#!/usr/bin/env node
// Actual eligibility, typed lifecycle delta and capability derivation. Pure
// synthetic cases only; no SQL, native ACL, provider or production proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
function load(path,deps){const module={exports:{}}
  const code=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]})
  return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const eligibility=load('app_src/lib/crm/nativeEmailEligibility.ts',{'./nativeEmailPublication':protocol})
const user=load('app_src/lib/crm/nativeEmailWorkspaceUserEligibility.ts',{'./nativeEmailPublication':protocol})
const projection=load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts',{'node:crypto':crypto})
const capability=load('app_src/lib/crm/nativeEmailCapabilityContract.ts',{'node:crypto':crypto,'./nativeEmailPublication':protocol})
const transition=load('app_src/lib/crm/nativeEmailAuthorityTransition.ts',{'./nativeEmailPublication':protocol,
  './suiteCrmNativeEmailProjection':projection,'./nativeEmailCapabilityContract':capability})
const planner=load('app_src/lib/crm/nativeEmailAuthorityPlan.ts',{'./nativeEmailPublication':protocol,
  './nativeEmailEligibility':eligibility,'./nativeEmailWorkspaceUserEligibility':user,
  './suiteCrmNativeEmailProjection':projection,'./nativeEmailAuthorityTransition':transition})
const fixture=JSON.parse(execFileSync(process.execPath,['scripts/test-native-email-authority-v2.mjs','--emit-fixture'],{encoding:'utf8'}))
const copy=value=>JSON.parse(JSON.stringify(value)),row=user.nativeEmailEligibilityRowJson,hash=protocol.nativeEmailDigest
const binding=fixture.plan.revoke.bindings[0].before,workspaceId=binding.workspace_id,pipelineId=binding.pipeline_id
const identity={email:'reader@example.test',status:'active',suitecrm_user_id:'reader-a',role:'member',permissions:{},organization_id:workspaceId}
const membership={user_email:identity.email,organization_id:workspaceId,status:'active',role:'member',permissions:{},
  trashed_at:null,trashed_by:null,pre_trash_status:null}
const base=()=>({kind:'workspace_user_eligibility_v1',workspaceId,userEmail:identity.email,
  actorScope:{workspaceId,ancestryJson:row([{id:workspaceId,parent_id:null,is_demo:false}])},
  action:{kind:'status',status:'disabled'},pipelineIntentFingerprint:'f'.repeat(64),appUser:{beforeJson:row(identity),afterJson:row({...identity,status:'disabled'})},
  membership:{beforeJson:row(membership),afterJson:row({...membership,status:'disabled'})},demoMembership:null,restoreFrom:null})
