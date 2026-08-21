#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0197_operations_shopify_catalog_webhook_refresh.sql',
)
includes(migration, [
  'operations_shopify_catalog_refresh_states',
  'dirty_version bigint NOT NULL DEFAULT 0',
  'reconciled_version bigint NOT NULL DEFAULT 0',
  'dirty_version > reconciled_version',
  'target_dirty_version bigint NOT NULL DEFAULT 0',
  'protect_operations_shopify_catalog_refresh_state',
  'refresh state versions are monotonic',
], 'Shopify catalog webhook refresh migration')

const capabilities = read(
  'app_src/lib/integrations/commerceCapabilities.ts',
)
includes(capabilities, [
  'SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS',
  "'products/create'",
  "'products/delete'",
  "'products/update'",
  "state: 'available'",
  'lossless monotonic watermark',
], 'Shopify product webhook capability')

const deleteEvidence = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyCatalogWebhook.ts',
)
const deletePayloadHash = createHash('sha256')
  .update('{"id":123456789}')
  .digest('hex')
const exactDeletion = deleteEvidence.shopifyDeletedProductEvidence({
  topic: 'products/delete',
  verifiedPayload: {
    id: 123456789,
    admin_graphql_api_id: 'gid://shopify/Product/123456789',
    updated_at: '2026-08-01T15:00:00Z',
    image: 'https://must-not-enter-delete-evidence.example/image.png',
  },
  verifiedPayloadHash: deletePayloadHash,
})
assert.deepEqual(JSON.parse(JSON.stringify(exactDeletion)), {
  externalProductId: 'gid://shopify/Product/123456789',
  productSourceHash: createHash('sha256').update([
    'shopify-product-delete-v1',
    deletePayloadHash,
    'gid://shopify/Product/123456789',
  ].join('\0')).digest('hex'),
  providerUpdatedAt: '2026-08-01T15:00:00.000Z',
})
assert.doesNotMatch(JSON.stringify(exactDeletion), /https:\/\//)
assert.equal(deleteEvidence.shopifyDeletedProductEvidence({
  topic: 'products/update',
  verifiedPayload: { id: 123456789 },
  verifiedPayloadHash: deletePayloadHash,
}), null)
for (const invalidPayload of [
  {},
  { id: 0 },
  { id: Number.MAX_SAFE_INTEGER + 1 },
  { id: ' 123456789' },
  {
    id: 123456789,
    admin_graphql_api_id: 'gid://shopify/Product/987654321',
  },
]) {
  assert.throws(
    () => deleteEvidence.shopifyDeletedProductEvidence({
      topic: 'products/delete',
      verifiedPayload: invalidPayload,
      verifiedPayloadHash: deletePayloadHash,
    }),
    /product-delete/u,
  )
}

const receiptPersistence = read(
  'app_src/lib/persistence/commerceIntegrations.ts',
)
assert.match(
  receiptPersistence,
  /if \([\s\S]*?SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS\.some\([\s\S]+?signalShopifyCatalogRefreshWithClient/,
  'Product webhook topics must signal catalog reconciliation',
)
includes(receiptPersistence, [
  'commerce.catalog.refresh_signaled',
  'catalogRefreshSignaled: Boolean(catalogRefreshSignal)',
  'providerWrites: 0',
  'ordersTouched: 0',
  'inventoryTouched: 0',
  'reconcileCommerceProductImageSetWithClient',
  "productLifecycle: 'deleted'",
  'id::text,\n         global_id,\n         received_at',
  'existing.rows[0].received_at',
  'productDeletionReconciled',
], 'Shopify product webhook receipt boundary')
const receiptFunction = receiptPersistence.slice(
  receiptPersistence.indexOf(
    'export async function recordShopifyWebhookReceiptInPostgres',
  ),
)
assert.ok(
  receiptFunction.indexOf('reconcileProductDeletion(')
    < receiptFunction.indexOf('signalShopifyCatalogRefreshWithClient('),
  'Signed product deletion must be durable before the dirty watermark advances',
)
includes(receiptFunction, [
  'account.commerce_credential_generation',
  'credential.credential_version',
  "account.provider = 'shopify'",
  'COALESCE(',
  'account.updated_by',
  'credential.created_by',
  "input.topic === 'products/delete'",
  "provider: 'shopify'",
  'credentialGeneration: input.runtime.credentialVersion',
  'externalProductId: input.productDeletion.externalProductId',
  'productSourceHash: input.productDeletion.productSourceHash',
  'imageSetComplete: true',
  'images: []',
  'observedAt: receivedAt',
  'providerUpdatedAt: input.productDeletion.providerUpdatedAt',
  'providerWrites: 0',
  "receipt.topic = 'products/delete'",
  "receipt.state = 'held'",
  'receipt.attempts < receipt.max_attempts',
  'credential.external_account_id = account.external_account_id',
  "credential.auth_mode = 'shopify_client_credentials'",
  "credential.webhook_verification_status = 'verified'",
  'operations_commerce_store_sync_is_running(',
  'ORDER BY receipt.received_at, receipt.id',
  'runtime.credentialVersion !== candidate.credential_version',
  "current.webhook_verification_status !== 'verified'",
  "const errorCode = 'SHOPIFY_PRODUCT_DELETE_REPLAY_FAILED'",
], 'Atomic Shopify delete image reconciliation')
assert.match(
  receiptFunction,
  /If the catalog worker is disabled while Store sync alone resumes,[\s\S]*?immutable receipt intentionally remains held/,
  'Worker-disabled Store sync resume must document the durable safe-hold state',
)

const receiptTrace = []
let replayExistingReceipt = false
let existingReceiptState = 'succeeded'
let storeSyncRunning = true
let receiptIntakeEnabled = true
let heldReplayCandidatesEnabled = false
let replayDecryptionMode = 'valid'
let replayFailureState = 'held'
let replayRuntimeCredentialVersion = 3
const durableReceiptObservedAt = '2026-08-01T15:01:02.000Z'
const faireFulfillmentReadiness = loadTypeScriptModule(
  'app_src/lib/integrations/faireFulfillmentReadiness.ts',
)
const receiptPersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceIntegrations.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent(input) {
          receiptTrace.push({
            kind: 'audit',
            eventType: input.eventType,
            payload: input.payload,
          })
        },
      },
      '@/lib/integrations/commerceCapabilities': {
        hasEffectiveShopifyScope(grantedScopes, requiredScope) {
          if (grantedScopes.includes(requiredScope)) return true
          return requiredScope.startsWith('read_')
            && grantedScopes.includes(
              `write_${requiredScope.slice('read_'.length)}`,
            )
        },
        SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS: [
          'products/create',
          'products/delete',
          'products/update',
        ],
        SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS: [
          'inventory_items/create',
          'inventory_items/delete',
          'inventory_items/update',
          'inventory_levels/connect',
          'inventory_levels/disconnect',
          'inventory_levels/update',
        ],
        SHOPIFY_RECEIPT_PROOF_SCOPES: [
          'read_products',
          'read_inventory',
        ],
      },
      '@/lib/integrations/commerceCredentialCrypto': {
        decryptCommerceWebhookPayload() {
          if (replayDecryptionMode === 'invalid_auth') {
            throw new Error(
              'authentication failed for product 123456789',
            )
          }
          if (replayDecryptionMode === 'hash_mismatch') {
            return Buffer.from('{"id":987654321}')
          }
          return Buffer.from('{"id":123456789}')
        },
      },
      '@/lib/integrations/faireFulfillmentReadiness':
        faireFulfillmentReadiness,
      '@/lib/integrations/shopifyCatalogWebhook': {
        shopifyDeletedProductEvidence:
          deleteEvidence.shopifyDeletedProductEvidence,
      },
      '@/lib/persistence/commerceExternalEffects': {
        assertRedactedCommerceExternalEffectEvidence() {},
      },
      '@/lib/persistence/commerceActiveTransitionAuthorization': {
        async readCommerceActiveContinuationInPostgres() {
          assert.fail(
            'Catalog webhook receipt tests must not read Active continuation state',
          )
        },
      },
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock(_client, key) {
          receiptTrace.push({ kind: 'lock', key })
        },
        async query(sql, values) {
          if (
            heldReplayCandidatesEnabled
            && sql.includes(
              'FROM operations_commerce_webhook_receipts receipt',
            )
          ) {
            assert.match(sql, /receipt\.topic = 'products\/delete'/)
            assert.match(sql, /receipt\.state = 'held'/)
            assert.match(sql, /receipt\.attempts < receipt\.max_attempts/)
            assert.match(
              sql,
              /credential\.external_account_id = account\.external_account_id/,
            )
            assert.match(
              sql,
              /credential\.webhook_verification_status = 'verified'/,
            )
            assert.match(
              sql,
              /operations_commerce_store_sync_is_running\(account\.organization_id, account\.id\)/,
            )
            assert.match(sql, /ORDER BY receipt\.received_at, receipt\.id/)
            return {
              rowCount: 1,
              rows: [{
                receipt_global_id: 'gcw1234567',
                organization_id:
                  '11111111-1111-4111-8111-111111111111',
                integration_account_id:
                  '22222222-2222-4222-8222-222222222222',
                account_global_id: 'gia1234567',
                credential_version: 3,
                provider_event_id: 'event-held-intake-paused-123456789',
                topic: 'products/delete',
                source_domain: 'example.myshopify.com',
                provider_api_version: '2026-07',
                payload_hash: deletePayloadHash,
                payload_ciphertext: Buffer.from('ciphertext'),
                payload_iv: Buffer.alloc(12),
                payload_tag: Buffer.alloc(16),
                payload_bytes: 16,
                provider_triggered_at: null,
              }],
            }
          }
          if (
            heldReplayCandidatesEnabled
            && sql.includes('WHERE account.global_id = $1')
          ) {
            return {
              rowCount: 1,
              rows: [{
                id: receiptInput.runtime.integrationAccountId,
                global_id: receiptInput.runtime.globalId,
                organization_id: receiptInput.runtime.organizationId,
                provider: 'shopify',
                environment: 'production',
                external_account_id: 'gid://shopify/Shop/123456789',
                credential_external_account_id:
                  'gid://shopify/Shop/123456789',
                display_name: 'Example store',
                status: 'active',
                receipt_intake_enabled: true,
                configuration: {},
                commerce_credential_generation:
                  replayRuntimeCredentialVersion,
                credential_ciphertext: Buffer.from('credential'),
                credential_iv: Buffer.alloc(12),
                credential_tag: Buffer.alloc(16),
                credential_version: replayRuntimeCredentialVersion,
                auth_mode: 'shopify_client_credentials',
                credential_identifier_last_four: '7890',
                verification_status: 'verified',
                verified_at: durableReceiptObservedAt,
                last_error_code: null,
                webhook_verification_status: 'verified',
                webhook_verified_at: durableReceiptObservedAt,
                updated_at: durableReceiptObservedAt,
              }],
            }
          }
          if (
            heldReplayCandidatesEnabled
            && sql.includes('UPDATE operations_commerce_webhook_receipts')
            && sql.includes("ELSE 'held'")
          ) {
            receiptTrace.push({
              kind: 'replay_failure',
              receiptGlobalId: values?.[0],
              errorCode: values?.[1],
            })
            return {
              rowCount: 1,
              rows: [{ state: replayFailureState }],
            }
          }
          return { rows: [] }
        },
        async withTransaction(callback) {
          return callback({
            async query(sql, values) {
              if (
                sql.includes('SELECT')
                && sql.includes('account.receipt_intake_enabled')
                && sql.includes('FOR UPDATE OF account, credential')
              ) {
                return {
                  rowCount: 1,
                  rows: [{
                    status: 'active',
                    receipt_intake_enabled: receiptIntakeEnabled,
                    account_external_account_id:
                      'gid://shopify/Shop/123456789',
                    commerce_credential_generation: 3,
                    credential_external_account_id:
                      'gid://shopify/Shop/123456789',
                    credential_version: 3,
                    auth_mode: 'shopify_client_credentials',
                    verification_status: 'verified',
                    webhook_verification_status: 'verified',
                    configuration: {},
                    actor_email: 'owner@example.com',
                  }],
                }
              }
              if (sql.includes(
                'SELECT operations_commerce_store_sync_is_running(',
              )) {
                return {
                  rowCount: 1,
                  rows: [{ running: storeSyncRunning }],
                }
              }
              if (
                sql.includes(
                  'SELECT global_id, credential_version, payload_hash, received_at',
                )
              ) {
                return replayExistingReceipt
                  ? {
                      rowCount: 1,
                      rows: [{
                        global_id: 'gcw1234567',
                        credential_version: 3,
                        payload_hash: deletePayloadHash,
                        received_at: durableReceiptObservedAt,
                        state: existingReceiptState,
                      }],
                    }
                  : { rowCount: 0, rows: [] }
              }
              if (
                sql.includes('INSERT INTO operations_commerce_webhook_receipts')
              ) {
                receiptTrace.push({
                  kind: 'receipt_insert',
                  state: values[13],
                })
                return {
                  rowCount: 1,
                  rows: [{
                    global_id: 'gcw1234567',
                    received_at: durableReceiptObservedAt,
                  }],
                }
              }
              if (sql.includes('UPDATE operations_integration_accounts')) {
                receiptTrace.push({
                  kind: 'scope_account_update',
                  intakeDisabled: values[3],
                  configuration: JSON.parse(values[4]),
                })
                return { rowCount: 1, rows: [] }
              }
              if (
                sql.includes('UPDATE operations_commerce_webhook_receipts')
              ) {
                receiptTrace.push({ kind: 'receipt_finalize' })
                return { rowCount: 1, rows: [] }
              }
              throw new Error(`Unexpected receipt query: ${sql}`)
            },
          })
        },
      },
      '@/lib/persistence/commerceCatalogSync': {
        async ensureAutomaticCommerceCatalogIntakeWithClient() {},
        async signalShopifyCatalogRefreshWithClient(_client, input) {
          receiptTrace.push({ kind: 'catalog_signal', input })
          return { dirtyVersion: 9, reconciledVersion: 8 }
        },
      },
      '@/lib/persistence/shopifyInventoryRefresh': {
        async signalShopifyInventoryRefreshWithClient() {
          assert.fail('A product deletion must not mutate inventory')
        },
      },
      '@/lib/persistence/shopifyInventoryTargetSignals': {
        async recordShopifyInventoryTargetSignalWithClient() {
          assert.fail('A product deletion must not create inventory evidence')
        },
      },
      '@/lib/persistence/commerceProductImageImports': {
        async reconcileCommerceProductImageSetWithClient(input) {
          receiptTrace.push({ kind: 'image_delete', input })
          return {
            productSourceHash: input.productSourceHash,
            productLifecycle: 'deleted',
            imageSetComplete: true,
            staleSnapshotIgnored: false,
            active: [],
            removed: [{ jobState: 'cancelled' }],
          }
        },
      },
      '@/lib/persistence/commerceOrderSync': {
        commerceOrderSyncAccountLockKey(accountGlobalId) {
          return `commerce-order-sync:${accountGlobalId}`
        },
      },
      '@/lib/persistence/shopifyFulfillmentNotifications': {},
      '@/lib/persistence/shopifyOrderWebhookSignals': {
        async downgradeShopifyOrderWebhookPolicyAfterDiscoveryWithClient() {
          assert.fail(
            'Catalog webhook receipt tests must not change order webhook policy',
          )
        },
      },
      '@/lib/persistence/shopifyWebhookReceiptHealth': {
        async readShopifyWebhookReceiptAccountHealthFromPostgres() {
          return []
        },
      },
    },
  },
)
const receiptInput = {
  runtime: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    integrationAccountId: '22222222-2222-4222-8222-222222222222',
    globalId: 'gia1234567',
    provider: 'shopify',
    environment: 'production',
    externalAccountId: 'gid://shopify/Shop/123456789',
    credentialVersion: 3,
  },
  providerEventId: 'event-delete-123456789',
  topic: 'products/delete',
  sourceDomain: 'example.myshopify.com',
  providerApiVersion: '2026-07',
  payloadHash: deletePayloadHash,
  encryptedPayload: {
    ciphertext: Buffer.from('ciphertext'),
    iv: Buffer.alloc(12),
    tag: Buffer.alloc(16),
  },
  payloadBytes: 16,
  providerTriggeredAt: null,
  productDeletion: exactDeletion,
}
const firstReceipt = await receiptPersistenceModule
  .recordShopifyWebhookReceiptInPostgres(receiptInput)
