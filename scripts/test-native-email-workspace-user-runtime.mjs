#!/usr/bin/env node
// Actual runtime/typed request/route error translation. Transactions, native
// provider and durable store are mocked here; SQL/native gates are separate.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
function run(text,deps){const module={exports:{}}
  const code=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{
    assert.ok(Object.hasOwn(deps,name),'Unmocked dependency '+name);return deps[name]})
  return module.exports}
const base=run(source('app_src/lib/crm/nativeEmailPublication.ts'),{'node:crypto':crypto})
const contract=run(source('app_src/lib/crm/nativeEmailWorkspaceUserEligibility.ts'),{'./nativeEmailPublication':base})
const identity=run(source('app_src/lib/crm/nativeEmailIdentityLinkChange.ts'),{'./nativeEmailPublication':base,'./nativeEmailWorkspaceUserEligibility':contract})
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const actor='owner@example.test',user='reader@example.test',workspace=id(1),pipeline=id(2),demo=id(3)
class Pending extends Error{status=409;code='CRM_ACCESS_CHANGE_PENDING';constructor(transitionId=null){super('CRM access is pending');this.transitionId=transitionId}}
const clone=value=>JSON.parse(JSON.stringify(value))
const request=(action={kind:'status',status:'disabled'})=>({workspaceId:workspace,userEmail:user,action})
function change(req){const normalized=contract.normalizeNativeEmailWorkspaceUserEligibilityRequest(req)
  const beforeUser={email:user,status:'active',suitecrm_user_id:id(4),role:'member',permissions:{},organization_id:workspace}
  const beforeMember={user_email:user,organization_id:workspace,status:'active',role:'member',permissions:{viewCrm:true},
    trashed_at:null,trashed_by:null,pre_trash_status:null}
  const afterMember={...beforeMember,status:'disabled'}
  if(req.action.kind==='trash')Object.assign(afterMember,{trashed_at:'2026-10-30T12:00:00+00:00',trashed_by:actor,pre_trash_status:'active'})
  if(req.action.kind==='access')Object.assign(afterMember,{status:'active',role:req.action.role,permissions:req.action.permissions})
  return contract.prepareNativeEmailWorkspaceUserEligibilityChange({kind:'workspace_user_eligibility_v1',...normalized,
    actorScope:{workspaceId:workspace,ancestryJson:contract.nativeEmailEligibilityRowJson([{id:workspace,parent_id:null,is_demo:false}])},
    pipelineIntentFingerprint:'a'.repeat(64),appUser:{beforeJson:contract.nativeEmailEligibilityRowJson(beforeUser),
      afterJson:contract.nativeEmailEligibilityRowJson({...beforeUser,status:afterMember.status})},
    membership:{beforeJson:contract.nativeEmailEligibilityRowJson(beforeMember),afterJson:contract.nativeEmailEligibilityRowJson(afterMember)},
    demoMembership:null,restoreFrom:null})}
