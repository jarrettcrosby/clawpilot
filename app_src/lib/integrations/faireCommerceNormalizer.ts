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
  integerCommerceMinorUnits,
  normalizeCommerceCurrency,
  nonnegativeCommerceInteger,
  optionalCommerceText,
  optionalCommerceTimestamp,
  positiveCommerceInteger,
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

export const FAIRE_COMMERCE_NORMALIZER_VERSION =
  'faire-commerce-normalizer-v3' as const

type FaireSource = Readonly<Record<string, unknown>>

const FAIRE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/

function faireIdentity(
  value: unknown,
  resourceType:
    | 'brand'
    | 'inventory_item'
    | 'order'
    | 'order_line'
    | 'product'
    | 'retailer'
    | 'variant',
): CommerceExternalIdentity {
  const text = requiredCommerceText(value, `Faire ${resourceType} identity`)
  if (!FAIRE_ID.test(text)) {
    throw new Error(`Faire returned an invalid ${resourceType} identity`)
  }
  return createCommerceExternalIdentity('faire', resourceType, text)
}

function optionalFaireIdentity(
  value: unknown,
  resourceType:
    | 'brand'
    | 'inventory_item'
    | 'product'
    | 'retailer'
    | 'variant',
): CommerceDataField<CommerceExternalIdentity> {
  if (value === null || value === undefined || value === '') {
    return unavailableCommerceField()
  }
  return availableCommerceField(faireIdentity(value, resourceType))
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
    throw new Error('Faire returned invalid selected product options')
  }
  const normalized = value.map((option) => {
    const record = asCommerceRecord(option)
    if (!record) {
      throw new Error('Faire returned an invalid selected product option')
    }
    return Object.freeze({
      name: requiredCommerceText(
        record.name ?? record.option_name,
        'Faire selected option name',
        255,
      ),
      value: requiredCommerceText(
        record.value ?? record.option_value,
        'Faire selected option value',
        512,
      ),
    })
  })
  if (
    new TextEncoder().encode(JSON.stringify(normalized)).byteLength > 16_384
  ) {
    throw new Error('Faire returned oversized selected product options')
  }
  return Object.freeze(normalized)
}

function scaledPositiveMeasurement(
  value: unknown,
  multiplier: number | undefined,
): number | null {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
    || !multiplier
  ) {
    return null
  }
  const scaled = Math.round(value * multiplier)
  return Number.isSafeInteger(scaled) && scaled > 0 ? scaled : null
}

function faireMeasurements(
  variant: Record<string, unknown>,
  product: Record<string, unknown>,
) {
  const measurement = asCommerceRecord(
    variant.case_measurements
      ?? variant.measurements
      ?? product.case_measurements
      ?? product.measurements,
  )
  if (!measurement) {
    return {
      packaging: unavailableCommerceField(),
      weightGrams: null,
    }
  }
  const massUnit = optionalCommerceText(measurement.mass_unit, 32)
    ?.toUpperCase()
  const massMultipliers: Record<string, number> = {
    GRAMS: 1,
    KILOGRAMS: 1_000,
    OUNCES: 28.349523125,
    POUNDS: 453.59237,
  }
  const distanceUnit = optionalCommerceText(measurement.distance_unit, 32)
    ?.toUpperCase()
  const distanceMultipliers: Record<string, number> = {
    MILLIMETERS: 1,
    CENTIMETERS: 10,
    METERS: 1_000,
    INCHES: 25.4,
    FEET: 304.8,
  }
  const weightGrams = scaledPositiveMeasurement(
    measurement.weight,
    massUnit ? massMultipliers[massUnit] : undefined,
  )
  const distanceMultiplier = distanceUnit
    ? distanceMultipliers[distanceUnit]
    : undefined
  const dimensionsMm = {
    length: scaledPositiveMeasurement(measurement.length, distanceMultiplier),
    width: scaledPositiveMeasurement(measurement.width, distanceMultiplier),
    height: scaledPositiveMeasurement(measurement.height, distanceMultiplier),
  }
  return {
    packaging: commercePackagingFromRecord({
      weight_grams: weightGrams,
      dimensions_mm: dimensionsMm,
    }, 'product_variant'),
    weightGrams,
  }
}

function firstProperty(
  record: Record<string, unknown>,
  keys: readonly string[],
): Readonly<{ exists: boolean; value: unknown }> {
  for (const key of keys) {
    if (propertyExists(record, key)) {
      return { exists: true, value: record[key] }
    }
  }
  return { exists: false, value: undefined }
}

function moneySet(money: CommerceMoney): CommerceMoneySet {
  return Object.freeze({
    primary: money,
    shop: unavailableCommerceField('not_supported'),
    presentment: unavailableCommerceField('not_supported'),
  })
}

function faireMoney(
  value: unknown,
  currencyValue: unknown,
  inputKind: 'decimal' | 'minor',
): CommerceDataField<CommerceMoneySet> {
  if (value === null || value === undefined || value === '') {
    return unavailableCommerceField()
  }
  const money = inputKind === 'minor'
    ? integerCommerceMinorUnits(value, currencyValue)
    : commerceMoneyFromDecimal(value, currencyValue)
  return availableCommerceField(moneySet(money))
}

