#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'
process.env.CLAWPILOT_ENV = 'development'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
  }
}

function loadTypeScriptModule(path, { mocks = {} } = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (specifier === '@/lib/integrations/commerceReadRuntime') {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceReadRuntime.ts',
        )
      }
      if (specifier === '@/lib/operations/commerceStoreSync') {
        return loadTypeScriptModule(
          'app_src/lib/operations/commerceStoreSync.ts',
        )
      }
      if (specifier === '@/lib/persistence/commerceStoreSync') {
        return {
          async assertCommerceStoreSyncProviderReadLeaseCurrentWithClient() {},
          async withCommerceStoreSyncProviderReadFenceInPostgres(input) {
            return input.read({
              id: '11111111-1111-4111-8111-111111111111',
              authorityKind: input.authorityKind,
              readKind: input.readKind,
              intentFingerprintSha256: 'a'.repeat(64),
              controlRevision: 1,
              activationRevision: 1,
              expiresAt: '2026-08-15T12:00:00.000Z',
            })
          },
        }
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0169_operations_shopify_inventory_refresh_queue.sql',
)
includes(migration, [
  'idx_operations_shopify_inventory_read_singleflight',
  "WHERE action = 'inventory.levels.read'",
  'operations_shopify_inventory_refresh_jobs',
  'cancel_requested boolean NOT NULL DEFAULT false',
  'lease_expires_at timestamptz',
  'idx_operations_shopify_inventory_refresh_active_account',
  "status IN ('pending', 'processing', 'failed')",
  'providerWrites',
  'orderQuantityAdjustment',
], 'Shopify inventory refresh migration')
const activeReadinessMigration = read(
  'db/migrations/0171_shopify_active_account_readiness.sql',
)
includes(activeReadinessMigration, [
  'CREATE OR REPLACE FUNCTION',
  'operations_shopify_carrier_service_config_is_ready',
  "account.status = 'active'",
], 'Shopify active-account readiness migration')
const inventoryAttemptLeaseMigration = read(
  'db/migrations/0172_operations_commerce_inventory_attempt_lease_renewal.sql',
)
includes(inventoryAttemptLeaseMigration, [
  'CREATE OR REPLACE FUNCTION protect_operations_commerce_provider_attempt()',
  "OLD.action <> 'inventory.levels.read'",
  "NEW.action <> 'inventory.levels.read'",
  "ARRAY['lease_token', 'lease_expires_at']::text[]",
  'OLD.lease_expires_at <= clock_timestamp()',
  'OLD.lease_expires_at > clock_timestamp()',
  "clock_timestamp() + interval '15 minutes'",
  'capture.provider_attempt_id = OLD.id',
  'capture.request_hash = OLD.request_hash',
  'Terminal commerce provider attempts are immutable',
], 'Shopify inventory attempt lease-renewal migration')
const inventoryWebhookRefreshMigration = read(
  'db/migrations/0190_operations_shopify_inventory_webhook_refresh.sql',
)
includes(inventoryWebhookRefreshMigration, [
  'operations_shopify_inventory_refresh_watermarks',
  'dirty_version bigint NOT NULL DEFAULT 0',
  'reconciled_version bigint NOT NULL DEFAULT 0',
  'dirty_version > reconciled_version',
  'protect_operations_shopify_inventory_refresh_watermark',
  'watermark versions are monotonic',
  'requested_dirty_version bigint NOT NULL DEFAULT 0',
  'inventory_refresh_version bigint NOT NULL DEFAULT 0',
  'acknowledges only this version',
], 'Shopify inventory webhook refresh migration')

