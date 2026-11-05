#!/usr/bin/env node
// Actual planner, typed change validator, issuer and coordinator. Persistence,
// native transport and transactions below are explicitly mocked, not SQL/native
// acceptance. An optional artifact validates recorded native planning evidence;
// it does not authorize production or prove deployed TypeScript runtime behavior.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const root = new URL('../', import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
function load(path, dependencies, environment = {}) {
  const module = { exports:{} }
  const code = ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), { fileName:path,
    compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true } }).outputText
  new Function('module','exports','require','process',code)(module,module.exports,name => {
    assert.ok(Object.hasOwn(dependencies,name),`Unmocked dependency ${name}`); return dependencies[name]
  },{ env:environment })
  return module.exports
}
const base = load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const eligibility = load('app_src/lib/crm/nativeEmailEligibility.ts',{'./nativeEmailPublication':base})
const userEligibility = load('app_src/lib/crm/nativeEmailWorkspaceUserEligibility.ts',{'./nativeEmailPublication':base})
const identityLink=load('app_src/lib/crm/nativeEmailIdentityLinkChange.ts',{'./nativeEmailPublication':base,'./nativeEmailWorkspaceUserEligibility':userEligibility})
const audience = load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts',{'node:crypto':crypto})
const capability = load('app_src/lib/crm/nativeEmailCapabilityContract.ts',{'node:crypto':crypto,'./nativeEmailPublication':base})
const transition = load('app_src/lib/crm/nativeEmailAuthorityTransition.ts',{'./nativeEmailPublication':base,
  './suiteCrmNativeEmailProjection':audience,'./nativeEmailCapabilityContract':capability})
const approval = load('app_src/lib/crm/nativeEmailAuthorityApproval.ts',{'node:crypto':crypto,
  './nativeEmailPublication':base,'./nativeEmailAuthorityTransition':transition})
const transport = load('app_src/lib/crm/nativeEmailAuthorityTransport.ts',{'./nativeEmailPublication':base,
  './nativeEmailAuthorityTransition':transition})
const adapter = load('app_src/lib/crm/nativeEmailAuthorityTransitionPostgres.ts',{'./nativeEmailPublication':base,
  './nativeEmailIdentityLinkChange':identityLink,
  './nativeEmailRootReaders':{}, // Pure runtime harness replaces the SQL store; no source collection is allowed here.
  './nativeEmailEligibility':eligibility,
  './nativeEmailWorkspaceUserEligibility':userEligibility,
  './nativeEmailAuthorityTransition':transition,'./nativeEmailAuthorityTransport':transport,'./nativeEmailCapabilityContract':capability})
const planner = load('app_src/lib/crm/nativeEmailAuthorityPlan.ts',{'./nativeEmailPublication':base,
  './nativeEmailEligibility':eligibility,
  './nativeEmailWorkspaceUserEligibility':userEligibility,
  './suiteCrmNativeEmailProjection':audience,'./nativeEmailAuthorityTransition':transition})
const fixture = JSON.parse(execFileSync(process.execPath,['scripts/test-native-email-authority-v2.mjs','--emit-fixture'],
  { cwd:root,encoding:'utf8' }))
const clone = value => JSON.parse(JSON.stringify(value)), hash = base.nativeEmailDigest
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const binding = fixture.plan.revoke.bindings[0].before
const pipelineId = binding.pipeline_id, workspaceId = binding.workspace_id
const owner = 'owner@example.test', readerA = 'reader-a@example.test', readerB = 'reader-b@example.test'
const stamp = '2026-10-30 18:00:00'
function member(email, role = 'viewer') {
  return { pipeline_id:pipelineId,user_email:email,access_role:role,shared_by:owner,
    created_at:'2026-10-30T12:00:00+00:00',updated_at:'2026-10-30T12:00:00+00:00' }
}
function inspection() {
  const command = fixture.plan.revoke
  return { version:1,generation:command.generationFrom,nativePolicyFingerprint:command.beforePolicyFingerprint,
    runtimeFingerprint:command.runtimeFingerprint,beforeBindingsFingerprint:command.beforeBindingsFingerprint,
    bindings:command.bindings.map(pair=>clone(pair.before)),
    memberships:[clone(command.membershipChanges[0].before),{
      id:'membership-owner',date_modified:stamp,deleted:'0',securitygroup_id:binding.group_id,
      user_id:binding.owner_id,primary_group:'0',noninheritable:'1' }].sort((a,b)=>a.id.localeCompare(b.id)),
    capabilities:command.capabilities.map(row=>({ emailId:row.emailId,globalId:row.globalId,pipelineId:row.pipelineId,capabilities:clone(row.before) })),
    principalSuiteCrmUserIds:JSON.parse(binding.capability_policy_json).principalSuiteCrmUserIds }
}
function appPreview(change) {
  change = adapter.prepareNativeEmailPipelineMemberChange(change)
  const beforeMembers = [member(readerA)], afterMembers = clone(beforeMembers)
  for (const delta of change.changes) {
    if (delta.before) afterMembers.splice(afterMembers.findIndex(row=>row.user_email===delta.before.user_email),1)
    if (delta.after) afterMembers.push(delta.after)
  }
  const scope = members => ({ pipeline:{ id:pipelineId,owner_email:owner },members,
    principals:[{email:owner,suitecrm_user_id:binding.owner_id},{email:readerA,suitecrm_user_id:'reader-a'},
      {email:readerB,suitecrm_user_id:'reader-b'}].map(row=>({...row,status:'active',membership_status:'active',
        membership_trashed_at:null,membership_role:row.email===owner?'owner':'member',native_identity_count:1,
        membership_permissions:adapter.encodeNativeEmailAuthoritySnapshotJson({})})) })
  const snapshot = members => ({version:1,pipelines:[scope(members)],emails:inspection().capabilities.map(({emailId,globalId,pipelineId})=>({emailId,globalId,pipelineId}))})
  const before = snapshot(beforeMembers), after = snapshot(afterMembers)
  return { desiredAppChange:change,appAuthorityBeforeFingerprint:hash(before),appAuthorityAfterFingerprint:hash(after),snapshots:{before,after} }
}
const add = (role = 'viewer') => ({kind:'pipeline_members_v1',changes:[{before:null,after:member(readerB,role)}]})
const remove = () => ({kind:'pipeline_members_v1',changes:[{before:member(readerA),after:null}]})
function forecast(request) {
  return { version:1,beforePolicyFingerprint:request.beforePolicyFingerprint,
    revokePolicyFingerprint:hash(['synthetic-revoke-policy',request.revokeMembershipChanges]),
    grantPolicyFingerprint:hash(['synthetic-grant-policy',request.grantMembershipChanges]) }
}
const build = (change, overrides = {}) => planner.buildNativeEmailMemberTransition({
  app:appPreview(change),inspection:inspection(),transitionId:hash('synthetic-plan'),timestamp:stamp,
  newMembershipId:()=>id(801),forecast:async request=>forecast(request),...overrides })
