#!/usr/bin/env node
// Local synthetic keys and read-only, isolated PHP. No databases or providers.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as util from 'node:util'
import {execFileSync} from 'node:child_process'
import {readFileSync,realpathSync} from 'node:fs'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'

const root=realpathSync(fileURLToPath(new URL('../',import.meta.url)))
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
const modules=new Map()
function load(name){
  if(modules.has(name))return modules.get(name)
  const source=readFileSync(join(root,'app_src/lib/crm',name+'.ts'),'utf8')
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const m={exports:{}}
  new Function('require','module','exports',code)(dependency=>{
    if(dependency==='server-only')return {}
    if(dependency==='node:crypto')return crypto
    if(dependency==='node:util')return util
    assert.equal(dependency,'./nativeEmailPublication');return load('nativeEmailPublication')
  },m,m.exports)
  modules.set(name,m.exports);return m.exports
}
const {prepareNativeEmailPublication,nativeEmailCanonicalJson,nativeEmailDigest:hash}=load('nativeEmailPublication')
const {createNativeEmailRecoveryDispatchSigner:createSigner,assertNativeEmailRecoveryDispatchSigner:verifySigner}=load('nativeEmailRecoveryDispatchPermit')
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const now=1794000000,keyId='fixture-issuer-1',targetFingerprint=hash('isolated target')
const signer=createSigner({keyId,key:privateKey,targetFingerprint})
assert.ok(Object.isFrozen(signer));assert.doesNotThrow(()=>verifySigner(signer))
assert.throws(()=>verifySigner({...signer}),/legacy_dispatch_signer_unverified/)
assert.throws(()=>createSigner({keyId,key:publicKey,targetFingerprint}),/legacy_dispatch_signer_invalid/)
const audience=['admin']
const request=prepareNativeEmailPublication({nativePolicyFingerprint:hash('policy'),allowedReaderSuiteCrmUserIds:audience,command:{
  version:2,operationId:hash('operation'),mode:'publish',workspaceId:uid(1),pipelineId:uid(2),localId:uid(3),
  suiteCrmId:uid(4),globalId:'gi1234567',generation:2,audienceFingerprint:hash('audience'),expectedRecordFingerprint:null,
  projection:{attributes:{name:'Synthetic ⸺ recovery'},accounts:[],contacts:[],contactAccounts:[],previousManaged:{accounts:[],contacts:[]}},
  capabilityPolicyFingerprint:hash('capability policy'),principalSuiteCrmUserIds:audience,
  expectedCapabilities:{view:audience,list:audience,export:audience,edit:audience,delete:audience},
}})
const base={action:'prepare',request,approvalHash:hash('review'),fence:{fenceEpoch:uid(5),targetFingerprint,expiresAt:now+21},
  leaseOwner:null,leaseFence:null,nowSeconds:now,authorizationExpiresAt:now+24}
assert.throws(()=>signer.signPermit({...base,action:'publish'}),/legacy_dispatch_lease_invalid/)
assert.throws(()=>signer.signPermit({...base,authorizationExpiresAt:now}),/legacy_dispatch_authorization_expired/)
assert.throws(()=>signer.signPermit({...base,fence:{...base.fence,targetFingerprint:hash('other target')}}),/legacy_dispatch_fence_invalid/)
assert.throws(()=>signer.signPermit({...base,request:{...request,commandHash:hash('other command')}}),/legacy_dispatch_request_changed/)
const vectors=['prepare','publish','resolve'].map(action=>{
  const lease=action==='prepare'?{}:{leaseOwner:uid(6),leaseFence:7}
  const permit=signer.signPermit({...base,action,...lease})
  assert.ok(Object.isFrozen(permit)&&Object.isFrozen(permit.proof))
  assert.equal(permit.proof.expiresAt,now+21)
  assert.ok(crypto.verify('sha256',Buffer.from(nativeEmailCanonicalJson(permit.proof),'ascii'),
    {key:publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(permit.signature,'base64')))
  return {envelope:permit,trusted:{keyId,publicKeyPem:publicKey.export({format:'pem',type:'spki'}),action,
    operationId:request.command.operationId,requestFingerprint:request.requestFingerprint,commandHash:request.commandHash,
    targetFingerprint,fenceEpoch:base.fence.fenceEpoch},now}
})
const phpDocker=['run','--rm','--pull=never','--network=none','--read-only','--memory=192m','--memory-swap=192m','--cpus=1','--pids-limit=48','-i']
const php=[...phpDocker,
  '--mount',`type=bind,source=${join(root,'services/suitecrm/email-audience')},target=/source,readonly`,
  '--mount',`type=bind,source=${join(root,'scripts/fixtures/native-email-recovery-dispatch-permit.php')},target=/fixture.php,readonly`,
  'php:8.3.35-cli-alpine','php','/fixture.php','/source/NativeEmailRecoveryDispatchPermit.php']
assert.equal(execFileSync('docker',php,{encoding:'utf8',timeout:30000}),'PASS private native recovery dispatch permit verification\n')
assert.equal(execFileSync('docker',[...php,'--wire'],{input:JSON.stringify(vectors),encoding:'utf8',timeout:30000}),
  'PASS Node-issued private dispatch permits verified in PHP\n')
console.log('PASS TypeScript and PHP exact dispatch authorization; no native writer or database used')
const maria={database:'synthetic_crm',hostname:'fixture-maria',serverId:'512',serverVersion:'11.4.13-MariaDB-ubu2404',
  serverUid:Buffer.alloc(20,0x41).toString('base64')}
const observed={database_name:maria.database,hostname:maria.hostname,server_id:maria.serverId,server_version:maria.serverVersion,
  server_uid:maria.serverUid,principal:'synthetic_recovery@%',epoch:String(now)}
const target={database:maria.database,databasePrincipal:observed.principal,
  mariaStoreFingerprint:load('nativeEmailRecoveryStoreBinding').nativeEmailMariaStoreFingerprint(maria)}
const phpStore=[...phpDocker,
  '--mount',`type=bind,source=${join(root,'services/suitecrm')},target=/source,readonly`,
  '--mount',`type=bind,source=${join(root,'scripts/fixtures/native-email-recovery-maria-store.php')},target=/fixture.php,readonly`,
  'php:8.3.35-cli-alpine','php','/fixture.php','/source/native-email-recovery-cli.php']
assert.equal(execFileSync('docker',phpStore,{input:JSON.stringify({observed,target}),encoding:'utf8',timeout:30000}),
  'PASS PHP native writer binds exact Maria identity and rejects missing or mismatched UID\n')
console.log('PASS canonical Node/PHP Maria store fingerprint parity and production row guard; no database opened')
