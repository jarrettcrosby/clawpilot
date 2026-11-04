#!/usr/bin/env node
// Pure first-link source contract. No database, provider, identity enrollment
// or permission grant is executed by these source-shape tests.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),ts=createRequire(resolve(root,'app_src/package.json'))('typescript'),cache=new Map()
function load(path){if(cache.has(path))return cache.get(path).exports
 const module={exports:{}};cache.set(path,module)
 new Function('require','module','exports',ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(
  name=>name==='node:crypto'?crypto:load(resolve(dirname(path),name+'.ts')),module,module.exports)
 return module.exports}
const api=load(resolve(root,'app_src/lib/crm/nativeEmailIdentityLinkChange.ts'))
const rows=load(resolve(root,'app_src/lib/crm/nativeEmailWorkspaceUserEligibility.ts'))
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,copy=x=>JSON.parse(JSON.stringify(x)),rowJson=rows.nativeEmailEligibilityRowJson
const user={email:'employee@example.test',status:'active',suitecrm_user_id:null,role:'member',permissions:{},organization_id:id(1),
 reference_code:'gu0123456789av',crm_user_enabled:true,suitecrm_username:null}
const linked={...user,suitecrm_user_id:id(3),suitecrm_username:user.reference_code}
const base={kind:'user_identity_link_v1',workspaceId:id(1),userEmail:user.email,
 actorScope:{workspaceId:id(1),ancestryJson:rowJson([{id:id(1),parent_id:null,is_demo:false}])},
 contextFingerprint:'a'.repeat(64),appUser:{beforeJson:rowJson(user),afterJson:rowJson(linked)},
 nativeIdentity:{userId:id(3),globalId:user.reference_code,username:user.reference_code}}
const request={workspaceId:base.workspaceId,userEmail:base.userEmail,nativeIdentity:base.nativeIdentity}
assert.deepEqual(api.normalizeNativeEmailUserIdentityLinkRequest(request),request)
for(const mutate of [v=>{v.permissions={viewCrm:true}},v=>{v.workspaceId='bad'},v=>{v.userEmail='UPPER@example.test'},
 v=>{v.nativeIdentity.userId='a'.repeat(37)},v=>{v.nativeIdentity.globalId='guINVALID'},v=>{v.nativeIdentity.username='other'},
 v=>{v.nativeIdentity.create=true},v=>{v.nativeIdentity=null}]){
 const invalid=copy(request);mutate(invalid);assert.throws(()=>api.normalizeNativeEmailUserIdentityLinkRequest(invalid))
}
console.log('PASS 9 exact first-link selection cases; browser permission/creation hints and malformed identities rejected')
let cases=0
const accepted=(label,value)=>{const result=api.prepareNativeEmailUserIdentityLinkChange(value);assert.deepEqual(result,value,label)
 assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.appUser)&&Object.isFrozen(result.actorScope)&&Object.isFrozen(result.nativeIdentity))
 cases++}
const denied=(label,change)=>{const value=copy(base);change(value)
 assert.throws(()=>api.prepareNativeEmailUserIdentityLinkChange(value),e=>e.name==='NativeEmailPublicationHeld',label);cases++}
const editRow=(value,stage,change)=>{const row=JSON.parse(value.appUser[stage+'Json']);change(row);value.appUser[stage+'Json']=rowJson(row)}
accepted('exact first link, no other principal mutations',base)
for(const status of ['invited','disabled']){
 const value=copy(base);for(const stage of ['before','after'])editRow(value,stage,row=>{row.status=status})
 accepted('linking does not reactivate a '+status+' user',value)
}
const ancestor=copy(base);ancestor.actorScope={workspaceId:id(2),ancestryJson:rowJson([
 {id:id(1),parent_id:id(2),is_demo:false},{id:id(2),parent_id:null,is_demo:false}])};accepted('explicit ancestor scope',ancestor)
