import { createHash } from 'node:crypto'
import { parse } from 'csv-parse/sync'
import type { PackagingMaterialType } from '@/lib/operations/packagingMaterials'

export const SHOPIFY_PACKAGING_IMPORT_HEADERS = [
  'shopify_package_id',
  'code',
  'name',
  'type',
  'length',
  'width',
  'height',
  'length_unit',
  'empty_weight',
  'weight_unit',
  'is_default',
] as const

export const SHOPIFY_PACKAGING_IMPORT_TEMPLATE = `${SHOPIFY_PACKAGING_IMPORT_HEADERS.join(',')}\n,CYL5505BK,CYL5505BK,BOX,19,12,12,INCHES,1,POUNDS,true\n`

const MAX_CSV_BYTES = 128 * 1024
const MAX_ROWS = 250
const SHIPPING_PACKAGE_GID = /^gid:\/\/shopify\/ShippingPackage\/[1-9][0-9]{0,20}$/u
const CODE = /^[A-Z0-9][A-Z0-9._-]{1,39}$/u

export class ShopifyPackagingImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ShopifyPackagingImportError'
  }
}

export type ShopifyPackagingImportRow = Readonly<{
  sourceExternalKey: string
  shopifyPackageId: string | null
  code: string
  name: string
  shopifyType: 'BOX' | 'ENVELOPE' | 'FLAT_RATE' | 'SOFT_PACK'
  materialType: PackagingMaterialType
  ratedOuterLengthMm: number
  ratedOuterWidthMm: number
  ratedOuterHeightMm: number
  tareWeightGrams: number
  isDefault: boolean
}>

export type ShopifyPackagingImportPreview = Readonly<{
  fileSha256: string
  rows: readonly ShopifyPackagingImportRow[]
  totalCount: number
  defaultCount: number
  warnings: readonly string[]
  providerListApiAvailable: false
  createsDraftsOnly: true
  providerWrites: 0
}>

function fail(code: string, message: string, status = 400): never {
  throw new ShopifyPackagingImportError(code, message, status)
}

function exactText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || value !== value.trim()) {
    fail('SHOPIFY_PACKAGING_IMPORT_ROW_INVALID', `${label} is invalid`)
  }
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('SHOPIFY_PACKAGING_IMPORT_ROW_INVALID', `${label} is invalid`)
  }
  return value
}

function optionalExactText(value: unknown, label: string, maximum: number) {
  if (value === '') return null
  return exactText(value, label, maximum)
}

