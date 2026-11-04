#!/usr/bin/env node
// Actual users.ts employee function, owner query, migrations and PostgreSQL.
// Synthetic users/activation receipt; no native/provider/browser/deployment proof.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),{Pool}=require('pg')
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
function load(path,deps){const module={exports:{}}
  const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]})
  return module.exports}
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const owner='owner@example.test',member='member@example.test',plain='plain@example.test',workspace=id(1),foreign=id(2),pipeline=id(3)
const newWorkspace=id(90),newPipeline=id(92),demoWorkspace=id(91),unsharedWorkspace=id(93)
const migration=read('db/migrations/0385_crm_employee_identity_retention.sql')
assert.doesNotMatch(migration,/DISABLE TRIGGER|UPDATE app_users|UPDATE crm_reference_registry|DELETE FROM|INSERT INTO/i)
const enrollmentMigration=read('db/migrations/0391_crm_native_email_unshared_workspace_enrollment.sql')
const guardBody=sql=>sql.match(/CREATE OR REPLACE FUNCTION clawpilot_native_email_authority_row_guard\(\)[\s\S]*?BEGIN([\s\S]*?)END \$\$;/)?.[1]
assert.ok(guardBody(enrollmentMigration));assert.ok(guardBody(read('db/migrations/0383_crm_native_email_user_eligibility.sql')))
assert.equal(guardBody(enrollmentMigration).replace(/OR public\.clawpilot_native_email_unshared_workspace_is_independent\(TG_TABLE_NAME,old_row,new_row\)/,'').replace(/\s+/g,''),
  guardBody(read('db/migrations/0383_crm_native_email_user_eligibility.sql')).replace(/\s+/g,''),
  'Enrollment must not alter any other exact-transition guard branch or policy-generation rule')
