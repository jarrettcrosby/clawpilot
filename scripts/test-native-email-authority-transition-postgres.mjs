#!/usr/bin/env node
// Real adapter, authorization queries, issuer and migrations. Native ACL/receipt
// readbacks are explicitly synthetic; no production/provider authorization proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript')
function load(path,deps){const module={exports:{}}
  const code=ts.transpileModule(readFileSync(new URL(`../${path}`,import.meta.url),'utf8'),{fileName:path,
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]})
  return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const eligibility=load('app_src/lib/crm/nativeEmailEligibility.ts',{'./nativeEmailPublication':protocol})
const userEligibility=load('app_src/lib/crm/nativeEmailWorkspaceUserEligibility.ts',{'./nativeEmailPublication':protocol})
const identityLink=load('app_src/lib/crm/nativeEmailIdentityLinkChange.ts',{'./nativeEmailPublication':protocol,'./nativeEmailWorkspaceUserEligibility':userEligibility})
const audience=load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts',{'node:crypto':crypto})
const capability=load('app_src/lib/crm/nativeEmailCapabilityContract.ts',{'node:crypto':crypto,'./nativeEmailPublication':protocol})
const transition=load('app_src/lib/crm/nativeEmailAuthorityTransition.ts',{'./nativeEmailPublication':protocol,'./suiteCrmNativeEmailProjection':audience,'./nativeEmailCapabilityContract':capability})
const approval=load('app_src/lib/crm/nativeEmailAuthorityApproval.ts',{'node:crypto':crypto,'./nativeEmailPublication':protocol,'./nativeEmailAuthorityTransition':transition})
const transport=load('app_src/lib/crm/nativeEmailAuthorityTransport.ts',{'./nativeEmailPublication':protocol,'./nativeEmailAuthorityTransition':transition})
const rootContract=load('app_src/lib/crm/rootEmployeeCrmAccess.ts',{'./nativeEmailPublication':protocol})
const controlLock=load('app_src/lib/persistence/crmNativeEmailAuthority.ts',{})
const rootCollector=load('app_src/lib/persistence/crmRootEmployeeAccess.ts',{'./crmNativeEmailAuthority':controlLock,
 '../crm/rootEmployeeCrmAccess':rootContract,'../crm/nativeEmailPublication':protocol})
const rootRegistry=load('app_src/lib/crm/rootEmployeeCrmRegistryChange.ts',{'./nativeEmailPublication':protocol})
const rootRegistryPreview=load('app_src/lib/persistence/crmRootEmployeeRegistryPreview.ts',{
 '../crm/nativeEmailPublication':protocol,'../crm/rootEmployeeCrmRegistryChange':rootRegistry,
 './crmNativeEmailAuthority':controlLock,'./crmRootEmployeeAccess':rootCollector})
const rootReaders=load('app_src/lib/crm/nativeEmailRootReaders.ts',{'../persistence/crmRootEmployeeAccess':rootCollector,
 '../persistence/crmRootEmployeeRegistryPreview':rootRegistryPreview,'./rootEmployeeCrmRegistryChange':rootRegistry,
 '../persistence/crmNativeEmailAuthority':controlLock,'./rootEmployeeCrmAccess':rootContract,'./nativeEmailPublication':protocol})
const adapter=load('app_src/lib/crm/nativeEmailAuthorityTransitionPostgres.ts',{'./nativeEmailPublication':protocol,
  './nativeEmailIdentityLinkChange':identityLink,
  './nativeEmailRootReaders':rootReaders,
  './nativeEmailEligibility':eligibility,
  './nativeEmailWorkspaceUserEligibility':userEligibility,
  './nativeEmailAuthorityTransition':transition,'./nativeEmailAuthorityTransport':transport,'./nativeEmailCapabilityContract':capability})
const publication=load('app_src/lib/persistence/crmNativeEmailPublication.ts',{
  './postgres':{},'./pipeline':{},'./crm':{},'../crm/stableId':{},'../crm/nativeEmailPublication':protocol,
  '../crm/nativeEmailAuthorityTransition':transition,'../crm/nativeEmailCapabilityContract':capability,
  '../crm/nativeEmailPublicationPostgres':load('app_src/lib/crm/nativeEmailPublicationPostgres.ts',{'./nativeEmailPublication':protocol}),
  '../crm/nativeEmailPublicationWorkContext':load('app_src/lib/crm/nativeEmailPublicationWorkContext.ts',{'./nativeEmailPublication':protocol}),
  '../crm/nativeEmailPublicationTransport':load('app_src/lib/crm/nativeEmailPublicationTransport.ts',{'./nativeEmailPublication':protocol}),
})
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash=protocol.nativeEmailDigest,clone=value=>JSON.parse(JSON.stringify(value))
const held=code=>error=>error?.name==='NativeEmailPublicationHeld'&&(!code||error.code===code)
const member={pipeline_id:id(2),user_email:'reader@example.test',access_role:'viewer',shared_by:'owner@example.test',
  created_at:'2026-10-30T12:00:00+00:00',updated_at:'2026-10-30T12:00:00+00:00'}
const checks=[]
async function check(name,run){await run();checks.push(name);console.log(`PASS ${name}`)}
await check('typed delta accepts exact retained role changes and rejects identity timestamp and duplicate drift',async()=>{
  const valid={kind:'pipeline_members_v1',changes:[{before:member,after:null}]}
  assert.ok(Object.isFrozen(adapter.prepareNativeEmailPipelineMemberChange(valid)))
  const role={...member,access_role:'editor',updated_at:'2026-10-30T12:01:00+00:00'}
  assert.ok(Object.isFrozen(adapter.prepareNativeEmailPipelineMemberChange({...valid,changes:[{before:member,after:role}]})))
  for(const after of [member,{...role,user_email:'other@example.test'},{...role,pipeline_id:id(99)},
    {...role,shared_by:'other@example.test'},{...role,created_at:role.updated_at},
    {...role,updated_at:'2026-10-30T11:00:00+00:00'},{...role,extra:true}])
    assert.throws(()=>adapter.prepareNativeEmailPipelineMemberChange({...valid,changes:[{before:member,after}]}),held())
  for(const value of [{...valid,changes:[{before:null,after:null}]},
    {...valid,changes:[...valid.changes,...valid.changes]}, {...valid,changes:[{before:{...member,extra:true},after:null}]},
    {...valid,changes:[{before:{...member,pipeline_id:'bad'},after:null}]}])assert.throws(()=>adapter.prepareNativeEmailPipelineMemberChange(value),held())
})
await check('snapshot permissions preserve empty object versus array without changing wire rules',async()=>{
  const encode=adapter.encodeNativeEmailAuthoritySnapshotJson
  assert.notEqual(hash(encode({})),hash(encode([])))
  assert.equal(hash(encode({viewCrm:true,nested:{}})),hash(encode({nested:{},viewCrm:true})))
  assert.notEqual(hash(encode({viewCrm:true})),hash(encode({viewCrm:false})))
  assert.throws(()=>protocol.nativeEmailCanonicalJson({}),held('invalid_json_empty_object'))
})
if(process.argv.length===2){console.log('PASS local typed contract; run --postgres for actual SQL/authorization/issuer acceptance');process.exit(0)}
const ownerMode={'--postgres-member-owner':'member','--postgres-admin-owner':'admin'}[process.argv[2]]??null
const userMode=process.argv[2]==='--postgres-user',v2=userMode||process.argv[2]==='--postgres-v2'||ownerMode!==null
assert.deepEqual(process.argv.slice(2),[ownerMode?`--postgres-${ownerMode}-owner`:userMode?'--postgres-user':v2?'--postgres-v2':'--postgres'],
  'Only explicit guarded --postgres, --postgres-v2, --postgres-user, --postgres-member-owner or --postgres-admin-owner is supported')
