import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  STARTER_PACKAGING_MATERIALS,
  packagingMaterialReadiness,
  type PackagingMaterial,
  type PackagingMaterialInput,
  type PackagingMaterialsWorkspace,
  type PackagingMaterialStock,
  type PackagingMaterialStockInput,
} from '@/lib/operations/packagingMaterials'
import type {
  ShopifyPackagingImportPreview,
} from '@/lib/operations/shopifyPackagingImport'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const HISTORY_WINDOW_DAYS = 365
const STARTER_ASSORTMENT_VERSION = 1

export class PackagingMaterialRequestError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

type WarehouseRow = QueryResultRow & {
  id: string
  global_id: string
  name: string
  status: 'active' | 'inactive'
}

type MaterialRow = QueryResultRow & {
  id: string
  global_id: string
  code: string
  name: string
  material_type: PackagingMaterial['materialType']
  inner_length_mm: number | null
  inner_width_mm: number | null
  inner_height_mm: number | null
  rated_outer_length_mm: number | null
  rated_outer_width_mm: number | null
  rated_outer_height_mm: number | null
  rated_outer_dimension_evidence_type:
    | Exclude<PackagingMaterial['dimensionEvidenceType'], 'unknown'>
    | null
  rated_outer_dimension_evidence_reference: string | null
  rated_outer_dimension_confirmed_at: Date | null
  rated_outer_dimension_confirmed_by: string | null
  dimension_basis: PackagingMaterial['dimensionBasis']
  dimension_evidence_type: PackagingMaterial['dimensionEvidenceType']
  dimension_evidence_reference: string | null
  dimension_confirmed_at: Date | null
  dimension_confirmed_by: string | null
  tare_weight_grams: number | null
  max_weight_grams: number | null
  unit_cost_minor: string | null
  currency: string | null
  status: PackagingMaterial['status']
  source: PackagingMaterial['source']
  source_account_global_id: string | null
  source_account_display_name: string | null
  source_external_package_id: string | null
  source_is_default: boolean
  source_imported_at: Date | null
  source_file_sha256: string | null
  row_version: string
  updated_at: Date
  stock_id: string | null
  stock_global_id: string | null
  warehouse_id: string | null
  warehouse_global_id: string | null
  warehouse_name: string | null
  warehouse_status: 'active' | 'inactive' | null
  is_available: boolean | null
  on_hand_quantity: number | null
  reorder_point_quantity: number | null
  reorder_to_quantity: number | null
  stock_row_version: string | null
  stock_updated_at: Date | null
}

type ReadinessRow = QueryResultRow & {
  shipped_demand_sample_count: string
  eligible_shipped_demand_sample_count: string
  missing_product_dimension_count: string
  missing_material_cost_count: string
  missing_warehouse_stock_count: string
  out_of_stock_availability_count: string
  eligible_material_count: string
  reorder_due_count: string
}

type SavedRow = QueryResultRow & {
  global_id: string
  row_version: string
  status: PackagingMaterial['status']
}