assert.equal(firstReceipt.duplicate, false)
assert.equal(firstReceipt.productDeletionReconciled, true)
assert.equal(firstReceipt.productImagesInactivated, 1)
const firstImageDeleteIndex = receiptTrace.findIndex(
  (entry) => entry.kind === 'image_delete',
)
const firstCatalogSignalIndex = receiptTrace.findIndex(
  (entry) => entry.kind === 'catalog_signal',
)
assert.ok(firstImageDeleteIndex > -1)
assert.ok(firstImageDeleteIndex < firstCatalogSignalIndex)
const firstImageDelete = receiptTrace[firstImageDeleteIndex].input
assert.deepEqual(JSON.parse(JSON.stringify(firstImageDelete)), {
  organizationId: receiptInput.runtime.organizationId,
  integrationAccountId: receiptInput.runtime.integrationAccountId,
  provider: 'shopify',
  credentialGeneration: 3,
  externalProductId: exactDeletion.externalProductId,
  productSourceHash: exactDeletion.productSourceHash,
  productLifecycle: 'deleted',
  imageSetComplete: true,
  images: [],
  observedAt: durableReceiptObservedAt,
  providerUpdatedAt: exactDeletion.providerUpdatedAt,
  actorEmail: 'owner@example.com',
  providerReadAuthority: 'automatic',
})

