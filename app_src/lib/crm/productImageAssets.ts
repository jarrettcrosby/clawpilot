import { createHash } from 'node:crypto'

export const CRM_PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024
export const CRM_PRODUCT_IMAGE_MAX_DIMENSION = 8192
export const CRM_PRODUCT_IMAGE_MAX_PIXELS = 40_000_000
export const CRM_PRODUCT_IMAGE_MAX_ALT_TEXT_LENGTH = 500

export const CRM_PRODUCT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const

export type CrmProductImageMimeType =
  (typeof CRM_PRODUCT_IMAGE_MIME_TYPES)[number]

export type ValidatedCrmProductImage = {
  bytes: Uint8Array
  mimeType: CrmProductImageMimeType
  contentSha256: string
  byteLength: number
  pixelWidth: number
  pixelHeight: number
  altText: string
}

export class CrmProductImageAssetError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'CrmProductImageAssetError'
    this.code = code
    this.status = status
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new CrmProductImageAssetError(code, message, status)
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! * 0x100) + bytes[offset + 1]!
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + (bytes[offset + 1]! * 0x100)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]!
    + (bytes[offset + 1]! * 0x100)
    + (bytes[offset + 2]! * 0x10000)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000)
    + (bytes[offset + 1]! * 0x10000)
    + (bytes[offset + 2]! * 0x100)
    + bytes[offset + 3]!
  ) >>> 0
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]!
    + (bytes[offset + 1]! * 0x100)
    + (bytes[offset + 2]! * 0x10000)
    + (bytes[offset + 3]! * 0x1000000)
  ) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? (0xedb88320 ^ (value >>> 1))
        : (value >>> 1)
    }
    table[index] = value >>> 0
  }
  return table
})()

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let offset = start; offset < end; offset += 1) {
    crc = PNG_CRC_TABLE[(crc ^ bytes[offset]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 45
    || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_PNG_INVALID',
      'Product image is not a structurally valid PNG',
    )
  }

  let offset = PNG_SIGNATURE.length
  let width = 0
  let height = 0
  let colorType = -1
  let sawHeader = false
  let sawPalette = false
  let sawImageData = false
  let imageDataEnded = false
  let sawEnd = false

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      fail(
        'CRM_PRODUCT_IMAGE_PNG_INVALID',
        'Product image contains a truncated PNG chunk',
      )
    }
    const length = u32be(bytes, offset)
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const dataEnd = dataOffset + length
    const chunkEnd = dataEnd + 4
    if (
      !Number.isSafeInteger(chunkEnd)
      || chunkEnd > bytes.length
      || length > CRM_PRODUCT_IMAGE_MAX_BYTES
    ) {
      fail(
        'CRM_PRODUCT_IMAGE_PNG_INVALID',
        'Product image contains an invalid PNG chunk length',
      )
    }
    const type = ascii(bytes, typeOffset, 4)
    if (!/^[A-Za-z]{4}$/.test(type)) {
      fail(
        'CRM_PRODUCT_IMAGE_PNG_INVALID',
        'Product image contains an invalid PNG chunk type',
      )
    }
    if (pngCrc32(bytes, typeOffset, dataEnd) !== u32be(bytes, dataEnd)) {
      fail(
        'CRM_PRODUCT_IMAGE_PNG_INVALID',
        'Product image contains a corrupt PNG chunk',
      )
    }

    if (!sawHeader && type !== 'IHDR') {
      fail(
        'CRM_PRODUCT_IMAGE_PNG_INVALID',
        'Product image PNG header must be the first chunk',
      )
    }
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) {
        fail(
          'CRM_PRODUCT_IMAGE_PNG_INVALID',
          'Product image contains an invalid PNG header',
        )
      }
      sawHeader = true
      width = u32be(bytes, dataOffset)
      height = u32be(bytes, dataOffset + 4)
      const bitDepth = bytes[dataOffset + 8]!
      colorType = bytes[dataOffset + 9]!
      const supportedDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      }
      if (
        !supportedDepths[colorType]?.includes(bitDepth)
        || bytes[dataOffset + 10] !== 0
        || bytes[dataOffset + 11] !== 0
        || (bytes[dataOffset + 12] !== 0 && bytes[dataOffset + 12] !== 1)
      ) {
        fail(
          'CRM_PRODUCT_IMAGE_PNG_INVALID',
          'Product image uses an unsupported PNG header',
        )
      }
    } else if (type === 'PLTE') {
      if (
        sawPalette
        || sawImageData
        || length === 0
        || length > 768
        || length % 3 !== 0
      ) {
        fail(
          'CRM_PRODUCT_IMAGE_PNG_INVALID',
          'Product image contains an invalid PNG palette',
        )
      }
      sawPalette = true
    } else if (type === 'IDAT') {
      if (
        imageDataEnded
        || length === 0
        || (colorType === 3 && !sawPalette)
      ) {
        fail(
          'CRM_PRODUCT_IMAGE_PNG_INVALID',
          'Product image contains invalid PNG image data',
        )
      }
      sawImageData = true
    } else {
      if (sawImageData) imageDataEnded = true
      if (type === 'IEND') {
        if (length !== 0 || sawEnd || !sawImageData || chunkEnd !== bytes.length) {
          fail(
            'CRM_PRODUCT_IMAGE_PNG_INVALID',
            'Product image contains an invalid PNG end marker',
          )
        }
        sawEnd = true
      } else if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90) {
        fail(
          'CRM_PRODUCT_IMAGE_PNG_INVALID',
          'Product image contains an unsupported critical PNG chunk',
        )
      }
    }
    offset = chunkEnd
  }

  if (!sawHeader || !sawImageData || !sawEnd || offset !== bytes.length) {
    fail(
      'CRM_PRODUCT_IMAGE_PNG_INVALID',
      'Product image is not a complete PNG',
    )
  }
  return { width, height }
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
])

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 16
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff
    || bytes[bytes.length - 1] !== 0xd9
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_JPEG_INVALID',
      'Product image is not a complete JPEG',
    )
  }

  let offset = 2
  let width = 0
  let height = 0
  let sawFrame = false
  let sawScan = false
  let inScan = false

  while (offset < bytes.length) {
    if (inScan) {
      let foundMarker = false
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1
          continue
        }
        let markerOffset = offset + 1
        while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
          markerOffset += 1
        }
        if (markerOffset >= bytes.length) {
          fail(
            'CRM_PRODUCT_IMAGE_JPEG_INVALID',
            'Product image contains truncated JPEG scan data',
          )
        }
        const marker = bytes[markerOffset]!
        if (marker === 0x00) {
          offset = markerOffset + 1
          continue
        }
        if (marker >= 0xd0 && marker <= 0xd7) {
          offset = markerOffset + 1
          continue
        }
        offset = markerOffset - 1
        inScan = false
        foundMarker = true
        break
      }
      if (!foundMarker) {
        fail(
          'CRM_PRODUCT_IMAGE_JPEG_INVALID',
          'Product image contains unterminated JPEG scan data',
        )
      }
    }

    if (bytes[offset] !== 0xff) {
      fail(
        'CRM_PRODUCT_IMAGE_JPEG_INVALID',
        'Product image contains an invalid JPEG marker',
      )
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) {
      fail(
        'CRM_PRODUCT_IMAGE_JPEG_INVALID',
        'Product image contains a truncated JPEG marker',
      )
    }
    const marker = bytes[offset]!
    offset += 1

    if (marker === 0xd9) {
      if (
        !sawFrame
        || !sawScan
        || offset !== bytes.length
      ) {
        fail(
          'CRM_PRODUCT_IMAGE_JPEG_INVALID',
          'Product image contains an invalid JPEG end marker',
        )
      }
      return { width, height }
    }
    if (
      marker === 0x00
      || marker === 0xd8
      || marker === 0x01
      || (marker >= 0xd0 && marker <= 0xd7)
    ) {
      fail(
        'CRM_PRODUCT_IMAGE_JPEG_INVALID',
        'Product image contains an unexpected JPEG marker',
      )
    }
    if (offset + 2 > bytes.length) {
      fail(
        'CRM_PRODUCT_IMAGE_JPEG_INVALID',
        'Product image contains a truncated JPEG segment',
      )
    }
    const segmentLength = u16be(bytes, offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      fail(
        'CRM_PRODUCT_IMAGE_JPEG_INVALID',
        'Product image contains an invalid JPEG segment length',
      )
    }
    const dataOffset = offset + 2
    const dataLength = segmentLength - 2

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (sawFrame || dataLength < 6) {
        fail(
          'CRM_PRODUCT_IMAGE_JPEG_INVALID',
          'Product image contains an invalid JPEG frame',
        )
      }
      const precision = bytes[dataOffset]!
      height = u16be(bytes, dataOffset + 1)
      width = u16be(bytes, dataOffset + 3)
      const components = bytes[dataOffset + 5]!
      if (
        precision !== 8
        || components < 1
        || components > 4
        || dataLength !== 6 + (components * 3)
      ) {
        fail(
          'CRM_PRODUCT_IMAGE_JPEG_INVALID',
          'Product image uses an unsupported JPEG frame',
        )
      }
      sawFrame = true
    } else if (marker === 0xda) {
      if (!sawFrame || dataLength < 4) {
        fail(
          'CRM_PRODUCT_IMAGE_JPEG_INVALID',
          'Product image contains an invalid JPEG scan header',
        )
      }
      const components = bytes[dataOffset]!
      if (
        components < 1
        || components > 4
        || dataLength !== 4 + (components * 2)
      ) {
        fail(
          'CRM_PRODUCT_IMAGE_JPEG_INVALID',
          'Product image contains an invalid JPEG scan header',
        )
      }
      sawScan = true
      inScan = true
    }
    offset += segmentLength
  }

  fail(
    'CRM_PRODUCT_IMAGE_JPEG_INVALID',
    'Product image is not a complete JPEG',
  )
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 26
    || ascii(bytes, 0, 4) !== 'RIFF'
    || ascii(bytes, 8, 4) !== 'WEBP'
    || u32le(bytes, 4) !== bytes.length - 8
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_WEBP_INVALID',
      'Product image is not a structurally valid WebP',
    )
  }

  let offset = 12
  let canvas: { width: number; height: number } | null = null
  let image: { width: number; height: number } | null = null
  let sawExtendedHeader = false
  let sawImageChunk = false

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      fail(
        'CRM_PRODUCT_IMAGE_WEBP_INVALID',
        'Product image contains a truncated WebP chunk',
      )
    }
    const type = ascii(bytes, offset, 4)
    const length = u32le(bytes, offset + 4)
    const dataOffset = offset + 8
    const dataEnd = dataOffset + length
    const paddedEnd = dataEnd + (length % 2)
    if (
      !Number.isSafeInteger(paddedEnd)
      || paddedEnd > bytes.length
      || length > CRM_PRODUCT_IMAGE_MAX_BYTES
      || (length % 2 === 1 && bytes[dataEnd] !== 0)
    ) {
      fail(
        'CRM_PRODUCT_IMAGE_WEBP_INVALID',
        'Product image contains an invalid WebP chunk length',
      )
    }

    if (type === 'VP8X') {
      if (offset !== 12 || sawExtendedHeader || length !== 10) {
        fail(
          'CRM_PRODUCT_IMAGE_WEBP_INVALID',
          'Product image contains an invalid WebP extended header',
        )
      }
      const flags = bytes[dataOffset]!
      if (
        (flags & 0xc3) !== 0
        || bytes[dataOffset + 1] !== 0
        || bytes[dataOffset + 2] !== 0
        || bytes[dataOffset + 3] !== 0
      ) {
        fail(
          'CRM_PRODUCT_IMAGE_WEBP_INVALID',
          'Animated or reserved WebP features are not supported',
        )
      }
      canvas = {
        width: u24le(bytes, dataOffset + 4) + 1,
        height: u24le(bytes, dataOffset + 7) + 1,
      }
      sawExtendedHeader = true
    } else if (type === 'VP8 ') {
      if (
        sawImageChunk
        || length < 10
        || (bytes[dataOffset]! & 1) !== 0
        || bytes[dataOffset + 3] !== 0x9d
        || bytes[dataOffset + 4] !== 0x01
        || bytes[dataOffset + 5] !== 0x2a
      ) {
        fail(
          'CRM_PRODUCT_IMAGE_WEBP_INVALID',
          'Product image contains an invalid WebP VP8 frame',
        )
      }
      const firstPartitionLength = (
        bytes[dataOffset]!
        + (bytes[dataOffset + 1]! * 0x100)
        + (bytes[dataOffset + 2]! * 0x10000)
      ) >>> 5
      if (firstPartitionLength > length - 10) {
        fail(
          'CRM_PRODUCT_IMAGE_WEBP_INVALID',
          'Product image contains a truncated WebP VP8 frame',
        )
      }
      image = {
        width: u16le(bytes, dataOffset + 6) & 0x3fff,
        height: u16le(bytes, dataOffset + 8) & 0x3fff,
      }
      sawImageChunk = true
    } else if (type === 'VP8L') {
      if (
        sawImageChunk
        || length < 5
        || bytes[dataOffset] !== 0x2f
      ) {
        fail(
          'CRM_PRODUCT_IMAGE_WEBP_INVALID',
          'Product image contains an invalid lossless WebP frame',
        )
      }
      const dimensionBits = u32le(bytes, dataOffset + 1)
      if ((dimensionBits >>> 29) !== 0) {
        fail(
          'CRM_PRODUCT_IMAGE_WEBP_INVALID',
          'Product image uses an unsupported lossless WebP version',
        )
      }
      image = {
        width: (dimensionBits & 0x3fff) + 1,
        height: ((dimensionBits >>> 14) & 0x3fff) + 1,
      }
      sawImageChunk = true
    } else if (type === 'ANIM' || type === 'ANMF') {
      fail(
        'CRM_PRODUCT_IMAGE_WEBP_INVALID',
        'Animated WebP product images are not supported',
      )
    }
    offset = paddedEnd
  }

  if (!image || !sawImageChunk || offset !== bytes.length) {
    fail(
      'CRM_PRODUCT_IMAGE_WEBP_INVALID',
      'Product image does not contain a complete WebP frame',
    )
  }
  if (
    canvas
    && (canvas.width !== image.width || canvas.height !== image.height)
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_WEBP_INVALID',
      'Product image WebP canvas dimensions do not match its frame',
    )
  }
  return canvas || image
}

