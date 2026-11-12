#!/usr/bin/env node
// Synthetic fixtures in an isolated, disposable PostgreSQL; no app providers.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createDisposablePostgresRuntime, disposablePostgresDockerArgs } from './lib/disposable-postgres-docker.mjs'

const flag=process.argv[2]??'--postgres-major=18'
assert.ok(process.argv.length<=3&&/^--postgres-major=(16|18)$/.test(flag))
const major=flag.split('=')[1]
const name='clawpilot-crm-maintenance-test-'+randomUUID()
const image=`pgvector/pgvector:pg${major}`
const migration=readFileSync(new URL('../db/migrations/0418_crm_maintenance_write_fence.sql',import.meta.url),'utf8')
const runtime=createDisposablePostgresRuntime()
const clients=new Set()
const fixtureDb='fixture_crm_custody'
const bootstrapRole='postgres'
const operatorRole='fixture_crm_operator'
const workerRole='fixture_crm_worker'
// These ephemeral values are used only in the no-network Docker fixture.
const bootstrapPassword=randomUUID()
const operatorPassword=randomUUID()
const workerPassword=randomUUID()
const fence='44124125-c3d0-4958-81ea-39837cb2da59'
const wrong='bb7b5317-1b39-40d9-86cd-0b17c6915b5c'
const schema='clawpilot_crm_maintenance'
const activate=`SELECT ${schema}.transition(NULL,'${fence}');`
const clear=`SELECT ${schema}.transition('${fence}',NULL);`