replayExistingReceipt = false
receiptIntakeEnabled = true
const effectiveWriteScopeTraceStart = receiptTrace.length
const effectiveWriteScopeReceipt = await receiptPersistenceModule
  .recordShopifyWebhookReceiptInPostgres({
    ...receiptInput,
    providerEventId: 'event-scope-complete-write-scopes',
    topic: 'app/scopes_update',
    productDeletion: null,
    scopeAudit: {
      requestedScopes: ['write_inventory', 'write_products'],
      grantedScopes: ['write_inventory', 'write_products'],
      missingScopes: [],
      restrictedScopes: [],
    },
  })
assert.equal(effectiveWriteScopeReceipt.duplicate, false)
const effectiveWriteScopeTrace = receiptTrace.slice(
  effectiveWriteScopeTraceStart,
)
assert.equal(
  effectiveWriteScopeTrace.find(
    (entry) => entry.kind === 'scope_account_update',
  ).intakeDisabled,
  false,
  'Effective write scopes must satisfy the paired receipt-proof reads',
)
assert.equal(
  effectiveWriteScopeTrace.find(
    (entry) => entry.kind === 'receipt_insert',
  ).state,
  'queued',
)
assert.equal(
  effectiveWriteScopeTrace.filter(
    (entry) => entry.kind === 'receipt_finalize',
  ).length,
  1,
  'A complete access-scope event must terminalize synchronously',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(effectiveWriteScopeTrace.find(
    (entry) => entry.kind === 'audit'
      && entry.eventType === 'commerce.webhook.received',
  ).payload)),
  {
    provider: 'shopify',
    environment: 'production',
    receiptGlobalId: 'gcw1234567',
    topic: 'app/scopes_update',
    providerEventId: 'event-scope-complete-write-scopes',
    credentialVersion: 3,
    inventoryRefreshSignaled: false,
    catalogRefreshSignaled: false,
    scopeRefreshApplied: true,
    scopeRefreshTerminalized: true,
    productDeletionReconciled: false,
    productDeletionStaleIgnored: false,
    productDeletionHeld: false,
    productImagesInactivated: 0,
  },
  'Complete scope evidence must distinguish application from terminalization',
)
assert.equal(
  effectiveWriteScopeTrace.some((entry) => (
    entry.kind === 'catalog_signal' || entry.kind === 'image_delete'
  )),
  false,
  'Access-scope events must not signal a catalog or image mutation',
)

