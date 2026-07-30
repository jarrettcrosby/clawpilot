import { createHash, createHmac } from 'node:crypto'
import {
  fingerprintShopifyCarrierServiceRateRequest,
  readShopifyCarrierServiceRateRequest,
  safeShopifyCarrierServiceProtocolErrorPath,
  shopifyCarrierServiceRequestMatchesTestAllowlist,
  stableShopifyCarrierServiceCode,
  type ShopifyCarrierServiceRateResponse,
  type ShopifyCarrierServiceRateRequest,
} from '@/lib/integrations/shopifyCarrierServiceProtocol'
import {
  rateCheckoutShipment,
  type CheckoutRateDestination,
  type CheckoutRateProviderResult,
} from '@/lib/integrations/carrierCheckoutRate'
import { testCarrierSandboxShipmentRate } from '@/lib/integrations/carrierIntegrations'
import {
  carrierSandboxRateDestinationFingerprint,
} from '@/lib/integrations/carrierSandboxRate'
import {
  planShopifyCheckoutPackages,
  shopifyProductGid,
  shopifyVariantGid,
} from '@/lib/operations/shopifyCheckoutRating'
import { shopifyCheckoutDestinationFingerprint } from '@/lib/integrations/commerceCredentialCrypto'
import {
  claimShopifyCheckoutRateReceiptInPostgres,
  completeShopifyCheckoutRateReceiptInPostgres,
  failShopifyCheckoutRateReceiptInPostgres,
  lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres,
  readCachedShopifyCheckoutRateReceiptInPostgres,
  shopifyCheckoutPackagePlanHash,
  shopifyCheckoutRatingHash,
  type ShopifyCheckoutPackageInput,
  type ShopifyCheckoutRateReceipt,
  type ShopifyCheckoutRatingAccount,
} from '@/lib/persistence/shopifyCheckoutRating'
import {
  readShopifyCheckoutContextFromPostgres,
  type ShopifyCheckoutContextLine,
  type ShopifyCheckoutContextResult,
} from '@/lib/persistence/shopifyCheckoutContext'
import {
  waitForShopifyCheckoutReceiptCompletion,
} from '@/lib/integrations/shopifyCheckoutReceiptWait'
import {
  buildShopifyStoreEntityRateResponse,
  normalizeShopifyStoreEntityName,
  type ShopifyStoreEntityRateOffer,
} from '@/lib/integrations/shopifyCarrierServiceBranding'

const ACCOUNT_GLOBAL_ID = /^gia[0-9]{7}$/
const CALLBACK_TOKEN = /^[A-Za-z0-9_-]{43}$/
const CALLBACK_CARRIER_DEADLINE_MS = 8_000
const CALLBACK_SUCCESS_PERSISTENCE_DEADLINE_MS = 8_400
const CALLBACK_WORK_ABORT_MS = 8_700
const CALLBACK_FAILURE_PERSISTENCE_DEADLINE_MS = 8_950
const CALLBACK_RESPONSE_TIMEOUT_MS = 9_250
const CALLBACK_LEASE_SECONDS = 20
const MAX_PERSISTED_LINE_QUANTITY = 100_000
const MAX_PERSISTED_UNIT_WEIGHT_GRAMS = 1_000_000
const EMPTY_RATE_RESPONSE: ShopifyCarrierServiceRateResponse = { rates: [] }
const SHOPIFY_NUMERIC_ID = /^[1-9][0-9]{0,19}$/

export const SHOPIFY_CARRIER_SERVICE_CALLBACK_ACTOR =
  'system:shopify-carrier-service'

type CallbackResult =
  | {
      authenticated: false
      response: ShopifyCarrierServiceRateResponse
    }
  | {
      authenticated: true
      httpStatus: 200 | 503 | 504
      response: ShopifyCarrierServiceRateResponse
    }

type CheckoutFailureStage =
  | 'request_parse'
  | 'shadow_guard'
  | 'request_fingerprint'
  | 'warehouse_origin'
  | 'checkout_lines'
  | 'destination_fingerprint'
  | 'checkout_destination'
  | 'carrier_destination_fingerprint'
  | 'checkout_context'
  | 'execution_fence'
  | 'receipt_cache'
  | 'receipt_claim'
  | 'post_claim'

type CheckoutFailureCheckpoint =
  | 'account_ready'
  | 'request_parsed'
  | 'shadow_authorized'
  | 'fingerprinted'
  | 'origin_valid'
  | 'lines_valid'
  | 'destination_fingerprinted'
  | 'destination_valid'
  | 'carrier_destination_fingerprinted'
  | 'context_loaded'
  | 'execution_fenced'
  | 'cache_read'
  | 'claim_attempted'
  | 'receipt_claimed'

function authenticatedResult(
  response: ShopifyCarrierServiceRateResponse,
  httpStatus: 200 | 503 | 504,
): CallbackResult {
  return { authenticated: true, httpStatus, response }
}

function checkoutFailureError(
  code: string,
  message: string,
  cause?: unknown,
) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause })
  Object.assign(error, { code })
  return error
}

function failedHttpStatus(error: unknown): 503 | 504 {
  return errorCode(error)
    === 'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED'
    || errorCode(error) === 'CHECKOUT_RATE_DEADLINE_EXCEEDED'
    || errorCode(error) === 'SHOPIFY_CARRIER_REQUEST_ABORTED'
    ? 504
    : 503
}

