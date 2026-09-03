#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { waitForPostgres } from './test-commerce-order-revisions-postgres.mjs'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = require('pg')
const ts = require('typescript')
const sourceRef = process.argv[2] === '--source-ref' ? process.argv[3] : null
assert.ok(process.argv.length === 2 || (sourceRef && process.argv.length === 4))

// Compile the actual production functions, not copied lock SQL. The small
// schema isolates the account/control interleaving; full migration/authority
// acceptance remains in test-commerce-store-sync-controls-postgres.mjs.
function productionFunctions(path, names, dependencies) {
  const source = sourceRef
    ? execFileSync('git', ['show', `${sourceRef}:${path}`], { encoding: 'utf8' })
    : readFileSync(path, 'utf8')
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const declarations = names.map((name) => {
    const declaration = parsed.statements.find((entry) => (
      (ts.isFunctionDeclaration(entry) || ts.isClassDeclaration(entry))
      && entry.name?.text === name
    ))
    assert.ok(declaration, `${path} must declare ${name}`)
    return declaration.getText(parsed).replace(/^export\s+/u, '')
  }).join('\n')
  const compiled = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const context = { Date, Error, JSON, Number, Object, String, ...dependencies }
  vm.runInNewContext(`${compiled}\nglobalThis.subjects = {${names.join(',')}}`, context)
  return context.subjects
}

const ids = {
  organization: randomUUID(), account: randomUUID(), pipeline: randomUUID(),
  lease: randomUUID(), intent: randomUUID(), attempt: randomUUID(),
  token: randomUUID(), session: randomUUID(),
}
const fingerprint = 'a'.repeat(64)
const requestHash = 'b'.repeat(64)
const queryHash = 'c'.repeat(64)
const boundary = new Error('Production lock/authority boundary reached')
const accountInput = { organizationId: ids.organization, accountGlobalId: 'gia1234567', forUpdate: true }
const lease = (kind = 'catalog_intake', authority = 'automatic') => ({
  id: ids.lease, authorityKind: authority, readKind: kind,
  intentFingerprintSha256: fingerprint, controlRevision: 1, activationRevision: 1,
})

async function seed(pool, kind, authority = 'automatic') {
  await pool.query('UPDATE operations_commerce_store_sync_controls SET desired_state = $1', ['running'])
  await pool.query("UPDATE operations_activation_scopes SET state = 'active'")
  await pool.query('DELETE FROM operations_commerce_store_sync_read_leases')
  await pool.query(`INSERT INTO operations_commerce_store_sync_read_leases
    (id, organization_id, integration_account_id, authority_kind, read_kind,
     intent_fingerprint_sha256, control_revision, activation_revision, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,1,1,clock_timestamp() + interval '1 hour')`,
  [ids.lease, ids.organization, ids.account, authority, kind, fingerprint])
}

function loadSubjects(withTransaction) {
  const store = productionFunctions('app_src/lib/persistence/commerceStoreSync.ts', [
    'CommerceStoreSyncProviderReadFenceError', 'CommerceStoreSyncProviderReadLeaseError',
    'assertCommerceStoreSyncProviderReadLeaseCurrentWithClient', 'acquireProviderReadLease',
  ], {
    withTransaction, randomUUID, PROVIDER_READ_LEASE_SECONDS: 60,
    commerceStoreSyncProviderReadIntentFingerprint: () => fingerprint,
  })
  const intake = productionFunctions('app_src/lib/persistence/commerceIntake.ts', [
    'resolveAccount', 'lockCommerceStoreSyncState', 'requireCommerceStoreSyncRunning',
    'requireCommerceProviderReadAuthority',
    'captureCommerceIntakeProviderReadInPostgres',
  ], {
    ...store, withTransaction,
    encryptCommerceIntakeReadResult: () => ({}),
    intakeError(code, message) { throw Object.assign(new Error(message), { code }) },
  })
  const history = productionFunctions('app_src/lib/persistence/commerceOrderSync.ts', [
    'appendCommerceOrderBackfillPageInPostgres', 'appendCommerceOrderWorkbenchExactReadInPostgres',
  ], {
    ...store, withTransaction,
    BACKFILL_GLOBAL_ID_PATTERN: /^gcob(?:[0-9]{7}|[0-9a-v]{12})$/u,
    UUID_PATTERN: /^[0-9a-f-]{36}$/u,
    count: (value) => value,
    normalizeObservation: (value) => value,
    assertCommerceOrderSyncObservationKinds() {},
    ORDER_READ_ACCOUNT_SQL: "account.status = 'active'",
    STORE_SYNC_RUNNING_SQL: 'operations_commerce_store_sync_is_running(account.organization_id, account.id)',
    CommerceOrderSyncError: class extends Error {
      constructor(code, message) { super(message); this.code = code }
    },
    appendObservationsWithClient: async () => { throw boundary },
  })
  return { ...store, ...intake, ...history }
}