const {Pool}=require('pg'),container=`clawpilot-authority-${process.pid}-${crypto.randomUUID().slice(0,8)}`
const image=process.env.CLAWPILOT_TEST_POSTGRES_IMAGE||'pgvector/pgvector:pg16'
assert.match(image,/^pgvector\/pgvector:pg(?:16|18)$/u)
let pool,started=false
try{
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never','-e','POSTGRES_PASSWORD=authority_fixture',
    '-e','POSTGRES_DB=authority_fixture','-p','127.0.0.1::5432',image]),{timeout:60000,stdio:'pipe'});started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1];assert.ok(port)
  pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'authority_fixture',database:'authority_fixture',ssl:false,
    max:4,connectionTimeoutMillis:1000,statement_timeout:5000})
  const deadline=Date.now()+30000
  while(true){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>=deadline)throw error;await new Promise(r=>setTimeout(r,100))}}
  assert.equal((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count,'0')
  const query=(sql,values)=>pool.query(sql,values)
  let failCommit=false
  const transaction=async callback=>{const tx=await pool.connect();try{await tx.query('BEGIN');const result=await callback(tx)
    if(failCommit){failCommit=false;throw Error('synthetic commit failure')}
    await tx.query('COMMIT');return result}catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}}
  await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid);
    CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,shared_by text,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,PRIMARY KEY(user_email,organization_id));
    CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,suitecrm_module text,suitecrm_synced_at timestamptz,subject text DEFAULT 'Synthetic',description text DEFAULT '');
    INSERT INTO workspace_organizations(id) VALUES('${id(1)}'),('${id(3)}');
    INSERT INTO app_users VALUES('owner@example.test','active','${id(11)}','${ownerMode??'owner'}','{}','${id(1)}'),
      ('reader@example.test','active','${id(12)}','member','{}','${id(1)}'),
      ('outsider@example.test','active','${id(13)}','member','{}','${id(1)}'),
      ('other-owner@example.test','active','${id(14)}','owner','{}','${id(3)}'),
      ('plain-app@example.test','active',NULL,'member','{}','${id(1)}');
    INSERT INTO app_user_organization_memberships SELECT email,organization_id,'active',role,'{}',NULL FROM app_users;
    INSERT INTO pipeline_spaces VALUES('${id(2)}','owner@example.test','${id(1)}',false),('${id(4)}','other-owner@example.test','${id(3)}',false);
    INSERT INTO crm_interactions(id,pipeline_id,suitecrm_id,reference_code,suitecrm_module,suitecrm_synced_at) VALUES('${id(101)}','${id(2)}','${id(201)}','gi1234567','Emails',now()),
      ('${id(102)}','${id(4)}','${id(202)}','gi1234568','Emails',now());`)
  await query('INSERT INTO pipeline_space_members SELECT (jsonb_populate_record(NULL::pipeline_space_members,$1::jsonb)).*',[JSON.stringify(member)])
  if(ownerMode)await query("ALTER TABLE pipeline_spaces ADD COLUMN name text NOT NULL DEFAULT 'Synthetic owned pipeline'")
  if(userMode)await query(`ALTER TABLE app_users ADD COLUMN updated_at timestamptz DEFAULT now();
    ALTER TABLE app_users ADD COLUMN reference_code text,ADD COLUMN crm_user_enabled boolean NOT NULL DEFAULT false,ADD COLUMN suitecrm_username text;
    ALTER TABLE workspace_organizations ADD COLUMN parent_id uuid REFERENCES workspace_organizations(id) ON DELETE RESTRICT;
    ALTER TABLE app_user_organization_memberships ADD COLUMN trashed_by text,ADD COLUMN pre_trash_status text,
      ADD COLUMN updated_by text,ADD COLUMN updated_at timestamptz DEFAULT now();
    CREATE TABLE sync_outbox(target_system text,operation text,status text);
    CREATE TABLE lifecycle_effects(transition_action text NOT NULL,user_email text NOT NULL);
    INSERT INTO workspace_organizations(id,is_demo) VALUES('${id(5)}',false),('${id(6)}',false),('${id(7)}',false),('${id(9)}',true);
    UPDATE workspace_organizations SET parent_id='${id(6)}' WHERE id='${id(7)}';
    UPDATE workspace_organizations SET parent_id='${id(7)}' WHERE id='${id(1)}';
    INSERT INTO app_users(email,status,suitecrm_user_id,role,permissions,organization_id)
      VALUES('parent-admin@example.test','active',NULL,'admin','{"manageUserAccess":true}','${id(6)}');
    INSERT INTO app_user_organization_memberships(user_email,organization_id,status,role,permissions)
      VALUES('reader@example.test','${id(3)}','active','member','{}'),
      ('reader@example.test','${id(5)}','disabled','member','{}'),
      ('reader@example.test','${id(9)}','active','member','{}'),
      ('parent-admin@example.test','${id(6)}','active','admin','{"manageUserAccess":true}');
    INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by,created_at,updated_at)
      VALUES('${id(4)}','reader@example.test','viewer','other-owner@example.test','2026-10-30T12:00:00Z','2026-10-30T12:00:00Z');`)
  for(const file of ['0375_crm_native_email_publication_admission.sql','0376_crm_native_email_publication_work_context.sql',
    '0377_crm_native_email_authority_transitions.sql','0378_crm_native_email_capability_policies.sql',
    '0379_crm_native_email_app_only_lifecycle.sql','0380_crm_native_email_grant_attempts.sql',
    ...(userMode?['0381_crm_native_email_identity_quiescence.sql','0382_crm_native_email_mapped_settings.sql',
      '0383_crm_native_email_user_eligibility.sql']:[]),
    '0384_crm_native_email_member_role_changes.sql','0392_crm_root_employee_access_registry.sql',
    ...(userMode?['0386_crm_native_email_first_access_grants.sql','0387_crm_native_email_shared_app_only_lifecycle.sql',
      '0391_crm_native_email_unshared_workspace_enrollment.sql','0395_crm_native_email_existing_identity_links.sql']:[])])
    await transaction(tx=>tx.query(readFileSync(new URL(`../db/migrations/${file}`,import.meta.url),'utf8')))
  if(userMode)await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":false}'
      WHERE user_email='outsider@example.test' AND organization_id='${id(1)}';
    INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by,created_at,updated_at)
      VALUES('${id(2)}','outsider@example.test','viewer','owner@example.test','2026-10-30T12:00:00Z','2026-10-30T12:00:00Z');`)
  const current=async()=>(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  await check('snapshot metadata remains writable outside active transitions in disabled and enabled mode',async()=>{
    await query("UPDATE pipeline_space_members SET updated_at=updated_at+interval '1 second' WHERE pipeline_id=$1",[id(2)])
    await query('UPDATE workspace_organizations SET is_demo=true WHERE id=$1',[id(1)])
    await query('UPDATE workspace_organizations SET is_demo=false WHERE id=$1',[id(1)])
  })
  const identity={keyId:'synthetic-key',nativeInstanceId:'synthetic-native',serviceUserId:id(901),oauthClientId:id(902)}
  const options={actorEmail:'owner@example.test',leaseSeconds:2,approvalIdentity:identity}
  const store=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,options)
  if(ownerMode)await check(`resource owner retains ${ownerMode} workspace role before native-first sharing`,async()=>{
    assert.equal((await query('SELECT role FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',
      [options.actorEmail,id(1)])).rows[0].role,ownerMode)
    const before=(await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m WHERE pipeline_id=$1 AND user_email=$2',
      [id(2),member.user_email])).rows[0].row
    const change={kind:'pipeline_members_v1',changes:[{before,after:null}]}
    const preview=await store.previewMemberChange(change,[id(2),id(4)])
    assert.equal(preview.snapshots.before.pipelines.find(p=>p.pipeline.id===id(2)).principals.find(p=>p.email===options.actorEmail).membership_role,ownerMode)
    const outsider=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,{...options,actorEmail:'outsider@example.test'})
    await assert.rejects(()=>outsider.previewMemberChange(change,[id(2),id(4)]),held('authority_actor_not_owner'))
  })
  const longStore=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,{...options,leaseSeconds:120})
  const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
  let clock=Date.now
  const issuer=approval.createNativeEmailAuthorityApprovalIssuer(store,{...identity,privateKey:keys.privateKey,ttlSeconds:120},()=>clock())
  let sequence=0
  async function makePlan(add=false){
    sequence++;const c=await current()
    const row=add?member:(await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m WHERE pipeline_id=$1 AND user_email=$2',[id(2),member.user_email])).rows[0].row
    const desired={kind:'pipeline_members_v1',changes:[{before:add?null:row,after:add?row:null}]}
    const preview=await store.previewMemberChange(desired,[id(2),id(4)])
    const generation=Number(c.generation),policy=c.native_policy_fingerprint??hash('initial-policy'),middlePolicy=hash(`middle-policy-${sequence}`),finalPolicy=hash(`final-policy-${sequence}`)
    const transitionId=hash(`transition-${sequence}`),runtime=hash('runtime')
    const makeBindings=(snapshot,gen,pin)=>snapshot.pipelines.map(scope=>{
      const readers=eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(value=>value.suitecrm_user_id).sort()
      const binding={pipeline_id:scope.pipeline.id,workspace_id:scope.workspace.id,group_id:id(scope.pipeline.id===id(2)?301:302),
        generation:String(gen),owner_id:scope.principals.find(value=>value.email===scope.pipeline.owner_email).suitecrm_user_id,
        readers_json:JSON.stringify(readers),audience_fingerprint:'',policy_fingerprint:pin,runtime_fingerprint:runtime,enabled:'1'}
      binding.audience_fingerprint=audience.suiteCrmEmailAudienceFingerprint({policy:'pipeline-internal',ownerSuiteCrmId:binding.owner_id,
        allowedSuiteCrmUserIds:readers,workspaceId:binding.workspace_id,pipelineId:binding.pipeline_id,fingerprint:''});return binding})
    const first=makeBindings(preview.snapshots.before,generation,policy),last=makeBindings(preview.snapshots.after,generation+2,finalPolicy)
    const middle=first.map((binding,index)=>{const readers=JSON.parse(binding.readers_json).filter(value=>JSON.parse(last[index].readers_json).includes(value))
      const b={...binding,generation:String(generation+1),policy_fingerprint:middlePolicy,readers_json:JSON.stringify(readers)}
      b.audience_fingerprint=audience.suiteCrmEmailAudienceFingerprint({policy:'pipeline-internal',ownerSuiteCrmId:b.owner_id,allowedSuiteCrmUserIds:readers,
        workspaceId:b.workspace_id,pipelineId:b.pipeline_id,fingerprint:''});return b})
    const matrix=(bindings,email)=>{const b=bindings.find(row=>row.pipeline_id===email.pipelineId),readers=JSON.parse(b.readers_json)
      return {view:readers,list:readers,export:readers,edit:[b.owner_id],delete:[b.owner_id]}}
    if(v2)for(const bindings of [first,middle,last])for(const b of bindings){
      const policy={version:2,pipelineId:b.pipeline_id,workspaceId:b.workspace_id,ownerSuiteCrmId:b.owner_id,audienceFingerprint:b.audience_fingerprint,
        principalSuiteCrmUserIds:[id(11),id(12),id(13),id(14)],futureCreate:matrix(bindings,{pipelineId:b.pipeline_id}),historical:[]}
      b.capability_policy_json=JSON.stringify(policy)
      b.capability_policy_fingerprint=capability.prepareNativeEmailCapabilityContract(policy,{binding:{pipelineId:b.pipeline_id,workspaceId:b.workspace_id,
        ownerSuiteCrmId:b.owner_id,audienceFingerprint:b.audience_fingerprint,allowedReaderSuiteCrmUserIds:JSON.parse(b.readers_json)},
        livePrincipalSuiteCrmUserIds:policy.principalSuiteCrmUserIds,approvedFutureCreate:policy.futureCreate,liveHistorical:[]}).futurePolicyFingerprint
    }
    const nativeMember={id:id(401),date_modified:'2026-10-30 12:00:00',deleted:add?'1':'0',securitygroup_id:id(301),user_id:id(12),primary_group:'0',noninheritable:'1'}
    const command=(phase,from,to,before,after,beforePolicy,afterPolicy)=>({version:v2?2:1,operationId:hash(`${transitionId}-${phase}`),transitionId,phase,
      generationFrom:from,generationTo:to,desiredAppChangeHash:hash(desired),beforePolicyFingerprint:beforePolicy,afterPolicyFingerprint:afterPolicy,
      beforeBindingsFingerprint:hash(before),afterBindingsFingerprint:hash(after),runtimeFingerprint:runtime,
      bindings:before.map((value,index)=>({before:value,after:after[index]})),
      membershipChanges:(phase==='grant')===add?[{before:nativeMember,after:{...nativeMember,deleted:add?'0':'1'}}]:[],
      capabilities:preview.snapshots.before.emails.map(email=>({...email,before:matrix(before,email),after:matrix(after,email)})),pendingPublicationCommand:null})
    return {version:1,desiredAppChange:desired,expectedAppAuthorityBeforeFingerprint:preview.appAuthorityBeforeFingerprint,
      expectedAppAuthorityAfterFingerprint:preview.appAuthorityAfterFingerprint,
      revoke:command('revoke',generation,generation+1,first,middle,policy,middlePolicy),
      grant:command('grant',generation+1,generation+2,middle,last,middlePolicy,finalPolicy)}
  }
  function receipt(plan,phase,cancelled=false){const command=plan[phase]
    return {version:command.version,operationId:command.operationId,transitionId:command.transitionId,phase,commandHash:hash(command),state:cancelled?'cancelled':'committed',replayed:false,
      result:cancelled?null:{desiredAppChangeHash:command.desiredAppChangeHash,generationFrom:command.generationFrom,generationTo:command.generationTo,
        beforePolicyFingerprint:command.beforePolicyFingerprint,afterPolicyFingerprint:command.afterPolicyFingerprint,
        beforeBindingsFingerprint:command.beforeBindingsFingerprint,afterBindingsFingerprint:command.afterBindingsFingerprint,
        capabilitiesFingerprint:hash(command.capabilities.map(entry=>({emailId:entry.emailId,globalId:entry.globalId,pipelineId:entry.pipelineId,capabilities:entry.after}))),
        pendingPublicationTerminalReceipt:null}}
  }
  async function approve(plan,phase){const envelope=await issuer.issue(plan.revoke.transitionId,phase)
    await store.recordApprovalReadback(plan.revoke.transitionId,phase,{version:1,operationId:plan[phase].operationId,transitionId:plan[phase].transitionId,
      phase,commandHash:hash(plan[phase]),proofHash:hash(envelope.proof),appCommitFingerprint:envelope.proof.appCommit?hash(envelope.proof.appCommit):null,replayed:false})
    return envelope}
  async function approveEffective(tid){
    const envelope=await issuer.issue(tid,'grant'),record=await store.load(tid)
    const command=transition.nativeEmailAuthorityPhaseCommand(record,'grant')
    await store.recordApprovalReadback(tid,'grant',{version:1,operationId:command.operationId,transitionId:tid,
      phase:'grant',commandHash:hash(command),proofHash:hash(envelope.proof),appCommitFingerprint:hash(record.appCommit),replayed:false})
    return {envelope,command}
  }
  const first=await makePlan(),firstId=first.revoke.transitionId
  if(v2)for(const pair of first.revoke.bindings)await query(`INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint)
    VALUES($1,$2,$3::jsonb,$4)`,[pair.before.pipeline_id,first.revoke.generationFrom,pair.before.capability_policy_json,pair.before.capability_policy_fingerprint])
  await check('default-off and owner authorization reject writes; full unaffected other-owner binding remains intact',async()=>{
    await assert.rejects(()=>store.admit(first),held('authority_admission_control_changed'))
    await query('UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,native_policy_fingerprint=$1,activation_receipt_hash=$2',[first.revoke.beforePolicyFingerprint,hash('activation')])
    await transaction(async tx=>{
      await tx.query("UPDATE pipeline_space_members SET updated_at=updated_at+interval '1 second' WHERE pipeline_id=$1",[id(2)])
      await tx.query("UPDATE pipeline_space_members SET updated_at=updated_at-interval '1 second' WHERE pipeline_id=$1",[id(2)])
      await tx.query('UPDATE workspace_organizations SET is_demo=true WHERE id=$1',[id(1)])
      await tx.query('UPDATE workspace_organizations SET is_demo=false WHERE id=$1',[id(1)])
    })
    const outsider=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,{...options,actorEmail:'outsider@example.test'})
    await assert.rejects(()=>outsider.admit(first),held('authority_actor_not_owner'))
    if(v2){const hinted=clone(first)
      hinted.revoke.identityLinks=[{userId:id(12),globalId:'gu1234567',username:'gu1234567'}]
      hinted.grant.identityLinks=clone(hinted.revoke.identityLinks)
      await assert.rejects(()=>store.admit(hinted),held('authority_identity_link_action_unsupported'))}
    const changed=clone(first);changed.expectedAppAuthorityBeforeFingerprint=hash('wrong')
    await assert.rejects(()=>store.admit(changed),held('authority_app_snapshot_changed'))
    const unbound=clone(first);unbound.revoke.capabilities.pop();unbound.grant.capabilities.pop()
    await assert.rejects(()=>store.admit(unbound),held('authority_email_matrix_coverage_changed'))
    assert.equal((await current()).active_transition_id,null)
    await store.admit(first);assert.equal((await current()).active_transition_id,firstId)
    assert.equal(first.revoke.bindings[1].before.owner_id,id(14))
    if(ownerMode){
      const recovery=load('app_src/lib/crm/nativeEmailSharingRecovery.ts',{
        '../persistence/postgres':{query},'./nativeEmailPublication':protocol,'./nativeEmailAuthorityTransition':transition,
        './nativeEmailAuthorityTransitionPostgres':adapter,'./nativeEmailAuthorityRuntime':{
          NativeEmailAccessPendingError:class extends Error{},changePipelineMemberWithNativeAuthority:()=>assert.fail('Discovery is read-only')},
      })
      assert.deepEqual(await recovery.getPendingPipelineSharingChange(options.actorEmail,id(1)),{
        transitionId:firstId,workspaceId:id(1),pipelineId:id(2),pipelineName:'Synthetic owned pipeline',userEmail:member.user_email,accessRole:null})
      assert.equal(await recovery.getPendingPipelineSharingChange('other-owner@example.test',id(1)),null)
      assert.equal(await recovery.getPendingPipelineSharingChange(options.actorEmail,id(3)),null)
    }
  })
  await check('ledger pins commands deltas initialization and exact full app preimages; direct authority mutation is refused',async()=>{
    await assert.rejects(()=>query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1',[id(2)]),/supported exact native-first transition/)
    await assert.rejects(()=>query("UPDATE crm_native_email_authority_transitions SET app_state='committed',app_commit='{}' WHERE transition_id=$1",[firstId]),/immutable or invalid phase/)
    await assert.rejects(()=>query("UPDATE crm_native_email_authority_phases SET command='{}' WHERE transition_id=$1 AND phase='revoke'",[firstId]),/phase evidence changed/)
    await assert.rejects(()=>query('UPDATE crm_native_email_authority_member_changes SET applied=true WHERE transition_id=$1',[firstId]),/exact active transaction/)
    await assert.rejects(()=>query('INSERT INTO crm_native_email_authority_member_changes SELECT transition_id,1,pipeline_id,user_email,before_row,after_row,true FROM crm_native_email_authority_member_changes WHERE transition_id=$1',[firstId]),/delta differs/)
    await assert.rejects(()=>query('UPDATE crm_native_email_publication_control SET active_transition_id=NULL'),/remains unresolved/)
    await assert.rejects(()=>store.commitAppChange(firstId,hash('wrong')),held('authority_app_plan_changed'))
    await assert.rejects(()=>store.commitAppChange(firstId,transition.prepareNativeEmailAuthorityTransition(first).planHash),held('authority_app_commit_before_revoke'))
    await assert.rejects(()=>query("UPDATE pipeline_space_members SET updated_at=clock_timestamp() WHERE pipeline_id=$1",[id(2)]),/snapshot is pinned/)
    await assert.rejects(()=>query(`INSERT INTO pipeline_space_members SELECT (jsonb_populate_record(NULL::pipeline_space_members,$1::jsonb)).*
      ON CONFLICT(pipeline_id,user_email) DO UPDATE SET access_role=excluded.access_role,updated_at=clock_timestamp()`,[JSON.stringify(member)]),
    /supported exact native-first transition|snapshot is pinned/)
    await assert.rejects(()=>query('UPDATE workspace_organizations SET is_demo=true WHERE id=$1',[id(1)]),/snapshot is pinned/)
    await assert.rejects(()=>query('UPDATE workspace_organizations SET is_demo=true WHERE id=$1',[id(3)]),/snapshot is pinned/)
  })
  await check('app-only lifecycle exception does not bypass an active exact transition',async()=>{
    assert.equal((await query(`SELECT clawpilot_native_email_app_only_change_is_independent('app_users',to_jsonb(u),
      to_jsonb(u)||'{"status":"disabled"}'::jsonb) AS independent FROM app_users u WHERE email='plain-app@example.test'`)).rows[0].independent,true)
    await assert.rejects(()=>query(`UPDATE app_users SET status='disabled' WHERE email='plain-app@example.test'`),/supported exact native-first transition/)
    await assert.rejects(()=>query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":false}'
      WHERE user_email='plain-app@example.test'`),/supported exact native-first transition/)
    await assert.rejects(()=>query(`INSERT INTO app_users(email,status,role,permissions,organization_id)
      VALUES('new-app@example.test','invited','member','{}',$1)`,[id(1)]),/supported exact native-first transition/)
    assert.equal((await current()).active_transition_id,firstId)
    assert.equal((await query(`SELECT status FROM app_users WHERE email='plain-app@example.test'`)).rows[0].status,'active')
  })
  await check('actual RSA issuer is transaction-backed once-only; failed commit rolls back envelope; readback pins proof',async()=>{
    failCommit=true;await assert.rejects(()=>issuer.issue(firstId,'revoke'),/synthetic commit failure/)
    assert.equal((await query("SELECT approval_envelope FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='revoke'",[firstId])).rows[0].approval_envelope,null)
    const envelope=await issuer.issue(firstId,'revoke');clock=()=>Date.now()+10000
    assert.deepEqual(await issuer.issue(firstId,'revoke'),envelope);clock=Date.now
    await assert.rejects(()=>issuer.issue(firstId,'grant'),held('authority_approval_phase_not_prepared'))
    await assert.rejects(()=>store.recordApprovalReadback(firstId,'revoke',{version:1,operationId:first.revoke.operationId,transitionId:firstId,
      phase:'revoke',commandHash:hash(first.revoke),proofHash:hash('wrong'),appCommitFingerprint:null,replayed:false}),held('authority_approval_readback_changed'))
    await approve(first,'revoke')
  })
  await check('known Email identity and eligibility are fenced; content timestamp refresh and unknown other-module rows remain writable',async()=>{
    await query("UPDATE crm_interactions SET subject='Synthetic edited',description='Synthetic content only' WHERE id=$1",[id(101)])
    await query('UPDATE crm_interactions SET suitecrm_synced_at=clock_timestamp() WHERE id=$1',[id(101)])
    await assert.rejects(()=>query("UPDATE crm_interactions SET reference_code='gi1234569' WHERE id=$1",[id(101)]),/Email inventory is pinned/)
    await assert.rejects(()=>query("UPDATE crm_interactions SET suitecrm_module='Notes' WHERE id=$1",[id(101)]),/Email inventory is pinned/)
    await assert.rejects(()=>query('UPDATE crm_interactions SET suitecrm_synced_at=NULL WHERE id=$1',[id(101)]),/Email inventory is pinned/)
    await assert.rejects(()=>query('DELETE FROM crm_interactions WHERE id=$1',[id(101)]),/Email inventory is pinned/)
    await assert.rejects(()=>query('TRUNCATE crm_interactions'),/Email inventory is pinned/)
    await assert.rejects(()=>query(`INSERT INTO crm_interactions(id,pipeline_id,suitecrm_id,reference_code,suitecrm_module,suitecrm_synced_at)
      VALUES($1,$2,$3,'gi1234569','Emails',now())`,[id(103),id(2),id(203)]),/Email inventory is pinned/)
    await query(`INSERT INTO crm_interactions(id,pipeline_id,suitecrm_id,reference_code,suitecrm_module,suitecrm_synced_at)
      VALUES($1,$2,$3,'gi1234569','Emails',NULL)`,[id(103),id(2),id(203)])
    await assert.rejects(()=>query('UPDATE crm_interactions SET suitecrm_synced_at=now() WHERE id=$1',[id(103)]),/Email inventory is pinned/)
    await query("UPDATE crm_interactions SET suitecrm_module='Notes',suitecrm_synced_at=now() WHERE id=$1",[id(103)])
    await query('DELETE FROM crm_interactions WHERE id=$1',[id(103)])
  })
  let firstClaim
  await check('unknown phase lease collision expiry takeover and stale-owner fencing never release authority',async()=>{
    firstClaim=await store.claimPhase(firstId,'revoke',id(501));assert.equal(firstClaim.action,'execute')
    await assert.rejects(()=>store.claimPhase(firstId,'revoke',id(502)),held('authority_lease_busy'))
    await store.markUnknown(firstId,'revoke',firstClaim.claim)
    assert.equal((await store.load(firstId)).revoke.state,'unknown')
    await new Promise(resolve=>setTimeout(resolve,2100))
    const taken=await longStore.claimPhase(firstId,'revoke',id(502));assert.equal(taken.action,'resolve');assert.equal(taken.claim.fence,2)
    await assert.rejects(()=>store.settlePhase(firstId,'revoke',firstClaim.claim,receipt(first,'revoke')),held('authority_lease_stale'))
    await assert.rejects(()=>store.markUnknown(firstId,'revoke',firstClaim.claim),held('authority_lease_stale'))
    assert.equal((await current()).active_transition_id,firstId)
    const wrong=receipt(first,'revoke');wrong.result.afterPolicyFingerprint=hash('wrong')
    await assert.rejects(()=>longStore.settlePhase(firstId,'revoke',taken.claim,wrong),held('authority_receipt_chain'))
    if(v2){
      const terminal=receipt(first,'revoke')
      const retain=tx=>tx.query(`UPDATE crm_native_email_authority_phases SET state='committed',native_receipt=$2::jsonb,receipt_hash=$3
        WHERE transition_id=$1 AND phase='revoke'`,[firstId,JSON.stringify(terminal),transition.nativeEmailAuthorityReceiptHash(terminal)])
      await assert.rejects(()=>transaction(retain),/not atomically settled/)
      await assert.rejects(()=>transaction(async tx=>{await retain(tx)
        const b=first.revoke.bindings[0].after
        await tx.query('UPDATE crm_native_email_capability_policies SET generation=$2,policy=$3::jsonb,fingerprint=$4 WHERE pipeline_id=$1',
          [b.pipeline_id,first.revoke.generationTo,b.capability_policy_json,hash('substituted-policy')])}),/differs from exact committed phase/)
      await assert.rejects(()=>transaction(async tx=>{await retain(tx)
        const b=first.revoke.bindings[0].after
        await tx.query('UPDATE crm_native_email_capability_policies SET generation=$2,policy=$3::jsonb,fingerprint=$4 WHERE pipeline_id=$1',
          [b.pipeline_id,first.revoke.generationTo,b.capability_policy_json,b.capability_policy_fingerprint])
        await tx.query('UPDATE crm_native_email_publication_control SET generation=$1,verified_generation=$1,native_policy_fingerprint=$2,activation_receipt_hash=$3',
          [first.revoke.generationTo,first.revoke.afterPolicyFingerprint,transition.nativeEmailAuthorityReceiptHash(terminal)])}),/postimages incomplete/)
      assert.equal((await store.load(firstId)).revoke.state,'unknown')
      failCommit=true;await assert.rejects(()=>longStore.settlePhase(firstId,'revoke',taken.claim,terminal),/synthetic commit failure/)
      for(const pair of first.revoke.bindings)assert.equal(Number((await query('SELECT generation FROM crm_native_email_capability_policies WHERE pipeline_id=$1',[pair.before.pipeline_id])).rows[0].generation),first.revoke.generationFrom)
    }
    await longStore.settlePhase(firstId,'revoke',taken.claim,receipt(first,'revoke'))
    firstClaim=taken;assert.equal(Number((await current()).generation),first.revoke.generationTo)
    if(v2)for(const pair of first.revoke.bindings){const row=(await query('SELECT * FROM crm_native_email_capability_policies WHERE pipeline_id=$1',[pair.after.pipeline_id])).rows[0]
      assert.equal(Number(row.generation),first.revoke.generationTo);assert.deepEqual(row.policy,JSON.parse(pair.after.capability_policy_json));assert.equal(row.fingerprint,pair.after.capability_policy_fingerprint)}
  })
  await check('app change and receipt commit atomically; rollback cannot leak membership and grant cannot precede proof',async()=>{
    const planHash=transition.prepareNativeEmailAuthorityTransition(first).planHash
    failCommit=true;await assert.rejects(()=>store.commitAppChange(firstId,planHash),/synthetic commit failure/)
    assert.equal((await query('SELECT count(*) FROM pipeline_space_members WHERE pipeline_id=$1',[id(2)])).rows[0].count,String(1+Number(userMode)))
    assert.equal((await store.load(firstId)).appCommit,null)
    const committed=await store.commitAppChange(firstId,planHash)
    assert.equal((await query('SELECT count(*) FROM pipeline_space_members WHERE pipeline_id=$1',[id(2)])).rows[0].count,String(Number(userMode)))
    assert.deepEqual((await store.commitAppChange(firstId,planHash)).appCommit,committed.appCommit)
    await assert.rejects(()=>store.claimPhase(firstId,'grant',id(503)),held('authority_phase_order'))
    const proof=await approve(first,'grant');assert.deepEqual(proof.proof.appCommit,committed.appCommit)
    const grant=await longStore.claimPhase(firstId,'grant',id(503));assert.equal(grant.action,'execute')
    await longStore.settlePhase(firstId,'grant',grant.claim,receipt(first,'grant'))
    assert.equal((await current()).active_transition_id,null);assert.equal((await store.load(firstId)).grant.state,'committed')
    await assert.rejects(()=>store.claimPhase(firstId,'grant',id(504)),held('authority_transition_not_active'))
    if(v2)for(const pair of first.grant.bindings){const row=(await query('SELECT * FROM crm_native_email_capability_policies WHERE pipeline_id=$1',[pair.after.pipeline_id])).rows[0]
      assert.equal(Number(row.generation),first.grant.generationTo);assert.deepEqual(row.policy,JSON.parse(pair.after.capability_policy_json))}
  })
  if(v2)await check('real committed authority ledger advances exact historical capabilities and rejects gaps wrong identity and invented future rights',async()=>{
    const b=first.revoke.bindings[0].before,a=first.grant.bindings[0].after,entry=first.revoke.capabilities[0]
    const pins={capabilityPolicyFingerprint:b.capability_policy_fingerprint,principalSuiteCrmUserIds:JSON.parse(b.capability_policy_json).principalSuiteCrmUserIds,
      expectedCapabilities:entry.before}
    const command={version:2,operationId:hash('synthetic-prior-publication'),mode:'publish',workspaceId:b.workspace_id,pipelineId:b.pipeline_id,
      generation:first.revoke.generationFrom,audienceFingerprint:b.audience_fingerprint,suiteCrmId:entry.emailId,globalId:entry.globalId,localId:id(101),
      expectedRecordFingerprint:hash('unchanged-native-content'),projection:{synthetic:'prior raw projection retained'},...pins}
    const request=protocol.prepareNativeEmailPublication({command,nativePolicyFingerprint:first.revoke.beforePolicyFingerprint,allowedReaderSuiteCrmUserIds:JSON.parse(b.readers_json)})
    const replay=(r=request,p=pins,g=first.grant.generationTo,policy=first.grant.afterPolicyFingerprint)=>
      transaction(tx=>publication.advanceNativeEmailPublicationCapabilities(tx,r,p,g,policy))
    const result=await replay()
    assert.equal(result.capabilityPolicyFingerprint,a.capability_policy_fingerprint)
    assert.deepEqual(result.expectedCapabilities,first.grant.capabilities[0].after)
    assert.deepEqual(result.expectedCapabilities.edit,[id(11)])
    assert.equal(request.command.expectedRecordFingerprint,hash('unchanged-native-content'))
    await assert.rejects(()=>replay({...request,command:{...request.command,globalId:'gi9999999'}}),held('native_authority_history_chain'))
    await assert.rejects(()=>replay(request,{...pins,expectedCapabilities:{...pins.expectedCapabilities,edit:[id(11),id(12)]}}),held('native_authority_history_chain'))
    await assert.rejects(()=>replay(request,pins,first.grant.generationTo+1),held('native_authority_history_incomplete'))
    await assert.rejects(()=>replay(request,pins,first.grant.generationTo,hash('wrong-policy')),held('native_authority_history_incomplete'))
  })
  await check('cancelled revoke records exact safe abort; stale generation and conflicting receipt cannot unlock',async()=>{
    const plan=await makePlan(true),tid=plan.revoke.transitionId;await store.admit(plan);await approve(plan,'revoke')
    await assert.rejects(()=>store.closeCancelledRevoke(tid),held('authority_abort_not_safe'))
    const claim=await longStore.claimPhase(tid,'revoke',id(505));const cancelled=receipt(plan,'revoke',true)
    await longStore.settlePhase(tid,'revoke',claim.claim,cancelled)
    await assert.rejects(()=>longStore.settlePhase(tid,'revoke',claim.claim,receipt(plan,'revoke')),held('authority_receipt_conflict'))
    await assert.rejects(()=>query('UPDATE crm_native_email_publication_control SET generation=generation+1,verified_generation=generation+1'),/exact committed phase receipt/)
    await store.closeCancelledRevoke(tid);await store.closeCancelledRevoke(tid)
    assert.equal((await current()).active_transition_id,null)
    assert.equal((await query('SELECT app_state FROM crm_native_email_authority_transitions WHERE transition_id=$1',[tid])).rows[0].app_state,'aborted')
    assert.equal((await query('SELECT count(*) FROM pipeline_space_members WHERE pipeline_id=$1',[id(2)])).rows[0].count,String(Number(userMode)))
  })
  await check('never-provisioned expired approval requires authenticated cancellation readback before exact resolve and abort',async()=>{
    const plan=await makePlan(true),tid=plan.revoke.transitionId;await store.admit(plan)
    const expiredIssuer=approval.createNativeEmailAuthorityApprovalIssuer(store,{...identity,privateKey:keys.privateKey,ttlSeconds:1})
    const envelope=await expiredIssuer.issue(tid,'revoke')
    await new Promise(resolve=>setTimeout(resolve,1100))
    assert.deepEqual(await expiredIssuer.issue(tid,'revoke'),envelope)
    await assert.rejects(()=>store.claimPhase(tid,'revoke',id(506)),held('authority_phase_not_claimable'))
    await assert.rejects(()=>store.settlePhase(tid,'revoke',{owner:id(506),fence:1},receipt(plan,'revoke',true)),held('authority_lease_stale'))
    await assert.rejects(()=>store.closeCancelledRevoke(tid),held('authority_abort_not_safe'))
    await assert.rejects(()=>query('UPDATE crm_native_email_publication_control SET active_transition_id=NULL'),/remains unresolved/)
    // Synthetic result of authenticated native cancel-expired: native atomically
    // retains this exact old proof and cancellation, never a refreshed approval.
    await store.recordApprovalReadback(tid,'revoke',{version:1,operationId:plan.revoke.operationId,
      transitionId:tid,phase:'revoke',commandHash:hash(plan.revoke),proofHash:hash(envelope.proof),appCommitFingerprint:null,replayed:false})
    const calls=[]
    const coordinator=transition.createNativeEmailAuthorityTransitionCoordinator(longStore,{
      execute:async()=>{throw Error('Expired command must never execute')},
      resolveOrCancel:async command=>{calls.push('resolve');assert.deepEqual(command,plan.revoke);return receipt(plan,'revoke',true)},
    },id(506))
    assert.deepEqual(await coordinator.step(tid),{state:'held',code:'authority_phase_cancelled'})
    assert.deepEqual(calls,['resolve']);assert.equal((await store.load(tid)).appCommit,null)
    assert.equal((await current()).active_transition_id,tid)
    assert.deepEqual(await expiredIssuer.issue(tid,'revoke'),envelope)
    await store.closeCancelledRevoke(tid)
  })
  await check('cancelled grant retains restrictive native authority and cannot use revoke safe-abort',async()=>{
    const plan=await makePlan(true),tid=plan.revoke.transitionId;await store.admit(plan);await approve(plan,'revoke')
    const revoke=await longStore.claimPhase(tid,'revoke',id(507));await longStore.settlePhase(tid,'revoke',revoke.claim,receipt(plan,'revoke'))
    await store.commitAppChange(tid,transition.prepareNativeEmailAuthorityTransition(plan).planHash);await approve(plan,'grant')
    const grant=await longStore.claimPhase(tid,'grant',id(508));await longStore.settlePhase(tid,'grant',grant.claim,receipt(plan,'grant',true))
    await assert.rejects(()=>store.closeCancelledRevoke(tid),held('authority_abort_not_safe'))
    assert.equal((await current()).active_transition_id,tid);assert.equal((await store.load(tid)).grant.state,'cancelled')
    assert.equal((await query('SELECT count(*) FROM pipeline_space_members WHERE pipeline_id=$1',[id(2)])).rows[0].count,String(1+Number(userMode)))
  })
  await check('cancelled grant retry appends exact immutable identity once under rollback and concurrent callers',async()=>{
    const tid=(await current()).active_transition_id,original=await store.load(tid),parent=original.plan.grant.operationId
    const nativePins=await current(),appCommit=clone(original.appCommit),plan=clone(original.plan)
    const outsider=new adapter.PostgresNativeEmailAuthorityTransitionStore(transaction,{...options,actorEmail:'outsider@example.test'})
    await assert.rejects(()=>outsider.retryCancelledGrant(tid,parent),held('authority_actor_changed'))
    await assert.rejects(()=>store.retryCancelledGrant(tid,hash('wrong-parent')),held('authority_grant_retry_stale'))
    failCommit=true
    await assert.rejects(()=>store.retryCancelledGrant(tid,parent),/synthetic commit failure/)
    assert.equal((await query('SELECT count(*) FROM crm_native_email_authority_grant_attempts')).rows[0].count,'0')
    // Original cancelled lease still live: retained cancellation, not a timeout,
    // proves the old operation cannot race a later executor.
    assert.equal((await query(`SELECT lease_until>clock_timestamp() AS live FROM crm_native_email_authority_phases
      WHERE transition_id=$1 AND phase='grant'`,[tid])).rows[0].live,true)
    const [a,b]=await Promise.all([store.retryCancelledGrant(tid,parent),store.retryCancelledGrant(tid,parent)])
    assert.deepEqual(a,b);assert.equal(a.grantAttempt.ordinal,1);assert.equal(a.grant.state,'prepared')
    const effective=transition.nativeEmailAuthorityPhaseCommand(a,'grant')
    assert.notEqual(effective.operationId,parent)
    assert.deepEqual({...effective,operationId:parent},original.plan.grant)
    assert.deepEqual(a.plan,plan);assert.deepEqual(a.appCommit,appCommit);assert.equal(a.grantApproval,null)
    assert.equal((await current()).generation,nativePins.generation)
    assert.equal((await current()).native_policy_fingerprint,nativePins.native_policy_fingerprint)
    assert.equal((await query('SELECT count(*) FROM crm_native_email_authority_grant_attempts')).rows[0].count,'1')
    assert.equal((await query(`SELECT state FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='grant'`,[tid])).rows[0].state,'cancelled')
    await assert.rejects(()=>query('DELETE FROM crm_native_email_authority_grant_attempts'),/evidence is retained/)
    await assert.rejects(()=>query('TRUNCATE crm_native_email_authority_grant_attempts'),/evidence is retained/)
    await assert.rejects(()=>query("UPDATE crm_native_email_authority_grant_attempts SET grant_attempt=jsonb_set(grant_attempt,'{ordinal}','2')"),/immutable/)
    await assert.rejects(()=>query('UPDATE crm_native_email_publication_control SET active_transition_id=NULL'),/remains unresolved/)
    await assert.rejects(()=>store.settlePhase(tid,'grant',{owner:id(508),fence:1},receipt(original.plan,'grant',true)),held())
  })
  await check('retry requires settled cancellation, preserves approval and receipt lineage, then atomically grants through effective phase',async()=>{
    const tid=(await current()).active_transition_id,firstRetry=await store.load(tid)
    const first=await approveEffective(tid)
    assert.equal(first.envelope.proof.version,2)
    assert.deepEqual(first.envelope.proof.grantAttempt,firstRetry.grantAttempt)
    const claim=await longStore.claimPhase(tid,'grant',id(509))
    await longStore.markUnknown(tid,'grant',claim.claim)
    await assert.rejects(()=>store.retryCancelledGrant(tid,first.command.operationId),held('authority_grant_retry_not_cancelled'))
    await longStore.settlePhase(tid,'grant',claim.claim,receipt({grant:first.command},'grant',true))
    const retry=await store.retryCancelledGrant(tid,first.command.operationId)
    assert.equal(retry.grantAttempt.ordinal,2)
    assert.equal(retry.grantAttempt.previousOperationId,first.command.operationId)
    assert.equal(retry.grantAttempt.previousCancellationReceiptHash,
      transition.nativeEmailAuthorityReceiptHash(receipt({grant:first.command},'grant',true)))
    await assert.rejects(()=>store.retryCancelledGrant(tid,retry.plan.grant.operationId),held('authority_grant_retry_stale'))
    const second=await approveEffective(tid),done=await longStore.claimPhase(tid,'grant',id(510))
    const finalReceipt=receipt({grant:second.command},'grant')
    await longStore.settlePhase(tid,'grant',done.claim,finalReceipt)
    assert.equal((await current()).active_transition_id,null)
    assert.equal((await current()).generation,String(second.command.generationTo))
    const final=await store.load(tid)
    assert.equal(final.grant.state,'committed');assert.equal(final.grantAttempt.ordinal,2)
    assert.deepEqual(final.plan,firstRetry.plan);assert.deepEqual(final.appCommit,firstRetry.appCommit)
    assert.deepEqual(await store.retryCancelledGrant(tid,first.command.operationId),final)
    assert.deepEqual(await longStore.settlePhase(tid,'grant',done.claim,finalReceipt),final)
    const phases=(await query(`SELECT phase,state,operation_id,grant_attempt FROM crm_native_email_effective_authority_phases
      WHERE transition_id=$1 ORDER BY phase`,[tid])).rows
    assert.equal(phases.length,2);assert.equal(phases[0].operation_id,second.command.operationId)
    assert.equal(phases[0].grant_attempt.ordinal,2);assert.equal(phases[1].grant_attempt,null)
    assert.deepEqual((await query(`SELECT ordinal,state FROM crm_native_email_authority_grant_attempts
      WHERE transition_id=$1 ORDER BY ordinal`,[tid])).rows,[{ordinal:1,state:'cancelled'},{ordinal:2,state:'committed'}])
    await assert.rejects(()=>query("UPDATE crm_native_email_authority_grant_attempts SET state='prepared' WHERE transition_id=$1 AND ordinal=2",[tid]),/immutable/)
    if(v2)assert.ok((await query('SELECT generation FROM crm_native_email_capability_policies')).rows.every(row=>Number(row.generation)===second.command.generationTo))
    if(v2)await check('publication history follows committed retry and rejects retained cancelled original grant',async()=>{
      const b=final.plan.revoke.bindings[0].before,a=second.command.bindings[0].after,entry=final.plan.revoke.capabilities[0]
      const pins={capabilityPolicyFingerprint:b.capability_policy_fingerprint,
        principalSuiteCrmUserIds:JSON.parse(b.capability_policy_json).principalSuiteCrmUserIds,expectedCapabilities:entry.before}
      const command={version:2,operationId:hash('synthetic-prior-publication-before-retry'),mode:'publish',
        workspaceId:b.workspace_id,pipelineId:b.pipeline_id,generation:final.plan.revoke.generationFrom,
        audienceFingerprint:b.audience_fingerprint,suiteCrmId:entry.emailId,globalId:entry.globalId,localId:id(101),
        expectedRecordFingerprint:hash('retry-preserves-native-content'),projection:{synthetic:'unchanged prior projection'},...pins}
      const request=protocol.prepareNativeEmailPublication({command,nativePolicyFingerprint:final.plan.revoke.beforePolicyFingerprint,
        allowedReaderSuiteCrmUserIds:JSON.parse(b.readers_json)})
      const replay=tx=>publication.advanceNativeEmailPublicationCapabilities(tx,request,pins,
        second.command.generationTo,second.command.afterPolicyFingerprint)
      const result=await transaction(replay)
      assert.equal(result.capabilityPolicyFingerprint,a.capability_policy_fingerprint)
      assert.deepEqual(result.expectedCapabilities,second.command.capabilities[0].after)
      assert.deepEqual(result.expectedCapabilities.view,[id(11),id(12)])
      assert.deepEqual(result.expectedCapabilities.edit,[id(11)])
      assert.equal(request.command.expectedRecordFingerprint,hash('retry-preserves-native-content'))
      // Exercise actual retained base SQL rows rather than inventing a fake
      // receipt. A legacy phase reader finds no committed grant at this point.
      await assert.rejects(()=>transaction(tx=>replay({query:(sql,values)=>tx.query(sql
        .replaceAll('crm_native_email_effective_authority_phases','crm_native_email_authority_phases')
        .replace('g.grant_attempt','NULL::jsonb AS grant_attempt'),values)})),held('native_authority_history_incomplete'))
      // Even if an upstream query erroneously selects the old cancelled row,
      // the real history verifier rejects that retained cancellation as proof.
      await assert.rejects(()=>transaction(tx=>replay({query:(sql,values)=>tx.query(sql
        .replaceAll('crm_native_email_effective_authority_phases','crm_native_email_authority_phases')
        .replace('g.grant_attempt','NULL::jsonb AS grant_attempt')
        .replace("g.state='committed'","g.state='cancelled'"),values)})),held('native_authority_history_receipt'))
    })
  })
  if(v2){const {runMemberRoleAcceptance}=await import('./test-native-email-member-role-postgres.mjs')
    await runMemberRoleAcceptance({load,protocol,eligibility,userEligibility,audience,transition,adapter,approval,
      query,transaction,store,options,keys,current,id,hash,clone,held,check,receipt})}
  if(userMode){const {runUserEligibilityAcceptance}=await import('./test-native-email-user-eligibility-postgres.mjs')
    const context={load,protocol,eligibility,userEligibility,audience,transition,adapter,approval,
      query,transaction,store,options,keys,current,id,hash,clone,held,check,receipt}
    const inspection=await runUserEligibilityAcceptance(context)
    const {runAppOnlySharingAcceptance}=await import('./test-native-email-app-only-sharing-postgres.mjs')
    await runAppOnlySharingAcceptance({...context,inspection})}
  if(ownerMode)assert.equal((await query('SELECT role FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',
    [options.actorEmail,id(1)])).rows[0].role,ownerMode,'Sharing must never promote the resource owner to workspace owner')
  console.log(`PASS ${checks.length} checks: actual PostgreSQL authorization/ledger/RSA issuer, synthetic native approvals/receipts; no live/deployment proof`)
}finally{try{if(pool)await pool.end()}finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})}}