function integer(value: string | number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function optionalInteger(value: string | number | null): number | null {
  return value === null ? null : integer(value)
}

function iso(value: Date): string {
  return new Date(value).toISOString()
}

function optionalIso(value: Date | null): string | null {
  return value === null ? null : iso(value)
}

function stockFromRow(row: MaterialRow): PackagingMaterialStock | null {
  if (
    !row.stock_id
    || !row.stock_global_id
    || !row.warehouse_id
    || !row.warehouse_global_id
    || !row.warehouse_name
    || !row.warehouse_status
    || row.stock_row_version === null
    || !row.stock_updated_at
  ) return null

  const onHandQuantity = row.on_hand_quantity === null
    ? null
    : integer(row.on_hand_quantity)
  const reorderPointQuantity = row.reorder_point_quantity === null
    ? null
    : integer(row.reorder_point_quantity)
  const reorderToQuantity = row.reorder_to_quantity === null
    ? null
    : integer(row.reorder_to_quantity)
  const reorderRecommendedQuantity = (
    row.is_available
    && onHandQuantity !== null
    && reorderPointQuantity !== null
    && reorderToQuantity !== null
    && onHandQuantity <= reorderPointQuantity
  )
    ? Math.max(0, reorderToQuantity - onHandQuantity)
    : 0

  return {
    id: row.stock_id,
    globalId: row.stock_global_id,
    warehouseId: row.warehouse_id,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseName: row.warehouse_name,
    warehouseStatus: row.warehouse_status,
    isAvailable: row.is_available === true,
    onHandQuantity,
    reorderPointQuantity,
    reorderToQuantity,
    reorderRecommendedQuantity,
    rowVersion: integer(row.stock_row_version),
    updatedAt: iso(row.stock_updated_at),
  }
}

function materialsFromRows(rows: MaterialRow[]): PackagingMaterial[] {
  const grouped = new Map<string, PackagingMaterial>()
  for (const row of rows) {
    let material = grouped.get(row.global_id)
    if (!material) {
      material = {
        id: row.id,
        globalId: row.global_id,
        code: row.code,
        name: row.name,
        materialType: row.material_type,
        innerDimensionsMm: {
          length: optionalInteger(row.inner_length_mm),
          width: optionalInteger(row.inner_width_mm),
          height: optionalInteger(row.inner_height_mm),
        },
        ratedOuterDimensionsMm: {
          length: optionalInteger(row.rated_outer_length_mm),
          width: optionalInteger(row.rated_outer_width_mm),
          height: optionalInteger(row.rated_outer_height_mm),
        },
        ratedOuterDimensionEvidenceType:
          row.rated_outer_dimension_evidence_type,
        ratedOuterDimensionEvidenceReference:
          row.rated_outer_dimension_evidence_reference,
        ratedOuterDimensionConfirmedAt:
          optionalIso(row.rated_outer_dimension_confirmed_at),
        ratedOuterDimensionConfirmedBy:
          row.rated_outer_dimension_confirmed_by,
        dimensionBasis: row.dimension_basis,
        dimensionEvidenceType: row.dimension_evidence_type,
        dimensionEvidenceReference: row.dimension_evidence_reference,
        dimensionConfirmedAt: optionalIso(row.dimension_confirmed_at),
        dimensionConfirmedBy: row.dimension_confirmed_by,
        tareWeightGrams: optionalInteger(row.tare_weight_grams),
        maxWeightGrams: optionalInteger(row.max_weight_grams),
        unitCostMinor: row.unit_cost_minor === null
          ? null
          : integer(row.unit_cost_minor),
        currency: row.currency,
        status: row.status,
        source: row.source,
        shopifyImport: row.source === 'shopify_import'
          && row.source_account_global_id
          && row.source_account_display_name
          && row.source_imported_at
          && row.source_file_sha256
          ? {
            accountGlobalId: row.source_account_global_id,
            accountDisplayName: row.source_account_display_name,
            externalPackageId: row.source_external_package_id,
            isDefault: row.source_is_default,
            importedAt: iso(row.source_imported_at),
            fileSha256: row.source_file_sha256,
          }
          : null,
        rowVersion: integer(row.row_version),
        updatedAt: iso(row.updated_at),
        stock: [],
        readiness: {
          eligibleForCartonization: false,
          missing: [],
        },
      }
      grouped.set(row.global_id, material)
    }
    const stock = stockFromRow(row)
    if (stock) material.stock.push(stock)
  }
  return [...grouped.values()].map((material) => ({
    ...material,
    stock: material.stock.sort((left, right) => (
      left.warehouseName.localeCompare(right.warehouseName)
    )),
    readiness: packagingMaterialReadiness({
      status: material.status,
      innerDimensionsMm: material.innerDimensionsMm,
      dimensionBasis: material.dimensionBasis,
      dimensionEvidenceType: material.dimensionEvidenceType,
      dimensionEvidenceReference: material.dimensionEvidenceReference,
      dimensionConfirmedAt: material.dimensionConfirmedAt,
      tareWeightGrams: material.tareWeightGrams,
      maxWeightGrams: material.maxWeightGrams,
      unitCostMinor: material.unitCostMinor,
      stock: material.stock,
    }),
  }))
}

async function materialRows(
  organizationId: string,
  client?: PoolClient,
): Promise<MaterialRow[]> {
  const sql = `SELECT material.id::text, material.global_id, material.code,
      material.name, material.material_type, material.inner_length_mm,
      material.inner_width_mm, material.inner_height_mm,
      material.rated_outer_length_mm, material.rated_outer_width_mm,
      material.rated_outer_height_mm,
      material.rated_outer_dimension_evidence_type,
      material.rated_outer_dimension_evidence_reference,
      material.rated_outer_dimension_confirmed_at,
      material.rated_outer_dimension_confirmed_by,
      material.dimension_basis, material.dimension_evidence_type,
      material.dimension_evidence_reference, material.dimension_confirmed_at,
      material.dimension_confirmed_by,
      material.tare_weight_grams, material.max_weight_grams,
      material.unit_cost_minor::text, material.currency, material.status,
      material.source, source_account.global_id AS source_account_global_id,
      source_account.display_name AS source_account_display_name,
      material.source_external_package_id, material.source_is_default,
      material.source_imported_at, material.source_file_sha256,
      material.row_version::text, material.updated_at,
      stock.id::text AS stock_id, stock.global_id AS stock_global_id,
      stock.warehouse_id::text, warehouse.global_id AS warehouse_global_id,
      warehouse.name AS warehouse_name, warehouse.status AS warehouse_status,
      stock.is_available, stock.on_hand_quantity,
      stock.reorder_point_quantity, stock.reorder_to_quantity,
      stock.row_version::text AS stock_row_version,
      stock.updated_at AS stock_updated_at
    FROM operations_packaging_materials material
    LEFT JOIN operations_packaging_material_stock stock
      ON stock.organization_id = material.organization_id
     AND stock.packaging_material_id = material.id
    LEFT JOIN operations_warehouses warehouse
      ON warehouse.organization_id = stock.organization_id
     AND warehouse.id = stock.warehouse_id
    LEFT JOIN operations_integration_accounts source_account
      ON source_account.organization_id = material.organization_id
     AND source_account.id = material.source_integration_account_id
    WHERE material.organization_id = $1::uuid
      AND material.status <> 'retired'
    ORDER BY
      CASE material.status WHEN 'active' THEN 0 ELSE 1 END,
      material.material_type, lower(material.name), material.id,
      lower(warehouse.name), warehouse.id`
  const result = client
    ? await client.query<MaterialRow>(sql, [organizationId])
    : await query<MaterialRow>(sql, [organizationId])
  return result.rows
}

async function readiness(
  organizationId: string,
): Promise<PackagingMaterialsWorkspace['optimizerReadiness']> {
  const result = await query<ReadinessRow>(
    `WITH shipped_orders AS (
       SELECT DISTINCT orders.id
       FROM operations_orders orders
       JOIN operations_shipments shipment
         ON shipment.organization_id = orders.organization_id
        AND shipment.order_id = orders.id
       WHERE orders.organization_id = $1::uuid
         AND shipment.status <> 'voided'
         AND shipment.shipped_at >= now() - ($2::text || ' days')::interval
     ),
     shipped_line_readiness AS (
       SELECT shipped.id AS order_id,
              bool_and(profile.id IS NOT NULL) AS dimensions_complete
       FROM shipped_orders shipped
       JOIN operations_current_order_lines line
         ON line.organization_id = $1::uuid
        AND line.order_id = shipped.id
       LEFT JOIN LATERAL (
         SELECT candidate.id
         FROM operations_product_package_profiles candidate
         WHERE candidate.organization_id = line.organization_id
           AND candidate.pipeline_id = line.pipeline_id
           AND candidate.product_id = line.product_id
           AND candidate.active = true
           AND candidate.length_mm > 0
           AND candidate.width_mm > 0
           AND candidate.height_mm > 0
           AND candidate.weight_grams > 0
         ORDER BY candidate.is_default DESC, candidate.updated_at DESC, candidate.id
         LIMIT 1
       ) profile ON true
       GROUP BY shipped.id
     ),
     missing_products AS (
       SELECT count(DISTINCT line.product_id)::bigint AS count
       FROM shipped_orders shipped
       JOIN operations_current_order_lines line
         ON line.organization_id = $1::uuid
        AND line.order_id = shipped.id
       WHERE NOT EXISTS (
         SELECT 1
         FROM operations_product_package_profiles profile
         WHERE profile.organization_id = line.organization_id
           AND profile.pipeline_id = line.pipeline_id
           AND profile.product_id = line.product_id
           AND profile.active = true
           AND profile.length_mm > 0
           AND profile.width_mm > 0
           AND profile.height_mm > 0
           AND profile.weight_grams > 0
       )
     ),
     material_summary AS (
       SELECT
         count(*) FILTER (WHERE material.unit_cost_minor IS NULL)::bigint
           AS missing_cost,
         count(*) FILTER (
           WHERE material.status = 'active'
             AND material.dimension_basis = 'inner'
             AND material.dimension_evidence_type <> 'unknown'
             AND material.dimension_evidence_reference IS NOT NULL
             AND length(btrim(material.dimension_evidence_reference)) BETWEEN 1 AND 500
             AND material.dimension_confirmed_at IS NOT NULL
             AND material.inner_length_mm IS NOT NULL
             AND material.inner_width_mm IS NOT NULL
             AND material.inner_height_mm IS NOT NULL
             AND material.tare_weight_grams IS NOT NULL
             AND material.max_weight_grams IS NOT NULL
             AND material.max_weight_grams > material.tare_weight_grams
             AND material.unit_cost_minor IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM operations_packaging_material_stock stock
               JOIN operations_warehouses warehouse
                 ON warehouse.organization_id = stock.organization_id
                AND warehouse.id = stock.warehouse_id
                AND warehouse.status = 'active'
               WHERE stock.organization_id = material.organization_id
                 AND stock.packaging_material_id = material.id
                 AND stock.is_available = true
                 AND stock.on_hand_quantity > 0
             )
         )::bigint AS eligible_materials
       FROM operations_packaging_materials material
       WHERE material.organization_id = $1::uuid
         AND material.status <> 'retired'
     ),
     warehouse_stock_summary AS (
       SELECT
         count(*) FILTER (
           WHERE stock.id IS NULL OR stock.on_hand_quantity IS NULL
         )::bigint AS missing_stock,
         count(*) FILTER (
           WHERE stock.is_available = true
             AND stock.on_hand_quantity = 0
         )::bigint AS out_of_stock,
         count(*) FILTER (
           WHERE stock.is_available = true
             AND stock.on_hand_quantity IS NOT NULL
             AND stock.reorder_point_quantity IS NOT NULL
             AND stock.reorder_to_quantity IS NOT NULL
             AND stock.on_hand_quantity <= stock.reorder_point_quantity
             AND stock.reorder_to_quantity > stock.on_hand_quantity
         )::bigint AS reorder_due
       FROM operations_packaging_materials material
       CROSS JOIN operations_warehouses warehouse
       LEFT JOIN operations_packaging_material_stock stock
         ON stock.organization_id = material.organization_id
        AND stock.packaging_material_id = material.id
        AND stock.warehouse_id = warehouse.id
       WHERE material.organization_id = $1::uuid
         AND material.status <> 'retired'
         AND warehouse.organization_id = $1::uuid
         AND warehouse.status = 'active'
     )
     SELECT
       (SELECT count(*) FROM shipped_line_readiness)::text
         AS shipped_demand_sample_count,
       (SELECT count(*) FROM shipped_line_readiness
        WHERE dimensions_complete)::text
         AS eligible_shipped_demand_sample_count,
       missing_products.count::text AS missing_product_dimension_count,
       material_summary.missing_cost::text AS missing_material_cost_count,
       COALESCE(warehouse_stock_summary.missing_stock, 0)::text
         AS missing_warehouse_stock_count,
       COALESCE(warehouse_stock_summary.out_of_stock, 0)::text
         AS out_of_stock_availability_count,
       material_summary.eligible_materials::text AS eligible_material_count,
       COALESCE(warehouse_stock_summary.reorder_due, 0)::text
         AS reorder_due_count
     FROM missing_products
     CROSS JOIN material_summary
     LEFT JOIN warehouse_stock_summary ON true`,
    [organizationId, HISTORY_WINDOW_DAYS],
  )
  const row = result.rows[0]
  return {
    historyWindowDays: HISTORY_WINDOW_DAYS,
    shippedDemandSampleCount: integer(row?.shipped_demand_sample_count || 0),
    eligibleShippedDemandSampleCount: integer(
      row?.eligible_shipped_demand_sample_count || 0,
    ),
    missingProductDimensionCount: integer(
      row?.missing_product_dimension_count || 0,
    ),
    missingMaterialCostCount: integer(row?.missing_material_cost_count || 0),
    missingWarehouseStockCount: integer(
      row?.missing_warehouse_stock_count || 0,
    ),
    outOfStockAvailabilityCount: integer(
      row?.out_of_stock_availability_count || 0,
    ),
    eligibleMaterialCount: integer(row?.eligible_material_count || 0),
    reorderDueCount: integer(row?.reorder_due_count || 0),
  }
}

export async function readPackagingMaterialsWorkspaceFromPostgres(input: {
  organizationId: string
  canView: boolean
  canManage: boolean
}): Promise<PackagingMaterialsWorkspace> {
  if (!input.canView) {
    throw new PackagingMaterialRequestError(
      'PACKAGING_MATERIAL_VIEW_REQUIRED',
      'You do not have permission to view packaging materials',
      403,
    )
  }
  const [warehouseResult, rows, optimizerReadiness, shopifyAccounts] = await Promise.all([
    query<WarehouseRow>(
      `SELECT id::text, global_id, name, status
       FROM operations_warehouses
       WHERE organization_id = $1::uuid
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, lower(name), id`,
      [input.organizationId],
    ),
    materialRows(input.organizationId),
    readiness(input.organizationId),
    query<{
      global_id: string
      display_name: string
      canonical_domain: string
    }>(
      `SELECT account.global_id, account.display_name,
              account.configuration->>'shopDomain' AS canonical_domain
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version =
              account.commerce_credential_generation
        AND credential.external_account_id = account.external_account_id
        AND credential.auth_mode = 'shopify_client_credentials'
        AND credential.verification_status = 'verified'
       WHERE account.organization_id = $1::uuid
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
         AND account.status = 'active'
         AND account.configuration->>'shopDomain' ~
               '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$'
       ORDER BY lower(account.display_name), account.id`,
      [input.organizationId],
    ),
  ])
  return {
    capabilities: {
      canView: input.canView,
      canManage: input.canManage,
    },
    warehouses: warehouseResult.rows.map((warehouse) => ({
      id: warehouse.id,
      globalId: warehouse.global_id,
      name: warehouse.name,
      status: warehouse.status,
    })),
    materials: materialsFromRows(rows),
    shopifyPackageImport: {
      providerListApiAvailable: false,
      importMethod: 'csv',
      accounts: shopifyAccounts.rows.map((account) => ({
        globalId: account.global_id,
        displayName: account.display_name,
        canonicalDomain: account.canonical_domain,
      })),
    },
    optimizerReadiness,
  }
}

async function assertActivationReady(
  client: PoolClient,
  organizationId: string,
  materialId: string,
) {
  const configured = await client.query<{
    evidence_ready: boolean
    stock_ready: boolean
  }>(
    `SELECT
       EXISTS (
         SELECT 1
         FROM operations_packaging_materials material
         WHERE material.organization_id = $1::uuid
           AND material.id = $2::uuid
           AND material.dimension_basis = 'inner'
           AND material.dimension_evidence_type <> 'unknown'
           AND material.dimension_evidence_reference IS NOT NULL
           AND length(btrim(material.dimension_evidence_reference)) BETWEEN 1 AND 500
           AND material.dimension_confirmed_at IS NOT NULL
       ) AS evidence_ready,
       EXISTS (
       SELECT 1
       FROM operations_packaging_material_stock stock
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = stock.organization_id
        AND warehouse.id = stock.warehouse_id
        AND warehouse.status = 'active'
       WHERE stock.organization_id = $1::uuid
         AND stock.packaging_material_id = $2::uuid
         AND stock.on_hand_quantity IS NOT NULL
     ) AS stock_ready`,
    [organizationId, materialId],
  )
  if (!configured.rows[0]?.evidence_ready) {
    throw new PackagingMaterialRequestError(
      'PACKAGING_MATERIAL_EVIDENCE_REQUIRED',
      'Retain the factual dimension evidence, reference, and confirmation before activation',
      409,
    )
  }
  if (!configured.rows[0]?.stock_ready) {
    throw new PackagingMaterialRequestError(
      'PACKAGING_MATERIAL_STOCK_REQUIRED',
      'Record on-hand stock for at least one active warehouse before activation',
      409,
    )
  }
}

export async function savePackagingMaterialInPostgres(input: {
  organizationId: string
  actorEmail: string
  material: PackagingMaterialInput
}) {
  try {
    return await withTransaction(async (client) => {
      let materialId: string | null = null
      let previousStatus: PackagingMaterial['status'] | null = null
      if (input.material.globalId) {
        const existing = await client.query<{
          id: string
          row_version: string
          status: PackagingMaterial['status']
          source: PackagingMaterial['source']
          code: string
        }>(
          `SELECT id::text, row_version::text, status, source, code
           FROM operations_packaging_materials
           WHERE organization_id = $1::uuid AND global_id = $2
           FOR UPDATE`,
          [input.organizationId, input.material.globalId],
        )
        const row = existing.rows[0]
        if (!row) {
          throw new PackagingMaterialRequestError(
            'PACKAGING_MATERIAL_NOT_FOUND',
            'Packaging material was not found',
            404,
          )
        }
        if (integer(row.row_version) !== input.material.expectedRowVersion) {
          throw new PackagingMaterialRequestError(
            'PACKAGING_MATERIAL_VERSION_CONFLICT',
            'Packaging material changed. Refresh and try again.',
            409,
          )
        }
        materialId = row.id
        previousStatus = row.status
        if (row.status === 'retired') {
          throw new PackagingMaterialRequestError(
            'PACKAGING_MATERIAL_RETIRED',
            'Retired packaging materials cannot be restored through the generic editor',
            409,
          )
        }
        if (
          (row.source === 'shopify_import'
            || input.material.source === 'shopify_import')
          && row.source !== input.material.source
        ) {
          throw new PackagingMaterialRequestError(
            'PACKAGING_MATERIAL_SOURCE_IMMUTABLE',
            'Shopify import provenance can only be established or changed by the verified import workflow',
            409,
          )
        }
        if (
          row.source === 'shopify_import'
          && row.code !== input.material.code
        ) {
          throw new PackagingMaterialRequestError(
            'PACKAGING_MATERIAL_SHOPIFY_CODE_IMMUTABLE',
            'A Shopify-imported package code is stable so later imports can update the same material',
            409,
          )
        }
      } else if (input.material.source === 'shopify_import') {
        throw new PackagingMaterialRequestError(
          'PACKAGING_MATERIAL_SOURCE_IMMUTABLE',
          'Create Shopify package materials through the verified import workflow',
          409,
        )
      }

      let saved: SavedRow
      if (materialId) {
        const updated = await client.query<SavedRow>(
          `UPDATE operations_packaging_materials
           SET code = $3,
               name = $4,
               material_type = $5,
               inner_length_mm = $6,
               inner_width_mm = $7,
               inner_height_mm = $8,
               rated_outer_length_mm = $9,
               rated_outer_width_mm = $10,
               rated_outer_height_mm = $11,
               rated_outer_dimension_evidence_type = $12,
               rated_outer_dimension_evidence_reference = $13,
               rated_outer_dimension_confirmed_at = CASE
                 WHEN $12::text IS NOT NULL
                   THEN CASE
                     WHEN rated_outer_length_mm IS DISTINCT FROM $9
                       OR rated_outer_width_mm IS DISTINCT FROM $10
                       OR rated_outer_height_mm IS DISTINCT FROM $11
                       OR rated_outer_dimension_evidence_type
                         IS DISTINCT FROM $12
                       OR rated_outer_dimension_evidence_reference
                         IS DISTINCT FROM $13
                       THEN now()
                     ELSE COALESCE(
                       rated_outer_dimension_confirmed_at,
                       now()
                     )
                   END
                 ELSE NULL
               END,
               rated_outer_dimension_confirmed_by = CASE
                 WHEN $12::text IS NOT NULL
                   THEN CASE
                     WHEN rated_outer_length_mm IS DISTINCT FROM $9
                       OR rated_outer_width_mm IS DISTINCT FROM $10
                       OR rated_outer_height_mm IS DISTINCT FROM $11
                       OR rated_outer_dimension_evidence_type
                         IS DISTINCT FROM $12
                       OR rated_outer_dimension_evidence_reference
                         IS DISTINCT FROM $13
                       THEN $22
                     ELSE COALESCE(
                       rated_outer_dimension_confirmed_by,
                       $22
                     )
                   END
                 ELSE NULL
               END,
               dimension_basis = $14,
               dimension_evidence_type = $15,
               dimension_evidence_reference = $16,
               dimension_confirmed_at = CASE
                 WHEN $15 <> 'unknown'
                   THEN CASE
                     WHEN inner_length_mm IS DISTINCT FROM $6
                       OR inner_width_mm IS DISTINCT FROM $7
                       OR inner_height_mm IS DISTINCT FROM $8
                       OR dimension_basis IS DISTINCT FROM $14
                       OR dimension_evidence_type IS DISTINCT FROM $15
                       OR dimension_evidence_reference IS DISTINCT FROM $16
                       THEN now()
                     ELSE COALESCE(dimension_confirmed_at, now())
                   END
                 ELSE NULL
               END,
               dimension_confirmed_by = CASE
                 WHEN $15 <> 'unknown'
                   THEN CASE
                     WHEN inner_length_mm IS DISTINCT FROM $6
                       OR inner_width_mm IS DISTINCT FROM $7
                       OR inner_height_mm IS DISTINCT FROM $8
                       OR dimension_basis IS DISTINCT FROM $14
                       OR dimension_evidence_type IS DISTINCT FROM $15
                       OR dimension_evidence_reference IS DISTINCT FROM $16
                       THEN $22
                     ELSE COALESCE(dimension_confirmed_by, $22)
                   END
                 ELSE NULL
               END,
               tare_weight_grams = $17,
               max_weight_grams = $18,
               unit_cost_minor = $19,
               currency = $20,
               status = $21,
               source = $23,
               row_version = row_version + 1,
               updated_by = $22,
               updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid
           RETURNING global_id, row_version::text, status`,
          [
            input.organizationId,
            materialId,
            input.material.code,
            input.material.name,
            input.material.materialType,
            input.material.innerLengthMm,
            input.material.innerWidthMm,
            input.material.innerHeightMm,
            input.material.ratedOuterLengthMm ?? null,
            input.material.ratedOuterWidthMm ?? null,
            input.material.ratedOuterHeightMm ?? null,
            input.material.ratedOuterDimensionEvidenceType ?? null,
            input.material.ratedOuterDimensionEvidenceReference ?? null,
            input.material.dimensionBasis,
            input.material.dimensionEvidenceType,
            input.material.dimensionEvidenceReference,
            input.material.tareWeightGrams,
            input.material.maxWeightGrams,
            input.material.unitCostMinor,
            input.material.currency,
            input.material.status,
            input.actorEmail,
            input.material.source,
          ],
        )
        saved = updated.rows[0]
      } else {
        const inserted = await client.query<SavedRow & { id: string }>(
          `INSERT INTO operations_packaging_materials (
             organization_id, code, name, material_type,
             inner_length_mm, inner_width_mm, inner_height_mm,
             rated_outer_length_mm, rated_outer_width_mm,
             rated_outer_height_mm,
             rated_outer_dimension_evidence_type,
             rated_outer_dimension_evidence_reference,
             rated_outer_dimension_confirmed_at,
             rated_outer_dimension_confirmed_by,
             dimension_basis, dimension_evidence_type,
             dimension_evidence_reference, dimension_confirmed_at,
             dimension_confirmed_by,
             tare_weight_grams, max_weight_grams, unit_cost_minor, currency,
             status, source, created_by, updated_by
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12,
             CASE WHEN $11::text IS NOT NULL THEN now() ELSE NULL END,
             CASE WHEN $11::text IS NOT NULL THEN $21 ELSE NULL END,
             $13, $14, $15,
             CASE WHEN $14 <> 'unknown'
               THEN now() ELSE NULL END,
             CASE WHEN $14 <> 'unknown'
               THEN $21 ELSE NULL END,
             $16, $17, $18, $19, $20, $22, $21, $21
           )
           RETURNING id::text, global_id, row_version::text, status`,
          [
            input.organizationId,
            input.material.code,
            input.material.name,
            input.material.materialType,
            input.material.innerLengthMm,
            input.material.innerWidthMm,
            input.material.innerHeightMm,
            input.material.ratedOuterLengthMm ?? null,
            input.material.ratedOuterWidthMm ?? null,
            input.material.ratedOuterHeightMm ?? null,
            input.material.ratedOuterDimensionEvidenceType ?? null,
            input.material.ratedOuterDimensionEvidenceReference ?? null,
            input.material.dimensionBasis,
            input.material.dimensionEvidenceType,
            input.material.dimensionEvidenceReference,
            input.material.tareWeightGrams,
            input.material.maxWeightGrams,
            input.material.unitCostMinor,
            input.material.currency,
            input.material.status,
            input.actorEmail,
            input.material.source,
          ],
        )
        const insertedRow = inserted.rows[0]
        materialId = insertedRow.id
        saved = insertedRow
      }

      if (input.material.status === 'active') {
        await assertActivationReady(client, input.organizationId, materialId)
      }

      const eventType = previousStatus === null
        ? 'operations.packaging_material.created'
        : input.material.status === 'active' && previousStatus !== 'active'
          ? 'operations.packaging_material.activated'
          : 'operations.packaging_material.updated'
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType,
        aggregateType: 'operations.packaging_material',
        aggregateId: saved.global_id,
        subject: input.material.name,
        organizationId: input.organizationId,
        eventKey: `${eventType}:${saved.global_id}:${saved.row_version}`,
        payload: {
          materialGlobalId: saved.global_id,
          code: input.material.code,
          materialType: input.material.materialType,
          dimensionsMm: {
            length: input.material.innerLengthMm,
            width: input.material.innerWidthMm,
            height: input.material.innerHeightMm,
          },
          ratedOuterDimensionsMm: {
            length: input.material.ratedOuterLengthMm ?? null,
            width: input.material.ratedOuterWidthMm ?? null,
            height: input.material.ratedOuterHeightMm ?? null,
          },
          ratedOuterDimensionEvidenceType:
            input.material.ratedOuterDimensionEvidenceType ?? null,
          ratedOuterDimensionEvidenceReference:
            input.material.ratedOuterDimensionEvidenceReference ?? null,
          dimensionBasis: input.material.dimensionBasis,
          dimensionEvidenceType: input.material.dimensionEvidenceType,
          dimensionEvidenceReference: input.material.dimensionEvidenceReference,
          tareWeightGrams: input.material.tareWeightGrams,
          maxWeightGrams: input.material.maxWeightGrams,
          unitCostMinor: input.material.unitCostMinor,
          currency: input.material.currency,
          status: input.material.status,
          source: input.material.source,
          rowVersion: integer(saved.row_version),
        },
      }, client)

      return {
        globalId: saved.global_id,
        rowVersion: integer(saved.row_version),
        status: saved.status,
      }
    })
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === '23505'
    ) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_CODE_CONFLICT',
        'Packaging material code already exists in this organization',
        409,
      )
    }
    throw error
  }
}