receiptIntakeEnabled = false
const heldIntakeCompleteScopeTraceStart = receiptTrace.length
await receiptPersistenceModule.recordShopifyWebhookReceiptInPostgres({
  ...receiptInput,
  providerEventId: 'event-scope-complete-while-intake-held',
  topic: 'app/scopes_update',
  productDeletion: null,
  scopeAudit: {
    requestedScopes: ['write_inventory', 'write_products'],
    grantedScopes: ['write_inventory', 'write_products'],
    missingScopes: [],
    restrictedScopes: [],
  },
})
const heldIntakeCompleteScopeTrace = receiptTrace.slice(
  heldIntakeCompleteScopeTraceStart,
)
assert.equal(
  heldIntakeCompleteScopeTrace.find(
    (entry) => entry.kind === 'receipt_insert',
  ).state,
  'queued',
  'A complete control event bypasses the manual domain-receipt hold',
)
assert.equal(
  heldIntakeCompleteScopeTrace.filter(
    (entry) => entry.kind === 'receipt_finalize',
  ).length,
  1,
  'A complete control event must terminalize while intake is held',
)

receiptIntakeEnabled = true
const lostProofScopeTraceStart = receiptTrace.length
await receiptPersistenceModule.recordShopifyWebhookReceiptInPostgres({
  ...receiptInput,
  providerEventId: 'event-scope-missing-inventory-proof',
  topic: 'app/scopes_update',
  productDeletion: null,
  scopeAudit: {
    requestedScopes: ['write_inventory', 'write_products'],
    grantedScopes: ['write_products'],
    missingScopes: ['write_inventory'],
    restrictedScopes: [],
  },
})
const lostProofScopeTrace = receiptTrace.slice(lostProofScopeTraceStart)
assert.equal(
  lostProofScopeTrace.find(
    (entry) => entry.kind === 'scope_account_update',
  ).intakeDisabled,
  true,
  'Losing an effective inventory proof scope must disable receipt intake',
)
assert.equal(
  lostProofScopeTrace.find(
    (entry) => entry.kind === 'receipt_insert',
  ).state,
  'held',
)
assert.equal(
  lostProofScopeTrace.some(
    (entry) => entry.kind === 'receipt_finalize',
  ),
  false,
  'A scope-loss receipt remains durable held evidence after intake closes',
)
const lostProofScopeAudit = lostProofScopeTrace.find(
  (entry) => entry.kind === 'audit'
    && entry.eventType === 'commerce.webhook.received',
)
assert.equal(lostProofScopeAudit.payload.scopeRefreshApplied, true)
assert.equal(lostProofScopeAudit.payload.scopeRefreshTerminalized, false)

