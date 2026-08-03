import { createHash } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import type { IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import sharp from 'sharp'
import {
  CRM_PRODUCT_IMAGE_MAX_BYTES,
  CRM_PRODUCT_IMAGE_MAX_DIMENSION,
  CRM_PRODUCT_IMAGE_MAX_PIXELS,
  CrmProductImageAssetError,
  validateCrmProductImage,
  type CrmProductImageMimeType,
} from '@/lib/crm/productImageAssets'

export const COMMERCE_PROVIDER_IMAGE_FETCH_TIMEOUT_MS = 15_000
export const COMMERCE_PROVIDER_IMAGE_MAX_REDIRECTS = 3
export const COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES = 16 * 1024 * 1024

const IDENTITY_NORMALIZATION_VERSION = 'identity-v1'
const WEBP_NORMALIZATION_VERSION =
  'sharp-0.35.3-webp-auto-orient-v1'
const WEBP_QUALITY_LADDER = Object.freeze([82, 72, 62, 52, 42, 32])

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SUPPORTED_MEDIA_TYPES = new Set<CrmProductImageMimeType>([
  'image/png',
  'image/jpeg',
  'image/webp',
])
const REQUEST_HEADERS = Object.freeze({
  Accept: 'image/png, image/jpeg, image/webp',
  'User-Agent': 'ClawPilot-Commerce-Image/1.0',
})

export type CommerceProviderImageFetchErrorCode =
  | 'COMMERCE_PROVIDER_IMAGE_URL_INVALID'
  | 'COMMERCE_PROVIDER_IMAGE_HTTPS_REQUIRED'
  | 'COMMERCE_PROVIDER_IMAGE_CREDENTIALS_FORBIDDEN'
  | 'COMMERCE_PROVIDER_IMAGE_HOST_FORBIDDEN'
  | 'COMMERCE_PROVIDER_IMAGE_DNS_FAILED'
  | 'COMMERCE_PROVIDER_IMAGE_DNS_EMPTY'
  | 'COMMERCE_PROVIDER_IMAGE_DNS_UNSAFE'
  | 'COMMERCE_PROVIDER_IMAGE_DNS_MIXED'
  | 'COMMERCE_PROVIDER_IMAGE_REDIRECT_INVALID'
  | 'COMMERCE_PROVIDER_IMAGE_REDIRECT_LIMIT'
  | 'COMMERCE_PROVIDER_IMAGE_FETCH_FAILED'
  | 'COMMERCE_PROVIDER_IMAGE_TIMEOUT'
  | 'COMMERCE_PROVIDER_IMAGE_ABORTED'
  | 'COMMERCE_PROVIDER_IMAGE_STATUS_INVALID'
  | 'COMMERCE_PROVIDER_IMAGE_CONTENT_LENGTH_INVALID'
  | 'COMMERCE_PROVIDER_IMAGE_SIZE_INVALID'
  | 'COMMERCE_PROVIDER_IMAGE_MIME_UNSUPPORTED'
  | 'COMMERCE_PROVIDER_IMAGE_MIME_MISMATCH'
  | 'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID'
  | 'COMMERCE_PROVIDER_IMAGE_DIMENSIONS_INVALID'

export class CommerceProviderImageFetchError extends Error {
  readonly code: CommerceProviderImageFetchErrorCode
  readonly status: number

  constructor(
    code: CommerceProviderImageFetchErrorCode,
    message: string,
    status = 400,
  ) {
    super(message)
    this.name = 'CommerceProviderImageFetchError'
    this.code = code
    this.status = status
  }
}

export type CommerceProviderImageDnsAnswer = {
  address: string
  family: 4 | 6
}

export type CommerceProviderImageHttpResponse = {
  status: number
  headers: {
    get(name: string): string | null
  }
  body: AsyncIterable<Uint8Array> | null
  cancel?: () => void
}

export type CommerceProviderImagePinnedRequest = {
  url: URL
  address: CommerceProviderImageDnsAnswer
  headers: Readonly<Record<string, string>>
  signal: AbortSignal
}

export type CommerceProviderImageFetchDependencies = {
  createResolver?: () => CommerceProviderImageDnsResolver
  lookup?: (
    hostname: string,
    input: { signal: AbortSignal },
  ) => Promise<CommerceProviderImageDnsAnswer[]>
  fetch?: (
    input: CommerceProviderImagePinnedRequest,
  ) => Promise<CommerceProviderImageHttpResponse>
  now?: () => number
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown
  clearScheduledTimeout?: (handle: unknown) => void
}

export type CommerceProviderImageDnsResolver = {
  cancel(): void
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
}

export type ValidatedCommerceProviderImage = {
  bytes: Uint8Array
  byteLength: number
  contentSha256: string
  mediaType: CrmProductImageMimeType
  normalizationVersion: string
  pixelWidth: number
  pixelHeight: number
  sourceByteLength: number
  sourceContentSha256: string
}

class FetchAborted extends Error {}

function fail(
  code: CommerceProviderImageFetchErrorCode,
  message: string,
  status = 400,
): never {
  throw new CommerceProviderImageFetchError(code, message, status)
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return Number.NaN
    return Number(part)
  })
  return octets.every((octet) => Number.isInteger(octet) && octet <= 255)
    ? octets
    : null
}