function detectedMimeType(bytes: Uint8Array): CrmProductImageMimeType {
  if (
    bytes.length >= PNG_SIGNATURE.length
    && PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12
    && ascii(bytes, 0, 4) === 'RIFF'
    && ascii(bytes, 8, 4) === 'WEBP'
  ) return 'image/webp'
  fail(
    'CRM_PRODUCT_IMAGE_TYPE_INVALID',
    'Product images must be PNG, JPEG, or WebP files',
    415,
  )
}

function dimensions(
  bytes: Uint8Array,
  mimeType: CrmProductImageMimeType,
): { width: number; height: number } {
  if (mimeType === 'image/png') return pngDimensions(bytes)
  if (mimeType === 'image/jpeg') return jpegDimensions(bytes)
  return webpDimensions(bytes)
}

function normalizedAltText(value: unknown): string {
  if (typeof value !== 'string') {
    fail(
      'CRM_PRODUCT_IMAGE_ALT_TEXT_REQUIRED',
      'Product image alt text is required',
    )
  }
  const altText = value.trim().replace(/\s+/g, ' ')
  if (!altText) {
    fail(
      'CRM_PRODUCT_IMAGE_ALT_TEXT_REQUIRED',
      'Product image alt text is required',
    )
  }
  if (
    altText.length > CRM_PRODUCT_IMAGE_MAX_ALT_TEXT_LENGTH
    || /[\u0000-\u001f\u007f]/.test(altText)
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_ALT_TEXT_INVALID',
      `Product image alt text must be ${CRM_PRODUCT_IMAGE_MAX_ALT_TEXT_LENGTH} characters or fewer`,
    )
  }
  return altText
}