replayExistingReceipt = true
const traceBeforeReplay = receiptTrace.length
const replayReceipt = await receiptPersistenceModule
  .recordShopifyWebhookReceiptInPostgres(receiptInput)
assert.equal(replayReceipt.duplicate, true)
assert.equal(replayReceipt.productDeletionReconciled, false)
const replayTrace = receiptTrace.slice(traceBeforeReplay)
assert.equal(
  replayTrace.filter((entry) => entry.kind === 'image_delete').length,
  0,
  'A succeeded duplicate must not replay the deletion mutation',
)
assert.equal(
  replayTrace.some((entry) => entry.kind === 'catalog_signal'),
  false,
  'Duplicate delivery must not increment the catalog dirty watermark again',
)
assert.equal(
  replayTrace.some((entry) => entry.kind === 'receipt_finalize'),
  false,
  'A succeeded duplicate must not finalize its receipt twice',
)

let workerDisabledHeldReceipt = null
for (const pausedContext of [
  'explicit-paused-shadow',
  'explicit-paused-read-only',
  'disabled-override',
  'frozen-override',
]) {
  replayExistingReceipt = false
  storeSyncRunning = false
  receiptIntakeEnabled = true
  const traceBeforeHeld = receiptTrace.length
  const heldReceipt = await receiptPersistenceModule
    .recordShopifyWebhookReceiptInPostgres({
      ...receiptInput,
      providerEventId: `event-held-${pausedContext}-123456789`,
    })
  assert.equal(heldReceipt.duplicate, false)
  assert.equal(heldReceipt.productDeletionHeld, true)
  workerDisabledHeldReceipt = heldReceipt
  const heldTrace = receiptTrace.slice(traceBeforeHeld)
  assert.equal(
    heldTrace.find((entry) => entry.kind === 'receipt_insert').state,
    'held',
  )
  assert.equal(
    heldTrace.some((entry) => entry.kind === 'image_delete'),
    false,
    `Store sync context ${pausedContext} must not mutate image bindings`,
  )
  assert.equal(
    heldTrace.some((entry) => entry.kind === 'catalog_signal'),
    false,
    `Store sync context ${pausedContext} must not advance the dirty watermark`,
  )
}

const traceAtWorkerDisabledResume = receiptTrace.length
storeSyncRunning = true
assert.equal(workerDisabledHeldReceipt?.productDeletionHeld, true)
assert.equal(
  receiptTrace.length,
  traceAtWorkerDisabledResume,
  'Store sync resume alone cannot consume the held receipt when the catalog worker is disabled',
)

storeSyncRunning = true
receiptIntakeEnabled = false
replayExistingReceipt = false
const traceBeforeIntakePause = receiptTrace.length
const intakePausedReceipt = await receiptPersistenceModule
  .recordShopifyWebhookReceiptInPostgres({
    ...receiptInput,
    providerEventId: 'event-held-intake-paused-123456789',
  })
assert.equal(intakePausedReceipt.productDeletionHeld, true)
assert.equal(
  receiptTrace.slice(traceBeforeIntakePause)
    .find((entry) => entry.kind === 'receipt_insert').state,
  'held',
)