function recordCurrency(
  record: Record<string, unknown>,
  fallback: unknown,
): string {
  const value = (
    record.currency
    ?? record.currency_code
    ?? record.currencyCode
    ?? fallback
  )
  return normalizeCommerceCurrency(value)
}

function moneyFromRecord(
  record: Record<string, unknown>,
  options: Readonly<{
    minorKeys: readonly string[]
    decimalKeys?: readonly string[]
    fallbackCurrency: unknown
  }>,
): CommerceDataField<CommerceMoneySet> {
  const minor = firstProperty(record, options.minorKeys)
  if (minor.exists) {
    return faireMoney(
      minor.value,
      recordCurrency(record, options.fallbackCurrency),
      'minor',
    )
  }
  const decimal = firstProperty(record, options.decimalKeys || [])
  if (decimal.exists) {
    const valueRecord = asCommerceRecord(decimal.value)
    if (valueRecord) {
      const minor = firstProperty(valueRecord, [
        'amount_minor',
        'amountMinor',
      ])
      if (minor.exists) {
        return faireMoney(
          minor.value,
          recordCurrency(
            valueRecord,
            recordCurrency(record, options.fallbackCurrency),
          ),
          'minor',
        )
      }
      const amount = (
        valueRecord.amount
        ?? valueRecord.value
        ?? valueRecord.decimal
      )
      const currency = recordCurrency(
        valueRecord,
        recordCurrency(record, options.fallbackCurrency),
      )
      return faireMoney(amount, currency, 'decimal')
    }
    return faireMoney(
      decimal.value,
      recordCurrency(record, options.fallbackCurrency),
      'decimal',
    )
  }
  return unavailableCommerceField()
}

function exactZeroMoney(
  currencyValue: unknown,
): CommerceDataField<CommerceMoneySet> {
  const currency = normalizeCommerceCurrency(currencyValue)
  return availableCommerceField(moneySet(Object.freeze({
    amountMinor: BigInt(0),
    currency,
  })))
}

function exactMoneySum(
  fields: readonly CommerceDataField<CommerceMoneySet>[],
): CommerceDataField<CommerceMoneySet> {
  if (fields.some((field) => field.state !== 'available')) {
    return unavailableCommerceField()
  }
  const available = fields as readonly Extract<
    CommerceDataField<CommerceMoneySet>,
    { state: 'available' }
  >[]
  const currency = available[0].value.primary.currency
  if (available.some(({ value }) => value.primary.currency !== currency)) {
    return unavailableCommerceField('not_supported')
  }
  try {
    return availableCommerceField(moneySet(integerCommerceMinorUnits(
      available.reduce(
        (total, { value }) => total + value.primary.amountMinor,
        BigInt(0),
      ),
      currency,
    )))
  } catch {
    return unavailableCommerceField('not_supported')
  }
}

function exactOrderTotal(
  subtotal: CommerceDataField<CommerceMoneySet>,
  discount: CommerceDataField<CommerceMoneySet>,
  shipping: CommerceDataField<CommerceMoneySet>,
  tax: CommerceDataField<CommerceMoneySet>,
): CommerceDataField<CommerceMoneySet> {
  const fields = [subtotal, discount, shipping, tax]
  if (fields.some((field) => field.state !== 'available')) {
    return unavailableCommerceField()
  }
  const available = fields as readonly Extract<
    CommerceDataField<CommerceMoneySet>,
    { state: 'available' }
  >[]
  const currency = available[0].value.primary.currency
  if (available.some(({ value }) => value.primary.currency !== currency)) {
    return unavailableCommerceField('not_supported')
  }
  const amountMinor = (
    available[0].value.primary.amountMinor
    - available[1].value.primary.amountMinor
    + available[2].value.primary.amountMinor
    + available[3].value.primary.amountMinor
  )
  if (amountMinor < BigInt(0)) {
    return unavailableCommerceField('not_supported')
  }
  try {
    return availableCommerceField(moneySet(
      integerCommerceMinorUnits(amountMinor, currency),
    ))
  } catch {
    return unavailableCommerceField('not_supported')
  }
}

function scaledMoney(
  field: CommerceDataField<CommerceMoneySet>,
  multiplier: number,
): CommerceDataField<CommerceMoneySet> {
  if (field.state !== 'available') return unavailableCommerceField()
  try {
    return availableCommerceField(moneySet(integerCommerceMinorUnits(
      field.value.primary.amountMinor * BigInt(multiplier),
      field.value.primary.currency,
    )))
  } catch {
    return unavailableCommerceField('not_supported')
  }
}

function availableMoneyOr(
  primary: CommerceDataField<CommerceMoneySet>,
  fallback: CommerceDataField<CommerceMoneySet>,
): CommerceDataField<CommerceMoneySet> {
  return primary.state === 'available' ? primary : fallback
}

function nestedMoneyCurrency(value: unknown): unknown {
  const record = asCommerceRecord(value)
  return (
    record?.currency
    ?? record?.currency_code
    ?? record?.currencyCode
  )
}