function demotionFixture() {
  const change={kind:'pipeline_members_v1',changes:[{before:member(readerA,'editor'),after:{...member(readerA),updated_at:'2026-10-30T12:01:00+00:00'}}]}
  const app=appPreview(change);app.snapshots.before.pipelines[0].members=[member(readerA,'editor')]
  app.appAuthorityBeforeFingerprint=hash(app.snapshots.before)
  const native=inspection()
  for(const row of native.capabilities)for(const surface of ['edit','delete'])row.capabilities[surface]=[binding.owner_id,'reader-a'].sort()
  const policy=JSON.parse(native.bindings[0].capability_policy_json)
  for(const surface of ['edit','delete'])policy.futureCreate[surface]=[binding.owner_id,'reader-a'].sort()
  native.bindings[0].capability_policy_json=JSON.stringify(policy)
  const {historical,...future}=policy;void historical
  native.bindings[0].capability_policy_fingerprint=hash(future)
  native.beforeBindingsFingerprint=hash(native.bindings)
  return {change,app,native}
}
if(process.argv.includes('--emit-role-fixture')) {
  assert.deepEqual(process.argv.slice(2),['--emit-role-fixture'])
  const promotion=await build({kind:'pipeline_members_v1',changes:[{before:member(readerA),after:{...member(readerA,'editor'),updated_at:'2026-10-30T12:01:00+00:00'}}]})
  const {change,app,native}=demotionFixture()
  const demotion=await build(change,{app,inspection:native})
  console.log(JSON.stringify({promotion,demotion}));process.exit(0)
}
function receipt(command, state = 'committed', replayed = false) {
  const value = {version:command.version,operationId:command.operationId,transitionId:command.transitionId,
    phase:command.phase,commandHash:hash(command),state,replayed,result:state==='cancelled'?null:{
      desiredAppChangeHash:command.desiredAppChangeHash,generationFrom:command.generationFrom,generationTo:command.generationTo,
      beforePolicyFingerprint:command.beforePolicyFingerprint,afterPolicyFingerprint:command.afterPolicyFingerprint,
      beforeBindingsFingerprint:command.beforeBindingsFingerprint,afterBindingsFingerprint:command.afterBindingsFingerprint,
      capabilitiesFingerprint:hash(command.capabilities.map(row=>({emailId:row.emailId,globalId:row.globalId,pipelineId:row.pipelineId,capabilities:row.after}))),
      pendingPublicationTerminalReceipt:null }}
  return transition.verifyNativeEmailAuthorityReceipt(transition.prepareNativeEmailAuthorityCommand(command),value)
}
function readback(command, envelope) {
  return transport.verifyNativeEmailAuthorityApprovalReadback(command,envelope,{version:1,
    operationId:command.operationId,transitionId:command.transitionId,phase:command.phase,commandHash:hash(command),
    proofHash:hash(envelope.proof),appCommitFingerprint:envelope.proof.appCommit?hash(envelope.proof.appCommit):null,replayed:false})
}
let checks = 0
async function check(label, run) { await run(); checks++; console.log('PASS '+label) }
await check('actual inspection validator accepts full v2 snapshot and preserves raw policy bytes',()=>{
  const value=inspection(),result=planner.readNativeEmailAuthorityInspection(value)
  assert.deepEqual(result,value);assert.notEqual(result,value)
  assert.equal(result.bindings[0].capability_policy_json,binding.capability_policy_json)
})
await check('actual inspection validator rejects shape, identity, reader, membership and capability drift',()=>{
  const edits=[v=>{v.extra=true},v=>{v.generation=0},v=>{v.beforeBindingsFingerprint='0'.repeat(64)},
    v=>{v.principalSuiteCrmUserIds.pop()},v=>{v.memberships.pop()},v=>{v.memberships[0].noninheritable='0'},
    v=>{v.memberships[0].securitygroup_id=id(999)},v=>{v.memberships[0].user_id='unknown'},
    v=>{v.memberships[0].date_modified='invalid'},v=>{v.memberships.reverse()},
    v=>{v.memberships.push({...v.memberships[0],id:'membership-z'})},v=>{v.capabilities[0].capabilities.view=[]}]
  for(const edit of edits){const value=inspection();edit(value);assert.throws(()=>planner.readNativeEmailAuthorityInspection(value))}
})
await check('actual planner adds viewer without changing retained historical editors; editor grants are explicit',async()=>{
  const viewer=await build(add()),editor=await build(add('editor'))
  assert.equal(viewer.revoke.membershipChanges.length,0);assert.equal(viewer.grant.membershipChanges.length,1)
  assert.deepEqual(viewer.grant.capabilities[0].after.edit,[binding.owner_id])
  assert.deepEqual(editor.grant.capabilities[0].after.edit,[binding.owner_id,'reader-b'].sort())
  assert.deepEqual(viewer.grant.capabilities[0].after.view,[binding.owner_id,'reader-a','reader-b'].sort())
  assert.equal(viewer.revoke.bindings[0].before.capability_policy_json,binding.capability_policy_json)
  assert.equal(viewer.grant.beforeBindingsFingerprint,viewer.revoke.afterBindingsFingerprint)
  assert.ok(Object.isFrozen(viewer))
})
await check('retained viewer promotion grants writes only after app commit without native membership churn',async()=>{
  const change={kind:'pipeline_members_v1',changes:[{before:member(readerA),after:{...member(readerA,'editor'),updated_at:'2026-10-30T12:01:00+00:00'}}]}
  const plan=await build(change)
  assert.deepEqual(plan.revoke.membershipChanges,[]);assert.deepEqual(plan.grant.membershipChanges,[])
  assert.deepEqual(plan.revoke.capabilities[0].after.edit,[binding.owner_id])
  assert.deepEqual(plan.grant.capabilities[0].after.edit,[binding.owner_id,'reader-a'].sort())
  assert.deepEqual(plan.revoke.capabilities[0].after.view,plan.grant.capabilities[0].after.view)
})
await check('retained editor demotion removes historical and future writes before app commit, preserving reads',async()=>{
  const {change,app,native}=demotionFixture()
  const plan=await build(change,{app,inspection:native})
  assert.deepEqual(plan.revoke.membershipChanges,[]);assert.deepEqual(plan.grant.membershipChanges,[])
  for(const phase of ['revoke','grant']){
    assert.deepEqual(plan[phase].capabilities[0].after.edit,[binding.owner_id])
    assert.deepEqual(plan[phase].capabilities[0].after.view,[binding.owner_id,'reader-a'].sort())
    assert.deepEqual(JSON.parse(plan[phase].bindings[0].after.capability_policy_json).futureCreate.edit,[binding.owner_id])
  }
})
await check('removing an explicit editor share retains inherited root reading but revokes its historical and future writes',async()=>{
  const {app,native}=demotionFixture()
  const change=adapter.prepareNativeEmailPipelineMemberChange({kind:'pipeline_members_v1',changes:[{before:member(readerA,'editor'),after:null}]})
  app.desiredAppChange=change;app.snapshots.after.pipelines[0].members=[]
  for(const stage of ['before','after']){
    const scope=app.snapshots[stage].pipelines[0]
    scope.pipeline.workspace_organization_id=binding.workspace_id
    scope.rootReaders=[{pipeline_id:pipelineId,workspace_id:binding.workspace_id,grant_id:id(811),operator_account_id:id(812),
      email:readerA,suitecrm_user_id:'reader-a',native_identity_count:1,source_fingerprint:'a'.repeat(64),registry_fingerprint:'b'.repeat(64),allowed:true}]
  }
  app.appAuthorityBeforeFingerprint=hash(app.snapshots.before);app.appAuthorityAfterFingerprint=hash(app.snapshots.after)
  const plan=await build(change,{app,inspection:native})
  for(const phase of ['revoke','grant']){
    assert.deepEqual(plan[phase].membershipChanges,[])
    for(const surface of ['view','list','export'])assert.deepEqual(plan[phase].capabilities[0].after[surface],[binding.owner_id,'reader-a'].sort())
    for(const surface of ['edit','delete']){
      assert.deepEqual(plan[phase].capabilities[0].after[surface],[binding.owner_id])
      assert.deepEqual(JSON.parse(plan[phase].bindings[0].after.capability_policy_json).futureCreate[surface],[binding.owner_id])
    }
  }
})
await check('actual planner revokes before app change and restores existing deleted membership without duplicate',async()=>{
  const removed=await build(remove())
  assert.equal(removed.revoke.membershipChanges.length,1);assert.equal(removed.grant.membershipChanges.length,0)
  assert.equal(removed.revoke.membershipChanges[0].after.deleted,'1')
  assert.deepEqual(removed.revoke.capabilities[0].after.view,[binding.owner_id])
  const value=inspection(),deleted={...value.memberships[0],id:'membership-b',user_id:'reader-b',deleted:'1'}
  value.memberships.push(deleted);value.memberships.sort((a,b)=>a.id.localeCompare(b.id))
  const restored=await build(add(),{inspection:value,newMembershipId:()=>assert.fail('must reuse deleted identity')})
  assert.deepEqual(restored.grant.membershipChanges[0].before,deleted)
  assert.equal(restored.grant.membershipChanges[0].after.id,deleted.id)
})
await check('actual planner holds wrong pipeline coverage, missing owner and mismatched forecast pins',async()=>{
  const app=appPreview(add());app.snapshots.before.pipelines[0].pipeline.id=id(999)
  await assert.rejects(()=>build(add(),{app}))
  const missingOwner=appPreview(add());missingOwner.snapshots.after.pipelines[0].principals.shift()
  await assert.rejects(()=>build(add(),{app:missingOwner}))
  for(const edit of [v=>{v.extra=true},v=>{v.beforePolicyFingerprint='0'.repeat(64)},v=>{v.revokePolicyFingerprint='bad'}])
    await assert.rejects(()=>build(add(),{forecast:async request=>{const value=forecast(request);edit(value);return value}}))
})
await check('actual planner preserves unchanged legacy bindings in mixed inventory and holds changes to legacy scope',async()=>{
  const value=inspection(),legacy={...clone(value.bindings[0]),pipeline_id:id(4),group_id:id(5),
    capability_policy_json:null,capability_policy_fingerprint:null}
  legacy.audience_fingerprint=audience.suiteCrmEmailAudienceFingerprint({policy:'pipeline-internal',
    ownerSuiteCrmId:legacy.owner_id,allowedSuiteCrmUserIds:JSON.parse(legacy.readers_json),
    workspaceId:legacy.workspace_id,pipelineId:legacy.pipeline_id,fingerprint:''})
  value.bindings.push(legacy);value.beforeBindingsFingerprint=hash(value.bindings)
  value.memberships.push(...value.memberships.map(row=>({...row,id:'z-'+row.id,securitygroup_id:legacy.group_id})))
  value.memberships.sort((a,b)=>a.id.localeCompare(b.id))
  value.capabilities.push({...clone(value.capabilities[0]),emailId:'legacy-email',globalId:'gi1234568',pipelineId:legacy.pipeline_id})
  value.capabilities.sort((a,b)=>a.emailId.localeCompare(b.emailId))
  const app=appPreview(add())
  for(const phase of ['before','after']){
    const scope=clone(app.snapshots.before.pipelines[0]);scope.pipeline.id=legacy.pipeline_id
    scope.members=scope.members.map(row=>({...row,pipeline_id:legacy.pipeline_id}));app.snapshots[phase].pipelines.push(scope)
  }
  const plan=await build(add(),{inspection:value,app})
  for(const phase of ['revoke','grant']){
    const pair=plan[phase].bindings.find(row=>row.before.pipeline_id===legacy.pipeline_id)
    assert.equal(pair.before.capability_policy_json,null);assert.equal(pair.after.capability_policy_json,null)
    assert.equal(pair.before.capability_policy_fingerprint,null);assert.equal(pair.after.capability_policy_fingerprint,null)
    assert.equal(pair.before.readers_json,pair.after.readers_json)
    assert.ok(!plan[phase].membershipChanges.some(row=>row.after.securitygroup_id===legacy.group_id))
  }
  const changed=clone(app)
  changed.desiredAppChange=adapter.prepareNativeEmailPipelineMemberChange({kind:'pipeline_members_v1',changes:[{
    before:{...member(readerA),pipeline_id:legacy.pipeline_id},after:null}]})
  changed.snapshots.after.pipelines[1].members=[]
  await assert.rejects(()=>build(add(),{inspection:value,app:changed}),error=>error.code==='authority_lifecycle_requires_v2_policy')
  const hiddenDrift=clone(app);hiddenDrift.snapshots.after.pipelines[1].members=[]
  await assert.rejects(()=>build(add(),{inspection:value,app:hiddenDrift}),error=>error.code==='authority_lifecycle_requires_v2_policy')
})

