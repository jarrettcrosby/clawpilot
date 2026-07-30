import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import type {
  HybridCartonizationInput,
  HybridCartonizationLine,
  HybridCartonizationMaterial,
  HybridCartonizationRecipe,
} from '@/lib/operations/hybridCartonization'
import type { ShopifyCheckoutRatingAccount } from '@/lib/persistence/shopifyCheckoutRating'
import { getPostgresPool } from '@/lib/persistence/postgres'

export type ShopifyCheckoutContextLine = {
  lineKey: string
  productGid: string
  variantGid: string
  sku: string | null
  quantity: number
  grams: number
  requiresShipping: boolean
}

export type ShopifyCheckoutContextResult = {
  readAt: string
  inventorySnapshotAt: string
  inventorySnapshotHash: string
  input: HybridCartonizationInput
  lines: Array<{
    lineKey: string
    productGid: string
    variantGid: string
    productGlobalId: string
    packMappingGlobalId: string
    packProfileVersionGlobalId: string
    packProfileVersionRowVersion: number
    packageLevel: 'each' | 'inner_pack' | 'case' | 'pallet'
    baseEachQuantity: number
    shipsAsOwnPackage: boolean
    inventoryLevelGlobalIds: string[]
    quantity: number
    unitWeightGrams: number
    sku: string | null
    requiresShipping: boolean
  }>
  materials: Array<{
    materialGlobalId: string
    rowVersion: number
    stockGlobalId: string
    stockRowVersion: number
    maxWeightGrams: number
    stockOnHandQuantity: number
    unitCostMinor: number
    currency: string
  }>
}

export class ShopifyCheckoutContextError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShopifyCheckoutContextError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new ShopifyCheckoutContextError(code, message)
}

function integer(value: unknown, label: string, minimum = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail('SHOPIFY_CHECKOUT_EVIDENCE_CORRUPT', `${label} is invalid`)
  }
  return parsed
}

function timestamp(value: unknown, label: string): string {
  const date = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null
  if (!date || !Number.isFinite(date.getTime())) {
    fail('SHOPIFY_CHECKOUT_EVIDENCE_CORRUPT', `${label} is invalid`)
  }
  return date.toISOString()
}

type LineRow = QueryResultRow & {
  line_key: string
  product_gid: string
  variant_gid: string
  product_id: string
  product_global_id: string
  product_title: string
  provider_variant_title: string | null
  provider_sku: string | null
  external_inventory_item_id: string | null
  state_requires_shipping: boolean | null
  state_weight_grams: number | null
  state_normalized_status: string
  state_provider_active: boolean | null
  state_source_revision: string
  state_source_hash: string
  pack_mapping_global_id: string
  pack_mapping_row_version: string | number
  pack_mapping_projection_state: string
  pack_mapping_provider_lifecycle_state: string
  pack_mapping_source_revision: string | null
  pack_mapping_source_hash: string | null
  profile_version_id: string
  profile_version_global_id: string
  profile_version_row_version: string | number
  profile_version_is_current: boolean
  profile_version_lifecycle_state:
    HybridCartonizationLine['profile']['lifecycleState']
  profile_package_level: 'each' | 'inner_pack' | 'case' | 'pallet'
  profile_base_each_quantity: number
  profile_length_mm: number | null
  profile_width_mm: number | null
  profile_height_mm: number | null
  profile_dimension_basis: 'inner' | 'outer' | 'unspecified'
  profile_ships_as_own_package: boolean
  profile_fit_model: HybridCartonizationLine['profile']['fitModel']
  profile_evidence_type: HybridCartonizationLine['profile']['evidenceType']
  profile_evidence_reference: string | null
  profile_confirmed_at: Date | string | null
  profile_gross_weight_grams: number | null
  profile_status: string
}

type MaterialRow = QueryResultRow & {
  material_id: string
  material_global_id: string
  expected_row_version: string | number
  current_row_version: string | number
  status: 'draft' | 'active'
  inner_length_mm: number | null
  inner_width_mm: number | null
  inner_height_mm: number | null
  dimension_basis: 'inner' | 'outer' | 'unspecified'
  dimension_evidence_type:
    | 'unknown'
    | 'customer_confirmed'
    | 'measured'
    | 'provider'
    | 'legacy'
  dimension_evidence_reference: string | null
  dimension_confirmed_at: Date | string | null
  rated_outer_length_mm: number | null
  rated_outer_width_mm: number | null
  rated_outer_height_mm: number | null
  tare_weight_grams: number | null
  max_weight_grams: number | null
  unit_cost_minor: string | number | null
  currency: string | null
  stock_global_id: string
  stock_row_version: string | number
  stock_is_available: boolean | null
  stock_on_hand_quantity: number | null
}

