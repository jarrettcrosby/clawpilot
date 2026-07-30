// Node's focused strip-types tests need the explicit extension.
// @ts-expect-error TypeScript extension imports are intentional for Node tests.
import { buildShopifyCarrierServiceRateResponse, type ShopifyCarrierServiceRateResponse } from './shopifyCarrierServiceProtocol.ts'

const SHOPIFY_RATE_TEXT_LIMIT = 255
const SHOPIFY_STORE_ENTITY_LIMIT = 255
const SHOPIFY_PROVIDER_SERVICE_LIMIT = 160
const RATE_NAME_SEPARATOR = ' · '

export type ShopifyStoreEntityRateOffer = {
  carrierCode: 'ups' | 'fedex'
  serviceLevelCode: string
  providerServiceName: string
  amountMinor: number
  currency: string
  minDeliveryDate: string | null
  maxDeliveryDate: string | null
}

const SHOPIFY_CARRIER_DISPLAY_NAMES: Record<
  ShopifyStoreEntityRateOffer['carrierCode'],
  string
> = {
  ups: 'UPS',
  fedex: 'FedEx',
}

const SHOPIFY_PROVIDER_PREFIX_PATTERNS: Record<
  ShopifyStoreEntityRateOffer['carrierCode'],
  RegExp
> = {
  ups: /^UPS(?:®)?(?=\s|$)/iu,
  fedex: /^FedEx(?=\s|$)/iu,
}

function exceedsCodePointLimit(value: string, maximum: number) {
  let count = 0
  for (const unused of value) {
    void unused
    count += 1
    if (count > maximum) return true
  }
  return false
}

function normalizedComponent(
  value: unknown,
  label: string,
  maximum: number,
) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be text`)
  }
  const normalized = value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
  if (
    normalized.length < 1
    || exceedsCodePointLimit(normalized, maximum)
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`${label} is missing or invalid`)
  }
  return normalized
}

export function normalizeShopifyStoreEntityName(value: unknown) {
  return normalizedComponent(
    value,
    'Provider-verified Shopify store entity name',
    SHOPIFY_STORE_ENTITY_LIMIT,
  )
}

/**
 * Shopify renders the CarrierService resource name in merchant shipping
 * settings and can expose it to customers. Keep that provider-owned resource
 * branded by the verified store entity; ClawPilot remains an internal adapter
 * identity and must not leak into the merchant-facing label.
 */
export function shopifyStoreEntityCarrierServiceName(value: unknown) {
  return normalizeShopifyStoreEntityName(value)
}

function sliceWithoutSplittingCodePoint(value: string, codeUnitBudget: number) {
  let result = ''
  for (const codePoint of value) {
    if (result.length + codePoint.length > codeUnitBudget) break
    result += codePoint
  }
  return result
}

function normalizeProviderServiceName(input: {
  carrierCode: ShopifyStoreEntityRateOffer['carrierCode']
  providerServiceName: unknown
}) {
  const providerServiceName = normalizedComponent(
    input.providerServiceName,
    'Provider service name',
    SHOPIFY_PROVIDER_SERVICE_LIMIT,
  )
  const serviceName = providerServiceName
    .replace(SHOPIFY_PROVIDER_PREFIX_PATTERNS[input.carrierCode], '')
    .trim()
  return normalizedComponent(
    serviceName,
    'Provider service name',
    SHOPIFY_PROVIDER_SERVICE_LIMIT,
  )
}

export function shopifyStoreEntityRateName(input: {
  storeEntityName: unknown
  carrierCode: ShopifyStoreEntityRateOffer['carrierCode']
  providerServiceName: unknown
}) {
  const storeEntityName = normalizeShopifyStoreEntityName(
    input.storeEntityName,
  )
  const carrierDisplayName = SHOPIFY_CARRIER_DISPLAY_NAMES[input.carrierCode]
  const providerServiceName = normalizeProviderServiceName(input)
  const retainedSuffix = (
    RATE_NAME_SEPARATOR
    + carrierDisplayName
    + RATE_NAME_SEPARATOR
    + providerServiceName
  )
  const storeBudget = SHOPIFY_RATE_TEXT_LIMIT - retainedSuffix.length
  if (storeBudget < 1) {
    throw new Error('Shopify rate name cannot retain every required component')
  }
  return (
    sliceWithoutSplittingCodePoint(storeEntityName, storeBudget)
    + retainedSuffix
  )
}

export function shopifyStoreEntityRateDescription(input: {
  storeEntityName: unknown
  packageCount: unknown
}) {
  const storeEntityName = normalizeShopifyStoreEntityName(
    input.storeEntityName,
  )
  const packageCount = Number(input.packageCount)
  if (
    !Number.isSafeInteger(packageCount)
    || packageCount < 1
    || packageCount > 50
  ) {
    throw new Error('Shopify checkout package count is invalid')
  }
  const retainedSuffix = (
    RATE_NAME_SEPARATOR
    + `${packageCount}-package shipment`
  )
  return (
    sliceWithoutSplittingCodePoint(
      storeEntityName,
      SHOPIFY_RATE_TEXT_LIMIT - retainedSuffix.length,
    )
    + retainedSuffix
  )
}

export function buildShopifyStoreEntityRateResponse(input: {
  storeEntityName: unknown
  packageCount: unknown
  offers: readonly ShopifyStoreEntityRateOffer[]
}): {
  response: ShopifyCarrierServiceRateResponse
} {
  const storeEntityName = normalizeShopifyStoreEntityName(
    input.storeEntityName,
  )
  const sorted = [...input.offers].sort((left, right) => (
    left.amountMinor - right.amountMinor
    || left.carrierCode.localeCompare(right.carrierCode)
    || left.serviceLevelCode.localeCompare(right.serviceLevelCode)
  ))
  const response = buildShopifyCarrierServiceRateResponse(
    sorted.map((offer) => ({
      carrierCode: offer.carrierCode,
      serviceLevelCode: offer.serviceLevelCode,
      serviceName: shopifyStoreEntityRateName({
        storeEntityName,
        carrierCode: offer.carrierCode,
        providerServiceName: offer.providerServiceName,
      }),
      description: shopifyStoreEntityRateDescription({
        storeEntityName,
        packageCount: input.packageCount,
      }),
      amountMinor: offer.amountMinor,
      currency: offer.currency,
      minDeliveryDate: offer.minDeliveryDate,
      maxDeliveryDate: offer.maxDeliveryDate,
    })),
  )
  return { response }
}
