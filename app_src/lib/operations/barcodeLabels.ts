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
export const BARCODE_LABEL_TEMPLATE_VERSION = 'warehouse-barcode-zpl-v2' as const
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

function zplBarcode(item: BarcodeLabelItem, height: number) {
  // Zebra's retail barcode commands calculate the check digit themselves:
  // ^BU accepts 11 data digits, ^B8 accepts 7, and ^BE accepts 12. Keep the
  // complete scan-authoritative GTIN in evidence and human-readable text, but
  // omit its already-validated final check digit from the ZPL field data.
  const retailData = item.barcodeValue.slice(0, -1)
  if (item.symbology === 'UPC-A') return `^BUN,${height},N,N,N^FD${retailData}^FS`
  if (item.symbology === 'EAN-8') return `^B8N,${height},N,N^FD${retailData}^FS`
  if (item.symbology === 'EAN-13') return `^BEN,${height},N,N^FD${retailData}^FS`
  return `^BCN,${height},N,N,N^FD${item.barcodeValue}^FS`
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
  geometry: BarcodeLabelMediaGeometry,
) {
  const modules = barcodeModuleCount(item)
  const quietZone = item.symbology === 'EAN-13'
    ? { left: 11, right: 7 }
    : { left: 10, right: 10 }
  const fittingModuleWidth = Math.floor(
    geometry.widthDots / (modules + quietZone.left + quietZone.right),
  )
  const moduleWidth = Math.max(
    1,
    Math.min(geometry.zpl.maximumModuleWidth, fittingModuleWidth),
  )
  const occupiedWidth = (modules + quietZone.left + quietZone.right) * moduleWidth
  return {
    moduleWidth,
    x: quietZone.left * moduleWidth
      + Math.floor((geometry.widthDots - occupiedWidth) / 2),
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
  const layout = geometry.zpl
  const textWidth = geometry.widthDots - layout.marginX * 2
  const labels: string[] = []
  for (const item of snapshot.items) {
    const title = safeZplText(item.displayName, 54)
    const humanCode = safeZplText(item.humanCode, 60)
    const barcode = zplBarcodeGeometry(item, geometry)
    const identity = safeZplText(
      `${item.targetGlobalId.toUpperCase()} - ${item.symbology}/${item.sourceIdentity}`,
      80,
    )
    const footer = safeZplText(
      `ClawPilot ${snapshot.targetType} (${item.barcodeSource}) - ${BARCODE_LABEL_TEMPLATE_VERSION}`,
      90,
    )
    for (let copy = 0; copy < item.copies; copy += 1) {
      const content = [
        zplTextField({
          x: layout.marginX,
          y: layout.titleY,
          width: textWidth,
          fontHeight: layout.titleHeight,
          fontWidth: layout.titleWidth,
          lines: layout.titleLines,
          value: title,
        }),
        `^BY${barcode.moduleWidth},2,${layout.barcodeHeight}`,
        `^FO${barcode.x},${layout.barcodeY}${zplBarcode(item, layout.barcodeHeight)}`,
        zplTextField({
          x: layout.marginX,
          y: layout.valueY,
          width: textWidth,
          fontHeight: layout.valueHeight,
          fontWidth: layout.valueWidth,
          alignment: 'C',
          value: safeZplText(item.barcodeValue, 70),
        }),
        zplTextField({
          x: layout.marginX,
          y: layout.detailsY,
          width: textWidth,
          fontHeight: layout.detailsHeight,
          fontWidth: layout.detailsWidth,
          value: humanCode,
        }),
        zplTextField({
          x: layout.marginX,
          y: layout.identityY,
          width: textWidth,
          fontHeight: layout.identityHeight,
          fontWidth: layout.identityWidth,
          value: identity,
        }),
        zplTextField({
          x: layout.marginX,
          y: layout.footerY,
          width: textWidth,
          fontHeight: layout.footerHeight,
          fontWidth: layout.footerWidth,
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

export function renderBarcodeLabelsPreviewHtml(
  batchGlobalId: string,
  snapshot: BarcodeLabelBatchSnapshot,
  templateVersion: string = BARCODE_LABEL_TEMPLATE_VERSION,
) {
  if (templateVersion === 'warehouse-barcode-zpl-v1') {
    return renderBarcodeLabelsPreviewHtmlV1(batchGlobalId, snapshot)
  }
  if (templateVersion !== BARCODE_LABEL_TEMPLATE_VERSION) {
    throw new Error('Barcode label template version is not supported')
  }
  const geometry = MEDIA_GEOMETRY[snapshot.media]
  const layout = geometry.preview
  const labels = snapshot.items.flatMap((item) => Array.from(
    { length: item.copies },
    () => `<section class="label" data-media="${snapshot.media}">
      <h1>${html(item.displayName)}</h1>
      ${retailBarcodeSvg(item)}
      <div class="value">${html(item.barcodeValue)}</div>
      <div class="details">${html(item.humanCode)} &middot; ${html(item.targetGlobalId.toUpperCase())}</div>
      <div class="meta">Printed ${html(item.symbology)} &middot; Source ${html(item.sourceIdentity)} (${html(item.barcodeSource)}) &middot; ClawPilot ${html(snapshot.targetType)} label &middot; ${BARCODE_LABEL_TEMPLATE_VERSION}</div>
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
