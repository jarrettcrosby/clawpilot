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
      if (specifier === '@/lib/integrations/commerceIntegrations') {
        return {
          CommerceIntegrationRequestError: class CommerceIntegrationRequestError extends Error {
            constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
              super(message)
              this.status = status
              this.code = code
            }
          },
        }
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const persistence = read('app_src/lib/persistence/commerceOrderReconciliation.ts')
const fairePromotionPolicy = loadTypeScriptModule(
  'app_src/lib/integrations/commerceFaireAutomaticPromotion.ts',
)
const freshProviderCreatedAt = Date.parse('2026-08-01T12:00:00.000Z')
const freshObservedAt = freshProviderCreatedAt + 5 * 60_000
assert.equal(
  fairePromotionPolicy.automaticFaireOrderSourceIsFresh({
    providerCreatedAt: new Date(freshProviderCreatedAt),
    observedAt: new Date(freshObservedAt),
    nowMs: freshProviderCreatedAt + 48 * 60 * 60 * 1_000,
  }),
  true,
  'Exact 48-hour provider evidence remains eligible',
)
assert.equal(
  fairePromotionPolicy.automaticFaireOrderSourceIsFresh({
    providerCreatedAt: new Date(freshProviderCreatedAt),
    observedAt: new Date(freshObservedAt),
    nowMs: freshObservedAt + 48 * 60 * 60 * 1_000 + 1,
  }),
  false,
  'A retained intake replay after 48 hours must not promote stale Faire evidence',
)
assert.equal(
  fairePromotionPolicy.automaticFaireOrderSourceIsFresh({
    providerCreatedAt: new Date(freshObservedAt),
    observedAt: new Date(freshProviderCreatedAt),
    nowMs: freshObservedAt,
  }),
  false,
  'Faire provider creation must not postdate the captured observation',
)
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
  'continuation_batch_number',
  'records_seen',
  'records_held',
  "date_trunc('milliseconds', clock_timestamp())",
  'projectCommerceOrderReconciliationPageInPostgres',
  "run.created_by = 'system:commerce-order-reconciliation'",
  'cursor.last_started_at = $3::timestamptz',
  "cursor.last_started_at + interval '1 millisecond'",
  'prior_intent.continuation_cursor_hash',
  'COMMERCE_ORDER_RECONCILIATION_SESSION_RECORD_BUDGET_EXCEEDED',
  'COMMERCE_ORDER_RECONCILIATION_RETRY_LIMIT_EXCEEDED',
  'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  "cursor.reconciliation_status IS DISTINCT FROM 'failed'",
  "active_intent.intent_state",
  'THEN 0',
  'durable_records_seen',
  'durable_records_held',
  'readCommerceOrderReconciliationStateInPostgres',
  'resetCommerceOrderReconciliationInPostgres',
  "eventType: 'commerce.orders.reconciliation.reset'",
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
                  continuation_batch_number: null,
                  last_started_at: claimStartedAt,
                  records_seen: '0',
                  records_held: '0',
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
assert.equal(claimedTargets[0].recordsSeen, 0)
assert.equal(claimedTargets[0].recordsHeld, 0)
assert.equal(claimedTargets[0].continuationBatchNumber, null)

let projectionSql = ''
const renewedAt = new Date('2026-07-28T14:16:00.123Z')
const projectionPersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async query(sql) {
          projectionSql = sql
          return {
            rows: [{
              last_started_at: renewedAt,
              records_seen: '42',
              records_held: '7',
              batch_number: 3,
              provider_cursor_repeated: false,
            }],
          }
        },
        async withTransaction() {
          throw new Error('Page projection must be one compare-and-swap query')
        },
      },
    },
  },
)
const projectedPage = await projectionPersistenceModule
  .projectCommerceOrderReconciliationPageInPostgres({
    target: claimedTargets[0],
    runGlobalId: 'gcir0000003',
  })
assert.equal(projectedPage.leaseLost, false)
assert.equal(projectedPage.startedAt, renewedAt.toISOString())
assert.equal(projectedPage.recordsSeen, 42)
assert.equal(projectedPage.recordsHeld, 7)
assert.equal(projectedPage.continuationBatchNumber, 3)
assert.match(
  projectionSql,
  /run\.global_id = \$4[\s\S]*reconciliation_status = 'running'[\s\S]*last_started_at = \$3::timestamptz[\s\S]*last_started_at > clock_timestamp\(\)/,
  'Durable page projection must compare-and-swap the exact still-live claim',
)