function invoke(subjects, kind, providerLease) {
  if (kind === 'intake capture') return subjects.captureCommerceIntakeProviderReadInPostgres({
    runtime: { organizationId: ids.organization, integrationAccountId: ids.account,
      globalId: 'gia1234567', provider: 'shopify' },
    actorEmail: 'lock-order-test@clawpilot.com', idempotencyKey: 'lock-order-read',
    readIntentId: ids.intent, providerAttemptId: ids.attempt, leaseToken: ids.token,
    requestHash, result: {}, redactedResponse: {}, providerReadLease: providerLease,
  })
  if (kind === 'history append') return subjects.appendCommerceOrderBackfillPageInPostgres({
    job: { id: ids.session, globalId: 'gcob1234567', organizationId: ids.organization,
      integrationAccountId: ids.account, accountGlobalId: 'gia1234567', provider: 'shopify',
      lockToken: ids.token, credentialGeneration: 1, policyRevision: 1, queryHash,
      sessionKind: 'historical_backfill', requestedFrom: '2026-01-01T00:00:00.000Z',
      requestedThrough: '2026-09-01T00:00:00.000Z', pageCount: 0, maxPages: 100 },
    providerReadLease: providerLease, pageNumber: 1, providerRecordsSeen: 0,
    observations: [], hasNextPage: false, nextProviderCursor: null,
    readAllOrdersScopeObserved: false, returnHistoryScopeObserved: false,
  })
  if (kind === 'exact history') return subjects.appendCommerceOrderWorkbenchExactReadInPostgres({
    organizationId: ids.organization, integrationAccountId: ids.account,
    accountGlobalId: 'gia1234567', provider: 'shopify', credentialGeneration: 1,
    externalOrderId: '123', providerReadLease: providerLease,
    observation: { observationKind: 'manual_exact_read', externalOrderId: '123', providerReadCount: 3 },
  })
  return subjects.acquireProviderReadLease({ organizationId: ids.organization,
    integrationAccountId: ids.account, authorityKind: 'automatic', readKind: 'order_history',
    intentKey: 'lock-order-new-lease', acquiredBy: 'lock-order-test@clawpilot.com' })
}

async function candidate(pool, kind, providerLease, onPid = () => {}) {
  const subjects = loadSubjects(async (work) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL deadlock_timeout = '100ms'")
      await client.query("SET LOCAL lock_timeout = '5s'")
      onPid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      return await work({ query: async (sql, values) => {
        // Stop only after the actual intake account/control/lease checks have
        // completed; this regression test does not exercise evidence writes.
        if (/UPDATE operations_commerce_provider_attempts/u.test(sql)) throw boundary
        return client.query(sql, values)
      } })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  try {
    await invoke(subjects, kind, providerLease)
    assert.equal(kind, 'lease acquisition')
    return { ok: true }
  } catch (error) {
    return error === boundary ? { ok: true } : { ok: false, code: error.code, message: error.message }
  }
}

async function waitUntilBlocked(pool, pid, blockerPid) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const row = (await pool.query(`SELECT wait_event_type,
      $2::integer = ANY(pg_blocking_pids(pid)) AS blocked_by_test
      FROM pg_stat_activity WHERE pid = $1`, [pid, blockerPid])).rows[0]
    if (row?.wait_event_type === 'Lock' && row.blocked_by_test) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Candidate did not reach its expected account-lock wait')
}