const noDefault=copy(base);for(const stage of ['before','after'])editRow(noDefault,stage,row=>{row.organization_id=null})
accepted('no global default inference',noDefault)
for(const [label,change]of[
 ['unknown command key',v=>{v.createNative=true}],['wrong action kind',v=>{v.kind='rename_user'}],
 ['wrong selection',v=>{v.userEmail='other@example.test'}],['uppercase canonical email',v=>{v.userEmail='EMPLOYEE@example.test'}],
 ['context hash drift shape',v=>{v.contextFingerprint='a'.repeat(63)}],['unknown native claim',v=>{v.nativeIdentity.role='owner'}],
 ['wrong native reference',v=>{v.nativeIdentity.globalId='gu7654321'}],['wrong native username',v=>{v.nativeIdentity.username='other'}],
 ['oversized native ID',v=>{v.nativeIdentity.userId='a'.repeat(37)}],
 ['already linked before',v=>editRow(v,'before',r=>{r.suitecrm_user_id=id(9);r.suitecrm_username=r.reference_code})],
 ['incomplete prior native identity',v=>editRow(v,'before',r=>{r.suitecrm_username=r.reference_code})],
 ['wrong native ID after',v=>editRow(v,'after',r=>{r.suitecrm_user_id=id(9)})],
 ['username not canonical after',v=>editRow(v,'after',r=>{r.suitecrm_username='other'})],
 ['Global ID reparenting',v=>editRow(v,'after',r=>{r.reference_code='gu7654321'})],
 ['implicit status activation',v=>editRow(v,'after',r=>{r.status='disabled'})],
 ['implicit workspace move',v=>editRow(v,'after',r=>{r.organization_id=id(2)})],
 ['implicit role promotion',v=>editRow(v,'after',r=>{r.role='owner'})],
 ['implicit permission grant',v=>editRow(v,'after',r=>{r.permissions.viewAccounting=true})],
 ['employee is not enabled',v=>{for(const stage of ['before','after'])editRow(v,stage,r=>{r.crm_user_enabled=false})}],
 ['unknown user data',v=>editRow(v,'before',r=>{r.updated_at='2026-11-03T00:00:00Z'})],
 ['malformed permissions',v=>editRow(v,'before',r=>{r.permissions.viewCrm='true'})],
 ['noncanonical row bytes',v=>{v.appUser.beforeJson+=' '}],
 ['unrelated actor source',v=>{v.actorScope.workspaceId=id(9)}],
 ['empty ancestry',v=>{v.actorScope.ancestryJson='[]'}],
 ['cyclic ancestry',v=>{v.actorScope.ancestryJson=rowJson([{id:id(1),parent_id:id(1),is_demo:false},{id:id(1),parent_id:null,is_demo:false}])}],
 ['demo actor context',v=>{v.actorScope.ancestryJson=rowJson([{id:id(1),parent_id:null,is_demo:true}])}],
 ['unknown ancestry role hint',v=>{v.actorScope.ancestryJson=rowJson([{id:id(1),parent_id:null,is_demo:false,owner:true}])}],
])denied(label,change)
console.log(`PASS ${cases} pure first-existing-account source cases; immutable identity-only delta, no SQL/native authorization proof`)
const planner=load(resolve(root,'app_src/lib/crm/nativeEmailAuthorityPlan.ts'))
const protocol=load(resolve(root,'app_src/lib/crm/nativeEmailPublication.ts'))
const fixture=JSON.parse(execFileSync(process.execPath,['scripts/test-native-email-authority-v2.mjs','--emit-fixture'],{cwd:root,encoding:'utf8'}))
const binding=fixture.plan.revoke.bindings[0].before,policy=JSON.parse(binding.capability_policy_json)
const hash=protocol.nativeEmailDigest,beforeReaders=JSON.parse(binding.readers_json)
const inspection={version:1,generation:Number(binding.generation),nativePolicyFingerprint:binding.policy_fingerprint,
 runtimeFingerprint:binding.runtime_fingerprint,beforeBindingsFingerprint:hash([binding]),bindings:[binding],
 memberships:beforeReaders.map((user_id,index)=>({id:id(20+index),securitygroup_id:binding.group_id,user_id,
  date_modified:'2026-10-30 12:00:00',deleted:'0',primary_group:'0',noninheritable:'1'})),
 capabilities:fixture.plan.revoke.capabilities.map(entry=>({emailId:entry.emailId,globalId:entry.globalId,pipelineId:entry.pipelineId,
  capabilities:entry.before})),principalSuiteCrmUserIds:policy.principalSuiteCrmUserIds}