function orderCurrency(
  order: Record<string, unknown>,
  lineRecords: readonly Record<string, unknown>[],
  fallback: unknown,
): string {
  const payout = asCommerceRecord(order.payout_costs)
  const nestedFallbacks = [
    order.subtotal,
    order.total,
    payout?.subtotal_after_brand_discounts,
    payout?.total_brand_discounts,
    payout?.net_tax,
    ...lineRecords.map((line) => line.price),
  ]
  const nestedFallback = nestedFallbacks
    .map(nestedMoneyCurrency)
    .find((value) => value !== null && value !== undefined && value !== '')
  return recordCurrency(order, nestedFallback ?? fallback)
}

function moneyFromPriceArray(
  value: unknown,
  key: 'retail_price' | 'wholesale_price',
  preferredCurrency: string | null,
): CommerceDataField<CommerceMoneySet> {
  if (value === null || value === undefined) {
    return unavailableCommerceField()
  }
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('Faire returned invalid product prices')
  }
  const prices = value.flatMap((entry) => {
    const price = asCommerceRecord(entry)
    const money = asCommerceRecord(price?.[key])
    if (!price || !money) return []
    const normalized = integerCommerceMinorUnits(
      money.amount_minor,
      money.currency,
    )
    return [{
      geoConstrained: asCommerceRecord(price.geo_constraint) !== null,
      money: normalized,
    }]
  })
  if (!prices.length) return unavailableCommerceField()
  const matching = preferredCurrency
    ? prices.filter((price) => (
        price.money.currency === preferredCurrency
      ))
    : []
  if (preferredCurrency && !matching.length) {
    return unavailableCommerceField('not_supported')
  }
  const candidates = preferredCurrency ? matching : prices
  const unconstrained = candidates.filter((price) => !price.geoConstrained)
  const selected = unconstrained.length === 1
    ? unconstrained[0]
    : candidates.length === 1
      ? candidates[0]
      : candidates.every((price) => (
          price.money.currency === candidates[0].money.currency
          && price.money.amountMinor === candidates[0].money.amountMinor
        ))
        ? candidates[0]
        : null
  return selected
    ? availableCommerceField(moneySet(selected.money))
    : unavailableCommerceField('not_supported')
}

function discountMoney(
  value: unknown,
  fallbackCurrency: unknown,
): CommerceDataField<CommerceMoneySet> {
  const record = asCommerceRecord(value)
  if (!record) return unavailableCommerceField()
  if (record.discount_type === 'NONE') {
    return exactZeroMoney(fallbackCurrency)
  }
  return moneyFromRecord(record, {
    minorKeys: [
      'amount_minor',
      'amount_cents',
      'discount_amount_cents',
      'discount_cents',
    ],
    decimalKeys: ['discount_amount', 'amount', 'value'],
    fallbackCurrency,
  })
}

function moneyFromDiscountCollection(
  value: unknown,
  fallbackCurrency: unknown,
): CommerceDataField<CommerceMoneySet> {
  if (value === null || value === undefined) {
    return unavailableCommerceField()
  }
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0) {
    return exactZeroMoney(fallbackCurrency)
  }
  return exactMoneySum(values.map((item) => (
    discountMoney(item, fallbackCurrency)
  )))
}

function productVariants(value: Record<string, unknown>): unknown[] {
  const candidates = [
    value.variants,
    value.product_variants,
    value.options,
  ]
  for (const candidate of candidates) {
    const values = commerceConnectionValues(candidate)
    if (values.length) return values
  }
  return []
}

function fairePageCollection(
  value: unknown,
  key: 'orders' | 'products',
): unknown[] {
  const direct = commerceConnectionValues(value)
  if (direct.length) return direct
  const page = asCommerceRecord(value)
  return page ? commerceConnectionValues(page[key]) : []
}

function pageHasMore(value: unknown): boolean {
  const page = asCommerceRecord(value)
  if (!page) return false
  const pagination = asCommerceRecord(page.pagination)
    || asCommerceRecord(page.page_info)
    || asCommerceRecord(page.pageInfo)
  const nextCursor = (
    page.cursor
    ?? page.next_cursor
    ?? page.nextCursor
    ?? pagination?.cursor
    ?? pagination?.next_cursor
    ?? pagination?.nextCursor
  )
  return (
    page.truncated === true
    || page.has_more === true
    || page.hasNextPage === true
    || pagination?.has_more === true
    || pagination?.hasNextPage === true
    || (
      typeof nextCursor === 'string'
      && nextCursor.trim().length > 0
    )
  )
}

function inventoryEntry(
  inventories: Record<string, unknown>,
  variantId: string,
): unknown {
  return inventories[variantId]
}

function faireInventoryQuantity(
  variant: Record<string, unknown>,
  inventories: Record<string, unknown>,
  variantId: string,
) {
  const entry = asCommerceRecord(inventoryEntry(inventories, variantId))
  if (entry) {
    const available = asCommerceRecord(entry.available_quantity)
    if (!available) return unavailableCommerceField()
    const type = optionalCommerceText(available.type, 64)?.toUpperCase()
    if (type === 'UNTRACKED') return unavailableCommerceField('untracked')
    const quantity = Number.isSafeInteger(available.quantity)
      ? Number(available.quantity)
      : null
    if (type !== 'QUANTITY' || quantity === null) {
      return unavailableCommerceField('not_supported')
    }
    return availableCommerceField(Object.freeze({
      quantity,
      name: 'available',
    }))
  }
  const direct = firstProperty(variant, [
    'inventory_quantity',
    'available_quantity',
    'quantity_available',
  ])
  if (direct.exists) {
    const quantity = Number.isSafeInteger(direct.value)
      ? Number(direct.value)
      : null
    return quantity === null
      ? unavailableCommerceField('not_supported')
      : availableCommerceField(Object.freeze({
          quantity,
          name: 'available',
        }))
  }
  return unavailableCommerceField()
}

