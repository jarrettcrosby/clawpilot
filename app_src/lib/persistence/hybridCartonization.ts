import type { PoolClient } from 'pg'
import type {
  HybridCartonizationInput,
  HybridCartonizationLine,
  HybridCartonizationMaterial,
  HybridCartonizationRecipe,
} from '@/lib/operations/hybridCartonization'
import { getPostgresPool } from '@/lib/persistence/postgres'

export type HybridCartonizationMaterialSelection = {
  materialGlobalId: string
  expectedRowVersion: number
}

export type HybridCartonizationCommittedAssumption = {
  lineGlobalId: string
  quantity: number
}

export type HybridCartonizationReadRequest = {
  organizationId: string
  accountGlobalId: string
  candidateGlobalId: string
  expectedCandidateRowVersion: number
  warehouseGlobalId: string
  mode: HybridCartonizationInput['mode']
  selectedMaterials: HybridCartonizationMaterialSelection[]
  assumedCommittedQuantities: HybridCartonizationCommittedAssumption[]
}

export type HybridCartonizationInventoryLineEvidence = {
  lineGlobalId: string
  productGlobalId: string
  requiredQuantity: number
  assumedCommittedQuantity: number
}

export type HybridCartonizationInventoryProductEvidence = {
  productGlobalId: string
  requiredQuantity: number
  availabilityAuthority:
    | 'operational_available'
    | 'shopify_provider_commitment'
  operationalAvailableQuantity: number
  providerCommittedQuantity: number
  assumedCommittedQuantity: number
  effectiveAvailableQuantity: number
  sourceLevelGlobalIds: string[]
  sourceProjectionStates: HybridCartonizationInventoryProjectionState[]
}

export type HybridCartonizationInventoryProjectionState =
  | 'projected'
  | 'negative_available'

export type HybridCartonizationReadResult = {
  readAt: string
  account: {
    globalId: string
    provider: 'shopify' | 'faire'
    status: 'active' | 'disabled'
  }
  candidate: {
    globalId: string
    orderNumber: string
    rowVersion: number
    sourceHash: string
    workflowState: string
  }
  warehouse: {
    globalId: string
    name: string
  }
  inventory: {
    syncRunGlobalId: string
    providerFetchedAt: string
    completedAt: string
    lines: HybridCartonizationInventoryLineEvidence[]
    products: HybridCartonizationInventoryProductEvidence[]
  }
  materialEvidence: Array<{
    globalId: string
    name: string
    rowVersion: number
    status: 'draft' | 'active'
    source: string
    ratedOuterDimensionsMm: {
      length: number
      width: number
      height: number
    } | null
    ratedOuterDimensionEvidenceType:
      | 'customer_confirmed'
      | 'measured'
      | 'provider'
      | 'legacy'
      | null
    ratedOuterDimensionEvidenceReference: string | null
    ratedOuterDimensionConfirmedAt: string | null
    stock: {
      isAvailable: boolean
      onHandQuantity: number | null
      rowVersion: number | null
    } | null
  }>
  recipeEvidence: Array<{
    globalId: string
    rowVersion: number
    productGlobalId: string
    inputPackProfileVersionGlobalId: string
    packagingMaterialGlobalId: string
  }>
  lineEvidence: Array<{
    lineGlobalId: string
    productGlobalId: string
    variantPackMappingGlobalId: string
    capturedMappingRowVersion: number
    currentMappingRowVersion: number
    packProfileVersionGlobalId: string
    capturedProfileRowVersion: number
    currentProfileRowVersion: number
    fitModel: HybridCartonizationLine['profile']['fitModel']
    packagingState: string
    packagingSource: string
    weightSource: 'profile_version' | 'provider_order' | 'provider_catalog'
    weightGrams: number
    channelSourceRevision: string
    channelSourceHash: string
    packLineageSource:
      | 'order_candidate_capture'
      | 'matched_shopify_checkout_receipt'
    checkoutReceiptGlobalId: string | null
  }>
  input: HybridCartonizationInput
}

type AccountRow = {
  id: string
  global_id: string
  provider: 'shopify' | 'faire'
  status: 'active' | 'disabled' | 'error'
}

type CandidateRow = {
  id: string
  global_id: string
  order_number_snapshot: string
  row_version: string
  source_hash: string
  workflow_state: string
  expires_at: Date | string
  checkout_shipping_service_code: string | null
}

export function assertHybridCartonizationCandidateEligible(input: {
  mode: HybridCartonizationInput['mode']
  workflowState: string
  expiresAt: Date | string
  now?: Date
}) {
  const prePromotionState = ['held', 'resolving', 'ready'].includes(
    input.workflowState,
  )
  const promotedOperationalState = (
    input.mode === 'production'
    && input.workflowState === 'promoted'
  )
  if (!prePromotionState && !promotedOperationalState) {
    fail(
      input.workflowState === 'promoted'
        ? 'A promoted order candidate can use only operational cartonization'
        : 'The order candidate is not eligible for cartonization',
      422,
      'HYBRID_CARTONIZATION_CANDIDATE_STATE_INVALID',
    )
  }

  // Promotion turns the candidate into durable source lineage for the
  // canonical order. Its review-window expiry no longer governs warehouse
  // planning, while every pre-promotion preview/evidence path remains bounded
  // by that window.
  if (input.workflowState === 'promoted') return

  const expiresAt = new Date(input.expiresAt)
  const now = input.now || new Date()
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    fail(
      'The order candidate expired; refresh it before cartonization',
      409,
      'HYBRID_CARTONIZATION_CANDIDATE_EXPIRED',
    )
  }
}

type WarehouseRow = {
  id: string
  global_id: string
  name: string
}

type InventoryRunRow = {
  id: string
  global_id: string
  provider_fetched_at: Date | string
  completed_at: Date | string
}

type CandidateLineRow = {
  global_id: string
  product_id: string | null
  product_global_id: string | null
  product_title_snapshot: string
  variant_title_snapshot: string | null
  external_product_id: string | null
  external_variant_id: string | null
  requires_shipping: boolean
  ordered_quantity: string
  unfulfilled_quantity: string
  mapping_state: string
  packaging_state: string
  packaging_source: string
  packaging_weight_source: string | null
  weight_grams: number | null
  pack_mapping_id: string | null
  pack_mapping_global_id: string | null
  captured_pack_mapping_row_version: string | null
  current_pack_mapping_row_version: string | null
  pack_mapping_is_current: boolean | null
  pack_mapping_projection_state: string | null
  pack_mapping_source_revision: string | null
  pack_mapping_source_hash: string | null
  channel_source_revision: string | null
  channel_source_hash: string | null
  channel_weight_grams: number | null
  pack_profile_version_id: string | null
  pack_profile_version_global_id: string | null
  captured_pack_profile_row_version: string | null
  current_pack_profile_row_version: string | null
  pack_profile_is_current: boolean | null
  pack_profile_lifecycle_state:
    | 'draft'
    | 'customer_confirmed'
    | 'active'
    | 'superseded'
    | 'retired'
    | null
  pack_profile_fit_model:
    | 'rigid_3d'
    | 'compressible'
    | 'approved_recipe_only'
    | null
  pack_profile_evidence_type:
    | 'unknown'
    | 'customer_confirmed'
    | 'measured'
    | 'provider'
    | 'derived'
    | 'legacy'
    | null
  pack_profile_evidence_reference: string | null
  pack_profile_confirmed_at: Date | string | null
  pack_profile_status: string | null
  pack_profile_base_each_quantity: number | null
  current_pack_profile_base_each_quantity: number | null
  current_pack_profile_length_mm: number | null
  current_pack_profile_width_mm: number | null
  current_pack_profile_height_mm: number | null
  current_pack_profile_dimension_basis:
    | 'inner'
    | 'outer'
    | 'unspecified'
    | null
  current_pack_profile_gross_weight_grams: number | null
  current_pack_profile_weight_basis: string | null
  pack_lineage_source:
    | 'order_candidate_capture'
    | 'matched_shopify_checkout_receipt'
  checkout_receipt_global_id: string | null
}

type MatchedCheckoutReconciliationRow = {
  outcome: 'matched' | 'ambiguous' | 'rejected' | 'expired'
  source_shopify_service_code: string | null
  receipt_id: string | null
  receipt_global_id: string | null
  receipt_status: string | null
}

type MatchedCheckoutReceiptLineRow = {
  receipt_global_id: string
  line_key: string
  provider_variant_id: string
  quantity: number
  unit_weight_grams: number
  line_snapshot: Record<string, unknown>
  pack_mapping_id: string | null
  pack_mapping_global_id: string | null
  pack_mapping_row_version: string | null
  pack_mapping_product_id: string | null
  pack_mapping_external_product_id: string | null
  pack_mapping_external_variant_id: string | null
  pack_mapping_purpose: string | null
  pack_mapping_projection_state: string | null
  pack_mapping_is_current: boolean | null
  pack_mapping_source_revision: string | null
  pack_mapping_source_hash: string | null
  product_global_id: string | null
  channel_source_revision: string | null
  channel_source_hash: string | null
  channel_weight_grams: number | null
  pack_profile_version_id: string | null
  pack_profile_version_global_id: string | null
  pack_profile_version_row_version: string | null
  pack_profile_is_current: boolean | null
  pack_profile_lifecycle_state:
    | 'draft'
    | 'customer_confirmed'
    | 'active'
    | 'superseded'
    | 'retired'
    | null
  pack_profile_fit_model:
    | 'rigid_3d'
    | 'compressible'
    | 'approved_recipe_only'
    | null
  pack_profile_evidence_type:
    | 'unknown'
    | 'customer_confirmed'
    | 'measured'
    | 'provider'
    | 'derived'
    | 'legacy'
    | null
  pack_profile_evidence_reference: string | null
  pack_profile_confirmed_at: Date | string | null
  pack_profile_status: string | null
  pack_profile_package_level:
    | 'each'
    | 'inner_pack'
    | 'case'
    | 'pallet'
    | null
  pack_profile_base_each_quantity: number | null
  pack_profile_length_mm: number | null
  pack_profile_width_mm: number | null
  pack_profile_height_mm: number | null
  pack_profile_dimension_basis:
    | 'inner'
    | 'outer'
    | 'unspecified'
    | null
  pack_profile_gross_weight_grams: number | null
  pack_profile_weight_basis: string | null
}

