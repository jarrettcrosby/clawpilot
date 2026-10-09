#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import {
  disposablePostgresDockerArgs,
  disposablePostgresDockerCleanupArgs,
} from './lib/disposable-postgres-docker.mjs'

const require = createRequire(resolve('app_src/package.json'))
const ts = require('typescript')
const pipelineId = '11111111-2222-4333-8444-555555555555'
const secondPipelineId = '22222222-3333-4444-8555-666666666666'
const sheetId = 'owned-managed-sheet'
const pipelineSource = readFileSync(resolve('app_src/lib/persistence/pipeline.ts'), 'utf8')
const crmSource = readFileSync(resolve('app_src/lib/persistence/crm.ts'), 'utf8')

function loadSource(source, postgres) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, process: { env: {} }, console, Buffer, URL,
    require: (name) => name === '@/lib/persistence/postgres' ? postgres
      : name === 'crypto' || name === 'node:crypto' ? require(name) : {},
  })
  return module.exports
}

function managedPipeline(overrides = {}) {
  return {
    id: pipelineId, name: 'My pipeline', owner_email: 'owner@example.test',
    provisioning_status: 'provisioning', provisioning_error: null,
    provisioning_requested_at: '2026-10-09T12:00:00Z',
    provisioning_started_at: '2026-10-09T12:00:01Z',
    provisioning_last_attempted_at: '2026-10-09T12:00:01Z', provisioning_completed_at: null,
    drive_folder_id: 'owned-folder', provisioning_sheet_id: sheetId,
    google_service_account_email: 'clawpilot@example.iam.gserviceaccount.com',
    google_shared_drive_id: 'owned-shared-drive', sheet_id: null,
    short_link_id: '33333333-4444-4555-8666-777777777777', sync_enabled: false,
    ...overrides,
  }
}

