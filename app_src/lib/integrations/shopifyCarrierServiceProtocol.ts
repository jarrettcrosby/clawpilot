import crypto from 'node:crypto'

const MAX_REQUEST_BYTES = 512 * 1024
const MAX_ITEMS = 250
const MAX_ITEM_QUANTITY = 100_000
const MAX_TOTAL_QUANTITY = 10_000_000
const MAX_ITEM_GRAMS = 1_000_000
const MAX_TOTAL_GRAMS = BigInt(2_000_000_000_000)
const MAX_ITEM_PRICE_MINOR = 9_000_000_000_000
const MAX_TOTAL_PRICE_MINOR = BigInt(9_000_000_000_000_000)
export const SHOPIFY_CARRIER_SERVICE_MAX_RATES = 50
const MAX_RATE_AMOUNT_MINOR = BigInt(9_000_000_000_000_000)
const MAX_PROPERTY_NODES = 256
const MAX_PROPERTY_DEPTH = 5
export const SHOPIFY_CARRIER_SERVICE_FINGERPRINT_VERSION =
  'shopify-carrier-service-rate-v3'

const CURRENCY_PATTERN = /^[A-Z]{3}$/
const COUNTRY_PATTERN = /^[A-Z]{2}$/
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/
const IDENTIFIER_PATTERN = /^[1-9][0-9]{0,19}$/
const CODE_PART_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,31})$/
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

export const SHOPIFY_CARRIER_SERVICE_MAX_REQUEST_BYTES = MAX_REQUEST_BYTES

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export type ShopifyCarrierServiceAddress = {
  countryCode: string
  postalCode: string
  provinceCode: string | null
  city: string | null
  address1: string | null
  address2: string | null
}

export type ShopifyCarrierServiceItem = {
  productId: string
  variantId: string
  name: string
  sku: string
  quantity: number
  grams: number
  priceMinor: number
  requiresShipping: boolean
  taxable: boolean
  propertiesFingerprint: string | null
}

export type ShopifyCarrierServiceOrderTotals = {
  subtotalPriceMinor: number
  totalPriceMinor: number
  discountAmountMinor: number
}

export type ShopifyCarrierServiceCustomer = {
  id: string | null
  tags: string[]
}

export type ShopifyCarrierServiceRateRequest = {
  origin: ShopifyCarrierServiceAddress
  destination: ShopifyCarrierServiceAddress
  items: ShopifyCarrierServiceItem[]
  currency: string
  locale: string
  orderTotals: ShopifyCarrierServiceOrderTotals | null
  customer: ShopifyCarrierServiceCustomer | null
}

export type ShopifyCarrierServiceRateQuote = {
  carrierCode: string
  serviceLevelCode: string
  serviceName: string
  description: string
  amountMinor: bigint | number | string
  currency: string
  phoneRequired?: boolean
  minDeliveryDate?: Date | string | null
  maxDeliveryDate?: Date | string | null
}

export type ShopifyCarrierServiceRateResponse = {
  rates: Array<{
    service_name: string
    service_code: string
    total_price: string
    description: string
    currency: string
    phone_required?: boolean
    min_delivery_date?: string
    max_delivery_date?: string
  }>
}

export type ShopifyCarrierServiceTestAllowlist = {
  customerIds: ReadonlySet<string>
  variantIds: ReadonlySet<string>
}

export class ShopifyCarrierServiceProtocolError extends Error {
  readonly code: string
  readonly path: string

  constructor(
    message: string,
    code: string,
    path: string,
  ) {
    super(message)
    this.name = 'ShopifyCarrierServiceProtocolError'
    this.code = code
    this.path = path
  }
}