async function verifyPair(pool, kind) {
  const authority = kind === 'exact history' ? 'manual_read_only' : 'automatic'
  const readKind = kind === 'intake capture' ? 'catalog_intake' : 'order_history'
  await seed(pool, readKind, authority)
  const blocker = await pool.connect()
  let pending
  try {
    await blocker.query('BEGIN')
    await blocker.query("SET LOCAL deadlock_timeout = '100ms'")
    await blocker.query("SET LOCAL lock_timeout = '5s'")
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const subjects = loadSubjects(() => { throw new Error('Unexpected nested transaction') })
    // This is the production intake reservation/staging account lock, not a
    // synthetic reversed transaction. Hold it until the competitor blocks.
    await subjects.resolveAccount(blocker, accountInput)
    let markPid
    const ready = new Promise((resolve) => { markPid = resolve })
    pending = candidate(pool, kind, lease(readKind, authority), markPid)
    await waitUntilBlocked(pool, await ready, blockerPid)
    let blockerError
    try {
      await subjects.lockCommerceStoreSyncState(blocker, {
        organizationId: ids.organization, integrationAccountId: ids.account,
      })
    } catch (error) { blockerError = error.code || error.message }
    await blocker.query('ROLLBACK')
    const outcome = await pending
    return { kind, blockerError, ...outcome }
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
    if (pending) await pending
  }
}

