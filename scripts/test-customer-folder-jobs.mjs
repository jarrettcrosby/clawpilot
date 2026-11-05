#!/usr/bin/env node
// Actual worker and secret HTTP route, with synthetic persistence/provider.
// Real SQL/trigger/card coverage is in test-customer-drive-folders-postgres.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript')
function load(path,deps={},environment={}) {
  const module={exports:{}},code=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('module','exports','require','process',code)(module,module.exports,name=>{
    if(name.startsWith('node:'))return require(name)
    assert.ok(Object.hasOwn(deps,name),`Unexpected import ${name}`);return deps[name]}, {env:environment})
  return module.exports
}
const core=load('app_src/lib/crm/customerDriveFolders.ts')
class ClientError extends Error {constructor(retryable){super('private-provider-token-account-folder');this.retryable=retryable}}
const jobs=[1,2,3,4].map(n=>({account_id:`account-${n}`,actor_email:'private@example.test',adopt_root_id:n===1?'explicit-root':null,
  attempts:1,lock_token:`lease-${n}`}))
function harness({queue=[],contextError,provisionError,settles=true}={}){
  const claims=[],contexts=[],provisions=[],settled=[]
  const api=load('app_src/lib/crm/customerFolderJobs.ts',{
    '@/lib/persistence/crmCustomerFolderJobs':{
      claimCustomerFolderJob:async()=>{const job=queue.shift()??null;claims.push(job);return job},
      customerFolderJobContext:async job=>{contexts.push(job);if(contextError)throw contextError;return {scope:{pipelineId:'pipeline'},customerName:'private name'}},
      settleCustomerFolderJob:async(job,result)=>{settled.push({job,result});return settles}},
    '@/lib/integrations/googleWorkspaceClient':{GoogleWorkspaceClientError:ClientError},
    './customerFolderProvisioning':{provisionCustomerAccountFolder:async input=>{provisions.push(input);if(provisionError)throw provisionError}},
    './customerDriveFolders':core})
  return {api,claims,contexts,provisions,settled}
}
let passed=0
async function check(name,work){await work();passed++;console.log(`PASS ${name}`)}
await check('empty queue is read-only and secret worker counts contain no identities',async()=>{
  const h=harness(),result=await h.api.processCustomerFolderJobs()
  assert.deepEqual(result,{claimed:0,ready:0,queued:0,held:0,leaseLost:0});assert.equal(h.claims.length,1)
  assert.equal(h.provisions.length,0);assert.equal(h.settled.length,0)
})
await check('bounded worker forwards only exact claimed actor/context/adoption and completes once',async()=>{
  const h=harness({queue:structuredClone(jobs)}),result=await h.api.processCustomerFolderJobs({limit:999})
  assert.equal(result.claimed,3);assert.equal(result.ready,3);assert.equal(h.provisions.length,3)
  assert.equal(h.provisions[0].actorEmail,jobs[0].actor_email);assert.equal(h.provisions[0].adoptRootId,'explicit-root')
  assert.equal(h.settled.length,3);assert.deepEqual(h.settled[0].result,{status:'ready'})
  assert.ok(Object.values(result).every(n=>typeof n==='number'));assert.ok(!JSON.stringify(result).includes('private'))
})
await check('context drift prevents provider access and records only an internal safe hold code',async()=>{
  const h=harness({queue:[jobs[0]],contextError:new core.CustomerFolderHeldError('customer_folder_configuration_or_lease_changed')})
  assert.equal((await h.api.processCustomerFolderJobs()).held,1);assert.equal(h.provisions.length,0)
  assert.deepEqual(h.settled[0].result,{status:'held',errorCode:'customer_folder_configuration_or_lease_changed'})
})
await check('retryable provider failures retry with a bound; exhausted/non-retryable/unknown failures hold without private error text',async()=>{
  for(const [error,attempts,status] of [[new ClientError(true),1,'queued'],[new ClientError(true),5,'held'],
    [new ClientError(false),1,'held'],[Error('private-token-url-email'),1,'held']]){
    const h=harness({queue:[{...jobs[0],attempts}],provisionError:error}),result=await h.api.processCustomerFolderJobs()
    assert.equal(result[status],1);assert.equal(h.settled[0].result.status,status)
    assert.ok(!JSON.stringify(h.settled[0].result).includes('private'))
  }
})
await check('lost settlement lease is counted and never overwritten by a second settlement',async()=>{
  const h=harness({queue:[jobs[0]],settles:false}),result=await h.api.processCustomerFolderJobs()
  assert.equal(result.leaseLost,1);assert.equal(result.ready,0);assert.equal(h.settled.length,1)
})
const {NextRequest,NextResponse}=require('next/server')
await check('actual secret HTTP route rejects missing/wrong auth before CRM or folder work',async()=>{
  let nativeCalls=0,folderCalls=0
  const api=load('app_src/app/api/crm/outbox/process/route.ts',{'next/server':{NextRequest,NextResponse},
    '@/lib/crm/worker':{processSuiteCrmOutbox:async()=>{nativeCalls++;return {claimed:0}}},
    '@/lib/crm/customerFolderJobs':{processCustomerFolderJobs:async()=>{folderCalls++;return {claimed:0}}},
    '@/lib/persistence/config':{isPostgresStorageEnabled:()=>true}}, {PIPELINE_OUTBOX_WORKER_SECRET:'fixture-worker-secret'})
  for(const authorization of ['', 'Bearer wrong-secret']){
    const response=await api.POST(new NextRequest('https://fixture.test/api/crm/outbox/process',{
      method:'POST',headers:{authorization,'content-type':'application/json'},body:'{}'}))
    assert.equal(response.status,401)
  }
  assert.equal(nativeCalls,0);assert.equal(folderCalls,0)
  const response=await api.POST(new NextRequest('https://fixture.test/api/crm/outbox/process',{
    method:'POST',headers:{authorization:'Bearer fixture-worker-secret','content-type':'application/json'},body:'{"limit":3}'}))
  assert.equal(response.status,200);assert.equal(nativeCalls,1);assert.equal(folderCalls,1)
  assert.deepEqual(await response.json(),{ok:true,claimed:0,customerFolders:{claimed:0}})
})
console.log(`${passed} customer folder worker/HTTP checks passed (synthetic dependencies; no live provider)`)