const healthQueries = []
const healthPersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async query(sql, values) {
          healthQueries.push({ sql, values })
          if (sql.includes('SELECT value FROM app_settings')) {
            return {
              rows: [{
                value: {
                  checkedAt: '2026-08-01T16:30:00.000Z',
                  phase: 'completed',
                },
              }],
            }
          }
          if (sql.includes('WITH eligible AS')) {
            return {
              rows: [{
                eligible_accounts: '2',
                shopify_accounts: '1',
                faire_accounts: '1',
                never_run: '0',
                running: '0',
                failed: '1',
                stale_processing: '0',
                promotion_attention_required: '1',
                overdue: '1',
                resumable: '1',
                last_success_at: '2026-08-01T16:20:00.000Z',
              }],
            }
          }
          return { rows: [] }
        },
        async withTransaction() {
          throw new Error('Health reads must not open a transaction')
        },
      },
    },
  },
)
const orderHealth = await healthPersistenceModule
  .readCommerceOrderReconciliationHealthFromPostgres()
assert.deepEqual(JSON.parse(JSON.stringify(orderHealth)), {
  eligibleAccounts: 2,
  providerAccounts: { shopify: 1, faire: 1 },
  neverRun: 0,
  running: 0,
  failed: 1,
  staleProcessing: 0,
  promotionAttentionRequired: 1,
  overdue: 1,
  resumable: 1,
  lastSuccessAt: '2026-08-01T16:20:00.000Z',
  resource: 'orders',
})
const heartbeat = await healthPersistenceModule
  .readCommerceOrderReconciliationWorkerHeartbeatFromPostgres()
assert.equal(heartbeat.phase, 'completed')
const recordedHeartbeat = await healthPersistenceModule
  .recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
    phase: 'started',
    workerId: 'worker-test',
    providerWrites: 0,
  })
assert.equal(recordedHeartbeat.resource, 'orders')
assert.equal(recordedHeartbeat.providerWrites, 0)
assert.ok(
  healthQueries.some(({ sql }) => sql.includes("account.provider IN ('shopify', 'faire')")),
  'Durable health must cover both Shopify and Faire order-readable accounts',
)
assert.ok(
  healthQueries.some(({ sql }) => sql.includes('INSERT INTO app_settings')),
  'Order-worker heartbeat must be durable',
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
                  consecutive_failures: 1,
                  last_error_code: values[3],
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
  recordsSeen: 0,
  recordsHeld: 0,
  continuationBatchNumber: null,
  continuationRunGlobalId: null,
  continuationIdempotencyKey: null,
}
const promotionCompletionQueries = []
const promotionCompletionAudits = []
const promotionCompletionModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent(event) {
          promotionCompletionAudits.push(event)
        },
      },
      '@/lib/persistence/postgres': {
        async withTransaction(callback) {
          return callback({
            async query(sql, values) {
              promotionCompletionQueries.push({ sql, values })
              return {
                rowCount: 1,
                rows: [{ organization_id: failureTarget.organizationId }],
              }
            },
          })
        },
      },
    },
  },
)
const promotionCompletion = await promotionCompletionModule
  .completeCommerceOrderReconciliationInPostgres({
    target: { ...failureTarget, provider: 'faire' },
    providerRecordsSeen: 1,
    ordersHeld: 1,
    recordsRejected: 0,
    pagesRead: 1,
    hasNextBatch: false,
    customersMatched: 1,
    customersCreated: 0,
    customersAmbiguous: 0,
    customersSkipped: 0,
    customerResolutionFailed: 0,
    customerResolutionFailureCodes: {},
    faireOrdersPromoted: 0,
    faireOrdersHeld: 0,
    fairePromotionFailed: 1,
    fairePromotionFailureCodes: {
      COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 1,
    },
  })
assert.equal(promotionCompletion.leaseLost, false)
assert.equal(promotionCompletionQueries.length, 1)
assert.match(
  promotionCompletionQueries[0].sql,
  /COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED/u,
  'Successful provider reads must durably retain local-promotion attention',
)
assert.equal(promotionCompletionQueries[0].values[5], 1)
assert.equal(promotionCompletionQueries[0].values[6], false)
assert.equal(
  promotionCompletionAudits[0].payload
    .automaticFaireOrderPromotion.failed,
  1,
)
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