function callbackFingerprintKey(): Buffer {
  const secret = String(
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
    || process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY
    || process.env.APP_SESSION_SECRET
    || '',
  )
  if (secret.length < 32) {
    throw checkoutFailureError(
      'SHOPIFY_CHECKOUT_FINGERPRINT_CONFIG_MISSING',
      'Shopify callback fingerprinting is not configured',
    )
  }
  return createHash('sha256').update(secret).digest()
}

function persistedRequestFingerprint(protocolDigest: string) {
  return createHmac('sha256', callbackFingerprintKey())
    .update(`shopify-carrier-request-fingerprint-v1:${protocolDigest}`)
    .digest('hex')
}

function fencedIdempotencyKey(input: {
  requestFingerprint: string
  configRowVersion: number
  activationState: 'shadow' | 'active'
  activationRevision: number
  inventorySnapshotHash: string
  executionFenceHash: string
}) {
  return `shopify-rate:${createHash('sha256')
    .update(JSON.stringify({
      version: 'shopify-checkout-idempotency-v2',
      ...input,
    }))
    .digest('hex')}`
}

function sandboxCheckoutAccountIsReady(
  account: ShopifyCheckoutRatingAccount | null,
): account is ShopifyCheckoutRatingAccount {
  if (
    !account
    || account.environment !== 'sandbox'
    || account.carriers.length !== 2
  ) {
    return false
  }
  try {
    normalizeShopifyStoreEntityName(account.storeEntityName)
  } catch {
    return false
  }
  const providers = new Set(account.carriers.map((carrier) => carrier.provider))
  return (
    providers.size === 2
    && providers.has('ups_rest')
    && providers.has('fedex_rest')
    && account.carriers.every((carrier) => (
      carrier.environment === 'sandbox'
      && carrier.accountStatus === 'active'
      && carrier.integrationStatus === 'active'
      && Number.isSafeInteger(carrier.credentialVersion)
      && carrier.credentialVersion > 0
    ))
  )
}

type ShadowCheckoutGuard =
  | { allowed: false; customerLabel: null }
  | { allowed: true; customerLabel: string | null }

function configuredIdentifierSet(
  environmentName: string,
): ReadonlySet<string> | null {
  const raw = String(process.env[environmentName] || '').trim()
  if (!raw) return null
  const identifiers = raw.split(',').map((entry) => entry.trim())
  if (
    identifiers.length < 1
    || identifiers.some((identifier) => !SHOPIFY_NUMERIC_ID.test(identifier))
  ) {
    return null
  }
  return new Set(identifiers)
}

function configuredShadowCustomerLabel(): string | null {
  const label = String(
    process.env.SHOPIFY_CHECKOUT_SHADOW_CUSTOMER_LABEL || '',
  )
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
  return (
    label
    && label.length <= 80
    && !/[\u0000-\u001f\u007f]/.test(label)
  )
    ? label
    : null
}

function shadowCheckoutRequestGuard(
  account: ShopifyCheckoutRatingAccount,
  request: ShopifyCarrierServiceRateRequest,
): ShadowCheckoutGuard {
  if (account.activationState !== 'shadow') {
    return { allowed: true, customerLabel: null }
  }
  const customerIds = configuredIdentifierSet(
    'SHOPIFY_CHECKOUT_SHADOW_ALLOWED_CUSTOMER_IDS',
  )
  const variantIds = configuredIdentifierSet(
    'SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS',
  )
  const customerLabel = configuredShadowCustomerLabel()
  if (
    !customerIds
    || !variantIds
    || !customerLabel
    || !shopifyCarrierServiceRequestMatchesTestAllowlist(request, {
      customerIds,
      variantIds,
    })
  ) {
    return { allowed: false, customerLabel: null }
  }
  return { allowed: true, customerLabel }
}

function checkoutExecutionFenceHash(
  account: ShopifyCheckoutRatingAccount,
  context: ShopifyCheckoutContextResult,
) {
  return createHash('sha256')
    .update(JSON.stringify({
      version: 'shopify-checkout-execution-fence-v2',
      accountEnvironment: account.environment,
      storeEntityName: normalizeShopifyStoreEntityName(
        account.storeEntityName,
      ),
      cartonizationInputHash: shopifyCheckoutRatingHash(context.input),
      materials: [...context.materials]
        .sort((left, right) => (
          left.materialGlobalId.localeCompare(right.materialGlobalId)
        ))
        .map((material) => ({
          materialGlobalId: material.materialGlobalId,
          materialRowVersion: material.rowVersion,
          stockGlobalId: material.stockGlobalId,
          stockRowVersion: material.stockRowVersion,
          stockOnHandQuantity: material.stockOnHandQuantity,
        })),
      carriers: [...account.carriers]
        .sort((left, right) => left.provider.localeCompare(right.provider))
        .map((carrier) => ({
          provider: carrier.provider,
          carrierAccountGlobalId: carrier.carrierAccountGlobalId,
          environment: carrier.environment,
          credentialVersion: carrier.credentialVersion,
        })),
    }))
    .digest('hex')
}

function normalizeAddressPart(value: unknown) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
}

function configuredWarehouseOriginMatches(
  request: ShopifyCarrierServiceRateRequest,
  warehouseAddress: Record<string, unknown>,
) {
  const configured = {
    line1: warehouseAddress.line1 ?? warehouseAddress.address1,
    city: warehouseAddress.city,
    region:
      warehouseAddress.regionCode
      ?? warehouseAddress.region
      ?? warehouseAddress.state,
    postalCode: warehouseAddress.postalCode ?? warehouseAddress.zip,
    countryCode:
      warehouseAddress.countryCode
      ?? warehouseAddress.country,
  }
  const supplied = {
    line1: request.origin.address1,
    city: request.origin.city,
    region: request.origin.provinceCode,
    postalCode: request.origin.postalCode,
    countryCode: request.origin.countryCode,
  }
  return Object.keys(configured).every((key) => {
    const field = key as keyof typeof configured
    const expected = normalizeAddressPart(configured[field])
    return expected
      && expected === normalizeAddressPart(supplied[field])
  })
}

