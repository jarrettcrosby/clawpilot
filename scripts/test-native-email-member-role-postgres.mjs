// Actual PostgreSQL role updates, immutable preimages and native-first receipt
// ordering. Native inspections, forecasts and terminal receipts are synthetic.
import assert from 'node:assert/strict'

export async function runMemberRoleAcceptance(context) {
  const {load,protocol,eligibility,userEligibility,audience,transition,adapter,approval,
    query,transaction,options,keys,current,id,hash,clone,held,check,receipt}=context
  const planner=load('app_src/lib/crm/nativeEmailAuthorityPlan.ts',{'./nativeEmailPublication':protocol,
    './suiteCrmNativeEmailProjection':audience,'./nativeEmailAuthorityTransition':transition,
    './nativeEmailEligibility':eligibility,'./nativeEmailWorkspaceUserEligibility':userEligibility})
  const pins=await current()
  const command=(await query(`SELECT command FROM crm_native_email_effective_authority_phases
    WHERE phase='grant' AND state='committed' AND (command->>'generationTo')::bigint=$1`,[pins.generation])).rows[0].command
  let native={version:1,generation:command.generationTo,nativePolicyFingerprint:command.afterPolicyFingerprint,
    runtimeFingerprint:command.runtimeFingerprint,beforeBindingsFingerprint:command.afterBindingsFingerprint,
    bindings:command.bindings.map(pair=>pair.after),memberships:[],
    capabilities:command.capabilities.map(({emailId,globalId,pipelineId,after})=>({emailId,globalId,pipelineId,capabilities:after})),
    principalSuiteCrmUserIds:JSON.parse(command.bindings[0].after.capability_policy_json).principalSuiteCrmUserIds}
  let serial=0
  for(const binding of native.bindings)for(const userId of JSON.parse(binding.readers_json))native.memberships.push({
    id:id(5000+ ++serial),date_modified:'2026-10-30 12:00:00',deleted:'0',securitygroup_id:binding.group_id,
    user_id:userId,primary_group:'0',noninheritable:'1'})
  native.memberships.sort((a,b)=>a.id.localeCompare(b.id))
  let failEffects=false
  await query(`CREATE TABLE role_row_events(operation text NOT NULL);
    CREATE FUNCTION role_row_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      INSERT INTO role_row_events VALUES(TG_OP);RETURN NULL;END$$;
    CREATE TRIGGER role_row_event AFTER INSERT OR UPDATE OR DELETE ON pipeline_space_members
      FOR EACH ROW EXECUTE FUNCTION role_row_event();`)
  const store=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,options,async()=>{
    if(failEffects)throw Error('synthetic role audit failure')
  })
  const issuer=approval.createNativeEmailAuthorityApprovalIssuer(store,{...options.approvalIdentity,privateKey:keys.privateKey,ttlSeconds:120})
  const member=async()=>(await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m WHERE pipeline_id=$1 AND user_email=$2',
    [id(2),'reader@example.test'])).rows[0].row
  const otherBefore=(await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m WHERE pipeline_id<>$1 ORDER BY pipeline_id,user_email',[id(2)])).rows
  async function makePlan(role) {
    const before=await member()
    const after={...before,access_role:role,updated_at:new Date(Date.parse(before.updated_at)+1000).toISOString().replace('.000Z','+00:00')}
    const app=await store.previewMemberChange({kind:'pipeline_members_v1',changes:[{before,after}]},native.bindings.map(b=>b.pipeline_id))
    const prepared=await planner.buildNativeEmailMemberTransition({app,inspection:clone(native),transitionId:hash('role-'+ ++serial),
      timestamp:'2026-10-30 14:00:00',newMembershipId:()=>assert.fail('Retained role must not create native membership'),
      forecast:async request=>({version:1,beforePolicyFingerprint:request.beforePolicyFingerprint,
        revokePolicyFingerprint:request.beforePolicyFingerprint,grantPolicyFingerprint:request.beforePolicyFingerprint})})
    const {planHash,...input}=prepared
    return {before,after,planHash,input}
  }
  async function settle(plan,phase) {
    const c=plan.input[phase],tid=c.transitionId,envelope=await issuer.issue(tid,phase)
    await store.recordApprovalReadback(tid,phase,{version:1,operationId:c.operationId,transitionId:tid,phase,
      commandHash:hash(c),proofHash:hash(envelope.proof),appCommitFingerprint:envelope.proof.appCommit?hash(envelope.proof.appCommit):null,replayed:false})
    const claim=await store.claimPhase(tid,phase,id(6000+serial))
    await store.settlePhase(tid,phase,claim.claim,receipt(plan.input,phase))
    native={...native,generation:c.generationTo,nativePolicyFingerprint:c.afterPolicyFingerprint,
      beforeBindingsFingerprint:c.afterBindingsFingerprint,bindings:c.bindings.map(pair=>clone(pair.after)),
      capabilities:c.capabilities.map(({emailId,globalId,pipelineId,after})=>({emailId,globalId,pipelineId,capabilities:clone(after)}))}
  }
  await check('retained viewer promotion is native-first, atomic UPDATE-only, resumable and explicitly scoped',async()=>{
    assert.equal((await member()).access_role,'viewer')
    const plan=await makePlan('editor'),tid=plan.input.revoke.transitionId
    assert.equal(plan.input.grant.roleChanges[0].userId,id(12))
    assert.deepEqual(plan.input.revoke.membershipChanges,[]);assert.deepEqual(plan.input.grant.membershipChanges,[])
    await store.admit(plan.input)
    await assert.rejects(()=>query("UPDATE pipeline_space_members SET access_role='editor' WHERE pipeline_id=$1 AND user_email=$2",[id(2),'reader@example.test']),/supported exact native-first transition|snapshot is pinned/)
    await assert.rejects(()=>store.commitAppChange(tid,plan.planHash),held('authority_app_commit_before_revoke'))
    assert.equal((await member()).access_role,'viewer')
    await settle(plan,'revoke')
    failEffects=true
    await assert.rejects(()=>store.commitAppChange(tid,plan.planHash),/synthetic role audit failure/)
    assert.deepEqual(await member(),plan.before)
    assert.equal((await query('SELECT count(*) AS n FROM role_row_events')).rows[0].n,'0')
    failEffects=false
    await store.commitAppChange(tid,plan.planHash)
    assert.deepEqual(await member(),plan.after)
    await store.commitAppChange(tid,plan.planHash)
    await settle(plan,'grant')
    assert.equal((await current()).active_transition_id,null)
    assert.deepEqual((await query('SELECT operation FROM role_row_events')).rows,[{operation:'UPDATE'}])
  })
  await check('retained editor demotion removes both write surfaces before the exact app role UPDATE and preserves all reads',async()=>{
    const plan=await makePlan('viewer'),tid=plan.input.revoke.transitionId
    for(const c of [plan.input.revoke,plan.input.grant]) {
      const caps=c.capabilities.find(row=>row.pipelineId===id(2))
      assert.equal(caps.after.edit.includes(id(12)),false);assert.equal(caps.after.delete.includes(id(12)),false)
      assert.equal(caps.after.view.includes(id(12)),true)
      assert.deepEqual(c.membershipChanges,[])
    }
    await store.admit(plan.input);await settle(plan,'revoke')
    assert.equal((await member()).access_role,'editor')
    await store.commitAppChange(tid,plan.planHash);await settle(plan,'grant')
    assert.deepEqual(await member(),plan.after)
    assert.deepEqual((await query('SELECT operation FROM role_row_events')).rows,[{operation:'UPDATE'},{operation:'UPDATE'}])
    assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m WHERE pipeline_id<>$1 ORDER BY pipeline_id,user_email',[id(2)])).rows,otherBefore)
    await assert.rejects(()=>query("UPDATE pipeline_space_members SET access_role='editor' WHERE pipeline_id=$1 AND user_email=$2",[id(2),'reader@example.test']),/supported exact native-first transition/)
  })
}