function publicIpv4Address(address: string): boolean {
  const octets = ipv4Octets(address)
  if (!octets) return false
  const [a, b, c] = octets
  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a! >= 224
  )
}

function ipv6Bytes(address: string): Uint8Array | null {
  let normalized = address.toLowerCase()
  const zoneIndex = normalized.indexOf('%')
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex)
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':')
    const embedded = ipv4Octets(normalized.slice(separator + 1))
    if (separator < 0 || !embedded) return null
    normalized = `${normalized.slice(0, separator)}:${
      ((embedded[0]! << 8) | embedded[1]!).toString(16)
    }:${((embedded[2]! << 8) | embedded[3]!).toString(16)}`
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const parseHalf = (value: string) => (
    value
      ? value.split(':').map((part) => (
          /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : -1
        ))
      : []
  )
  const left = parseHalf(halves[0] || '')
  const right = parseHalf(halves[1] || '')
  if ([...left, ...right].some((part) => part < 0)) return null
  const compressed = halves.length === 2
  if (!compressed && left.length !== 8) return null
  if (compressed && left.length + right.length > 7) return null
  const words = compressed
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left
  if (words.length !== 8) return null
  const bytes = new Uint8Array(16)
  words.forEach((word, index) => {
    bytes[index * 2] = (word >>> 8) & 0xff
    bytes[(index * 2) + 1] = word & 0xff
  })
  return bytes
}

function publicIpv6Address(address: string): boolean {
  const bytes = ipv6Bytes(address)
  if (!bytes) return false
  // Current native global-unicast allocations are within 2000::/3. Requiring
  // that range rejects loopback, mapped IPv4, ULA, link-local, site-local,
  // multicast, discard-only, and other reserved ranges by default.
  if (bytes[0]! < 0x20 || bytes[0]! > 0x3f) return false
  // Reject special-use space within global unicast: 2001:0000::/23 (Teredo,
  // benchmarking, ORCHID), 2001:db8::/32 documentation, 2002::/16 6to4, and
  // 3fff::/20 documentation.
  if (
    bytes[0] === 0x20
    && bytes[1] === 0x01
    && (
      bytes[2]! < 0x02
      || (bytes[2] === 0x0d && bytes[3] === 0xb8)
    )
  ) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false
  if (
    bytes[0] === 0x3f
    && bytes[1] === 0xff
    && (bytes[2]! & 0xf0) === 0
  ) return false
  return true
}

function publicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  const family = isIP(normalized)
  if (family === 4) return publicIpv4Address(normalized)
  if (family === 6) return publicIpv6Address(normalized)
  return false
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function validateUrl(value: string): { url: URL; hostname: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(
      'COMMERCE_PROVIDER_IMAGE_URL_INVALID',
      'Provider image URL is invalid',
    )
  }
  if (url.protocol !== 'https:') {
    fail(
      'COMMERCE_PROVIDER_IMAGE_HTTPS_REQUIRED',
      'Provider images must use HTTPS',
    )
  }
  if (url.username || url.password) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_CREDENTIALS_FORBIDDEN',
      'Provider image URLs must not contain embedded credentials',
    )
  }
  const hostname = normalizedHostname(url)
  const reservedName = (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home')
    || hostname.endsWith('.lan')
    || hostname.endsWith('.test')
    || hostname.endsWith('.invalid')
    || hostname.endsWith('.example')
    || hostname.endsWith('.onion')
  )
  if (!hostname || reservedName) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_HOST_FORBIDDEN',
      'Provider image host is not public',
    )
  }
  return { url, hostname }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) throw new FetchAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      cleanup()
      reject(new FetchAborted())
    }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

const EMPTY_DNS_ERROR_CODES = new Set([
  'EAI_NODATA',
  'EAI_NONAME',
  'ENODATA',
  'ENOTFOUND',
])

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return ''
  return typeof error.code === 'string' ? error.code : ''
}

async function resolveDnsFamily(promise: Promise<string[]>) {
  try {
    return await promise
  } catch (error) {
    if (EMPTY_DNS_ERROR_CODES.has(errorCode(error))) return []
    throw error
  }
}

async function defaultLookup(
  hostname: string,
  input: { signal: AbortSignal },
  createResolver: () => CommerceProviderImageDnsResolver,
) {
  if (input.signal.aborted) throw new FetchAborted()
  const resolver = createResolver()
  const cancel = () => {
    try {
      resolver.cancel()
    } catch {
      // Cancellation is best effort and must never expose resolver details.
    }
  }
  input.signal.addEventListener('abort', cancel, { once: true })
  try {
    const [ipv6, ipv4] = await Promise.all([
      resolveDnsFamily(resolver.resolve6(hostname)),
      resolveDnsFamily(resolver.resolve4(hostname)),
    ])
    if (input.signal.aborted) throw new FetchAborted()
    return [
      ...ipv6.map((address) => ({ address, family: 6 as const })),
      ...ipv4.map((address) => ({ address, family: 4 as const })),
    ]
  } catch (error) {
    if (input.signal.aborted || errorCode(error) === 'ECANCELLED') {
      throw new FetchAborted()
    }
    cancel()
    throw error
  } finally {
    input.signal.removeEventListener('abort', cancel)
  }
}

function pinnedLookup(address: CommerceProviderImageDnsAnswer) {
  return ((
    _hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ) => {
    if (options && typeof options === 'object' && 'all' in options && options.all) {
      callback(null, [{ address: address.address, family: address.family }])
      return
    }
    callback(null, address.address, address.family)
  }) as unknown as LookupFunction
}

function incomingHeader(response: IncomingMessage, name: string) {
  const value = response.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] || null : value || null
}

function defaultPinnedFetch(
  input: CommerceProviderImagePinnedRequest,
): Promise<CommerceProviderImageHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      input.url,
      {
        method: 'GET',
        headers: {
          ...input.headers,
          Host: input.url.host,
        },
        lookup: pinnedLookup(input.address),
        agent: false,
        servername: isIP(normalizedHostname(input.url))
          ? ''
          : input.url.hostname,
        signal: input.signal,
      },
      (response) => resolve({
        status: response.statusCode || 0,
        headers: {
          get: (name) => incomingHeader(response, name),
        },
        body: response,
        cancel: () => response.destroy(),
      }),
    )
    request.on('error', reject)
    request.end()
  })
}