let count=0
async function check(name,fn){await fn();count++;console.log('PASS '+name)}
await check('typed user delta preserves empty permission objects as canonical strings and fixed native identity',()=>{
  assert.deepEqual(user.prepareNativeEmailWorkspaceUserEligibilityChange(base()),base())
  const request={workspaceId,userEmail:identity.email,action:{kind:'access',role:'member',permissions:{viewCrm:false}}}
  assert.equal(user.normalizeNativeEmailWorkspaceUserEligibilityRequest(request).action.permissionsJson,'{"viewCrm":false}')
  assert.notEqual(row({}),row([]))
})
await check('typed user delta refuses extra keys, native remap, forged action and fabricated trash state',()=>{
  const edits=[v=>v.extra=true,v=>v.appUser.afterJson=row({...identity,status:'disabled',suitecrm_user_id:'someone-else'}),
    v=>v.membership.afterJson=row({...membership,status:'disabled',role:'admin'}),v=>v.action.status='active',
    v=>v.membership.afterJson=row({...membership,status:'disabled',permissions:[]}),
    v=>v.membership.afterJson=row({...membership,status:'disabled',trashed_at:'not-a-date'}),
    v=>v.pipelineIntentFingerprint='unknown',v=>v.restoreFrom={transitionId:'a'.repeat(64),planHash:'bad'},
    v=>v.appUser.beforeJson=' '+v.appUser.beforeJson]
  for(const edit of edits){const value=base();edit(value);assert.throws(()=>user.prepareNativeEmailWorkspaceUserEligibilityChange(value))}
})
await check('actor ancestry is exact target-to-source, bounded, unique and not an unrelated manager graph',()=>{
  const parent='00000000-0000-4000-8000-000000000099',value=base()
  value.actorScope={workspaceId:parent,ancestryJson:row([{id:workspaceId,parent_id:parent,is_demo:false},
    {id:parent,parent_id:null,is_demo:false}])}
  user.prepareNativeEmailWorkspaceUserEligibilityChange(value)
  const edits=[v=>v.actorScope.workspaceId=workspaceId,
    v=>v.actorScope.ancestryJson=row([{id:workspaceId,parent_id:null,is_demo:false},{id:parent,parent_id:null,is_demo:false}]),
    v=>v.actorScope.ancestryJson=row([{id:workspaceId,parent_id:workspaceId,is_demo:false},{id:workspaceId,parent_id:null,is_demo:false}]),
    v=>v.actorScope.ancestryJson=row([{id:workspaceId,parent_id:parent,is_demo:false},{id:parent,parent_id:null,is_demo:true}]),
    v=>v.actorScope.ancestryJson=' '+v.actorScope.ancestryJson,
    v=>v.actorScope.extra=true]
  for(const edit of edits){const candidate=copy(value);edit(candidate);assert.throws(()=>user.prepareNativeEmailWorkspaceUserEligibilityChange(candidate))}
})
await check('trash records exact pre-trash status and restore cannot silently activate an invited identity',()=>{
  const value=base();value.action={kind:'trash',trashed:true}
  value.membership.afterJson=row({...membership,status:'disabled',trashed_at:'2026-10-30T12:00:00+00:00',
    trashed_by:'owner@example.test',pre_trash_status:'active'})
  user.prepareNativeEmailWorkspaceUserEligibilityChange(value)
  const restore=copy(value);restore.action={kind:'trash',trashed:false}
  restore.appUser={beforeJson:value.appUser.afterJson,afterJson:value.appUser.beforeJson}
  restore.membership={beforeJson:value.membership.afterJson,afterJson:value.membership.beforeJson}
  user.prepareNativeEmailWorkspaceUserEligibilityChange(restore)
  const invalid=base();invalid.membership.beforeJson=row({...membership,status:'invited'});invalid.action.status='active'
  invalid.membership.afterJson=row(membership);assert.throws(()=>user.prepareNativeEmailWorkspaceUserEligibilityChange(invalid))
})
const principal=(email,nativeId,role='member',extra={})=>({email,suitecrm_user_id:nativeId,status:'active',membership_status:'active',
  membership_role:role,membership_permissions:{},membership_trashed_at:null,native_identity_count:1,...extra})
const owner=principal('owner@example.test','native-owner','owner')
await check('shared eligibility excludes explicit denied states but rejects missing or ambiguous identity',()=>{
  for(const denied of [{status:'disabled'},{membership_status:'invited'},{membership_trashed_at:'2026-10-30'},
    {membership_permissions:{viewCrm:false}}])assert.equal(eligibility.nativeEmailPrincipalIsEligible(principal(identity.email,'reader-a','member',denied)),false)
  for(const invalid of [{status:'unknown'},{suitecrm_user_id:null},{native_identity_count:2},
    {membership_permissions:[]},{membership_permissions:{viewCrm:'false'}}])
    assert.throws(()=>eligibility.nativeEmailPrincipalIsEligible(principal(identity.email,'reader-a','member',{status:'disabled',...invalid})))
  assert.equal(eligibility.nativeEmailPrincipalIsEligible({...owner,membership_permissions:{viewCrm:false}}),true)
})
const encoded=p=>({...p,membership_permissions:['object',Object.entries(p.membership_permissions).sort().map(([k,v])=>[k,['boolean',v]])]})
await check('root reader witnesses are scoped read authority, never a manual target membership or editor grant',()=>{
  const rootReader={pipeline_id:pipelineId,workspace_id:workspaceId,grant_id:'00000000-0000-4000-8000-000000000801',
    operator_account_id:'00000000-0000-4000-8000-000000000802',email:identity.email,suitecrm_user_id:'reader-a',native_identity_count:1,
    source_fingerprint:'a'.repeat(64),registry_fingerprint:'b'.repeat(64),allowed:true}
  const scope={pipeline:{id:pipelineId,workspace_organization_id:workspaceId,owner_email:owner.email},members:[],principals:[encoded(owner)],rootReaders:[rootReader]}
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(p=>p.email),[owner.email,identity.email])
  assert.deepEqual(eligibility.nativeEmailManualPipelinePrincipals(scope).map(p=>p.email),[owner.email])
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals({...scope,rootReaders:[{...rootReader,allowed:false}]}).map(p=>p.email),[owner.email])
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals({...scope,rootReaders:[{...rootReader,suitecrm_user_id:null,native_identity_count:0}]}).map(p=>p.email),[owner.email])
  for(const change of [{workspace_id:'00000000-0000-4000-8000-000000000803'},{pipeline_id:'00000000-0000-4000-8000-000000000803'},
    {access_role:'editor'},{source_fingerprint:'bad'},{registry_fingerprint:'bad'},{native_identity_count:2},{suitecrm_user_id:owner.suitecrm_user_id},
    {suitecrm_user_id:null,native_identity_count:1},{email:'Reader@example.test'}])
    assert.throws(()=>eligibility.nativeEmailEffectivePipelinePrincipals({...scope,rootReaders:[{...rootReader,...change}]}))
  assert.throws(()=>eligibility.nativeEmailEffectivePipelinePrincipals({...scope,rootReaders:[rootReader,rootReader]}))
  const missing=principal(identity.email,'reader-a','member',{workspace_id:null,membership_status:null,membership_role:null,membership_permissions:null,membership_trashed_at:null})
  assert.throws(()=>eligibility.nativeEmailPrincipalIsEligible(missing))
  assert.equal(eligibility.nativeEmailPrincipalIsEligible(missing,false,true),false)
  const stale={...scope,members:[{user_email:identity.email,access_role:'editor'}],principals:[encoded(owner),{...missing,membership_permissions:['null']}]}
  assert.deepEqual(eligibility.nativeEmailManualPipelinePrincipals(stale).map(p=>p.email),[owner.email])
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(stale).map(p=>p.email),[owner.email,identity.email])
})
const retained={pipeline_id:pipelineId,user_email:identity.email,access_role:'editor',shared_by:owner.email,
  created_at:'2026-10-30T12:00:00+00:00',updated_at:'2026-10-30T12:00:00+00:00'}