receiptIntakeEnabled = true
storeSyncRunning = true
replayExistingReceipt = true
existingReceiptState = 'held'
const traceBeforeHeldReplay = receiptTrace.length
const heldReplay = await receiptPersistenceModule
  .recordShopifyWebhookReceiptInPostgres({
    ...receiptInput,
    providerEventId: 'event-held-intake-paused-123456789',
  })
assert.equal(heldReplay.duplicate, true)
assert.equal(heldReplay.productDeletionHeld, false)
assert.equal(heldReplay.productDeletionReconciled, true)
const heldReplayTrace = receiptTrace.slice(traceBeforeHeldReplay)
const heldReplayImageIndex = heldReplayTrace.findIndex(
  (entry) => entry.kind === 'image_delete',
)
const heldReplaySignalIndex = heldReplayTrace.findIndex(
  (entry) => entry.kind === 'catalog_signal',
)
assert.ok(heldReplayImageIndex > -1)
assert.ok(heldReplayImageIndex < heldReplaySignalIndex)
assert.equal(
  heldReplayTrace[heldReplayImageIndex].input.observedAt,
  durableReceiptObservedAt,
  'Held deletion replay must retain the original receipt-time ordering fence',
)
assert.equal(
  heldReplayTrace.some((entry) => entry.kind === 'receipt_finalize'),
  true,
)

heldReplayCandidatesEnabled = true
existingReceiptState = 'held'
const traceBeforeWorkerReplay = receiptTrace.length
const workerReplay = await receiptPersistenceModule
  .replayHeldShopifyProductDeletionsInPostgres({ limit: 5 })
assert.deepEqual(JSON.parse(JSON.stringify(workerReplay)), {
  selected: 1,
  reconciled: 1,
  held: 0,
  failed: 0,
  deadLettered: 0,
  providerWrites: 0,
})
const workerReplayTrace = receiptTrace.slice(traceBeforeWorkerReplay)
assert.ok(
  workerReplayTrace.findIndex((entry) => entry.kind === 'image_delete')
    < workerReplayTrace.findIndex((entry) => entry.kind === 'catalog_signal'),
  'Catalog worker replay must persist deletion before advancing its watermark',
)

replayDecryptionMode = 'hash_mismatch'
replayFailureState = 'held'
const traceBeforeHashFailure = receiptTrace.length
const hashFailure = await receiptPersistenceModule
  .replayHeldShopifyProductDeletionsInPostgres({ limit: 5 })
assert.deepEqual(JSON.parse(JSON.stringify(hashFailure)), {
  selected: 1,
  reconciled: 0,
  held: 1,
  failed: 1,
  deadLettered: 0,
  providerWrites: 0,
})
const hashFailureTrace = receiptTrace.slice(traceBeforeHashFailure)
assert.deepEqual(
  hashFailureTrace.filter((entry) => entry.kind === 'replay_failure'),
  [{
    kind: 'replay_failure',
    receiptGlobalId: 'gcw1234567',
    errorCode: 'SHOPIFY_PRODUCT_DELETE_REPLAY_FAILED',
  }],
  'Hash failure must remain recoverably held with only a fixed safe code',
)
assert.doesNotMatch(
  JSON.stringify(hashFailureTrace),
  /987654321|gid:\/\/shopify\/Product/,
  'Replay failure evidence must not expose payload or product identity',
)

replayDecryptionMode = 'valid'
const recoveredReplay = await receiptPersistenceModule
  .replayHeldShopifyProductDeletionsInPostgres({ limit: 5 })
assert.equal(recoveredReplay.reconciled, 1)
assert.equal(recoveredReplay.failed, 0)

replayRuntimeCredentialVersion = 4
const traceBeforeCredentialRotation = receiptTrace.length
const rotationHeld = await receiptPersistenceModule
  .replayHeldShopifyProductDeletionsInPostgres({ limit: 5 })
assert.deepEqual(JSON.parse(JSON.stringify(rotationHeld)), {
  selected: 1,
  reconciled: 0,
  held: 1,
  failed: 0,
  deadLettered: 0,
  providerWrites: 0,
})
assert.equal(
  receiptTrace.slice(traceBeforeCredentialRotation)
    .some((entry) => entry.kind === 'image_delete'),
  false,
  'A receipt selected before credential rotation must remain held',
)
replayRuntimeCredentialVersion = 3

replayDecryptionMode = 'invalid_auth'
replayFailureState = 'dead_letter'
const traceBeforeAuthFailure = receiptTrace.length
const authFailure = await receiptPersistenceModule
  .replayHeldShopifyProductDeletionsInPostgres({ limit: 5 })
assert.deepEqual(JSON.parse(JSON.stringify(authFailure)), {
  selected: 1,
  reconciled: 0,
  held: 0,
  failed: 1,
  deadLettered: 1,
  providerWrites: 0,
})
const authFailureTrace = receiptTrace.slice(traceBeforeAuthFailure)
assert.doesNotMatch(
  JSON.stringify(authFailureTrace),
  /123456789|gid:\/\/shopify\/Product/,
  'Decrypt/auth failure evidence must not expose payload or product identity',
)
assert.equal(
  authFailureTrace.find((entry) => entry.kind === 'replay_failure')
    ?.errorCode,
  'SHOPIFY_PRODUCT_DELETE_REPLAY_FAILED',
)
replayDecryptionMode = 'valid'
replayFailureState = 'held'
heldReplayCandidatesEnabled = false

