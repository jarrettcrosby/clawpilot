import crypto from 'crypto'
import { normalizeGlobalId } from '@/lib/globalIds.mjs'

export const BARCODE_LABEL_TARGET_TYPES = ['product', 'location'] as const
export const BARCODE_LABEL_MEDIA = [
  'label_2x1',
  'label_3x1',
  'label_4x2',
  'label_4x6',
  'label_4x8',
] as const
export const BARCODE_LABEL_TEMPLATE_VERSION = 'warehouse-barcode-zpl-v4' as const
const LEGACY_BARCODE_LABEL_TEMPLATE_VERSION_V3 = 'warehouse-barcode-zpl-v3' as const
const LEGACY_BARCODE_LABEL_TEMPLATE_VERSION_V2 = 'warehouse-barcode-zpl-v2' as const
export const INTERNAL_PRODUCT_BARCODE_PREFIX = 'CP1P-' as const
export const LOCATION_BARCODE_PREFIX = 'CP1L-' as const

export type BarcodeLabelTargetType = typeof BARCODE_LABEL_TARGET_TYPES[number]
export type BarcodeLabelMedia = typeof BARCODE_LABEL_MEDIA[number]
export type BarcodeSymbology = 'UPC-A' | 'EAN-8' | 'EAN-13' | 'CODE128'
export type BarcodeSourceIdentity = BarcodeSymbology | 'GTIN-14' | 'LOCATION'
export type ProductBarcodeSource = 'provider' | 'internal'

export type BarcodeLabelItem = {
  targetGlobalId: string
  displayName: string
  humanCode: string
  barcodeValue: string
  symbology: BarcodeSymbology
  sourceIdentity: BarcodeSourceIdentity
  barcodeSource: ProductBarcodeSource | 'location'
  copies: number
}

export type BarcodeLabelBatchSnapshot = {
  targetType: BarcodeLabelTargetType
  warehouseGlobalId: string
  warehouseName: string
  media: BarcodeLabelMedia
  items: BarcodeLabelItem[]
}

const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213',
  '122312', '132212', '221213', '221312', '231212', '112232', '122132',
  '122231', '113222', '123122', '123221', '223211', '221132', '221231',
  '213212', '223112', '312131', '311222', '321122', '321221', '312212',
  '322112', '322211', '212123', '212321', '232121', '111323', '131123',
  '131321', '112313', '132113', '132311', '211313', '231113', '231311',
  '112133', '112331', '132131', '113123', '113321', '133121', '313121',
  '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111',
  '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114',
  '413111', '241112', '134111', '111242', '121142', '121241', '114212',
  '124112', '124211', '411212', '421112', '421211', '212141', '214121',
  '412121', '111143', '111341', '131141', '114113', '114311', '411113',
  '411311', '113141', '114131', '311141', '411131', '211412', '211214',
  '211232', '2331112',
] as const

function compact(value: unknown) {
  return String(value ?? '').trim()
}

function gtinCheckDigitIsValid(value: string) {
  if (!/^\d+$/.test(value) || ![8, 12, 13, 14].includes(value.length)) return false
  const digits = [...value].map(Number)
  const expected = digits.pop()
  let sum = 0
  for (let index = digits.length - 1, position = 0; index >= 0; index -= 1, position += 1) {
    sum += digits[index] * (position % 2 === 0 ? 3 : 1)
  }
  return expected === (10 - (sum % 10)) % 10
}

export function providerBarcodeIdentity(value: unknown): {
  value: string
  symbology: BarcodeSymbology
  sourceIdentity: Exclude<BarcodeSourceIdentity, 'LOCATION'>
} | null {
  const normalized = compact(value)
  if (!gtinCheckDigitIsValid(normalized)) return null
  const sourceIdentity = normalized.length === 8
    ? 'EAN-8'
    : normalized.length === 12
      ? 'UPC-A'
      : normalized.length === 13
        ? 'EAN-13'
        : 'GTIN-14'
  return {
    value: normalized,
    symbology: sourceIdentity === 'GTIN-14' ? 'CODE128' : sourceIdentity,
    sourceIdentity,
  }
}

export function internalProductBarcode(productGlobalId: string) {
  const normalized = normalizeGlobalId(productGlobalId, 'gp')
  if (!normalized) {
    throw new Error('Product Global ID is invalid for an internal barcode')
  }
  return `${INTERNAL_PRODUCT_BARCODE_PREFIX}${normalized.toUpperCase()}`
}

export function locationBarcode(locationGlobalId: string) {
  const normalized = normalizeGlobalId(locationGlobalId, 'gwl')
  if (!normalized) {
    throw new Error('Location Global ID is invalid for a location barcode')
  }
  return `${LOCATION_BARCODE_PREFIX}${normalized.toUpperCase()}`
}