function normalizeVariant(
  source: unknown,
  product: Record<string, unknown>,
  productIdentity: CommerceExternalIdentity,
  inventories: Record<string, unknown>,
  currency: string,
  preferredPriceCurrency: string | null,
): CommerceNormalizedVariant {
  const variant = asCommerceRecord(source)
  if (!variant) throw new Error('Faire returned an invalid product variant')
  const identity = faireIdentity(
    variant.id ?? variant.variant_id ?? variant.product_variant_id,
    'variant',
  )
  const unitMultiplier = positiveCommerceInteger(
    variant.unit_multiplier ?? product.unit_multiplier,
  )
  const inventory = asCommerceRecord(
    inventoryEntry(inventories, identity.value),
  )
  const packaging = commercePackagingFromRecord(
    variant.packaging ?? product.packaging,
    'product_variant',
  )
  const measurements = faireMeasurements(variant, product)
  const explicitWeightGrams = positiveCommerceInteger(
    variant.weight_grams ?? product.weight_grams,
  )
  const modernWholesalePrice = moneyFromPriceArray(
    variant.prices,
    'wholesale_price',
    preferredPriceCurrency,
  )
  const modernPricesPresent = (
    Array.isArray(variant.prices)
    && variant.prices.length > 0
  )
  const legacyVariantWholesalePrice = moneyFromRecord(variant, {
    minorKeys: ['wholesale_price_cents'],
    decimalKeys: ['wholesale_price'],
    fallbackCurrency: currency,
  })
  const legacyProductWholesalePrice = moneyFromRecord(product, {
    minorKeys: ['wholesale_price_cents'],
    decimalKeys: ['wholesale_price'],
    fallbackCurrency: currency,
  })
  const modernRetailPrice = moneyFromPriceArray(
    variant.prices,
    'retail_price',
    preferredPriceCurrency,
  )
  const legacyVariantRetailPrice = moneyFromRecord(variant, {
    minorKeys: ['retail_price_cents'],
    decimalKeys: ['retail_price'],
    fallbackCurrency: currency,
  })
  const legacyProductRetailPrice = moneyFromRecord(product, {
    minorKeys: ['retail_price_cents'],
    decimalKeys: ['retail_price'],
    fallbackCurrency: currency,
  })
  return Object.freeze({
    schemaVersion: COMMERCE_NORMALIZED_VARIANT_VERSION,
    identity,
    productIdentity,
    inventoryItemIdentity: optionalFaireIdentity(
      variant.inventory_item_id
        ?? inventory?.inventory_item_id
        ?? inventory?.inventory_id,
      'inventory_item',
    ),
    // Faire SKUs are case-sensitive matching evidence and stay byte-for-byte.
    sku: optionalCommerceText(variant.sku, 255),
    barcode: optionalCommerceText(
      variant.gtin ?? variant.barcode ?? variant.upc,
      255,
    ),
    title: optionalCommerceText(
      variant.name ?? variant.title ?? variant.option_name,
      512,
    ),
    selectedOptions: selectedOptions(
      variant.options
        ?? variant.selected_options
        ?? variant.selectedOptions,
    ),
    unitMultiplier,
    // A multi-geo price set is only canonical when the shop currency resolves
    // it unambiguously. Never pick prices[0] merely because it came first.
    wholesalePrice: modernPricesPresent
      ? modernWholesalePrice
      : legacyVariantWholesalePrice.state === 'available'
        ? legacyVariantWholesalePrice
        : legacyProductWholesalePrice,
    retailPrice: modernPricesPresent
      ? modernRetailPrice
      : legacyVariantRetailPrice.state === 'available'
        ? legacyVariantRetailPrice
        : legacyProductRetailPrice,
    taxable: optionalBoolean(variant.taxable ?? product.taxable),
    requiresShipping: optionalBoolean(
      variant.requires_shipping ?? product.requires_shipping,
    ),
    inventory: faireInventoryQuantity(
      variant,
      inventories,
      identity.value,
    ),
    packaging: packaging.state === 'available'
      ? packaging
      : measurements.packaging,
    weightGrams: packaging.state === 'available'
      ? packaging.value.weightGrams
      : measurements.weightGrams ?? explicitWeightGrams,
    providerCreatedAt: optionalCommerceTimestamp(
      variant.created_at ?? product.created_at,
    ),
    providerUpdatedAt: optionalCommerceTimestamp(
      variant.updated_at ?? product.updated_at,
    ),
    sourceHash: commerceSourceHash(Object.freeze({
      inventory,
      product,
      variant,
    })),
  })
}