function docker(args,input) {
  return execFileSync('docker',args,{input,encoding:'utf8',timeout:15000,maxBuffer:256*1024,stdio:['pipe','pipe','pipe']}).trim()
}
// The entrypoint's temporary init server is Unix-socket-only. The final
// fixture has loopback TCP inside --network none, never a published port.
const psql=(role,password,db)=>['exec','-i','-e',`PGPASSWORD=${password}`,name,'psql','-X','-qAt','-h','127.0.0.1','-U',role,'-d',db,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
const bootstrap=(s)=>docker(psql(bootstrapRole,bootstrapPassword,'postgres'),s)
const sql=(s)=>docker(psql(operatorRole,operatorPassword,fixtureDb),s)
const worker=(s)=>docker(psql(workerRole,workerPassword,fixtureDb),s)
function held(fn,state='55000') {
  assert.throws(fn,(e)=>Number.isInteger(e?.status)&&new RegExp(`ERROR:\\s+${state}:`).test(e.stderr??''))
}
function stream() {
  const cp=spawn('docker',psql(workerRole,workerPassword,fixtureDb),{stdio:['pipe','pipe','pipe']})
  let stdout='',stderr=''
  cp.stdout.setEncoding('utf8').on('data',s=>stdout+=s)
  cp.stderr.setEncoding('utf8').on('data',s=>stderr+=s)
  cp.stdin.on('error',()=>{})
  const done=once(cp,'close').then(([code])=>({code,stderr}))
  clients.add(cp)
  void done.catch(()=>{}).finally(()=>clients.delete(cp))
  return {cp,done,write:(s)=>cp.stdin.write(s+'\n'),wait:async(marker)=>{
    for(let i=0;i<60;i++){
      if(stdout.split(/\r?\n/).includes(marker))return
      if(cp.exitCode!==null)throw Error(`Fixture session stopped before ${marker}`)
      await delay(50)
    }
    throw Error(`Fixture did not reach ${marker}`)
  }}
}

const seed=`
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  CREATE SCHEMA crm_legacy_email_retirement;
  CREATE SCHEMA crm_legacy_email_terminal_hold;
  CREATE TABLE crm_legacy_email_retirement.receipts (id text PRIMARY KEY);
  CREATE TABLE crm_legacy_email_terminal_hold.receipts (id text PRIMARY KEY);
  CREATE TABLE public.pipeline_spaces (id text PRIMARY KEY, title text, crm_last_synced_at timestamptz,
    workspace_organization_id text, owner_email text, crm_provider text, crm_projection_version integer);
  CREATE TABLE public.pipeline_space_members (id text PRIMARY KEY);
  CREATE TABLE public.crm_interactions (id text PRIMARY KEY,pipeline_id text REFERENCES pipeline_spaces(id) ON DELETE CASCADE);
  CREATE TABLE public.fractional_crm_gateway_operations (id text PRIMARY KEY);
  CREATE TABLE public.quickbooks_crm_links (id text PRIMARY KEY);
  CREATE TABLE public.crm_reference_registry (id text PRIMARY KEY,entity_type text);
  CREATE TABLE public.crm_reference_number_registry (id text PRIMARY KEY);
  CREATE TABLE public.sync_outbox (id text PRIMARY KEY,target_system text,aggregate_type text,operation text);
  CREATE TABLE public.sync_jobs (id text PRIMARY KEY,target_system text,source_system text);
  CREATE TABLE public.short_links (id text PRIMARY KEY,source_app text);
  CREATE TABLE public.short_link_clicks (id text PRIMARY KEY,source_app text);
  CREATE TABLE public.app_settings (key text PRIMARY KEY);
  CREATE TABLE public.audit_events (id text PRIMARY KEY,event_type text,aggregate_type text);
  CREATE TABLE public.organization_quickbooks_connections (id text PRIMARY KEY, status text, crm_pipeline_id text,
    crm_customer_sync_enabled boolean DEFAULT false, crm_product_sync_enabled boolean DEFAULT false,
    last_crm_synced_at timestamptz, last_crm_sync_error text);
  CREATE TABLE public.app_users (email text PRIMARY KEY, display_name text, status text, role text,
    permissions jsonb, organization_id text, reference_code text, crm_user_enabled boolean DEFAULT false,
    suitecrm_user_id text, suitecrm_username text);
  CREATE TABLE public.operations_fixture (id text PRIMARY KEY);
  GRANT USAGE ON SCHEMA public,crm_legacy_email_retirement,crm_legacy_email_terminal_hold TO ${workerRole};
  -- Deliberately grant TRUNCATE here to exercise its dedicated trigger, not
  -- as a grant recommendation for the hosted runtime.
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public,
    crm_legacy_email_retirement,crm_legacy_email_terminal_hold TO ${workerRole};
`
let launched=false
try {
  const args=disposablePostgresDockerArgs(['run','-d','--pull','never','--name',name,'--network','none',
    '-e',`POSTGRES_PASSWORD=${bootstrapPassword}`,image,'-c','max_prepared_transactions=2'],{runtime})
  launched=true
  docker(args)
  for(let i=0;;i++){
    try {if(bootstrap('SELECT 1;')==='1')break} catch { /* isolated boot */ }
    assert.ok(i<50,'PostgreSQL fixture did not start')
    await delay(150)
  }
  bootstrap(`CREATE ROLE ${operatorRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${operatorPassword}';
    CREATE ROLE ${workerRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${workerPassword}';
    CREATE DATABASE ${fixtureDb} OWNER ${operatorRole};
    REVOKE ALL ON DATABASE ${fixtureDb} FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${fixtureDb} TO ${workerRole};`)
  const identity=`SELECT current_user,session_user,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname=current_user;`
  assert.equal(sql(identity),`${operatorRole}|${operatorRole}|f|f|f|f|f|f`)
  assert.equal(worker(identity),`${workerRole}|${workerRole}|f|f|f|f|f|f`)
  sql(seed)
  sql('BEGIN;\n'+migration+'\nCOMMIT;')
  assert.equal(sql(`SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='${schema}';`),operatorRole)
  assert.equal(sql(`SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='${schema}.write_fence'::regclass;`),operatorRole)
  assert.equal(sql(`SELECT ${schema}.coverage();`),'t')
  assert.equal(sql(`SELECT fence_id IS NULL FROM ${schema}.write_fence;`),'t')
  held(()=>worker(`SELECT ${schema}.transition(NULL,'${fence}');`),'42501')
  held(()=>worker(`UPDATE ${schema}.write_fence SET fence_id=NULL;`),'42501')

  worker(`INSERT INTO pipeline_spaces(id,title,crm_last_synced_at) VALUES ('fixture','original',now());
    INSERT INTO crm_interactions VALUES ('seed','fixture');
    INSERT INTO organization_quickbooks_connections (id,status,crm_customer_sync_enabled) VALUES ('accounting','ready',true);
    INSERT INTO app_users (email,crm_user_enabled,role) VALUES ('crm@example.test',true,'member');
    INSERT INTO sync_outbox VALUES ('crm','suitecrm','app_users','sync'),
      ('normal','google_sheets','pipeline_items','ordinary');`)
  const older=stream()
  older.write("BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM operations_fixture; SELECT 'snapshot-open';")
  await older.wait('snapshot-open')
  const admitted=stream()
  admitted.write("BEGIN; INSERT INTO crm_interactions VALUES ('prior-write','fixture'); SELECT 'writer-open';")
  await admitted.wait('writer-open')
  held(()=>sql("SET lock_timeout='200ms';"+activate),'55P03')
  assert.equal(sql(`SELECT fence_id IS NULL FROM ${schema}.write_fence;`),'t')
  admitted.write('COMMIT;');admitted.cp.stdin.end()
  assert.equal((await admitted.done).code,0)
  worker("BEGIN; INSERT INTO crm_interactions VALUES ('prepared-write','fixture'); PREPARE TRANSACTION 'crm-fence-fixture';")
  held(()=>sql("SET lock_timeout='200ms';"+activate),'55P03')
  worker("ROLLBACK PREPARED 'crm-fence-fixture';")
  sql(activate)
  assert.equal(sql(`SELECT fence_id FROM ${schema}.write_fence;`),fence)
  for(const statement of [
    `SET ROLE ${operatorRole};`,
    `SET SESSION AUTHORIZATION ${operatorRole};`,
    'SET ROLE pg_write_all_data;',
    "SET session_replication_role='replica';",
    'ALTER TABLE crm_interactions DISABLE TRIGGER clawpilot_crm_fence_write;',
    'DROP TRIGGER clawpilot_crm_fence_write ON crm_interactions;',
    'ALTER TABLE sync_outbox DISABLE TRIGGER clawpilot_crm_fence_truncate;',
    `DROP SCHEMA ${schema} CASCADE;`,
    `SELECT ${schema}.admit_write();`,
    clear,
    `UPDATE ${schema}.write_fence SET fence_id=NULL;`,
    `DELETE FROM ${schema}.write_fence;`,
  ])held(()=>worker(statement),'42501')
  assert.equal(sql(`SELECT fence_id FROM ${schema}.write_fence;`),fence)
  assert.equal(sql(`SELECT ${schema}.coverage();`),'t')
  older.write("INSERT INTO crm_interactions VALUES ('stale-snapshot','fixture'); COMMIT;");older.cp.stdin.end()
  const olderResult=await older.done
  assert.notEqual(olderResult.code,0)
  assert.match(olderResult.stderr,/ERROR:\s+(40001|55000):/)

  for(const statement of [
    "INSERT INTO crm_interactions VALUES ('blocked','fixture');",
    "UPDATE crm_interactions SET pipeline_id=NULL WHERE id='seed';",
    "DELETE FROM crm_interactions WHERE id='seed';",
    'TRUNCATE crm_interactions;', 'TRUNCATE sync_outbox;',
    "COPY crm_interactions FROM STDIN;\nblocked-copy\tfixture\n\\.\n",
    "INSERT INTO crm_interactions VALUES ('seed','fixture') ON CONFLICT(id) DO UPDATE SET pipeline_id=NULL;",
    "INSERT INTO fractional_crm_gateway_operations VALUES ('blocked');",
    "INSERT INTO quickbooks_crm_links VALUES ('blocked');",
    "INSERT INTO crm_legacy_email_retirement.receipts VALUES ('blocked');",
    "INSERT INTO crm_legacy_email_terminal_hold.receipts VALUES ('blocked');",
    "UPDATE sync_outbox SET target_system='google_sheets' WHERE id='crm';",
    "UPDATE sync_outbox SET target_system='suitecrm' WHERE id='normal';",
    "INSERT INTO sync_outbox VALUES ('crm-sheet','google_sheets','pipeline_space','project_crm_workbook');",
    "INSERT INTO sync_outbox VALUES ('crm-owner','pipeline_internal_v1','pipeline_space','sync_pipeline_owner_profile_v1');",
    "INSERT INTO sync_outbox VALUES ('crm-legacy','google_sheets','pipeline_space','append_interaction');",
    "INSERT INTO sync_outbox VALUES ('crm-provision','google_workspace_v6','pipeline_space','provision_pipeline');",
    "INSERT INTO sync_outbox VALUES ('unrelated-first','google_sheets','pipeline_items','ordinary'),('crm-last','suitecrm','crm_interaction','sync');",
    "INSERT INTO sync_jobs VALUES ('blocked','google_sheets','suitecrm');",
    "INSERT INTO short_links VALUES ('blocked','clawpilot-crm');",
    "INSERT INTO short_link_clicks VALUES ('blocked','clawpilot-crm');",
    "INSERT INTO app_settings VALUES ('crm.last_sync');",
    "INSERT INTO audit_events VALUES ('blocked','pipeline.opportunity.created','crm_opportunity');",
    "INSERT INTO crm_reference_registry VALUES ('blocked','crm.product');",
    "UPDATE pipeline_spaces SET crm_last_synced_at=NULL WHERE id='fixture';",
    "UPDATE pipeline_spaces SET workspace_organization_id='blocked' WHERE id='fixture';",
    "DELETE FROM pipeline_spaces WHERE id='fixture';",
    "INSERT INTO pipeline_space_members VALUES ('blocked');",
    "UPDATE organization_quickbooks_connections SET last_crm_sync_error='blocked' WHERE id='accounting';",
    "UPDATE app_users SET role='admin' WHERE email='crm@example.test';",
    "UPDATE app_users SET suitecrm_username='blocked' WHERE email='crm@example.test';",
  ])held(()=>worker(statement))
  assert.equal(sql("SELECT count(*) FROM sync_outbox WHERE id='unrelated-first';"),'0')
  worker(`INSERT INTO operations_fixture VALUES ('works');
    INSERT INTO crm_reference_registry VALUES ('shipping','shipping.parcel');
    INSERT INTO crm_reference_number_registry VALUES ('other-suffix');
    INSERT INTO short_links VALUES ('unrelated','clawpilot');
    INSERT INTO app_settings VALUES ('unrelated');
    INSERT INTO sync_outbox VALUES ('ordinary','google_sheets','pipeline_item','ordinary');
    UPDATE organization_quickbooks_connections SET status='connected' WHERE id='accounting';
    UPDATE app_users SET display_name='Normal profile' WHERE email='crm@example.test';
    INSERT INTO app_users(email) VALUES ('ordinary@example.test');
    UPDATE pipeline_spaces SET title='still available' WHERE id='fixture';`)
  assert.equal(worker('SELECT count(*) FROM crm_interactions;'),'2')
  held(()=>sql(`SELECT ${schema}.transition('${wrong}',NULL);`))
  held(()=>sql(activate))
  sql(clear)
  assert.equal(sql(`SELECT fence_id IS NULL FROM ${schema}.write_fence;`),'t')
  worker("INSERT INTO crm_interactions VALUES ('resumed','fixture');")
  assert.equal(worker("SELECT count(*) FROM crm_interactions WHERE id='resumed';"),'1')

  sql('ALTER TABLE crm_interactions DISABLE TRIGGER clawpilot_crm_fence_write;')
  assert.equal(sql(`SELECT ${schema}.coverage();`),'f')
  held(()=>sql(activate))
  sql('ALTER TABLE crm_interactions ENABLE ALWAYS TRIGGER clawpilot_crm_fence_write; CREATE TABLE crm_future_unfenced (id text);')
  assert.equal(sql(`SELECT ${schema}.coverage();`),'f')
  held(()=>sql(activate))
  sql('DROP TABLE crm_future_unfenced; ALTER TABLE sync_outbox RENAME COLUMN target_system TO different_target;')
  assert.equal(sql(`SELECT ${schema}.coverage();`),'f')
  held(()=>sql(activate))
  sql(`DELETE FROM ${schema}.write_fence;`)
  held(()=>worker("INSERT INTO crm_interactions VALUES ('missing-gate','fixture');"))
  console.log(`PASS PostgreSQL ${major}: distinct CRM app/operator logins, denied fence bypass, activation drain, unchanged unrelated writes, reopening and fail-closed drift`)
} finally {
  for(const cp of clients){cp.stdin.destroy();cp.kill('SIGTERM')}
  if(launched)assert.ok(runtime.cleanup(),'Guarded PostgreSQL cleanup was not verified')
}
