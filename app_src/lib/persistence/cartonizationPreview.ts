import type { PoolClient } from 'pg'
import {
  type CartonizationPreviewRequest,
  type CartonizationPreviewSnapshot,
} from '@/lib/operations/cartonizationPreview'
import { getPostgresPool } from '@/lib/persistence/postgres'

type AccountRow = {
  integration_account_id: string
  organization_global_id: string | null
  global_id: string
  provider: string
  status: string
  activation_state: string | null
  data_pipeline_id: string | null
}

type CandidateRow = {
  order_candidate_id: string
  global_id: string
  order_number_snapshot: string
  source_hash: string
  row_version: string
  workflow_state: string
  currency_code: string
  requires_shipping: boolean
  expires_at: Date | string
}

type CandidateLineRow = {
  global_id: string
  product_title_snapshot: string
  requires_shipping: boolean
  unfulfilled_quantity: string
  mapping_state: string
  packaging_state: string
  product_global_id: string | null
  weight_grams: number | null
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  packaging_source: string
  packaging_weight_source: string | null
  commerce_variant_pack_mapping_global_id: string | null
  commerce_variant_pack_mapping_row_version: string | null
  pack_profile_version_global_id: string | null
  pack_profile_version_row_version: string | null
  pack_profile_package_level: string | null
  pack_profile_base_each_quantity: number | null
}

type WarehouseRow = {
  id: string
  global_id: string
  name: string
}

type InventoryLocationMappingRow = {
  id: string
  warehouse_id: string
}

type CarrierServiceWarehouseRow = {
  warehouse_id: string
}

type InventoryRunRow = {
  sync_run_id: string
  global_id: string
  warehouse_global_id: string
  provider_fetched_at: Date | string
  completed_at: Date | string
}

type InventoryPositionRow = {
  position_global_id: string
  warehouse_global_id: string
  product_global_id: string
  atp_quantity: string
  provider_committed_quantity: string
  source_level_global_ids: string[]
}

type MaterialRow = {
  global_id: string
  name: string
  material_type: string
  status: string
  inner_length_mm: number
  inner_width_mm: number
  inner_height_mm: number
  tare_weight_grams: number
  max_weight_grams: number
  unit_cost_minor: string | null
  currency: string | null
  row_version: string
  stock_warehouse_global_id: string | null
  stock_warehouse_status: string | null
  stock_is_available: boolean | null
  stock_on_hand_quantity: number | null
  stock_row_version: string | null
}

type ReadTimeRow = {
  read_at: Date | string
}

export class CartonizationPreviewPersistenceError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'CartonizationPreviewPersistenceError'
    this.status = status
    this.code = code
  }
}

function persistenceError(
  message: string,
  status: number,
  code: string,
): never {
  throw new CartonizationPreviewPersistenceError(message, status, code)
}

function exactInteger(
  value: string | number | null,
  label: string,
  minimum = 0,
) {
  if (value === null || value === '') {
    persistenceError(
      `${label} is missing`,
      500,
      'CARTONIZATION_PREVIEW_EVIDENCE_INVALID',
    )
  }
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum) {
    persistenceError(
      `${label} is not an exact safe integer`,
      500,
      'CARTONIZATION_PREVIEW_EVIDENCE_INVALID',
    )
  }
  return result
}

function nullableExactInteger(
  value: string | number | null,
  label: string,
) {
  return value === null ? null : exactInteger(value, label)
}

function timestamp(value: Date | string, label: string) {
  const result = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(result.getTime())) {
    persistenceError(
      `${label} is invalid`,
      500,
      'CARTONIZATION_PREVIEW_EVIDENCE_INVALID',
    )
  }
  return result.toISOString()
}