function cancelResponse(response: CommerceProviderImageHttpResponse) {
  try {
    response.cancel?.()
  } catch {
    // Cancellation is best effort; never surface transport detail or a URL.
  }
}

async function resolvePinnedAddress(
  hostname: string,
  dependencies: Required<Pick<CommerceProviderImageFetchDependencies, 'lookup'>>,
  signal: AbortSignal,
) {
  const literalFamily = isIP(hostname)
  if (literalFamily) {
    if (!publicIpAddress(hostname)) {
      fail(
        'COMMERCE_PROVIDER_IMAGE_DNS_UNSAFE',
        'Provider image host resolves to a non-public address',
      )
    }
    return { address: hostname, family: literalFamily as 4 | 6 }
  }
  let answers: CommerceProviderImageDnsAnswer[]
  try {
    answers = await abortable(
      dependencies.lookup(hostname, { signal }),
      signal,
    )
  } catch (error) {
    if (error instanceof FetchAborted) throw error
    fail(
      'COMMERCE_PROVIDER_IMAGE_DNS_FAILED',
      'Provider image host could not be resolved',
      502,
    )
  }
  if (answers.length === 0) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_DNS_EMPTY',
      'Provider image host did not resolve to an address',
      502,
    )
  }
  const classified = answers.map((answer) => ({
    answer,
    validFamily: isIP(answer.address) === answer.family,
    public: publicIpAddress(answer.address),
  }))
  const publicCount = classified.filter((entry) => (
    entry.validFamily && entry.public
  )).length
  if (publicCount > 0 && publicCount < classified.length) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_DNS_MIXED',
      'Provider image host returned mixed public and non-public addresses',
    )
  }
  if (publicCount !== classified.length) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_DNS_UNSAFE',
      'Provider image host resolves to a non-public address',
    )
  }
  // Railway can resolve both families while its outbound network supports
  // IPv4 only. Keep validating the complete answer set before preferring a
  // public IPv4 address, and retain IPv6 for hosts that have no IPv4 answer.
  return (
    classified.find((entry) => entry.answer.family === 4)
    || classified[0]!
  ).answer
}

function normalizedContentType(response: CommerceProviderImageHttpResponse) {
  const raw = response.headers.get('content-type')
  const mediaType = String(raw || '').split(';', 1)[0]!.trim().toLowerCase()
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType as CrmProductImageMimeType)) {
    cancelResponse(response)
    fail(
      'COMMERCE_PROVIDER_IMAGE_MIME_UNSUPPORTED',
      'Provider image response must be PNG, JPEG, or WebP',
      415,
    )
  }
  return mediaType as CrmProductImageMimeType
}

function declaredContentLength(response: CommerceProviderImageHttpResponse) {
  const raw = response.headers.get('content-length')
  if (raw === null) return null
  const value = raw.trim()
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    cancelResponse(response)
    fail(
      'COMMERCE_PROVIDER_IMAGE_CONTENT_LENGTH_INVALID',
      'Provider image response has an invalid content length',
      502,
    )
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length)) {
    cancelResponse(response)
    fail(
      'COMMERCE_PROVIDER_IMAGE_CONTENT_LENGTH_INVALID',
      'Provider image response has an invalid content length',
      502,
    )
  }
  if (length > COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES) {
    cancelResponse(response)
    fail(
      'COMMERCE_PROVIDER_IMAGE_SIZE_INVALID',
      `Provider image sources must be no larger than ${COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES} bytes`,
      413,
    )
  }
  return length
}

