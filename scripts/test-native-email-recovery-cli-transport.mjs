#!/usr/bin/env node
// Focused wire/argv tests. The injected runner records commands without
// spawning a process, contacting Railway, or asserting native receipt validity.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as util from 'node:util'

const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
function load(name,deps){
  const source=fs.readFileSync(new URL(`../app_src/lib/crm/${name}.ts`,import.meta.url),'utf8')
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const module={exports:{}}
  new Function('module','exports','require',code)(module,module.exports,key=>{
    assert.ok(Object.hasOwn(deps,key),`Unexpected dependency ${key}`)
    return deps[key]
  })
  return module.exports
}
const protocol=load('nativeEmailPublication',{'node:crypto':crypto})
const permitApi=load('nativeEmailRecoveryDispatchPermit',{'server-only':{},'node:crypto':crypto,'node:util':util,
  './nativeEmailPublication':protocol})
const readyApi=load('nativeEmailRecoveryReadyProof',{'node:crypto':crypto})
const api=load('nativeEmailRecoveryCliTransport',{'server-only':{},'node:crypto':crypto,'node:fs':fs,'node:path':path,
  './nativeEmailPublication':protocol,'./nativeEmailRecoveryReadyProof':readyApi,'./nativeEmailRecoveryDuplexRunner':{
    createNativeEmailRecoveryDuplexCommandRunner:()=>assert.fail('test must not instantiate the real SSH runner'),
  }})

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const {nativeEmailCanonicalJson:json,nativeEmailDigest:hash,prepareNativeEmailPublication:prepare}=protocol
const target={projectId:id(1),environmentId:id(2),serviceId:id(3),deploymentId:id(4),deploymentInstanceId:id(8),replicaId:id(5),nativeInstanceId:id(6),
  database:'synthetic_crm',databasePrincipal:'synthetic_recovery@%',serviceUserId:'synthetic-admin',oauthClientId:id(7),
  mariaStoreFingerprint:hash('fixture-maria-store'),cliSourceHash:hash('fixture-cli'),imagePackageHash:hash('fixture-image')}
const targetFingerprint=api.nativeEmailRecoveryCliTargetFingerprint(target)
assert.equal(targetFingerprint,hash(target))
assert.equal(api.nativeEmailRecoveryCliTargetFingerprint(Object.fromEntries(Object.entries(target).reverse())),targetFingerprint)
for(const key of Object.keys(target)){
  const alternate=/(?:Hash|Fingerprint)$/.test(key)?hash(`alternate ${key}`):key==='database'?'other_crm':
    key==='databasePrincipal'?'other_recovery@%':key==='serviceUserId'?'other-admin':id(90)
  assert.notEqual(api.nativeEmailRecoveryCliTargetFingerprint({...target,[key]:alternate}),targetFingerprint)
}
const otherStoreTarget={...target,mariaStoreFingerprint:hash('different physical Maria store')}
const otherStoreTargetFingerprint=api.nativeEmailRecoveryCliTargetFingerprint(otherStoreTarget)
const railwayBinary=fileURLToPath(import.meta.url) // hashed local bytes; never executed
const railwayBinarySha256=crypto.createHash('sha256').update(fs.readFileSync(railwayBinary)).digest('hex')
const temp=fs.mkdtempSync(path.join(tmpdir(),'clawpilot-recovery-identity-fixture-'))
const railwayIdentityFile=path.join(temp,'synthetic-ssh-identity')
fs.writeFileSync(railwayIdentityFile,'synthetic fixture; never used as an SSH key',{mode:0o600,flag:'wx'})
process.on('exit',()=>{fs.unlinkSync(railwayIdentityFile);fs.rmdirSync(temp)})
const transportAttestationKey=crypto.randomBytes(32)
const options={target,railwayBinary,railwayBinarySha256,railwayIdentityFile,transportAttestationKey}
const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
const signer=permitApi.createNativeEmailRecoveryDispatchSigner({keyId:'synthetic-transport',key:privateKey,targetFingerprint})
const readers=['synthetic-admin','synthetic-reader']
const command={version:2,mode:'publish',operationId:hash('operation'),workspaceId:id(10),pipelineId:id(11),localId:id(12),
  suiteCrmId:id(13),globalId:'gi1234567',generation:2,audienceFingerprint:hash('audience'),expectedRecordFingerprint:null,
  projection:{attributes:{name:'Synthetic mail: Café; $(never_execute)\nnewline'},accounts:[],contacts:[],contactAccounts:[],
    previousManaged:{accounts:[],contacts:[]}},capabilityPolicyFingerprint:hash('capability-policy'),
  principalSuiteCrmUserIds:readers,expectedCapabilities:{view:readers,list:readers,export:readers,edit:[readers[0]],delete:[readers[0]]}}
const request=prepare({command,nativePolicyFingerprint:hash('native-policy'),allowedReaderSuiteCrmUserIds:[...readers].reverse()})
const now=Math.floor(Date.now()/1000)
const sign=(action,req=request)=>signer.signPermit({action,request:req,approvalHash:hash('approval'),
  fence:{fenceEpoch:id(14),targetFingerprint,expiresAt:now+23},leaseOwner:action==='prepare'?null:id(15),
  leaseFence:action==='prepare'?null:7,nowSeconds:now,authorizationExpiresAt:now+25})