const SAFE_PROTOCOL_ERROR_PATHS = [
  /^\$$/,
  /^\$\.rate$/,
  /^\$\.rate\.(?:currency|locale|items|order_totals|customer)$/,
  /^\$\.rate\.(?:origin|destination)(?:\.(?:country|postal_code|province|city|address1|address2))?$/,
  /^\$\.rate\.items\[[0-9]{1,3}\](?:\.(?:name|sku|quantity|grams|price|requires_shipping|taxable|product_id|variant_id|properties))?$/,
  /^\$\.rate\.order_totals\.(?:subtotal_price|total_price|discount_amount)$/,
  /^\$\.rate\.customer\.(?:id|tags)(?:\[[0-9]{1,3}\])?$/,
]
const SAFE_ITEM_PROPERTIES_ROOT =
  /^(\$\.rate\.items\[[0-9]{1,3}\]\.properties)(?:\.|\[).*$/

/**
 * Returns only a schema-owned path suitable for operational logging.
 * Arbitrary line-property keys are collapsed to the known properties root so
 * customer-provided names or values cannot enter logs.
 */
export function safeShopifyCarrierServiceProtocolErrorPath(
  error: unknown,
): string | null {
  if (!(error instanceof ShopifyCarrierServiceProtocolError)) return null
  if (SAFE_PROTOCOL_ERROR_PATHS.some((pattern) => pattern.test(error.path))) {
    return error.path
  }
  return error.path.match(SAFE_ITEM_PROPERTIES_ROOT)?.[1] || '$'
}

function protocolError(path: string, message: string, code: string): never {
  throw new ShopifyCarrierServiceProtocolError(message, code, path)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    protocolError(path, `${path} must be an object`, 'SHOPIFY_CARRIER_REQUEST_INVALID')
  }
  return value as Record<string, unknown>
}

function boundedRequest(input: unknown): void {
  let serialized: string
  try {
    const candidate = JSON.stringify(input)
    if (typeof candidate !== 'string') throw new Error('not serializable')
    serialized = candidate
  } catch {
    protocolError(
      '$',
      'Shopify carrier request must be bounded JSON data',
      'SHOPIFY_CARRIER_REQUEST_INVALID',
    )
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    protocolError(
      '$',
      'Shopify carrier request exceeded the safe size limit',
      'SHOPIFY_CARRIER_REQUEST_TOO_LARGE',
    )
  }
}

function cleanText(
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') {
    protocolError(path, `${path} must be text`, 'SHOPIFY_CARRIER_REQUEST_INVALID')
  }
  const normalized = value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
  if (
    normalized.length > maximum
    || (!allowEmpty && !normalized)
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    protocolError(
      path,
      `${path} is invalid or too long`,
      'SHOPIFY_CARRIER_REQUEST_INVALID',
    )
  }
  return normalized
}

function optionalText(
  value: unknown,
  path: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === '') return null
  return cleanText(value, path, maximum)
}

function exactInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  let parsed: number
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    parsed = Number(value)
  } else {
    protocolError(
      path,
      `${path} must be an exact integer`,
      'SHOPIFY_CARRIER_INTEGER_INVALID',
    )
  }
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    protocolError(
      path,
      `${path} is outside the supported integer range`,
      'SHOPIFY_CARRIER_INTEGER_OUT_OF_RANGE',
    )
  }
  return parsed
}

type ShopifyIdentifierResource = 'Customer' | 'Product' | 'ProductVariant'

function decimalIdentifier(
  value: unknown,
  path: string,
  resource: ShopifyIdentifierResource,
): string {
  let normalized: string
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      protocolError(
        path,
        `${path} must be an exact positive identifier`,
        'SHOPIFY_CARRIER_IDENTIFIER_INVALID',
      )
    }
    normalized = String(value)
  } else if (typeof value === 'string') {
    const resourceGid = value.match(
      new RegExp(`^gid://shopify/${resource}/([1-9][0-9]{0,19})$`),
    )
    normalized = resourceGid?.[1] || value
  } else {
    protocolError(
      path,
      `${path} must be an exact positive identifier`,
      'SHOPIFY_CARRIER_IDENTIFIER_INVALID',
    )
  }
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    protocolError(
      path,
      `${path} must be an exact positive identifier`,
      'SHOPIFY_CARRIER_IDENTIFIER_INVALID',
    )
  }
  return normalized
}