type RecipeRow = QueryResultRow & {
  global_id: string
  row_version: string | number
  product_id: string
  product_global_id: string
  input_profile_version_id: string
  input_profile_version_global_id: string
  output_profile_version_global_id: string
  packaging_material_global_id: string
  recipe_type: HybridCartonizationRecipe['recipeType']
  input_quantity: number
  minimum_input_quantity: number | null
  content_compatibility_key: string | null
  allows_mixed_products: boolean
  exclusive_contents: boolean
  lifecycle_state: HybridCartonizationRecipe['lifecycleState']
  fit_evidence_type: HybridCartonizationRecipe['fitEvidenceType']
  fit_evidence_reference: string | null
  confirmed_at: Date | string | null
  is_current: boolean
}

type InventoryRow = QueryResultRow & {
  variant_gid: string
  external_inventory_item_id: string
  operational_available_quantity: string | number
  source_level_global_ids: string[]
}

async function readLines(
  client: PoolClient,
  account: ShopifyCheckoutRatingAccount,
  lines: ShopifyCheckoutContextLine[],
): Promise<LineRow[]> {
  const result = await client.query<LineRow>(
    `WITH requested AS (
       SELECT *
       FROM jsonb_to_recordset($3::jsonb) AS item(
         line_key text,
         product_gid text,
         variant_gid text
       )
     )
     SELECT
       requested.line_key,
       requested.product_gid,
       requested.variant_gid,
       mapping.product_id::text,
       product.reference_code AS product_global_id,
       product.name AS product_title,
       state.provider_variant_title,
       state.provider_sku,
       state.external_inventory_item_id,
       state.requires_shipping AS state_requires_shipping,
       state.weight_grams AS state_weight_grams,
       state.normalized_status AS state_normalized_status,
       state.provider_active AS state_provider_active,
       state.source_revision AS state_source_revision,
       state.source_hash AS state_source_hash,
       mapping.global_id AS pack_mapping_global_id,
       mapping.row_version::text AS pack_mapping_row_version,
       mapping.projection_state AS pack_mapping_projection_state,
       mapping.provider_lifecycle_state
         AS pack_mapping_provider_lifecycle_state,
       mapping.source_revision AS pack_mapping_source_revision,
       mapping.source_hash AS pack_mapping_source_hash,
       version.id::text AS profile_version_id,
       version.global_id AS profile_version_global_id,
       version.row_version::text AS profile_version_row_version,
       version.is_current AS profile_version_is_current,
       version.lifecycle_state AS profile_version_lifecycle_state,
       profile.package_level AS profile_package_level,
       version.base_each_quantity AS profile_base_each_quantity,
       version.length_mm AS profile_length_mm,
       version.width_mm AS profile_width_mm,
       version.height_mm AS profile_height_mm,
       version.dimension_basis AS profile_dimension_basis,
       version.ships_as_own_package AS profile_ships_as_own_package,
       version.fit_model AS profile_fit_model,
       version.evidence_type AS profile_evidence_type,
       version.evidence_reference AS profile_evidence_reference,
       version.confirmed_at AS profile_confirmed_at,
       version.gross_weight_grams AS profile_gross_weight_grams,
       profile.status AS profile_status
     FROM requested
     JOIN operations_commerce_variant_pack_mappings mapping
       ON mapping.organization_id = $1::uuid
      AND mapping.integration_account_id = $2::uuid
      AND mapping.provider = 'shopify'
      AND mapping.external_product_id = requested.product_gid
      AND mapping.external_variant_id = requested.variant_gid
      AND mapping.mapping_purpose = 'shopify_checkout'
      AND mapping.is_current = true
     JOIN operations_product_channel_states state
       ON state.organization_id = mapping.organization_id
      AND state.integration_account_id = mapping.integration_account_id
      AND state.provider = mapping.provider
      AND state.external_product_id = mapping.external_product_id
      AND state.external_variant_id = mapping.external_variant_id
      AND state.pipeline_id = mapping.pipeline_id
      AND state.product_id = mapping.product_id
     JOIN crm_products product
       ON product.pipeline_id = mapping.pipeline_id
      AND product.id = mapping.product_id
     JOIN operations_product_pack_profile_versions version
       ON version.organization_id = mapping.organization_id
      AND version.pipeline_id = mapping.pipeline_id
      AND version.product_id = mapping.product_id
      AND version.id = mapping.default_pack_profile_version_id
     JOIN operations_product_pack_profiles profile
       ON profile.organization_id = version.organization_id
      AND profile.pipeline_id = version.pipeline_id
      AND profile.product_id = version.product_id
      AND profile.id = version.profile_id
     ORDER BY requested.line_key`,
    [
      account.organizationId,
      account.integrationAccountId,
      JSON.stringify(lines.map((line) => ({
        line_key: line.lineKey,
        product_gid: line.productGid,
        variant_gid: line.variantGid,
      }))),
    ],
  )
  if (result.rows.length !== lines.length) {
    fail(
      'SHOPIFY_CHECKOUT_EXACT_VARIANT_MAPPING_REQUIRED',
      'Every shippable item requires an exact current Shopify variant mapping',
    )
  }
  return result.rows
}