const container=`clawpilot-employee-${process.pid}-${randomUUID().slice(0,8)}`
let pool,started=false,count=0,lastPid,transactionOrdinal=0,pauseOwnerCount=null,failAudit=false
let inspectIdentity=async()=>({verified:true})
async function check(name,run){await run();count++;console.log('PASS '+name)}
try{
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--pull','never','--name',container,
    '-e','POSTGRES_PASSWORD=employee_fixture','-e','POSTGRES_DB=employee_fixture','-p','127.0.0.1::5432','pgvector/pgvector:pg16']),{stdio:'pipe',timeout:60000});started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8'}).match(/^127\.0\.0\.1:(\d+)\s*$/)?.[1];assert.ok(port)
  pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'employee_fixture',database:'employee_fixture',ssl:false,
    max:6,connectionTimeoutMillis:1000,statement_timeout:8000})
  const deadline=Date.now()+30000
  while(true){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>=deadline)throw error;await new Promise(r=>setTimeout(r,100))}}
  const query=(sql,values)=>pool.query(sql,values)
  const transaction=async fn=>{const tx=await pool.connect();lastPid=tx.processID;transactionOrdinal++
    try{await tx.query('BEGIN');const wrapped={query:async(sql,values)=>{
      const result=await tx.query(sql,values)
      if(pauseOwnerCount&&sql.includes('FROM crm_contacts')&&sql.includes('count(*)')){
        const pause=pauseOwnerCount;pauseOwnerCount=null;pause.reached();await pause.release
      }
      return result
    }};const result=await fn(wrapped);await tx.query('COMMIT');return result}
    catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}}
  await query(`CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,parent_id uuid,name text,is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE crm_reference_registry(reference_code text PRIMARY KEY,status text DEFAULT 'active',retired_at timestamptz);
    CREATE SEQUENCE employee_reference_seq START 7654321;
    CREATE FUNCTION allocate_crm_reference(prefix text) RETURNS text LANGUAGE plpgsql AS $$
      DECLARE reference text:=prefix||nextval('employee_reference_seq')::text;
      BEGIN INSERT INTO crm_reference_registry(reference_code) VALUES(reference);RETURN reference;END $$;
    CREATE TABLE app_users(email text PRIMARY KEY,status text DEFAULT 'active',role text DEFAULT 'member',permissions jsonb DEFAULT '{}',
      organization_id uuid,reference_code text UNIQUE REFERENCES crm_reference_registry(reference_code),contact_reference_code text,
      crm_user_enabled boolean NOT NULL DEFAULT false,suitecrm_user_id text,suitecrm_username text,display_name text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text DEFAULT 'active',role text DEFAULT 'member',
      permissions jsonb DEFAULT '{}',trashed_at timestamptz,trashed_by text,pre_trash_status text,is_default boolean DEFAULT false,
      created_by text,updated_by text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(user_email,organization_id));
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,shared_by text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,suitecrm_module text,suitecrm_synced_at timestamptz);
    CREATE TABLE crm_contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_reference_code text REFERENCES crm_reference_registry(reference_code));
    CREATE TABLE sync_outbox(target_system text,operation text,status text,aggregate_type text,aggregate_id text,payload jsonb,
      attempts integer,idempotency_key text,created_at timestamptz,available_at timestamptz,updated_at timestamptz,processed_at timestamptz,last_error text);
    CREATE UNIQUE INDEX employee_outbox_key ON sync_outbox(target_system,idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE employee_audit(payload jsonb);
    INSERT INTO workspace_organizations(id,name) VALUES('${workspace}','A'),('${foreign}','B');
    INSERT INTO crm_reference_registry(reference_code) VALUES('gu1234567'),('gu0123456789av');
    INSERT INTO app_users(email,role,organization_id,crm_user_enabled,reference_code,suitecrm_user_id,suitecrm_username)
      VALUES('${owner}','owner','${workspace}',true,'gu1234567','${id(11)}','gu1234567'),
        ('${member}','member','${workspace}',true,'gu0123456789av','${id(12)}','gu0123456789av');
    INSERT INTO app_users(email,organization_id) VALUES('${plain}','${workspace}'),('admin@example.test','${workspace}');
    INSERT INTO app_user_organization_memberships(user_email,organization_id,role) SELECT email,organization_id,role FROM app_users;
    INSERT INTO app_user_organization_memberships(user_email,organization_id,role) VALUES('${member}','${foreign}','member');
    INSERT INTO pipeline_spaces VALUES('${pipeline}','${owner}','${workspace}',false);
    INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES('${pipeline}','${member}','editor','${owner}');
    INSERT INTO workspace_organizations(id,parent_id,name,is_demo) VALUES
      ('${newWorkspace}','${workspace}','Another operator workspace',false),('${demoWorkspace}',NULL,'Demo',true),
      ('${unsharedWorkspace}','${workspace}','Unenrolled child',false);
    INSERT INTO app_user_organization_memberships(user_email,organization_id,role) VALUES('${owner}','${newWorkspace}','owner');
    INSERT INTO pipeline_spaces VALUES('${newPipeline}','${owner}','${newWorkspace}',false);`)
  // Reproduce the actual pre-0385 checks, with the exact legacy-to-alphanumeric
  // replacement applied by 0203, rather than a permissive fixture substitute.
  for(const [file,name] of [['0056_crm_employee_identity_and_workbook_dashboard.sql','app_users_crm_employee_identity_complete'],
    ['0057_canonical_suitecrm_usernames.sql','app_users_suitecrm_identity_canonical']]){
    const clause=read('db/migrations/'+file).match(new RegExp('ADD CONSTRAINT '+name+' CHECK \\([\\s\\S]*?\\n  \\);'))?.[0];assert.ok(clause)
    await query('ALTER TABLE app_users '+clause.replaceAll('[0-9]{7}','([0-9]{7}|[0-9a-v]{12})'))
  }
  const core=read('db/migrations/0202_global_id_alphanumeric_compatibility_core.sql')
  for(const name of ['global_reference_prefix_is_valid','global_reference_code_is_valid']){
    const definition=core.match(new RegExp('CREATE OR REPLACE FUNCTION '+name+'\\([\\s\\S]*?\\$\\$;'))?.[0];assert.ok(definition);await query(definition)
  }
  for(const file of ['0375_crm_native_email_publication_admission.sql','0376_crm_native_email_publication_work_context.sql',
    '0377_crm_native_email_authority_transitions.sql','0378_crm_native_email_capability_policies.sql','0379_crm_native_email_app_only_lifecycle.sql',
    '0380_crm_native_email_grant_attempts.sql','0381_crm_native_email_identity_quiescence.sql','0382_crm_native_email_mapped_settings.sql',
    '0383_crm_native_email_user_eligibility.sql','0384_crm_native_email_member_role_changes.sql'])await transaction(tx=>tx.query(read('db/migrations/'+file)))
  const beforeMigration=(await query('SELECT * FROM app_users ORDER BY email')).rows
  await transaction(tx=>tx.query(migration))
  await transaction(tx=>tx.query(read('db/migrations/0386_crm_native_email_first_access_grants.sql')))
  await transaction(tx=>tx.query(read('db/migrations/0387_crm_native_email_shared_app_only_lifecycle.sql')))
  assert.deepEqual((await query('SELECT * FROM app_users ORDER BY email')).rows,beforeMigration,'Migration may not rewrite any historical identity')
  const persistence={query,withTransaction:transaction}
  class IdentityPending extends Error{status=409;code='CRM_ACCESS_CHANGE_PENDING';transitionId=null}
  let nativeLinkCalls=0
  const users=load('app_src/lib/users.ts',{'@/lib/persistence/postgres':persistence,
    '@/lib/persistence/crmNativeEmailAuthority':load('app_src/lib/persistence/crmNativeEmailAuthority.ts',{}),
    '@/lib/crm/nativeEmailWorkspaceUserRuntime':{linkExistingUserWithNativeAuthority:async(actorEmail,selection,actorWorkspaceId)=>{
      nativeLinkCalls++;assert.equal(actorEmail,owner);assert.equal(actorWorkspaceId,workspace);assert.equal(selection.workspaceId,workspace)
      assert.equal(selection.nativeIdentity.username,selection.nativeIdentity.globalId);throw new IdentityPending()
    }},'@/lib/invitationWorkspaceScope':{},'@/lib/demoMode':{DEMO_WORKSPACE_ID:id(99)},
    '@/lib/crm/suiteCrmClient':{findSuiteCrmUser:async({globalId})=>({id:id(13),globalId}),inspectSuiteCrmUserIdentity:async record=>inspectIdentity(record)},'@/lib/auditWriter':{recordAuditEvent:async(event,tx)=>{
      await tx.query('INSERT INTO employee_audit(payload) VALUES($1::jsonb)',[JSON.stringify(event)])
      if(failAudit)throw Error('synthetic audit failure')
    }}})
  const actor={email:owner,role:'owner',status:'active',permissions:users.OWNER_PERMISSIONS,organizationId:workspace}
  const toggle=(enabled,email=member,extra={})=>users.updateAppUserCrmEmployee({actorEmail:actor,email,organizationId:workspace,enabled,...extra})
  const sync=()=>users.syncAppUserSuiteCrmIdentity({actorEmail:actor,email:member,organizationId:workspace})
  const snapshot=async()=>({users:(await query("SELECT to_jsonb(u)-'crm_user_enabled'-'updated_at' AS u FROM app_users u ORDER BY email")).rows,
    members:(await query('SELECT * FROM app_user_organization_memberships ORDER BY user_email,organization_id')).rows,
    pipelines:(await query('SELECT * FROM pipeline_space_members ORDER BY pipeline_id,user_email')).rows,
    registry:(await query('SELECT * FROM crm_reference_registry ORDER BY reference_code')).rows,
    control:(await query('SELECT * FROM crm_native_email_publication_control')).rows})
  await check('admin access revoked during provider read wins over stale session permission',async()=>{
    // Exercise a legal disabled-policy authority mutation, not a direct SQL
    // bypass of the enabled native-first guard.
    const before=(await query('SELECT * FROM app_users ORDER BY email')).rows
    inspectIdentity=async()=>{await query("UPDATE app_user_organization_memberships SET trashed_at=now() WHERE user_email=$1 AND organization_id=$2",[owner,workspace]);return {verified:true}}
    try{await assert.rejects(sync(),/permission|active/)}finally{
      inspectIdentity=async()=>({verified:true})
      await query('UPDATE app_user_organization_memberships SET trashed_at=NULL WHERE user_email=$1 AND organization_id=$2',[owner,workspace])
    }
    assert.deepEqual((await query('SELECT * FROM app_users ORDER BY email')).rows,before)
    assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'0')
  })
  await check('identity changed during provider read rejects stale mapping rather than overwriting it',async()=>{
    inspectIdentity=async()=>{await query('UPDATE app_users SET suitecrm_user_id=$2 WHERE email=$1',[member,id(13)]);return {verified:true}}
    try{await assert.rejects(sync(),error=>error instanceof users.AppUserIdentitySyncConflictError)}finally{
      inspectIdentity=async()=>({verified:true});await query('UPDATE app_users SET suitecrm_user_id=$2 WHERE email=$1',[member,id(12)])
    }
    assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'0')
  })
  await check('disabled-policy legacy repair queues the exact identity while activation still refuses unfinished work',async()=>{
    const before=(await query('SELECT * FROM app_users ORDER BY email')).rows
    inspectIdentity=async()=>({verified:false})
    try{assert.equal((await sync()).identitySync,'queued')}finally{inspectIdentity=async()=>({verified:true})}
    const rows=(await query('SELECT * FROM sync_outbox')).rows;assert.equal(rows.length,1)
    assert.equal(rows[0].operation,'upsert_user_identity');assert.equal(rows[0].status,'queued')
    assert.deepEqual(rows[0].payload,{localId:member,suiteCrmUserId:id(12),referenceCode:'gu0123456789av',username:'gu0123456789av'})
    assert.deepEqual((await query('SELECT * FROM app_users ORDER BY email')).rows,before)
    await assert.rejects(query("UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,native_policy_fingerprint=$1,activation_receipt_hash=$2",['1'.repeat(64),'2'.repeat(64)]),error=>error.code==='55000')
    // Reset only this disposable fixture row. This is not worker completion,
    // permission activation proof, or a prescription for production cleanup.
    await query('DELETE FROM sync_outbox WHERE idempotency_key=$1',[rows[0].idempotency_key])
  })
  for(const enabled of [false,true])await check(`actual employee off/on preserves permanent identity and all authority with native policy ${enabled?'enabled':'disabled'}`,async()=>{
    await query(`UPDATE crm_native_email_publication_control SET enabled=$1,verified_generation=generation,native_policy_fingerprint=$2,activation_receipt_hash=$3`,[enabled,'1'.repeat(64),'2'.repeat(64)])
    const before=await snapshot(),auditCount=(await query('SELECT count(*) FROM employee_audit')).rows[0].count
    const off=await toggle(false);assert.equal(off.crmUserEnabled,false);assert.equal(off.referenceCode,'gu0123456789av');assert.equal(off.suiteCrmUserId,id(12))
    const on=await toggle(true);assert.equal(on.crmUserEnabled,true);assert.equal(on.referenceCode,off.referenceCode);assert.equal(on.suiteCrmUsername,on.referenceCode)
    assert.deepEqual(await snapshot(),before)
    const saved=(await query('SELECT * FROM app_users WHERE email=$1',[member])).rows[0]
    await toggle(true);assert.deepEqual((await query('SELECT * FROM app_users WHERE email=$1',[member])).rows[0],saved,'No-op must not even change update time')
    assert.equal(Number((await query('SELECT count(*) FROM employee_audit')).rows[0].count),Number(auditCount)+2)
    const identityBefore=(await query('SELECT * FROM app_users ORDER BY email')).rows
    const auditBefore=(await query('SELECT * FROM employee_audit')).rows
    for(let n=0;n<2;n++)assert.equal((await sync()).identitySync,'verified')
    assert.deepEqual((await query('SELECT * FROM app_users ORDER BY email')).rows,identityBefore,'Canonical sync must not even resave the local User')
    assert.deepEqual((await query('SELECT * FROM employee_audit')).rows,auditBefore)
    assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'0','Verification is not a queued identity write')
    if(!enabled)await check('activation during provider read cannot queue a now-protected native identity repair',async()=>{
      inspectIdentity=async()=>{
        await query("UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,native_policy_fingerprint=$1,activation_receipt_hash=$2",['1'.repeat(64),'2'.repeat(64)])
        return {verified:false}
      }
      try{await assert.rejects(sync(),error=>error instanceof users.AppUserIdentitySyncConflictError)}finally{inspectIdentity=async()=>({verified:true})}
      assert.deepEqual((await query('SELECT * FROM app_users ORDER BY email')).rows,identityBefore)
      assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'0')
    })
  })
  await check('real users PATCH returns retained identity without automatically resaving the mapped native user',async()=>{
    class Pending extends Error{}
    const route=load('app_src/app/api/users/route.ts',{'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200})}},
      '@/lib/authSessions':{},'@/lib/invitations':{},'@/lib/organizations':{},'@/lib/tenancy':{},'@/lib/persistence/crm':{},
      '@/lib/requestUser':{requireRequestUser:async()=>actor},'@/lib/crm/nativeEmailAuthorityRuntime':{NativeEmailAccessPendingError:Pending},
      '@/lib/crm/nativeEmailWorkspaceUserRecovery':{},'@/lib/users':users})
    const before=await snapshot()
    for(const enabled of [false,true]){
      const response=await route.PATCH({json:async()=>({action:'crm-employee',email:member,organizationId:workspace,enabled})})
      assert.equal(response.status,200);assert.equal(response.body.user.crmUserEnabled,enabled)
      assert.equal(response.body.user.referenceCode,'gu0123456789av');assert.equal(response.body.crmIdentitySync,'retained')
      assert.equal(response.body.warning,undefined,'Retained mapped identity must not enter optional native sync or emit a false pending warning')
    }
    const verified=await route.PATCH({json:async()=>({action:'crm-user-sync',email:member,organizationId:workspace})})
    assert.equal(verified.status,200);assert.equal(verified.body.crmIdentitySync,'verified')
    inspectIdentity=async()=>({verified:false})
    try{
      const held=await route.PATCH({json:async()=>({action:'crm-user-sync',email:member,organizationId:workspace})})
      assert.equal(held.status,409);assert.equal(held.body.code,'CRM_IDENTITY_SYNC_CONFLICT')
      assert.match(held.body.error,/No identity change was queued/);assert.equal(held.body.user,undefined)
      assert.equal(held.body.transitionId,undefined,'Do not invent a resumable native transition for a held identity action')
    }finally{inspectIdentity=async()=>({verified:true})}
    assert.deepEqual(await snapshot(),before);assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'0')
  })
  await check('provider identity inspection never holds PostgreSQL authority or user locks',async()=>{
    inspectIdentity=async()=>{
      const tx=await pool.connect()
      try{
        await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='500ms'")
        await tx.query('SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE NOWAIT')
        await tx.query('SELECT email FROM app_users WHERE email=ANY($1::text[]) ORDER BY email FOR UPDATE NOWAIT',[[owner,member].sort()])
        return {verified:true}
      }finally{await tx.query('ROLLBACK');tx.release()}
    }
    try{assert.equal((await sync()).identitySync,'verified')}finally{inspectIdentity=async()=>({verified:true})}
  })
  await check('employee removed during provider read cannot publish stale verification or queue work',async()=>{
    inspectIdentity=async()=>{await toggle(false);return {verified:true}}
    try{await assert.rejects(sync(),/Configure this user/)}finally{inspectIdentity=async()=>({verified:true});await toggle(true)}
    assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'0')
  })
  await check('first employee allocation is reused across off/on without retiring or resurrecting registry entries',async()=>{
    const initial=await toggle(true,plain);assert.match(initial.referenceCode,/^gu[0-9]{7}$/);assert.equal(initial.suiteCrmUserId,null)
    await toggle(false,plain);assert.equal((await toggle(true,plain)).referenceCode,initial.referenceCode)
    let providerCalls=0;inspectIdentity=async()=>{providerCalls++;return {verified:true}}
    const previousLinks=nativeLinkCalls
    try{await assert.rejects(users.syncAppUserSuiteCrmIdentity({actorEmail:actor,email:plain,organizationId:workspace}),error=>error instanceof IdentityPending)}finally{inspectIdentity=async()=>({verified:true})}
    assert.equal(providerCalls,1,'First link may inspect an existing native account, never rename or create it')
    assert.equal(nativeLinkCalls,previousLinks+1,'Protected first link must enter the dedicated exact native-first coordinator')
    assert.equal((await query('SELECT suitecrm_user_id FROM app_users WHERE email=$1',[plain])).rows[0].suitecrm_user_id,null)
    assert.equal((await query('SELECT status FROM crm_reference_registry WHERE reference_code=$1',[initial.referenceCode])).rows[0].status,'active')
    assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'0','Eligibility toggle must not dispatch native identity work')
  })
  await check('issued identity cannot be cleared replaced or paired with an incomplete native username',async()=>{
    for(const sql of ["UPDATE app_users SET reference_code=NULL WHERE email=$1", "UPDATE app_users SET reference_code='gu7654322' WHERE email=$1",
      'UPDATE app_users SET suitecrm_username=NULL WHERE email=$1',"UPDATE app_users SET suitecrm_username='other' WHERE email=$1"])
      await assert.rejects(query(sql,[member]),error=>error.code==='23514')
    await assert.rejects(query('UPDATE app_users SET suitecrm_user_id=NULL WHERE email=$1',[member]),error=>error.code==='23514')
    await assert.rejects(query('UPDATE app_users SET suitecrm_user_id=NULL,suitecrm_username=NULL WHERE email=$1',[member]),error=>error.code==='55000')
  })
  await check('current actor access organization and owner restrictions win over stale or forged DTO hints',async()=>{
    const before=await snapshot()
    await assert.rejects(toggle(false,owner),/owner must remain/)
    await assert.rejects(toggle(false,member,{organizationId:foreign}),/outside/)
    await assert.rejects(toggle(false,member,{actorEmail:{...actor,email:'admin@example.test'}}),/permission/)
    assert.deepEqual(await snapshot(),before)
  })
  await check('owned contacts still require reassignment and failed audit rolls every local write back',async()=>{
    await query('INSERT INTO crm_contacts(owner_user_reference_code) VALUES($1)',['gu0123456789av'])
    await assert.rejects(toggle(false),/Reassign 1 CRM Contact/)
    await query('DELETE FROM crm_contacts WHERE owner_user_reference_code=$1',['gu0123456789av'])
    const before=(await query('SELECT * FROM app_users ORDER BY email')).rows,audits=(await query('SELECT * FROM employee_audit')).rows
    failAudit=true;try{await assert.rejects(toggle(false),/audit failure/)}finally{failAudit=false}
    assert.deepEqual((await query('SELECT * FROM app_users ORDER BY email')).rows,before)
    assert.deepEqual((await query('SELECT * FROM employee_audit')).rows,audits)
  })
  // Invoke the real owner lookup, including its new FOR SHARE, not copied SQL.
  const crm=ts.createSourceFile('crm.ts',read('app_src/lib/persistence/crm.ts'),ts.ScriptTarget.Latest,true)
  const pieces=['clean','nullable','activeCrmContactOwners'].map(name=>{const node=crm.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node);return node.getText(crm)})
  const ownerCode=ts.transpileModule(pieces.join('\n')+'\nmodule.exports=activeCrmContactOwners',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const ownerModule={exports:{}};new Function('module',ownerCode)(ownerModule);const owners=ownerModule.exports
  const waitBlocked=async(waiting,blocking)=>{for(let n=0;n<200;n++){
    if((await query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[waiting,blocking])).rows[0].blocked)return
    await new Promise(r=>setTimeout(r,10))
  }assert.fail('Expected exact owner/toggle lock contention')}
  await check('in-flight contact owner assignment prevents employee removal until committed contact is checked',async()=>{
    const tx=await pool.connect();await tx.query('BEGIN')
    try{
      assert.equal((await owners(tx,{pipelineId:pipeline,referenceCode:'gu0123456789av'})).length,1)
      const ordinal=transactionOrdinal,pending=toggle(false).then(value=>({value}),error=>({error}))
      for(let n=0;transactionOrdinal===ordinal&&n<200;n++)await new Promise(r=>setTimeout(r,10))
      assert.ok(transactionOrdinal>ordinal,'Actual toggle transaction must start before lock inspection')
      await waitBlocked(lastPid,tx.processID)
      await tx.query("INSERT INTO crm_contacts(owner_user_reference_code) VALUES('gu0123456789av')");await tx.query('COMMIT')
      assert.match(String((await pending).error),/Reassign 1 CRM Contact/)
    }finally{await tx.query('ROLLBACK');tx.release()}
    await query("DELETE FROM crm_contacts WHERE owner_user_reference_code='gu0123456789av'")
  })
  await check('employee removal committed first makes a waiting owner lookup recheck eligibility and refuse the disabled assignee',async()=>{
    let reached,release;const atCount=new Promise(r=>{reached=r}),continueToggle=new Promise(r=>{release=r})
    pauseOwnerCount={reached,release:continueToggle};const pending=toggle(false).then(value=>({value}),error=>({error}))
    await Promise.race([atCount,pending.then(result=>{throw result.error??Error('Toggle did not pause at owner count')})])
    const togglePid=lastPid,tx=await pool.connect();await tx.query('BEGIN')
    try{
      const lookup=owners(tx,{pipelineId:pipeline,referenceCode:'gu0123456789av'}).then(value=>({value}),error=>({error}))
      await waitBlocked(tx.processID,togglePid);release();assert.equal((await pending).value.crmUserEnabled,false)
      const result=await lookup;assert.ifError(result.error);assert.equal(result.value.length,0)
    }finally{release();await tx.query('ROLLBACK');tx.release()}
    await toggle(true)
  })
  const addScope=()=>users.addAppUserOrganizationMemberships({actorEmail:actor,email:member,organizationIds:[newWorkspace]})
  const audienceIds=async()=> (await query(`SELECT p.id::text,u.suitecrm_user_id FROM pipeline_spaces p
    JOIN app_users u ON u.email=p.owner_email OR EXISTS(SELECT 1 FROM pipeline_space_members pm
      WHERE pm.pipeline_id=p.id AND pm.user_email=u.email)
    JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=p.workspace_organization_id
    WHERE u.status='active' AND m.status='active' AND m.trashed_at IS NULL
      AND (m.role='owner' OR COALESCE(m.permissions->>'viewCrm','true')='true') ORDER BY p.id,u.email`)).rows
  await check('reproduces mapped user organization addition being blocked before the new migration',async()=>{
    await assert.rejects(addScope(),error=>error.code==='55000'&&/native-first/.test(error.message))
    assert.equal((await query('SELECT count(*) FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[member,newWorkspace])).rows[0].count,'0')
  })
  const beforeEnrollment=await snapshot(),audienceBeforeEnrollment=await audienceIds()
  await transaction(tx=>tx.query(enrollmentMigration))
  await check('migration leaves all users, membership intent, native pins and known audiences unchanged',async()=>{
    assert.deepEqual(await snapshot(),beforeEnrollment);assert.deepEqual(await audienceIds(),audienceBeforeEnrollment)
  })
  await check('actual owner workflow adds mapped member to an unshared workspace without granting a pipeline or private board',async()=>{
    const before=await query('SELECT * FROM pipeline_space_members ORDER BY pipeline_id,user_email')
    const result=await addScope()
    assert.deepEqual(result.addedOrganizationIds,[newWorkspace]);assert.equal(result.user.organizationId,newWorkspace)
    assert.equal(result.user.organizationRole,'member');assert.equal(result.user.suiteCrmUserId,id(12))
    assert.deepEqual((await query('SELECT * FROM pipeline_space_members ORDER BY pipeline_id,user_email')).rows,before.rows)
    assert.deepEqual(await audienceIds(),audienceBeforeEnrollment)
    assert.deepEqual((await query('SELECT * FROM crm_native_email_publication_control')).rows,beforeEnrollment.control)
    const audits=(await query("SELECT payload FROM employee_audit WHERE payload->>'eventType'='user.organizations.added'")).rows
    assert.equal(audits.length,1);assert.deepEqual(audits[0].payload.payload.organizationIds,[newWorkspace])
    await assert.rejects(addScope(),/already has access/)
    assert.equal((await query("SELECT count(*) FROM employee_audit WHERE payload->>'eventType'='user.organizations.added'")).rows[0].count,'1')
  })
  await check('new enrollment cannot bypass sharing, remap identities, promote owners or revive a mapped membership',async()=>{
    for(const [sql,params] of [
      ['INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES($1,$2,$3,$4)',[newPipeline,member,'viewer',owner]],
      ['UPDATE app_users SET suitecrm_user_id=$2 WHERE email=$1',[member,id(66)]],
      ["INSERT INTO app_user_organization_memberships(user_email,organization_id,role) VALUES($1,$2,'owner')",[member,unsharedWorkspace]],
      ["DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2",[member,newWorkspace]],
      ["INSERT INTO app_user_organization_memberships(user_email,organization_id,role) VALUES($1,$2,'owner')",[member,demoWorkspace]],
      ["INSERT INTO app_user_organization_memberships(user_email,organization_id,role) VALUES($1,$2,'member')",[member,demoWorkspace]],
    ])await assert.rejects(()=>query(sql,params),error=>error.code==='55000'&&/native-first/.test(error.message))
    assert.deepEqual(await audienceIds(),audienceBeforeEnrollment)
    assert.deepEqual((await query('SELECT * FROM crm_native_email_publication_control')).rows,beforeEnrollment.control)
  })
  await check('a failed organization audit rolls the new mapped membership back without changing native pins',async()=>{
    const before=await snapshot(),audits=(await query('SELECT * FROM employee_audit')).rows
    failAudit=true
    try{await assert.rejects(()=>users.addAppUserOrganizationMemberships({actorEmail:actor,email:member,organizationIds:[unsharedWorkspace]}),/synthetic audit failure/)}
    finally{failAudit=false}
    assert.deepEqual(await snapshot(),before);assert.deepEqual((await query('SELECT * FROM employee_audit')).rows,audits)
  })
  await check('a stale administrator request cannot add workspace access after its live management membership is trashed',async()=>{
    await query("UPDATE app_users SET role='admin' WHERE email='admin@example.test'")
    await query(`UPDATE app_user_organization_memberships SET role='admin',permissions='{"inviteUsers":true,"manageUserAccess":true}'
      WHERE user_email='admin@example.test'`)
    const adminActor={...actor,email:'admin@example.test',role:'admin',organizationRole:'admin',organizationPermissions:users.OWNER_PERMISSIONS}
    // This app-only administrator has no native identity or pipeline role;
    // its normal Trash remains independently legal with policy enabled.
    await query('UPDATE app_user_organization_memberships SET trashed_at=now() WHERE user_email=$1',[adminActor.email])
    const before=await snapshot()
    await assert.rejects(()=>users.addAppUserOrganizationMemberships({actorEmail:adminActor,email:member,organizationIds:[unsharedWorkspace]}),/no longer available|outside/)
    assert.deepEqual(await snapshot(),before)
  })
  console.log(`PASS ${count} real PostgreSQL employee identity, authorization, rollback and contention groups; synthetic native activation, no native/browser/production proof`)
}finally{
  try{if(pool)await pool.end()}
  finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{stdio:'pipe',timeout:30000})}
}