export async function savePackagingMaterialStockInPostgres(input: {
  organizationId: string
  actorEmail: string
  stock: PackagingMaterialStockInput
}) {
  return withTransaction(async (client) => {
    const material = await client.query<{
      id: string
      name: string
      status: PackagingMaterial['status']
    }>(
      `SELECT id::text, name, status
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid AND global_id = $2
       FOR UPDATE`,
      [input.organizationId, input.stock.materialGlobalId],
    )
    if (!material.rows[0]) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_NOT_FOUND',
        'Packaging material was not found',
        404,
      )
    }
    if (material.rows[0].status === 'retired') {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_RETIRED',
        'Retired packaging materials cannot receive warehouse stock updates',
        409,
      )
    }
    const warehouse = await client.query<{ id: string; global_id: string; name: string }>(
      `SELECT id::text, global_id, name
       FROM operations_warehouses
       WHERE organization_id = $1::uuid AND id = $2::uuid
       FOR SHARE`,
      [input.organizationId, input.stock.warehouseId],
    )
    if (!warehouse.rows[0]) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_WAREHOUSE_NOT_FOUND',
        'Warehouse was not found in this organization',
        404,
      )
    }

    const existing = await client.query<{
      id: string
      row_version: string
    }>(
      `SELECT id::text, row_version::text
       FROM operations_packaging_material_stock
       WHERE organization_id = $1::uuid
         AND packaging_material_id = $2::uuid
         AND warehouse_id = $3::uuid
       FOR UPDATE`,
      [input.organizationId, material.rows[0].id, input.stock.warehouseId],
    )
    const current = existing.rows[0]
    if (
      current
      && integer(current.row_version) !== input.stock.expectedRowVersion
    ) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_STOCK_VERSION_CONFLICT',
        'Warehouse packaging stock changed. Refresh and try again.',
        409,
      )
    }
    if (!current && input.stock.expectedRowVersion !== undefined) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_STOCK_VERSION_CONFLICT',
        'Warehouse packaging stock no longer exists. Refresh and try again.',
        409,
      )
    }
    if (current) {
      const claimResult = await client.query<{
        active_claimed_quantity: string
      }>(
        `SELECT COALESCE(sum(quantity), 0)::text
                  AS active_claimed_quantity
         FROM operations_packaging_material_claims
         WHERE organization_id = $1::uuid
           AND packaging_material_id = $2::uuid
           AND warehouse_id = $3::uuid
           AND status = 'active'`,
        [
          input.organizationId,
          material.rows[0].id,
          input.stock.warehouseId,
        ],
      )
      const activeClaimedQuantity = integer(
        claimResult.rows[0]?.active_claimed_quantity || '0',
      )
      if (
        activeClaimedQuantity > 0
        && (
          input.stock.isAvailable !== true
          || input.stock.onHandQuantity === null
          || input.stock.onHandQuantity < activeClaimedQuantity
        )
      ) {
        throw new PackagingMaterialRequestError(
          'PACKAGING_MATERIAL_STOCK_ACTIVE_CLAIMS_CONFLICT',
          `Warehouse packaging stock must remain available with at least ${activeClaimedQuantity} unit${activeClaimedQuantity === 1 ? '' : 's'} while accepted fulfillment plans hold active claims`,
          409,
        )
      }
    }

    const saved = current
      ? await client.query<SavedRow>(
        `UPDATE operations_packaging_material_stock
         SET is_available = $3,
             on_hand_quantity = $4,
             reorder_point_quantity = $5,
             reorder_to_quantity = $6,
             row_version = row_version + 1,
             updated_by = $7,
             updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid
         RETURNING global_id, row_version::text, 'draft'::text AS status`,
        [
          input.organizationId,
          current.id,
          input.stock.isAvailable,
          input.stock.onHandQuantity,
          input.stock.reorderPointQuantity,
          input.stock.reorderToQuantity,
          input.actorEmail,
        ],
      )
      : await client.query<SavedRow>(
        `INSERT INTO operations_packaging_material_stock (
           organization_id, packaging_material_id, warehouse_id,
           is_available, on_hand_quantity, reorder_point_quantity,
           reorder_to_quantity, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $8
         )
         RETURNING global_id, row_version::text, 'draft'::text AS status`,
        [
          input.organizationId,
          material.rows[0].id,
          input.stock.warehouseId,
          input.stock.isAvailable,
          input.stock.onHandQuantity,
          input.stock.reorderPointQuantity,
          input.stock.reorderToQuantity,
          input.actorEmail,
        ],
      )

    const row = saved.rows[0]
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: current
        ? 'operations.packaging_material.stock_updated'
        : 'operations.packaging_material.stock_created',
      aggregateType: 'operations.packaging_material',
      aggregateId: input.stock.materialGlobalId,
      subject: material.rows[0].name,
      organizationId: input.organizationId,
      eventKey: `operations:packaging-material-stock:${row.global_id}:version:${row.row_version}`,
      payload: {
        stockGlobalId: row.global_id,
        materialGlobalId: input.stock.materialGlobalId,
        warehouseGlobalId: warehouse.rows[0].global_id,
        isAvailable: input.stock.isAvailable,
        onHandQuantity: input.stock.onHandQuantity,
        reorderPointQuantity: input.stock.reorderPointQuantity,
        reorderToQuantity: input.stock.reorderToQuantity,
        rowVersion: integer(row.row_version),
      },
    }, client)

    return {
      globalId: row.global_id,
      materialGlobalId: input.stock.materialGlobalId,
      warehouseGlobalId: warehouse.rows[0].global_id,
      rowVersion: integer(row.row_version),
    }
  })
}