await check('effective scope retains intended member row while inactive reader is excluded and owner still mandatory',()=>{
  const scope={pipeline:{id:pipelineId,owner_email:owner.email},members:[retained],principals:[encoded(owner),encoded(principal(identity.email,'reader-a','member',{status:'disabled'}))]}
  const original=copy(scope)
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(value=>value.email),[owner.email]);assert.deepEqual(scope,original)
  scope.principals[0].status='disabled';assert.throws(()=>eligibility.nativeEmailEffectivePipelinePrincipals(scope))
})
await check('app-only identity is explicit null plus numeric zero; duplicate app emails and missing native owners still fail',()=>{
  const first=principal('app-only@example.test',null,'member',{native_identity_count:0})
  const second={...first,email:'app-only-two@example.test'}
  assert.equal(eligibility.nativeEmailPrincipalIsEligible(first),false)
  for(const edit of [{native_identity_count:null},{native_identity_count:'0'},{native_identity_count:1},
    {suitecrm_user_id:undefined},{membership_permissions:null},{status:'unknown'}])
    assert.throws(()=>eligibility.nativeEmailPrincipalIsEligible({...first,...edit}))
  const members=[first,second].map(p=>({...retained,user_email:p.email}))
  const scope={pipeline:{id:pipelineId,owner_email:owner.email},members,principals:[encoded(owner),encoded(first),encoded(second)]}
  const before=copy(scope)
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(p=>p.email),[owner.email])
  assert.deepEqual(scope,before,'App-only intent stays in the complete hashed app snapshot')
  assert.throws(()=>eligibility.nativeEmailEffectivePipelinePrincipals({...scope,principals:[encoded(owner),encoded(first),encoded(first)]}))
  assert.throws(()=>eligibility.nativeEmailEffectivePipelinePrincipals({...scope,pipeline:{...scope.pipeline,owner_email:first.email}}))
})
const originalPlan=copy(fixture.plan)
originalPlan.planHash='a'.repeat(64);originalPlan.revoke.transitionId='b'.repeat(64)
originalPlan.revoke.capabilities[0].before.edit=['native-owner','reader-a']
const restored=base();restored.restoreFrom={transitionId:'b'.repeat(64),planHash:'a'.repeat(64)}
const noReader={view:['native-owner'],list:['native-owner'],export:['native-owner'],edit:['native-owner'],delete:['native-owner']}
const rights=(emailId,overrides={})=>user.nativeEmailEligibilityFinalCapabilities({change:restored,restoration:originalPlan,pipelineId,
  emailId,readers:['native-owner','reader-a'],before:noReader,...overrides})