export function resolveOperationalShopifyCheckoutReconciliation(input: {
  candidateServiceCode: string | null
  rows: MatchedCheckoutReconciliationRow[]
}): (MatchedCheckoutReconciliationRow & {
  outcome: 'matched'
  source_shopify_service_code: string
  receipt_id: string
  receipt_global_id: string
  receipt_status: 'succeeded'
}) | null {
  const clawPilotCheckout =
    input.candidateServiceCode?.startsWith('clawpilot:') === true
  if (input.rows.length === 0) {
    if (clawPilotCheckout) {
      fail(
        'The promoted ClawPilot checkout has no current Shopify rate reconciliation',
        409,
        'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
      )
    }
    return null
  }
  if (input.rows.length !== 1) {
    fail(
      'The promoted order has conflicting Shopify checkout rate reconciliations',
      409,
      'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
    )
  }
  const matched = input.rows[0]
  if (matched.outcome !== 'matched') {
    if (clawPilotCheckout) {
      fail(
        `The promoted ClawPilot checkout rate reconciliation is ${matched.outcome}`,
        409,
        'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
      )
    }
    return null
  }
  if (
    !clawPilotCheckout
    || matched.source_shopify_service_code !== input.candidateServiceCode
    || !matched.receipt_id
    || !matched.receipt_global_id
    || matched.receipt_status !== 'succeeded'
  ) {
    fail(
      'The matched Shopify checkout decision has no valid succeeded receipt',
      409,
      'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
    )
  }
  return matched as MatchedCheckoutReconciliationRow & {
    outcome: 'matched'
    source_shopify_service_code: string
    receipt_id: string
    receipt_global_id: string
    receipt_status: 'succeeded'
  }
}

type MaterialRow = {
  id: string
  global_id: string
  name: string
  status: 'draft' | 'active'
  source: string
  row_version: string
  inner_length_mm: number | null
  inner_width_mm: number | null
  inner_height_mm: number | null
  rated_outer_length_mm: number | null
  rated_outer_width_mm: number | null
  rated_outer_height_mm: number | null
  rated_outer_dimension_evidence_type:
    | 'customer_confirmed'
    | 'measured'
    | 'provider'
    | 'legacy'
    | null
  rated_outer_dimension_evidence_reference: string | null
  rated_outer_dimension_confirmed_at: Date | string | null
  dimension_basis: 'inner' | 'outer' | 'unspecified'
  dimension_evidence_type:
    | 'unknown'
    | 'customer_confirmed'
    | 'measured'
    | 'provider'
    | 'legacy'
  dimension_evidence_reference: string | null
  dimension_confirmed_at: Date | string | null
  tare_weight_grams: number | null
  max_weight_grams: number | null
  stock_is_available: boolean | null
  stock_on_hand_quantity: number | null
  stock_row_version: string | null
}

type RecipeRow = {
  global_id: string
  row_version: string
  product_id: string
  product_global_id: string
  input_pack_profile_version_id: string
  input_pack_profile_version_global_id: string
  output_pack_profile_version_global_id: string
  packaging_material_id: string
  packaging_material_global_id: string
  recipe_type: 'exact_case' | 'max_capacity' | 'ship_ready_unit'
  input_quantity: number
  minimum_input_quantity: number | null
  content_compatibility_key: string | null
  allows_mixed_products: boolean
  exclusive_contents: boolean
  lifecycle_state: 'draft' | 'customer_confirmed' | 'active' | 'retired'
  fit_evidence_type:
    | 'unknown'
    | 'customer_confirmed'
    | 'measured'
    | 'provider'
    | 'derived'
  fit_evidence_reference: string | null
  confirmed_at: Date | string | null
  is_current: boolean
}

type InventoryProductRow = {
  product_id: string
  product_global_id: string
  operational_available_quantity: string
  provider_committed_quantity: string
  source_level_global_ids: string[]
  source_projection_states: HybridCartonizationInventoryProjectionState[]
}

type ReadTimeRow = {
  read_at: Date | string
}

type InventoryEvaluationLine = {
  lineGlobalId: string
  productGlobalId: string
  requiredQuantity: number
}

type InventoryEvaluationPosition = {
  productGlobalId: string
  operationalAvailableQuantity: number
  providerCommittedQuantity: number
  sourceLevelGlobalIds: string[]
  sourceProjectionStates: HybridCartonizationInventoryProjectionState[]
}

export class HybridCartonizationPersistenceError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status = 409,
    code = 'HYBRID_CARTONIZATION_EVIDENCE_INVALID',
  ) {
    super(message)
    this.name = 'HybridCartonizationPersistenceError'
    this.status = status
    this.code = code
  }
}

function fail(
  message: string,
  status = 409,
  code = 'HYBRID_CARTONIZATION_EVIDENCE_INVALID',
): never {
  throw new HybridCartonizationPersistenceError(message, status, code)
}

function exactInteger(
  value: string | number | null,
  label: string,
  minimum = 0,
) {
  if (value === null || value === '') {
    fail(
      `${label} is missing`,
      500,
      'HYBRID_CARTONIZATION_EVIDENCE_CORRUPT',
    )
  }
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum) {
    fail(
      `${label} is not an exact safe integer`,
      500,
      'HYBRID_CARTONIZATION_EVIDENCE_CORRUPT',
    )
  }
  return result
}

function checkoutSnapshotText(
  snapshot: Record<string, unknown>,
  key: string,
  label: string,
) {
  const value = snapshot[key]
  if (typeof value !== 'string' || value.trim() === '') {
    fail(
      `${label} is missing from matched checkout evidence`,
      409,
      'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
    )
  }
  return value.trim()
}

function checkoutSnapshotInteger(
  snapshot: Record<string, unknown>,
  key: string,
  label: string,
) {
  const value = snapshot[key]
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(
      `${label} is invalid in matched checkout evidence`,
      409,
      'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
    )
  }
  return Number(value)
}

export function assertMatchedShopifyCheckoutPackLineage(input: {
  candidateLineGlobalId: string
  candidateProductId: string | null
  candidateProductGlobalId: string | null
  candidateExternalProductId: string | null
  candidateExternalVariantId: string | null
  receiptLine: MatchedCheckoutReceiptLineRow
}) {
  const { receiptLine: row } = input
  const label = `${input.candidateLineGlobalId} matched checkout pack lineage`
  const snapshot = row.line_snapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail(
      `${label} has no immutable line snapshot`,
      409,
      'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
    )
  }
  const snapshotVariantId = checkoutSnapshotText(
    snapshot,
    'variantGid',
    `${label} variant`,
  )
  const snapshotProductId = checkoutSnapshotText(
    snapshot,
    'productGid',
    `${label} provider product`,
  )
  const snapshotProductGlobalId = checkoutSnapshotText(
    snapshot,
    'productGlobalId',
    `${label} CRM product`,
  )
  const snapshotMappingGlobalId = checkoutSnapshotText(
    snapshot,
    'packMappingGlobalId',
    `${label} mapping`,
  )
  const snapshotProfileGlobalId = checkoutSnapshotText(
    snapshot,
    'packProfileVersionGlobalId',
    `${label} profile version`,
  )
  const snapshotProfileRowVersion = checkoutSnapshotInteger(
    snapshot,
    'packProfileVersionRowVersion',
    `${label} profile row version`,
  )
  const snapshotQuantity = checkoutSnapshotInteger(
    snapshot,
    'quantity',
    `${label} quantity`,
  )
  const snapshotUnitWeightGrams = checkoutSnapshotInteger(
    snapshot,
    'unitWeightGrams',
    `${label} unit weight`,
  )
  const snapshotBaseEachQuantity = checkoutSnapshotInteger(
    snapshot,
    'baseEachQuantity',
    `${label} base-each quantity`,
  )
  const snapshotPackageLevel = checkoutSnapshotText(
    snapshot,
    'packageLevel',
    `${label} package level`,
  )
  const snapshotMappingRowVersion = snapshot.packMappingRowVersion === undefined
    ? null
    : checkoutSnapshotInteger(
        snapshot,
        'packMappingRowVersion',
        `${label} mapping row version`,
      )
  const currentMappingRowVersion = exactInteger(
    row.pack_mapping_row_version,
    `${label} current mapping row version`,
  )
  const currentProfileRowVersion = exactInteger(
    row.pack_profile_version_row_version,
    `${label} current profile row version`,
  )
  if (
    !input.candidateProductId
    || !input.candidateProductGlobalId
    || !input.candidateExternalProductId
    || !input.candidateExternalVariantId
    || snapshotVariantId !== row.provider_variant_id
    || snapshotVariantId !== input.candidateExternalVariantId
    || snapshotProductId !== input.candidateExternalProductId
    || snapshotProductGlobalId !== input.candidateProductGlobalId
    || row.pack_mapping_product_id !== input.candidateProductId
    || row.pack_mapping_external_product_id !== snapshotProductId
    || row.pack_mapping_external_variant_id !== snapshotVariantId
    || row.pack_mapping_global_id !== snapshotMappingGlobalId
    || row.pack_mapping_purpose !== 'shopify_checkout'
    || row.pack_mapping_projection_state !== 'current'
    || row.pack_mapping_is_current !== true
    || !row.pack_mapping_source_revision
    || !row.pack_mapping_source_hash
    || row.pack_mapping_source_revision !== row.channel_source_revision
    || row.pack_mapping_source_hash !== row.channel_source_hash
    || row.product_global_id !== snapshotProductGlobalId
    || row.pack_profile_version_global_id !== snapshotProfileGlobalId
    || snapshotProfileRowVersion !== currentProfileRowVersion
    || (
      snapshotMappingRowVersion !== null
      && snapshotMappingRowVersion !== currentMappingRowVersion
    )
    || row.pack_profile_is_current !== true
    || row.pack_profile_lifecycle_state !== 'active'
    || row.pack_profile_status !== 'active'
    || row.pack_profile_package_level !== snapshotPackageLevel
    || row.pack_profile_base_each_quantity !== snapshotBaseEachQuantity
    || snapshotQuantity !== row.quantity
    || snapshotUnitWeightGrams !== row.unit_weight_grams
    || row.channel_weight_grams !== row.unit_weight_grams
    || (
      row.pack_profile_gross_weight_grams !== null
      && row.pack_profile_gross_weight_grams !== row.unit_weight_grams
    )
  ) {
    fail(
      `${label} no longer matches its exact Shopify checkout mapping and profile`,
      409,
      'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
    )
  }
  return {
    mappingRowVersion: snapshotMappingRowVersion
      ?? currentMappingRowVersion,
    profileRowVersion: snapshotProfileRowVersion,
  }
}