const publish=sign('publish')
const preparePermit=sign('prepare')
const publishFence={fenceEpoch:id(14),targetFingerprint,expiresAt:now+23}
const reply={received:true,state:'synthetic',version:2}
const replyText=json(reply)+'\n'
function ready(value, changes={}, key=transportAttestationKey){
  const proof={action:value.args.at(-2),expiresAt:now+23,fenceEpoch:id(14),nonce:value.args.at(-1),
    purpose:'clawpilot-native-email-recovery-ready-v1',targetFingerprint,version:1,...changes}
  return json({mac:crypto.createHmac('sha256',key).update(json(proof),'ascii').digest('hex'),proof})
}
const make=({replyBytes=replyText,runError,overrides={},withoutReady=false,eagerAuthorization=false}={})=>{
  const calls=[], payloads=[]
  const transport=api.createNativeEmailRecoveryCliTransport({...options,...overrides},async value=>{
    calls.push(value)
    if(runError)throw runError
    if(eagerAuthorization)await value.stdin()
    if(!withoutReady){
      for(const invalid of [ready(value,{nonce:hash('wrong nonce')}),ready(value,{action:'unsafe action'}),
        ready(value,{targetFingerprint:hash('other instance')}),ready(value,{targetFingerprint:otherStoreTargetFingerprint}),ready(value,{fenceEpoch:id(61)}),
        ready(value,{expiresAt:now+1}),ready(value,{},crypto.randomBytes(32)),ready(value)+'\n', 'null', '{}'])
        assert.equal(value.verifyReady(invalid),false)
      const line=ready(value)
      assert.equal(value.verifyReady(line),true)
      assert.equal(value.verifyReady(line),false)
      payloads.push(typeof value.stdin==='function'?await value.stdin():value.stdin)
    }
    return replyBytes
  })
  return {transport,calls,payloads}
}
function held(code){return error=>error instanceof protocol.NativeEmailPublicationHeld&&error.code===`legacy_dispatch_transport_${code}`}

{
  const mutable={...target},f=make({overrides:{target:mutable}})
  assert.ok(Object.isFrozen(f.transport))
  mutable.projectId=id(70) // the verified destination cannot follow a caller mutation
  mutable.mariaStoreFingerprint=otherStoreTarget.mariaStoreFingerprint
  for(const action of ['prepare','publish','resolve']){
    const permit=sign(action)
    assert.deepEqual(await (action==='publish'?f.transport.exchangePublish({request,fence:publishFence,authorize:async()=>permit})
      :f.transport.exchange({request,permit})),reply)
    const sent=f.calls.at(-1)
    const stdin=f.payloads.at(-1)
    assert.match(sent.args.at(-1),/^[0-9a-f]{64}$/u)
    assert.deepEqual({...sent,stdin,verifyReady:undefined},{program:railwayBinary,args:['ssh','--project',target.projectId,'--environment',target.environmentId,
      '--service',target.serviceId,'--deployment-instance',target.deploymentInstanceId,'--identity-file',railwayIdentityFile,'--','php',
      '/opt/clawpilot/native-email-recovery-cli.php',action,sent.args.at(-1)],stdin:json({command:request.command,
      nativePolicyFingerprint:request.nativePolicyFingerprint,allowedReaderSuiteCrmUserIds:readers,permit})+'\n',verifyReady:undefined})
    assert.ok(!sent.args.join(' ').includes('never_execute'))
    assert.ok(!stdin.includes('BEGIN PRIVATE KEY'))
    assert.ok(!stdin.includes(transportAttestationKey.toString('base64')))
  }
  assert.equal(f.calls.length,3)
  assert.equal(new Set(f.calls.map(c=>c.args.at(-1))).size,3)
}
console.log('PASS exact pinned argv and canonical stdin for prepare, publish, resolve; target snapshot is immutable')

{
  const extra={...target,unexpected:'unsafe'}
  const missing={...target};delete missing.replicaId
  const unpinned={...target};delete unpinned.mariaStoreFingerprint
  const getter={...target};Object.defineProperty(getter,'projectId',{enumerable:true,get:()=>assert.fail('do not invoke a target getter')})
  for(const invalid of [extra,missing,unpinned,getter])assert.throws(()=>make({overrides:{target:invalid}}),held('target_shape'))
  for(const invalid of [{projectId:target.projectId+'\n'},{databasePrincipal:'root;exec@%'},{cliSourceHash:'0'.repeat(63)},
    {mariaStoreFingerprint:'unverified-maria'},{mariaStoreFingerprint:'A'.repeat(64)},{deploymentInstanceId:'--fallback'}]){
    assert.throws(()=>make({overrides:{target:{...target,...invalid}}}),held('target_invalid'))
  }
  for(const overrides of [{railwayIdentityFile:'--fallback'},{railwayBinary:'railway'},{railwayBinarySha256:'bad'}]){
    assert.throws(()=>make({overrides}),held('binary_config'))
  }
  const changed=make({overrides:{railwayBinarySha256:hash('different bytes')}})
  await assert.rejects(()=>changed.transport.exchange({request,permit:preparePermit}),held('binary_changed'))
  assert.deepEqual(changed.calls,[])
  assert.throws(()=>make({overrides:{transportAttestationKey:Buffer.alloc(31)}}),held('ready_key'))
  for(const file of [railwayBinary,path.join(temp,'missing-key')]){
    const unprotected=make({overrides:{railwayIdentityFile:file}})
    await assert.rejects(()=>unprotected.transport.exchange({request,permit:preparePermit}),held('identity_file'))
    assert.deepEqual(unprotected.calls,[])
  }
}
console.log('PASS malformed destination and changed binary hold before any command')