function normalizeAddress(
  value: unknown,
  path: '$.rate.origin' | '$.rate.destination',
): ShopifyCarrierServiceAddress {
  const address = record(value, path)
  const countryCode = cleanText(address.country, `${path}.country`, 2).toUpperCase()
  if (!COUNTRY_PATTERN.test(countryCode)) {
    protocolError(
      `${path}.country`,
      `${path}.country must be an ISO 3166-1 alpha-2 code`,
      'SHOPIFY_CARRIER_COUNTRY_INVALID',
    )
  }
  const postalCode = cleanText(
    address.postal_code,
    `${path}.postal_code`,
    32,
  ).toUpperCase()

  return {
    countryCode,
    postalCode,
    provinceCode: optionalText(
      address.province,
      `${path}.province`,
      128,
    )?.toUpperCase() || null,
    city: optionalText(address.city, `${path}.city`, 255),
    address1: optionalText(address.address1, `${path}.address1`, 255),
    address2: optionalText(address.address2, `${path}.address2`, 255),
  }
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson }

function canonicalPropertyValue(
  value: unknown,
  path: string,
  depth: number,
  nodeCounter: { count: number },
): CanonicalJson {
  nodeCounter.count += 1
  if (nodeCounter.count > MAX_PROPERTY_NODES || depth > MAX_PROPERTY_DEPTH) {
    protocolError(
      path,
      'Shopify line properties exceeded the safe complexity limit',
      'SHOPIFY_CARRIER_PROPERTIES_TOO_COMPLEX',
    )
  }
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      protocolError(
        path,
        'Shopify line property numbers must be exact safe integers',
        'SHOPIFY_CARRIER_PROPERTIES_INVALID',
      )
    }
    return value
  }
  if (typeof value === 'string') {
    return cleanText(value, path, 1_024, true)
  }
  if (Array.isArray(value)) {
    if (value.length > 64) {
      protocolError(
        path,
        'Shopify line properties exceeded the safe array limit',
        'SHOPIFY_CARRIER_PROPERTIES_TOO_COMPLEX',
      )
    }
    return value.map((entry, index) =>
      canonicalPropertyValue(entry, `${path}[${index}]`, depth + 1, nodeCounter))
  }
  const input = record(value, path)
  const keys = Object.keys(input).sort()
  if (keys.length > 64) {
    protocolError(
      path,
      'Shopify line properties exceeded the safe field limit',
      'SHOPIFY_CARRIER_PROPERTIES_TOO_COMPLEX',
    )
  }
  const output: { [key: string]: CanonicalJson } = {}
  for (const key of keys) {
    if (
      !key
      || key.length > 128
      || /[\u0000-\u001f\u007f]/.test(key)
    ) {
      protocolError(
        path,
        'Shopify line property names are invalid',
        'SHOPIFY_CARRIER_PROPERTIES_INVALID',
      )
    }
    output[key] = canonicalPropertyValue(
      input[key],
      `${path}.${key}`,
      depth + 1,
      nodeCounter,
    )
  }
  return output
}

function propertiesFingerprint(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  const canonical = canonicalPropertyValue(value, path, 0, { count: 0 })
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex')
}

function normalizeItem(
  value: unknown,
  index: number,
): ShopifyCarrierServiceItem {
  const path = `$.rate.items[${index}]`
  const item = record(value, path)
  if (typeof item.requires_shipping !== 'boolean') {
    protocolError(
      `${path}.requires_shipping`,
      `${path}.requires_shipping must be boolean`,
      'SHOPIFY_CARRIER_REQUEST_INVALID',
    )
  }
  if (typeof item.taxable !== 'boolean') {
    protocolError(
      `${path}.taxable`,
      `${path}.taxable must be boolean`,
      'SHOPIFY_CARRIER_REQUEST_INVALID',
    )
  }
  return {
    productId: decimalIdentifier(
      item.product_id,
      `${path}.product_id`,
      'Product',
    ),
    variantId: decimalIdentifier(
      item.variant_id,
      `${path}.variant_id`,
      'ProductVariant',
    ),
    name: cleanText(item.name, `${path}.name`, 255),
    sku: item.sku === undefined || item.sku === null
      ? ''
      : cleanText(item.sku, `${path}.sku`, 255, true),
    quantity: exactInteger(
      item.quantity,
      `${path}.quantity`,
      1,
      MAX_ITEM_QUANTITY,
    ),
    grams: exactInteger(
      item.grams,
      `${path}.grams`,
      0,
      MAX_ITEM_GRAMS,
    ),
    priceMinor: exactInteger(
      item.price,
      `${path}.price`,
      0,
      MAX_ITEM_PRICE_MINOR,
    ),
    requiresShipping: item.requires_shipping,
    taxable: item.taxable,
    propertiesFingerprint: propertiesFingerprint(
      item.properties,
      `${path}.properties`,
    ),
  }
}