function checkoutDestination(
  request: ShopifyCarrierServiceRateRequest,
): CheckoutRateDestination {
  if (request.destination.countryCode !== 'US') {
    throw checkoutFailureError(
      'SHOPIFY_CHECKOUT_DESTINATION_COUNTRY_UNSUPPORTED',
      'Checkout destination country is not supported',
    )
  }
  if (!request.destination.postalCode) {
    throw checkoutFailureError(
      'SHOPIFY_CHECKOUT_DESTINATION_NOT_READY',
      'Checkout destination is not rate-ready',
    )
  }
  return {
    name: null,
    line1: null,
    line2: null,
    city: null,
    region: null,
    postalCode: request.destination.postalCode,
    countryCode: 'US',
  }
}

function stableShippableLines(
  request: ShopifyCarrierServiceRateRequest,
): ShopifyCheckoutContextLine[] {
  const items = request.items
    .filter((item) => item.requiresShipping)
    .sort((left, right) => JSON.stringify({
      productId: left.productId,
      variantId: left.variantId,
      sku: left.sku,
      quantity: left.quantity,
      grams: left.grams,
      priceMinor: left.priceMinor,
      propertiesFingerprint: left.propertiesFingerprint,
    }).localeCompare(JSON.stringify({
      productId: right.productId,
      variantId: right.variantId,
      sku: right.sku,
      quantity: right.quantity,
      grams: right.grams,
      priceMinor: right.priceMinor,
      propertiesFingerprint: right.propertiesFingerprint,
    })))
  return items.map((item, index) => {
    if (item.quantity > MAX_PERSISTED_LINE_QUANTITY) {
      throw checkoutFailureError(
        'SHOPIFY_CHECKOUT_LINE_QUANTITY_UNSUPPORTED',
        'Checkout line quantity exceeds the durable rating limit',
      )
    }
    if (item.grams < 1) {
      throw checkoutFailureError(
        'SHOPIFY_CHECKOUT_LINE_WEIGHT_REQUIRED',
        'Checkout line requires a positive unit weight',
      )
    }
    if (item.grams > MAX_PERSISTED_UNIT_WEIGHT_GRAMS) {
      throw checkoutFailureError(
        'SHOPIFY_CHECKOUT_LINE_WEIGHT_UNSUPPORTED',
        'Checkout line weight exceeds the durable rating limit',
      )
    }
    return {
      lineKey: `shopify-line-${String(index + 1).padStart(3, '0')}`,
      productGid: shopifyProductGid(item.productId),
      variantGid: shopifyVariantGid(item.variantId),
      sku: item.sku || null,
      quantity: item.quantity,
      grams: item.grams,
      requiresShipping: true,
    }
  })
}

type TypedReceiptResponse = {
  response: ShopifyCarrierServiceRateResponse
}