const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
function runtimeHarness(options = {}) {
  const log=[],state={control:{enabled:true,active_operation_id:null,active_transition_id:null},
    owner:{owner_email:owner,role:'owner',status:'active',trashed_at:null,user_status:'active',
      permissions:{},suitecrm_user_id:binding.owner_id,native_identity_count:1},
    targetMember:options.remove?member(readerA):null,record:null,envelopes:{},readbacks:{},nativeReceipts:{},
    fence:0,commits:0,queued:0,audited:0,effectTx:null,originalActor:null,attemptHistory:[],...options.state}
  const selection={actorEmail:owner,workspaceId,pipelineId,userEmail:options.remove?readerA:readerB,accessRole:options.remove?null:'viewer',...options.selection}
  const tx={label:'mock-initial-transaction',async query(sql,values){
    if(sql.includes('SELECT * FROM crm_native_email_publication_control')){log.push('sql.control');return {rows:state.control?[clone(state.control)]:[]}}
    if(sql.includes('FROM pipeline_spaces p JOIN')){log.push('sql.actor');assert.deepEqual(values,[selection.pipelineId,selection.workspaceId]);return {rows:state.owner?[clone(state.owner)]:[]}}
    if(sql.includes('SELECT to_jsonb(m) AS member')){log.push('sql.member');return {rows:state.targetMember?[{member:clone(state.targetMember)}]:[]}}
    if(sql.includes('SELECT jsonb_build_object')){log.push('sql.next');return {rows:[{member:member(selection.userEmail,selection.accessRole)}]}}
    assert.fail('Unexpected runtime SQL')
  }}
  let effects
  class MockStore {
    constructor(transaction,config,callback){log.push('store.construct');effects=callback;this.actor=config.actorEmail}
    async previewMemberChange(change,pipelines){log.push('store.preview');assert.deepEqual(pipelines,[pipelineId]);return appPreview(change)}
    async admit(plan){log.push('store.admit');assert.equal(state.record,null);state.originalActor=this.actor
      state.record={enabled:true,plan:transition.prepareNativeEmailAuthorityTransition(plan),revoke:{state:'prepared',receipt:null},grant:{state:'prepared',receipt:null},appCommit:null,grantApproval:null}
      state.control.active_transition_id=plan.revoke.transitionId}
    async load(id){assert.equal(id,state.record.plan.revoke.transitionId);assert.equal(this.actor,state.originalActor,'mock store actor recheck');return clone(state.record)}
    async issueApproval(id,phase,create){log.push('store.issue.'+phase)
      if(!state.envelopes[phase])state.envelopes[phase]=create(await this.load(id))
      return clone(state.envelopes[phase])}
    async recordApprovalReadback(id,phase,value){log.push('store.approval.'+phase)
      transport.verifyNativeEmailAuthorityApprovalReadback(transition.nativeEmailAuthorityPhaseCommand(state.record,phase),state.envelopes[phase],value)
      state.readbacks[phase]=clone(value)
      if(phase==='grant')state.record.grantApproval={operationId:value.operationId,commandHash:value.commandHash,appCommitFingerprint:value.appCommitFingerprint}}
    async claimPhase(id,phase,leaseOwner){log.push('store.claim.'+phase);assert.ok(state.readbacks[phase])
      const expired=state.envelopes[phase].proof.expiresAt<=Math.floor(Date.now()/1000)
      const action=state.record[phase].state==='prepared'&&!expired?'execute':'resolve'
      state.record[phase].state='dispatched';return {record:clone(state.record),claim:{owner:leaseOwner,fence:++state.fence},action}}
    async markUnknown(id,phase){log.push('store.unknown.'+phase);state.record[phase].state='unknown'}
    async settlePhase(id,phase,claim,value){log.push('store.settle.'+phase)
      const verified=transition.verifyNativeEmailAuthorityReceipt(transition.prepareNativeEmailAuthorityCommand(transition.nativeEmailAuthorityPhaseCommand(state.record,phase)),value)
      state.record[phase]={state:verified.state,receipt:clone(verified)}
      if(phase==='grant'&&verified.state==='committed')state.control.active_transition_id=null
      return clone(state.record)}
    async commitAppChange(id,planHash){log.push('store.app.begin');assert.equal(planHash,state.record.plan.planHash)
      assert.equal(state.record.revoke.state,'committed');assert.equal(state.record.appCommit,null)
      const effectTx={label:'mock-commit-transaction'},prior={queued:state.queued,audited:state.audited}
      try{await effects(effectTx,state.record.plan.desiredAppChange)}catch(error){Object.assign(state,prior);log.push('store.app.rollback');throw error}
      state.effectTx=effectTx;state.targetMember=clone(state.record.plan.desiredAppChange.changes[0].after)
      state.record.appCommit={version:1,transitionId:id,planHash,desiredAppChangeHash:state.record.plan.revoke.desiredAppChangeHash,
        revokeReceiptHash:transition.nativeEmailAuthorityReceiptHash(state.record.revoke.receipt),
        appAuthorityBeforeFingerprint:state.record.plan.expectedAppAuthorityBeforeFingerprint,
        appAuthorityAfterFingerprint:state.record.plan.expectedAppAuthorityAfterFingerprint}
      state.commits++;log.push('store.app.commit')
      if(options.loseAppReply&&!state.appReplyLost){state.appReplyLost=true;throw Error('synthetic lost app commit response')}
      return clone(state.record)}
    async closeCancelledRevoke(){log.push('store.close.cancelled');assert.equal(state.record.revoke.state,'cancelled')
      assert.equal(state.record.appCommit,null);state.control.active_transition_id=null}
    async retryCancelledGrant(id,expectedOperationId){
      log.push('store.retry.grant');const previous=transition.nativeEmailAuthorityPhaseCommand(state.record,'grant')
      assert.equal(previous.operationId,expectedOperationId);assert.equal(state.record.grant.state,'cancelled');assert.ok(state.record.appCommit)
      state.attemptHistory.push({command:clone(previous),phase:clone(state.record.grant),envelope:clone(state.envelopes.grant)})
      state.record.grantAttempt={ordinal:(state.record.grantAttempt?.ordinal??0)+1,
        originalOperationId:state.record.plan.grant.operationId,originalCommandHash:hash(state.record.plan.grant),
        previousOperationId:previous.operationId,previousCommandHash:hash(previous),
        previousCancellationReceiptHash:transition.nativeEmailAuthorityReceiptHash(state.record.grant.receipt)}
      state.record.grant={state:'prepared',receipt:null};state.record.grantApproval=null
      delete state.envelopes.grant;delete state.readbacks.grant
      return clone(state.record)
    }
  }
  const client={
    async inspect(){log.push('native.inspect');if(options.inspectFailure)throw Error('private-native-diagnostic');return inspection()},
    async project(request){log.push('native.project');return forecast(request)},
    async approve(command,envelope){log.push('native.approve.'+command.phase)
      if(envelope.proof.expiresAt<=Math.floor(Date.now()/1000)&&!state.readbacks[command.phase]
        &&!(options.preapprovedExpiredGrant&&command.phase==='grant'))throw Error('synthetic expired native approval rejected')
      return readback(command,envelope)},
    async execute(command){log.push('native.execute.'+command.phase)
      if(options.cancelNativeReply===command.phase&&!state.nativeReplyLost){state.nativeReplyLost=true;throw Error('synthetic unknown never executed outcome')}
      const value=receipt(command);state.nativeReceipts[command.operationId]=value
      if(options.loseNativeReply===command.phase&&!state.nativeReplyLost){state.nativeReplyLost=true;throw Error('synthetic lost native response')}
      return value},
    async resolveOrCancel(command){log.push('native.resolve.'+command.phase)
      return state.nativeReceipts[command.operationId]?{...clone(state.nativeReceipts[command.operationId]),replayed:true}:receipt(command,'cancelled')},
    async cancelExpired(command,envelope){log.push('native.cancel.expired.'+command.phase)
      return {approval:readback(command,envelope),receipt:state.nativeReceipts[command.operationId]??receipt(command,'cancelled')}} }
  const env=Object.fromEntries(Object.entries({BASE_URL:'https://native.example.test',CLIENT_ID:'synthetic-client',CLIENT_SECRET:'synthetic-secret',
    KEY_ID:'synthetic-key',INSTANCE_ID:'synthetic-native',SERVICE_USER_ID:'native-owner',
    PRIVATE_KEY:privateKey.export({format:'pem',type:'pkcs8'}).toString()}).map(([key,value])=>['CLAWPILOT_NATIVE_EMAIL_AUTHORITY_'+key,value]))
  if(options.missingConfig)delete env.CLAWPILOT_NATIVE_EMAIL_AUTHORITY_PRIVATE_KEY
  const runtime=load('app_src/lib/crm/nativeEmailAuthorityRuntime.ts',{
    'node:crypto':crypto,'../persistence/postgres':{withTransaction:async callback=>{log.push('sql.begin');return callback(tx)}},
    '../persistence/crmNativeEmailAuthority':{lockCrmNativeEmailAuthorityWithClient:async selected=>{assert.equal(selected,tx);log.push('sql.lock')}},
    '../persistence/pipeline':{enqueuePipelinePermissionSyncWithClient:async(selected,payload)=>{
      log.push('effect.queue');assert.equal(selected.label,'mock-commit-transaction');assert.deepEqual(payload,{pipelineId,actor:selection.actorEmail})
      state.queueTx=selected;state.queued++;if(options.queueFailure)throw Error('synthetic queue failure')}},
    '../auditWriter':{recordAuditEvent:async(payload,selected)=>{log.push('effect.audit');assert.equal(selected,state.queueTx)
      assert.equal(payload.aggregateId,pipelineId);assert.equal(payload.organizationId,workspaceId);assert.equal(payload.payload.userEmail,selection.userEmail)
      assert.equal(payload.eventType,selection.accessRole===null?'pipeline.space.share.removed':'pipeline.space.shared')
      state.audited++;if(options.auditFailure)throw Error('synthetic audit failure')}},
    './nativeEmailPublication':base,'./nativeEmailAuthorityTransitionPostgres':{...adapter,PostgresNativeEmailAuthorityTransitionStore:MockStore},
    './nativeEmailAuthorityApproval':{createNativeEmailAuthorityApprovalIssuer:(store,config)=>{
      const live=approval.createNativeEmailAuthorityApprovalIssuer(store,config),expired=approval.createNativeEmailAuthorityApprovalIssuer(store,config,()=>Date.now()-600000)
      return {issue:(id,phase)=>(options.expiredPhase===phase&&(!state.record?.grantAttempt||options.expireRetries)?expired:live).issue(id,phase)}}},
    './nativeEmailAuthorityTransport':{createSuiteCrmNativeEmailAuthorityClient:()=>client},
    './nativeEmailAuthorityTransition':transition,'./nativeEmailAuthorityPlan':planner,'./nativeEmailEligibility':eligibility,
  },env)
  return {state,log,selection,run:expected=>runtime.changePipelineMemberWithNativeAuthority(selection,expected),
    pending:error=>error instanceof runtime.NativeEmailAccessPendingError&&error.status===409&&error.code==='CRM_ACCESS_CHANGE_PENDING'
      &&!error.message.includes('private-native-diagnostic'),effects:()=>effects}
}
function order(log,...labels){let prior=-1;for(const label of labels){const index=log.indexOf(label);assert.ok(index>prior,`Expected ${label} after previous stage: ${log.join(',')}`);prior=index}}
await check('runtime disabled policy is the only false/legacy return; enabled failures are public pending errors',async()=>{
  const disabled=runtimeHarness({state:{control:{enabled:false}}});assert.equal(await disabled.run(),false)
  assert.deepEqual(disabled.log,['sql.begin','sql.lock','sql.control'])
  for(const options of [{missingConfig:true},{inspectFailure:true},{state:{control:null}},
    {state:{control:{enabled:true,active_operation_id:hash('busy'),active_transition_id:null}}}]){
    const h=runtimeHarness(options);await assert.rejects(h.run,h.pending);assert.equal(h.state.commits,0)
    assert.ok(!h.log.includes('native.execute.revoke'))
  }
})
await check('saved sharing resume is exact under control and never exposes an unowned active identity',async()=>{
  for(const state of [{control:{enabled:false,active_transition_id:null}},
    {control:{enabled:true,active_operation_id:null,active_transition_id:null}},
    {control:{enabled:true,active_operation_id:null,active_transition_id:hash('new-operation')}}]){
    const h=runtimeHarness({state})
    await assert.rejects(()=>h.run(hash('old-operation')),error=>h.pending(error)&&error.transitionId===null)
    assert.equal(h.state.record,null);assert.ok(!h.log.some(entry=>entry.startsWith('native.')))
  }
  const h=runtimeHarness({state:{control:{enabled:true,active_operation_id:null,active_transition_id:hash('private-other-owner')}}})
  await assert.rejects(h.run,error=>h.pending(error)&&error.transitionId===null)
  assert.ok(!h.log.includes('store.admit'))
})
await check('runtime denies non-owner, inactive, trashed, self-change and non-normalized actor before native calls',async()=>{
  for(const edit of [h=>{h.selection.actorEmail='outsider@example.test'},h=>{h.state.owner.role='unexpected'},
    h=>{h.state.owner.status='inactive'},h=>{h.state.owner.user_status='inactive'},h=>{h.state.owner.trashed_at=stamp},
    h=>{h.state.owner.permissions=null},h=>{h.state.owner.role='member';h.state.owner.permissions={viewCrm:false}},
    h=>{h.state.owner.role='admin';h.state.owner.permissions={viewCrm:false}},
    h=>{h.state.owner.suitecrm_user_id=null;h.state.owner.native_identity_count=0},h=>{h.state.owner.native_identity_count=2},
    h=>{h.selection.userEmail=owner},h=>{h.selection.actorEmail='Owner@example.test'},h=>{h.selection.workspaceId='invalid'}]){
    const h=runtimeHarness();edit(h);await assert.rejects(h.run,h.pending);assert.ok(!h.log.some(row=>row.startsWith('native.')))
  }
})
await check('current pipeline owner can share as an eligible workspace member or admin without becoming workspace owner',async()=>{
  for(const role of ['member','admin'])for(const permissions of [{},{viewCrm:true}]){
    const h=runtimeHarness();Object.assign(h.state.owner,{role,permissions})
    assert.equal(await h.run(),true)
    assert.equal(h.state.commits,1);assert.equal(h.state.queued,1);assert.equal(h.state.audited,1)
    assert.equal(h.state.owner.role,role)
  }
})
await check('runtime executes revoke, transaction-bound effect callback, app receipt, then grant; completed request is idempotent',async()=>{
  for(const remove of [false,true]){
    const h=runtimeHarness({remove});assert.equal(await h.run(),true)
    order(h.log,'sql.lock','sql.control','sql.actor','native.inspect','store.preview','native.project','store.admit',
      'native.approve.revoke','store.claim.revoke','native.execute.revoke','store.settle.revoke','store.app.begin',
      'effect.queue','effect.audit','store.app.commit','native.approve.grant','native.execute.grant','store.settle.grant')
    assert.equal(h.state.commits,1);assert.equal(h.state.queued,1);assert.equal(h.state.audited,1)
    assert.equal(h.state.effectTx,h.state.queueTx);assert.equal(h.state.control.active_transition_id,null)
    const calls=h.log.filter(row=>row.startsWith('native.')).length
    assert.equal(await h.run(),true);assert.equal(h.state.commits,1);assert.equal(h.log.filter(row=>row.startsWith('native.')).length,calls)
  }
})
await check('runtime retained-member promotion uses the exact native-first transition; same-role no-op needs no provider',async()=>{
  const changed=runtimeHarness({state:{targetMember:member(readerA)},selection:{userEmail:readerA,accessRole:'editor'}})
  assert.equal(await changed.run(),true)
  assert.equal(changed.state.targetMember.access_role,'editor')
  const delta=changed.state.record.plan.desiredAppChange.changes[0]
  assert.equal(delta.before.user_email,delta.after.user_email)
  assert.equal(delta.before.created_at,delta.after.created_at)
  order(changed.log,'native.execute.revoke','store.app.begin','store.app.commit','native.execute.grant')
  const same=runtimeHarness({state:{targetMember:member(readerB)}});assert.equal(await same.run(),true)
  assert.ok(!same.log.includes('store.construct'))
})
await check('runtime callback queues and audits in the supplied commit transaction and propagates failures',async()=>{
  for(const failure of ['queueFailure','auditFailure']){
    const h=runtimeHarness({[failure]:true});await assert.rejects(h.run,h.pending)
    assert.equal(h.state.record.revoke.state,'committed');assert.equal(h.state.record.appCommit,null)
    assert.equal(h.state.commits,0);assert.equal(h.state.targetMember,null);assert.equal(h.state.queued,0);assert.equal(h.state.audited,0)
    assert.ok(h.log.includes('store.app.rollback'));assert.ok(!h.log.includes('native.approve.grant'))
  }
  // Callback scope is actual runtime validation; rollback above is mocked. SQL
  // atomicity is separately covered by the PostgreSQL adapter acceptance gate.
  const h=runtimeHarness();assert.equal(await h.run(),true)
  await assert.rejects(()=>h.effects()({label:'mock-commit-transaction'},{
    kind:'pipeline_members_v1',changes:[{before:null,after:member('wrong@example.test')}]}))
})
await check('runtime unknown native outcome retry resolves exact phase without duplicate native execute or app commit',async()=>{
  for(const phase of ['revoke','grant']){
    const h=runtimeHarness({loseNativeReply:phase});await assert.rejects(h.run,h.pending)
    assert.equal(h.state.record[phase].state,'unknown');const transitionId=h.state.control.active_transition_id
    assert.equal(await h.run(),true);assert.equal(h.state.record.plan.revoke.transitionId,transitionId)
    assert.equal(h.log.filter(row=>row==='native.execute.'+phase).length,1)
    assert.equal(h.log.filter(row=>row==='native.resolve.'+phase).length,1);assert.equal(h.state.commits,1)
  }
})
await check('runtime lost app-commit response reloads durable receipt instead of repeating effects',async()=>{
  const h=runtimeHarness({loseAppReply:true});await assert.rejects(h.run,h.pending)
  assert.ok(h.state.record.appCommit);assert.equal(await h.run(),true)
  assert.equal(h.state.commits,1);assert.equal(h.state.queued,1);assert.equal(h.state.audited,1)
})
await check('runtime rejects a different selection or actor while exact transition is pending',async()=>{
  for(const edit of [h=>{h.selection.userEmail='other@example.test'},h=>{h.selection.accessRole='editor'},
    h=>{h.selection.actorEmail='other-owner@example.test';h.state.owner.owner_email=h.selection.actorEmail}]){
    const h=runtimeHarness({loseNativeReply:'revoke'});await assert.rejects(h.run,h.pending)
    const count=h.log.filter(row=>row.startsWith('native.')).length;edit(h);await assert.rejects(h.run,h.pending)
    assert.equal(h.log.filter(row=>row.startsWith('native.')).length,count);assert.equal(h.state.commits,0)
  }
})
await check('runtime expired revoke closes only on verified explicit cancellation without app or grant mutation',async()=>{
  const h=runtimeHarness({expiredPhase:'revoke'});await assert.rejects(h.run,error=>h.pending(error)&&error.transitionId===null)
  assert.equal(h.state.record.revoke.state,'cancelled');assert.equal(h.state.control.active_transition_id,null)
  assert.equal(h.state.commits,0);assert.ok(!h.log.includes('native.execute.revoke'));assert.ok(!h.log.includes('native.approve.grant'))
  order(h.log,'native.cancel.expired.revoke','store.approval.revoke','store.claim.revoke','store.settle.revoke','store.close.cancelled')
})
await check('runtime expired unprovisioned grant retains cancellation and completes a separate exact retry',async()=>{
  const h=runtimeHarness({expiredPhase:'grant'});assert.equal(await h.run(),true)
  assert.ok(h.state.record.appCommit);assert.equal(h.state.record.grant.state,'committed');assert.equal(h.state.commits,1)
  assert.equal(h.state.record.grantAttempt.ordinal,1);assert.equal(h.state.control.active_transition_id,null)
  assert.equal(h.state.attemptHistory.length,1);assert.equal(h.state.attemptHistory[0].phase.state,'cancelled')
  assert.equal(h.state.attemptHistory[0].envelope.proof.version,1);assert.equal(h.state.envelopes.grant.proof.version,2)
  const old=h.state.attemptHistory[0].command,now=transition.nativeEmailAuthorityPhaseCommand(h.state.record,'grant')
  assert.notEqual(old.operationId,now.operationId);assert.deepEqual({...now,operationId:old.operationId},old)
  order(h.log,'native.cancel.expired.grant','store.retry.grant','native.execute.grant')
  assert.ok(!h.log.includes('store.close.cancelled'))
})
await check('runtime ambiguous provisioned grant first resolves cancellation then retries without repeating app effects',async()=>{
  const h=runtimeHarness({cancelNativeReply:'grant'});await assert.rejects(h.run,h.pending)
  assert.equal(h.state.record.grant.state,'unknown');assert.ok(h.state.control.active_transition_id)
  assert.equal(await h.run(),true);assert.equal(h.state.commits,1);assert.equal(h.state.queued,1);assert.equal(h.state.audited,1)
  order(h.log,'native.resolve.grant','store.retry.grant');assert.equal(h.state.attemptHistory[0].phase.state,'cancelled')
  assert.equal(h.state.record.grantAttempt.ordinal,1);assert.equal(h.state.control.active_transition_id,null)
})
await check('runtime repeated expiry is bounded and retains every cancelled proof before a later live retry',async()=>{
  const options={expiredPhase:'grant',expireRetries:true},h=runtimeHarness(options);await assert.rejects(h.run,h.pending)
  assert.ok(h.state.control.active_transition_id);assert.equal(h.state.commits,1);assert.ok(h.state.attemptHistory.length>=1)
  const history=clone(h.state.attemptHistory),appCommit=clone(h.state.record.appCommit),plan=clone(h.state.record.plan)
  options.expiredPhase=null;assert.equal(await h.run(),true)
  assert.deepEqual(h.state.attemptHistory.slice(0,history.length),history);assert.deepEqual(h.state.record.appCommit,appCommit)
  assert.deepEqual(h.state.record.plan,plan);assert.equal(h.state.commits,1);assert.equal(h.state.control.active_transition_id,null)
})