function normalizeOrderTotals(
  value: unknown,
): ShopifyCarrierServiceOrderTotals | null {
  if (value === undefined || value === null) return null
  const totals = record(value, '$.rate.order_totals')
  return {
    subtotalPriceMinor: exactInteger(
      totals.subtotal_price,
      '$.rate.order_totals.subtotal_price',
      0,
      MAX_ITEM_PRICE_MINOR,
    ),
    totalPriceMinor: exactInteger(
      totals.total_price,
      '$.rate.order_totals.total_price',
      0,
      MAX_ITEM_PRICE_MINOR,
    ),
    discountAmountMinor: exactInteger(
      totals.discount_amount,
      '$.rate.order_totals.discount_amount',
      0,
      MAX_ITEM_PRICE_MINOR,
    ),
  }
}

function normalizeCustomer(value: unknown): ShopifyCarrierServiceCustomer | null {
  if (value === undefined || value === null) return null
  const customer = record(value, '$.rate.customer')
  const id = customer.id === undefined || customer.id === null
    ? null
    : decimalIdentifier(customer.id, '$.rate.customer.id', 'Customer')
  if (!Array.isArray(customer.tags) || customer.tags.length > 100) {
    protocolError(
      '$.rate.customer.tags',
      '$.rate.customer.tags must be a bounded array',
      'SHOPIFY_CARRIER_REQUEST_INVALID',
    )
  }
  const tags = [...new Set(customer.tags.map((tag, index) =>
    cleanText(tag, `$.rate.customer.tags[${index}]`, 128)))]
    .sort(compareCanonicalText)
  return { id, tags }
}

/**
 * Parses Shopify's public CarrierService callback payload. Shopify does not
 * HMAC-sign this callback, so endpoint authentication belongs at the opaque
 * callback URL layer rather than in this protocol parser.
 *
 * Contact fields are deliberately discarded. In particular, customer email,
 * phone, names, fax, and company names never enter the normalized request or
 * its fingerprint.
 */
export function parseShopifyCarrierServiceRateRequest(
  input: unknown,
): ShopifyCarrierServiceRateRequest {
  boundedRequest(input)
  const root = record(input, '$')
  const rate = record(root.rate, '$.rate')
  if (!Array.isArray(rate.items) || rate.items.length < 1 || rate.items.length > MAX_ITEMS) {
    protocolError(
      '$.rate.items',
      `$.rate.items must contain between 1 and ${MAX_ITEMS} lines`,
      'SHOPIFY_CARRIER_ITEMS_INVALID',
    )
  }
  const items = rate.items.map(normalizeItem)
  let totalQuantity = 0
  let totalGrams = BigInt(0)
  let totalPriceMinor = BigInt(0)
  for (const item of items) {
    totalQuantity += item.quantity
    totalGrams += BigInt(item.quantity) * BigInt(item.grams)
    totalPriceMinor += BigInt(item.quantity) * BigInt(item.priceMinor)
  }
  if (
    totalQuantity > MAX_TOTAL_QUANTITY
    || totalGrams > MAX_TOTAL_GRAMS
    || totalPriceMinor > MAX_TOTAL_PRICE_MINOR
  ) {
    protocolError(
      '$.rate.items',
      'Shopify carrier request totals exceeded the supported bounds',
      'SHOPIFY_CARRIER_TOTALS_OUT_OF_RANGE',
    )
  }

  const currency = cleanText(rate.currency, '$.rate.currency', 3).toUpperCase()
  if (!CURRENCY_PATTERN.test(currency)) {
    protocolError(
      '$.rate.currency',
      '$.rate.currency must be a three-letter currency code',
      'SHOPIFY_CARRIER_CURRENCY_INVALID',
    )
  }
  const locale = cleanText(rate.locale, '$.rate.locale', 64)
    .replace(/_/g, '-')
    .toLowerCase()
  if (!LOCALE_PATTERN.test(locale)) {
    protocolError(
      '$.rate.locale',
      '$.rate.locale is invalid',
      'SHOPIFY_CARRIER_LOCALE_INVALID',
    )
  }

  return {
    origin: normalizeAddress(rate.origin, '$.rate.origin'),
    destination: normalizeAddress(rate.destination, '$.rate.destination'),
    items,
    currency,
    locale,
    orderTotals: normalizeOrderTotals(rate.order_totals),
    customer: normalizeCustomer(rate.customer),
  }
}