export function parseClawPilotWarehouseBarcode(value: unknown):
  | { version: 1; targetType: 'product'; targetGlobalId: string }
  | { version: 1; targetType: 'location'; targetGlobalId: string }
  | null {
  const normalized = compact(value).toUpperCase()
  if (normalized.startsWith(INTERNAL_PRODUCT_BARCODE_PREFIX)) {
    const targetGlobalId = normalizeGlobalId(
      normalized.slice(INTERNAL_PRODUCT_BARCODE_PREFIX.length),
      'gp',
    )
    return targetGlobalId
      ? { version: 1, targetType: 'product', targetGlobalId }
      : null
  }
  if (normalized.startsWith(LOCATION_BARCODE_PREFIX)) {
    const targetGlobalId = normalizeGlobalId(
      normalized.slice(LOCATION_BARCODE_PREFIX.length),
      'gwl',
    )
    return targetGlobalId
      ? { version: 1, targetType: 'location', targetGlobalId }
      : null
  }
  return null
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  )).join(',')}}`
}

export function barcodeLabelRequestHash(value: unknown) {
  return crypto
    .createHash('sha256')
    .update(`clawpilot:warehouse-barcode-label:v1\n${stableJson(value)}`)
    .digest('hex')
}

function safeZplText(value: string, maximum: number) {
  return value
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\^~]/g, '')
    .trim()
    .slice(0, maximum)
}

type BarcodeLabelMediaGeometry = {
  widthDots: number
  lengthDots: number
  widthInches: number
  heightInches: number
  zpl: {
    marginX: number
    titleY: number
    titleHeight: number
    titleWidth: number
    titleLines: number
    barcodeY: number
    barcodeHeight: number
    maximumModuleWidth: number
    valueY: number
    valueHeight: number
    valueWidth: number
    detailsY: number
    detailsHeight: number
    detailsWidth: number
    identityY: number
    identityHeight: number
    identityWidth: number
    footerY: number
    footerHeight: number
    footerWidth: number
  }
  preview: {
    paddingXInches: number
    paddingYInches: number
    titleHeightInches: number
    barcodeHeightInches: number
    valueHeightInches: number
    detailsHeightInches: number
    metaHeightInches: number
    gapInches: number
    titleFontPoints: number
    titleLines: number
    valueFontPoints: number
    detailsFontPoints: number
    metaFontPoints: number
  }
}

const MEDIA_GEOMETRY: Record<BarcodeLabelMedia, BarcodeLabelMediaGeometry> = {
  label_2x1: {
    widthDots: 406,
    lengthDots: 203,
    widthInches: 2,
    heightInches: 1,
    zpl: {
      marginX: 12,
      titleY: 5,
      titleHeight: 22,
      titleWidth: 18,
      titleLines: 1,
      barcodeY: 32,
      barcodeHeight: 76,
      maximumModuleWidth: 3,
      valueY: 113,
      valueHeight: 16,
      valueWidth: 13,
      detailsY: 135,
      detailsHeight: 16,
      detailsWidth: 13,
      identityY: 157,
      identityHeight: 13,
      identityWidth: 10,
      footerY: 178,
      footerHeight: 11,
      footerWidth: 9,
    },
    preview: {
      paddingXInches: 0.08,
      paddingYInches: 0.04,
      titleHeightInches: 0.14,
      barcodeHeightInches: 0.4,
      valueHeightInches: 0.1,
      detailsHeightInches: 0.11,
      metaHeightInches: 0.09,
      gapInches: 0.02,
      titleFontPoints: 9.25,
      titleLines: 1,
      valueFontPoints: 6.4,
      detailsFontPoints: 6.6,
      metaFontPoints: 4.25,
    },
  },
  label_3x1: {
    widthDots: 609,
    lengthDots: 203,
    widthInches: 3,
    heightInches: 1,
    zpl: {
      marginX: 14,
      titleY: 5,
      titleHeight: 24,
      titleWidth: 20,
      titleLines: 1,
      barcodeY: 34,
      barcodeHeight: 84,
      maximumModuleWidth: 5,
      valueY: 122,
      valueHeight: 18,
      valueWidth: 15,
      detailsY: 144,
      detailsHeight: 17,
      detailsWidth: 14,
      identityY: 166,
      identityHeight: 14,
      identityWidth: 11,
      footerY: 184,
      footerHeight: 11,
      footerWidth: 9,
    },
    preview: {
      paddingXInches: 0.1,
      paddingYInches: 0.04,
      titleHeightInches: 0.15,
      barcodeHeightInches: 0.42,
      valueHeightInches: 0.09,
      detailsHeightInches: 0.11,
      metaHeightInches: 0.07,
      gapInches: 0.02,
      titleFontPoints: 9.5,
      titleLines: 1,
      valueFontPoints: 6,
      detailsFontPoints: 7.2,
      metaFontPoints: 4.5,
    },
  },
  label_4x2: {
    widthDots: 812,
    lengthDots: 406,
    widthInches: 4,
    heightInches: 2,
    zpl: {
      marginX: 24,
      titleY: 15,
      titleHeight: 38,
      titleWidth: 32,
      titleLines: 1,
      barcodeY: 65,
      barcodeHeight: 180,
      maximumModuleWidth: 7,
      valueY: 256,
      valueHeight: 28,
      valueWidth: 24,
      detailsY: 293,
      detailsHeight: 30,
      detailsWidth: 26,
      identityY: 334,
      identityHeight: 22,
      identityWidth: 18,
      footerY: 373,
      footerHeight: 16,
      footerWidth: 13,
    },
    preview: {
      paddingXInches: 0.14,
      paddingYInches: 0.12,
      titleHeightInches: 0.28,
      barcodeHeightInches: 0.82,
      valueHeightInches: 0.16,
      detailsHeightInches: 0.22,
      metaHeightInches: 0.14,
      gapInches: 0.035,
      titleFontPoints: 16,
      titleLines: 1,
      valueFontPoints: 10,
      detailsFontPoints: 13,
      metaFontPoints: 7.5,
    },
  },
  label_4x6: {
    widthDots: 812,
    lengthDots: 1218,
    widthInches: 4,
    heightInches: 6,
    zpl: {
      marginX: 36,
      titleY: 35,
      titleHeight: 62,
      titleWidth: 52,
      titleLines: 2,
      barcodeY: 185,
      barcodeHeight: 720,
      maximumModuleWidth: 7,
      valueY: 930,
      valueHeight: 42,
      valueWidth: 34,
      detailsY: 990,
      detailsHeight: 50,
      detailsWidth: 42,
      identityY: 1060,
      identityHeight: 32,
      identityWidth: 26,
      footerY: 1120,
      footerHeight: 24,
      footerWidth: 20,
    },
    preview: {
      paddingXInches: 0.24,
      paddingYInches: 0.24,
      titleHeightInches: 0.8,
      barcodeHeightInches: 3.5,
      valueHeightInches: 0.3,
      detailsHeightInches: 0.4,
      metaHeightInches: 0.37,
      gapInches: 0.0375,
      titleFontPoints: 26,
      titleLines: 2,
      valueFontPoints: 16,
      detailsFontPoints: 20,
      metaFontPoints: 9,
    },
  },
  label_4x8: {
    widthDots: 812,
    lengthDots: 1624,
    widthInches: 4,
    heightInches: 8,
    zpl: {
      marginX: 36,
      titleY: 45,
      titleHeight: 72,
      titleWidth: 60,
      titleLines: 2,
      barcodeY: 230,
      barcodeHeight: 1020,
      maximumModuleWidth: 7,
      valueY: 1280,
      valueHeight: 48,
      valueWidth: 39,
      detailsY: 1350,
      detailsHeight: 58,
      detailsWidth: 48,
      identityY: 1430,
      identityHeight: 38,
      identityWidth: 31,
      footerY: 1500,
      footerHeight: 28,
      footerWidth: 23,
    },
    preview: {
      paddingXInches: 0.26,
      paddingYInches: 0.28,
      titleHeightInches: 0.9,
      barcodeHeightInches: 5,
      valueHeightInches: 0.35,
      detailsHeightInches: 0.5,
      metaHeightInches: 0.37,
      gapInches: 0.08,
      titleFontPoints: 30,
      titleLines: 2,
      valueFontPoints: 18,
      detailsFontPoints: 24,
      metaFontPoints: 9,
    },
  },
}

type BarcodeLabelBox = {
  x: number
  y: number
  width: number
  height: number
}

type BarcodeLabelTextBox = BarcodeLabelBox & {
  fontHeight: number
  fontWidth: number
  lines?: number
  alignment?: 'L' | 'C' | 'R' | 'J'
}

type BarcodeLabelV3Geometry = {
  title: BarcodeLabelTextBox
  linear: BarcodeLabelBox & {
    maximumModuleWidth: number
    minimumModuleWidth: number
  }
  value: BarcodeLabelTextBox
  qr: (BarcodeLabelBox & { magnification: number }) | null
  details: BarcodeLabelTextBox
  identity: BarcodeLabelTextBox
  footer: BarcodeLabelTextBox
}

// Version 3 keeps the scan-authoritative linear code for ordinary warehouse
// scanners. Larger media reserve a separate QR square containing the exact
// same value so a wide-angle wearable camera does not have to resolve every
// narrow Code 128 bar. Coordinates are in 203 dpi printer dots and are shared
// by ZPL and browser previews.
const V3_MEDIA_GEOMETRY: Record<BarcodeLabelMedia, BarcodeLabelV3Geometry> = {
  label_2x1: {
    title: { x: 12, y: 5, width: 382, height: 22, fontHeight: 22, fontWidth: 18 },
    linear: {
      x: 0, y: 32, width: 406, height: 76,
      maximumModuleWidth: 3, minimumModuleWidth: 1,
    },
    value: {
      x: 12, y: 113, width: 382, height: 16,
      fontHeight: 16, fontWidth: 13, alignment: 'C',
    },
    qr: null,
    details: { x: 12, y: 135, width: 382, height: 16, fontHeight: 16, fontWidth: 13 },
    identity: { x: 12, y: 157, width: 382, height: 13, fontHeight: 13, fontWidth: 10 },
    footer: { x: 12, y: 178, width: 382, height: 11, fontHeight: 11, fontWidth: 9 },
  },
  label_3x1: {
    title: { x: 14, y: 5, width: 581, height: 24, fontHeight: 24, fontWidth: 20 },
    linear: {
      x: 0, y: 34, width: 609, height: 84,
      maximumModuleWidth: 5, minimumModuleWidth: 1,
    },
    value: {
      x: 14, y: 122, width: 581, height: 18,
      fontHeight: 18, fontWidth: 15, alignment: 'C',
    },
    qr: null,
    details: { x: 14, y: 144, width: 581, height: 17, fontHeight: 17, fontWidth: 14 },
    identity: { x: 14, y: 166, width: 581, height: 14, fontHeight: 14, fontWidth: 11 },
    footer: { x: 14, y: 184, width: 581, height: 11, fontHeight: 11, fontWidth: 9 },
  },
  label_4x2: {
    title: { x: 24, y: 12, width: 764, height: 36, fontHeight: 32, fontWidth: 27 },
    linear: {
      x: 0, y: 60, width: 812, height: 92,
      maximumModuleWidth: 4, minimumModuleWidth: 2,
    },
    value: {
      x: 24, y: 160, width: 764, height: 24,
      fontHeight: 22, fontWidth: 18, alignment: 'C',
    },
    qr: { x: 24, y: 198, width: 203, height: 203, magnification: 7 },
    details: {
      x: 250, y: 202, width: 538, height: 50,
      fontHeight: 30, fontWidth: 25, lines: 1,
    },
    identity: {
      x: 250, y: 270, width: 538, height: 26,
      fontHeight: 20, fontWidth: 16,
    },
    footer: {
      x: 250, y: 324, width: 538, height: 52,
      fontHeight: 15, fontWidth: 12, lines: 2,
    },
  },
  label_4x6: {
    title: {
      x: 36, y: 30, width: 740, height: 80,
      fontHeight: 38, fontWidth: 32, lines: 2,
    },
    linear: {
      x: 0, y: 130, width: 812, height: 600,
      maximumModuleWidth: 5, minimumModuleWidth: 2,
    },
    value: {
      x: 36, y: 750, width: 740, height: 50,
      fontHeight: 42, fontWidth: 34, alignment: 'C',
    },
    qr: { x: 36, y: 850, width: 290, height: 290, magnification: 10 },
    details: {
      x: 370, y: 850, width: 406, height: 90,
      fontHeight: 45, fontWidth: 37, lines: 2,
    },
    identity: {
      x: 370, y: 970, width: 406, height: 55,
      fontHeight: 27, fontWidth: 22, lines: 2,
    },
    footer: {
      x: 370, y: 1050, width: 406, height: 80,
      fontHeight: 21, fontWidth: 17, lines: 3,
    },
  },
  label_4x8: {
    title: {
      x: 36, y: 40, width: 740, height: 100,
      fontHeight: 48, fontWidth: 40, lines: 2,
    },
    linear: {
      x: 0, y: 170, width: 812, height: 900,
      maximumModuleWidth: 5, minimumModuleWidth: 2,
    },
    value: {
      x: 36, y: 1090, width: 740, height: 60,
      fontHeight: 48, fontWidth: 39, alignment: 'C',
    },
    qr: { x: 36, y: 1260, width: 290, height: 290, magnification: 10 },
    details: {
      x: 370, y: 1260, width: 406, height: 105,
      fontHeight: 52, fontWidth: 43, lines: 2,
    },
    identity: {
      x: 370, y: 1395, width: 406, height: 65,
      fontHeight: 32, fontWidth: 26, lines: 2,
    },
    footer: {
      x: 370, y: 1480, width: 406, height: 90,
      fontHeight: 23, fontWidth: 19, lines: 3,
    },
  },
}

// Version 4 leaves the proven one-inch media unchanged. On larger stock it
// gives the linear symbol a standards-friendly height without allowing it to
// dominate the label, and makes the duplicate camera code the primary visual
// target. QR boxes include the required four-module quiet zone.
const V4_MEDIA_GEOMETRY: Record<BarcodeLabelMedia, BarcodeLabelV3Geometry> = {
  label_2x1: V3_MEDIA_GEOMETRY.label_2x1,
  label_3x1: V3_MEDIA_GEOMETRY.label_3x1,
  label_4x2: {
    title: { x: 24, y: 12, width: 764, height: 36, fontHeight: 32, fontWidth: 27 },
    linear: {
      x: 0, y: 58, width: 812, height: 84,
      maximumModuleWidth: 4, minimumModuleWidth: 2,
    },
    value: {
      x: 24, y: 150, width: 764, height: 24,
      fontHeight: 22, fontWidth: 18, alignment: 'C',
    },
    qr: { x: 24, y: 183, width: 203, height: 203, magnification: 7 },
    details: {
      x: 250, y: 188, width: 538, height: 50,
      fontHeight: 30, fontWidth: 25, lines: 1,
    },
    identity: {
      x: 250, y: 260, width: 538, height: 26,
      fontHeight: 20, fontWidth: 16,
    },
    footer: {
      x: 250, y: 316, width: 538, height: 52,
      fontHeight: 15, fontWidth: 12, lines: 2,
    },
  },
  label_4x6: {
    title: {
      x: 36, y: 28, width: 740, height: 78,
      fontHeight: 38, fontWidth: 32, lines: 2,
    },
    linear: {
      x: 0, y: 128, width: 812, height: 240,
      maximumModuleWidth: 5, minimumModuleWidth: 2,
    },
    value: {
      x: 36, y: 388, width: 740, height: 48,
      fontHeight: 40, fontWidth: 32, alignment: 'C',
    },
    qr: { x: 232, y: 470, width: 348, height: 348, magnification: 12 },
    details: {
      x: 36, y: 850, width: 740, height: 62,
      fontHeight: 44, fontWidth: 36, lines: 1, alignment: 'C',
    },
    identity: {
      x: 36, y: 936, width: 740, height: 42,
      fontHeight: 27, fontWidth: 22, lines: 1, alignment: 'C',
    },
    footer: {
      x: 80, y: 1020, width: 652, height: 90,
      fontHeight: 21, fontWidth: 17, lines: 3, alignment: 'C',
    },
  },
  label_4x8: {
    title: {
      x: 36, y: 38, width: 740, height: 94,
      fontHeight: 46, fontWidth: 38, lines: 2,
    },
    linear: {
      x: 0, y: 160, width: 812, height: 300,
      maximumModuleWidth: 5, minimumModuleWidth: 2,
    },
    value: {
      x: 36, y: 480, width: 740, height: 56,
      fontHeight: 46, fontWidth: 37, alignment: 'C',
    },
    qr: { x: 203, y: 590, width: 406, height: 406, magnification: 14 },
    details: {
      x: 36, y: 1050, width: 740, height: 74,
      fontHeight: 50, fontWidth: 41, lines: 1, alignment: 'C',
    },
    identity: {
      x: 36, y: 1150, width: 740, height: 52,
      fontHeight: 31, fontWidth: 25, lines: 1, alignment: 'C',
    },
    footer: {
      x: 80, y: 1240, width: 652, height: 96,
      fontHeight: 23, fontWidth: 19, lines: 3, alignment: 'C',
    },
  },
}

function zplBarcode(item: BarcodeLabelItem, height: number) {
  const barcodeValue = safeWarehouseBarcodeValue(item.barcodeValue)
  // Zebra's retail barcode commands calculate the check digit themselves:
  // ^BU accepts 11 data digits, ^B8 accepts 7, and ^BE accepts 12. Keep the
  // complete scan-authoritative GTIN in evidence and human-readable text, but
  // omit its already-validated final check digit from the ZPL field data.
  const retailData = barcodeValue.slice(0, -1)
  if (item.symbology === 'UPC-A') return `^BUN,${height},N,N,N^FD${retailData}^FS`
  if (item.symbology === 'EAN-8') return `^B8N,${height},N,N^FD${retailData}^FS`
  if (item.symbology === 'EAN-13') return `^BEN,${height},N,N^FD${retailData}^FS`
  return `^BCN,${height},N,N,N^FD${barcodeValue}^FS`
}

function safeWarehouseBarcodeValue(value: string) {
  // Product and location persistence only emits retail digits or uppercase
  // CP1 identifiers. Keeping this stricter than general ZPL text prevents
  // field/control delimiters from ever being interpolated into ^FD.
  if (!/^[0-9A-Z-]{1,20}$/.test(value)) {
    throw new Error('Warehouse barcode value is invalid for label rendering')
  }
  return value
}

function barcodeModuleCount(item: BarcodeLabelItem) {
  if (item.symbology === 'EAN-8') return 67
  if (item.symbology === 'UPC-A' || item.symbology === 'EAN-13') return 95
  // Code 128 subset B: start, one symbol per character, checksum, stop, and
  // termination bar. The conservative extra two modules keep the right quiet
  // zone intact across Zebra firmware variants.
  return 11 * (item.barcodeValue.length + 2) + 15
}

function zplBarcodeGeometry(
  item: BarcodeLabelItem,
  box: BarcodeLabelBox,
  maximumModuleWidth: number,
  minimumModuleWidth: number,
) {
  const modules = barcodeModuleCount(item)
  const quietZone = item.symbology === 'EAN-13'
    ? { left: 11, right: 7 }
    : { left: 10, right: 10 }
  const fittingModuleWidth = Math.floor(
    box.width / (modules + quietZone.left + quietZone.right),
  )
  const moduleWidth = Math.min(maximumModuleWidth, fittingModuleWidth)
  if (moduleWidth < minimumModuleWidth) {
    throw new Error('Barcode does not fit the selected label media at a scannable module width')
  }
  const occupiedWidth = (modules + quietZone.left + quietZone.right) * moduleWidth
  const occupiedX = box.x + Math.floor((box.width - occupiedWidth) / 2)
  return {
    moduleWidth,
    occupiedX,
    occupiedWidth,
    x: occupiedX + quietZone.left * moduleWidth,
  }
}

function zplTextField(input: {
  x: number
  y: number
  width: number
  fontHeight: number
  fontWidth: number
  lines?: number
  alignment?: 'L' | 'C' | 'R' | 'J'
  value: string
}) {
  return `^FO${input.x},${input.y}^A0N,${input.fontHeight},${input.fontWidth}`
    + `^FB${input.width},${input.lines || 1},0,${input.alignment || 'L'},0`
    + `^FD${input.value}^FS`
}

export function renderBarcodeLabelsZpl(snapshot: BarcodeLabelBatchSnapshot) {
  const geometry = MEDIA_GEOMETRY[snapshot.media]
  const layout = V4_MEDIA_GEOMETRY[snapshot.media]
  const labels: string[] = []
  for (const item of snapshot.items) {
    const barcodeValue = safeWarehouseBarcodeValue(item.barcodeValue)
    const title = safeZplText(item.displayName, 54)
    const humanCode = safeZplText(item.humanCode, 60)
    const barcode = zplBarcodeGeometry(
      item,
      layout.linear,
      layout.linear.maximumModuleWidth,
      layout.linear.minimumModuleWidth,
    )
    const identity = safeZplText(
      `${item.targetGlobalId.toUpperCase()} - ${item.symbology}/${item.sourceIdentity}`,
      80,
    )
    const footer = safeZplText(
      layout.qr
        ? `Primary ${item.symbology}; QR same value - ClawPilot ${snapshot.targetType} (${item.barcodeSource}) - ${BARCODE_LABEL_TEMPLATE_VERSION}`
        : `Primary ${item.symbology}; linear only - ClawPilot ${snapshot.targetType} (${item.barcodeSource}) - ${BARCODE_LABEL_TEMPLATE_VERSION}`,
      130,
    )
    const qrGraphic = layout.qr
      ? qrCodeZplGraphic(barcodeValue, layout.qr.magnification)
      : null
    for (let copy = 0; copy < item.copies; copy += 1) {
      const content = [
        zplTextField({
          ...layout.title,
          value: title,
        }),
        `^BY${barcode.moduleWidth},2,${layout.linear.height}`,
        `^FO${barcode.x},${layout.linear.y}${zplBarcode(item, layout.linear.height)}`,
        zplTextField({
          ...layout.value,
          value: barcodeValue,
        }),
        ...(layout.qr && qrGraphic ? [
          // Render the validated QR matrix as one deterministic raster graphic.
          // This avoids model- and firmware-specific ^BQ parsing while making
          // the physical ZPL bytes match the browser preview module-for-module.
          `^FO${layout.qr.x + QR_QUIET_ZONE_MODULES * layout.qr.magnification},${layout.qr.y + QR_QUIET_ZONE_MODULES * layout.qr.magnification}`
            + `${qrGraphic}^FS`,
        ] : []),
        zplTextField({
          ...layout.details,
          value: humanCode,
        }),
        zplTextField({
          ...layout.identity,
          value: identity,
        }),
        zplTextField({
          ...layout.footer,
          value: footer,
        }),
      ]
      labels.push([
        '^XA',
        '^CI28',
        `^PW${geometry.widthDots}`,
        `^LL${geometry.lengthDots}`,
        '^LH0,0',
        ...content,
        '^XZ',
      ].join('\n'))
    }
  }
  return `${labels.join('\n')}\n`
}

function html(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character)
}

const QR_VERSION = 1
const QR_SIZE = 21
const QR_QUIET_ZONE_MODULES = 4
const QR_DATA_CODEWORDS_M = 16
const QR_ERROR_CORRECTION_CODEWORDS_M = 10
const QR_ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

function appendQrBits(target: number[], value: number, length: number) {
  for (let bit = length - 1; bit >= 0; bit -= 1) target.push((value >>> bit) & 1)
}

function qrDataCodewords(value: string) {
  const safeValue = safeWarehouseBarcodeValue(value)
  const numeric = /^\d+$/.test(safeValue)
  const bits: number[] = []
  appendQrBits(bits, numeric ? 0b0001 : 0b0010, 4)
  appendQrBits(bits, safeValue.length, numeric ? 10 : 9)

  if (numeric) {
    for (let index = 0; index < safeValue.length; index += 3) {
      const group = safeValue.slice(index, index + 3)
      appendQrBits(bits, Number(group), group.length === 3 ? 10 : group.length === 2 ? 7 : 4)
    }
  } else {
    const values = [...safeValue].map((character) => QR_ALPHANUMERIC.indexOf(character))
    if (values.some((current) => current < 0)) {
      throw new Error('Warehouse barcode value cannot be represented in QR alphanumeric mode')
    }
    for (let index = 0; index + 1 < values.length; index += 2) {
      appendQrBits(bits, values[index] * 45 + values[index + 1], 11)
    }
    if (values.length % 2 === 1) appendQrBits(bits, values[values.length - 1], 6)
  }

  const capacity = QR_DATA_CODEWORDS_M * 8
  if (bits.length > capacity) throw new Error('Warehouse barcode value does not fit QR version 1-M')
  for (let index = 0; index < Math.min(4, capacity - bits.length); index += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords: number[] = []
  for (let index = 0; index < bits.length; index += 8) {
    codewords.push(Number.parseInt(bits.slice(index, index + 8).join(''), 2))
  }
  for (let padIndex = 0; codewords.length < QR_DATA_CODEWORDS_M; padIndex += 1) {
    codewords.push(padIndex % 2 === 0 ? 0xec : 0x11)
  }
  return codewords
}

function qrGaloisTables() {
  const exponent = new Array<number>(512).fill(0)
  const logarithm = new Array<number>(256).fill(0)
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    exponent[index] = value
    logarithm[value] = index
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let index = 255; index < exponent.length; index += 1) {
    exponent[index] = exponent[index - 255]
  }
  return { exponent, logarithm }
}

function qrErrorCorrection(data: number[]) {
  const { exponent, logarithm } = qrGaloisTables()
  const multiply = (left: number, right: number) => (
    left === 0 || right === 0 ? 0 : exponent[logarithm[left] + logarithm[right]]
  )
  let generator = [1]
  for (let degree = 0; degree < QR_ERROR_CORRECTION_CODEWORDS_M; degree += 1) {
    const next = new Array<number>(generator.length + 1).fill(0)
    for (let index = 0; index < generator.length; index += 1) {
      next[index] ^= generator[index]
      next[index + 1] ^= multiply(generator[index], exponent[degree])
    }
    generator = next
  }

  const remainder = new Array<number>(QR_ERROR_CORRECTION_CODEWORDS_M).fill(0)
  for (const codeword of data) {
    const factor = codeword ^ remainder[0]
    remainder.shift()
    remainder.push(0)
    for (let index = 0; index < remainder.length; index += 1) {
      remainder[index] ^= multiply(generator[index + 1], factor)
    }
  }
  return remainder
}

type QrMatrix = {
  modules: boolean[][]
  functions: boolean[][]
}

function emptyQrMatrix(): QrMatrix {
  return {
    modules: Array.from({ length: QR_SIZE }, () => Array<boolean>(QR_SIZE).fill(false)),
    functions: Array.from({ length: QR_SIZE }, () => Array<boolean>(QR_SIZE).fill(false)),
  }
}

function setQrFunction(matrix: QrMatrix, x: number, y: number, dark: boolean) {
  if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) return
  matrix.modules[y][x] = dark
  matrix.functions[y][x] = true
}

function drawQrFinder(matrix: QrMatrix, centerX: number, centerY: number) {
  for (let deltaY = -4; deltaY <= 4; deltaY += 1) {
    for (let deltaX = -4; deltaX <= 4; deltaX += 1) {
      const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY))
      setQrFunction(
        matrix,
        centerX + deltaX,
        centerY + deltaY,
        distance !== 2 && distance !== 4,
      )
    }
  }
}

function qrFormatBits(mask: number) {
  // Error-correction level M uses format value 00.
  const data = mask
  let remainder = data
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  }
  return ((data << 10) | remainder) ^ 0x5412
}

function drawQrFormat(matrix: QrMatrix, mask: number) {
  const bits = qrFormatBits(mask)
  const dark = (index: number) => ((bits >>> index) & 1) !== 0
  for (let index = 0; index <= 5; index += 1) setQrFunction(matrix, 8, index, dark(index))
  setQrFunction(matrix, 8, 7, dark(6))
  setQrFunction(matrix, 8, 8, dark(7))
  setQrFunction(matrix, 7, 8, dark(8))
  for (let index = 9; index < 15; index += 1) {
    setQrFunction(matrix, 14 - index, 8, dark(index))
  }
  for (let index = 0; index < 8; index += 1) {
    setQrFunction(matrix, QR_SIZE - 1 - index, 8, dark(index))
  }
  for (let index = 8; index < 15; index += 1) {
    setQrFunction(matrix, 8, QR_SIZE - 15 + index, dark(index))
  }
  setQrFunction(matrix, 8, QR_SIZE - 8, true)
}

function qrMask(mask: number, x: number, y: number) {
  if (mask === 0) return (x + y) % 2 === 0
  if (mask === 1) return y % 2 === 0
  if (mask === 2) return x % 3 === 0
  if (mask === 3) return (x + y) % 3 === 0
  if (mask === 4) return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
  if (mask === 5) return (x * y) % 2 + (x * y) % 3 === 0
  if (mask === 6) return ((x * y) % 2 + (x * y) % 3) % 2 === 0
  return ((x + y) % 2 + (x * y) % 3) % 2 === 0
}

function qrPenalty(modules: boolean[][]) {
  let penalty = 0
  const scoreLine = (line: boolean[]) => {
    let score = 0
    let runColor = line[0]
    let runLength = 1
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === runColor) {
        runLength += 1
        if (runLength === 5) score += 3
        else if (runLength > 5) score += 1
      } else {
        runColor = line[index]
        runLength = 1
      }
    }
    const pattern = line.map((current) => current ? '1' : '0').join('')
    for (let index = 0; index <= pattern.length - 11; index += 1) {
      const segment = pattern.slice(index, index + 11)
      if (segment === '00001011101' || segment === '10111010000') score += 40
    }
    return score
  }
  for (let index = 0; index < QR_SIZE; index += 1) {
    penalty += scoreLine(modules[index])
    penalty += scoreLine(modules.map((row) => row[index]))
  }
  for (let y = 0; y < QR_SIZE - 1; y += 1) {
    for (let x = 0; x < QR_SIZE - 1; x += 1) {
      const color = modules[y][x]
      if (
        modules[y][x + 1] === color
        && modules[y + 1][x] === color
        && modules[y + 1][x + 1] === color
      ) penalty += 3
    }
  }
  const darkCount = modules.flat().filter(Boolean).length
  penalty += Math.floor(Math.abs(darkCount * 20 - QR_SIZE * QR_SIZE * 10) / (QR_SIZE * QR_SIZE)) * 10
  return penalty
}

export function warehouseBarcodeQrModules(value: string) {
  const data = qrDataCodewords(value)
  const codewords = [...data, ...qrErrorCorrection(data)]
  const base = emptyQrMatrix()
  for (let index = 0; index < QR_SIZE; index += 1) {
    setQrFunction(base, 6, index, index % 2 === 0)
    setQrFunction(base, index, 6, index % 2 === 0)
  }
  drawQrFinder(base, 3, 3)
  drawQrFinder(base, QR_SIZE - 4, 3)
  drawQrFinder(base, 3, QR_SIZE - 4)
  drawQrFormat(base, 0)

  let dataIndex = 0
  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < QR_SIZE; vertical += 1) {
      const upward = ((right + 1) & 2) === 0
      const y = upward ? QR_SIZE - 1 - vertical : vertical
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset
        if (base.functions[y][x]) continue
        const bit = dataIndex < codewords.length * 8
          ? ((codewords[dataIndex >>> 3] >>> (7 - (dataIndex & 7))) & 1) !== 0
          : false
        base.modules[y][x] = bit
        dataIndex += 1
      }
    }
  }
  if (dataIndex !== codewords.length * 8) throw new Error('QR codeword placement is incomplete')

  let selected: boolean[][] | null = null
  let selectedPenalty = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate: QrMatrix = {
      modules: base.modules.map((row) => [...row]),
      functions: base.functions,
    }
    for (let y = 0; y < QR_SIZE; y += 1) {
      for (let x = 0; x < QR_SIZE; x += 1) {
        if (!candidate.functions[y][x] && qrMask(mask, x, y)) {
          candidate.modules[y][x] = !candidate.modules[y][x]
        }
      }
    }
    drawQrFormat(candidate, mask)
    const penalty = qrPenalty(candidate.modules)
    if (penalty < selectedPenalty) {
      selected = candidate.modules
      selectedPenalty = penalty
    }
  }
  if (!selected) throw new Error('QR mask selection failed')
  return selected
}

function qrCodeSvgV3(value: string) {
  const modules = warehouseBarcodeQrModules(value)
  const viewSize = QR_SIZE + QR_QUIET_ZONE_MODULES * 2
  const path = modules.flatMap((row, y) => row.flatMap((dark, x) => (
    dark ? [`M${x + QR_QUIET_ZONE_MODULES} ${y + QR_QUIET_ZONE_MODULES}h1v1h-1z`] : []
  ))).join('')
  return `<svg class="qr-code" viewBox="0 0 ${viewSize} ${viewSize}" role="img" aria-label="QR barcode ${html(value)}" data-version="${QR_VERSION}" data-modules="${QR_SIZE}" data-quiet-zone="${QR_QUIET_ZONE_MODULES}" shape-rendering="crispEdges"><rect width="${viewSize}" height="${viewSize}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}