function mapLines(
  rows: LineRow[],
  requested: Map<string, ShopifyCheckoutContextLine>,
) {
  return rows.map((row) => {
    const input = requested.get(row.line_key)
    if (!input) {
      fail(
        'SHOPIFY_CHECKOUT_EVIDENCE_CORRUPT',
        'Checkout line evidence did not match the request',
      )
    }
    if (
      row.state_normalized_status !== 'active'
      || row.state_provider_active !== true
      || row.state_requires_shipping !== true
      || row.pack_mapping_projection_state !== 'current'
      || row.pack_mapping_provider_lifecycle_state !== 'active'
      || row.pack_mapping_source_revision !== row.state_source_revision
      || row.pack_mapping_source_hash !== row.state_source_hash
      || row.profile_version_is_current !== true
      || row.profile_version_lifecycle_state !== 'active'
      || row.profile_status !== 'active'
      || row.profile_evidence_type === 'unknown'
      || !row.profile_evidence_reference
      || row.profile_confirmed_at === null
      || !row.external_inventory_item_id
    ) {
      fail(
        'SHOPIFY_CHECKOUT_VARIANT_EVIDENCE_NOT_READY',
        'A requested Shopify variant has stale or incomplete operational evidence',
      )
    }
    const providerWeight = integer(
      row.state_weight_grams,
      `${row.variant_gid} provider weight`,
      1,
    )
    if (
      providerWeight !== input.grams
      || (
        row.profile_gross_weight_grams !== null
        && row.profile_gross_weight_grams !== providerWeight
      )
    ) {
      fail(
        'SHOPIFY_CHECKOUT_VARIANT_WEIGHT_CONFLICT',
        'A requested Shopify variant weight differs from current retained evidence',
      )
    }
    const rowVersion = integer(
      row.profile_version_row_version,
      `${row.variant_gid} pack profile row version`,
    )
    const baseEachQuantity = integer(
      row.profile_base_each_quantity,
      `${row.variant_gid} base-each quantity`,
      1,
    )
    const outerDimensionsMm = (
      row.profile_dimension_basis === 'outer'
      && row.profile_length_mm !== null
      && row.profile_width_mm !== null
      && row.profile_height_mm !== null
    )
      ? {
          length: integer(
            row.profile_length_mm,
            `${row.variant_gid} profile length`,
            1,
          ),
          width: integer(
            row.profile_width_mm,
            `${row.variant_gid} profile width`,
            1,
          ),
          height: integer(
            row.profile_height_mm,
            `${row.variant_gid} profile height`,
            1,
          ),
        }
      : null
    const title = row.provider_variant_title?.trim()
      && row.provider_variant_title.trim().toLowerCase() !== 'default title'
      ? `${row.product_title} · ${row.provider_variant_title.trim()}`
      : row.product_title
    return {
      productId: row.product_id,
      profileVersionId: row.profile_version_id,
      inventoryItemId: row.external_inventory_item_id,
      line: {
        lineGlobalId: input.lineKey,
        productGlobalId: row.product_global_id,
        title,
        quantity: input.quantity,
        unitWeightGrams: providerWeight,
        profile: {
          versionGlobalId: row.profile_version_global_id,
          capturedRowVersion: rowVersion,
          currentRowVersion: rowVersion,
          isCurrent: true,
          lifecycleState: row.profile_version_lifecycle_state,
          fitModel: row.profile_fit_model,
          evidenceType: row.profile_evidence_type,
          evidenceReference: row.profile_evidence_reference,
          confirmedAt: timestamp(
            row.profile_confirmed_at,
            `${row.variant_gid} pack profile confirmation`,
          ),
          packageLevel: row.profile_package_level,
          baseEachQuantity,
          shipsAsOwnPackage: row.profile_ships_as_own_package,
          outerDimensionsMm,
          grossWeightGrams: row.profile_gross_weight_grams,
        },
      } satisfies HybridCartonizationLine,
      evidence: {
        lineKey: input.lineKey,
        productGid: input.productGid,
        variantGid: input.variantGid,
        productGlobalId: row.product_global_id,
        packMappingGlobalId: row.pack_mapping_global_id,
        packProfileVersionGlobalId: row.profile_version_global_id,
        packProfileVersionRowVersion: rowVersion,
        packageLevel: row.profile_package_level,
        baseEachQuantity,
        shipsAsOwnPackage: row.profile_ships_as_own_package,
        inventoryLevelGlobalIds: [] as string[],
        quantity: input.quantity,
        unitWeightGrams: providerWeight,
        sku: input.sku,
        requiresShipping: true,
      },
    }
  })
}

