#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

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

const callback = read(
  'app_src/lib/integrations/shopifyCarrierServiceCallback.ts',
)
const context = read(
  'app_src/lib/persistence/shopifyCheckoutContext.ts',
)
const persistence = read(
  'app_src/lib/persistence/shopifyCheckoutRating.ts',
)
const migration = read(
  'db/migrations/0149_operations_shopify_checkout_rating.sql',
)
const mutationMigration = read(
  'db/migrations/0150_operations_shopify_carrier_service_mutation_authorization.sql',
)
const contract = read('docs/modules/distributed-operations.md')

includes(migration, [
  "account.environment = 'sandbox'",
  "carrier_integration.environment = 'sandbox'",
  'Shopify carrier service configuration requires a sandbox Shopify commerce account',
  'Shopify callback carrier binding requires its sandbox provider account',
  'operations_shopify_checkout_rate_receipts_processing_unique',
  'idempotency_key',
  'current_credential.credential_version',
  '= rate_evidence.credential_version',
], 'PostgreSQL sandbox and receipt fences')

const processingIndex = section(
  migration,
  'CREATE UNIQUE INDEX\n'
    + '  operations_shopify_checkout_rate_receipts_processing_unique',
  'CREATE TABLE IF NOT EXISTS '
    + 'operations_shopify_checkout_rate_receipt_lines',
  'Processing receipt index',
)
assert.ok(
  processingIndex.includes('idempotency_key'),
  'processing receipt uniqueness must include the full execution fence',
)

const replacementConfigTrigger = section(
  mutationMigration,
  'CREATE OR REPLACE FUNCTION\n'
    + '  validate_operations_shopify_carrier_service_config()',
  'COMMENT ON TABLE\n'
    + '  operations_shopify_carrier_service_mutation_authorizations',
  '0150 replacement configuration trigger',
)
includes(replacementConfigTrigger, [
  "TG_OP = 'INSERT'",
  "NEW.registration_state IN ('shadow_simulated', 'registered')",
  "account_environment IS DISTINCT FROM 'sandbox'",
  'New Shopify CarrierService configuration and registration are sandbox-only',
], '0150 sandbox-only setup fence')

includes(context, [
  'stock.row_version::text AS stock_row_version',
  'stockRowVersion: number',
  'stockRowVersion,',
], 'Packaging stock generation fence')

includes(persistence, [
  'credentialVersion: number',
  'credential.credential_version',
  'rate_evidence.credential_version',
  "account.account_environment !== 'sandbox'",
  "integration.environment = 'sandbox'",
  "AND account.environment = 'sandbox'",
  "'SHOPIFY_CHECKOUT_SANDBOX_REQUIRED'",
  'idempotencyKey: string',
  'AND receipt.idempotency_key = $5',
  'AND receipt.idempotency_key = $11',
], 'Persistence sandbox, credential, and exact-cache fences')

includes(callback, [
  "version: 'shopify-checkout-idempotency-v2'",
  "version: 'shopify-checkout-execution-fence-v2'",
  "account.environment !== 'sandbox'",
  "carrier.environment === 'sandbox'",
  'materialRowVersion: material.rowVersion',
  'stockRowVersion: material.stockRowVersion',
  'stockOnHandQuantity: material.stockOnHandQuantity',
  'credentialVersion: carrier.credentialVersion',
  'cartonizationInputHash: shopifyCheckoutRatingHash(context.input)',
  'executionFenceHash,',
  'idempotencyKey,',
  'cached,\n        shadowGuard.customerLabel,',
  'claim.receipt,\n        shadowGuard.customerLabel,',
  'completed,\n      shadowGuard.customerLabel,',
], 'Callback sandbox and execution cache fences')

const typedResponse = section(
  callback,
  'function responseFromTypedReceipt(',
  'function deliveryTimestamp(',
  'Typed cached response reconstruction',
)
includes(typedResponse, [
  'shopifyCheckoutPackagePlanHash({ packages: receipt.packages })',
  'receipt.offers.map((offer)',
  'parcel.materialRowVersion !== material.rowVersion',
  'stockOnHandQuantity || 0',
  'carrier.credentialVersion !== offer.credentialVersion',
  'offer.packageCount !== receipt.packages.length',
  'offer.packagePlanHash !== receipt.packagePlanHash',
  'offer.shopifyServiceCode !== stableCode',
  'buildShopifyStoreEntityRateResponse({',
  'shopifyCheckoutRatingHash(resultSnapshot) !== receipt.resultHash',
  'shopifyCheckoutRatingHash(resultSnapshot.response)',
  'shopifyCheckoutRatingHash(expectedResponse)',
], 'Typed cached response reconstruction')
assert.equal(
  typedResponse.includes(
    'response: resultSnapshot.response as ShopifyCarrierServiceRateResponse',
  ),
  true,
  'cached Shopify responses may replay only the hash-bound typed response',
)
assert.equal(
  typedResponse.includes('return resultSnapshot.response'),
  false,
  'cached Shopify responses must not bypass typed reconstruction',
)

includes(contract, [
  'sandbox-only checkout execution boundary',
  'packaging-material and packaging-stock revisions',
  'carrier-credential generations',
  'immutable typed package and offer rows',
  'hash-bound customer-neutral response',
], 'Distributed Operations cache and sandbox contract')

console.log('Shopify checkout sandbox and cache fences passed.')
