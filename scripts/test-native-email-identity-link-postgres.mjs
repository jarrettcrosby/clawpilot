// Actual full-migration SQL/store/issuer acceptance. Native inspection,
// approval readback and terminal receipts below are explicitly synthetic.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {enrollRootCrmSyntheticInitial} from './lib/root-crm-synthetic-initial-enrollment.mjs'

export async function runExistingIdentityLinkAcceptance(context){
 const {load,protocol,eligibility,userEligibility,nativeProjection,capability,transition,nativeAdapter,
  nativeTransport,query,tx,id,root,peer,owner,employee,grant}=context
 const hash=protocol.nativeEmailDigest,copy=value=>JSON.parse(JSON.stringify(value))
 const planner=load('app_src/lib/crm/nativeEmailAuthorityPlan.ts',{'./nativeEmailPublication':protocol,
  './nativeEmailEligibility':eligibility,'./nativeEmailWorkspaceUserEligibility':userEligibility,
  './suiteCrmNativeEmailProjection':nativeProjection,'./nativeEmailAuthorityTransition':transition})
 const approval=load('app_src/lib/crm/nativeEmailAuthorityApproval.ts',{'node:crypto':crypto,
  './nativeEmailPublication':protocol,'./nativeEmailAuthorityTransition':transition})
 const pipelines=[id(20),id(21)],nativeId=id(902),nativeOwner=id(901)
 const gu=(await query('SELECT reference_code FROM app_users WHERE email=$1',[employee])).rows[0].reference_code
 const request={workspaceId:root,userEmail:employee,nativeIdentity:{userId:nativeId,globalId:gu,username:gu}}
 await query('DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])
 await query('INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES($1,$2,\'editor\',$3)',[pipelines[0],employee,owner])
 for(let n=0;n<2;n++)await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,
  suitecrm_module,suitecrm_synced_at,reference_code) VALUES($1,$2,$3,'Synthetic identity-link history',$4,$5,'Emails',now(),allocate_crm_reference('gi'))`,
  [id(6000+n),pipelines[n],'identity-link-fixture-'+n,hash(['identity-source',n]),id(7000+n)])
 const beforeUser=(await query('SELECT to_jsonb(u) AS row FROM app_users u WHERE email=$1',[employee])).rows[0].row
 const beforeMemberships=(await query('SELECT to_jsonb(m) AS row FROM app_user_organization_memberships m ORDER BY user_email,organization_id')).rows
 const beforeMembers=(await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m ORDER BY pipeline_id,user_email')).rows
 await query('CREATE TABLE identity_link_effects(user_email text NOT NULL,transition_kind text NOT NULL)')
 const generation=Number((await query('SELECT generation FROM crm_native_email_publication_control')).rows[0].generation)
 const allCaps=()=>({view:[nativeOwner],list:[nativeOwner],export:[nativeOwner],edit:[nativeOwner],delete:[nativeOwner]})
 const bindings=pipelines.map((pipeline_id,n)=>{
  const workspace_id=n===0?root:peer,readers=[nativeOwner]
  const audience_fingerprint=nativeProjection.suiteCrmEmailAudienceFingerprint({policy:'pipeline-internal',ownerSuiteCrmId:nativeOwner,
   allowedSuiteCrmUserIds:readers,workspaceId:workspace_id,pipelineId:pipeline_id,fingerprint:''})
  const policy={version:2,pipelineId:pipeline_id,workspaceId:workspace_id,ownerSuiteCrmId:nativeOwner,audienceFingerprint:audience_fingerprint,
   principalSuiteCrmUserIds:[nativeOwner,nativeId],futureCreate:allCaps(),historical:[]}
  const checked=capability.prepareNativeEmailCapabilityContract(policy,{binding:{pipelineId:pipeline_id,workspaceId:workspace_id,
   ownerSuiteCrmId:nativeOwner,audienceFingerprint:audience_fingerprint,allowedReaderSuiteCrmUserIds:readers},
   livePrincipalSuiteCrmUserIds:policy.principalSuiteCrmUserIds,approvedFutureCreate:policy.futureCreate,liveHistorical:[]})
  return {pipeline_id,workspace_id,group_id:id(8000+n),generation:String(generation),owner_id:nativeOwner,
   readers_json:protocol.nativeEmailCanonicalJson(readers),audience_fingerprint,policy_fingerprint:hash('identity-initial-native-policy'),
   runtime_fingerprint:hash('identity-native-runtime'),enabled:'1',capability_policy_json:protocol.nativeEmailCanonicalJson(policy),
   capability_policy_fingerprint:checked.futurePolicyFingerprint}
 })
 const interactionRows=(await query('SELECT suitecrm_id,reference_code,pipeline_id::text FROM crm_interactions ORDER BY suitecrm_id')).rows
 assert.equal(interactionRows.length,2)
 const inspection={version:1,generation,nativePolicyFingerprint:bindings[0].policy_fingerprint,runtimeFingerprint:bindings[0].runtime_fingerprint,
  beforeBindingsFingerprint:hash(bindings),bindings,
  memberships:bindings.map((b,n)=>({id:id(8100+n),securitygroup_id:b.group_id,user_id:nativeOwner,
   date_modified:'2026-11-03 15:00:00',deleted:'0',primary_group:'0',noninheritable:'1'})),
  capabilities:interactionRows.map(row=>({emailId:row.suitecrm_id,globalId:row.reference_code,pipelineId:row.pipeline_id,capabilities:allCaps()})),
  principalSuiteCrmUserIds:[nativeOwner,nativeId]}
 planner.readNativeEmailAuthorityInspection(inspection)
 await enrollRootCrmSyntheticInitial({query,tx,protocol,capability,owner,root,inspection})
 let failEffects=false
 const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),options={actorEmail:owner,actorWorkspaceId:root,leaseSeconds:1,
  approvalIdentity:{keyId:'identity-fixture-key',nativeInstanceId:'identity-fixture-native',serviceUserId:id(9000),oauthClientId:id(9001)}}
 const store=new nativeAdapter.PostgresNativeEmailAuthorityTransitionStore(tx,options,async(c,change)=>{
  assert.equal(change.kind,'user_identity_link_v1');await c.query('INSERT INTO identity_link_effects VALUES($1,$2)',[change.userEmail,change.kind])
  if(failEffects)throw Error('Synthetic identity audit failure')
 })
 const app=await store.previewUserIdentityLink(request,pipelines)
 const plan=await planner.buildNativeEmailMemberTransition({app,inspection,transitionId:hash('identity-link-actual-pg'),
  timestamp:'2026-11-03 15:00:00',newMembershipId:()=>crypto.randomUUID(),forecast:async input=>({version:1,
   beforePolicyFingerprint:input.beforePolicyFingerprint,revokePolicyFingerprint:hash('identity-revoke-native'),grantPolicyFingerprint:hash('identity-grant-native')})})
 const {planHash,...input}=plan,tid=plan.revoke.transitionId
 const issuer=approval.createNativeEmailAuthorityApprovalIssuer(store,{...options.approvalIdentity,privateKey:keys.privateKey,ttlSeconds:120})
 const receipt=phase=>{const command=plan[phase];return {version:2,operationId:command.operationId,transitionId:tid,phase,
  commandHash:hash(command),state:'committed',replayed:false,result:{desiredAppChangeHash:command.desiredAppChangeHash,
   generationFrom:command.generationFrom,generationTo:command.generationTo,beforePolicyFingerprint:command.beforePolicyFingerprint,
   afterPolicyFingerprint:command.afterPolicyFingerprint,beforeBindingsFingerprint:command.beforeBindingsFingerprint,
   afterBindingsFingerprint:command.afterBindingsFingerprint,capabilitiesFingerprint:hash(command.capabilities.map(entry=>({emailId:entry.emailId,
    globalId:entry.globalId,pipelineId:entry.pipelineId,capabilities:entry.after}))),pendingPublicationTerminalReceipt:null}}}
 const approve=async phase=>{const envelope=await issuer.issue(tid,phase)
  await store.recordApprovalReadback(tid,phase,{version:1,operationId:plan[phase].operationId,transitionId:tid,phase,
   commandHash:hash(plan[phase]),proofHash:hash(envelope.proof),appCommitFingerprint:envelope.proof.appCommit?hash(envelope.proof.appCommit):null,replayed:false})}
 // The SQL validator independently rejects privilege/identity expansion, not
 // only the TypeScript parser. No malformed proposal is admitted.
 for(const mutate of [change=>{const row=JSON.parse(change.appUser.afterJson);row.role='owner';change.appUser.afterJson=JSON.stringify(row)},
  change=>{change.nativeIdentity.globalId='gu1234567'},change=>{change.nativeIdentity.create=true},change=>{change.contextFingerprint='bad'}]){
  const changed=copy(app.desiredAppChange);mutate(changed)
  await assert.rejects(query('SELECT * FROM clawpilot_native_email_identity_link_rows($1)',[JSON.stringify(changed)]),e=>e.code==='55000')
 }
 await store.admit(input)
 assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_authority_user_changes WHERE transition_id=$1',[tid])).rows[0].n,1)
 await assert.rejects(store.commitAppChange(tid,planHash),e=>e.code==='authority_app_commit_before_revoke')
 await assert.rejects(query('UPDATE app_users SET suitecrm_user_id=$2,suitecrm_username=reference_code WHERE email=$1',[employee,nativeId]),e=>e.code==='55000')
 await assert.rejects(query('UPDATE app_users SET crm_user_enabled=false WHERE email=$1',[employee]),e=>e.code==='55000')
 await assert.rejects(query('UPDATE crm_native_email_authority_user_changes SET applied=true WHERE transition_id=$1',[tid]),e=>e.code==='55000')
 await approve('revoke');const revoke=await store.claimPhase(tid,'revoke',id(9200));assert.equal(revoke.action,'execute')
 await store.settlePhase(tid,'revoke',revoke.claim,receipt('revoke'))
 for(const [index,pipeline]of pipelines.entries()){
  assert.equal((await query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS allowed',
   [pipeline,index===0?root:peer,nativeOwner])).rows[0].allowed,true,'An exact committed revoke preserves an unaffected native reader')
  assert.equal((await query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS allowed',
   [pipeline,index===0?root:peer,nativeId])).rows[0].allowed,false,'Revoke proof cannot grant a newly linked reader')
 }
 failEffects=true;await assert.rejects(store.commitAppChange(tid,planHash),/Synthetic identity audit failure/);failEffects=false
 assert.deepEqual((await query('SELECT to_jsonb(u) AS row FROM app_users u WHERE email=$1',[employee])).rows[0].row,beforeUser)
 assert.equal((await query('SELECT count(*)::int AS n FROM identity_link_effects')).rows[0].n,0)
 assert.equal((await query('SELECT applied FROM crm_native_email_authority_user_changes WHERE transition_id=$1',[tid])).rows[0].applied,false)
 await store.commitAppChange(tid,planHash)
 const afterUser=(await query('SELECT to_jsonb(u) AS row FROM app_users u WHERE email=$1',[employee])).rows[0].row
 assert.deepEqual({...afterUser,updated_at:beforeUser.updated_at},{...beforeUser,suitecrm_user_id:nativeId,suitecrm_username:gu})
 assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM app_user_organization_memberships m ORDER BY user_email,organization_id')).rows,beforeMemberships)
 assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m ORDER BY pipeline_id,user_email')).rows,beforeMembers)
 assert.equal((await query('SELECT active_transition_id FROM crm_native_email_publication_control')).rows[0].active_transition_id,tid)
 for(const [index,pipeline]of pipelines.entries())assert.equal((await query(
  'SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS allowed',[pipeline,index===0?root:peer,nativeId])).rows[0].allowed,false,
  'A local app identity commit cannot supply native root reads before the exact grant receipt')
 await approve('grant');const grantClaim=await store.claimPhase(tid,'grant',id(9201));assert.equal(grantClaim.action,'execute')
 await store.markUnknown(tid,'grant',grantClaim.claim)
 await assert.rejects(store.claimPhase(tid,'grant',id(9202)),e=>e.code==='authority_lease_busy')
 await new Promise(resolve=>setTimeout(resolve,1200))
 const recovery=await store.claimPhase(tid,'grant',id(9202));assert.equal(recovery.action,'resolve')
 await store.settlePhase(tid,'grant',recovery.claim,receipt('grant'))
 const completed=await store.load(tid);assert.equal(completed.grant.state,'committed')
 assert.equal((await query('SELECT active_transition_id FROM crm_native_email_publication_control')).rows[0].active_transition_id,null)
 await store.commitAppChange(tid,planHash)
 assert.equal((await query('SELECT count(*)::int AS n FROM identity_link_effects')).rows[0].n,1)
 for(const scope of app.snapshots.after.pipelines){
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(p=>p.suitecrm_user_id).sort(),[nativeOwner,nativeId])
  const matrix=plan.grant.capabilities.find(entry=>entry.pipelineId===scope.pipeline.id).after
  assert.deepEqual(matrix.view,[nativeOwner,nativeId]);assert.deepEqual(matrix.edit,scope.pipeline.id===pipelines[0]?[nativeOwner,nativeId]:[nativeOwner])
 }
 console.log('PASS exact identity SQL validation, native-first mapping, rollback, retained membership intent, unknown-grant receipt resolution and idempotent effects')
 if(context.verifyRootNativeReads)await context.verifyRootNativeReads({nativeId,pipelines,transitionId:tid})
 // The parent owns a disposable database clone. Keep all committed initial
 // and identity-link evidence intact until that clone is removed; never
 // disable native authority or erase its policies to reset a test flag.
 assert.equal((await query('SELECT enabled FROM crm_native_email_publication_control')).rows[0].enabled,true)
 assert.equal((await query("SELECT count(*)::int AS n FROM crm_native_email_initial_enrollments WHERE state='activated'")).rows[0].n,1)
 assert.equal((await query('SELECT enabled FROM crm_root_employee_access_grants WHERE id=$1',[grant])).rows[0].enabled,true)
 void nativeTransport
}
