#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { emailBodyPreview } from '../app_src/lib/crm/emailBodyPreview.mjs'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(path.join(root, relative), 'utf8')
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function loadTypeScript(pathname, source, mocks = {}) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: pathname,
    reportDiagnostics: true,
  })
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.equal(diagnostics.length, 0)
  const loaded = { exports: {} }
  vm.runInNewContext(output.outputText, {
    exports: loaded.exports,
    module: loaded,
    require: (specifier) => Object.prototype.hasOwnProperty.call(mocks, specifier)
      ? mocks[specifier]
      : specifier === '@/lib/integrations/shopifyOrderNativeActivity'
        ? nativeActivityRuntime
      : specifier === '@/lib/integrations/commerceOrderHistoryReadLimits'
        ? readLimitsRuntime
      : specifier === 'node:crypto'
        ? requireFromApp('node:crypto')
        : {},
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    process,
  }, { filename: pathname })
  return loaded.exports
}

const readLimitsRuntime = loadTypeScript(
  'app_src/lib/integrations/commerceOrderHistoryReadLimits.ts',
  await read('app_src/lib/integrations/commerceOrderHistoryReadLimits.ts'),
)
const nativeActivityRuntime = loadTypeScript(
  'app_src/lib/integrations/shopifyOrderNativeActivity.ts',
  await read('app_src/lib/integrations/shopifyOrderNativeActivity.ts'),
  { '@/lib/crm/emailBodyPreview.mjs': { emailBodyPreview } },
)
const historyPolicySource = await read(
  'app_src/lib/integrations/commerceOrderHistoryPolicy.ts',
)
const historyPolicyRuntime = loadTypeScript(
  'app_src/lib/integrations/commerceOrderHistoryPolicy.ts',
  historyPolicySource,
)

const [
  migration, persistence, history, capabilities, worker, processRoute,
  commerceIntegrations, historyPolicyMigration, historyAdmission,
  historyExclusionMigration,
] =
  await Promise.all([
  read('db/migrations/0276_operations_commerce_order_sync_foundation.sql'),
  read('app_src/lib/persistence/commerceOrderSync.ts'),
  read('app_src/lib/integrations/commerceOrderHistory.ts'),
  read('app_src/lib/integrations/commerceCapabilities.ts'),
  read('app_src/lib/commerceOrderHistoryWorker.ts'),
  read('app_src/app/api/integrations/commerce/orders/process/route.ts'),
  read('app_src/lib/persistence/commerceIntegrations.ts'),
  read('db/migrations/0349_operations_commerce_order_history_policy.sql'),
  read('app_src/lib/persistence/commerceOrderHistoryAdmission.ts'),
  read('db/migrations/0350_operations_commerce_order_history_exclusions.sql'),
])

for (const table of [
  'operations_commerce_order_sync_policies',
  'operations_commerce_order_backfill_sessions',
  'operations_commerce_order_observations',
  'operations_commerce_order_observation_lines',
  'operations_commerce_order_event_observations',
]) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))

assert.match(migration, /shopify_rolling_60_days/u)
assert.match(migration, /shopify_fixed_window_orders_complete/u)
assert.match(migration, /shopify_fixed_window_read_attempt_complete/u)
assert.match(migration, /faire_provider_available_orders_complete/u)
assert.match(migration, /read_all_orders_scope_observed boolean,/u)
assert.match(migration, /return_history_state/u)
assert.match(migration, /provider_write_count integer NOT NULL DEFAULT 0[\s\S]{0,80}provider_write_count = 0/u)
assert.match(migration, /BEFORE UPDATE OR DELETE ON operations_commerce_order_observations/u)
assert.match(migration, /BEFORE UPDATE OR DELETE ON operations_commerce_order_event_observations/u)
assert.match(migration, /inventory_semantics = 'order_demand'/u)
assert.match(migration, /retained locally after it ages out/u)
assert.match(migration, /session\.session_kind = 'continuous_poll'[\s\S]{0,120}NEW\.observation_kind = 'scheduled_poll'/u)
assert.match(migration, /redact_expired_commerce_order_sensitive_evidence/u)
assert.match(migration, /interval '400 days'/u)
assert.match(migration, /protect_credentialed_commerce_account_identity/u)
assert.match(migration, /credentialed_commerce_account_identity_guard/u)
assert.match(migration, /credential\.external_account_id = account\.external_account_id/u)
assert.doesNotMatch(migration, /webhook_triggered_exact_read|exact_reconciliation/u)

for (const forbidden of [
  'customer_name',
  'customer_email',
  'customer_phone',
  'shipping_address',
  'billing_address',
  'postal_code',
  'address_hash',
  'customer_hash',
]) assert.doesNotMatch(migration, new RegExp(forbidden, 'iu'))

assert.match(persistence, /SHOPIFY_READ_ORDERS_REQUIRED/u)
assert.doesNotMatch(persistence, /SHOPIFY_READ_ALL_ORDERS_REQUIRED/u)
assert.match(persistence, /readAllOrdersGranted/u)
assert.match(persistence, /credential\.external_account_id = account\.external_account_id/u)
assert.match(persistence, /commerceOrderHistoryWindow/u)
assert.match(persistence, /assessCommerceOrderHistoryAdmissionWithClient/u)
assert.match(persistence, /lockCommerceOrderHistoryAdmissionWithClient/u)
assert.match(persistence, /COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED/u)
assert.doesNotMatch(
  persistence,
  /CASE WHEN account\.provider = 'shopify'[\s\S]{0,120}'last_60_days'/u,
)
assert.match(persistence, /providerWrites: 0 as const/u)
assert.match(persistence, /lock_token = gen_random_uuid\(\)/u)
assert.match(persistence, /LEFT JOIN LATERAL[\s\S]{0,400}operations_orders/u)
assert.doesNotMatch(persistence, /INSERT INTO operations_orders/u)
assert.match(persistence, /attempt_count = 0/u)
assert.match(persistence, /page_count < session\.max_pages/u)
assert.match(persistence, /readCommerceOrderHistorySummariesFromPostgres/u)
assert.match(persistence, /readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres/u)
assert.doesNotMatch(
  persistence,
  /appendContinuousCommerceOrderObservationsInPostgres/u,
)
assert.match(
  commerceIntegrations,
  /credential_external_account_id !== row\.external_account_id/u,
)

assert.match(
  historyPolicyMigration,
  /CREATE TABLE operations_commerce_order_history_policies/u,
)
assert.match(historyPolicyMigration, /history_mode = 'provider_all'/u)
assert.match(historyPolicyMigration, /commerce order history policy is immutable/u)
assert.match(
  historyPolicyMigration,
  /ALTER FUNCTION protect_commerce_order_history_policy\(\)[\s\S]{0,100}SET search_path = pg_catalog, public, pg_temp/u,
)
assert.match(
  historyPolicyMigration,
  /SELECT account\.organization_id,[\s\S]{0,180}'new_orders_only',[\s\S]{0,80}frozen\.at,[\s\S]{0,80}frozen\.at/u,
)
assert.match(
  historyPolicyMigration,
  /order_history_mode text NOT NULL DEFAULT 'new_orders_only'/u,
)
assert.match(
  historyPolicyMigration,
  /commerce_order_backfill_coverage_basis_check[\s\S]{0,300}NOT VALID/u,
)
assert.match(
  historyPolicyMigration,
  /VALIDATE CONSTRAINT commerce_order_backfill_coverage_basis_check/u,
)
assert.match(historyAdmission, /The frozen floor governs first materialization only/u)
assert.match(historyAdmission, /operations_orders canonical/u)
assert.match(historyAdmission, /operations_external_identifiers external/u)
assert.match(historyAdmission, /operations_commerce_order_candidates candidate/u)
assert.match(historyAdmission, /operations_commerce_order_observations observation/u)
assert.match(historyAdmission, /reason: 'known_provider_identity'/u)
assert.match(historyAdmission, /providerCreatedAt >= row\.ingestion_floor\.getTime\(\)/u)
assert.match(
  historyExclusionMigration,
  /history_exclusion_code = 'COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED'/u,
)
assert.match(
  historyExclusionMigration,
  /history_excluded_provider_created_at <= captured_at/u,
)
assert.match(
  historyExclusionMigration,
  /NEW\.excluded_provider_created_at < history\.ingestion_floor/u,
)
assert.match(
  historyExclusionMigration,
  /NEW\.excluded_provider_created_at <=\s+NEW\.observed_provider_updated_at/u,
)
assert.match(
  historyExclusionMigration,
  /Order-history exclusion evidence is immutable/u,
)
assert.match(
  historyExclusionMigration,
  /commerce_store_sync_history_exclusion_valid[\s\S]{0,900}NOT VALID;[\s\S]{0,150}VALIDATE CONSTRAINT commerce_store_sync_history_exclusion_valid/u,
)
assert.match(
  historyExclusionMigration,
  /shopify_order_webhook_history_exclusion_valid[\s\S]{0,700}NOT VALID;[\s\S]{0,150}VALIDATE CONSTRAINT shopify_order_webhook_history_exclusion_valid/u,
)
assert.match(
  persistence,
  /account\.integration_type = 'commerce'[\s\S]{0,80}account\.provider = \$4/u,
)
assert.match(
  commerceIntegrations,
  /operations_commerce_order_history_policies[\s\S]{0,800}ON CONFLICT \(organization_id, integration_account_id\) DO NOTHING/u,
)
assert.equal(
  historyPolicyRuntime.normalizeCommerceOrderHistoryMode(
    'new_orders_only',
    'shopify',
  ),
  'new_orders_only',
)
assert.equal(
  historyPolicyRuntime.normalizeCommerceOrderHistoryMode(undefined, 'shopify'),
  'new_orders_only',
)
assert.equal(
  historyPolicyRuntime.normalizeCommerceOrderHistoryMode(undefined, 'faire'),
  'new_orders_only',
)
for (const mode of ['last_7_days', 'last_30_days', 'last_60_days']) {
  assert.equal(
    historyPolicyRuntime.normalizeCommerceOrderHistoryMode(mode, 'shopify'),
    mode,
  )
  assert.equal(
    historyPolicyRuntime.normalizeCommerceOrderHistoryMode(mode, 'faire'),
    mode,
  )
}
assert.equal(
  historyPolicyRuntime.normalizeCommerceOrderHistoryMode(
    'provider_all',
    'faire',
  ),
  'provider_all',
)
assert.equal(
  historyPolicyRuntime.commerceOrderHistoryRequestedFrom(
    'last_7_days',
    new Date('2026-09-04T12:00:00.000Z'),
  ).toISOString(),
  '2026-08-28T12:00:00.000Z',
)
assert.equal(
  historyPolicyRuntime.commerceOrderHistoryRequestedFrom(
    'provider_all',
    new Date('2026-09-04T12:00:00.000Z'),
  ),
  null,
)
assert.throws(
  () => historyPolicyRuntime.normalizeCommerceOrderHistoryMode(
    'provider_all',
    'shopify',
  ),
  /invalid for shopify/u,
)
assert.throws(
  () => historyPolicyRuntime.normalizeCommerceOrderHistoryMode(
    'unbounded',
    'faire',
  ),
  /invalid for faire/u,
)