function inputInteger(
  value: unknown,
  label: string,
  minimum = 0,
) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(`${label} is invalid`, 400, 'HYBRID_CARTONIZATION_REQUEST_INVALID')
  }
  return Number(value)
}

function timestamp(
  value: Date | string | null,
  label: string,
): string | null {
  if (value === null) return null
  const result = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(result.getTime())) {
    fail(
      `${label} is invalid`,
      500,
      'HYBRID_CARTONIZATION_EVIDENCE_CORRUPT',
    )
  }
  return result.toISOString()
}

function requiredTimestamp(value: Date | string, label: string) {
  return timestamp(value, label) as string
}

function exactReference(
  value: unknown,
  pattern: RegExp,
  label: string,
) {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!pattern.test(result)) {
    fail(`${label} is invalid`, 400, 'HYBRID_CARTONIZATION_REQUEST_INVALID')
  }
  return result
}

export function normalizeHybridCartonizationReadRequest(
  input: HybridCartonizationReadRequest,
): HybridCartonizationReadRequest {
  const organizationId = typeof input.organizationId === 'string'
    ? input.organizationId.trim()
    : ''
  if (!organizationId) {
    fail(
      'Organization ID is required',
      400,
      'HYBRID_CARTONIZATION_REQUEST_INVALID',
    )
  }
  const accountGlobalId = exactReference(
    input.accountGlobalId,
    /^gia[0-9]{7}$/,
    'Commerce account Global ID',
  )
  const candidateGlobalId = exactReference(
    input.candidateGlobalId,
    /^gcoc[0-9]{7}$/,
    'Order candidate Global ID',
  )
  const warehouseGlobalId = exactReference(
    input.warehouseGlobalId,
    /^gwh[0-9]{7}$/,
    'Warehouse Global ID',
  )
  const expectedCandidateRowVersion = inputInteger(
    input.expectedCandidateRowVersion,
    'Expected candidate row version',
  )
  if (!['production', 'sandbox_demo'].includes(input.mode)) {
    fail(
      'Cartonization mode is invalid',
      400,
      'HYBRID_CARTONIZATION_REQUEST_INVALID',
    )
  }
  if (
    !Array.isArray(input.selectedMaterials)
    || input.selectedMaterials.length < 1
    || input.selectedMaterials.length > 8
  ) {
    fail(
      'Select between one and eight packaging materials',
      400,
      'HYBRID_CARTONIZATION_REQUEST_INVALID',
    )
  }
  const materialIds = new Set<string>()
  const selectedMaterials = input.selectedMaterials.map((selection, index) => {
    const materialGlobalId = exactReference(
      selection?.materialGlobalId,
      /^gmat[0-9]{7}$/,
      `Selected material ${index + 1} Global ID`,
    )
    if (materialIds.has(materialGlobalId)) {
      fail(
        'Selected packaging materials must be unique',
        400,
        'HYBRID_CARTONIZATION_REQUEST_INVALID',
      )
    }
    materialIds.add(materialGlobalId)
    return {
      materialGlobalId,
      expectedRowVersion: inputInteger(
        selection?.expectedRowVersion,
        `${materialGlobalId} expected row version`,
      ),
    }
  })
  if (!Array.isArray(input.assumedCommittedQuantities)) {
    fail(
      'Assumed committed quantities must be supplied as an array',
      400,
      'HYBRID_CARTONIZATION_REQUEST_INVALID',
    )
  }
  const lineIds = new Set<string>()
  const assumedCommittedQuantities = input.assumedCommittedQuantities.map(
    (assumption, index) => {
      const lineGlobalId = exactReference(
        assumption?.lineGlobalId,
        /^gcol[0-9]{7}$/,
        `Committed assumption ${index + 1} line Global ID`,
      )
      if (lineIds.has(lineGlobalId)) {
        fail(
          'Each order line may have only one committed-quantity assumption',
          400,
          'HYBRID_CARTONIZATION_REQUEST_INVALID',
        )
      }
      lineIds.add(lineGlobalId)
      return {
        lineGlobalId,
        quantity: inputInteger(
          assumption?.quantity,
          `${lineGlobalId} assumed committed quantity`,
        ),
      }
    },
  )
  return {
    organizationId,
    accountGlobalId,
    candidateGlobalId,
    expectedCandidateRowVersion,
    warehouseGlobalId,
    mode: input.mode,
    selectedMaterials,
    assumedCommittedQuantities,
  }
}

export function evaluateHybridCartonizationInventoryAvailability(input: {
  mode?: HybridCartonizationReadRequest['mode']
  provider?: HybridCartonizationReadResult['account']['provider']
  lines: InventoryEvaluationLine[]
  positions: InventoryEvaluationPosition[]
  assumedCommittedQuantities: HybridCartonizationCommittedAssumption[]
}) {
  if (
    input.mode === 'production'
    && input.assumedCommittedQuantities.length > 0
  ) {
    fail(
      'Production cartonization cannot accept operator-entered committed inventory assumptions',
      400,
      'HYBRID_CARTONIZATION_PRODUCTION_ASSUMPTIONS_FORBIDDEN',
    )
  }
  if (input.mode === 'production' && !input.provider) {
    fail(
      'Production cartonization requires an explicit commerce provider inventory authority',
      400,
      'HYBRID_CARTONIZATION_PRODUCTION_PROVIDER_REQUIRED',
    )
  }
  const assumptionsByLine = new Map(
    input.assumedCommittedQuantities.map((entry) => [
      entry.lineGlobalId,
      entry.quantity,
    ]),
  )
  if (
    input.mode !== 'production'
    && assumptionsByLine.size !== input.lines.length
  ) {
    fail(
      'Record an explicit committed quantity, including zero, for every shipping line',
      422,
      'HYBRID_CARTONIZATION_COMMITTED_ASSUMPTION_REQUIRED',
    )
  }
  const lineIds = new Set(input.lines.map((line) => line.lineGlobalId))
  const unknownAssumptions = input.assumedCommittedQuantities.filter(
    (entry) => !lineIds.has(entry.lineGlobalId),
  )
  if (unknownAssumptions.length > 0) {
    fail(
      'A committed-quantity assumption references a line outside this order',
      422,
      'HYBRID_CARTONIZATION_COMMITTED_ASSUMPTION_STALE',
    )
  }

  const positionByProduct = new Map<string, InventoryEvaluationPosition>()
  for (const position of input.positions) {
    if (positionByProduct.has(position.productGlobalId)) {
      fail(
        `Inventory evidence for ${position.productGlobalId} is ambiguous`,
        500,
        'HYBRID_CARTONIZATION_INVENTORY_EVIDENCE_AMBIGUOUS',
      )
    }
    positionByProduct.set(position.productGlobalId, position)
  }

  const lineEvidence: HybridCartonizationInventoryLineEvidence[] = []
  const totals = new Map<string, {
    required: number
    assumed: number
  }>()
  for (const line of input.lines) {
    const assumed = input.mode === 'production'
      ? 0
      : assumptionsByLine.get(line.lineGlobalId)
    if (assumed === undefined) {
      fail(
        `Committed quantity for ${line.lineGlobalId} is missing`,
        422,
        'HYBRID_CARTONIZATION_COMMITTED_ASSUMPTION_REQUIRED',
      )
    }
    if (assumed > line.requiredQuantity) {
      fail(
        `Committed quantity for ${line.lineGlobalId} exceeds its order quantity`,
        422,
        'HYBRID_CARTONIZATION_COMMITTED_ASSUMPTION_INVALID',
      )
    }
    lineEvidence.push({
      lineGlobalId: line.lineGlobalId,
      productGlobalId: line.productGlobalId,
      requiredQuantity: line.requiredQuantity,
      assumedCommittedQuantity: assumed,
    })
    const current = totals.get(line.productGlobalId) || {
      required: 0,
      assumed: 0,
    }
    current.required += line.requiredQuantity
    current.assumed += assumed
    totals.set(line.productGlobalId, current)
  }

  const productEvidence: HybridCartonizationInventoryProductEvidence[] = []
  for (const [productGlobalId, total] of totals) {
    const position = positionByProduct.get(productGlobalId)
    const operationalAvailableQuantity =
      position?.operationalAvailableQuantity ?? 0
    const providerCommittedQuantity =
      position?.providerCommittedQuantity ?? 0
    if (total.assumed > providerCommittedQuantity) {
      fail(
        `Assumed committed inventory for ${productGlobalId} exceeds the latest provider evidence`,
        422,
        'HYBRID_CARTONIZATION_COMMITTED_ASSUMPTION_UNSUPPORTED',
      )
    }
    const availabilityAuthority = (
      input.mode === 'production'
      && input.provider === 'shopify'
    )
      ? 'shopify_provider_commitment'
      : 'operational_available'
    const effectiveAvailableQuantity =
      availabilityAuthority === 'shopify_provider_commitment'
        ? providerCommittedQuantity
        : operationalAvailableQuantity + total.assumed
    if (total.required > effectiveAvailableQuantity) {
      fail(
        `Latest inventory cannot cover ${total.required} unit(s) of ${productGlobalId}`,
        422,
        'HYBRID_CARTONIZATION_INVENTORY_INSUFFICIENT',
      )
    }
    productEvidence.push({
      productGlobalId,
      requiredQuantity: total.required,
      availabilityAuthority,
      operationalAvailableQuantity,
      providerCommittedQuantity,
      assumedCommittedQuantity: total.assumed,
      effectiveAvailableQuantity,
      sourceLevelGlobalIds: position?.sourceLevelGlobalIds || [],
      sourceProjectionStates: position?.sourceProjectionStates || [],
    })
  }
  return {
    lines: lineEvidence.sort((left, right) => (
      left.lineGlobalId.localeCompare(right.lineGlobalId)
    )),
    products: productEvidence.sort((left, right) => (
      left.productGlobalId.localeCompare(right.productGlobalId)
    )),
  }
}