async function readAccount(
  client: PoolClient,
  organizationId: string,
  accountGlobalId: string,
) {
  const result = await client.query<AccountRow>(
    `SELECT
       account.id::text AS integration_account_id,
       organization.reference_code AS organization_global_id,
       account.global_id,
       account.provider,
       account.status,
       activation.state AS activation_state,
       activation.data_pipeline_id::text
     FROM operations_integration_accounts account
     JOIN workspace_organizations organization
       ON organization.id = account.organization_id
     LEFT JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
     LIMIT 1`,
    [organizationId, accountGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    persistenceError(
      'The selected commerce account is unavailable in the active organization',
      404,
      'CARTONIZATION_PREVIEW_ACCOUNT_NOT_FOUND',
    )
  }
  if (!row.organization_global_id) {
    persistenceError(
      'The active organization has no canonical Global ID',
      500,
      'CARTONIZATION_PREVIEW_ORGANIZATION_ID_REQUIRED',
    )
  }
  return row
}

async function readCandidate(
  client: PoolClient,
  input: {
    organizationId: string
    account: AccountRow
    candidateGlobalId: string
    expectedRowVersion: number
  },
) {
  const result = await client.query<CandidateRow>(
    `SELECT
       candidate.id::text AS order_candidate_id,
       candidate.global_id,
       candidate.order_number_snapshot,
       candidate.source_hash,
       candidate.row_version::text,
       candidate.workflow_state,
       candidate.currency_code,
       candidate.requires_shipping,
       candidate.expires_at
     FROM operations_commerce_order_candidates candidate
     WHERE candidate.organization_id = $1::uuid
       AND candidate.integration_account_id = $2::uuid
       AND candidate.global_id = $3
       AND (
         $4::uuid IS NULL
         OR candidate.pipeline_id = $4::uuid
       )
     LIMIT 1`,
    [
      input.organizationId,
      input.account.integration_account_id,
      input.candidateGlobalId,
      input.account.data_pipeline_id,
    ],
  )
  const row = result.rows[0]
  if (!row) {
    persistenceError(
      'The selected order candidate is unavailable for this exact commerce account',
      404,
      'CARTONIZATION_PREVIEW_CANDIDATE_NOT_FOUND',
    )
  }
  const rowVersion = exactInteger(
    row.row_version,
    'Order candidate row version',
  )
  if (rowVersion !== input.expectedRowVersion) {
    persistenceError(
      'The order candidate changed; reload it before previewing cartonization',
      409,
      'CARTONIZATION_PREVIEW_CANDIDATE_REVISION_CONFLICT',
    )
  }
  return { row, rowVersion }
}

async function readCandidateLines(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    orderCandidateId: string
  },
) {
  const result = await client.query<CandidateLineRow>(
    `SELECT
       line.global_id,
       line.product_title_snapshot,
       line.requires_shipping,
       line.unfulfilled_quantity::text,
       line.mapping_state,
       line.packaging_state,
       product.reference_code AS product_global_id,
       line.weight_grams,
       line.length_mm,
       line.width_mm,
       line.height_mm,
       line.packaging_source,
       line.packaging_weight_source,
       pack_mapping.global_id
         AS commerce_variant_pack_mapping_global_id,
       line.commerce_variant_pack_mapping_row_version::text,
       pack_version.global_id AS pack_profile_version_global_id,
       line.pack_profile_version_row_version::text,
       line.pack_profile_package_level,
       line.pack_profile_base_each_quantity
     FROM operations_commerce_current_planning_lines line
     LEFT JOIN crm_products product
      ON product.pipeline_id = line.pipeline_id
      AND product.id = line.product_id
     LEFT JOIN operations_commerce_variant_pack_mappings pack_mapping
       ON pack_mapping.organization_id = line.organization_id
      AND pack_mapping.id = line.commerce_variant_pack_mapping_id
     LEFT JOIN operations_product_pack_profile_versions pack_version
       ON pack_version.organization_id = line.organization_id
      AND pack_version.id = line.pack_profile_version_id
     WHERE line.organization_id = $1::uuid
       AND line.integration_account_id = $2::uuid
       AND line.order_candidate_id = $3::uuid
     ORDER BY line.created_at, line.id`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.orderCandidateId,
    ],
  )
  return result.rows
}

