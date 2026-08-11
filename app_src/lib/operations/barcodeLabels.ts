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
export const BARCODE_LABEL_TEMPLATE_VERSION = 'warehouse-barcode-zpl-v1' as const
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

const MEDIA_GEOMETRY: Record<BarcodeLabelMedia, {
  widthDots: number
  lengthDots: number
  widthInches: number
  heightInches: number
  compact: boolean
}> = {
  label_2x1: { widthDots: 406, lengthDots: 203, widthInches: 2, heightInches: 1, compact: true },
  label_3x1: { widthDots: 609, lengthDots: 203, widthInches: 3, heightInches: 1, compact: true },
  label_4x2: { widthDots: 812, lengthDots: 406, widthInches: 4, heightInches: 2, compact: false },
  label_4x6: { widthDots: 812, lengthDots: 1218, widthInches: 4, heightInches: 6, compact: false },
  label_4x8: { widthDots: 812, lengthDots: 1624, widthInches: 4, heightInches: 8, compact: false },
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

export function renderBarcodeLabelsZpl(snapshot: BarcodeLabelBatchSnapshot) {
  const geometry = MEDIA_GEOMETRY[snapshot.media]
  const labels: string[] = []
  for (const item of snapshot.items) {
    const title = safeZplText(item.displayName, 54)
    const humanCode = safeZplText(item.humanCode, 60)
    for (let copy = 0; copy < item.copies; copy += 1) {
      const content = geometry.compact
        ? [
            `^FO14,8^A0N,24,20^FB${geometry.widthDots - 28},1,0,L,0^FD${title}^FS`,
            `^BY${snapshot.media === 'label_2x1' ? 1 : 2},2,58`,
            `^FO14,38${zplBarcode(item, 58)}`,
            `^FO14,120^A0N,18,16^FD${safeZplText(item.barcodeValue, 45)}^FS`,
            `^FO14,145^A0N,17,15^FD${humanCode}^FS`,
            `^FO14,170^A0N,14,12^FD${item.targetGlobalId.toUpperCase()} - ${item.symbology}^FS`,
          ]
        : [
            `^FO32,25^A0N,36,31^FB${geometry.widthDots - 64},2,0,L,0^FD${title}^FS`,
            '^BY2,2,105',
            `^FO32,100${zplBarcode(item, 105)}`,
            `^FO32,235^A0N,25,22^FD${safeZplText(item.barcodeValue, 70)}^FS`,
            `^FO32,275^A0N,26,23^FD${humanCode}^FS`,
            `^FO32,315^A0N,20,18^FD${item.targetGlobalId.toUpperCase()} - ${item.symbology} (${item.sourceIdentity})^FS`,
            `^FO32,350^A0N,16,14^FDClawPilot ${snapshot.targetType} - ${BARCODE_LABEL_TEMPLATE_VERSION}^FS`,
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

function linearBarcodeSvg(bits: string, value: string) {
  const quiet = 10
  const bars = [...bits].map((bit, index) => (
    bit === '1' ? `<rect x="${index + quiet}" y="0" width="1" height="90"/>` : ''
  )).join('')
  return `<svg class="barcode" viewBox="0 0 ${bits.length + quiet * 2} 90" role="img" aria-label="Barcode ${html(value)}" preserveAspectRatio="none">${bars}</svg>`
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
    return linearBarcodeSvg(`101${left}01010${right}101`, item.barcodeValue)
  }
  return code128Svg(item.barcodeValue)
}

export function renderBarcodeLabelsPreviewHtml(
  batchGlobalId: string,
  snapshot: BarcodeLabelBatchSnapshot,
) {
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
  const geometry = MEDIA_GEOMETRY[snapshot.media]
  const compact = geometry.compact ? ' compact' : ''
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