const terminalQueries = []
const terminalAudits = []
const terminalPersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent(event) {
          terminalAudits.push(event)
        },
      },
      '@/lib/persistence/postgres': {
        async withTransaction(callback) {
          return callback({
            async query(sql, values) {
              terminalQueries.push({ sql, values })
              if (sql.includes('UPDATE operations_commerce_sync_cursors')) {
                return {
                  rowCount: 1,
                  rows: [{
                    consecutive_failures: 1,
                    last_error_code:
                      'COMMERCE_ORDER_RECONCILIATION_PROVIDER_CURSOR_REPEATED',
                  }],
                }
              }
              if (sql.includes('UPDATE operations_commerce_intake_continuations')) {
                return {
                  rowCount: 1,
                  rows: [{
                    id: '33333333-3333-4333-8333-333333333333',
                    session_id: '44444444-4444-4444-8444-444444444444',
                    batch_number: 2,
                  }],
                }
              }
              throw new Error(`Unexpected terminal SQL: ${sql}`)
            },
          })
        },
      },
    },
  },
)
const terminalFailure = await terminalPersistenceModule
  .failCommerceOrderReconciliationInPostgres({
    target: failureTarget,
    error: {
      code: 'COMMERCE_ORDER_RECONCILIATION_PROVIDER_CURSOR_REPEATED',
    },
  })
assert.equal(terminalFailure.terminal, true)
assert.equal(terminalFailure.continuationTransition, 'invalid')
assert.equal(terminalFailure.continuationsRetired, 1)
const retirementQuery = terminalQueries.find(({ sql }) => (
  sql.includes('UPDATE operations_commerce_intake_continuations')
))
assert.deepEqual(JSON.parse(JSON.stringify(retirementQuery.values)), [
  failureTarget.organizationId,
  failureTarget.integrationAccountId,
  1,
  'shopify',
  'invalid',
])
assert.match(retirementQuery.sql, /cursor_state = \$5/)
assert.match(retirementQuery.sql, /continuation\.provider = \$4/)
assert.match(retirementQuery.sql, /credential_version = \$3::integer/)
assert.equal(terminalAudits.length, 1)
assert.equal(
  terminalAudits[0].eventType,
  'commerce.orders.reconciliation.terminal',
)