function normalizeProduct(
  source: unknown,
  inventories: Record<string, unknown>,
  brandFallback: unknown,
  currencyFallback: unknown,
  priceCurrencyFallback: unknown,
): CommerceNormalizedProduct {
  const product = asCommerceRecord(source)
  if (!product) throw new Error('Faire returned an invalid product')
  const identity = faireIdentity(product.id ?? product.product_id, 'product')
  const currency = recordCurrency(product, currencyFallback)
  const rawPreferredPriceCurrency = (
    product.currency
    ?? product.currency_code
    ?? product.currencyCode
    ?? priceCurrencyFallback
  )
  const preferredPriceCurrency = typeof rawPreferredPriceCurrency === 'string'
    ? normalizeCommerceCurrency(rawPreferredPriceCurrency)
    : null
  const variants = productVariants(product).map((variant) => normalizeVariant(
    variant,
    product,
    identity,
    inventories,
    currency,
    preferredPriceCurrency,
  ))
  const lifecycleState = optionalCommerceText(
    product.lifecycle_state ?? product.sale_state ?? product.state,
    64,
  )
  const taxonomyType = asCommerceRecord(product.taxonomy_type)
  const active = typeof product.active === 'boolean'
    ? product.active
    : typeof product.deleted === 'boolean'
      ? !product.deleted
      : lifecycleState === null
        ? null
        : ['ACTIVE', 'PUBLISHED'].includes(lifecycleState.toUpperCase())
  return Object.freeze({
    schemaVersion: COMMERCE_NORMALIZED_PRODUCT_VERSION,
    identity,
    brandIdentity: optionalFaireIdentity(
      product.brand_id ?? brandFallback,
      'brand',
    ),
    title: requiredCommerceText(
      product.name ?? product.title,
      'Faire product title',
      500,
    ),
    description: optionalCommerceText(
      product.description ?? product.short_description,
      20_000,
    ),
    vendor: optionalCommerceText(
      product.brand_name ?? product.vendor ?? product.maker_name,
      512,
    ),
    productType: optionalCommerceText(
      taxonomyType?.name
        ?? taxonomyType?.id
        ?? product.product_type
        ?? product.type
        ?? product.category,
      512,
    ),
    lifecycleState,
    active,
    providerCreatedAt: optionalCommerceTimestamp(product.created_at),
    providerUpdatedAt: optionalCommerceTimestamp(product.updated_at),
    variants: Object.freeze(variants),
    sourceHash: commerceSourceHash(source),
  })
}

function fieldText(value: unknown): CommerceDataField<string> {
  const text = optionalCommerceText(value, 512)
  return text === null
    ? unavailableCommerceField()
    : availableCommerceField(text)
}

function partySnapshot(
  order: Record<string, unknown>,
): CommerceDataField<CommercePartySnapshot> {
  const customer = asCommerceRecord(order.customer)
  const retailer = asCommerceRecord(order.retailer)
  const retailerId = order.retailer_id ?? retailer?.id
  if (!customer && !retailer && !retailerId) return unavailableCommerceField()
  const firstName = optionalCommerceText(
    customer?.first_name ?? retailer?.first_name,
    255,
  )
  const lastName = optionalCommerceText(
    customer?.last_name ?? retailer?.last_name,
    255,
  )
  const combinedName = [firstName, lastName].filter(Boolean).join(' ') || null
  return availableCommerceField(Object.freeze({
    role: 'retailer',
    partyType: 'organization',
    externalIdentity: optionalFaireIdentity(retailerId, 'retailer'),
    organizationName: fieldText(
      customer?.company_name
        ?? retailer?.name
        ?? customer?.company
        ?? order.retailer_name,
    ),
    contactName: fieldText(
      customer?.name ?? retailer?.contact_name ?? combinedName,
    ),
    email: fieldText(customer?.email ?? retailer?.email),
    phone: fieldText(
      customer?.phone
        ?? customer?.phone_number
        ?? retailer?.phone
        ?? retailer?.phone_number,
    ),
  }))
}

function providerDateTime(value: unknown): string | null {
  const timestamp = optionalCommerceTimestamp(value)
  if (timestamp) return timestamp
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null
  }
  return optionalCommerceTimestamp(`${value}T00:00:00.000Z`)
}

function canonicalPayment(value: string | null) {
  switch ((value || '').toUpperCase()) {
    case 'AUTHORIZED': return 'authorized' as const
    case 'PAID': return 'paid' as const
    case 'PARTIALLY_PAID': return 'partially_paid' as const
    case 'PARTIALLY_REFUNDED': return 'partially_refunded' as const
    case 'PENDING':
    case 'PAYMENT_INITIATED': return 'pending' as const
    case 'REFUNDED': return 'refunded' as const
    case 'VOIDED': return 'voided' as const
    default: return 'unknown' as const
  }
}

function canonicalFulfillment(value: string | null) {
  switch ((value || '').toUpperCase()) {
    case 'DELIVERED':
    case 'FULFILLED':
    case 'IN_TRANSIT':
    case 'PRE_TRANSIT':
    case 'SHIPPED': return 'fulfilled' as const
    case 'PARTIALLY_FULFILLED':
    case 'PARTIALLY_SHIPPED': return 'partial' as const
    case 'BACKORDERED':
    case 'ON_HOLD': return 'on_hold' as const
    case 'NEW':
    case 'OPEN':
    case 'PENDING_RETAILER_CONFIRMATION':
    case 'PROCESSING': return 'unfulfilled' as const
    default: return 'unknown' as const
  }
}