function pipelineHarness(rows) {
  let state = { pipelines: rows, outboxes: {}, events: [] }
  let failInsert = false
  const observed = []
  async function execute(current, sql, values = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    observed.push(normalized)
    if (normalized.includes('WITH candidates AS')) return { rows: [] }
    if (normalized.startsWith('UPDATE sync_outbox') && normalized.includes('worker lease expired')) return { rows: [], rowCount: 0 }
    if (normalized.startsWith('SELECT') && normalized.includes('FROM pipeline_spaces')) {
      const pipeline = current.pipelines[values[0]]
      if (normalized.includes('AND sheet_id = $2')) {
        return { rows: pipeline?.sheet_id === values[1] && pipeline.sync_enabled ? [{ id: pipeline.id }] : [] }
      }
      return { rows: pipeline ? [pipeline] : [] }
    }
    if (normalized.startsWith('UPDATE pipeline_spaces') && normalized.includes('sheet_id = provisioning_sheet_id')) {
      Object.assign(current.pipelines[values[0]], {
        sheet_id: current.pipelines[values[0]].provisioning_sheet_id,
        sync_enabled: true, provisioning_status: 'ready', provisioning_error: null,
        provisioning_completed_at: '2026-10-09T12:00:02Z',
      })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('SELECT id::text, status FROM sync_outbox')) {
      const outbox = current.outboxes[values[0]]
      return { rows: outbox ? [{ id: outbox.id, status: outbox.status }] : [] }
    }
    if (normalized.startsWith('INSERT INTO sync_outbox')) {
      if (failInsert) throw new Error('simulated durable queue failure')
      const [aggregateType, aggregateId, operation, payload, key] = values
      const outbox = {
        id: `outbox-${Object.keys(current.outboxes).length + 1}`, status: 'queued', attempts: 0,
        aggregateType, aggregateId, operation, payload: JSON.parse(payload), key,
      }
      current.outboxes[key] = outbox
      return { rows: [{ id: outbox.id, status: outbox.status }] }
    }
    if (normalized.startsWith('UPDATE sync_outbox') && normalized.includes("status IN ('failed', 'dead')")) {
      const outbox = Object.values(current.outboxes).find((entry) => entry.id === values[0])
      assert.ok(outbox)
      Object.assign(outbox, { status: 'queued', attempts: 0, payload: JSON.parse(values[1]) })
      return { rows: [{ id: outbox.id, status: outbox.status }] }
    }
    if (normalized.startsWith('INSERT INTO audit_events')) {
      current.events.push(values)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unexpected test query: ${normalized}`)
  }
  const postgres = {
    query: (sql, values) => execute(state, sql, values),
    withTransaction: async (callback) => {
      const staged = structuredClone(state)
      const result = await callback({ query: (sql, values) => execute(staged, sql, values) })
      state = staged
      return result
    },
  }
  return {
    api: loadSource(pipelineSource, postgres), observed,
    state: () => state,
    failInsert: (value) => { failInsert = value },
  }
}

const harness = pipelineHarness({ [pipelineId]: managedPipeline() })
const completed = await harness.api.completePipelineProvisioningInPostgres(pipelineId)
assert.equal(completed.provisioningStatus, 'ready')
assert.equal(completed.sheetId, sheetId)
const key = `pipeline:${pipelineId}:crm-initial-projection:v1:${sheetId}`
const initial = harness.state().outboxes[key]
assert.equal(initial.operation, 'project_crm_workbook')
assert.equal(initial.aggregateId, pipelineId)
assert.equal(initial.payload.pipelineId, pipelineId)
assert.equal(initial.payload.sheetId, sheetId)
assert.equal(initial.payload.initialManagedWorkbook, true)
assert.ok(harness.observed.findIndex((sql) => sql.startsWith('UPDATE pipeline_spaces'))
  < harness.observed.findIndex((sql) => sql.startsWith('INSERT INTO sync_outbox')))

for (const status of ['queued', 'processing', 'succeeded']) {
  harness.state().outboxes[key].status = status
  const replay = await harness.api.enqueuePipelineInitialCrmProjectionInPostgres(pipelineId)
  assert.equal(replay.id, initial.id)
  assert.equal(replay.status, status)
  assert.equal(Object.keys(harness.state().outboxes).length, 1)
}
for (const status of ['failed', 'dead']) {
  Object.assign(harness.state().outboxes[key], { status, attempts: 5 })
  await harness.api.completePipelineProvisioningInPostgres(pipelineId)
  assert.equal(harness.state().outboxes[key].status, 'queued')
  assert.equal(harness.state().outboxes[key].attempts, 0)
  assert.equal(Object.keys(harness.state().outboxes).length, 1)
}

const rollback = pipelineHarness({ [pipelineId]: managedPipeline() })
rollback.failInsert(true)
await assert.rejects(rollback.api.completePipelineProvisioningInPostgres(pipelineId), /simulated durable queue failure/)
assert.equal(rollback.state().pipelines[pipelineId].sheet_id, null, 'binding rolls back if bootstrap cannot be queued')
assert.equal(rollback.state().pipelines[pipelineId].provisioning_status, 'provisioning')
rollback.failInsert(false)
await rollback.api.completePipelineProvisioningInPostgres(pipelineId)
assert.equal(Object.keys(rollback.state().outboxes).length, 1)

for (const overrides of [
  { provisioning_status: 'provisioning' }, { sync_enabled: false },
  { provisioning_sheet_id: 'different-sheet' }, { provisioning_completed_at: null },
  { drive_folder_id: null }, { google_service_account_email: null }, { google_shared_drive_id: null },
]) {
  const unsafe = pipelineHarness({ [pipelineId]: managedPipeline({
    provisioning_status: 'ready', sheet_id: sheetId, sync_enabled: true,
    provisioning_completed_at: '2026-10-09T12:00:02Z', ...overrides,
  }) })
  await assert.rejects(unsafe.api.enqueuePipelineInitialCrmProjectionInPostgres(pipelineId), /verified managed pipeline/)
  assert.equal(Object.keys(unsafe.state().outboxes).length, 0)
}
await assert.rejects(harness.api.enqueuePipelineInitialCrmProjectionInPostgres('not-a-pipeline'), /valid pipeline ID/)
await assert.rejects(harness.api.enqueuePipelineInitialCrmProjectionInPostgres(secondPipelineId), /not found/)

const separate = pipelineHarness({
  [pipelineId]: managedPipeline(),
  [secondPipelineId]: managedPipeline({ id: secondPipelineId, provisioning_sheet_id: 'second-managed-sheet' }),
})
await separate.api.completePipelineProvisioningInPostgres(pipelineId)
await separate.api.completePipelineProvisioningInPostgres(secondPipelineId)
assert.equal(Object.keys(separate.state().outboxes).length, 2)
assert.deepEqual(Object.values(separate.state().outboxes).map((entry) => entry.payload.pipelineId).sort(), [pipelineId, secondPipelineId].sort())

await harness.api.claimPipelineSyncOutboxInPostgres()
const claimSql = harness.observed.find((sql) => sql.includes('WITH candidates AS'))
assert.match(claimSql, /initialManagedWorkbook/)
assert.match(claimSql, /reconciliation\.payload->>'pipelineId' = candidate\.payload->>'pipelineId'/)
assert.match(claimSql, /reconciliation\.status <> 'succeeded'/)
assert.match(claimSql, /import_run\.pipeline_id::text = candidate\.payload->>'pipelineId'/)
assert.match(claimSql, /import_run\.direction = 'sheet_to_crm'/)
assert.match(claimSql, /ORDER BY import_run\.started_at DESC, import_run\.id DESC LIMIT 1/)
assert.match(claimSql, /attempts = outbox\.attempts \+ 1/, 'provider failure retry contract remains unchanged')

for (const test of [
  { importStatus: null, managed: true, unresolved: 0, ready: true },
  { importStatus: null, managed: false, unresolved: 0, ready: false },
  { importStatus: null, managed: true, unresolved: 1, ready: false },
  { importStatus: 'running', managed: true, unresolved: 0, ready: false },
  { importStatus: 'failed', managed: true, unresolved: 0, ready: false },
  { importStatus: 'succeeded', managed: false, unresolved: 0, ready: true },
  { importStatus: 'succeeded', managed: true, unresolved: 1, ready: false },
]) {
  const queries = []
  const crm = loadSource(crmSource, {
    query: async (sql, values) => {
      queries.push({ sql, values })
      return { rows: [{ unresolved: String(test.unresolved), import_status: test.importStatus, managed_workbook_ready: test.managed }] }
    },
  })
  assert.equal((await crm.readCrmWorkbookProjectionReadiness(pipelineId)).ready, test.ready, JSON.stringify(test))
  assert.deepEqual(Array.from(queries[0].values), [pipelineId])
  assert.match(queries[0].sql, /pipeline\.id = \$1::uuid/)
  assert.match(queries[0].sql, /pipeline\.sheet_id = pipeline\.provisioning_sheet_id/)
  assert.match(queries[0].sql, /pipeline\.provisioning_completed_at IS NOT NULL/)
  assert.match(queries[0].sql, /pipeline\.google_service_account_email IS NOT NULL/)
  assert.match(queries[0].sql, /pipeline\.google_shared_drive_id IS NOT NULL/)
}

console.log('PASS managed pipeline initial CRM projection: atomic bootstrap, tenant scope, replay/retry, import and dependency gates')

// Opt-in SQL integration fixture. It never reads .env, application credentials,
// provider resources, production data, or the full migration suite.
if (process.argv.includes('--postgres') || process.argv.includes('--native-postgres')) {
  const nativePostgres = process.argv.includes('--native-postgres')
  const { Pool } = require('pg')
  const container = `clawpilot-workbook-bootstrap-${process.pid}-${randomUUID().slice(0, 8)}`
  let started = false
  let nativeDirectory
  let nativeStartAttempted = false
  let pool
  try {
    let port
    if (nativePostgres) {
      nativeDirectory = mkdtempSync(join(tmpdir(), 'clawpilot-workbook-bootstrap-'))
      execFileSync('/opt/homebrew/bin/initdb', ['-D', join(nativeDirectory, 'data'), '-U', 'postgres',
        '--auth-local=trust', '--auth-host=trust', '--no-locale', '--encoding=UTF8'], { timeout: 30_000, stdio: 'pipe' })
      const server = createServer()
      port = await new Promise((resolvePort, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const selected = server.address().port
          server.close((error) => error ? reject(error) : resolvePort(selected))
        })
      })
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
      nativeStartAttempted = true
      execFileSync('/opt/homebrew/bin/pg_ctl', ['-D', join(nativeDirectory, 'data'), '-l', join(nativeDirectory, 'postgres.log'),
        '-o', `-p ${port} -h 127.0.0.1 -k ${quote(nativeDirectory)} -c shared_buffers=16MB -c max_connections=10`,
        '-w', '-t', '15', 'start'], { timeout: 20_000, stdio: 'pipe' })
      started = true
    } else {
      execFileSync('docker', disposablePostgresDockerArgs([
        'run', '--rm', '-d', '--name', container, '--pull', 'never',
        '-e', 'POSTGRES_PASSWORD=workbook_bootstrap_test', '-e', 'POSTGRES_DB=workbook_bootstrap_test',
        '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16',
      ], { environment: {
        ...process.env, CLAWPILOT_TEST_POSTGRES_MEMORY: '512m',
        CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE: '256m', CLAWPILOT_TEST_POSTGRES_CPUS: '1',
      } }), { timeout: 60_000, stdio: 'pipe' })
      started = true
      port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 10_000 })
        .match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
    }
    assert.ok(port, 'Disposable PostgreSQL must bind only to loopback')
    pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres',
      password: 'workbook_bootstrap_test', database: nativePostgres ? 'postgres' : 'workbook_bootstrap_test',
      ssl: false, max: 3, connectionTimeoutMillis: 1000, statement_timeout: 5000 })
    const deadline = Date.now() + 30_000
    while (true) {
      try { await pool.query('SELECT 1'); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
    }
    await pool.query(`
      CREATE TABLE pipeline_spaces (
        id uuid PRIMARY KEY, name text, owner_email text, provisioning_status text,
        provisioning_error text, provisioning_requested_at timestamptz,
        provisioning_started_at timestamptz, provisioning_last_attempted_at timestamptz,
        provisioning_completed_at timestamptz, drive_folder_id text, provisioning_sheet_id text,
        google_service_account_email text, google_shared_drive_id text, sheet_id text,
        short_link_id uuid, sync_enabled boolean, updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE sync_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), aggregate_type text, aggregate_id uuid,
        operation text, target_system text, payload jsonb, status text, attempts integer DEFAULT 0,
        idempotency_key text, last_error text, available_at timestamptz DEFAULT now(),
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        processed_at timestamptz, locked_at timestamptz, lock_token uuid
      );
      CREATE UNIQUE INDEX fixture_outbox_key ON sync_outbox (target_system, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE TABLE audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor text, event_type text,
        aggregate_type text, aggregate_id uuid, payload jsonb
      );
      CREATE TABLE crm_sync_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid REFERENCES pipeline_spaces(id),
        direction text, status text, started_at timestamptz DEFAULT now()
      );
    `)
    const postgres = {
      query: (sql, values) => pool.query(sql, values),
      withTransaction: async (callback) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await callback(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally { client.release() }
      },
    }
    const persistence = loadSource(pipelineSource, postgres)
    const crm = loadSource(crmSource, postgres)
    const insertPipeline = async (id, sheet) => pool.query(`
      INSERT INTO pipeline_spaces (id, name, owner_email, provisioning_status, drive_folder_id,
        provisioning_sheet_id, google_service_account_email, google_shared_drive_id, short_link_id, sync_enabled)
      VALUES ($1::uuid, 'Synthetic pipeline', 'owner@example.test', 'provisioning', 'owned-folder',
        $2, 'clawpilot@example.iam.gserviceaccount.com', 'owned-shared-drive', $3::uuid, false)
    `, [id, sheet, randomUUID()])
    await insertPipeline(pipelineId, sheetId)
    await insertPipeline(secondPipelineId, 'second-managed-sheet')
    await Promise.all([
      persistence.completePipelineProvisioningInPostgres(pipelineId),
      persistence.completePipelineProvisioningInPostgres(pipelineId),
    ])
    assert.equal((await pool.query('SELECT count(*) FROM sync_outbox WHERE idempotency_key=$1', [key])).rows[0].count, '1')
    assert.equal((await crm.readCrmWorkbookProjectionReadiness(pipelineId)).ready, true)
    const firstOutbox = (await pool.query('SELECT id FROM sync_outbox WHERE idempotency_key=$1', [key])).rows[0].id
    for (const status of ['failed', 'dead']) {
      await pool.query('UPDATE sync_outbox SET status=$2, attempts=5 WHERE id=$1::uuid', [firstOutbox, status])
      const repaired = await persistence.enqueuePipelineInitialCrmProjectionInPostgres(pipelineId)
      assert.equal(repaired.id, firstOutbox)
      assert.equal(repaired.status, 'queued')
      assert.equal((await pool.query('SELECT attempts FROM sync_outbox WHERE id=$1::uuid', [firstOutbox])).rows[0].attempts, 0)
    }
    await pool.query(`INSERT INTO sync_outbox (aggregate_type, aggregate_id, operation, target_system, payload, status)
      VALUES ('crm_contacts', $1::uuid, 'upsert_record', 'suitecrm', $2::jsonb, 'queued')`,
    [pipelineId, JSON.stringify({ pipelineId })])
    for (let count = 0; count < 7; count++) assert.equal((await persistence.claimPipelineSyncOutboxInPostgres()).length, 0)
    assert.equal((await pool.query('SELECT attempts FROM sync_outbox WHERE id=$1::uuid', [firstOutbox])).rows[0].attempts, 0,
      'waiting on SuiteCRM must not exhaust actual provider-write attempts')
    assert.equal((await crm.readCrmWorkbookProjectionReadiness(pipelineId)).ready, false)
    await pool.query("UPDATE sync_outbox SET status='succeeded' WHERE target_system='suitecrm'")
    for (const status of ['running', 'failed']) {
      await pool.query(`INSERT INTO crm_sync_runs (pipeline_id, direction, status)
        VALUES ($1::uuid, 'sheet_to_crm', $2)`, [pipelineId, status])
      assert.equal((await crm.readCrmWorkbookProjectionReadiness(pipelineId)).ready, false)
      assert.equal((await persistence.claimPipelineSyncOutboxInPostgres()).length, 0)
      await pool.query('DELETE FROM crm_sync_runs WHERE pipeline_id=$1::uuid', [pipelineId])
    }
    await pool.query(`INSERT INTO sync_outbox (aggregate_type, aggregate_id, operation, target_system, payload, status)
      VALUES ('crm_contacts', $1::uuid, 'upsert_record', 'suitecrm', $2::jsonb, 'failed')`,
    [secondPipelineId, JSON.stringify({ pipelineId: secondPipelineId })])
    const [claimed] = await persistence.claimPipelineSyncOutboxInPostgres()
    assert.equal(claimed.id, firstOutbox, 'another tenant reconciliation does not block this workbook')
    assert.equal(claimed.pipelineId, pipelineId)
    assert.equal(claimed.sheetId, sheetId)
    assert.equal(claimed.attempts, 1)
    assert.equal(await persistence.failPipelineSyncOutboxInPostgres({
      item: claimed, error: 'Synthetic Google Sheets write failure', maxAttempts: 2,
    }), 'failed')
    await pool.query('UPDATE sync_outbox SET available_at=now() WHERE id=$1::uuid', [firstOutbox])
    const [retried] = await persistence.claimPipelineSyncOutboxInPostgres({ maxAttempts: 2 })
    assert.equal(retried.attempts, 2)
    assert.equal(await persistence.failPipelineSyncOutboxInPostgres({
      item: retried, error: 'Synthetic Google Sheets write failure', maxAttempts: 2,
    }), 'dead')
    assert.equal((await persistence.claimPipelineSyncOutboxInPostgres({ maxAttempts: 2 })).length, 0)
    await persistence.enqueuePipelineInitialCrmProjectionInPostgres(pipelineId)
    const [repairedClaim] = await persistence.claimPipelineSyncOutboxInPostgres({ maxAttempts: 2 })
    assert.equal(repairedClaim.attempts, 1)
    await persistence.completePipelineSyncOutboxInPostgres(repairedClaim)
    assert.equal((await persistence.enqueuePipelineInitialCrmProjectionInPostgres(pipelineId)).status, 'succeeded')
    assert.equal((await persistence.claimPipelineSyncOutboxInPostgres()).length, 0, 'successful initial projection is not replayed')
    await persistence.completePipelineProvisioningInPostgres(secondPipelineId)
    assert.equal((await persistence.claimPipelineSyncOutboxInPostgres()).length, 0, 'second tenant keeps its own unresolved blocker')

    // Prove completion and bootstrap enqueue are one SQL transaction by making
    // this fixture reject the queue insert, then retry after removing that rule.
    const rollbackId = '33333333-4444-4555-8666-777777777777'
    await insertPipeline(rollbackId, 'rollback-managed-sheet')
    await pool.query(`ALTER TABLE sync_outbox ADD CONSTRAINT fixture_reject_bootstrap
      CHECK (NOT (aggregate_id='${rollbackId}'::uuid AND operation='project_crm_workbook'))`)
    await assert.rejects(persistence.completePipelineProvisioningInPostgres(rollbackId), /fixture_reject_bootstrap/)
    const rolledBack = (await pool.query('SELECT sheet_id, provisioning_status FROM pipeline_spaces WHERE id=$1::uuid', [rollbackId])).rows[0]
    assert.equal(rolledBack.sheet_id, null)
    assert.equal(rolledBack.provisioning_status, 'provisioning')
    await pool.query('ALTER TABLE sync_outbox DROP CONSTRAINT fixture_reject_bootstrap')
    await persistence.completePipelineProvisioningInPostgres(rollbackId)
    assert.equal((await pool.query("SELECT count(*) FROM sync_outbox WHERE aggregate_id=$1::uuid AND operation='project_crm_workbook'", [rollbackId])).rows[0].count, '1')
    console.log('PASS PostgreSQL managed workbook bootstrap: real transaction rollback, concurrent replay, dependency wait, tenant isolation, successful/dead retry')
  } finally {
    try { if (pool) await pool.end() } finally {
      if (nativePostgres && nativeDirectory) {
        // Never remove data if the owned test server cannot be confirmed stopped.
        if (nativeStartAttempted && existsSync(join(nativeDirectory, 'data', 'postmaster.pid'))) {
          execFileSync('/opt/homebrew/bin/pg_ctl', ['-D', join(nativeDirectory, 'data'), '-m', 'fast', '-w', '-t', '15', 'stop'],
            { timeout: 20_000, stdio: 'pipe' })
        }
        assert.equal(existsSync(join(nativeDirectory, 'data', 'postmaster.pid')), false)
        assert.ok(nativeDirectory.startsWith(join(tmpdir(), 'clawpilot-workbook-bootstrap-')))
        rmSync(nativeDirectory, { recursive: true })
      } else if (started) {
        execFileSync('docker', disposablePostgresDockerCleanupArgs(container), { timeout: 30_000, stdio: 'pipe' })
      }
    }
  }
}
