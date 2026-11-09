// Private App-side half of the exact repair. Invoke only over the pinned
// Railway SSH connection; responses may contain a single exact Email body.
import { createHash } from 'node:crypto'
import { lstatSync, openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { createBpoFailedEmailAppHandoff, prepareBpoFailedEmailCandidate } from './lib/bpo-failed-email-app-handoff.mjs'
import { createBpoFailedEmailAppSettler } from './lib/bpo-failed-email-app-settlement.mjs'
import { createBpoFailedEmailAbsenceVerifier } from './lib/bpo-failed-email-operator-proof.mjs'
import { createSharedBpoEmailReceiptVerifier } from './lib/bpo-shared-email-receipt-proof.mjs'
import { sharedEmailCanonicalJson } from './lib/bpo-shared-email-projection.mjs'

const path='/tmp/clawpilot-bpo-email-repair/pins.json'
const APP={projectId:'b5169ebd-8166-4b96-9a81-7cc8adaa9270',environmentId:'058ce52f-1d3b-44bb-afe2-0df2bf24efb9',
  serviceId:'f3fdf47c-6645-42ff-9a28-52843f8e4da2'}
const mapping={projectId:'RAILWAY_PROJECT_ID',environmentId:'RAILWAY_ENVIRONMENT_ID',serviceId:'RAILWAY_SERVICE_ID',
  deploymentId:'RAILWAY_DEPLOYMENT_ID',replicaId:'RAILWAY_REPLICA_ID',gitCommit:'RAILWAY_GIT_COMMIT_SHA'}
const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const COMMIT=/^[a-f0-9]{40}(?![\s\S])/u
const hash=input=>createHash('sha256').update(input).digest('hex')
const need=(ok,code)=>{if(!ok)throw new Error(code)}
const match=(value,re)=>typeof value==='string'&&re.test(value)
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length
  &&keys.every(key=>Object.hasOwn(value,key))

function readPins(expectedSha) {
  need(process.geteuid?.()===0&&process.cwd()==='/app','operator_context')
  const directory=lstatSync(path.slice(0,path.lastIndexOf('/')))
  need(directory.isDirectory()&&!directory.isSymbolicLink()&&directory.uid===0&&(directory.mode&0o777)===0o700,'protected_directory')
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
    const file=fstatSync(fd)
    need(file.isFile()&&file.uid===0&&file.nlink===1&&(file.mode&0o777)===0o600&&file.size<=100000,'protected_pins')
    const bytes=readFileSync(fd)
    need(bytes.length===file.size&&hash(bytes)===expectedSha,'pins_drift')
    return JSON.parse(bytes.toString('utf8'))
  } finally {closeSync(fd)}
}

function deploymentOf(target) {
  need(exact(target,Object.keys(mapping))&&Object.keys(mapping).every(field=>match(target[field],field==='gitCommit'?COMMIT:UUID))
    &&Object.entries(APP).every(([key,value])=>target[key]===value),'target_binding')
  for(const [key,env] of Object.entries(mapping))need(process.env[env]===target[key],'railway_identity')
  return hash(sharedEmailCanonicalJson(['clawpilot-bpo-app-deployment-v1',target]))
}

let client
try {
  const [action,pinArg,...extra]=process.argv.slice(2), pin=pinArg?.match(/^--pins-sha256=([a-f0-9]{64})$/u)?.[1]
  need(extra.length===0&&pin&&['candidate','inspect','claim','settle','resolve'].includes(action),'one_action')
  const pins=readPins(pin)
  need(exact(pins,['version','target','candidateManifestJson','expectedManifestFingerprint','review',
    'expectedInventoryFingerprint','readbackKeyId','readbackPublicKeyPem','writeEnabled'])&&pins.version===1&&typeof pins.writeEnabled==='boolean',
  'pins_shape')
  const deploymentFingerprint=deploymentOf(pins.target), attestAppDeployment=()=>deploymentOf(pins.target)
  need((action!=='claim'&&action!=='settle')||pins.writeEnabled===true,'write_disabled')
  const lengthLimit=32768
  let bytes=0;const chunks=[]
  for await(const part of process.stdin){bytes+=part.length;need(bytes<=lengthLimit,'input_limit');chunks.push(part)}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const proofKey=action==='claim'?'absenceEvidence':['settle','resolve'].includes(action)?'receiptEnvelope':null
  need(exact(input,proofKey?['interactionId',proofKey]:['interactionId'])&&match(input.interactionId,UUID),'input_shape')
  const url=process.env.DATABASE_URL
  const address=new URL(url)
  need(['postgres:','postgresql:'].includes(address.protocol)&&address.hostname&&address.username&&!address.search&&!address.hash,'app_database_url')
  const require=createRequire(new URL('../app_src/package.json',import.meta.url)), { Client }=require('pg')
  client=new Client({connectionString:url,connectionTimeoutMillis:7000,application_name:'clawpilot-bpo-exact-email-repair'})
  await client.connect()
  let result
  if(action==='candidate'){
    need(typeof pins.candidateManifestJson==='string'&&match(pins.expectedManifestFingerprint,HASH),'candidate_manifest')
    result=await prepareBpoFailedEmailCandidate({client,interactionId:input.interactionId,candidateManifestJson:pins.candidateManifestJson,
      expectedManifestFingerprint:pins.expectedManifestFingerprint,appDeploymentFingerprint:deploymentFingerprint,attestAppDeployment})
  }else {
    const common={review:pins.review,expectedInventoryFingerprint:pins.expectedInventoryFingerprint,attestAppDeployment}
    const trust={publicKeyPem:pins.readbackPublicKeyPem,keyId:pins.readbackKeyId}
    if(action==='inspect'||action==='claim'){
      const handoff=createBpoFailedEmailAppHandoff({...common,verifyNativeAbsence:createBpoFailedEmailAbsenceVerifier(trust)})
      result=await handoff[action]({client,...input})
    } else {
      const settlement=createBpoFailedEmailAppSettler({...common,verifyNativeReceipt:createSharedBpoEmailReceiptVerifier(trust)})
      result=await settlement[action]({client,...input})
    }
  }
  await client.end();client=undefined
  const response=JSON.stringify(result)
  need(Buffer.byteLength(response)<=600000,'output_limit')
  process.stdout.write(response+'\n')
} catch {
  // No body, raw PostgreSQL error, process environment, or key in diagnostics.
  process.stderr.write('Exact BPO Email App operator held; inspect the specific slot before proceeding.\n')
  process.exitCode=1
} finally {if(client)await client.end().catch(()=>{})}
