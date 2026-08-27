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
      if (
        specifier
        === '@/lib/operations/shopifyCheckoutPlanRatePolicy'
      ) {
        const policyPath =
          'app_src/lib/operations/shopifyCheckoutPlanRatePolicy.ts'
        const policyOutput = ts.transpileModule(read(policyPath), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
          fileName: policyPath,
        }).outputText
        const policyModule = { exports: {} }
        vm.runInNewContext(policyOutput, {
          Array,
          Error,
          Number,
          Object,
          Set,
          String,
          exports: policyModule.exports,
          module: policyModule,
          require(policySpecifier) {
            if (policySpecifier === '../currency.ts') {
              return {
                DEFAULT_WORKSPACE_CURRENCY_CODE: 'USD',
                isIso4217CurrencyCode: (value) => (
                  typeof value === 'string'
                  && /^[A-Z]{3}$/.test(value)
                  && value !== 'ZZZ'
                ),
              }
            }
            return requireFromApp(policySpecifier)
          },
        }, { filename: policyPath })
        return policyModule.exports
      }
      if (
        specifier
        === '@/lib/operations/shopifyCheckoutRateWarmPolicy'
      ) {
        const policyPath =
          'app_src/lib/operations/shopifyCheckoutRateWarmPolicy.ts'
        const policyOutput = ts.transpileModule(read(policyPath), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
          fileName: policyPath,
        }).outputText
        const policyModule = { exports: {} }
        vm.runInNewContext(policyOutput, {
          Array,
          Error,
          Number,
          Object,
          Set,
          String,
          exports: policyModule.exports,
          module: policyModule,
        }, { filename: policyPath })
        return policyModule.exports
      }
      if (
        specifier
        === '@/lib/operations/shopifyCheckoutAudiencePolicy'
      ) {
        const policyPath =
          'app_src/lib/operations/shopifyCheckoutAudiencePolicy.ts'
        const policyOutput = ts.transpileModule(read(policyPath), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
          fileName: policyPath,
        }).outputText
        const policyModule = { exports: {} }
        vm.runInNewContext(policyOutput, {
          Array,
          Error,
          Object,
          String,
          exports: policyModule.exports,
          module: policyModule,
        }, { filename: policyPath })
        return policyModule.exports
      }
      if (
        specifier
        === '@/lib/operations/shopifyCheckoutRateControl'
      ) {
        const controlPath =
          'app_src/lib/operations/shopifyCheckoutRateControl.ts'
        const controlOutput = ts.transpileModule(read(controlPath), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
          fileName: controlPath,
        }).outputText
        const controlModule = { exports: {} }
        vm.runInNewContext(controlOutput, {
          Array,
          Error,
          Object,
          String,
          exports: controlModule.exports,
          module: controlModule,
          require(controlSpecifier) {
            if (controlSpecifier === './shopifyCheckoutAudiencePolicy') {
              return {}
            }
            return requireFromApp(controlSpecifier)
          },
        }, { filename: controlPath })
        return controlModule.exports
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
const nameAlignmentMigration = read(
  'db/migrations/0166_shopify_carrier_service_name_alignment.sql',
)
const planRatePolicyMigration = read(
  'db/migrations/0170_operations_shopify_checkout_plan_rate_policy.sql',
)
const shippingServiceCodeMigration = read(
  'db/migrations/0173_operations_shopify_shipping_service_codes.sql',
)
const providerAttemptMigration = read(
  'db/migrations/0174_operations_shopify_checkout_provider_attempts.sql',
)
const configuredCarrierMigration = read(
  'db/migrations/0285_shopify_carrier_service_configured_carriers.sql',
)
const rateWarmPolicyMigration = read(
  'db/migrations/0175_operations_shopify_checkout_rate_warm_policy.sql',
)
const quoteMatchFamiliesMigration = read(
  'db/migrations/0189_operations_shopify_checkout_quote_match_families.sql',
)
const unitMaterialCheckoutMigration = read(
  'db/migrations/0329_operations_shopify_checkout_unit_material_cartonization.sql',
)
const checkoutLineAuthorityMigration = read(
  'db/migrations/0331_operations_shopify_checkout_line_authority.sql',
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
includes(unitMaterialCheckoutMigration, [
  "'unit_material_selection'",
  'op_shopify_rate_packages_planning_method_valid',
  'op_shopify_rate_packages_profile_version_valid',
  "planning_method <> 'unit_material_selection'",
  'OR allocation_count = 1',
  "planning_method = 'self_package'",
  'pack_profile_version_id IS NOT NULL',
  'tare_weight_grams = 0',
  'protect_operations_shopify_checkout_rate_receipt_package()',
  "NEW.planning_method IN (",
  'mapping.pack_evidence_hash = state.pack_evidence_hash',
  'validate_operations_shopify_checkout_unit_material_allocation()',
  'NEW.quantity <> 1 OR retained_allocation_count <> 0',
  'validate_operations_shopify_checkout_unit_material_finalize()',
  "package.planning_method = 'unit_material_selection'",
  'count(allocation.line_key) <> 1',
  'sum(allocation.quantity) <> 1',
  "WHEN 'unit_material_selection'",
  "THEN 'ClawPilot carton '",
], 'Unit-material checkout receipt persistence')
includes(checkoutLineAuthorityMigration, [
  'validate_operations_shopify_checkout_unit_material_allocation()',
  "line.line_snapshot ->> 'snapshotVersion'",
  "line.line_snapshot ->> 'cartonizationAuthority'",
  "'shopify-checkout-line-pack-evidence-v2'",
  "'shopify-checkout-line-pack-evidence-v1'",
  'ELSE NULL',
  "'product_pack', 'unit_material_selection'",
  "target_planning_method = 'unit_material_selection'",
  "target_cartonization_authority = 'unit_material_selection'",
  'Shopify checkout package method conflicts with retained line authority',
  'Existing Shopify checkout allocation conflicts with retained line authority',
], 'Checkout line-to-package authority persistence')
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
includes(shippingServiceCodeMigration, [
  'operations_commerce_order_candidates_checkout_service_valid',
  'BETWEEN 1 AND 255',
  "checkout_shipping_service_code !~ '[[:cntrl:]]'",
], 'Shopify opaque shipping-service-code boundary')
assert.ok(
  !shippingServiceCodeMigration.includes('BETWEEN 3 AND 80'),
  'Order intake must retain valid two-character Shopify shipping method codes',
)
assert.doesNotMatch(
  offerParcelEvidenceMigration,
  /package\.carrier_parcel_snapshot/,
  'Provider parcel evidence must not compare against the internal package-key snapshot',
)
includes(providerAttemptMigration, [
  'operations_shopify_checkout_rate_receipt_provider_attempts',
  "carrier_provider IN ('ups_rest', 'fedex_rest')",
  "carrier_rate_purpose = 'cartonization_shipment_rate'",
  "attempt_status IN ('succeeded', 'degraded')",
  'failure_code IS NOT NULL',
  'op_shopify_checkout_provider_attempts_rate_fkey',
  'operations_shopify_checkout_json_is_customer_neutral(',
  'protect_op_shopify_checkout_provider_attempt',
  "rate_evidence.status = 'succeeded'",
  "rate_evidence.status = 'failed'",
  'rate_evidence.error_code = NEW.failure_code',
  "'{shipment,destinationFingerprint}'",
  "'{shipment,parcels}'",
  'operations_shopify_checkout_carrier_parcels_match',
  'successful_attempt_without_offer_count',
  'degraded_attempt_with_offer_count',
  'retained_attempt_count <> expected_provider_count',
  'successful_attempt_count < 1',
  'offer.carrier_rate_request_id =',
  'Shopify checkout receipt provider-attempt evidence is incomplete',
], 'Shopify checkout provider-attempt evidence')

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
  'UNIQUE (organization_id, integration_account_id)',
  'UNIQUE (organization_id, id)',
  'REFERENCES operations_warehouses(organization_id, id)',
  'operations_shopify_carrier_service_configs_policy_redacted',
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
includes(nameAlignmentMigration, [
  'checkout_brand_name_override text',
  'registered_service_name text',
  'operations_shopify_carrier_service_configs_brand_name_valid',
  'length(btrim(checkout_brand_name_override)) BETWEEN 1 AND 120',
  "checkout_brand_name_override !~ '[[:cntrl:]]'",
  'length(btrim(registered_service_name)) BETWEEN 1 AND 255',
  "registered_service_name !~ '[[:cntrl:]]'",
  'Provider-confirmed name currently applied to the exact registered Shopify CarrierService',
], 'Optional audited checkout-name override schema')
includes(planRatePolicyMigration, [
  'operations_shopify_checkout_plan_rate_policy_is_valid',
  "'shopify-checkout-plan-rate-objective-v2'",
  "'maxCandidates', 4",
  "'landed_price'",
  "'package_count'",
  "'unused_cube'",
  "'handlingCostMinorPerPackage', 0",
  "'handlingCostCurrency', upper(preference.currency_code)",
  'INSERT INTO workspace_organization_preferences',
  'WHERE preference.organization_id IS NULL',
  'JOIN workspace_organization_preferences preference',
  'canonical_operations_shopify_checkout_policy_jsonb',
  'policy_revision = config.policy_revision + 1',
  'policy_hash = encode(',
  'row_version = config.row_version + 1',
  'operations_shopify_configs_plan_rate_policy_valid',
  "policy_snapshot -> 'planRateOptimization'",
], 'Persisted tenant checkout plan-rate policy migration')
includes(rateWarmPolicyMigration, [
  'operations_shopify_checkout_rate_warm_policy_is_valid',
  "'shopify-checkout-rate-warm-v1'",
  "'enabled', false",
  "'mode', 'hosted_ajax'",
  "'zoneScope', 'all_saved_rate_zones'",
  "'concurrency', 2",
  "'debounceMs', 350",
  "'minIntervalMs', 1000",
  "'supportedCountries', jsonb_build_array('US')",
  "input_policy ->> 'mode' IS DISTINCT FROM 'hosted_ajax'",
  "countries IS DISTINCT FROM jsonb_build_array('US')",
  "'staleCartAbort', true",
  "input_policy -> 'staleCartAbort' IS DISTINCT FROM 'true'::jsonb",
  'canonical_operations_shopify_checkout_policy_jsonb',
  'policy_revision = config.policy_revision + 1',
  'policy_hash = encode(',
  'row_version = config.row_version + 1',
  'operations_shopify_configs_rate_warm_policy_valid',
  "policy_snapshot -> 'checkoutRateWarm'",
], 'Persisted tenant checkout rate-warm policy migration')
assert.equal(
  rateWarmPolicyMigration.includes("'headless_storefront'"),
  false,
  'checkout rate-warm v1 migration must reject unimplemented headless mode',
)

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
  "'SHOPIFY_CHECKOUT_ATTEMPT_KEY_INVALID'",
  "left(receipt.idempotency_key, length($10) + 9)",
  "left(receipt.idempotency_key, length($9) + 9)",
  "left(receipt.idempotency_key, length($5) + 9)",
  'shopifyCheckoutRatingHash',
  'shopifyCheckoutPackagePlanHash',
  'readShopifyCarrierServiceConfigFromPostgres',
  'updateShopifyCarrierServiceBrandNameOverrideInPostgres',
  'updateShopifyCarrierServiceRateWarmPolicyInPostgres',
  'upsertShopifyCarrierServiceConfigInPostgres',
  'finalizeShopifyCarrierServiceRegistrationInPostgres',
  'lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres',
  'claimShopifyCheckoutRateReceiptInPostgres',
  'completeShopifyCheckoutRateReceiptInPostgres',
  'failShopifyCheckoutRateReceiptInPostgres',
  'readCachedShopifyCheckoutRateReceiptInPostgres',
  'lockCleanShopifyInventoryRefreshVersion',
  'shopify-inventory-watermark:',
  'SHOPIFY_CHECKOUT_INVENTORY_REFRESH_PENDING',
  'SHOPIFY_CHECKOUT_INVENTORY_REFRESH_VERSION_STALE',
  'receipt.inventory_refresh_version',
  'inventory_refresh_version = $6::bigint',
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
  'config.checkout_brand_name_override',
  'checkoutBrandNameOverride: row.checkout_brand_name_override',
  'config.registered_service_name',
  'registeredServiceName: row.registered_service_name',
  'current.checkoutBrandNameOverride',
  '=== input.checkoutBrandNameOverride',
  'SET checkout_brand_name_override = $3',
  'row_version = row_version + 1',
  "'operations.shopify_carrier_service.brand_name_changed'",
  "effectiveNameSource:",
  "'provider_verified_shop_name'",
  "'administrator_override'",
  "'SHOPIFY_CHECKOUT_BRAND_NAME_AUTHORIZATION_ACTIVE'",
  'authorized_mutation.config_row_version = $3::bigint',
  "outcome.outcome = 'failed'",
  'outcome.provider_write_count = 0',
  "resolution.disposition = 'confirmed_not_applied'",
  'checkoutRateControl.rateSource !== input.rateSource',
  'existing.rows[0].rate_source !== input.rateSource',
  "receipt.status IN ('succeeded', 'failed')",
  'receipt.expires_at > now()',
  "AND receipt.status = 'processing'",
  'AND receipt.lease_token = $3::uuid',
  'operations_shopify_carrier_service_config_is_ready',
  'callback_token_hash = $2',
  "AND integration.environment IN ('sandbox', 'production')",
  'config.registration_state = \'registered\'',
  'config.registration_state = \'shadow_simulated\'',
  "account.configuration ->> 'accountName'",
  'AS store_entity_name',
  'MAX_SHOPIFY_CHECKOUT_CARRIER_ACCOUNTS',
  'MAX_SHOPIFY_CHECKOUT_CONFIGURED_CARRIER_ACCOUNTS',
  'updateRegisteredShopifyCarrierServiceRateSourcesInPostgres',
  "'clawpilot.shopify_carrier_binding_write_token'",
  'DELETE FROM operations_shopify_carrier_service_config_materials',
  'INSERT INTO operations_shopify_carrier_service_config_materials',
  "'operations.shopify_carrier_service.rate_sources_updated'",
  "'SHOPIFY_CHECKOUT_BINDING_UPDATE_RECEIPT_IN_FLIGHT'",
  'ShopifyCheckoutProviderAttemptInput',
  'ShopifyCheckoutRateReceiptProviderAttempt',
  'providerAttempts: ShopifyCheckoutProviderAttemptInput[]',
  'providerAttempts: ShopifyCheckoutRateReceiptProviderAttempt[]',
  'operations_shopify_checkout_rate_receipt_provider_attempts',
  'ShopifyCheckoutReceiptLineSnapshotV1',
  'normalizeShopifyCheckoutReceiptLineSnapshotV1',
  'SHOPIFY_CHECKOUT_LINE_HASH_MISMATCH',
  'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_COUNT_INVALID',
  'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_OFFER_MISMATCH',
  'attemptHash: shopifyCheckoutRatingHash(normalized)',
  'JSON.stringify(input.providerAttempts.map((attempt) => ({',
], 'Checkout persistence exports and guards')