function normalizedStates(
  order: Record<string, unknown>,
): Readonly<{
  raw: CommerceProviderStates
  canonical: CommerceCanonicalStates
}> {
  const rawLifecycle = optionalCommerceText(
    order.state ?? order.status,
    64,
  )
  const rawPayment = optionalCommerceText(
    order.payment_state ?? order.financial_status,
    64,
  )
  const rawFulfillment = optionalCommerceText(
    order.fulfillment_state ?? order.state,
    64,
  )
  const rawReturns = optionalCommerceText(order.return_state, 64)
  const state = (rawLifecycle || '').toUpperCase()
  return Object.freeze({
    raw: Object.freeze({
      lifecycle: rawLifecycle,
      payment: rawPayment,
      fulfillment: rawFulfillment,
      returns: rawReturns,
    }),
    canonical: Object.freeze({
      lifecycle: state.includes('CANCEL')
        ? 'cancelled'
        : ['CLOSED', 'DELIVERED', 'FULFILLED'].includes(state)
          ? 'closed'
          : rawLifecycle
            ? 'open'
            : 'unknown',
      payment: canonicalPayment(rawPayment),
      fulfillment: canonicalFulfillment(rawFulfillment),
      returns: rawReturns ? (
        rawReturns.toUpperCase() === 'NO_RETURN'
          ? 'none'
          : rawReturns.toUpperCase().includes('RETURNED')
          ? 'returned'
          : rawReturns.toUpperCase().includes('REQUEST')
            ? 'requested'
            : 'in_progress'
      ) : 'unknown',
    }),
  })
}

function lineMoney(
  line: Record<string, unknown>,
  currency: string,
  minorKeys: readonly string[],
  decimalKeys: readonly string[] = [],
) {
  return moneyFromRecord(line, {
    minorKeys,
    decimalKeys,
    fallbackCurrency: currency,
  })
}

function lineDiscountMoney(
  line: Record<string, unknown>,
  currency: string,
): CommerceDataField<CommerceMoneySet> {
  const direct = lineMoney(
    line,
    currency,
    ['discount_cents', 'line_discount_cents'],
    ['discount'],
  )
  return availableMoneyOr(
    direct,
    moneyFromDiscountCollection(line.discounts, currency),
  )
}

function normalizeLine(
  source: unknown,
  currency: string,
  knownVariants: ReadonlyMap<string, CommerceNormalizedVariant>,
): CommerceNormalizedOrderLine {
  const line = asCommerceRecord(source)
  if (!line) throw new Error('Faire returned an invalid order line')
  const identity = faireIdentity(
    line.id ?? line.order_item_id ?? line.item_id,
    'order_line',
  )
  const productIdentity = optionalFaireIdentity(
    line.product_id ?? asCommerceRecord(line.product)?.id,
    'product',
  )
  const variantIdentity = optionalFaireIdentity(
    line.product_variant_id
      ?? line.variant_id
      ?? asCommerceRecord(line.variant)?.id,
    'variant',
  )
  const knownVariant = variantIdentity.state === 'available'
    ? knownVariants.get(variantIdentity.value.value)
    : null
  const quantity = nonnegativeCommerceInteger(line.quantity)
  if (quantity === null) throw new Error('Faire returned an invalid line quantity')
  const unitMultiplier = positiveCommerceInteger(
    line.unit_multiplier ?? knownVariant?.unitMultiplier,
  )
  const multiplier = unitMultiplier || 1
  const physicalUnitQuantity = quantity * multiplier
  if (!Number.isSafeInteger(physicalUnitQuantity)) {
    throw new Error('Faire returned a line quantity outside the safe range')
  }
  let linePackaging = commercePackagingFromRecord(
    line.packaging,
    'order_line',
  )
  if (
    linePackaging.state !== 'available'
    && knownVariant?.packaging.state === 'available'
  ) {
    linePackaging = knownVariant.packaging
  }
  const unitPrice = lineMoney(
    line,
    currency,
    ['price_cents', 'wholesale_price_cents', 'unit_price_cents'],
    ['price', 'unit_price'],
  )
  const merchandiseSubtotal = scaledMoney(unitPrice, quantity)
  const computedSubtotal = line.includes_tester === true
    ? exactMoneySum([
        merchandiseSubtotal,
        lineMoney(
          line,
          currency,
          ['tester_price_cents'],
          ['tester_price'],
        ),
      ])
    : merchandiseSubtotal
  const lineSubtotal = availableMoneyOr(
    lineMoney(
      line,
      currency,
      ['subtotal_cents', 'total_cents'],
      ['subtotal', 'total'],
    ),
    computedSubtotal,
  )
  if (line.includes_tester === true && lineSubtotal.state !== 'available') {
    throw new Error('Faire returned an order-line tester without an exact price')
  }
  return Object.freeze({
    schemaVersion: COMMERCE_NORMALIZED_ORDER_LINE_VERSION,
    identity,
    productIdentity,
    variantIdentity,
    sku: optionalCommerceText(line.sku, 255),
    titleSnapshot: requiredCommerceText(
      line.product_name ?? line.name ?? line.title,
      'Faire order-line title',
      512,
    ),
    variantTitleSnapshot: optionalCommerceText(
      line.variant_name ?? line.option_name,
      512,
    ),
    vendorSnapshot: optionalCommerceText(
      line.brand_name ?? line.vendor,
      512,
    ),
    orderedQuantity: quantity,
    currentQuantity: null,
    cancelledQuantity: null,
    fulfilledQuantity: null,
    unfulfilledQuantity: null,
    returnedQuantity: null,
    removedOrRefundedQuantity: null,
    unitMultiplier,
    physicalUnitQuantity,
    unitPrice,
    lineSubtotal,
    lineDiscount: lineDiscountMoney(line, currency),
    lineTax: lineMoney(
      line,
      currency,
      ['tax_cents', 'vat_cents'],
      ['tax'],
    ),
    requiresShipping: line.requires_shipping !== false,
    packaging: linePackaging,
    sourceHash: commerceSourceHash(source),
  })
}