async function readSelectedWarehouseAuthority(
  client: PoolClient,
  input: {
    organizationId: string
    account: AccountRow
    warehouseGlobalId: string
  },
) {
  const result = await client.query<WarehouseRow>(
    `SELECT warehouse.id::text, warehouse.global_id, warehouse.name
     FROM operations_warehouses warehouse
     WHERE warehouse.organization_id = $1::uuid
       AND warehouse.global_id = $2
       AND warehouse.status = 'active'
     LIMIT 2`,
    [input.organizationId, input.warehouseGlobalId],
  )
  if (result.rows.length !== 1) {
    persistenceError(
      'The selected warehouse is not exactly one active warehouse in this organization',
      409,
      'CARTONIZATION_PREVIEW_WAREHOUSE_UNAVAILABLE',
    )
  }
  const warehouse = result.rows[0]
  if (input.account.provider !== 'shopify') {
    return { warehouse, locationMappingId: null }
  }

  const [mappingResult, carrierConfigResult] = await Promise.all([
    client.query<InventoryLocationMappingRow>(
      `SELECT mapping.id::text, mapping.warehouse_id::text
       FROM operations_commerce_inventory_location_mappings mapping
       WHERE mapping.organization_id = $1::uuid
         AND mapping.integration_account_id = $2::uuid
         AND mapping.warehouse_id = $3::uuid
         AND mapping.active = true
       ORDER BY mapping.id
       LIMIT 2`,
      [
        input.organizationId,
        input.account.integration_account_id,
        warehouse.id,
      ],
    ),
    client.query<CarrierServiceWarehouseRow>(
      `SELECT DISTINCT config.warehouse_id::text AS warehouse_id
       FROM operations_shopify_carrier_service_configs config
       WHERE config.organization_id = $1::uuid
         AND config.integration_account_id = $2::uuid
         AND config.registration_state IN ('shadow_simulated', 'registered')
       ORDER BY config.warehouse_id::text
       LIMIT 2`,
      [input.organizationId, input.account.integration_account_id],
    ),
  ])
  if (mappingResult.rows.length > 1) {
    persistenceError(
      'More than one active Shopify inventory location mapping exists for the selected warehouse',
      409,
      'CARTONIZATION_PREVIEW_LOCATION_MAPPING_AMBIGUOUS',
    )
  }
  if (carrierConfigResult.rows.length > 1) {
    persistenceError(
      'More than one active Shopify carrier-service warehouse requires review',
      409,
      'CARTONIZATION_PREVIEW_CARRIER_CONFIG_AMBIGUOUS',
    )
  }
  const mapping = mappingResult.rows[0] || null
  const carrierWarehouseId =
    carrierConfigResult.rows[0]?.warehouse_id || null
  if (!mapping) {
    persistenceError(
      'The selected Shopify account has no current active inventory location mapping',
      409,
      'CARTONIZATION_PREVIEW_LOCATION_MAPPING_REQUIRED',
    )
  }
  if (
    carrierWarehouseId
    && carrierWarehouseId !== mapping.warehouse_id
  ) {
    persistenceError(
      'The saved Shopify inventory mapping and carrier-service configuration target different warehouses',
      409,
      'CARTONIZATION_PREVIEW_WAREHOUSE_AUTHORITY_CONFLICT',
    )
  }
  if (
    mapping.warehouse_id !== warehouse.id
    || (carrierWarehouseId && carrierWarehouseId !== warehouse.id)
  ) {
    persistenceError(
      'The selected warehouse does not match current Shopify inventory authority',
      409,
      'CARTONIZATION_PREVIEW_WAREHOUSE_AUTHORITY_MISMATCH',
    )
  }
  return { warehouse, locationMappingId: mapping.id }
}

