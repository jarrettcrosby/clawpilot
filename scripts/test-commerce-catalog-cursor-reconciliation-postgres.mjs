#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
let runtimePool = null

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(diagnostics, [])
  const loaded = { exports: {} }
  vm.runInNewContext(output.outputText, {
    Array,
    BigInt,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: loaded.exports,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return loaded.exports
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => {})
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function withRuntimeTransaction(callback) {
  assert.ok(runtimePool, 'Runtime PostgreSQL pool is not configured')
  const client = await runtimePool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const persistence = loadTypeScriptModule(
  'app_src/lib/persistence/commerceCatalogSync.ts',
  {
    '@/lib/auditWriter': {
      async recordAuditEvent() {},
    },
    '@/lib/persistence/postgres': {
      acquireTransactionAdvisoryLock: (client, key) => client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      ),
      async query(sql, values) {
        assert.ok(runtimePool, 'Runtime PostgreSQL pool is not configured')
        return runtimePool.query(sql, values)
      },
      withTransaction: withRuntimeTransaction,
    },
  },
)

async function seedAccount(pool) {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  const actorEmail = 'catalog-cursor-postgres@episcs.com'
  await pool.query(
    `INSERT INTO app_users (email, role, status, activated_at)
     VALUES ($1, 'owner', 'active', clock_timestamp())`,
    [actorEmail],
  )
  await pool.query(
    `INSERT INTO workspace_organizations (id, name, created_by, updated_by)
     VALUES ($1::uuid, 'Catalog cursor acceptance', $2, $2)`,
    [organizationId, actorEmail],
  )
  await pool.query(
    `UPDATE app_users
     SET organization_id = $2::uuid,
         organization_name = 'Catalog cursor acceptance'
     WHERE email = $1`,
    [actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, status, is_default,
       created_by, updated_by
     ) VALUES ($1, $2::uuid, 'owner', 'active', true, $1, $1)`,
    [actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES (
       $1::uuid, 'Catalog cursor pipeline', $2, true, $3::uuid
     )`,
    [pipelineId, actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shadow',
       'Catalog cursor acceptance', $3
     )`,
    [organizationId, pipelineId, actorEmail],
  )
  const account = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       $1::uuid, 'faire', 'commerce', 'production',
       'Faire cursor acceptance', 'active', 'b_cursor_acceptance',
       1, $2, $2
     ) RETURNING id::text, global_id`,
    [organizationId, actorEmail],
  )
  const integrationAccountId = account.rows[0].id
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'b_cursor_acceptance', 'faire_brand_token',
       decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
       decode(repeat('00', 16), 'hex'), 1, 'TEST', 'verified',
       clock_timestamp(), 'not_applicable', $3, $3
     )`,
    [organizationId, integrationAccountId, actorEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_product_intake_policies (
       organization_id, integration_account_id, policy_version,
       unmatched_action, revision, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'commerce-product-intake-policy-v1',
       'auto_create', 3, $3, $3
     )`,
    [organizationId, integrationAccountId, actorEmail],
  )
  return {
    organizationId,
    integrationAccountId,
    accountGlobalId: account.rows[0].global_id,
    actorEmail,
  }
}

async function cursorState(pool, fixture) {
  return (
    await pool.query(
      `SELECT reconciliation_status, last_error_code,
              last_completed_at::text
       FROM operations_commerce_sync_cursors
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'products'`,
      [fixture.organizationId, fixture.integrationAccountId],
    )
  ).rows[0]
}

