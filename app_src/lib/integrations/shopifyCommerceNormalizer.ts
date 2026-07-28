import {
  COMMERCE_NORMALIZATION_ENVELOPE_VERSION,
  COMMERCE_NORMALIZED_ORDER_LINE_VERSION,
  COMMERCE_NORMALIZED_ORDER_VERSION,
  COMMERCE_NORMALIZED_PRODUCT_VERSION,
  COMMERCE_NORMALIZED_VARIANT_VERSION,
  CommerceNormalizationError,
  asCommerceRecord,
  availableCommerceField,
  buildCommerceReadinessFacts,
  commerceAddressFromRecord,
  commerceConnectionValues,
  commerceMoneyFromDecimal,
  commerceOrderHeaderMoneyState,
  commercePackagingFromRecord,
  commerceSourceHash,
  createCommerceExternalIdentity,
  createCommerceNormalizationRejection,
  freezeCommerceEnvelope,
  normalizeCommerceCurrency,
  nonnegativeCommerceInteger,
  optionalCommerceText,
  optionalCommerceTimestamp,
  redactedCommerceField,
  requiredCommerceText,
  unavailableCommerceField,
  validateCommerceNormalizationContext,
  type CommerceCanonicalStates,
  type CommerceDataField,
  type CommerceExternalIdentity,
  type CommerceMoney,
  type CommerceMoneySet,
  type CommerceNormalizationContext,
  type CommerceNormalizationEnvelope,
  type CommerceNormalizationRejection,
  type CommerceNormalizationRejectionCode,
  type CommerceNormalizedOrder,
  type CommerceNormalizedOrderLine,
  type CommerceNormalizedProduct,
  type CommerceNormalizedVariant,
  type CommercePartySnapshot,
  type CommerceProviderStates,
  type ReadOnlyCommerceNormalizationAdapter,
} from '@/lib/operations/commerceNormalization'

export const SHOPIFY_COMMERCE_NORMALIZER_VERSION =
  'shopify-commerce-normalizer-v1' as const

type ShopifySource = Readonly<Record<string, unknown>>

