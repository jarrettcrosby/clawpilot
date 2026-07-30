#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} is missing ${startMarker}`)
  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : source.length
  assert.notEqual(end, -1, `${label} is missing ${endMarker}`)
  return source.slice(start, end)
}

function loadPersistence() {
  const path = 'app_src/lib/persistence/shopifyCheckoutRating.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
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
        return { recordAuditEvent: async () => {} }
      }
      if (specifier === '@/lib/persistence/postgres') {
        return {
          acquireTransactionAdvisoryLock: async () => {},
          query: async () => {
            throw new Error('database must not be reached by pure tests')
          },
          withTransaction: async () => {
            throw new Error('database must not be reached by pure tests')
          },
        }
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0149_operations_shopify_checkout_rating.sql',
)
const receiptReuseMigration = read(
  'db/migrations/0157_operations_shopify_checkout_receipt_reuse.sql',
)
const packHardeningMigration = read(
  'db/migrations/0151_operations_product_pack_management_hardening.sql',
)
const offerParcelEvidenceMigration = read(
  'db/migrations/0164_shopify_checkout_offer_parcel_evidence.sql',
)
const persistenceSource = read(
  'app_src/lib/persistence/shopifyCheckoutRating.ts',
)
const commerceIntakeSource = read(
  'app_src/lib/persistence/commerceIntake.ts',
)
const operationsSource = read(
  'app_src/lib/persistence/operations.ts',
)
const persistence = loadPersistence()

includes(migration, [
  'rated_outer_length_mm integer',
  'rated_outer_width_mm integer',
  'rated_outer_height_mm integer',
  'operations_packaging_materials_rated_outer_evidence_valid',
  'rated_outer_dimension_evidence_type IN (',
  'rated_outer_dimension_evidence_reference',
  'rated_outer_dimension_confirmed_at IS NOT NULL',
], 'Rated outside dimensions')
includes(packHardeningMigration, [
  "planning_method IN ('approved_recipe', 'self_package')",
  'op_shopify_rate_packages_profile_version_valid',
  'pack_profile_version_id IS NOT NULL',
  'self_package_line_key',
  'profile.package_level = \'case\'',
  'NEW.quantity <> 1',
  'Shopify checkout self-package receipt evidence is incomplete',
], 'Self-package checkout receipt hardening')
includes(offerParcelEvidenceMigration, [
  'operations_shopify_checkout_carrier_request_parcel_snapshot',
  "WHEN 'self_package'",
  "'ClawPilot sealed case '",
  "WHEN 'approved_recipe'",
  "'ClawPilot carton '",
  "'dimensionUnit', 'IN'",
  "'weightUnit', 'LB'",
  'operations_shopify_checkout_carrier_parcels_match',
  "jsonb_typeof(provider_parcels) = 'array'",
  'package.planning_method',
  'ORDER BY package.package_sequence, package.package_key',
  'protect_operations_shopify_checkout_rate_receipt_offer',
  "rate_evidence.redacted_request #> '{shipment,parcels}'",
  'operations_shopify_checkout_carrier_rate_matches',
], 'Checkout offer carrier parcel evidence')
assert.doesNotMatch(
  offerParcelEvidenceMigration,
  /package\.carrier_parcel_snapshot/,
  'Provider parcel evidence must not compare against the internal package-key snapshot',
)

const configSchema = section(
  migration,
  'CREATE TABLE IF NOT EXISTS operations_shopify_carrier_service_configs',
  'CREATE TABLE IF NOT EXISTS operations_shopify_checkout_rate_receipts',
  'Shopify CarrierService configuration',
)
includes(configSchema, [
  "registration_state IN (",
  "'unconfigured'",
  "'shadow_simulated'",
  "'registered'",
  "'disabled'",
  "'error'",
  'credential_generation integer NOT NULL',
  'activation_revision integer NOT NULL',
  'callback_token_version integer NOT NULL',
  'callback_token_hash text NOT NULL',
  'policy_revision bigint NOT NULL',
  'policy_hash text NOT NULL',
  'policy_snapshot jsonb NOT NULL',
  'inventory_max_age_seconds integer NOT NULL',
  'quote_ttl_seconds integer NOT NULL',
  'quote_ttl_seconds <= inventory_max_age_seconds',
  'order_reconciliation_window_seconds integer NOT NULL',
  'algorithm_version text NOT NULL',
  'row_version bigint NOT NULL',
  'operations_shopify_carrier_service_config_materials',
  'selection_sequence BETWEEN 1 AND 8',
  'packaging_material_row_version bigint NOT NULL',
  'operations_shopify_carrier_service_config_carriers',
  "carrier_provider IN ('ups_rest', 'fedex_rest')",
  'operations_shopify_carrier_service_config_is_ready',
  'material.row_version',
  '= selected.packaging_material_row_version',
  'material.rated_outer_length_mm > 0',
  'stock.is_available = true',
  'stock.on_hand_quantity > 0',
  "selected.carrier_provider = 'ups_rest'",
  "selected.carrier_provider = 'fedex_rest'",
  "credential.verification_status = 'verified'",
  "account.environment = 'sandbox'",
  "carrier_integration.environment = 'sandbox'",
  'activation.revision = config.activation_revision',
  "activation.state = 'active'",
  "activation.state = 'shadow'",
  "config.registration_state = 'shadow_simulated'",
  "activation.state = 'shadow'",
  'Registering a Shopify CarrierService requires Active Operations',
], 'Shopify CarrierService configuration')

