import { createHmac, timingSafeEqual } from 'node:crypto'

const SHOP_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/
const CUSTOMER_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/
const TIMESTAMP_PATTERN = /^[0-9]{10}$/
const CART_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/
const MAX_QUERY_BYTES = 8 * 1024
const MAX_PARAMETER_COUNT = 64
const MAX_PARAMETER_KEY_LENGTH = 128
const MAX_PARAMETER_VALUE_LENGTH = 2_048
const DEFAULT_MAX_AGE_SECONDS = 300
const DEFAULT_FUTURE_SKEW_SECONDS = 30

export type ShopifyAppProxyIdentity = {
  shopDomain: string
  customerId: string
  timestamp: number
  pathPrefix: string | null
  cartFingerprint: string
  cartCurrency: string | null
}

export class ShopifyAppProxyVerificationError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 401) {
    super(message)
    this.name = 'ShopifyAppProxyVerificationError'
    this.code = code
    this.status = status
  }
}

function fail(code: string, message: string, status = 401): never {
  throw new ShopifyAppProxyVerificationError(code, message, status)
}

function queryBytes(parameters: URLSearchParams) {
  return Buffer.byteLength(parameters.toString(), 'utf8')
}

function validatedEntries(parameters: URLSearchParams) {
  if (queryBytes(parameters) > MAX_QUERY_BYTES) {
    fail(
      'SHOPIFY_APP_PROXY_QUERY_TOO_LARGE',
      'Shopify app-proxy query exceeded the supported size',
      400,
    )
  }
  const entries = [...parameters.entries()]
  if (entries.length < 1 || entries.length > MAX_PARAMETER_COUNT) {
    fail(
      'SHOPIFY_APP_PROXY_QUERY_INVALID',
      'Shopify app-proxy query had an invalid parameter count',
      400,
    )
  }
  for (const [key, value] of entries) {
    if (
      !key
      || key.length > MAX_PARAMETER_KEY_LENGTH
      || value.length > MAX_PARAMETER_VALUE_LENGTH
      || /[\u0000-\u001f\u007f]/.test(key)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    ) {
      fail(
        'SHOPIFY_APP_PROXY_QUERY_INVALID',
        'Shopify app-proxy query contained an invalid parameter',
        400,
      )
    }
  }
  return entries
}

function singleton(
  parameters: URLSearchParams,
  key: string,
  required = true,
): string | null {
  const values = parameters.getAll(key)
  if (values.length > 1 || (required && values.length !== 1)) {
    fail(
      'SHOPIFY_APP_PROXY_QUERY_INVALID',
      `Shopify app-proxy ${key} parameter was invalid`,
      400,
    )
  }
  return values[0] ?? null
}

export function readShopifyAppProxyShopHint(
  parameters: URLSearchParams,
): string {
  validatedEntries(parameters)
  const value = singleton(parameters, 'shop')
  const shopDomain = String(value || '').trim().toLowerCase()
  if (!SHOP_DOMAIN_PATTERN.test(shopDomain)) {
    fail(
      'SHOPIFY_APP_PROXY_SHOP_INVALID',
      'Shopify app-proxy shop was invalid',
      400,
    )
  }
  return shopDomain
}

export function canonicalizeShopifyAppProxyQuery(
  parameters: URLSearchParams,
): string {
  const grouped = new Map<string, string[]>()
  for (const [key, value] of validatedEntries(parameters)) {
    if (key === 'signature') continue
    const values = grouped.get(key) || []
    values.push(value)
    grouped.set(key, values)
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    ))
    .map(([key, values]) => `${key}=${values.join(',')}`)
    .join('')
}

function signatureMatches(
  suppliedSignature: string,
  canonicalQuery: string,
  secret: string,
) {
  if (!SIGNATURE_PATTERN.test(suppliedSignature)) return false
  if (
    secret.length < 16
    || secret.length > 4_096
    || secret !== secret.trim()
    || !/^[\x21-\x7e]+$/.test(secret)
  ) {
    fail(
      'SHOPIFY_APP_PROXY_SECRET_INVALID',
      'Shopify app-proxy verification is not configured',
      500,
    )
  }
  const supplied = Buffer.from(suppliedSignature, 'hex')
  const expected = createHmac('sha256', secret)
    .update(canonicalQuery, 'utf8')
    .digest()
  return supplied.length === expected.length
    && timingSafeEqual(supplied, expected)
}

