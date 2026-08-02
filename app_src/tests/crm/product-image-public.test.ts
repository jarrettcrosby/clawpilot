import assert from 'node:assert/strict'
import test from 'node:test'
import {
  publicCrmProductImageUrl,
} from '../../lib/crm/productImagePublic.ts'

const LEGACY_PRODUCT_REFERENCE = 'gp4513844'
const COMPACT_PRODUCT_REFERENCE = 'gp0123456789av'
const CONTENT_SHA256 = 'a'.repeat(64)

test('builds an exact immutable public Product image URL', () => {
  assert.equal(
    publicCrmProductImageUrl({
      publicOrigin: 'https://clawpilot.example',
      productReferenceCode: LEGACY_PRODUCT_REFERENCE,
      contentSha256: CONTENT_SHA256,
    }),
    `https://clawpilot.example/api/public/crm-product-images/${
      LEGACY_PRODUCT_REFERENCE
    }/${CONTENT_SHA256}`,
  )
  assert.equal(
    publicCrmProductImageUrl({
      publicOrigin: 'http://localhost:4002',
      productReferenceCode: ` ${COMPACT_PRODUCT_REFERENCE.toUpperCase()} `,
      contentSha256: ` ${CONTENT_SHA256.toUpperCase()} `,
    }),
    `http://localhost:4002/api/public/crm-product-images/${
      COMPACT_PRODUCT_REFERENCE
    }/${CONTENT_SHA256}`,
  )
})

test('rejects unsafe origins and invalid immutable identities', () => {
  for (const publicOrigin of [
    'http://clawpilot.example',
    'https://user:pass@clawpilot.example',
    'https://clawpilot.example/path',
    'https://clawpilot.example/?query=1',
    'not-a-url',
  ]) {
    assert.throws(() => publicCrmProductImageUrl({
      publicOrigin,
      productReferenceCode: LEGACY_PRODUCT_REFERENCE,
      contentSha256: CONTENT_SHA256,
    }), /public origin is invalid/)
  }
  assert.throws(() => publicCrmProductImageUrl({
    publicOrigin: 'https://clawpilot.example',
    productReferenceCode: 'gia0000001',
    contentSha256: CONTENT_SHA256,
  }), /Product reference is invalid/)
  assert.throws(() => publicCrmProductImageUrl({
    publicOrigin: 'https://clawpilot.example',
    productReferenceCode: LEGACY_PRODUCT_REFERENCE,
    contentSha256: 'f'.repeat(63),
  }), /content identity is invalid/)
})