function harness(options={}){
  const log=[],queries=[],audits=[];let effects,admitted=null
  const req=options.request??request(),delta=options.delta??change(req)
  const tx={async query(sql,values){log.push('sql');queries.push({sql,values})
    if(sql.includes('SELECT * FROM crm_native_email_publication_control'))return{rows:[{
      enabled:options.enabled??true,active_operation_id:options.activePublication??null,active_transition_id:options.activeId??null}]}
    if(sql.includes('SELECT suitecrm_user_id FROM app_users'))return{rows:options.missingTarget?[]:[{suitecrm_user_id:options.unmapped?null:id(4)}]}
    if(sql.includes("SELECT plan->'desiredAppChange' AS desired")){
      assert.deepEqual(values,[options.expectedTransitionId??options.activeId,actor,options.identityRequest.workspaceId,options.identityRequest.userEmail])
      return{rows:options.noOwnedIdentity?[]:[{desired:delta}]}}
    if(sql.startsWith('UPDATE app_sessions')||sql.startsWith('UPDATE app_user_invitations')){
      if(options.effectFailure)throw Error('private SQL diagnostic');return{rows:[]}}
    assert.fail('Unexpected SQL: '+sql)
  }}
  class Store{
    constructor(_transaction,config,callback){assert.equal(config.actorEmail,actor)
      assert.equal(config.actorWorkspaceId,options.actorWorkspaceId);effects=callback;log.push('store')}
    async previewWorkspaceUserEligibility(value,pipelines){log.push('preview');assert.deepEqual(value,req);assert.deepEqual(pipelines,[pipeline])
      if(options.previewFailure)throw Error('private authority refusal')
      return options.unchanged?{unchanged:true}:{desiredAppChange:delta}}
    async previewUserIdentityLink(value,pipelines){log.push('identity-preview');assert.deepEqual(value,options.identityRequest);assert.deepEqual(pipelines,[pipeline])
      if(options.previewFailure)throw Error('private identity refusal');return{desiredAppChange:delta}}
    async admit(plan){log.push('admit');if(options.admitFailure)throw Error('private admission failure');admitted=plan}
    async load(value){log.push('load');assert.equal(value,options.activeId??options.expectedTransitionId);return{plan:{desiredAppChange:delta}}}
  }
  const config={keyId:'test-key',nativeInstanceId:'test-instance',serviceUserId:'test-user',clientId:'test-client'}
  const runtime=run(source('app_src/lib/crm/nativeEmailWorkspaceUserRuntime.ts'),{
    'node:crypto':crypto,'../persistence/postgres':{withTransaction:async callback=>callback(tx)},
    '../persistence/crmNativeEmailAuthority':{lockCrmNativeEmailAuthorityWithClient:async value=>{assert.equal(value,tx);log.push('lock')}},
    '../auditWriter':{recordAuditEvent:async(event,value)=>{assert.equal(value,tx);audits.push(event);log.push('audit')}},
    '../invitationWorkspaceScope':{removeWorkspaceFromPendingInvitationsWithClient:async(value,input)=>{
      assert.equal(value,tx);queries.push({invitationScope:input});return{trimmedInvitationIds:[id(90)],revokedInvitationIds:[]}}},
    './nativeEmailPublication':base,
    './nativeEmailAuthorityTransitionPostgres':{PostgresNativeEmailAuthorityTransitionStore:Store},
    './nativeEmailAuthorityTransport':{createSuiteCrmNativeEmailAuthorityClient:()=>({
      inspect:async()=>{log.push('inspect');if(options.inspectFailure)throw Error('private native failure');return{bindings:[{pipeline_id:pipeline}]}},project:()=>{}})},
    './nativeEmailAuthorityPlan':{readNativeEmailAuthorityInspection:value=>value,buildNativeEmailMemberTransition:async input=>{
      log.push('plan');assert.equal(input.app.desiredAppChange,delta);return{desiredAppChange:delta}}},
    './nativeEmailAuthorityRuntime':{NativeEmailAccessPendingError:Pending,nativeEmailAuthorityConfiguration:()=>{
      log.push('config');if(options.missingConfig)throw Error('private config failure');return config},
    resumeNativeEmailAuthorityChange:async value=>{
      log.push('resume');assert.ok(admitted||options.activeId||options.expectedTransitionId)
      if(options.resumeFailure)throw new Pending(value.transitionId)
      await effects(tx,options.effectDelta??delta)
      return true}},
    './nativeEmailWorkspaceUserEligibility':contract,
    './nativeEmailIdentityLinkChange':identity,
  })
  return{log,queries,audits,invoke:()=>runtime.changeWorkspaceUserWithNativeAuthority(actor,req,options.actorWorkspaceId,options.expectedTransitionId),
    invokeIdentity:()=>runtime.linkExistingUserWithNativeAuthority(actor,options.identityRequest,options.actorWorkspaceId),
    invokeSavedIdentity:()=>runtime.resumePendingExistingUserIdentityWithNativeAuthority(actor,options.identityRequest.workspaceId,
      options.identityRequest.userEmail,options.expectedTransitionId??options.activeId,options.actorWorkspaceId)}
}
let checks=0
async function check(label,fn){await fn();checks++;console.log('PASS '+label)}
await check('disabled policy alone selects the legacy branch before config/provider work',async()=>{
  const h=harness({enabled:false,missingConfig:true});assert.equal(await h.invoke(),false)
  assert.deepEqual(h.log,['lock','sql']);assert.equal(h.audits.length,0)
})
await check('unmapped app-only target keeps existing SQL path; missing target never does',async()=>{
  const h=harness({unmapped:true});assert.equal(await h.invoke(),false);assert.ok(!h.log.includes('config'))
  await assert.rejects(harness({missingTarget:true}).invoke,Pending)
})
await check('mapped native failures cannot fall through to an unverified user write',async()=>{
  for(const options of [{missingConfig:true},{inspectFailure:true},{previewFailure:true},{activePublication:'a'.repeat(64)}]){
    const h=harness(options);await assert.rejects(h.invoke,error=>error instanceof Pending&&!error.message.includes('private'))
    assert.equal(h.audits.length,0);assert.ok(!h.log.includes('resume'))
  }
})
await check('mapped request admits exact scope before shared recovery and scopes sessions/audit',async()=>{
  const h=harness({actorWorkspaceId:id(82)});assert.equal(await h.invoke(),true)
  assert.ok(h.log.indexOf('admit')<h.log.indexOf('resume'))
  const session=h.queries.find(value=>value.sql.startsWith('UPDATE app_sessions'))
  assert.deepEqual(session.values,[user,workspace,'workspace_access_changed'])
  assert.equal(h.audits.length,1);assert.equal(h.audits[0].organizationId,workspace)
  assert.equal(h.audits[0].eventType,'user.status.updated');assert.match(h.audits[0].payload.transitionId,/^[a-f0-9]{64}$/)
})
await check('unchanged mapped request performs no admission session invalidation or audit',async()=>{
  const h=harness({unchanged:true});assert.equal(await h.invoke(),true)
  assert.ok(!h.log.includes('admit')&&!h.log.includes('resume'));assert.equal(h.audits.length,0)
})
await check('resume requires exact desired user workspace and action',async()=>{
  const activeId='b'.repeat(64),h=harness({activeId});assert.equal(await h.invoke(),true)
  assert.ok(!h.log.includes('inspect')&&!h.log.includes('admit'))
  const other=change(request({kind:'trash',trashed:true}))
  const mismatch=harness({activeId,delta:other})
  await assert.rejects(mismatch.invoke,error=>error instanceof Pending&&error.transitionId===null)
  assert.ok(!mismatch.log.includes('resume'));assert.equal(mismatch.audits.length,0)
})
await check('explicit resume cannot turn a settled replaced or disabled transition into a fresh change',async()=>{
  const expectedTransitionId='b'.repeat(64)
  for(const options of [{},{enabled:false},{activeId:'c'.repeat(64)}]){
    const h=harness({...options,expectedTransitionId})
    await assert.rejects(h.invoke,error=>error instanceof Pending&&error.transitionId===null)
    assert.ok(!h.log.includes('config')&&!h.log.includes('admit'));assert.equal(h.audits.length,0)
  }
  assert.equal(await harness({expectedTransitionId,activeId:expectedTransitionId}).invoke(),true)
})
await check('trash revokes outstanding invitations and optional derived demo sessions only in owned scope',async()=>{
  const req=request({kind:'trash',trashed:true}),delta=change(req)
  delta.demoMembership={beforeJson:contract.nativeEmailEligibilityRowJson({...JSON.parse(delta.membership.beforeJson),organization_id:demo}),afterJson:null}
  const h=harness({request:req,delta});assert.equal(await h.invoke(),true)
  const invitations=h.queries.find(value=>value.invitationScope)
  assert.deepEqual(invitations.invitationScope,{email:user,organizationId:workspace})
  assert.deepEqual(h.audits[0].payload.invitationChanges,{trimmedInvitationIds:[id(90)],revokedInvitationIds:[]})
  const sessions=h.queries.filter(value=>value.sql?.startsWith('UPDATE app_sessions'))
  assert.deepEqual(sessions[0].values,[user,workspace,'workspace_user_trashed'])
  assert.deepEqual(sessions[1].values,[user,demo]);assert.equal(h.audits[0].eventType,'user.trashed')
  const alternateDemo=id(92),alternateDelta=clone(delta)
  alternateDelta.demoMembership.beforeJson=contract.nativeEmailEligibilityRowJson({
    ...JSON.parse(delta.demoMembership.beforeJson),organization_id:alternateDemo})
  const alternate=harness({request:req,delta:alternateDelta});assert.equal(await alternate.invoke(),true)
  assert.deepEqual(alternate.queries.filter(value=>value.sql?.startsWith('UPDATE app_sessions'))[1].values,[user,alternateDemo])
})
await check('pending execution and failed effects return resumable hold never a false success',async()=>{
  for(const options of [{resumeFailure:true},{effectFailure:true}]){
    const h=harness(options);await assert.rejects(h.invoke,error=>error instanceof Pending&&/^[a-f0-9]{64}$/.test(error.transitionId))
    assert.equal(h.audits.length,0)
  }
})
await check('exact callback scope is rechecked before any session or audit write',async()=>{
  const effectDelta=change(request({kind:'trash',trashed:true})),h=harness({effectDelta})
  await assert.rejects(h.invoke,Pending)
  assert.ok(!h.queries.some(value=>value.sql.startsWith('UPDATE')));assert.equal(h.audits.length,0)
})
await check('user API returns safe409 with resumable ID and hides native SQL diagnostics',()=>{
  const path='app_src/app/api/users/route.ts',ast=ts.createSourceFile(path,source(path),ts.ScriptTarget.Latest,true)
  const extract=name=>ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(ast)
  const code=`import {NextResponse,NativeEmailAccessPendingError,AppUserAuthorizationError,AppUserNotFoundError,AppUserIdentitySyncConflictError} from 'test';\n`
    +extract('userMutationErrorStatus')+'\nexport '+extract('userMutationErrorResponse')
  class Authorization extends Error{};class Missing extends Error{};class IdentityConflict extends Error{}
  const api=run(code,{test:{NextResponse:{json:(body,options)=>({body,...options})},NativeEmailAccessPendingError:Pending,
    AppUserAuthorizationError:Authorization,AppUserNotFoundError:Missing,AppUserIdentitySyncConflictError:IdentityConflict}})
  const pending=api.userMutationErrorResponse(new Pending('c'.repeat(64)),'fallback')
  assert.equal(pending.status,409);assert.equal(pending.body.transitionId,'c'.repeat(64))
  for(const label of ['authority exact delta','user actor ancestry']){
    const sql=Object.assign(new Error(`Native ${label} private SQL`),{code:'55000'})
    const blocked=api.userMutationErrorResponse(sql,'fallback');assert.equal(blocked.status,409)
    assert.ok(!JSON.stringify(blocked).includes('private SQL'))
  }
  assert.equal(api.userMutationErrorResponse(new Authorization(),'fallback').status,403)
})
function identityHarness(options={}){
  const selected={workspaceId:workspace,userEmail:user,nativeIdentity:{userId:id(4),globalId:'gu1234567',username:'gu1234567'}}
  const before={email:user,status:'active',role:'member',permissions:{},organization_id:workspace,reference_code:'gu1234567',
    crm_user_enabled:true,suitecrm_user_id:null,suitecrm_username:null}
  const delta=identity.prepareNativeEmailUserIdentityLinkChange({kind:'user_identity_link_v1',...selected,
    actorScope:{workspaceId:workspace,ancestryJson:contract.nativeEmailEligibilityRowJson([{id:workspace,parent_id:null,is_demo:false}])},
    contextFingerprint:'a'.repeat(64),appUser:{beforeJson:contract.nativeEmailEligibilityRowJson(before),
      afterJson:contract.nativeEmailEligibilityRowJson({...before,suitecrm_user_id:id(4),suitecrm_username:'gu1234567'})}})
  return harness({identityRequest:selected,delta,...options})
}
await check('first existing-account link never falls back when configured native work is held',async()=>{
  const disabled=identityHarness({enabled:false,missingConfig:true});assert.equal(await disabled.invokeIdentity(),false)
  assert.deepEqual(disabled.log,['lock','sql'])
  for(const options of [{missingConfig:true},{inspectFailure:true},{previewFailure:true},{activePublication:'a'.repeat(64)}]){
    const h=identityHarness(options);await assert.rejects(h.invokeIdentity,error=>error instanceof Pending&&!error.message.includes('private'))
    assert.equal(h.audits.length,0);assert.ok(!h.log.includes('resume'))
  }
})
await check('first existing-account runtime commits only its exact user identity and marks grant as pending in its audit',async()=>{
  const h=identityHarness({actorWorkspaceId:id(82)});assert.equal(await h.invokeIdentity(),true)
  assert.ok(h.log.indexOf('admit')<h.log.indexOf('resume'))
  const session=h.queries.find(value=>value.sql.startsWith('UPDATE app_sessions'));assert.deepEqual(session.values,[user])
  assert.equal(h.audits.length,1);assert.equal(h.audits[0].eventType,'user.crm_identity.synced')
  assert.equal(h.audits[0].payload.identitySync,'mapping_committed');assert.equal(h.audits[0].payload.nativeGrantPending,true)
  assert.ok(!h.queries.some(value=>value.invitationScope));assert.ok(!h.queries.some(value=>/UPDATE app_user_organization_memberships|INSERT INTO app_users/.test(value.sql)))
})
await check('an identity sync resumes its stored operation after local commit and rejects a different account without exposing its ID',async()=>{
  const activeId='d'.repeat(64),h=identityHarness({activeId});assert.equal(await h.invokeIdentity(),true)
  assert.ok(h.log.includes('load'));assert.ok(!h.log.includes('inspect'));assert.ok(!h.log.includes('identity-preview'));assert.ok(!h.log.includes('admit'))
  const mismatch=identityHarness({activeId,identityRequest:{workspaceId:id(88),userEmail:user,nativeIdentity:{userId:id(4),globalId:'gu1234567',username:'gu1234567'}}})
  await assert.rejects(mismatch.invokeIdentity,error=>error instanceof Pending&&error.transitionId===null)
  assert.equal(mismatch.audits.length,0)
})
await check('pending identity grants and failed session/audit effects cannot return verified success',async()=>{
  for(const options of [{resumeFailure:true},{effectFailure:true}]){
    const h=identityHarness(options);await assert.rejects(h.invokeIdentity,error=>error instanceof Pending&&/^[a-f0-9]{64}$/.test(error.transitionId))
    assert.equal(h.audits.length,0)
  }
  const malformed=identityHarness({identityRequest:{workspaceId:workspace,userEmail:user,nativeIdentity:{userId:id(4),globalId:'gu1234567',username:'other'}}})
  await assert.rejects(malformed.invokeIdentity,Pending);assert.deepEqual(malformed.log,[])
  const admission=identityHarness({admitFailure:true});await assert.rejects(admission.invokeIdentity,error=>error instanceof Pending&&error.transitionId===null)
  assert.equal(admission.audits.length,0,'A refused admission has no owned resumable identity or local mapping')
})
await check('saved identity recovery does not rediscover an account and only loads exact actor-owned user/workspace intent',async()=>{
  const activeId='d'.repeat(64),h=identityHarness({activeId});assert.equal(await h.invokeSavedIdentity(),true)
  assert.ok(h.log.includes('load'));assert.ok(!h.log.includes('inspect'));assert.ok(!h.log.includes('identity-preview'));assert.ok(!h.log.includes('admit'))
  const settled=identityHarness({expectedTransitionId:activeId});assert.equal(await settled.invokeSavedIdentity(),true)
  const foreign=identityHarness({activeId,noOwnedIdentity:true});await assert.rejects(foreign.invokeSavedIdentity,error=>error instanceof Pending&&error.transitionId===null)
  assert.ok(!foreign.log.includes('config'));assert.equal(foreign.audits.length,0)
  const changed=identityHarness({activeId:'a'.repeat(64),expectedTransitionId:activeId})
  await assert.rejects(changed.invokeSavedIdentity,error=>error instanceof Pending&&error.transitionId===null)
})
console.log(`PASS ${checks} workspace-user/identity runtime/route groups; mocked store/provider, no SQL/native/production proof`)