{
  const bypass=make({withoutReady:true})
  await assert.rejects(()=>bypass.transport.exchange({request,permit:preparePermit}),held('destination_unverified'))
  assert.equal(bypass.calls.length,1)
  const f=make()
  await assert.rejects(()=>f.transport.exchange({request,permit:publish}),held('publish_requires_readiness'))
  const otherStore=make({overrides:{target:otherStoreTarget}})
  assert.equal(otherStore.transport.targetFingerprint,otherStoreTargetFingerprint)
  await assert.rejects(()=>otherStore.transport.exchange({request,permit:preparePermit}),held('packet_scope'))
  await assert.rejects(()=>otherStore.transport.exchangePublish({request,fence:publishFence,authorize:async()=>{
    assert.fail('a changed Maria store must never request a publish permit')
  }}),held('packet_scope'))
  assert.deepEqual(otherStore.calls,[])
  const changeProof=changes=>({...preparePermit,proof:{...preparePermit.proof,...changes}})
  for(const permit of [null,changeProof({action:'publish; exec'}),changeProof({operationId:hash('other operation')}),
    changeProof({targetFingerprint:hash('other target')}),changeProof({commandHash:hash('other command')}),
    changeProof({requestFingerprint:hash('other request')})]){
    await assert.rejects(()=>f.transport.exchange({request,permit}),held('packet_scope'))
  }
  const {capabilityPolicyFingerprint,principalSuiteCrmUserIds,expectedCapabilities,...v1}=command
  for(const invalid of [{...request,commandHash:hash('wrong command')},{...request,requestFingerprint:hash('wrong request')},
    {...request,command:{...request.command,projection:{attributes:{name:'different'}}}},
    prepare({command:{...v1,version:1},nativePolicyFingerprint:request.nativePolicyFingerprint,allowedReaderSuiteCrmUserIds:readers}),
    prepare({command:{...command,mode:'repair',projection:null,expectedRecordFingerprint:hash('existing record')},
      nativePolicyFingerprint:request.nativePolicyFingerprint,allowedReaderSuiteCrmUserIds:readers}),
    prepare({command:{...command,expectedRecordFingerprint:hash('existing record')},nativePolicyFingerprint:request.nativePolicyFingerprint,
      allowedReaderSuiteCrmUserIds:readers})]){
    await assert.rejects(()=>f.transport.exchange({request:invalid,permit:preparePermit}),held('packet_scope'))
  }
  await assert.rejects(()=>f.transport.exchange({request,permit:{...preparePermit,signature:'x'.repeat(650_000)}}),held('packet_bound'))
  assert.deepEqual(f.calls,[])
}
console.log('PASS tampered permit or request, repair/update commands, and oversized input never dispatch')

{
  let authorized=0
  const input={request,fence:publishFence,authorize:async()=>{authorized++;return publish}}
  await assert.rejects(()=>make({eagerAuthorization:true}).transport.exchangePublish(input),held('authorization_before_ready_or_reentered'))
  await assert.rejects(()=>make({withoutReady:true}).transport.exchangePublish(input),held('destination_unverified'))
  assert.equal(authorized,0)
  assert.deepEqual(await make().transport.exchangePublish(input),reply)
  assert.equal(authorized,1)
}
console.log('PASS only same-process verified readiness can request the one-time publish authorization')

{
  for(const [replyBytes,code] of [['not JSON','output_json'],['[]\n','output_canonical'],[replyText.trimEnd(),'output_canonical'],
    ['{"version":2,"state":"synthetic","received":true}\n','output_canonical'],['{"received":true,"received":true}\n','output_canonical'],
    ['x'.repeat(1_250_001),'output_bound'],[null,'output_bound']]){
    const f=make({replyBytes})
    await assert.rejects(()=>f.transport.exchange({request,permit:preparePermit}),held(code))
    assert.equal(f.calls.length,1,'invalid output must never trigger another dispatch')
  }
  const uncertain=new Error('synthetic remote outcome unknown'),f=make({runError:uncertain})
  await assert.rejects(()=>f.transport.exchange({request,permit:preparePermit}),error=>error===uncertain)
  assert.equal(f.calls.length,1,'lost response must never trigger another dispatch')
}
console.log('PASS malformed or missing native response and uncertain remote outcome cause no automatic retry')
