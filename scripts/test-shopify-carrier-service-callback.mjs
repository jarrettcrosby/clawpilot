import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const callback = read(
  'app_src/lib/integrations/shopifyCarrierServiceCallback.ts',
)
const shadowGuardModule = read(
  'app_src/lib/integrations/shopifyShadowCheckoutGuard.ts',
)
const branding = read(
  'app_src/lib/integrations/shopifyCarrierServiceBranding.ts',
)
const context = read(
  'app_src/lib/persistence/shopifyCheckoutContext.ts',
)
const channelEligibility = read(
  'app_src/lib/integrations/shopifyCheckoutChannelEligibility.ts',
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
const productionCheckoutRate = read(
  'app_src/lib/integrations/shopifyCarrierServiceProductionRate.ts',
)
const checkoutCarrierSelection = read(
  'app_src/lib/integrations/shopifyCheckoutCarrierSelection.ts',
)
const checkoutParcelEvidenceMigration = read(
  'db/migrations/0164_shopify_checkout_offer_parcel_evidence.sql',
)

for (const required of [
  'carrierWholeShipmentRateDestinationFingerprint({',
  "purpose: 'shopify_checkout'",
  'shipment: {',
  "rateScope: 'multi_package_shipment'",
  'packageCount: input.packageCount',
  'parcels: input.parcels.map((parcel) => ({',
  'packageCount: input.parcels.length',
]) {
  assert.ok(
    productionCheckoutRate.includes(required),
    `production checkout failure evidence is missing ${required}`,
  )
}
assert.equal(
  productionCheckoutRate.includes('carrier-production-destination-v1'),
  false,
  'production checkout evidence must use the canonical foundation fingerprint',
)
for (const required of [
  'shopify-checkout-carrier-selection-v1|',
  'input.receiptGlobalId',
  'input.carrierAccountGlobalId',
]) {
  assert.ok(
    checkoutCarrierSelection.includes(required),
    `checkout carrier selection key is missing ${required}`,
  )
}
for (const required of [
  'shopifyCheckoutCarrierSelectionKey({',
  'receiptGlobalId: claim.receiptGlobalId',
  'carrierSelectionKey,',
]) {
  assert.ok(
    callback.includes(required),
    `callback evidence selection is missing ${required}`,
  )
}
assert.ok(
  productionCheckoutRate.includes('carrierSelectionKey,')
    && productionCheckoutRate.includes(
      'receiptGlobalId: input.receiptGlobalId',
    ),
  'LIVE evidence must persist the exact receipt/account selection key',
)

for (const required of [
  'readShopifyCarrierServiceRateRequest(input.request, {',
  'allowShadowSimulation: false',
  'SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS',
  'readActiveShopifyCustomerRatePolicyFromPostgres({',
  'evaluateShopifyShadowCheckoutPrePolicy({',
  'evaluateShopifyShadowCheckoutPolicy(customerPolicy)',
  "'[shopify checkout rating] shadow guard denied'",
  'buildShopifyStoreEntityRateResponse({',
  'storeEntityName: account.storeEntityName',
  "protocolVersion: 'shopify-carrier-service-response-v5'",
  "responseProtocolVersion !== 'shopify-carrier-service-response-v2'",
  "responseProtocolVersion\n        !== 'shopify-carrier-service-response-v3'",
  "responseProtocolVersion\n        !== 'shopify-carrier-service-response-v4'",
  "responseProtocolVersion\n        !== 'shopify-carrier-service-response-v5'",
  'packages: checkoutRatePackageSummary(packages)',
  "responseProtocolVersion === 'shopify-carrier-service-response-v5'",
  'checkoutRatePackageSummary(receipt.packages)',
  'shopifyCheckoutRatingHash(resultSnapshot) !== receipt.resultHash',
  'shopifyCheckoutRatingHash(resultSnapshot.response)',
  "console.warn('[shopify checkout rating] callback failed'",
  'attemptedStage: CheckoutFailureStage',
  'checkpoint: CheckoutFailureCheckpoint',
  'stage: checkoutFailureStage(',
  'checkpoint: input.checkpoint',
  'reasonCode: errorCode(input.error)',
  "'SHOPIFY_CHECKOUT_FINGERPRINT_CONFIG_MISSING'",
  "'SHOPIFY_CHECKOUT_WAREHOUSE_ORIGIN_MISMATCH'",
  "'SHOPIFY_CHECKOUT_LINE_QUANTITY_UNSUPPORTED'",
  "'SHOPIFY_CHECKOUT_LINE_WEIGHT_REQUIRED'",
  "'SHOPIFY_CHECKOUT_LINE_WEIGHT_UNSUPPORTED'",
  "'SHOPIFY_CHECKOUT_DESTINATION_COUNTRY_UNSUPPORTED'",
  "'SHOPIFY_CHECKOUT_DESTINATION_NOT_READY'",
  'fallbackReasonCode(attemptedStage)',
  "attemptedStage = 'destination_fingerprint'",
  "attemptedStage = 'carrier_destination_fingerprint'",
  "attemptedStage = 'checkout_context'",
  "attemptedStage = 'receipt_cache'",
  "attemptedStage = 'receipt_claim'",
  "'account_ready'",
  "'request_parsed'",
  "'shadow_authorized'",
  "'fingerprinted'",
  "'origin_valid'",
  "'lines_valid'",
  "'destination_fingerprinted'",
  "'destination_valid'",
  "'carrier_destination_fingerprinted'",
  "'context_loaded'",
  "'execution_fenced'",
  "'cache_read'",
  "'claim_attempted'",
  "'receipt_claimed'",
  'safeShopifyCarrierServiceProtocolErrorPath(input.error)',
  '...(protocolPath ? { protocolPath } : {})',
  'persistedRequestFingerprint(',
  'createShopifyCheckoutReceiptKeys({',
  'stableCacheKey,',
  'shopifyCheckoutDestinationFingerprint(',
  'carrierSandboxRateDestinationFingerprint(destination)',
  'carrierWholeShipmentRateDestinationFingerprint({',
  "account.activationState === 'active'",
  'carrierDestinationFingerprint: carrierDestinationHash',
  'readShopifyCheckoutContextFromPostgres({',
  'inventorySnapshotHash: context.inventorySnapshotHash',
  'readCachedShopifyCheckoutRateReceiptInPostgres(cacheLookup)',
  'waitForShopifyCheckoutReceiptCompletion({',
  'claimShopifyCheckoutRateReceiptInPostgres({',
  'SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION',
  'snapshotVersion:',
  'packEvidenceHash: line.packEvidenceHash',
  "version: 'shopify-checkout-execution-fence-v5'",
  'packLines: [...context.lines]',
  'receiptGlobalId: claim.receiptGlobalId',
  'expectedConfigRowVersion: account.configRowVersion',
  'expectedActivationState: account.activationState',
  'expectedActivationRevision: account.activationRevision',
  'planShopifyCheckoutPackageCandidates(',
  'rateOptimizedCheckoutPlans({',
  'readShopifyCheckoutPlanRatePolicy(',
  'checkoutContextForCurrency(',
  'planRatePolicy.handlingCostCurrency !== request.currency',
  'materialPreferenceOrder(',
  'feasibleRateCandidate(',
  'candidatePlanEvidence(',
  'testCarrierSandboxShipmentRate({',
  'rateShopifyProductionCheckoutShipment({',
  'requireFailureEvidence: true',
  'completeShopifyCheckoutRateReceiptInPostgres({',
  'failShopifyCheckoutRateReceiptInPostgres({',
  'const chargedOffers = publicCheckoutOffers(rated.offers)',
  'collapseShopifyCheckoutRateSourceOffers(',
  'policy: shadowGuard.customerPolicy',
  'offers: chargedOffers.map((offer) => ({',
  'carrierCostMinor: offer.amountMinor',
  'customerChargeMinor: offer.customerChargeMinor',
  'subsidyReason: offer.subsidyReason',
  'amountMinor: offer.customerChargeMinor',
  'shadowTestChargePolicy: shopifyShadowTestChargePolicyFence({',
  'carrierAccountGlobalId: offer.carrierAccountGlobalId',
  'rateEvidenceGlobalId: offer.evidenceGlobalId',
  'providerAttempts: rated.providerAttempts.map((attempt) => ({',
  'configuredAccounts: runtimeCarriers.map((carrier) => ({',
  'successfulAccounts: rated.successfulAccounts.map((selection) => ({',
  'candidateAttempts: candidateDecisionEvidence',
  'planResultHash: candidate.plan.resultHash',
  'preferenceMaterialGlobalIdsByPool:',
  'materialStockRowVersion:',
  'recipeEvidence:',
  'planInputHash:',
  'carrierAccountGlobalId: offer.carrierAccountGlobalId',
  'evidenceGlobalId: offer.evidenceGlobalId',
  'failureCode:',
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
  "normalizedStatus === 'active'",
  "providerStatusRaw === 'active'",
  'input.providerActive === true',
  "normalizedStatus === 'unlisted'",
  "providerStatusRaw === 'unlisted'",
  'input.providerActive === false',
  "normalizedText(input.accountEnvironment) === 'sandbox'",
  'input.requiresShipping === true',
  'Number.isSafeInteger(input.weightGrams)',
]) {
  assert.ok(
    channelEligibility.includes(required),
    `checkout channel eligibility is missing ${required}`,
  )
}

for (const required of [
  'state.pack_evidence_hash AS state_pack_evidence_hash',
  'mapping.pack_evidence_hash AS pack_mapping_pack_evidence_hash',
  '!row.pack_mapping_pack_evidence_hash',
  'row.pack_mapping_pack_evidence_hash\n        !== row.state_pack_evidence_hash',
  'packEvidenceHash,',
]) {
  assert.ok(
    context.includes(required),
    `checkout context is missing current pack-evidence fence: ${required}`,
  )
}
assert.equal(
  callback.includes('receiptGlobalId: claim.receipt.globalId'),
  false,
  'a new receipt claim must not hydrate terminal receipt children before carrier rating',
)

for (const required of [
  'candidateAttempts: CheckoutPlanRateCandidateAttempt[]',
  'const baselineCandidate = candidates[0]',
  'alternativeBudgetMs',
  'Promise.allSettled(alternatives.map(',
  "failureCode: alternativeFailureCode(error)",
  "'CHECKOUT_RATE_ALTERNATIVE_BUDGET_EXHAUSTED'",
]) {
  assert.ok(
    checkoutRate.includes(required),
    `bounded best-effort rate optimizer is missing: ${required}`,
  )
}
assert.equal(
  checkoutRate.includes('offerEligible'),
  false,
  'checkout rating must not claim an unpersisted delivery-promise filter',
)

for (const required of [
  'SHOPIFY_CARRIER_DISPLAY_NAMES',
  "ups: 'UPS'",
  "fedex: 'FedEx'",
  'RATE_NAME_SEPARATOR',
  'carrierDisplayName',
  'providerServiceName',
]) {
  assert.ok(
    branding.includes(required),
    `rate branding is missing store, carrier, and service contract: ${required}`,
  )
}

assert.equal(
  callback.includes('shadowCustomerAlias:'),
  false,
  'customer identity must not alter a Shopify CarrierService rate name',
)
assert.equal(
  callback.includes('error.message,'),
  false,
  'callback failure logs must not include provider messages or payload values',
)
assert.equal(
  callback.includes('rawPayload'),
  false,
  'callback failure logs must not include raw provider payloads',
)
const shadowGuardLogger = callback.slice(
  callback.indexOf('function recordShadowCheckoutGuardDenial('),
  callback.indexOf('function deliveryTimestamp('),
)
for (const required of [
  'accountGlobalId: string',
  'reasonCode: ShopifyShadowCheckoutGuardDenialReason',
  'shopifyShadowCheckoutGuardDenialTelemetry(input)',
]) {
  assert.ok(
    shadowGuardLogger.includes(required),
    `Shadow denial telemetry is missing safe field: ${required}`,
  )
}
for (const forbidden of [
  'customerId:',
  'variantId:',
  'address:',
  'payload:',
  'request:',
  'receiptClaimed:',
  'protocolPath:',
]) {
  assert.equal(
    shadowGuardLogger.includes(forbidden),
    false,
    `Shadow denial telemetry must not include unsafe field: ${forbidden}`,
  )
}
assert.ok(
  callback.includes('name: null')
    && callback.includes('line1: request.destination.address1')
    && callback.includes('line2: request.destination.address2')
    && callback.includes('city: request.destination.city')
    && callback.includes('region: request.destination.provinceCode')
    && callback.includes('!request.destination.postalCode'),
  'Shopify callback rating must retain every available rate-material destination field',
)
assert.equal(
  callback.includes('!request.destination.provinceCode'),
  false,
  'Shopify ZIP-only rate discovery must not be rejected for an omitted province',
)
assert.equal(
  callback.includes("name: 'Shopify checkout'"),
  false,
  'the callback must not fabricate a carrier destination name',
)

for (const required of [
  'withShopifyCheckoutDeadlineTransaction',
  'acquireShopifyCheckoutClient',
  'getPostgresPool().connect()',
  'Promise.race([connection, fence])',
  'lateClient.release()',
  "client.query('BEGIN')",
  "client.query('COMMIT')",
  "client.query('ROLLBACK')",
  'requirePersistenceAvailable(deadlineAt, options?.signal)',
  'commitBufferMs: 25',
  "set_config('statement_timeout', $1, true)",
  'clock_timestamp() < $1::timestamptz AS within_deadline',
  'deadlineFencedClient(',
  "'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED'",
]) {
  assert.ok(
    checkoutPersistence.includes(required),
    `callback persistence is missing deadline fence: ${required}`,
  )
}
assert.ok(
  callback.includes('signal: workController.signal'),
  'receipt claiming must carry callback cancellation through the commit fence',
)
assert.match(
  callback,
  /CALLBACK_CARRIER_DEADLINE_MS = 6_500[\s\S]*CALLBACK_SUCCESS_PERSISTENCE_DEADLINE_MS = 8_250[\s\S]*CALLBACK_WORK_ABORT_MS = 8_700[\s\S]*CALLBACK_FAILURE_PERSISTENCE_DEADLINE_MS = 8_950[\s\S]*CALLBACK_RESPONSE_TIMEOUT_MS = 9_250/,
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
const authenticatedExecution = callback.slice(
  callback.indexOf('const authenticatedExecution'),
)
const shadowGuard = authenticatedExecution.indexOf(
  'const shadowGuard = await awaitCallbackWork(',
)
assert.ok(
  shadowGuard >= 0
    && authenticatedExecution.indexOf(
      'shadowCheckoutRequestGuard(account, request),',
      shadowGuard,
    ) > shadowGuard
    && shadowGuard < authenticatedExecution.indexOf(
      'persistedRequestFingerprint(',
    )
    && shadowGuard < authenticatedExecution.indexOf(
      'readShopifyCheckoutContextFromPostgres({',
    )
    && shadowGuard < authenticatedExecution.indexOf(
      'claimShopifyCheckoutRateReceiptInPostgres({',
    )
    && shadowGuard < authenticatedExecution.indexOf(
      'planShopifyCheckoutPackageCandidates(',
    )
    && shadowGuard < authenticatedExecution.indexOf(
      'rateOptimizedCheckoutPlans({',
    ),
  'Shadow customer and variant allowlist must run before fingerprints, persistence, cartonization, or carrier calls',
)
assert.ok(
  authenticatedExecution.includes(
    'if (!shadowGuard.allowed) {\n'
      + '      recordShadowCheckoutGuardDenial({\n'
      + '        accountGlobalId: account.accountGlobalId,\n'
      + '        reasonCode: shadowGuard.reasonCode,\n'
      + '      })\n'
      + '      return authenticatedResult(EMPTY_RATE_RESPONSE, 200)',
  ),
  'a denied Shadow test request must log safe telemetry and return authenticated HTTP 200 empty rates',
)
const shadowGuardFunction = callback.slice(
  callback.indexOf('async function shadowCheckoutRequestGuard('),
  callback.indexOf('function checkoutExecutionFenceHash('),
)
for (const required of [
  "account.activationState !== 'shadow'",
  'evaluateShopifyShadowCheckoutPrePolicy({',
  'customerId: request.customer?.id',
  'configuredVariantIds: configuredShopifyNumericIdentifierSet(',
  'items: request.items',
  'if (!prePolicy.ready)',
  'reasonCode: prePolicy.reasonCode',
  'shopifyCustomerGid: prePolicy.customerId',
  'evaluateShopifyShadowCheckoutPolicy(customerPolicy)',
]) {
  assert.ok(
    shadowGuardFunction.includes(required),
    `Shadow callback targeting is missing fail-closed contract: ${required}`,
  )
}
assert.ok(
  shadowGuardFunction.indexOf('if (!prePolicy.ready)')
    < shadowGuardFunction.indexOf(
      'readActiveShopifyCustomerRatePolicyFromPostgres({',
    ),
  'guest or customer-omitted Shadow callbacks must fail closed before policy lookup',
)
for (const required of [
  "MissingCustomer: 'SHOPIFY_SHADOW_GUARD_MISSING_CUSTOMER'",
  "'SHOPIFY_SHADOW_GUARD_MISSING_VARIANT_CONFIGURATION'",
  "NoShippableItems: 'SHOPIFY_SHADOW_GUARD_NO_SHIPPABLE_ITEMS'",
  "UnallowlistedVariant: 'SHOPIFY_SHADOW_GUARD_UNALLOWLISTED_VARIANT'",
  "'SHOPIFY_SHADOW_GUARD_POLICY_ABSENT_OR_INELIGIBLE'",
  "HideAll: 'SHOPIFY_SHADOW_GUARD_HIDE_ALL'",
  'shopifyShadowCheckoutGuardDenialTelemetry',
  "stage: 'shadow_guard' as const",
  "checkpoint?: 'account_authenticated' | 'request_parsed'",
  "checkpoint: input.checkpoint || 'request_parsed'",
]) {
  assert.ok(
    shadowGuardModule.includes(required),
    `Shadow denial telemetry is missing stable reason: ${required}`,
  )
}
assert.ok(
  callback.indexOf('readShopifyCheckoutContextFromPostgres({')
    < callback.indexOf(
      'readCachedShopifyCheckoutRateReceiptInPostgres(cacheLookup)',
    ),
  'inventory evidence must fence cache lookup',
)
assert.ok(
  callback.indexOf(
    'return resultFromTypedReceipt(\n        account,\n        context,\n        cached,',
  ) < callback.indexOf('const chargedOffers = publicCheckoutOffers('),
  'a cached typed receipt must remain authoritative and bypass live subsidy recalculation',
)
const typedReceiptReplay = callback.slice(
  callback.indexOf('function responseFromTypedReceipt('),
  callback.indexOf('function resultFromTypedReceipt('),
)
assert.equal(
  typedReceiptReplay.includes('applyShopifyShadowTestCharge('),
  false,
  'typed receipt replay must use its persisted customer charge without policy reinterpretation',
)
assert.ok(
  callback.indexOf("if (claim.kind === 'in_progress')")
    < callback.indexOf('planShopifyCheckoutPackageCandidates('),
  'an in-progress duplicate must wait for the durable receipt before cartonization or carrier calls',
)
const inProgressBranch = callback.slice(
  callback.indexOf("if (claim.kind === 'in_progress')"),
  callback.indexOf("if (claim.kind !== 'claimed')"),
)
assert.ok(
  inProgressBranch.includes(
    'readCachedShopifyCheckoutRateReceiptInPostgres(cacheLookup)',
  )
    && inProgressBranch.includes('deadlineAt: workDeadlineAt')
    && inProgressBranch.includes('signal: workController.signal'),
  'duplicate checkout coalescing must poll the fenced terminal receipt within the callback deadline',
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
  'state.provider_status_raw AS state_provider_status_raw',
  'isShopifySandboxCheckoutChannelEligible({',
  'accountEnvironment: account.environment',
  'row.pack_mapping_provider_lifecycle_state\n        !== row.state_normalized_status',
  "level.projection_state = 'projected'",
  'level.external_inventory_item_id =',
  "recipe.lifecycle_state = 'active'",
  "row.status !== 'active'",
  'config.row_version = $3',
  'inventorySnapshotHash',
  'material.unit_cost_minor::text',
  'material.currency',
  'unitCostMinor',
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
  sandboxRate.includes(
    '...(packageCode === null ? {} : { packageCode })',
  ),
  'provider-neutral checkout evidence must omit a null package code',
)
assert.equal(
  checkoutParcelEvidenceMigration.includes("'packageCode'"),
  false,
  'provider-neutral checkout evidence must retain the historical parcel shape expected by PostgreSQL',
)
assert.ok(
  checkoutRate.includes("const ACCOUNT_GLOBAL_ID = /^gac(?:[0-9]{7}|[0-9a-v]{12})$/"),
  'checkout rating must accept canonical carrier-account Global IDs',
)
assert.ok(
  checkoutRate.includes('input.signal?.addEventListener('),
  'checkout rating must compose the callback abort signal',
)

console.log('Shopify CarrierService public callback contracts passed.')