async function readBoundedImage(
  response: CommerceProviderImageHttpResponse,
  signal: AbortSignal,
) {
  const declaredLength = declaredContentLength(response)
  if (!response.body) {
    cancelResponse(response)
    fail(
      'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
      'Provider image response did not contain valid image bytes',
      422,
    )
  }
  const bytes = new Uint8Array(COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES)
  let byteLength = 0
  const iterator = response.body[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await abortable(iterator.next(), signal)
      if (next.done) break
      const chunk = next.value
      if (signal.aborted) throw new FetchAborted()
      if (!(chunk instanceof Uint8Array)) {
        cancelResponse(response)
        fail(
          'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
          'Provider image response did not contain valid image bytes',
          422,
        )
      }
      if (chunk.byteLength === 0) {
        cancelResponse(response)
        fail(
          'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
          'Provider image response did not contain valid image bytes',
          422,
        )
      }
      if (
        chunk.byteLength
          > COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES - byteLength
      ) {
        cancelResponse(response)
        fail(
          'COMMERCE_PROVIDER_IMAGE_SIZE_INVALID',
          `Provider image sources must be no larger than ${COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES} bytes`,
          413,
        )
      }
      bytes.set(chunk, byteLength)
      byteLength += chunk.byteLength
    }
  } catch (error) {
    cancelResponse(response)
    // Do not await iterator cleanup: a hostile stream can leave `next()`
    // pending forever even after transport cancellation.
    void iterator.return?.().catch(() => undefined)
    if (
      error instanceof FetchAborted
      || error instanceof CommerceProviderImageFetchError
    ) throw error
    fail(
      'COMMERCE_PROVIDER_IMAGE_FETCH_FAILED',
      'Provider image could not be fetched',
      502,
    )
  }
  if (declaredLength !== null && declaredLength !== byteLength) {
    cancelResponse(response)
    fail(
      'COMMERCE_PROVIDER_IMAGE_CONTENT_LENGTH_INVALID',
      'Provider image response has an invalid content length',
      502,
    )
  }
  return bytes.subarray(0, byteLength)
}

const SHARP_FORMAT_BY_MIME_TYPE: Readonly<
  Record<CrmProductImageMimeType, 'jpeg' | 'png' | 'webp'>
> = Object.freeze({
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
})

async function validateDecodedImage(
  image: ValidatedCommerceProviderImage,
  signal: AbortSignal,
) {
  const decoder = sharp(
    Buffer.from(
      image.bytes.buffer as ArrayBuffer,
      image.bytes.byteOffset,
      image.bytes.byteLength,
    ),
    {
      failOn: 'warning',
      limitInputPixels: CRM_PRODUCT_IMAGE_MAX_PIXELS,
      sequentialRead: true,
    },
  )
  const cancel = () => decoder.destroy()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const metadata = await abortable(decoder.metadata(), signal)
    if (
      metadata.format !== SHARP_FORMAT_BY_MIME_TYPE[image.mediaType]
      || metadata.width !== image.pixelWidth
      || metadata.height !== image.pixelHeight
      || (metadata.pages ?? 1) !== 1
    ) {
      fail(
        'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
        'Provider image response did not contain valid image bytes',
        422,
      )
    }
    // `metadata()` validates headers only. `stats()` forces libvips to decode
    // every pixel while the constructor-enforced pixel limit remains active.
    await abortable(decoder.stats(), signal)
  } catch (error) {
    if (
      error instanceof FetchAborted
      || error instanceof CommerceProviderImageFetchError
    ) throw error
    if (signal.aborted) throw new FetchAborted()
    fail(
      'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
      'Provider image response did not contain valid image bytes',
      422,
    )
  } finally {
    signal.removeEventListener('abort', cancel)
    decoder.destroy()
  }
}