const commerceIntegrationPersistence = read(
  'app_src/lib/persistence/commerceIntegrations.ts',
)
assert.match(
  commerceIntegrationPersistence,
  /if \(SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS\.some\([\s\S]+?signalShopifyInventoryRefreshWithClient/,
  'Inventory webhook topics must signal refresh even while signed receipt intake is held',
)
assert.doesNotMatch(
  commerceIntegrationPersistence,
  /receiptState === 'queued'[\s\S]{0,160}SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS/,
  'Held inventory receipts must not suppress the read-only refresh signal',
)

const persistence = read(
  'app_src/lib/persistence/shopifyInventoryRefresh.ts',
)
includes(persistence, [
  'queueAutomaticShopifyInventoryRefreshesInPostgres',
  'readShopifyInventoryRefreshRecoveryStateFromPostgres',
  'claimShopifyInventoryRefreshJobsInPostgres',
  'completeShopifyInventoryRefreshJobInPostgres',
  'failShopifyInventoryRefreshJobInPostgres',
  'FOR UPDATE OF job SKIP LOCKED',
  'operations_shopify_inventory_read_config_is_ready',
  'credential.verification_status =',
  'config.row_version = job.config_row_version',
  'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
  "actor: 'system'",
  'isSystem: true',
  'readShopifyInventoryRefreshHealthFromPostgres',
  'readShopifyInventoryRefreshWorkerHeartbeatFromPostgres',
  'renewShopifyInventoryRefreshJobLeaseInPostgres',
  'signalShopifyInventoryRefreshWithClient',
  'dirty_version =',
  'reconciled_version',
  'requested_dirty_version',
  'EXCLUDED.requested_dirty_version >',
  'followUpRequired',
  'started_at = now()',
  'provider_attempt_created_at',
  'attempt.requested_at AS provider_attempt_created_at',
  'provider_capture_created_at',
  'providerAttemptBeganAfterClaim',
  'providerEvidenceCapturedAfterClaim',
  'dirty_version = $4::bigint',
  '$6::timestamptz >= last_signaled_at',
  'job.lease_expires_at > now()',
  'recovered.completed_at > dead.completed_at',
  'automaticSchedulingBlocked',
  'managerRecoveryRequired',
  'recoveredAfterDead',
  'projectedRefreshErrorCode',
  "'inventoryRunGlobalId', $5::text",
  'providerWrites: 0',
  'orderQuantityAdjustment: 0',
], 'Shopify inventory refresh persistence')
assert.match(
  persistence,
  /DO UPDATE SET[\s\S]*?requested_dirty_version = EXCLUDED\.requested_dirty_version[\s\S]*?status = 'pending'[\s\S]*?available_at = now\(\)[\s\S]*?EXCLUDED\.requested_dirty_version >[\s\S]*?operations_shopify_inventory_refresh_jobs[\s\S]*?\.requested_dirty_version/,
  'Automatic scheduling may only expedite a failed refresh for a newer webhook dirty version',
)
assert.match(
  persistence,
  /const PERMANENT_ERROR_CODES = new Set\(\[[\s\S]*?'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT'[\s\S]*?\]\)/,
  'A provider-commitment conflict must stop automatic retries until an operator reconciles the affected plan',
)

let recoveryRow = {
  status: 'dead',
  last_error_code: 'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT',
  attempt_count: 8,
  max_attempts: 8,
  available_at: '2026-08-01T12:00:00.000Z',
  completed_at: '2026-08-01T12:05:00.000Z',
  recovered_after_dead: false,
  affected_orders: [{
    globalId: 'gor0006603',
    orderNumber: '#6603',
  }],
}
const recoveryQueries = []
const recoveryPersistence = loadTypeScriptModule(
  'app_src/lib/persistence/shopifyInventoryRefresh.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock() {},
        async query(sql, values) {
          recoveryQueries.push({ sql, values })
          return { rows: [recoveryRow] }
        },
        async withTransaction() {
          assert.fail('Recovery projection must remain read-only')
        },
      },
    },
  },
)
const recoveryInput = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  accountGlobalId: 'gia0000001',
}
const deadRecovery = await recoveryPersistence
  .readShopifyInventoryRefreshRecoveryStateFromPostgres(recoveryInput)
assert.deepEqual(JSON.parse(JSON.stringify(deadRecovery)), {
  status: 'dead',
  automaticSchedulingBlocked: true,
  managerRecoveryRequired: true,
  recoveredAfterDead: false,
  lastErrorCode: 'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT',
  attemptCount: 8,
  maxAttempts: 8,
  availableAt: '2026-08-01T12:00:00.000Z',
  completedAt: '2026-08-01T12:05:00.000Z',
  affectedOrders: [{
    globalId: 'gor0006603',
    orderNumber: '#6603',
  }],
})
assert.equal(recoveryQueries.length, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(recoveryQueries[0].values)),
  [recoveryInput.organizationId, recoveryInput.accountGlobalId],
)
includes(recoveryQueries[0].sql, [
  'account.organization_id = $1::uuid',
  'account.global_id = $2',
  'job.carrier_service_config_id =',
  'job.credential_generation = current.credential_generation',
  'job.activation_revision = current.activation_revision',
  'job.config_row_version = current.row_version',
  'job.policy_revision = current.policy_revision',
  'job.policy_hash = current.policy_hash',
  'job.inventory_max_age_seconds =',
  "job.status NOT IN ('dead', 'mapped_dead')",
  "recovered.status = 'succeeded'",
  'recovered.completed_at > job.completed_at',
  "reservation.reservation_authority = 'provider_commitment'",
  'JOIN LATERAL (',
  'ORDER BY plan.version_number DESC, plan.id DESC',
  "source_order.status = 'released'",
  "latest_plan.status = 'released'",
  'operations_shopify_external_fulfillment_reconciliation_required(',
  'latest_plan.id',
  'source_level.integration_account_id =',
  'position.warehouse_id = job.warehouse_id',
  'position.location_id = job.inventory_location_id',
  'position.pool_id = job.inventory_pool_id',
  "job.last_error_code =",
  "'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT'",
  'source_order.archived_at IS NULL',
  'LIMIT 10',
], 'Tenant-scoped Shopify inventory dead-fence recovery projection')
assert.doesNotMatch(
  recoveryQueries[0].sql,
  /\b(?:INSERT|UPDATE|DELETE)\b/i,
  'Recovery projection must not mutate queue or inventory evidence',
)

recoveryRow = {
  ...recoveryRow,
  recovered_after_dead: true,
}
const recoveredState = await recoveryPersistence
  .readShopifyInventoryRefreshRecoveryStateFromPostgres(recoveryInput)
assert.equal(recoveredState.status, 'dead')
assert.equal(recoveredState.recoveredAfterDead, true)
assert.equal(recoveredState.managerRecoveryRequired, false)
assert.equal(recoveredState.automaticSchedulingBlocked, false)
assert.deepEqual(
  JSON.parse(JSON.stringify(recoveredState.affectedOrders)),
  [],
  'Recovered jobs must not continue projecting stale affected-order actions',
)

