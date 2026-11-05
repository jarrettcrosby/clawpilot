#!/usr/bin/env node
// Actual disabled-control/policy generation guards and transactional fixture
// enrollment. Synthetic native snapshot; not native or production activation.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {randomUUID,createHash} from 'node:crypto'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
import {enrollCombinedNativeSnapshot} from './lib/native-app-postgres-acceptance.mjs'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),{Pool}=require('pg')
const fixture=JSON.parse(execFileSync(process.execPath,['scripts/test-native-email-authority-v2.mjs','--emit-fixture'],{encoding:'utf8'}))
const before={generation:37,nativePolicyFingerprint:fixture.plan.revoke.beforePolicyFingerprint,
  bindings:fixture.plan.revoke.bindings.map(p=>({...p.before,generation:'37'}))}
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const container='clawpilot-native-enrollment-'+randomUUID().slice(0,8)
const environment={...process.env,CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE:'256m',CLAWPILOT_TEST_POSTGRES_MEMORY:'512m',CLAWPILOT_TEST_POSTGRES_CPUS:'0.5'}
let pool,started=false
try{
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','--detach','--name',container,'--pull','never',
    '-e','POSTGRES_PASSWORD=enrollment_fixture_only','-e','POSTGRES_DB=enrollment_fixture','-p','127.0.0.1::5432','pgvector/pgvector:pg16'],{environment}),
  {timeout:60000,stdio:'pipe'});started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8'}).match(/^127\.0\.0\.1:(\d+)\s*$/)?.[1];assert.ok(port)
  pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'enrollment_fixture_only',database:'enrollment_fixture',connectionTimeoutMillis:1000})
  const query=(sql,values)=>pool.query(sql,values),deadline=Date.now()+30000
  while(true){try{await query('SELECT 1');break}catch(error){if(Date.now()>deadline)throw error;await new Promise(r=>setTimeout(r,100))}}
  const transaction=async run=>{const tx=await pool.connect();try{await tx.query('BEGIN');const result=await run(tx);await tx.query('COMMIT');return result}
    catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}}
  await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid);
    CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean DEFAULT false);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean DEFAULT false);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,shared_by text,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,PRIMARY KEY(user_email,organization_id));
    CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,suitecrm_module text,suitecrm_synced_at timestamptz);`)
  for(const b of before.bindings)await query('INSERT INTO pipeline_spaces(id,owner_email,workspace_organization_id) VALUES($1,$2,$3)',[b.pipeline_id,'owner@example.test',b.workspace_id])
  for(const file of ['0375_crm_native_email_publication_admission.sql','0376_crm_native_email_publication_work_context.sql',
    '0377_crm_native_email_authority_transitions.sql','0378_crm_native_email_capability_policies.sql'])
    await transaction(tx=>tx.query(readFileSync(new URL('../db/migrations/'+file,import.meta.url),'utf8')))
  const policy=before.bindings.find(b=>b.capability_policy_json!==null);assert.ok(policy)
  await assert.rejects(()=>query('INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint) VALUES($1,$2,$3::jsonb,$4)',
    [policy.pipeline_id,policy.generation,policy.capability_policy_json,policy.capability_policy_fingerprint]),
  e=>e.code==='55000'&&/generation differs/.test(e.message))
  console.log('PASS existing PostgreSQL guard refuses native policies before disabled control generation alignment')
  await assert.rejects(()=>enrollCombinedNativeSnapshot(run=>transaction(async tx=>{await run(tx);throw Error('synthetic enrollment rollback')}),before,hash),/synthetic enrollment rollback/)
  assert.deepEqual((await query('SELECT enabled,generation::text FROM crm_native_email_publication_control')).rows,[{enabled:false,generation:'1'}])
  assert.equal((await query('SELECT count(*) FROM crm_native_email_capability_policies')).rows[0].count,'0')
  console.log('PASS failed fixture enrollment rolls generation, policies and activation back atomically')
  await enrollCombinedNativeSnapshot(transaction,before,hash)
  const control=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  assert.equal(control.enabled,true);assert.equal(control.generation,'37');assert.equal(control.verified_generation,'37')
  assert.equal((await query('SELECT count(*) FROM crm_native_email_capability_policies')).rows[0].count,String(before.bindings.filter(b=>b.capability_policy_json!==null).length))
  await assert.rejects(()=>enrollCombinedNativeSnapshot(transaction,before,hash),/disabled, drained/)
  assert.deepEqual((await query('SELECT * FROM crm_native_email_publication_control')).rows[0],control)
  console.log('PASS exact advanced-generation fixture enrollment succeeds once and cannot re-enroll enabled control')
}finally{try{if(pool)await pool.end()}finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})}}