export function hybridCartonizationInventoryProjectionStates(
  mode: HybridCartonizationReadRequest['mode'],
): HybridCartonizationInventoryProjectionState[] {
  return mode === 'sandbox_demo'
    ? ['projected', 'negative_available']
    : ['projected']
}

async function readAccount(
  client: PoolClient,
  input: HybridCartonizationReadRequest,
) {
  const result = await client.query<AccountRow>(
    `SELECT
       account.id::text,
       account.global_id,
       account.provider,
       account.status
     FROM operations_integration_accounts account
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
     LIMIT 1`,
    [input.organizationId, input.accountGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'The selected active commerce account is unavailable in this organization',
      404,
      'HYBRID_CARTONIZATION_ACCOUNT_NOT_FOUND',
    )
  }
  if (
    row.status !== 'active'
    && !(input.mode === 'sandbox_demo' && row.status === 'disabled')
  ) {
    fail(
      input.mode === 'production'
        ? 'The selected commerce account must be active for production cartonization'
        : 'The selected commerce account is not eligible for a read-only sandbox demonstration',
      422,
      'HYBRID_CARTONIZATION_ACCOUNT_INELIGIBLE',
    )
  }
  return row
}

async function readCandidate(
  client: PoolClient,
  input: HybridCartonizationReadRequest,
  account: AccountRow,
) {
  const result = await client.query<CandidateRow>(
    `SELECT
       candidate.id::text,
       candidate.global_id,
       candidate.order_number_snapshot,
       candidate.row_version::text,
       candidate.source_hash,
       candidate.workflow_state,
       candidate.expires_at,
       candidate.checkout_shipping_service_code
     FROM operations_commerce_order_candidates candidate
     WHERE candidate.organization_id = $1::uuid
       AND candidate.integration_account_id = $2::uuid
       AND candidate.global_id = $3
     LIMIT 1`,
    [input.organizationId, account.id, input.candidateGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'The selected order candidate is unavailable for this commerce account',
      404,
      'HYBRID_CARTONIZATION_CANDIDATE_NOT_FOUND',
    )
  }
  const rowVersion = exactInteger(
    row.row_version,
    'Order candidate row version',
  )
  if (rowVersion !== input.expectedCandidateRowVersion) {
    fail(
      'The order candidate changed; reload before cartonization',
      409,
      'HYBRID_CARTONIZATION_CANDIDATE_REVISION_CONFLICT',
    )
  }
  assertHybridCartonizationCandidateEligible({
    mode: input.mode,
    workflowState: row.workflow_state,
    expiresAt: row.expires_at,
  })
  return { row, rowVersion }
}

async function readWarehouse(
  client: PoolClient,
  input: HybridCartonizationReadRequest,
) {
  const result = await client.query<WarehouseRow>(
    `SELECT warehouse.id::text, warehouse.global_id, warehouse.name
     FROM operations_warehouses warehouse
     WHERE warehouse.organization_id = $1::uuid
       AND warehouse.global_id = $2
       AND warehouse.status = 'active'
     LIMIT 1`,
    [input.organizationId, input.warehouseGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'The requested active warehouse is unavailable in this organization',
      404,
      'HYBRID_CARTONIZATION_WAREHOUSE_NOT_FOUND',
    )
  }
  return row
}

async function readLatestInventoryRun(
  client: PoolClient,
  input: HybridCartonizationReadRequest,
  account: AccountRow,
  warehouse: WarehouseRow,
) {
  const result = await client.query<InventoryRunRow>(
    `SELECT
       run.id::text,
       run.global_id,
       run.provider_fetched_at,
       run.completed_at
     FROM operations_commerce_inventory_sync_runs run
     WHERE run.organization_id = $1::uuid
       AND run.integration_account_id = $2::uuid
       AND run.warehouse_id = $3::uuid
       AND run.status = 'succeeded'
     ORDER BY
       run.provider_fetched_at DESC,
       run.completed_at DESC,
       run.id DESC
     LIMIT 1`,
    [input.organizationId, account.id, warehouse.id],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'No successful inventory sync exists for this account and warehouse',
      422,
      'HYBRID_CARTONIZATION_INVENTORY_SYNC_REQUIRED',
    )
  }
  return row
}

async function readMatchedCheckoutPackLineage(
  client: PoolClient,
  input: HybridCartonizationReadRequest,
  account: AccountRow,
  candidate: CandidateRow,
) {
  if (
    input.mode !== 'production'
    || account.provider !== 'shopify'
    || candidate.workflow_state !== 'promoted'
  ) return null

  const reconciliation = await client.query<MatchedCheckoutReconciliationRow>(
     `SELECT
       reconciliation.outcome,
       reconciliation.source_shopify_service_code,
       reconciliation.receipt_id::text,
       receipt.global_id AS receipt_global_id,
       receipt.status AS receipt_status
     FROM operations_shopify_checkout_rate_current_reconciliations
            reconciliation
     LEFT JOIN operations_shopify_checkout_rate_receipts receipt
       ON receipt.organization_id = reconciliation.organization_id
      AND receipt.id = reconciliation.receipt_id
      AND receipt.integration_account_id = $2::uuid
     WHERE reconciliation.organization_id = $1::uuid
       AND reconciliation.integration_account_id = $2::uuid
       AND reconciliation.order_candidate_id = $3::uuid
     ORDER BY reconciliation.created_at, reconciliation.id`,
    [input.organizationId, account.id, candidate.id],
  )
  const matched = resolveOperationalShopifyCheckoutReconciliation({
    candidateServiceCode: candidate.checkout_shipping_service_code,
    rows: reconciliation.rows,
  })
  if (!matched) return null
  const lines = await client.query<MatchedCheckoutReceiptLineRow>(
    `SELECT
       receipt.global_id AS receipt_global_id,
       receipt_line.line_key,
       receipt_line.provider_variant_id,
       receipt_line.quantity,
       receipt_line.unit_weight_grams,
       receipt_line.line_snapshot,
       pack_mapping.id::text AS pack_mapping_id,
       pack_mapping.global_id AS pack_mapping_global_id,
       pack_mapping.row_version::text AS pack_mapping_row_version,
       pack_mapping.product_id::text AS pack_mapping_product_id,
       pack_mapping.external_product_id
         AS pack_mapping_external_product_id,
       pack_mapping.external_variant_id
         AS pack_mapping_external_variant_id,
       pack_mapping.mapping_purpose AS pack_mapping_purpose,
       pack_mapping.projection_state AS pack_mapping_projection_state,
       pack_mapping.is_current AS pack_mapping_is_current,
       pack_mapping.source_revision AS pack_mapping_source_revision,
       pack_mapping.source_hash AS pack_mapping_source_hash,
       product.reference_code AS product_global_id,
       channel_state.source_revision AS channel_source_revision,
       channel_state.source_hash AS channel_source_hash,
       channel_state.weight_grams AS channel_weight_grams,
       pack_version.id::text AS pack_profile_version_id,
       pack_version.global_id AS pack_profile_version_global_id,
       pack_version.row_version::text AS pack_profile_version_row_version,
       pack_version.is_current AS pack_profile_is_current,
       pack_version.lifecycle_state AS pack_profile_lifecycle_state,
       pack_version.fit_model AS pack_profile_fit_model,
       pack_version.evidence_type AS pack_profile_evidence_type,
       pack_version.evidence_reference
         AS pack_profile_evidence_reference,
       pack_version.confirmed_at AS pack_profile_confirmed_at,
       pack_profile.status AS pack_profile_status,
       pack_profile.package_level AS pack_profile_package_level,
       pack_version.base_each_quantity
         AS pack_profile_base_each_quantity,
       pack_version.length_mm AS pack_profile_length_mm,
       pack_version.width_mm AS pack_profile_width_mm,
       pack_version.height_mm AS pack_profile_height_mm,
       pack_version.dimension_basis AS pack_profile_dimension_basis,
       pack_version.gross_weight_grams
         AS pack_profile_gross_weight_grams,
       pack_version.weight_basis AS pack_profile_weight_basis
     FROM operations_shopify_checkout_rate_receipts receipt
     JOIN operations_shopify_checkout_rate_receipt_lines receipt_line
       ON receipt_line.organization_id = receipt.organization_id
      AND receipt_line.receipt_id = receipt.id
     LEFT JOIN operations_commerce_variant_pack_mappings pack_mapping
       ON pack_mapping.organization_id = receipt.organization_id
      AND pack_mapping.integration_account_id =
            receipt.integration_account_id
      AND pack_mapping.provider = 'shopify'
      AND pack_mapping.external_variant_id =
            receipt_line.provider_variant_id
      AND pack_mapping.global_id =
            receipt_line.line_snapshot ->> 'packMappingGlobalId'
     LEFT JOIN crm_products product
       ON product.pipeline_id = pack_mapping.pipeline_id
      AND product.id = pack_mapping.product_id
     LEFT JOIN operations_product_channel_states channel_state
       ON channel_state.organization_id = pack_mapping.organization_id
      AND channel_state.integration_account_id =
            pack_mapping.integration_account_id
      AND channel_state.pipeline_id = pack_mapping.pipeline_id
      AND channel_state.provider = pack_mapping.provider
      AND channel_state.external_product_id =
            pack_mapping.external_product_id
      AND channel_state.external_variant_id =
            pack_mapping.external_variant_id
      AND channel_state.product_id = pack_mapping.product_id
     LEFT JOIN operations_product_pack_profile_versions pack_version
       ON pack_version.organization_id = pack_mapping.organization_id
      AND pack_version.pipeline_id = pack_mapping.pipeline_id
      AND pack_version.product_id = pack_mapping.product_id
      AND pack_version.id = pack_mapping.default_pack_profile_version_id
      AND pack_version.global_id =
            receipt_line.line_snapshot ->> 'packProfileVersionGlobalId'
     LEFT JOIN operations_product_pack_profiles pack_profile
       ON pack_profile.organization_id = pack_version.organization_id
      AND pack_profile.pipeline_id = pack_version.pipeline_id
      AND pack_profile.product_id = pack_version.product_id
      AND pack_profile.id = pack_version.profile_id
     WHERE receipt.organization_id = $1::uuid
       AND receipt.integration_account_id = $2::uuid
       AND receipt.id = $3::uuid
     ORDER BY receipt_line.provider_variant_id, receipt_line.line_key`,
    [input.organizationId, account.id, matched.receipt_id],
  )
  if (lines.rows.length === 0) {
    fail(
      'The matched Shopify checkout receipt has no retained line evidence',
      409,
      'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
    )
  }
  return { receiptGlobalId: matched.receipt_global_id, lines: lines.rows }
}

