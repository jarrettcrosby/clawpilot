#!/usr/bin/env node
// Actual migration 0381 and actual application claim/dispatch SQL against an
// isolated PostgreSQL fixture. No native Users PATCH, provider or deployment proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'

assert.deepEqual(process.argv.slice(2), ['--postgres'], 'Explicit --postgres required')
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript'), { Pool } = require('pg')
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const crmSource = source('app_src/lib/persistence/crm.ts')
const ast = ts.createSourceFile('crm.ts', crmSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const declarations = ['nativeEmailOutboxUnresolvedGuardSql', 'lockNativeEmailPublicationModeWithClient',
  'nativeEmailOutboxTouchesEmail', 'claimSuiteCrmOutboxInPostgres', 'mayDispatchSuiteCrmUserIdentityInPostgres']
  .map(name => {
    const node = ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name && value.body)
    assert.ok(node, `Actual ${name} must exist`)
    return node.getText(ast)
  }).join('\n')
const compiled = ts.transpileModule(declarations, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
function application(withTransaction) {
  const module = { exports: {} }
  // No known CRM aggregate is used in this fixture: unrelated Notes work still
  // exercises actual claim SQL, without inventing a provider or entity writer.
  new Function('module', 'exports', 'crypto', 'withTransaction', 'ENTITY_TABLE', compiled)(
    module, module.exports, crypto, withTransaction, {})
  return module.exports
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const container = `clawpilot-identity-guard-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
const image = process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16'
assert.match(image, /^pgvector\/pgvector:pg(?:16|18)$/u, 'Use an already cached approved image')
const checks = []
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`) }
const activateSql = `UPDATE crm_native_email_publication_control SET enabled=true,
  verified_generation=generation,native_policy_fingerprint=$1,activation_receipt_hash=$2 WHERE singleton`