assert.match(history, /status:any created_at:>='/u)
assert.match(history, /created_at:<='/u)
assert.match(history, /sortKey: \$\{sortKey\}, reverse: false/u)
assert.match(history, /mode === 'continuous_poll' \? 'UPDATED_AT' : 'CREATED_AT'/u)
assert.doesNotMatch(history, /status:open/u)
assert.match(history, /duration > SIXTY_DAYS_MS/u)
assert.match(history, /providerWrites: 0/u)
assert.match(history, /readAllOrdersScopeObserved: readAllOrders/u)
assert.match(history, /returnHistoryScopeObserved: readReturns/u)
assert.match(history, /listFaireOrders\(options, \{/u)
assert.match(history, /cursor: input\.providerCursor/u)
assert.match(history, /updatedAtMin: requestedFrom/u)
assert.doesNotMatch(history, /updateFaire|cancelFaire|moveFaire|updateShopify|mutation /u)
assert.match(history, /attributionSource: 'unavailable'/u)
assert.doesNotMatch(history, /providerActorFingerprint: staffFingerprint/u)
assert.doesNotMatch(history, /staffMember \{ id \}/u)
assert.match(history, /providerInventoryReservationState/u)
assert.match(history, /inventoryEffectKind: 'order_demand'/u)
assert.doesNotMatch(history, /partyFingerprint|shipToFingerprint|shippingAddress/u)

assert.equal(
  (
    capabilities.match(
      /historical_order_import: 'control_plane_implemented'/gu,
    ) || []
  ).length,
  2,
  'Both providers must advertise the landed read-only history control plane',
)
assert.match(
  capabilities,
  /historical_order_import: \['read_orders'\]/u,
)
assert.doesNotMatch(
  capabilities,
  /historical_order_import: \['read_orders', 'read_all_orders'\]/u,
)
assert.match(
  capabilities,
  /FAIRE_PROVIDER_AVAILABLE_CAPABILITIES = \[[\s\S]*?'historical_order_import'/u,
)
assert.match(
  capabilities,
  /historical_order_import: \['READ_ORDERS'\]/u,
)

const persistenceRuntime = loadTypeScript(
  'app_src/lib/persistence/commerceOrderSync.ts',
  persistence,
  {
    '@/lib/integrations/commerceReadRuntime': {
      commerceReadAccountSql: () => 'TRUE',
    },
    '@/lib/integrations/commerceCapabilities': {
      hasEffectiveShopifyScope: (scopes, expected) => scopes.includes(expected),
    },
    '@/lib/integrations/commerceCredentialCrypto': {
      COMMERCE_ORDER_SYNC_CURSOR_AAD_VERSION:
        'commerce-order-sync-cursor-aad-v1',
    },
    '@/lib/operations/commerceStoreSync': {
      commerceStoreSyncRunningSql: () => 'TRUE',
    },
  },
)
const keyConfiguration = await import(
  '../app_src/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'
)
let hosted = true
const cryptoRuntime = loadTypeScript(
  'app_src/lib/integrations/commerceCredentialCrypto.ts',
  await read('app_src/lib/integrations/commerceCredentialCrypto.ts'),
  {
    '@/lib/globalIds.mjs': {
      normalizeGlobalId(value, prefix) {
        const normalized = String(value || '').trim().toLowerCase()
        return normalized.startsWith(prefix) ? normalized : null
      },
    },
    '@/lib/persistence/config': { isHostedRuntime: () => hosted },
    '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs':
      keyConfiguration,
    '@/lib/integrations/integrationCredentialRuntimeGate.mjs':
      integrationCredentialRuntimeGate,
  },
)
const historyRuntime = loadTypeScript(
  'app_src/lib/integrations/commerceOrderHistory.ts',
  history,
  {
    '@/lib/integrations/commerceCredentialCrypto': cryptoRuntime,
    '@/lib/persistence/commerceOrderSync': {
      CommerceOrderSyncError: class CommerceOrderSyncError extends Error {
        constructor(code, message, status = 409) {
          super(message)
          this.code = code
          this.status = status
        }
      },
    },
    '@/lib/persistence/commerceStoreSync': {
      withCommerceStoreSyncProviderReadFenceInPostgres: (input) => input.read(),
    },
  },
)

assert.equal(
  persistenceRuntime.commerceOrderObservationKindForSession(
    'historical_backfill',
  ),
  'historical_backfill',
)
assert.equal(
  persistenceRuntime.commerceOrderObservationKindForSession('continuous_poll'),
  'scheduled_poll',
)
assert.throws(
  () => persistenceRuntime.assertCommerceOrderSyncObservationKinds(
    'continuous_poll',
    ['historical_backfill'],
  ),
  /wrong observation kind/u,
)
assert.doesNotThrow(
  () => persistenceRuntime.assertCommerceOrderSyncObservationKinds(
    'continuous_poll',
    ['scheduled_poll'],
  ),
)
assert.equal(
  persistenceRuntime.commerceOrderHistoryReadiness({
    provider: 'shopify',
    authMode: 'shopify_client_credentials',
    grantedScopes: ['read_orders'],
  }).completionMeaning,
  'shopify_fixed_window_read_attempt_complete',
)
assert.equal(
  persistenceRuntime.commerceOrderHistoryReadiness({
    provider: 'shopify',
    authMode: 'shopify_client_credentials',
    grantedScopes: ['read_orders'],
  }).fullHistoricalCoverageReady,
  false,
)
assert.equal(
  persistenceRuntime.commerceOrderHistoryReadiness({
    provider: 'faire',
    authMode: 'faire_brand_token',
  }).pollingCadenceMinutes,
  5,
)
assert.equal(
  persistenceRuntime.commerceOrderHistoryReadiness({
    provider: 'shopify',
    authMode: 'shopify_client_credentials',
    grantedScopes: ['read_orders'],
  }).pollingCadenceMinutes,
  30,
)
assert.equal(
  persistenceRuntime.commerceOrderHistoryReadiness({
    provider: 'shopify',
    authMode: 'shopify_client_credentials',
    grantedScopes: ['read_orders', 'read_all_orders'],
  }).completionMeaning,
  'shopify_fixed_window_orders_complete',
)
assert.equal(
  persistenceRuntime.commerceOrderHistoryReadiness({
    provider: 'shopify',
    authMode: 'faire_brand_token',
    grantedScopes: ['read_orders', 'read_all_orders'],
  }).historicalOrdersReadable,
  false,
)
assert.equal(
  persistenceRuntime.commerceOrderHistoryReadiness({
    provider: 'shopify',
    authMode: 'faire_brand_token',
    grantedScopes: ['read_orders'],
  }).blockers[0],
  'COMMERCE_ORDER_SYNC_AUTH_MODE_INCOMPATIBLE',
)
assert.equal(
  persistenceRuntime.commerceOrderHistoryReadiness({
    provider: 'faire',
    authMode: 'shopify_client_credentials',
    requestedScopes: ['READ_ORDERS'],
  }).historicalOrdersReadable,
  false,
)

for (const malformed of [null, false, '', '0', Number.NaN, Infinity, 1.5, -1]) {
  assert.throws(
    () => persistenceRuntime.normalizeCommerceOrderQuantity(
      malformed,
      'Provider quantity',
    ),
    /Provider quantity is invalid/u,
  )
  assert.equal(
    historyRuntime.normalizeCommerceHistoryProviderQuantity(malformed),
    null,
  )
}
assert.equal(
  persistenceRuntime.normalizeCommerceOrderQuantity(null, 'Quantity', true),
  null,
)
assert.equal(
  persistenceRuntime.normalizeCommerceOrderQuantity(undefined, 'Quantity', true),
  null,
)
assert.equal(persistenceRuntime.normalizeCommerceOrderQuantity(0, 'Quantity'), 0)
assert.equal(historyRuntime.normalizeCommerceHistoryProviderQuantity(0), 0)
assert.equal(
  historyRuntime.sumCommerceHistoryProviderQuantities({
    nodes: [{ quantity: 2 }, { quantity: 3 }],
  }),
  5,
)
for (const malformed of [null, false, '', '0']) {
  assert.equal(
    historyRuntime.sumCommerceHistoryProviderQuantities({
      nodes: [{ quantity: 2 }, { quantity: malformed }],
    }),
    null,
    'one malformed member must prevent a partial quantity sum',
  )
}

const unavailableMoney = {
  state: 'unavailable',
  value: null,
  reason: 'not_provided',
}
const availableMoney = (amountMinor) => ({
  state: 'available',
  value: {
    primary: { amountMinor: BigInt(amountMinor), currency: 'USD' },
    shop: unavailableMoney,
    presentment: unavailableMoney,
  },
})
const historyLine = (provider, input) => ({
  identity: {
    provider,
    resourceType: 'order_line',
    value: input.externalLineId,
  },
  productIdentity: {
    state: 'available',
    value: {
      provider,
      resourceType: 'product',
      value: `${input.externalLineId}-product`,
    },
  },
  variantIdentity: {
    state: 'unavailable',
    value: null,
    reason: 'not_provided',
  },
  sku: input.sku,
  titleSnapshot: input.title,
  variantTitleSnapshot: input.variantTitle || null,
  vendorSnapshot: input.vendor || null,
  orderedQuantity: input.quantity,
  currentQuantity: input.quantity,
  unfulfilledQuantity: 0,
  fulfilledQuantity: input.quantity,
  returnedQuantity: 0,
  requiresShipping: true,
  unitPrice: availableMoney(input.unitPriceMinor),
  lineSubtotal: availableMoney(input.subtotalMinor),
  lineDiscount: availableMoney(input.discountMinor),
  lineTax: availableMoney(input.taxMinor),
})
const historyOrder = (provider, lines) => ({
  identity: { provider, resourceType: 'order', value: `${provider}-order-1` },
  orderNumber: `${provider}-order-1`,
  providerCreatedAt: null,
  providerProcessedAt: null,
  providerUpdatedAt: '2026-08-13T00:00:00.000Z',
  providerCancelledAt: null,
  providerClosedAt: null,
  rawStates: {
    lifecycle: 'OPEN',
    payment: 'PAID',
    fulfillment: 'FULFILLED',
    returns: 'NONE',
  },
  canonicalStates: {
    lifecycle: 'open',
    payment: 'paid',
    fulfillment: 'fulfilled',
    returns: 'none',
  },
  total: availableMoney(12_500),
  lines,
})
const observedAt = '2026-08-13T00:00:01.000Z'
const shopifyHistoryLine = historyLine('shopify', {
  externalLineId: 'gid://shopify/LineItem/line-1',
  sku: 'SHOP-ONE',
  title: 'Original Shopify item',
  variantTitle: 'Large',
  vendor: 'Provider vendor',
  quantity: 2,
  unitPriceMinor: 5_000,
  subtotalMinor: 10_000,
  discountMinor: 500,
  taxMinor: 800,
})
const shopifyObservation = historyRuntime.commerceOrderHistoryObservation(
  'shopify',
  historyOrder('shopify', [shopifyHistoryLine]),
  { fulfillments: [], refunds: [] },
  observedAt,
  3,
  'manual_exact_read',
)
// Optional native fields must respect the unchanged core event-status limit.
// Oversized activity is omitted with explicit partial coverage, not allowed
// to turn a valid order and its lines into a normalization failure.
for (const actionLength of [128, 129, 255, 256]) {
  const nativeOrderId = shopifyObservation.externalOrderId
  const activity = await nativeActivityRuntime.readShopifyOrderNativeActivity({
    externalOrderId: nativeOrderId, observedAt, includeStaffAuthors: false,
    readPage: async () => ({ order: { id: nativeOrderId, events: {
      nodes: ['updated', 'x'.repeat(actionLength)].map((action, index) => ({
        __typename: 'BasicEvent', id: `gid://shopify/BasicEvent/${index + 1}`,
        subjectId: nativeOrderId, action, createdAt: '2026-08-13T00:00:00.000Z',
        message: 'Provider activity', actor: 'Provider operator',
        attributeToUser: true, attributeToApp: false,
      })), pageInfo: { hasNextPage: false, endCursor: null },
    } } }),
  })
  assert.equal(activity.nativeActivityFetchedCount, 2)
  assert.equal(activity.providerReads, 1)
  assert.equal(activity.nativeActivityState, actionLength === 128 ? 'complete' : 'partial')
  assert.equal(activity.nativeActivityReason, actionLength === 128 ? null : 'invalid_provider_event')
  assert.equal(activity.events.length, actionLength === 128 ? 2 : 1)
  const withActivity = historyRuntime.commerceOrderHistoryObservation(
    'shopify', historyOrder('shopify', [shopifyHistoryLine]),
    { fulfillments: [], refunds: [], nativeActivity: activity }, observedAt, 4, 'manual_exact_read',
  )
  const retained = persistenceRuntime.normalizeCommerceOrderObservationInput(withActivity)
  assert.equal(retained.lines.length, shopifyObservation.lines.length)
  assert.equal(retained.providerReadCount, 4)
  assert.equal(retained.nativeActivityState, activity.nativeActivityState)
}
assert.deepEqual(
  JSON.parse(JSON.stringify(shopifyObservation.lines[0])),
  {
    externalLineId: 'gid://shopify/LineItem/line-1',
    externalProductId: 'gid://shopify/LineItem/line-1-product',
    externalVariantId: null,
    sku: 'SHOP-ONE',
    titleSnapshot: 'Original Shopify item',
    variantTitleSnapshot: 'Large',
    vendorSnapshot: 'Provider vendor',
    originalQuantity: 2,
    currentQuantity: 2,
    unfulfilledQuantity: 0,
    fulfilledQuantity: 2,
    returnedQuantity: 0,
    requiresShipping: true,
    unitPriceCurrency: 'USD',
    unitPriceMinor: 5_000,
    subtotalCurrency: 'USD',
    subtotalMinor: 10_000,
    discountCurrency: 'USD',
    discountMinor: 500,
    taxCurrency: 'USD',
    taxMinor: 800,
  },
  'Shopify history retains exact item descriptions and money',
)
const changedShopifyObservation = historyRuntime.commerceOrderHistoryObservation(
  'shopify',
  historyOrder('shopify', [{
    ...shopifyHistoryLine,
    titleSnapshot: 'Replacement Shopify item',
    lineSubtotal: availableMoney(9_500),
  }]),
  { fulfillments: [], refunds: [] },
  observedAt,
  3,
  'manual_exact_read',
)
assert.notEqual(
  changedShopifyObservation.sourceHash,
  shopifyObservation.sourceHash,
  'provider title and price changes must change the retained revision hash',
)
const faireObservation = historyRuntime.commerceOrderHistoryObservation(
  'faire',
  historyOrder('faire', [historyLine('faire', {
    externalLineId: 'faire-line-1',
    sku: null,
    title: 'Added Faire item without SKU',
    vendor: 'Faire brand',
    quantity: 1,
    unitPriceMinor: 4_200,
    subtotalMinor: 4_200,
    discountMinor: 0,
    taxMinor: 210,
  })]),
  {},
  observedAt,
  2,
  'manual_exact_read',
)
assert.equal(faireObservation.lines[0].sku, null)
assert.equal(faireObservation.lines[0].titleSnapshot, 'Added Faire item without SKU')
assert.equal(faireObservation.lines[0].unitPriceMinor, 4_200)
assert.equal(faireObservation.lines[0].taxMinor, 210)
const privacyObservationBase = {
  observationKind: 'historical_backfill',
  externalOrderId: 'provider-order-privacy-1',
  orderNumber: '#privacy-1',
  sourceRevision: '2026-08-13T00:00:00.000Z',
  sourceHash: 'd'.repeat(64),
  canonicalLifecycleState: 'closed',
  canonicalPaymentState: 'refunded',
  canonicalFulfillmentState: 'fulfilled',
  canonicalReturnState: 'returned',
  providerCreatedAt: '2026-08-12T00:00:00.000Z',
  providerUpdatedAt: '2026-08-13T00:00:00.000Z',
  observedAt: '2026-08-13T00:00:01.000Z',
  providerReadCount: 2,
  lines: [{
    externalLineId: 'line-privacy-1',
    originalQuantity: 1,
    currentQuantity: 1,
    unfulfilledQuantity: 0,
    fulfilledQuantity: 1,
  }],
}
const privacyEventBase = {
  externalSubjectId: 'shipment-privacy-1',
  eventKind: 'tracking_updated',
  attributionSource: 'provider_staff',
  trackingCarrier: 'UPS',
  occurredAt: '2026-08-13T00:00:00.000Z',
}
const privacyOne = persistenceRuntime.normalizeCommerceOrderObservationInput({
  ...privacyObservationBase,
  events: [{
    ...privacyEventBase,
    externalEventId:
      'shipment-privacy-1:tracking:0:0:2026-08-13T00:00:00.000Z',
    trackingNumber: '1Z-PRIVATE-ONE',
    providerActorFingerprint: '1'.repeat(64),
  }],
})
const privacyTwo = persistenceRuntime.normalizeCommerceOrderObservationInput({
  ...privacyObservationBase,
  sourceHash: 'e'.repeat(64),
  observedAt: '2026-08-13T00:00:02.000Z',
  events: [{
    ...privacyEventBase,
    externalEventId:
      'shipment-privacy-1:tracking:0:0:2026-08-13T00:00:01.000Z',
    trackingNumber: '1Z-PRIVATE-TWO',
    providerActorFingerprint: '2'.repeat(64),
    occurredAt: '2026-08-13T00:00:01.000Z',
  }],
})
assert.notEqual(
  privacyOne.sourceHash,
  privacyTwo.sourceHash,
  'An advanced provider revision must retain changed tracking evidence',
)
assert.notEqual(
  privacyOne.events[0].eventHash,
  privacyTwo.events[0].eventHash,
  'An advanced provider event revision must retain changed tracking evidence',
)
const privacySameRevisionChangedTracking =
  persistenceRuntime.normalizeCommerceOrderObservationInput({
    ...privacyObservationBase,
    events: [{
      ...privacyEventBase,
      externalEventId:
        'shipment-privacy-1:tracking:0:0:2026-08-13T00:00:00.000Z',
      trackingNumber: '1Z-PRIVATE-TWO',
      providerActorFingerprint: '2'.repeat(64),
    }],
  })
assert.equal(
  privacyOne.sourceHash,
  privacySameRevisionChangedTracking.sourceHash,
  'Exact sensitive values remain excluded from durable observation identity',
)
assert.equal(
  privacyOne.events[0].eventHash,
  privacySameRevisionChangedTracking.events[0].eventHash,
  'Exact sensitive values remain excluded from durable event identity',
)
for (const sensitive of [
  '1Z-PRIVATE-ONE',
  '1'.repeat(64),
]) {
  assert.equal(
    JSON.stringify({
      sourceHash: privacyOne.sourceHash,
      eventHash: privacyOne.events[0].eventHash,
      externalEventId: privacyOne.events[0].externalEventId,
      externalSubjectId: privacyOne.events[0].externalSubjectId,
    }).includes(sensitive),
    false,
  )
}
assert.throws(
  () => persistenceRuntime.normalizeCommerceOrderObservationInput({
    ...privacyObservationBase,
    events: [{
      ...privacyEventBase,
      externalEventId: 'shipment:1Z-PRIVATE-ONE:tracking',
      trackingNumber: '1Z-PRIVATE-ONE',
      providerActorFingerprint: '1'.repeat(64),
    }],
  }),
  /must not be embedded in durable identifiers/u,
)
const fingerprintContext = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  accountGlobalId: 'gia0000001',
  provider: 'shopify',
  staffId: 'gid://shopify/StaffMember/123',
}
const managedEnvironment = [
  'INTEGRATION_EVIDENCE_FINGERPRINT_KEY',
  'INTEGRATION_EVIDENCE_ACTIVE_KEY_ID',
  'INTEGRATION_EVIDENCE_ENCRYPTION_KEYS',
]
const previousEnvironment = new Map(
  managedEnvironment.map((name) => [name, process.env[name]]),
)
process.env.INTEGRATION_EVIDENCE_FINGERPRINT_KEY =
  'history-staff-fingerprint-key-000000000000000001'
process.env.INTEGRATION_EVIDENCE_ACTIVE_KEY_ID = 'history-k1'
process.env.INTEGRATION_EVIDENCE_ENCRYPTION_KEYS = JSON.stringify({
  'history-k1': 'history-encryption-key-one-000000000000000001',
})
const fingerprint = historyRuntime.commerceProviderStaffFingerprint(
  fingerprintContext,
)
assert.match(fingerprint, /^[a-f0-9]{64}$/u)
assert.notEqual(
  fingerprint,
  historyRuntime.commerceProviderStaffFingerprint({
    ...fingerprintContext,
    organizationId: '00000000-0000-4000-8000-000000000002',
  }),
)

const cursorContext = {
  organizationId: fingerprintContext.organizationId,
  accountGlobalId: fingerprintContext.accountGlobalId,
  provider: fingerprintContext.provider,
  sessionId: '11111111-1111-4111-8111-111111111111',
  page: 1,
  queryHash: 'a'.repeat(64),
}
const cursorOne = cryptoRuntime.encryptCommerceOrderSyncCursor(
  { orderCursor: 'opaque-provider-cursor' },
  cursorContext.organizationId,
  cursorContext.accountGlobalId,
  cursorContext.provider,
  cursorContext.sessionId,
  cursorContext.page,
  cursorContext.queryHash,
)
process.env.INTEGRATION_EVIDENCE_ACTIVE_KEY_ID = 'history-k2'
process.env.INTEGRATION_EVIDENCE_ENCRYPTION_KEYS = JSON.stringify({
  'history-k1': 'history-encryption-key-one-000000000000000001',
  'history-k2': 'history-encryption-key-two-000000000000000002',
})
assert.equal(
  cryptoRuntime.decryptCommerceOrderSyncCursor(
    cursorOne,
    cursorContext.organizationId,
    cursorContext.accountGlobalId,
    cursorContext.provider,
    cursorContext.sessionId,
    cursorContext.page,
    cursorContext.queryHash,
  ).orderCursor,
  'opaque-provider-cursor',
)
const tamperedCursorCiphertext = Buffer.from(cursorOne.ciphertext)
tamperedCursorCiphertext[0] ^= 1
assert.throws(
  () => cryptoRuntime.decryptCommerceOrderSyncCursor(
    { ...cursorOne, ciphertext: tamperedCursorCiphertext },
    cursorContext.organizationId,
    cursorContext.accountGlobalId,
    cursorContext.provider,
    cursorContext.sessionId,
    cursorContext.page,
    cursorContext.queryHash,
  ),
  /could not be decrypted/u,
)
process.env.INTEGRATION_EVIDENCE_ENCRYPTION_KEYS = JSON.stringify({
  'history-k2': 'history-encryption-key-two-000000000000000002',
})
assert.throws(
  () => cryptoRuntime.decryptCommerceOrderSyncCursor(
    cursorOne,
    cursorContext.organizationId,
    cursorContext.accountGlobalId,
    cursorContext.provider,
    cursorContext.sessionId,
    cursorContext.page,
    cursorContext.queryHash,
  ),
  /could not be decrypted/u,
)
const historicalQuery = historyRuntime.shopifyOrderHistoryListQuery(
  'historical_backfill',
)
const continuousQuery = historyRuntime.shopifyOrderHistoryListQuery(
  'continuous_poll',
)
assert.match(historicalQuery, /sortKey: CREATED_AT/u)
assert.match(continuousQuery, /sortKey: UPDATED_AT/u)
assert.deepEqual(
  { ...historyRuntime.faireOrderHistoryListWindow({
    requestedFrom: null,
    requestedThrough: '2026-08-13T00:00:00.000Z',
    mode: 'historical_backfill',
  }) },
  {
    requestedFrom: null,
    requestedThrough: '2026-08-13T00:00:00.000Z',
    updatedAtMin: null,
  },
)
assert.throws(
  () => historyRuntime.faireOrderHistoryListWindow({
    requestedFrom: null,
    requestedThrough: '2026-08-13T00:00:00.000Z',
    mode: 'continuous_poll',
  }),
  /requires an updated-at overlap start time/u,
)
assert.equal(
  historyRuntime.faireOrderHistoryListWindow({
    requestedFrom: '2026-08-06T00:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    mode: 'historical_backfill',
  }).updatedAtMin,
  '2026-08-06T00:00:00.000Z',
)
assert.equal(
  historyRuntime.faireOrderHistoryListWindow({
    requestedFrom: '2026-08-12T23:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    mode: 'continuous_poll',
  }).updatedAtMin,
  '2026-08-12T23:00:00.000Z',
)
assert.doesNotThrow(
  () => historyRuntime.assertShopifyOrderHistoryWindowAccessible({
    requestedFrom: '2026-06-14T00:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    observedAt: '2026-08-14T00:00:00.000Z',
    readAllOrdersGranted: false,
  }),
  'A frozen admission floor must not make delayed standard-scope work fail',
)
assert.equal(
  historyRuntime.shopifyOrderHistoryProviderRequestedFrom({
    requestedFrom: '2026-06-14T00:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    observedAt: '2026-08-14T00:00:00.000Z',
    readAllOrdersGranted: false,
  }),
  '2026-06-15T00:00:00.000Z',
  'Standard read_orders must clamp the provider query, not mutate the policy floor',
)
assert.equal(
  historyRuntime.shopifyOrderHistoryProviderRequestedFrom({
    requestedFrom: '2026-06-14T00:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    observedAt: '2026-08-14T00:00:00.000Z',
    readAllOrdersGranted: true,
  }),
  '2026-06-14T00:00:00.000Z',
  'read_all_orders may query the complete configured window',
)
assert.equal(
  historyRuntime.shopifyOrderHistoryProviderRequestedFrom({
    requestedFrom: '2026-04-01T00:00:00.000Z',
    requestedThrough: '2026-05-01T00:00:00.000Z',
    observedAt: '2026-08-14T00:00:00.000Z',
    readAllOrdersGranted: false,
  }),
  null,
  'A delayed standard-scope session must terminate when no accessible overlap remains',
)
assert.doesNotThrow(
  () => historyRuntime.shopifyHistoricalOrderSearchWindow({
    requestedFrom: '2026-05-01T00:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    mode: 'historical_backfill',
  }),
  'Authorized historical backfill is not inherently limited to 60 days',
)
assert.throws(
  () => historyRuntime.shopifyHistoricalOrderSearchWindow({
    requestedFrom: '2026-05-01T00:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    mode: 'continuous_poll',
  }),
  /provider-read window is invalid/u,
)
assert.match(
  historyRuntime.shopifyHistoricalOrderSearchWindow({
    requestedFrom: '2026-06-14T00:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    mode: 'historical_backfill',
  }),
  /created_at:>='2026-06-14T00:00:00.000Z'/u,
)
assert.doesNotMatch(
  historyRuntime.shopifyOrderHistoryDetailQuery(true),
  /staffMember/u,
)
assert.match(
  historyRuntime.shopifyOrderHistoryDetailQuery(true),
  /trackingInfo\(first: 11\)/u,
)
assert.match(
  historyRuntime.shopifyOrderHistoryDetailQuery(true),
  /fulfillments\(first: 101\)/u,
)
assert.match(
  historyRuntime.shopifyOrderHistoryDetailQuery(true),
  /returnLineItems\(first: 51\)/u,
)
assert.match(
  historyRuntime.shopifyOrderHistoryDetailQuery(true),
  /refundLineItems\(first: 51\)/u,
)
assert.match(
  historyRuntime.shopifyOrderHistoryDetailQuery(true),
  /fulfillmentLineItem \{ lineItem \{ id \} \}/u,
)
assert.doesNotMatch(
  historyRuntime.shopifyOrderHistoryDetailQuery(true),
  /nodes \{ id name status createdAt updatedAt/u,
)

const shopifyListRow = {
  id: 'gid://shopify/Order/1',
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
}
assert.deepEqual(
  JSON.parse(JSON.stringify(historyRuntime.shopifyOrderHistoryPageEvidence({
    nodes: [shopifyListRow],
    pageInfo: { hasNextPage: true, endCursor: 'shopify-page-2' },
  }))),
  { orders: [shopifyListRow], nextCursor: 'shopify-page-2' },
)
for (const invalid of [
  { nodes: [shopifyListRow, null], pageInfo: { hasNextPage: false } },
  { nodes: [shopifyListRow, 'bad'], pageInfo: { hasNextPage: false } },
  { nodes: [shopifyListRow] },
  { nodes: [shopifyListRow], pageInfo: { hasNextPage: 'false' } },
  { nodes: [shopifyListRow], pageInfo: { hasNextPage: true, endCursor: null } },
  {
    nodes: [shopifyListRow, shopifyListRow],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
]) {
  assert.throws(
    () => historyRuntime.shopifyOrderHistoryPageEvidence(invalid),
    /invalid/u,
  )
}
assert.throws(
  () => historyRuntime.shopifyOrderHistoryPageEvidence({
    nodes: [shopifyListRow],
    pageInfo: { hasNextPage: true, endCursor: 'repeat' },
  }, 'repeat'),
  /invalid/u,
)

const validShopifyDetail = {
  id: 'gid://shopify/Order/1',
  name: '#1',
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  processedAt: '2026-08-12T00:00:01.000Z',
  cancelledAt: null,
  closedAt: null,
  confirmed: true,
  currencyCode: 'USD',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  returnStatus: 'NO_RETURN',
  currentSubtotalPriceSet: {
    shopMoney: { amount: '10.00', currencyCode: 'USD' },
  },
  currentShippingPriceSet: {
    shopMoney: { amount: '0.00', currencyCode: 'USD' },
  },
  currentTotalTaxSet: {
    shopMoney: { amount: '0.00', currencyCode: 'USD' },
  },
  currentTotalDiscountsSet: {
    shopMoney: { amount: '0.00', currencyCode: 'USD' },
  },
  currentTotalPriceSet: {
    shopMoney: { amount: '10.00', currencyCode: 'USD' },
  },
  lineItems: {
    nodes: [{
      id: 'gid://shopify/LineItem/1',
      title: 'Test',
      quantity: 1,
      currentQuantity: 1,
      unfulfilledQuantity: 1,
      requiresShipping: true,
      originalUnitPriceSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
      originalTotalSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
      discountedTotalSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
      totalDiscountSet: {
        shopMoney: { amount: '0.00', currencyCode: 'USD' },
      },
      unfulfilledOriginalTotalSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
      unfulfilledDiscountedTotalSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  fulfillments: [],
  refunds: [],
}
assert.doesNotThrow(
  () => historyRuntime.assertShopifyOrderHistoryDetailEvidence(
    validShopifyDetail,
    false,
  ),
)
const blankOptionalShopifyDetail = {
  ...validShopifyDetail,
  lineItems: {
    ...validShopifyDetail.lineItems,
    nodes: [{
      ...validShopifyDetail.lineItems.nodes[0],
      sku: '',
      vendor: '',
      variantTitle: '',
    }],
  },
}
assert.doesNotThrow(
  () => historyRuntime.assertShopifyOrderHistoryDetailEvidence(
    blankOptionalShopifyDetail,
    false,
  ),
  'Shopify empty optional String fields must normalize as unavailable',
)
const validShopifyReturnDetail = {
  ...validShopifyDetail,
  returns: {
    nodes: [{
      id: 'gid://shopify/Return/1',
      name: '#return-1',
      status: 'REQUESTED',
      createdAt: '2026-08-12T02:00:00.000Z',
      requestApprovedAt: null,
      closedAt: null,
      totalQuantity: 1,
      returnLineItems: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
}
assert.doesNotThrow(
  () => historyRuntime.assertShopifyOrderHistoryDetailEvidence(
    validShopifyReturnDetail,
    true,
  ),
)
const attributedShopifyReturns = historyRuntime
  .shopifyOrderHistoryReturnedQuantities({
    refunds: [{
      refundLineItems: {
        nodes: [{
          quantity: 2,
          restockType: 'RETURN',
          lineItem: { id: 'gid://shopify/LineItem/1' },
        }, {
          quantity: 1,
          restockType: 'NO_RESTOCK',
          lineItem: { id: 'gid://shopify/LineItem/2' },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }],
    returns: {
      nodes: [{
        returnLineItems: {
          nodes: [{
            __typename: 'ReturnLineItem',
            processedQuantity: 1,
            refundedQuantity: 1,
            fulfillmentLineItem: {
              lineItem: { id: 'gid://shopify/LineItem/1' },
            },
          }, {
            __typename: 'ReturnLineItem',
            processedQuantity: 2,
            refundedQuantity: 0,
            fulfillmentLineItem: {
              lineItem: { id: 'gid://shopify/LineItem/2' },
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  })
assert.deepEqual(
  Object.fromEntries(attributedShopifyReturns),
  {
    'gid://shopify/LineItem/1': 2,
    'gid://shopify/LineItem/2': 2,
  },
  'exact refunds and processed returns must retain per-line quantities without double counting',
)
for (const invalid of [
  { ...validShopifyDetail, processedAt: 'not-a-time' },
  { ...validShopifyDetail, processedAt: null },
  Object.fromEntries(Object.entries(validShopifyDetail).filter(
    ([key]) => key !== 'processedAt',
  )),
  {
    ...validShopifyDetail,
    lineItems: {
      ...validShopifyDetail.lineItems,
      nodes: [null],
    },
  },
  {
    ...validShopifyDetail,
    lineItems: {
      ...validShopifyDetail.lineItems,
      nodes: [{ ...validShopifyDetail.lineItems.nodes[0], requiresShipping: null }],
    },
  },
  {
    ...validShopifyDetail,
    lineItems: {
      ...validShopifyDetail.lineItems,
      nodes: [{ ...validShopifyDetail.lineItems.nodes[0], sku: '   ' }],
    },
  },
  { ...validShopifyDetail, fulfillments: [null] },
  {
    ...validShopifyDetail,
    fulfillments: [{
      id: 'gid://shopify/Fulfillment/1',
      trackingInfo: [{ number: '1Z' }, null],
    }],
  },
  {
    ...validShopifyDetail,
    fulfillments: Array.from({ length: 101 }, (_value, index) => ({
      id: `gid://shopify/Fulfillment/${index}`,
      createdAt: '2026-08-12T01:00:00.000Z',
      updatedAt: '2026-08-12T01:01:00.000Z',
      status: 'SUCCESS',
      trackingInfo: [],
    })),
  },
  { ...validShopifyDetail, refunds: [null] },
  {
    ...validShopifyDetail,
    refunds: [{
      id: 'gid://shopify/Refund/missing-revision',
      createdAt: '2026-08-12T01:00:00.000Z',
      processedAt: '2026-08-12T01:01:00.000Z',
      updatedAt: null,
      totalRefundedSet: {
        shopMoney: { amount: '1.00', currencyCode: 'USD' },
      },
    }],
  },
  {
    ...validShopifyDetail,
    currentTotalPriceSet: {
      shopMoney: { amount: 'invalid', currencyCode: 'USD' },
    },
  },
  {
    ...validShopifyDetail,
    refunds: Array.from({ length: 101 }, (_value, index) => ({
      id: `gid://shopify/Refund/${index}`,
    })),
  },
]) {
  assert.throws(
    () => historyRuntime.assertShopifyOrderHistoryDetailEvidence(invalid, false),
    /invalid|bounded/u,
  )
}
for (const invalidReturn of [
  { ...validShopifyReturnDetail.returns.nodes[0], name: null },
  { ...validShopifyReturnDetail.returns.nodes[0], status: null },
  { ...validShopifyReturnDetail.returns.nodes[0], createdAt: null },
  { ...validShopifyReturnDetail.returns.nodes[0], totalQuantity: null },
  {
    ...validShopifyReturnDetail.returns.nodes[0],
    requestApprovedAt: 'not-a-time',
  },
]) {
  assert.throws(
    () => historyRuntime.assertShopifyOrderHistoryDetailEvidence({
      ...validShopifyReturnDetail,
      returns: {
        ...validShopifyReturnDetail.returns,
        nodes: [invalidReturn],
      },
    }, true),
    /invalid/u,
  )
}
const faireOrder = {
  id: 'bo_order_1',
  display_id: '#faire-1',
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-13T00:00:00.000Z',
  items: [],
}
assert.deepEqual(
  JSON.parse(JSON.stringify(historyRuntime.faireOrderHistoryPageEvidence({
    orders: [faireOrder],
    has_more: true,
    next_cursor: 'faire-page-2',
  }))),
  { orders: [faireOrder], nextCursor: 'faire-page-2' },
)
for (const invalid of [
  { orders: [faireOrder, null] },
  { orders: [faireOrder, 'bad'] },
  { orders: [faireOrder, faireOrder] },
  { orders: [faireOrder], has_more: 'false' },
  { orders: [faireOrder], has_more: true },
  { orders: [faireOrder], has_more: false, next_cursor: 'contradiction' },
  {
    orders: [faireOrder],
    has_more: true,
    next_cursor: 'a',
    pagination: { has_more: true, next_cursor: 'b' },
  },
]) {
  assert.throws(
    () => historyRuntime.faireOrderHistoryPageEvidence(invalid),
    /invalid/u,
  )
}
assert.throws(
  () => historyRuntime.faireOrderHistoryPageEvidence({
    orders: [faireOrder],
    has_more: true,
    next_cursor: 'repeat',
  }, 'repeat'),
  /invalid/u,
)
assert.doesNotThrow(
  () => historyRuntime.assertFaireOrderHistoryDetailEvidence(faireOrder),
)
for (const invalid of [
  { ...faireOrder, display_id: false },
  { ...faireOrder, updated_at: 'not-a-time' },
  { ...faireOrder, items: [null] },
  {
    ...faireOrder,
    items: [{ id: 'line-1', quantity: '1', requires_shipping: true }],
  },
  { ...faireOrder, shipments: [null] },
  {
    ...faireOrder,
    shipments: [{ id: 'ship-1', tracking_info: [{ tracking_code: 'T1' }, null] }],
  },
  {
    ...faireOrder,
    items: Array.from({ length: 251 }, (_value, index) => ({
      id: `line-${index}`,
      quantity: 1,
    })),
  },
]) {
  assert.throws(
    () => historyRuntime.assertFaireOrderHistoryDetailEvidence(invalid),
    /invalid|bounded/u,
  )
}

let adapterProvider = 'shopify'
let shopifyAdapterDetail = null
let shopifyAdapterNextCursor = null
let shopifyAdapterReadReturns = false
let shopifyAdapterReadAllOrders = true
let shopifyAdapterFailureStage = null
let shopifyAdapterNativeNodes = []
let faireAdapterOrder = null
let faireAdapterFailureStage = null
const normalizedAdapterOrder = (provider, source) => ({
  provider,
  identity: { value: String(source.id ?? source.order_id) },
  orderNumber: String(
    source.name ?? source.display_id ?? source.order_number
      ?? source.id ?? source.order_id,
  ),
  providerCreatedAt: String(source.createdAt ?? source.created_at),
  providerProcessedAt: String(
    source.processedAt ?? source.processed_at ?? source.processing_at
      ?? source.createdAt ?? source.created_at,
  ),
  providerUpdatedAt: String(source.updatedAt ?? source.updated_at),
  providerCancelledAt: source.cancelledAt ?? source.cancelled_at ?? null,
  providerClosedAt: source.closedAt ?? source.closed_at ?? null,
  rawStates: {
    lifecycle: String(source.status ?? source.state ?? 'open'),
    payment: String(
      source.displayFinancialStatus ?? source.financialStatus
        ?? source.payment_state ?? 'paid',
    ),
    fulfillment: String(
      source.displayFulfillmentStatus ?? source.fulfillment_state
        ?? 'fulfilled',
    ),
    returns: String(source.returnStatus ?? source.return_state ?? 'none'),
  },
  canonicalStates: {
    lifecycle: 'open', payment: 'paid', fulfillment: 'fulfilled', returns: 'none',
  },
  total: { state: 'unavailable' },
  lines: provider === 'shopify'
    ? (source.lineItems?.nodes || []).map((line) => ({
        identity: { value: String(line.id) },
        productIdentity: line.product?.id
          ? { state: 'available', value: { value: String(line.product.id) } }
          : { state: 'unavailable', value: null },
        variantIdentity: line.variant?.id
          ? { state: 'available', value: { value: String(line.variant.id) } }
          : { state: 'unavailable', value: null },
        sku: line.sku ?? null,
        orderedQuantity: line.quantity,
        currentQuantity: line.currentQuantity,
        unfulfilledQuantity: line.unfulfilledQuantity,
        fulfilledQuantity: line.currentQuantity - line.unfulfilledQuantity,
        returnedQuantity: null,
        requiresShipping: line.requiresShipping,
      }))
    : [],
  lineItemsTruncated: false,
})
const adapterHistoryRuntime = loadTypeScript(
  'app_src/lib/integrations/commerceOrderHistory.ts',
  history,
  {
    '@/lib/integrations/commerceReadRuntime': {
      commerceReadCredentialEligible: () => true,
    },
    '@/lib/integrations/commerceCapabilities': {
      hasEffectiveShopifyScope: (scopes, expected) => scopes.includes(expected),
    },
    '@/lib/integrations/commerceCredentialCrypto': {
      commerceProviderStaffEvidenceFingerprint: () => null,
      decryptCommerceCredential: () => adapterProvider === 'shopify'
        ? {
            provider: 'shopify', authMode: 'shopify_client_credentials',
            clientId: 'client', clientSecret: 'secret',
          }
        : {
            provider: 'faire', authMode: 'faire_brand_token',
            accessToken: 'token',
          },
    },
    '@/lib/integrations/faireCommerceClient': {
      getFaireOrder: async () => {
        if (faireAdapterFailureStage === 'detail') {
          throw new Error('Faire detail read failed')
        }
        return faireAdapterOrder
      },
      listFaireOrders: async () => ({
        orders: [faireAdapterOrder], has_more: false, next_cursor: null,
      }),
      probeFaireBrandProfile: async () => {
        if (faireAdapterFailureStage === 'probe') {
          throw new Error('Faire probe read failed')
        }
        return { id: 'brand-adapter' }
      },
    },
    '@/lib/integrations/faireCommerceNormalizer': {
      normalizeFaireCommerce: (value) => ({
        orders: value.orders.orders.map(
          (source) => normalizedAdapterOrder('faire', source),
        ),
        rejections: [],
      }),
    },
    '@/lib/integrations/shopifyCommerceClient': {
      normalizeShopifyShopDomain: (value) => value,
      requestShopifyAccessToken: async () => {
        if (shopifyAdapterFailureStage === 'token') {
          throw new Error('token read failed')
        }
        return {
          accessToken: 'access',
          grantedScopes: [
            'read_orders',
            ...(shopifyAdapterReadAllOrders ? ['read_all_orders'] : []),
            ...(shopifyAdapterReadReturns ? ['read_returns'] : []),
          ],
        }
      },
      probeShopifyConnection: async () => {
        if (shopifyAdapterFailureStage === 'probe') {
          throw new Error('probe read failed')
        }
        return {
          shopId: 'gid://shopify/Shop/adapter',
          grantedScopes: [
            'read_orders',
            ...(shopifyAdapterReadAllOrders ? ['read_all_orders'] : []),
            ...(shopifyAdapterReadReturns ? ['read_returns'] : []),
          ],
        }
      },
      shopifyAdminGraphql: async (_credential, request) => {
        if (request.operationName === 'ClawPilotShopifyOrderNativeActivity') {
          if (shopifyAdapterFailureStage === 'native') throw new Error('optional activity denied')
          return { order: { id: shopifyAdapterDetail.id, events: {
            nodes: shopifyAdapterNativeNodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          } } }
        }
        if (shopifyAdapterFailureStage === 'detail') {
          throw new Error('detail read failed')
        }
        return request.operationName === 'ClawPilotCommerceOrderHistoryIds'
          ? {
              orders: {
                nodes: [{
                  id: shopifyAdapterDetail.id,
                  createdAt: shopifyAdapterDetail.createdAt,
                  updatedAt: shopifyAdapterDetail.updatedAt,
                }],
                pageInfo: {
                  hasNextPage: Boolean(shopifyAdapterNextCursor),
                  endCursor: shopifyAdapterNextCursor,
                },
              },
            }
          : { order: shopifyAdapterDetail }
      },
    },
    '@/lib/integrations/shopifyCommerceNormalizer': {
      normalizeShopifyCommerce: (value) => ({
        orders: value.data.orders.nodes.map(
          (source) => normalizedAdapterOrder('shopify', source),
        ),
        rejections: [],
      }),
    },
    '@/lib/operations/commerceNormalization': {
      commerceMoneyFromDecimal: (amount, currency) => ({
        amountMinor: BigInt(Math.round(Number(amount) * 100)),
        currency,
      }),
      integerCommerceMinorUnits: (amount, currency) => ({
        amountMinor: BigInt(amount),
        currency,
      }),
    },
    '@/lib/persistence/commerceOrderSync': {
      CommerceOrderSyncError: class CommerceOrderSyncError extends Error {
        constructor(code, message, status = 409) {
          super(message)
          this.code = code
          this.status = status
        }
      },
    },
    '@/lib/persistence/commerceIntegrations': {
      readCommerceRuntimeCredentialFromPostgres: async () => ({
        organizationId: '00000000-0000-4000-8000-000000000001',
        integrationAccountId: '00000000-0000-4000-8000-000000000002',
        globalId: 'gia0000001',
        provider: adapterProvider,
        environment: 'production',
        externalAccountId: adapterProvider === 'shopify'
          ? 'gid://shopify/Shop/adapter' : 'brand-adapter',
        status: 'active', verificationStatus: 'verified', credentialVersion: 1,
        authMode: adapterProvider === 'shopify'
          ? 'shopify_client_credentials' : 'faire_brand_token',
        configuration: adapterProvider === 'shopify'
          ? { shopDomain: 'adapter.myshopify.com' }
          : { requestedScopes: ['READ_ORDERS'] },
        encrypted: {},
      }),
    },
    '@/lib/persistence/commerceStoreSync': {
      withCommerceStoreSyncProviderReadFenceInPostgres: (input) => input.read(),
    },
  },
)
const shopifyTrackingDetail = (trackingNumber, revision, status = 'SUCCESS') => ({
  ...validShopifyDetail,
  updatedAt: revision,
  fulfillments: [{
    id: 'gid://shopify/Fulfillment/adapter',
    createdAt: '2026-08-12T12:00:00.000Z',
    updatedAt: revision,
    status,
    trackingInfo: [{ company: 'UPS', number: trackingNumber, url: null }],
  }],
})
const readShopifyAdapter = async (detail, overrides = {}) => {
  adapterProvider = 'shopify'
  shopifyAdapterDetail = detail
  shopifyAdapterNextCursor = overrides.nextCursor ?? null
  shopifyAdapterReadReturns = overrides.readReturns ?? false
  shopifyAdapterReadAllOrders = overrides.readAllOrders ?? true
  return adapterHistoryRuntime.readCommerceOrderHistoryPage({
    organizationId: '00000000-0000-4000-8000-000000000001',
    accountGlobalId: 'gia0000001',
    expectedCredentialGeneration: 1,
    requestedFrom: overrides.requestedFrom
      ?? '2026-06-14T00:02:00.000Z',
    requestedThrough: overrides.requestedThrough
      ?? '2026-08-13T00:02:00.000Z',
    providerCursor: null,
    observedAt: overrides.observedAt ?? '2026-08-13T00:03:00.000Z',
    mode: overrides.mode ?? 'historical_backfill',
  })
}

shopifyAdapterDetail = validShopifyDetail
for (const [failureStage, expectedProviderReads] of [
  ['probe', 2],
  ['detail', 3],
]) {
  shopifyAdapterFailureStage = failureStage
  let exactReadError = null
  try {
    await adapterHistoryRuntime.readExactShopifyOrderHistoryObservation({
      organizationId: '00000000-0000-4000-8000-000000000001',
      accountGlobalId: 'gia0000001',
      expectedCredentialGeneration: 1,
      externalOrderId: validShopifyDetail.id,
      observedAt: '2026-08-13T00:03:00.000Z',
      observationKind: 'manual_exact_read',
    })
  } catch (error) {
    exactReadError = error
  }
  assert.ok(exactReadError, `${failureStage} failure must reject the exact read`)
  assert.equal(
    adapterHistoryRuntime.exactShopifyOrderHistoryProviderReads(exactReadError),
    expectedProviderReads,
    `${failureStage} failure must retain attempted provider-read volume`,
  )
}
shopifyAdapterFailureStage = null
shopifyAdapterNativeNodes = [{
  __typename: 'BasicEvent', id: 'gid://shopify/BasicEvent/99881',
  subjectId: validShopifyDetail.id, action: 'fulfillment_cancelled',
  createdAt: '2026-08-12T12:00:00.000Z',
  message: '<b>Fulfillment cancelled</b>', actor: 'Provider operator',
  attributeToUser: true, attributeToApp: false,
}]
const nativeAdapterRead = await readShopifyAdapter(validShopifyDetail)
assert.equal(nativeAdapterRead.providerReads, 5)
assert.equal(nativeAdapterRead.observations[0].nativeActivityState, 'complete')
assert.equal(nativeAdapterRead.observations[0].nativeActivityFetchedCount, 1)
const nativeEvent = nativeAdapterRead.observations[0].events.find((event) => event.eventKind === 'provider_activity')
assert.equal(nativeEvent.providerMessage, 'Fulfillment cancelled')
assert.equal(nativeEvent.providerActorDisplayName, 'Provider operator')
assert.equal(nativeEvent.attributionSource, 'unavailable', 'display names are not authenticated staff IDs')
shopifyAdapterNativeNodes = [{ ...shopifyAdapterNativeNodes[0], message: 'Edited provider text',
  actor: 'Renamed operator', action: 'fulfillment_updated', attributeToUser: false, attributeToApp: true }]
const nativeEditedRead = await readShopifyAdapter(validShopifyDetail)
assert.equal(nativeEditedRead.observations[0].sourceHash, nativeAdapterRead.observations[0].sourceHash,
  'mutable sensitive text, action and attribution never change the permanent source hash')
const nativeInitialNormalized = persistenceRuntime.normalizeCommerceOrderObservationInput(nativeAdapterRead.observations[0])
const nativeEditedNormalized = persistenceRuntime.normalizeCommerceOrderObservationInput(nativeEditedRead.observations[0])
assert.equal(nativeInitialNormalized.events.find((event) => event.eventKind === 'provider_activity').eventHash,
  nativeEditedNormalized.events.find((event) => event.eventKind === 'provider_activity').eventHash,
  'one provider event retains one stable identity across content/action/attribution changes')
const nativeExact = await adapterHistoryRuntime.readExactShopifyOrderHistoryObservation({
  organizationId: '00000000-0000-4000-8000-000000000001', accountGlobalId: 'gia0000001',
  expectedCredentialGeneration: 1, externalOrderId: validShopifyDetail.id,
  observedAt: '2026-08-13T00:03:00.000Z', observationKind: 'manual_exact_read',
})
assert.equal(nativeExact.providerReads, 4)
assert.equal(nativeExact.observation.providerReadCount, 4)
shopifyAdapterFailureStage = 'native'
const nativeDenied = await readShopifyAdapter(validShopifyDetail)
assert.equal(nativeDenied.observations.length, 1, 'optional timeline denial cannot fail core order import')
assert.equal(nativeDenied.observations[0].nativeActivityState, 'unavailable')
assert.equal(nativeDenied.providerReads, 5, 'failed optional page attempts are counted')
shopifyAdapterFailureStage = null
shopifyAdapterNativeNodes = []
const shopifyAdapterOne = await readShopifyAdapter(
  shopifyTrackingDetail('1Z-ADAPTER-ONE', '2026-08-13T00:00:00.000Z'),
)
const shopifyAdapterSameRevision = await readShopifyAdapter(
  shopifyTrackingDetail('1Z-ADAPTER-TWO', '2026-08-13T00:00:00.000Z'),
)
const shopifyAdapterAdvanced = await readShopifyAdapter(
  shopifyTrackingDetail('1Z-ADAPTER-TWO', '2026-08-13T00:01:00.000Z', 'OPEN'),
)
const shopifyAdapterTrackingCleared = await readShopifyAdapter({
  ...shopifyTrackingDetail(
    'unused',
    '2026-08-13T00:02:00.000Z',
    'SUCCESS',
  ),
  fulfillments: [{
    ...shopifyTrackingDetail(
      'unused',
      '2026-08-13T00:02:00.000Z',
    ).fulfillments[0],
    trackingInfo: [],
  }],
})
const normalizedShopifyAdapterOne = persistenceRuntime
  .normalizeCommerceOrderObservationInput(shopifyAdapterOne.observations[0])
const normalizedShopifyAdapterSame = persistenceRuntime
  .normalizeCommerceOrderObservationInput(
    shopifyAdapterSameRevision.observations[0],
  )
const normalizedShopifyAdapterAdvanced = persistenceRuntime
  .normalizeCommerceOrderObservationInput(shopifyAdapterAdvanced.observations[0])
assert.equal(
  normalizedShopifyAdapterOne.sourceHash,
  normalizedShopifyAdapterSame.sourceHash,
)
assert.equal(
  normalizedShopifyAdapterOne.events.find((event) => event.trackingNumber)
    .eventHash,
  normalizedShopifyAdapterSame.events.find((event) => event.trackingNumber)
    .eventHash,
)
assert.notEqual(
  normalizedShopifyAdapterOne.sourceHash,
  normalizedShopifyAdapterAdvanced.sourceHash,
)
const shopifyClearedTrackingEvents = shopifyAdapterTrackingCleared
  .observations[0].events.filter((event) => event.eventKind === 'tracking_updated')
assert.equal(shopifyClearedTrackingEvents.length, 1)
assert.equal(shopifyClearedTrackingEvents[0].trackingNumber, undefined)
assert.notEqual(
  normalizedShopifyAdapterOne.events.find((event) => event.trackingNumber)
    .eventHash,
  normalizedShopifyAdapterAdvanced.events.find((event) => event.trackingNumber)
    .eventHash,
)
for (const creationKind of ['order_created', 'fulfillment_created']) {
  const initial = shopifyAdapterOne.observations[0].events.find(
    (event) => event.eventKind === creationKind,
  )
  const later = shopifyAdapterAdvanced.observations[0].events.find(
    (event) => event.eventKind === creationKind,
  )
  assert.deepEqual(initial, later)
  assert.equal(initial.eventStatus, undefined)
  assert.equal(initial.quantity, undefined)
}
for (const exact of ['1Z-ADAPTER-ONE', '1Z-ADAPTER-TWO']) {
  assert.equal(JSON.stringify({
    sourceHash: normalizedShopifyAdapterAdvanced.sourceHash,
    externalEventId: normalizedShopifyAdapterAdvanced.events.map(
      (event) => event.externalEventId,
    ),
    eventHashes: normalizedShopifyAdapterAdvanced.events.map(
      (event) => event.eventHash,
    ),
  }).includes(exact), false)
}
const racedShopifyPage = await readShopifyAdapter(
  shopifyTrackingDetail('1Z-RACE', '2026-08-13T00:01:00.000Z'),
  {
    mode: 'continuous_poll',
    requestedFrom: '2026-08-12T23:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    nextCursor: 'shopify-race-next',
  },
)
assert.equal(racedShopifyPage.observations.length, 0)
assert.equal(racedShopifyPage.providerRowsSeen, 1)
assert.equal(racedShopifyPage.nextProviderCursor, 'shopify-race-next')
const overlappedShopifyPage = await readShopifyAdapter(
  shopifyTrackingDetail('1Z-RACE', '2026-08-13T00:01:00.000Z'),
  {
    mode: 'continuous_poll',
    requestedFrom: '2026-08-12T23:59:00.000Z',
    requestedThrough: '2026-08-13T00:02:00.000Z',
  },
)
assert.equal(overlappedShopifyPage.observations.length, 1)
const expiredShopifyStandardScopePage = await readShopifyAdapter(
  shopifyTrackingDetail('1Z-EXPIRED', '2026-05-01T00:00:00.000Z'),
  {
    readAllOrders: false,
    requestedFrom: '2026-04-01T00:00:00.000Z',
    requestedThrough: '2026-05-01T00:00:00.000Z',
    observedAt: '2026-08-14T00:00:00.000Z',
  },
)
assert.equal(expiredShopifyStandardScopePage.observations.length, 0)
assert.equal(expiredShopifyStandardScopePage.providerRowsSeen, 0)
assert.equal(expiredShopifyStandardScopePage.nextProviderCursor, null)
assert.equal(expiredShopifyStandardScopePage.providerReads, 2)
assert.equal(expiredShopifyStandardScopePage.readAllOrdersScopeObserved, false)

const shopifyLifecycleDetail = (
  revision,
  paymentStatus,
  returnStatus,
  refundAmount,
) => ({
  ...shopifyTrackingDetail('1Z-LIFECYCLE', revision),
  displayFinancialStatus: paymentStatus,
  returnStatus,
  refunds: [{
    id: 'gid://shopify/Refund/history-adapter',
    createdAt: '2026-08-12T18:00:00.000Z',
    processedAt: '2026-08-12T18:01:00.000Z',
    updatedAt: revision,
    totalRefundedSet: {
      shopMoney: { amount: refundAmount, currencyCode: 'USD' },
    },
    refundLineItems: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }],
})
const shopifyLifecycleOne = await readShopifyAdapter(
  shopifyLifecycleDetail(
    '2026-08-13T00:00:00.000Z',
    'PAID',
    'RETURN_REQUESTED',
    '2.50',
  ),
)
const shopifyLifecycleTwo = await readShopifyAdapter(
  shopifyLifecycleDetail(
    '2026-08-13T00:01:00.000Z',
    'REFUNDED',
    'RETURNED',
    '5.00',
  ),
)
const shopifyLifecycleEventsOne = shopifyLifecycleOne.observations[0].events
const shopifyLifecycleEventsTwo = shopifyLifecycleTwo.observations[0].events
assert.deepEqual(
  JSON.parse(JSON.stringify(shopifyLifecycleEventsOne.find(
    (event) => event.eventKind === 'refund_created',
  ))),
  JSON.parse(JSON.stringify(shopifyLifecycleEventsTwo.find(
    (event) => event.eventKind === 'refund_created',
  ))),
)
assert.deepEqual(
  JSON.parse(JSON.stringify(shopifyLifecycleEventsOne.find(
    (event) => event.eventKind === 'refund_created',
  ))),
  {
    externalEventId: 'gid://shopify/Refund/history-adapter:created',
    externalSubjectId: 'gid://shopify/Refund/history-adapter',
    eventKind: 'refund_created',
    inventoryEffectKind: 'unknown',
    attributionSource: 'unavailable',
    occurredAt: '2026-08-12T18:00:00.000Z',
  },
)
for (const [events, revision, payment, returns, amount] of [
  [shopifyLifecycleEventsOne, '2026-08-13T00:00:00.000Z',
    'PAID', 'RETURN_REQUESTED', 250],
  [shopifyLifecycleEventsTwo, '2026-08-13T00:01:00.000Z',
    'REFUNDED', 'RETURNED', 500],
]) {
  const paymentEvent = events.find((event) => event.eventKind === 'payment_updated')
  const parentTimestampedReturnEvent = events.find((event) => (
    event.eventKind === 'return_updated'
      && event.externalSubjectId === 'gid://shopify/Order/1'
  ))
  const refundEvent = events.find((event) => event.eventKind === 'refund_updated')
  assert.equal(paymentEvent.occurredAt, revision)
  assert.equal(paymentEvent.eventStatus, payment)
  assert.equal(parentTimestampedReturnEvent, undefined)
  assert.equal(
    events.some((event) => (
      event.eventKind === 'return_updated'
        && event.eventStatus === returns
    )),
    false,
    'Shopify current Return state must not be backdated to Order.updatedAt',
  )
  assert.equal(refundEvent.occurredAt, revision)
  assert.equal(refundEvent.amountMinor, amount)
}

const exactShopifyLineAdjustment = await readShopifyAdapter({
  ...shopifyTrackingDetail(
    '1Z-LINE-ADJUSTMENT',
    '2026-08-13T00:02:00.000Z',
  ),
  returnStatus: 'RETURNED',
  lineItems: {
    ...validShopifyDetail.lineItems,
    nodes: [{
      ...validShopifyDetail.lineItems.nodes[0],
      currentQuantity: 0,
      unfulfilledQuantity: 0,
    }],
  },
  refunds: [{
    id: 'gid://shopify/Refund/line-adjustment',
    createdAt: '2026-08-12T21:00:00.000Z',
    processedAt: '2026-08-12T21:01:00.000Z',
    updatedAt: '2026-08-13T00:02:00.000Z',
    totalRefundedSet: {
      shopMoney: { amount: '10.00', currencyCode: 'USD' },
    },
    refundLineItems: {
      nodes: [{
        quantity: 1,
        restockType: 'RETURN',
        lineItem: { id: 'gid://shopify/LineItem/1' },
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }],
  returns: {
    nodes: [{
      id: 'gid://shopify/Return/line-adjustment',
      name: '#return-line-adjustment',
      status: 'CLOSED',
      createdAt: '2026-08-12T20:00:00.000Z',
      requestApprovedAt: '2026-08-12T20:01:00.000Z',
      closedAt: '2026-08-13T00:01:00.000Z',
      totalQuantity: 1,
      returnLineItems: {
        nodes: [{
          __typename: 'ReturnLineItem',
          id: 'gid://shopify/ReturnLineItem/line-adjustment',
          quantity: 1,
          processedQuantity: 1,
          refundedQuantity: 1,
          fulfillmentLineItem: {
            lineItem: { id: 'gid://shopify/LineItem/1' },
          },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
}, { readReturns: true })
assert.equal(
  exactShopifyLineAdjustment.observations[0].lines[0].returnedQuantity,
  1,
  'a Shopify return and its refund must persist one exact returned unit, not two stale or duplicated units',
)

const shopifyReturnSnapshot = ({
  status,
  approvedAt = null,
  closedAt = null,
}) => ({
  ...shopifyTrackingDetail('1Z-RETURN-MILESTONE', '2026-08-13T00:00:00.000Z'),
  returnStatus: status,
  returns: {
    nodes: [{
      id: 'gid://shopify/Return/history-adapter',
      name: '#return-history-adapter',
      status,
      createdAt: '2026-08-12T20:00:00.000Z',
      requestApprovedAt: approvedAt,
      closedAt,
      totalQuantity: 1,
      returnLineItems: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
})
const shopifyReturnRequested = await readShopifyAdapter(
  shopifyReturnSnapshot({ status: 'REQUESTED' }),
  { readReturns: true },
)
const shopifyReturnApproved = await readShopifyAdapter(
  shopifyReturnSnapshot({
    status: 'OPEN',
    approvedAt: '2026-08-13T00:00:30.000Z',
  }),
  { readReturns: true },
)
const shopifyReturnChangedWithoutMilestone = await readShopifyAdapter(
  {
    ...shopifyReturnSnapshot({ status: 'REQUESTED' }),
    returns: {
      ...shopifyReturnSnapshot({ status: 'REQUESTED' }).returns,
      nodes: [{
        ...shopifyReturnSnapshot({ status: 'REQUESTED' }).returns.nodes[0],
        status: 'DECLINED',
        totalQuantity: 2,
      }],
    },
  },
  { readReturns: true },
)
const requestedReturnEvents = shopifyReturnRequested.observations[0].events
const approvedReturnEvents = shopifyReturnApproved.observations[0].events
const changedReturnEvents = shopifyReturnChangedWithoutMilestone
  .observations[0].events
assert.deepEqual(
  requestedReturnEvents.find((event) => event.eventKind === 'return_created'),
  approvedReturnEvents.find((event) => event.eventKind === 'return_created'),
)
assert.equal(
  requestedReturnEvents.some((event) => event.eventKind === 'return_updated'),
  false,
)
assert.deepEqual(
  JSON.parse(JSON.stringify(requestedReturnEvents.find(
    (event) => event.eventKind === 'return_state_observed',
  ))), {
    ...JSON.parse(JSON.stringify(requestedReturnEvents.find(
      (event) => event.eventKind === 'return_state_observed',
    ))),
    externalSubjectId: 'gid://shopify/Return/history-adapter',
    eventKind: 'return_state_observed',
    eventStatus: 'REQUESTED',
    quantity: 1,
    inventoryEffectKind: 'unknown',
    attributionSource: 'provider_system',
    occurredAt: '2026-08-13T00:03:00.000Z',
  },
)
assert.match(
  requestedReturnEvents.find(
    (event) => event.eventKind === 'return_state_observed',
  ).externalEventId,
  /^gid:\/\/shopify\/Return\/history-adapter:state-observed:[a-f0-9]{24}$/u,
)
assert.deepEqual(
  JSON.parse(JSON.stringify(approvedReturnEvents.find(
    (event) => event.eventKind === 'return_updated',
  ))),
  {
    externalEventId:
      'gid://shopify/Return/history-adapter:approved:'
      + '2026-08-13T00:00:30.000Z',
    externalSubjectId: 'gid://shopify/Return/history-adapter',
    eventKind: 'return_updated',
    eventStatus: 'approved',
    inventoryEffectKind: 'unknown',
    attributionSource: 'unavailable',
    occurredAt: '2026-08-13T00:00:30.000Z',
  },
)
assert.equal(
  shopifyReturnRequested.observations[0].providerUpdatedAt,
  shopifyReturnApproved.observations[0].providerUpdatedAt,
  'Return milestones must not depend on a parent Order.updatedAt change',
)
assert.notEqual(
  persistenceRuntime.normalizeCommerceOrderObservationInput(
    shopifyReturnRequested.observations[0],
  ).sourceHash,
  persistenceRuntime.normalizeCommerceOrderObservationInput(
    shopifyReturnApproved.observations[0],
  ).sourceHash,
)
const requestedReturnHash = persistenceRuntime
  .normalizeCommerceOrderObservationInput(
    shopifyReturnRequested.observations[0],
  ).sourceHash
const changedReturnHash = persistenceRuntime
  .normalizeCommerceOrderObservationInput(
    shopifyReturnChangedWithoutMilestone.observations[0],
  ).sourceHash
assert.notEqual(requestedReturnHash, changedReturnHash)
assert.deepEqual(
  changedReturnEvents.find(
    (event) => event.eventKind === 'return_state_observed',
  ).eventStatus,
  'DECLINED',
)
assert.equal(
  changedReturnEvents.find(
    (event) => event.eventKind === 'return_state_observed',
  ).quantity,
  2,
)

const faireTrackingOrder = (trackingNumber, revision, status = 'SHIPPED') => ({
  ...faireOrder,
  updated_at: revision,
  status,
  shipments: [{
    id: 'faire-shipment-adapter',
    created_at: '2026-08-12T12:00:00.000Z',
    updated_at: revision,
    status,
    carrier: 'UPS',
    tracking_number: trackingNumber,
  }],
})
const readFaireAdapter = async (source) => {
  adapterProvider = 'faire'
  faireAdapterOrder = source
  return adapterHistoryRuntime.readCommerceOrderHistoryPage({
    organizationId: '00000000-0000-4000-8000-000000000001',
    accountGlobalId: 'gia0000001',
    expectedCredentialGeneration: 1,
    requestedFrom: null,
    requestedThrough: '2026-08-13T00:02:00.000Z',
    providerCursor: null,
    observedAt: '2026-08-13T00:03:00.000Z',
    mode: 'historical_backfill',
  })
}
const faireAdapterOne = await readFaireAdapter(
  faireTrackingOrder('FAIRE-TRACK-ONE', '2026-08-13T00:00:00.000Z'),
)
const faireAdapterSame = await readFaireAdapter(
  faireTrackingOrder('FAIRE-TRACK-TWO', '2026-08-13T00:00:00.000Z'),
)
const faireAdapterAdvanced = await readFaireAdapter(
  faireTrackingOrder('FAIRE-TRACK-TWO', '2026-08-13T00:01:00.000Z', 'DELIVERED'),
)
const faireAdapterTrackingCleared = await readFaireAdapter({
  ...faireTrackingOrder(
    'unused',
    '2026-08-13T00:02:00.000Z',
    'DELIVERED',
  ),
  shipments: [{
    id: 'faire-shipment-adapter',
    created_at: '2026-08-12T12:00:00.000Z',
    updated_at: '2026-08-13T00:02:00.000Z',
    status: 'DELIVERED',
    carrier: 'UPS',
  }],
})
adapterProvider = 'faire'
faireAdapterOrder = faireTrackingOrder(
  'FAIRE-EXACT-TRACKING',
  '2026-08-13T00:02:00.000Z',
  'DELIVERED',
)
const exactFaireRead = await adapterHistoryRuntime
  .readExactFaireOrderHistoryObservation({
    organizationId: '00000000-0000-4000-8000-000000000001',
    accountGlobalId: 'gia0000001',
    expectedCredentialGeneration: 1,
    externalOrderId: faireAdapterOrder.id,
    observedAt: '2026-08-13T00:03:00.000Z',
    observationKind: 'manual_exact_read',
  })
assert.equal(exactFaireRead.provider, 'faire')
assert.equal(exactFaireRead.providerReads, 2)
assert.equal(exactFaireRead.providerWrites, 0)
assert.equal(exactFaireRead.observation.providerReadCount, 2)
assert.equal(
  exactFaireRead.observation.events.find(
    (event) => event.eventKind === 'tracking_updated'
      && event.trackingNumber,
  )?.trackingNumber,
  'FAIRE-EXACT-TRACKING',
  'an exact Faire refresh must retain current embedded shipment tracking',
)
for (const [failureStage, expectedProviderReads] of [
  ['probe', 1],
  ['detail', 2],
]) {
  faireAdapterFailureStage = failureStage
  let exactReadError = null
  try {
    await adapterHistoryRuntime.readExactFaireOrderHistoryObservation({
      organizationId: '00000000-0000-4000-8000-000000000001',
      accountGlobalId: 'gia0000001',
      expectedCredentialGeneration: 1,
      externalOrderId: faireAdapterOrder.id,
      observedAt: '2026-08-13T00:03:00.000Z',
      observationKind: 'manual_exact_read',
    })
  } catch (error) {
    exactReadError = error
  }
  assert.ok(exactReadError, `${failureStage} must reject the exact Faire read`)
  assert.equal(
    adapterHistoryRuntime.exactFaireOrderHistoryProviderReads(exactReadError),
    expectedProviderReads,
    `${failureStage} must retain attempted Faire provider-read volume`,
  )
}
faireAdapterFailureStage = null
const normalizedFaireOne = persistenceRuntime
  .normalizeCommerceOrderObservationInput(faireAdapterOne.observations[0])
const normalizedFaireSame = persistenceRuntime
  .normalizeCommerceOrderObservationInput(faireAdapterSame.observations[0])
const normalizedFaireAdvanced = persistenceRuntime
  .normalizeCommerceOrderObservationInput(faireAdapterAdvanced.observations[0])
assert.equal(normalizedFaireOne.sourceHash, normalizedFaireSame.sourceHash)
assert.equal(
  normalizedFaireOne.events.find((event) => event.trackingNumber).eventHash,
  normalizedFaireSame.events.find((event) => event.trackingNumber).eventHash,
)
assert.notEqual(normalizedFaireOne.sourceHash, normalizedFaireAdvanced.sourceHash)
assert.notEqual(
  normalizedFaireOne.events.find((event) => event.trackingNumber).eventHash,
  normalizedFaireAdvanced.events.find((event) => event.trackingNumber).eventHash,
)
const faireClearedTrackingEvents = faireAdapterTrackingCleared
  .observations[0].events.filter((event) => event.eventKind === 'tracking_updated')
assert.equal(faireClearedTrackingEvents.length, 1)
assert.equal(faireClearedTrackingEvents[0].trackingNumber, undefined)

const faireLifecycleOrder = (
  revision,
  paymentStatus,
  returnStatus,
  refundAmount,
) => ({
  ...faireTrackingOrder('FAIRE-LIFECYCLE', revision),
  payment_state: paymentStatus,
  return_state: returnStatus,
  refunds: [{
    id: 'faire-refund-history-adapter',
    created_at: '2026-08-12T18:00:00.000Z',
    processed_at: '2026-08-12T18:01:00.000Z',
    updated_at: revision,
    status: paymentStatus,
    amount_cents: refundAmount,
    currency: 'USD',
  }],
})
const faireLifecycleOne = await readFaireAdapter(
  faireLifecycleOrder(
    '2026-08-13T00:00:00.000Z',
    'PAID',
    'REQUESTED',
    250,
  ),
)
const faireLifecycleTwo = await readFaireAdapter(
  faireLifecycleOrder(
    '2026-08-13T00:01:00.000Z',
    'REFUNDED',
    'RETURNED',
    500,
  ),
)
const faireLifecycleEventsOne = faireLifecycleOne.observations[0].events
const faireLifecycleEventsTwo = faireLifecycleTwo.observations[0].events
assert.deepEqual(
  faireLifecycleEventsOne.find((event) => event.eventKind === 'refund_created'),
  faireLifecycleEventsTwo.find((event) => event.eventKind === 'refund_created'),
)
for (const [events, revision, payment, returns, amount] of [
  [faireLifecycleEventsOne, '2026-08-13T00:00:00.000Z',
    'PAID', 'REQUESTED', 250],
  [faireLifecycleEventsTwo, '2026-08-13T00:01:00.000Z',
    'REFUNDED', 'RETURNED', 500],
]) {
  const paymentEvent = events.find((event) => event.eventKind === 'payment_updated')
  const returnEvent = events.find((event) => (
    event.eventKind === 'return_updated'
      && event.externalSubjectId === 'bo_order_1'
  ))
  const refundEvent = events.find((event) => event.eventKind === 'refund_updated')
  assert.equal(paymentEvent.occurredAt, revision)
  assert.equal(paymentEvent.eventStatus, payment)
  assert.equal(returnEvent.occurredAt, revision)
  assert.equal(returnEvent.eventStatus, returns)
  assert.equal(refundEvent.occurredAt, revision)
  assert.equal(refundEvent.amountMinor, amount)
}
for (const creationKind of ['order_created', 'shipment_created']) {
  const initial = faireAdapterOne.observations[0].events.find(
    (event) => event.eventKind === creationKind,
  )
  const later = faireAdapterAdvanced.observations[0].events.find(
    (event) => event.eventKind === creationKind,
  )
  assert.deepEqual(initial, later)
  assert.equal(initial.eventStatus, undefined)
  assert.equal(initial.quantity, undefined)
}
for (const exact of ['FAIRE-TRACK-ONE', 'FAIRE-TRACK-TWO']) {
  assert.equal(JSON.stringify({
    sourceHash: normalizedFaireAdvanced.sourceHash,
    externalEventId: normalizedFaireAdvanced.events.map(
      (event) => event.externalEventId,
    ),
    eventHashes: normalizedFaireAdvanced.events.map(
      (event) => event.eventHash,
    ),
  }).includes(exact), false)
}
await assert.rejects(
  readFaireAdapter({
    ...faireTrackingOrder('FAIRE-NO-REVISION', '2026-08-13T00:01:00.000Z'),
    shipments: [{
      id: 'faire-shipment-no-revision',
      created_at: '2026-08-12T12:00:00.000Z',
      tracking_number: 'FAIRE-NO-REVISION',
    }],
  }),
  /tracking-bearing fulfillment update time/u,
)
assert.notEqual(
  fingerprint,
  historyRuntime.commerceProviderStaffFingerprint({
    ...fingerprintContext,
    accountGlobalId: 'gia0000002',
  }),
)
assert.notEqual(
  fingerprint,
  historyRuntime.commerceProviderStaffFingerprint({
    ...fingerprintContext,
    provider: 'faire',
  }),
)

for (const [name, value] of previousEnvironment) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

assert.match(processRoute, /processCommerceOrderHistory/u)
assert.match(processRoute, /orderHistory/u)
const workerCalls = []
const baseJob = {
  id: '11111111-1111-4111-8111-111111111111',
  globalId: 'gcob0000001',
  organizationId: fingerprintContext.organizationId,
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  accountGlobalId: fingerprintContext.accountGlobalId,
  provider: 'shopify',
  sessionKind: 'historical_backfill',
  credentialGeneration: 1,
  policyRevision: 1,
  requestedFrom: '2026-06-14T00:00:00.000Z',
  requestedThrough: '2026-08-13T00:00:00.000Z',
  queryHash: 'b'.repeat(64),
  pageCount: 8,
  attemptCount: 1,
  maxAttempts: 8,
  maxPages: 10000,
  lockToken: '33333333-3333-4333-8333-333333333333',
}
const workerRuntime = loadTypeScript(
  'app_src/lib/commerceOrderHistoryWorker.ts',
  worker,
  {
    '@/lib/integrations/integrationCredentialRuntimeGate.mjs':
      integrationCredentialRuntimeGate,
    '@/lib/integrations/commerceOrderHistory': {
      async readCommerceOrderHistoryPage(input) {
        workerCalls.push(['read', input.providerCursor])
        return {
          provider: 'shopify',
          observations: [],
          nextProviderCursor: null,
          providerRowsSeen: 0,
          providerReads: 3,
          providerWrites: 0,
          readAllOrdersScopeObserved: true,
          returnHistoryScopeObserved: false,
        }
      },
    },
    '@/lib/persistence/commerceOrderSync': {
      async redactExpiredCommerceOrderSensitiveEvidenceInPostgres() {
        return { redacted: 0, providerWrites: 0 }
      },
      async materializeDeferredCommerceOrderHistoryRefreshesInPostgres() {
        return { materialized: 0, skipped: 0, providerWrites: 0 }
      },
      async ensureContinuousCommerceOrderPollsInPostgres() {
        return { scheduled: 1, providerWrites: 0 }
      },
      async claimCommerceOrderBackfillsInPostgres() {
        return [baseJob]
      },
      async readCommerceOrderBackfillCursorFromPostgres() {
        return 'never-return-this-raw-cursor'
      },
      async appendCommerceOrderBackfillPageInPostgres(input) {
        workerCalls.push(['append', input.pageNumber])
        return { status: 'succeeded', appended: 0, preserved: 0 }
      },
      async failCommerceOrderBackfillInPostgres() {
        assert.fail('successful page must not enter failure persistence')
      },
      async readCommerceOrderSyncHealthFromPostgres() {
        return { failed: 0, providerWrites: 0 }
      },
      async readCommerceOrderSyncCursorKeyReadinessFromPostgres() {
        return { ready: true, referencedKeyIds: [] }
      },
    },
    '@/lib/persistence/commerceStoreSync': {
      withCommerceStoreSyncProviderReadFenceInPostgres: (input) => input.read(),
    },
  },
)
const workerResult = await workerRuntime.processCommerceOrderHistory({
  workerId: 'foundation-worker',
  limit: 1,
})
assert.equal(workerResult.claimed, 1)
assert.equal(workerResult.succeeded, 1)
assert.equal(workerResult.operationsOrderWrites, 0)
assert.equal(workerResult.providerWrites, 0)
assert.doesNotMatch(JSON.stringify(workerResult), /never-return-this-raw-cursor/u)
assert.deepEqual(workerCalls, [
  ['read', 'never-return-this-raw-cursor'],
  ['append', 9],
])

console.log('Commerce order sync foundation contract checks passed')