async function readLatestInventoryRun(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    warehouseId: string
    locationMappingId: string
  },
) {
  const result = await client.query<InventoryRunRow>(
    `SELECT
       COALESCE(run.source_level_set_run_id, run.id)::text AS sync_run_id,
       run.global_id,
       warehouse.global_id AS warehouse_global_id,
       run.provider_fetched_at,
       run.completed_at
     FROM operations_commerce_inventory_sync_runs run
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = run.organization_id
      AND warehouse.id = run.warehouse_id
     WHERE run.organization_id = $1::uuid
       AND run.integration_account_id = $2::uuid
       AND run.warehouse_id = $3::uuid
       AND run.location_mapping_id = $4::uuid
       AND run.status = 'succeeded'
     ORDER BY
       run.provider_fetched_at DESC,
       run.completed_at DESC,
       run.id DESC
     LIMIT 1`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.warehouseId,
      input.locationMappingId,
    ],
  )
  return result.rows[0] || null
}

async function readInventoryPositions(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    syncRunId: string
  },
) {
  const result = await client.query<InventoryPositionRow>(
    `SELECT
       position.global_id AS position_global_id,
       warehouse.global_id AS warehouse_global_id,
       product.reference_code AS product_global_id,
       sum(level.operational_available_quantity)::text AS atp_quantity,
       sum(level.provider_committed_quantity)::text
         AS provider_committed_quantity,
       array_agg(level.global_id ORDER BY level.global_id)
         AS source_level_global_ids
     FROM operations_commerce_inventory_levels level
     JOIN operations_inventory_positions position
       ON position.organization_id = level.organization_id
      AND position.id = level.inventory_position_id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = level.organization_id
      AND warehouse.id = level.warehouse_id
     JOIN crm_products product
       ON product.pipeline_id = level.pipeline_id
      AND product.id = level.product_id
     WHERE level.organization_id = $1::uuid
       AND level.integration_account_id = $2::uuid
       AND level.sync_run_id = $3::uuid
       AND level.projection_state = 'projected'
     GROUP BY
       position.global_id,
       warehouse.global_id,
       product.reference_code
     ORDER BY product.reference_code, position.global_id`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.syncRunId,
    ],
  )
  return result.rows
}

async function readSelectedMaterials(
  client: PoolClient,
  organizationId: string,
  materialGlobalIds: string[],
) {
  const result = await client.query<MaterialRow>(
    `SELECT
       material.global_id,
       material.name,
       material.material_type,
       material.status,
       material.inner_length_mm,
       material.inner_width_mm,
       material.inner_height_mm,
       material.tare_weight_grams,
       material.max_weight_grams,
       material.unit_cost_minor::text,
       material.currency,
       material.row_version::text,
       warehouse.global_id AS stock_warehouse_global_id,
       warehouse.status AS stock_warehouse_status,
       stock.is_available AS stock_is_available,
       stock.on_hand_quantity AS stock_on_hand_quantity,
       stock.row_version::text AS stock_row_version
     FROM operations_packaging_materials material
     LEFT JOIN operations_packaging_material_stock stock
       ON stock.organization_id = material.organization_id
      AND stock.packaging_material_id = material.id
     LEFT JOIN operations_warehouses warehouse
       ON warehouse.organization_id = stock.organization_id
      AND warehouse.id = stock.warehouse_id
     WHERE material.organization_id = $1::uuid
       AND material.global_id = ANY($2::text[])
     ORDER BY material.global_id, warehouse.global_id`,
    [organizationId, materialGlobalIds],
  )
  return result.rows
}

