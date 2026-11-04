// Actual adapter/planner/issuer, audience SQL and PostgreSQL lifecycle guards.
// Native inspections, forecasts and phase receipts are synthetic. No native
// account, group, provider connection, browser or production change is made.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as crypto from 'node:crypto'
import {loadNativeRootReaderFixtureModules} from './lib/native-root-reader-fixture-modules.mjs'

export async function runAppOnlySharingAcceptance(context) {
  const {load,protocol,eligibility,userEligibility,audience,transition,adapter,approval,
    query,transaction,options,keys,current,id,hash,clone,held,check,receipt}=context
  const planner=load('app_src/lib/crm/nativeEmailAuthorityPlan.ts',{'./nativeEmailPublication':protocol,
    './suiteCrmNativeEmailProjection':audience,'./nativeEmailAuthorityTransition':transition,
    './nativeEmailEligibility':eligibility,'./nativeEmailWorkspaceUserEligibility':userEligibility})
  const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
  const source=readFileSync(new URL('../app_src/lib/persistence/crm.ts',import.meta.url),'utf8')
  const ast=ts.createSourceFile('crm.ts',source,ts.ScriptTarget.Latest,true)
  const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reviewedEmailAudienceUnderNativeControlWithClient')
  assert.ok(declaration)
  const compiled=ts.transpileModule(declaration.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const exported={}
  const roots=loadNativeRootReaderFixtureModules(load,protocol)
  new Function('exports','nativeEmailPrincipalIsEligible','nativeEmailEffectivePipelinePrincipals',
    'collectNativeEmailRootSourcesWithClient','projectNativeEmailRootReaders','suiteCrmEmailAudienceFingerprint',compiled)(
    exported,eligibility.nativeEmailPrincipalIsEligible,eligibility.nativeEmailEffectivePipelinePrincipals,
    roots.collectNativeEmailRootSourcesWithClient,roots.projectNativeEmailRootReaders,audience.suiteCrmEmailAudienceFingerprint)
  const readAudience=()=>transaction(async tx=>{
    await tx.query('SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
    return exported.reviewedEmailAudienceUnderNativeControlWithClient(tx,id(2))
  })
  const first='plain-app@example.test',second='app-only-two@example.test',pipelineIds=[id(2),id(4)]
  const nativeBefore=clone(context.inspection),expectedAudience=await readAudience()
  let native=clone(nativeBefore),serial=0
  const store=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,options)
  const issuer=approval.createNativeEmailAuthorityApprovalIssuer(store,{...options.approvalIdentity,privateKey:keys.privateKey,ttlSeconds:120})
  const member=email=>query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m WHERE pipeline_id=$1 AND user_email=$2',[id(2),email]).then(r=>r.rows[0]?.row??null)
  function applyNativeCommand(command) {
    assert.deepEqual(command.membershipChanges,[])
    native={...native,generation:command.generationTo,nativePolicyFingerprint:command.afterPolicyFingerprint,
      beforeBindingsFingerprint:command.afterBindingsFingerprint,bindings:command.bindings.map(pair=>clone(pair.after)),
      capabilities:command.capabilities.map(({emailId,globalId,pipelineId,after})=>({emailId,globalId,pipelineId,capabilities:clone(after)}))}
    planner.readNativeEmailAuthorityInspection(native)
  }
  async function makePlan(email,role) {
    const before=await member(email),stamp=(await query('SELECT to_jsonb(transaction_timestamp()) AS stamp')).rows[0].stamp
    const after=role===null?null:{pipeline_id:id(2),user_email:email,access_role:role,
      shared_by:before?.shared_by??options.actorEmail,created_at:before?.created_at??stamp,updated_at:stamp}
    const app=await store.previewMemberChange({kind:'pipeline_members_v1',changes:[{before,after}]},pipelineIds)
    const n=++serial,plan=await planner.buildNativeEmailMemberTransition({app,inspection:clone(native),
      transitionId:hash(`app-only-sharing-${n}`),timestamp:'2026-11-02 20:00:00',
      newMembershipId:()=>assert.fail('An app-only member cannot receive a native group membership'),
      forecast:async request=>{
        assert.deepEqual(request.revokeMembershipChanges,[]);assert.deepEqual(request.grantMembershipChanges,[])
        return {version:1,beforePolicyFingerprint:request.beforePolicyFingerprint,
          revokePolicyFingerprint:request.beforePolicyFingerprint,grantPolicyFingerprint:request.beforePolicyFingerprint}
      }})
    for(const phase of ['revoke','grant']) {
      assert.deepEqual(plan[phase].membershipChanges,[])
      assert.equal(plan[phase].roleChanges,undefined,'Do not invent a native User ID for an app-only viewer/editor change')
      for(const entry of plan[phase].capabilities)assert.deepEqual(entry.before,entry.after)
      for(const pair of plan[phase].bindings)assert.equal(pair.before.readers_json,pair.after.readers_json)
    }
    for(const stage of ['before','after'])for(const email of [first,second]) {
      const p=app.snapshots[stage].pipelines.flatMap(scope=>scope.principals).find(p=>p.email===email)
      if(p){assert.equal(p.suitecrm_user_id,null);assert.equal(p.native_identity_count,0)}
    }
    const {planHash,...input}=plan
    return {input,planHash}
  }
  async function settle(plan,phase) {
    const command=plan.input[phase],tid=command.transitionId,envelope=await issuer.issue(tid,phase)
    await store.recordApprovalReadback(tid,phase,{version:1,operationId:command.operationId,transitionId:tid,phase,
      commandHash:hash(command),proofHash:hash(envelope.proof),appCommitFingerprint:envelope.proof.appCommit?hash(envelope.proof.appCommit):null,replayed:false})
    const claim=await store.claimPhase(tid,phase,id(8000+serial));assert.equal(claim.action,'execute')
    await store.settlePhase(tid,phase,claim.claim,receipt(plan.input,phase))
    applyNativeCommand(command)
  }
  async function finish(plan) {
    await settle(plan,'revoke');await store.commitAppChange(plan.input.revoke.transitionId,plan.planHash);await settle(plan,'grant')
    assert.equal((await current()).active_transition_id,null)
    assert.deepEqual(await readAudience(),expectedAudience)
  }
  await check('app-only sharing commits complete app intent with no invented native principal group role or audience',async()=>{
    const plan=await makePlan(first,'viewer');await store.admit(plan.input)
    assert.equal(await member(first),null,'App access cannot commit ahead of the native phase receipt')
    await assert.rejects(()=>store.commitAppChange(plan.input.revoke.transitionId,plan.planHash),held('authority_app_commit_before_revoke'))
    await finish(plan);assert.equal((await member(first)).access_role,'viewer')
    assert.equal((await query('SELECT suitecrm_user_id FROM app_users WHERE email=$1',[first])).rows[0].suitecrm_user_id,null)
  })
  await check('multiple app-only members and retained editor promotion preserve native readership and writer matrices',async()=>{
    await query(`INSERT INTO app_users(email,status,suitecrm_user_id,role,permissions,organization_id) VALUES($1,'active',NULL,'member','{}',$2)`,[second,id(1)])
    await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,status,role,permissions,trashed_at) VALUES($1,$2,'active','member','{}',NULL)`,[second,id(1)])
    for(const [email,role]of[[second,'viewer'],[first,'editor']]){const plan=await makePlan(email,role);await store.admit(plan.input);await finish(plan)}
    assert.equal((await member(first)).access_role,'editor');assert.equal((await member(second)).access_role,'viewer')
    assert.deepEqual(native.memberships,nativeBefore.memberships)
    assert.equal(native.nativePolicyFingerprint,nativeBefore.nativePolicyFingerprint)
  })
  await check('shared app-only module denial disable Trash and restore keep intent and native pins intact',async()=>{
    const pins=await current(),members=(await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m ORDER BY pipeline_id,user_email')).rows
    await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":false}' WHERE user_email=$1 AND organization_id=$2`,[first,id(1)])
    await query("UPDATE app_users SET status='disabled' WHERE email=$1",[first])
    assert.deepEqual(await readAudience(),expectedAudience)
    await query("UPDATE app_user_organization_memberships SET status='disabled',trashed_at=now(),trashed_by=$2,pre_trash_status='active' WHERE user_email=$1",[first,options.actorEmail])
    assert.deepEqual(await readAudience(),expectedAudience)
    await transaction(async tx=>{
      await tx.query("UPDATE app_users SET status='active' WHERE email=$1",[first])
      await tx.query("UPDATE app_user_organization_memberships SET status='active',permissions='{}',trashed_at=NULL,trashed_by=NULL,pre_trash_status=NULL WHERE user_email=$1",[first])
    })
    assert.deepEqual(await current(),pins);assert.deepEqual(await readAudience(),expectedAudience)
    assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m ORDER BY pipeline_id,user_email')).rows,members)
  })
  await check('app-only cannot bypass mapping ownership source-snapshot or orphan-scope safeguards',async()=>{
    for(const [sql,args]of[
      ['UPDATE app_users SET suitecrm_user_id=$2 WHERE email=$1',[first,id(12)]],
      ['DELETE FROM app_users WHERE email=$1',[first]],
      ['DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[first,id(1)]],
      ['UPDATE app_user_organization_memberships SET organization_id=$2 WHERE user_email=$1 AND organization_id=$3',[first,id(5),id(1)]],
      ['UPDATE pipeline_spaces SET owner_email=$1 WHERE id=$2',[first,id(2)]],
    ])await assert.rejects(()=>query(sql,args),error=>error.code==='55000'
      || sql.startsWith('DELETE FROM app_users')&&error.code==='23503'
        &&error.constraint==='crm_native_email_authority_member_changes_user_email_fkey')
    assert.equal((await query('SELECT suitecrm_user_id FROM app_users WHERE email=$1',[first])).rows[0].suitecrm_user_id,null)
    const plan=await makePlan(first,'viewer');await store.admit(plan.input)
    await assert.rejects(()=>query("UPDATE app_users SET status='disabled' WHERE email=$1",[first]),error=>error.code==='55000')
    await assert.rejects(()=>query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":false}' WHERE user_email=$1`,[first]),error=>error.code==='55000')
    await finish(plan);assert.equal((await member(first)).access_role,'viewer')
  })
  await check('app-only unsharing preserves every native grant and permits scope cleanup only after intent removal',async()=>{
    const plan=await makePlan(first,null);await store.admit(plan.input);await finish(plan)
    assert.equal(await member(first),null);assert.equal((await member(second)).access_role,'viewer')
    await query('DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[first,id(1)])
    assert.deepEqual(await readAudience(),expectedAudience)
    assert.deepEqual(native.capabilities,nativeBefore.capabilities)
    assert.deepEqual(native.memberships,nativeBefore.memberships)
  })
  await check('actual sharing runtime drives PostgreSQL admission RSA approvals app commit permission sync and audit for app-only role changes',async()=>{
    await query('CREATE TABLE app_only_sharing_effects(kind text,payload jsonb)')
    let nativeExecutions=0,loseGrantReply=true,holdResolution=true
    const receipts=new Map()
    const client={inspect:async()=>clone(native),project:async input=>({version:1,
      beforePolicyFingerprint:input.beforePolicyFingerprint,revokePolicyFingerprint:input.beforePolicyFingerprint,grantPolicyFingerprint:input.beforePolicyFingerprint}),
      approve:async(command,envelope)=>({version:1,operationId:command.operationId,transitionId:command.transitionId,phase:command.phase,
        commandHash:hash(command),proofHash:hash(envelope.proof),appCommitFingerprint:envelope.proof.appCommit?hash(envelope.proof.appCommit):null,replayed:false}),
      execute:async command=>{
        nativeExecutions++;assert.equal(command.roleChanges,undefined);applyNativeCommand(command)
        const value=transition.verifyNativeEmailAuthorityReceipt(transition.prepareNativeEmailAuthorityCommand(command),{
          version:command.version,operationId:command.operationId,transitionId:command.transitionId,phase:command.phase,
          commandHash:hash(command),state:'committed',replayed:false,result:{desiredAppChangeHash:command.desiredAppChangeHash,
            generationFrom:command.generationFrom,generationTo:command.generationTo,beforePolicyFingerprint:command.beforePolicyFingerprint,
            afterPolicyFingerprint:command.afterPolicyFingerprint,beforeBindingsFingerprint:command.beforeBindingsFingerprint,
            afterBindingsFingerprint:command.afterBindingsFingerprint,capabilitiesFingerprint:hash(command.capabilities.map(
              ({emailId,globalId,pipelineId,after})=>({emailId,globalId,pipelineId,capabilities:after}))),pendingPublicationTerminalReceipt:null}})
        receipts.set(command.operationId,value)
        if(command.phase==='grant'&&loseGrantReply){loseGrantReply=false;throw Error('synthetic lost grant response')}
        return value
      },resolveOrCancel:async command=>{
        if(holdResolution)throw Error('synthetic native outcome is still unknown')
        assert.ok(receipts.has(command.operationId));return {...clone(receipts.get(command.operationId)),replayed:true}
      }}
    // Reviewed local two-second lease profile, not a production duration or a
    // lease bypass. Exercise the real store and wait for database-clock expiry.
    class FixtureRuntimeStore extends adapter.PostgresNativeEmailAuthorityTransitionStore {
      constructor(tx,config,effects){super(tx,{...config,leaseSeconds:2},effects)}
    }
    const runtimeDeps={'node:crypto':crypto,'../persistence/postgres':{withTransaction:transaction},
      '../persistence/crmNativeEmailAuthority':load('app_src/lib/persistence/crmNativeEmailAuthority.ts',{}),
      '../persistence/pipeline':{enqueuePipelinePermissionSyncWithClient:async(tx,payload)=>tx.query("INSERT INTO app_only_sharing_effects VALUES('permission-sync',$1::jsonb)",[JSON.stringify(payload)])},
      '../auditWriter':{recordAuditEvent:async(payload,tx)=>tx.query("INSERT INTO app_only_sharing_effects VALUES('audit',$1::jsonb)",[JSON.stringify(payload)])},
      './nativeEmailPublication':protocol,'./nativeEmailAuthorityTransitionPostgres':{...adapter,PostgresNativeEmailAuthorityTransitionStore:FixtureRuntimeStore},'./nativeEmailAuthorityApproval':approval,
      './nativeEmailAuthorityTransport':{createSuiteCrmNativeEmailAuthorityClient:()=>client},
      './nativeEmailAuthorityTransition':transition,'./nativeEmailAuthorityPlan':planner,'./nativeEmailEligibility':eligibility}
    const values={BASE_URL:'https://native.example.test',CLIENT_ID:options.approvalIdentity.oauthClientId,CLIENT_SECRET:'synthetic-only',
      KEY_ID:options.approvalIdentity.keyId,INSTANCE_ID:options.approvalIdentity.nativeInstanceId,SERVICE_USER_ID:options.approvalIdentity.serviceUserId,
      PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()}
    const env=Object.fromEntries(Object.entries(values).map(([key,value])=>['CLAWPILOT_NATIVE_EMAIL_AUTHORITY_'+key,value]))
    const module={exports:{}},runtimeCode=ts.transpileModule(readFileSync(new URL('../app_src/lib/crm/nativeEmailAuthorityRuntime.ts',import.meta.url),'utf8'),{
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
    new Function('module','exports','require','process',runtimeCode)(module,module.exports,name=>{
      assert.ok(Object.hasOwn(runtimeDeps,name),name);return runtimeDeps[name]}, {env})
    const selection={actorEmail:options.actorEmail,workspaceId:id(1),pipelineId:id(2),userEmail:second,accessRole:'editor'}
    await assert.rejects(()=>module.exports.changePipelineMemberWithNativeAuthority(selection),e=>e instanceof module.exports.NativeEmailAccessPendingError)
    assert.equal((await member(second)).access_role,'editor');assert.equal(nativeExecutions,2)
    const savedId=(await current()).active_transition_id;assert.match(savedId,/^[a-f0-9]{64}$/)
    await query("ALTER TABLE pipeline_spaces ADD COLUMN name text NOT NULL DEFAULT 'Synthetic pipeline'")
    const recovery=load('app_src/lib/crm/nativeEmailSharingRecovery.ts',{'../persistence/postgres':{query},
      './nativeEmailPublication':protocol,'./nativeEmailAuthorityTransition':transition,
      './nativeEmailAuthorityTransitionPostgres':adapter,'./nativeEmailAuthorityRuntime':module.exports})
    assert.deepEqual(await recovery.getPendingPipelineSharingChange(options.actorEmail,id(1)),{
      transitionId:savedId,workspaceId:id(1),pipelineId:id(2),pipelineName:'Synthetic pipeline',userEmail:second,accessRole:'editor'})
    for(const [email,workspace]of[['other-owner@example.test',id(3)],[options.actorEmail,id(3)],[second,id(1)]]){
      assert.equal(await recovery.getPendingPipelineSharingChange(email,workspace),null)
      await assert.rejects(()=>recovery.resumePipelineSharingChange(email,workspace,savedId),e=>e instanceof module.exports.NativeEmailAccessPendingError&&e.transitionId===null)
    }
    const lease=()=>query("SELECT state,lease_owner,lease_fence,lease_until,lease_until>clock_timestamp() AS live FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='grant'",[savedId]).then(r=>r.rows[0])
    const beforeRetry=await lease();assert.equal(beforeRetry.live,true)
    await assert.rejects(()=>recovery.resumePipelineSharingChange(options.actorEmail,id(1),savedId),e=>e instanceof module.exports.NativeEmailAccessPendingError&&e.transitionId===savedId)
    assert.deepEqual(await lease(),beforeRetry,'Resume must not steal or rewrite a live claim')
    const expiryDeadline=Date.now()+5000
    while((await lease()).live){assert.ok(Date.now()<expiryDeadline,'Fixture lease must expire by its real database clock');await new Promise(resolve=>setTimeout(resolve,50))}
    holdResolution=false
    await recovery.resumePipelineSharingChange(options.actorEmail,id(1),savedId)
    assert.equal((await current()).active_transition_id,null)
    assert.equal(await recovery.getPendingPipelineSharingChange(options.actorEmail,id(1)),null)
    await assert.rejects(()=>module.exports.changePipelineMemberWithNativeAuthority(selection,savedId),e=>e instanceof module.exports.NativeEmailAccessPendingError&&e.transitionId===null)
    await assert.rejects(()=>recovery.resumePipelineSharingChange(options.actorEmail,id(1),savedId),e=>e instanceof module.exports.NativeEmailAccessPendingError&&e.transitionId===null)
    assert.equal(await module.exports.changePipelineMemberWithNativeAuthority(selection),true)
    assert.equal(nativeExecutions,2,'Already-correct role must not re-execute phases or effects')
    const effects=(await query('SELECT * FROM app_only_sharing_effects ORDER BY kind')).rows
    assert.equal(effects.length,2);assert.deepEqual(effects.find(e=>e.kind==='permission-sync').payload,{pipelineId:id(2),actor:options.actorEmail})
    const audit=effects.find(e=>e.kind==='audit').payload
    assert.equal(audit.eventType,'pipeline.space.shared');assert.equal(audit.payload.userEmail,second)
    assert.equal(audit.payload.accessRole,'editor');assert.equal(audit.payload.nativeAuthority,true)
    assert.deepEqual(await readAudience(),expectedAudience);assert.deepEqual(native.capabilities,nativeBefore.capabilities)
  })
}
