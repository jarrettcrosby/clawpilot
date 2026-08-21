#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

const [
  migration,
  packEvidenceMigration,
  checkoutAccountCorrection,
  unlistedCheckoutMigration,
  domain,
  persistence,
  route,
  panel,
] = await Promise.all([
  read('db/migrations/0151_operations_product_pack_management_hardening.sql'),
  read('db/migrations/0191_operations_commerce_pack_evidence_fingerprint.sql'),
  read('db/migrations/0162_operations_shopify_checkout_mapping_account_status.sql'),
  read('db/migrations/0255_operations_shopify_unlisted_checkout_eligibility.sql'),
  read('app_src/lib/operations/productPackManagement.ts'),
  read('app_src/lib/persistence/productPackManagement.ts'),
  read('app_src/app/api/operations/product-pack-profiles/route.ts'),
  read('app_src/components/crm/ProductPackProfilePanel.tsx'),
])

for (const fragment of [
  'operations_shopify_checkout_channel_is_eligible(',
  "lower(btrim(requested_environment)) = 'sandbox'",
  "lower(btrim(requested_provider_status_raw)) = 'active'",
  "lower(btrim(requested_normalized_status)) = 'unlisted'",
  "lower(btrim(requested_provider_status_raw)) = 'unlisted'",
  'requested_provider_active IS FALSE',
  "credential_verification_status IS DISTINCT FROM 'verified'",
  'channel_state.provider_status_raw',
  'operations_shopify_carrier_service_config_is_ready(',
]) {
  assert.ok(
    unlistedCheckoutMigration.includes(fragment),
    `unlisted checkout migration is missing ${fragment}`,
  )
}
assert.doesNotMatch(
  unlistedCheckoutMigration,
  /UPDATE\s+operations_product_channel_states/i,
  'unlisted checkout migration must not relabel provider lifecycle evidence',
)

for (const fragment of [
  'operations_commerce_pack_evidence_hash(',
  'ADD COLUMN IF NOT EXISTS pack_evidence_hash text',
  'SET pack_evidence_hash = state.pack_evidence_hash',
  'set_operations_product_channel_pack_evidence_hash()',
  'Current pack evidence is immutable; retire and create a new mapping',
  "account_status NOT IN ('active', 'disabled')",
  'mapping.pack_evidence_hash = state.pack_evidence_hash',
  'NEW.pack_evidence_hash',
  'channel_state.pack_evidence_hash',
  'Full source_revision/source_hash remain catalog audit evidence',
]) {
  assert.ok(
    packEvidenceMigration.includes(fragment),
    `pack evidence migration is missing ${fragment}`,
  )
}
for (const excluded of [
  'inventory_quantity',
  'provider_updated_at',
  'provider_product_title',
  'provider_variant_title',
  'provider_sku',
  'provider_barcode',
  'provider_category_id',
  'retail_price_minor',
]) {
  const fingerprintFunction = packEvidenceMigration.slice(
    packEvidenceMigration.indexOf(
      'CREATE OR REPLACE FUNCTION operations_commerce_pack_evidence_hash',
    ),
    packEvidenceMigration.indexOf(
      'ALTER TABLE operations_product_channel_states',
    ),
  )
  assert.ok(
    !fingerprintFunction.includes(excluded),
    `pack evidence fingerprint must exclude ${excluded}`,
  )
}

for (const fragment of [
  "account_status NOT IN ('active', 'disabled')",
  'validate_operations_commerce_variant_pack_mapping()',
]) {
  assert.ok(
    checkoutAccountCorrection.includes(fragment),
    `checkout account-status correction is missing ${fragment}`,
  )
}

for (const fragment of [
  'validate_operations_product_pack_profile_version()',
  'provider_weight_channel_state_id',
  'provider_weight_source_revision',
  'provider_weight_source_hash',
  'Active provider weight must exactly match retained channel-state evidence',
  "profile_level = 'each'",
  "profile_level = 'case'",
  "NEW.lifecycle_state = 'active'",
  "NEW.dimension_basis <> 'outer'",
  'validate_operations_commerce_variant_pack_mapping()',
  "mapping_purpose IN ('catalog', 'shopify_checkout')",
  'idx_operations_commerce_variant_pack_mappings_one_current',
  'external_variant_id,\n    mapping_purpose',
  "IF NOT (NEW.is_current AND NEW.projection_state = 'current')",
  'NEW.source_revision IS DISTINCT FROM channel_state.source_revision',
  'NEW.source_hash IS DISTINCT FROM channel_state.source_hash',
  'NEW.observed_at IS DISTINCT FROM channel_state.observed_at',
  "NEW.mapping_purpose = 'shopify_checkout'",
  'operations_shopify_carrier_service_config_is_ready(',
  "profile_package_level = 'case'",
  'version_base_each_quantity > 1',
  'version_ships_as_own_package = true',
  "'self_package'",
  'op_shopify_rate_packages_profile_version_valid',
  'Each self-package must allocate exactly one sell unit',
  'validate_operations_approved_pack_recipe()',
  "NEW.recipe_type = 'exact_case'",
  'input_base_each_quantity * NEW.input_quantity',
  'output_base_each_quantity * NEW.output_quantity',
  'material.rated_outer_length_mm > 0',
  'material.max_weight_grams > material.tare_weight_grams',
]) {
  assert.ok(migration.includes(fragment), `migration is missing ${fragment}`)
}