function mapMaterials(rows: MaterialRow[]) {
  const materials = new Map<
    string,
    CartonizationPreviewSnapshot['selectedMaterials'][number]
  >()
  for (const row of rows) {
    let material = materials.get(row.global_id)
    if (!material) {
      material = {
        globalId: row.global_id,
        name: row.name,
        materialType: row.material_type as
          CartonizationPreviewSnapshot['selectedMaterials'][number]['materialType'],
        status: row.status as
          CartonizationPreviewSnapshot['selectedMaterials'][number]['status'],
        innerDimensionsMm: {
          length: row.inner_length_mm,
          width: row.inner_width_mm,
          height: row.inner_height_mm,
        },
        tareWeightGrams: row.tare_weight_grams,
        maxWeightGrams: row.max_weight_grams,
        unitCostMinor: nullableExactInteger(
          row.unit_cost_minor,
          `${row.global_id} unit cost`,
        ),
        currency: row.currency,
        rowVersion: exactInteger(
          row.row_version,
          `${row.global_id} row version`,
        ),
        stock: [],
      }
      materials.set(row.global_id, material)
    }
    if (row.stock_warehouse_global_id) {
      material.stock.push({
        warehouseGlobalId: row.stock_warehouse_global_id,
        warehouseStatus: row.stock_warehouse_status as 'active' | 'inactive',
        isAvailable: row.stock_is_available === true,
        onHandQuantity: row.stock_on_hand_quantity,
        rowVersion: nullableExactInteger(
          row.stock_row_version,
          `${row.global_id} stock row version`,
        ),
      })
    }
  }
  return [...materials.values()]
}

