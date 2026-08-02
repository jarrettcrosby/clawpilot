import { globalIdPattern } from '../globalIds.mjs'

const PRODUCT_REFERENCE_PATTERN = globalIdPattern('gp')
const CONTENT_SHA256_PATTERN = /^[0-9a-f]{64}$/
const SUITECRM_PRODUCT_IMAGE_MAX_URL_LENGTH = 255

function exactPublicOrigin(value: unknown) {
  const raw = String(value || '').trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Product image public origin is invalid')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('Product image public origin is invalid')
  }
  return url.origin
}

export function publicCrmProductImageUrl(input: {
  publicOrigin: unknown
  productReferenceCode: unknown
  contentSha256: unknown
}) {
  const publicOrigin = exactPublicOrigin(input.publicOrigin)
  const productReferenceCode = String(input.productReferenceCode || '')
    .trim()
    .toLowerCase()
  const contentSha256 = String(input.contentSha256 || '')
    .trim()
    .toLowerCase()
  if (!PRODUCT_REFERENCE_PATTERN.test(productReferenceCode)) {
    throw new Error('Product image Product reference is invalid')
  }
  if (!CONTENT_SHA256_PATTERN.test(contentSha256)) {
    throw new Error('Product image content identity is invalid')
  }
  const result = `${publicOrigin}/api/public/crm-product-images/${
    encodeURIComponent(productReferenceCode)
  }/${contentSha256}`
  if (result.length > SUITECRM_PRODUCT_IMAGE_MAX_URL_LENGTH) {
    throw new Error('Product image public URL exceeds SuiteCRM limits')
  }
  return result
}

export const CRM_PRODUCT_IMAGE_PUBLIC_CONTENT_SHA256_PATTERN =
  CONTENT_SHA256_PATTERN
export const CRM_PRODUCT_IMAGE_PUBLIC_REFERENCE_PATTERN =
  PRODUCT_REFERENCE_PATTERN