async function inspectOversizedSource(
  bytes: Uint8Array,
  mediaType: CrmProductImageMimeType,
  signal: AbortSignal,
) {
  const source = Buffer.from(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  )
  const metadataDecoder = sharp(source, {
    failOn: 'warning',
    limitInputPixels: false,
    sequentialRead: true,
  })
  const cancelMetadata = () => metadataDecoder.destroy()
  signal.addEventListener('abort', cancelMetadata, { once: true })
  let pixelWidth = 0
  let pixelHeight = 0
  try {
    const metadata = await abortable(metadataDecoder.metadata(), signal)
    if (metadata.format !== SHARP_FORMAT_BY_MIME_TYPE[mediaType]) {
      fail(
        'COMMERCE_PROVIDER_IMAGE_MIME_MISMATCH',
        'Provider image MIME type does not match its file content',
        415,
      )
    }
    if ((metadata.pages ?? 1) !== 1) {
      fail(
        'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
        'Provider image response did not contain valid image bytes',
        422,
      )
    }
    pixelWidth = Number(metadata.autoOrient?.width ?? metadata.width)
    pixelHeight = Number(metadata.autoOrient?.height ?? metadata.height)
    if (
      !Number.isSafeInteger(pixelWidth)
      || !Number.isSafeInteger(pixelHeight)
      || pixelWidth < 1
      || pixelHeight < 1
      || pixelWidth > CRM_PRODUCT_IMAGE_MAX_DIMENSION
      || pixelHeight > CRM_PRODUCT_IMAGE_MAX_DIMENSION
      || pixelWidth * pixelHeight > CRM_PRODUCT_IMAGE_MAX_PIXELS
    ) {
      fail(
        'COMMERCE_PROVIDER_IMAGE_DIMENSIONS_INVALID',
        'Provider image dimensions exceed the supported limit',
        422,
      )
    }
  } catch (error) {
    if (
      error instanceof FetchAborted
      || error instanceof CommerceProviderImageFetchError
    ) throw error
    if (signal.aborted) throw new FetchAborted()
    fail(
      'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
      'Provider image response did not contain valid image bytes',
      422,
    )
  } finally {
    signal.removeEventListener('abort', cancelMetadata)
    metadataDecoder.destroy()
  }

  const decoder = sharp(source, {
    failOn: 'warning',
    limitInputPixels: CRM_PRODUCT_IMAGE_MAX_PIXELS,
    sequentialRead: true,
  })
  const cancelDecode = () => decoder.destroy()
  signal.addEventListener('abort', cancelDecode, { once: true })
  try {
    await abortable(decoder.stats(), signal)
  } catch (error) {
    if (
      error instanceof FetchAborted
      || error instanceof CommerceProviderImageFetchError
    ) throw error
    if (signal.aborted) throw new FetchAborted()
    fail(
      'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
      'Provider image response did not contain valid image bytes',
      422,
    )
  } finally {
    signal.removeEventListener('abort', cancelDecode)
    decoder.destroy()
  }
  return { pixelWidth, pixelHeight }
}

async function normalizeOversizedSource(
  bytes: Uint8Array,
  signal: AbortSignal,
) {
  const source = Buffer.from(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  )
  for (const quality of WEBP_QUALITY_LADDER) {
    const encoder = sharp(source, {
      failOn: 'warning',
      limitInputPixels: CRM_PRODUCT_IMAGE_MAX_PIXELS,
      sequentialRead: true,
    }).autoOrient().webp({
      alphaQuality: 100,
      effort: 4,
      quality,
      smartSubsample: true,
    })
    const cancel = () => encoder.destroy()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const normalized = await abortable(encoder.toBuffer(), signal)
      if (normalized.byteLength <= CRM_PRODUCT_IMAGE_MAX_BYTES) {
        return {
          bytes: Uint8Array.from(normalized),
          normalizationVersion: `${WEBP_NORMALIZATION_VERSION}-q${quality}`,
        }
      }
    } catch (error) {
      if (
        error instanceof FetchAborted
        || error instanceof CommerceProviderImageFetchError
      ) throw error
      if (signal.aborted) throw new FetchAborted()
      fail(
        'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
        'Provider image response did not contain valid image bytes',
        422,
      )
    } finally {
      signal.removeEventListener('abort', cancel)
      encoder.destroy()
    }
  }
  fail(
    'COMMERCE_PROVIDER_IMAGE_SIZE_INVALID',
    `Provider image could not be normalized below ${CRM_PRODUCT_IMAGE_MAX_BYTES} bytes`,
    413,
  )
}

