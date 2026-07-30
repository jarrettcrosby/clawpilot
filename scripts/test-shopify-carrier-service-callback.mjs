import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const callback = read(
  'app_src/lib/integrations/shopifyCarrierServiceCallback.ts',
)
const context = read(
  'app_src/lib/persistence/shopifyCheckoutContext.ts',
)
const route = read(
  'app_src/app/api/integrations/commerce/shopify/carrier-service/'
  + '[accountGlobalId]/[token]/route.ts',
)
const proxy = read('app_src/proxy.ts')
const credentialClient = read(
  'app_src/lib/integrations/carrierCredentialClient.ts',
)
const sandboxRate = read(
  'app_src/lib/integrations/carrierSandboxRate.ts',
)
const checkoutRate = read(
  'app_src/lib/integrations/carrierCheckoutRate.ts',
)
const checkoutPersistence = read(
  'app_src/lib/persistence/shopifyCheckoutRating.ts',
)

for (const required of [
  'readShopifyCarrierServiceRateRequest(input.request, {',
  'allowShadowSimulation: false',
  'persistedRequestFingerprint(',
  'shopifyCheckoutDestinationFingerprint(',
  'carrierSandboxPartyFingerprint(destination)',
  'carrierDestinationFingerprint: carrierDestinationHash',
  'readShopifyCheckoutContextFromPostgres({',
  'inventorySnapshotHash: context.inventorySnapshotHash',
  'readCachedShopifyCheckoutRateReceiptInPostgres({',
  'claimShopifyCheckoutRateReceiptInPostgres({',
  'expectedConfigRowVersion: account.configRowVersion',
  'expectedActivationState: account.activationState',
  'expectedActivationRevision: account.activationRevision',
  'planShopifyCheckoutPackages(context.input)',
  'rateCheckoutShipment({',
  'testCarrierSandboxShipmentRate({',
  'completeShopifyCheckoutRateReceiptInPostgres({',
  'failShopifyCheckoutRateReceiptInPostgres({',
  'customerChargeMinor: offer.amountMinor',
  'carrierAccountGlobalId: offer.carrierAccountGlobalId',
  'rateEvidenceGlobalId: offer.evidenceGlobalId',
  'shopifyServiceCode: stableShopifyCarrierServiceCode(',
  'CALLBACK_RESPONSE_TIMEOUT_MS',
  'const workController = new AbortController()',
  'signal: workController.signal',
  'awaitCallbackWork(',
  'deadlineAt: new Date(successPersistenceDeadlineAt).toISOString()',
  'failurePersistenceDeadlineAt',
  'httpStatus: 200 | 503 | 504',
  'resultFromTypedReceipt(',
  'failedHttpStatus(error)',
]) {
  assert.ok(
    callback.includes(required),
    `callback is missing required contract: ${required}`,
  )
}

for (const required of [
  'withShopifyCheckoutDeadlineTransaction',
  "set_config('statement_timeout', $1, true)",
  'clock_timestamp() < $1::timestamptz AS within_deadline',
  'deadlineFencedClient(client, deadlineAt)',
  "'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED'",
]) {
  assert.ok(
    checkoutPersistence.includes(required),
    `callback persistence is missing deadline fence: ${required}`,
  )
}
assert.match(
  callback,
  /CALLBACK_CARRIER_DEADLINE_MS = 8_000[\s\S]*CALLBACK_SUCCESS_PERSISTENCE_DEADLINE_MS = 8_400[\s\S]*CALLBACK_WORK_ABORT_MS = 8_700[\s\S]*CALLBACK_FAILURE_PERSISTENCE_DEADLINE_MS = 8_950[\s\S]*CALLBACK_RESPONSE_TIMEOUT_MS = 9_250/,
  'carrier, success, cancellation, failure, and response deadlines must retain cleanup buffers',
)
const responseTimeout = callback.slice(
  callback.indexOf('const timeout = new Promise<CallbackResult>'),
)
assert.ok(
  responseTimeout.indexOf('workController.abort()')
    < responseTimeout.indexOf(
      'resolve(authenticatedResult(EMPTY_RATE_RESPONSE, 504))',
    ),
  'hard response timeout must abort callback work before returning 504',
)

assert.ok(
  callback.indexOf('if (!lines.length)')
    < callback.indexOf('claimShopifyCheckoutRateReceiptInPostgres({'),
  'zero shippable lines must exit before receipt persistence',
)
assert.ok(
  callback.indexOf('readShopifyCheckoutContextFromPostgres({')
    < callback.indexOf('readCachedShopifyCheckoutRateReceiptInPostgres({'),
  'inventory evidence must fence cache lookup',
)
for (const forbidden of [
  'createCommerceProduct',
  'updateCommerceProduct',
  'updateCommerceInventory',
  'reserveInventory',
  'createCarrierLabel',
  'voidCarrierLabel',
  'buyPostage',
]) {
  assert.equal(
    callback.includes(forbidden),
    false,
    `callback must not invoke external write primitive: ${forbidden}`,
  )
}

for (const required of [
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  "mapping.provider = 'shopify'",
  'mapping.external_product_id = requested.product_gid',
  'mapping.external_variant_id = requested.variant_gid',
  "mapping.mapping_purpose = 'shopify_checkout'",
  "level.projection_state = 'projected'",
  'level.external_inventory_item_id =',
  "recipe.lifecycle_state = 'active'",
  "row.status !== 'active'",
  'config.row_version = $3',
  'inventorySnapshotHash',
]) {
  assert.ok(
    context.includes(required),
    `context reader is missing required contract: ${required}`,
  )
}
assert.equal(
  /provider_sku\s*=\s*requested|sku\s*=\s*requested/i.test(context),
  false,
  'context reader must never use SKU fallback matching',
)
assert.equal(
  /`(?:INSERT\s+INTO|UPDATE\s+[a-z_]|DELETE\s+FROM)/i.test(context),
  false,
  'callback context reader must be read-only',
)

assert.ok(
  route.includes('executeShopifyCarrierServiceCallback({'),
  'public route must delegate to the bounded callback executor',
)
assert.ok(
  route.includes("status: 404"),
  'invalid account/token must return the generic 404 response',
)
assert.ok(
  route.includes('status: result.httpStatus'),
  'authenticated callback outcomes must retain success/retry status',
)
assert.equal(
  /requireRequestUser|resolveRequestSession/.test(route),
  false,
  'Shopify callback must not depend on a browser session',
)
assert.ok(
  proxy.includes(
    "/api/integrations/commerce/shopify/carrier-service/",
  ),
  'Shopify callback path must be exempt from browser authentication',
)

assert.ok(
  credentialClient.includes('signal?: AbortSignal'),
  'carrier token calls must accept the checkout abort signal',
)
assert.ok(
  sandboxRate.includes('signal: options.signal'),
  'carrier rate calls must propagate the checkout abort signal',
)
assert.ok(
  checkoutRate.includes("const ACCOUNT_GLOBAL_ID = /^gac[0-9]{7}$/"),
  'checkout rating must accept canonical carrier-account Global IDs',
)
assert.ok(
  checkoutRate.includes('input.signal?.addEventListener('),
  'checkout rating must compose the callback abort signal',
)

console.log('Shopify CarrierService public callback contracts passed.')