recoveryRow = {
  ...recoveryRow,
  recovered_after_dead: false,
  affected_orders: [
    { globalId: '../../orders/6603', orderNumber: '#6603' },
    { globalId: 'gor0006603', orderNumber: 'bad\u0000number' },
  ],
}
const sanitizedRecovery = await recoveryPersistence
  .readShopifyInventoryRefreshRecoveryStateFromPostgres(recoveryInput)
assert.deepEqual(
  JSON.parse(JSON.stringify(sanitizedRecovery.affectedOrders)),
  [],
  'Affected-order links must reject malformed Global IDs and labels',
)

const signalQueries = []
const refreshPersistence = loadTypeScriptModule(
  'app_src/lib/persistence/shopifyInventoryRefresh.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock(client) {
          await client.query('SELECT pg_advisory_xact_lock(1)')
        },
        async query() {
          return { rows: [] }
        },
        async withTransaction(callback) {
          return callback({
            async query(sql) {
              signalQueries.push(sql)
              return {
                rowCount: 1,
                rows: [{ dirty_version: '2', reconciled_version: '1' }],
              }
            },
          })
        },
      },
    },
  },
)
const signaled = await refreshPersistence
  .signalShopifyInventoryRefreshWithClient(
    {
      async query(sql) {
        signalQueries.push(sql)
        return {
          rowCount: 1,
          rows: [{ dirty_version: '6', reconciled_version: '4' }],
        }
      },
    },
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      integrationAccountId: '33333333-3333-4333-8333-333333333333',
      credentialGeneration: 2,
      receiptGlobalId: 'gcw1234567',
      providerTriggeredAt: '2026-07-30T12:00:00.000Z',
    },
  )
assert.deepEqual(
  JSON.parse(JSON.stringify(signaled)),
  { dirtyVersion: 6, reconciledVersion: 4 },
)
const signalUpsert = signalQueries.find((sql) => (
  sql.includes('INSERT INTO operations_shopify_inventory_refresh_watermarks')
))
assert.ok(signalUpsert, 'Shopify inventory webhook dirty signal was not issued')
includes(signalUpsert, [
  'ON CONFLICT (organization_id, integration_account_id)',
  '.dirty_version + 1',
  'RETURNING dirty_version::text, reconciled_version::text',
], 'Shopify inventory webhook dirty signal')

const providerCommitmentConflict = new Error(
  'Current Shopify committed quantity no longer supports the claim',
)
providerCommitmentConflict.code =
  'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT'
const stoppedConflict = await refreshPersistence
  .failShopifyInventoryRefreshJobInPostgres({
    job: {
      id: '99999999-9999-4999-8999-999999999999',
      organizationId: recoveryInput.organizationId,
      integrationAccountId:
        '33333333-3333-4333-8333-333333333333',
      accountGlobalId: 'gia0000001',
      carrierServiceConfigId:
        '44444444-4444-4444-8444-444444444444',
      warehouseId: '55555555-5555-4555-8555-555555555555',
      locationMappingId: null,
      locationMappingRowVersion: null,
      providerLocationId: null,
      inventoryLocationId: null,
      inventoryPoolId: null,
      credentialGeneration: 2,
      activationRevision: 3,
      configRowVersion: 4,
      policyRevision: 5,
      policyHash: 'a'.repeat(64),
      inventoryMaxAgeSeconds: 900,
      requestedDirtyVersion: 6,
      attemptCount: 1,
      maxAttempts: 8,
      lockToken: '88888888-8888-4888-8888-888888888888',
      startedAt: '2026-07-30T12:00:00.000Z',
    },
    error: providerCommitmentConflict,
  })
assert.equal(stoppedConflict.code, providerCommitmentConflict.code)
assert.equal(stoppedConflict.dead, true)
assert.equal(stoppedConflict.leaseLost, false)
assert.equal(stoppedConflict.retryAt, null)

const completionQueries = []
const completionPersistence = loadTypeScriptModule(
  'app_src/lib/persistence/shopifyInventoryRefresh.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock(client) {
          await client.query('SELECT pg_advisory_xact_lock(1)')
        },
        async query() {
          return { rows: [] }
        },
        async withTransaction(callback) {
          return callback({
            async query(sql) {
              completionQueries.push(sql)
              if (sql.includes('SELECT 1')) {
                return { rowCount: 1, rows: [{ '?column?': 1 }] }
              }
              if (sql.includes('inventory_sync_runs')) {
                return {
                  rowCount: 1,
                  rows: [{
                    id: '77777777-7777-4777-8777-777777777777',
                    global_id: 'gisr1234567',
                    provider_fetched_at: '2026-07-30T12:01:00.000Z',
                    provider_attempt_created_at:
                      '2026-07-30T12:00:30.000Z',
                    provider_capture_created_at:
                      '2026-07-30T12:01:00.000Z',
                    completed_at: '2026-07-30T12:01:01.000Z',
                    levels_seen: 1,
                    levels_projected: 1,
                    provider_writes: 0,
                    order_quantity_adjustment: '0',
                  }],
                }
              }
              if (sql.includes('UPDATE operations_shopify_inventory_refresh_jobs')) {
                return { rowCount: 1, rows: [] }
              }
              if (sql.includes('SELECT dirty_version::text')) {
                return {
                  rowCount: 1,
                  rows: [{ dirty_version: '6', reconciled_version: '5' }],
                }
              }
              assert.fail(`Unexpected completion query: ${sql}`)
            },
          })
        },
      },
    },
  },
)