/**
 * Limits a hosted Shadow checkout proof to an immutable Shopify customer ID
 * and an explicit set of test variants. Shopify may omit the customer object
 * from discovery callbacks, but those requests remain ineligible for Shadow
 * rates. Contact names, tags, and email addresses are never authorization
 * boundaries.
 */
export function shopifyCarrierServiceRequestMatchesTestAllowlist(
  request: ShopifyCarrierServiceRateRequest,
  allowlist: ShopifyCarrierServiceTestAllowlist,
): boolean {
  const customerId = request.customer?.id
  if (!customerId || !allowlist.customerIds.has(customerId)) return false
  const shippableItems = request.items.filter((item) => item.requiresShipping)
  return shippableItems.length > 0
    && shippableItems.every((item) => allowlist.variantIds.has(item.variantId))
}

/**
 * Reads a public callback without first allowing Request.json() to allocate an
 * unbounded body. Content-Length is advisory; the streamed byte count remains
 * authoritative.
 */
export async function readShopifyCarrierServiceRateRequest(
  request: Request,
  options: {
    signal?: AbortSignal
  } = {},
): Promise<ShopifyCarrierServiceRateRequest> {
  const contentLength = request.headers.get('content-length')
  if (
    contentLength
    && (
      !/^(?:0|[1-9][0-9]*)$/.test(contentLength)
      || Number(contentLength) > MAX_REQUEST_BYTES
    )
  ) {
    protocolError(
      '$',
      'Shopify carrier request exceeded the safe size limit',
      'SHOPIFY_CARRIER_REQUEST_TOO_LARGE',
    )
  }
  if (!request.body) {
    protocolError(
      '$',
      'Shopify carrier request body is required',
      'SHOPIFY_CARRIER_REQUEST_INVALID',
    )
  }
  const reader = request.body.getReader()
  const abortReader = () => {
    void reader.cancel('Shopify carrier callback deadline exceeded')
      .catch(() => undefined)
  }
  if (options.signal?.aborted) abortReader()
  else options.signal?.addEventListener('abort', abortReader, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      if (options.signal?.aborted) {
        protocolError(
          '$',
          'Shopify carrier request was cancelled at the callback deadline',
          'SHOPIFY_CARRIER_REQUEST_ABORTED',
        )
      }
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        protocolError(
          '$',
          'Shopify carrier request exceeded the safe size limit',
          'SHOPIFY_CARRIER_REQUEST_TOO_LARGE',
        )
      }
      chunks.push(value)
    }
    if (options.signal?.aborted) {
      protocolError(
        '$',
        'Shopify carrier request was cancelled at the callback deadline',
        'SHOPIFY_CARRIER_REQUEST_ABORTED',
      )
    }
  } finally {
    options.signal?.removeEventListener('abort', abortReader)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    protocolError(
      '$',
      'Shopify carrier request must be valid UTF-8 JSON',
      'SHOPIFY_CARRIER_REQUEST_INVALID',
    )
  }
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    protocolError(
      '$',
      'Shopify carrier request must be valid JSON',
      'SHOPIFY_CARRIER_REQUEST_INVALID',
    )
  }
  return parseShopifyCarrierServiceRateRequest(input)
}

