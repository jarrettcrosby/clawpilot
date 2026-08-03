import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]+$/
const TOKEN_SIGNATURE_LENGTH = 43
const TOKEN_MAX_LENGTH = 2_048
const ACTIVE_MAX_TTL_SECONDS = 15 * 60
const SHADOW_MAX_TTL_SECONDS = 60
const MAX_CLOCK_SKEW_SECONDS = 30

export const SHOPIFY_PRODUCT_MEDIA_SIGNING_SECRET_ENV =
  'SHOPIFY_PRODUCT_MEDIA_SIGNING_SECRET'

export type ShopifyProductMediaTokenMode = 'shadow' | 'active'

export type ShopifyProductMediaTokenPayload = {
  v: 1
  g: string
  o: string
  p: string
  a: string
  h: string
  m: ShopifyProductMediaTokenMode
  iat: number
  exp: number
}

export class ShopifyProductMediaTokenError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ShopifyProductMediaTokenError'
    this.code = code
    this.status = status
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new ShopifyProductMediaTokenError(code, message, status)
}

function exactObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype,
  )
}

function validatePayloadShape(
  value: unknown,
): ShopifyProductMediaTokenPayload {
  if (!exactObject(value)) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  const expected = ['a', 'exp', 'g', 'h', 'iat', 'm', 'o', 'p', 'v']
  if (
    Object.keys(value).sort().join(',') !== expected.join(',')
    || value.v !== 1
    || !UUID_PATTERN.test(String(value.g || '').toLowerCase())
    || !UUID_PATTERN.test(String(value.o || '').toLowerCase())
    || !UUID_PATTERN.test(String(value.p || '').toLowerCase())
    || !UUID_PATTERN.test(String(value.a || '').toLowerCase())
    || !SHA256_PATTERN.test(String(value.h || '').toLowerCase())
    || (value.m !== 'shadow' && value.m !== 'active')
    || !Number.isSafeInteger(value.iat)
    || !Number.isSafeInteger(value.exp)
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  const issuedAt = Number(value.iat)
  const expiresAt = Number(value.exp)
  const maximumTtl = value.m === 'active'
    ? ACTIVE_MAX_TTL_SECONDS
    : SHADOW_MAX_TTL_SECONDS
  if (
    issuedAt < 1
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > maximumTtl
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  return {
    v: 1,
    g: String(value.g).toLowerCase(),
    o: String(value.o).toLowerCase(),
    p: String(value.p).toLowerCase(),
    a: String(value.a).toLowerCase(),
    h: String(value.h).toLowerCase(),
    m: value.m,
    iat: issuedAt,
    exp: expiresAt,
  }
}

function strictBase64UrlDecode(value: string): Buffer {
  if (!value || !TOKEN_PART_PATTERN.test(value)) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64url')
  } catch {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  if (!decoded.length || decoded.toString('base64url') !== value) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  return decoded
}

export function resolveShopifyProductMediaSigningSecret(
  environment: NodeJS.ProcessEnv = process.env,
): Buffer {
  const raw = environment[SHOPIFY_PRODUCT_MEDIA_SIGNING_SECRET_ENV]
  if (
    typeof raw !== 'string'
    || raw !== raw.trim()
    || Buffer.byteLength(raw, 'utf8') < 32
    || Buffer.byteLength(raw, 'utf8') > 1_024
    || /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_SIGNING_SECRET_REQUIRED',
      `${SHOPIFY_PRODUCT_MEDIA_SIGNING_SECRET_ENV} must be configured with at least 32 bytes`,
      503,
    )
  }
  return Buffer.from(raw, 'utf8')
}

function signature(payloadPart: string, secret: Uint8Array) {
  return createHmac('sha256', secret)
    .update(payloadPart, 'ascii')
    .digest('base64url')
}

export function signShopifyProductMediaToken(
  input: ShopifyProductMediaTokenPayload,
  secret: Uint8Array,
): string {
  const payload = validatePayloadShape(input)
  const payloadPart = Buffer
    .from(JSON.stringify(payload), 'utf8')
    .toString('base64url')
  return `${payloadPart}.${signature(payloadPart, secret)}`
}

export function verifyShopifyProductMediaToken(
  rawToken: unknown,
  secret: Uint8Array,
  nowSeconds = Math.floor(Date.now() / 1_000),
): ShopifyProductMediaTokenPayload {
  const token = String(rawToken || '')
  if (
    !token
    || token.length > TOKEN_MAX_LENGTH
    || token.includes('/')
    || token.includes('\\')
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  const parts = token.split('.')
  if (
    parts.length !== 2
    || !TOKEN_PART_PATTERN.test(parts[0] || '')
    || !TOKEN_PART_PATTERN.test(parts[1] || '')
    || parts[1]?.length !== TOKEN_SIGNATURE_LENGTH
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  const expected = Buffer.from(signature(parts[0]!, secret), 'ascii')
  const supplied = Buffer.from(parts[1]!, 'ascii')
  if (
    expected.length !== supplied.length
    || !timingSafeEqual(expected, supplied)
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(strictBase64UrlDecode(parts[0]!).toString('utf8'))
  } catch (error) {
    if (error instanceof ShopifyProductMediaTokenError) throw error
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
      'Shopify product media token is invalid',
      404,
    )
  }
  const payload = validatePayloadShape(decoded)
  if (
    !Number.isSafeInteger(nowSeconds)
    || nowSeconds < 1
    || payload.iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS
    || payload.exp <= nowSeconds
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_EXPIRED',
      'Shopify product media token is unavailable',
      404,
    )
  }
  return payload
}

export function assertShopifyProductMediaTokenIsDeliverable(
  payload: ShopifyProductMediaTokenPayload,
): asserts payload is ShopifyProductMediaTokenPayload & { m: 'active' } {
  if (payload.m !== 'active') {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_NOT_DELIVERABLE',
      'Shopify product media token is unavailable',
      404,
    )
  }
}