const receiptSchema = section(
  migration,
  'CREATE TABLE IF NOT EXISTS operations_shopify_checkout_rate_receipts',
  'COMMENT ON TABLE operations_shopify_carrier_service_configs',
  'Checkout receipt schema',
)
includes(receiptSchema, [
  'operations_shopify_checkout_json_is_customer_neutral',
  'request_fingerprint text NOT NULL',
  'destination_fingerprint text NOT NULL',
  'carrier_destination_fingerprint text NOT NULL',
  'line_quantity_fingerprint text NOT NULL',
  'request_evidence_hash text NOT NULL',
  'reconciliation_window_seconds integer NOT NULL',
  'reconciliation_deadline_at timestamptz NOT NULL',
  'operations_shopify_checkout_receipt_line_quantity_fingerprint',
  'operations_shopify_checkout_order_line_quantity_fingerprint',
  'inventory_snapshot_hash text NOT NULL',
  "activation_state IN ('shadow', 'active')",
  'redacted_request_snapshot jsonb NOT NULL',
  'provider_write_count integer NOT NULL DEFAULT 0',
  'CHECK (\n    provider_write_count = 0',
  'operations_shopify_checkout_rate_receipts_idempotency_unique',
  'operations_shopify_checkout_rate_receipts_processing_unique',
  'config_row_version',
  'inventory_snapshot_hash',
  'operations_shopify_checkout_rate_receipt_lines',
  'operations_shopify_checkout_rate_receipt_packages',
  'packaging_material_stock_id uuid NOT NULL',
  'packaging_material_stock_row_version bigint NOT NULL',
  'packaging_material_stock_on_hand_quantity integer NOT NULL',
  'op_shopify_rate_packages_material_stock_fkey',
  'stock.id = NEW.packaging_material_stock_id',
  'stock.row_version',
  '= NEW.packaging_material_stock_row_version',
  'stock.on_hand_quantity',
  '= NEW.packaging_material_stock_on_hand_quantity',
  'package_stock_mismatch_count <> 0',
  'operations_shopify_checkout_carrier_parcel_snapshot',
  'carrier_parcel_snapshot jsonb GENERATED ALWAYS AS',
  'operations_shopify_checkout_rate_receipt_allocations',
  'operations_shopify_checkout_rate_receipt_offers',
  'package_count BETWEEN 0 AND 50',
  'offer_count BETWEEN 0 AND 100',
  'Terminal Shopify checkout rate receipts are immutable',
  'Shopify checkout receipt request evidence is immutable',
  'Shopify checkout receipt reclaim is invalid',
  'Failed Shopify checkout receipts cannot retain quote output',
  'allocation_mismatch_count <> 0',
  'package_allocation_mismatch_count <> 0',
  'package_weight_mismatch_count <> 0',
  'offer.package_plan_hash <> NEW.package_plan_hash',
  'Shopify checkout receipt child evidence is immutable',
  'Shopify checkout package must use an exact selected material revision',
  'carrier_account_id uuid NOT NULL',
  'carrier_rate_request_id uuid NOT NULL',
  "carrier_rate_purpose = 'cartonization_shipment_rate'",
  'carrier_request_hash text NOT NULL',
  'carrier_response_rate_hash text NOT NULL',
  'operations_shopify_checkout_carrier_rate_matches',
  "'{shipment,destinationFingerprint}'",
  "'{shipment,parcels}'",
  "'{shipment,packageCount}'",
  "'{rateScope}' = 'multi_package_shipment'",
  'shopify_service_code text NOT NULL',
  'Shopify checkout offer requires exact configured carrier and rate evidence',
  'operations_shopify_checkout_rate_reconciliations',
  'operations_shopify_checkout_rate_match_candidates',
  'source_line_quantity_fingerprint',
  'source_destination_fingerprint',
  'source_shipping_charge_minor',
  'candidate_set_hash',
  'order_candidate_id uuid NOT NULL',
  'Shopify reconciliation candidate evidence was not database-derived',
  'Ambiguous Shopify checkout matches fail closed',
  'Unmatched Shopify checkout decisions fail closed',
  'Shopify checkout rate reconciliation evidence is immutable',
], 'Checkout receipt schema')