function canonicalAddress(address: ShopifyCarrierServiceAddress) {
  const canonicalText = (value: string | null) =>
    value === null ? null : value.toLowerCase()
  return {
    countryCode: address.countryCode,
    postalCode: canonicalText(address.postalCode),
    provinceCode: canonicalText(address.provinceCode),
    city: canonicalText(address.city),
    address1: canonicalText(address.address1),
    address2: canonicalText(address.address2),
  }
}

function canonicalItem(item: ShopifyCarrierServiceItem) {
  return {
    productId: item.productId,
    variantId: item.variantId,
    sku: item.sku.toLowerCase(),
    quantity: item.quantity,
    grams: item.grams,
    priceMinor: item.priceMinor,
    requiresShipping: item.requiresShipping,
    taxable: item.taxable,
    propertiesFingerprint: item.propertiesFingerprint,
  }
}

export function fingerprintShopifyCarrierServiceRateRequest(
  request: ShopifyCarrierServiceRateRequest,
): string {
  const items = request.items
    .map(canonicalItem)
    .sort((left, right) => compareCanonicalText(
      JSON.stringify(left),
      JSON.stringify(right),
    ))
  const canonical = {
    version: SHOPIFY_CARRIER_SERVICE_FINGERPRINT_VERSION,
    origin: canonicalAddress(request.origin),
    destination: canonicalAddress(request.destination),
    items,
    currency: request.currency,
    locale: request.locale,
    orderTotals: request.orderTotals,
    customer: request.customer
      ? {
          id: request.customer.id,
          tags: [...request.customer.tags].sort(compareCanonicalText),
        }
      : null,
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex')
}

function cleanResponseText(
  value: unknown,
  path: string,
  maximum: number,
): string {
  if (typeof value !== 'string') {
    protocolError(path, `${path} must be text`, 'SHOPIFY_CARRIER_RESPONSE_INVALID')
  }
  const normalized = value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    protocolError(
      path,
      `${path} is invalid or too long`,
      'SHOPIFY_CARRIER_RESPONSE_INVALID',
    )
  }
  return normalized
}

function codePart(value: unknown, path: string): string {
  const normalized = cleanResponseText(value, path, 32).toLowerCase()
  if (!CODE_PART_PATTERN.test(normalized)) {
    protocolError(
      path,
      `${path} must be a stable lowercase code token`,
      'SHOPIFY_CARRIER_SERVICE_CODE_INVALID',
    )
  }
  return normalized
}

export function stableShopifyCarrierServiceCode(
  carrierCode: unknown,
  serviceLevelCode: unknown,
): string {
  return `clawpilot:${codePart(carrierCode, 'carrierCode')}:${codePart(
    serviceLevelCode,
    'serviceLevelCode',
  )}`
}

function minorAmount(value: unknown, path: string): string {
  let amount: bigint
  try {
    if (typeof value === 'bigint') {
      amount = value
    } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
      amount = BigInt(value)
    } else if (
      typeof value === 'string'
      && /^(?:0|[1-9][0-9]*)$/.test(value)
    ) {
      amount = BigInt(value)
    } else {
      throw new Error('not an integer')
    }
  } catch {
    protocolError(
      path,
      `${path} must be an exact integer minor amount`,
      'SHOPIFY_CARRIER_AMOUNT_INVALID',
    )
  }
  if (amount < BigInt(0) || amount > MAX_RATE_AMOUNT_MINOR) {
    protocolError(
      path,
      `${path} is outside the supported amount range`,
      'SHOPIFY_CARRIER_AMOUNT_OUT_OF_RANGE',
    )
  }
  return amount.toString()
}

function responseCurrency(value: unknown, path: string): string {
  const currency = cleanResponseText(value, path, 3)
  if (!CURRENCY_PATTERN.test(currency)) {
    protocolError(
      path,
      `${path} must be an uppercase three-letter currency code`,
      'SHOPIFY_CARRIER_CURRENCY_INVALID',
    )
  }
  return currency
}

function validRfc3339Calendar(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/
    .exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[9] === undefined ? 0 : Number(match[9])
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10])
  if (
    year < 2_000
    || month < 1
    || month > 12
    || day < 1
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return false
  }
  const calendar = new Date(Date.UTC(year, month - 1, day))
  return (
    calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day
  )
}