async function verifyReconciliation(pool) {
  const fixture = await seedAccount(pool)
  const pending = await pool.query(
    `INSERT INTO operations_commerce_catalog_sync_jobs (
       organization_id, integration_account_id, provider,
       credential_version, policy_revision, requested_by, status,
       continuation_run_global_id, page_count, provider_records_seen,
       products_mapped, started_at
     ) VALUES (
       $1::uuid, $2::uuid, 'faire', 1, 3, $3, 'pending',
       'gcir1234567', 1, 50, 50, now() - interval '2 minutes'
     ) RETURNING id::text`,
    [fixture.organizationId, fixture.integrationAccountId, fixture.actorEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_sync_cursors (
       organization_id, integration_account_id, resource,
       reconciliation_status, records_seen, records_applied,
       last_started_at
     ) VALUES (
       $1::uuid, $2::uuid, 'products', 'running', 50, 50,
       now() - interval '2 minutes'
     )`,
    [fixture.organizationId, fixture.integrationAccountId],
  )
  await pool.query(
    `UPDATE operations_commerce_product_intake_policies
     SET unmatched_action = 'review', revision = 4, updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [fixture.organizationId, fixture.integrationAccountId],
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await persistence.applyCommerceCatalogSyncPolicyWithClient(
      client,
      {
        organizationId: fixture.organizationId,
        integrationAccountId: fixture.integrationAccountId,
        provider: 'faire',
        credentialVersion: 1,
        policyRevision: 4,
        unmatchedAction: 'review',
        actorEmail: fixture.actorEmail,
      },
    )
    assert.equal(result.cancelled, 1)
    assert.equal(result.queued, 1)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  const cancelledPending = (
    await pool.query(
      `SELECT status, cancel_requested, last_error_code
       FROM operations_commerce_catalog_sync_jobs
       WHERE id = $1::uuid`,
      [pending.rows[0].id],
    )
  ).rows[0]
  assert.deepEqual(cancelledPending, {
    status: 'cancelled',
    cancel_requested: true,
    last_error_code: 'COMMERCE_CATALOG_SYNC_FENCE_CHANGED',
  })
  const reviewPending = (
    await pool.query(
      `SELECT id::text, status, policy_revision, cancel_requested
       FROM operations_commerce_catalog_sync_jobs
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND policy_revision = 4
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [fixture.organizationId, fixture.integrationAccountId],
    )
  ).rows[0]
  assert.deepEqual(reviewPending, {
    id: reviewPending.id,
    status: 'pending',
    policy_revision: 4,
    cancel_requested: false,
  })
  assert.deepEqual(await cursorState(pool, fixture), {
    reconciliation_status: 'running',
    last_error_code: null,
    last_completed_at: null,
  })
  await pool.query(
    `DELETE FROM operations_commerce_catalog_sync_jobs
     WHERE id = $1::uuid`,
    [reviewPending.id],
  )

  await pool.query(
    `UPDATE operations_commerce_product_intake_policies
     SET unmatched_action = 'auto_create', revision = 5, updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [fixture.organizationId, fixture.integrationAccountId],
  )
  const lockToken = randomUUID()
  const processing = await pool.query(
    `INSERT INTO operations_commerce_catalog_sync_jobs (
       organization_id, integration_account_id, provider,
       credential_version, policy_revision, requested_by, status,
       continuation_run_global_id, page_count, provider_records_seen,
       products_mapped, attempt_count, locked_at, locked_by, lock_token,
       started_at
     ) VALUES (
       $1::uuid, $2::uuid, 'faire', 1, 5, $3, 'processing',
       'gcir7654321', 1, 50, 50, 1, now(), 'cursor-test-worker',
       $4::uuid, now() - interval '1 minute'
     ) RETURNING id::text, started_at::text`,
    [
      fixture.organizationId,
      fixture.integrationAccountId,
      fixture.actorEmail,
      lockToken,
    ],
  )
  await pool.query(
    `UPDATE operations_commerce_sync_cursors
     SET reconciliation_status = 'running', last_error_code = NULL,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND resource = 'products'`,
    [fixture.organizationId, fixture.integrationAccountId],
  )
  await pool.query(
    `UPDATE operations_commerce_product_intake_policies
     SET unmatched_action = 'review', revision = 6, updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [fixture.organizationId, fixture.integrationAccountId],
  )
  const policyClient = await pool.connect()
  try {
    await policyClient.query('BEGIN')
    await persistence.applyCommerceCatalogSyncPolicyWithClient(
      policyClient,
      {
        organizationId: fixture.organizationId,
        integrationAccountId: fixture.integrationAccountId,
        provider: 'faire',
        credentialVersion: 1,
        policyRevision: 6,
        unmatchedAction: 'review',
        actorEmail: fixture.actorEmail,
      },
    )
    await policyClient.query('COMMIT')
  } catch (error) {
    await policyClient.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    policyClient.release()
  }
  const activeProcessing = (
    await pool.query(
      `SELECT status, cancel_requested
       FROM operations_commerce_catalog_sync_jobs
       WHERE id = $1::uuid`,
      [processing.rows[0].id],
    )
  ).rows[0]
  assert.deepEqual(activeProcessing, {
    status: 'processing',
    cancel_requested: true,
  })
  assert.equal(
    (await cursorState(pool, fixture)).reconciliation_status,
    'running',
    'A cursor must remain running while its cancelled worker still owns an active lease',
  )

  const completion = await persistence.completeCommerceCatalogSyncPageInPostgres({
    job: {
      id: processing.rows[0].id,
      organizationId: fixture.organizationId,
      integrationAccountId: fixture.integrationAccountId,
      accountGlobalId: fixture.accountGlobalId,
      provider: 'faire',
      credentialVersion: 1,
      policyRevision: 5,
      requestedBy: fixture.actorEmail,
      continuationRunGlobalId: 'gcir7654321',
      targetDirtyVersion: 0,
      readGeneration: 0,
      pageCount: 1,
      providerRecordsSeen: 50,
      attemptCount: 1,
      sweepFailureCount: 0,
      maxAttempts: 8,
      startedAt: new Date(processing.rows[0].started_at).toISOString(),
      lockToken,
    },
    continuationRunGlobalId: null,
    hasNextBatch: false,
    totals: {
      providerRecordsSeen: 0,
      productsCreated: 0,
      productsMapped: 0,
      productsUnchanged: 0,
      productsSkipped: 0,
      productsFailed: 0,
    },
  })
  assert.equal(completion.status, 'cancelled')
  const cancelledProcessing = (
    await pool.query(
      `SELECT status, cancel_requested, lock_token, last_error_code
       FROM operations_commerce_catalog_sync_jobs
       WHERE id = $1::uuid`,
      [processing.rows[0].id],
    )
  ).rows[0]
  assert.deepEqual(cancelledProcessing, {
    status: 'cancelled',
    cancel_requested: true,
    lock_token: null,
    last_error_code: 'COMMERCE_CATALOG_SYNC_FENCE_CHANGED',
  })
  assert.deepEqual(await cursorState(pool, fixture), {
    reconciliation_status: 'idle',
    last_error_code: 'COMMERCE_CATALOG_SYNC_FENCE_CHANGED',
    last_completed_at: null,
  })

  await pool.query(
    `DELETE FROM operations_commerce_catalog_sync_jobs
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [fixture.organizationId, fixture.integrationAccountId],
  )
  await pool.query(
    `UPDATE operations_commerce_sync_cursors
     SET reconciliation_status = 'running', last_error_code = NULL,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND resource = 'products'`,
    [fixture.organizationId, fixture.integrationAccountId],
  )
  const repaired = await persistence
    .reconcileOrphanedCommerceCatalogSyncCursorsWithClient(pool)
  assert.equal(repaired.reconciled, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(repaired.cursors)), [{
    organizationId: fixture.organizationId,
    integrationAccountId: fixture.integrationAccountId,
    lastErrorCode: 'COMMERCE_CATALOG_SYNC_ORPHAN_RECONCILED',
  }])
  assert.deepEqual(await cursorState(pool, fixture), {
    reconciliation_status: 'idle',
    last_error_code: 'COMMERCE_CATALOG_SYNC_ORPHAN_RECONCILED',
    last_completed_at: null,
  })
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-catalog-cursor-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=catalog_cursor',
      '-e', 'POSTGRES_DB=catalog_cursor',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      `postgresql://postgres:catalog_cursor@127.0.0.1:${port}/catalog_cursor`
    )
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    runtimePool = new Pool({ connectionString: databaseUrl, max: 4 })
    await verifyReconciliation(runtimePool)
    await runtimePool.end()
    runtimePool = null
  } finally {
    if (runtimePool) await runtimePool.end().catch(() => {})
    runtimePool = null
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Commerce catalog cursor reconciliation disposable-PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
