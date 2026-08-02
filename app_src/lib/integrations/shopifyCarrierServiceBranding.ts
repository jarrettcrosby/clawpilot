// Node's focused strip-types tests need the explicit extension.
// @ts-expect-error TypeScript extension imports are intentional for Node tests.
import { buildShopifyCarrierServiceRateResponse, type ShopifyCarrierServiceRateResponse } from './shopifyCarrierServiceProtocol.ts'

const SHOPIFY_RATE_TEXT_LIMIT = 255
const SHOPIFY_STORE_ENTITY_LIMIT = 255
const SHOPIFY_PROVIDER_SERVICE_LIMIT = 160
const RATE_NAME_SEPARATOR = ' · '
const GRAMS_PER_POUND = 453.59237

export type ShopifyStoreEntityRateOffer = {
  carrierCode: 'ups' | 'fedex'
  serviceLevelCode: string
  providerServiceName: string
  amountMinor: number
  currency: string
  minDeliveryDate: string | null
  maxDeliveryDate: string | null
}

export type ShopifyCheckoutRatePackageSummary = {
  packageSequence: number
  itemCount: number
  contentWeightGrams: number
  tareWeightGrams: number
  grossWeightGrams: number
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

function exactPackageInteger(
  value: unknown,
  label: string,
  minimum: number,
) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

function pounds(weightGrams: number) {
  return (weightGrams / GRAMS_PER_POUND).toFixed(2)
}

function shippingSummary(
  input: readonly ShopifyCheckoutRatePackageSummary[],
) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 50) {
    throw new Error('Shopify checkout package summary is invalid')
  }
  const sequences = new Set<number>()
  let itemCount = 0
  let contentWeightGrams = 0
  let tareWeightGrams = 0
  let grossWeightGrams = 0
  const packages = input.map((item) => {
    const packageSequence = exactPackageInteger(
      item.packageSequence,
      'Shopify checkout package sequence',
      1,
    )
    const packageItemCount = exactPackageInteger(
      item.itemCount,
      'Shopify checkout package item count',
      1,
    )
    const packageContentWeightGrams = exactPackageInteger(
      item.contentWeightGrams,
      'Shopify checkout package content weight',
      1,
    )
    const packageTareWeightGrams = exactPackageInteger(
      item.tareWeightGrams,
      'Shopify checkout package tare weight',
      0,
    )
    const packageGrossWeightGrams = exactPackageInteger(
      item.grossWeightGrams,
      'Shopify checkout package gross weight',
      1,
    )
    if (
      sequences.has(packageSequence)
      || packageContentWeightGrams + packageTareWeightGrams
        !== packageGrossWeightGrams
    ) {
      throw new Error('Shopify checkout package summary is inconsistent')
    }
    sequences.add(packageSequence)
    itemCount += packageItemCount
    contentWeightGrams += packageContentWeightGrams
    tareWeightGrams += packageTareWeightGrams
    grossWeightGrams += packageGrossWeightGrams
    if (
      !Number.isSafeInteger(itemCount)
      || !Number.isSafeInteger(contentWeightGrams)
      || !Number.isSafeInteger(tareWeightGrams)
      || !Number.isSafeInteger(grossWeightGrams)
    ) {
      throw new Error('Shopify checkout package summary exceeds exact limits')
    }
    return {
      packageSequence,
      itemCount: packageItemCount,
      tareWeightGrams: packageTareWeightGrams,
      grossWeightGrams: packageGrossWeightGrams,
    }
  }).sort((left, right) => left.packageSequence - right.packageSequence)

  return {
    core: [
      `${packages.length} ${packages.length === 1 ? 'package' : 'packages'}`,
      `${itemCount} ${itemCount === 1 ? 'item' : 'items'}`,
      `${pounds(grossWeightGrams)} lb gross`,
      `${pounds(contentWeightGrams)} lb items`,
      `${pounds(tareWeightGrams)} lb tare`,
    ].join(RATE_NAME_SEPARATOR),
    packageDetail: packages.length > 1
      ? packages.map((item) => (
        `P${item.packageSequence}: ${item.itemCount} `
        + `${item.itemCount === 1 ? 'item' : 'items'}, `
        + `${pounds(item.grossWeightGrams)} lb gross, `
        + `${pounds(item.tareWeightGrams)} lb tare`
      )).join('; ')
      : '',
  }
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
  packages?: readonly ShopifyCheckoutRatePackageSummary[]
}) {
  const storeEntityName = normalizeShopifyStoreEntityName(
    input.storeEntityName,
  )
  const carrierDisplayName = SHOPIFY_CARRIER_DISPLAY_NAMES[input.carrierCode]
  const providerServiceName = normalizeProviderServiceName(input)
  const shipping = input.packages
    ? shippingSummary(input.packages)
    : null
  const coreSuffix = (
    RATE_NAME_SEPARATOR
    + carrierDisplayName
    + RATE_NAME_SEPARATOR
    + providerServiceName
    + (shipping ? RATE_NAME_SEPARATOR + shipping.core : '')
  )
  const storeBudget = SHOPIFY_RATE_TEXT_LIMIT - coreSuffix.length
  if (storeBudget < 1) {
    throw new Error(
      'Shopify rate name cannot retain service and package totals',
    )
  }
  const coreName = (
    sliceWithoutSplittingCodePoint(storeEntityName, storeBudget)
    + coreSuffix
  )
  if (!shipping?.packageDetail) return coreName
  const detailSuffix = RATE_NAME_SEPARATOR + shipping.packageDetail
  return coreName.length + detailSuffix.length <= SHOPIFY_RATE_TEXT_LIMIT
    ? coreName + detailSuffix
    : coreName
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
  packages?: readonly ShopifyCheckoutRatePackageSummary[]
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
  if (
    input.packages
    && Number(input.packageCount) !== input.packages.length
  ) {
    throw new Error('Shopify checkout package summary count is inconsistent')
  }
  const response = buildShopifyCarrierServiceRateResponse(
    sorted.map((offer) => ({
      carrierCode: offer.carrierCode,
      serviceLevelCode: offer.serviceLevelCode,
      serviceName: shopifyStoreEntityRateName({
        storeEntityName,
        carrierCode: offer.carrierCode,
        providerServiceName: offer.providerServiceName,
        packages: input.packages,
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
