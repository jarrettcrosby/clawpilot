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
      if (specifier === '@/lib/operations/commerceStoreSync') {
        return {
          commerceStoreSyncRunningSql(alias) {
            return `operations_commerce_store_sync_is_running(${alias}.organization_id, ${alias}.id)`
          },
        }
      }
      if (specifier === '@/lib/persistence/postgres') return postgres
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

function loadProjection() {
  const path = 'app_src/lib/operations/shopifyInventoryProjection.ts'
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: path,
    },
  ).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Math,
    Object,
    exports: module.exports,
    module,
  }, { filename: path })
  return module.exports
}

function loadInventoryPersistence(pool) {
  const path = 'app_src/lib/persistence/commerceInventory.ts'
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
  const projection = loadProjection()
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
    Intl,
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
      if (specifier === '@/lib/operations/commerceStoreSync') {
        return {
          commerceStoreSyncRunningSql(alias) {
            return `operations_commerce_store_sync_is_running(${alias}.organization_id, ${alias}.id)`
          },
        }
      }
      if (specifier === '@/lib/integrations/shopifyInventory') {
        return {
          SHOPIFY_INVENTORY_ADAPTER_VERSION:
            'multi-location-refresh-postgres-v1',
        }
      }
      if (specifier === '@/lib/operations/shopifyInventoryProjection') {
        return projection
      }
      if (specifier === '@/lib/persistence/postgres') return postgres
      if (specifier.startsWith('@/')) return {}
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
  legacySuccessJob: '28800000-0000-4000-8000-000000000051',
  legacySuccessLock: '28800000-0000-4000-8000-000000000052',
}
const actorEmail = null

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
         'Shopify Available-to-Promise', 'shared'
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