export async function readCartonizationPreviewSnapshotFromPostgres(input: {
  organizationId: string
  request: CartonizationPreviewRequest
}): Promise<CartonizationPreviewSnapshot> {
  const client = await getPostgresPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const readTimeResult = await client.query<ReadTimeRow>(
      'SELECT transaction_timestamp() AS read_at',
    )
    const readTime = readTimeResult.rows[0]
    if (!readTime) {
      persistenceError(
        'The database did not return a preview read timestamp',
        500,
        'CARTONIZATION_PREVIEW_EVIDENCE_INVALID',
      )
    }
    const readAtUtc = timestamp(
      readTime.read_at,
      'Preview read timestamp',
    )
    const account = await readAccount(
      client,
      input.organizationId,
      input.request.accountGlobalId,
    )
    const { row: candidate, rowVersion } = await readCandidate(client, {
      organizationId: input.organizationId,
      account,
      candidateGlobalId: input.request.candidateGlobalId,
      expectedRowVersion: input.request.expectedCandidateRowVersion,
    })
    const warehouseAuthority = await readSelectedWarehouseAuthority(client, {
      organizationId: input.organizationId,
      account,
      warehouseGlobalId: input.request.warehouseGlobalId,
    })
    let inventoryRunRead: Promise<InventoryRunRow | null> =
      Promise.resolve(null)
    if (account.provider === 'shopify') {
      if (!warehouseAuthority.locationMappingId) {
        persistenceError(
          'Shopify preview warehouse authority lost its exact location mapping',
          500,
          'CARTONIZATION_PREVIEW_EVIDENCE_INVALID',
        )
      }
      inventoryRunRead = readLatestInventoryRun(client, {
        organizationId: input.organizationId,
        integrationAccountId: account.integration_account_id,
        warehouseId: warehouseAuthority.warehouse.id,
        locationMappingId: warehouseAuthority.locationMappingId,
      })
    }
    const [
      lineRows,
      inventoryRun,
      materialRows,
    ] = await Promise.all([
      readCandidateLines(client, {
        organizationId: input.organizationId,
        integrationAccountId: account.integration_account_id,
        orderCandidateId: candidate.order_candidate_id,
      }),
      inventoryRunRead,
      readSelectedMaterials(
        client,
        input.organizationId,
        input.request.materialGlobalIds,
      ),
    ])
    const inventoryRows = inventoryRun
      ? await readInventoryPositions(client, {
          organizationId: input.organizationId,
          integrationAccountId: account.integration_account_id,
          syncRunId: inventoryRun.sync_run_id,
        })
      : []
    const snapshot: CartonizationPreviewSnapshot = {
      readAtUtc,
      organization: {
        globalId: account.organization_global_id as string,
      },
      account: {
        globalId: account.global_id,
        provider: account.provider as 'shopify' | 'faire',
        status: account.status as 'active' | 'disabled' | 'error',
        activationState: account.activation_state as
          CartonizationPreviewSnapshot['account']['activationState'],
      },
      candidate: {
        globalId: candidate.global_id,
        orderNumber: candidate.order_number_snapshot,
        sourceHash: candidate.source_hash,
        rowVersion,
        workflowState: candidate.workflow_state as
          CartonizationPreviewSnapshot['candidate']['workflowState'],
        currency: candidate.currency_code,
        requiresShipping: candidate.requires_shipping,
        expiresAt: timestamp(candidate.expires_at, 'Candidate expiration'),
      },
      lines: lineRows.map((line) => {
        const hasDimensions = (
          line.length_mm !== null
          && line.width_mm !== null
          && line.height_mm !== null
        )
        return {
          globalId: line.global_id,
          title: line.product_title_snapshot,
          requiresShipping: line.requires_shipping,
          quantity: exactInteger(
            line.unfulfilled_quantity,
            `${line.global_id} unfulfilled quantity`,
          ),
          mappingState: line.mapping_state,
          packagingState: line.packaging_state,
          productGlobalId: line.product_global_id,
          weightGrams: line.weight_grams,
          dimensionsMm: hasDimensions
            ? {
                length: line.length_mm as number,
                width: line.width_mm as number,
                height: line.height_mm as number,
              }
            : null,
          packEvidence: (
            line.commerce_variant_pack_mapping_global_id
            && line.commerce_variant_pack_mapping_row_version
            && line.pack_profile_version_global_id
            && line.pack_profile_version_row_version
            && line.pack_profile_package_level
            && line.pack_profile_base_each_quantity
          )
            ? {
                mappingGlobalId:
                  line.commerce_variant_pack_mapping_global_id,
                mappingRowVersion: Number(
                  line.commerce_variant_pack_mapping_row_version,
                ),
                profileVersionGlobalId:
                  line.pack_profile_version_global_id,
                profileVersionRowVersion: Number(
                  line.pack_profile_version_row_version,
                ),
                packageLevel: line.pack_profile_package_level,
                baseEachQuantity: line.pack_profile_base_each_quantity,
                packagingSource: line.packaging_source,
                weightSource: line.packaging_weight_source,
              }
            : null,
        }
      }),
      activeWarehouses: [{
        globalId: warehouseAuthority.warehouse.global_id,
        name: warehouseAuthority.warehouse.name,
      }],
      latestInventoryRun: inventoryRun
        ? {
            globalId: inventoryRun.global_id,
            warehouseGlobalId: inventoryRun.warehouse_global_id,
            providerFetchedAt: timestamp(
              inventoryRun.provider_fetched_at,
              'Inventory provider fetch timestamp',
            ),
            completedAt: timestamp(
              inventoryRun.completed_at,
              'Inventory completion timestamp',
            ),
          }
        : null,
      inventoryPositions: inventoryRows.map((position) => ({
        positionGlobalId: position.position_global_id,
        warehouseGlobalId: position.warehouse_global_id,
        productGlobalId: position.product_global_id,
        atpQuantity: exactInteger(
          position.atp_quantity,
          `${position.position_global_id} ATP quantity`,
        ),
        providerCommittedQuantity: exactInteger(
          position.provider_committed_quantity,
          `${position.position_global_id} provider committed quantity`,
        ),
        sourceLevelGlobalIds: position.source_level_global_ids,
      })),
      selectedMaterials: mapMaterials(materialRows),
    }
    await client.query('COMMIT')
    return snapshot
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original error. This transaction is read-only.
    }
    throw error
  } finally {
    client.release()
  }
}