await check('restore uses original per-email write subsets rather than retained editor role',()=>{
  assert.deepEqual(rights('email-native').edit,['native-owner','reader-a'])
  assert.deepEqual(rights('email-native').delete,['native-owner'])
  assert.deepEqual(rights('created-during-suspension').edit,['native-owner'])
  assert.deepEqual(rights('created-during-suspension').view,['native-owner','reader-a'])
  assert.deepEqual(rights(null).delete,['native-owner','reader-a'])
  assert.throws(()=>rights('email-native',{restoration:{...originalPlan,planHash:'c'.repeat(64)}}))
})
await check('restore preserves current unrelated rights and never grants a target absent from effective readers',()=>{
  const prior=Object.fromEntries(Object.entries(noReader).map(([surface,ids])=>[surface,[...ids,'reader-b']]))
  assert.deepEqual(rights('email-native',{before:prior,readers:['native-owner','reader-b']}).edit,['native-owner','reader-b'])
})
await check('first CRM access grants reads without fabricating historical or future edit/delete rights',()=>{
  const initial=base();initial.action={kind:'access',role:'member',permissionsJson:'{"viewCrm":true}'}
  initial.appUser={beforeJson:row(identity),afterJson:row(identity)}
  initial.membership={beforeJson:row({...membership,permissions:{viewCrm:false}}),afterJson:row({...membership,permissions:{viewCrm:true}})}
  user.prepareNativeEmailWorkspaceUserEligibilityChange(initial)
  for(const emailId of ['email-native','email-later',null]){
    const actual=user.nativeEmailEligibilityFinalCapabilities({change:initial,restoration:null,pipelineId,emailId,
      readers:['native-owner','reader-a'],before:noReader})
    for(const surface of ['view','list','export'])assert.deepEqual(actual[surface],['native-owner','reader-a'])
    for(const surface of ['edit','delete'])assert.deepEqual(actual[surface],['native-owner'])
  }
})
await check('actual lifecycle planner revokes disabled member with no application membership removal',async()=>{
  const command=fixture.plan.revoke
  const inspection={version:1,generation:command.generationFrom,nativePolicyFingerprint:command.beforePolicyFingerprint,
    runtimeFingerprint:command.runtimeFingerprint,beforeBindingsFingerprint:command.beforeBindingsFingerprint,
    bindings:command.bindings.map(pair=>copy(pair.before)),capabilities:command.capabilities.map(value=>({emailId:value.emailId,
      globalId:value.globalId,pipelineId:value.pipelineId,capabilities:copy(value.before)})),
    memberships:[copy(command.membershipChanges[0].before),{id:'membership-owner',date_modified:'2026-10-30 12:00:00',
      deleted:'0',securitygroup_id:binding.group_id,user_id:'native-owner',primary_group:'0',noninheritable:'1'}].sort((a,b)=>a.id.localeCompare(b.id)),
    principalSuiteCrmUserIds:JSON.parse(binding.capability_policy_json).principalSuiteCrmUserIds}
  const scope=status=>({pipeline:{id:pipelineId,owner_email:owner.email},workspace:{id:workspaceId,is_demo:false},
    members:[copy(retained)],principals:[encoded(owner),encoded(principal(identity.email,'reader-a','member',{status,membership_status:status}))]})
  const before={version:1,pipelines:[scope('active')],emails:[]},after={version:1,pipelines:[scope('disabled')],emails:[]}
  const plan=await planner.buildNativeEmailMemberTransition({app:{desiredAppChange:base(),appAuthorityBeforeFingerprint:hash(before),
    appAuthorityAfterFingerprint:hash(after),snapshots:{before,after,restoration:null}},inspection,transitionId:'c'.repeat(64),
    timestamp:'2026-10-30 13:00:00',newMembershipId:()=>assert.fail('must not add native memberships'),forecast:async request=>({version:1,
      beforePolicyFingerprint:request.beforePolicyFingerprint,revokePolicyFingerprint:'d'.repeat(64),grantPolicyFingerprint:'e'.repeat(64)})})
  assert.equal(plan.revoke.membershipChanges.length,1);assert.equal(plan.grant.membershipChanges.length,0)
  assert.deepEqual(plan.grant.capabilities[0].after.view,['native-owner'])
  assert.deepEqual(before.pipelines[0].members,after.pipelines[0].members)
  assert.equal(plan.desiredAppChange.kind,'workspace_user_eligibility_v1')
})
console.log(`PASS ${count} pure mapped-user eligibility groups; no database/native/deployment proof`)