function responseFromTypedReceipt(
  account: ShopifyCheckoutRatingAccount,
  context: ShopifyCheckoutContextResult,
  receipt: ShopifyCheckoutRateReceipt | null,
): TypedReceiptResponse | null {
  if (!receipt) return null
  if (receipt.status === 'failed') return null
  if (
    receipt.status !== 'succeeded'
    || !receipt.packagePlanHash
    || receipt.packages.length < 1
    || receipt.offers.length < 1
    || shopifyCheckoutPackagePlanHash({ packages: receipt.packages })
      !== receipt.packagePlanHash
  ) {
    return null
  }
  const resultSnapshot = receipt.resultSnapshot
  if (
    !receipt.resultHash
    || !resultSnapshot
    || resultSnapshot.protocolVersion
      !== 'shopify-carrier-service-response-v2'
    || shopifyCheckoutRatingHash(resultSnapshot) !== receipt.resultHash
    || resultSnapshot.packagePlanHash !== receipt.packagePlanHash
    || resultSnapshot.inventorySnapshotHash
      !== receipt.inventorySnapshotHash
    || resultSnapshot.packageCount !== receipt.packages.length
    || resultSnapshot.rateScope !== 'multi_package_shipment'
  ) {
    throw new Error(
      'Shopify checkout result evidence failed immutable replay validation',
    )
  }
  const storeEntityName = normalizeShopifyStoreEntityName(
    resultSnapshot.storeEntityName,
  )
  const materialByGlobalId = new Map(context.materials.map(
    (material) => [material.materialGlobalId, material],
  ))
  const requiredByMaterial = new Map<string, number>()
  for (const parcel of receipt.packages) {
    if (parcel.planningMethod === 'self_package') {
      const sourceLine = context.lines.find(
        (line) => line.lineKey === parcel.selfPackageLineKey,
      )
      const plannedLine = context.input.lines.find(
        (line) => line.lineGlobalId === parcel.selfPackageLineKey,
      )
      if (
        !sourceLine
        || !plannedLine
        || sourceLine.packProfileVersionGlobalId
          !== parcel.packProfileVersionGlobalId
        || sourceLine.packProfileVersionRowVersion
          !== parcel.packProfileVersionRowVersion
        || plannedLine.profile.shipsAsOwnPackage !== true
        || plannedLine.profile.packageLevel !== 'case'
        || plannedLine.profile.baseEachQuantity === undefined
        || plannedLine.profile.baseEachQuantity < 2
        || plannedLine.profile.outerDimensionsMm === null
        || plannedLine.profile.outerDimensionsMm === undefined
        || plannedLine.profile.grossWeightGrams
          !== parcel.grossWeightGrams
        || parcel.contentWeightGrams !== parcel.grossWeightGrams
        || parcel.tareWeightGrams !== 0
        || parcel.allocations.length !== 1
        || parcel.allocations[0].lineKey !== parcel.selfPackageLineKey
        || parcel.allocations[0].quantity !== 1
      ) {
        return null
      }
      continue
    }
    const material = materialByGlobalId.get(parcel.materialGlobalId)
    if (
      !material
      || parcel.materialRowVersion !== material.rowVersion
      || parcel.materialStockGlobalId !== material.stockGlobalId
      || parcel.materialStockRowVersion !== material.stockRowVersion
      || parcel.materialStockOnHandQuantity
        !== material.stockOnHandQuantity
    ) {
      return null
    }
    requiredByMaterial.set(
      parcel.materialGlobalId,
      (requiredByMaterial.get(parcel.materialGlobalId) || 0) + 1,
    )
  }
  if ([...requiredByMaterial].some(
    ([materialGlobalId, quantity]) => (
      (materialByGlobalId.get(materialGlobalId)?.stockOnHandQuantity || 0)
        < quantity
    ),
  )) {
    return null
  }
  const carrierByProvider = new Map(
    account.carriers.map((carrier) => [carrier.provider, carrier]),
  )
  const serviceCodes = new Set<string>()
  const typedOffers: ShopifyStoreEntityRateOffer[] =
    receipt.offers.map((offer) => {
      const carrier = carrierByProvider.get(offer.provider)
      const carrierCode = offer.provider === 'ups_rest' ? 'ups' : 'fedex'
      const stableCode = stableShopifyCarrierServiceCode(
        carrierCode,
        offer.serviceCode,
      )
      if (
        !carrier
        || carrier.environment !== 'sandbox'
        || carrier.carrierAccountGlobalId !== offer.carrierAccountGlobalId
        || carrier.credentialVersion !== offer.credentialVersion
        || offer.packageCount !== receipt.packages.length
        || offer.packagePlanHash !== receipt.packagePlanHash
        || offer.currency !== receipt.currency
        || offer.shopifyServiceCode !== stableCode
        || serviceCodes.has(stableCode)
      ) {
        throw new Error(
          'Typed Shopify checkout offer evidence failed replay validation',
        )
      }
      serviceCodes.add(stableCode)
      return {
        carrierCode,
        serviceLevelCode: offer.serviceCode,
        providerServiceName: offer.serviceName,
        amountMinor: offer.customerChargeMinor,
        currency: offer.currency,
        minDeliveryDate: deliveryTimestamp(offer.minDeliveryDate),
        maxDeliveryDate: deliveryTimestamp(offer.maxDeliveryDate),
      }
    })
  const rebuilt = buildShopifyStoreEntityRateResponse({
    storeEntityName,
    packageCount: receipt.packages.length,
    offers: typedOffers,
  })
  const expectedResponse = rebuilt.response
  if (
    shopifyCheckoutRatingHash(resultSnapshot.response)
      !== shopifyCheckoutRatingHash(expectedResponse)
  ) {
    throw new Error(
      'Shopify checkout response does not match typed receipt evidence',
    )
  }
  return {
    response: resultSnapshot.response as ShopifyCarrierServiceRateResponse,
  }
}

function resultFromTypedReceipt(
  account: ShopifyCheckoutRatingAccount,
  context: ShopifyCheckoutContextResult,
  receipt: ShopifyCheckoutRateReceipt | null,
): CallbackResult {
  const replay = responseFromTypedReceipt(account, context, receipt)
  return receipt?.status === 'succeeded' && replay
    ? authenticatedResult(replay.response, 200)
    : authenticatedResult(EMPTY_RATE_RESPONSE, 503)
}

function checkoutFailureStage(
  error: unknown,
  claimed: boolean,
  attemptedStage: CheckoutFailureStage,
) {
  if (!claimed && safeShopifyCarrierServiceProtocolErrorPath(error)) {
    return 'protocol'
  }
  return claimed ? 'post_claim' : attemptedStage
}

function fallbackReasonCode(stage: CheckoutFailureStage) {
  const suffix = stage.toUpperCase()
  return `SHOPIFY_CHECKOUT_${suffix}_FAILED`
}

function classifyCheckoutFailure(
  error: unknown,
  claimed: boolean,
  attemptedStage: CheckoutFailureStage,
) {
  if (claimed || errorCode(error) !== 'SHOPIFY_CHECKOUT_RATE_FAILED') {
    return error
  }
  return checkoutFailureError(
    fallbackReasonCode(attemptedStage),
    'Shopify checkout pre-claim fence failed',
    error,
  )
}

function recordCheckoutFailure(input: {
  accountGlobalId: string
  error: unknown
  claimed: boolean
  attemptedStage: CheckoutFailureStage
  checkpoint: CheckoutFailureCheckpoint
}) {
  const protocolPath = safeShopifyCarrierServiceProtocolErrorPath(input.error)
  console.warn('[shopify checkout rating] callback failed', {
    accountGlobalId: input.accountGlobalId,
    stage: checkoutFailureStage(
      input.error,
      input.claimed,
      input.attemptedStage,
    ),
    checkpoint: input.checkpoint,
    reasonCode: errorCode(input.error),
    receiptClaimed: input.claimed,
    ...(protocolPath ? { protocolPath } : {}),
  })
}

