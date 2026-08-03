import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CRM_PRODUCT_IMAGE_MAX_BYTES,
  CrmProductImageAssetError,
  validateCrmProductImage,
} from '../../lib/crm/productImageAssets.ts'

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

const THREE_BY_TWO_JPEG = Uint8Array.from(Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIIAeC//2Q==',
  'base64',
))

const FOUR_BY_FIVE_WEBP = Uint8Array.from(Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvAwABAAdQlFKUp/+BiOh/AAA=',
  'base64',
))

const FOUR_BY_FIVE_LOSSY_WEBP = Uint8Array.from(Buffer.from(
  'UklGRjAAAABXRUJQVlA4ICQAAABQAQCdASoEAAUAAUAmJQBOgCgAAP76id+R2EN2HLri5shvAAA=',
  'base64',
))

function losslessWebpFixture(width: number, height: number) {
  const dimensionBits = (
    (width - 1)
    | ((height - 1) << 14)
  ) >>> 0
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46,
    0x12, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x4c,
    0x05, 0x00, 0x00, 0x00,
    0x2f,
    dimensionBits & 0xff,
    (dimensionBits >>> 8) & 0xff,
    (dimensionBits >>> 16) & 0xff,
    (dimensionBits >>> 24) & 0xff,
    0x00,
  ])
}

function hasCode(error: unknown, code: string) {
  return error instanceof CrmProductImageAssetError && error.code === code
}

test('validates PNG structure, dimensions, digest, and normalized alt text', () => {
  const image = validateCrmProductImage({
    bytes: ONE_PIXEL_PNG,
    declaredMimeType: 'image/png',
    altText: '  Front   of jar  ',
  })

  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.pixelWidth, 1)
  assert.equal(image.pixelHeight, 1)
  assert.equal(image.byteLength, ONE_PIXEL_PNG.byteLength)
  assert.equal(image.altText, 'Front of jar')
  assert.match(image.contentSha256, /^[0-9a-f]{64}$/)
})

test('parses bounded baseline JPEG dimensions through a complete scan', () => {
  const image = validateCrmProductImage({
    bytes: THREE_BY_TWO_JPEG,
    declaredMimeType: 'image/jpeg',
    altText: 'Package front',
  })

  assert.equal(image.mimeType, 'image/jpeg')
  assert.equal(image.pixelWidth, 3)
  assert.equal(image.pixelHeight, 2)
})

test('parses a lossless WebP frame and rejects oversized dimensions', () => {
  const image = validateCrmProductImage({
    bytes: FOUR_BY_FIVE_WEBP,
    declaredMimeType: 'image/webp',
    altText: 'Four by five product image',
  })

  assert.equal(image.mimeType, 'image/webp')
  assert.equal(image.pixelWidth, 4)
  assert.equal(image.pixelHeight, 5)

  const lossy = validateCrmProductImage({
    bytes: FOUR_BY_FIVE_LOSSY_WEBP,
    declaredMimeType: 'image/webp',
    altText: 'Lossy WebP product image',
  })
  assert.equal(lossy.pixelWidth, 4)
  assert.equal(lossy.pixelHeight, 5)

  const invalidRiffLength = Uint8Array.from(FOUR_BY_FIVE_WEBP)
  invalidRiffLength[4] = 0
  assert.throws(
    () => validateCrmProductImage({
      bytes: invalidRiffLength,
      declaredMimeType: 'image/webp',
      altText: 'Invalid RIFF length',
    }),
    (error: unknown) =>
      hasCode(error, 'CRM_PRODUCT_IMAGE_WEBP_INVALID'),
  )

  assert.throws(
    () => validateCrmProductImage({
      bytes: losslessWebpFixture(8192, 8192),
      declaredMimeType: 'image/webp',
      altText: 'Too many pixels',
    }),
    (error: unknown) =>
      hasCode(error, 'CRM_PRODUCT_IMAGE_DIMENSIONS_INVALID'),
  )
})

test('fails closed on MIME mismatch and unsupported magic bytes', () => {
  assert.throws(
    () => validateCrmProductImage({
      bytes: ONE_PIXEL_PNG,
      declaredMimeType: 'image/jpeg',
      altText: 'Wrong declared type',
    }),
    (error: unknown) =>
      hasCode(error, 'CRM_PRODUCT_IMAGE_MIME_MISMATCH'),
  )

  assert.throws(
    () => validateCrmProductImage({
      bytes: Uint8Array.from({ length: 64 }, (_, index) => index),
      declaredMimeType: 'image/png',
      altText: 'Not an image',
    }),
    (error: unknown) =>
      hasCode(error, 'CRM_PRODUCT_IMAGE_TYPE_INVALID'),
  )
})

test('rejects corrupt PNG chunks and incomplete JPEG evidence', () => {
  const corruptPng = Uint8Array.from(ONE_PIXEL_PNG)
  corruptPng[45] = corruptPng[45]! ^ 0x01
  assert.throws(
    () => validateCrmProductImage({
      bytes: corruptPng,
      declaredMimeType: 'image/png',
      altText: 'Corrupt PNG',
    }),
    (error: unknown) =>
      hasCode(error, 'CRM_PRODUCT_IMAGE_PNG_INVALID'),
  )

  const incompleteJpeg = THREE_BY_TWO_JPEG.subarray(0, -2)
  assert.throws(
    () => validateCrmProductImage({
      bytes: incompleteJpeg,
      declaredMimeType: 'image/jpeg',
      altText: 'Incomplete JPEG',
    }),
    (error: unknown) =>
      hasCode(error, 'CRM_PRODUCT_IMAGE_JPEG_INVALID'),
  )
})

test('enforces byte and alt-text bounds before persistence', () => {
  assert.throws(
    () => validateCrmProductImage({
      bytes: new Uint8Array(CRM_PRODUCT_IMAGE_MAX_BYTES + 1),
      declaredMimeType: 'image/png',
      altText: 'Too large',
    }),
    (error: unknown) =>
      hasCode(error, 'CRM_PRODUCT_IMAGE_SIZE_INVALID'),
  )

  assert.throws(
    () => validateCrmProductImage({
      bytes: ONE_PIXEL_PNG,
      declaredMimeType: 'image/png',
      altText: 'x'.repeat(501),
    }),
    (error: unknown) =>
      hasCode(error, 'CRM_PRODUCT_IMAGE_ALT_TEXT_INVALID'),
  )
})