function validationFailure(error: CrmProductImageAssetError): never {
  if (error.code === 'CRM_PRODUCT_IMAGE_SIZE_INVALID') {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SIZE_INVALID',
      `Provider images must be no larger than ${CRM_PRODUCT_IMAGE_MAX_BYTES} bytes`,
      413,
    )
  }
  if (error.code === 'CRM_PRODUCT_IMAGE_MIME_MISMATCH') {
    fail(
      'COMMERCE_PROVIDER_IMAGE_MIME_MISMATCH',
      'Provider image MIME type does not match its file content',
      415,
    )
  }
  if (error.code === 'CRM_PRODUCT_IMAGE_DIMENSIONS_INVALID') {
    fail(
      'COMMERCE_PROVIDER_IMAGE_DIMENSIONS_INVALID',
      'Provider image dimensions exceed the supported limit',
      422,
    )
  }
  fail(
    'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
    'Provider image response did not contain valid image bytes',
    422,
  )
}

export async function fetchCommerceProviderImage(
  input: {
    url: string
    timeoutMs?: number
    signal?: AbortSignal
  },
  injected: CommerceProviderImageFetchDependencies = {},
): Promise<ValidatedCommerceProviderImage> {
  const timeoutMs = input.timeoutMs
    ?? COMMERCE_PROVIDER_IMAGE_FETCH_TIMEOUT_MS
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 60_000
  ) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_URL_INVALID',
      'Provider image fetch timeout is invalid',
    )
  }
  const createResolver = injected.createResolver
    || (() => new Resolver())
  const dependencies = {
    lookup: injected.lookup || ((hostname, input) => (
      defaultLookup(hostname, input, createResolver)
    )),
    fetch: injected.fetch || defaultPinnedFetch,
    now: injected.now || Date.now,
    scheduleTimeout: injected.scheduleTimeout
      || ((callback: () => void, delayMs: number) => (
        setTimeout(callback, delayMs)
      )),
    clearScheduledTimeout: injected.clearScheduledTimeout
      || ((handle: unknown) => clearTimeout(
        handle as ReturnType<typeof setTimeout>,
      )),
  }
  const controller = new AbortController()
  let timedOut = false
  const startedAt = dependencies.now()
  const onCallerAbort = () => controller.abort()
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timeoutHandle = dependencies.scheduleTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let currentUrl = input.url
    for (
      let redirectCount = 0;
      redirectCount <= COMMERCE_PROVIDER_IMAGE_MAX_REDIRECTS;
      redirectCount += 1
    ) {
      if (
        dependencies.now() - startedAt >= timeoutMs
      ) {
        timedOut = true
        controller.abort()
        throw new FetchAborted()
      }
      if (controller.signal.aborted) throw new FetchAborted()
      const validatedUrl = validateUrl(currentUrl)
      const address = await resolvePinnedAddress(
        validatedUrl.hostname,
        { lookup: dependencies.lookup },
        controller.signal,
      )
      let response: CommerceProviderImageHttpResponse
      try {
        response = await abortable(
          dependencies.fetch({
            url: new URL(validatedUrl.url.toString()),
            address,
            headers: REQUEST_HEADERS,
            signal: controller.signal,
          }),
          controller.signal,
        )
      } catch (error) {
        if (error instanceof FetchAborted) throw error
        if (error instanceof CommerceProviderImageFetchError) throw error
        fail(
          'COMMERCE_PROVIDER_IMAGE_FETCH_FAILED',
          'Provider image could not be fetched',
          502,
        )
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        cancelResponse(response)
        if (!location) {
          fail(
            'COMMERCE_PROVIDER_IMAGE_REDIRECT_INVALID',
            'Provider image redirect is invalid',
            502,
          )
        }
        if (redirectCount === COMMERCE_PROVIDER_IMAGE_MAX_REDIRECTS) {
          fail(
            'COMMERCE_PROVIDER_IMAGE_REDIRECT_LIMIT',
            'Provider image exceeded the redirect limit',
            502,
          )
        }
        try {
          currentUrl = new URL(location, validatedUrl.url).toString()
        } catch {
          fail(
            'COMMERCE_PROVIDER_IMAGE_REDIRECT_INVALID',
            'Provider image redirect is invalid',
            502,
          )
        }
        continue
      }
      if (response.status !== 200) {
        cancelResponse(response)
        fail(
          'COMMERCE_PROVIDER_IMAGE_STATUS_INVALID',
          'Provider image response was not successful',
          502,
        )
      }
      const mediaType = normalizedContentType(response)
      const sourceBytes = await readBoundedImage(response, controller.signal)
      const sourceByteLength = sourceBytes.byteLength
      const sourceContentSha256 = createHash('sha256')
        .update(sourceBytes)
        .digest('hex')
      try {
        if (sourceByteLength > CRM_PRODUCT_IMAGE_MAX_BYTES) {
          const sourceDimensions = await inspectOversizedSource(
            sourceBytes,
            mediaType,
            controller.signal,
          )
          const normalized = await normalizeOversizedSource(
            sourceBytes,
            controller.signal,
          )
          const validated = validateCrmProductImage({
            bytes: normalized.bytes,
            declaredMimeType: 'image/webp',
            altText: 'Provider product image',
          })
          const image = {
            bytes: validated.bytes,
            byteLength: validated.byteLength,
            contentSha256: validated.contentSha256,
            mediaType: validated.mimeType,
            normalizationVersion: normalized.normalizationVersion,
            pixelWidth: validated.pixelWidth,
            pixelHeight: validated.pixelHeight,
            sourceByteLength,
            sourceContentSha256,
          }
          if (
            image.pixelWidth !== sourceDimensions.pixelWidth
            || image.pixelHeight !== sourceDimensions.pixelHeight
          ) {
            fail(
              'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
              'Normalized provider image dimensions changed unexpectedly',
              422,
            )
          }
          await validateDecodedImage(image, controller.signal)
          return image
        }
        const validated = validateCrmProductImage({
          bytes: sourceBytes,
          declaredMimeType: mediaType,
          altText: 'Provider product image',
        })
        const image = {
          bytes: validated.bytes,
          byteLength: validated.byteLength,
          contentSha256: validated.contentSha256,
          mediaType: validated.mimeType,
          normalizationVersion: IDENTITY_NORMALIZATION_VERSION,
          pixelWidth: validated.pixelWidth,
          pixelHeight: validated.pixelHeight,
          sourceByteLength,
          sourceContentSha256,
        }
        await validateDecodedImage(image, controller.signal)
        return image
      } catch (error) {
        if (error instanceof CrmProductImageAssetError) {
          validationFailure(error)
        }
        throw error
      }
    }
    fail(
      'COMMERCE_PROVIDER_IMAGE_REDIRECT_LIMIT',
      'Provider image exceeded the redirect limit',
      502,
    )
  } catch (error) {
    if (error instanceof CommerceProviderImageFetchError) throw error
    if (error instanceof FetchAborted || controller.signal.aborted) {
      if (timedOut) {
        fail(
          'COMMERCE_PROVIDER_IMAGE_TIMEOUT',
          'Provider image fetch timed out',
          504,
        )
      }
      fail(
        'COMMERCE_PROVIDER_IMAGE_ABORTED',
        'Provider image fetch was aborted',
        408,
      )
    }
    fail(
      'COMMERCE_PROVIDER_IMAGE_FETCH_FAILED',
      'Provider image could not be fetched',
      502,
    )
  } finally {
    dependencies.clearScheduledTimeout(timeoutHandle)
    input.signal?.removeEventListener('abort', onCallerAbort)
  }
  return fail(
    'COMMERCE_PROVIDER_IMAGE_FETCH_FAILED',
    'Provider image could not be fetched',
    502,
  )
}
