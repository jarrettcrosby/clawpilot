#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
  }
}

function loadTypeScriptModule(path, { mocks = {}, globals = {} } = {}) {
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
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const persistence = read('app_src/lib/persistence/commerceOrderReconciliation.ts')
const shippingServiceCodeMigration = read(
  'db/migrations/0173_operations_shopify_shipping_service_codes.sql',
)
includes(persistence, [
  "const ORDER_RECONCILIATION_INTERVAL = '30 minutes'",
  "const ORDER_RECONCILIATION_LEASE = '10 minutes'",
  "? 'read_orders'",
  "credential.auth_mode = 'faire_brand_token'",
  "? 'READ_ORDERS'",
  "account.status <> 'error'",
  "activation.state IN ('shadow', 'active')",
  "reconciliation_status = 'running'",
  "reconciliation_status = 'succeeded'",
  "reconciliation_status = 'failed'",
  'LEFT JOIN LATERAL',
  "continuation.cursor_state = 'available'",
  "continuation.resource = 'orders'",
  'continuation.provider = account.provider',
  'continuation.credential_version',
  "run.created_by = 'system:commerce-order-reconciliation'",
  'continuation_run_global_id',
  'continuation_idempotency_key',
  "active_intent.intent_state",
  'THEN 0',
  'ELSE operations_commerce_sync_cursors.records_seen',
  'ELSE operations_commerce_sync_cursors.records_held',
  'readCommerceOrderReconciliationStateInPostgres',
  'providerWrites: 0',
  'canonicalOrderWrites: 0',
  'inventoryWrites: 0',
], 'Order reconciliation persistence')
includes(shippingServiceCodeMigration, [
  'operations_commerce_order_candidates_checkout_service_valid',
  'BETWEEN 1 AND 255',
  "checkout_shipping_service_code !~ '[[:cntrl:]]'",
  'Opaque Shopify ShippingLine.code',
], 'Shopify shipping-service-code migration')
assert.ok(
  !shippingServiceCodeMigration.includes('BETWEEN 3 AND 80'),
  'Shopify opaque shipping method codes must not inherit ClawPilot service-code length rules',
)
assert.ok(!persistence.includes('provider_cursor ='), 'Order reconciliation must not persist a provider cursor')
assert.ok(!persistence.includes("? 'read_all_orders'"), 'Current automatic order reconciliation must not require historical-order scope')
assert.ok(
  !persistence.includes('faire_updated_at_min')
    && !persistence.includes('high_watermark ='),
  'Faire automatic reconciliation must not use an unsafe live-cursor incremental checkpoint',
)

let claimSql = ''
const claimStartedAt = new Date('2026-07-28T14:15:16.789Z')
const persistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async withTransaction(callback) {
          return callback({
            async query(sql) {
              claimSql = sql
              return {
                rows: [{
                  organization_id:
                    '11111111-1111-4111-8111-111111111111',
                  integration_account_id:
                    '22222222-2222-4222-8222-222222222222',
                  account_global_id: 'gca0000001',
                  provider: 'faire',
                  credential_version: 2,
                  continuation_run_global_id: null,
                  continuation_idempotency_key: null,
                  last_started_at: claimStartedAt,
                }],
              }
            },
          })
        },
      },
    },
  },
)
const claimedTargets = await persistenceModule
  .claimCommerceOrderReconciliationTargetsInPostgres({ limit: 1 })
assert.match(
  claimSql,
  /RETURNING[\s\S]*last_started_at/,
  'Claim SQL must return the persisted reconciliation lease timestamp',
)
assert.equal(claimedTargets.length, 1)
assert.equal(
  claimedTargets[0].startedAt,
  claimStartedAt.toISOString(),
  'Claim mapping must use last_started_at returned by the sync cursor',
)

const persistedFailureCodes = []
const failurePersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async withTransaction(callback) {
          return callback({
            async query(_sql, values) {
              persistedFailureCodes.push(values[3])
              return {
                rowCount: 1,
                rows: [{
                  organization_id:
                    '11111111-1111-4111-8111-111111111111',
                }],
              }
            },
          })
        },
      },
    },
  },
)
const failureTarget = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  accountGlobalId: 'gca0000001',
  provider: 'shopify',
  credentialVersion: 1,
  startedAt: '2026-07-27T12:00:00.000Z',
  continuationRunGlobalId: null,
  continuationIdempotencyKey: null,
}
const knownConstraintFailure = await failurePersistenceModule
  .failCommerceOrderReconciliationInPostgres({
    target: failureTarget,
    error: {
      code: '23514',
      constraint:
        'operations_commerce_order_candidates_checkout_service_valid',
    },
  })