const hydrationRunner = section(
  persistenceSource,
  'async function runHydrationQueries',
  'async function readConfigChildren(',
  'child hydration query runner',
)
includes(hydrationRunner, [
  'if (!client)',
  'Promise.all(runnable.map((task) => task()))',
  'for (const task of runnable)',
  'results.push(await task())',
], 'pool-parallel and transaction-serialized child hydration')

const configHydration = section(
  persistenceSource,
  'async function readConfigChildren(',
  'async function readConfigRowWithClient(',
  'CarrierService config child hydration',
)
includes(configHydration, [
  'runHydrationQueries(client, [',
  '() => run<MaterialRow>(',
  '() => run<CarrierBindingRow>(',
], 'transaction-safe CarrierService config child hydration')

const receiptHydration = section(
  persistenceSource,
  'async function readReceiptChildren(',
  'async function receiptFromRow(',
  'checkout receipt child hydration',
)
includes(receiptHydration, [
  'runHydrationQueries(client, [',
  '() => run<QueryResultRow & {',
  'providerAttemptResult',
  'operations_shopify_checkout_rate_receipt_provider_attempts',
  'hydrateShopifyCheckoutRateReceiptLine({',
  'providerAttempts: providerAttemptResult.rows.map(',
], 'transaction-safe checkout receipt child hydration')