function applyMatchedCheckoutPackLineage(
  candidateRows: CandidateLineRow[],
  matched: {
    receiptGlobalId: string
    lines: MatchedCheckoutReceiptLineRow[]
  },
) {
  const candidateByVariant = new Map<string, CandidateLineRow[]>()
  for (const row of candidateRows) {
    if (!row.external_variant_id) {
      fail(
        `${row.product_title_snapshot} has no Shopify variant identity for its matched checkout quote`,
        409,
        'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
      )
    }
    const grouped = candidateByVariant.get(row.external_variant_id) || []
    grouped.push(row)
    candidateByVariant.set(row.external_variant_id, grouped)
  }
  const receiptByVariant = new Map<string, MatchedCheckoutReceiptLineRow[]>()
  for (const row of matched.lines) {
    const grouped = receiptByVariant.get(row.provider_variant_id) || []
    grouped.push(row)
    receiptByVariant.set(row.provider_variant_id, grouped)
  }
  if (
    candidateByVariant.size !== receiptByVariant.size
    || [...candidateByVariant.keys()].some(
      (variantId) => !receiptByVariant.has(variantId),
    )
    || [...receiptByVariant.keys()].some(
      (variantId) => !candidateByVariant.has(variantId),
    )
  ) {
    fail(
      'The promoted order lines no longer match the exact Shopify checkout variants',
      409,
      'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
    )
  }
  const effectiveByVariant = new Map<string, {
    row: MatchedCheckoutReceiptLineRow
    mappingRowVersion: number
    profileRowVersion: number
  }>()
  for (const [variantId, candidateLines] of candidateByVariant) {
    const receiptLines = receiptByVariant.get(variantId) || []
    const candidateQuantity = candidateLines.reduce((total, row) => (
      total + exactInteger(
        row.ordered_quantity,
        `${row.global_id} ordered quantity`,
        1,
      )
    ), 0)
    const receiptQuantity = receiptLines.reduce((total, row) => (
      total + exactInteger(
        row.quantity,
        `${row.line_key} checkout quantity`,
        1,
      )
    ), 0)
    if (candidateQuantity !== receiptQuantity) {
      fail(
        `Shopify variant ${variantId} ordered quantity no longer matches checkout rating`,
        409,
        'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
      )
    }
    const activeCandidateLines = candidateLines.filter((row) => (
      exactInteger(
        row.unfulfilled_quantity,
        `${row.global_id} unfulfilled quantity`,
        0,
      ) > 0
    ))
    if (activeCandidateLines.length === 0) continue
    const candidateLine = activeCandidateLines[0]
    const receiptLine = receiptLines[0]
    const captured = assertMatchedShopifyCheckoutPackLineage({
      candidateLineGlobalId: candidateLine.global_id,
      candidateProductId: candidateLine.product_id,
      candidateProductGlobalId: candidateLine.product_global_id,
      candidateExternalProductId: candidateLine.external_product_id,
      candidateExternalVariantId: candidateLine.external_variant_id,
      receiptLine,
    })
    for (const comparedLine of receiptLines.slice(1)) {
      const compared = assertMatchedShopifyCheckoutPackLineage({
        candidateLineGlobalId: candidateLine.global_id,
        candidateProductId: candidateLine.product_id,
        candidateProductGlobalId: candidateLine.product_global_id,
        candidateExternalProductId: candidateLine.external_product_id,
        candidateExternalVariantId: candidateLine.external_variant_id,
        receiptLine: comparedLine,
      })
      if (
        comparedLine.pack_mapping_global_id
          !== receiptLine.pack_mapping_global_id
        || comparedLine.pack_profile_version_global_id
          !== receiptLine.pack_profile_version_global_id
        || compared.mappingRowVersion !== captured.mappingRowVersion
        || compared.profileRowVersion !== captured.profileRowVersion
      ) {
        fail(
          `Shopify variant ${variantId} has conflicting checkout pack lineage`,
          409,
          'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
        )
      }
    }
    for (const comparedLine of activeCandidateLines.slice(1)) {
      assertMatchedShopifyCheckoutPackLineage({
        candidateLineGlobalId: comparedLine.global_id,
        candidateProductId: comparedLine.product_id,
        candidateProductGlobalId: comparedLine.product_global_id,
        candidateExternalProductId: comparedLine.external_product_id,
        candidateExternalVariantId: comparedLine.external_variant_id,
        receiptLine,
      })
    }
    effectiveByVariant.set(variantId, { row: receiptLine, ...captured })
  }
  return candidateRows.filter((row) => (
    exactInteger(
      row.unfulfilled_quantity,
      `${row.global_id} unfulfilled quantity`,
      0,
    ) > 0
  )).map((row): CandidateLineRow => {
    const effective = effectiveByVariant.get(row.external_variant_id || '')
    if (!effective) {
      fail(
        `${row.product_title_snapshot} has no exact matched checkout pack lineage`,
        409,
        'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
      )
    }
    const receipt = effective.row
    const recipeOnly =
      receipt.pack_profile_fit_model === 'approved_recipe_only'
    return {
      ...row,
      mapping_state: 'resolved',
      packaging_state: recipeOnly ? 'unresolved' : 'resolved',
      packaging_source: 'variant_pack_mapping',
      packaging_weight_source: recipeOnly ? null : 'provider_catalog',
      weight_grams: recipeOnly ? null : receipt.unit_weight_grams,
      pack_mapping_id: receipt.pack_mapping_id,
      pack_mapping_global_id: receipt.pack_mapping_global_id,
      captured_pack_mapping_row_version: String(effective.mappingRowVersion),
      current_pack_mapping_row_version: receipt.pack_mapping_row_version,
      pack_mapping_is_current: receipt.pack_mapping_is_current,
      pack_mapping_projection_state: receipt.pack_mapping_projection_state,
      pack_mapping_source_revision: receipt.pack_mapping_source_revision,
      pack_mapping_source_hash: receipt.pack_mapping_source_hash,
      channel_source_revision: receipt.channel_source_revision,
      channel_source_hash: receipt.channel_source_hash,
      channel_weight_grams: receipt.channel_weight_grams,
      pack_profile_version_id: receipt.pack_profile_version_id,
      pack_profile_version_global_id:
        receipt.pack_profile_version_global_id,
      captured_pack_profile_row_version: String(effective.profileRowVersion),
      current_pack_profile_row_version:
        receipt.pack_profile_version_row_version,
      pack_profile_is_current: receipt.pack_profile_is_current,
      pack_profile_lifecycle_state: receipt.pack_profile_lifecycle_state,
      pack_profile_fit_model: receipt.pack_profile_fit_model,
      pack_profile_evidence_type: receipt.pack_profile_evidence_type,
      pack_profile_evidence_reference:
        receipt.pack_profile_evidence_reference,
      pack_profile_confirmed_at: receipt.pack_profile_confirmed_at,
      pack_profile_status: receipt.pack_profile_status,
      pack_profile_base_each_quantity:
        receipt.pack_profile_base_each_quantity,
      current_pack_profile_base_each_quantity:
        receipt.pack_profile_base_each_quantity,
      current_pack_profile_length_mm: receipt.pack_profile_length_mm,
      current_pack_profile_width_mm: receipt.pack_profile_width_mm,
      current_pack_profile_height_mm: receipt.pack_profile_height_mm,
      current_pack_profile_dimension_basis:
        receipt.pack_profile_dimension_basis,
      current_pack_profile_gross_weight_grams:
        receipt.pack_profile_gross_weight_grams,
      current_pack_profile_weight_basis: receipt.pack_profile_weight_basis,
      pack_lineage_source: 'matched_shopify_checkout_receipt',
      checkout_receipt_global_id: matched.receiptGlobalId,
    }
  })
}