const inventoryPersistence = read(
  'app_src/lib/persistence/commerceInventory.ts',
)
assert.match(
  inventoryPersistence,
  /\[\s*'shopify-inventory-read',\s*input\.runtime\.organizationId,\s*input\.runtime\.integrationAccountId,\s*\]\.join/,
  'Inventory reads must lock at account scope, independent of idempotency key',
)
includes(inventoryPersistence, [
  'SHOPIFY_INVENTORY_SYNC_IN_PROGRESS',
  'SHOPIFY_INVENTORY_CAPTURE_LEASE_REACQUIRE_FAILED',
  'AS lease_is_live',
  "SET lease_token = gen_random_uuid()",
  'attempt.lease_expires_at <= clock_timestamp()',
  'capture.provider_attempt_id = attempt.id',
  'capture.request_hash = attempt.request_hash',
  'renewShopifyInventoryReadLeaseInPostgres',
  'expectedRefreshFence',
  'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
  'AND lease_expires_at > clock_timestamp()',
  "'operations:inventory-reservation'",
  "reservation.reservation_authority = 'local_balance'",
  "reservation.reservation_authority = 'provider_commitment'",
  'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT',
  "actor: input.actorEmail || 'system'",
  'isSystem: !input.actorEmail',
], 'Shopify inventory single-flight persistence')
assert.match(
  inventoryPersistence,
  /AND job\.status = CASE[\s\S]*?WHEN \$14::uuid IS NULL THEN 'processing'[\s\S]*?ELSE 'mapped_processing'[\s\S]*?END/,
  'The projection fence must accept both legacy processing and mapped processing jobs without weakening the mapping fence',
)
assert.match(
  inventoryPersistence,
  /const reservedLocally = await client\.query\([\s\S]*?reservation\.status = 'active'[\s\S]*?reservation\.reservation_authority = 'local_balance'[\s\S]*?SHOPIFY_INVENTORY_LOCAL_RESERVATION_CONFLICT/,
  'Shopify refresh must ignore provider-commitment claims already represented in Shopify committed quantity',
)
assert.match(
  inventoryPersistence,
  /const activeProviderCommitments = await client\.query[\s\S]*?reservation\.reservation_authority = 'provider_commitment'[\s\S]*?projectedByProduct\.get\(claim\.product_id\)[\s\S]*?SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT/,
  'Shopify refresh must fail closed when current committed quantity cannot cover active provider commitments',
)
assert.doesNotMatch(
  inventoryPersistence,
  /lease_expires_at\.getTime\(\)\s*[<>]=?\s*Date\.now\(\)/,
  'Inventory lease decisions must use the PostgreSQL wall clock',
)
assert.doesNotMatch(
  inventoryPersistence,
  /lease_expires_at\s*=\s*\$\d+::timestamptz/,
  'Inventory lease fences must not round-trip PostgreSQL microseconds through JavaScript Date',
)

const inventoryTargetIds = {
  organization: '11111111-1111-4111-8111-111111111111',
  account: '22222222-2222-4222-8222-222222222222',
  agWarehouse: '33333333-3333-4333-8333-333333333333',
  proofWarehouse: '44444444-4444-4444-8444-444444444444',
  agLocation: '55555555-5555-4555-8555-555555555555',
}
const inventoryTargetRuntime = {
  organizationId: inventoryTargetIds.organization,
  integrationAccountId: inventoryTargetIds.account,
  globalId: 'gia0000001',
  credentialVersion: 3,
}
const agMapping = {
  id: '66666666-6666-4666-8666-666666666666',
  global_id: 'gilm0000001',
  external_location_id: 'gid://shopify/Location/35568222286',
  external_location_name: 'Ag-Alchemy',
  warehouse_id: inventoryTargetIds.agWarehouse,
  location_id: inventoryTargetIds.agLocation,
}
const agTargetRow = {
  integration_account_id: inventoryTargetIds.account,
  credential_version: 3,
  verification_status: 'verified',
  account_status: 'active',
  pipeline_id: '77777777-7777-4777-8777-777777777777',
  warehouse_id: inventoryTargetIds.agWarehouse,
  warehouse_global_id: 'gwh5366613',
  warehouse_name: 'Ag-Alchemy',
  warehouse_address: { countryCode: 'US' },
  location_id: inventoryTargetIds.agLocation,
  location_global_id: 'gol0000001',
  location_code: 'RESERVE-01',
}

function inventoryTargetPersistenceScenario({
  mappings = [],
  configuredWarehouses = [],
  activeWarehouses = [],
  targetRow = agTargetRow,
}) {
  const queries = []
  const loaded = loadTypeScriptModule(
    'app_src/lib/persistence/commerceInventory.ts',
    {
      mocks: {
        '@/lib/auditWriter': {
          async recordAuditEvent() {},
        },
        '@/lib/integrations/shopifyInventory': {
          SHOPIFY_INVENTORY_ADAPTER_VERSION: 'test',
        },
        '@/lib/operations/shopifyInventoryProjection': {
          projectShopifyInventoryBalance() {
            assert.fail('Target selection must not project inventory')
          },
        },
        '@/lib/persistence/postgres': {
          async acquireTransactionAdvisoryLock() {
            assert.fail('Target selection must remain read-only')
          },
          async withTransaction() {
            assert.fail('Target selection must remain read-only')
          },
          async query(sql, values) {
            queries.push({ sql, values })
            if (sql.includes(
              'FROM operations_commerce_inventory_location_mappings mapping',
            )) {
              return { rowCount: mappings.length, rows: mappings }
            }
            if (sql.includes(
              'FROM operations_shopify_carrier_service_configs config',
            )) {
              const rows = configuredWarehouses.map((warehouse_id) => ({
                warehouse_id,
              }))
              return { rowCount: rows.length, rows }
            }
            if (sql.includes('WITH selected_location AS')) {
              return {
                rowCount: targetRow ? 1 : 0,
                rows: targetRow ? [targetRow] : [],
              }
            }
            if (
              sql.includes('FROM operations_warehouses warehouse')
              && !sql.includes('JOIN operations_integration_accounts')
            ) {
              const rows = activeWarehouses.map((warehouse_id) => ({
                warehouse_id,
              }))
              return { rowCount: rows.length, rows }
            }
            assert.fail(`Unexpected inventory target query: ${sql}`)
          },
        },
      },
    },
  )
  return { loaded, queries }
}

const mappedTargetScenario = inventoryTargetPersistenceScenario({
  mappings: [agMapping],
  configuredWarehouses: [inventoryTargetIds.agWarehouse],
  activeWarehouses: [
    inventoryTargetIds.agWarehouse,
    inventoryTargetIds.proofWarehouse,
  ],
})
const mappedTarget = await mappedTargetScenario.loaded
  .readShopifyInventoryTargetFromPostgres({
    runtime: inventoryTargetRuntime,
  })
assert.equal(mappedTarget.warehouse.globalId, 'gwh5366613')
assert.equal(mappedTarget.location.code, 'RESERVE-01')
assert.equal(
  mappedTarget.existingMapping.externalLocationId,
  'gid://shopify/Location/35568222286',
)
const mappedTargetRead = mappedTargetScenario.queries.find(({ sql }) => (
  sql.includes('WITH selected_location AS')
))
assert.deepEqual(
  JSON.parse(JSON.stringify(mappedTargetRead.values)),
  [
    inventoryTargetIds.organization,
    inventoryTargetRuntime.globalId,
    inventoryTargetIds.agWarehouse,
    inventoryTargetIds.agLocation,
  ],
)
assert.equal(
  mappedTargetScenario.queries.some(({ sql }) => (
    sql.includes('SELECT warehouse.id::text AS warehouse_id')
  )),
  false,
  'A saved/configured Ag-Alchemy target must not fall back to active warehouse count',
)

const configuredTargetScenario = inventoryTargetPersistenceScenario({
  configuredWarehouses: [inventoryTargetIds.agWarehouse],
  activeWarehouses: [
    inventoryTargetIds.agWarehouse,
    inventoryTargetIds.proofWarehouse,
  ],
})
await configuredTargetScenario.loaded
  .readShopifyInventoryTargetFromPostgres({
    runtime: inventoryTargetRuntime,
  })
const configuredTargetRead = configuredTargetScenario.queries.find(
  ({ sql }) => sql.includes('WITH selected_location AS'),
)
assert.deepEqual(
  JSON.parse(JSON.stringify(configuredTargetRead.values)),
  [
    inventoryTargetIds.organization,
    inventoryTargetRuntime.globalId,
    inventoryTargetIds.agWarehouse,
    null,
  ],
)

const fenceMismatchScenario = inventoryTargetPersistenceScenario({
  mappings: [agMapping],
  configuredWarehouses: [inventoryTargetIds.agWarehouse],
})
await assert.rejects(
  fenceMismatchScenario.loaded.readShopifyInventoryTargetFromPostgres({
    runtime: inventoryTargetRuntime,
    expectedWarehouseId: inventoryTargetIds.proofWarehouse,
  }),
  (error) => (
    error.code === 'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED'
  ),
)
assert.equal(
  fenceMismatchScenario.queries.some(({ sql }) => (
    sql.includes('WITH selected_location AS')
  )),
  false,
  'A refresh fence mismatch must fail before reading a target location',
)

const authorityConflictScenario = inventoryTargetPersistenceScenario({
  mappings: [agMapping],
  configuredWarehouses: [inventoryTargetIds.proofWarehouse],
})
await assert.rejects(
  authorityConflictScenario.loaded
    .readShopifyInventoryTargetFromPostgres({
      runtime: inventoryTargetRuntime,
    }),
  (error) => (
    error.code === 'SHOPIFY_INVENTORY_WAREHOUSE_AUTHORITY_CONFLICT'
  ),
)
assert.equal(
  authorityConflictScenario.queries.some(({ sql }) => (
    sql.includes('WITH selected_location AS')
  )),
  false,
  'Conflicting mapping and carrier configuration must fail before target selection',
)

const ambiguousConfigScenario = inventoryTargetPersistenceScenario({
  configuredWarehouses: [
    inventoryTargetIds.agWarehouse,
    inventoryTargetIds.proofWarehouse,
  ],
})
await assert.rejects(
  ambiguousConfigScenario.loaded
    .readShopifyInventoryTargetFromPostgres({
      runtime: inventoryTargetRuntime,
    }),
  (error) => (
    error.code === 'SHOPIFY_INVENTORY_CARRIER_CONFIG_AMBIGUOUS'
  ),
)

const ambiguousFallbackScenario = inventoryTargetPersistenceScenario({
  activeWarehouses: [
    inventoryTargetIds.agWarehouse,
    inventoryTargetIds.proofWarehouse,
  ],
})
await assert.rejects(
  ambiguousFallbackScenario.loaded
    .readShopifyInventoryTargetFromPostgres({
      runtime: inventoryTargetRuntime,
    }),
  (error) => (
    error.code === 'SHOPIFY_INVENTORY_SINGLE_WAREHOUSE_REQUIRED'
  ),
)
assert.equal(
  ambiguousFallbackScenario.queries.some(({ sql }) => (
    sql.includes('WITH selected_location AS')
  )),
  false,
  'A multi-warehouse workspace without authority must fail before target selection',
)

const orchestration = read(
  'app_src/lib/integrations/commerceInventory.ts',
)
includes(orchestration, [
  'actorEmail?: string | null',
  'const actorEmail = input.actorEmail || null',
  'idempotencyKey: attempt.idempotencyKey',
  'effectiveIdempotencyKey: attempt.idempotencyKey',
  'inventoryRunGlobalId: applied.runGlobalId',
  'expectedRefreshFence: input.expectedRefreshFence',
  'expectedWarehouseId: input.expectedRefreshFence?.warehouseId || null',
  'onProgress: async (current)',
  'readShopifyInventoryRefreshRecoveryStateFromPostgres',
  'return { ...inventory, refreshRecovery }',
], 'Shopify inventory orchestration')

const inventoryRoute = read(
  'app_src/app/api/integrations/commerce/inventory/route.ts',
)
includes(inventoryRoute, [
  'requireRequestUser(req)',
  'operationsCapabilities(user).canManage',
  'SHOPIFY_INVENTORY_MANAGER_REQUIRED',
  "body.action !== 'sync'",
  'actorEmail: user.email',
], 'Authenticated Shopify inventory manager recovery route')

const inventoryPanel = read(
  'app_src/components/operations/ShopifyInventoryPanel.tsx',
)
includes(inventoryPanel, [
  'refreshRecovery?.managerRecoveryRequired',
  'refreshRecovery?.affectedOrders || []',
  'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT',
  'Open order {order.orderNumber}',
  'onOpenOrder(order.globalId)',
  'reconcile the Shopify fulfillment, then retry inventory sync',
  '<strong>Refresh this</strong>',
  'Shopify inventory refresh is queued or retrying automatically.',
  'Wait for that bounded attempt instead of starting another read.',
  'window.setInterval',
  'automatic scheduling is eligible again',
  'The failed job remains preserved as audit evidence.',
], 'Shopify inventory recovery user experience')

const commerceImportsPanel = read(
  'app_src/components/operations/CommerceImportsPanel.tsx',
)
includes(commerceImportsPanel, [
  'onOpenOrder: (orderGlobalId: string) => void',
  'onOpenOrder={onOpenOrder}',
], 'Shopify inventory affected-order navigation handoff')

const operationsSection = read(
  'app_src/components/operations/OperationsSection.tsx',
)
includes(operationsSection, [
  '<CommerceImportsPanel onOpenOrder={openPickingOrder} />',
  "const OPERATIONS_ORDER_QUERY = 'operationsOrder'",
  'OPERATIONS_ORDER_GLOBAL_ID.test(pendingOrderGlobalId)',
  'const openPickingOrder = (orderGlobalId: string) => {',
  "if (view === 'orders')",
  'nextUrl.searchParams.set(OPERATIONS_ORDER_QUERY, orderGlobalId)',
  'nextUrl.searchParams.delete(OPERATIONS_ORDER_QUERY)',
  'setSelectedGlobalId(orderGlobalId)',
  'setSelectedGlobalId(pendingOrderGlobalId)',
  'setDrawerOpen(true)',
  "window.location.hash = 'operations'",
], 'Shopify inventory affected-order Operations drawer navigation')

const job = {
  id: '22222222-2222-4222-8222-222222222222',
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '33333333-3333-4333-8333-333333333333',
  accountGlobalId: 'gia0000001',
  carrierServiceConfigId: '44444444-4444-4444-8444-444444444444',
  warehouseId: '55555555-5555-4555-8555-555555555555',
  locationMappingId: null,
  locationMappingRowVersion: null,
  providerLocationId: null,
  inventoryLocationId: null,
  inventoryPoolId: null,
  credentialGeneration: 2,
  activationRevision: 4,
  configRowVersion: 6,
  policyRevision: 8,
  policyHash: 'a'.repeat(64),
  inventoryMaxAgeSeconds: 900,
  requestedDirtyVersion: 6,
  attemptCount: 2,
  maxAttempts: 8,
  lockToken: '66666666-6666-4666-8666-666666666666',
  // The first provider attempt succeeded at 12:01, then the worker failed.
  // A webhook dirtied version 6 before this retry claimed a new attempt window.
  startedAt: '2026-07-30T12:02:00.000Z',
}
const lostWakeupCompletion = await completionPersistence
  .completeShopifyInventoryRefreshJobInPostgres({
    job,
    effectiveIdempotencyKey: 'shopify-inventory-refresh:watermark-proof',
    inventoryRunGlobalId: 'gisr1234567',
  })
assert.equal(lostWakeupCompletion.status, 'succeeded')
assert.equal(lostWakeupCompletion.requestedDirtyVersion, 6)
assert.equal(lostWakeupCompletion.currentDirtyVersion, 6)
assert.equal(lostWakeupCompletion.reconciledDirtyVersion, 5)
assert.equal(lostWakeupCompletion.followUpRequired, true)
assert.equal(
  completionQueries.some((sql) => (
    sql.includes('UPDATE operations_shopify_inventory_refresh_watermarks')
  )),
  false,
  'A replayed pre-claim provider capture must not acknowledge a newer webhook dirty version',
)
const trace = {
  claim: [],
  renew: [],
  heartbeat: [],
  sync: [],
  complete: [],
  fail: [],
}
const worker = loadTypeScriptModule(
  'app_src/lib/shopifyInventoryRefreshWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceInventory': {
        async syncShopifyInventory(input) {
          trace.sync.push(input)
          await input.onProgress({
            phase: 'inventory_page',
            pageCount: 7,
          })
          return {
            replayed: false,
            effectiveIdempotencyKey: 'manager-owned-overlap-key',
            inventoryRunGlobalId: 'gir1234567',
          }
        },
      },
      '@/lib/persistence/shopifyInventoryRefresh': {
        async queueAutomaticShopifyInventoryRefreshesInPostgres() {
          return { queued: 1, cancelled: 0 }
        },
        async claimShopifyInventoryRefreshJobsInPostgres(input) {
          trace.claim.push(input)
          return [job]
        },
        async renewShopifyInventoryRefreshJobLeaseInPostgres(input) {
          trace.renew.push(input)
          return true
        },
        async recordShopifyInventoryRefreshWorkerHeartbeatInPostgres(input) {
          trace.heartbeat.push(input)
        },
        async completeShopifyInventoryRefreshJobInPostgres(input) {
          trace.complete.push(input)
          return { status: 'succeeded' }
        },
        async failShopifyInventoryRefreshJobInPostgres(input) {
          trace.fail.push(input)
          return { dead: false, leaseLost: false }
        },
      },
    },
  },
)
const completed = await worker.processShopifyInventoryRefreshOutbox({
  limit: 1,
  workerId: 'worker-one',
})
assert.equal(completed.autoQueued, 1)
assert.equal(completed.claimed, 1)
assert.equal(completed.completed, 1)
assert.equal(completed.providerWrites, 0)
assert.equal(completed.orderQuantityAdjustment, 0)
assert.equal(trace.sync.length, 1)
assert.equal(trace.claim.length, 1)
assert.equal(trace.claim[0].limit, 1)
assert.equal(trace.renew.length, 1)
assert.equal(trace.heartbeat[0].pageCount, 7)
assert.equal(trace.sync[0].actorEmail, null)
assert.equal(
  trace.sync[0].idempotencyKey,
  `shopify-inventory-refresh:${job.id}`,
)
assert.equal(
  trace.complete[0].effectiveIdempotencyKey,
  'manager-owned-overlap-key',
)
assert.equal(trace.complete[0].inventoryRunGlobalId, 'gir1234567')
assert.deepEqual(
  JSON.parse(JSON.stringify(trace.sync[0].expectedRefreshFence)),
  {
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
)
assert.equal(trace.fail.length, 0)

const retryTrace = []
let retryClaimed = false
const retryWorker = loadTypeScriptModule(
  'app_src/lib/shopifyInventoryRefreshWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceInventory': {
        async syncShopifyInventory() {
          const failure = new Error('provider busy')
          failure.code = 'SHOPIFY_INVENTORY_SYNC_IN_PROGRESS'
          throw failure
        },
      },
      '@/lib/persistence/shopifyInventoryRefresh': {
        async queueAutomaticShopifyInventoryRefreshesInPostgres() {
          return { queued: 0, cancelled: 0 }
        },
        async claimShopifyInventoryRefreshJobsInPostgres() {
          if (retryClaimed) return []
          retryClaimed = true
          return [job]
        },
        async renewShopifyInventoryRefreshJobLeaseInPostgres() {
          return true
        },
        async recordShopifyInventoryRefreshWorkerHeartbeatInPostgres() {
        },
        async completeShopifyInventoryRefreshJobInPostgres() {
          assert.fail('failed refresh must not complete')
        },
        async failShopifyInventoryRefreshJobInPostgres(input) {
          retryTrace.push(input)
          return { dead: false, leaseLost: false }
        },
      },
    },
  },
)
const retried = await retryWorker.processShopifyInventoryRefreshOutbox({
  workerId: 'worker-two',
})
assert.equal(retried.retried, 1)
assert.equal(retried.dead, 0)
assert.equal(retryTrace.length, 1)
assert.equal(retryTrace[0].error.code, 'SHOPIFY_INVENTORY_SYNC_IN_PROGRESS')

