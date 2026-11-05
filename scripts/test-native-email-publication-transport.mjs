#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
const require=createRequire(new URL('../app_src/package.json',import.meta.url));const ts=require('typescript')
function load(path,dependencies,environment={}){
  const source=readFileSync(new URL(`../${path}`,import.meta.url),'utf8')
  const module={exports:{}}
  const output=ts.transpileModule(source,{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}})
  new Function('module','exports','require','process',output.outputText)(module,module.exports,name=>{
    assert.ok(Object.hasOwn(dependencies,name),`Unexpected dependency ${name}`);return dependencies[name]
  },{env:environment})
  return module.exports
}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const transport=load('app_src/lib/crm/nativeEmailPublicationTransport.ts',{'./nativeEmailPublication':protocol})
const args=process.argv.slice(2)
assert.ok(args.length===0 || args.length===1 && args[0].startsWith('--native-receipt='),'Use optional --native-receipt=/absolute/local-fixture.json')
const copy=value=>JSON.parse(JSON.stringify(value))
function nativeClient(fetchImpl){
  const api=load('app_src/lib/crm/suiteCrmClient.ts',{
    '@/lib/currency':{},'@/lib/crm/productImagePublic':{},'@/lib/crm/suiteCrmNativeProductImageClient':{},
    '@/lib/publicUrl':{},'@/lib/crm/suiteCrmNativeEmailProjection':{},'@/lib/crm/nativeEmailPublicationTransport':transport,
  },{SUITECRM_BASE_URL:'https://native.example.invalid',SUITECRM_CLIENT_ID:'fixture-client',SUITECRM_CLIENT_SECRET:'fixture-secret'})
  return api.createSuiteCrmNativeEmailPublicationClient(fetchImpl)
}
function fixture(){
  const attributes={global_id_c:'gi1234567',name:'Subject & evidence',date_sent_received:'2026-10-30T13:00:00.000Z',
    type:'archived',status:'read',parent_type:'',parent_id:'',assigned_user_id:'admin',description:'Plain &amp; <literal>\nTwo',description_html:'',
    from_addr_name:'Sender <Sender@Example.test>',to_addrs_names:'Recipient <recipient@example.test>',cc_addrs_names:'',bcc_addrs_names:'',reply_to_addrs_names:'reply@example.test'}
  const command={version:1,operationId:'a'.repeat(64),mode:'publish',workspaceId:'workspace',pipelineId:'11111111-1111-4111-8111-111111111111',generation:1,
    audienceFingerprint:'b'.repeat(64),suiteCrmId:'native-email',globalId:'gi1234567',localId:'22222222-2222-4222-8222-222222222222',expectedRecordFingerprint:null,
    projection:{attributes,accounts:[],contacts:[],contactAccounts:[],previousManaged:{accounts:[],contacts:[]}}}
  const receipt={version:1,operationId:command.operationId,commandHash:protocol.nativeEmailDigest(command),state:'committed',replayed:false,result:{
    version:1,mode:'publish',suiteCrmId:command.suiteCrmId,globalId:command.globalId,pipelineId:command.pipelineId,generation:1,audienceFingerprint:command.audienceFingerprint,
    recordFingerprint:'c'.repeat(64),readerSuiteCrmUserIds:['admin'],projection:{version:2,suiteCrmId:command.suiteCrmId,
      attributes:{...attributes,date_sent_received:'2026-10-30 13:00:00',description_html:'Native sanitized HTML',from_addr_name:'Sender <sender@example.test>',created_by:'admin',deleted:'0'},
      sourceAttributes:copy(attributes),accounts:[],contacts:[],contactAccounts:[],snapshotFingerprint:'c'.repeat(64),dateSentReceivedUtc:'2026-10-30T13:00:00Z'}}}
  return{command,receipt}
}
test('prepared HTTP bridge has fixed authenticated paths and cancellation stays a distinct call',async()=>{
  const calls=[],{command}=fixture();const bridge=transport.nativeEmailPublicationBridge(async(path,init)=>{calls.push({path,init});return {pending:true}})
  assert.deepEqual(await bridge.publish(command),{pending:true});await bridge.resolveOrCancel(command)
  assert.deepEqual(calls.map(x=>x.path),['/Api/V8/custom/clawpilot-email-publication/publish','/Api/V8/custom/clawpilot-email-publication/resolve'])
  for(const {init} of calls){assert.equal(init.body,protocol.nativeEmailCanonicalJson(command));assert.equal(init.method,'POST');assert.ok(init.signal instanceof AbortSignal)}
})
test('native client uses existing service OAuth and fixed origin without I/O on construction',async()=>{
  const calls=[],{command}=fixture()
  const client=nativeClient(async(url,init)=>{
    calls.push({url,init})
    assert.equal(new URL(url).origin,'https://native.example.invalid')
    assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.ok(init.signal instanceof AbortSignal)
    if(new URL(url).pathname==='/Api/access_token'){
      assert.deepEqual(JSON.parse(init.body),{grant_type:'client_credentials',client_id:'fixture-client',client_secret:'fixture-secret'})
      return Response.json({access_token:'synthetic-token',expires_in:3600})
    }
    assert.equal(init.headers.Authorization,'Bearer synthetic-token')
    assert.equal(init.body,protocol.nativeEmailCanonicalJson(command))
    return Response.json(new URL(url).pathname.endsWith('/prepare')?{version:1,suiteCrmId:command.suiteCrmId,globalId:command.globalId,
      pipelineId:command.pipelineId,generation:command.generation,audienceFingerprint:command.audienceFingerprint,expectedRecordFingerprint:null}:{pending:true})
  })
  assert.equal(calls.length,0)
  await client.prepare(command);await client.publish(command);await client.resolveOrCancel(command)
  assert.deepEqual(calls.map(call=>new URL(call.url).pathname),['/Api/access_token',
    '/Api/V8/custom/clawpilot-email-publication/prepare','/Api/V8/custom/clawpilot-email-publication/publish',
    '/Api/V8/custom/clawpilot-email-publication/resolve'])
})
test('native client never interprets 400, 404 or 409 as no-write proof or follows legacy fallback',async()=>{
  const{command}=fixture()
  for(const status of[400,404,409]){
    const paths=[]
    const client=nativeClient(async(url)=>{
      const path=new URL(url).pathname;paths.push(path)
      return path==='/Api/access_token'?Response.json({access_token:'synthetic-token',expires_in:3600}):Response.json({ok:false,code:'HELD'},{status})
    })
    for(const operation of['prepare','publish','resolveOrCancel'])await assert.rejects(client[operation](command),new RegExp(`request failed \\(${status}\\)`))
    assert.deepEqual(paths,['/Api/access_token','/Api/V8/custom/clawpilot-email-publication/prepare',
      '/Api/V8/custom/clawpilot-email-publication/publish','/Api/V8/custom/clawpilot-email-publication/resolve'])
  }
})
test('preparation cannot silently adopt newer native edits',async()=>{
  const{command}=fixture();const response={version:1,suiteCrmId:command.suiteCrmId,globalId:command.globalId,pipelineId:command.pipelineId,generation:1,
    audienceFingerprint:command.audienceFingerprint,expectedRecordFingerprint:null}
  await transport.verifyNativeEmailPreparation(command,async()=>response)
  await assert.rejects(transport.verifyNativeEmailPreparation(command,async()=>({...response,expectedRecordFingerprint:'d'.repeat(64)})),/native_preimage_changed/)
  await assert.rejects(transport.verifyNativeEmailPreparation(command,async()=>({...response,generation:2})),/native_preimage_changed/)
})
test('raw native v2 representation is retained separately from proven source attributes',()=>{
  const{command,receipt}=fixture();const p=transport.verifyNativeEmailProjectionReceipt(command,receipt)
  assert.equal(p.attributes.date_sent_received,'2026-10-30 13:00:00');assert.equal(p.sourceAttributes.date_sent_received,'2026-10-30T13:00:00.000Z')
  assert.equal(p.attributes.description,'Plain &amp; <literal>\nTwo');assert.notEqual(p.attributes.description_html,'')
})
test('plain body subject ownership deletion and header drift cannot be echoed as successful',()=>{
  for(const[field,value]of[['description','Changed'],['name','Changed'],['created_by','other'],['deleted','1'],['from_addr_name','other@example.test'],['bcc_addrs_names','hidden@example.test']]){
    const{command,receipt}=fixture();receipt.result.projection.attributes[field]=value
    assert.throws(()=>transport.verifyNativeEmailProjectionReceipt(command,receipt))
  }
})
test('invented relationships stale snapshot and changed source echo refuse',()=>{
  for(const mutate of[p=>{p.accounts=['foreign-account']},p=>{p.snapshotFingerprint='d'.repeat(64)},p=>{p.sourceAttributes.description='changed'},p=>{p.extra=true}]){
    const{command,receipt}=fixture();mutate(receipt.result.projection);assert.throws(()=>transport.verifyNativeEmailProjectionReceipt(command,receipt))
  }
})
test('invalid UTC timestamps and header control characters refuse',()=>{
  for(const value of['2026-02-30 13:00:00','2026-10-30 14:00:00','2026-10-30T13:00:00+01:00']){
    const{command,receipt}=fixture();receipt.result.projection.attributes.date_sent_received=value;assert.throws(()=>transport.verifyNativeEmailProjectionReceipt(command,receipt))
  }
  const{command,receipt}=fixture();receipt.result.projection.attributes.to_addrs_names='recipient@example.test\r\nBcc: other@example.test'
  assert.throws(()=>transport.verifyNativeEmailProjectionReceipt(command,receipt))
})
test('cancellation has no projection and historical repair relies on its exact snapshot contract',()=>{
  const{command,receipt}=fixture();assert.equal(transport.verifyNativeEmailProjectionReceipt(command,{...receipt,state:'cancelled',result:null}),null)
  command.mode='repair';command.projection=null;receipt.result.mode='repair';receipt.result.projection=null
  assert.equal(transport.verifyNativeEmailProjectionReceipt(command,receipt),null)
})
test('combined finalizer-facing verifier always checks envelope before early-return cases',()=>{
  const{command,receipt}=fixture()
  const request=protocol.prepareNativeEmailPublication({command,nativePolicyFingerprint:'f'.repeat(64),allowedReaderSuiteCrmUserIds:['admin']})
  transport.verifyNativeEmailPublicationReceipt(request,receipt)
  assert.throws(()=>transport.verifyNativeEmailPublicationReceipt(request,{...receipt,operationId:'e'.repeat(64),state:'cancelled',result:null}))
})
if(args.length) test('actual synthetic PHP native publisher receipt matches TypeScript command hash and raw finalizer',()=>{
  const path=args[0].slice('--native-receipt='.length);assert.ok(path.startsWith('/'))
  const artifact=JSON.parse(readFileSync(path,'utf8'))
  assert.equal(artifact.mode,'remediation-candidate');assert.equal(artifact.isolatedNetwork,true);assert.equal(artifact.hostPorts,0)
  const lines=artifact.output.split('\n').filter(line=>line.startsWith('CLAWPILOT_NATIVE_PUBLISHER_WIRE='))
  assert.equal(lines.length,1)
  const wire=JSON.parse(lines[0].slice('CLAWPILOT_NATIVE_PUBLISHER_WIRE='.length))
  const request=protocol.prepareNativeEmailPublication(wire.input)
  const receipt=transport.verifyNativeEmailPublicationReceipt(request,wire.receipt)
  assert.equal(receipt.state,'committed');assert.equal(receipt.result.projection.version,2)
})