async function readCandidateLines(
  client: PoolClient,
  input: HybridCartonizationReadRequest,
  account: AccountRow,
  candidate: CandidateRow,
) {
  const result = await client.query<CandidateLineRow>(
    `SELECT
       line.global_id,
       line.product_id::text,
       product.reference_code AS product_global_id,
       line.product_title_snapshot,
       line.variant_title_snapshot,
       line.external_product_id,
       line.external_variant_id,
       line.requires_shipping,
       line.ordered_quantity::text,
       line.unfulfilled_quantity::text,
       line.mapping_state,
       line.packaging_state,
       line.packaging_source,
       line.packaging_weight_source,
       line.weight_grams,
       pack_mapping.id::text AS pack_mapping_id,
       pack_mapping.global_id AS pack_mapping_global_id,
       line.commerce_variant_pack_mapping_row_version::text
         AS captured_pack_mapping_row_version,
       pack_mapping.row_version::text
         AS current_pack_mapping_row_version,
       pack_mapping.is_current AS pack_mapping_is_current,
       pack_mapping.projection_state AS pack_mapping_projection_state,
       pack_mapping.source_revision AS pack_mapping_source_revision,
       pack_mapping.source_hash AS pack_mapping_source_hash,
       channel_state.source_revision AS channel_source_revision,
       channel_state.source_hash AS channel_source_hash,
       channel_state.weight_grams AS channel_weight_grams,
       pack_version.id::text AS pack_profile_version_id,
       pack_version.global_id AS pack_profile_version_global_id,
       line.pack_profile_version_row_version::text
         AS captured_pack_profile_row_version,
       pack_version.row_version::text
         AS current_pack_profile_row_version,
       pack_version.is_current AS pack_profile_is_current,
       pack_version.lifecycle_state AS pack_profile_lifecycle_state,
       pack_version.fit_model AS pack_profile_fit_model,
       pack_version.evidence_type AS pack_profile_evidence_type,
       pack_version.evidence_reference AS pack_profile_evidence_reference,
       pack_version.confirmed_at AS pack_profile_confirmed_at,
       pack_profile.status AS pack_profile_status,
       line.pack_profile_base_each_quantity,
       pack_version.base_each_quantity
         AS current_pack_profile_base_each_quantity,
       pack_version.length_mm AS current_pack_profile_length_mm,
       pack_version.width_mm AS current_pack_profile_width_mm,
       pack_version.height_mm AS current_pack_profile_height_mm,
       pack_version.dimension_basis
         AS current_pack_profile_dimension_basis,
       pack_version.gross_weight_grams
         AS current_pack_profile_gross_weight_grams,
       pack_version.weight_basis AS current_pack_profile_weight_basis,
       'order_candidate_capture'::text AS pack_lineage_source,
       NULL::text AS checkout_receipt_global_id
     FROM operations_commerce_order_candidate_lines line
     LEFT JOIN crm_products product
       ON product.pipeline_id = line.pipeline_id
      AND product.id = line.product_id
     LEFT JOIN operations_commerce_variant_pack_mappings pack_mapping
       ON pack_mapping.organization_id = line.organization_id
      AND pack_mapping.integration_account_id =
            line.integration_account_id
      AND pack_mapping.pipeline_id = line.pipeline_id
      AND pack_mapping.product_id = line.product_id
      AND pack_mapping.id = line.commerce_variant_pack_mapping_id
      AND pack_mapping.default_pack_profile_version_id =
            line.pack_profile_version_id
     LEFT JOIN operations_product_pack_profile_versions pack_version
       ON pack_version.organization_id = line.organization_id
      AND pack_version.pipeline_id = line.pipeline_id
      AND pack_version.product_id = line.product_id
      AND pack_version.id = line.pack_profile_version_id
     LEFT JOIN operations_product_pack_profiles pack_profile
       ON pack_profile.organization_id = pack_version.organization_id
      AND pack_profile.pipeline_id = pack_version.pipeline_id
      AND pack_profile.product_id = pack_version.product_id
      AND pack_profile.id = pack_version.profile_id
     LEFT JOIN operations_product_channel_states channel_state
       ON channel_state.organization_id = line.organization_id
      AND channel_state.integration_account_id =
            line.integration_account_id
      AND channel_state.pipeline_id = line.pipeline_id
      AND channel_state.provider = line.provider
      AND channel_state.external_product_id = line.external_product_id
      AND channel_state.external_variant_id = line.external_variant_id
      AND channel_state.product_id = line.product_id
      AND channel_state.product_mapping_id = line.product_mapping_id
     WHERE line.organization_id = $1::uuid
       AND line.integration_account_id = $2::uuid
       AND line.order_candidate_id = $3::uuid
       AND line.requires_shipping = true
     ORDER BY line.created_at, line.id`,
    [input.organizationId, account.id, candidate.id],
  )
  if (result.rows.length === 0) {
    fail(
      'The order has no unfulfilled shipping lines to cartonize',
      422,
      'HYBRID_CARTONIZATION_LINES_REQUIRED',
    )
  }
  const matched = await readMatchedCheckoutPackLineage(
    client,
    input,
    account,
    candidate,
  )
  const lineageRows = matched
    ? applyMatchedCheckoutPackLineage(result.rows, matched)
    : result.rows
  const unfulfilledRows = lineageRows.filter((row) => (
    exactInteger(
      row.unfulfilled_quantity,
      `${row.global_id} unfulfilled quantity`,
      0,
    ) > 0
  ))
  if (unfulfilledRows.length === 0) {
    fail(
      'The order has no unfulfilled shipping lines to cartonize',
      422,
      'HYBRID_CARTONIZATION_LINES_REQUIRED',
    )
  }
  return unfulfilledRows
}

function mapCandidateLines(
  input: HybridCartonizationReadRequest,
  rows: CandidateLineRow[],
) {
  return rows.map((row): {
    productId: string
    packProfileVersionId: string
    line: HybridCartonizationLine
    evidence: HybridCartonizationReadResult['lineEvidence'][number]
  } => {
    const quantity = exactInteger(
      row.unfulfilled_quantity,
      `${row.global_id} unfulfilled quantity`,
      1,
    )
    const recipeOnlyAssociation = (
      row.pack_profile_fit_model === 'approved_recipe_only'
      && row.packaging_state === 'unresolved'
      && row.packaging_source === 'variant_pack_mapping'
      && row.weight_grams === null
      && row.packaging_weight_source === null
      && row.current_pack_profile_length_mm === null
      && row.current_pack_profile_width_mm === null
      && row.current_pack_profile_height_mm === null
      && row.current_pack_profile_dimension_basis === 'unspecified'
    )
    if (
      !row.product_id
      || !row.product_global_id
      || row.mapping_state !== 'resolved'
      || (
        row.packaging_state !== 'resolved'
        && !recipeOnlyAssociation
      )
      || row.packaging_source !== 'variant_pack_mapping'
      || !row.pack_mapping_id
      || !row.pack_mapping_global_id
      || row.captured_pack_mapping_row_version === null
      || row.current_pack_mapping_row_version === null
      || row.pack_mapping_is_current !== true
      || row.pack_mapping_projection_state !== 'current'
      || !row.pack_mapping_source_revision
      || !row.pack_mapping_source_hash
      || !row.channel_source_revision
      || !row.channel_source_hash
      || !row.pack_profile_version_id
      || !row.pack_profile_version_global_id
      || row.captured_pack_profile_row_version === null
      || row.current_pack_profile_row_version === null
      || row.pack_profile_is_current !== true
      || row.pack_profile_status === 'retired'
      || !row.pack_profile_fit_model
      || !row.pack_profile_evidence_type
      || !row.pack_profile_evidence_reference
      || row.pack_profile_confirmed_at === null
      || !row.pack_profile_base_each_quantity
      || !row.current_pack_profile_base_each_quantity
    ) {
      fail(
        `${row.product_title_snapshot} lacks complete current mapped-pack evidence`,
        422,
        'HYBRID_CARTONIZATION_PACK_EVIDENCE_REQUIRED',
      )
    }
    const capturedMappingRowVersion = exactInteger(
      row.captured_pack_mapping_row_version,
      `${row.global_id} captured pack-mapping row version`,
    )
    const currentMappingRowVersion = exactInteger(
      row.current_pack_mapping_row_version,
      `${row.global_id} current pack-mapping row version`,
    )
    if (capturedMappingRowVersion !== currentMappingRowVersion) {
      fail(
        `${row.product_title_snapshot} pack mapping changed after order intake`,
        409,
        'HYBRID_CARTONIZATION_PACK_MAPPING_REVISION_CONFLICT',
      )
    }
    const capturedProfileRowVersion = exactInteger(
      row.captured_pack_profile_row_version,
      `${row.global_id} captured pack-profile row version`,
    )
    const currentProfileRowVersion = exactInteger(
      row.current_pack_profile_row_version,
      `${row.global_id} current pack-profile row version`,
    )
    if (capturedProfileRowVersion !== currentProfileRowVersion) {
      fail(
        `${row.product_title_snapshot} pack profile changed after order intake`,
        409,
        'HYBRID_CARTONIZATION_PACK_PROFILE_REVISION_CONFLICT',
      )
    }
    if (
      row.pack_mapping_source_revision !== row.channel_source_revision
      || row.pack_mapping_source_hash !== row.channel_source_hash
    ) {
      fail(
        `${row.product_title_snapshot} channel-pack evidence is stale`,
        409,
        'HYBRID_CARTONIZATION_CHANNEL_PACK_REVISION_CONFLICT',
      )
    }
    const eligibleLifecycle = input.mode === 'production'
      ? row.pack_profile_lifecycle_state === 'active'
      : ['customer_confirmed', 'active'].includes(
          row.pack_profile_lifecycle_state || '',
        )
    if (!eligibleLifecycle) {
      fail(
        `${row.product_title_snapshot} pack profile is not eligible in ${input.mode}`,
        422,
        'HYBRID_CARTONIZATION_PACK_PROFILE_STATE_INVALID',
      )
    }
    const unitWeightGrams = exactInteger(
      recipeOnlyAssociation
        ? row.channel_weight_grams
        : row.weight_grams,
      `${row.global_id} unit weight`,
      1,
    )
    if (
      row.packaging_weight_source === 'profile_version'
      && (
        row.current_pack_profile_gross_weight_grams !== unitWeightGrams
        || row.current_pack_profile_weight_basis === 'unspecified'
      )
    ) {
      fail(
        `${row.product_title_snapshot} profile weight changed after order intake`,
        409,
        'HYBRID_CARTONIZATION_LINE_WEIGHT_REVISION_CONFLICT',
      )
    }
    if (
      row.packaging_weight_source === 'provider_catalog'
      && row.channel_weight_grams !== unitWeightGrams
    ) {
      fail(
        `${row.product_title_snapshot} provider catalog weight changed after order intake`,
        409,
        'HYBRID_CARTONIZATION_LINE_WEIGHT_REVISION_CONFLICT',
      )
    }
    if (
      !recipeOnlyAssociation
      && ![
        'profile_version',
        'provider_order',
        'provider_catalog',
      ].includes(row.packaging_weight_source || '')
    ) {
      fail(
        `${row.product_title_snapshot} has no exact weight source`,
        422,
        'HYBRID_CARTONIZATION_LINE_WEIGHT_REQUIRED',
      )
    }
    if (
      row.pack_profile_base_each_quantity
      !== row.current_pack_profile_base_each_quantity
    ) {
      fail(
        `${row.product_title_snapshot} pack quantity changed after order intake`,
        409,
        'HYBRID_CARTONIZATION_PACK_PROFILE_REVISION_CONFLICT',
      )
    }
    const variant = row.variant_title_snapshot?.trim()
    const title = variant && variant.toLowerCase() !== 'default title'
      ? `${row.product_title_snapshot} · ${variant}`
      : row.product_title_snapshot
    const weightSource = recipeOnlyAssociation
      ? 'provider_catalog'
      : row.packaging_weight_source as
        | 'profile_version'
        | 'provider_order'
        | 'provider_catalog'
    return {
      productId: row.product_id,
      packProfileVersionId: row.pack_profile_version_id,
      line: {
        lineGlobalId: row.global_id,
        productGlobalId: row.product_global_id,
        title,
        quantity,
        unitWeightGrams,
        profile: {
          versionGlobalId: row.pack_profile_version_global_id,
          capturedRowVersion: capturedProfileRowVersion,
          currentRowVersion: currentProfileRowVersion,
          isCurrent: true,
          lifecycleState: row.pack_profile_lifecycle_state as
            HybridCartonizationLine['profile']['lifecycleState'],
          fitModel: row.pack_profile_fit_model,
          evidenceType: row.pack_profile_evidence_type,
          evidenceReference: row.pack_profile_evidence_reference,
          confirmedAt: timestamp(
            row.pack_profile_confirmed_at,
            `${row.global_id} pack-profile confirmation`,
          ),
        },
      },
      evidence: {
        lineGlobalId: row.global_id,
        productGlobalId: row.product_global_id,
        variantPackMappingGlobalId: row.pack_mapping_global_id,
        capturedMappingRowVersion,
        currentMappingRowVersion,
        packProfileVersionGlobalId: row.pack_profile_version_global_id,
        capturedProfileRowVersion,
        currentProfileRowVersion,
        fitModel: row.pack_profile_fit_model,
        packagingState: row.packaging_state,
        packagingSource: row.packaging_source,
        weightSource,
        weightGrams: unitWeightGrams,
        channelSourceRevision: row.channel_source_revision,
        channelSourceHash: row.channel_source_hash,
        packLineageSource: row.pack_lineage_source,
        checkoutReceiptGlobalId: row.checkout_receipt_global_id,
      },
    }
  })
}