assert.equal(
  knownConstraintFailure.errorCode,
  'COMMERCE_ORDER_CHECKOUT_SERVICE_CODE_INVALID',
)
const unknownConstraintFailure = await failurePersistenceModule
  .failCommerceOrderReconciliationInPostgres({
    target: failureTarget,
    error: {
      code: '23514',
      constraint: 'provider_or_customer_data_must_not_escape',
    },
  })
assert.equal(
  unknownConstraintFailure.errorCode,
  'COMMERCE_ORDER_RECONCILIATION_CHECK_CONSTRAINT_FAILED',
)
assert.deepEqual(persistedFailureCodes, [
  'COMMERCE_ORDER_CHECKOUT_SERVICE_CODE_INVALID',
  'COMMERCE_ORDER_RECONCILIATION_CHECK_CONSTRAINT_FAILED',
])

const workerSource = read('app_src/lib/commerceOrderReconciliationWorker.ts')
assert.ok(
  workerSource.includes('never promotes canonical orders, derives packages or shipments'),
  'Order reconciliation must remain package-agnostic and preserve held source quantities',
)
const intakeSource = read('app_src/lib/integrations/commerceIntake.ts')
includes(intakeSource, [
  'export async function executeCommerceOrderPage',
  "action: input.continuationRunGlobalId ? 'fetch-next' : 'fetch'",
  'includeIntakeState: false',
  'hydrateProductInventory: false',
], 'Order-page execution path')
assert.ok(
  !intakeSource.includes('updatedAtMin: page.windowStart')
    && !intakeSource.includes('initialWindowStart'),
  'Fresh Faire automatic polls must start as full current-order scans',
)
assert.ok(
  intakeSource.includes('Shopify must grant read_orders for current operational intake'),
  'Current order reads must require only read_orders',
)
assert.ok(
  intakeSource.includes('currentOrderWindow')
    && intakeSource.includes("updated_at:>='${page.windowStart}'"),
  'Current Shopify reads must stay inside the provider default-order window',
)

const trace = { claims: 0, complete: [], failed: [] }
let page = 0
const worker = loadTypeScriptModule('app_src/lib/commerceOrderReconciliationWorker.ts', {
  mocks: {
    '@/lib/integrations/commerceIntake': {
      commerceIntakeRuntimeAvailable: () => true,
      async executeCommerceOrderPage(input) {
        assert.equal(input.actorEmail, 'system:commerce-order-reconciliation')
        assert.ok(
          !Object.prototype.hasOwnProperty.call(input, 'initialWindowStart'),
          'Faire polling must not inject an unsafe incremental lower bound',
        )
        if (page === 0) {
          assert.equal(input.continuationRunGlobalId, null)
          page += 1
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 3,
              recordsRejected: 1,
              pagination: {
                providerRowsSeen: 4,
                hasNextBatch: true,
                continuationRunGlobalId: 'gcir0000001',
                windowEnd: '2026-07-27T12:00:01.000Z',
              },
            },
          }
        }
        assert.equal(input.continuationRunGlobalId, 'gcir0000001')
        page += 1
        return {
          command: {
            providerWrites: 0,
            syncCursorAdvanced: false,
            ordersStaged: 2,
            recordsRejected: 0,
            pagination: {
              providerRowsSeen: 2,
              hasNextBatch: false,
              windowEnd: '2026-07-27T12:00:01.000Z',
            },
          },
        }
      },
    },
    '@/lib/persistence/commerceOrderReconciliation': {
      async claimCommerceOrderReconciliationTargetsInPostgres() {
        trace.claims += 1
        return [{
          organizationId: '11111111-1111-4111-8111-111111111111',
          integrationAccountId: '22222222-2222-4222-8222-222222222222',
          accountGlobalId: 'gca0000001',
          provider: 'faire',
          credentialVersion: 1,
          startedAt: '2026-07-27T12:00:00.000Z',
          continuationRunGlobalId: null,
          continuationIdempotencyKey: null,
        }]
      },
      async completeCommerceOrderReconciliationInPostgres(input) {
        trace.complete.push(input)
        return { leaseLost: false }
      },
      async failCommerceOrderReconciliationInPostgres(input) {
        trace.failed.push(input)
        return { leaseLost: false, errorCode: 'COMMERCE_ORDER_RECONCILIATION_FAILED' }
      },
    },
  },
})
const completed = await worker.processCommerceOrderReconciliation({ limit: 1 })
assert.equal(trace.claims, 1)
assert.equal(completed.claimed, 1)
assert.equal(page, 2, 'worker must consume the continuation page before completion')
assert.equal(completed.pagesRead, 2)
assert.equal(completed.staged, 5)
assert.equal(completed.rejected, 1)
assert.equal(completed.providerWrites, 0)
assert.equal(completed.canonicalOrderWrites, 0)
assert.equal(completed.inventoryWrites, 0)
assert.equal(trace.complete.length, 1)
assert.equal(trace.complete[0].pagesRead, 2)
assert.equal(trace.complete[0].hasNextBatch, false)
assert.equal(trace.failed.length, 0)
assert.deepEqual(
  { ...completed.failureCodes },
  {},
  'Successful order reconciliation must report no failure categories',
)