async function readMaterials(
  client: PoolClient,
  account: ShopifyCheckoutRatingAccount,
): Promise<MaterialRow[]> {
  const result = await client.query<MaterialRow>(
    `SELECT
       material.id::text AS material_id,
       material.global_id AS material_global_id,
       selected.packaging_material_row_version::text
         AS expected_row_version,
       material.row_version::text AS current_row_version,
       material.status,
       material.inner_length_mm,
       material.inner_width_mm,
       material.inner_height_mm,
       material.dimension_basis,
       material.dimension_evidence_type,
       material.dimension_evidence_reference,
       material.dimension_confirmed_at,
       material.rated_outer_length_mm,
       material.rated_outer_width_mm,
       material.rated_outer_height_mm,
       material.tare_weight_grams,
       material.max_weight_grams,
       material.unit_cost_minor::text,
       material.currency,
       stock.global_id AS stock_global_id,
       stock.row_version::text AS stock_row_version,
       stock.is_available AS stock_is_available,
       stock.on_hand_quantity AS stock_on_hand_quantity
     FROM operations_shopify_carrier_service_configs config
     JOIN operations_shopify_carrier_service_config_materials selected
       ON selected.organization_id = config.organization_id
      AND selected.config_id = config.id
     JOIN operations_packaging_materials material
       ON material.organization_id = selected.organization_id
      AND material.id = selected.packaging_material_id
     JOIN operations_packaging_material_stock stock
       ON stock.organization_id = material.organization_id
      AND stock.packaging_material_id = material.id
      AND stock.warehouse_id = config.warehouse_id
     WHERE config.organization_id = $1::uuid
       AND config.global_id = $2
       AND config.row_version = $3
     ORDER BY selected.selection_sequence`,
    [
      account.organizationId,
      account.configGlobalId,
      account.configRowVersion,
    ],
  )
  if (
    result.rows.length < 1
    || result.rows.length > 8
    || result.rows.length !== account.materials.length
  ) {
    fail(
      'SHOPIFY_CHECKOUT_MATERIAL_CONFIGURATION_STALE',
      'Approved checkout packaging material configuration is incomplete',
    )
  }
  return result.rows
}