async function readSelectedMaterials(
  client: PoolClient,
  input: HybridCartonizationReadRequest,
  warehouse: WarehouseRow,
) {
  const result = await client.query<MaterialRow>(
    `SELECT
       material.id::text,
       material.global_id,
       material.name,
       material.status,
       material.source,
       material.row_version::text,
       material.inner_length_mm,
       material.inner_width_mm,
       material.inner_height_mm,
       material.rated_outer_length_mm,
       material.rated_outer_width_mm,
       material.rated_outer_height_mm,
       material.rated_outer_dimension_evidence_type,
       material.rated_outer_dimension_evidence_reference,
       material.rated_outer_dimension_confirmed_at,
       material.dimension_basis,
       material.dimension_evidence_type,
       material.dimension_evidence_reference,
       material.dimension_confirmed_at,
       material.tare_weight_grams,
       material.max_weight_grams,
       stock.is_available AS stock_is_available,
       stock.on_hand_quantity AS stock_on_hand_quantity,
       stock.row_version::text AS stock_row_version
     FROM operations_packaging_materials material
     LEFT JOIN operations_packaging_material_stock stock
       ON stock.organization_id = material.organization_id
      AND stock.packaging_material_id = material.id
      AND stock.warehouse_id = $3::uuid
     WHERE material.organization_id = $1::uuid
       AND material.global_id = ANY($2::text[])
     ORDER BY material.global_id`,
    [
      input.organizationId,
      input.selectedMaterials.map((entry) => entry.materialGlobalId),
      warehouse.id,
    ],
  )
  if (result.rows.length !== input.selectedMaterials.length) {
    fail(
      'One or more selected packaging materials are unavailable in this organization',
      404,
      'HYBRID_CARTONIZATION_MATERIAL_NOT_FOUND',
    )
  }
  return result.rows
}

function mapSelectedMaterials(
  input: HybridCartonizationReadRequest,
  rows: MaterialRow[],
) {
  const expectedByGlobalId = new Map(
    input.selectedMaterials.map((entry) => [
      entry.materialGlobalId,
      entry.expectedRowVersion,
    ]),
  )
  return rows.map((row): {
    id: string
    input: HybridCartonizationMaterial
    evidence: HybridCartonizationReadResult['materialEvidence'][number]
  } => {
    const currentRowVersion = exactInteger(
      row.row_version,
      `${row.global_id} material row version`,
    )
    const expectedRowVersion = expectedByGlobalId.get(row.global_id)
    if (expectedRowVersion !== currentRowVersion) {
      fail(
        `${row.name} changed; reload packaging materials before cartonization`,
        409,
        'HYBRID_CARTONIZATION_MATERIAL_REVISION_CONFLICT',
      )
    }
    const eligible = input.mode === 'production'
      ? row.status === 'active'
      : (
          row.status === 'active'
          || (
            row.status === 'draft'
            && row.source === 'customer_supplied'
          )
        )
    if (!eligible) {
      fail(
        `${row.name} is not eligible in ${input.mode}`,
        422,
        'HYBRID_CARTONIZATION_MATERIAL_STATE_INVALID',
      )
    }
    const dimensions = {
      length: exactInteger(
        row.inner_length_mm,
        `${row.global_id} material length`,
        1,
      ),
      width: exactInteger(
        row.inner_width_mm,
        `${row.global_id} material width`,
        1,
      ),
      height: exactInteger(
        row.inner_height_mm,
        `${row.global_id} material height`,
        1,
      ),
    }
    const confirmedAt = timestamp(
      row.dimension_confirmed_at,
      `${row.global_id} dimension confirmation`,
    )
    if (
      row.dimension_evidence_type === 'unknown'
      || !row.dimension_evidence_reference
      || !confirmedAt
    ) {
      fail(
        `${row.name} has no retained dimension evidence`,
        422,
        'HYBRID_CARTONIZATION_MATERIAL_EVIDENCE_REQUIRED',
      )
    }
    const ratedOuterDimensionsMm = (
      row.rated_outer_length_mm === null
      || row.rated_outer_width_mm === null
      || row.rated_outer_height_mm === null
    )
      ? null
      : {
          length: exactInteger(
            row.rated_outer_length_mm,
            `${row.global_id} rated exterior length`,
            1,
          ),
          width: exactInteger(
            row.rated_outer_width_mm,
            `${row.global_id} rated exterior width`,
            1,
          ),
          height: exactInteger(
            row.rated_outer_height_mm,
            `${row.global_id} rated exterior height`,
            1,
          ),
        }
    const ratedOuterConfirmedAt = timestamp(
      row.rated_outer_dimension_confirmed_at,
      `${row.global_id} rated exterior confirmation`,
    )
    if (
      input.mode === 'production'
      && (
        !ratedOuterDimensionsMm
        || !['customer_confirmed', 'measured', 'provider'].includes(
          row.rated_outer_dimension_evidence_type || '',
        )
        || !row.rated_outer_dimension_evidence_reference
        || !ratedOuterConfirmedAt
      )
    ) {
      fail(
        `${row.name} has no current factual rated exterior measurement`,
        422,
        'HYBRID_CARTONIZATION_MATERIAL_RATE_EVIDENCE_REQUIRED',
      )
    }
    const stockRowVersion = row.stock_row_version === null
      ? null
      : exactInteger(
          row.stock_row_version,
          `${row.global_id} stock row version`,
        )
    if (
      input.mode === 'production'
      && (
        row.stock_is_available !== true
        || row.stock_on_hand_quantity === null
        || row.stock_on_hand_quantity <= 0
      )
    ) {
      fail(
        `${row.name} has no available stock at the selected warehouse`,
        422,
        'HYBRID_CARTONIZATION_MATERIAL_STOCK_REQUIRED',
      )
    }
    return {
      id: row.id,
      input: {
        materialGlobalId: row.global_id,
        capturedRowVersion: expectedRowVersion,
        currentRowVersion,
        isCurrent: true,
        status: row.status,
        innerDimensionsMm: dimensions,
        dimensionBasis: row.dimension_basis === 'unspecified'
          ? 'unconfirmed'
          : row.dimension_basis,
        dimensionEvidenceType: row.dimension_evidence_type,
        dimensionEvidenceReference: row.dimension_evidence_reference,
        dimensionConfirmedAt: confirmedAt,
        tareWeightGrams: row.tare_weight_grams,
        maximumGrossWeightGrams: row.max_weight_grams,
        availableQuantity: row.stock_on_hand_quantity,
        ratedOuterDimensionsMm,
      },
      evidence: {
        globalId: row.global_id,
        name: row.name,
        rowVersion: currentRowVersion,
        status: row.status,
        source: row.source,
        ratedOuterDimensionsMm,
        ratedOuterDimensionEvidenceType:
          row.rated_outer_dimension_evidence_type,
        ratedOuterDimensionEvidenceReference:
          row.rated_outer_dimension_evidence_reference,
        ratedOuterDimensionConfirmedAt: ratedOuterConfirmedAt,
        stock: stockRowVersion === null
          ? null
          : {
              isAvailable: row.stock_is_available === true,
              onHandQuantity: row.stock_on_hand_quantity,
              rowVersion: stockRowVersion,
            },
      },
    }
  })
}