const artifactArg=process.argv.slice(2).find(value=>value.startsWith('--native-artifact='))
assert.ok(process.argv.slice(2).every(value=>value===artifactArg),'Only --native-artifact=<path> is supported')
if(artifactArg)await check('actual planner accepts recorded native snapshot/revoke forecast; synthetic PG and unchanged-grant pin are not native execution proof',async()=>{
  const artifact=JSON.parse(readFileSync(artifactArg.slice('--native-artifact='.length),'utf8'))
  assert.equal(typeof artifact.output,'string')
  const prefix='CLAWPILOT_NATIVE_AUTHORITY_V2_PLANNING='
  const lines=artifact.output.split('\n').filter(line=>line.startsWith(prefix));assert.equal(lines.length,1)
  const evidence=JSON.parse(lines[0].slice(prefix.length)),native=planner.readNativeEmailAuthorityInspection(evidence.snapshot)
  const nativeToEmail=new Map(native.principalSuiteCrmUserIds.map((nativeId,index)=>[nativeId,`principal-${index}@example.test`]))
  const changes=[]
  for(const delta of evidence.revokeMembershipChanges){
    const nativeMember=delta.after,b=native.bindings.find(value=>value.group_id===nativeMember.securitygroup_id)
    assert.ok(b)
    const row={...member(nativeToEmail.get(nativeMember.user_id)),pipeline_id:b.pipeline_id,shared_by:nativeToEmail.get(b.owner_id)}
    changes.push({before:row,after:null})
  }
  changes.sort((a,b)=>{const one=a.before??a.after,two=b.before??b.after;return (one.pipeline_id+'\0'+one.user_email).localeCompare(two.pipeline_id+'\0'+two.user_email)})
  const desiredAppChange=adapter.prepareNativeEmailPipelineMemberChange({kind:'pipeline_members_v1',changes})
  const before={version:1,pipelines:native.bindings.map(b=>({pipeline:{id:b.pipeline_id,owner_email:nativeToEmail.get(b.owner_id)},
    members:JSON.parse(b.readers_json).filter(nativeId=>nativeId!==b.owner_id).map(nativeId=>({...member(nativeToEmail.get(nativeId)),pipeline_id:b.pipeline_id,shared_by:nativeToEmail.get(b.owner_id)})),
    principals:native.principalSuiteCrmUserIds.map(nativeId=>({email:nativeToEmail.get(nativeId),suitecrm_user_id:nativeId,
      status:'active',membership_status:'active',membership_trashed_at:null,membership_role:nativeId===b.owner_id?'owner':'member',
      native_identity_count:1,membership_permissions:adapter.encodeNativeEmailAuthoritySnapshotJson({})}))})),
    emails:native.capabilities.map(({emailId,globalId,pipelineId})=>({emailId,globalId,pipelineId}))}
  const after=clone(before)
  for(const delta of changes){const row=delta.before??delta.after,scope=after.pipelines.find(value=>value.pipeline.id===row.pipeline_id)
    if(delta.before)scope.members=scope.members.filter(value=>value.user_email!==row.user_email);else scope.members.push(row)}
  const app={desiredAppChange,appAuthorityBeforeFingerprint:hash(before),appAuthorityAfterFingerprint:hash(after),snapshots:{before,after}}
  const timestamps=evidence.revokeMembershipChanges.map(delta=>delta.after.date_modified)
  assert.equal(new Set(timestamps).size,1)
  const plan=await planner.buildNativeEmailMemberTransition({app,inspection:native,transitionId:hash('recorded-native-planning'),timestamp:timestamps[0],
    newMembershipId:()=>assert.fail('Revocation-only plan must not create memberships'),forecast:async request=>{
      assert.equal(hash(request.revokeMembershipChanges),hash(evidence.revokeMembershipChanges),'Exact recorded revoke delta differs')
      assert.deepEqual(request.grantMembershipChanges,[])
      // The recorded forecast restores the same native member, which is not a
      // valid atomic add/remove PG delta. Use its actual revoke prediction only;
      // no second membership delta means the grant policy pin stays unchanged.
      return {...evidence.projection,grantPolicyFingerprint:evidence.projection.revokePolicyFingerprint} }})
  assert.equal(plan.revoke.afterPolicyFingerprint,evidence.projection.revokePolicyFingerprint)
  assert.equal(plan.grant.afterPolicyFingerprint,evidence.projection.revokePolicyFingerprint)
  assert.equal(plan.revoke.bindings.length,native.bindings.length)
})
console.log(`Native authority runtime passed ${checks} local validator/planner and mocked-I/O checks. No database, live native, deployment or production proof claimed.`)