function deliveryTimestamp(value: string | null) {
  return value ? `${value}T23:59:59.000Z` : null
}

function errorCode(error: unknown) {
  const candidate = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : null
  return typeof candidate === 'string'
    && /^[A-Z][A-Z0-9_]{2,127}$/.test(candidate)
    ? candidate
    : 'SHOPIFY_CHECKOUT_RATE_FAILED'
}

function requireCallbackTime(
  deadlineAt: number,
  signal?: AbortSignal,
  code = 'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
) {
  if (signal?.aborted || Date.now() >= deadlineAt) {
    const error = new Error('Shopify checkout callback deadline exceeded')
    Object.assign(error, { code })
    throw error
  }
}

function callbackDeadlineError() {
  const error = new Error('Shopify checkout callback deadline exceeded')
  Object.assign(error, {
    code: 'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
  })
  return error
}

function awaitCallbackWork<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(callbackDeadlineError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(callbackDeadlineError())
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

async function failClaim(
  claim: {
    organizationId: string
    receiptGlobalId: string
    leaseToken: string
  },
  code: string,
  deadlineAt: number,
) {
  await failShopifyCheckoutRateReceiptInPostgres({
    ...claim,
    errorCode: code,
    cacheSeconds: 30,
    deadlineAt: new Date(deadlineAt).toISOString(),
    resultSnapshot: {
      protocolVersion: 'shopify-carrier-service-response-v1',
      response: EMPTY_RATE_RESPONSE,
      errorCode: code,
    },
  }).catch(() => null)
}

/**
 * Executes the authenticated Shopify callback. No branch in this function
 * writes CRM, reserves inventory, changes a provider catalog, buys postage,
 * creates labels, or applies MUD.
 */
export async function executeShopifyCarrierServiceCallback(input: {
  accountGlobalId: string
  callbackToken: string
  request: Request
}): Promise<CallbackResult> {
  if (
    !ACCOUNT_GLOBAL_ID.test(input.accountGlobalId)
    || !CALLBACK_TOKEN.test(input.callbackToken)
  ) {
    return { authenticated: false, response: EMPTY_RATE_RESPONSE }
  }
  const startedAt = Date.now()
  const carrierDeadlineAt = startedAt + CALLBACK_CARRIER_DEADLINE_MS
  const successPersistenceDeadlineAt =
    startedAt + CALLBACK_SUCCESS_PERSISTENCE_DEADLINE_MS
  const workDeadlineAt = startedAt + CALLBACK_WORK_ABORT_MS
  const failurePersistenceDeadlineAt =
    startedAt + CALLBACK_FAILURE_PERSISTENCE_DEADLINE_MS
  const workController = new AbortController()
  const abortFromRequest = () => workController.abort()
  if (input.request.signal.aborted) workController.abort()
  else input.request.signal.addEventListener(
    'abort',
    abortFromRequest,
    { once: true },
  )
  const workTimer = setTimeout(
    () => workController.abort(),
    CALLBACK_WORK_ABORT_MS,
  )
  const cleanup = () => {
    clearTimeout(workTimer)
    input.request.signal.removeEventListener('abort', abortFromRequest)
    workController.abort()
  }
  if (workController.signal.aborted) {
    cleanup()
    return authenticatedResult(EMPTY_RATE_RESPONSE, 504)
  }
  let account
  try {
    account = await awaitCallbackWork(
      lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres({
        accountGlobalId: input.accountGlobalId,
        callbackTokenHash: createHash('sha256')
          .update(input.callbackToken, 'ascii')
          .digest('hex'),
        allowShadowSimulation: false,
      }),
      workController.signal,
    )
  } catch (error) {
    const deadlineExceeded = workController.signal.aborted
    cleanup()
    return deadlineExceeded
      ? authenticatedResult(EMPTY_RATE_RESPONSE, 504)
      : authenticatedResult(
          EMPTY_RATE_RESPONSE,
          failedHttpStatus(error),
        )
  }
  if (!account) {
    cleanup()
    return { authenticated: false, response: EMPTY_RATE_RESPONSE }
  }
  if (!sandboxCheckoutAccountIsReady(account)) {
    cleanup()
    return authenticatedResult(EMPTY_RATE_RESPONSE, 503)
  }

  const authenticatedExecution = (async (): Promise<CallbackResult> => {
    let claimed: {
      organizationId: string
      receiptGlobalId: string
      leaseToken: string
    } | null = null
    let attemptedStage: CheckoutFailureStage = 'request_parse'
    let checkpoint: CheckoutFailureCheckpoint = 'account_ready'
    try {
    const request = await awaitCallbackWork(
      readShopifyCarrierServiceRateRequest(input.request, {
        signal: workController.signal,
      }),
      workController.signal,
    )
    checkpoint = 'request_parsed'
    attemptedStage = 'shadow_guard'
    const shadowGuard = shadowCheckoutRequestGuard(account, request)
    if (!shadowGuard.allowed) {
      return authenticatedResult(EMPTY_RATE_RESPONSE, 200)
    }
    checkpoint = 'shadow_authorized'
    attemptedStage = 'request_fingerprint'
    const requestFingerprint = persistedRequestFingerprint(
      fingerprintShopifyCarrierServiceRateRequest(request),
    )
    checkpoint = 'fingerprinted'
    attemptedStage = 'warehouse_origin'
    if (!configuredWarehouseOriginMatches(request, account.warehouseAddress)) {
      throw checkoutFailureError(
        'SHOPIFY_CHECKOUT_WAREHOUSE_ORIGIN_MISMATCH',
        'Shopify callback origin does not match the warehouse',
      )
    }
    checkpoint = 'origin_valid'
    attemptedStage = 'checkout_lines'
    const lines = stableShippableLines(request)
    if (!lines.length) {
      return authenticatedResult(EMPTY_RATE_RESPONSE, 200)
    }
    checkpoint = 'lines_valid'
    attemptedStage = 'destination_fingerprint'
    const destinationHash = shopifyCheckoutDestinationFingerprint(
      request.destination,
    )
    checkpoint = 'destination_fingerprinted'
    attemptedStage = 'checkout_destination'
    const destination = checkoutDestination(request)
    checkpoint = 'destination_valid'
    attemptedStage = 'carrier_destination_fingerprint'
    const carrierDestinationHash =
      carrierSandboxRateDestinationFingerprint(destination)
    checkpoint = 'carrier_destination_fingerprinted'
    attemptedStage = 'checkout_context'
    const context = await awaitCallbackWork(
      readShopifyCheckoutContextFromPostgres({
        account,
        lines,
      }),
      workController.signal,
    )
    checkpoint = 'context_loaded'
    attemptedStage = 'execution_fence'
    const executionFenceHash = checkoutExecutionFenceHash(account, context)
    const idempotencyKey = fencedIdempotencyKey({
      requestFingerprint,
      configRowVersion: account.configRowVersion,
      activationState: account.activationState,
      activationRevision: account.activationRevision,
      inventorySnapshotHash: context.inventorySnapshotHash,
      executionFenceHash,
    })
    checkpoint = 'execution_fenced'
    const cacheLookup = {
      organizationId: account.organizationId,
      accountGlobalId: account.accountGlobalId,
      requestFingerprint,
      inventorySnapshotHash: context.inventorySnapshotHash,
      idempotencyKey,
    }
    attemptedStage = 'receipt_cache'
    requireCallbackTime(workDeadlineAt, workController.signal)
    const cached =
      await awaitCallbackWork(
        readCachedShopifyCheckoutRateReceiptInPostgres(cacheLookup),
        workController.signal,
      )
    checkpoint = 'cache_read'
    if (cached) {
      return resultFromTypedReceipt(
        account,
        context,
        cached,
      )
    }
    requireCallbackTime(
      successPersistenceDeadlineAt,
      workController.signal,
    )
    attemptedStage = 'receipt_claim'
    checkpoint = 'claim_attempted'
    const claim = await awaitCallbackWork(
      claimShopifyCheckoutRateReceiptInPostgres({
        organizationId: account.organizationId,
        accountGlobalId: account.accountGlobalId,
        expectedConfigRowVersion: account.configRowVersion,
        expectedActivationState: account.activationState,
        expectedActivationRevision: account.activationRevision,
        requestFingerprint,
        destinationFingerprint: destinationHash,
        carrierDestinationFingerprint: carrierDestinationHash,
        inventorySnapshotHash: context.inventorySnapshotHash,
        inventorySnapshotAt: context.inventorySnapshotAt,
        currency: request.currency,
        idempotencyKey,
        claimedBy: SHOPIFY_CARRIER_SERVICE_CALLBACK_ACTOR,
        leaseSeconds: CALLBACK_LEASE_SECONDS,
        deadlineAt: new Date(successPersistenceDeadlineAt).toISOString(),
        redactedRequestSnapshot: {
          protocolVersion: 'shopify-carrier-service-request-v1',
          requestFingerprint,
          destinationFingerprint: destinationHash,
          carrierDestinationFingerprint: carrierDestinationHash,
          originWarehouseMatched: true,
          currency: request.currency,
          locale: request.locale,
          itemCount: request.items.length,
          shippableLineCount: lines.length,
          executionFenceHash,
        },
        lines: context.lines.map((line) => ({
          lineKey: line.lineKey,
          providerVariantId: line.variantGid,
          sku: line.sku,
          quantity: line.quantity,
          unitWeightGrams: line.unitWeightGrams,
          requiresShipping: true,
          lineSnapshot: {
            productGid: line.productGid,
            variantGid: line.variantGid,
            productGlobalId: line.productGlobalId,
            packMappingGlobalId: line.packMappingGlobalId,
            packProfileVersionGlobalId:
              line.packProfileVersionGlobalId,
            packProfileVersionRowVersion:
              line.packProfileVersionRowVersion,
            packageLevel: line.packageLevel,
            baseEachQuantity: line.baseEachQuantity,
            shipsAsOwnPackage: line.shipsAsOwnPackage,
            inventoryLevelGlobalIds: line.inventoryLevelGlobalIds,
            quantity: line.quantity,
            unitWeightGrams: line.unitWeightGrams,
          },
        })),
      }),
      workController.signal,
    )
    if (claim.kind === 'in_progress') {
      const completed =
        await waitForShopifyCheckoutReceiptCompletion({
          signal: workController.signal,
          deadlineAt: workDeadlineAt,
          read: () => awaitCallbackWork(
            readCachedShopifyCheckoutRateReceiptInPostgres(cacheLookup),
            workController.signal,
          ),
        })
      return resultFromTypedReceipt(
        account,
        context,
        completed,
      )
    }
    if (claim.kind !== 'claimed') {
      return resultFromTypedReceipt(
        account,
        context,
        claim.receipt,
      )
    }
    claimed = {
      organizationId: account.organizationId,
      receiptGlobalId: claim.receipt.globalId,
      leaseToken: claim.leaseToken,
    }
    checkpoint = 'receipt_claimed'
    attemptedStage = 'post_claim'
    requireCallbackTime(workDeadlineAt, workController.signal)
    const { plan, parcels } = planShopifyCheckoutPackages(context.input)
    const materialLimits = new Map(context.materials.map(
      (material) => [material.materialGlobalId, material.maxWeightGrams],
    ))
    const materialStock = new Map(context.materials.map(
      (material) => [
        material.materialGlobalId,
        material.stockOnHandQuantity,
      ],
    ))
    const plannedMaterialCounts = new Map<string, number>()
    for (const recipePackage of plan.recipePackages) {
      const gross = recipePackage.rateReadiness.ratedWeightGrams
      const maximum = materialLimits.get(
        recipePackage.packagingMaterialGlobalId,
      )
      if (!gross || !maximum || gross > maximum) {
        throw new Error('Carton plan exceeds packaging material weight limits')
      }
      plannedMaterialCounts.set(
        recipePackage.packagingMaterialGlobalId,
        (
          plannedMaterialCounts.get(
            recipePackage.packagingMaterialGlobalId,
          ) || 0
        ) + 1,
      )
    }
    for (const [materialGlobalId, required] of plannedMaterialCounts) {
      if ((materialStock.get(materialGlobalId) || 0) < required) {
        throw new Error('Carton plan exceeds packaging material stock')
      }
    }
    const carriers = account.carriers.map((carrier) => ({
      provider: carrier.provider,
      carrierAccountGlobalId: carrier.carrierAccountGlobalId,
    }))
    if (
      carriers.length !== 2
      || !carriers.some((carrier) => carrier.provider === 'ups_rest')
      || !carriers.some((carrier) => carrier.provider === 'fedex_rest')
      || account.carriers.some((carrier) => carrier.environment !== 'sandbox')
    ) {
      throw new Error('Checkout carrier configuration is not rate-ready')
    }
    const rated = await awaitCallbackWork(
      rateCheckoutShipment({
        destination,
        parcels,
        carriers,
        currency: request.currency,
        deadlineAt: carrierDeadlineAt,
        signal: workController.signal,
        invoke: async (selection, carrierRequest) => {
          const remaining = Math.max(1, carrierDeadlineAt - Date.now())
          const result = await testCarrierSandboxShipmentRate({
            organizationId: account.organizationId,
            provider: selection.provider,
            environment: 'sandbox',
            carrierAccountGlobalId: selection.carrierAccountGlobalId,
            destination: carrierRequest.destination,
            parcels: carrierRequest.parcels,
            actorEmail: SHOPIFY_CARRIER_SERVICE_CALLBACK_ACTOR,
            timeoutMs: remaining,
            signal: carrierRequest.signal,
          })
          return {
            provider: selection.provider,
            carrierAccountGlobalId: selection.carrierAccountGlobalId,
            packageCount: carrierRequest.parcels.length,
            rateScope: 'multi_package_shipment',
            rates: result.rates.map((rate) => ({
              ...rate,
              evidenceGlobalId: result.evidenceGlobalId,
            })),
          } satisfies CheckoutRateProviderResult
        },
      }),
      workController.signal,
    )
    requireCallbackTime(
      successPersistenceDeadlineAt,
      workController.signal,
    )
    const { response } = buildShopifyStoreEntityRateResponse({
      storeEntityName: account.storeEntityName,
      packageCount: rated.packageCount,
      offers: rated.offers.map((offer) => ({
        carrierCode: offer.carrierCode,
        serviceLevelCode: offer.serviceLevelCode,
        providerServiceName: offer.serviceName,
        amountMinor: offer.amountMinor,
        currency: offer.currency,
        minDeliveryDate: deliveryTimestamp(offer.deliveryDate),
        maxDeliveryDate: deliveryTimestamp(offer.deliveryDate),
      })),
    })
    const recipePackages: ShopifyCheckoutPackageInput[] =
      plan.recipePackages.map((recipePackage) => {
        const ratedOuterDimensionsMm =
          recipePackage.rateReadiness.ratedOuterDimensionsMm
        const tareWeightGrams = recipePackage.rateReadiness.tareWeightGrams
        const materialEvidence = context.materials.find(
          (material) => (
            material.materialGlobalId
              === recipePackage.packagingMaterialGlobalId
          ),
        )
        if (
          !ratedOuterDimensionsMm
          || tareWeightGrams === null
          || !materialEvidence
        ) {
          throw new Error('Carton plan lacks retained rating evidence')
        }
        return {
          planningMethod: 'approved_recipe',
          packageKey: recipePackage.packageKey,
          packageSequence: recipePackage.sequence,
          materialGlobalId: recipePackage.packagingMaterialGlobalId,
          materialRowVersion:
            recipePackage.packagingMaterialRowVersion,
          materialStockGlobalId: materialEvidence.stockGlobalId,
          materialStockRowVersion: materialEvidence.stockRowVersion,
          materialStockOnHandQuantity:
            materialEvidence.stockOnHandQuantity,
          ratedOuterDimensionsMm,
          contentWeightGrams: recipePackage.contentWeightGrams,
          tareWeightGrams,
          allocations: recipePackage.lineAllocations.map((allocation) => ({
            lineKey: allocation.lineGlobalId,
            quantity: allocation.quantity,
          })),
          packageSnapshot: {
            planningMethod: recipePackage.planningMethod,
            materialGlobalId: recipePackage.packagingMaterialGlobalId,
            recipeEvidence: recipePackage.recipeEvidence,
            ratedOuterDimensionsMm,
            contentWeightGrams: recipePackage.contentWeightGrams,
            tareWeightGrams,
          },
        }
      })
    const selfPackages: ShopifyCheckoutPackageInput[] =
      plan.selfPackages.map((selfPackage) => {
        const allocation = selfPackage.lineAllocations[0]
        const contextLine = context.lines.find(
          (line) => line.lineKey === allocation.lineGlobalId,
        )
        if (
          !contextLine
          || contextLine.packProfileVersionGlobalId
            !== selfPackage.packProfileVersionGlobalId
          || contextLine.packProfileVersionRowVersion
            !== selfPackage.packProfileVersionRowVersion
        ) {
          throw new Error('Self-package plan lacks retained line evidence')
        }
        return {
          planningMethod: 'self_package',
          packageKey: selfPackage.packageKey,
          packageSequence: selfPackage.sequence,
          packProfileVersionGlobalId:
            selfPackage.packProfileVersionGlobalId,
          packProfileVersionRowVersion:
            selfPackage.packProfileVersionRowVersion,
          selfPackageLineKey: allocation.lineGlobalId,
          ratedOuterDimensionsMm:
            selfPackage.rateReadiness.ratedOuterDimensionsMm,
          contentWeightGrams: selfPackage.contentWeightGrams,
          tareWeightGrams: 0,
          allocations: [{
            lineKey: allocation.lineGlobalId,
            quantity: 1,
          }],
          packageSnapshot: {
            planningMethod: selfPackage.planningMethod,
            lineKey: allocation.lineGlobalId,
            productGlobalId: allocation.productGlobalId,
            packProfileVersionGlobalId:
              selfPackage.packProfileVersionGlobalId,
            packProfileVersionRowVersion:
              selfPackage.packProfileVersionRowVersion,
            packageLevel: selfPackage.packageLevel,
            baseEachQuantity: selfPackage.baseEachQuantity,
            ratedOuterDimensionsMm:
              selfPackage.rateReadiness.ratedOuterDimensionsMm,
            contentWeightGrams: selfPackage.contentWeightGrams,
            tareWeightGrams: 0,
          },
        }
      })
    const packages: ShopifyCheckoutPackageInput[] = [
      ...selfPackages,
      ...recipePackages,
    ].sort((left, right) => (
      left.packageSequence - right.packageSequence
      || left.packageKey.localeCompare(right.packageKey)
    ))
    const packagePlanHash = shopifyCheckoutPackagePlanHash({ packages })
    requireCallbackTime(
      successPersistenceDeadlineAt,
      workController.signal,
    )
    const completed = await awaitCallbackWork(
      completeShopifyCheckoutRateReceiptInPostgres({
        ...claimed,
        packagePlanHash,
        deadlineAt: new Date(successPersistenceDeadlineAt).toISOString(),
        packages,
        offers: rated.offers.map((offer) => ({
          provider: offer.provider,
          carrierAccountGlobalId: offer.carrierAccountGlobalId,
          rateEvidenceGlobalId: offer.evidenceGlobalId,
          shopifyServiceCode: stableShopifyCarrierServiceCode(
            offer.carrierCode,
            offer.serviceLevelCode,
          ),
          serviceCode: offer.serviceLevelCode,
          serviceName: offer.serviceName,
          carrierCostMinor: offer.amountMinor,
          customerChargeMinor: offer.amountMinor,
          currency: offer.currency,
          minDeliveryDate: offer.deliveryDate,
          maxDeliveryDate: offer.deliveryDate,
          offerSnapshot: {
            carrierAccountGlobalId: offer.carrierAccountGlobalId,
            evidenceGlobalId: offer.evidenceGlobalId,
            rateScope: rated.rateScope,
            packageCount: rated.packageCount,
            transitDays: offer.transitDays,
            deliveryDate: offer.deliveryDate,
          },
        })),
        resultSnapshot: {
          protocolVersion: 'shopify-carrier-service-response-v2',
          storeEntityName: normalizeShopifyStoreEntityName(
            account.storeEntityName,
          ),
          response,
          packagePlanHash,
          inventorySnapshotHash: context.inventorySnapshotHash,
          rateScope: rated.rateScope,
          packageCount: rated.packageCount,
          completedAt: rated.completedAt,
        },
      }),
      workController.signal,
    )
    return resultFromTypedReceipt(
      account,
      context,
      completed,
    )
    } catch (error) {
      const classifiedError = classifyCheckoutFailure(
        error,
        Boolean(claimed),
        attemptedStage,
      )
      recordCheckoutFailure({
        accountGlobalId: account.accountGlobalId,
        error: classifiedError,
        claimed: Boolean(claimed),
        attemptedStage,
        checkpoint,
      })
      if (claimed && Date.now() < failurePersistenceDeadlineAt) {
        await failClaim(
          claimed,
          errorCode(classifiedError),
          failurePersistenceDeadlineAt,
        )
      }
      return authenticatedResult(
        EMPTY_RATE_RESPONSE,
        failedHttpStatus(classifiedError),
      )
    }
  })()
  let responseTimer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<CallbackResult>((resolve) => {
    responseTimer = setTimeout(
      () => {
        workController.abort()
        resolve(authenticatedResult(EMPTY_RATE_RESPONSE, 504))
      },
      Math.max(
        1,
        startedAt + CALLBACK_RESPONSE_TIMEOUT_MS - Date.now(),
      ),
    )
  })
  try {
    return await Promise.race([authenticatedExecution, timeout])
  } finally {
    if (responseTimer) clearTimeout(responseTimer)
    cleanup()
  }
}
