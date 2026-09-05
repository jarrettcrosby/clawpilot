#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

import * as runtimeGate from './lib/integration-credential-runtime-test-double.mjs'

const root = resolve(import.meta.dirname, '..')
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}) {
  const result = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile`)
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, {
    AbortController,
    AbortSignal,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Request,
    Response,
    Set,
    String,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const maintenanceError =
  new runtimeGate.IntegrationCredentialRuntimeGateError(
    'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
  )

const maintenanceHttp = loadTypeScriptModule(
  'app_src/lib/integrations/integrationCredentialRuntimeHttp.ts',
  {
    'next/server': {
      NextResponse: {
        json(body, init) {
          return { body, status: init.status, headers: init.headers }
        },
      },
    },
    '@/lib/integrations/integrationCredentialRuntimeGate.mjs': runtimeGate,
  },
)
assert.equal(
  maintenanceHttp.integrationCredentialRuntimeMaintenanceResponse(
    new Error('ordinary failure'),
  ),
  null,
)
const maintenanceResponse =
  maintenanceHttp.integrationCredentialRuntimeMaintenanceResponse(
    maintenanceError,
  )
assert.equal(maintenanceResponse.status, 503)
assert.equal(maintenanceResponse.headers['Retry-After'], '60')
assert.equal(
  maintenanceResponse.body.code,
  'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
)
assert.equal(maintenanceResponse.body.retryable, true)
assert.equal(
  maintenanceResponse.body.error.includes(maintenanceError.message),
  false,
  'maintenance responses must not expose internal gate details',
)

const checkoutRateSource = read(
  'app_src/lib/integrations/carrierCheckoutRate.ts',
)
assert.equal(
  checkoutRateSource.includes('integrationCredentialRuntimeGate.mjs'),
  false,
  'browser-shared checkout aggregation must not import the server-only runtime gate',
)
const checkoutRate = loadTypeScriptModule(
  'app_src/lib/integrations/carrierCheckoutRate.ts',
)
let providerCalls = 0
await assert.rejects(
  checkoutRate.rateCheckoutShipment({
    destination: {
      name: 'Runtime Gate Test',
      line1: '1 Test Way',
      line2: null,
      city: 'Testville',
      region: 'NY',
      postalCode: '10001',
      countryCode: 'US',
    },
    parcels: [{
      packageKey: 'package-1',
      description: 'Runtime gate parcel',
      exteriorInches: { length: 10, width: 8, height: 6 },
      grossPounds: 2,
    }],
    carriers: [
      { provider: 'ups_rest', carrierAccountGlobalId: 'gac1234567' },
      { provider: 'fedex_rest', carrierAccountGlobalId: 'gac7654321' },
    ],
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    async invoke() {
      providerCalls += 1
      throw maintenanceError
    },
  }),
  (error) => error === maintenanceError,
  'multi-provider checkout rating must preserve the original typed outage',
)
assert.equal(providerCalls, 2)

for (const relativePath of [
  'app_src/lib/integrations/commerceIntegrations.ts',
  'app_src/lib/integrations/carrierIntegrations.ts',
  'app_src/lib/integrations/brokeredTransportIntegrations.ts',
]) {
  const source = read(relativePath)
  assert.ok(
    source.includes('if (isIntegrationCredentialRuntimeGateError(error)) throw error'),
    `${relativePath} must preserve typed maintenance through sanitization`,
  )
}

for (const relativePath of [
  'app_src/app/api/dev/shopify-test-fixtures/route.ts',
  'app_src/app/api/crm/products/[productId]/faire-product-image/route.ts',
  'app_src/app/api/crm/products/[productId]/faire-product-images/route.ts',
  'app_src/app/api/crm/products/[productId]/shopify-product-image/route.ts',
  'app_src/app/api/integrations/brokered-transport/route.ts',
  'app_src/app/api/integrations/carriers/route.ts',
  'app_src/app/api/integrations/commerce/faire/inventory/route.ts',
  'app_src/app/api/integrations/commerce/faire/oauth/callback/route.ts',
  'app_src/app/api/integrations/commerce/fulfillment/process/route.ts',
  'app_src/app/api/integrations/commerce/intake/cartonization-preview/route.ts',
  'app_src/app/api/integrations/commerce/intake/cartonization-rate-evidence/route.ts',
  'app_src/app/api/integrations/commerce/intake/planning-assignment/route.ts',
  'app_src/app/api/integrations/commerce/intake/route.ts',
  'app_src/app/api/integrations/commerce/inventory/route.ts',
  'app_src/app/api/integrations/commerce/route.ts',
  'app_src/app/api/integrations/commerce/shopify/customer-rate-policies/route.ts',
  'app_src/app/api/integrations/commerce/shopify/location-administration/route.ts',
  'app_src/app/api/integrations/commerce/shopify/order-preview/route.ts',
  'app_src/app/api/integrations/commerce/shopify/rate-warm/route.ts',
  'app_src/app/api/integrations/commerce/shopify/webhooks/[accountGlobalId]/route.ts',
  'app_src/app/api/operations/artifacts/[globalId]/route.ts',
  'app_src/app/api/operations/carrier-billing/import/route.ts',
  'app_src/app/api/operations/order-discovery/route.ts',
  'app_src/app/api/operations/order-history-sync/route.ts',
  'app_src/app/api/operations/order-revisions/route.ts',
  'app_src/app/api/operations/order-status-sync/route.ts',
  'app_src/app/api/operations/order-workbench/route.ts',
  'app_src/app/api/operations/orders/unified/route.ts',
  'app_src/app/api/operations/one-off-shipments/route.ts',
  'app_src/app/api/operations/route.ts',
  'app_src/app/api/operations/shipment-address/route.ts',
  'app_src/app/api/operations/shopify-order-management/route.ts',
]) {
  const source = read(relativePath)
  assert.ok(
    source.includes('integrationCredentialRuntimeMaintenanceResponse'),
    `${relativePath} must map typed maintenance before business sanitization`,
  )
}

for (const [relativePath, minimumGuards] of [
  ['app_src/lib/integrations/carrierShippingDiagnosticRate.ts', 1],
  ['app_src/lib/integrations/brokeredTransportIntegrations.ts', 2],
  ['app_src/lib/integrations/faireProductImageRefresh.ts', 1],
  ['app_src/lib/integrations/commerceIntake.ts', 9],
  ['app_src/lib/integrations/shopifyCarrierServiceProductionRate.ts', 1],
  ['app_src/lib/integrations/shopifyReversalFixtureProvider.ts', 1],
  ['app_src/lib/operations/commerceOrderRevisionCommands.ts', 1],
  ['app_src/lib/operations/productionFulfillmentRerates.ts', 1],
  ['app_src/lib/operations/shopifyReversalFixtureCommands.ts', 2],
  ['app_src/lib/persistence/carrierBilling.ts', 1],
  ['app_src/lib/persistence/commerceIntake.ts', 8],
  ['app_src/lib/persistence/commerceOrderWorkbench.ts', 1],
  ['app_src/lib/persistence/oneOffShipments.ts', 5],
  ['app_src/lib/persistence/operationOneOffShipping.ts', 2],
  ['app_src/lib/persistence/operationsOrderShipmentAddress.ts', 1],
]) {
  const source = read(relativePath)
  const guards = source.match(
    /if \(isIntegrationCredentialRuntimeGateError\(error\)\) throw error/gu,
  )?.length || 0
  assert.ok(
    guards >= minimumGuards,
    `${relativePath} must preserve typed maintenance before failure persistence`,
  )
}

const commerceIntake = read(
  'app_src/lib/integrations/commerceIntake.ts',
)
for (const commandAction of [
  "commandAction === 'reset-order-reconciliation'",
  "commandAction === 'set-product-intake-policy'",
]) {
  const actionStart = commerceIntake.indexOf(commandAction)
  const stateRead = commerceIntake.indexOf(
    'readCommerceIntakeStateFromPostgres({',
    actionStart,
  )
  const bestEffortNull = commerceIntake.indexOf(
    'return null',
    stateRead,
  )
  const maintenanceRethrow = commerceIntake.indexOf(
    'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
    stateRead,
  )
  assert.ok(
    actionStart >= 0
    && stateRead > actionStart
    && maintenanceRethrow > stateRead
    && bestEffortNull > maintenanceRethrow,
    `${commandAction} must preserve typed maintenance before its best-effort null fallback`,
  )
}

const oneOffPersistence = read(
  'app_src/lib/persistence/oneOffShipments.ts',
)
const oneOffRateFailure = oneOffPersistence.indexOf(
  "SET state = $3, error_code = $4,",
)
const oneOffRateCatch = oneOffPersistence.lastIndexOf(
  '} catch (error) {',
  oneOffRateFailure,
)
const oneOffRateMaintenance = oneOffPersistence.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
  oneOffRateCatch,
)
assert.ok(
  oneOffRateCatch >= 0
  && oneOffRateMaintenance > oneOffRateCatch
  && oneOffRateMaintenance < oneOffRateFailure,
  'one-off production rating must leave prepared attempts unresolved during maintenance',
)
const quoteCommandFailure = oneOffPersistence.indexOf(
  'await failQuoteCommand({ organizationId, idempotencyKey, error })',
)
const quoteCommandCatch = oneOffPersistence.lastIndexOf(
  '} catch (error) {',
  quoteCommandFailure,
)
const quoteCommandMaintenance = oneOffPersistence.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
  quoteCommandCatch,
)
assert.ok(
  quoteCommandCatch >= 0
  && quoteCommandMaintenance > quoteCommandCatch
  && quoteCommandMaintenance < quoteCommandFailure,
  'one-off quote commands must not be failed during runtime maintenance',
)

const operationsPersistence = read(
  'app_src/lib/persistence/operations.ts',
)

const storeSyncPersistence = read(
  'app_src/lib/persistence/commerceStoreSync.ts',
)
const providerReadFenceStart = storeSyncPersistence.indexOf(
  'export async function withCommerceStoreSyncProviderReadFenceInPostgres',
)
const providerReadFenceEnd = storeSyncPersistence.indexOf(
  '\nfunction mapControl',
  providerReadFenceStart,
)
const providerReadFenceBody = storeSyncPersistence.slice(
  providerReadFenceStart,
  providerReadFenceEnd,
)
assert.match(
  providerReadFenceBody,
  /runtimeMaintenance = isIntegrationCredentialRuntimeGateError\(error\)[\s\S]*?Promise\.allSettled\(\[release\(\)\]\)/u,
  'provider-read lease cleanup must not replace typed runtime maintenance',
)

const orderProcessRoute = read(
  'app_src/app/api/integrations/commerce/orders/process/route.ts',
)
const orderProcessCatch = orderProcessRoute.lastIndexOf('} catch (error) {')
const orderProcessMaintenance = orderProcessRoute.indexOf(
  'if (maintenance) {',
  orderProcessCatch,
)
const orderProcessBestEffortTelemetry = orderProcessRoute.indexOf(
  'await Promise.allSettled([',
  orderProcessMaintenance,
)
const orderProcessMaintenanceReturn = orderProcessRoute.indexOf(
  'return maintenance',
  orderProcessBestEffortTelemetry,
)
assert.ok(
  orderProcessCatch >= 0
  && orderProcessMaintenance > orderProcessCatch
  && orderProcessBestEffortTelemetry > orderProcessMaintenance
  && orderProcessMaintenanceReturn > orderProcessBestEffortTelemetry,
  'order-worker maintenance telemetry must be best-effort before returning 503',
)

const shadowPreparationProbe = operationsPersistence.indexOf(
  'shadowPreparationBlockedReason = caught instanceof Error',
)
const shadowPreparationCatch = operationsPersistence.lastIndexOf(
  '} catch (caught) {',
  shadowPreparationProbe,
)
const shadowPreparationMaintenance = operationsPersistence.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(caught)) throw caught',
  shadowPreparationCatch,
)
assert.ok(
  shadowPreparationCatch >= 0
  && shadowPreparationMaintenance > shadowPreparationCatch
  && shadowPreparationMaintenance < shadowPreparationProbe,
  'order detail must not represent runtime maintenance as an ordinary shadow-preparation blocker',
)

const packingSlipStart = operationsPersistence.indexOf(
  'export async function generateOperationsPackagePackingSlipInPostgres',
)
const packingSlipEnd = operationsPersistence.indexOf(
  'type CommerceFulfillmentExportExecutionRow',
  packingSlipStart,
)
const packingSlipBody = operationsPersistence.slice(
  packingSlipStart,
  packingSlipEnd,
)
const packingSlipFailure = packingSlipBody.indexOf(
  'await failCommandReceipt(command.receipt.id, error)',
)
const packingSlipCatch = packingSlipBody.lastIndexOf(
  '} catch (error) {',
  packingSlipFailure,
)
const packingSlipMaintenance = packingSlipBody.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
  packingSlipCatch,
)
assert.ok(
  packingSlipCatch >= 0
  && packingSlipMaintenance > packingSlipCatch
  && packingSlipMaintenance < packingSlipFailure,
  'packing-slip generation must preserve retryable runtime maintenance before failing its command receipt',
)

const shipmentPreparationStart = operationsPersistence.indexOf(
  'export async function prepareOperationsShipmentExecutionFromPostgres',
)
const shipmentPreparationEnd = operationsPersistence.indexOf(
  'type PutawayPendingUsage',
  shipmentPreparationStart,
)
const shipmentPreparationBody = operationsPersistence.slice(
  shipmentPreparationStart,
  shipmentPreparationEnd,
)
const shipmentPreparationFailure = shipmentPreparationBody.indexOf(
  'await failCommandReceipt(command.receipt.id, error)',
)
const shipmentPreparationCatch = shipmentPreparationBody.lastIndexOf(
  '} catch (error) {',
  shipmentPreparationFailure,
)
const shipmentPreparationMaintenance = shipmentPreparationBody.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
  shipmentPreparationCatch,
)
assert.ok(
  shipmentPreparationCatch >= 0
  && shipmentPreparationMaintenance > shipmentPreparationCatch
  && shipmentPreparationMaintenance < shipmentPreparationFailure,
  'shipment preparation must preserve retryable runtime maintenance before failing its command receipt',
)

const planOperationsStart = operationsPersistence.indexOf(
  'export async function planOperationsOrderFromPostgres',
)
const planOperationsEnd = operationsPersistence.indexOf(
  'export async function releaseOperationsOrderFromPostgres',
  planOperationsStart,
)
const planOperationsBody = operationsPersistence.slice(
  planOperationsStart,
  planOperationsEnd,
)
const planFailure = planOperationsBody.indexOf(
  'await failCommandReceipt(command.receipt.id, normalizedError)',
)
const planCatch = planOperationsBody.lastIndexOf(
  '} catch (error) {',
  planFailure,
)
const planMaintenance = planOperationsBody.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
  planCatch,
)
assert.ok(
  planCatch >= 0
  && planMaintenance > planCatch
  && planMaintenance < planFailure,
  'Shopify planning commands must remain retryable during runtime maintenance',
)

const reconciliationStart = operationsPersistence.indexOf(
  'export async function reconcileShopifyExternalFulfillmentFromPostgres',
)
const reconciliationEnd = operationsPersistence.indexOf(
  'export async function reopenOperationsOrderForReplanningInPostgres',
  reconciliationStart,
)
const reconciliationBody = operationsPersistence.slice(
  reconciliationStart,
  reconciliationEnd,
)
const reconciliationFailure = reconciliationBody.indexOf(
  'await failCommandReceipt(command.receipt.id, error)',
)
const reconciliationCatch = reconciliationBody.lastIndexOf(
  '} catch (error) {',
  reconciliationFailure,
)
const reconciliationMaintenance = reconciliationBody.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
  reconciliationCatch,
)
assert.ok(
  reconciliationCatch >= 0
  && reconciliationMaintenance > reconciliationCatch
  && reconciliationMaintenance < reconciliationFailure,
  'external-fulfillment reconciliation must not fail its command receipt during runtime maintenance',
)

const fulfillmentRetryStart = operationsPersistence.indexOf(
  'export async function retryOperationsCommerceFulfillmentExportFromPostgres',
)
const fulfillmentRetryEnd = operationsPersistence.indexOf(
  'type NativeOneOffShipmentAuthority',
  fulfillmentRetryStart,
)
const fulfillmentRetryBody = operationsPersistence.slice(
  fulfillmentRetryStart,
  fulfillmentRetryEnd,
)
const fulfillmentRetryFailure = fulfillmentRetryBody.indexOf(
  'await failCommandReceipt(command.receipt.id, error)',
)
const fulfillmentRetryCatch = fulfillmentRetryBody.lastIndexOf(
  '} catch (error) {',
  fulfillmentRetryFailure,
)
const fulfillmentRetryMaintenance = fulfillmentRetryBody.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
  fulfillmentRetryCatch,
)
assert.ok(
  fulfillmentRetryCatch >= 0
  && fulfillmentRetryMaintenance > fulfillmentRetryCatch
  && fulfillmentRetryMaintenance < fulfillmentRetryFailure,
  'commerce fulfillment retries must not fail command receipts during runtime maintenance',
)

const shipmentConfirmationStart = operationsPersistence.indexOf(
  'export async function confirmOperationsOrderShipmentFromPostgres',
)
const shipmentConfirmationBody = operationsPersistence.slice(
  shipmentConfirmationStart,
)
const shipmentConfirmationFailure = shipmentConfirmationBody.indexOf(
  'await failCommandReceipt(command.receipt.id, error)',
)
const shipmentConfirmationCatch = shipmentConfirmationBody.lastIndexOf(
  '} catch (error) {',
  shipmentConfirmationFailure,
)
const shipmentConfirmationMaintenance = shipmentConfirmationBody.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
  shipmentConfirmationCatch,
)
assert.ok(
  shipmentConfirmationCatch >= 0
  && shipmentConfirmationMaintenance > shipmentConfirmationCatch
  && shipmentConfirmationMaintenance < shipmentConfirmationFailure,
  'shipment confirmation must preserve retryable runtime maintenance before failing its command receipt',
)

const orderStatusSync = read(
  'app_src/app/api/operations/order-status-sync/route.ts',
)
const statusItemCatch = orderStatusSync.indexOf('} catch (error) {',
  orderStatusSync.indexOf('for (const candidate of candidates)'))
const statusItemMaintenance = orderStatusSync.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
  statusItemCatch,
)
const statusItemFailure = orderStatusSync.indexOf(
  'counts.failed += 1',
  statusItemCatch,
)
assert.ok(
  statusItemCatch >= 0
  && statusItemMaintenance > statusItemCatch
  && statusItemMaintenance < statusItemFailure,
  'order-status sync must abort maintenance before recording a failed candidate',
)

for (const relativePath of [
  'app_src/app/api/integrations/commerce/catalog/process/route.ts',
  'app_src/app/api/integrations/commerce/images/process/route.ts',
  'app_src/app/api/integrations/commerce/inventory/process/route.ts',
  'app_src/app/api/integrations/commerce/orders/process/route.ts',
  'app_src/app/api/integrations/commerce/shopify/carrier-service/route.ts',
]) {
  const source = read(relativePath)
  assert.ok(
    source.includes('isIntegrationCredentialRuntimeGateError'),
    `${relativePath} must recognize typed runtime maintenance`,
  )
  assert.ok(
    source.includes("'Retry-After': '60'"),
    `${relativePath} must emit a bounded retry hint`,
  )
  assert.ok(
    /['"]Cache-Control['"]:\s*['"][^'"]*no-store/iu.test(source),
    `${relativePath} must prevent maintenance-response caching`,
  )
}

for (const [relativePath, expectedFetches] of [
  ['app_src/lib/integrations/shopifyCommerceClient.ts', 2],
  ['app_src/lib/integrations/faireCommerceClient.ts', 2],
  ['app_src/lib/integrations/carrierCredentialClient.ts', 1],
  ['app_src/lib/integrations/carrierSandboxRate.ts', 1],
  ['app_src/lib/integrations/carrierWholeShipmentRateClient.ts', 1],
  ['app_src/lib/integrations/wwexSpeedshipClient.ts', 2],
  ['app_src/lib/integrations/rlCarriersFreightClient.ts', 2],
  ['app_src/lib/integrations/carrierSandboxLabel.ts', 2],
  ['app_src/lib/integrations/carrierOneOffGroupShipment.ts', 2],
  ['app_src/lib/integrations/commerceProviderImageFetch.ts', 1],
]) {
  const source = read(relativePath)
  const assertions = source.match(
    /assertIntegrationCredentialProviderIoReady\(\)/gu,
  )?.length || 0
  assert.ok(
    assertions >= expectedFetches,
    `${relativePath} must attest immediately before each provider request`,
  )
  assert.ok(
    source.includes('isIntegrationCredentialRuntimeGateError(error)'),
    `${relativePath} must preserve typed runtime maintenance`,
  )
}

for (const relativePath of [
  'app_src/lib/commerceCatalogSyncWorker.ts',
  'app_src/lib/commerceOrderHistoryWorker.ts',
  'app_src/lib/commerceFaireOrderRevisionWorker.ts',
  'app_src/lib/commerceShopifyOrderRevisionWorker.ts',
  'app_src/lib/shopifyOrderWebhookWorker.ts',
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  'app_src/lib/shopifyInventoryRefreshWorker.ts',
  'app_src/lib/faireInventoryPollingWorker.ts',
]) {
  const source = read(relativePath)
  assert.ok(
    source.includes('Promise.allSettled('),
    `${relativePath} must park all claimed work on a best-effort basis`,
  )
  const typedCatch = source.indexOf(
    'if (isIntegrationCredentialRuntimeGateError(error))',
  )
  const originalRethrow = source.indexOf('throw error', typedCatch)
  assert.ok(
    typedCatch >= 0 && originalRethrow > typedCatch,
    `${relativePath} must rethrow the original typed maintenance error`,
  )
}

const callback = read(
  'app_src/lib/integrations/shopifyCarrierServiceCallback.ts',
)
const fingerprintKeyStart = callback.indexOf('function callbackFingerprintKey')
const fingerprintKeyEnd = callback.indexOf(
  '\nfunction persistedRequestFingerprint',
  fingerprintKeyStart,
)
const fingerprintKeyBody = callback.slice(fingerprintKeyStart, fingerprintKeyEnd)
assert.ok(fingerprintKeyBody.includes('integrationCredentialRuntimeEncryptionKey()'))
assert.equal(
  fingerprintKeyBody.includes('SHOPIFY_CHECKOUT_FINGERPRINT_CONFIG_MISSING'),
  false,
  'callback fingerprinting must preserve the typed runtime gate error',
)
const postClaim = callback.indexOf("attemptedStage = 'post_claim'")
const postClaimGate = callback.indexOf(
  'assertIntegrationCredentialProviderIoReady()',
  postClaim,
)
const dispatch = callback.indexOf('rateOptimizedCheckoutPlans({', postClaim)
assert.ok(
  postClaim >= 0 && postClaimGate > postClaim && postClaimGate < dispatch,
  'checkout callback must reattest after claim and before provider dispatch',
)
assert.match(
  callback,
  /claimed\s*&&\s*!isIntegrationCredentialRuntimeGateError\(classifiedError\)[\s\S]*?await failClaim\(/u,
  'runtime maintenance must leave the checkout claim unresolved for retry',
)

const callbackRoute = read(
  'app_src/app/api/integrations/commerce/shopify/carrier-service/[accountGlobalId]/[token]/route.ts',
)
assert.ok(callbackRoute.includes("result.httpStatus === 503"))
assert.ok(callbackRoute.includes("'Retry-After': '60'"))

const webhookRoute = read(
  'app_src/app/api/integrations/commerce/shopify/webhooks/[accountGlobalId]/route.ts',
)
const webhookCatch = webhookRoute.lastIndexOf('} catch (error) {')
const webhookMaintenance = webhookRoute.indexOf(
  'integrationCredentialRuntimeMaintenanceResponse(error)',
  webhookCatch,
)
const webhookSanitization = webhookRoute.indexOf(
  'sanitizedCommerceIntegrationError(error)',
  webhookCatch,
)
assert.ok(
  webhookCatch >= 0
  && webhookMaintenance > webhookCatch
  && webhookSanitization > webhookMaintenance,
  'webhook maintenance must return before provider/business failure logging',
)

const rateWarmRoute = read(
  'app_src/app/api/integrations/commerce/shopify/rate-warm/route.ts',
)
const rateWarmCatch = rateWarmRoute.lastIndexOf('} catch (error) {')
const rateWarmMaintenance = rateWarmRoute.indexOf(
  'integrationCredentialRuntimeMaintenanceResponse(error)',
  rateWarmCatch,
)
const rateWarmGenericFailure = rateWarmRoute.indexOf(
  'genericFailure(safeStatus(error))',
  rateWarmCatch,
)
assert.ok(
  rateWarmCatch >= 0
  && rateWarmMaintenance > rateWarmCatch
  && rateWarmGenericFailure > rateWarmMaintenance,
  'rate-warm maintenance must return before its generic Shopify failure',
)

const cartonizationRoute = read(
  'app_src/app/api/integrations/commerce/intake/cartonization-rate-evidence/route.ts',
)
assert.ok(
  cartonizationRoute.includes(
    'claimedCommand && !isIntegrationCredentialRuntimeGateError(error)',
  ),
  'runtime maintenance must not finalize a rating command as failed',
)

console.log('PASS test-integration-credential-runtime-boundaries')