export async function removePackagingMaterialInPostgres(input: {
  organizationId: string
  actorEmail: string
  materialGlobalId: string
  expectedRowVersion: number
  idempotencyKey: string
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `packaging-material-remove:${input.organizationId}:${input.materialGlobalId}`,
    )
    const commandType = 'operations.packaging_material.remove'
    const requestHash = createHash('sha256').update(JSON.stringify({
      version: 1,
      materialGlobalId: input.materialGlobalId,
      expectedRowVersion: input.expectedRowVersion,
    })).digest('hex')
    const existingReceipt = await client.query<{
      request_hash: string
      status: string
      result_payload: Record<string, unknown> | null
    }>(
      `SELECT request_hash, status, result_payload
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [input.organizationId, commandType, input.idempotencyKey],
    )
    const priorReceipt = existingReceipt.rows[0]
    if (priorReceipt) {
      if (priorReceipt.request_hash !== requestHash) {
        throw new PackagingMaterialRequestError(
          'PACKAGING_MATERIAL_IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used for another removal',
          409,
        )
      }
      if (priorReceipt.status === 'succeeded' && priorReceipt.result_payload) {
        return { ...priorReceipt.result_payload, replayed: true }
      }
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_COMMAND_IN_PROGRESS',
        'Packaging material removal is already in progress',
        409,
      )
    }
    const createdReceipt = await client.query<{ id: string }>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id
       ) VALUES ($1::uuid, $2, $3, $4, $5, 'processing', gen_random_uuid())
       RETURNING id::text`,
      [
        input.organizationId,
        commandType,
        input.idempotencyKey,
        requestHash,
        input.actorEmail,
      ],
    )
    const currentResult = await client.query<{
      id: string
      global_id: string
      code: string
      name: string
      row_version: string
      status: PackagingMaterial['status']
    }>(
      `SELECT id::text, global_id, code, name, row_version::text, status
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid AND global_id = $2
       FOR UPDATE`,
      [input.organizationId, input.materialGlobalId],
    )
    const current = currentResult.rows[0]
    if (!current || current.status === 'retired') {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_NOT_FOUND',
        'Packaging material was not found',
        404,
      )
    }
    if (integer(current.row_version) !== input.expectedRowVersion) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_VERSION_CONFLICT',
        'Packaging material changed. Refresh and try again.',
        409,
      )
    }
    const activeClaims = await client.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity), 0)::text AS quantity
       FROM operations_packaging_material_claims
       WHERE organization_id = $1::uuid
         AND packaging_material_id = $2::uuid
         AND status = 'active'`,
      [input.organizationId, current.id],
    )
    if (integer(activeClaims.rows[0]?.quantity || 0) > 0) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_ACTIVE_CLAIMS_CONFLICT',
        'Release or complete active fulfillment plans that claim this material before removing it',
        409,
      )
    }

    let outcome: 'deleted' | 'retired' = 'deleted'
    await client.query('SAVEPOINT remove_packaging_material')
    try {
      await client.query(
        `DELETE FROM operations_packaging_material_stock
         WHERE organization_id = $1::uuid
           AND packaging_material_id = $2::uuid`,
        [input.organizationId, current.id],
      )
      await client.query(
        `DELETE FROM operations_packaging_materials
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [input.organizationId, current.id],
      )
      await client.query('RELEASE SAVEPOINT remove_packaging_material')
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT remove_packaging_material')
      if ((error as { code?: string }).code !== '23503') {
        await client.query('RELEASE SAVEPOINT remove_packaging_material')
        throw error
      }
      await client.query('RELEASE SAVEPOINT remove_packaging_material')
      outcome = 'retired'
      await client.query(
        `UPDATE operations_packaging_material_stock
         SET is_available = false, row_version = row_version + 1,
             updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid
           AND packaging_material_id = $2::uuid`,
        [input.organizationId, current.id, input.actorEmail],
      )
      await client.query(
        `UPDATE operations_packaging_materials
         SET status = 'retired', row_version = row_version + 1,
             source_is_default = false,
             updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [input.organizationId, current.id, input.actorEmail],
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: outcome === 'deleted'
        ? 'operations.packaging_material.deleted'
        : 'operations.packaging_material.retired',
      aggregateType: 'operations.packaging_material',
      aggregateId: current.global_id,
      subject: current.name,
      organizationId: input.organizationId,
      eventKey: `operations:packaging-material:${current.global_id}:${outcome}:v${current.row_version}`,
      payload: {
        materialGlobalId: current.global_id,
        code: current.code,
        outcome,
        providerWrites: 0,
      },
    }, client)
    const payload = {
      materialGlobalId: current.global_id,
      outcome,
      providerWrites: 0 as const,
      replayed: false,
    }
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_global_id = $2,
           result_payload = $3::jsonb, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [createdReceipt.rows[0].id, current.global_id, JSON.stringify(payload)],
    )
    return payload
  })
}

function shopifyImportRequestHash(input: {
  accountGlobalId: string
  preview: ShopifyPackagingImportPreview
}) {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    accountGlobalId: input.accountGlobalId,
    fileSha256: input.preview.fileSha256,
    rows: input.preview.rows,
  })).digest('hex')
}

export async function importShopifyPackagingMaterialsInPostgres(input: {
  organizationId: string
  actorEmail: string
  accountGlobalId: string
  idempotencyKey: string
  preview: ShopifyPackagingImportPreview
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `packaging-material-shopify-import:${input.organizationId}:${input.accountGlobalId}`,
    )
    const accountResult = await client.query<{
      id: string
      global_id: string
      display_name: string
      external_account_id: string
      shop_domain: string
    }>(
      `SELECT account.id::text, account.global_id, account.display_name,
              account.external_account_id,
              account.configuration->>'shopDomain' AS shop_domain
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version =
              account.commerce_credential_generation
        AND credential.external_account_id = account.external_account_id
        AND credential.auth_mode = 'shopify_client_credentials'
        AND credential.verification_status = 'verified'
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
         AND account.status = 'active'
         AND account.configuration->>'shopDomain' ~
               '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$'
       FOR SHARE`,
      [input.organizationId, input.accountGlobalId],
    )
    const account = accountResult.rows[0]
    if (!account) {
      throw new PackagingMaterialRequestError(
        'SHOPIFY_PACKAGING_IMPORT_ACCOUNT_UNAVAILABLE',
        'Select a current verified Shopify connection in this workspace',
        409,
      )
    }
    const commandType = 'operations.packaging_materials.import_shopify_csv'
    const requestHash = shopifyImportRequestHash(input)
    const existing = await client.query<{
      request_hash: string
      status: string
      result_payload: Record<string, unknown> | null
    }>(
      `SELECT request_hash, status, result_payload
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [input.organizationId, commandType, input.idempotencyKey],
    )
    const receipt = existing.rows[0]
    if (receipt) {
      if (receipt.request_hash !== requestHash) {
        throw new PackagingMaterialRequestError(
          'PACKAGING_MATERIAL_IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used for a different Shopify package file',
          409,
        )
      }
      if (receipt.status === 'succeeded' && receipt.result_payload) {
        return { ...receipt.result_payload, replayed: true }
      }
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_COMMAND_IN_PROGRESS',
        'Shopify package import is already in progress',
        409,
      )
    }
    const createdReceipt = await client.query<{ id: string }>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id
       ) VALUES ($1::uuid, $2, $3, $4, $5, 'processing', gen_random_uuid())
       RETURNING id::text`,
      [
        input.organizationId,
        commandType,
        input.idempotencyKey,
        requestHash,
        input.actorEmail,
      ],
    )
    if (input.preview.defaultCount === 1) {
      await client.query(
        `UPDATE operations_packaging_materials
         SET source_is_default = false, row_version = row_version + 1,
             updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid
           AND source_integration_account_id = $2::uuid
           AND source = 'shopify_import'
           AND source_is_default = true
           AND source_external_key <> $4`,
        [
          input.organizationId,
          account.id,
          input.actorEmail,
          input.preview.rows.find((row) => row.isDefault)!.sourceExternalKey,
        ],
      )
    }
    let createdCount = 0
    let updatedCount = 0
    const materialGlobalIds: string[] = []
    for (const row of input.preview.rows) {
      const codeOwner = await client.query<{
        id: string
        global_id: string
        status: PackagingMaterial['status']
        source: string
        source_integration_account_id: string | null
        source_external_key: string | null
      }>(
        `SELECT id::text, global_id, status, source,
                source_integration_account_id::text, source_external_key
         FROM operations_packaging_materials
         WHERE organization_id = $1::uuid AND code = $2
         FOR UPDATE`,
        [input.organizationId, row.code],
      )
      const existingMaterial = codeOwner.rows[0]
      const sourceOwner = await client.query<{
        id: string
        code: string
        source: string
      }>(
        `SELECT id::text, code, source
         FROM operations_packaging_materials
         WHERE organization_id = $1::uuid
           AND source_integration_account_id = $2::uuid
           AND source_external_key = $3
         FOR UPDATE`,
        [input.organizationId, account.id, row.sourceExternalKey],
      )
      const existingSource = sourceOwner.rows[0]
      if (existingMaterial?.status === 'retired') {
        throw new PackagingMaterialRequestError(
          'SHOPIFY_PACKAGING_IMPORT_RETIRED_CONFLICT',
          `Packaging material ${row.code} was retired and cannot be restored by an import. Remove it from the file or use a new Shopify package identity.`,
          409,
        )
      }
      if (
        existingSource
        && (
          existingSource.source !== 'shopify_import'
          || existingSource.code !== row.code
        )
      ) {
        throw new PackagingMaterialRequestError(
          'SHOPIFY_PACKAGING_IMPORT_SOURCE_CONFLICT',
          `Shopify package ${row.sourceExternalKey} was previously imported as code ${existingSource.code}. Keep that code or remove the prior draft first.`,
          409,
        )
      }
      if (
        existingMaterial
        && (
          existingMaterial.source !== 'shopify_import'
          || existingMaterial.source_integration_account_id !== account.id
          || existingMaterial.source_external_key !== row.sourceExternalKey
        )
      ) {
        throw new PackagingMaterialRequestError(
          'SHOPIFY_PACKAGING_IMPORT_CODE_CONFLICT',
          `Packaging material code ${row.code} already belongs to a different material`,
          409,
        )
      }
      if (
        existingSource
        && existingMaterial
        && existingSource.id !== existingMaterial.id
      ) {
        throw new PackagingMaterialRequestError(
          'SHOPIFY_PACKAGING_IMPORT_SOURCE_CONFLICT',
          `Shopify package ${row.sourceExternalKey} conflicts with packaging material code ${row.code}`,
          409,
        )
      }
      const saved = existingMaterial
        ? await client.query<{ global_id: string }>(
          `UPDATE operations_packaging_materials
           SET name = $4, material_type = $5,
               rated_outer_length_mm = $6,
               rated_outer_width_mm = $7,
               rated_outer_height_mm = $8,
               rated_outer_dimension_evidence_type = 'provider',
               rated_outer_dimension_evidence_reference = $9,
               rated_outer_dimension_confirmed_at = now(),
               rated_outer_dimension_confirmed_by = $10,
               tare_weight_grams = $11,
               source_external_package_id = $12,
               source_is_default = $13,
               source_imported_at = now(), source_file_sha256 = $14,
               status = 'draft',
               row_version = row_version + 1,
               updated_by = $10, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid
             AND source_external_key = $3
           RETURNING global_id`,
          [
            input.organizationId,
            existingMaterial.id,
            row.sourceExternalKey,
            row.name,
            row.materialType,
            row.ratedOuterLengthMm,
            row.ratedOuterWidthMm,
            row.ratedOuterHeightMm,
            `Operator-supplied Shopify saved-package CSV for ${account.shop_domain}; SHA-256 ${input.preview.fileSha256}`,
            input.actorEmail,
            row.tareWeightGrams,
            row.shopifyPackageId,
            row.isDefault,
            input.preview.fileSha256,
          ],
        )
        : await client.query<{ global_id: string }>(
          `INSERT INTO operations_packaging_materials (
             organization_id, code, name, material_type,
             rated_outer_length_mm, rated_outer_width_mm,
             rated_outer_height_mm,
             rated_outer_dimension_evidence_type,
             rated_outer_dimension_evidence_reference,
             rated_outer_dimension_confirmed_at,
             rated_outer_dimension_confirmed_by,
             dimension_basis, dimension_evidence_type,
             tare_weight_grams, status, source,
             source_integration_account_id, source_external_key,
             source_external_package_id, source_is_default,
             source_imported_at, source_file_sha256,
             created_by, updated_by
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, $7, 'provider', $8,
             now(), $9, 'unspecified', 'unknown', $10, 'draft',
             'shopify_import', $11::uuid, $12, $13, $14, now(), $15,
             $9, $9
           ) RETURNING global_id`,
          [
            input.organizationId,
            row.code,
            row.name,
            row.materialType,
            row.ratedOuterLengthMm,
            row.ratedOuterWidthMm,
            row.ratedOuterHeightMm,
            `Operator-supplied Shopify saved-package CSV for ${account.shop_domain}; SHA-256 ${input.preview.fileSha256}`,
            input.actorEmail,
            row.tareWeightGrams,
            account.id,
            row.sourceExternalKey,
            row.shopifyPackageId,
            row.isDefault,
            input.preview.fileSha256,
          ],
        )
      if (!saved.rows[0]) {
        throw new PackagingMaterialRequestError(
          'SHOPIFY_PACKAGING_IMPORT_LINEAGE_CONFLICT',
          `Shopify package ${row.code} changed during import. Refresh and try again.`,
          409,
        )
      }
      if (existingMaterial) updatedCount += 1
      else createdCount += 1
      materialGlobalIds.push(saved.rows[0].global_id)
    }
    const payload = {
      accountGlobalId: account.global_id,
      accountDisplayName: account.display_name,
      fileSha256: input.preview.fileSha256,
      createdCount,
      updatedCount,
      totalCount: input.preview.totalCount,
      defaultCount: input.preview.defaultCount,
      materialGlobalIds,
      status: 'draft',
      replayed: false,
      providerListApiAvailable: false,
      providerReads: 0,
      providerWrites: 0,
    }
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_global_id = $2,
           result_payload = $3::jsonb, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [createdReceipt.rows[0].id, materialGlobalIds[0], JSON.stringify(payload)],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.packaging_material.shopify_csv_imported',
      aggregateType: 'operations.integration_account',
      aggregateId: account.global_id,
      subject: account.display_name,
      organizationId: input.organizationId,
      eventKey: `operations:shopify-packaging-import:${account.global_id}:${createdReceipt.rows[0].id}`,
      payload: {
        commandReceiptId: createdReceipt.rows[0].id,
        idempotencyKeyHash: createHash('sha256')
          .update(input.idempotencyKey)
          .digest('hex'),
        fileSha256: input.preview.fileSha256,
        createdCount,
        updatedCount,
        totalCount: input.preview.totalCount,
        defaultCount: input.preview.defaultCount,
        createsDraftsOnly: true,
        providerReads: 0,
        providerWrites: 0,
      },
    }, client)
    return payload
  })
}

function starterRequestHash() {
  return createHash('sha256').update(JSON.stringify({
    version: STARTER_ASSORTMENT_VERSION,
    materials: STARTER_PACKAGING_MATERIALS,
  })).digest('hex')
}

export async function createStarterPackagingAssortmentInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
}) {
  return withTransaction(async (client) => {
    const commandType = 'operations.packaging_materials.create_starter_assortment'
    const requestHash = starterRequestHash()
    await acquireTransactionAdvisoryLock(
      client,
      `packaging-material-starter:${input.organizationId}`,
    )
    const existing = await client.query<{
      id: string
      request_hash: string
      status: 'processing' | 'succeeded' | 'failed'
      result_payload: Record<string, unknown> | null
    }>(
      `SELECT id::text, request_hash, status, result_payload
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [input.organizationId, commandType, input.idempotencyKey],
    )
    const receipt = existing.rows[0]
    if (receipt) {
      if (receipt.request_hash !== requestHash) {
        throw new PackagingMaterialRequestError(
          'PACKAGING_MATERIAL_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different starter assortment',
          409,
        )
      }
      if (receipt.status === 'succeeded' && receipt.result_payload) {
        const materialGlobalIds = Array.isArray(
          receipt.result_payload.materialGlobalIds,
        )
          ? receipt.result_payload.materialGlobalIds.filter(
            (value): value is string => typeof value === 'string',
          )
          : []
        const currentMaterials = materialGlobalIds.length
          ? await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM operations_packaging_materials
             WHERE organization_id = $1::uuid
               AND global_id = ANY($2::text[])
               AND status <> 'retired'`,
            [input.organizationId, materialGlobalIds],
          )
          : { rows: [{ count: '0' }] }
        if (
          materialGlobalIds.length !== STARTER_PACKAGING_MATERIALS.length
          || integer(currentMaterials.rows[0]?.count || '0')
            !== materialGlobalIds.length
        ) {
          throw new PackagingMaterialRequestError(
            'PACKAGING_MATERIAL_STARTER_REPLAY_STALE',
            'This starter-assortment command already completed, but one or more of its materials were later removed. Start a new creation command.',
            409,
          )
        }
        return {
          ...receipt.result_payload,
          replayed: true,
        }
      }
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_COMMAND_IN_PROGRESS',
        'Starter assortment creation is already in progress',
        409,
      )
    }

    const createdReceipt = await client.query<{ id: string }>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, 'processing', gen_random_uuid()
       )
       RETURNING id::text`,
      [
        input.organizationId,
        commandType,
        input.idempotencyKey,
        requestHash,
        input.actorEmail,
      ],
    )

    let createdCount = 0
    for (const starter of STARTER_PACKAGING_MATERIALS) {
      const inserted = await client.query(
        `INSERT INTO operations_packaging_materials (
           organization_id, code, name, material_type,
           inner_length_mm, inner_width_mm, inner_height_mm,
           dimension_basis, dimension_evidence_type,
           dimension_evidence_reference,
           tare_weight_grams, max_weight_grams, unit_cost_minor, currency,
           status, source, created_by, updated_by
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, NULL, NULL, 'draft', 'starter_assortment', $13, $13
         )
         ON CONFLICT (organization_id, code) DO NOTHING`,
        [
          input.organizationId,
          starter.code,
          starter.name,
          starter.materialType,
          starter.innerLengthMm,
          starter.innerWidthMm,
          starter.innerHeightMm,
          starter.dimensionBasis,
          starter.dimensionEvidenceType,
          starter.dimensionEvidenceReference,
          starter.tareWeightGrams,
          starter.maxWeightGrams,
          input.actorEmail,
        ],
      )
      createdCount += inserted.rowCount || 0
    }

    const starters = await client.query<{
      id: string
      global_id: string
      code: string
      name: string
      material_type: PackagingMaterial['materialType']
      inner_length_mm: number | null
      inner_width_mm: number | null
      inner_height_mm: number | null
      dimension_basis: PackagingMaterial['dimensionBasis']
      dimension_evidence_type: PackagingMaterial['dimensionEvidenceType']
      dimension_evidence_reference: string | null
      tare_weight_grams: number | null
      max_weight_grams: number | null
      unit_cost_minor: string | null
      currency: string | null
      status: PackagingMaterial['status']
      source: PackagingMaterial['source']
    }>(
      `SELECT id::text, global_id, code, name, material_type,
              inner_length_mm, inner_width_mm, inner_height_mm,
              dimension_basis, dimension_evidence_type,
              dimension_evidence_reference,
              tare_weight_grams, max_weight_grams, unit_cost_minor, currency,
              status, source
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid
         AND code = ANY($2::text[])
       ORDER BY code, id`,
      [
        input.organizationId,
        STARTER_PACKAGING_MATERIALS.map((material) => material.code),
      ],
    )
    if (!starters.rows[0]) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_STARTER_FAILED',
        'Starter assortment could not be created',
        500,
      )
    }
    if (starters.rows.length !== STARTER_PACKAGING_MATERIALS.length) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_STARTER_FAILED',
        'Starter assortment is incomplete',
        500,
      )
    }
    const expectedByCode = new Map(
      STARTER_PACKAGING_MATERIALS.map((starter) => [starter.code, starter]),
    )
    for (const starterRow of starters.rows) {
      const expected = expectedByCode.get(starterRow.code)
      if (
        !expected
        || starterRow.name !== expected.name
        || starterRow.material_type !== expected.materialType
        || Number(starterRow.inner_length_mm) !== expected.innerLengthMm
        || Number(starterRow.inner_width_mm) !== expected.innerWidthMm
        || Number(starterRow.inner_height_mm) !== expected.innerHeightMm
        || starterRow.dimension_basis !== expected.dimensionBasis
        || starterRow.dimension_evidence_type !== expected.dimensionEvidenceType
        || starterRow.dimension_evidence_reference
          !== expected.dimensionEvidenceReference
        || Number(starterRow.tare_weight_grams) !== expected.tareWeightGrams
        || Number(starterRow.max_weight_grams) !== expected.maxWeightGrams
        || starterRow.unit_cost_minor !== null
        || starterRow.currency !== null
        || starterRow.status !== 'draft'
        || starterRow.source !== 'starter_assortment'
      ) {
        throw new PackagingMaterialRequestError(
          'PACKAGING_MATERIAL_STARTER_CODE_CONFLICT',
          `Packaging material code ${starterRow.code} is already in use by a different material`,
          409,
        )
      }
    }

    // Only existing warehouses receive stock placeholders. This module never
    // creates or guesses a warehouse.
    await client.query(
      `INSERT INTO operations_packaging_material_stock (
         organization_id, packaging_material_id, warehouse_id,
         is_available, on_hand_quantity, reorder_point_quantity,
         reorder_to_quantity, created_by, updated_by
       )
       SELECT $1::uuid, material.id, warehouse.id,
              false, NULL, NULL, NULL, $3, $3
       FROM operations_packaging_materials material
       CROSS JOIN operations_warehouses warehouse
       WHERE material.organization_id = $1::uuid
         AND material.code = ANY($2::text[])
         AND warehouse.organization_id = $1::uuid
         AND warehouse.status = 'active'
       ON CONFLICT (
         organization_id, packaging_material_id, warehouse_id
       ) DO NOTHING`,
      [
        input.organizationId,
        STARTER_PACKAGING_MATERIALS.map((material) => material.code),
        input.actorEmail,
      ],
    )

    const payload = {
      createdCount,
      totalCount: starters.rows.length,
      materialGlobalIds: starters.rows.map((row) => row.global_id),
      status: 'draft',
      replayed: false,
    }
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded',
           result_global_id = $2,
           result_payload = $3::jsonb,
           completed_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        createdReceipt.rows[0].id,
        starters.rows[0].global_id,
        JSON.stringify(payload),
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.packaging_material.starter_assortment_created',
      aggregateType: 'operations.packaging_material',
      aggregateId: starters.rows[0].global_id,
      organizationId: input.organizationId,
      eventKey: `operations:packaging-material-starter:${input.organizationId}:v${STARTER_ASSORTMENT_VERSION}:${createdReceipt.rows[0].id}`,
      payload: {
        assortmentVersion: STARTER_ASSORTMENT_VERSION,
        createdCount,
        totalCount: starters.rows.length,
        status: 'draft',
        includesCost: false,
        includesStock: false,
      },
    }, client)
    return payload
  })
}