const leaseTrace = {
  complete: 0,
  fail: [],
}
const leaseWorker = loadTypeScriptModule(
  'app_src/lib/shopifyInventoryRefreshWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceInventory': {
        async syncShopifyInventory(input) {
          await input.onProgress({ phase: 'inventory_page', pageCount: 1 })
          assert.fail('lost job lease must abort sync progress')
        },
      },
      '@/lib/persistence/shopifyInventoryRefresh': {
        async queueAutomaticShopifyInventoryRefreshesInPostgres() {
          return { queued: 0, cancelled: 0 }
        },
        async claimShopifyInventoryRefreshJobsInPostgres() {
          return [job]
        },
        async renewShopifyInventoryRefreshJobLeaseInPostgres() {
          return false
        },
        async recordShopifyInventoryRefreshWorkerHeartbeatInPostgres() {
          assert.fail('lost lease must not publish processing heartbeat')
        },
        async completeShopifyInventoryRefreshJobInPostgres() {
          leaseTrace.complete += 1
        },
        async failShopifyInventoryRefreshJobInPostgres(input) {
          leaseTrace.fail.push(input)
          return { dead: false, leaseLost: true }
        },
      },
    },
  },
)
const leaseLost = await leaseWorker.processShopifyInventoryRefreshOutbox({
  limit: 1,
  workerId: 'worker-lease-lost',
})
assert.equal(leaseLost.cancelled, 1)
assert.equal(leaseTrace.complete, 0)
assert.equal(leaseTrace.fail.length, 1)
assert.equal(
  leaseTrace.fail[0].error.code,
  'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
)