function lineDiscountTotal(
  lines: readonly Record<string, unknown>[],
  currency: string,
) {
  if (lines.length === 0) return unavailableCommerceField<CommerceMoneySet>()
  return exactMoneySum(lines.map((line) => (
    lineDiscountMoney(line, currency)
  )))
}

function payoutMoney(
  value: unknown,
  currency: string,
): CommerceDataField<CommerceMoneySet> {
  const payout = asCommerceRecord(value)
  if (!payout) return unavailableCommerceField()
  return moneyFromRecord(payout, {
    minorKeys: [
      'payout_cents',
      'total_payout_cents',
      'maker_cost_cents',
      'amount_cents',
    ],
    decimalKeys: ['total_payout', 'payout', 'amount'],
    fallbackCurrency: currency,
  })
}

function normalizeOrder(
  source: unknown,
  context: CommerceNormalizationContext,
  knownVariants: ReadonlyMap<string, CommerceNormalizedVariant>,
  ambiguousSkus: ReadonlySet<string>,
  brandFallback: unknown,
  rootTruncated: boolean,
  currencyFallback: unknown,
): CommerceNormalizedOrder {
  const order = asCommerceRecord(source)
  if (!order) throw new Error('Faire returned an invalid order')
  const identity = faireIdentity(order.id ?? order.order_id, 'order')
  const lineRecords = commerceConnectionValues(order.items ?? order.order_items)
    .map((line) => {
      const record = asCommerceRecord(line)
      if (!record) throw new Error('Faire returned an invalid order line')
      return record
    })
  const payout = asCommerceRecord(order.payout_costs)
  const currency = orderCurrency(order, lineRecords, currencyFallback)
  const lines = lineRecords.map((line) => normalizeLine(
    line,
    currency,
    knownVariants,
  ))
  const states = normalizedStates(order)
  const party = partySnapshot(order)
  const shipTo = commerceAddressFromRecord(
    order.address ?? order.shipping_address ?? order.ship_to,
  )
  const deliveryValue = providerDateTime(
    order.requested_delivery_at
      ?? order.expected_delivery_at
      ?? order.ship_after
      ?? order.expected_ship_date,
  )
  const requestedDeliveryAt = deliveryValue
    ? availableCommerceField(deliveryValue)
    : unavailableCommerceField<string>()
  const lineItemsTruncated = (
    rootTruncated
    || order.items_truncated === true
    || pageHasMore(order.items ?? order.order_items)
  )
  const sourceStale = (
    context.sourceState === 'stale'
    || order.source_stale === true
  )
  const readinessFacts = buildCommerceReadinessFacts({
    canonicalStates: states.canonical,
    lines,
    party,
    shipTo,
    requestedDeliveryAt,
    lineItemsTruncated,
    sourceStale,
    ambiguousSkus,
  })
  const retailerId = order.retailer_id ?? asCommerceRecord(order.retailer)?.id
  const brandDiscount = moneyFromDiscountCollection(
    order.brand_discounts,
    currency,
  )
  const lineDiscounts = lineDiscountTotal(lineRecords, currency)
  const explicitSubtotal = moneyFromRecord(order, {
    minorKeys: ['subtotal_cents', 'items_subtotal_cents'],
    decimalKeys: ['subtotal'],
    fallbackCurrency: currency,
  })
  const explicitShipping = moneyFromRecord(order, {
    minorKeys: ['shipping_cents', 'shipping_cost_cents'],
    decimalKeys: ['shipping', 'shipping_cost'],
    fallbackCurrency: currency,
  })
  const explicitTax = moneyFromRecord(order, {
    minorKeys: ['tax_cents', 'vat_cents'],
    decimalKeys: ['tax', 'vat'],
    fallbackCurrency: currency,
  })
  const explicitDiscount = moneyFromRecord(order, {
    minorKeys: ['discount_cents', 'total_discount_cents'],
    decimalKeys: ['discount', 'total_discount'],
    fallbackCurrency: currency,
  })
  const explicitTotal = moneyFromRecord(order, {
    minorKeys: ['total_cents', 'order_total_cents'],
    decimalKeys: ['total', 'order_total'],
    fallbackCurrency: currency,
  })
  const payoutSubtotalAfterDiscounts = payout
    ? moneyFromRecord(payout, {
        minorKeys: ['subtotal_after_brand_discounts_cents'],
        decimalKeys: ['subtotal_after_brand_discounts'],
        fallbackCurrency: currency,
      })
    : unavailableCommerceField<CommerceMoneySet>()
  const payoutTotalDiscounts = payout
    ? moneyFromRecord(payout, {
        minorKeys: ['total_brand_discounts_cents'],
        decimalKeys: ['total_brand_discounts'],
        fallbackCurrency: currency,
      })
    : unavailableCommerceField<CommerceMoneySet>()
  const payoutTax = payout
    ? moneyFromRecord(payout, {
        minorKeys: ['net_tax_cents'],
        decimalKeys: ['net_tax'],
        fallbackCurrency: currency,
      })
    : unavailableCommerceField<CommerceMoneySet>()
  const discount = availableMoneyOr(
    explicitDiscount,
    payoutTotalDiscounts,
  )
  const subtotal = availableMoneyOr(
    explicitSubtotal,
    exactMoneySum([
      payoutSubtotalAfterDiscounts,
      payoutTotalDiscounts,
    ]),
  )
  const shipping = availableMoneyOr(
    explicitShipping,
    order.is_free_shipping === true
      ? exactZeroMoney(currency)
      : unavailableCommerceField<CommerceMoneySet>(),
  )
  const tax = availableMoneyOr(explicitTax, payoutTax)
  const total = availableMoneyOr(
    explicitTotal,
    exactOrderTotal(subtotal, discount, shipping, tax),
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
      order.display_id ?? order.order_number ?? order.id,
      'Faire order number',
      255,
    ),
    providerCreatedAt: optionalCommerceTimestamp(order.created_at),
    providerProcessedAt: optionalCommerceTimestamp(
      order.processing_at ?? order.processed_at,
    ),
    providerUpdatedAt: optionalCommerceTimestamp(order.updated_at),
    providerCancelledAt: optionalCommerceTimestamp(order.cancelled_at),
    providerClosedAt: optionalCommerceTimestamp(
      order.delivered_at ?? order.closed_at,
    ),
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
    requestedDeliveryAt,
    lines: Object.freeze(lines),
    lineItemsTruncated,
    sourceStale,
    readinessFacts,
    providerFacts: Object.freeze({
      provider: 'faire',
      brandIdentity: optionalFaireIdentity(
        order.brand_id ?? brandFallback,
        'brand',
      ),
      retailerIdentity: optionalFaireIdentity(retailerId, 'retailer'),
      brandDiscount,
      lineDiscountTotal: lineDiscounts,
      payoutState: optionalCommerceText(
        payout?.state ?? payout?.status,
        64,
      ),
      payoutAmount: payoutMoney(order.payout_costs, currency),
    }),
    sourceHash: commerceSourceHash(source),
  })
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