const integrationServiceSource = read(
  'app_src/lib/integrations/commerceIntegrations.ts',
)
const receiveWebhookSource = integrationServiceSource.slice(
  integrationServiceSource.indexOf(
    'export async function receiveShopifyWebhook',
  ),
)
assert.ok(
  receiveWebhookSource.indexOf('verifyShopifyWebhookHmac({')
    < receiveWebhookSource.indexOf('shopifyDeletedProductEvidence({'),
  'Product identity must not be derived until the raw Shopify body is verified',
)
assert.ok(
  receiveWebhookSource.indexOf('shopifyDeletedProductEvidence({')
    < receiveWebhookSource.indexOf('encryptCommerceWebhookPayload(')
    && receiveWebhookSource.indexOf('encryptCommerceWebhookPayload(')
      < receiveWebhookSource.indexOf('recordShopifyWebhookReceiptInPostgres({'),
  'The exact delete projection and encrypted receipt must share one persistence call',
)

const catalogPersistence = read(
  'app_src/lib/persistence/commerceCatalogSync.ts',
)
includes(catalogPersistence, [
  'signalShopifyCatalogRefreshWithClient',
  'shopify-catalog-watermark:',
  'pendingRefreshSignals',
  "catalogRefresh?.provider === 'shopify'",
  "account.provider = 'shopify'",
  'refresh.credential_generation',
  '= account.commerce_credential_generation',
  'target_dirty_version',
  'COALESCE(refresh.dirty_version, 0)',
  'COALESCE(refresh.dirty_version, 0)',
  '> COALESCE(refresh.reconciled_version, 0)',
  'LEAST(dirty_version, $4::bigint)',
  'targetDirtyVersion: input.job.targetDirtyVersion',
], 'Lossless Shopify catalog reconciliation handoff')
const recurringCatalogQueue = catalogPersistence.slice(
  catalogPersistence.indexOf(
    'export async function queueAutomaticCommerceCatalogSyncsInPostgres',
  ),
  catalogPersistence.indexOf(
    'export async function claimCommerceCatalogSyncJobsInPostgres',
  ),
)
assert.doesNotMatch(
  recurringCatalogQueue,
  /policy\.unmatched_action = 'auto_create'/u,
  'Review-only unmatched-product policy must not pause mapped catalog refresh',
)
const claimedCatalogJobs = catalogPersistence.slice(
  catalogPersistence.indexOf(
    'export async function claimCommerceCatalogSyncJobsInPostgres',
  ),
  catalogPersistence.indexOf('async function currentJobFence'),
)
assert.doesNotMatch(
  claimedCatalogJobs,
  /policy\.unmatched_action = 'auto_create'/u,
  'The worker must claim review-policy catalog jobs without auto-creating products',
)

const signalQueries = []
const persistence = loadTypeScriptModule(
  'app_src/lib/persistence/commerceCatalogSync.ts',
  {
    mocks: {
      '@/lib/auditWriter': { async recordAuditEvent() {} },
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock(client, key) {
          signalQueries.push({ kind: 'lock', key })
          await client.query('SELECT pg_advisory_xact_lock(1)')
        },
        async query() {
          return { rows: [] }
        },
        async withTransaction() {
          assert.fail('The receipt transaction must supply the client')
        },
      },
    },
  },
)
const signal = await persistence.signalShopifyCatalogRefreshWithClient(
  {
    async query(sql, values) {
      signalQueries.push({ kind: 'query', sql, values })
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      return {
        rowCount: 1,
        rows: [{ dirty_version: '8', reconciled_version: '6' }],
      }
    },
  },
  {
    organizationId: '11111111-1111-4111-8111-111111111111',
    integrationAccountId: '22222222-2222-4222-8222-222222222222',
    credentialGeneration: 3,
    receiptGlobalId: 'gcw1234567',
    providerTriggeredAt: '2026-08-01T12:00:00.000Z',
  },
)
assert.deepEqual(JSON.parse(JSON.stringify(signal)), {
  dirtyVersion: 8,
  reconciledVersion: 6,
})
assert.equal(signalQueries[0].kind, 'lock')
const signalUpsert = signalQueries.find((entry) => (
  entry.kind === 'query'
  && entry.sql.includes('operations_shopify_catalog_refresh_states')
))
assert.ok(signalUpsert, 'Shopify catalog dirty signal was not issued')
includes(signalUpsert.sql, [
  'ON CONFLICT (organization_id, integration_account_id)',
  '.dirty_version + 1',
  'RETURNING dirty_version::text, reconciled_version::text',
], 'Shopify catalog dirty signal')