const recoveredIntentKey = '018f0f50-28ec-7af5-a3fb-9bcbe43ea204'
const recoveredTrace = { requestedKeys: [], complete: 0, failed: 0 }
const recoveredWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceIntakeRuntimeAvailable: () => true,
        async executeCommerceOrderPage(input) {
          recoveredTrace.requestedKeys.push(input.idempotencyKey)
          assert.equal(input.continuationRunGlobalId, 'gcir0000099')
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 1,
              recordsRejected: 0,
              pagination: {
                providerRowsSeen: 1,
                hasNextBatch: false,
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{
            ...failureTarget,
            continuationRunGlobalId: 'gcir0000099',
            continuationIdempotencyKey: recoveredIntentKey,
          }]
        },
        async completeCommerceOrderReconciliationInPostgres() {
          recoveredTrace.complete += 1
          return { leaseLost: false }
        },
        async failCommerceOrderReconciliationInPostgres() {
          recoveredTrace.failed += 1
          return {
            leaseLost: false,
            errorCode: 'COMMERCE_ORDER_RECONCILIATION_FAILED',
          }
        },
      },
    },
  },
)
const recovered = await recoveredWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.deepEqual(recoveredTrace.requestedKeys, [recoveredIntentKey])
assert.equal(recoveredTrace.complete, 1)
assert.equal(recoveredTrace.failed, 0)
assert.equal(recovered.staged, 1)
assert.equal(recovered.providerWrites, 0)

const failedWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceIntakeRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          const error = new Error('sensitive provider response omitted')
          error.code = '23514'
          throw error
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [failureTarget]
        },
        async completeCommerceOrderReconciliationInPostgres() {
          throw new Error('completion must not run after failure')
        },
        async failCommerceOrderReconciliationInPostgres() {
          return {
            leaseLost: false,
            errorCode: 'COMMERCE_ORDER_CHECKOUT_SERVICE_CODE_INVALID',
          }
        },
      },
    },
  },
)
const failedSummary = await failedWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(failedSummary.failed, 1)
assert.deepEqual(
  { ...failedSummary.failureCodes },
  { COMMERCE_ORDER_CHECKOUT_SERVICE_CODE_INVALID: 1 },
  'Worker summary must expose only the stable allowlisted failure category',
)

const route = read('app_src/app/api/integrations/commerce/orders/process/route.ts')
includes(route, [
  'PIPELINE_OUTBOX_WORKER_SECRET',
  'timingSafeEqual',
  'commerceIntakeRuntimeAvailable()',
  'isPostgresStorageEnabled()',
  'processCommerceOrderReconciliation',
], 'Order reconciliation route')
const poller = read('scripts/pipeline-outbox-poller.mjs')
includes(poller, [
  'commerceOrderReconciliationEnabled',
  "runLoop('commerce-order-reconciliation'",
  '/api/integrations/commerce/orders/process',
], 'Order reconciliation poller')
const proxy = read('app_src/proxy.ts')
includes(proxy, ['/api/integrations/commerce/orders/process'], 'Order reconciliation proxy allowlist')
const health = read('app_src/app/api/health/route.ts')
includes(health, [
  "WHERE filename = '0122_operations_commerce_incomplete_header_money.sql'",
  'row?.operations_commerce_incomplete_header_money_migration_applied',
  "'0173_operations_shopify_shipping_service_codes.sql'",
  'row?.operations_shopify_shipping_service_codes_applied',
], 'Order reconciliation health migration gate')
const predeploy = read('scripts/verify-predeploy.mjs')
includes(predeploy, [
  "'db/migrations/0122_operations_commerce_incomplete_header_money.sql'",
  "'db/migrations/0173_operations_shopify_shipping_service_codes.sql'",
  "'scripts/test-commerce-order-reconciliation.mjs'",
], 'Order reconciliation predeploy gate')

console.log('Commerce order reconciliation contract tests passed.')