async function readRecipes(
  client: PoolClient,
  input: HybridCartonizationReadRequest,
  lineEvidence: Array<{
    productId: string
    packProfileVersionId: string
  }>,
  materialIds: string[],
) {
  const result = await client.query<RecipeRow>(
    `SELECT
       recipe.global_id,
       recipe.row_version::text,
       recipe.product_id::text,
       product.reference_code AS product_global_id,
       recipe.input_pack_profile_version_id::text,
       input_version.global_id
         AS input_pack_profile_version_global_id,
       output_version.global_id
         AS output_pack_profile_version_global_id,
       recipe.packaging_material_id::text,
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
      AND input_version.pipeline_id = recipe.pipeline_id
      AND input_version.product_id = recipe.product_id
      AND input_version.id = recipe.input_pack_profile_version_id
     JOIN operations_product_pack_profile_versions output_version
       ON output_version.organization_id = recipe.organization_id
      AND output_version.pipeline_id = recipe.pipeline_id
      AND output_version.product_id = recipe.product_id
      AND output_version.id = recipe.output_pack_profile_version_id
     JOIN operations_packaging_materials material
       ON material.organization_id = recipe.organization_id
      AND material.id = recipe.packaging_material_id
     WHERE recipe.organization_id = $1::uuid
       AND recipe.product_id = ANY($2::uuid[])
       AND recipe.packaging_material_id = ANY($3::uuid[])
       AND recipe.is_current = true
       AND (
         ($4 = 'production' AND recipe.lifecycle_state = 'active')
         OR (
           $4 = 'sandbox_demo'
           AND recipe.lifecycle_state IN ('customer_confirmed', 'active')
         )
       )
     ORDER BY
       product.reference_code,
       material.global_id,
       recipe.global_id`,
    [
      input.organizationId,
      [...new Set(lineEvidence.map((entry) => entry.productId))],
      materialIds,
      input.mode,
    ],
  )
  const permittedPairs = new Set(
    lineEvidence.map((entry) => (
      `${entry.productId}:${entry.packProfileVersionId}`
    )),
  )
  return result.rows.filter((row) => permittedPairs.has(
    `${row.product_id}:${row.input_pack_profile_version_id}`,
  ))
}

function mapRecipes(rows: RecipeRow[]) {
  return rows.map((row): HybridCartonizationRecipe => ({
    recipeGlobalId: row.global_id,
    productGlobalId: row.product_global_id,
    inputPackProfileVersionGlobalId:
      row.input_pack_profile_version_global_id,
    outputPackProfileVersionGlobalId:
      row.output_pack_profile_version_global_id,
    packagingMaterialGlobalId: row.packaging_material_global_id,
    recipeType: row.recipe_type,
    maximumInputQuantity: exactInteger(
      row.input_quantity,
      `${row.global_id} maximum input quantity`,
      1,
    ),
    minimumInputQuantity: row.minimum_input_quantity === null
      ? null
      : exactInteger(
          row.minimum_input_quantity,
          `${row.global_id} minimum input quantity`,
          1,
        ),
    contentCompatibilityKey: row.content_compatibility_key,
    allowsMixedProducts: row.allows_mixed_products,
    exclusiveContents: row.exclusive_contents,
    capturedRowVersion: exactInteger(
      row.row_version,
      `${row.global_id} captured row version`,
    ),
    currentRowVersion: exactInteger(
      row.row_version,
      `${row.global_id} current row version`,
    ),
    isCurrent: row.is_current,
    lifecycleState: row.lifecycle_state,
    fitEvidenceType: row.fit_evidence_type,
    fitEvidenceReference: row.fit_evidence_reference,
    confirmedAt: timestamp(
      row.confirmed_at,
      `${row.global_id} recipe confirmation`,
    ),
  }))
}

async function readInventoryProducts(
  client: PoolClient,
  input: HybridCartonizationReadRequest,
  account: AccountRow,
  warehouse: WarehouseRow,
  inventoryRun: InventoryRunRow,
) {
  const result = await client.query<InventoryProductRow>(
    `SELECT
       level.product_id::text,
       product.reference_code AS product_global_id,
       sum(level.operational_available_quantity)::text
         AS operational_available_quantity,
       sum(level.provider_committed_quantity)::text
         AS provider_committed_quantity,
       array_agg(level.global_id ORDER BY level.global_id)
         AS source_level_global_ids,
       array_agg(
         DISTINCT level.projection_state
         ORDER BY level.projection_state
       ) AS source_projection_states
     FROM operations_commerce_inventory_levels level
     JOIN crm_products product
       ON product.pipeline_id = level.pipeline_id
      AND product.id = level.product_id
     WHERE level.organization_id = $1::uuid
       AND level.integration_account_id = $2::uuid
       AND level.warehouse_id = $3::uuid
       AND level.sync_run_id = $4::uuid
       AND level.mapping_state = 'mapped'
       AND level.projection_state = ANY($5::text[])
     GROUP BY level.product_id, product.reference_code
     ORDER BY product.reference_code`,
    [
      input.organizationId,
      account.id,
      warehouse.id,
      inventoryRun.id,
      hybridCartonizationInventoryProjectionStates(input.mode),
    ],
  )
  return result.rows.map((row): InventoryEvaluationPosition => ({
    productGlobalId: row.product_global_id,
    operationalAvailableQuantity: exactInteger(
      row.operational_available_quantity,
      `${row.product_global_id} operational available quantity`,
    ),
    providerCommittedQuantity: exactInteger(
      row.provider_committed_quantity,
      `${row.product_global_id} provider committed quantity`,
    ),
    sourceLevelGlobalIds: row.source_level_global_ids,
    sourceProjectionStates: row.source_projection_states,
  }))
}

export async function readHybridCartonizationInputFromPostgres(
  rawInput: HybridCartonizationReadRequest,
): Promise<HybridCartonizationReadResult> {
  const input = normalizeHybridCartonizationReadRequest(rawInput)
  const client = await getPostgresPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const readTimeResult = await client.query<ReadTimeRow>(
      'SELECT transaction_timestamp() AS read_at',
    )
    const readTime = readTimeResult.rows[0]
    if (!readTime) {
      fail(
        'The database did not return a cartonization read timestamp',
        500,
        'HYBRID_CARTONIZATION_EVIDENCE_CORRUPT',
      )
    }
    const account = await readAccount(client, input)
    const { row: candidate, rowVersion } = await readCandidate(
      client,
      input,
      account,
    )
    const warehouse = await readWarehouse(client, input)
    const inventoryRun = await readLatestInventoryRun(
      client,
      input,
      account,
      warehouse,
    )
    const [candidateRows, materialRows] = await Promise.all([
      readCandidateLines(client, input, account, candidate),
      readSelectedMaterials(client, input, warehouse),
    ])
    const lineEvidence = mapCandidateLines(input, candidateRows)
    const selectedMaterials = mapSelectedMaterials(input, materialRows)
    const [recipeRows, inventoryPositions] = await Promise.all([
      readRecipes(
        client,
        input,
        lineEvidence,
        selectedMaterials.map((entry) => entry.id),
      ),
      readInventoryProducts(
        client,
        input,
        account,
        warehouse,
        inventoryRun,
      ),
    ])
    const recipes = mapRecipes(recipeRows)
    const inventory = evaluateHybridCartonizationInventoryAvailability({
      mode: input.mode,
      provider: account.provider,
      lines: lineEvidence.map((entry) => ({
        lineGlobalId: entry.line.lineGlobalId,
        productGlobalId: entry.line.productGlobalId,
        requiredQuantity: entry.line.quantity,
      })),
      positions: inventoryPositions,
      assumedCommittedQuantities: input.assumedCommittedQuantities,
    })
    const result: HybridCartonizationReadResult = {
      readAt: requiredTimestamp(
        readTime.read_at,
        'Cartonization read timestamp',
      ),
      account: {
        globalId: account.global_id,
        provider: account.provider,
        status: account.status as 'active' | 'disabled',
      },
      candidate: {
        globalId: candidate.global_id,
        orderNumber: candidate.order_number_snapshot,
        rowVersion,
        sourceHash: candidate.source_hash,
        workflowState: candidate.workflow_state,
      },
      warehouse: {
        globalId: warehouse.global_id,
        name: warehouse.name,
      },
      inventory: {
        syncRunGlobalId: inventoryRun.global_id,
        providerFetchedAt: requiredTimestamp(
          inventoryRun.provider_fetched_at,
          'Inventory provider fetch timestamp',
        ),
        completedAt: requiredTimestamp(
          inventoryRun.completed_at,
          'Inventory sync completion timestamp',
        ),
        lines: inventory.lines,
        products: inventory.products,
      },
      materialEvidence: selectedMaterials.map((entry) => entry.evidence),
      recipeEvidence: recipes.map((recipe) => ({
        globalId: recipe.recipeGlobalId,
        rowVersion: recipe.currentRowVersion,
        productGlobalId: recipe.productGlobalId,
        inputPackProfileVersionGlobalId:
          recipe.inputPackProfileVersionGlobalId,
        packagingMaterialGlobalId: recipe.packagingMaterialGlobalId,
      })),
      lineEvidence: lineEvidence.map((entry) => entry.evidence),
      input: {
        mode: input.mode,
        lines: lineEvidence.map((entry) => entry.line),
        recipes,
        materials: selectedMaterials.map((entry) => entry.input),
      },
    }
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original read error.
    }
    throw error
  } finally {
    client.release()
  }
}