async function schema(pool) {
  await pool.query(`
    CREATE TABLE operations_integration_accounts (id uuid PRIMARY KEY, organization_id uuid,
      global_id text, provider text, environment text, integration_type text, status text,
      commerce_credential_generation integer, external_account_id text);
    CREATE TABLE operations_activation_scopes (organization_id uuid PRIMARY KEY,
      state text, revision integer, data_pipeline_id uuid);
    CREATE TABLE pipeline_spaces (id uuid PRIMARY KEY, workspace_organization_id uuid);
    CREATE TABLE operations_commerce_store_sync_controls (organization_id uuid,
      integration_account_id uuid, desired_state text, explicit_choice boolean,
      revision integer, reason text, PRIMARY KEY(organization_id,integration_account_id));
    CREATE TABLE operations_commerce_credentials (organization_id uuid, integration_account_id uuid,
      credential_version integer, external_account_id text, auth_mode text, verification_status text);
    CREATE TABLE operations_commerce_store_sync_read_leases (id uuid PRIMARY KEY,
      organization_id uuid, integration_account_id uuid, authority_kind text, read_kind text,
      intent_fingerprint_sha256 text, control_revision integer, activation_revision integer,
      expires_at timestamptz, released_at timestamptz, release_reason text, captured_at timestamptz,
      acquired_by text, acquired_at timestamptz, heartbeat_at timestamptz);
    CREATE TABLE operations_commerce_intake_read_intents (id uuid PRIMARY KEY,
      organization_id uuid, integration_account_id uuid, request_hash text,
      provider_read_authority text, idempotency_key text, provider_attempt_id uuid,
      intent_state text, lease_token uuid, lease_expires_at timestamptz);
    CREATE TABLE operations_commerce_order_sync_policies (organization_id uuid,
      integration_account_id uuid, authority text, historical_observation_enabled boolean,
      continuous_observation_enabled boolean, revision integer);
    CREATE TABLE operations_commerce_order_backfill_sessions (id uuid PRIMARY KEY, global_id text,
      organization_id uuid, integration_account_id uuid, provider text, credential_generation integer,
      query_hash text, page_count integer, lock_token uuid, session_kind text, policy_revision integer,
      requested_from timestamptz, requested_through timestamptz, read_all_orders_scope_observed boolean,
      return_history_state text, status text, lease_expires_at timestamptz);
    CREATE FUNCTION operations_commerce_store_sync_is_running(uuid,uuid) RETURNS boolean
      LANGUAGE sql STABLE AS 'SELECT desired_state = ''running'' FROM operations_commerce_store_sync_controls
        WHERE organization_id = $1 AND integration_account_id = $2';
    CREATE FUNCTION operations_commerce_store_sync_effective_reason(uuid,uuid) RETURNS text
      LANGUAGE sql STABLE AS 'SELECT CASE WHEN operations_commerce_store_sync_is_running($1,$2)
        THEN ''STORE_SYNC_RUNNING'' ELSE ''STORE_SYNC_EXPLICIT_PAUSED'' END';
  `)
  const authoritySql = readFileSync('db/migrations/0298_operations_commerce_store_sync_controls.sql', 'utf8')
    .match(/CREATE OR REPLACE FUNCTION operations_commerce_provider_read_authority_is_current\([\s\S]*?\$\$;/u)?.[0]
  assert.ok(authoritySql, 'Use the actual automatic/manual provider-read authority function')
  await pool.query(authoritySql)
  await pool.query(`INSERT INTO operations_integration_accounts VALUES
    ($1,$2,'gia1234567','shopify','sandbox','commerce','active',1,'shop');
  `, [ids.account, ids.organization])
  await pool.query('INSERT INTO operations_activation_scopes VALUES ($1,$2,1,$3)',
    [ids.organization, 'active', ids.pipeline])
  await pool.query('INSERT INTO pipeline_spaces VALUES ($1,$2)', [ids.pipeline, ids.organization])
  await pool.query("INSERT INTO operations_commerce_store_sync_controls VALUES ($1,$2,'running',true,1,'test')",
    [ids.organization, ids.account])
  await pool.query("INSERT INTO operations_commerce_credentials VALUES ($1,$2,1,'shop','shopify_client_credentials','verified')",
    [ids.organization, ids.account])
  await pool.query(`INSERT INTO operations_commerce_intake_read_intents VALUES
    ($1,$2,$3,$4,'automatic','lock-order-read',$5,'reading',$6,clock_timestamp()+interval '1 hour')`,
  [ids.intent, ids.organization, ids.account, requestHash, ids.attempt, ids.token])
  await pool.query("INSERT INTO operations_commerce_order_sync_policies VALUES ($1,$2,'provider',true,true,1)",
    [ids.organization, ids.account])
  await pool.query(`INSERT INTO operations_commerce_order_backfill_sessions VALUES
    ($1,'gcob1234567',$2,$3,'shopify',1,$4,0,$5,'historical_backfill',1,
      '2026-01-01','2026-09-01',NULL,'unknown','processing',clock_timestamp()+interval '1 hour')`,
  [ids.session, ids.organization, ids.account, queryHash, ids.token])
}

const container = `clawpilot-order-lock-test-${process.pid}-${randomUUID().slice(0, 8)}`
let pool
try {
  execFileSync('docker', ['run', '--rm', '-d', '--name', container,
    '-e', 'POSTGRES_PASSWORD=lock_order_test', '-e', 'POSTGRES_DB=lock_order_test',
    '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16'], { timeout: 180_000, stdio: 'pipe' })
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).match(/:(\d+)\s*$/u)?.[1]
  assert.ok(port)
  const url = `postgresql://postgres:lock_order_test@127.0.0.1:${port}/lock_order_test`
  await waitForPostgres(url)
  pool = new Pool({ connectionString: url, max: 4, statement_timeout: 10_000 })
  await schema(pool)
  const outcomes = []
  for (const kind of ['intake capture', 'history append', 'exact history', 'lease acquisition']) {
    outcomes.push(await verifyPair(pool, kind))
  }
  console.log(JSON.stringify({ source: sourceRef || 'working tree', interleavings: outcomes }, null, 2))
  assert.ok(outcomes.every((row) => row.ok && !row.blockerError), 'All account-first interleavings must complete without deadlock')
  for (const kind of ['intake capture', 'history append', 'exact history']) {
    const authority = kind === 'exact history' ? 'manual_read_only' : 'automatic'
    const readKind = kind === 'intake capture' ? 'catalog_intake' : 'order_history'
    await seed(pool, readKind, authority)
    const stale = await candidate(pool, kind, { ...lease(readKind, authority), controlRevision: 2 })
    assert.equal(stale.code, 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST', `${kind} must reject a stale lease`)
    // Manual exact reads intentionally have different authority from
    // automatic sync. Freeze activation to revoke their actual authority.
    await pool.query(kind === 'exact history'
      ? "UPDATE operations_activation_scopes SET state='frozen'"
      : "UPDATE operations_commerce_store_sync_controls SET desired_state='paused'")
    const paused = await candidate(pool, kind, lease(readKind, authority))
    assert.equal(paused.code, 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST', `${kind} must reject lost authority`)
    assert.equal((await pool.query('SELECT captured_at FROM operations_commerce_store_sync_read_leases')).rows[0].captured_at, null)
  }
  console.log('Commerce order account/control lock ordering and fail-closed lease regression passed')
} finally {
  if (pool) await pool.end()
  spawnSync('docker', ['stop', '-t', '1', container], { timeout: 30_000, stdio: 'pipe' })
}