function deliveryDate(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  let date: Date
  if (value instanceof Date) {
    date = value
  } else if (
    typeof value === 'string'
    && RFC3339_PATTERN.test(value)
    && validRfc3339Calendar(value)
  ) {
    date = new Date(value)
  } else {
    protocolError(
      path,
      `${path} must be an RFC 3339 timestamp`,
      'SHOPIFY_CARRIER_DELIVERY_DATE_INVALID',
    )
  }
  if (!Number.isFinite(date.getTime())) {
    protocolError(
      path,
      `${path} must be a valid delivery timestamp`,
      'SHOPIFY_CARRIER_DELIVERY_DATE_INVALID',
    )
  }
  const normalized = date.toISOString()
  if (!validRfc3339Calendar(normalized)) {
    protocolError(
      path,
      `${path} is outside the supported delivery timestamp range`,
      'SHOPIFY_CARRIER_DELIVERY_DATE_INVALID',
    )
  }
  return normalized
}

export function buildShopifyCarrierServiceRateResponse(
  quotes: readonly ShopifyCarrierServiceRateQuote[],
): ShopifyCarrierServiceRateResponse {
  if (
    !Array.isArray(quotes)
    || quotes.length > SHOPIFY_CARRIER_SERVICE_MAX_RATES
  ) {
    protocolError(
      'rates',
      `rates must be an array with at most ${SHOPIFY_CARRIER_SERVICE_MAX_RATES} entries`,
      'SHOPIFY_CARRIER_RESPONSE_INVALID',
    )
  }
  const serviceCodes = new Set<string>()
  const rates = quotes.map((quote, index) => {
    if (!quote || typeof quote !== 'object') {
      protocolError(
        `rates[${index}]`,
        `rates[${index}] must be an object`,
        'SHOPIFY_CARRIER_RESPONSE_INVALID',
      )
    }
    const serviceCode = stableShopifyCarrierServiceCode(
      quote.carrierCode,
      quote.serviceLevelCode,
    )
    if (serviceCodes.has(serviceCode)) {
      protocolError(
        `rates[${index}].serviceLevelCode`,
        `rates contains duplicate service code ${serviceCode}`,
        'SHOPIFY_CARRIER_SERVICE_CODE_DUPLICATE',
      )
    }
    serviceCodes.add(serviceCode)
    if (
      quote.phoneRequired !== undefined
      && typeof quote.phoneRequired !== 'boolean'
    ) {
      protocolError(
        `rates[${index}].phoneRequired`,
        `rates[${index}].phoneRequired must be boolean`,
        'SHOPIFY_CARRIER_RESPONSE_INVALID',
      )
    }
    const minDeliveryDate = deliveryDate(
      quote.minDeliveryDate,
      `rates[${index}].minDeliveryDate`,
    )
    const maxDeliveryDate = deliveryDate(
      quote.maxDeliveryDate,
      `rates[${index}].maxDeliveryDate`,
    )
    if (
      minDeliveryDate
      && maxDeliveryDate
      && Date.parse(minDeliveryDate) > Date.parse(maxDeliveryDate)
    ) {
      protocolError(
        `rates[${index}]`,
        'Minimum delivery date cannot be later than maximum delivery date',
        'SHOPIFY_CARRIER_DELIVERY_RANGE_INVALID',
      )
    }
    return {
      service_name: cleanResponseText(
        quote.serviceName,
        `rates[${index}].serviceName`,
        255,
      ),
      service_code: serviceCode,
      total_price: minorAmount(
        quote.amountMinor,
        `rates[${index}].amountMinor`,
      ),
      description: cleanResponseText(
        quote.description,
        `rates[${index}].description`,
        255,
      ),
      currency: responseCurrency(
        quote.currency,
        `rates[${index}].currency`,
      ),
      ...(quote.phoneRequired === undefined
        ? {}
        : { phone_required: quote.phoneRequired }),
      ...(minDeliveryDate ? { min_delivery_date: minDeliveryDate } : {}),
      ...(maxDeliveryDate ? { max_delivery_date: maxDeliveryDate } : {}),
    }
  })
  return { rates }
}