const workerSource = read('app_src/lib/commerceOrderReconciliationWorker.ts')
includes(workerSource, [
  'MAX_PAGES_PER_RECONCILIATION = 5',
  "'CLAWPILOT_COMMERCE_ORDER_MAX_SESSION_PAGES'",
  '2_000',
  'MAX_PROVIDER_RECORDS_PER_RECONCILIATION = 250',
  "'CLAWPILOT_COMMERCE_ORDER_MAX_SESSION_RECORDS'",
  '100_000',
  'MAX_RECONCILIATION_RUNTIME_MS = 180_000',
  'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED',
  'COMMERCE_ORDER_RECONCILIATION_PROVIDER_CURSOR_REPEATED',
  'COMMERCE_ORDER_RECONCILIATION_PAGE_SEQUENCE_INVALID',
  'projectCommerceOrderReconciliationPageInPostgres',
], 'Bounded order reconciliation worker')
assert.ok(
  workerSource.includes('permits a bounded')
    && workerSource.includes('local-only Faire promotion')
    && workerSource.includes('never derives packages or shipments'),
  'Order reconciliation must permit only bounded local Faire promotion while remaining package, shipment, inventory, and provider-write fenced',
)
const intakeSource = read('app_src/lib/integrations/commerceIntake.ts')
includes(intakeSource, [
  'export async function executeCommerceOrderPage',
  "action: input.continuationRunGlobalId ? 'fetch-next' : 'fetch'",
  'includeIntakeState: false',
  'hydrateProductInventory: false',
  "| 'reset-order-reconciliation'",
  'confirmResetOrderReconciliation',
  'expectedLastErrorCode',
  'expectedLastStartedAt',
  'resetCommerceOrderReconciliationInPostgres',
], 'Order-page execution path')
const intakeWorkflowSource = read(
  'app_src/components/settings/CommerceIntakeWorkflow.tsx',
)
includes(intakeWorkflowSource, [
  'resetRequired: boolean',
  'automaticPromotionAttentionRequired: boolean',
  'automatic local Faire order promotion needs attention',
  'provider order rows scanned',
  'eligible order rows in latest page',
  'ClawPilot orders added',
  'Scanned rows are provider order rows checked, not ClawPilot',
  'filters ineligible rows and',
  'deduplicates already-known orders',
  'This read-only step does not reserve inventory, create',
  "'reset-order-reconciliation'",
  'Restart automatic staging',
  'ClawPilot will not reuse the terminal continuation.',
], 'Order-reconciliation operator recovery')
assert.ok(
  !intakeWorkflowSource.includes('provider records read'),
  'Order reconciliation must not present scanned provider rows as orders added',
)
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
              automaticCustomerResolution: {
                matched: 2,
                created: 1,
                ambiguous: 1,
                skipped: 0,
                failed: 0,
                failedByCode: {},
                providerWrites: 0,
                syncCursorAdvanced: false,
              },
              automaticFaireOrderPromotion: {
                promoted: 1,
                held: 1,
                failed: 0,
                failedByCode: {},
                providerWrites: 0,
                canonicalOrderWrites: 1,
                inventoryWrites: 0,
                syncCursorAdvanced: false,
              },
              pagination: {
                batchNumber: 1,
                runGlobalId: 'gcir0000001',
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
            automaticCustomerResolution: {
              matched: 1,
              created: 0,
              ambiguous: 0,
              skipped: 1,
              failed: 1,
              failedByCode: {
                COMMERCE_CUSTOMER_AUTO_RESOLUTION_FAILED: 1,
              },
              providerWrites: 0,
              syncCursorAdvanced: false,
            },
            automaticFaireOrderPromotion: {
              promoted: 0,
              held: 1,
              failed: 1,
              failedByCode: {
                COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 1,
              },
              providerWrites: 0,
              canonicalOrderWrites: 0,
              inventoryWrites: 0,
              syncCursorAdvanced: false,
            },
            pagination: {
              batchNumber: 2,
              runGlobalId: 'gcir0000002',
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
          recordsSeen: 0,
          recordsHeld: 0,
          continuationBatchNumber: null,
          continuationRunGlobalId: null,
          continuationIdempotencyKey: null,
        }]
      },
      async completeCommerceOrderReconciliationInPostgres(input) {
        trace.complete.push(input)
        return { leaseLost: false }
      },
      async projectCommerceOrderReconciliationPageInPostgres({ target }) {
        return {
          leaseLost: false,
          startedAt: new Date(
            Date.parse(target.startedAt) + 1_000,
          ).toISOString(),
          recordsSeen: page === 1 ? 4 : 6,
          recordsHeld: page === 1 ? 4 : 6,
          continuationBatchNumber: page,
          providerCursorRepeated: false,
        }
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
assert.equal(completed.canonicalOrderWrites, 1)
assert.equal(completed.inventoryWrites, 0)
assert.deepEqual(
  JSON.parse(JSON.stringify(completed.automaticCustomerResolution)),
  {
    matched: 3,
    created: 1,
    ambiguous: 1,
    skipped: 1,
    failed: 1,
    failedByCode: {
      COMMERCE_CUSTOMER_AUTO_RESOLUTION_FAILED: 1,
    },
    operatorReviewRequired: 3,
    providerWrites: 0,
    syncCursorAdvanced: false,
  },
)
assert.deepEqual(
  JSON.parse(JSON.stringify(completed.automaticFaireOrderPromotion)),
  {
    promoted: 1,
    held: 2,
    failed: 1,
    failedByCode: {
      COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 1,
    },
    operatorReviewRequired: 3,
    providerWrites: 0,
    canonicalOrderWrites: 1,
    inventoryWrites: 0,
    syncCursorAdvanced: false,
  },
)
assert.equal(trace.complete.length, 1)
assert.equal(trace.complete[0].pagesRead, 2)
assert.equal(trace.complete[0].hasNextBatch, false)
assert.equal(trace.complete[0].customersMatched, 3)
assert.equal(trace.complete[0].customersCreated, 1)
assert.equal(trace.complete[0].customersAmbiguous, 1)
assert.equal(trace.complete[0].customersSkipped, 1)
assert.equal(trace.complete[0].customerResolutionFailed, 1)
assert.equal(trace.complete[0].faireOrdersPromoted, 1)
assert.equal(trace.complete[0].faireOrdersHeld, 2)
assert.equal(trace.complete[0].fairePromotionFailed, 1)
assert.deepEqual(
  { ...trace.complete[0].fairePromotionFailureCodes },
  { COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 1 },
)
assert.deepEqual(
  { ...trace.complete[0].customerResolutionFailureCodes },
  { COMMERCE_CUSTOMER_AUTO_RESOLUTION_FAILED: 1 },
)
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
                batchNumber: 2,
                runGlobalId: 'gcir0000100',
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
            continuationBatchNumber: 1,
            continuationRunGlobalId: 'gcir0000099',
            continuationIdempotencyKey: recoveredIntentKey,
          }]
        },
        async completeCommerceOrderReconciliationInPostgres() {
          recoveredTrace.complete += 1
          return { leaseLost: false }
        },
        async projectCommerceOrderReconciliationPageInPostgres({ target }) {
          return {
            leaseLost: false,
            startedAt: new Date(
              Date.parse(target.startedAt) + 1_000,
            ).toISOString(),
            recordsSeen: 1,
            recordsHeld: 1,
            continuationBatchNumber: 2,
            providerCursorRepeated: false,
          }
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

const boundedTrace = { pages: 0, complete: [], failed: [] }
const boundedWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceIntakeRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          boundedTrace.pages += 1
          const batchNumber = boundedTrace.pages
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 0,
              recordsRejected: 0,
              pagination: {
                batchNumber,
                runGlobalId: `gcir00001${String(batchNumber).padStart(2, '0')}`,
                providerRowsSeen: 50,
                hasNextBatch: true,
                continuationRunGlobalId:
                  `gcir00001${String(batchNumber).padStart(2, '0')}`,
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{ ...failureTarget, provider: 'faire' }]
        },
        async projectCommerceOrderReconciliationPageInPostgres({ target }) {
          return {
            leaseLost: false,
            startedAt: new Date(
              Date.parse(target.startedAt) + 1_000,
            ).toISOString(),
            recordsSeen: boundedTrace.pages * 50,
            recordsHeld: 0,
            continuationBatchNumber: boundedTrace.pages,
            providerCursorRepeated: false,
          }
        },
        async completeCommerceOrderReconciliationInPostgres(input) {
          boundedTrace.complete.push(input)
          return { leaseLost: false }
        },
        async failCommerceOrderReconciliationInPostgres(input) {
          boundedTrace.failed.push(input)
          return { leaseLost: false, errorCode: input.error.code }
        },
      },
    },
  },
)
const boundedSummary = await boundedWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(boundedTrace.pages, 5)
assert.equal(boundedTrace.complete.length, 1)
assert.equal(boundedTrace.complete[0].hasNextBatch, true)
assert.equal(boundedTrace.failed.length, 0)
assert.equal(boundedSummary.pagesRead, 5)
assert.equal(boundedSummary.resumable, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(boundedSummary.budgetStops)),
  { pages: 1, records: 0, time: 0 },
  'A long chain must yield its encrypted continuation at the page budget',
)