function positiveDecimal(value: unknown, label: string) {
  if (typeof value !== 'string' || value !== value.trim() || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(value)) {
    fail('SHOPIFY_PACKAGING_IMPORT_ROW_INVALID', `${label} must be a positive number with at most six decimals`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail('SHOPIFY_PACKAGING_IMPORT_ROW_INVALID', `${label} must be greater than zero`)
  }
  return parsed
}

function canonicalCode(value: unknown, name: string) {
  const candidate = typeof value === 'string' && value.trim()
    ? value.trim().toUpperCase()
    : name.toUpperCase().replace(/[^A-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (!CODE.test(candidate)) {
    fail(
      'SHOPIFY_PACKAGING_IMPORT_CODE_INVALID',
      `Package ${name} needs a unique 2–40 character code using letters, numbers, periods, underscores, or hyphens`,
    )
  }
  return candidate
}

function lengthMillimeters(value: number, unit: string) {
  const multiplier = {
    MILLIMETERS: 1,
    CENTIMETERS: 10,
    INCHES: 25.4,
  }[unit]
  if (!multiplier) {
    fail(
      'SHOPIFY_PACKAGING_IMPORT_LENGTH_UNIT_INVALID',
      'Length unit must be MILLIMETERS, CENTIMETERS, or INCHES',
    )
  }
  const result = Math.round(value * multiplier)
  if (!Number.isSafeInteger(result) || result < 1 || result > 100_000) {
    fail('SHOPIFY_PACKAGING_IMPORT_DIMENSION_INVALID', 'Package dimensions are outside the supported range')
  }
  return result
}

function weightGrams(value: number, unit: string) {
  const multiplier = {
    GRAMS: 1,
    KILOGRAMS: 1_000,
    OUNCES: 28.349523125,
    POUNDS: 453.59237,
  }[unit]
  if (!multiplier) {
    fail(
      'SHOPIFY_PACKAGING_IMPORT_WEIGHT_UNIT_INVALID',
      'Weight unit must be GRAMS, KILOGRAMS, OUNCES, or POUNDS',
    )
  }
  const result = Math.round(value * multiplier)
  if (!Number.isSafeInteger(result) || result < 1 || result > 100_000_000) {
    fail('SHOPIFY_PACKAGING_IMPORT_WEIGHT_INVALID', 'Package weight is outside the supported range')
  }
  return result
}

function packageType(value: unknown) {
  const normalized = exactText(value, 'Package type', 30).toUpperCase()
  const materialType: Record<string, PackagingMaterialType> = {
    BOX: 'carton',
    FLAT_RATE: 'carton',
    SOFT_PACK: 'poly_mailer',
    ENVELOPE: 'padded_mailer',
  }
  if (!materialType[normalized]) {
    fail(
      'SHOPIFY_PACKAGING_IMPORT_TYPE_INVALID',
      'Package type must be BOX, ENVELOPE, FLAT_RATE, or SOFT_PACK',
    )
  }
  return {
    shopifyType: normalized as ShopifyPackagingImportRow['shopifyType'],
    materialType: materialType[normalized],
  }
}

function booleanValue(value: unknown) {
  if (typeof value !== 'string' || value !== value.trim()) {
    fail('SHOPIFY_PACKAGING_IMPORT_DEFAULT_INVALID', 'Default must be true or false')
  }
  const normalized = value.toLowerCase()
  if (['true', 'yes', '1'].includes(normalized)) return true
  if (['false', 'no', '0'].includes(normalized)) return false
  fail('SHOPIFY_PACKAGING_IMPORT_DEFAULT_INVALID', 'Default must be true or false')
}

export function parseShopifyPackagingImportCsv(csv: string): ShopifyPackagingImportPreview {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    fail('SHOPIFY_PACKAGING_IMPORT_TOO_LARGE', 'Shopify package CSV must be 128 KiB or smaller', 413)
  }
  let records: Record<string, string>[]
  try {
    records = parse(csv, {
      bom: true,
      columns: (headers: string[]) => {
        if (
          headers.length !== SHOPIFY_PACKAGING_IMPORT_HEADERS.length
          || headers.some((header, index) => header !== SHOPIFY_PACKAGING_IMPORT_HEADERS[index])
        ) {
          fail(
            'SHOPIFY_PACKAGING_IMPORT_HEADERS_INVALID',
            `CSV headers must be exactly: ${SHOPIFY_PACKAGING_IMPORT_HEADERS.join(',')}`,
          )
        }
        return headers
      },
      relax_column_count: false,
      skip_empty_lines: true,
      trim: false,
    }) as Record<string, string>[]
  } catch (error) {
    if (error instanceof ShopifyPackagingImportError) throw error
    fail('SHOPIFY_PACKAGING_IMPORT_CSV_INVALID', 'Shopify package CSV could not be parsed')
  }
  if (!records.length || records.length > MAX_ROWS) {
    fail(
      'SHOPIFY_PACKAGING_IMPORT_ROW_COUNT_INVALID',
      `Shopify package CSV must contain 1–${MAX_ROWS} packages`,
    )
  }
  const codes = new Set<string>()
  const externalIds = new Set<string>()
  const rows = records.map((record, index): ShopifyPackagingImportRow => {
    if (Object.keys(record).length !== SHOPIFY_PACKAGING_IMPORT_HEADERS.length) {
      fail('SHOPIFY_PACKAGING_IMPORT_ROW_INVALID', `CSV row ${index + 2} is invalid`)
    }
    const name = exactText(record.name, `Row ${index + 2} name`, 120)
    const code = canonicalCode(record.code, name)
    if (codes.has(code)) {
      fail('SHOPIFY_PACKAGING_IMPORT_CODE_CONFLICT', `Package code ${code} appears more than once`)
    }
    codes.add(code)
    const shopifyPackageId = optionalExactText(
      record.shopify_package_id,
      `Row ${index + 2} Shopify package ID`,
      100,
    )
    if (shopifyPackageId && !SHIPPING_PACKAGE_GID.test(shopifyPackageId)) {
      fail(
        'SHOPIFY_PACKAGING_IMPORT_PACKAGE_ID_INVALID',
        `Row ${index + 2} Shopify package ID is invalid`,
      )
    }
    if (shopifyPackageId && externalIds.has(shopifyPackageId)) {
      fail(
        'SHOPIFY_PACKAGING_IMPORT_PACKAGE_ID_CONFLICT',
        `Shopify package ID ${shopifyPackageId} appears more than once`,
      )
    }
    if (shopifyPackageId) externalIds.add(shopifyPackageId)
    const type = packageType(record.type)
    const lengthUnit = exactText(record.length_unit, 'Length unit', 20).toUpperCase()
    const weightUnit = exactText(record.weight_unit, 'Weight unit', 20).toUpperCase()
    return Object.freeze({
      sourceExternalKey: shopifyPackageId || `code:${code}`,
      shopifyPackageId,
      code,
      name,
      ...type,
      ratedOuterLengthMm: lengthMillimeters(
        positiveDecimal(record.length, `Row ${index + 2} length`),
        lengthUnit,
      ),
      ratedOuterWidthMm: lengthMillimeters(
        positiveDecimal(record.width, `Row ${index + 2} width`),
        lengthUnit,
      ),
      ratedOuterHeightMm: lengthMillimeters(
        positiveDecimal(record.height, `Row ${index + 2} height`),
        lengthUnit,
      ),
      tareWeightGrams: weightGrams(
        positiveDecimal(record.empty_weight, `Row ${index + 2} empty weight`),
        weightUnit,
      ),
      isDefault: booleanValue(record.is_default),
    })
  })
  const defaultCount = rows.filter((row) => row.isDefault).length
  if (defaultCount > 1) {
    fail('SHOPIFY_PACKAGING_IMPORT_DEFAULT_CONFLICT', 'Only one Shopify package can be marked as default')
  }
  return Object.freeze({
    fileSha256: createHash('sha256').update(csv).digest('hex'),
    rows: Object.freeze(rows),
    totalCount: rows.length,
    defaultCount,
    warnings: Object.freeze([
      'Shopify package dimensions are stored as carrier-rated outer dimensions.',
      'Imported packages remain drafts until usable inner dimensions, capacity, cost, and warehouse stock are verified.',
      'Shopify ENVELOPE is staged as a padded-mailer draft and must be reviewed before activation.',
    ]),
    providerListApiAvailable: false,
    createsDraftsOnly: true,
    providerWrites: 0,
  })
}