const receiptClaim = section(
  persistenceSource,
  'async function claimShopifyCheckoutRateReceiptOnceInPostgres',
  'export async function claimShopifyCheckoutRateReceiptInPostgres',
  'single checkout receipt claim transaction',
)
const receiptClaimRetry = section(
  persistenceSource,
  'export async function claimShopifyCheckoutRateReceiptInPostgres',
  'function normalizeCompletion(',
  'checkout receipt claim retry wrapper',
)
const completionNormalization = section(
  persistenceSource,
  'function normalizeCompletion(',
  'export async function completeShopifyCheckoutRateReceiptInPostgres',
  'checkout receipt completion normalization',
)
includes(completionNormalization, [
  'input.providerAttempts.length < 1',
  '> MAX_SHOPIFY_CHECKOUT_CARRIER_ACCOUNTS',
  'Checkout provider attempts must use unique carrier accounts',
  "attempt.status === 'degraded' && matchingOffers.length > 0",
  "planningMethod === 'unit_material_selection'",
  "'SHOPIFY_CHECKOUT_UNIT_MATERIAL_SHAPE_INVALID'",
  'Each unit-material package must allocate exactly one line unit',
], 'account-keyed bounded carrier attempt completion')
assert.equal(
  completionNormalization.includes(
    "attempt.status === 'succeeded' && matchingOffers.length < 1",
  ),
  false,
  'a succeeded account may lose public service-code deduplication',
)
includes(receiptClaim, [
  'readConfigRowWithClient(client, input)',
  'checkoutReceiptClaimConfig(configRow)',
  'receiptGlobalId: reclaimed.rows[0].global_id',
  'receiptGlobalId: inserted.rows[0].global_id',
], 'latency-bounded checkout receipt claim')
includes(receiptClaim, [
  'statementTimeoutMs: SHOPIFY_CHECKOUT_CLAIM_STATEMENT_TIMEOUT_MS',
  'signal: input.signal',
], 'claim-only persistence deadline options')
assert.equal(
  section(
    persistenceSource,
    'export async function completeShopifyCheckoutRateReceiptInPostgres',
    'export async function failShopifyCheckoutRateReceiptInPostgres',
    'checkout receipt completion transaction',
  ).includes('SHOPIFY_CHECKOUT_CLAIM_STATEMENT_TIMEOUT_MS'),
  false,
  'Receipt completion must retain the default persistence statement timeout',
)
assert.equal(
  receiptClaim.includes('readConfigWithClient(client, input)'),
  false,
  'receipt claim must not hydrate configuration children',
)
assert.equal(
  receiptClaim.includes('readReceiptByGlobalId(client, {'),
  false,
  'new and reclaimed receipt claims must not hydrate terminal receipt children',
)
includes(persistenceSource, [
  'SHOPIFY_CHECKOUT_PERSISTENCE_STATEMENT_TIMEOUT_MS = 500',
  'SHOPIFY_CHECKOUT_CLAIM_STATEMENT_TIMEOUT_MS = 750',
  'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_MAX_ATTEMPTS = 2',
  "'40001'",
  "'40P01'",
  "'55P03'",
  "'57014'",
  "'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_DB_TIMEOUT'",
  "'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_CANCELLED'",
  "'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_LOCK_TIMEOUT'",
  "'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_RETRY_EXHAUSTED'",
], 'bounded checkout receipt claim database retry policy')
const deadlineTransaction = section(
  persistenceSource,
  'async function acquireShopifyCheckoutClient(',
  'function postgresSqlState(',
  'checkout deadline transaction',
)
includes(deadlineTransaction, [
  'Promise.race([connection, fence])',
  'lateClient.release()',
  "await client.query('BEGIN')",
  "await client.query('COMMIT')",
  "await client.query('ROLLBACK')",
  'commitBufferMs: 25',
], 'bounded checkout claim transaction lifecycle')
assert.equal(
  section(
    deadlineTransaction,
    "await client.query('COMMIT')",
    'return result',
    'committed checkout claim return',
  ).includes('requirePersistenceAvailable'),
  false,
  'A resolved COMMIT must return its durable claim without a late deadline error',
)
includes(receiptClaimRetry, [
  'normalizeShopifyCheckoutReceiptClaimInput(rawInput)',
  'claimShopifyCheckoutRateReceiptOnceInPostgres(input)',
  'executeShopifyCheckoutReceiptClaimWithRetry({',
  'signal: input.signal',
], 'deadline-fenced checkout receipt claim retry')

const configProjection = section(
  persistenceSource,
  'const CONFIG_SELECT = `SELECT',
  'async function readConfigChildren(',
  'CarrierService config projection',
)
includes(configProjection, [
  'config.checkout_brand_name_override',
  'config.registered_service_name',
  "config.registration_state = 'shadow_simulated'",
  "config.registration_state = 'registered'",
  'config.registered_service_name IS NOT DISTINCT FROM',
  "btrim(config.checkout_brand_name_override)",
  "account.configuration ->> 'accountName'",
], 'applied-vs-desired CarrierService config readiness')

const overrideUpdate = section(
  persistenceSource,
  'export async function updateShopifyCarrierServiceBrandNameOverrideInPostgres',
  'export async function upsertShopifyCarrierServiceConfigInPostgres',
  'checkout-name override update',
)
includes(overrideUpdate, [
  'shopify-carrier-service-authorization:',
  'shopify-carrier-service-config:',
  'current.rowVersion !== input.expectedRowVersion',
  'current.checkoutBrandNameOverride',
  '=== input.checkoutBrandNameOverride',
  'operations_shopify_carrier_service_mutation_authorizations',
  'authorized_mutation.config_row_version = $3::bigint',
  "outcome.outcome = 'failed'",
  'outcome.provider_write_count = 0',
  "resolution.disposition = 'confirmed_not_applied'",
  "'SHOPIFY_CHECKOUT_BRAND_NAME_AUTHORIZATION_ACTIVE'",
  'SET checkout_brand_name_override = $3',
  'row_version = row_version + 1',
  'priorOverride: current.checkoutBrandNameOverride',
  'newOverride: input.checkoutBrandNameOverride',
], 'serialized row-fenced checkout-name override update')
assert.ok(
  overrideUpdate.indexOf('shopify-carrier-service-authorization:')
    < overrideUpdate.indexOf('readConfigWithClient(client, input)'),
  'override writes must obtain the provider-authorization lock before reading the fenced config row',
)