const timeTrace = { pages: 0, complete: [] }
const timeWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceIntakeRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          timeTrace.pages += 1
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 0,
              recordsRejected: 0,
              pagination: {
                batchNumber: 1,
                runGlobalId: 'gcir0000201',
                providerRowsSeen: 1,
                hasNextBatch: true,
                continuationRunGlobalId: 'gcir0000201',
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{ ...failureTarget, provider: 'faire' }]
        },
        async projectCommerceOrderReconciliationPageInPostgres() {
          return {
            leaseLost: false,
            startedAt: '2026-07-27T12:00:01.000Z',
            recordsSeen: 1,
            recordsHeld: 0,
            continuationBatchNumber: 1,
            providerCursorRepeated: false,
          }
        },
        async completeCommerceOrderReconciliationInPostgres(input) {
          timeTrace.complete.push(input)
          return { leaseLost: false }
        },
        async failCommerceOrderReconciliationInPostgres(input) {
          return { leaseLost: false, errorCode: input.error.code }
        },
      },
    },
  },
)
let clockCalls = 0
const timeSummary = await timeWorker.processCommerceOrderReconciliation({
  limit: 1,
  clock: () => clockCalls++ === 0 ? 0 : 150_000,
})
assert.equal(timeTrace.pages, 1)
assert.equal(timeTrace.complete[0].hasNextBatch, true)
assert.deepEqual(
  JSON.parse(JSON.stringify(timeSummary.budgetStops)),
  { pages: 0, records: 0, time: 1 },
  'A near-deadline worker must persist its continuation without another read',
)