assert.doesNotMatch(
  persistenceSource,
  /\bfetch\s*\(/,
  'Persistence must not perform provider network calls',
)
assert.doesNotMatch(
  persistenceSource,
  /credential_(?:ciphertext|iv|tag)/,
  'Callback persistence must not read credential plaintext or ciphertext',
)
includes(persistenceSource, [
  'normalizeShopifyCarrierServiceConfigInput',
  'normalizeShopifyCheckoutReceiptClaimInput',
  'shopifyCheckoutRatingHash',
  'shopifyCheckoutPackagePlanHash',
  'readShopifyCarrierServiceConfigFromPostgres',
  'upsertShopifyCarrierServiceConfigInPostgres',
  'finalizeShopifyCarrierServiceRegistrationInPostgres',
  'lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres',
  'claimShopifyCheckoutRateReceiptInPostgres',
  'completeShopifyCheckoutRateReceiptInPostgres',
  'failShopifyCheckoutRateReceiptInPostgres',
  'readCachedShopifyCheckoutRateReceiptInPostgres',
  'reconcileShopifyCheckoutRateForOrderCandidateWithClient',
  'reconcileShopifyCheckoutRateForOrderCandidateInPostgres',
  'readShopifyCheckoutRateReconciliationsInPostgres',
  'shopifyCheckoutLineQuantityFingerprint',
  'SHOPIFY_CHECKOUT_IDEMPOTENCY_CONFLICT',
  'SHOPIFY_CHECKOUT_REGISTRATION_DISABLE_REQUIRED',
  'SHOPIFY_CHECKOUT_RECEIPT_ATTEMPTS_EXHAUSTED',
  'SHOPIFY_CHECKOUT_MARKUP_NOT_ALLOWED',
  'SHOPIFY_CHECKOUT_CONTEXT_STALE',
  'config.rowVersion !== input.expectedConfigRowVersion',
  'activation.state !== input.expectedActivationState',
  'activation.revision !== input.expectedActivationRevision',
  "receipt.status IN ('succeeded', 'failed')",
  'receipt.expires_at > now()',
  "AND receipt.status = 'processing'",
  'AND receipt.lease_token = $3::uuid',
  'operations_shopify_carrier_service_config_is_ready',
  'callback_token_hash = $2',
  "AND integration.environment = 'sandbox'",
  'config.registration_state = \'registered\'',
  'config.registration_state = \'shadow_simulated\'',
  "account.configuration ->> 'accountName'",
  'AS store_display_name',
], 'Checkout persistence exports and guards')

const {
  ShopifyCheckoutRatingPersistenceError,
  normalizeShopifyCarrierServiceConfigInput,
  normalizeShopifyCheckoutReceiptClaimInput,
  classifyShopifyCheckoutRateReconciliationOutcome,
  reconcileShopifyCheckoutRateForOrderCandidateWithClient,
  shopifyCheckoutRateLineageIsRequired,
  shopifyCheckoutRateOutcomeAllowsFulfillment,
  shopifyCheckoutPackagePlanHash,
  shopifyCheckoutLineQuantityFingerprint,
  shopifyCheckoutRatingHash,
} = persistence

assert.equal(
  classifyShopifyCheckoutRateReconciliationOutcome({
    exactCandidateCount: 1,
    potentialCandidateCount: 1,
  }),
  'matched',
)
assert.equal(
  classifyShopifyCheckoutRateReconciliationOutcome({
    exactCandidateCount: 2,
    potentialCandidateCount: 2,
  }),
  'ambiguous',
)
assert.equal(
  classifyShopifyCheckoutRateReconciliationOutcome({
    exactCandidateCount: 0,
    potentialCandidateCount: 1,
  }),
  'expired',
)
assert.equal(
  classifyShopifyCheckoutRateReconciliationOutcome({
    exactCandidateCount: 0,
    potentialCandidateCount: 0,
  }),
  'rejected',
)
assert.equal(shopifyCheckoutRateOutcomeAllowsFulfillment('matched'), true)
for (const outcome of ['ambiguous', 'expired', 'rejected', null]) {
  assert.equal(
    shopifyCheckoutRateOutcomeAllowsFulfillment(outcome),
    false,
    `${outcome || 'missing'} checkout lineage must fail closed`,
  )
}
assert.throws(
  () => classifyShopifyCheckoutRateReconciliationOutcome({
    exactCandidateCount: 2,
    potentialCandidateCount: 1,
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_RECONCILIATION_COUNTS_INVALID'
  ),
)
for (const serviceCode of [
  'clawpilot:ups:ground',
  'clawpilot:fedex:fedex_ground',
]) {
  assert.equal(
    shopifyCheckoutRateLineageIsRequired(serviceCode),
    true,
    `${serviceCode} must require immutable ClawPilot quote lineage`,
  )
}
for (const serviceCode of [
  null,
  '',
  'shopify:standard',
  'free_shipping',
  'clawpilot:usps:priority',
]) {
  assert.equal(
    shopifyCheckoutRateLineageIsRequired(serviceCode),
    false,
    `${serviceCode || 'missing'} must remain outside ClawPilot quote lineage`,
  )
}

async function reconcileWithFakeTransaction({
  exactCandidateCount,
  potentialCandidateCount,
}) {
  const organizationId = '00000000-0000-4000-8000-000000000001'
  const integrationAccountId =
    '00000000-0000-4000-8000-000000000002'
  const candidateId = '00000000-0000-4000-8000-000000000003'
  const orderId = '00000000-0000-4000-8000-000000000004'
  const exactMatches = Array.from(
    { length: exactCandidateCount },
    (_unused, index) => ({
      receipt_id:
        `00000000-0000-4000-8000-${String(index + 5).padStart(12, '0')}`,
      receipt_global_id: `gsqr${String(index + 1).padStart(7, '0')}`,
      offer_carrier_provider: index % 2 ? 'fedex_rest' : 'ups_rest',
      offer_carrier_account_id:
        `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
      offer_carrier_rate_request_id:
        `00000000-0000-4000-8000-${String(index + 30).padStart(12, '0')}`,
      offer_service_code: index % 2 ? 'fedex_ground' : 'ground',
      offer_shopify_service_code: index % 2
        ? 'clawpilot:fedex:fedex_ground'
        : 'clawpilot:ups:ground',
      offer_hash: String(index + 1).repeat(64).slice(0, 64),
      offer_customer_charge_minor: '1299',
      offer_currency: 'USD',
    }),
  )
  const expectedOutcome =
    classifyShopifyCheckoutRateReconciliationOutcome({
      exactCandidateCount,
      potentialCandidateCount,
    })
  const selected = exactCandidateCount === 1 ? exactMatches[0] : null
  const insertedRow = {
    global_id: 'gsqc0000001',
    supersedes_reconciliation_global_id: null,
    account_global_id: 'gia0000001',
    order_candidate_global_id: 'gcoc0000001',
    receipt_global_id: selected?.receipt_global_id || null,
    order_global_id: 'gor0000001',
    source_external_order_id: 'shopify-order-1',
    source_order_created_at: '2026-07-30T12:00:00.000Z',
    source_line_quantity_fingerprint: 'a'.repeat(64),
    source_destination_fingerprint: 'b'.repeat(64),
    source_currency: 'USD',
    source_shipping_charge_minor: '1299',
    source_shopify_service_code: 'clawpilot:ups:ground',
    candidate_set_hash: 'c'.repeat(64),
    selected_carrier_account_global_id: selected
      ? 'gac0000001'
      : null,
    selected_rate_evidence_global_id: selected ? 'grq0000001' : null,
    selected_carrier_provider:
      selected?.offer_carrier_provider || null,
    selected_service_code: selected?.offer_service_code || null,
    selected_offer_hash: selected?.offer_hash || null,
    selected_customer_charge_minor:
      selected?.offer_customer_charge_minor || null,
    selected_currency: selected?.offer_currency || null,
    outcome: expectedOutcome,
    match_method: 'shopify_exact_rate_v1',
    candidate_count: exactCandidateCount,
    match_evidence: { providerWrites: 0 },
    idempotency_key: 'gcoc0000001:checkout-rate-reconciliation',
    provider_write_count: 0,
    created_by: 'operator@example.test',
    created_at: '2026-07-30T12:00:01.000Z',
  }
  const responses = [
    { rows: [] },
    {
      rows: [{
        id: candidateId,
        integration_account_id: integrationAccountId,
        account_global_id: 'gia0000001',
        canonical_order_id: orderId,
        order_global_id: 'gor0000001',
        external_order_id: 'shopify-order-1',
        provider_created_at: '2026-07-30T12:00:00.000Z',
        line_quantity_fingerprint: 'a'.repeat(64),
        checkout_destination_fingerprint: 'b'.repeat(64),
        currency_code: 'USD',
        shipping_minor: '1299',
        checkout_shipping_service_code: 'clawpilot:ups:ground',
        workflow_state: 'promoted',
        provider: 'shopify',
        subtotal_minor: '0',
      }],
    },
    { rows: exactMatches, rowCount: exactMatches.length },
    { rows: [{ candidate_count: potentialCandidateCount }] },
    { rows: [insertedRow] },
  ]
  const queries = []
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      const response = responses.shift()
      assert.ok(response, 'unexpected reconciliation query')
      return response
    },
  }
  const reconciliation =
    await reconcileShopifyCheckoutRateForOrderCandidateWithClient(
      client,
      {
        organizationId,
        orderCandidateGlobalId: 'gcoc0000001',
        idempotencyKey:
          'gcoc0000001:checkout-rate-reconciliation',
        actorEmail: 'operator@example.test',
      },
    )
  assert.equal(reconciliation.outcome, expectedOutcome)
  assert.equal(reconciliation.providerWriteCount, 0)
  assert.equal(reconciliation.supersedesReconciliationGlobalId, null)
  assert.equal(queries.length, 5)
  assert.match(
    queries[0].sql,
    /operations_shopify_checkout_rate_current_reconciliations/,
  )
  assert.match(
    queries[4].sql,
    /INSERT INTO operations_shopify_checkout_rate_reconciliations/,
  )
  assert.equal(queries[4].values[20], expectedOutcome)
  assert.equal(responses.length, 0)
}

await reconcileWithFakeTransaction({
  exactCandidateCount: 1,
  potentialCandidateCount: 1,
})
await reconcileWithFakeTransaction({
  exactCandidateCount: 2,
  potentialCandidateCount: 2,
})
await reconcileWithFakeTransaction({
  exactCandidateCount: 0,
  potentialCandidateCount: 1,
})
await reconcileWithFakeTransaction({
  exactCandidateCount: 0,
  potentialCandidateCount: 0,
})

{
  const queries = []
  const client = {
    async query(sql) {
      queries.push(sql)
      return {
        rows: [{
          global_id: 'gsqc0000002',
          supersedes_reconciliation_global_id: 'gsqc0000001',
          account_global_id: 'gia0000001',
          order_candidate_global_id: 'gcoc0000001',
          receipt_global_id: 'gsqr0000001',
          order_global_id: 'gor0000001',
          source_external_order_id: 'shopify-order-1',
          source_order_created_at: '2026-07-30T12:00:00.000Z',
          source_line_quantity_fingerprint: 'a'.repeat(64),
          source_destination_fingerprint: 'b'.repeat(64),
          source_currency: 'USD',
          source_shipping_charge_minor: '1299',
          source_shopify_service_code: 'clawpilot:ups:ground',
          candidate_set_hash: 'c'.repeat(64),
          selected_carrier_account_global_id: 'gac0000001',
          selected_rate_evidence_global_id: 'grq0000001',
          selected_carrier_provider: 'ups_rest',
          selected_service_code: 'ground',
          selected_offer_hash: 'd'.repeat(64),
          selected_customer_charge_minor: '1299',
          selected_currency: 'USD',
          outcome: 'matched',
          match_method: 'shopify_exact_rate_v1',
          candidate_count: 1,
          match_evidence: {
            version:
              'shopify-exact-rate-reconciliation-v2-cached-reuse',
            supersedesReconciliationGlobalId: 'gsqc0000001',
            providerWrites: 0,
          },
          idempotency_key:
            'gcoc0000001:checkout-rate-reconciliation',
          provider_write_count: 0,
          created_by: 'operator@example.test',
          created_at: '2026-07-30T12:05:00.000Z',
        }],
      }
    },
  }
  const replayed =
    await reconcileShopifyCheckoutRateForOrderCandidateWithClient(
      client,
      {
        organizationId: '00000000-0000-4000-8000-000000000001',
        orderCandidateGlobalId: 'gcoc0000001',
        idempotencyKey:
          'gcoc0000001:checkout-rate-reconciliation',
        actorEmail: 'operator@example.test',
      },
    )
  assert.equal(replayed.outcome, 'matched')
  assert.equal(
    replayed.supersedesReconciliationGlobalId,
    'gsqc0000001',
  )
  assert.equal(queries.length, 1)
  assert.match(
    queries[0],
    /operations_shopify_checkout_rate_current_reconciliations/,
  )
}

const promotionSource = section(
  commerceIntakeSource,
  'export async function promoteCommerceCandidateInPostgres',
  null,
  'Commerce order promotion',
)
includes(promotionSource, [
  'reconcileShopifyCheckoutRateForOrderCandidateWithClient',
  'checkoutRateReconciliationGlobalId',
  'checkoutRateReconciliationOutcome',
  'checkoutRateLineageRequired',
  'checkoutRateFulfillmentEligible',
  "'not_applicable'",
  'checkoutRateReconciliation:',
], 'Atomic Shopify checkout reconciliation during promotion')
assert.ok(
  promotionSource.indexOf(
    'reconcileShopifyCheckoutRateForOrderCandidateWithClient',
  ) < promotionSource.lastIndexOf('completeReceipt('),
  'Shopify checkout reconciliation must complete before promotion commits',
)
includes(commerceIntakeSource, [
  'checkout_rate_reconciliation_global_id',
  'checkout_rate_receipt_global_id',
  'checkout_rate_reconciliation_outcome',
  'operations_shopify_checkout_rate_current_reconciliations',
  'fulfillmentEligible:',
], 'Checkout reconciliation intake projection')
includes(commerceIntakeSource, [
  'reconcilePromotedCommerceCandidateCheckoutRateInPostgres',
  'A promoted Shopify order using a ClawPilot shipping service is required',
  'FOR UPDATE OF candidate',
  '`${input.candidateGlobalId}:checkout-rate-reconciliation`',
], 'Executable missing checkout reconciliation recovery')

const releaseSource = section(
  operationsSource,
  'export async function releaseOperationsOrderFromPostgres',
  'export async function confirmOperationsOrderPicksFromPostgres',
  'Operations warehouse release',
)
includes(releaseSource, [
  "order.source_provider === 'shopify'",
  'operations_commerce_order_candidates',
  'operations_shopify_checkout_rate_current_reconciliations',
  'shopifyCheckoutRateLineageIsRequired',
  'shopifyCheckoutRateOutcomeAllowsFulfillment',
  'requiredLineage.length > 0',
  'OPERATIONS_SHOPIFY_CHECKOUT_RATE_RECONCILIATION_REQUIRED',
], 'Shopify fulfillment lineage release guard')

const policySnapshot = {
  algorithm: 'hybrid-v2',
  rateMode: 'whole_shipment',
  materialLimit: 8,
}
const validConfig = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  accountGlobalId: 'gia0000001',
  expectedRowVersion: null,
  credentialGeneration: 2,
  activationRevision: 4,
  callbackTokenVersion: 1,
  callbackTokenHash: 'a'.repeat(64),
  policyRevision: 3,
  policyHash: shopifyCheckoutRatingHash(policySnapshot),
  policySnapshot,
  warehouseGlobalId: 'gwh0000001',
  materials: [
    { materialGlobalId: 'gmat0000002', expectedRowVersion: 7 },
    { materialGlobalId: 'gmat0000001', expectedRowVersion: 5 },
  ],
  carriers: [
    { provider: 'ups_rest', carrierAccountGlobalId: 'gac0000001' },
    { provider: 'fedex_rest', carrierAccountGlobalId: 'gac0000002' },
  ],
  inventoryMaxAgeSeconds: 900,
  quoteTtlSeconds: 900,
  orderReconciliationWindowSeconds: 3600,
  algorithmVersion: 'hybrid-v2',
  actorEmail: 'operator@example.test',
}
const normalizedConfig =
  normalizeShopifyCarrierServiceConfigInput(validConfig)
assert.deepEqual(
  JSON.parse(JSON.stringify(normalizedConfig.materials)),
  [
    {
      selectionSequence: 1,
      materialGlobalId: 'gmat0000002',
      expectedRowVersion: 7,
    },
    {
      selectionSequence: 2,
      materialGlobalId: 'gmat0000001',
      expectedRowVersion: 5,
    },
  ],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(normalizedConfig.carriers)),
  [
    { provider: 'fedex_rest', carrierAccountGlobalId: 'gac0000002' },
    { provider: 'ups_rest', carrierAccountGlobalId: 'gac0000001' },
  ],
)
assert.throws(
  () => normalizeShopifyCarrierServiceConfigInput({
    ...validConfig,
    policyHash: 'b'.repeat(64),
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_POLICY_HASH_MISMATCH'
  ),
)
assert.throws(
  () => normalizeShopifyCarrierServiceConfigInput({
    ...validConfig,
    inventoryMaxAgeSeconds: 300,
    quoteTtlSeconds: 301,
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code
      === 'SHOPIFY_CHECKOUT_TTL_EXCEEDS_INVENTORY_FRESHNESS'
  ),
)
assert.throws(
  () => normalizeShopifyCarrierServiceConfigInput({
    ...validConfig,
    materials: [
      validConfig.materials[0],
      validConfig.materials[0],
    ],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_MATERIAL_DUPLICATE'
  ),
)

const validClaim = {
  organizationId: validConfig.organizationId,
  accountGlobalId: validConfig.accountGlobalId,
  expectedConfigRowVersion: 7,
  expectedActivationState: 'shadow',
  expectedActivationRevision: 5,
  requestFingerprint: 'c'.repeat(64),
  destinationFingerprint: 'd'.repeat(64),
  carrierDestinationFingerprint: 'f'.repeat(64),
  redactedRequestSnapshot: {
    currency: 'USD',
    itemCount: 2,
  },
  currency: 'usd',
  idempotencyKey: 'shopify-rate-request-0001',
  inventorySnapshotHash: 'e'.repeat(64),
  inventorySnapshotAt: '2026-07-29T12:00:00.000Z',
  claimedBy: 'system:shopify-checkout',
  lines: [
    {
      lineKey: 'line-b',
      providerVariantId: 'gid://shopify/ProductVariant/2',
      sku: 'SKU-2',
      quantity: 1,
      unitWeightGrams: 200,
      requiresShipping: true,
      lineSnapshot: { merchandiseKey: 'variant-2' },
    },
    {
      lineKey: 'line-a',
      providerVariantId: 'gid://shopify/ProductVariant/1',
      sku: 'SKU-1',
      quantity: 3,
      unitWeightGrams: 100,
      requiresShipping: true,
      lineSnapshot: { merchandiseKey: 'variant-1' },
    },
  ],
}
const normalizedClaim = normalizeShopifyCheckoutReceiptClaimInput(validClaim)
assert.equal(normalizedClaim.currency, 'USD')
assert.deepEqual(
  JSON.parse(JSON.stringify(
    normalizedClaim.lines.map((line) => line.lineKey),
  )),
  ['line-a', 'line-b'],
)
assert.match(normalizedClaim.requestEvidenceHash, /^[a-f0-9]{64}$/)
assert.match(normalizedClaim.lineQuantityFingerprint, /^[a-f0-9]{64}$/)
assert.notEqual(
  normalizedClaim.requestEvidenceHash,
  normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    carrierDestinationFingerprint: 'a'.repeat(64),
  }).requestEvidenceHash,
  'Carrier destination identity must be sealed into request evidence',
)
assert.equal(
  normalizedClaim.lineQuantityFingerprint,
  shopifyCheckoutLineQuantityFingerprint([
    {
      providerVariantId: 'gid://shopify/ProductVariant/1',
      quantity: 1,
    },
    {
      providerVariantId: 'gid://shopify/ProductVariant/2',
      quantity: 1,
    },
    {
      providerVariantId: 'gid://shopify/ProductVariant/1',
      quantity: 2,
    },
  ]),
  'Line fingerprint must aggregate identical variants independent of line split',
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    redactedRequestSnapshot: {
      currency: 'USD',
      customerEmail: 'not-allowed@example.test',
    },
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_EVIDENCE_NOT_NEUTRAL'
  ),
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    carrierDestinationFingerprint: 'not-a-hash',
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_IDENTIFIER_INVALID'
  ),
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    expectedActivationState: 'read_only',
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_ACTIVATION_STATE_INVALID'
  ),
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    lines: [{
      ...validClaim.lines[0],
      requiresShipping: false,
    }],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_NONSHIPPING_LINE_INVALID'
  ),
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    lines: [validClaim.lines[0], validClaim.lines[0]],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_LINE_DUPLICATE'
  ),
)

const packageOne = {
  packageKey: 'package-1',
  packageSequence: 1,
  materialGlobalId: 'gmat0000001',
  materialRowVersion: 5,
  materialStockGlobalId: 'gmas0000001',
  materialStockRowVersion: 9,
  materialStockOnHandQuantity: 25,
  ratedOuterDimensionsMm: { length: 279, width: 229, height: 178 },
  contentWeightGrams: 1000,
  tareWeightGrams: 100,
  allocations: [
    { lineKey: 'line-b', quantity: 1 },
    { lineKey: 'line-a', quantity: 3 },
  ],
  packageSnapshot: { planningMethod: 'approved_recipe' },
}
const selfPackage = {
  packageKey: 'sealed-case-1',
  packageSequence: 1,
  planningMethod: 'self_package',
  packProfileVersionGlobalId: 'gppv0000001',
  packProfileVersionRowVersion: 3,
  selfPackageLineKey: 'line-a',
  ratedOuterDimensionsMm: { length: 279, width: 229, height: 178 },
  contentWeightGrams: 2268,
  tareWeightGrams: 0,
  allocations: [{ lineKey: 'line-a', quantity: 1 }],
  packageSnapshot: { planningMethod: 'self_package' },
}
assert.notEqual(
  shopifyCheckoutPackagePlanHash({ packages: [packageOne] }),
  shopifyCheckoutPackagePlanHash({ packages: [selfPackage] }),
  'Package-plan hashing must retain the self-package planning method and profile',
)
assert.equal(
  shopifyCheckoutPackagePlanHash({ packages: [packageOne] }),
  shopifyCheckoutPackagePlanHash({
    packages: [{
      ...packageOne,
      allocations: [...packageOne.allocations].reverse(),
    }],
  }),
  'Package-plan hashing must be allocation-order independent',
)
assert.equal(
  shopifyCheckoutRatingHash({ b: 2, a: 1 }),
  shopifyCheckoutRatingHash({ a: 1, b: 2 }),
  'Canonical evidence hashing must be object-key-order independent',
)

includes(persistenceSource, [
  'zeroValueMerchandiseAllowed',
  'candidate.subtotal_minor',
], 'Zero-value Shopify order reconciliation')
assert.doesNotMatch(
  section(
    migration,
    'CREATE OR REPLACE FUNCTION\n  operations_shopify_checkout_rate_match_candidates',
    'CREATE OR REPLACE FUNCTION\n  protect_operations_shopify_checkout_rate_reconciliation',
    'Exact Shopify quote-to-order candidate matcher',
  ),
  /subtotal_minor|unit_price_minor|total_minor/,
  'A zero-value product must not affect exact shipping-quote reconciliation',
)
const receiptReuseMatcher = section(
  receiptReuseMigration,
  'CREATE OR REPLACE FUNCTION\n  operations_shopify_checkout_rate_match_candidates',
  'CREATE OR REPLACE FUNCTION\n  protect_ops_shopify_rate_recon_supersession',
  'Shopify cached-receipt matcher',
)
includes(receiptReuseMigration, [
  'DROP INDEX IF EXISTS',
  'op_shopify_rate_reconciliations_receipt_match_unique',
  'op_shopify_rate_reconciliations_receipt_match_idx',
  'operations_shopify_checkout_rate_reconciliation_supersessions',
  'protect_ops_shopify_rate_recon_supersession',
  'operations_shopify_checkout_rate_current_reconciliations',
  "'pre_0157_cached_receipt_exclusivity'",
  "original.outcome IN ('rejected', 'expired')",
  'recoverable.exact_candidate_count = 1',
  'ON CONFLICT (organization_id, original_reconciliation_id) DO NOTHING',
  'One immutable receipt may support multiple orders',
], 'Shopify cached receipt reuse')
includes(receiptReuseMatcher, [
  "date_trunc('second', receipt.created_at)",
  'candidate.checkout_destination_fingerprint',
  'operations_shopify_checkout_order_line_quantity_fingerprint',
  'offer.shopify_service_code',
  'offer.customer_charge_minor = candidate.shipping_minor',
], 'Shopify cached receipt exact facts')
assert.doesNotMatch(
  receiptReuseMatcher,
  /operations_shopify_checkout_rate_reconciliations prior|prior\.receipt_id|NOT EXISTS/,
  'A cached Shopify receipt must not be consumed by the first matching order',
)
includes(persistenceSource, [
  'supersedesReconciliationGlobalId',
  'CURRENT_RECONCILIATION_SELECT',
  'operations_shopify_checkout_rate_current_reconciliations',
], 'Current Shopify reconciliation projection')

for (const path of [
  'db/migrations/0148_operations_commerce_external_effects.sql',
  'db/migrations/0149_operations_shopify_checkout_rating.sql',
  'db/migrations/0157_operations_shopify_checkout_receipt_reuse.sql',
]) {
  const overlength = [
    ...new Set(
      [...read(path).matchAll(/\b[A-Za-z_][A-Za-z0-9_$]*\b/g)]
        .map((match) => match[0])
        .filter((identifier) => Buffer.byteLength(identifier, 'utf8') > 63),
    ),
  ]
  assert.deepEqual(
    overlength,
    [],
    `${path} must not rely on PostgreSQL identifier truncation`,
  )
}

console.log('Shopify checkout rating persistence contracts passed.')
