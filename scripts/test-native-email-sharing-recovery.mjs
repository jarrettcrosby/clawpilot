#!/usr/bin/env node
// Actual immutable plan and recovery helpers; SQL/runtime boundary mocked.
// No native execution, database authority, browser or production proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
function load(path,deps){const module={exports:{}}
  new Function('module','exports','require',ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(
    module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]})
  return module.exports}
const base=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const projection=load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts',{'node:crypto':crypto})
const capability=load('app_src/lib/crm/nativeEmailCapabilityContract.ts',{'node:crypto':crypto,'./nativeEmailPublication':base})
const authority=load('app_src/lib/crm/nativeEmailAuthorityTransition.ts',{'./nativeEmailPublication':base,
  './suiteCrmNativeEmailProjection':projection,'./nativeEmailCapabilityContract':capability})
const eligibility=load('app_src/lib/crm/nativeEmailEligibility.ts',{'./nativeEmailPublication':base})
const user=load('app_src/lib/crm/nativeEmailWorkspaceUserEligibility.ts',{'./nativeEmailPublication':base})
const identityLink=load('app_src/lib/crm/nativeEmailIdentityLinkChange.ts',{'./nativeEmailPublication':base,'./nativeEmailWorkspaceUserEligibility':user})
const adapter=load('app_src/lib/crm/nativeEmailAuthorityTransitionPostgres.ts',{'./nativeEmailPublication':base,
  './nativeEmailIdentityLinkChange':identityLink,
  './nativeEmailRootReaders':{}, // Read-only recovery contract does not execute a SQL snapshot.
  './nativeEmailEligibility':eligibility,'./nativeEmailWorkspaceUserEligibility':user,'./nativeEmailAuthorityTransition':authority,
  './nativeEmailAuthorityTransport':{},'./nativeEmailCapabilityContract':capability})