async function applyInventoryEvidence(pool, inventoryPersistence, job) {
  const mappingId = job.locationMappingId || ids.mappingOne
  const targetResult = await pool.query(
    `SELECT warehouse.id::text AS warehouse_id,
            warehouse.global_id AS warehouse_global_id,
            warehouse.name AS warehouse_name,
            warehouse.address AS warehouse_address,
            location.id::text AS location_id,
            location.global_id AS location_global_id,
            location.code AS location_code,
            mapping.id::text AS mapping_id,
            mapping.global_id AS mapping_global_id,
            mapping.external_location_id,
            mapping.external_location_name,
            mapping.inventory_pool_id::text,
            mapping.ownership_classification,
            mapping.row_version::text
     FROM operations_commerce_inventory_location_mappings mapping
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = mapping.organization_id
      AND warehouse.id = mapping.warehouse_id
     JOIN operations_locations location
       ON location.organization_id = mapping.organization_id
      AND location.id = mapping.location_id
     WHERE mapping.organization_id = $1::uuid
       AND mapping.integration_account_id = $2::uuid
       AND mapping.id = $3::uuid`,
    [job.organizationId, job.integrationAccountId, mappingId],
  )
  assert.equal(targetResult.rowCount, 1)
  const row = targetResult.rows[0]
  const providerLocation = {
    id: row.external_location_id,
    name: row.external_location_name,
    isActive: true,
    shipsInventory: true,
    fulfillsOnlineOrders: true,
    hasActiveInventory: true,
    addressVerified: true,
    isFulfillmentService: false,
    fulfillmentService: null,
    address: {
      line1: '100 Refresh Lane',
      line2: null,
      city: 'Trumbull',
      region: 'Connecticut',
      regionCode: 'CT',
      postalCode: '06611',
      country: 'United States',
      countryCode: 'US',
    },
  }
  const target = {
    integrationAccountId: job.integrationAccountId,
    credentialVersion: job.credentialGeneration,
    pipelineId: ids.pipeline,
    warehouse: {
      id: row.warehouse_id,
      globalId: row.warehouse_global_id,
      name: row.warehouse_name,
      address: row.warehouse_address || {},
    },
    location: {
      id: row.location_id,
      globalId: row.location_global_id,
      code: row.location_code,
    },
    existingMapping: {
      id: row.mapping_id,
      globalId: row.mapping_global_id,
      externalLocationId: row.external_location_id,
      externalLocationName: row.external_location_name,
      rowVersion: Number(row.row_version),
      inventoryPoolId: row.inventory_pool_id,
      ownershipClassification: row.ownership_classification,
    },
  }
  const runtime = {
    organizationId: job.organizationId,
    integrationAccountId: job.integrationAccountId,
    globalId: job.accountGlobalId,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId: 'gid://shopify/Shop/2880001',
    status: 'active',
    credentialVersion: job.credentialGeneration,
    verificationStatus: 'verified',
    encrypted: {},
    configuration: {},
  }
  const idempotencyKey = `shopify-inventory-refresh:${job.id}`
  const requestHash = createHash('sha256')
    .update(`request:${job.id}`)
    .digest('hex')
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    location: providerLocation,
    levels: [],
    pageCount: 1,
    enrichment: {
      unitCostAvailable: false,
      productDimensionKeys: {},
      variantDimensionKeys: {},
      ambiguousDimensionDefinitions: [],
    },
    snapshotHash: createHash('sha256')
      .update(`snapshot:${job.id}`)
      .digest('hex'),
  }
  const attempt = await inventoryPersistence
    .prepareShopifyInventoryReadInPostgres({
      runtime,
      target,
      idempotencyKey,
      requestHash,
      actorEmail: null,
    })
  const capture = await inventoryPersistence
    .captureShopifyInventorySnapshotInPostgres({
      runtime,
      target,
      attempt,
      requestHash,
      snapshot,
      actorEmail: null,
    })
  const applied = await inventoryPersistence
    .applyShopifyInventorySnapshotInPostgres({
      runtime,
      target,
      attempt,
      capture,
      providerLocation,
      mappingMethod: 'automatic_exact_address',
      idempotencyKey,
      requestHash,
      actorEmail: null,
      expectedRefreshFence: {
        jobId: job.id,
        carrierServiceConfigId: job.carrierServiceConfigId,
        warehouseId: job.warehouseId,
        locationMappingId: job.locationMappingId,
        locationMappingRowVersion: job.locationMappingRowVersion,
        providerLocationId: job.providerLocationId,
        inventoryLocationId: job.inventoryLocationId,
        inventoryPoolId: job.inventoryPoolId,
        credentialGeneration: job.credentialGeneration,
        activationRevision: job.activationRevision,
        configRowVersion: job.configRowVersion,
        policyRevision: job.policyRevision,
        policyHash: job.policyHash,
        inventoryMaxAgeSeconds: job.inventoryMaxAgeSeconds,
        requestedDirtyVersion: job.requestedDirtyVersion,
        lockToken: job.lockToken,
      },
    })
  return {
    effectiveIdempotencyKey: idempotencyKey,
    inventoryRunGlobalId: applied.runGlobalId,
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
    for (const file of files.slice(migrationIndex + 1)) {
      await applyMigration(client, file)
    }
    await client.query(
      `UPDATE operations_commerce_store_sync_controls
       SET desired_state = 'running', explicit_choice = true,
           revision = revision + 1,
           reason = 'Inventory acceptance remains Running in Read only',
           updated_by = $2, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $3::uuid`,
      [ids.organization, actorEmail, ids.account],
    )
    await client.query(
      `UPDATE operations_activation_scopes
       SET state = 'read_only', revision = revision + 1,
           reason = 'Inventory Store sync independence acceptance',
           updated_by = $2, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid`,
      [ids.organization, actorEmail],
    )
    const inventoryReadiness = await client.query(
      `SELECT
         operations_commerce_store_sync_is_running($1::uuid, $2::uuid)
           AS store_sync_running,
         operations_shopify_inventory_read_config_is_ready(
           $1::uuid, $3::uuid
         ) AS inventory_ready`,
      [ids.organization, ids.account, ids.config],
    )
    assert.deepEqual(inventoryReadiness.rows[0], {
      store_sync_running: true,
      inventory_ready: true,
    }, 'explicit Running + Read only must retain shadow-simulated inventory reads')
  } finally {
    client.release()
  }

  const persistence = loadPersistence(pool)
  const inventoryPersistence = loadInventoryPersistence(pool)
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

  const firstEvidence = await applyInventoryEvidence(
    pool,
    inventoryPersistence,
    firstClaim[0],
  )
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
  const secondEvidence = await applyInventoryEvidence(
    pool,
    inventoryPersistence,
    secondClaim[0],
  )
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

  const legacyJobInsert = await pool.query(
    `INSERT INTO operations_shopify_inventory_refresh_jobs (
       id, organization_id, integration_account_id,
       carrier_service_config_id, warehouse_id,
       credential_generation, activation_revision, config_row_version,
       policy_revision, policy_hash, inventory_max_age_seconds,
       requested_dirty_version, status, attempt_count,
       locked_at, locked_by, lock_token, lease_expires_at, started_at
     ) SELECT
       $1::uuid, $2::uuid, $3::uuid, config.id, $5::uuid,
       config.credential_generation, config.activation_revision,
       config.row_version, config.policy_revision, config.policy_hash,
       config.inventory_max_age_seconds, 1, 'processing', 1,
       now(), 'rolling-legacy-worker', $6::uuid,
       now() + interval '20 minutes', now()
     FROM operations_shopify_carrier_service_configs config
     WHERE config.organization_id = $2::uuid
       AND config.id = $4::uuid
     RETURNING credential_generation, activation_revision,
               config_row_version::text, policy_revision::text,
               policy_hash, inventory_max_age_seconds`,
    [
      ids.legacySuccessJob,
      ids.organization,
      ids.account,
      ids.config,
      ids.warehouseOne,
      ids.legacySuccessLock,
    ],
  )
  assert.equal(legacyJobInsert.rowCount, 1)
  const legacyJobFence = legacyJobInsert.rows[0]
  const legacySuccessClaim = {
    id: ids.legacySuccessJob,
    organizationId: ids.organization,
    integrationAccountId: ids.account,
    accountGlobalId: 'gia2880001',
    carrierServiceConfigId: ids.config,
    warehouseId: ids.warehouseOne,
    locationMappingId: null,
    locationMappingRowVersion: null,
    providerLocationId: null,
    inventoryLocationId: null,
    inventoryPoolId: null,
    credentialGeneration: Number(legacyJobFence.credential_generation),
    activationRevision: Number(legacyJobFence.activation_revision),
    configRowVersion: Number(legacyJobFence.config_row_version),
    policyRevision: Number(legacyJobFence.policy_revision),
    policyHash: legacyJobFence.policy_hash,
    inventoryMaxAgeSeconds: Number(
      legacyJobFence.inventory_max_age_seconds,
    ),
    requestedDirtyVersion: 1,
    attemptCount: 1,
    maxAttempts: 8,
    lockToken: ids.legacySuccessLock,
    startedAt: new Date().toISOString(),
  }
  const legacyFenceState = await pool.query(
    `SELECT job.status, job.cancel_requested,
            job.lock_token::text AS lock_token,
            job.lease_expires_at > clock_timestamp() AS lease_is_live,
            job.credential_generation = config.credential_generation
              AS credential_matches,
            job.activation_revision = config.activation_revision
              AS config_activation_matches,
            job.config_row_version = config.row_version
              AS config_row_matches,
            job.policy_revision = config.policy_revision
              AS policy_revision_matches,
            job.policy_hash = config.policy_hash AS policy_hash_matches,
            job.inventory_max_age_seconds = config.inventory_max_age_seconds
              AS max_age_matches,
            account.status AS account_status,
            account.commerce_credential_generation::text
              AS account_credential_generation,
            credential.verification_status,
            config.registration_state,
            operations_commerce_store_sync_effective_reason(
              job.organization_id, job.integration_account_id
            ) AS store_sync_reason,
            operations_shopify_inventory_read_config_is_ready(
              config.organization_id, config.id
            ) AS inventory_ready
     FROM operations_shopify_inventory_refresh_jobs job
     JOIN operations_shopify_carrier_service_configs config
       ON config.organization_id = job.organization_id
      AND config.id = job.carrier_service_config_id
     JOIN operations_integration_accounts account
       ON account.organization_id = job.organization_id
      AND account.id = job.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = job.organization_id
      AND credential.integration_account_id = job.integration_account_id
     WHERE job.id = $1::uuid`,
    [ids.legacySuccessJob],
  )
  assert.deepEqual(legacyFenceState.rows[0], {
    status: 'processing',
    cancel_requested: false,
    lock_token: ids.legacySuccessLock,
    lease_is_live: true,
    credential_matches: true,
    config_activation_matches: true,
    config_row_matches: true,
    policy_revision_matches: true,
    policy_hash_matches: true,
    max_age_matches: true,
    account_status: 'active',
    account_credential_generation: '1',
    verification_status: 'verified',
    registration_state: 'shadow_simulated',
    store_sync_reason: 'STORE_SYNC_EXPLICIT_RUNNING',
    inventory_ready: true,
  }, 'legacy inventory evidence must retain every exact non-mode fence')
  const legacyEvidence = await applyInventoryEvidence(
    pool,
    inventoryPersistence,
    legacySuccessClaim,
  )
  const legacyState = await pool.query(
    `UPDATE operations_shopify_inventory_refresh_jobs
     SET status = 'succeeded',
         result_summary = jsonb_build_object(
           'resource', 'inventory',
           'readOnly', true,
           'providerWrites', 0,
           'orderQuantityAdjustment', 0,
           'inventoryRunGlobalId', $3::text
         ),
         completed_at = now(),
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         last_error_code = NULL,
         updated_at = now()
     WHERE id = $1::uuid
       AND status = 'processing'
       AND lock_token = $2::uuid
       AND lease_expires_at > now()
     RETURNING status`,
    [
      ids.legacySuccessJob,
      ids.legacySuccessLock,
      legacyEvidence.inventoryRunGlobalId,
    ],
  )
  assert.equal(legacyState.rowCount, 1)
  assert.equal(legacyState.rows[0].status, 'succeeded')

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
