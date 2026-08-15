#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const migration = '0288_operations_shopify_location_routing.sql'

process.env.CLAWPILOT_ENV = 'development'
process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim()
}

function migrationFiles() {
  return readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
}

async function applyMigration(client, filename) {
  const sql = readFileSync(
    resolve(root, 'db/migrations', filename),
    'utf8',
  )
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query(
      'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
    )
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES ($1, $2)`,
      [filename, createHash('sha256').update(sql).digest('hex')],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw new Error(`Migration ${filename} failed`, { cause: error })
  }
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 45_000
  let lastError = null
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
    } catch (error) {
      lastError = error
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => (
        setTimeout(resolvePromise, 250)
      ))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

function loadPersistence(pool) {
  const path = 'app_src/lib/persistence/shopifyInventoryRefresh.ts'
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
    },
  ).outputText
  const module = { exports: {} }
  const postgres = {
    query(text, values = []) {
      return pool.query(text, values)
    },
    async withTransaction(callback) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const value = await callback(client)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async acquireTransactionAdvisoryLock(client, key) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      )
    },
  }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/auditWriter') {
        return { async recordAuditEvent() {} }
      }
      if (specifier === '@/lib/integrations/commerceReadRuntime') {
        return {
          commerceReadAccountSql(alias) {
            return `${alias}.status = 'active'`
          },
        }
      }
      if (specifier === '@/lib/persistence/postgres') return postgres
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

const ids = {
  organization: '28800000-0000-4000-8000-000000000001',
  pipeline: '28800000-0000-4000-8000-000000000002',
  account: '28800000-0000-4000-8000-000000000003',
  config: '28800000-0000-4000-8000-000000000004',
  warehouseOne: '28800000-0000-4000-8000-000000000010',
  warehouseTwo: '28800000-0000-4000-8000-000000000020',
  locationOne: '28800000-0000-4000-8000-000000000011',
  locationTwo: '28800000-0000-4000-8000-000000000021',
  pool: '28800000-0000-4000-8000-000000000030',
  mappingOne: '28800000-0000-4000-8000-000000000041',
  mappingTwo: '28800000-0000-4000-8000-000000000042',
  legacyJob: '28800000-0000-4000-8000-000000000050',
}

async function seedPreMigration(client) {
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO workspace_organizations (id, name)
       VALUES ($1::uuid, 'Shopify multi-location refresh fixture')`,
      [ids.organization],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES ($1::uuid, $2::uuid, 'shadow', 1)`,
      [ids.organization, ids.pipeline],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES (
         $1::uuid, 'gia2880001', $2::uuid, 'shopify', 'commerce',
         'sandbox', 'Multi-location Shopify fixture', 'active',
         '{
           "accountName":"Multi-location fixture",
           "grantedScopes":[
             "read_inventory","read_locations","read_products"
           ]
         }'::jsonb,
         'gid://shopify/Shop/2880001', 1
       )`,
      [ids.account, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status
       ) VALUES (
         $1::uuid, $2::uuid, 'gid://shopify/Shop/2880001',
         'shopify_client_credentials', decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, '0001',
         'verified', clock_timestamp(), 'unverified'
       )`,
      [ids.organization, ids.account],
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, status
       ) VALUES
       ($1::uuid, 'gwh2880001', $3::uuid, 'LOC-ONE', 'Location one', 'active'),
       ($2::uuid, 'gwh2880002', $3::uuid, 'LOC-TWO', 'Location two', 'active')`,
      [ids.warehouseOne, ids.warehouseTwo, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_locations (
         id, global_id, organization_id, warehouse_id, code, active
       ) VALUES
       ($1::uuid, 'gwl2880001', $5::uuid, $3::uuid, 'STORAGE-ONE', true),
       ($2::uuid, 'gwl2880002', $5::uuid, $4::uuid, 'STORAGE-TWO', true)`,
      [
        ids.locationOne,
        ids.locationTwo,
        ids.warehouseOne,
        ids.warehouseTwo,
        ids.organization,
      ],
    )
    await client.query(
      `INSERT INTO operations_inventory_pools (
         id, global_id, organization_id, pipeline_id, name, pool_type
       ) VALUES (
         $1::uuid, 'gip2880001', $2::uuid, $3::uuid,
         'Shopify fixture pool', 'shared'
       )`,
      [ids.pool, ids.organization, ids.pipeline],
    )
    await client.query(
      `INSERT INTO operations_shopify_carrier_service_configs (
         id, global_id, organization_id, integration_account_id,
         warehouse_id, registration_state, credential_generation,
         activation_revision, callback_token_version, callback_token_hash,
         policy_revision, policy_hash, policy_snapshot,
         inventory_max_age_seconds, quote_ttl_seconds,
         order_reconciliation_window_seconds, algorithm_version, row_version
       ) VALUES (
         $1::uuid, 'gscf2880001', $2::uuid, $3::uuid, $4::uuid,
         'shadow_simulated', 1, 1, 1, $5, 1, $6, '{
           "planRateOptimization": {
             "version": "shopify-checkout-plan-rate-objective-v2",
             "maxCandidates": 4,
             "objectivePriority": [
               "landed_price", "package_count", "unused_cube"
             ],
             "handlingCostMinorPerPackage": 0,
             "handlingCostCurrency": "USD"
           },
           "checkoutRateWarm": {
             "version": "shopify-checkout-rate-warm-v1",
             "enabled": false,
             "mode": "hosted_ajax",
             "zoneScope": "all_saved_rate_zones",
             "concurrency": 2,
             "debounceMs": 350,
             "minIntervalMs": 1000,
             "supportedCountries": ["US"],
             "staleCartAbort": true
           }
         }'::jsonb,
         900, 120, 3600, 'multi-location-refresh-v1', 7
       )`,
      [
        ids.config,
        ids.organization,
        ids.account,
        ids.warehouseOne,
        'a'.repeat(64),
        'b'.repeat(64),
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_inventory_location_mappings (
         id, global_id, organization_id, integration_account_id,
         external_location_id, external_location_name,
         warehouse_id, location_id, inventory_pool_id,
         mapping_method, active, row_version
       ) VALUES
       (
         $1::uuid, 'gilm2880001', $3::uuid, $4::uuid,
         'gid://shopify/Location/2880001', 'Shopify location one',
         $5::uuid, $7::uuid, $9::uuid, 'manual', true, 3
       ),
       (
         $2::uuid, 'gilm2880002', $3::uuid, $4::uuid,
         'gid://shopify/Location/2880002', 'Shopify location two',
         $6::uuid, $8::uuid, $9::uuid, 'manual', true, 5
       )`,
      [
        ids.mappingOne,
        ids.mappingTwo,
        ids.organization,
        ids.account,
        ids.warehouseOne,
        ids.warehouseTwo,
        ids.locationOne,
        ids.locationTwo,
        ids.pool,
      ],
    )
    await client.query(
      `INSERT INTO operations_shopify_inventory_refresh_jobs (
         id, organization_id, integration_account_id,
         carrier_service_config_id, warehouse_id,
         credential_generation, activation_revision, config_row_version,
         policy_revision, policy_hash, inventory_max_age_seconds,
         requested_dirty_version
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         1, 1, 7, 1, $6, 900, 0
       )`,
      [
        ids.legacyJob,
        ids.organization,
        ids.account,
        ids.config,
        ids.warehouseOne,
        'b'.repeat(64),
      ],
    )
    await client.query(
      `INSERT INTO operations_shopify_inventory_refresh_watermarks (
         organization_id, integration_account_id, credential_generation,
         dirty_version, reconciled_version, last_signaled_at
       ) VALUES ($1::uuid, $2::uuid, 1, 1, 0, clock_timestamp())`,
      [ids.organization, ids.account],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

async function insertInventoryEvidence(pool, job) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    const attempt = await client.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action,
         adapter_version, idempotency_key, request_hash,
         redacted_request, redacted_response, state,
         requested_at, completed_at
       ) VALUES (
         $1::uuid, $2::uuid, 'inventory.levels.read',
         'multi-location-refresh-postgres-v1', $3, $4,
         '{"resource":"inventory","readOnly":true}'::jsonb,
         '{"providerWrites":0,"orderQuantityAdjustment":0}'::jsonb,
         'succeeded', clock_timestamp(), clock_timestamp()
       ) RETURNING id::text`,
      [
        job.organizationId,
        job.integrationAccountId,
        `attempt:${job.id}`,
        createHash('sha256').update(`attempt:${job.id}`).digest('hex'),
      ],
    )
    const attemptId = attempt.rows[0].id
    const capture = await client.query(
      `INSERT INTO operations_commerce_inventory_captures (
         organization_id, integration_account_id, provider_attempt_id,
         warehouse_id, location_id, provider, adapter_version,
         credential_version, request_hash, snapshot_hash,
         provider_location_id, provider_fetched_at, level_count,
         captured_snapshot, snapshot_bytes, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         'shopify', 'multi-location-refresh-postgres-v1', 1,
         $6, $7, $8, clock_timestamp(), 0, '{}'::jsonb, 2,
         clock_timestamp()
       ) RETURNING id::text, provider_fetched_at`,
      [
        job.organizationId,
        job.integrationAccountId,
        attemptId,
        job.warehouseId,
        job.inventoryLocationId,
        createHash('sha256').update(`attempt:${job.id}`).digest('hex'),
        createHash('sha256').update(`snapshot:${job.id}`).digest('hex'),
        job.providerLocationId,
      ],
    )
    const idempotencyKey = `shopify-inventory-refresh:${job.id}`
    const run = await client.query(
      `INSERT INTO operations_commerce_inventory_sync_runs (
         organization_id, integration_account_id, provider_attempt_id,
         capture_id, location_mapping_id, warehouse_id, location_id,
         inventory_pool_id, provider, adapter_version,
         credential_version, idempotency_key, request_hash, snapshot_hash,
         status, provider_location_id, provider_location_name,
         provider_fetched_at, levels_seen, levels_mapped,
         levels_projected, levels_unmapped, levels_untracked,
         negative_available_levels, equation_mismatch_levels,
         provider_available_quantity, provider_committed_quantity,
         provider_on_hand_quantity, operational_available_quantity,
         positions_created, positions_updated, positions_zeroed,
         provider_writes, order_quantity_adjustment
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, $8::uuid, 'shopify',
         'multi-location-refresh-postgres-v1', 1, $9, $10, $11,
         'succeeded', $12, 'Fixture location', $13::timestamptz,
         0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
       ) RETURNING global_id`,
      [
        job.organizationId,
        job.integrationAccountId,
        attemptId,
        capture.rows[0].id,
        job.locationMappingId,
        job.warehouseId,
        job.inventoryLocationId,
        job.inventoryPoolId,
        idempotencyKey,
        createHash('sha256').update(`attempt:${job.id}`).digest('hex'),
        createHash('sha256').update(`snapshot:${job.id}`).digest('hex'),
        job.providerLocationId,
        capture.rows[0].provider_fetched_at,
      ],
    )
    return {
      effectiveIdempotencyKey: idempotencyKey,
      inventoryRunGlobalId: run.rows[0].global_id,
    }
  } finally {
    await client.query('SET session_replication_role = origin')
      .catch(() => undefined)
    client.release()
  }
}

async function claimWithLegacySql(client, workerId) {
  return client.query(
    `WITH candidate AS (
       SELECT job.id
       FROM operations_shopify_inventory_refresh_jobs job
       WHERE job.status IN ('pending', 'failed')
         AND job.available_at <= now()
         AND job.cancel_requested = false
       ORDER BY job.available_at, job.created_at, job.id
       FOR UPDATE OF job SKIP LOCKED
       LIMIT 1
     )
     UPDATE operations_shopify_inventory_refresh_jobs job
     SET status = 'processing',
         attempt_count = job.attempt_count + 1,
         locked_at = now(),
         locked_by = $1,
         lock_token = gen_random_uuid(),
         lease_expires_at = now() + interval '20 minutes',
         started_at = now(),
         updated_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id::text, job.status`,
    [workerId],
  )
}

async function exercise(pool) {
  const client = await pool.connect()
  const files = migrationFiles()
  const migrationIndex = files.indexOf(migration)
  assert.ok(migrationIndex > 0, `${migration} is missing`)
  try {
    for (const file of files.slice(0, migrationIndex)) {
      await applyMigration(client, file)
    }
    await seedPreMigration(client)
    await applyMigration(client, migration)

    const validatedMappingForeignKeys = await client.query(
      `SELECT conname, convalidated
       FROM pg_constraint
       WHERE conrelid =
         'operations_shopify_inventory_refresh_jobs'::regclass
         AND conname = ANY($1::text[])
       ORDER BY conname`,
      [[
        'operations_shopify_inventory_refresh_inventory_location_fkey',
        'operations_shopify_inventory_refresh_inventory_pool_fkey',
        'operations_shopify_inventory_refresh_mapping_fkey',
      ]],
    )
    assert.deepEqual(validatedMappingForeignKeys.rows, [
      {
        conname:
          'operations_shopify_inventory_refresh_inventory_location_fkey',
        convalidated: true,
      },
      {
        conname:
          'operations_shopify_inventory_refresh_inventory_pool_fkey',
        convalidated: true,
      },
      {
        conname: 'operations_shopify_inventory_refresh_mapping_fkey',
        convalidated: true,
      },
    ], 'Every mapped refresh foreign-key fence must be validated')

    const rollout = await client.query(
      `SELECT
         ownership_classification,
         provider_snapshot_json,
         provider_snapshot_hash,
         provider_observed_at,
         inventory_import_enabled
       FROM operations_commerce_inventory_location_mappings
       ORDER BY external_location_id`,
    )
    assert.equal(rollout.rowCount, 2)
    for (const row of rollout.rows) {
      assert.equal(row.ownership_classification, 'unknown')
      assert.deepEqual(row.provider_snapshot_json, {})
      assert.equal(row.provider_snapshot_hash, null)
      assert.equal(row.provider_observed_at, null)
      assert.equal(row.inventory_import_enabled, true)
    }
    const preserved = await client.query(
      `SELECT location_mapping_id, location_mapping_row_version,
              provider_location_id, inventory_location_id,
              inventory_pool_id, status
       FROM operations_shopify_inventory_refresh_jobs
       WHERE id = $1::uuid`,
      [ids.legacyJob],
    )
    assert.deepEqual(preserved.rows[0], {
      location_mapping_id: null,
      location_mapping_row_version: null,
      provider_location_id: null,
      inventory_location_id: null,
      inventory_pool_id: null,
      status: 'pending',
    })

    const oldUpsert = await client.query(
      `INSERT INTO operations_shopify_inventory_refresh_jobs (
         organization_id, integration_account_id,
         carrier_service_config_id, warehouse_id,
         credential_generation, activation_revision, config_row_version,
         policy_revision, policy_hash, inventory_max_age_seconds,
         requested_dirty_version
       ) SELECT
         organization_id, integration_account_id,
         carrier_service_config_id, warehouse_id,
         credential_generation, activation_revision, config_row_version,
         policy_revision, policy_hash, inventory_max_age_seconds, 1
       FROM operations_shopify_inventory_refresh_jobs
       WHERE id = $1::uuid
       ON CONFLICT (
         organization_id, integration_account_id
       ) WHERE status IN ('pending', 'processing', 'failed')
       DO UPDATE SET
         requested_dirty_version = EXCLUDED.requested_dirty_version,
         updated_at = now()
       RETURNING id::text, status`,
      [ids.legacyJob],
    )
    assert.deepEqual(oldUpsert.rows, [{
      id: ids.legacyJob,
      status: 'pending',
    }], 'The pre-0288 ON CONFLICT target must remain inferable')

    const legacyClaim = await claimWithLegacySql(
      client,
      'pre-0288-worker',
    )
    assert.deepEqual(legacyClaim.rows, [{
      id: ids.legacyJob,
      status: 'processing',
    }], 'A legacy NULL-fenced job must remain claimable')
    await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET status = 'cancelled', completed_at = clock_timestamp(),
           locked_at = NULL, locked_by = NULL, lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = 'ROLLOUT_FIXTURE_TERMINALIZED'
       WHERE id = $1::uuid`,
      [ids.legacyJob],
    )
    await client.query(
      `CREATE OR REPLACE FUNCTION
         operations_shopify_carrier_service_config_is_ready(
           requested_organization_id uuid,
           requested_config_id uuid
         )
       RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'`,
    )
  } finally {
    client.release()
  }

  const persistence = loadPersistence(pool)
  const queued = await persistence
    .queueAutomaticShopifyInventoryRefreshesInPostgres()
  assert.deepEqual(JSON.parse(JSON.stringify(queued)), {
    queued: 2,
    cancelled: 0,
  })
  const jobs = await pool.query(
    `SELECT location_mapping_id::text,
            location_mapping_row_version::text,
            provider_location_id, warehouse_id::text,
            inventory_location_id::text, inventory_pool_id::text,
            requested_dirty_version::text, status
     FROM operations_shopify_inventory_refresh_jobs
     WHERE location_mapping_id IS NOT NULL
     ORDER BY provider_location_id`,
  )
  assert.deepEqual(jobs.rows, [
    {
      location_mapping_id: ids.mappingOne,
      location_mapping_row_version: '3',
      provider_location_id: 'gid://shopify/Location/2880001',
      warehouse_id: ids.warehouseOne,
      inventory_location_id: ids.locationOne,
      inventory_pool_id: ids.pool,
      requested_dirty_version: '1',
      status: 'mapped_pending',
    },
    {
      location_mapping_id: ids.mappingTwo,
      location_mapping_row_version: '5',
      provider_location_id: 'gid://shopify/Location/2880002',
      warehouse_id: ids.warehouseTwo,
      inventory_location_id: ids.locationTwo,
      inventory_pool_id: ids.pool,
      requested_dirty_version: '1',
      status: 'mapped_pending',
    },
  ])
  const oldClaimAgainstMapped = await claimWithLegacySql(
    pool,
    'pre-0288-worker-after-fanout',
  )
  assert.equal(
    oldClaimAgainstMapped.rowCount,
    0,
    'The pre-0288 claim predicate must not see mapped jobs',
  )
  const rollingLegacyInsert = await pool.query(
    `INSERT INTO operations_shopify_inventory_refresh_jobs (
       organization_id, integration_account_id,
       carrier_service_config_id, warehouse_id,
       credential_generation, activation_revision, config_row_version,
       policy_revision, policy_hash, inventory_max_age_seconds,
       requested_dirty_version
     ) SELECT
       organization_id, integration_account_id,
       carrier_service_config_id, warehouse_id,
       credential_generation, activation_revision, config_row_version,
       policy_revision, policy_hash, inventory_max_age_seconds, 1
     FROM operations_shopify_inventory_refresh_jobs
     WHERE id = $1::uuid
     ON CONFLICT (
       organization_id, integration_account_id
     ) WHERE status IN ('pending', 'processing', 'failed')
     DO UPDATE SET updated_at = now()
     RETURNING id::text, location_mapping_id::text, status`,
    [ids.legacyJob],
  )
  assert.equal(rollingLegacyInsert.rowCount, 1)
  assert.equal(rollingLegacyInsert.rows[0].location_mapping_id, null)
  assert.equal(rollingLegacyInsert.rows[0].status, 'pending')
  const rollingLegacyClaim = await claimWithLegacySql(
    pool,
    'pre-0288-worker-while-mapped-jobs-exist',
  )
  assert.deepEqual(rollingLegacyClaim.rows, [{
    id: rollingLegacyInsert.rows[0].id,
    status: 'processing',
  }], 'Legacy work must remain independent of mapped job statuses')
  await pool.query(
    `UPDATE operations_shopify_inventory_refresh_jobs
     SET status = 'cancelled', completed_at = clock_timestamp(),
         locked_at = NULL, locked_by = NULL, lock_token = NULL,
         lease_expires_at = NULL,
         last_error_code = 'ROLLOUT_FIXTURE_TERMINALIZED'
     WHERE id = $1::uuid`,
    [rollingLegacyInsert.rows[0].id],
  )

  const firstClaim = await persistence
    .claimShopifyInventoryRefreshJobsInPostgres({
      limit: 10,
      workerId: 'multi-location-worker-one',
    })
  assert.equal(firstClaim.length, 1)
  assert.ok(firstClaim[0].locationMappingId)
  const mappedProcessing = await pool.query(
    `SELECT count(*)::text AS count
     FROM operations_shopify_inventory_refresh_jobs
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND status = 'mapped_processing'`,
    [ids.organization, ids.account],
  )
  assert.equal(mappedProcessing.rows[0].count, '1')
  const overlappingClaim = await persistence
    .claimShopifyInventoryRefreshJobsInPostgres({
      limit: 10,
      workerId: 'multi-location-worker-two',
    })
  assert.equal(
    overlappingClaim.length,
    0,
    'Only one mapped provider read may process for an account',
  )

  const firstEvidence = await insertInventoryEvidence(pool, firstClaim[0])
  const firstCompletion = await persistence
    .completeShopifyInventoryRefreshJobInPostgres({
      job: firstClaim[0],
      ...firstEvidence,
    })
  assert.equal(firstCompletion.status, 'succeeded')
  assert.equal(firstCompletion.currentDirtyVersion, 1)
  assert.equal(firstCompletion.reconciledDirtyVersion, 0)
  assert.equal(firstCompletion.followUpRequired, true)
  const firstFollowUp = await persistence
    .queueAutomaticShopifyInventoryRefreshesInPostgres()
  assert.deepEqual(JSON.parse(JSON.stringify(firstFollowUp)), {
    queued: 0,
    cancelled: 0,
  })
  const remainingBatchJobs = await pool.query(
    `SELECT count(*)::text AS count
     FROM operations_shopify_inventory_refresh_jobs
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND requested_dirty_version = 1
       AND status IN (
         'mapped_pending', 'mapped_processing', 'mapped_failed'
       )`,
    [ids.organization, ids.account],
  )
  assert.equal(
    remainingBatchJobs.rows[0].count,
    '1',
    'A completed mapping must not be requeued while sibling mappings finish',
  )

  const secondClaim = await persistence
    .claimShopifyInventoryRefreshJobsInPostgres({
      limit: 10,
      workerId: 'multi-location-worker-two',
    })
  assert.equal(secondClaim.length, 1)
  assert.notEqual(
    secondClaim[0].locationMappingId,
    firstClaim[0].locationMappingId,
  )
  const secondEvidence = await insertInventoryEvidence(pool, secondClaim[0])
  const secondCompletion = await persistence
    .completeShopifyInventoryRefreshJobInPostgres({
      job: secondClaim[0],
      ...secondEvidence,
    })
  assert.equal(secondCompletion.status, 'succeeded')
  assert.equal(secondCompletion.currentDirtyVersion, 1)
  assert.equal(secondCompletion.reconciledDirtyVersion, 1)
  assert.equal(secondCompletion.followUpRequired, false)

  const recovery = await persistence
    .readShopifyInventoryRefreshRecoveryStateFromPostgres({
      organizationId: ids.organization,
      accountGlobalId: 'gia2880001',
    })
  assert.equal(recovery.status, 'succeeded')
  assert.equal(recovery.managerRecoveryRequired, false)
  assert.equal(recovery.recoveredAfterDead, false)
  const health = await persistence
    .readShopifyInventoryRefreshHealthFromPostgres()
  assert.equal(health.eligibleAccounts, 1)
  assert.equal(health.staleAccounts, 0)
  assert.equal(health.dirtyAccounts, 0)
  assert.equal(health.queued, 0)
  assert.equal(health.processing, 0)
  assert.equal(health.retrying, 0)
  assert.equal(health.currentDead, 0)
  assert.equal(health.providerWrites, 0)
  assert.equal(health.orderQuantityAdjustment, 0)

  const watermark = await pool.query(
    `SELECT dirty_version::text, reconciled_version::text,
            last_reconciled_run_global_id
     FROM operations_shopify_inventory_refresh_watermarks
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [ids.organization, ids.account],
  )
  assert.equal(watermark.rows[0].dirty_version, '1')
  assert.equal(watermark.rows[0].reconciled_version, '1')
  assert.equal(
    watermark.rows[0].last_reconciled_run_global_id,
    secondEvidence.inventoryRunGlobalId,
  )

  await pool.query(
    `INSERT INTO operations_shopify_inventory_refresh_jobs (
       organization_id, integration_account_id,
       carrier_service_config_id, warehouse_id,
       location_mapping_id, location_mapping_row_version,
       provider_location_id, inventory_location_id, inventory_pool_id,
       credential_generation, activation_revision, config_row_version,
       policy_revision, policy_hash, inventory_max_age_seconds, status
     ) SELECT
       organization_id, integration_account_id,
       carrier_service_config_id, warehouse_id,
       location_mapping_id, location_mapping_row_version,
       provider_location_id, inventory_location_id, inventory_pool_id,
       credential_generation, activation_revision, config_row_version,
       policy_revision, policy_hash, inventory_max_age_seconds,
       'mapped_pending'
     FROM operations_shopify_inventory_refresh_jobs
     WHERE location_mapping_id = $1::uuid
     ORDER BY created_at DESC LIMIT 1`,
    [ids.mappingOne],
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO operations_shopify_inventory_refresh_jobs (
         organization_id, integration_account_id,
         carrier_service_config_id, warehouse_id,
         location_mapping_id, location_mapping_row_version,
         provider_location_id, inventory_location_id, inventory_pool_id,
         credential_generation, activation_revision, config_row_version,
         policy_revision, policy_hash, inventory_max_age_seconds, status
       ) SELECT
         organization_id, integration_account_id,
         carrier_service_config_id, warehouse_id,
         location_mapping_id, location_mapping_row_version,
         provider_location_id, inventory_location_id, inventory_pool_id,
         credential_generation, activation_revision, config_row_version,
         policy_revision, policy_hash, inventory_max_age_seconds,
         'mapped_pending'
       FROM operations_shopify_inventory_refresh_jobs
       WHERE location_mapping_id = $1::uuid
       ORDER BY created_at DESC LIMIT 1`,
      [ids.mappingOne],
    ),
    /duplicate key value/u,
  )
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-shopify-multilocation-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shopify_multilocation',
      '-e', 'POSTGRES_DB=shopify_multilocation',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:shopify_multilocation@127.0.0.1:'
      + `${port}/shopify_multilocation`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 4 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
  } finally {
    command('docker', ['stop', container], { timeout: 30_000 })
  }
  console.log('Shopify multi-location refresh PostgreSQL tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
