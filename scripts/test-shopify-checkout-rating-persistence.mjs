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
const packHardeningMigration = read(
  'db/migrations/0151_operations_product_pack_management_hardening.sql',
)
const persistenceSource = read(
  'app_src/lib/persistence/shopifyCheckoutRating.ts',
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
], 'Checkout persistence exports and guards')

const {
  ShopifyCheckoutRatingPersistenceError,
  normalizeShopifyCarrierServiceConfigInput,
  normalizeShopifyCheckoutReceiptClaimInput,
  shopifyCheckoutPackagePlanHash,
  shopifyCheckoutLineQuantityFingerprint,
  shopifyCheckoutRatingHash,
} = persistence

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
includes(
  section(
    migration,
    'CREATE OR REPLACE FUNCTION\n  operations_shopify_checkout_rate_match_candidates',
    'CREATE OR REPLACE FUNCTION\n  protect_operations_shopify_checkout_rate_reconciliation',
    'Exact Shopify quote-to-order candidate matcher',
  ),
  [
    "date_trunc('second', receipt.created_at)",
    'NOT EXISTS (',
    'FROM operations_shopify_checkout_rate_reconciliations prior',
    'prior.receipt_id = receipt.id',
    "prior.outcome = 'matched'",
  ],
  'Previously linked Shopify receipt exclusion',
)

for (const path of [
  'db/migrations/0148_operations_commerce_external_effects.sql',
  'db/migrations/0149_operations_shopify_checkout_rating.sql',
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