export function validateCrmProductImage(input: {
  bytes: Uint8Array
  declaredMimeType: unknown
  altText: unknown
}): ValidatedCrmProductImage {
  if (!(input.bytes instanceof Uint8Array)) {
    fail(
      'CRM_PRODUCT_IMAGE_BYTES_REQUIRED',
      'Product image bytes are required',
    )
  }
  if (
    input.bytes.byteLength === 0
    || input.bytes.byteLength > CRM_PRODUCT_IMAGE_MAX_BYTES
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_SIZE_INVALID',
      `Product images must be no larger than ${CRM_PRODUCT_IMAGE_MAX_BYTES} bytes`,
      413,
    )
  }
  const mimeType = detectedMimeType(input.bytes)
  const declaredMimeType = String(input.declaredMimeType || '')
    .trim()
    .toLowerCase()
  if (declaredMimeType !== mimeType) {
    fail(
      'CRM_PRODUCT_IMAGE_MIME_MISMATCH',
      'Product image MIME type does not match its file content',
      415,
    )
  }
  const measured = dimensions(input.bytes, mimeType)
  if (
    !Number.isSafeInteger(measured.width)
    || !Number.isSafeInteger(measured.height)
    || measured.width < 1
    || measured.height < 1
    || measured.width > CRM_PRODUCT_IMAGE_MAX_DIMENSION
    || measured.height > CRM_PRODUCT_IMAGE_MAX_DIMENSION
    || measured.width * measured.height > CRM_PRODUCT_IMAGE_MAX_PIXELS
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_DIMENSIONS_INVALID',
      `Product image dimensions must be at most ${CRM_PRODUCT_IMAGE_MAX_DIMENSION}px per side and ${CRM_PRODUCT_IMAGE_MAX_PIXELS} total pixels`,
    )
  }
  const bytes = Uint8Array.from(input.bytes)
  return {
    bytes,
    mimeType,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    pixelWidth: measured.width,
    pixelHeight: measured.height,
    altText: normalizedAltText(input.altText),
  }
}
