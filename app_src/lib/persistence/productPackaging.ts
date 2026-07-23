import type { PoolClient, QueryResultRow } from 'pg'
import type { ProductPackagingProfile } from '@/lib/crm/types'
import { recordAuditEvent } from '@/lib/auditWriter'
import { query } from '@/lib/persistence/postgres'

export type ProductPackagingProfileInput = {
  profileName: string
  packageType: ProductPackagingProfile['packageType']
  unitOfMeasure: string
  unitsPerPackage: number
  measurementSystem: ProductPackagingProfile['measurementSystem']
  lengthMm: number
  widthMm: number
  heightMm: number
  weightGrams: number
  active: boolean
  source: ProductPackagingProfile['source']
}

type PackagingRow = QueryResultRow & {
  id: string
  global_id: string
  product_id: string
  profile_key: string
  profile_name: string
  package_type: ProductPackagingProfile['packageType']
  unit_of_measure: string
  units_per_package: number
  measurement_system: ProductPackagingProfile['measurementSystem']
  length_mm: number
  width_mm: number
  height_mm: number
  weight_grams: number
  is_default: boolean
  active: boolean
  source: ProductPackagingProfile['source']
  row_version: string
  updated_at: Date
}

function profileFromRow(row: PackagingRow): ProductPackagingProfile {
  return {
    id: row.id,
    globalId: row.global_id,
    productId: row.product_id,
    profileKey: row.profile_key,
    profileName: row.profile_name,
    packageType: row.package_type,
    unitOfMeasure: row.unit_of_measure,
    unitsPerPackage: Number(row.units_per_package),
    measurementSystem: row.measurement_system,
    lengthMm: Number(row.length_mm),
    widthMm: Number(row.width_mm),
    heightMm: Number(row.height_mm),
    weightGrams: Number(row.weight_grams),
    isDefault: row.is_default,
    active: row.active,
    source: row.source,
    rowVersion: Number(row.row_version),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function clean(value: string, label: string, max: number) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

function positiveInteger(value: number, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`)
  }
  return value
}

function validatedProfile(input: ProductPackagingProfileInput): ProductPackagingProfileInput {
  const packageTypes = new Set<ProductPackagingProfile['packageType']>([
    'each', 'inner_pack', 'case', 'carton', 'pallet',
  ])
  const sources = new Set<ProductPackagingProfile['source']>(['manual', 'csv_import', 'provider_sync'])
  const measurementSystems = new Set<ProductPackagingProfile['measurementSystem']>(['metric', 'imperial'])
  if (!packageTypes.has(input.packageType)) throw new Error('Package type is invalid')
  if (!sources.has(input.source)) throw new Error('Package profile source is invalid')
  if (!measurementSystems.has(input.measurementSystem)) throw new Error('Package measurement system is invalid')
  return {
    profileName: clean(input.profileName, 'Package profile name', 120),
    packageType: input.packageType,
    unitOfMeasure: clean(input.unitOfMeasure, 'Package unit of measure', 50),
    unitsPerPackage: positiveInteger(input.unitsPerPackage, 'Units per package', 1_000_000),
    measurementSystem: input.measurementSystem,
    lengthMm: positiveInteger(input.lengthMm, 'Package length', 100_000),
    widthMm: positiveInteger(input.widthMm, 'Package width', 100_000),
    heightMm: positiveInteger(input.heightMm, 'Package height', 100_000),
    weightGrams: positiveInteger(input.weightGrams, 'Package weight', 100_000_000),
    active: input.active !== false,
    source: input.source,
  }
}

export async function upsertProductPackagingProfileWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    pipelineId: string
    productId: string
    actorEmail: string
    profile: ProductPackagingProfileInput
  },
): Promise<ProductPackagingProfile> {
  const profile = validatedProfile(input.profile)
  const product = await client.query<{ reference_code: string; name: string }>(
    `SELECT reference_code, name
     FROM crm_products
     WHERE pipeline_id = $1::uuid AND id = $2::uuid
     LIMIT 1
     FOR UPDATE`,
    [input.pipelineId, input.productId],
  )
  if (!product.rows[0]) throw new Error('Product was not found in the selected pipeline')

  const saved = await client.query<PackagingRow>(
    `INSERT INTO operations_product_package_profiles (
       organization_id, pipeline_id, product_id, profile_key, profile_name,
       package_type, unit_of_measure, units_per_package,
       measurement_system, length_mm, width_mm, height_mm, weight_grams,
       is_default, active, source, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'default', $4,
       $5, $6, $7, $8, $9, $10, $11, $12,
       true, $13, $14, $15, $15
     )
     ON CONFLICT (organization_id, product_id, profile_key) DO UPDATE SET
       profile_name = EXCLUDED.profile_name,
       package_type = EXCLUDED.package_type,
       unit_of_measure = EXCLUDED.unit_of_measure,
       units_per_package = EXCLUDED.units_per_package,
       measurement_system = EXCLUDED.measurement_system,
       length_mm = EXCLUDED.length_mm,
       width_mm = EXCLUDED.width_mm,
       height_mm = EXCLUDED.height_mm,
       weight_grams = EXCLUDED.weight_grams,
       is_default = true,
       active = EXCLUDED.active,
       source = EXCLUDED.source,
       row_version = operations_product_package_profiles.row_version + 1,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING id::text, global_id, product_id::text, profile_key, profile_name,
       package_type, unit_of_measure, units_per_package,
       measurement_system, length_mm, width_mm, height_mm, weight_grams,
       is_default, active, source, row_version::text, updated_at`,
    [
      input.organizationId,
      input.pipelineId,
      input.productId,
      profile.profileName,
      profile.packageType,
      profile.unitOfMeasure,
      profile.unitsPerPackage,
      profile.measurementSystem,
      profile.lengthMm,
      profile.widthMm,
      profile.heightMm,
      profile.weightGrams,
      profile.active,
      profile.source,
      input.actorEmail,
    ],
  )
  const result = profileFromRow(saved.rows[0])
  await recordAuditEvent({
    actor: input.actorEmail,
    eventType: 'operations.product_packaging.updated',
    aggregateType: 'operations.product_package_profile',
    aggregateId: result.globalId,
    subject: product.rows[0].name,
    organizationId: input.organizationId,
    eventKey: `operations:product-packaging:${result.globalId}:version:${result.rowVersion}`,
    payload: {
      productGlobalId: product.rows[0].reference_code,
      packageType: result.packageType,
      unitOfMeasure: result.unitOfMeasure,
      unitsPerPackage: result.unitsPerPackage,
      measurementSystem: result.measurementSystem,
      dimensionsMm: { length: result.lengthMm, width: result.widthMm, height: result.heightMm },
      weightGrams: result.weightGrams,
      active: result.active,
      source: result.source,
      rowVersion: result.rowVersion,
    },
  }, client)
  return result
}

export async function readProductPackagingProfilesInPostgres(input: {
  organizationId: string
  pipelineId: string
  productIds?: string[]
}): Promise<ProductPackagingProfile[]> {
  const productIds = [...new Set((input.productIds || []).filter(Boolean))]
  const result = await query<PackagingRow>(
    `SELECT id::text, global_id, product_id::text, profile_key, profile_name,
       package_type, unit_of_measure, units_per_package,
       measurement_system, length_mm, width_mm, height_mm, weight_grams,
       is_default, active, source, row_version::text, updated_at
     FROM operations_product_package_profiles
     WHERE organization_id = $1::uuid
       AND pipeline_id = $2::uuid
       AND ($3::uuid[] IS NULL OR product_id = ANY($3::uuid[]))
     ORDER BY product_id, active DESC, is_default DESC, lower(profile_name), id`,
    [input.organizationId, input.pipelineId, productIds.length ? productIds : null],
  )
  return result.rows.map(profileFromRow)
}

export async function readDefaultProductPackagingWithClient(
  client: PoolClient,
  input: { organizationId: string; pipelineId: string; productIds: string[] },
): Promise<Map<string, ProductPackagingProfile>> {
  const productIds = [...new Set(input.productIds.filter(Boolean))]
  if (!productIds.length) return new Map()
  const result = await client.query<PackagingRow>(
    `SELECT DISTINCT ON (product_id)
       id::text, global_id, product_id::text, profile_key, profile_name,
       package_type, unit_of_measure, units_per_package,
       measurement_system, length_mm, width_mm, height_mm, weight_grams,
       is_default, active, source, row_version::text, updated_at
     FROM operations_product_package_profiles
     WHERE organization_id = $1::uuid
       AND pipeline_id = $2::uuid
       AND product_id = ANY($3::uuid[])
       AND active = true
     ORDER BY product_id, is_default DESC, lower(profile_name), id`,
    [input.organizationId, input.pipelineId, productIds],
  )
  return new Map(result.rows.map((row) => [row.product_id, profileFromRow(row)]))
}
