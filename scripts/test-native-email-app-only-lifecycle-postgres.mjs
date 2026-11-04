#!/usr/bin/env node
// Original 0379 compatibility-floor SQL fences (not the expanded 0387 path,
// covered by test-native-email-app-only-sharing-postgres.mjs). The activation
// receipt below is synthetic: this is not native ACL or production proof.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'

const migrationPath = new URL('../db/migrations/0379_crm_native_email_app_only_lifecycle.sql', import.meta.url)
const migration = readFileSync(migrationPath, 'utf8')
assert.match(migration, /transition IS NULL AND public\.clawpilot_native_email_app_only_change_is_independent/)
assert.match(migration, /candidate->>'suitecrm_user_id' IS NOT NULL/)
assert.doesNotMatch(migration, /DISABLE TRIGGER|set_config\(|current_setting\(|DROP TRIGGER/)
if (process.argv.length === 2) {
  console.log('PASS app-only lifecycle migration guard shape; --postgres required for actual SQL acceptance')
  process.exit(0)
}
assert.deepEqual(process.argv.slice(2), ['--postgres'])
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = require('pg')
const container = `clawpilot-app-only-${process.pid}-${randomUUID().slice(0, 8)}`
const image = process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16'
assert.match(image, /^pgvector\/pgvector:pg(?:16|18)$/u)
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const refused = /Native authority requires a supported exact native-first transition/
let pool, started = false, count = 0
async function check(name, run) { await run(); count++; console.log(`PASS ${name}`) }
try {
  execFileSync('docker', disposablePostgresDockerArgs(['run', '--rm', '-d', '--name', container, '--pull', 'never',
    '-e', 'POSTGRES_PASSWORD=app_only_fixture', '-e', 'POSTGRES_DB=app_only_fixture', '-p', '127.0.0.1::5432', image]),
  { timeout: 60000, stdio: 'pipe' }); started = true
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 10000 })
    .match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port)
  pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'app_only_fixture',
    database: 'app_only_fixture', ssl: false, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 5000 })
  const deadline = Date.now() + 30000
  while (true) { try { await pool.query('SELECT 1'); break } catch (error) {
    if (Date.now() >= deadline) throw error
    await new Promise(resolve => setTimeout(resolve, 100))
  } }
  const query = (sql, values) => pool.query(sql, values)
  const transaction = async run => { const tx = await pool.connect(); try {
    await tx.query('BEGIN'); const result = await run(tx); await tx.query('COMMIT'); return result
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() } }
  await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,
      organization_id uuid,display_name text,updated_at timestamptz DEFAULT now());
    CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text REFERENCES app_users(email) ON DELETE CASCADE,
      workspace_organization_id uuid,reference_access_disabled boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_space_members(pipeline_id uuid REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
      user_email text REFERENCES app_users(email) ON DELETE CASCADE,access_role text,shared_by text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text REFERENCES app_users(email) ON DELETE CASCADE,
      organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,PRIMARY KEY(user_email,organization_id));
    CREATE TABLE app_user_login_addresses(user_email text PRIMARY KEY REFERENCES app_users(email) ON DELETE CASCADE,
      login_email text NOT NULL UNIQUE,verified_at timestamptz DEFAULT now());
    CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,
      suitecrm_module text,suitecrm_synced_at timestamptz);
    INSERT INTO workspace_organizations(id) VALUES('${id(1)}'),('${id(3)}');
    INSERT INTO app_users(email,status,suitecrm_user_id,role,permissions,organization_id) VALUES
      ('owner@example.test','active','${id(11)}','owner','{}','${id(1)}'),
      ('reader@example.test','active','${id(12)}','member','{}','${id(1)}'),
      ('unmapped-member@example.test','active',NULL,'member','{}','${id(1)}'),
      ('unmapped-owner@example.test','active',NULL,'owner','{}','${id(3)}'),
      ('native-unreferenced@example.test','active','${id(13)}','member','{}','${id(3)}');
    INSERT INTO app_user_organization_memberships SELECT email,organization_id,status,role,permissions,NULL FROM app_users;
    INSERT INTO pipeline_spaces VALUES('${id(2)}','owner@example.test','${id(1)}',false),
      ('${id(4)}','unmapped-owner@example.test','${id(3)}',false);
    INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES
      ('${id(2)}','reader@example.test','viewer','owner@example.test'),
      ('${id(2)}','unmapped-member@example.test','viewer','owner@example.test');`)
  for (const file of ['0375_crm_native_email_publication_admission.sql', '0376_crm_native_email_publication_work_context.sql',
    '0377_crm_native_email_authority_transitions.sql', '0378_crm_native_email_capability_policies.sql',
    '0379_crm_native_email_app_only_lifecycle.sql'])
    await transaction(tx => tx.query(readFileSync(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8')))
  const control = async () => (await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  await check('disabled mode still invalidates the original policy generation', async () => {
    const before = await control()
    await query(`INSERT INTO app_users(email,status,role,permissions,organization_id)
      VALUES('plain@example.test','invited','member','{}',$1)`, [id(1)])
    assert.equal(Number((await control()).generation), Number(before.generation) + 1)
    await query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
      native_policy_fingerprint=$1,activation_receipt_hash=$2`, ['1'.repeat(64), '2'.repeat(64)])
  })
  const baseline = await control()
  await check('app-only invitation and acceptance leave enabled generation and pins unchanged', async () => {
    await transaction(async tx => {
      await tx.query(`INSERT INTO app_users(email,status,role,permissions,organization_id)
        VALUES('invite@example.test','invited','member','{}',$1)`, [id(1)])
      await tx.query(`INSERT INTO app_user_organization_memberships VALUES('invite@example.test',$1,'invited','member','{}',NULL)`, [id(1)])
    })
    await transaction(async tx => {
      await tx.query(`UPDATE app_user_organization_memberships SET status='active' WHERE user_email='invite@example.test'`)
      await tx.query(`UPDATE app_users SET status='active' WHERE email='invite@example.test'`)
    })
    assert.deepEqual(await control(), baseline)
  })
  await check('app-only role module permission trash restore and organization membership changes work', async () => {
    await query(`UPDATE app_user_organization_memberships SET role='admin',permissions='{"viewCrm":false}' WHERE user_email='invite@example.test'`)
    await query(`UPDATE app_users SET role='admin',permissions='{"viewCrm":false}' WHERE email='invite@example.test'`)
    await transaction(async tx => {
      await tx.query(`UPDATE app_user_organization_memberships SET status='disabled',trashed_at=now() WHERE user_email='invite@example.test'`)
      await tx.query(`UPDATE app_users SET status='disabled' WHERE email='invite@example.test'`)
    })
    await transaction(async tx => {
      await tx.query(`UPDATE app_user_organization_memberships SET status='active',trashed_at=NULL WHERE user_email='invite@example.test'`)
      await tx.query(`UPDATE app_users SET status='active' WHERE email='invite@example.test'`)
      await tx.query(`INSERT INTO app_user_organization_memberships VALUES('invite@example.test',$1,'active','member','{}',NULL)`, [id(3)])
      await tx.query(`UPDATE app_users SET organization_id=$1 WHERE email='invite@example.test'`, [id(3)])
    })
    assert.deepEqual(await control(), baseline)
  })
  await check('unrelated workspace grants cannot affect a different workspace pipeline snapshot', async () => {
    await query(`INSERT INTO app_user_organization_memberships VALUES('unmapped-member@example.test',$1,'active','member','{}',NULL)`, [id(3)])
    await query(`UPDATE app_user_organization_memberships SET status='disabled' WHERE user_email='unmapped-member@example.test' AND organization_id=$1`, [id(3)])
    await assert.rejects(() => query(`UPDATE app_user_organization_memberships SET status='disabled' WHERE user_email='unmapped-member@example.test' AND organization_id=$1`, [id(1)]), refused)
    assert.deepEqual(await control(), baseline)
  })
  await check('native mapped users ownership members duplicate mapping and identity clearing remain fenced', async () => {
    for (const email of ['owner@example.test', 'reader@example.test', 'unmapped-member@example.test', 'unmapped-owner@example.test', 'native-unreferenced@example.test']) {
      await assert.rejects(() => query(`UPDATE app_users SET status='disabled' WHERE email=$1`, [email]), refused)
      await assert.rejects(() => query(`UPDATE app_user_organization_memberships SET status='disabled' WHERE user_email=$1`, [email]), refused)
    }
    await assert.rejects(() => query(`UPDATE app_users SET suitecrm_user_id=$1 WHERE email='plain@example.test'`, [id(11)]), refused)
    await assert.rejects(() => query(`UPDATE app_users SET suitecrm_user_id=NULL WHERE email='native-unreferenced@example.test'`), refused)
    await assert.rejects(() => query(`INSERT INTO app_users(email,status,suitecrm_user_id) VALUES('alias@example.test','active',$1)`, [id(11)]), refused)
    // Non-CRM keys are still covered by complete principal snapshot pins. Do
    // not describe this narrow exception as general mapped-user settings
    // support, or silently loosen JSON permission changes by field name.
    await assert.rejects(() => query(`UPDATE app_users SET permissions='{"viewShipping":true}' WHERE email='reader@example.test'`), refused)
    await assert.rejects(() => query(`UPDATE app_user_organization_memberships SET permissions='{"viewShipping":true}' WHERE user_email='reader@example.test'`), refused)
    assert.deepEqual((await query(`SELECT permissions FROM app_users WHERE email='reader@example.test'`)).rows[0].permissions,{})
    assert.equal((await query(`SELECT count(*) FROM app_users WHERE status='disabled'`)).rows[0].count, '0')
  })
  await check('profile metadata and verified login alias preserve canonical native mapping', async () => {
    await query(`UPDATE app_users SET display_name='Renamed',updated_at=now() WHERE email='reader@example.test'`)
    await query(`INSERT INTO app_user_login_addresses(user_email,login_email) VALUES('reader@example.test','new-login@example.test')`)
    assert.equal((await query(`SELECT suitecrm_user_id FROM app_users WHERE email='reader@example.test'`)).rows[0].suitecrm_user_id, id(12))
    assert.deepEqual(await control(), baseline)
  })
  await check('new-user invitation rollback cascades safely while mapped and pipeline user deletion rolls back', async () => {
    await query(`DELETE FROM app_users WHERE email='invite@example.test'`)
    assert.equal((await query(`SELECT count(*) FROM app_user_organization_memberships WHERE user_email='invite@example.test'`)).rows[0].count, '0')
    for (const email of ['reader@example.test', 'native-unreferenced@example.test', 'unmapped-member@example.test', 'unmapped-owner@example.test']) {
      await assert.rejects(() => query('DELETE FROM app_users WHERE email=$1', [email]), refused)
      assert.equal((await query('SELECT count(*) FROM app_users WHERE email=$1', [email])).rows[0].count, '1')
    }
    assert.deepEqual(await control(), baseline)
  })
  await check('pipeline creation sharing removal ownership and bulk destructive operations remain fenced', async () => {
    for (const [sql, params] of [
      ['INSERT INTO pipeline_spaces VALUES($1,$2,$3,false)', [id(5), 'plain@example.test', id(1)]],
      ['INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role) VALUES($1,$2,$3)', [id(2), 'plain@example.test', 'viewer']],
      ['DELETE FROM pipeline_space_members WHERE pipeline_id=$1', [id(2)]],
      ['UPDATE pipeline_spaces SET owner_email=$1 WHERE id=$2', ['plain@example.test', id(2)]],
      ['TRUNCATE app_user_organization_memberships', []],
    ]) await assert.rejects(() => query(sql, params), /Native (?:Email )?authority/)
    await assert.rejects(() => query(`UPDATE app_users SET status='disabled' WHERE email IN ('plain@example.test','reader@example.test')`), refused)
    assert.equal((await query(`SELECT status FROM app_users WHERE email='plain@example.test'`)).rows[0].status, 'invited')
  })
  await check('the original control-first lock serializes app-only changes rather than bypassing admission fences', async () => {
    const held = await pool.connect(), waiting = await pool.connect()
    try {
      await held.query('BEGIN')
      await held.query('SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
      await waiting.query('BEGIN')
      await waiting.query(`SET LOCAL lock_timeout='200ms'`)
      await assert.rejects(() => waiting.query(`UPDATE app_users SET status='active' WHERE email='plain@example.test'`), error => error.code === '55P03')
      await waiting.query('ROLLBACK')
      await held.query('COMMIT')
      await query(`UPDATE app_users SET status='active' WHERE email='plain@example.test'`)
    } finally { await held.query('ROLLBACK'); await waiting.query('ROLLBACK'); held.release(); waiting.release() }
    assert.deepEqual(await control(), baseline)
  })
  console.log(`PASS ${count} actual PostgreSQL app-only lifecycle fence checks; synthetic activation, no native or production proof`)
} finally {
  try { if (pool) await pool.end() } finally {
    if (started) execFileSync('docker', disposablePostgresDockerCleanupArgs(container), { timeout: 30000, stdio: 'pipe' })
  }
}