const activateParams = ['1'.repeat(64), '2'.repeat(64)] // Synthetic SQL shape only; not an approved native receipt.
const barrierError = error => error.code === '55000' && /all legacy identity work/.test(error.message)
let pool, started = false
try {
  execFileSync('docker', disposablePostgresDockerArgs(['run', '--rm', '-d', '--name', container, '--pull', 'never',
    '-e', 'POSTGRES_PASSWORD=identity_fixture', '-e', 'POSTGRES_DB=identity_fixture', '-p', '127.0.0.1::5432', image]),
  { timeout: 60000, stdio: 'pipe' }); started = true
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 10000 })
    .match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port)
  pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'identity_fixture',
    database: 'identity_fixture', ssl: false, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 10000 })
  const deadline = Date.now() + 30000
  while (true) {
    try { await pool.query('SELECT 1'); break } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  assert.equal((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, '0')
  const query = (sql, params) => pool.query(sql, params)
  const transaction = async fn => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  // A rolled-back fixture scope, not a runtime reset or trigger bypass.
  const rolledBack = async fn => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); return await fn(client) }
    finally { try { await client.query('ROLLBACK') } finally { client.release() } }
  }
  const insert = async (client, n, status, identity = true, target = 'suitecrm') => {
    const aggregateId = identity ? `identity-${n}@example.test` : id(1000 + n)
    const payload = identity ? { localId: aggregateId, suiteCrmUserId: id(2000 + n), username: `gu${1000000 + n}`,
      referenceCode: `gu${1000000 + n}` } : { localId: aggregateId, entity: 'fixture_notes', suiteCrmModule: 'Notes' }
    await client.query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,operation,target_system,payload,status,
      lock_token,locked_at,idempotency_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
    [id(n), identity ? 'app_users' : 'fixture_notes', aggregateId, identity ? 'upsert_user_identity' : 'upsert_record',
      target, JSON.stringify(payload), status, status === 'processing' ? `lease-${n}` : null,
      status === 'processing' ? new Date() : null, `fixture-${n}`])
    return { id: id(n), aggregateType: identity ? 'app_users' : 'fixture_notes', aggregateId,
      operation: identity ? 'upsert_user_identity' : 'upsert_record', payload, lockToken: `lease-${n}`,
      idempotencyKey: `fixture-${n}`, attempts: 0 }
  }
  const control = async client => (await client.query('SELECT * FROM crm_native_email_publication_control WHERE singleton')).rows[0]
  const rows = async client => (await client.query('SELECT * FROM sync_outbox ORDER BY id')).rows
  await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid);
    CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean DEFAULT false);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean DEFAULT false);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,shared_by text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,
      trashed_at timestamptz,PRIMARY KEY(user_email,organization_id));
    CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,suitecrm_module text,
      suitecrm_synced_at timestamptz,sync_status text DEFAULT 'pending',sync_error text,metadata jsonb DEFAULT '{}',updated_at timestamptz DEFAULT now());
    CREATE TABLE sync_outbox(id uuid PRIMARY KEY,aggregate_type text,aggregate_id text,operation text,target_system text,payload jsonb,
      status text DEFAULT 'queued',attempts integer DEFAULT 0,idempotency_key text,lock_token text,locked_at timestamptz,
      available_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
      processed_at timestamptz,last_error text,UNIQUE(target_system,idempotency_key));`)
  for (const name of ['0375_crm_native_email_publication_admission.sql', '0376_crm_native_email_publication_work_context.sql',
    '0377_crm_native_email_authority_transitions.sql', '0378_crm_native_email_capability_policies.sql',
    '0379_crm_native_email_app_only_lifecycle.sql', '0381_crm_native_email_identity_quiescence.sql']) {
    await transaction(client => client.query(source(`db/migrations/${name}`)))
  }
  const api = application(transaction)
  await check('installation starts disabled and does not create native or queue evidence', async () => {
    assert.equal((await control(pool)).enabled, false)
    assert.equal((await control(pool)).activation_receipt_hash, null)
    assert.deepEqual(await rows(pool), [])
  })
  for (const [index, status] of ['queued', 'failed', 'processing', 'dead'].entries()) {
    await check(`${status} identity work blocks activation without changing queue or control`, () => rolledBack(async client => {
      await insert(client, index + 1, status)
      if (status === 'processing') await client.query("UPDATE sync_outbox SET locked_at=now()-interval '1 day'")
      const before = await rows(client), original = await control(client)
      await client.query('SAVEPOINT attempted_activation')
      await assert.rejects(client.query(activateSql, activateParams), barrierError)
      await client.query('ROLLBACK TO SAVEPOINT attempted_activation')
      assert.deepEqual(await rows(client), before)
      assert.deepEqual(await control(client), original)
    }))
  }
  await check('only succeeded identities permit activation; unrelated queued work is not a blocker', () => rolledBack(async client => {
    await insert(client, 10, 'succeeded')
    await insert(client, 11, 'queued', false)
    await insert(client, 12, 'queued', true, 'fixture_other_target')
    const before = await rows(client)
    await client.query(activateSql, activateParams)
    assert.equal((await control(client)).enabled, true)
    assert.deepEqual(await rows(client), before)
  }))
  await check('disabled dispatch requires exact owned processing payload, not just a stale job ID', () => rolledBack(async client => {
    const item = await insert(client, 20, 'processing')
    const scoped = application(fn => fn(client))
    assert.equal(await scoped.mayDispatchSuiteCrmUserIdentityInPostgres(item), true)
    for (const changed of [{ ...item, lockToken: 'another-lease' },
      { ...item, payload: { ...item.payload, username: 'gu9999999' } }]) {
      await assert.rejects(scoped.mayDispatchSuiteCrmUserIdentityInPostgres(changed), /claim changed/)
    }
  }))
  await check('concurrent claim-first activation waits on control and then sees the committed identity lease', async () => {
    await insert(pool, 30, 'queued')
    const claimant = await pool.connect(), activator = await pool.connect()
    let activation
    try {
      await claimant.query('BEGIN')
      const claimed = await application(fn => fn(claimant)).claimSuiteCrmOutboxInPostgres()
      assert.deepEqual(claimed.map(value => value.id), [id(30)])
      const pid = (await activator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      // Capture rejection immediately so a test failure cannot leave an
      // unhandled background query. pg_stat_activity proves an actual DB wait.
      activation = activator.query(activateSql, activateParams).then(value => ({ value }), error => ({ error }))
      const until = Date.now() + 3000
      let blocked = false
      while (Date.now() < until) {
        const state = (await query('SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]
        if (state?.wait_event_type === 'Lock' && state.blockers.length > 0) { blocked = true; break }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.ok(blocked, 'Actual concurrent activation must wait on the control-first claim')
      await claimant.query('COMMIT')
      const outcome = await activation
      assert.ok(outcome.error && barrierError(outcome.error), 'Committed identity lease must prevent activation')
      assert.equal((await control(pool)).enabled, false)
      assert.equal((await rows(pool)).find(value => value.id === id(30)).status, 'processing')
    } finally {
      try { await claimant.query('ROLLBACK'); if (activation) await activation }
      finally { claimant.release(); activator.release() }
    }
    // Test cleanup of a precisely identified synthetic row only; not recovery.
    await query('DELETE FROM sync_outbox WHERE id=$1', [id(30)])
  })
  await check('concurrent activation-first claim waits, then leaves newly queued identity untouched', async () => {
    const activator = await pool.connect(), claimant = await pool.connect()
    let claim
    try {
      await activator.query('BEGIN')
      await activator.query(activateSql, activateParams)
      // Enqueue itself does not touch native policy: a job created after the
      // activation barrier is safe only if its later claim observes enabled.
      await insert(pool, 40, 'queued')
      await insert(pool, 41, 'queued', false)
      const before = (await rows(pool)).find(value => value.id === id(40))
      const pid = (await claimant.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await claimant.query('BEGIN')
      claim = application(fn => fn(claimant)).claimSuiteCrmOutboxInPostgres()
        .then(value => ({ value }), error => ({ error }))
      const until = Date.now() + 3000
      let blocked = false
      while (Date.now() < until) {
        const state = (await query('SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]
        if (state?.wait_event_type === 'Lock' && state.blockers.length > 0) { blocked = true; break }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.ok(blocked, 'Actual claim must wait on uncommitted activation')
      await activator.query('COMMIT')
      const outcome = await claim
      assert.ifError(outcome.error)
      await claimant.query('COMMIT')
      assert.deepEqual(outcome.value.map(value => value.id), [id(41)])
      assert.deepEqual((await rows(pool)).find(value => value.id === id(40)), before)
      assert.equal((await control(pool)).enabled, true)
    } finally {
      try { await activator.query('ROLLBACK'); if (claim) await claim; await claimant.query('ROLLBACK') }
      finally { activator.release(); claimant.release() }
    }
  })
  await check('enabled claim does not burn held identity attempts and dispatch rechecks already-claimed work', async () => {
    const alreadyClaimed = await insert(pool, 50, 'processing')
    const before = await rows(pool)
    assert.deepEqual(await api.claimSuiteCrmOutboxInPostgres(), [])
    assert.deepEqual(await rows(pool), before)
    assert.equal(await api.mayDispatchSuiteCrmUserIdentityInPostgres(alreadyClaimed), false)
    assert.deepEqual(await rows(pool), before)
  })
  console.log(`PASS ${checks.length} real PostgreSQL identity-quiescence groups; synthetic identities and activation receipt only`)
  console.log('BOUNDARY: queue completion does not prove a timed-out native PATCH stopped; offline/drained native activation and current policy readback remain required')
} finally {
  try { if (pool) await pool.end() }
  finally { if (started) execFileSync('docker', disposablePostgresDockerCleanupArgs(container), { timeout: 30000, stdio: 'pipe' }) }
}