function mapMaterials(rows: MaterialRow[]) {
  return rows.map((row) => {
    const expected = integer(
      row.expected_row_version,
      `${row.material_global_id} selected row version`,
    )
    const current = integer(
      row.current_row_version,
      `${row.material_global_id} current row version`,
    )
    if (
      expected !== current
      || row.status !== 'active'
      || row.dimension_basis === 'unspecified'
      || row.dimension_evidence_type === 'unknown'
      || !row.dimension_evidence_reference
      || row.dimension_confirmed_at === null
      || row.stock_is_available !== true
      || row.unit_cost_minor === null
      || !row.currency
      || !/^[A-Z]{3}$/.test(row.currency)
      || integer(
        row.stock_on_hand_quantity,
        `${row.material_global_id} stock`,
      ) < 1
    ) {
      fail(
        'SHOPIFY_CHECKOUT_MATERIAL_EVIDENCE_NOT_READY',
        'Approved checkout packaging material evidence is stale or unavailable',
      )
    }
    const inner = {
      length: integer(
        row.inner_length_mm,
        `${row.material_global_id} inner length`,
        1,
      ),
      width: integer(
        row.inner_width_mm,
        `${row.material_global_id} inner width`,
        1,
      ),
      height: integer(
        row.inner_height_mm,
        `${row.material_global_id} inner height`,
        1,
      ),
    }
    const ratedOuter = {
      length: integer(
        row.rated_outer_length_mm,
        `${row.material_global_id} rated outer length`,
        1,
      ),
      width: integer(
        row.rated_outer_width_mm,
        `${row.material_global_id} rated outer width`,
        1,
      ),
      height: integer(
        row.rated_outer_height_mm,
        `${row.material_global_id} rated outer height`,
        1,
      ),
    }
    const tareWeightGrams = integer(
      row.tare_weight_grams,
      `${row.material_global_id} tare weight`,
      1,
    )
    const maxWeightGrams = integer(
      row.max_weight_grams,
      `${row.material_global_id} maximum weight`,
      1,
    )
    const unitCostMinor = integer(
      row.unit_cost_minor,
      `${row.material_global_id} unit cost`,
      1,
    )
    const stockOnHandQuantity = integer(
      row.stock_on_hand_quantity,
      `${row.material_global_id} stock`,
      1,
    )
    const stockRowVersion = integer(
      row.stock_row_version,
      `${row.material_global_id} stock row version`,
    )
    return {
      id: row.material_id,
      input: {
        materialGlobalId: row.material_global_id,
        capturedRowVersion: expected,
        currentRowVersion: current,
        isCurrent: true,
        status: 'active',
        innerDimensionsMm: inner,
        dimensionBasis: row.dimension_basis,
        dimensionEvidenceType: row.dimension_evidence_type,
        dimensionEvidenceReference: row.dimension_evidence_reference,
        dimensionConfirmedAt: timestamp(
          row.dimension_confirmed_at,
          `${row.material_global_id} dimension confirmation`,
        ),
        tareWeightGrams,
        maximumGrossWeightGrams: maxWeightGrams,
        availableQuantity: stockOnHandQuantity,
        ratedOuterDimensionsMm: ratedOuter,
      } satisfies HybridCartonizationMaterial,
      evidence: {
        materialGlobalId: row.material_global_id,
        rowVersion: current,
        stockGlobalId: row.stock_global_id,
        stockRowVersion,
        maxWeightGrams,
        stockOnHandQuantity,
        unitCostMinor,
        currency: row.currency,
      },
    }
  })
}

async function readRecipes(
  client: PoolClient,
  account: ShopifyCheckoutRatingAccount,
  lines: Array<{ productId: string; profileVersionId: string }>,
  materialIds: string[],
): Promise<RecipeRow[]> {
  const result = await client.query<RecipeRow>(
    `SELECT
       recipe.global_id,
       recipe.row_version::text,
       recipe.product_id::text,
       product.reference_code AS product_global_id,
       recipe.input_pack_profile_version_id::text
         AS input_profile_version_id,
       input_version.global_id AS input_profile_version_global_id,
       output_version.global_id AS output_profile_version_global_id,
       material.global_id AS packaging_material_global_id,
       recipe.recipe_type,
       recipe.input_quantity,
       recipe.minimum_input_quantity,
       recipe.content_compatibility_key,
       recipe.allows_mixed_products,
       recipe.exclusive_contents,
       recipe.lifecycle_state,
       recipe.fit_evidence_type,
       recipe.fit_evidence_reference,
       recipe.confirmed_at,
       recipe.is_current
     FROM operations_approved_pack_recipes recipe
     JOIN crm_products product
       ON product.pipeline_id = recipe.pipeline_id
      AND product.id = recipe.product_id
     JOIN operations_product_pack_profile_versions input_version
       ON input_version.organization_id = recipe.organization_id
      AND input_version.id = recipe.input_pack_profile_version_id
     JOIN operations_product_pack_profile_versions output_version
       ON output_version.organization_id = recipe.organization_id
      AND output_version.id = recipe.output_pack_profile_version_id
     JOIN operations_packaging_materials material
       ON material.organization_id = recipe.organization_id
      AND material.id = recipe.packaging_material_id
     WHERE recipe.organization_id = $1::uuid
       AND recipe.product_id = ANY($2::uuid[])
       AND recipe.packaging_material_id = ANY($3::uuid[])
       AND recipe.lifecycle_state = 'active'
       AND recipe.is_current = true
     ORDER BY product.reference_code, material.global_id, recipe.global_id`,
    [
      account.organizationId,
      [...new Set(lines.map((line) => line.productId))],
      materialIds,
    ],
  )
  const pairs = new Set(lines.map(
    (line) => `${line.productId}:${line.profileVersionId}`,
  ))
  return result.rows.filter(
    (row) => pairs.has(`${row.product_id}:${row.input_profile_version_id}`),
  )
}

