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
      material.dimension_basis, material.dimension_evidence_type,
      material.dimension_evidence_reference, material.dimension_confirmed_at,
      material.dimension_confirmed_by,
      material.tare_weight_grams, material.max_weight_grams,
      material.unit_cost_minor::text, material.currency, material.status,
      material.source, material.row_version::text, material.updated_at,
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
    WHERE material.organization_id = $1::uuid
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
       JOIN operations_order_lines line
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
       JOIN operations_order_lines line
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
  const [warehouseResult, rows, optimizerReadiness] = await Promise.all([
    query<WarehouseRow>(
      `SELECT id::text, global_id, name, status
       FROM operations_warehouses
       WHERE organization_id = $1::uuid
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, lower(name), id`,
      [input.organizationId],
    ),
    materialRows(input.organizationId),
    readiness(input.organizationId),
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
    optimizerReadiness,
  }
}

async function assertActivationReady(
  client: PoolClient,
  organizationId: string,
  materialId: string,
) {
  const configured = await client.query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM operations_packaging_material_stock stock
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = stock.organization_id
        AND warehouse.id = stock.warehouse_id
        AND warehouse.status = 'active'
       WHERE stock.organization_id = $1::uuid
         AND stock.packaging_material_id = $2::uuid
         AND stock.on_hand_quantity IS NOT NULL
     ) AS ready`,
    [organizationId, materialId],
  )
  if (!configured.rows[0]?.ready) {
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
        }>(
          `SELECT id::text, row_version::text, status
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
               dimension_basis = $9,
               dimension_evidence_type = $10,
               dimension_evidence_reference = $11,
               dimension_confirmed_at = CASE
                 WHEN $10 IN ('customer_confirmed', 'measured')
                   THEN CASE
                     WHEN inner_length_mm IS DISTINCT FROM $6
                       OR inner_width_mm IS DISTINCT FROM $7
                       OR inner_height_mm IS DISTINCT FROM $8
                       OR dimension_basis IS DISTINCT FROM $9
                       OR dimension_evidence_type IS DISTINCT FROM $10
                       OR dimension_evidence_reference IS DISTINCT FROM $11
                       THEN now()
                     ELSE COALESCE(dimension_confirmed_at, now())
                   END
                 ELSE NULL
               END,
               dimension_confirmed_by = CASE
                 WHEN $10 IN ('customer_confirmed', 'measured')
                   THEN CASE
                     WHEN inner_length_mm IS DISTINCT FROM $6
                       OR inner_width_mm IS DISTINCT FROM $7
                       OR inner_height_mm IS DISTINCT FROM $8
                       OR dimension_basis IS DISTINCT FROM $9
                       OR dimension_evidence_type IS DISTINCT FROM $10
                       OR dimension_evidence_reference IS DISTINCT FROM $11
                       THEN $17
                     ELSE COALESCE(dimension_confirmed_by, $17)
                   END
                 ELSE NULL
               END,
               tare_weight_grams = $12,
               max_weight_grams = $13,
               unit_cost_minor = $14,
               currency = $15,
               status = $16,
               source = $18,
               row_version = row_version + 1,
               updated_by = $17,
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
             dimension_basis, dimension_evidence_type,
             dimension_evidence_reference, dimension_confirmed_at,
             dimension_confirmed_by,
             tare_weight_grams, max_weight_grams, unit_cost_minor, currency,
             status, source, created_by, updated_by
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $9 IN ('customer_confirmed', 'measured')
               THEN now() ELSE NULL END,
             CASE WHEN $9 IN ('customer_confirmed', 'measured')
               THEN $16 ELSE NULL END,
             $11, $12, $13, $14, $15, $17, $16, $16
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
    const material = await client.query<{ id: string; name: string }>(
      `SELECT id::text, name
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid AND global_id = $2
       FOR SHARE`,
      [input.organizationId, input.stock.materialGlobalId],
    )
    if (!material.rows[0]) {
      throw new PackagingMaterialRequestError(
        'PACKAGING_MATERIAL_NOT_FOUND',
        'Packaging material was not found',
        404,
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
      eventKey: `operations:packaging-material-starter:${input.organizationId}:v${STARTER_ASSORTMENT_VERSION}`,
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