function rejectedRecordExternalId(
  source: unknown,
  resourceType: 'order' | 'product',
): string | undefined {
  const record = asCommerceRecord(source)
  const value = resourceType === 'product'
    ? record?.id ?? record?.product_id
    : record?.id ?? record?.order_id
  return (
    typeof value === 'string'
    && value === value.trim()
    && FAIRE_ID.test(value)
  )
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

export function normalizeFaireCommerce(
  sourceValue: FaireSource,
  context: CommerceNormalizationContext,
): CommerceNormalizationEnvelope {
  validateCommerceNormalizationContext(context)
  const source = asCommerceRecord(sourceValue)
  if (!source) throw new Error('Faire normalization requires an object source')
  const data = asCommerceRecord(source.data) || source
  const brand = asCommerceRecord(data.brand ?? data.brand_profile)
  const productsPage = asCommerceRecord(data.products)
  const brandFallback = brand?.id ?? context.externalAccountId
  const inventories = asCommerceRecord(data.inventories) || {}
  const currencyFallback = (
    data.currency
    ?? data.currency_code
    ?? productsPage?.currency
    ?? productsPage?.currency_code
    ?? brand?.currency
    ?? brand?.currency_code
    ?? 'USD'
  )
  const priceCurrencyFallback = (
    data.currency
    ?? data.currency_code
    ?? productsPage?.currency
    ?? productsPage?.currency_code
    ?? brand?.currency
    ?? brand?.currency_code
    ?? null
  )
  const products: CommerceNormalizedProduct[] = []
  const rejections: CommerceNormalizationRejection[] = []
  for (const product of fairePageCollection(data.products, 'products')) {
    try {
      products.push(normalizeProduct(
        product,
        inventories,
        brandFallback,
        currencyFallback,
        priceCurrencyFallback,
      ))
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
  const rootTruncated = (
    source.truncated === true
    || pageHasMore(data.products)
    || pageHasMore(data.orders)
    || asCommerceRecord(data.pagination)?.has_more === true
    || asCommerceRecord(data.page_info)?.has_next_page === true
  )
  const orders: CommerceNormalizedOrder[] = []
  for (const order of fairePageCollection(data.orders, 'orders')) {
    try {
      orders.push(normalizeOrder(
        order,
        context,
        variants,
        ambiguousSkus,
        brandFallback,
        rootTruncated,
        currencyFallback,
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
    normalizerVersion: FAIRE_COMMERCE_NORMALIZER_VERSION,
    provider: 'faire',
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

export const FAIRE_COMMERCE_NORMALIZATION_ADAPTER = Object.freeze({
  provider: 'faire',
  normalizerVersion: FAIRE_COMMERCE_NORMALIZER_VERSION,
  normalize: normalizeFaireCommerce,
} satisfies ReadOnlyCommerceNormalizationAdapter<FaireSource>)
