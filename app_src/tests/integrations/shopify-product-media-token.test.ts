import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertShopifyProductMediaTokenIsDeliverable,
  resolveShopifyProductMediaSigningSecret,
  ShopifyProductMediaTokenError,
  signShopifyProductMediaToken,
  verifyShopifyProductMediaToken,
  type ShopifyProductMediaTokenPayload,
} from '../../lib/integrations/shopifyProductMediaTokens.ts'

const secret = Buffer.from(
  'test-only-shopify-product-media-signing-secret-0001',
  'utf8',
)
const payload: ShopifyProductMediaTokenPayload = {
  v: 1,
  g: '11111111-1111-4111-8111-111111111111',
  o: '22222222-2222-4222-8222-222222222222',
  p: '33333333-3333-4333-8333-333333333333',
  a: '44444444-4444-4444-8444-444444444444',
  h: 'a'.repeat(64),
  m: 'active',
  iat: 1_785_400_000,
  exp: 1_785_400_900,
}

function hasCode(error: unknown, code: string) {
  return error instanceof ShopifyProductMediaTokenError
    && error.code === code
}

test('signs and verifies exact active tenant, product, asset, hash, and expiry facts', () => {
  const token = signShopifyProductMediaToken(payload, secret)
  const verified = verifyShopifyProductMediaToken(
    token,
    secret,
    payload.iat + 30,
  )

  assert.deepEqual(verified, payload)
  assert.doesNotThrow(() => (
    assertShopifyProductMediaTokenIsDeliverable(verified)
  ))
  assert.equal(token.includes('/'), false)
  assert.equal(token.includes('\\'), false)
})

test('fails closed on payload, signature, path, extra-field, and expiry tampering', () => {
  const token = signShopifyProductMediaToken(payload, secret)
  const [encoded, signature] = token.split('.')
  const changeLast = (value: string) => (
    `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`
  )
  assert.throws(
    () => verifyShopifyProductMediaToken(
      `${changeLast(encoded!)}.${signature}`,
      secret,
      payload.iat,
    ),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
    ),
  )
  assert.throws(
    () => verifyShopifyProductMediaToken(
      `${encoded}.${changeLast(signature!)}`,
      secret,
      payload.iat,
    ),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
    ),
  )
  assert.throws(
    () => verifyShopifyProductMediaToken(
      `../${token}`,
      secret,
      payload.iat,
    ),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
    ),
  )
  assert.throws(
    () => signShopifyProductMediaToken({
      ...payload,
      account: 'gia0000001',
    } as ShopifyProductMediaTokenPayload, secret),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
    ),
  )
  const extraPayload = Buffer.from(JSON.stringify({
    ...payload,
    account: 'gia0000001',
  })).toString('base64url')
  assert.throws(
    () => verifyShopifyProductMediaToken(
      `${extraPayload}.${signature}`,
      secret,
      payload.iat,
    ),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
    ),
  )
  assert.throws(
    () => verifyShopifyProductMediaToken(
      token,
      secret,
      payload.exp,
    ),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_EXPIRED',
    ),
  )
})

test('shadow evidence tokens are bounded and never publicly deliverable', () => {
  const shadow = {
    ...payload,
    m: 'shadow' as const,
    exp: payload.iat + 60,
  }
  const verified = verifyShopifyProductMediaToken(
    signShopifyProductMediaToken(shadow, secret),
    secret,
    shadow.iat,
  )
  assert.throws(
    () => assertShopifyProductMediaTokenIsDeliverable(verified),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_NOT_DELIVERABLE',
    ),
  )
  assert.throws(
    () => signShopifyProductMediaToken({
      ...shadow,
      exp: shadow.iat + 61,
    }, secret),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_TOKEN_INVALID',
    ),
  )
})

test('requires a nontrivial server-only signing secret', () => {
  assert.throws(
    () => resolveShopifyProductMediaSigningSecret({}),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_SIGNING_SECRET_REQUIRED',
    ),
  )
  assert.throws(
    () => resolveShopifyProductMediaSigningSecret({
      SHOPIFY_PRODUCT_MEDIA_SIGNING_SECRET: 'too-short',
    }),
    (error: unknown) => hasCode(
      error,
      'SHOPIFY_PRODUCT_MEDIA_SIGNING_SECRET_REQUIRED',
    ),
  )
  assert.equal(
    resolveShopifyProductMediaSigningSecret({
      SHOPIFY_PRODUCT_MEDIA_SIGNING_SECRET:
        'configured-shopify-media-signing-secret-1234',
    }).length,
    44,
  )
})