function normalizedPathPrefix(value: string | null) {
  if (value === null) return null
  if (
    !value.startsWith('/')
    || value.length > 255
    || value.includes('\\')
    || value.includes('..')
  ) {
    fail(
      'SHOPIFY_APP_PROXY_PATH_INVALID',
      'Shopify app-proxy path prefix was invalid',
      400,
    )
  }
  return value
}

export function verifyShopifyAppProxyRequest(input: {
  parameters: URLSearchParams
  clientSecret: string
  expectedShopDomain: string
  nowSeconds?: number
  maxAgeSeconds?: number
  futureSkewSeconds?: number
}): ShopifyAppProxyIdentity {
  const shopDomain = readShopifyAppProxyShopHint(input.parameters)
  const expectedShopDomain = String(input.expectedShopDomain || '')
    .trim()
    .toLowerCase()
  if (
    !SHOP_DOMAIN_PATTERN.test(expectedShopDomain)
    || expectedShopDomain !== shopDomain
  ) {
    fail(
      'SHOPIFY_APP_PROXY_SHOP_MISMATCH',
      'Shopify app-proxy shop did not match the connected account',
    )
  }

  const signature = singleton(input.parameters, 'signature')
  const canonicalQuery = canonicalizeShopifyAppProxyQuery(input.parameters)
  if (!signatureMatches(
    String(signature || ''),
    canonicalQuery,
    input.clientSecret,
  )) {
    fail(
      'SHOPIFY_APP_PROXY_SIGNATURE_INVALID',
      'Shopify app-proxy signature was invalid',
    )
  }

  const rawTimestamp = singleton(input.parameters, 'timestamp')
  if (!TIMESTAMP_PATTERN.test(String(rawTimestamp || ''))) {
    fail(
      'SHOPIFY_APP_PROXY_TIMESTAMP_INVALID',
      'Shopify app-proxy timestamp was invalid',
    )
  }
  const timestamp = Number(rawTimestamp)
  const nowSeconds = input.nowSeconds === undefined
    ? Math.floor(Date.now() / 1_000)
    : input.nowSeconds
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  const futureSkewSeconds =
    input.futureSkewSeconds ?? DEFAULT_FUTURE_SKEW_SECONDS
  if (
    !Number.isSafeInteger(nowSeconds)
    || !Number.isSafeInteger(maxAgeSeconds)
    || maxAgeSeconds < 1
    || maxAgeSeconds > 900
    || !Number.isSafeInteger(futureSkewSeconds)
    || futureSkewSeconds < 0
    || futureSkewSeconds > 120
    || timestamp < nowSeconds - maxAgeSeconds
    || timestamp > nowSeconds + futureSkewSeconds
  ) {
    fail(
      'SHOPIFY_APP_PROXY_TIMESTAMP_STALE',
      'Shopify app-proxy request was outside the accepted time window',
    )
  }

  const customerId = String(
    singleton(input.parameters, 'logged_in_customer_id') || '',
  )
  if (!CUSTOMER_ID_PATTERN.test(customerId)) {
    fail(
      'SHOPIFY_APP_PROXY_CUSTOMER_REQUIRED',
      'A logged-in Shopify customer is required',
      403,
    )
  }
  const cartFingerprint = String(
    singleton(input.parameters, 'cart_fingerprint') || '',
  )
  if (!CART_FINGERPRINT_PATTERN.test(cartFingerprint)) {
    fail(
      'SHOPIFY_APP_PROXY_CART_FINGERPRINT_INVALID',
      'Shopify app-proxy cart fingerprint was invalid',
      400,
    )
  }
  const rawCurrency = singleton(input.parameters, 'cart_currency', false)
  if (rawCurrency !== null && !CURRENCY_PATTERN.test(rawCurrency)) {
    fail(
      'SHOPIFY_APP_PROXY_CART_CURRENCY_INVALID',
      'Shopify app-proxy cart currency was invalid',
      400,
    )
  }

  return {
    shopDomain,
    customerId,
    timestamp,
    pathPrefix: normalizedPathPrefix(
      singleton(input.parameters, 'path_prefix', false),
    ),
    cartFingerprint,
    cartCurrency: rawCurrency?.toUpperCase() || null,
  }
}