for (const fragment of [
  'PRODUCT_PACK_DIMENSION_EVIDENCE_INVALID',
  'PRODUCT_PACK_WEIGHT_EVIDENCE_INVALID',
  'PRODUCT_PACK_ACTIVATION_STATE_INVALID',
  'PRODUCT_PACK_PROVIDER_WEIGHT_EVIDENCE_REQUIRED',
  'PRODUCT_PACK_EXACT_CASE_OUTPUT_INVALID',
  'PRODUCT_PACK_ACTIVE_RECIPE_EVIDENCE_REQUIRED',
]) {
  assert.ok(domain.includes(fragment), `domain is missing ${fragment}`)
}

for (const fragment of [
  'operations_command_receipts',
  'acquireTransactionAdvisoryLock(',
  'FOR UPDATE OF product',
  'FOR UPDATE OF state',
  'PRODUCT_PACK_CHANNEL_STATE_VERSION_CONFLICT',
  'PRODUCT_PACK_PROVIDER_WEIGHT_CONFLICT',
  'operations_shopify_carrier_service_rating_environment_is_ready(',
  "config.registration_state = 'registered'",
  "planning_method: 'self_package'",
  "planning_method: 'approved_recipe'",
  "SET projection_state = 'stale'",
  "SET lifecycle_state = 'retired'",
  "SET lifecycle_state = 'superseded'",
  'channelStates: channelStates.rows.map',
  'packagingMaterials: materials.rows.map',
  'state.source_revision',
  'state.source_hash',
  'state.pack_evidence_hash',
  'state.provider_status_raw',
  'isShopifyRatingCheckoutChannelEligible({',
  'material.rated_outer_length_mm',
  'recordAuditEvent({',
  "row.account_status === 'error'",
]) {
  assert.ok(persistence.includes(fragment), `persistence is missing ${fragment}`)
}
assert.doesNotMatch(
  persistence,
  /\b(?:fetch|decryptCommerceCredentials)\s*\(/,
  'pack management must not perform provider calls or decrypt credentials',
)
assert.doesNotMatch(
  persistence,
  /UPDATE\s+operations_product_channel_states/i,
  'pack management must not rewrite retained provider evidence',
)

for (const fragment of [
  'requireRequestUser(req)',
  'operationsCapabilities(actor)',
  'capabilities.canManage',
  'activeOperationsOrganizationId(actor)',
  'isPostgresStorageEnabled()',
  'Idempotency-Key header is required',
  'MAX_REQUEST_BYTES',
  "action === 'save-profile-version'",
  "action === 'save-variant-mapping'",
  "action === 'save-approved-recipe'",
  "'Cache-Control': 'private, no-store'",
]) {
  assert.ok(route.includes(fragment), `route is missing ${fragment}`)
}

assert.match(
  route,
  /const PRODUCT_GLOBAL_ID = \/\^gp\(\?:\[0-9\]\{7\}\|\[0-9a-v\]\{12\}\)\$\//,
  'route must accept only public Product Global IDs',
)
const productGlobalIdPattern = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
assert.match('gp1234567', productGlobalIdPattern)
assert.match('gp0123456789av', productGlobalIdPattern)
assert.doesNotMatch('ga1234567', productGlobalIdPattern)
assert.doesNotMatch('gp0123456789aw', productGlobalIdPattern)
assert.doesNotMatch(
  route,
  /credential|secret|accessToken|refreshToken/i,
  'route contract must not expose commerce credentials',
)

for (const fragment of [
  "lifecycleState: 'draft'",
  "grossWeight: ''",
  "| 'derived'",
  'function profileEvidenceMetadata(',
  "evidenceType: 'derived'",
  "evidenceType: 'customer_confirmed'",
  "evidenceType: 'measured'",
  "source: 'provider_sync'",
  "? 'customer_supplied'",
  ": 'manual'",
  'Derived from evidenced components',
  'Exclude the selected outbound carton or shipping-material tare;',
  'outbound shipping-material tare must not be included.',
  '6 oz net-content bag',
  'Gross shipping weight is not yet supplied',
  "recipeKey = 'loose-each-carton'",
  "recipeType: 'max_capacity'",
  'minimumInputQuantity: 1',
  'Case-only evidence is not enough.',
]) {
  assert.ok(panel.includes(fragment), `panel is missing ${fragment}`)
}
assert.doesNotMatch(
  panel,
  /grossWeight:\s*'(?:6|72)'/,
  'nominal product contents must not be persisted as gross shipping weight',
)

console.log('Product pack management contract tests passed')