const callbackAccountLookup = persistenceSource.slice(
  persistenceSource.indexOf(
    'lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres',
  ),
  persistenceSource.indexOf('const RECEIPT_SELECT'),
)
includes(callbackAccountLookup, [
  'CASE',
  "WHEN config.registration_state = 'registered'",
  'THEN config.registered_service_name',
  'ELSE COALESCE(',
  'btrim(config.checkout_brand_name_override)',
  "account.configuration ->> 'accountName'",
  'END AS store_entity_name',
  "config.registration_state = 'registered'",
  'config.registered_service_name IS NOT DISTINCT FROM',
  '$3::boolean = true',
  "config.registration_state = 'shadow_simulated'",
], 'callback applied-name authority')
assert.equal(
  callbackAccountLookup.includes('account.display_name'),
  false,
  'checkout rate branding must not fall back to an editable connection label',
)
assert.ok(
  callbackAccountLookup.indexOf(
    'THEN config.registered_service_name',
  ) < callbackAccountLookup.indexOf(
    'ELSE COALESCE(',
  ),
  'registered callbacks must use provider-applied name evidence before any desired-name fallback',
)

const {
  ShopifyCheckoutRatingPersistenceError,
  SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION,
  SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION_CURRENT,
  SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION_V2,
  executeShopifyCheckoutReceiptClaimWithRetry,
  hydrateShopifyCheckoutRateReceiptLine,
  normalizeShopifyCarrierServiceConfigInput,
  normalizeShopifyCheckoutReceiptClaimInput,
  normalizeShopifyCheckoutReceiptLineSnapshotV1,
  normalizeShopifyCheckoutReceiptLineSnapshotV2,
  readShopifyCheckoutReceiptLineSnapshotEvidence,
  classifyShopifyCheckoutRateReconciliationOutcome,
  reconcileShopifyCheckoutRateForOrderCandidateWithClient,
  shopifyCheckoutRateLineageIsRequired,
  shopifyCheckoutRateOutcomeAllowsFulfillment,
  shopifyCheckoutPackagePlanHash,
  shopifyCheckoutReceiptClaimRetryDisposition,
  shopifyCheckoutLineQuantityFingerprint,
  shopifyCheckoutRatingHash,
} = persistence

const claimDeadline = '2026-07-31T22:00:08.250Z'
assert.equal(
  shopifyCheckoutReceiptClaimRetryDisposition({
    error: {
      code: '57014',
      message: 'canceling statement due to statement timeout',
    },
    attempt: 1,
    deadlineAt: claimDeadline,
    nowMs: Date.parse('2026-07-31T22:00:01.000Z'),
  }).retry,
  true,
  'A first statement timeout receives one bounded receipt-claim retry',
)
assert.equal(
  shopifyCheckoutReceiptClaimRetryDisposition({
    error: {
      code: '57014',
      message: 'canceling statement due to statement timeout',
    },
    attempt: 2,
    deadlineAt: claimDeadline,
    nowMs: Date.parse('2026-07-31T22:00:02.000Z'),
  }).reasonCode,
  'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_DB_TIMEOUT',
  'An exhausted statement timeout maps to a safe fixed reason',
)
assert.equal(
  shopifyCheckoutReceiptClaimRetryDisposition({
    error: { code: '55P03' },
    attempt: 2,
    deadlineAt: claimDeadline,
    nowMs: Date.parse('2026-07-31T22:00:02.000Z'),
  }).reasonCode,
  'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_LOCK_TIMEOUT',
  'An exhausted lock timeout maps to a safe fixed reason',
)
assert.equal(
  shopifyCheckoutReceiptClaimRetryDisposition({
    error: { code: '40001' },
    attempt: 2,
    deadlineAt: claimDeadline,
    nowMs: Date.parse('2026-07-31T22:00:02.000Z'),
  }).reasonCode,
  'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_RETRY_EXHAUSTED',
  'An exhausted serialization retry maps to a safe fixed reason',
)
assert.equal(
  shopifyCheckoutReceiptClaimRetryDisposition({
    error: {
      code: '57014',
      message: 'canceling statement due to statement timeout',
    },
    attempt: 1,
    deadlineAt: claimDeadline,
    nowMs: Date.parse(claimDeadline),
  }).reasonCode,
  'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
  'The callback deadline always wins over a database retry',
)
assert.equal(
  shopifyCheckoutReceiptClaimRetryDisposition({
    error: {
      code: '57014',
      message: 'canceling statement due to user request',
    },
    attempt: 1,
    deadlineAt: claimDeadline,
    nowMs: Date.parse('2026-07-31T22:00:02.000Z'),
  }).reasonCode,
  'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_CANCELLED',
  'An external query cancellation is classified without replay',
)
assert.equal(
  shopifyCheckoutReceiptClaimRetryDisposition({
    error: { code: 'SHOPIFY_CHECKOUT_CONTEXT_STALE' },
    attempt: 1,
    deadlineAt: claimDeadline,
    nowMs: Date.parse('2026-07-31T22:00:02.000Z'),
  }).reasonCode,
  null,
  'Application and unknown errors are never retried as database contention',
)

let transientClaimAttempts = 0
assert.equal(
  await executeShopifyCheckoutReceiptClaimWithRetry({
    deadlineAt: '2099-07-31T22:00:08.250Z',
    executeAttempt: async () => {
      transientClaimAttempts += 1
      if (transientClaimAttempts === 1) {
        throw Object.assign(
          new Error('canceling statement due to statement timeout'),
          { code: '57014' },
        )
      }
      return 'claimed'
    },
  }),
  'claimed',
  'A transient first receipt-claim transaction is replayed exactly once',
)
assert.equal(
  transientClaimAttempts,
  2,
  'The recovered receipt claim executes exactly two whole transactions',
)
let nonTransientClaimAttempts = 0
await assert.rejects(
  executeShopifyCheckoutReceiptClaimWithRetry({
    deadlineAt: '2099-07-31T22:00:08.250Z',
    executeAttempt: async () => {
      nonTransientClaimAttempts += 1
      throw Object.assign(new Error('stale'), {
        code: 'SHOPIFY_CHECKOUT_CONTEXT_STALE',
      })
    },
  }),
  (error) => error.code === 'SHOPIFY_CHECKOUT_CONTEXT_STALE',
  'A non-transient claim error is returned without replay',
)
assert.equal(
  nonTransientClaimAttempts,
  1,
  'A non-transient receipt claim executes only one transaction',
)

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
  ]
  const equivalentReceiptGlobalIds = selected
    ? [selected.receipt_global_id, 'gsqr9999999']
    : []
  if (selected) {
    responses.push({
      rows: equivalentReceiptGlobalIds.map((receiptGlobalId) => ({
        receipt_global_id: receiptGlobalId,
      })),
    })
  }
  responses.push({ rows: [insertedRow] })
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
  assert.equal(queries.length, selected ? 6 : 5)
  assert.match(
    queries[0].sql,
    /operations_shopify_checkout_rate_current_reconciliations/,
  )
  if (selected) {
    assert.match(
      queries[4].sql,
      /operations_shopify_checkout_rate_match_family_members/,
    )
  }
  const insertQuery = queries.at(-1)
  assert.match(
    insertQuery.sql,
    /INSERT INTO operations_shopify_checkout_rate_reconciliations/,
  )
  assert.equal(insertQuery.values[20], expectedOutcome)
  assert.deepEqual(
    JSON.parse(insertQuery.values[22]).equivalentReceiptGlobalIds,
    equivalentReceiptGlobalIds,
  )
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