function mapRecipes(rows: RecipeRow[]): HybridCartonizationRecipe[] {
  return rows.map((row) => {
    const rowVersion = integer(
      row.row_version,
      `${row.global_id} recipe row version`,
    )
    return {
      recipeGlobalId: row.global_id,
      productGlobalId: row.product_global_id,
      inputPackProfileVersionGlobalId:
        row.input_profile_version_global_id,
      outputPackProfileVersionGlobalId:
        row.output_profile_version_global_id,
      packagingMaterialGlobalId: row.packaging_material_global_id,
      recipeType: row.recipe_type,
      maximumInputQuantity: integer(
        row.input_quantity,
        `${row.global_id} input quantity`,
        1,
      ),
      minimumInputQuantity: row.minimum_input_quantity === null
        ? null
        : integer(
            row.minimum_input_quantity,
            `${row.global_id} minimum input quantity`,
            1,
          ),
      contentCompatibilityKey: row.content_compatibility_key,
      allowsMixedProducts: row.allows_mixed_products,
      exclusiveContents: row.exclusive_contents,
      capturedRowVersion: rowVersion,
      currentRowVersion: rowVersion,
      isCurrent: row.is_current,
      lifecycleState: row.lifecycle_state,
      fitEvidenceType: row.fit_evidence_type,
      fitEvidenceReference: row.fit_evidence_reference,
      confirmedAt: row.confirmed_at === null
        ? null
        : timestamp(row.confirmed_at, `${row.global_id} confirmation`),
    }
  })
}

async function readLatestInventory(
  client: PoolClient,
  account: ShopifyCheckoutRatingAccount,
  mappedLines: Array<{
    productId: string
    inventoryItemId: string
    line: HybridCartonizationLine
    evidence: ShopifyCheckoutContextResult['lines'][number]
  }>,
) {
  const runResult = await client.query<{
    id: string
    global_id: string
    provider_fetched_at: Date | string
  }>(
    `SELECT id::text, global_id, provider_fetched_at
     FROM operations_commerce_inventory_sync_runs
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND warehouse_id = $3::uuid
       AND status = 'succeeded'
     ORDER BY provider_fetched_at DESC, completed_at DESC, id DESC
     LIMIT 1`,
    [
      account.organizationId,
      account.integrationAccountId,
      account.warehouseId,
    ],
  )
  const run = runResult.rows[0]
  if (!run) {
    fail(
      'SHOPIFY_CHECKOUT_INVENTORY_SYNC_REQUIRED',
      'No successful current inventory snapshot exists for checkout rating',
    )
  }
  const fetchedAt = timestamp(
    run.provider_fetched_at,
    'Inventory provider fetch timestamp',
  )
  if (
    Date.now() - Date.parse(fetchedAt)
      > account.inventoryMaxAgeSeconds * 1_000
  ) {
    fail(
      'SHOPIFY_CHECKOUT_INVENTORY_STALE',
      'The retained Shopify inventory snapshot is too old for checkout rating',
    )
  }
  const inventoryResult = await client.query<InventoryRow>(
    `WITH requested AS (
       SELECT *
       FROM jsonb_to_recordset($5::jsonb) AS item(
         variant_gid text,
         product_id uuid,
         external_inventory_item_id text
       )
     )
     SELECT
       requested.variant_gid,
       requested.external_inventory_item_id,
       sum(level.operational_available_quantity)::text
         AS operational_available_quantity,
       array_agg(level.global_id ORDER BY level.global_id)
         AS source_level_global_ids
     FROM requested
     JOIN operations_commerce_inventory_levels level
       ON level.organization_id = $1::uuid
      AND level.integration_account_id = $2::uuid
      AND level.warehouse_id = $3::uuid
      AND level.sync_run_id = $4::uuid
      AND level.product_id = requested.product_id
      AND level.external_inventory_item_id =
            requested.external_inventory_item_id
      AND level.mapping_state = 'mapped'
      AND level.projection_state = 'projected'
     GROUP BY
       requested.variant_gid,
       requested.external_inventory_item_id
     ORDER BY requested.variant_gid`,
    [
      account.organizationId,
      account.integrationAccountId,
      account.warehouseId,
      run.id,
      JSON.stringify(
        [...new Map(mappedLines.map((line) => [
          line.evidence.variantGid,
          {
            variant_gid: line.evidence.variantGid,
            product_id: line.productId,
            external_inventory_item_id: line.inventoryItemId,
          },
        ])).values()],
      ),
    ],
  )
  const inventoryByVariant = new Map(
    inventoryResult.rows.map((row) => [row.variant_gid, row]),
  )
  const requiredByVariant = new Map<string, number>()
  for (const line of mappedLines) {
    requiredByVariant.set(
      line.evidence.variantGid,
      (requiredByVariant.get(line.evidence.variantGid) || 0)
        + line.line.quantity,
    )
  }
  for (const [variantGid, required] of requiredByVariant) {
    const inventory = inventoryByVariant.get(variantGid)
    if (
      !inventory
      || integer(
        inventory.operational_available_quantity,
        `${variantGid} operational availability`,
      ) < required
    ) {
      fail(
        'SHOPIFY_CHECKOUT_INVENTORY_UNAVAILABLE',
        'Current operational inventory cannot satisfy the checkout request',
      )
    }
  }
  for (const line of mappedLines) {
    line.evidence.inventoryLevelGlobalIds =
      inventoryByVariant.get(line.evidence.variantGid)
        ?.source_level_global_ids || []
  }
  const inventorySnapshotHash = createHash('sha256')
    .update(JSON.stringify({
      fetchedAt,
      syncRunGlobalId: run.global_id,
      variants: [...inventoryByVariant.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([variantGid, row]) => ({
          variantGid,
          inventoryItemId: row.external_inventory_item_id,
          operationalAvailableQuantity:
            String(row.operational_available_quantity),
          sourceLevelGlobalIds: row.source_level_global_ids,
        })),
    }))
    .digest('hex')
  return { fetchedAt, inventorySnapshotHash }
}