function qrCodeSvg(value: string) {
  const modules = warehouseBarcodeQrModules(value)
  const viewSize = QR_SIZE + QR_QUIET_ZONE_MODULES * 2
  const rectangles = modules.flatMap((row, y) => row.flatMap((dark, x) => (
    dark
      ? [`<rect x="${x + QR_QUIET_ZONE_MODULES}" y="${y + QR_QUIET_ZONE_MODULES}" width="1" height="1" fill="#000"/>`]
      : []
  ))).join('')
  return `<svg class="qr-code" viewBox="0 0 ${viewSize} ${viewSize}" role="img" aria-label="QR barcode ${html(value)}" data-version="${QR_VERSION}" data-modules="${QR_SIZE}" data-quiet-zone="${QR_QUIET_ZONE_MODULES}" shape-rendering="crispEdges"><rect width="${viewSize}" height="${viewSize}" fill="#fff"/>${rectangles}</svg>`
}

function qrCodeZplGraphic(value: string, magnification: number) {
  const modules = warehouseBarcodeQrModules(value)
  const dimension = QR_SIZE * magnification
  const bytesPerRow = Math.ceil(dimension / 8)
  const rows: string[] = []
  for (let pixelY = 0; pixelY < dimension; pixelY += 1) {
    const moduleY = Math.floor(pixelY / magnification)
    let row = ''
    for (let byteX = 0; byteX < bytesPerRow; byteX += 1) {
      let byte = 0
      for (let bit = 0; bit < 8; bit += 1) {
        const pixelX = byteX * 8 + bit
        const moduleX = Math.floor(pixelX / magnification)
        if (
          pixelX < dimension
          && modules[moduleY][moduleX]
        ) byte |= 1 << (7 - bit)
      }
      row += byte.toString(16).padStart(2, '0').toUpperCase()
    }
    rows.push(row)
  }
  const repeatCount = (count: number) => {
    const high = Math.floor(count / 20)
    const low = count % 20
    return `${high ? String.fromCharCode('g'.charCodeAt(0) + high - 1) : ''}`
      + `${low ? String.fromCharCode('G'.charCodeAt(0) + low - 1) : ''}`
  }
  const compressRow = (row: string) => {
    let encoded = ''
    for (let start = 0; start < row.length;) {
      let end = start + 1
      while (end < row.length && row[end] === row[start]) end += 1
      const count = end - start
      encoded += count < 4 ? row[start].repeat(count) : `${repeatCount(count)}${row[start]}`
      start = end
    }
    return encoded
  }
  const compressedRows: string[] = []
  let previous = ''
  for (const row of rows) {
    if (row === previous) compressedRows.push(':')
    else if (/^0+$/.test(row)) compressedRows.push(',')
    else compressedRows.push(compressRow(row))
    previous = row
  }
  const byteCount = bytesPerRow * dimension
  return `^GFA,${byteCount},${byteCount},${bytesPerRow},${compressedRows.join('')}`
}