const completedShadowReplaySource = section(
  operationsSource,
  'async function completedShadowFulfillmentExecutionResult(',
  'function shadowExecutionDestination(',
  'Completed Shadow fulfillment replay',
)
includes(completedShadowReplaySource, [
  "'result_global_id' | 'result_payload'",
  'receipt.result_global_id',
  'payload.fulfillmentExecutionGlobalId',
  'fulfillment_run.selected_carrier_account_id',
  'shipment_group.selected_carrier_account_id',
  'operations_fulfillment_execution_rate_attempts attempt',
  'rate_evidence.id = attempt.carrier_rate_request_id',
  'rate_evidence.provider = attempt.carrier_provider',
  'rate_evidence.carrier_account_id = attempt.carrier_account_id',
  'retained.carrier_provider === attempt.provider',
  'retained.rate_evidence_global_id === attempt.rateEvidenceGlobalId',
  'retained.attempt_status === attempt.status',
  'retained.failure_code === (attempt.failureCode ?? null)',
  'matchedAttemptKeys.has(exactKey)',
  'attempt.carrierAccountGlobalId',
  '!== exact.carrier_account_global_id',
  'providerAttempts.length !== exactAttempts.length',
  'carrierAccountGlobalId: exact.carrier_account_global_id',
  'carrierAccountGlobalId,',
  'providerAttempts,',
], 'Completed Shadow fulfillment exact-account replay')
assert.doesNotMatch(
  completedShadowReplaySource,
  /retained\.carrier_provider === attempt\.provider\s*\)\)/u,
  'same-provider replay must also bind each attempt to its distinct immutable rate-evidence row',
)
assert.match(
  completedShadowReplaySource,
  /typeof attempt\.carrierAccountGlobalId === 'string'[\s\S]*attempt\.carrierAccountGlobalId[\s\S]*!== exact\.carrier_account_global_id/u,
  'a tampered preexisting per-attempt carrier account must fail replay instead of being silently overwritten',
)

function loadCompletedShadowReplay(exactRows) {
  const harnessSource = `
type QueryResultRow = Record<string, unknown>
type CommandReceiptRow = {
  result_global_id: string | null
  result_payload: Record<string, unknown> | null
}
type OperationsShadowFulfillmentExecutionResult = Record<string, unknown>
const CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS = 8
class OperationsRequestError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}
const exactRows = ${JSON.stringify(exactRows)}
async function query<T>(): Promise<{ rows: T[] }> {
  return { rows: exactRows as T[] }
}
${completedShadowReplaySource}
module.exports = completedShadowFulfillmentExecutionResult
`
  const output = ts.transpileModule(harnessSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: 'completed-shadow-replay-harness.ts',
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Error,
    Map,
    Object,
    Promise,
    Set,
    String,
    exports: module.exports,
    module,
  }, { filename: 'completed-shadow-replay-harness.ts' })
  return module.exports
}

