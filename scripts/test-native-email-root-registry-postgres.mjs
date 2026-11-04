// Real application store, full PostgreSQL schema/guards and approval issuer.
// Native inspection/forecast/terminal receipts are synthetic, not provider proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'

export async function runRootRegistryAcceptance(context){
 const {load,protocol,eligibility,userEligibility,nativeProjection,capability,transition,nativeAdapter,
  query,tx,id,root,peer,child,owner,employee,check}=context
 const json=protocol.nativeEmailCanonicalJson,hash=protocol.nativeEmailDigest,copy=value=>JSON.parse(JSON.stringify(value))
 const planner=load('app_src/lib/crm/nativeEmailAuthorityPlan.ts',{'./nativeEmailPublication':protocol,
  './nativeEmailEligibility':eligibility,'./nativeEmailWorkspaceUserEligibility':userEligibility,
  './suiteCrmNativeEmailProjection':nativeProjection,'./nativeEmailAuthorityTransition':transition})
 const approval=load('app_src/lib/crm/nativeEmailAuthorityApproval.ts',{'node:crypto':crypto,
  './nativeEmailPublication':protocol,'./nativeEmailAuthorityTransition':transition})
 const newRoot=id(500),account=id(510),grant=id(511),nativeOwner=id(901),nativeUser=id(902)
 const pipelines=[id(20),id(21),id(520),id(521)],workspaceIds=[root,peer,newRoot,child]
 await query("INSERT INTO workspace_organizations(id,name,organization_type,is_demo,created_by,updated_by) VALUES($1,'New explicit operator root','root',false,$2,$2)",[newRoot,owner])
 for(const [user,role]of [[owner,'owner'],[employee,'member']])await query(`INSERT INTO app_user_organization_memberships
  (organization_id,user_email,role,status,permissions,created_by,updated_by) VALUES($1,$2,$3,'active','{"viewCrm":true}',$4,$4)`,[newRoot,user,role,owner])
 for(const [pipeline,workspace]of [[pipelines[2],newRoot],[pipelines[3],child]]){
  await query("INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,'Root registry exact integration',$2,$3)",[pipeline,owner,workspace])
  await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,reference_code)
   VALUES($1,$2,$3,'Synthetic root registry history',$4,$5,'Emails',now(),allocate_crm_reference('gi'))`,
  [id(pipeline===pipelines[2]?530:531),pipeline,'root-registry-'+pipeline,hash(pipeline),id(pipeline===pipelines[2]?540:541)])
 }
 const delta=(table,row)=>({table,beforeJson:null,afterJson:json(row)})
 const request={kind:'root_registry_v1',workspaceId:newRoot,operatorAccountId:account,ownerEmail:owner,
  actorScope:{workspaceId:newRoot,ancestryJson:json([{id:newRoot,parent_id:null,is_demo:false}])},contextFingerprint:'a'.repeat(64),
  changes:[delta('account',{id:account,root_workspace_id:newRoot,owner_email:owner,enabled:true,revision:'1'}),
   ...[child,newRoot].sort().map(workspace=>delta('binding',{operator_account_id:account,workspace_id:workspace,owner_email:owner,enabled:true,revision:'1'})),
   delta('grant',{id:grant,operator_account_id:account,user_email:employee,source_workspace_id:newRoot,enabled:true,revision:'1'})]}
 const rows=(await query(`SELECT suitecrm_id AS "emailId",reference_code AS "globalId",pipeline_id::text AS "pipelineId"
  FROM crm_interactions WHERE suitecrm_module='Emails' AND suitecrm_synced_at IS NOT NULL ORDER BY suitecrm_id,id`)).rows
 const generation=Number((await query('SELECT generation FROM crm_native_email_publication_control')).rows[0].generation)
 const caps=()=>({view:[nativeOwner],list:[nativeOwner],export:[nativeOwner],edit:[nativeOwner],delete:[nativeOwner]})
 const bindings=pipelines.map((pipeline_id,index)=>{
  const workspace_id=workspaceIds[index],readers=[nativeOwner]
  const audience=nativeProjection.suiteCrmEmailAudienceFingerprint({policy:'pipeline-internal',ownerSuiteCrmId:nativeOwner,
   allowedSuiteCrmUserIds:readers,workspaceId:workspace_id,pipelineId:pipeline_id,fingerprint:''})
  const policy={version:2,pipelineId:pipeline_id,workspaceId:workspace_id,ownerSuiteCrmId:nativeOwner,audienceFingerprint:audience,
   principalSuiteCrmUserIds:[nativeOwner,nativeUser],futureCreate:caps(),historical:[]}
  const checked=capability.prepareNativeEmailCapabilityContract(policy,{binding:{pipelineId:pipeline_id,workspaceId:workspace_id,
   ownerSuiteCrmId:nativeOwner,audienceFingerprint:audience,allowedReaderSuiteCrmUserIds:readers},
   livePrincipalSuiteCrmUserIds:policy.principalSuiteCrmUserIds,approvedFutureCreate:policy.futureCreate,liveHistorical:[]})
  return {pipeline_id,workspace_id,group_id:id(600+index),generation:String(generation),owner_id:nativeOwner,readers_json:json(readers),
   audience_fingerprint:audience,policy_fingerprint:hash('root-registry-initial-native'),runtime_fingerprint:hash('root-registry-runtime'),
   enabled:'1',capability_policy_json:json(policy),capability_policy_fingerprint:checked.futurePolicyFingerprint}
 })
 const inspection={version:1,generation,nativePolicyFingerprint:bindings[0].policy_fingerprint,runtimeFingerprint:bindings[0].runtime_fingerprint,
  beforeBindingsFingerprint:hash(bindings),bindings,memberships:bindings.map((b,index)=>({id:id(610+index),securitygroup_id:b.group_id,
   user_id:nativeOwner,date_modified:'2026-11-03 20:00:00',deleted:'0',primary_group:'0',noninheritable:'1'})),
  capabilities:rows.map(row=>({...row,capabilities:caps()})),principalSuiteCrmUserIds:[nativeOwner,nativeUser]}
 await tx(async c=>{
  for(const b of bindings)await c.query('INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint) VALUES($1,$2,$3,$4)',
   [b.pipeline_id,generation,b.capability_policy_json,b.capability_policy_fingerprint])
  await c.query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
   native_policy_fingerprint=$1,activation_receipt_hash=$2`,[inspection.nativePolicyFingerprint,hash('synthetic-root-registry-initial')])
 })
 const identity={keyId:'root-registry-test',nativeInstanceId:'root-registry-native',serviceUserId:id(700),oauthClientId:id(701)}
 let failEffects=false
 await query('CREATE TABLE root_registry_effects(transition_kind text NOT NULL)')
 const store=new nativeAdapter.PostgresNativeEmailAuthorityTransitionStore(tx,{actorEmail:owner,actorWorkspaceId:newRoot,leaseSeconds:1,
  approvalIdentity:identity},async(c,change)=>{assert.equal(change.kind,'root_registry_v1');await c.query('INSERT INTO root_registry_effects VALUES($1)',[change.kind]);
   if(failEffects)throw Error('Synthetic root registry audit failure')})
 const app=await store.previewRootRegistryChange(request,pipelines)
 const plan=await planner.buildNativeEmailMemberTransition({app,inspection,transitionId:hash('actual-root-registry-pg'),
  timestamp:'2026-11-03 20:00:00',newMembershipId:()=>crypto.randomUUID(),forecast:async input=>({version:1,
   beforePolicyFingerprint:input.beforePolicyFingerprint,revokePolicyFingerprint:hash('root-registry-native-revoke'),grantPolicyFingerprint:hash('root-registry-native-grant')})})
 const {planHash,...input}=plan,tid=plan.revoke.transitionId,keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
 const issuer=approval.createNativeEmailAuthorityApprovalIssuer(store,{...identity,privateKey:keys.privateKey,ttlSeconds:120})
 const receipt=(phase,selected=plan)=>{const command=selected[phase];return {version:2,operationId:command.operationId,transitionId:command.transitionId,phase,
  commandHash:hash(command),state:'committed',replayed:false,result:{desiredAppChangeHash:command.desiredAppChangeHash,
   generationFrom:command.generationFrom,generationTo:command.generationTo,beforePolicyFingerprint:command.beforePolicyFingerprint,
   afterPolicyFingerprint:command.afterPolicyFingerprint,beforeBindingsFingerprint:command.beforeBindingsFingerprint,
   afterBindingsFingerprint:command.afterBindingsFingerprint,capabilitiesFingerprint:hash(command.capabilities.map(e=>({emailId:e.emailId,
    globalId:e.globalId,pipelineId:e.pipelineId,capabilities:e.after}))),pendingPublicationTerminalReceipt:null}}}
 const approve=async(phase,selected=plan)=>{const transitionId=selected.revoke.transitionId,envelope=await issuer.issue(transitionId,phase);await store.recordApprovalReadback(transitionId,phase,{version:1,
  operationId:selected[phase].operationId,transitionId,phase,commandHash:hash(selected[phase]),proofHash:hash(envelope.proof),
  appCommitFingerprint:envelope.proof.appCommit?hash(envelope.proof.appCommit):null,replayed:false})}
 const memberships=(await query('SELECT to_jsonb(m) AS row FROM app_user_organization_memberships m ORDER BY organization_id,user_email')).rows
 await check('native root registry SQL validates exact immutable changes independently of the TypeScript parser',async()=>{
  assert.equal((await query('SELECT count(*)::int AS n FROM clawpilot_crm_root_registry_change_rows($1)',[json(app.desiredAppChange)])).rows[0].n,4)
  for(const mutate of [v=>{v.ownerEmail='wrong@example.invalid'},v=>{v.changes.reverse()},v=>{v.changes[0].extra=true},
   v=>{const r=JSON.parse(v.changes[3].afterJson);r.source_workspace_id=root;v.changes[3].afterJson=json(r)},
   v=>{const r=JSON.parse(v.changes[3].afterJson);r.revision='9007199254740992';v.changes[3].afterJson=json(r)}]){
   const invalid=copy(app.desiredAppChange);mutate(invalid)
   await assert.rejects(query('SELECT * FROM clawpilot_crm_root_registry_change_rows($1)',[json(invalid)]),e=>e.code==='55000')
  }
 })
 await check('root registry admission pins new actual source and refuses raw writes and app commit before native revoke',async()=>{
  await store.admit(input)
  assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_authority_root_changes WHERE transition_id=$1',[tid])).rows[0].n,4)
  await assert.rejects(store.commitAppChange(tid,planHash),e=>e.code==='authority_app_commit_before_revoke')
  await assert.rejects(query('UPDATE crm_native_email_authority_root_changes SET applied=true WHERE transition_id=$1',[tid]),e=>e.code==='55000')
  for(const [sql,args]of[
   ["UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":false}' WHERE organization_id=$1 AND user_email=$2",[newRoot,employee]],
   ['UPDATE workspace_organizations SET is_demo=true WHERE id=$1',[newRoot]],
   ["INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,'Unexpected',$2,$3)",[id(599),owner,newRoot]],
  ])await assert.rejects(query(sql,args),e=>e.code==='55000')
  assert.equal((await query('SELECT count(*)::int AS n FROM crm_operator_accounts WHERE id=$1',[account])).rows[0].n,0)
 })
 await approve('revoke');const revoked=await store.claimPhase(tid,'revoke',id(710));await store.settlePhase(tid,'revoke',revoked.claim,receipt('revoke'))
 await check('an audit failure rolls back all account/binding/grant rows and applied evidence atomically',async()=>{
  failEffects=true;await assert.rejects(store.commitAppChange(tid,planHash),/Synthetic root registry audit failure/u);failEffects=false
  assert.equal((await query('SELECT count(*)::int AS n FROM crm_operator_accounts WHERE id=$1',[account])).rows[0].n,0)
  assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_authority_root_changes WHERE transition_id=$1 AND applied',[tid])).rows[0].n,0)
  assert.equal((await query('SELECT count(*)::int AS n FROM root_registry_effects')).rows[0].n,0)
 })
 await check('exact new registry intent commits once after revoke without creating memberships or granting premature mapped reads',async()=>{
  await store.commitAppChange(tid,planHash)
  assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_authority_root_changes WHERE transition_id=$1 AND applied',[tid])).rows[0].n,4)
  assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM app_user_organization_memberships m ORDER BY organization_id,user_email')).rows,memberships)
  assert.equal((await query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS ok',[pipelines[3],child,nativeUser])).rows[0].ok,false)
  await store.commitAppChange(tid,planHash)
  assert.equal((await query('SELECT count(*)::int AS n FROM root_registry_effects')).rows[0].n,1)
 })
 await approve('grant');const claim=await store.claimPhase(tid,'grant',id(711));await store.markUnknown(tid,'grant',claim.claim)
 await assert.rejects(store.claimPhase(tid,'grant',id(712)),e=>e.code==='authority_lease_busy')
 await new Promise(resolve=>setTimeout(resolve,1200))
 const resumed=await store.claimPhase(tid,'grant',id(712));assert.equal(resumed.action,'resolve');await store.settlePhase(tid,'grant',resumed.claim,receipt('grant'))
 await check('lost root-registry grant resolves its retained receipt exactly once and gives inherited readers no writer rights',async()=>{
  const done=await store.load(tid);assert.equal(done.grant.state,'committed')
  for(const pipeline of pipelines.slice(2)){
   const scope=app.snapshots.after.pipelines.find(row=>row.pipeline.id===pipeline)
   assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(p=>p.suitecrm_user_id).sort(),[nativeOwner,nativeUser])
   const policy=JSON.parse(plan.grant.bindings.find(row=>row.after.pipeline_id===pipeline).after.capability_policy_json)
   assert.deepEqual(policy.futureCreate.view,[nativeOwner,nativeUser]);assert.deepEqual(policy.futureCreate.edit,[nativeOwner])
  }
  assert.equal((await query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS ok',[pipelines[3],child,nativeUser])).rows[0].ok,true)
  assert.equal((await query('SELECT count(*)::int AS n FROM clawpilot_crm_root_read_workspaces($1) WHERE workspace_id=$2',[employee,child])).rows[0].n,1)
  assert.equal((await query('SELECT count(*)::int AS n FROM root_registry_effects')).rows[0].n,1)
 })
 await check('a second exact transition disables account/bindings/grant at the next revision without deleting history or retaining inherited native access',async()=>{
  const disable={...request,changes:request.changes.map(row=>({table:row.table,beforeJson:row.afterJson,
   afterJson:json({...JSON.parse(row.afterJson),enabled:false,revision:'2'})}))}
  const beforeBindings=plan.grant.bindings.map(pair=>pair.after)
  const nativeMembers=[...inspection.memberships,...plan.grant.membershipChanges.map(pair=>pair.after)].sort((a,b)=>a.id<b.id?-1:1)
  const currentInspection={...inspection,generation:plan.grant.generationTo,nativePolicyFingerprint:plan.grant.afterPolicyFingerprint,
   beforeBindingsFingerprint:hash(beforeBindings),bindings:beforeBindings,memberships:nativeMembers,
   capabilities:plan.grant.capabilities.map(row=>({emailId:row.emailId,globalId:row.globalId,pipelineId:row.pipelineId,capabilities:row.after}))}
  const app2=await store.previewRootRegistryChange(disable,pipelines)
  const plan2=await planner.buildNativeEmailMemberTransition({app:app2,inspection:currentInspection,transitionId:hash('actual-root-registry-disable-pg'),
   timestamp:'2026-11-03 20:01:00',newMembershipId:()=>crypto.randomUUID(),forecast:async input=>({version:1,
    beforePolicyFingerprint:input.beforePolicyFingerprint,revokePolicyFingerprint:hash('root-registry-disable-native-revoke'),grantPolicyFingerprint:hash('root-registry-disable-native-grant')})})
  const {planHash:hash2,...input2}=plan2,tid2=plan2.revoke.transitionId
  await store.admit(input2);await approve('revoke',plan2)
  const revoke=await store.claimPhase(tid2,'revoke',id(720));await store.settlePhase(tid2,'revoke',revoke.claim,receipt('revoke',plan2))
  assert.equal((await query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS ok',[pipelines[3],child,nativeUser])).rows[0].ok,false)
  await store.commitAppChange(tid2,hash2);await approve('grant',plan2)
  const claim2=await store.claimPhase(tid2,'grant',id(721));await store.settlePhase(tid2,'grant',claim2.claim,receipt('grant',plan2))
  for(const [table,key,value]of [['crm_operator_accounts','id',account],['crm_operator_workspace_bindings','operator_account_id',account],
   ['crm_root_employee_access_grants','id',grant]]){
   const found=(await query(`SELECT enabled,revision::text FROM ${table} WHERE ${key}=$1`,[value])).rows
   assert.ok(found.length>0);for(const row of found)assert.deepEqual(row,{enabled:false,revision:'2'})
   await assert.rejects(query(`DELETE FROM ${table} WHERE ${key}=$1`,[value]),e=>e.code==='55000')
  }
  assert.equal((await query('SELECT count(*)::int AS n FROM root_registry_effects')).rows[0].n,2)
  assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_authority_root_changes WHERE transition_id=ANY($1::text[]) AND applied',[[tid,tid2]])).rows[0].n,8)
  assert.equal((await query('SELECT count(*)::int AS n FROM clawpilot_crm_root_read_workspaces($1) WHERE workspace_id=$2',[employee,child])).rows[0].n,0)
  assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM app_user_organization_memberships m ORDER BY organization_id,user_email')).rows,memberships)
 })
}