function code128Svg(value: string) {
  if (!/^[\x20-\x7e]{1,120}$/.test(value)) throw new Error('Code 128 preview value is invalid')
  const values = [...value].map((character) => character.charCodeAt(0) - 32)
  const checksum = (104 + values.reduce((sum, current, index) => (
    sum + current * (index + 1)
  ), 0)) % 103
  const symbols = [104, ...values, checksum, 106]
  let x = 10
  const bars: string[] = []
  for (const symbol of symbols) {
    const pattern = CODE128_PATTERNS[symbol]
    for (let index = 0; index < pattern.length; index += 1) {
      const width = Number(pattern[index])
      if (index % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${width}" height="90"/>`)
      x += width
    }
  }
  x += 10
  return `<svg class="barcode" viewBox="0 0 ${x} 90" role="img" aria-label="Barcode ${html(value)}" preserveAspectRatio="none">${bars.join('')}</svg>`
}

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']
const EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

function linearBarcodeSvg(
  bits: string,
  value: string,
  quiet: { left: number; right: number } = { left: 10, right: 10 },
) {
  const bars = [...bits].map((bit, index) => (
    bit === '1' ? `<rect x="${index + quiet.left}" y="0" width="1" height="90"/>` : ''
  )).join('')
  return `<svg class="barcode" viewBox="0 0 ${bits.length + quiet.left + quiet.right} 90" role="img" aria-label="Barcode ${html(value)}" preserveAspectRatio="none">${bars}</svg>`
}

function retailBarcodeSvg(item: BarcodeLabelItem) {
  const digits = [...item.barcodeValue].map(Number)
  if (item.symbology === 'UPC-A') {
    const left = digits.slice(0, 6).map((digit) => EAN_L[digit]).join('')
    const right = digits.slice(6).map((digit) => EAN_R[digit]).join('')
    return linearBarcodeSvg(`101${left}01010${right}101`, item.barcodeValue)
  }
  if (item.symbology === 'EAN-8') {
    const left = digits.slice(0, 4).map((digit) => EAN_L[digit]).join('')
    const right = digits.slice(4).map((digit) => EAN_R[digit]).join('')
    return linearBarcodeSvg(`101${left}01010${right}101`, item.barcodeValue)
  }
  if (item.symbology === 'EAN-13') {
    const parity = EAN13_PARITY[digits[0]]
    const left = digits.slice(1, 7).map((digit, index) => (
      parity[index] === 'G' ? EAN_G[digit] : EAN_L[digit]
    )).join('')
    const right = digits.slice(7).map((digit) => EAN_R[digit]).join('')
    return linearBarcodeSvg(
      `101${left}01010${right}101`,
      item.barcodeValue,
      { left: 11, right: 7 },
    )
  }
  return code128Svg(item.barcodeValue)
}

function renderBarcodeLabelsPreviewHtmlV1(
  batchGlobalId: string,
  snapshot: BarcodeLabelBatchSnapshot,
) {
  const geometry = MEDIA_GEOMETRY[snapshot.media]
  const compact = geometry.heightInches === 1 ? ' compact' : ''
  const labels = snapshot.items.flatMap((item) => Array.from(
    { length: item.copies },
    () => `<section class="label">
      <h1>${html(item.displayName)}</h1>
      ${retailBarcodeSvg(item)}
      <div class="value">${html(item.barcodeValue)}</div>
      <div class="details">${html(item.humanCode)} &middot; ${html(item.targetGlobalId.toUpperCase())}</div>
      <div class="meta">Printed ${html(item.symbology)} &middot; Source ${html(item.sourceIdentity)} &middot; ClawPilot ${html(snapshot.targetType)} label</div>
    </section>`,
  )).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ClawPilot barcode labels ${html(batchGlobalId)}</title>
<style>
@page { size: ${geometry.widthInches}in ${geometry.heightInches}in; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; color: #050505; background: #e9edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center; padding: 12px 16px; color: white; background: #111827; }
.toolbar button { padding: 9px 15px; border: 0; border-radius: 8px; color: #08162b; background: #9ec5ff; font-weight: 700; cursor: pointer; }
.label { width: ${geometry.widthInches}in; height: ${geometry.heightInches}in; margin: 18px auto; padding: .18in; overflow: hidden; background: white; break-after: page; }
h1 { min-height: .75in; margin: 0 0 .12in; font-size: 25pt; line-height: 1.08; }
.barcode { display: block; width: 100%; height: 1.25in; margin-top: .12in; fill: #000; }
.value { margin-top: .08in; font: 700 13pt ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; overflow-wrap: anywhere; }
.details { margin-top: .25in; font-size: 17pt; font-weight: 700; }
.meta { margin-top: .12in; color: #374151; font-size: 10pt; }
.compact { padding: .06in .08in; }
.compact h1 { min-height: 0; height: .2in; margin: 0; overflow: hidden; font-size: 10pt; white-space: nowrap; }
.compact .barcode { height: .34in; margin-top: .02in; }
.compact .value { margin-top: .01in; font-size: 6.5pt; line-height: 1; }
.compact .details { margin-top: .02in; overflow: hidden; font-size: 7pt; line-height: 1; white-space: nowrap; }
.compact .meta { margin-top: .015in; overflow: hidden; font-size: 5.5pt; line-height: 1; white-space: nowrap; }
@media print { body { background: white; } .toolbar { display: none; } .label { margin: 0; } }
</style></head><body>
<div class="toolbar"><button type="button" onclick="window.print()">Print labels</button><span>${html(snapshot.warehouseName)} &middot; ${snapshot.items.reduce((sum, item) => sum + item.copies, 0)} labels</span></div>
${labels.replaceAll('class="label"', `class="label${compact}"`)}
</body></html>`
}

function renderBarcodeLabelsPreviewHtmlV2(
  batchGlobalId: string,
  snapshot: BarcodeLabelBatchSnapshot,
) {
  const geometry = MEDIA_GEOMETRY[snapshot.media]
  const layout = geometry.preview
  const labels = snapshot.items.flatMap((item) => Array.from(
    { length: item.copies },
    () => `<section class="label" data-media="${snapshot.media}">
      <h1>${html(item.displayName)}</h1>
      ${retailBarcodeSvg(item)}
      <div class="value">${html(item.barcodeValue)}</div>
      <div class="details">${html(item.humanCode)} &middot; ${html(item.targetGlobalId.toUpperCase())}</div>
      <div class="meta">Printed ${html(item.symbology)} &middot; Source ${html(item.sourceIdentity)} (${html(item.barcodeSource)}) &middot; ClawPilot ${html(snapshot.targetType)} label &middot; ${LEGACY_BARCODE_LABEL_TEMPLATE_VERSION_V2}</div>
    </section>`,
  )).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ClawPilot barcode labels ${html(batchGlobalId)}</title>
<style>
@page { size: ${geometry.widthInches}in ${geometry.heightInches}in; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; color: #050505; background: #e9edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center; padding: 12px 16px; color: white; background: #111827; }
.toolbar button { padding: 9px 15px; border: 0; border-radius: 8px; color: #08162b; background: #9ec5ff; font-weight: 700; cursor: pointer; }
.label {
  width: ${geometry.widthInches}in;
  height: ${geometry.heightInches}in;
  margin: 18px auto;
  padding: ${layout.paddingYInches}in ${layout.paddingXInches}in;
  display: grid;
  grid-template-rows: ${layout.titleHeightInches}in ${layout.barcodeHeightInches}in ${layout.valueHeightInches}in ${layout.detailsHeightInches}in ${layout.metaHeightInches}in;
  row-gap: ${layout.gapInches}in;
  overflow: hidden;
  background: white;
  break-after: page;
}
h1 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: ${layout.titleFontPoints}pt;
  line-height: 1.08;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: ${layout.titleLines};
}
.barcode { display: block; width: 100%; height: 100%; margin: 0; fill: #000; shape-rendering: crispEdges; }
.value, .details, .meta { min-width: 0; overflow: hidden; display: flex; align-items: center; line-height: 1.08; }
.value { justify-content: center; font: 700 ${layout.valueFontPoints}pt ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; white-space: nowrap; }
.details { font-size: ${layout.detailsFontPoints}pt; font-weight: 700; overflow-wrap: anywhere; }
.meta { color: #374151; font-size: ${layout.metaFontPoints}pt; overflow-wrap: anywhere; }
@media print { body { background: white; } .toolbar { display: none; } .label { margin: 0; } }
</style></head><body>
<div class="toolbar"><button type="button" onclick="window.print()">Print labels</button><span>${html(snapshot.warehouseName)} &middot; ${snapshot.items.reduce((sum, item) => sum + item.copies, 0)} labels</span></div>
${labels}
</body></html>`
}

function previewInches(dots: number) {
  return `${(dots / 203).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}in`
}

function previewBoxStyle(box: BarcodeLabelBox) {
  return `left:${previewInches(box.x)};top:${previewInches(box.y)};width:${previewInches(box.width)};height:${previewInches(box.height)}`
}

function previewTextStyle(box: BarcodeLabelTextBox) {
  const alignment = box.alignment === 'C' ? 'center' : box.alignment === 'R' ? 'right' : 'left'
  const justify = box.alignment === 'C' ? 'center' : box.alignment === 'R' ? 'flex-end' : 'flex-start'
  return `${previewBoxStyle(box)};font-size:${((box.fontHeight / 203) * 72).toFixed(2)}pt;text-align:${alignment};justify-content:${justify}`
}

function boxContract(box: BarcodeLabelBox) {
  return `${box.x},${box.y},${box.width},${box.height}`
}

function renderBarcodeLabelsPreviewHtmlPositioned(
  batchGlobalId: string,
  snapshot: BarcodeLabelBatchSnapshot,
  templateVersion: typeof BARCODE_LABEL_TEMPLATE_VERSION | typeof LEGACY_BARCODE_LABEL_TEMPLATE_VERSION_V3,
  layouts: Record<BarcodeLabelMedia, BarcodeLabelV3Geometry>,
) {
  const media = MEDIA_GEOMETRY[snapshot.media]
  const layout = layouts[snapshot.media]
  const labels = snapshot.items.flatMap((item) => Array.from(
    { length: item.copies },
    () => {
      const barcodeValue = safeWarehouseBarcodeValue(item.barcodeValue)
      const linearBarcode = zplBarcodeGeometry(
        item,
        layout.linear,
        layout.linear.maximumModuleWidth,
        layout.linear.minimumModuleWidth,
      )
      const linearRenderBox: BarcodeLabelBox = {
        x: linearBarcode.occupiedX,
        y: layout.linear.y,
        width: linearBarcode.occupiedWidth,
        height: layout.linear.height,
      }
      const mode = layout.qr ? 'linear-and-qr' : 'linear-only'
      const qr = layout.qr
        ? `<div class="qr-code-box" style="${previewBoxStyle(layout.qr)}">${templateVersion === LEGACY_BARCODE_LABEL_TEMPLATE_VERSION_V3 ? qrCodeSvgV3(barcodeValue) : qrCodeSvg(barcodeValue)}</div>`
        : ''
      const footer = layout.qr
        ? `Primary ${html(item.symbology)} &middot; QR duplicates the same value &middot; ClawPilot ${html(snapshot.targetType)} (${html(item.barcodeSource)}) &middot; ${templateVersion}`
        : `Primary ${html(item.symbology)} &middot; Compact linear-only label &middot; ClawPilot ${html(snapshot.targetType)} (${html(item.barcodeSource)}) &middot; ${templateVersion}`
      return `<section class="label" data-media="${snapshot.media}" data-template="${templateVersion}" data-code-mode="${mode}" data-title-box="${boxContract(layout.title)}" data-linear-box="${boxContract(layout.linear)}" data-linear-render-box="${boxContract(linearRenderBox)}" data-linear-module-width="${linearBarcode.moduleWidth}" data-value-box="${boxContract(layout.value)}" data-details-box="${boxContract(layout.details)}" data-identity-box="${boxContract(layout.identity)}" data-footer-box="${boxContract(layout.footer)}"${layout.qr ? ` data-qr-box="${boxContract(layout.qr)}" data-qr-magnification="${layout.qr.magnification}"` : ''}>
      <h1 style="${previewTextStyle(layout.title)}">${html(item.displayName)}</h1>
      <div class="linear-code" style="${previewBoxStyle(linearRenderBox)}">${retailBarcodeSvg(item)}</div>
      <div class="value" style="${previewTextStyle(layout.value)}">${html(barcodeValue)}</div>
      ${qr}
      <div class="details" style="${previewTextStyle(layout.details)}">${html(item.humanCode)}</div>
      <div class="identity" style="${previewTextStyle(layout.identity)}">${html(item.targetGlobalId.toUpperCase())} &middot; ${html(item.symbology)}/${html(item.sourceIdentity)}</div>
      <div class="meta" style="${previewTextStyle(layout.footer)}">${footer}</div>
    </section>`
    },
  )).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ClawPilot barcode labels ${html(batchGlobalId)}</title>
<style>
@page { size: ${media.widthInches}in ${media.heightInches}in; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; color: #050505; background: #e9edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center; padding: 12px 16px; color: white; background: #111827; }
.toolbar button { padding: 9px 15px; border: 0; border-radius: 8px; color: #08162b; background: #9ec5ff; font-weight: 700; cursor: pointer; }
.label { position: relative; width: ${media.widthInches}in; height: ${media.heightInches}in; margin: 18px auto; overflow: hidden; background: white; break-after: page; }
.label > * { position: absolute; margin: 0; min-width: 0; overflow: hidden; }
h1, .value, .details, .identity, .meta { display: flex; align-items: center; line-height: 1.06; overflow-wrap: anywhere; }
h1 { font-weight: 750; }
.linear-code .barcode, .qr-code-box .qr-code { display: block; width: 100%; height: 100%; margin: 0; fill: #000; shape-rendering: crispEdges; }
.value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; white-space: nowrap; }
.details { font-weight: 700; }
.identity { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.meta { color: #374151; }
@media print { body { background: white; } .toolbar { display: none; } .label { margin: 0; } }
</style></head><body>
<div class="toolbar"><button type="button" onclick="window.print()">Print labels</button><span>${html(snapshot.warehouseName)} &middot; ${snapshot.items.reduce((sum, item) => sum + item.copies, 0)} labels</span></div>
${labels}
</body></html>`
}

function renderBarcodeLabelsPreviewHtmlV3(
  batchGlobalId: string,
  snapshot: BarcodeLabelBatchSnapshot,
) {
  return renderBarcodeLabelsPreviewHtmlPositioned(
    batchGlobalId,
    snapshot,
    LEGACY_BARCODE_LABEL_TEMPLATE_VERSION_V3,
    V3_MEDIA_GEOMETRY,
  )
}

function renderBarcodeLabelsPreviewHtmlV4(
  batchGlobalId: string,
  snapshot: BarcodeLabelBatchSnapshot,
) {
  return renderBarcodeLabelsPreviewHtmlPositioned(
    batchGlobalId,
    snapshot,
    BARCODE_LABEL_TEMPLATE_VERSION,
    V4_MEDIA_GEOMETRY,
  )
}

export function renderBarcodeLabelsPreviewHtml(
  batchGlobalId: string,
  snapshot: BarcodeLabelBatchSnapshot,
  templateVersion: string = BARCODE_LABEL_TEMPLATE_VERSION,
) {
  if (templateVersion === 'warehouse-barcode-zpl-v1') {
    return renderBarcodeLabelsPreviewHtmlV1(batchGlobalId, snapshot)
  }
  if (templateVersion === LEGACY_BARCODE_LABEL_TEMPLATE_VERSION_V2) {
    return renderBarcodeLabelsPreviewHtmlV2(batchGlobalId, snapshot)
  }
  if (templateVersion === LEGACY_BARCODE_LABEL_TEMPLATE_VERSION_V3) {
    return renderBarcodeLabelsPreviewHtmlV3(batchGlobalId, snapshot)
  }
  if (templateVersion === BARCODE_LABEL_TEMPLATE_VERSION) {
    return renderBarcodeLabelsPreviewHtmlV4(batchGlobalId, snapshot)
  }
  throw new Error('Barcode label template version is not supported')
}