/**
 * Reads exact Shopify variant, active pack-recipe, approved material, and
 * fresh inventory evidence in one repeatable-read transaction. It never
 * performs SKU matching, inventory reservation, CRM writes, or provider writes.
 */
export async function readShopifyCheckoutContextFromPostgres(input: {
  account: ShopifyCheckoutRatingAccount
  lines: ShopifyCheckoutContextLine[]
}): Promise<ShopifyCheckoutContextResult> {
  if (
    input.lines.length < 1
    || input.lines.length > 250
    || input.lines.some((line) => !line.requiresShipping)
  ) {
    fail(
      'SHOPIFY_CHECKOUT_SHIPPABLE_LINES_REQUIRED',
      'Checkout rating requires one or more shippable items',
    )
  }
  const client = await getPostgresPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const readResult = await client.query<{ read_at: Date | string }>(
      'SELECT transaction_timestamp() AS read_at',
    )
    const requestedByKey = new Map(
      input.lines.map((line) => [line.lineKey, line]),
    )
    const [lineRows, materialRows] = await Promise.all([
      readLines(client, input.account, input.lines),
      readMaterials(client, input.account),
    ])
    const mappedLines = mapLines(lineRows, requestedByKey)
    const materials = mapMaterials(materialRows)
    const [recipeRows, inventorySnapshot] = await Promise.all([
      readRecipes(
        client,
        input.account,
        mappedLines,
        materials.map((material) => material.id),
      ),
      readLatestInventory(client, input.account, mappedLines),
    ])
    const result: ShopifyCheckoutContextResult = {
      readAt: timestamp(readResult.rows[0]?.read_at, 'Checkout read timestamp'),
      inventorySnapshotAt: inventorySnapshot.fetchedAt,
      inventorySnapshotHash: inventorySnapshot.inventorySnapshotHash,
      input: {
        mode: 'production',
        lines: mappedLines.map((line) => line.line),
        recipes: mapRecipes(recipeRows),
        materials: materials.map((material) => material.input),
      },
      lines: mappedLines.map((line) => line.evidence),
      materials: materials.map((material) => material.evidence),
    }
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original read failure.
    }
    throw error
  } finally {
    client.release()
  }
}
