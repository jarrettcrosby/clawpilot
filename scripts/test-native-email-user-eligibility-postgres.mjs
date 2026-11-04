#!/usr/bin/env node
// Actual PostgreSQL migration/store/planner/issuer acceptance. Native inspection,
// policy forecast and terminal receipts are synthetic, not provider proof.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

export async function runUserEligibilityAcceptance(context){
  const {load,protocol,eligibility,userEligibility,audience,transition,adapter,approval,
    query,transaction,options,keys,current,id,hash,clone,held,check,receipt}=context
  const planner=load('app_src/lib/crm/nativeEmailAuthorityPlan.ts',{'./nativeEmailPublication':protocol,
    './suiteCrmNativeEmailProjection':audience,'./nativeEmailAuthorityTransition':transition,
    './nativeEmailEligibility':eligibility,'./nativeEmailWorkspaceUserEligibility':userEligibility})
  const target='reader@example.test',pipelineIds=[id(2),id(4)]
  const beforeMembers=(await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m ORDER BY pipeline_id,user_email')).rows
  const otherMembership=(await query(`SELECT clawpilot_native_email_user_projection('app_user_organization_memberships',to_jsonb(m)) AS row
    FROM app_user_organization_memberships m WHERE user_email=$1 AND organization_id=$2`,[target,id(3)])).rows[0].row
  const currentPins=await current()
  const last=(await query(`SELECT command FROM crm_native_email_effective_authority_phases
    WHERE phase='grant' AND state='committed' AND (command->>'generationTo')::bigint=$1`,[currentPins.generation])).rows
  assert.equal(last.length,1)
  let native={version:1,generation:last[0].command.generationTo,nativePolicyFingerprint:last[0].command.afterPolicyFingerprint,
    runtimeFingerprint:last[0].command.runtimeFingerprint,beforeBindingsFingerprint:last[0].command.afterBindingsFingerprint,
    bindings:last[0].command.bindings.map(pair=>pair.after),memberships:[],
    capabilities:last[0].command.capabilities.map(({emailId,globalId,pipelineId,after})=>({emailId,globalId,pipelineId,capabilities:after})),
    principalSuiteCrmUserIds:JSON.parse(last[0].command.bindings[0].after.capability_policy_json).principalSuiteCrmUserIds}
  let serial=0,memberSerial=1000,failEffects=false
  for(const binding of native.bindings)for(const userId of JSON.parse(binding.readers_json))native.memberships.push({
    id:id(++memberSerial),date_modified:'2026-10-30 12:00:00',deleted:'0',securitygroup_id:binding.group_id,
    user_id:userId,primary_group:'0',noninheritable:'1'})
  const commitEffects=async(tx,change)=>{
    assert.equal(change.kind,'workspace_user_eligibility_v1')
    await tx.query('INSERT INTO lifecycle_effects VALUES($1,$2)',[change.action.kind,change.userEmail])
    if(failEffects)throw Error('synthetic same-transaction session/audit failure')
  }
  let store=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,options,commitEffects)
  let issuer=approval.createNativeEmailAuthorityApprovalIssuer(store,{...options.approvalIdentity,privateKey:keys.privateKey,ttlSeconds:120})
  const memberRow=async(email=target,workspaceId=id(1))=>(await query(`SELECT clawpilot_native_email_user_projection(
    'app_user_organization_memberships',to_jsonb(m)) AS row FROM app_user_organization_memberships m
    WHERE user_email=$1 AND organization_id=$2`,[email,workspaceId])).rows[0]?.row
  const userRow=async(email=target)=>(await query(`SELECT clawpilot_native_email_user_projection('app_users',to_jsonb(u)) AS row
    FROM app_users u WHERE email=$1`,[email])).rows[0].row
  const effects=async()=>Number((await query('SELECT count(*) FROM lifecycle_effects')).rows[0].count)
  async function makePlan(action,email=target){
    const app=await store.previewWorkspaceUserEligibility({userEmail:email,workspaceId:id(1),action},pipelineIds)
    assert.notEqual(app.unchanged,true)
    const n=++serial
    const prepared=await planner.buildNativeEmailMemberTransition({app,inspection:clone(native),
      transitionId:hash(`user-eligibility-${n}`),timestamp:'2026-10-30 13:00:00',newMembershipId:()=>id(++memberSerial),
      forecast:async request=>({version:1,beforePolicyFingerprint:request.beforePolicyFingerprint,
        revokePolicyFingerprint:hash(`user-middle-${n}`),grantPolicyFingerprint:hash(`user-final-${n}`)})})
    // Runtime admits the exact input, not the derived planHash property.
    const {planHash,...input}=prepared
    assert.equal(transition.prepareNativeEmailAuthorityTransition(input).planHash,planHash)
    return {input,planHash,app}
  }
  function applySyntheticNative(command){
    for(const change of command.membershipChanges){
      const index=native.memberships.findIndex(row=>row.id===change.after.id)
      assert.deepEqual(index<0?null:native.memberships[index],change.before)
      if(index<0)native.memberships.push(clone(change.after));else native.memberships[index]=clone(change.after)
    }
    native.memberships.sort((a,b)=>a.id.localeCompare(b.id))
    native={...native,generation:command.generationTo,nativePolicyFingerprint:command.afterPolicyFingerprint,
      beforeBindingsFingerprint:command.afterBindingsFingerprint,bindings:command.bindings.map(pair=>clone(pair.after)),
      capabilities:command.capabilities.map(({emailId,globalId,pipelineId,after})=>({emailId,globalId,pipelineId,capabilities:clone(after)}))}
    planner.readNativeEmailAuthorityInspection(native)
  }
  async function settle(plan,phase){
    const command=plan.input[phase],tid=command.transitionId,envelope=await issuer.issue(tid,phase)
    await store.recordApprovalReadback(tid,phase,{version:1,operationId:command.operationId,transitionId:tid,phase,
      commandHash:hash(command),proofHash:hash(envelope.proof),appCommitFingerprint:envelope.proof.appCommit?hash(envelope.proof.appCommit):null,replayed:false})
    const claimed=await store.claimPhase(tid,phase,id(2000+serial))
    assert.equal(claimed.action,'execute')
    await store.settlePhase(tid,phase,claimed.claim,receipt(plan.input,phase))
    applySyntheticNative(command)
  }
  async function revoke(plan){await store.admit(plan.input);await settle(plan,'revoke')}
  async function finish(plan){
    await store.commitAppChange(plan.input.revoke.transitionId,plan.planHash)
    await settle(plan,'grant')
    assert.equal((await current()).active_transition_id,null)
    assert.equal((await store.load(plan.input.revoke.transitionId)).grant.state,'committed')
  }
  async function run(action,email=target){const plan=await makePlan(action,email);await revoke(plan);await finish(plan);return plan}

  let disabled
  await check('user lifecycle preview derives exact scoped revocation, retained other-org access and optional demo removal',async()=>{
    disabled=await makePlan({kind:'status',status:'disabled'})
    const desired=disabled.input.desiredAppChange
    assert.equal(desired.appUser.beforeJson,desired.appUser.afterJson)
    assert.equal(JSON.parse(desired.membership.afterJson).status,'disabled')
    assert.equal(JSON.parse(desired.demoMembership.beforeJson).organization_id,id(9))
    assert.equal(desired.restoreFrom,null)
    assert.deepEqual(desired.actorScope,{workspaceId:id(1),ancestryJson:userEligibility.nativeEmailEligibilityRowJson([
      {id:id(1),parent_id:id(7),is_demo:false}])})
    assert.deepEqual(disabled.input.grant.capabilities.find(row=>row.pipelineId===id(2)).after.view,[id(11)])
    const foreign=disabled.input.grant.capabilities.find(row=>row.pipelineId===id(4))
    assert.deepEqual(foreign.before,foreign.after)
    assert.deepEqual(foreign.after.view,[id(12),id(14)])
    assert.ok(disabled.input.revoke.membershipChanges.every(change=>change.after.securitygroup_id===id(301)))
    const rows=(await query('SELECT ordinal,source_table FROM clawpilot_native_email_user_change_rows($1::jsonb)',
      [JSON.stringify(desired)])).rows
    assert.deepEqual(rows,[{ordinal:1,source_table:'app_user_organization_memberships'},{ordinal:2,source_table:'app_user_organization_memberships'}])
    const bad=clone(desired);bad.appUser.afterJson=userEligibility.nativeEmailEligibilityRowJson({...JSON.parse(bad.appUser.afterJson),suitecrm_user_id:id(13)})
    await assert.rejects(()=>query('SELECT * FROM clawpilot_native_email_user_change_rows($1::jsonb)',[JSON.stringify(bad)]),/identities or delta invalid/)
    await assert.rejects(()=>store.previewWorkspaceUserEligibility({userEmail:'owner@example.test',workspaceId:id(1),action:{kind:'status',status:'disabled'}},pipelineIds),held('authority_actor_user_access_denied'))
    const outsider=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,{...options,actorEmail:'outsider@example.test'})
    await assert.rejects(()=>outsider.previewWorkspaceUserEligibility({userEmail:target,workspaceId:id(1),action:{kind:'status',status:'disabled'}},pipelineIds),held('authority_actor_user_access_denied'))
  })
  await check('user lifecycle admission pins exact ledger and every retained workspace snapshot',async()=>{
    const newMembership=JSON.stringify({user_email:target,organization_id:id(6),status:'active',role:'member',permissions:{},
      trashed_at:null,trashed_by:null,pre_trash_status:null})
    assert.equal((await query("SELECT clawpilot_native_email_unshared_workspace_is_independent('app_user_organization_memberships',NULL,$1::jsonb) AS allowed",
      [newMembership])).rows[0].allowed,true,'Unshared membership is independent only before a transition pins all source rows')
    await store.admit(disabled.input)
    const tid=disabled.input.revoke.transitionId
    await assert.rejects(()=>query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,status,role,permissions)
      VALUES($1,$2,'active','member','{}')`,[target,id(6)]),/supported exact native-first transition|snapshot is pinned/)
    await assert.rejects(()=>query('UPDATE crm_native_email_authority_user_changes SET applied=true WHERE transition_id=$1',[tid]),/exact active transaction/)
    await assert.rejects(()=>query('DELETE FROM crm_native_email_authority_user_changes WHERE transition_id=$1',[tid]),/evidence is retained/)
    await assert.rejects(()=>query("UPDATE app_user_organization_memberships SET status='disabled' WHERE user_email=$1 AND organization_id=$2",[target,id(1)]),/supported exact native-first transition/)
    await assert.rejects(()=>query("UPDATE app_user_organization_memberships SET pre_trash_status='active' WHERE user_email=$1 AND organization_id=$2",[target,id(3)]),/supported exact native-first transition/)
    await assert.rejects(()=>query('UPDATE workspace_organizations SET is_demo=true WHERE id=$1',[id(5)]),/snapshot is pinned/)
    await assert.rejects(()=>store.commitAppChange(tid,disabled.planHash),held('authority_app_commit_before_revoke'))
    await settle(disabled,'revoke')
    await assert.rejects(()=>transaction(tx=>tx.query("UPDATE crm_native_email_authority_transitions SET app_state='applying',applying_xid=txid_current(),updated_at=clock_timestamp() WHERE transition_id=$1",[tid])),/cannot partially commit/)
    assert.equal((await memberRow()).status,'active')
  })
  await check('user app mutation and session-audit callback roll back together after native revoke',async()=>{
    const tid=disabled.input.revoke.transitionId
    failEffects=true
    await assert.rejects(()=>store.commitAppChange(tid,disabled.planHash),/synthetic same-transaction session\/audit failure/)
    failEffects=false
    assert.equal((await memberRow()).status,'active')
    assert.ok(await memberRow(target,id(9)))
    assert.equal(await effects(),0)
    assert.ok((await query('SELECT applied FROM crm_native_email_authority_user_changes WHERE transition_id=$1',[tid])).rows.every(row=>row.applied===false))
    assert.equal((await current()).generation,String(disabled.input.revoke.generationTo))
    assert.equal((await store.load(tid)).appCommit,null)
    await finish(disabled)
    assert.equal((await memberRow()).status,'disabled')
    assert.equal((await userRow()).status,'active')
    assert.equal(await memberRow(target,id(9)),undefined)
    assert.deepEqual(await memberRow(target,id(3)),otherMembership)
    assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m ORDER BY pipeline_id,user_email')).rows,beforeMembers)
    assert.equal(await effects(),1)
    await store.commitAppChange(tid,disabled.planHash)
    assert.equal(await effects(),1)
  })
  await check('reactivation restores exact retained rights without granting historical editor access or re-creating demo grants',async()=>{
    const restored=await run({kind:'status',status:'active'})
    assert.deepEqual(restored.input.desiredAppChange.restoreFrom,{transitionId:disabled.input.revoke.transitionId,planHash:disabled.planHash})
    const entry=restored.input.grant.capabilities.find(row=>row.pipelineId===id(2))
    assert.deepEqual(entry.after.view,[id(11),id(12)])
    assert.deepEqual(entry.after.edit,[id(11)]);assert.deepEqual(entry.after.delete,[id(11)])
    assert.equal(await memberRow(target,id(9)),undefined)
    assert.equal((await memberRow()).status,'active')
    assert.deepEqual(await store.previewWorkspaceUserEligibility({userEmail:target,workspaceId:id(1),action:{kind:'status',status:'active'}},pipelineIds),{unchanged:true})
  })
  await check('module denial and re-enable use effective readers while preserving intended pipeline membership and foreign-org rights',async()=>{
    const denied=await run({kind:'access',role:'member',permissions:{viewCrm:false,viewAccounting:true}})
    assert.equal((await memberRow()).permissions.viewCrm,false)
    assert.deepEqual(denied.input.grant.capabilities.find(row=>row.pipelineId===id(2)).after.view,[id(11)])
    assert.deepEqual(denied.input.grant.capabilities.find(row=>row.pipelineId===id(4)).after.view,[id(12),id(14)])
    const restored=await makePlan({kind:'access',role:'member',permissions:{viewCrm:true,viewAccounting:false}})
    assert.equal(restored.input.desiredAppChange.restoreFrom.transitionId,denied.input.revoke.transitionId)
    const stale=clone(restored.input.desiredAppChange)
    stale.restoreFrom={transitionId:disabled.input.revoke.transitionId,planHash:disabled.planHash}
    await assert.rejects(()=>transaction(tx=>store.restorationPlan(tx,stale)),held('authority_user_restore_not_latest'))
    await revoke(restored);await finish(restored)
    assert.deepEqual(restored.input.grant.capabilities.find(row=>row.pipelineId===id(2)).after.edit,[id(11)])
    assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m ORDER BY pipeline_id,user_email')).rows,beforeMembers)
  })
  await check('trash retains prior status and rejects metadata-only restoration privilege rewrites',async()=>{
    const trashed=await run({kind:'trash',trashed:true}),row=await memberRow()
    assert.equal(row.status,'disabled');assert.equal(row.pre_trash_status,'active');assert.equal(row.trashed_by,options.actorEmail)
    assert.ok(row.trashed_at)
    for(const [field,value] of [['pre_trash_status','invited'],['trashed_by','outsider@example.test']])
      await assert.rejects(()=>query(`UPDATE app_user_organization_memberships SET ${field}=$1 WHERE user_email=$2 AND organization_id=$3`,[value,target,id(1)]),/supported exact native-first transition/)
    assert.deepEqual(await memberRow(),row)
    const restored=await run({kind:'trash',trashed:false})
    assert.equal(restored.input.desiredAppChange.restoreFrom.transitionId,trashed.input.revoke.transitionId)
    const after=await memberRow()
    assert.equal(after.status,'active');assert.equal(after.trashed_at,null);assert.equal(after.trashed_by,null);assert.equal(after.pre_trash_status,null)
    assert.deepEqual(await memberRow(target,id(3)),otherMembership)
  })
  await check('parent-org manager pins full ancestry and actor authority while preserving native ownership and sole-workspace status',async()=>{
    const parentOptions={...options,actorEmail:'parent-admin@example.test',actorWorkspaceId:id(6)}
    store=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,parentOptions,commitEffects)
    issuer=approval.createNativeEmailAuthorityApprovalIssuer(store,{...options.approvalIdentity,privateKey:keys.privateKey,ttlSeconds:120})
    const request={userEmail:'outsider@example.test',workspaceId:id(1),action:{kind:'status',status:'disabled'}}
    const unrelated=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,{...parentOptions,actorWorkspaceId:id(3)})
    await assert.rejects(()=>unrelated.previewWorkspaceUserEligibility(request,pipelineIds),held('authority_actor_user_access_denied'))
    const disabled=await makePlan(request.action,request.userEmail)
    assert.deepEqual(JSON.parse(disabled.input.desiredAppChange.actorScope.ancestryJson),[
      {id:id(1),parent_id:id(7),is_demo:false},{id:id(7),parent_id:id(6),is_demo:false},{id:id(6),parent_id:null,is_demo:false}])
    assert.equal(disabled.input.revoke.membershipChanges.length,0)
    assert.equal(disabled.input.grant.membershipChanges.length,0)
    await store.admit(disabled.input)
    for(const workspaceId of [id(1),id(7),id(6)]){
      await assert.rejects(()=>query('UPDATE workspace_organizations SET parent_id=$1 WHERE id=$2',[id(5),workspaceId]),/snapshot is pinned/)
      await assert.rejects(()=>query('UPDATE workspace_organizations SET is_demo=true WHERE id=$1',[workspaceId]),/snapshot is pinned/)
      await assert.rejects(()=>query('DELETE FROM workspace_organizations WHERE id=$1',[workspaceId]),/snapshot is pinned/)
    }
    await assert.rejects(()=>query("UPDATE app_users SET organization_id=$1 WHERE email='parent-admin@example.test'",[id(3)]),/supported exact native-first transition/)
    await assert.rejects(()=>query("UPDATE app_users SET status='disabled' WHERE email='parent-admin@example.test'"),/supported exact native-first transition/)
    await assert.rejects(()=>query("UPDATE app_user_organization_memberships SET permissions='{}' WHERE user_email='parent-admin@example.test'"),/supported exact native-first transition/)
    await settle(disabled,'revoke');await finish(disabled)
    assert.equal(JSON.parse(disabled.input.desiredAppChange.appUser.afterJson).status,'disabled')
    assert.equal((await userRow('outsider@example.test')).status,'disabled')
    assert.deepEqual((await query('SELECT ordinal FROM crm_native_email_authority_user_changes WHERE transition_id=$1 ORDER BY ordinal',
      [disabled.input.revoke.transitionId])).rows,[{ordinal:0},{ordinal:1}])
    assert.ok(disabled.input.grant.capabilities.every(row=>!row.after.view.includes(id(13))))
    const restored=await run({kind:'status',status:'active'},'outsider@example.test')
    assert.equal((await userRow('outsider@example.test')).status,'active')
    assert.ok(restored.input.grant.capabilities.every(row=>!row.after.view.includes(id(13))))
    assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m ORDER BY pipeline_id,user_email')).rows,beforeMembers)
    assert.equal((await current()).active_transition_id,null)
  })
  await check('first mapped-user CRM access grant admits and commits without fictitious restoration history',async()=>{
    const first=await makePlan({kind:'access',role:'member',permissions:{viewCrm:true}},'outsider@example.test')
    assert.equal(first.input.desiredAppChange.restoreFrom,null)
    assert.equal(first.app.snapshots.restoration,null)
    const command=first.input.grant,local=command.capabilities.find(row=>row.pipelineId===id(2))
    for(const surface of ['view','list','export'])assert.ok(local.after[surface].includes(id(13)))
    for(const surface of ['edit','delete'])assert.deepEqual(local.after[surface],local.before[surface])
    const policy=JSON.parse(command.bindings.find(pair=>pair.after.pipeline_id===id(2)).after.capability_policy_json)
    assert.ok(policy.futureCreate.view.includes(id(13)));assert.ok(!policy.futureCreate.edit.includes(id(13)))
    assert.ok(command.capabilities.filter(row=>row.pipelineId===id(4)).every(row=>JSON.stringify(row.before)===JSON.stringify(row.after)))
    const original=await memberRow('outsider@example.test'),userBefore=await userRow('outsider@example.test')
    await revoke(first)
    assert.deepEqual(await memberRow('outsider@example.test'),original,'Native revoke must not publish app access early')
    await finish(first)
    assert.deepEqual((await memberRow('outsider@example.test')).permissions,{viewCrm:true})
    assert.deepEqual(await userRow('outsider@example.test'),userBefore,'An access grant cannot remap or rewrite canonical user authority')
    assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m ORDER BY pipeline_id,user_email')).rows,beforeMembers)
  })
  await check('a later regrant must use latest verified revocation and cannot masquerade as a first grant',async()=>{
    const revocation=await run({kind:'access',role:'member',permissions:{viewCrm:false}},'outsider@example.test')
    const restore=await makePlan({kind:'access',role:'member',permissions:{viewCrm:true}},'outsider@example.test')
    assert.deepEqual(restore.input.desiredAppChange.restoreFrom,{transitionId:revocation.input.revoke.transitionId,planHash:revocation.planHash})
    // The typed adapter rejects a forged first-grant plan before native work.
    const forged=clone(restore.input);forged.desiredAppChange.restoreFrom=null
    for(const phase of ['revoke','grant'])forged[phase].desiredAppChangeHash=hash(forged.desiredAppChange)
    await assert.rejects(()=>store.admit(forged),held('authority_user_restore_provenance'))
    // Independently exercise the SQL INSERT guard, not only adapter validation.
    const prepared=transition.prepareNativeEmailAuthorityTransition(forged)
    await assert.rejects(()=>query(`INSERT INTO crm_native_email_authority_transitions
      (transition_id,actor_email,desired_change_hash,plan_hash,plan,app_state)
      VALUES($1,$2,$3,$4,$5::jsonb,'prepared')`,[prepared.revoke.transitionId,options.actorEmail,
      hash(prepared.desiredAppChange),prepared.planHash,JSON.stringify(prepared)]),/latest revocation lineage/)
    await revoke(restore);await finish(restore)
    assert.deepEqual((await memberRow('outsider@example.test')).permissions,{viewCrm:true})
    assert.equal((await current()).active_transition_id,null)
  })
  return clone(native)
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--postgres'],'Explicit --postgres is required; root owns guarded DB acceptance')
  execFileSync(process.execPath,[fileURLToPath(new URL('./test-native-email-authority-transition-postgres.mjs',import.meta.url)),'--postgres-user'],{stdio:'inherit'})
}