const fixtures=JSON.parse(execFileSync(process.execPath,['scripts/test-native-email-authority-runtime.mjs','--emit-role-fixture'],{encoding:'utf8'}))
const clone=value=>JSON.parse(JSON.stringify(value)),actor='owner@example.test',plan=fixtures.promotion
const binding=plan.revoke.bindings[0].before,workspace=binding.workspace_id,pipeline=binding.pipeline_id,tid=plan.revoke.transitionId
class Pending extends Error{status=409;code='CRM_ACCESS_CHANGE_PENDING';constructor(id=null){super('CRM access is pending');this.transitionId=id}}
function harness(edits={}){
  const calls=[],row={enabled:true,active_transition_id:tid,active_operation_id:null,transition_id:tid,
    actor_email:actor,plan_hash:plan.planHash,plan:clone(plan),grant_state:'unknown',pipeline_id:pipeline,workspace_id:workspace,pipeline_name:'Sales pipeline',...edits}
  const sql={rows:[row]},runtime={confirmed:true,error:null}
  const api=load('app_src/lib/crm/nativeEmailSharingRecovery.ts',{'../persistence/postgres':{query:async(text,values)=>{
    calls.push({sql:text,values});assert.doesNotMatch(text,/FOR UPDATE|INSERT |UPDATE |DELETE /i)
    assert.match(text,/p\.owner_email=\$1/);assert.match(text,/m\.role IN \('owner','admin','member'\)/);assert.match(text,/m\.trashed_at IS NULL/)
    assert.match(text,/jsonb_typeof\(m\.permissions\)='object'/);assert.match(text,/m\.permissions->'viewCrm'='true'::jsonb/)
    assert.match(text,/t\.actor_email=\$1/);assert.match(text,/NOT w\.is_demo/);assert.match(text,/g\.state<>'committed'/)
    return clone(sql)}},'./nativeEmailPublication':base,'./nativeEmailAuthorityTransition':authority,
    './nativeEmailAuthorityTransitionPostgres':adapter,'./nativeEmailAuthorityRuntime':{NativeEmailAccessPendingError:Pending,
      changePipelineMemberWithNativeAuthority:async(...args)=>{calls.push({runtime:clone(args)});if(runtime.error)throw runtime.error;return runtime.confirmed}}})
  return {api,calls,row,sql,runtime}
}
let count=0
async function check(name,run){await run();count++;console.log('PASS '+name)}
await check('owned discovery is one read and returns only frozen safe sharing metadata',async()=>{
  const h=harness(),value=await h.api.getPendingPipelineSharingChange(actor,workspace)
  assert.deepEqual(value,{transitionId:tid,workspaceId:workspace,pipelineId:pipeline,pipelineName:'Sales pipeline',userEmail:'reader-a@example.test',accessRole:'editor'})
  assert.ok(Object.isFrozen(value));assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].values,[actor,workspace])
  assert.ok(!JSON.stringify(value).includes('capabilit'));assert.ok(!JSON.stringify(value).includes(plan.planHash))
})
await check('absent completed disabled other-owner and other-workspace scopes reveal no pending ID',async()=>{
  for(const edits of [{enabled:false},{active_transition_id:null},{grant_state:'committed'},
    {actor_email:'someone-else@example.test'},{workspace_id:'00000000-0000-4000-8000-000000000099'}]){
    const h=harness(edits);assert.equal(await h.api.getPendingPipelineSharingChange(actor,workspace),null)
    await assert.rejects(()=>h.api.resumePipelineSharingChange(actor,workspace,tid),e=>e instanceof Pending&&e.transitionId===null)
    assert.ok(!h.calls.some(c=>c.runtime))
  }
  const h=harness();h.sql.rows=[];assert.equal(await h.api.getPendingPipelineSharingChange(actor,workspace),null)
})
await check('malformed inputs cannot query discover or execute global work',async()=>{
  const h=harness()
  for(const [email,scope]of[['Owner@example.test',workspace],[actor,'bad'],[null,workspace]])
    await assert.rejects(()=>h.api.getPendingPipelineSharingChange(email,scope),e=>e instanceof Pending&&e.transitionId===null)
  for(const invalid of ['bad',tid+'\n',[tid],null])await assert.rejects(()=>h.api.resumePipelineSharingChange(actor,workspace,invalid),e=>e instanceof Pending&&e.transitionId===null)
  assert.equal(h.calls.length,0)
})
await check('changed pins private plans bindings scope and member deltas fail without leaking diagnostics',async()=>{
  const edits=[r=>r.plan_hash='0'.repeat(64),r=>r.active_transition_id='0'.repeat(64),r=>r.active_operation_id='0'.repeat(64),
    r=>r.plan.planHash='0'.repeat(64),r=>r.pipeline_id='00000000-0000-4000-8000-000000000099',r=>r.grant_state='invalid',
    r=>r.plan.desiredAppChange.changes[0].after.user_email='forged@example.test',r=>r.plan.desiredAppChange.changes.push(r.plan.desiredAppChange.changes[0])]
  for(const edit of edits){const h=harness();edit(h.row)
    await assert.rejects(()=>h.api.getPendingPipelineSharingChange(actor,workspace),e=>e instanceof Pending&&e.transitionId===null)
    assert.ok(!h.calls.some(c=>c.runtime))}
})
await check('resume reconstructs exact saved role and passes expected ID, never browser form values',async()=>{
  const h=harness();await h.api.resumePipelineSharingChange(actor,workspace,tid)
  assert.deepEqual(h.calls.find(c=>c.runtime).runtime,[{actorEmail:actor,workspaceId:workspace,pipelineId:pipeline,userEmail:'reader-a@example.test',accessRole:'editor'},tid])
  const wrong=harness();await assert.rejects(()=>wrong.api.resumePipelineSharingChange(actor,workspace,'0'.repeat(64)),e=>e instanceof Pending&&e.transitionId===null)
  assert.ok(!wrong.calls.some(c=>c.runtime))
})
await check('runtime false or private failure stays held and carries only an already-owned ID',async()=>{
  for(const config of [{confirmed:false},{error:new Error('private SQL credentials')}]){
    const h=harness();Object.assign(h.runtime,config)
    await assert.rejects(()=>h.api.resumePipelineSharingChange(actor,workspace,tid),e=>e instanceof Pending&&e.transitionId===tid&&!e.message.includes('private'))
  }
})
await check('workspaces API discovers owned changes and resumes using only actor scope plus saved ID',async()=>{
  let visible=true,denied=false,pending=true,queries=0
  const calls=[],identity={email:actor,organizationId:workspace}
  class ModuleDenied extends Error{status=403}
  const metadata={transitionId:tid,workspaceId:workspace,pipelineId:pipeline,pipelineName:'Sales pipeline',userEmail:'reader-a@example.test',accessRole:'editor'}
  const route=load('app_src/app/api/workspaces/route.ts',{
    'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200,cookies:{set(){}}})}},
    '@/lib/dashboardWorkspace':{readDashboardWorkspace:async()=>({boards:[],pipelines:visible?[{id:pipeline,ownerEmail:actor}]:[]})},
    '@/lib/requestUser':{requireRequestUser:async()=>identity},
    '@/lib/moduleAuthorization':{ModuleAccessError:ModuleDenied,requireModuleAccess:(who,module)=>{assert.equal(who,identity);assert.equal(module,'crm');if(denied)throw new ModuleDenied()}},
    '@/lib/crm/nativeEmailAuthorityRuntime':{NativeEmailAccessPendingError:Pending},
    '@/lib/crm/nativeEmailSharingRecovery':{
      getPendingPipelineSharingChange:async(...args)=>{queries++;assert.deepEqual(args,[actor,workspace]);return pending?metadata:null},
      resumePipelineSharingChange:async(...args)=>{calls.push(args);pending=false}},
    '@/lib/pipelineProvisioning':{PipelineProvisioningRequestError:class extends Error{}},
    '@/lib/tenancy':{BOARD_SELECTION_COOKIE:'board',PIPELINE_SELECTION_COOKIE:'pipeline'},
  })
  const request=body=>({nextUrl:new URL('https://app.example.test/api/workspaces'),cookies:{get:()=>undefined},json:async()=>body})
  assert.deepEqual((await route.GET(request())).body.pendingSharingChange,metadata)
  const dashboard=request();dashboard.nextUrl.searchParams.set('dashboard','true')
  const beforeDashboard=queries
  assert.equal((await route.GET(dashboard)).body.pendingSharingChange,null)
  assert.equal(queries,beforeDashboard,'Dashboard fast path must not parse or discover a sharing transition')
  const done=await route.POST(request({action:'resume-sharing-change',transitionId:tid}))
  assert.equal(done.status,200);assert.equal(done.body.pendingSharingChange,null)
  assert.deepEqual(calls,[[actor,workspace,tid]])
  assert.equal((await route.POST(request({action:'resume-sharing-change',transitionId:tid,email:'unsubmitted@example.test',accessRole:'viewer'}))).status,400)
  assert.equal(calls.length,1,'Form fields must not be treated as a resumed action')
  denied=true;assert.equal((await route.POST(request({action:'resume-sharing-change',transitionId:tid}))).status,403)
  assert.equal(calls.length,1)
  visible=false;const before=queries
  assert.equal((await route.GET(request())).body.pendingSharingChange,null);assert.equal(queries,before,'Projects-only workspace payload does not discover CRM work')
})
console.log(`PASS ${count} sharing recovery groups; mocked query/runtime boundaries, no PG/native/production proof`)
