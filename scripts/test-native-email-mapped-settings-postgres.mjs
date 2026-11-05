#!/usr/bin/env node
// Actual SQL fences and canonical app audience/role functions, synthetic rows.
// No native permission, full admin-route, provider, deployment or production proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'
import {loadNativeRootReaderFixtureModules} from './lib/native-root-reader-fixture-modules.mjs'
const source=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8')
const migration=source('db/migrations/0382_crm_native_email_mapped_settings.sql')
assert.match(migration,/transition IS NULL AND/)
assert.match(migration,/TG_OP='UPDATE' AND public\.clawpilot_native_email_mapped_settings_are_independent/)
assert.match(migration,/eligible_before IS DISTINCT FROM eligible_after/)
assert.doesNotMatch(migration,/DISABLE TRIGGER|set_config\(|current_setting\(|DROP TRIGGER/)
if(process.argv.length===2){console.log('PASS mapped-settings migration shape; --postgres required for SQL and canonical audience proof');process.exit(0)}
assert.deepEqual(process.argv.slice(2),['--postgres'])
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),{Pool}=require('pg')
function run(text,deps={}){const module={exports:{}}
  const code=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]})
  return module.exports}
function declarations(path,names){const ast=ts.createSourceFile(path,source(path),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
  return names.map(name=>{const node=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name
    ||ts.isVariableStatement(node)&&node.declarationList.declarations.some(value=>value.name.getText(ast)===name))
  assert.ok(node,`Actual ${name} must exist`);return node.getText(ast)}).join('\n')}