const principal=(email,nativeId,role='member')=>({email,suitecrm_user_id:nativeId,status:'active',native_identity_count:nativeId===null?0:1,
 membership_status:'active',membership_role:role,membership_permissions:['object',[]],membership_trashed_at:null})
for(const mode of ['root-viewer','manual-editor','explicit-denial']){
 const beforeUser={...user,organization_id:binding.workspace_id},afterUser={...beforeUser,suitecrm_user_id:'reader-b',suitecrm_username:user.reference_code}
 const change=api.prepareNativeEmailUserIdentityLinkChange({...base,workspaceId:binding.workspace_id,
  actorScope:{workspaceId:binding.workspace_id,ancestryJson:rowJson([{id:binding.workspace_id,parent_id:null,is_demo:false}])},
  appUser:{beforeJson:rowJson(beforeUser),afterJson:rowJson(afterUser)},
  nativeIdentity:{userId:'reader-b',globalId:user.reference_code,username:user.reference_code}})
 const source=(stage)=>({version:1,pipelines:[{pipeline:{id:binding.pipeline_id,workspace_organization_id:binding.workspace_id,owner_email:'owner@example.test'},
  workspace:{id:binding.workspace_id,is_demo:false},
  principals:[principal('owner@example.test','native-owner','owner'),principal('retained@example.test','reader-a'),
   {...principal(user.email,stage==='before'?null:'reader-b'),...(mode==='explicit-denial'?{membership_permissions:['object',[['viewCrm',['boolean',false]]]]}:{})}],
  members:[{user_email:'retained@example.test',access_role:'editor'},...(mode==='root-viewer'?[]:[{user_email:user.email,access_role:'editor'}])],
  rootReaders:[{pipeline_id:binding.pipeline_id,workspace_id:binding.workspace_id,grant_id:id(80),operator_account_id:id(81),email:user.email,
   suitecrm_user_id:stage==='before'?null:'reader-b',native_identity_count:stage==='before'?0:1,
   source_fingerprint:hash(stage),registry_fingerprint:'b'.repeat(64),allowed:mode!=='explicit-denial'}]}],emails:[],
  lifecycle:{userJson:stage==='before'?change.appUser.beforeJson:change.appUser.afterJson}})
 const before=source('before'),after=source('after'),snapshots={before,after,restoration:null}
 const plan=await planner.buildNativeEmailMemberTransition({app:{desiredAppChange:change,snapshots,
  appAuthorityBeforeFingerprint:hash(before),appAuthorityAfterFingerprint:hash(after)},inspection,transitionId:hash(['identity-link',mode]),
  timestamp:'2026-11-03 15:00:00',newMembershipId:()=>id(90),forecast:async request=>({version:1,beforePolicyFingerprint:request.beforePolicyFingerprint,
   revokePolicyFingerprint:hash('identity-revoke'),grantPolicyFingerprint:hash('identity-grant')})})
 assert.deepEqual(plan.revoke.identityLinks,[change.nativeIdentity]);assert.deepEqual(plan.grant.identityLinks,[change.nativeIdentity])
 assert.equal(plan.revoke.roleChanges,undefined);assert.equal(plan.grant.roleChanges,undefined)
 assert.equal(plan.revoke.membershipChanges.length,0)
 assert.equal(plan.grant.membershipChanges.length,mode==='explicit-denial'?0:1)
 const final=plan.grant.capabilities[0].after,future=JSON.parse(plan.grant.bindings[0].after.capability_policy_json).futureCreate
 assert.deepEqual(final.view,[...beforeReaders,...(mode==='explicit-denial'?[]:['reader-b'])].sort())
 assert.deepEqual(final.edit,[...inspection.capabilities[0].capabilities.edit,...(mode==='manual-editor'?['reader-b']:[])].sort())
 assert.deepEqual(final.delete,final.edit)
 assert.deepEqual(future.edit,[...policy.futureCreate.edit,...(mode==='manual-editor'?['reader-b']:[])].sort())
 assert.deepEqual(future.delete,future.edit)
 assert.deepEqual(plan.revoke.capabilities[0].before,inspection.capabilities[0].capabilities)
 assert.deepEqual(plan.revoke.capabilities[0].after,inspection.capabilities[0].capabilities)
 console.log(`PASS exact first-link ${mode} plan; existing native writers preserved, same identity witness in both phases`)
}
