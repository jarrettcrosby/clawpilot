#!/usr/bin/env node
// Actual coordinator + Google adapter; synthetic provider/store. No live Drive,
// PostgreSQL, UI, calendar, native CRM or deployment proof.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript')
function load(path,deps={}) {
  const module={exports:{}}
  const code=ts.transpileModule(readFileSync(new URL(`../${path}`,import.meta.url),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('module','exports','require','fetch',code)(module,module.exports,name=>{
    assert.ok(Object.hasOwn(deps,name),`Unexpected import ${name}`);return deps[name]},(...args)=>fetchHandler(...args))
  return module.exports
}
const core=load('app_src/lib/crm/customerDriveFolders.ts'),copy=x=>structuredClone(x)
const links=load('app_src/lib/crm/customerFolderLinks.ts')
const publication=load('app_src/lib/crm/customerFolderPublication.ts',{
  './customerFolderLinks':links,'./customerDriveFolders':core})
const scope={workspaceId:'00000000-0000-4000-8000-000000000001',pipelineId:'00000000-0000-4000-8000-000000000002',
  accountId:'00000000-0000-4000-8000-000000000003',accountGlobalId:'ga1234567',sharedDriveId:'drive-1',
  customersParentId:'customers-parent',serviceAccountEmail:'fixture@project.iam.gserviceaccount.com'}
function harness() {
  const files=new Map(),creates=[],calls=[],plans=[];let reserved=null,completed=0,generation=0,drop=false,readFailure=false
  const file=(id,name,parentId,appProperties={})=>({id,name,driveId:scope.sharedDriveId,
    mimeType:'application/vnd.google-apps.folder',parents:parentId?[parentId]:[],trashed:false,appProperties})
  files.set(scope.customersParentId,file(scope.customersParentId,'01 Customers','drive-1'))
  const store={read:async s=>{assert.deepEqual(s,scope);return copy(reserved)},reserve:async p=>{
    core.assertCustomerFolderPlan(p,scope);if(!reserved){reserved=copy(p);plans.push(copy(p))}return copy(reserved)},
    complete:async p=>{assert.deepEqual(p,reserved);completed++}}
  const drive={get:async id=>{calls.push(['get',id]);if(readFailure)throw new Error('read failed');return copy(files.get(id)??null)},
    namedChildren:async(parent,name)=>[...files.values()].filter(f=>f.parents.includes(parent)&&f.name===name).map(copy),
    generateIds:async count=>Array.from({length:count},()=>`generated-${++generation}`),
    create:async input=>{assert.ok(reserved,'create requires durable reservation first');creates.push(copy(input))
      if(!files.has(input.id))files.set(input.id,file(input.id,input.name,input.parentId,input.properties))
      if(drop){drop=false;throw new Error('response lost')}}}
  return {files,creates,calls,plans,file,store,drive,run:extra=>core.provisionBpoCustomerFolders({scope,customerName:'Globus',store,drive,...extra}),
    drop:()=>{drop=true},failRead:()=>{readFailure=true},get completed(){return completed},get reserved(){return reserved}}
}
let passed=0
async function check(name,work){await work();passed++;console.log(`PASS ${name}`)}
await check('exact established layout reserved once before creates and independently read back',async()=>{
  const h=harness(),result=await h.run()
  assert.equal(h.creates.length,8);assert.equal(h.completed,1);assert.equal(h.plans.length,1)
  assert.deepEqual(result.plan.nodes.slice(1).map(n=>n.name),core.BPO_CUSTOMER_FOLDER_LAYOUT.slice(1).map(n=>n[1]))
  assert.equal(result.url,`https://drive.google.com/drive/folders/${result.rootId}`)
  assert.ok(h.calls.filter(c=>c[0]==='get'&&c[1]===result.rootId).length>=3)
})
await check('replay and customer/provider rename preserve root identity and do not create more',async()=>{
  const h=harness(),first=await h.run();h.files.get(first.rootId).name='Renamed outside app'
  const second=await h.run({customerName:'Renamed customer'})
  assert.deepEqual(second,first);assert.equal(h.creates.length,8);assert.equal(h.plans.length,1)
})
await check('lost successful create response resumes exact persisted ID without duplicate',async()=>{
  const h=harness();h.drop();await assert.rejects(h.run(),/response lost/)
  assert.equal(h.completed,0);assert.equal(h.files.size,2)
  const root=h.reserved.nodes[0].id;assert.equal((await h.run()).rootId,root)
  assert.equal(h.creates.length,8);assert.equal(h.files.size,9)
})
await check('concurrent first requests converge on one atomic reservation',async()=>{
  const h=harness(),results=await Promise.all([h.run(),h.run()])
  assert.equal(results[0].rootId,results[1].rootId);assert.equal(h.plans.length,1)
  assert.equal(new Set(h.creates.map(c=>c.id)).size,8);assert.equal(h.files.size,9)
})
await check('existing name requires explicit adoption and creates nothing',async()=>{
  const h=harness();h.files.set('manual-root',h.file('manual-root','Globus',scope.customersParentId))
  await assert.rejects(h.run(),/existing_root_requires_adoption/);assert.equal(h.creates.length,0);assert.equal(h.reserved,null)
})
await check('explicit existing root and children reused without retagging, renaming or sharing',async()=>{
  const h=harness();h.files.set('manual-root',h.file('manual-root','Old customer spelling',scope.customersParentId))
  const child=h.file('manual-account','00 Account','manual-root',{unrelated:'preserved'})
  h.files.set(child.id,copy(child));const before=copy(h.files.get('manual-root'))
  const result=await h.run({adoptRootId:'manual-root'})
  assert.equal(result.rootId,'manual-root');assert.equal(h.creates.length,6)
  assert.deepEqual(h.files.get('manual-root'),before);assert.deepEqual(h.files.get(child.id),child)
})
await check('duplicate children or foreign managed identity stop before any provider creation',async()=>{
  for(const kind of ['duplicate','foreign']){
    const h=harness();h.files.set('manual-root',h.file('manual-root','Globus',scope.customersParentId,
      kind==='foreign'?{pipelineId:'different-pipeline'}:{}))
    if(kind==='duplicate')for(const id of ['one','two'])h.files.set(id,h.file(id,'00 Account','manual-root'))
    await assert.rejects(h.run({adoptRootId:'manual-root'}),/duplicate_children|identity_conflict/)
    assert.equal(h.creates.length,0)
  }
})
await check('wrong drive, moved/trashed root, adopted missing folder and permission failures never recreate',async()=>{
  for(const mutation of ['drive','moved','trashed','read-failure']){
    const h=harness(),first=await h.run(),count=h.creates.length
    if(mutation==='drive')h.files.get(first.rootId).driveId='other-drive'
    if(mutation==='moved')h.files.get(first.rootId).parents=['elsewhere']
    if(mutation==='trashed')h.files.get(first.rootId).trashed=true
    if(mutation==='read-failure')h.failRead()
    await assert.rejects(h.run());assert.equal(h.creates.length,count)
  }
  const h=harness();h.files.set('manual-root',h.file('manual-root','Globus',scope.customersParentId))
  await h.run({adoptRootId:'manual-root'});h.files.delete('manual-root')
  await assert.rejects(h.run(),/adopted_folder_missing/);assert.equal(h.creates.length,7)
})
await check('cross-account/pipeline/parent/runtime reservation drift is refused',async()=>{
  const h=harness(),{plan}=await h.run()
  for(const key of ['workspaceId','pipelineId','accountId','accountGlobalId','sharedDriveId','customersParentId','serviceAccountEmail']){
    assert.throws(()=>core.assertCustomerFolderPlan(plan,{...scope,[key]:key.endsWith('Id')&&key!=='sharedDriveId'&&key!=='customersParentId'
      ?'00000000-0000-4000-8000-000000000099':key==='accountGlobalId'?'ga7654321':key==='serviceAccountEmail'?'other@project.iam.gserviceaccount.com':'different'}))
  }
  await assert.rejects(h.run({adoptRootId:'different-root'}),/adoption_changed/)
})
class ClientError extends Error{constructor(status){super('synthetic provider error');this.upstreamStatus=status}}
let requests=[],handler
const adapter=load('app_src/lib/crm/customerDriveFolderGoogle.ts',{
  './customerDriveFolders':core,'@/lib/integrations/googleWorkspaceClient':{GoogleWorkspaceClientError:ClientError,
    googleDriveJson:async(runtime,path,input)=>{requests.push({path,input});return handler(path,input)}}})
const google=()=>adapter.customerFolderGoogleDrive({sharedDriveId:scope.sharedDriveId,serviceAccountEmail:scope.serviceAccountEmail},scope)
await check('Google adapter distinguishes exact 404 absence from auth/timeout errors',async()=>{
  for(const status of [401,403,500]){handler=()=>{throw new ClientError(status)};await assert.rejects(google().get('folder'))}
  handler=()=>{throw new ClientError(404)};assert.equal(await google().get('folder'),null)
  assert.throws(()=>adapter.customerFolderGoogleDrive({sharedDriveId:'other'},scope),/runtime_mismatch/)
})
await check('Google adapter completes pagination and refuses incomplete/repeating search',async()=>{
  requests=[];handler=path=>new URL(path,'https://fixture.test').searchParams.has('pageToken')
    ?{files:[{id:'second'}]}:{files:[{id:'first'}],nextPageToken:'page-two'}
  assert.deepEqual((await google().namedChildren('parent',"O'Brien")).map(f=>f.id),['first','second'])
  assert.ok(new URL(requests[0].path,'https://fixture.test').searchParams.get('q').includes("O\\'Brien"))
  handler=()=>({files:[],incompleteSearch:true});await assert.rejects(google().namedChildren('parent','name'),/search_incomplete/)
  handler=()=>({files:[],nextPageToken:'repeat'});await assert.rejects(google().namedChildren('parent','name'),/search_incomplete/)
})
await check('Google create retries fixed IDs only, does not grant permissions, and leaves conflict readback to coordinator',async()=>{
  requests=[];handler=()=>{throw new ClientError(409)}
  await google().create({id:'fixed-id',name:'00 Account',parentId:'root',properties:{accountGlobalId:scope.accountGlobalId}})
  assert.equal(requests.length,1);assert.equal(requests[0].input.body.id,'fixed-id');assert.equal(requests[0].input.idempotent,true)
  assert.equal(requests[0].input.method,'POST');assert.ok(!requests[0].path.includes('permissions'))
  handler=()=>{throw new ClientError(403)};await assert.rejects(google().create({id:'fixed-id',name:'name',parentId:'root',properties:{}}))
})
let fetchHandler
const actualGoogleClient=load('app_src/lib/integrations/googleWorkspaceClient.ts',{'google-auth-library':{JWT:class{}}})
const actualGoogle=load('app_src/lib/crm/customerDriveFolderGoogle.ts',{
  './customerDriveFolders':core,'@/lib/integrations/googleWorkspaceClient':actualGoogleClient})
await check('actual Google client maps HTTP 404/409 without confusing its app-facing status with upstream status',async()=>{
  const drive=actualGoogle.customerFolderGoogleDrive({sharedDriveId:scope.sharedDriveId,serviceAccountEmail:scope.serviceAccountEmail,
    authClient:{getAccessToken:async()=>({token:'fixture-only'})},apiKey:null},scope)
  let status=404
  fetchHandler=async()=>new Response(JSON.stringify({error:{message:'fixture-only'}}),{status})
  assert.equal(await drive.get('folder'),null)
  status=403;await assert.rejects(drive.get('folder'),error=>error.code==='GOOGLE_ACCESS_DENIED'&&error.upstreamStatus===403)
  status=409;await drive.create({id:'fixed',name:'name',parentId:'root',properties:{}})
  // A 404 create is NOT a duplicate-ID conflict, even though its app-facing
  // error status is 409. Nor is an internal 409 error evidence of absence.
  status=404;await assert.rejects(drive.create({id:'fixed',name:'name',parentId:'root',properties:{}}),
    error=>error.code==='GOOGLE_RESOURCE_NOT_FOUND'&&error.status===409&&error.upstreamStatus===404)
})
await check('publication preserves current notes and Fractional link, then replays without duplicate lines',async()=>{
  const description='Notes updated while provisioning\r\nFractional Customer Folder: https://fractional.example.test/s/customer\r\nTail'
  const first=publication.prepareCustomerFolderPublication({description,rootId:'verified-root',status:'pending',adopted:false})
  assert.ok(first.description.startsWith(description));assert.equal(first.status,'published')
  assert.equal(links.parseCustomerFolderLinks(first.description).values.fractionalCustomerFolderUrl,'https://fractional.example.test/s/customer')
  assert.deepEqual(publication.prepareCustomerFolderPublication({...first,rootId:'verified-root',adopted:false}),first)
  assert.equal(first.description.match(/BPO Supply Chain Drive:/g).length,1)
})
await check('later manual replacement or clearing is never overwritten or reinserted',async()=>{
  for(const description of ['Notes only','Notes\nBPO Supply Chain Drive: https://bpo.example.test/s/manual']){
    const next=publication.prepareCustomerFolderPublication({description,rootId:'verified-root',status:'published',adopted:false})
    assert.deepEqual(next,{description,status:'manual_override'})
    assert.deepEqual(publication.prepareCustomerFolderPublication({...next,rootId:'verified-root',adopted:false}),next)
  }
})
await check('existing manual link blocks fresh creation but explicit adoption preserves its exact spelling',async()=>{
  const description='BPO Supply Chain Drive: https://bposupplychain.com/s/existing-invoice'
  await assert.rejects(async()=>publication.prepareCustomerFolderPublication({description,rootId:'selected-root',status:'pending',adopted:false}),/requires_adoption/)
  assert.deepEqual(publication.prepareCustomerFolderPublication({description,rootId:'selected-root',status:'pending',adopted:true}),
    {description,status:'manual_override'})
})
await check('ambiguous or unsafe description lines and invalid publication state hold instead of overwriting',async()=>{
  for(const description of ['BPO Supply Chain Drive: javascript:unsafe','BPO Supply Chain Drive: https://one.test/\nBPO Supply Chain Drive: https://two.test/']){
    assert.throws(()=>publication.prepareCustomerFolderPublication({description,rootId:'root',status:'pending',adopted:false}),/description_requires_repair/)
  }
  assert.throws(()=>publication.prepareCustomerFolderPublication({description:'',rootId:'root',status:'unknown',adopted:false}),/publication_invalid/)
})
console.log(`${passed} customer Drive provisioning checks passed (synthetic provider/store only)`)