const sameProviderReplayRows = [
  {
    selected_carrier_account_global_id: 'gach00000000001',
    carrier_provider: 'ups_rest',
    carrier_account_global_id: 'gach00000000001',
    attempt_status: 'succeeded',
    failure_code: null,
    rate_evidence_global_id: 'grq00000000001',
    selected: true,
  },
  {
    selected_carrier_account_global_id: 'gach00000000001',
    carrier_provider: 'ups_rest',
    carrier_account_global_id: 'gach00000000003',
    attempt_status: 'degraded',
    failure_code: 'UPS_RATE_TIMEOUT',
    rate_evidence_global_id: 'grq00000000002',
    selected: false,
  },
]
const completedShadowReplay = loadCompletedShadowReplay(
  sameProviderReplayRows,
)
const legacyReplayPayload = {
  orderGlobalId: 'gor00000000001',
  orderStatus: 'packed',
  fulfillmentExecutionGlobalId: 'gofe00000000001',
  shipmentGroupGlobalId: 'gshg00000000001',
  providerAttempts: [
    {
      provider: 'ups_rest',
      status: 'succeeded',
      failureCode: null,
      rateEvidenceGlobalId: 'grq00000000001',
    },
    {
      provider: 'ups_rest',
      status: 'degraded',
      failureCode: 'UPS_RATE_TIMEOUT',
      rateEvidenceGlobalId: 'grq00000000002',
    },
  ],
}
const rehydratedLegacyReplay = await completedShadowReplay(
  '28500000-0000-4000-8000-000000000001',
  {
    result_global_id: 'gofe00000000001',
    result_payload: legacyReplayPayload,
  },
)
assert.equal(
  rehydratedLegacyReplay.carrierAccountGlobalId,
  'gach00000000001',
  'legacy completed replay must restore the selected exact carrier account',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(rehydratedLegacyReplay.providerAttempts)),
  [
    {
      provider: 'ups_rest',
      carrierAccountGlobalId: 'gach00000000001',
      status: 'succeeded',
      failureCode: null,
      rateEvidenceGlobalId: 'grq00000000001',
    },
    {
      provider: 'ups_rest',
      carrierAccountGlobalId: 'gach00000000003',
      status: 'degraded',
      failureCode: 'UPS_RATE_TIMEOUT',
      rateEvidenceGlobalId: 'grq00000000002',
    },
  ],
  'two legacy same-provider attempts must rehydrate to their distinct immutable accounts',
)
await assert.rejects(
  completedShadowReplay(
    '28500000-0000-4000-8000-000000000001',
    {
      result_global_id: 'gofe00000000001',
      result_payload: {
        ...legacyReplayPayload,
        providerAttempts: [
          {
            ...legacyReplayPayload.providerAttempts[0],
            carrierAccountGlobalId: 'gach00000000003',
          },
          legacyReplayPayload.providerAttempts[1],
        ],
      },
    },
  ),
  (error) => (
    error?.code === 'OPERATIONS_COMMAND_RECEIPT_INVALID'
    && /no longer match exact evidence/u.test(error.message)
  ),
  'a tampered existing per-attempt account must fail completed replay',
)

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
const sameProviderCarriers = normalizeShopifyCarrierServiceConfigInput({
  ...validConfig,
  carriers: [
    { provider: 'ups_rest', carrierAccountGlobalId: 'gac0000003' },
    { provider: 'ups_rest', carrierAccountGlobalId: 'gac0000001' },
  ],
})
assert.deepEqual(
  JSON.parse(JSON.stringify(sameProviderCarriers.carriers)),
  [
    { provider: 'ups_rest', carrierAccountGlobalId: 'gac0000001' },
    { provider: 'ups_rest', carrierAccountGlobalId: 'gac0000003' },
  ],
  'multiple exact accounts for the same provider must be accepted and sorted',
)
const maxCarrierBindings = Array.from({ length: 16 }, (_, index) => ({
  provider: index < 8 ? 'ups_rest' : 'fedex_rest',
  carrierAccountGlobalId: `gac${String(index + 1).padStart(7, '0')}`,
}))
assert.equal(
  normalizeShopifyCarrierServiceConfigInput({
    ...validConfig,
    carriers: maxCarrierBindings,
  }).carriers.length,
  16,
  'paired sets totaling sixteen exact direct carrier accounts must be accepted',
)
assert.throws(
  () => normalizeShopifyCarrierServiceConfigInput({
    ...validConfig,
    carriers: [
      ...maxCarrierBindings,
      { provider: 'ups_rest', carrierAccountGlobalId: 'gac0000017' },
    ],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_CARRIER_BINDINGS_INVALID'
  ),
  'a seventeenth configured direct carrier account must be rejected',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(normalizedConfig.carriers)),
  [
    { provider: 'fedex_rest', carrierAccountGlobalId: 'gac0000002' },
    { provider: 'ups_rest', carrierAccountGlobalId: 'gac0000001' },
  ],
)
for (const carrier of validConfig.carriers) {
  const oneCarrier = normalizeShopifyCarrierServiceConfigInput({
    ...validConfig,
    carriers: [carrier],
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(oneCarrier.carriers)),
    [carrier],
    `${carrier.provider} must be independently valid for checkout rating`,
  )
}
assert.throws(
  () => normalizeShopifyCarrierServiceConfigInput({
    ...validConfig,
    carriers: [],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_CARRIER_BINDINGS_INVALID'
  ),
)

includes(configuredCarrierMigration, [
  'PRIMARY KEY (organization_id, config_id, carrier_account_id)',
  'PRIMARY KEY (organization_id, receipt_id, carrier_account_id)',
  'operations_shopify_carrier_service_config_environment_is_ready(',
  "config.id, 'sandbox'",
  "config.id, 'production'",
  "carrier_account.registered_address ->> 'line1'",
  "warehouse.address ->> 'line1'",
  ') BETWEEN 1 AND 16',
  ') BETWEEN 1 AND 8',
  'expected_account_count NOT BETWEEN 1 AND 8',
  "WHEN 'shadow' THEN 'sandbox'",
  "WHEN 'active' THEN 'production'",
  "'clawpilot.shopify_carrier_binding_write_token'",
  'degraded_attempt_with_offer_count',
], 'paired environment account-keyed configured-carrier migration')
assert.equal(
  configuredCarrierMigration.includes(
    'successful_attempt_without_offer_count',
  ),
  false,
  '0285 finalization must allow a successful losing account without an offer',
)
assert.throws(
  () => normalizeShopifyCarrierServiceConfigInput({
    ...validConfig,
    carriers: [
      validConfig.carriers[0],
      {
        provider: 'ups_rest',
        carrierAccountGlobalId: 'gac0000001',
      },
    ],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_CARRIER_BINDINGS_INVALID'
  ),
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
  rateSource: 'sandbox',
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
      lineSnapshot: {
        snapshotVersion: SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION,
        productGid: 'gid://shopify/Product/2',
        variantGid: 'gid://shopify/ProductVariant/2',
        productGlobalId: 'gp0000002',
        packMappingGlobalId: 'gcvm0000002',
        packMappingRowVersion: 3,
        packEvidenceHash: '2'.repeat(64),
        packProfileVersionGlobalId: 'gppv0000002',
        packProfileVersionRowVersion: 5,
        packageLevel: 'each',
        baseEachQuantity: 1,
        shipsAsOwnPackage: false,
        inventoryLevelGlobalIds: ['giil0000002'],
        quantity: 1,
        unitWeightGrams: 200,
      },
    },
    {
      lineKey: 'line-a',
      providerVariantId: 'gid://shopify/ProductVariant/1',
      sku: 'SKU-1',
      quantity: 3,
      unitWeightGrams: 100,
      requiresShipping: true,
      lineSnapshot: {
        snapshotVersion: SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION,
        productGid: 'gid://shopify/Product/1',
        variantGid: 'gid://shopify/ProductVariant/1',
        productGlobalId: 'gp0000001',
        packMappingGlobalId: 'gcvm0000001',
        packMappingRowVersion: 2,
        packEvidenceHash: '1'.repeat(64),
        packProfileVersionGlobalId: 'gppv0000001',
        packProfileVersionRowVersion: 4,
        packageLevel: 'inner_pack',
        baseEachQuantity: 12,
        shipsAsOwnPackage: false,
        inventoryLevelGlobalIds: ['giil0000001'],
        quantity: 3,
        unitWeightGrams: 100,
      },
    },
  ],
}
const normalizedClaim = normalizeShopifyCheckoutReceiptClaimInput(validClaim)
assert.equal(normalizedClaim.currency, 'USD')
const retryCacheKey = `shopify-rate:${'a'.repeat(64)}`
const normalizedRetryClaim = normalizeShopifyCheckoutReceiptClaimInput({
  ...validClaim,
  cacheKey: retryCacheKey,
  idempotencyKey: `${retryCacheKey}:attempt:42`,
})
assert.equal(normalizedRetryClaim.cacheKey, retryCacheKey)
assert.equal(
  normalizedRetryClaim.idempotencyKey,
  `${retryCacheKey}:attempt:42`,
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    cacheKey: retryCacheKey,
    idempotencyKey: `shopify-rate:${'b'.repeat(64)}:attempt:42`,
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_ATTEMPT_KEY_INVALID'
  ),
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    normalizedClaim.lines.map((line) => line.lineKey),
  )),
  ['line-a', 'line-b'],
)
assert.equal(
  normalizedClaim.lines[0].lineSnapshot.snapshotVersion,
  SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION,
)
assert.equal(
  normalizedClaim.lines[0].lineSnapshot.packEvidenceHash,
  '1'.repeat(64),
)
assert.equal(
  normalizeShopifyCheckoutReceiptClaimInput(validClaim).lines[0].lineHash,
  normalizedClaim.lines[0].lineHash,
  'An unchanged versioned pack snapshot produces a stable line hash',
)
assert.notEqual(
  normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    lines: [{
      ...validClaim.lines[1],
      lineSnapshot: {
        ...validClaim.lines[1].lineSnapshot,
        packEvidenceHash: '3'.repeat(64),
      },
    }],
  }).lines[0].lineHash,
  normalizedClaim.lines[0].lineHash,
  'A changed pack-evidence fingerprint changes immutable line evidence',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    readShopifyCheckoutReceiptLineSnapshotEvidence(
      validClaim.lines[1].lineSnapshot,
    ),
  )),
  {
    snapshotVersion: SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION,
    cartonizationAuthority: 'product_pack',
    packEvidenceHash: '1'.repeat(64),
  },
  'Known receipt line snapshots expose their immutable pack fingerprint',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    normalizeShopifyCheckoutReceiptLineSnapshotV1({
      ...validClaim.lines[1].lineSnapshot,
      inventoryLevelGlobalIds: ['giil0000003', 'giil0000001'],
    }),
  )),
  {
    ...validClaim.lines[1].lineSnapshot,
    inventoryLevelGlobalIds: ['giil0000001', 'giil0000003'],
  },
  'Known v1 snapshots normalize their complete callback evidence shape',
)
assert.equal(
  SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION_CURRENT,
  SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION_V2,
  'The explicit current snapshot alias points to V2 without changing the V1 compatibility export',
)
const validV2ProductPackSnapshot = {
  snapshotVersion: SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION_CURRENT,
  cartonizationAuthority: 'product_pack',
  productGid: 'gid://shopify/Product/1',
  variantGid: 'gid://shopify/ProductVariant/1',
  productGlobalId: 'gp0000001',
  productMappingGlobalId: 'gpm0000001',
  channelSourceRevision: '2026-08-26T12:00:00.000Z',
  channelSourceHash: '4'.repeat(64),
  packMappingGlobalId: 'gcvm0000001',
  packMappingRowVersion: 2,
  packEvidenceHash: '1'.repeat(64),
  packProfileVersionGlobalId: 'gppv0000001',
  packProfileVersionRowVersion: 4,
  packageLevel: 'inner_pack',
  baseEachQuantity: 12,
  shipsAsOwnPackage: false,
  inventoryLevelGlobalIds: ['giil0000003', 'giil0000001'],
  quantity: 3,
  unitWeightGrams: 100,
}
assert.deepEqual(
  JSON.parse(JSON.stringify(
    normalizeShopifyCheckoutReceiptLineSnapshotV2(
      validV2ProductPackSnapshot,
    ),
  )),
  {
    ...validV2ProductPackSnapshot,
    inventoryLevelGlobalIds: ['giil0000001', 'giil0000003'],
  },
  'V2 product-pack snapshots retain exact mapping and channel evidence',
)
const validV2UnitMaterialSnapshot = {
  snapshotVersion: SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION_CURRENT,
  cartonizationAuthority: 'unit_material_selection',
  productGid: 'gid://shopify/Product/2',
  variantGid: 'gid://shopify/ProductVariant/2',
  productGlobalId: 'gp0000002',
  productMappingGlobalId: 'gpm0000002',
  channelSourceRevision: '2026-08-26T12:01:00.000Z',
  channelSourceHash: '5'.repeat(64),
  packMappingGlobalId: null,
  packMappingRowVersion: null,
  packEvidenceHash: null,
  packProfileVersionGlobalId: null,
  packProfileVersionRowVersion: null,
  packageLevel: 'each',
  baseEachQuantity: 1,
  shipsAsOwnPackage: false,
  inventoryLevelGlobalIds: ['giil0000002'],
  quantity: 1,
  unitWeightGrams: 200,
}
assert.deepEqual(
  JSON.parse(JSON.stringify(
    readShopifyCheckoutReceiptLineSnapshotEvidence(
      validV2UnitMaterialSnapshot,
    ),
  )),
  {
    snapshotVersion: SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION_V2,
    cartonizationAuthority: 'unit_material_selection',
    packEvidenceHash: null,
  },
  'V2 unit-material snapshots remain readable without Product-pack evidence',
)
const normalizedV2UnitClaim = normalizeShopifyCheckoutReceiptClaimInput({
  ...validClaim,
  lines: [{
    ...validClaim.lines[0],
    lineSnapshot: validV2UnitMaterialSnapshot,
  }],
})
assert.equal(
  normalizedV2UnitClaim.lines[0].lineSnapshot.cartonizationAuthority,
  'unit_material_selection',
  'New receipt claims accept the current V2 unit-material authority',
)
for (const requiredV2Field of [
  'productMappingGlobalId',
  'channelSourceRevision',
  'channelSourceHash',
]) {
  const incompleteSnapshot = { ...validV2UnitMaterialSnapshot }
  delete incompleteSnapshot[requiredV2Field]
  assert.throws(
    () => normalizeShopifyCheckoutReceiptLineSnapshotV2(incompleteSnapshot),
    (error) => error instanceof ShopifyCheckoutRatingPersistenceError,
    `V2 snapshots reject a missing ${requiredV2Field}`,
  )
}
assert.throws(
  () => normalizeShopifyCheckoutReceiptLineSnapshotV2({
    ...validV2UnitMaterialSnapshot,
    packEvidenceHash: '6'.repeat(64),
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_INVALID'
  ),
  'Unit-material authority rejects partial or invented Product-pack evidence',
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptLineSnapshotV2({
    ...validV2ProductPackSnapshot,
    packProfileVersionGlobalId: null,
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_INVALID'
  ),
  'Product-pack authority requires the complete exact Product-pack evidence set',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    readShopifyCheckoutReceiptLineSnapshotEvidence({
      merchandiseKey: 'legacy-variant',
    }),
  )),
  {
    snapshotVersion: null,
    cartonizationAuthority: null,
    packEvidenceHash: null,
  },
  'Historical receipts without snapshot metadata remain readable as unknown',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    readShopifyCheckoutReceiptLineSnapshotEvidence({
      snapshotVersion: 'shopify-checkout-line-pack-evidence-v3',
      packEvidenceHash: 'a'.repeat(64),
    }),
  )),
  {
    snapshotVersion: null,
    cartonizationAuthority: null,
    packEvidenceHash: null,
  },
  'Unknown future snapshot versions are not interpreted using current rules',
)
assert.throws(
  () => readShopifyCheckoutReceiptLineSnapshotEvidence({
    ...validClaim.lines[1].lineSnapshot,
    packEvidenceHash: 'invalid',
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_IDENTIFIER_INVALID'
  ),
  'A stored snapshot that claims v1 but has malformed evidence fails closed',
)
const hydratedLine = hydrateShopifyCheckoutRateReceiptLine({
  ...normalizedClaim.lines[0],
  lineSnapshot: normalizedClaim.lines[0].lineSnapshot,
})
assert.equal(
  hydratedLine.snapshotVersion,
  SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION,
)
assert.equal(hydratedLine.cartonizationAuthority, 'product_pack')
assert.equal(hydratedLine.packEvidenceHash, '1'.repeat(64))
assert.deepEqual(
  JSON.parse(JSON.stringify(hydratedLine.lineSnapshot)),
  JSON.parse(JSON.stringify(normalizedClaim.lines[0].lineSnapshot)),
  'Hydration exposes complete normalized evidence only after hash validation',
)
assert.throws(
  () => hydrateShopifyCheckoutRateReceiptLine({
    ...normalizedClaim.lines[0],
    lineSnapshot: {
      ...normalizedClaim.lines[0].lineSnapshot,
      packEvidenceHash: '9'.repeat(64),
    },
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_LINE_HASH_MISMATCH'
  ),
  'Receipt hydration rejects a snapshot that differs from its immutable line hash',
)
const historicalLineSnapshot = { merchandiseKey: 'legacy-variant' }
const historicalRetainedLine = {
  lineKey: 'legacy-line',
  providerVariantId: 'gid://shopify/ProductVariant/9',
  sku: null,
  quantity: 1,
  unitWeightGrams: 50,
  requiresShipping: true,
  lineSnapshot: historicalLineSnapshot,
}
const historicalHydratedLine = hydrateShopifyCheckoutRateReceiptLine({
  ...historicalRetainedLine,
  lineHash: shopifyCheckoutRatingHash(historicalRetainedLine),
})
assert.equal(historicalHydratedLine.snapshotVersion, null)
assert.equal(historicalHydratedLine.cartonizationAuthority, null)
assert.equal(historicalHydratedLine.packEvidenceHash, null)
assert.deepEqual(
  JSON.parse(JSON.stringify(historicalHydratedLine.lineSnapshot)),
  historicalLineSnapshot,
  'Historical snapshots without a known version and hash hydrate as unknown',
)
const v2UnitRetainedLine = {
  lineKey: 'unit-material-line',
  providerVariantId: validV2UnitMaterialSnapshot.variantGid,
  sku: null,
  quantity: validV2UnitMaterialSnapshot.quantity,
  unitWeightGrams: validV2UnitMaterialSnapshot.unitWeightGrams,
  requiresShipping: true,
  lineSnapshot: validV2UnitMaterialSnapshot,
}
const v2UnitHydratedLine = hydrateShopifyCheckoutRateReceiptLine({
  ...v2UnitRetainedLine,
  lineHash: shopifyCheckoutRatingHash(v2UnitRetainedLine),
})
assert.equal(
  v2UnitHydratedLine.snapshotVersion,
  SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION_V2,
)
assert.equal(
  v2UnitHydratedLine.cartonizationAuthority,
  'unit_material_selection',
)
assert.equal(v2UnitHydratedLine.packEvidenceHash, null)
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
for (const requiredSnapshotField of [
  'snapshotVersion',
  'productGid',
  'variantGid',
  'productGlobalId',
  'packMappingGlobalId',
  'packMappingRowVersion',
  'packEvidenceHash',
  'packProfileVersionGlobalId',
  'packProfileVersionRowVersion',
  'packageLevel',
  'baseEachQuantity',
  'shipsAsOwnPackage',
  'inventoryLevelGlobalIds',
  'quantity',
  'unitWeightGrams',
]) {
  const incompleteSnapshot = { ...validClaim.lines[1].lineSnapshot }
  delete incompleteSnapshot[requiredSnapshotField]
  assert.throws(
    () => normalizeShopifyCheckoutReceiptClaimInput({
      ...validClaim,
      lines: [{
        ...validClaim.lines[1],
        lineSnapshot: incompleteSnapshot,
      }],
    }),
    (error) => error instanceof ShopifyCheckoutRatingPersistenceError,
    `New v1 claims reject a missing ${requiredSnapshotField}`,
  )
}
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    lines: [{
      ...validClaim.lines[1],
      lineSnapshot: {
        ...validClaim.lines[1].lineSnapshot,
        inventoryLevelGlobalIds: [],
      },
    }],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_INVALID'
  ),
  'New v1 claims reject an empty inventory-level evidence set',
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    lines: [{
      ...validClaim.lines[1],
      lineSnapshot: {
        ...validClaim.lines[1].lineSnapshot,
        quantity: validClaim.lines[1].quantity + 1,
      },
    }],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_MISMATCH'
  ),
  'New v1 claims reject a snapshot that disagrees with its line quantity',
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    lines: [{
      ...validClaim.lines[0],
      lineSnapshot: {
        ...validClaim.lines[0].lineSnapshot,
        snapshotVersion: 'shopify-checkout-line-pack-evidence-v3',
      },
    }],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_VERSION_INVALID'
  ),
  'New receipt claims reject future line snapshot versions',
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    lines: [{
      ...validClaim.lines[0],
      lineSnapshot: {
        ...validClaim.lines[0].lineSnapshot,
        packEvidenceHash: 'not-a-pack-evidence-hash',
      },
    }],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_IDENTIFIER_INVALID'
  ),
  'New receipt claims reject malformed pack-evidence fingerprints',
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    lines: [{
      ...validClaim.lines[0],
      lineSnapshot: {
        packEvidenceHash: validClaim.lines[0].lineSnapshot.packEvidenceHash,
      },
    }],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_VERSION_INVALID'
  ),
  'New receipt claims reject a missing line snapshot version',
)
assert.throws(
  () => normalizeShopifyCheckoutReceiptClaimInput({
    ...validClaim,
    lines: [{
      ...validClaim.lines[0],
      lineSnapshot: {
        ...validClaim.lines[0].lineSnapshot,
        packEvidenceHash: undefined,
      },
    }],
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_TEXT_INVALID'
  ),
  'New receipt claims reject a missing pack-evidence fingerprint',
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
    rateSource: 'invalid',
  }),
  (error) => (
    error instanceof ShopifyCheckoutRatingPersistenceError
    && error.code === 'SHOPIFY_CHECKOUT_RATE_SOURCE_INVALID'
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
const unitMaterialPackage = {
  packageKey: 'unit-material-1',
  packageSequence: 1,
  planningMethod: 'unit_material_selection',
  materialGlobalId: 'gmat0000001',
  materialRowVersion: 5,
  materialStockGlobalId: 'gmas0000001',
  materialStockRowVersion: 9,
  materialStockOnHandQuantity: 25,
  ratedOuterDimensionsMm: { length: 279, width: 229, height: 178 },
  contentWeightGrams: 200,
  tareWeightGrams: 100,
  allocations: [{ lineKey: 'line-b', quantity: 1 }],
  packageSnapshot: { planningMethod: 'unit_material_selection' },
}
assert.notEqual(
  shopifyCheckoutPackagePlanHash({ packages: [packageOne] }),
  shopifyCheckoutPackagePlanHash({ packages: [selfPackage] }),
  'Package-plan hashing must retain the self-package planning method and profile',
)
assert.notEqual(
  shopifyCheckoutPackagePlanHash({ packages: [packageOne] }),
  shopifyCheckoutPackagePlanHash({ packages: [unitMaterialPackage] }),
  'Package-plan hashing must retain unit-material planner provenance',
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
includes(persistenceSource, [
  'operations_shopify_checkout_rate_match_family_members',
  'equivalentReceiptGlobalIds',
  "'shopify-exact-rate-reconciliation-v2-match-family'",
  "'shopify-material-equivalence-v1'",
  "'latest_before_order'",
], 'Repeated Shopify callback reconciliation evidence')
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

const quoteMatchFamilyFacts = section(
  quoteMatchFamiliesMigration,
  'CREATE OR REPLACE FUNCTION\n  operations_shopify_checkout_rate_match_candidate_facts',
  'CREATE OR REPLACE FUNCTION\n  operations_shopify_checkout_rate_match_candidates',
  'Shopify checkout quote match-family facts',
)
includes(quoteMatchFamilyFacts, [
  "'requestFingerprint', receipt.request_fingerprint",
  "'redactedRequestSnapshot', receipt.redacted_request_snapshot",
  "'configId', receipt.config_id::text",
  "'configRowVersion', receipt.config_row_version",
  "'credentialGeneration', receipt.credential_generation",
  "'activationRevision', receipt.activation_revision",
  "'activationState', receipt.activation_state",
  "'policyRevision', receipt.policy_revision",
  "'policyHash', receipt.policy_hash",
  "'warehouseId', receipt.warehouse_id::text",
  "'algorithmVersion', receipt.algorithm_version",
  "'receiptPackagePlanHash', receipt.package_plan_hash",
  "'carrierProvider', offer.carrier_provider",
  "'carrierAccountId', offer.carrier_account_id::text",
  "'carrierRequestHash', offer.carrier_request_hash",
  "'carrierResponseRateHash', offer.carrier_response_rate_hash",
  "'shopifyServiceCode', offer.shopify_service_code",
  "'serviceCode', offer.service_code",
  "'carrierCostMinor', offer.carrier_cost_minor",
  "'customerChargeMinor', offer.customer_charge_minor",
  "'checkoutAdjustmentMinor', offer.checkout_adjustment_minor",
  "'offerCurrency', offer.currency",
  "'offerPackagePlanHash', offer.package_plan_hash",
], 'Shopify checkout quote material equivalence fences')
assert.doesNotMatch(
  quoteMatchFamilyFacts,
  /request_evidence_hash|inventory_snapshot_(?:hash|at)/,
  'Equivalent repeated callbacks may have different receipt-local request evidence and inventory observation identities',
)
const quoteMatchFamilyRepresentative = section(
  quoteMatchFamiliesMigration,
  'CREATE OR REPLACE FUNCTION\n  operations_shopify_checkout_rate_match_candidates',
  'CREATE OR REPLACE FUNCTION\n  operations_shopify_checkout_rate_match_family_members',
  'Shopify checkout quote match-family representative',
)
includes(quoteMatchFamilyRepresentative, [
  'PARTITION BY facts.match_family_key',
  'facts.receipt_created_at DESC',
  'WHERE ranked.family_rank = 1',
], 'Shopify repeated callback family collapse')
includes(quoteMatchFamiliesMigration, [
  'operations_shopify_checkout_rate_match_family_members',
  'requested_representative_receipt_id',
  'family.match_family_key = facts.match_family_key',
  'ORDER BY facts.receipt_created_at DESC',
], 'Shopify repeated callback family evidence')

for (const path of [
  'db/migrations/0148_operations_commerce_external_effects.sql',
  'db/migrations/0149_operations_shopify_checkout_rating.sql',
  'db/migrations/0157_operations_shopify_checkout_receipt_reuse.sql',
  'db/migrations/0189_operations_shopify_checkout_quote_match_families.sql',
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
