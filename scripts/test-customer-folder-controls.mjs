#!/usr/bin/env node
// Actual command parser, server service and Next HTTP route; synthetic auth,
// persistence and Google transport. Separate PG/browser gates cover those layers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),{NextRequest,NextResponse}=require('next/server')
function load(path,deps={}){const module={exports:{}},code=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]})
  return module.exports}
const contract=load('app_src/lib/crm/customerFolderControls.ts'),core=load('app_src/lib/crm/customerDriveFolders.ts')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,actor='owner@example.test'
const base={pipelineId:id(1),accountId:id(2)},configuration={...base,action:'configure',parentId:'parent-id',enabled:true,expectedRevision:0}
const queue={...base,action:'queue',expectedRevision:1,expectedJobVersion:0,requestKey:id(3)}
let count=0
async function check(name,work){await work();count++;console.log(`PASS ${name}`)}
await check('typed commands accept only exact keys, safe versions and explicit Google folder IDs/URLs',()=>{
  assert.equal(contract.customerDriveFolderId(' https://drive.google.com/drive/folders/known-id?usp=sharing '),'known-id')
  assert.deepEqual(contract.parseCustomerFolderCommand(configuration),configuration)
  assert.deepEqual(contract.parseCustomerFolderCommand({...queue,adoptRootId:'https://drive.google.com/drive/folders/root-id'}),{...queue,adoptRootId:'root-id'})
  for(const bad of [null,[],{...configuration,actorEmail:'forged@example.test'},{...queue,expectedJobVersion:-1},
    {...queue,expectedRevision:'1'},{...queue,requestKey:'bad'},{...configuration,enabled:'true'},{...configuration,expectedRevision:Infinity}]){
    assert.throws(()=>contract.parseCustomerFolderCommand(bad))
  }
  for(const value of ['https://bposupplychain.com/s/shortlink','http://drive.google.com/drive/folders/id',
    'https://drive.google.com.evil.test/drive/folders/id','https://user@drive.google.com/drive/folders/id',
    'https://drive.google.com/drive/folders/id/other','https://drive.google.com/file/d/id',
    'https://drive.google.com/drive/folders/%2fsecret','https://drive.google.com/drive/folders/id#fragment','../id']){
    assert.throws(()=>contract.customerDriveFolderId(value),undefined,value)
  }
})
function serviceHarness(){
  const calls=[],state={account:{...base,id:base.accountId,globalId:'ga1234567',name:'Customer',isCustomer:true,hasManualLink:false},
    canEdit:true,canConfigure:true,settings:{enabled:false,revision:0,parentUrl:null},job:null,folder:null}
  const h={calls,state,folder:{id:'parent-id',name:'01 Customers',mimeType:'application/vnd.google-apps.folder',trashed:false,
    driveId:'bpo-drive',capabilities:{canAddChildren:true}},providerError:null}
  h.api=load('app_src/lib/crm/customerFolderControlService.ts',{'./customerDriveFolders':core,
    '@/lib/persistence/crmCustomerFolderControls':{readCustomerFolderControls:async input=>{calls.push(['read',input]);return structuredClone(state)},
      requestCustomerFolderJob:async input=>{calls.push(['queue',input])},saveVerifiedCustomerFolderSettings:async input=>{calls.push(['save',input])},
      pauseCustomerFolderSettings:async input=>{calls.push(['pause',input])}},
    '@/lib/integrations/googleWorkspace':{resolveGoogleWorkspacePrivateFileRuntime:async()=>{calls.push(['credentials']);if(h.providerError)throw h.providerError;return {serviceAccountEmail:'fixture@project.iam.gserviceaccount.com'}},
      resolveManagedGoogleWorkspaceRuntime:async binding=>{calls.push(['drive-binding',binding]);return {}}},
    '@/lib/integrations/googleWorkspaceClient':{googleDriveJson:async(runtime,path)=>{calls.push(['provider',path]);return structuredClone(h.folder)}}})
  return h
}
await check('service denies read-only/non-admin or stale setup before credentials/provider access',async()=>{
  for(const scenario of ['viewer','non-admin','stale']){
    const h=serviceHarness()
    if(scenario==='viewer')h.state.canEdit=false
    if(scenario==='non-admin')h.state.canConfigure=false
    if(scenario==='stale')h.state.settings.revision=9
    await assert.rejects(h.api.applyCustomerFolderCommand(configuration,actor))
    assert.ok(!h.calls.some(([kind])=>kind==='provider'||kind==='credentials'||kind==='save'))
  }
})
await check('setup verifies exact live Customers parent and independent shared drive before scoped persistence',async()=>{
  const h=serviceHarness();await h.api.applyCustomerFolderCommand(configuration,actor)
  const saved=h.calls.find(([kind])=>kind==='save')[1]
  assert.equal(saved.sharedDriveId,'bpo-drive');assert.equal(saved.parentId,'parent-id');assert.equal(saved.actorEmail,actor)
  assert.deepEqual(h.calls.find(([kind])=>kind==='drive-binding')[1],{serviceAccountEmail:'fixture@project.iam.gserviceaccount.com',sharedDriveId:'bpo-drive'})
  assert.ok(h.calls.findIndex(([kind])=>kind==='provider')<h.calls.findIndex(([kind])=>kind==='save'))
  assert.ok(!JSON.stringify(h.calls).includes('files?'))
})
await check('wrong parent name/type/identity/drive, trash or missing write capability prevents saving',async()=>{
  for(const edit of [{name:'Invoices'},{mimeType:'application/pdf'},{id:'other'},{driveId:''},{trashed:true},{capabilities:{canAddChildren:false}}]){
    const h=serviceHarness();Object.assign(h.folder,edit)
    await assert.rejects(h.api.applyCustomerFolderCommand(configuration,actor),/customers_parent_required/)
    assert.ok(!h.calls.some(([kind])=>kind==='save'))
  }
})
await check('pause works without provider credentials/network and a confirmed lost-response setup replay is read-only',async()=>{
  const h=serviceHarness();Object.assign(h.state.settings,{enabled:true,revision:1,parentUrl:'https://drive.google.com/drive/folders/parent-id'})
  h.providerError=Error('provider outage')
  await h.api.applyCustomerFolderCommand({...configuration,enabled:false,expectedRevision:1},actor)
  assert.ok(h.calls.some(([kind])=>kind==='pause'));assert.ok(!h.calls.some(([kind])=>kind==='credentials'))
  const replay=serviceHarness();Object.assign(replay.state.settings,{enabled:true,revision:1,parentUrl:'https://drive.google.com/drive/folders/parent-id'})
  await replay.api.applyCustomerFolderCommand(configuration,actor)
  assert.deepEqual(replay.calls.map(([kind])=>kind),['read'])
})
await check('exact single-customer queue dispatch does not read credentials or create provider files synchronously',async()=>{
  const h=serviceHarness();await h.api.applyCustomerFolderCommand(queue,actor)
  assert.deepEqual(h.calls.find(([kind])=>kind==='queue')[1],{...queue,actorEmail:actor})
  assert.ok(!h.calls.some(([kind])=>kind==='credentials'||kind==='provider'))
})
function routeHarness(){
  const calls=[],h={calls,authorized:true,postgres:true,viewer:false,denyPipeline:false,impersonating:false,applyError:null}
  const state={fixture:true},deps={'next/server':{NextRequest,NextResponse},
    '@/lib/requestUser':{requestSession:async()=>({authenticatedUser:actor,effectiveUser:actor,impersonating:h.impersonating}),
      requireRequestUser:async()=>{if(!h.authorized)throw Error('Unauthorized');return {email:actor}}},
    '@/lib/tenancy':{resolvePipelineSpaceAccess:async input=>{calls.push(['access',input.pipelineId]);if(h.denyPipeline)throw Error('Pipeline access denied');return {accessRole:h.viewer?'viewer':'owner'}},
      requireResourceEditor:resource=>{if(resource.accessRole==='viewer')throw Error('This resource is view-only')}},
    '@/lib/persistence/config':{isPostgresStorageEnabled:()=>h.postgres},
    '@/lib/browserSameOrigin':{isBrowserSameOriginRequest:({headers,requestOrigin})=>headers.get('origin')===requestOrigin},
    '@/lib/persistence/crmCustomerFolderControls':{readCustomerFolderControls:async input=>{calls.push(['read',input]);return state}},
    '@/lib/crm/customerFolderControlService':{applyCustomerFolderCommand:async(...args)=>{calls.push(['apply',args]);if(h.applyError)throw h.applyError;return state}},
    '@/lib/crm/customerFolderControls':contract,'@/lib/crm/customerDriveFolders':core}
  h.api=load('app_src/app/api/crm/customer-folders/route.ts',deps)
  h.get=()=>h.api.GET(new NextRequest(`https://fixture.test/api/crm/customer-folders?${new URLSearchParams(base)}`))
  h.post=(body=queue,headers={})=>h.api.POST(new NextRequest('https://fixture.test/api/crm/customer-folders',{
    method:'POST',headers:{origin:'https://fixture.test','content-type':'application/json',...headers},body:JSON.stringify(body)}))
  return h
}
await check('actual GET is no-store and scoped to both IDs; rejected pipeline never falls back',async()=>{
  const h=routeHarness(),response=await h.get();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store')
  assert.deepEqual(h.calls.find(([kind])=>kind==='read')[1],{...base,actorEmail:actor})
  const denied=routeHarness();denied.denyPipeline=true;assert.equal((await denied.get()).status,403)
  assert.deepEqual(denied.calls,[['access',base.pipelineId]])
})
await check('actual POST rejects cross-origin, unauthenticated, preview, viewer, malformed, oversized and injected authority commands',async()=>{
  const foreign=routeHarness();assert.equal((await foreign.post(queue,{origin:'https://evil.test'})).status,403);assert.equal(foreign.calls.length,0)
  for(const [change,status] of [[h=>{h.authorized=false},401],[h=>{h.impersonating=true},409],[h=>{h.viewer=true},403]]){
    const h=routeHarness();change(h);assert.equal((await h.post()).status,status);assert.ok(!h.calls.some(([kind])=>kind==='apply'))
  }
  const oversized=routeHarness();assert.equal((await oversized.post(queue,{'content-length':'9000'})).status,413)
  const injected=routeHarness();assert.equal((await injected.post({...queue,actorEmail:'forged@example.test'})).status,400)
  assert.ok(!injected.calls.some(([kind])=>kind==='apply'))
  const body=routeHarness();assert.equal((await body.post({...queue,unused:'x'.repeat(9000)})).status,413)
  let pulls=0,cancelled=false
  const stream=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(9000))},cancel(){cancelled=true}})
  const streaming=routeHarness(),response=await streaming.api.POST(new NextRequest('https://fixture.test/api/crm/customer-folders',{
    method:'POST',headers:{origin:'https://fixture.test'},body:stream,duplex:'half'}))
  assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(pulls<=2,'oversized chunked request must not be drained/buffered')
  assert.equal(streaming.calls.length,0)
})
await check('actual POST uses authenticated actor and exact typed command; unexpected failures disclose no private detail',async()=>{
  const h=routeHarness();assert.equal((await h.post()).status,200)
  assert.deepEqual(h.calls.find(([kind])=>kind==='apply')[1],[queue,actor])
  const bad=routeHarness();bad.applyError=Error('private token secret email folder SQL')
  const response=await bad.post();assert.equal(response.status,500);assert.ok(!(await response.text()).includes('private token'))
})
console.log(`${count} customer folder command/service/HTTP checks passed (synthetic auth, persistence and provider)`)