const latestCatalogJob = {
  status: 'succeeded',
  provider: 'shopify',
  credential_version: 1,
  policy_revision: 4,
  continuation_run_global_id: null,
  page_count: 5,
  provider_records_seen: '240',
  products_created: '0',
  products_mapped: '0',
  products_unchanged: '240',
  products_skipped: '0',
  products_failed: '0',
  attempt_count: 0,
  result_summary: {},
  max_attempts: 8,
  available_at: '2026-08-01T14:43:49.000Z',
  last_error_code: null,
  started_at: '2026-08-01T14:42:00.000Z',
  completed_at: '2026-08-01T14:43:49.000Z',
  updated_at: '2026-08-01T14:43:49.000Z',
  active_backlog: '0',
  unmatched_action: 'review',
  current_credential_version: 1,
  current_policy_revision: 4,
  current_policy_version: 'commerce-product-intake-policy-v1',
  current_provider: 'shopify',
  last_success_at: '2026-08-01T14:43:49.000Z',
}
async function catalogState(provider, dirtyVersion, reconciledVersion) {
  return persistence.readCommerceCatalogSyncStateWithClient(
    {
      async query(sql) {
        if (sql.includes(
          'LEFT JOIN operations_shopify_catalog_refresh_states refresh',
        )) {
          return {
            rows: [{
              provider,
              dirty_version: dirtyVersion,
              reconciled_version: reconciledVersion,
            }],
          }
        }
        if (sql.includes('FROM operations_commerce_catalog_sync_jobs job')) {
          return {
            rows: [{
              ...latestCatalogJob,
              provider,
              current_provider: provider,
            }],
          }
        }
        throw new Error(`Unexpected catalog-state query: ${sql}`)
      },
    },
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      integrationAccountId: '22222222-2222-4222-8222-222222222222',
    },
  )
}
const reviewShopifyState = await catalogState('shopify', '36', '0')
assert.equal(reviewShopifyState.status, 'completed')
assert.equal(reviewShopifyState.rawStatus, 'succeeded')
assert.equal(reviewShopifyState.dirtyVersion, 36)
assert.equal(reviewShopifyState.reconciledVersion, 0)
assert.equal(reviewShopifyState.pendingRefreshSignals, 36)
assert.ok(reviewShopifyState.nextRunAt)

const reviewFaireState = await catalogState('faire', null, null)
assert.equal(reviewFaireState.status, 'completed')
assert.equal(reviewFaireState.dirtyVersion, null)
assert.equal(reviewFaireState.reconciledVersion, null)
assert.equal(reviewFaireState.pendingRefreshSignals, null)

const integrationService = read(
  'app_src/lib/integrations/commerceIntegrations.ts',
)
includes(integrationService, [
  'registerShopifyScopeWebhookSubscriptions',
  'registerShopifyCatalogWebhookSubscriptions',
  "group: 'scope' | 'inventory' | 'catalog'",
  'SHOPIFY_SCOPE_REFRESH_WEBHOOK_TOPICS',
  'SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS',
  'scopeWebhookSubscriptions',
  'catalogWebhookSubscriptions',
  'SHOPIFY_RECEIPT_SUBSCRIPTIONS_INCOMPLETE',
  'providerWrites: 0',
], 'Shopify catalog webhook registration')

includes(
  read('app_src/app/api/integrations/commerce/route.ts'),
  [
    "action === 'register-shopify-scope-webhooks'",
    "action === 'register-shopify-catalog-webhooks'",
    'confirmProviderWrites !== true',
    'registerShopifyScopeWebhookSubscriptions',
    'registerShopifyCatalogWebhookSubscriptions',
  ],
  'Shopify catalog webhook registration API',
)
includes(
  read('app_src/components/settings/CommerceIntegrationPanel.tsx'),
  [
    'registerScopeWebhooks',
    'Register scope safety webhook',
    'registerCatalogWebhooks',
    'Register catalog webhooks',
    'read-only catalog reconciliation in Shadow',
  ],
  'Shopify catalog webhook registration UI',
)

includes(
  read('app_src/components/settings/CommerceIntakeWorkflow.tsx'),
  [
    'pendingRefreshSignals?: number | null',
    'pendingCatalogRefreshSignals',
    'catalog change notification${',
    'Existing mapped products will refresh automatically',
    'Automatically create unmatched provider products',
    'Faire does not currently provide catalog webhooks',
  ],
  'Review-only catalog refresh observability UI',
)
includes(
  read('app_src/lib/persistence/commerceIntake.ts'),
  [
    'const productCatalogSync = await readCommerceCatalogSyncStateWithClient(',
    'productCatalogSync,',
  ],
  'Commerce intake catalog-sync state projection',
)
includes(
  read('app_src/app/api/integrations/commerce/intake/route.ts'),
  [
    'const intake = await getCommerceIntake({',
    'return json({ ok: true, intake })',
  ],
  'Commerce intake API state response',
)

const worker = read('app_src/lib/commerceCatalogSyncWorker.ts')
includes(worker, [
  'replayHeldShopifyProductDeletionsInPostgres',
  'heldProductDeletionsReconciled',
  'const followUpQueued = await queueAutomaticCommerceCatalogSyncsInPostgres()',
  'autoQueued: autoQueued + followUpQueued',
], 'Shopify catalog follow-up scheduling')

includes(
  read('app_src/app/api/health/route.ts'),
  [
    'operations_shopify_catalog_webhook_refresh_applied',
    '0197_operations_shopify_catalog_webhook_refresh.sql',
    'unreconciled_shopify_accounts',
    'unreconciled_shopify_signals',
    'overdue_shopify_refreshes_without_active_job',
    'unreconciled webhook signals without an active reconciliation job',
  ],
  'Shopify catalog webhook migration health gate',
)

console.log(
  'Shopify catalog webhook refresh tests passed '
  + '(registration, signed receipt signal, monotonic watermark, follow-up '
  + 'scheduling, review-only observability, Faire null semantics, read-only '
  + 'boundary, and zero provider writes).',
)