const repeatedTrace = { pages: 0, failureCode: null }
const repeatedWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceIntakeRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          repeatedTrace.pages += 1
          const first = repeatedTrace.pages === 1
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 0,
              recordsRejected: 0,
              pagination: {
                batchNumber: first ? 1 : 2,
                runGlobalId: first ? 'gcir0000301' : 'gcir0000302',
                providerRowsSeen: 1,
                hasNextBatch: true,
                continuationRunGlobalId: 'gcir0000301',
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{ ...failureTarget, provider: 'faire' }]
        },
        async projectCommerceOrderReconciliationPageInPostgres({ target }) {
          return {
            leaseLost: false,
            startedAt: new Date(
              Date.parse(target.startedAt) + 1_000,
            ).toISOString(),
            recordsSeen: repeatedTrace.pages,
            recordsHeld: 0,
            continuationBatchNumber: repeatedTrace.pages,
            providerCursorRepeated: false,
          }
        },
        async completeCommerceOrderReconciliationInPostgres() {
          throw new Error('Repeated continuation must fail closed')
        },
        async failCommerceOrderReconciliationInPostgres(input) {
          repeatedTrace.failureCode = input.error.code
          return { leaseLost: false, errorCode: input.error.code }
        },
      },
    },
  },
)
const repeatedSummary = await repeatedWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(repeatedTrace.pages, 2)
assert.equal(
  repeatedTrace.failureCode,
  'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED',
)
assert.deepEqual(
  { ...repeatedSummary.failureCodes },
  { COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED: 1 },
)

let oversizedProviderCalls = 0
const oversizedWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceIntakeRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          oversizedProviderCalls += 1
          throw new Error('The terminal budget must stop before provider I/O')
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{
            ...failureTarget,
            provider: 'faire',
            recordsSeen: 100_000,
            continuationBatchNumber: 1_999,
            continuationRunGlobalId: 'gcir0000405',
          }]
        },
        async completeCommerceOrderReconciliationInPostgres() {
          throw new Error('Terminal session budget must not complete')
        },
        async failCommerceOrderReconciliationInPostgres(input) {
          return { leaseLost: false, errorCode: input.error.code }
        },
      },
    },
  },
)
const oversizedSummary = await oversizedWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(oversizedProviderCalls, 0)
assert.deepEqual(
  { ...oversizedSummary.failureCodes },
  { COMMERCE_ORDER_RECONCILIATION_SESSION_RECORD_BUDGET_EXCEEDED: 1 },
  'An oversized session must enter a deterministic terminal state',
)

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
  'recordCommerceOrderReconciliationWorkerHeartbeatInPostgres',
  "phase: 'started'",
  "phase: 'completed'",
  "phase: 'failed'",
  'providerReadOnly: true',
  'localCanonicalOrderWritesPossible: true',
], 'Order reconciliation route')
assert.ok(
  !route.includes('readOnly: true'),
  'The order worker must not claim that local canonical promotion is read-only',
)
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
  'commerceOrderReconciliationWorker',
  'readCommerceOrderReconciliationHealthFromPostgres',
  'Commerce order reconciliation worker heartbeat is missing or stale.',
  'orderState.promotionAttentionRequired > 0',
  'automatic local order promotion needs operator attention',
], 'Order reconciliation health migration gate')
const reconciliationPersistence = read(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
)
includes(reconciliationPersistence, [
  'commerce_order_reconciliation_worker_heartbeat',
  'readCommerceOrderReconciliationHealthFromPostgres',
  "account.provider IN ('shopify', 'faire')",
  "cursor.resource = 'orders'",
  'stale_processing',
  'promotion_attention_required',
  'overdue',
  'providerAccounts',
  'promotionAttentionRequired',
  'automaticPromotionAttentionRequired',
], 'Order reconciliation durable health')
const predeploy = read('scripts/verify-predeploy.mjs')
includes(predeploy, [
  "'db/migrations/0122_operations_commerce_incomplete_header_money.sql'",
  "'db/migrations/0173_operations_shopify_shipping_service_codes.sql'",
  "'scripts/test-commerce-order-reconciliation.mjs'",
], 'Order reconciliation predeploy gate')

console.log('Commerce order reconciliation contract tests passed.')