const projection=run(source('app_src/lib/crm/suiteCrmNativeEmailProjection.ts'),{'node:crypto':crypto})
const protocol=run(source('app_src/lib/crm/nativeEmailPublication.ts'),{'node:crypto':crypto})
const eligibility=run(source('app_src/lib/crm/nativeEmailEligibility.ts'),{'./nativeEmailPublication':protocol})
const roots=loadNativeRootReaderFixtureModules((path,deps)=>run(source(path),deps),protocol)
const audienceApi=run(`import {suiteCrmEmailAudienceFingerprint} from 'projection';\nimport {nativeEmailPrincipalIsEligible,nativeEmailEffectivePipelinePrincipals} from 'eligibility';\nimport {collectNativeEmailRootSourcesWithClient,projectNativeEmailRootReaders} from 'roots';\n`
  +declarations('app_src/lib/users.ts',['OWNER_PERMISSIONS','normalizePermissions','permissionsForRole'])+'\n'
  +declarations('app_src/lib/persistence/crm.ts',['reviewedEmailAudienceUnderNativeControlWithClient']),{projection,eligibility,roots})
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const refused=/Native authority requires a supported exact native-first transition/
const container=`clawpilot-mapped-settings-${process.pid}-${crypto.randomUUID().slice(0,8)}`
const image=process.env.CLAWPILOT_TEST_POSTGRES_IMAGE||'pgvector/pgvector:pg16'
assert.match(image,/^pgvector\/pgvector:pg(?:16|18)$/u)
let pool,started=false,count=0
async function check(name,fn){await fn();count++;console.log(`PASS ${name}`)}
try{
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
    '-e','POSTGRES_PASSWORD=mapped_settings_fixture','-e','POSTGRES_DB=mapped_settings_fixture','-p','127.0.0.1::5432',image]),
  {timeout:60000,stdio:'pipe'});started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port)
  pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'mapped_settings_fixture',database:'mapped_settings_fixture',
    ssl:false,max:4,connectionTimeoutMillis:1000,statement_timeout:5000})
  const deadline=Date.now()+30000
  while(true){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>=deadline)throw error;await new Promise(r=>setTimeout(r,100))}}
  const query=(sql,values)=>pool.query(sql,values)
  const transaction=async fn=>{const tx=await pool.connect();try{await tx.query('BEGIN');const result=await fn(tx);await tx.query('COMMIT');return result}
    catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}}
  await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid);
    CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,shared_by text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,
      PRIMARY KEY(user_email,organization_id));
    CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,suitecrm_module text,suitecrm_synced_at timestamptz);
    CREATE TABLE sync_outbox(id uuid PRIMARY KEY,target_system text,operation text,status text);
    INSERT INTO workspace_organizations(id) VALUES('${id(1)}'),('${id(3)}');
    INSERT INTO app_users VALUES
      ('owner@example.test','active','${id(11)}','owner','{}','${id(1)}'),
      ('reader@example.test','active','${id(12)}','member','{}','${id(1)}'),
      ('other-owner@example.test','active','${id(13)}','owner','{}','${id(3)}'),
      ('denied@example.test','active','${id(14)}','member','{}','${id(1)}'),
      ('duplicate-a@example.test','active','${id(15)}','member','{}','${id(3)}'),
      ('duplicate-b@example.test','active','${id(15)}','member','{}','${id(3)}');
    INSERT INTO app_user_organization_memberships SELECT email,organization_id,'active',role,'{}',NULL FROM app_users;
    INSERT INTO app_user_organization_memberships VALUES('reader@example.test','${id(3)}','active','member','{}',NULL);
    UPDATE app_user_organization_memberships SET permissions='{"viewCrm":false}' WHERE user_email='denied@example.test';
    INSERT INTO pipeline_spaces VALUES('${id(2)}','owner@example.test','${id(1)}',false),
      ('${id(4)}','other-owner@example.test','${id(3)}',false),('${id(6)}','owner@example.test','${id(1)}',false);
    INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES
      ('${id(2)}','reader@example.test','viewer','owner@example.test'),
      ('${id(4)}','reader@example.test','editor','other-owner@example.test'),
      ('${id(6)}','denied@example.test','viewer','owner@example.test');`)
  for(const file of ['0375_crm_native_email_publication_admission.sql','0376_crm_native_email_publication_work_context.sql',
    '0377_crm_native_email_authority_transitions.sql','0378_crm_native_email_capability_policies.sql','0379_crm_native_email_app_only_lifecycle.sql',
    '0380_crm_native_email_grant_attempts.sql','0381_crm_native_email_identity_quiescence.sql','0382_crm_native_email_mapped_settings.sql',
    '0392_crm_root_employee_access_registry.sql'])
    await transaction(tx=>tx.query(source(`db/migrations/${file}`)))
  const control=async()=>(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  const audience=pipeline=>transaction(async tx=>{await tx.query('SELECT singleton FROM crm_native_email_publication_control FOR UPDATE')
    return audienceApi.reviewedEmailAudienceUnderNativeControlWithClient(tx,pipeline)})
  await check('disabled mapped settings still invalidate activation generation',async()=>{
    const before=await control()
    await query(`UPDATE app_users SET permissions='{"viewAccounting":true}' WHERE email='reader@example.test'`)
    assert.equal(Number((await control()).generation),Number(before.generation)+1)
    await query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
      native_policy_fingerprint=$1,activation_receipt_hash=$2`,['1'.repeat(64),'2'.repeat(64)])
  })
  const baseline=await control(),a=await audience(id(2)),b=await audience(id(4))
  const nativeWriters=(await query('SELECT pipeline_id,user_email,access_role FROM pipeline_space_members ORDER BY pipeline_id,user_email')).rows
  await check('mapped global settings and default workspace preserve both exact native audiences and writer rows',async()=>{
    await query(`UPDATE app_users SET role='admin',permissions='{"viewCrm":false,"viewShipping":true}',organization_id=$1
      WHERE email='reader@example.test'`,[id(3)])
    assert.deepEqual(await audience(id(2)),a);assert.deepEqual(await audience(id(4)),b)
    assert.deepEqual((await query('SELECT pipeline_id,user_email,access_role FROM pipeline_space_members ORDER BY pipeline_id,user_email')).rows,nativeWriters)
    assert.deepEqual(await control(),baseline)
  })
  await check('mapped scoped role and nonCRM settings save without widening native readers or writers',async()=>{
    await query(`UPDATE app_user_organization_memberships SET role='admin',permissions='{"viewShipping":true,"viewAccounting":true}'
      WHERE user_email='reader@example.test' AND organization_id=$1`,[id(1)])
    await query(`UPDATE app_user_organization_memberships SET role='member',permissions='{"viewCrm":true,"viewAccounting":false}'
      WHERE user_email='reader@example.test' AND organization_id=$1`,[id(1)])
    await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":false,"viewShipping":true}'
      WHERE user_email='owner@example.test'`)
    assert.deepEqual(await audience(id(2)),a);assert.deepEqual(await audience(id(4)),b)
    assert.deepEqual((await query('SELECT pipeline_id,user_email,access_role FROM pipeline_space_members ORDER BY pipeline_id,user_email')).rows,nativeWriters)
    assert.deepEqual(await control(),baseline)
  })
  await check('known valid denied member remains in intended membership but outside effective audience',async()=>{
    const deniedAudience=await audience(id(6))
    assert.deepEqual(deniedAudience.allowedSuiteCrmUserIds,[id(11)])
    await query(`UPDATE app_user_organization_memberships SET role='admin',permissions='{"viewCrm":false,"viewAccounting":true}'
      WHERE user_email='denied@example.test'`)
    assert.deepEqual(await audience(id(6)),deniedAudience)
    assert.equal((await query("SELECT count(*) FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email='denied@example.test'",[id(6)])).rows[0].count,'1')
    await assert.rejects(()=>query(`UPDATE app_user_organization_memberships SET role='owner' WHERE user_email='denied@example.test'`),refused)
    await assert.rejects(()=>query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":true}' WHERE user_email='denied@example.test'`),refused)
    assert.deepEqual(await control(),baseline)
  })
  await check('identity status trash scope and actual CRM eligibility changes remain exact-transition holds',async()=>{
    for(const [sql,params] of [
      ["UPDATE app_users SET email='renamed@example.test' WHERE email='reader@example.test'",[]],
      ["UPDATE app_users SET suitecrm_user_id=NULL WHERE email='reader@example.test'",[]],
      ["UPDATE app_users SET suitecrm_user_id=$1 WHERE email='reader@example.test'",[id(11)]],
      ["UPDATE app_users SET status='disabled' WHERE email='reader@example.test'",[]],
      ["UPDATE app_user_organization_memberships SET status='disabled' WHERE user_email='reader@example.test'",[]],
      ["UPDATE app_user_organization_memberships SET trashed_at=now() WHERE user_email='reader@example.test'",[]],
      ["UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":false}' WHERE user_email='reader@example.test' AND organization_id=$1",[id(1)]],
      ["UPDATE app_user_organization_memberships SET role='admin' WHERE user_email='owner@example.test'",[]],
      ["UPDATE app_user_organization_memberships SET organization_id=$1 WHERE user_email='owner@example.test'",[id(3)]],
      ["UPDATE pipeline_space_members SET access_role='editor' WHERE pipeline_id=$1 AND user_email='reader@example.test'",[id(2)]],
      ["DELETE FROM app_users WHERE email='reader@example.test'",[]],
      ["DELETE FROM app_user_organization_memberships WHERE user_email='reader@example.test'",[]],
    ])await assert.rejects(()=>query(sql,params),refused)
    assert.deepEqual(await audience(id(2)),a);assert.deepEqual(await audience(id(4)),b)
    assert.deepEqual(await control(),baseline)
  })
  await check('malformed permissions unknown roles ambiguous identities and mixed bulk updates fail closed',async()=>{
    for(const permissions of ['[]','null','{"viewCrm":"true"}','{"viewCrm":null}'])await assert.rejects(()=>query(
      "UPDATE app_user_organization_memberships SET permissions=$1::jsonb WHERE user_email='reader@example.test'",[permissions]),refused)
    await assert.rejects(()=>query("UPDATE app_user_organization_memberships SET role='other' WHERE user_email='reader@example.test'"),refused)
    await assert.rejects(()=>query("UPDATE app_users SET permissions='{\"viewShipping\":true}' WHERE email='duplicate-a@example.test'"),refused)
    await assert.rejects(()=>query("UPDATE app_user_organization_memberships SET permissions='{\"viewShipping\":true}' WHERE user_email='duplicate-a@example.test'"),refused)
    const before=(await query('SELECT email,permissions FROM app_users ORDER BY email')).rows
    await assert.rejects(()=>query("UPDATE app_users SET permissions='{\"viewShipping\":true}' WHERE email IN ('reader@example.test','duplicate-a@example.test')"),refused)
    assert.deepEqual((await query('SELECT email,permissions FROM app_users ORDER BY email')).rows,before)
    assert.deepEqual(await control(),baseline)
  })
  await check('mapped settings retain original control-first serialization',async()=>{
    const held=await pool.connect(),waiting=await pool.connect()
    try{await held.query('BEGIN');await held.query('SELECT singleton FROM crm_native_email_publication_control FOR UPDATE')
      await waiting.query('BEGIN');await waiting.query("SET LOCAL lock_timeout='200ms'")
      await assert.rejects(()=>waiting.query("UPDATE app_users SET permissions='{\"viewShipping\":true}' WHERE email='reader@example.test'"),error=>error.code==='55P03')
      await waiting.query('ROLLBACK');await held.query('COMMIT')
    }finally{await held.query('ROLLBACK');await waiting.query('ROLLBACK');held.release();waiting.release()}
    assert.deepEqual(await control(),baseline)
  })
  await check('active transition freezes full mapped settings snapshot even when effective readers would remain equal',async()=>{
    // Synthetically seeded DB-plan envelope only: sufficient to exercise actual
    // SQL pinning, not native/typed plan authorization or activation evidence.
    const tid='3'.repeat(64),planHash='4'.repeat(64),changeHash='5'.repeat(64)
    const member=(await query('SELECT to_jsonb(m) AS value FROM pipeline_space_members m WHERE pipeline_id=$1 AND user_email=$2',[id(2),'reader@example.test'])).rows[0].value
    const desired={kind:'pipeline_members_v1',changes:[{before:member,after:null}]}
    const command=phase=>({version:1,phase,operationId:(phase==='revoke'?'6':'7').repeat(64),transitionId:tid,
      desiredAppChangeHash:changeHash,generationFrom:Number(baseline.generation),beforePolicyFingerprint:baseline.native_policy_fingerprint,
      bindings:[{before:{pipeline_id:id(2),workspace_id:id(1)}}]})
    const plan={planHash,desiredAppChange:desired,revoke:command('revoke'),grant:command('grant')}
    await transaction(async tx=>{
      await tx.query(`INSERT INTO crm_native_email_authority_transitions(transition_id,plan_hash,desired_change_hash,plan,actor_email)
        VALUES($1,$2,$3,$4::jsonb,'owner@example.test')`,[tid,planHash,changeHash,JSON.stringify(plan)])
      for(const phase of ['revoke','grant'])await tx.query(`INSERT INTO crm_native_email_authority_phases
        (transition_id,phase,operation_id,command_hash,command) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [tid,phase,plan[phase].operationId,'8'.repeat(64),JSON.stringify(plan[phase])])
      await tx.query(`INSERT INTO crm_native_email_authority_member_changes(transition_id,ordinal,pipeline_id,user_email,before_row,after_row)
        VALUES($1,0,$2,'reader@example.test',$3::jsonb,NULL)`,[tid,id(2),JSON.stringify(member)])
      await tx.query('UPDATE crm_native_email_publication_control SET active_transition_id=$1',[tid])
    })
    await assert.rejects(()=>query("UPDATE app_users SET permissions='{\"viewShipping\":true}' WHERE email='reader@example.test'"),refused)
    await assert.rejects(()=>query("UPDATE app_user_organization_memberships SET role='admin' WHERE user_email='reader@example.test' AND organization_id=$1",[id(1)]),refused)
    await assert.rejects(()=>query("UPDATE app_users SET organization_id=$1 WHERE email='reader@example.test'",[id(1)]),refused)
    assert.equal((await control()).active_transition_id,tid)
    assert.deepEqual(await audience(id(2)),a);assert.deepEqual(await audience(id(4)),b)
  })
  console.log(`PASS ${count} real PostgreSQL mapped-settings groups; canonical audience proof, synthetic activation, no native/production proof`)
}finally{try{if(pool)await pool.end()}finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})}}