const route = read(
  'app_src/app/api/integrations/commerce/inventory/process/route.ts',
)
includes(route, [
  'PIPELINE_OUTBOX_WORKER_SECRET',
  'timingSafeEqual',
  'shopifyInventoryRuntimeAvailable()',
  'isPostgresStorageEnabled()',
  'processShopifyInventoryRefreshOutbox',
  'recordShopifyInventoryRefreshWorkerHeartbeatInPostgres',
], 'Shopify inventory refresh route')
const poller = read('scripts/pipeline-outbox-poller.mjs')
includes(poller, [
  'SHOPIFY_INVENTORY_REFRESH_POLL_MS',
  "runLoop('shopify-inventory-refresh'",
  '/api/integrations/commerce/inventory/process',
], 'Shopify inventory refresh poller')
includes(
  read('app_src/proxy.ts'),
  ['/api/integrations/commerce/inventory/process'],
  'Shopify inventory refresh proxy allowlist',
)
const health = read('app_src/app/api/health/route.ts')
includes(health, [
  'operations_shopify_inventory_refresh_migration_applied',
  'operations_shopify_inventory_webhook_refresh_applied',
  'operations_shopify_checkout_plan_rate_policy_applied',
  'shopify_active_account_readiness_migration_applied',
  'operations_commerce_inventory_attempt_lease_renewal_applied',
  "operationalStatus: operationalDegraded ? 'degraded' : 'ready'",
  'readShopifyInventoryRefreshHealthFromPostgres',
  'Shopify inventory refresh worker heartbeat is missing or stale.',
  'Checkout-ready Shopify accounts have stale inventory evidence.',
], 'Shopify inventory refresh health')
const checkoutContext = read(
  'app_src/lib/persistence/shopifyCheckoutContext.ts',
)
includes(checkoutContext, [
  'SHOPIFY_CHECKOUT_INVENTORY_SYNC_REQUIRED',
  'SHOPIFY_CHECKOUT_INVENTORY_STALE',
  'SHOPIFY_CHECKOUT_INVENTORY_REFRESH_PENDING',
  'dirty_version::text, reconciled_version::text',
  'account.inventoryMaxAgeSeconds * 1_000',
], 'Shopify checkout inventory freshness gate')
const predeploy = read('scripts/verify-predeploy.mjs')
includes(predeploy, [
  "'db/migrations/0169_operations_shopify_inventory_refresh_queue.sql'",
  "'db/migrations/0171_shopify_active_account_readiness.sql'",
  "'db/migrations/0172_operations_commerce_inventory_attempt_lease_renewal.sql'",
  "'db/migrations/0190_operations_shopify_inventory_webhook_refresh.sql'",
  "'scripts/test-shopify-inventory-refresh-worker.mjs'",
  "'scripts/test-shopify-inventory-refresh-postgres.mjs'",
], 'Shopify inventory refresh predeploy gate')
const packageManifest = JSON.parse(read('package.json'))
assert.equal(
  packageManifest.scripts['test:shopify-inventory-refresh-postgres'],
  'node scripts/test-shopify-inventory-refresh-postgres.mjs',
  'Postgres acceptance must remain an explicit opt-in npm script',
)

console.log(
  'Shopify inventory refresh worker tests passed '
  + '(queue fences, account single-flight, system actor, lease, retry, '
  + 'route, poller, health, checkout freshness, zero provider writes).',
)