const GID_PATTERNS = {
  order: /^gid:\/\/shopify\/Order\/[^/?#]+(?:[?#].*)?$/,
  order_line: /^gid:\/\/shopify\/LineItem\/[^/?#]+(?:[?#].*)?$/,
  product: /^gid:\/\/shopify\/Product\/[^/?#]+(?:[?#].*)?$/,
  variant: /^gid:\/\/shopify\/ProductVariant\/[^/?#]+(?:[?#].*)?$/,
  inventory_item: /^gid:\/\/shopify\/InventoryItem\/[^/?#]+(?:[?#].*)?$/,
  customer: /^gid:\/\/shopify\/Customer\/[^/?#]+(?:[?#].*)?$/,
  company: /^gid:\/\/shopify\/Company\/[^/?#]+(?:[?#].*)?$/,
  company_location: /^gid:\/\/shopify\/CompanyLocation\/[^/?#]+(?:[?#].*)?$/,
  shop: /^gid:\/\/shopify\/Shop\/[^/?#]+(?:[?#].*)?$/,
} as const

function shopifyIdentity(
  value: unknown,
  resourceType: 'inventory_item' | 'order' | 'order_line' | 'product' | 'variant',
): CommerceExternalIdentity {
  const text = requiredCommerceText(value, `Shopify ${resourceType} GID`)
  if (!GID_PATTERNS[resourceType].test(text)) {
    throw new Error(`Shopify returned an invalid ${resourceType} GID`)
  }
  return createCommerceExternalIdentity('shopify', resourceType, text)
}

function optionalShopifyIdentity(
  value: unknown,
  resourceType: 'inventory_item' | 'product' | 'variant',
): CommerceDataField<CommerceExternalIdentity> {
  if (value === undefined || value === null || value === '') {
    return unavailableCommerceField()
  }
  return availableCommerceField(shopifyIdentity(value, resourceType))
}

function recordId(value: unknown): unknown {
  return asCommerceRecord(value)?.id
}

function moneyValue(value: unknown): CommerceMoney | null {
  const money = asCommerceRecord(value)
  if (!money) return null
  const amount = money.amount
  const currency = money.currencyCode ?? money.currency
  if (typeof amount !== 'string' || typeof currency !== 'string') return null
  return commerceMoneyFromDecimal(amount, currency)
}

function shopifyMoneySet(
  value: unknown,
  fallbackCurrency?: unknown,
): CommerceDataField<CommerceMoneySet> {
  if (typeof value === 'string' && typeof fallbackCurrency === 'string') {
    const money = commerceMoneyFromDecimal(value, fallbackCurrency)
    return availableCommerceField(Object.freeze({
      primary: money,
      shop: availableCommerceField(money),
      presentment: unavailableCommerceField('not_provided'),
    }))
  }
  const bag = asCommerceRecord(value)
  if (!bag) return unavailableCommerceField()
  const direct = moneyValue(bag)
  if (direct) {
    return availableCommerceField(Object.freeze({
      primary: direct,
      shop: availableCommerceField(direct),
      presentment: unavailableCommerceField('not_provided'),
    }))
  }
  const shop = moneyValue(bag.shopMoney)
  const presentment = moneyValue(bag.presentmentMoney)
  const primary = shop || presentment
  if (!primary) return unavailableCommerceField()
  return availableCommerceField(Object.freeze({
    primary,
    shop: shop
      ? availableCommerceField(shop)
      : unavailableCommerceField('not_provided'),
    presentment: presentment
      ? availableCommerceField(presentment)
      : unavailableCommerceField('not_provided'),
  }))
}

function sumMoneySets(values: readonly unknown[]): CommerceDataField<CommerceMoneySet> {
  const parsed = values
    .map(shopifyMoneySet)
    .filter((field): field is Extract<
      CommerceDataField<CommerceMoneySet>,
      { state: 'available' }
    > => field.state === 'available')
  if (!parsed.length) return unavailableCommerceField()
  const sum = (
    selector: (set: CommerceMoneySet) => CommerceDataField<CommerceMoney>,
  ): CommerceDataField<CommerceMoney> => {
    const fields = parsed.map(({ value }) => selector(value))
    if (fields.some((field) => field.state !== 'available')) {
      return unavailableCommerceField()
    }
    const money = fields.map((field) => (
      field as Extract<typeof field, { state: 'available' }>
    ).value)
    const currency = money[0].currency
    if (money.some((item) => item.currency !== currency)) {
      return unavailableCommerceField()
    }
    return availableCommerceField(Object.freeze({
      amountMinor: money.reduce(
        (total, item) => total + item.amountMinor,
        BigInt(0),
      ),
      currency,
    }))
  }
  const primaryCurrency = parsed[0].value.primary.currency
  if (parsed.some(({ value }) => value.primary.currency !== primaryCurrency)) {
    return unavailableCommerceField()
  }
  const primary = Object.freeze({
    amountMinor: parsed.reduce(
      (total, { value }) => total + value.primary.amountMinor,
      BigInt(0),
    ),
    currency: primaryCurrency,
  })
  return availableCommerceField(Object.freeze({
    primary,
    shop: sum((set) => set.shop),
    presentment: sum((set) => set.presentment),
  }))
}

function subtractMoneySets(
  minuendValue: unknown,
  subtrahendValue: unknown,
): CommerceDataField<CommerceMoneySet> {
  const minuend = shopifyMoneySet(minuendValue)
  const subtrahend = shopifyMoneySet(subtrahendValue)
  if (minuend.state !== 'available' || subtrahend.state !== 'available') {
    return unavailableCommerceField()
  }
  const subtract = (
    left: CommerceDataField<CommerceMoney>,
    right: CommerceDataField<CommerceMoney>,
  ): CommerceDataField<CommerceMoney> => {
    if (left.state !== 'available' || right.state !== 'available') {
      return unavailableCommerceField()
    }
    if (
      left.value.currency !== right.value.currency
      || left.value.amountMinor < right.value.amountMinor
    ) {
      return unavailableCommerceField('not_supported')
    }
    return availableCommerceField(Object.freeze({
      amountMinor: left.value.amountMinor - right.value.amountMinor,
      currency: left.value.currency,
    }))
  }
  if (
    minuend.value.primary.currency !== subtrahend.value.primary.currency
    || minuend.value.primary.amountMinor < subtrahend.value.primary.amountMinor
  ) {
    return unavailableCommerceField('not_supported')
  }
  return availableCommerceField(Object.freeze({
    primary: Object.freeze({
      amountMinor:
        minuend.value.primary.amountMinor - subtrahend.value.primary.amountMinor,
      currency: minuend.value.primary.currency,
    }),
    shop: subtract(minuend.value.shop, subtrahend.value.shop),
    presentment: subtract(
      minuend.value.presentment,
      subtrahend.value.presentment,
    ),
  }))
}

function nodeRecord(value: unknown): Record<string, unknown> | null {
  return asCommerceRecord(value)
}

function propertyExists(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function selectedOptions(value: unknown) {
  if (value === null || value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 25) {
    throw new Error('Shopify returned invalid selected product options')
  }
  const normalized = value.map((option) => {
    const record = asCommerceRecord(option)
    if (!record) {
      throw new Error('Shopify returned an invalid selected product option')
    }
    return Object.freeze({
      name: requiredCommerceText(
        record.name,
        'Shopify selected option name',
        255,
      ),
      value: requiredCommerceText(
        record.value,
        'Shopify selected option value',
        512,
      ),
    })
  })
  if (
    new TextEncoder().encode(JSON.stringify(normalized)).byteLength > 16_384
  ) {
    throw new Error('Shopify returned oversized selected product options')
  }
  return Object.freeze(normalized)
}

function shopifyWeightGrams(inventoryItemValue: unknown): number | null {
  const inventoryItem = asCommerceRecord(inventoryItemValue)
  const measurement = asCommerceRecord(inventoryItem?.measurement)
  const weight = asCommerceRecord(measurement?.weight)
  if (!weight || typeof weight.value !== 'number') return null
  if (!Number.isFinite(weight.value) || weight.value <= 0) return null
  const multipliers = {
    GRAMS: 1,
    KILOGRAMS: 1_000,
    OUNCES: 28.349523125,
    POUNDS: 453.59237,
  } as const
  const unit = typeof weight.unit === 'string'
    ? weight.unit.trim().toUpperCase()
    : ''
  const multiplier = multipliers[unit as keyof typeof multipliers]
  if (!multiplier) return null
  const grams = Math.round(weight.value * multiplier)
  return Number.isSafeInteger(grams) && grams > 0 ? grams : null
}

function packaging(
  primary: Record<string, unknown>,
  secondary?: Record<string, unknown> | null,
) {
  const direct = commercePackagingFromRecord(
    primary.packaging,
    'order_line',
  )
  if (direct.state === 'available') return direct
  return commercePackagingFromRecord(
    secondary?.packaging,
    'product_variant',
  )
}

function normalizeVariant(
  source: unknown,
  productIdentity: CommerceExternalIdentity,
  productRecord: Record<string, unknown>,
  currencyFallback: unknown,
): CommerceNormalizedVariant {
  const variant = nodeRecord(source)
  if (!variant) throw new Error('Shopify returned an invalid product variant')
  const identity = shopifyIdentity(variant.id, 'variant')
  const sku = optionalCommerceText(variant.sku, 255)
  const inventoryItem = nodeRecord(variant.inventoryItem)
  const inventory = propertyExists(variant, 'inventoryQuantity')
    && Number.isSafeInteger(variant.inventoryQuantity)
    ? availableCommerceField(Object.freeze({
        quantity: Number(variant.inventoryQuantity),
        name: 'available',
      }))
    : unavailableCommerceField(
        propertyExists(variant, 'inventoryQuantity')
          ? 'not_supported'
          : 'not_provided',
      )
  return Object.freeze({
    schemaVersion: COMMERCE_NORMALIZED_VARIANT_VERSION,
    identity,
    productIdentity,
    inventoryItemIdentity: optionalShopifyIdentity(
      inventoryItem?.id,
      'inventory_item',
    ),
    sku,
    barcode: optionalCommerceText(variant.barcode, 255),
    title: optionalCommerceText(
      variant.displayName ?? variant.title,
      512,
    ),
    selectedOptions: selectedOptions(variant.selectedOptions),
    unitMultiplier: null,
    wholesalePrice: shopifyMoneySet(variant.price, currencyFallback),
    retailPrice: shopifyMoneySet(variant.compareAtPrice, currencyFallback),
    taxable: optionalBoolean(variant.taxable),
    requiresShipping: optionalBoolean(inventoryItem?.requiresShipping),
    inventory,
    packaging: packaging(variant, productRecord),
    weightGrams: shopifyWeightGrams(inventoryItem),
    providerCreatedAt: optionalCommerceTimestamp(
      variant.createdAt ?? productRecord.createdAt,
    ),
    providerUpdatedAt: optionalCommerceTimestamp(
      variant.updatedAt ?? productRecord.updatedAt,
    ),
    sourceHash: commerceSourceHash(Object.freeze({
      product: productRecord,
      variant,
    })),
  })
}

function normalizeProduct(
  source: unknown,
  externalAccountId: string,
  currencyFallback: unknown,
): CommerceNormalizedProduct {
  const product = nodeRecord(source)
  if (!product) throw new Error('Shopify returned an invalid product')
  const identity = shopifyIdentity(product.id, 'product')
  const variants = commerceConnectionValues(product.variants)
    .map((variant) => normalizeVariant(
      variant,
      identity,
      product,
      product.currencyCode ?? currencyFallback,
    ))
  const lifecycleState = optionalCommerceText(product.status, 64)
  const brandIdentity = GID_PATTERNS.shop.test(externalAccountId)
    ? availableCommerceField(
        createCommerceExternalIdentity('shopify', 'brand', externalAccountId),
      )
    : unavailableCommerceField<CommerceExternalIdentity>('not_supported')
  return Object.freeze({
    schemaVersion: COMMERCE_NORMALIZED_PRODUCT_VERSION,
    identity,
    brandIdentity,
    title: requiredCommerceText(product.title, 'Shopify product title', 500),
    description: optionalCommerceText(
      product.description ?? product.descriptionHtml,
      20_000,
    ),
    vendor: optionalCommerceText(product.vendor, 512),
    productType: optionalCommerceText(product.productType, 512),
    lifecycleState,
    active: lifecycleState === null
      ? null
      : lifecycleState.toUpperCase() === 'ACTIVE',
    providerCreatedAt: optionalCommerceTimestamp(product.createdAt),
    providerUpdatedAt: optionalCommerceTimestamp(product.updatedAt),
    variants: Object.freeze(variants),
    sourceHash: commerceSourceHash(source),
  })
}

function errorPaths(source: Record<string, unknown>): readonly string[][] {
  if (!Array.isArray(source.errors)) return []
  return source.errors.flatMap((error) => {
    const path = asCommerceRecord(error)?.path
    return Array.isArray(path)
      ? [path.map((segment) => String(segment))]
      : []
  })
}

function pathIsRedacted(
  paths: readonly string[][],
  ...fieldNames: string[]
): boolean {
  return paths.some((path) => (
    fieldNames.every((fieldName) => path.includes(fieldName))
  ))
}

function sensitiveText(
  value: unknown,
  redacted: boolean,
): CommerceDataField<string> {
  if (redacted) return redactedCommerceField()
  const text = optionalCommerceText(value, 512)
  return text === null
    ? unavailableCommerceField()
    : availableCommerceField(text)
}

function nestedText(
  value: unknown,
  keys: readonly string[],
): unknown {
  let current: unknown = value
  for (const key of keys) {
    current = asCommerceRecord(current)?.[key]
  }
  return current
}

function partySnapshot(
  order: Record<string, unknown>,
  paths: readonly string[][],
): CommerceDataField<CommercePartySnapshot> {
  const purchasing = asCommerceRecord(order.purchasingEntity)
  const customer = asCommerceRecord(order.customer)
  const purchasingCompany = purchasing?.__typename === 'PurchasingCompany'
    ? purchasing
    : null
  const company = asCommerceRecord(purchasingCompany?.company)
  const contact = asCommerceRecord(purchasingCompany?.contact)
  const contactCustomer = asCommerceRecord(contact?.customer)
  const shippingAddress = asCommerceRecord(order.shippingAddress)
  const customerLike = customer || (
    purchasing?.__typename === 'Customer' ? purchasing : null
  ) || contactCustomer
  const redacted = (
    pathIsRedacted(paths, 'customer')
    || pathIsRedacted(paths, 'purchasingEntity')
  )
  if (
    !purchasing
    && !customer
    && !order.email
    && !order.phone
    && !shippingAddress
  ) {
    return redacted ? redactedCommerceField() : unavailableCommerceField()
  }

  const identityValue = company?.id ?? customerLike?.id
  let externalIdentity: CommerceDataField<CommerceExternalIdentity>
  if (typeof identityValue === 'string' && GID_PATTERNS.company.test(identityValue)) {
    externalIdentity = availableCommerceField(
      createCommerceExternalIdentity('shopify', 'retailer', identityValue),
    )
  } else if (
    typeof identityValue === 'string'
    && GID_PATTERNS.customer.test(identityValue)
  ) {
    externalIdentity = availableCommerceField(
      createCommerceExternalIdentity('shopify', 'customer', identityValue),
    )
  } else {
    externalIdentity = redacted
      ? redactedCommerceField()
      : unavailableCommerceField()
  }

  const firstName = optionalCommerceText(
    contact?.firstName
      ?? customerLike?.firstName
      ?? shippingAddress?.firstName,
    255,
  )
  const lastName = optionalCommerceText(
    contact?.lastName
      ?? customerLike?.lastName
      ?? shippingAddress?.lastName,
    255,
  )
  const combinedName = [firstName, lastName].filter(Boolean).join(' ') || null
  const contactName = (
    contact?.displayName
    ?? customerLike?.displayName
    ?? shippingAddress?.name
    ?? combinedName
  )
  const email = (
    order.email
    ?? contact?.email
    ?? nestedText(customerLike, ['defaultEmailAddress', 'emailAddress'])
    ?? customerLike?.email
  )
  const phone = (
    order.phone
    ?? contact?.phone
    ?? nestedText(customerLike, ['defaultPhoneNumber', 'phoneNumber'])
    ?? customerLike?.phone
    ?? shippingAddress?.phone
  )
  const organizationName = (
    company?.name
    ?? shippingAddress?.company
  )
  return availableCommerceField(Object.freeze({
    role: 'customer',
    partyType: organizationName ? 'organization' : 'person',
    externalIdentity,
    organizationName: sensitiveText(
      organizationName,
      pathIsRedacted(paths, 'company'),
    ),
    contactName: sensitiveText(
      contactName,
      pathIsRedacted(paths, 'firstName')
        || pathIsRedacted(paths, 'lastName')
        || pathIsRedacted(paths, 'displayName'),
    ),
    email: sensitiveText(email, pathIsRedacted(paths, 'email')),
    phone: sensitiveText(phone, pathIsRedacted(paths, 'phone')),
  }))
}

function addressSnapshot(
  order: Record<string, unknown>,
  paths: readonly string[][],
) {
  const redacted = pathIsRedacted(paths, 'shippingAddress')
  const redactedFields = new Set<string>()
  const fieldMap = {
    name: ['name', 'firstName', 'lastName'],
    organizationName: ['company'],
    line1: ['address1'],
    line2: ['address2'],
    city: ['city'],
    region: ['province'],
    regionCode: ['provinceCode'],
    postalCode: ['zip'],
    country: ['country'],
    countryCode: ['countryCodeV2'],
    phone: ['phone'],
  } as const
  for (const [canonical, providerFields] of Object.entries(fieldMap)) {
    if (providerFields.some((field) => (
      pathIsRedacted(paths, 'shippingAddress', field)
    ))) {
      redactedFields.add(canonical)
    }
  }
  return commerceAddressFromRecord(order.shippingAddress, {
    redacted: redacted && !asCommerceRecord(order.shippingAddress),
    redactedFields,
  })
}

function canonicalPayment(value: string | null) {
  switch ((value || '').toUpperCase()) {
    case 'AUTHORIZED': return 'authorized' as const
    case 'PAID': return 'paid' as const
    case 'PARTIALLY_PAID': return 'partially_paid' as const
    case 'PARTIALLY_REFUNDED': return 'partially_refunded' as const
    case 'PENDING': return 'pending' as const
    case 'REFUNDED': return 'refunded' as const
    case 'VOIDED':
    case 'EXPIRED': return 'voided' as const
    default: return 'unknown' as const
  }
}

function canonicalFulfillment(value: string | null) {
  switch ((value || '').toUpperCase()) {
    case 'FULFILLED':
      return 'fulfilled' as const
    case 'PARTIALLY_FULFILLED':
    case 'IN_PROGRESS': return 'partial' as const
    case 'ON_HOLD': return 'on_hold' as const
    case 'SCHEDULED':
    case 'PENDING_FULFILLMENT': return 'scheduled' as const
    case 'OPEN':
    case 'REQUEST_DECLINED':
    case 'UNFULFILLED': return 'unfulfilled' as const
    default: return 'unknown' as const
  }
}

function canonicalReturns(value: string | null) {
  switch ((value || '').toUpperCase()) {
    case 'NO_RETURN': return 'none' as const
    case 'RETURN_REQUESTED': return 'requested' as const
    case 'IN_PROGRESS':
    case 'INSPECTION_COMPLETE': return 'in_progress' as const
    case 'RETURNED': return 'returned' as const
    default: return 'unknown' as const
  }
}

function normalizedStates(
  order: Record<string, unknown>,
): Readonly<{
  raw: CommerceProviderStates
  canonical: CommerceCanonicalStates
}> {
  const cancelledAt = optionalCommerceTimestamp(order.cancelledAt)
  const closedAt = optionalCommerceTimestamp(order.closedAt)
  const rawLifecycle = optionalCommerceText(order.status, 64)
    || (cancelledAt ? 'CANCELLED' : closedAt ? 'CLOSED' : 'OPEN')
  const rawPayment = optionalCommerceText(order.displayFinancialStatus, 64)
  const rawFulfillment = optionalCommerceText(
    order.displayFulfillmentStatus,
    64,
  )
  const rawReturns = optionalCommerceText(order.returnStatus, 64)
  return Object.freeze({
    raw: Object.freeze({
      lifecycle: rawLifecycle,
      payment: rawPayment,
      fulfillment: rawFulfillment,
      returns: rawReturns,
    }),
    canonical: Object.freeze({
      lifecycle: cancelledAt || rawLifecycle.toUpperCase() === 'CANCELLED'
        ? 'cancelled'
        : closedAt || rawLifecycle.toUpperCase() === 'CLOSED'
          ? 'closed'
          : 'open',
      payment: canonicalPayment(rawPayment),
      fulfillment: canonicalFulfillment(rawFulfillment),
      returns: canonicalReturns(rawReturns),
    }),
  })
}

function normalizeLine(
  source: unknown,
  knownVariants: ReadonlyMap<string, CommerceNormalizedVariant>,
): CommerceNormalizedOrderLine {
  const line = nodeRecord(source)
  if (!line) throw new Error('Shopify returned an invalid order line')
  const identity = shopifyIdentity(line.id, 'order_line')
  const productValue = recordId(line.product) ?? line.productId
  const variantValue = recordId(line.variant) ?? line.variantId
  const productIdentity = optionalShopifyIdentity(productValue, 'product')
  const variantIdentity = optionalShopifyIdentity(variantValue, 'variant')
  const knownVariant = variantIdentity.state === 'available'
    ? knownVariants.get(variantIdentity.value.value)
    : null
  const quantity = nonnegativeCommerceInteger(line.quantity)
  const currentQuantity = nonnegativeCommerceInteger(line.currentQuantity)
  const unfulfilledQuantity = nonnegativeCommerceInteger(
    line.unfulfilledQuantity,
  )
  if (
    quantity === null
    || quantity === 0
    || currentQuantity === null
    || currentQuantity > quantity
    || unfulfilledQuantity === null
    || unfulfilledQuantity > currentQuantity
  ) {
    throw new Error('Shopify returned an invalid line quantity')
  }
  const removedOrRefundedQuantity = quantity - currentQuantity
  const fulfilledQuantity = currentQuantity - unfulfilledQuantity
  const taxLines = commerceConnectionValues(line.taxLines)
    .map((taxLine) => asCommerceRecord(taxLine)?.priceSet)
  const linePackaging = packaging(line, knownVariant
    ? {
        packaging: knownVariant.packaging.state === 'available'
          ? knownVariant.packaging.value
          : null,
      }
    : null)
  return Object.freeze({
    schemaVersion: COMMERCE_NORMALIZED_ORDER_LINE_VERSION,
    identity,
    productIdentity,
    variantIdentity,
    sku: optionalCommerceText(line.sku, 255),
    titleSnapshot: requiredCommerceText(
      line.title ?? line.name,
      'Shopify order-line title',
      512,
    ),
    variantTitleSnapshot: optionalCommerceText(line.variantTitle, 512),
    vendorSnapshot: optionalCommerceText(line.vendor, 512),
    orderedQuantity: quantity,
    currentQuantity,
    // Shopify combines refunded and removed units in the quantity delta.
    // The compatibility bucket is preserved alongside its exact semantics.
    cancelledQuantity: removedOrRefundedQuantity,
    fulfilledQuantity,
    unfulfilledQuantity,
    returnedQuantity: null,
    removedOrRefundedQuantity,
    unitMultiplier: null,
    physicalUnitQuantity: quantity,
    unitPrice: shopifyMoneySet(
      line.originalUnitPriceSet ?? line.discountedUnitPriceSet,
    ),
    lineSubtotal: shopifyMoneySet(
      line.unfulfilledOriginalTotalSet
        ?? line.originalTotalSet
        ?? line.discountedTotalSet,
    ),
    lineDiscount: subtractMoneySets(
      line.unfulfilledOriginalTotalSet,
      line.unfulfilledDiscountedTotalSet,
    ),
    lineTax: sumMoneySets(taxLines),
    requiresShipping: line.requiresShipping === true,
    packaging: linePackaging,
    sourceHash: commerceSourceHash(source),
  })
}

function requestedDelivery(
  order: Record<string, unknown>,
): CommerceDataField<string> {
  const value = (
    order.requestedDeliveryAt
    ?? nestedText(order.deliveryMethod, ['requestedDeliveryAt'])
  )
  const timestamp = optionalCommerceTimestamp(value)
  return timestamp
    ? availableCommerceField(timestamp)
    : unavailableCommerceField()
}

function ambiguousVariantSkus(
  products: readonly CommerceNormalizedProduct[],
): ReadonlySet<string> {
  const identities = new Map<string, Set<string>>()
  for (const product of products) {
    for (const variant of product.variants) {
      if (!variant.sku) continue
      const values = identities.get(variant.sku) || new Set<string>()
      values.add(variant.identity.value)
      identities.set(variant.sku, values)
    }
  }
  return new Set(
    [...identities.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([sku]) => sku),
  )
}

function normalizeOrder(
  source: unknown,
  context: CommerceNormalizationContext,
  knownVariants: ReadonlyMap<string, CommerceNormalizedVariant>,
  ambiguousSkus: ReadonlySet<string>,
  paths: readonly string[][],
  shopDomain: string | null,
  rootTruncated: boolean,
): CommerceNormalizedOrder {
  const order = nodeRecord(source)
  if (!order) throw new Error('Shopify returned an invalid order')
  const identity = shopifyIdentity(order.id, 'order')
  const linesConnection = asCommerceRecord(order.lineItems)
  const lines = commerceConnectionValues(order.lineItems)
    .map((line) => normalizeLine(line, knownVariants))
  const states = normalizedStates(order)
  const party = partySnapshot(order, paths)
  const shipTo = addressSnapshot(order, paths)
  const delivery = requestedDelivery(order)
  const lineItemsTruncated = (
    rootTruncated
    || asCommerceRecord(linesConnection?.pageInfo)?.hasNextPage === true
    || order.lineItemsTruncated === true
  )
  const sourceStale = context.sourceState === 'stale'
    || order.sourceStale === true
  const readinessFacts = buildCommerceReadinessFacts({
    canonicalStates: states.canonical,
    lines,
    party,
    shipTo,
    requestedDeliveryAt: delivery,
    lineItemsTruncated,
    sourceStale,
    ambiguousSkus,
  })
  const currency = normalizeCommerceCurrency(
    order.currencyCode
      ?? asCommerceRecord(
        asCommerceRecord(order.currentTotalPriceSet)?.shopMoney,
      )?.currencyCode,
  )
  const subtotal = shopifyMoneySet(
    order.currentSubtotalPriceSet ?? order.originalSubtotalPriceSet,
  )
  const shipping = shopifyMoneySet(
    order.currentShippingPriceSet ?? order.originalTotalShippingPriceSet,
  )
  const tax = shopifyMoneySet(
    order.currentTotalTaxSet ?? order.originalTotalTaxSet,
  )
  const discount = shopifyMoneySet(
    order.currentTotalDiscountsSet ?? order.originalTotalDiscountsSet,
  )
  const total = shopifyMoneySet(
    order.currentTotalPriceSet ?? order.originalTotalPriceSet,
  )
  const headerMoney = commerceOrderHeaderMoneyState({
    currency,
    subtotal,
    shipping,
    tax,
    discount,
    total,
  })
  return Object.freeze({
    schemaVersion: COMMERCE_NORMALIZED_ORDER_VERSION,
    identity,
    orderNumber: requiredCommerceText(
      order.name ?? order.orderNumber ?? order.number,
      'Shopify order number',
      255,
    ),
    providerCreatedAt: optionalCommerceTimestamp(order.createdAt),
    providerProcessedAt: optionalCommerceTimestamp(order.processedAt),
    providerUpdatedAt: optionalCommerceTimestamp(order.updatedAt),
    providerCancelledAt: optionalCommerceTimestamp(order.cancelledAt),
    providerClosedAt: optionalCommerceTimestamp(order.closedAt),
    rawStates: states.raw,
    canonicalStates: states.canonical,
    currency,
    subtotal,
    shipping,
    tax,
    discount,
    total,
    headerMoney,
    party,
    shipTo,
    requestedDeliveryAt: delivery,
    lines: Object.freeze(lines),
    lineItemsTruncated,
    sourceStale,
    readinessFacts,
    providerFacts: Object.freeze({
      provider: 'shopify',
      shopDomain,
      sourceName: optionalCommerceText(order.sourceName, 120),
      testOrder: order.test === true,
      shippingService: asCommerceRecord(order.shippingLine)
        ? Object.freeze({
            code: optionalCommerceText(
              asCommerceRecord(order.shippingLine)?.code,
              255,
            ),
            title: optionalCommerceText(
              asCommerceRecord(order.shippingLine)?.title,
              512,
            ),
            deliveryCategory: optionalCommerceText(
              asCommerceRecord(order.shippingLine)?.deliveryCategory,
              255,
            ),
          })
        : null,
    }),
    sourceHash: commerceSourceHash(source),
  })
}

function sourceCollections(source: ShopifySource) {
  const data = asCommerceRecord(source.data) || source
  const productsSource = data.products ?? source.products
  const ordersSource = data.orders ?? source.orders
  const products = commerceConnectionValues(productsSource)
  return {
    products,
    orders: commerceConnectionValues(ordersSource),
    truncated: (
      asCommerceRecord(asCommerceRecord(productsSource)?.pageInfo)
        ?.hasNextPage === true
      || asCommerceRecord(asCommerceRecord(ordersSource)?.pageInfo)
        ?.hasNextPage === true
      || products.some((product) => (
        asCommerceRecord(
          asCommerceRecord(asCommerceRecord(product)?.variants)?.pageInfo,
        )?.hasNextPage === true
      ))
    ),
  }
}

function sourceCurrency(
  source: ShopifySource,
  orders: readonly unknown[],
): unknown {
  const data = asCommerceRecord(source.data) || source
  const firstOrder = orders
    .map((order) => asCommerceRecord(order))
    .find((order) => order !== null)
  return (
    data.currencyCode
    ?? asCommerceRecord(data.shop)?.currencyCode
    ?? source.currencyCode
    ?? asCommerceRecord(source.shop)?.currencyCode
    ?? firstOrder?.currencyCode
    ?? asCommerceRecord(
      asCommerceRecord(firstOrder?.currentTotalPriceSet)?.shopMoney,
    )?.currencyCode
  )
}

function rejectedRecordExternalId(
  source: unknown,
  resourceType: 'order' | 'product',
): string | undefined {
  const value = asCommerceRecord(source)?.id
  return typeof value === 'string' && GID_PATTERNS[resourceType].test(value)
    ? value
    : undefined
}

function rejectedOrderCode(
  error: unknown,
): CommerceNormalizationRejectionCode {
  return (
    error instanceof CommerceNormalizationError
    && error.code === 'COMMERCE_ORDER_MONEY_INCOMPLETE'
  )
    ? 'COMMERCE_ORDER_MONEY_INCOMPLETE'
    : 'COMMERCE_ORDER_RECORD_INVALID'
}

export function normalizeShopifyCommerce(
  sourceValue: ShopifySource,
  context: CommerceNormalizationContext,
): CommerceNormalizationEnvelope {
  validateCommerceNormalizationContext(context)
  const source = asCommerceRecord(sourceValue)
  if (!source) throw new Error('Shopify normalization requires an object source')
  const collections = sourceCollections(source)
  const currencyFallback = sourceCurrency(source, collections.orders)
  const products: CommerceNormalizedProduct[] = []
  const rejections: CommerceNormalizationRejection[] = []
  for (const product of collections.products) {
    try {
      products.push(
        normalizeProduct(product, context.externalAccountId, currencyFallback),
      )
    } catch {
      rejections.push(createCommerceNormalizationRejection({
        resourceType: 'product',
        source: product,
        externalId: rejectedRecordExternalId(product, 'product'),
        errorCode: 'COMMERCE_PRODUCT_RECORD_INVALID',
      }))
    }
  }
  const variants = new Map<string, CommerceNormalizedVariant>()
  for (const product of products) {
    for (const variant of product.variants) {
      variants.set(variant.identity.value, variant)
    }
  }
  const ambiguousSkus = ambiguousVariantSkus(products)
  const paths = errorPaths(source)
  const shopDomain = optionalCommerceText(
    source.shopDomain ?? asCommerceRecord(source.shop)?.myshopifyDomain,
    255,
  )
  const orders: CommerceNormalizedOrder[] = []
  for (const order of collections.orders) {
    try {
      orders.push(normalizeOrder(
        order,
        context,
        variants,
        ambiguousSkus,
        paths,
        shopDomain,
        collections.truncated,
      ))
    } catch (error) {
      rejections.push(createCommerceNormalizationRejection({
        resourceType: 'order',
        source: order,
        externalId: rejectedRecordExternalId(order, 'order'),
        errorCode: rejectedOrderCode(error),
      }))
    }
  }
  return freezeCommerceEnvelope({
    schemaVersion: COMMERCE_NORMALIZATION_ENVELOPE_VERSION,
    normalizerVersion: SHOPIFY_COMMERCE_NORMALIZER_VERSION,
    provider: 'shopify',
    organizationId: context.organizationId,
    integrationAccountId: context.integrationAccountId,
    externalAccountId: context.externalAccountId,
    apiVersion: context.apiVersion,
    observedAt: optionalCommerceTimestamp(context.observedAt) as string,
    credentialGeneration: context.credentialGeneration,
    retentionExpiresAt: optionalCommerceTimestamp(
      context.retentionExpiresAt,
    ) as string,
    sourceHash: commerceSourceHash(sourceValue),
    products: Object.freeze(products),
    orders: Object.freeze(orders),
    rejections: Object.freeze(rejections),
  })
}

export const SHOPIFY_COMMERCE_NORMALIZATION_ADAPTER = Object.freeze({
  provider: 'shopify',
  normalizerVersion: SHOPIFY_COMMERCE_NORMALIZER_VERSION,
  normalize: normalizeShopifyCommerce,
} satisfies ReadOnlyCommerceNormalizationAdapter<ShopifySource>)
