import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  SANDBOX_COMMERCE_E2E_CONFIRMATION,
  SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION,
} from '@/lib/operations/sandboxCommerceE2e'
import { query, withTransaction } from '@/lib/persistence/postgres'

export {
  SANDBOX_COMMERCE_E2E_CONFIRMATION,
  SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION,
} from '@/lib/operations/sandboxCommerceE2e'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const AUTHORIZATION_GLOBAL_ID = /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/

export class SandboxCommerceE2eAuthorizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'SandboxCommerceE2eAuthorizationError'
  }
}

type AuthorizationRow = {
  id: string
  global_id: string
  organization_id: string
  order_id: string
  order_global_id: string
  external_order_id: string
  source_provider: string
  state: 'active' | 'consumed' | 'revoked' | 'expired'
  reason: string
  authorized_by: string
  authorized_at: Date | string
  expires_at: Date | string
  consumed_at: Date | string | null
  consumed_by: string | null
}

export type SandboxCommerceE2eAuthorization = {
  authorizationGlobalId: string
  orderGlobalId: string
  externalOrderId: string
  sourceProvider: string
  state: AuthorizationRow['state']
  reason: string
  authorizedBy: string
  authorizedAt: string
  expiresAt: string
  consumedAt: string | null
  consumedBy: string | null
}

function fail(code: string, message: string, status = 409): never {
  throw new SandboxCommerceE2eAuthorizationError(code, message, status)
}

function organizationId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID.test(normalized)) fail('SANDBOX_E2E_ORGANIZATION_INVALID', 'Organization is invalid', 400)
  return normalized
}

function email(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized.length > 320 || !normalized.includes('@')) {
    fail('SANDBOX_E2E_ACTOR_INVALID', 'A signed-in actor is required', 401)
  }
  return normalized
}

function reason(value: unknown) {
  const normalized = String(value || '').trim()
  if (normalized.length < 8 || normalized.length > 500 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail('SANDBOX_E2E_REASON_INVALID', 'An 8-500 character authorization reason is required', 400)
  }
  return normalized
}

function map(row: AuthorizationRow): SandboxCommerceE2eAuthorization {
  return {
    authorizationGlobalId: row.global_id,
    orderGlobalId: row.order_global_id,
    externalOrderId: row.external_order_id,
    sourceProvider: row.source_provider,
    state: row.state,
    reason: row.reason,
    authorizedBy: row.authorized_by,
    authorizedAt: new Date(row.authorized_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
    consumedBy: row.consumed_by,
  }
}

const SELECT = `SELECT auth.id::text, auth.global_id,
  auth.organization_id::text, auth.order_id::text,
  source_order.global_id AS order_global_id,
  auth.external_order_id, source_order.source_provider, auth.state,
  auth.reason, auth.authorized_by,
  auth.authorized_at, auth.expires_at,
  auth.consumed_at, auth.consumed_by
FROM operations_sandbox_commerce_e2e_authorizations auth
JOIN operations_orders source_order
  ON source_order.organization_id = auth.organization_id
 AND source_order.id = auth.order_id`

type FaireEvidenceRow = {
  integration_account_id: string
  pipeline_id: string
  run_id: string
  order_candidate_id: string
  order_candidate_global_id: string
  order_candidate_row_version: string
  order_candidate_source_revision: string
  order_candidate_source_hash: string
  order_candidate_ship_to_hash: string
  order_line_candidate_id: string
  order_line_candidate_global_id: string
  order_line_candidate_row_version: string
  order_line_candidate_source_revision: string
  order_line_candidate_source_hash: string
  canonical_order_line_id: string
  variant_pack_mapping_id: string
  variant_pack_mapping_global_id: string
  variant_pack_mapping_row_version: string
  variant_pack_evidence_hash: string
  pack_profile_version_id: string
  pack_profile_version_global_id: string
  pack_profile_version_row_version: string
  external_product_id: string
  external_variant_id: string
  fulfillment_plan_id: string
  fulfillment_plan_global_id: string
  fulfillment_plan_version: number
  warehouse_id: string
  warehouse_address_hash: string
  cartonization_evidence_id: string
  cartonization_evidence_global_id: string
  cartonization_request_hash: string
  cartonization_plan_input_hash: string
  cartonization_plan_result_hash: string
  cartonization_package_key: string
  cartonization_package_hash: string
  packaging_material_id: string
  packaging_material_global_id: string
  packaging_material_row_version: string
  approved_pack_recipe_id: string
  approved_pack_recipe_global_id: string
  approved_pack_recipe_row_version: string
  package_id: string
  package_global_id: string
  package_content_id: string
  package_content_global_id: string
  package_number: number
  item_quantity: string
  item_pack_length_mm: number
  item_pack_width_mm: number
  item_pack_height_mm: number
  item_pack_gross_weight_grams: number
  item_pack_evidence_hash: string
  parcel_inner_dimensions_mm: Record<string, unknown>
  parcel_length_mm: number
  parcel_width_mm: number
  parcel_height_mm: number
  parcel_content_weight_grams: number
  parcel_tare_weight_grams: number
  parcel_gross_weight_grams: number
  ship_to_hash: string
  destination_region: string
  destination_country_code: string
  package_evidence_hash: string
}

async function readExactFaireEvidence(
  client: PoolClient,
  input: {
    organizationId: string
    orderId: string
  },
) {
  const result = await client.query<FaireEvidenceRow>(
    `SELECT
       candidate.integration_account_id::text,
       candidate.pipeline_id::text,
       candidate.run_id::text,
       candidate.id::text AS order_candidate_id,
       candidate.global_id AS order_candidate_global_id,
       candidate.row_version::text AS order_candidate_row_version,
       candidate.source_revision AS order_candidate_source_revision,
       candidate.source_hash AS order_candidate_source_hash,
       candidate.ship_to_snapshot_hash AS order_candidate_ship_to_hash,
       candidate_line.id::text AS order_line_candidate_id,
       candidate_line.global_id AS order_line_candidate_global_id,
       candidate_line.row_version::text AS order_line_candidate_row_version,
       candidate_line.source_revision AS order_line_candidate_source_revision,
       candidate_line.source_hash AS order_line_candidate_source_hash,
       canonical_line.id::text AS canonical_order_line_id,
       pack_mapping.id::text AS variant_pack_mapping_id,
       pack_mapping.global_id AS variant_pack_mapping_global_id,
       pack_mapping.row_version::text AS variant_pack_mapping_row_version,
       pack_mapping.pack_evidence_hash AS variant_pack_evidence_hash,
       pack_version.id::text AS pack_profile_version_id,
       pack_version.global_id AS pack_profile_version_global_id,
       pack_version.row_version::text AS pack_profile_version_row_version,
       pack_mapping.external_product_id,
       pack_mapping.external_variant_id,
       plan.id::text AS fulfillment_plan_id,
       plan.global_id AS fulfillment_plan_global_id,
       plan.version_number AS fulfillment_plan_version,
       plan.warehouse_id::text,
       operations_sandbox_commerce_e2e_jsonb_hash(warehouse.address)
         AS warehouse_address_hash,
       cartonization.id::text AS cartonization_evidence_id,
       cartonization.global_id AS cartonization_evidence_global_id,
       cartonization.request_hash AS cartonization_request_hash,
       cartonization.plan_input_hash AS cartonization_plan_input_hash,
       cartonization.plan_result_hash AS cartonization_plan_result_hash,
       carton_package.package_key AS cartonization_package_key,
       carton_package.package_hash AS cartonization_package_hash,
       material.id::text AS packaging_material_id,
       material.global_id AS packaging_material_global_id,
       material.row_version::text AS packaging_material_row_version,
       recipe.id::text AS approved_pack_recipe_id,
       recipe.global_id AS approved_pack_recipe_global_id,
       recipe.row_version::text AS approved_pack_recipe_row_version,
       package.id::text AS package_id,
       package.global_id AS package_global_id,
       content.id::text AS package_content_id,
       content.global_id AS package_content_global_id,
       package.package_number,
       content.quantity::text AS item_quantity,
       pack_version.length_mm AS item_pack_length_mm,
       pack_version.width_mm AS item_pack_width_mm,
       pack_version.height_mm AS item_pack_height_mm,
       pack_version.gross_weight_grams AS item_pack_gross_weight_grams,
       operations_sandbox_commerce_e2e_jsonb_hash(
         jsonb_build_object(
           'candidateLineGlobalId', candidate_line.global_id,
           'canonicalOrderLineGlobalId', canonical_line.global_id,
           'packProfileVersionGlobalId', pack_version.global_id,
           'quantity', content.quantity,
           'lengthMm', pack_version.length_mm,
           'widthMm', pack_version.width_mm,
           'heightMm', pack_version.height_mm,
           'grossWeightGrams', pack_version.gross_weight_grams
         )
       ) AS item_pack_evidence_hash,
       carton_package.inner_dimensions_mm AS parcel_inner_dimensions_mm,
       (carton_package.rated_outer_dimensions_mm->>'length')::integer
         AS parcel_length_mm,
       (carton_package.rated_outer_dimensions_mm->>'width')::integer
         AS parcel_width_mm,
       (carton_package.rated_outer_dimensions_mm->>'height')::integer
         AS parcel_height_mm,
       carton_package.content_weight_grams AS parcel_content_weight_grams,
       carton_package.tare_weight_grams AS parcel_tare_weight_grams,
       carton_package.rated_gross_weight_grams
         AS parcel_gross_weight_grams,
       operations_sandbox_commerce_e2e_jsonb_hash(source_order.ship_to)
         AS ship_to_hash,
       upper(coalesce(
         source_order.ship_to->>'region', source_order.ship_to->>'state'
       )) AS destination_region,
       upper(coalesce(
         source_order.ship_to->>'countryCode', source_order.ship_to->>'country'
       )) AS destination_country_code,
       operations_sandbox_commerce_e2e_jsonb_hash(
         jsonb_build_object(
           'packageGlobalId', package.global_id,
           'contentGlobalId', content.global_id,
           'orderLineGlobalId', canonical_line.global_id,
           'quantity', content.quantity,
           'cartonizationEvidenceGlobalId', cartonization.global_id,
           'cartonizationPackageKey', carton_package.package_key,
           'packagingMaterialGlobalId', material.global_id,
           'packagingMaterialRowVersion', carton_package.material_row_version,
           'approvedPackRecipeGlobalId', recipe.global_id,
           'approvedPackRecipeRowVersion', carton_package.recipe_row_version,
           'innerDimensionsMm', carton_package.inner_dimensions_mm,
           'ratedOuterDimensionsMm',
             carton_package.rated_outer_dimensions_mm,
           'contentWeightGrams', carton_package.content_weight_grams,
           'tareWeightGrams', carton_package.tare_weight_grams,
           'grossWeightGrams', carton_package.rated_gross_weight_grams
         )
       ) AS package_evidence_hash
     FROM operations_orders source_order
     JOIN operations_integration_accounts account
       ON account.organization_id = source_order.organization_id
      AND account.id = source_order.integration_account_id
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = source_order.organization_id
      AND candidate.integration_account_id = account.id
      AND candidate.canonical_order_id = source_order.id
     JOIN operations_commerce_order_candidate_lines candidate_line
       ON candidate_line.organization_id = candidate.organization_id
      AND candidate_line.integration_account_id = candidate.integration_account_id
      AND candidate_line.pipeline_id = candidate.pipeline_id
      AND candidate_line.run_id = candidate.run_id
      AND candidate_line.order_candidate_id = candidate.id
     JOIN operations_order_lines canonical_line
       ON canonical_line.organization_id = source_order.organization_id
      AND canonical_line.order_id = source_order.id
      AND canonical_line.id = candidate_line.canonical_order_line_id
     JOIN operations_commerce_variant_pack_mappings pack_mapping
       ON pack_mapping.organization_id = candidate_line.organization_id
      AND pack_mapping.id = candidate_line.commerce_variant_pack_mapping_id
     JOIN operations_product_pack_profile_versions pack_version
       ON pack_version.organization_id = pack_mapping.organization_id
      AND pack_version.id = pack_mapping.default_pack_profile_version_id
      AND pack_version.id = candidate_line.pack_profile_version_id
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = source_order.organization_id
      AND plan.order_id = source_order.id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = plan.organization_id
      AND warehouse.id = plan.warehouse_id
     JOIN operations_cartonization_rate_evidence cartonization
       ON cartonization.organization_id = plan.organization_id
      AND cartonization.id = plan.cartonization_evidence_id
      AND cartonization.order_candidate_id = candidate.id
      AND cartonization.integration_account_id = account.id
      AND cartonization.warehouse_id = warehouse.id
     JOIN operations_packages package
       ON package.organization_id = plan.organization_id
      AND package.plan_id = plan.id
      AND package.cartonization_evidence_id = cartonization.id
     JOIN operations_cartonization_rate_evidence_packages carton_package
       ON carton_package.organization_id = package.organization_id
      AND carton_package.evidence_id = cartonization.id
      AND carton_package.package_key = package.evidence_package_key
     JOIN operations_packaging_materials material
       ON material.organization_id = carton_package.organization_id
      AND material.id = carton_package.packaging_material_id
     JOIN operations_approved_pack_recipes recipe
       ON recipe.organization_id = carton_package.organization_id
      AND recipe.id = carton_package.approved_pack_recipe_id
      AND recipe.packaging_material_id = material.id
     JOIN operations_package_contents content
       ON content.organization_id = plan.organization_id
      AND content.plan_id = plan.id
      AND content.order_id = source_order.id
      AND content.package_id = package.id
      AND content.order_line_id = canonical_line.id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.id = $2::uuid
       AND source_order.source_provider = 'faire'
       AND source_order.status = 'packed'
       AND account.integration_type = 'commerce'
       AND account.provider = 'faire'
       AND candidate.provider = 'faire'
       AND candidate.workflow_state = 'promoted'
       AND candidate.ship_to_snapshot_state = 'confirmed'
       AND candidate.ship_to_snapshot_hash IS NOT NULL
       AND candidate_line.provider = 'faire'
       AND candidate_line.workflow_state = 'promoted'
       AND candidate_line.packaging_source = 'variant_pack_mapping'
       AND candidate_line.unfulfilled_quantity = 1
       AND candidate_line.commerce_variant_pack_mapping_row_version =
             pack_mapping.row_version
       AND candidate_line.pack_profile_version_row_version =
             pack_version.row_version
       AND candidate_line.length_mm = pack_version.length_mm
       AND candidate_line.width_mm = pack_version.width_mm
       AND candidate_line.height_mm = pack_version.height_mm
       AND candidate_line.weight_grams = pack_version.gross_weight_grams
       AND canonical_line.quantity = 1
       AND canonical_line.weight_grams = pack_version.gross_weight_grams
       AND (canonical_line.dimensions_mm->>'length')::integer =
             pack_version.length_mm
       AND (canonical_line.dimensions_mm->>'width')::integer =
             pack_version.width_mm
       AND (canonical_line.dimensions_mm->>'height')::integer =
             pack_version.height_mm
       AND pack_mapping.provider = 'faire'
       AND pack_mapping.is_current = true
       AND pack_mapping.projection_state = 'current'
       AND pack_mapping.pack_evidence_hash IS NOT NULL
       AND pack_version.is_current = true
       AND pack_version.lifecycle_state IN ('customer_confirmed', 'active')
       AND pack_version.base_each_quantity = 1
       AND pack_version.dimension_basis = 'outer'
       AND pack_version.length_mm IS NOT NULL
       AND pack_version.width_mm IS NOT NULL
       AND pack_version.height_mm IS NOT NULL
       AND pack_version.gross_weight_grams IS NOT NULL
       AND plan.status = 'released'
       AND cartonization.evidence_mode = 'operational'
       AND cartonization.status IN ('succeeded', 'partial')
       AND cartonization.sealed_at IS NOT NULL
       AND cartonization.candidate_row_version = candidate.row_version
       AND cartonization.candidate_source_hash = candidate.source_hash
       AND carton_package.planning_method = 'approved_recipe'
       AND jsonb_array_length(carton_package.allocations) = 1
       AND carton_package.allocations->0->>'lineGlobalId' =
             candidate_line.global_id
       AND (carton_package.allocations->0->>'quantity')::numeric = 1
       AND material.global_id IS NOT NULL
       AND material.row_version = carton_package.material_row_version
       AND material.status = 'active'
       AND material.rated_outer_length_mm =
             (carton_package.rated_outer_dimensions_mm->>'length')::integer
       AND material.rated_outer_width_mm =
             (carton_package.rated_outer_dimensions_mm->>'width')::integer
       AND material.rated_outer_height_mm =
             (carton_package.rated_outer_dimensions_mm->>'height')::integer
       AND material.tare_weight_grams = carton_package.tare_weight_grams
       AND recipe.global_id IS NOT NULL
       AND recipe.row_version = carton_package.recipe_row_version
       AND recipe.is_current = true
       AND recipe.lifecycle_state IN ('customer_confirmed', 'active')
       AND recipe.input_pack_profile_version_id = pack_version.id
       AND recipe.packaging_material_id = material.id
       AND NOT EXISTS (
         SELECT 1
         FROM operations_fulfillment_plans newer_plan
         WHERE newer_plan.organization_id = plan.organization_id
           AND newer_plan.order_id = plan.order_id
           AND (
             newer_plan.version_number > plan.version_number
             OR (
               newer_plan.version_number = plan.version_number
               AND newer_plan.id > plan.id
             )
           )
       )
       AND warehouse.address IS NOT NULL
       AND package.status = 'packed'
       AND package.length_mm =
             (carton_package.rated_outer_dimensions_mm->>'length')::integer
       AND package.width_mm =
             (carton_package.rated_outer_dimensions_mm->>'width')::integer
       AND package.height_mm =
             (carton_package.rated_outer_dimensions_mm->>'height')::integer
       AND carton_package.content_weight_grams =
             pack_version.gross_weight_grams
       AND carton_package.tare_weight_grams > 0
       AND carton_package.rated_gross_weight_grams =
             carton_package.content_weight_grams
             + carton_package.tare_weight_grams
       AND package.weight_grams = carton_package.rated_gross_weight_grams
       AND content.quantity = 1
       AND upper(coalesce(
             source_order.ship_to->>'region', source_order.ship_to->>'state'
           )) = 'CA'
       AND upper(coalesce(
             source_order.ship_to->>'countryCode',
             source_order.ship_to->>'country'
           )) = 'US'
       AND length(btrim(coalesce(source_order.ship_to->>'name', ''))) > 0
       AND length(btrim(coalesce(
             source_order.ship_to->>'line1',
             source_order.ship_to->>'street', ''
           ))) > 0
       AND length(btrim(coalesce(source_order.ship_to->>'city', ''))) > 0
       AND length(btrim(coalesce(
             source_order.ship_to->>'postalCode',
             source_order.ship_to->>'postal_code', ''
           ))) > 0
       AND NOT EXISTS (
         SELECT 1
         FROM operations_commerce_order_candidates other_candidate
         WHERE other_candidate.organization_id = source_order.organization_id
           AND other_candidate.canonical_order_id = source_order.id
           AND other_candidate.id <> candidate.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM operations_commerce_order_candidate_lines other_line
         WHERE other_line.organization_id = candidate.organization_id
           AND other_line.order_candidate_id = candidate.id
           AND other_line.unfulfilled_quantity > 0
           AND other_line.id <> candidate_line.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM operations_order_lines other_order_line
         WHERE other_order_line.organization_id = source_order.organization_id
           AND other_order_line.order_id = source_order.id
           AND other_order_line.id <> canonical_line.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM operations_packages other_package
         WHERE other_package.organization_id = plan.organization_id
           AND other_package.plan_id = plan.id
           AND other_package.id <> package.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM operations_package_contents other_content
         WHERE other_content.organization_id = package.organization_id
           AND other_content.package_id = package.id
           AND other_content.id <> content.id
       )
     FOR SHARE OF
       account, candidate, candidate_line, canonical_line, pack_mapping,
       pack_version, plan, warehouse, cartonization, carton_package,
       material, recipe, package, content`,
    [input.organizationId, input.orderId],
  )
  if (result.rows.length !== 1) {
    fail(
      'SANDBOX_E2E_FAIRE_EVIDENCE_REQUIRED',
      'Faire authorization requires one promoted line with an exact current versioned item pack, one sealed operational shipping parcel, and the confirmed US/CA destination',
    )
  }
  return result.rows[0]
}

function faireEvidenceHash(row: FaireEvidenceRow) {
  return createHash('sha256').update(JSON.stringify({
    candidate: {
      globalId: row.order_candidate_global_id,
      rowVersion: row.order_candidate_row_version,
      sourceRevision: row.order_candidate_source_revision,
      sourceHash: row.order_candidate_source_hash,
      shipToHash: row.order_candidate_ship_to_hash,
    },
    line: {
      globalId: row.order_line_candidate_global_id,
      rowVersion: row.order_line_candidate_row_version,
      sourceRevision: row.order_line_candidate_source_revision,
      sourceHash: row.order_line_candidate_source_hash,
    },
    variantPack: {
      globalId: row.variant_pack_mapping_global_id,
      rowVersion: row.variant_pack_mapping_row_version,
      evidenceHash: row.variant_pack_evidence_hash,
      profileVersionGlobalId: row.pack_profile_version_global_id,
      profileVersionRowVersion: row.pack_profile_version_row_version,
      externalProductId: row.external_product_id,
      externalVariantId: row.external_variant_id,
    },
    itemPack: {
      evidenceHash: row.item_pack_evidence_hash,
      quantity: row.item_quantity,
      lengthMm: row.item_pack_length_mm,
      widthMm: row.item_pack_width_mm,
      heightMm: row.item_pack_height_mm,
      grossWeightGrams: row.item_pack_gross_weight_grams,
    },
    fulfillment: {
      planGlobalId: row.fulfillment_plan_global_id,
      planVersion: row.fulfillment_plan_version,
      warehouseAddressHash: row.warehouse_address_hash,
      cartonizationEvidenceGlobalId:
        row.cartonization_evidence_global_id,
      cartonizationRequestHash: row.cartonization_request_hash,
      cartonizationPlanInputHash: row.cartonization_plan_input_hash,
      cartonizationPlanResultHash: row.cartonization_plan_result_hash,
      cartonizationPackageKey: row.cartonization_package_key,
      cartonizationPackageHash: row.cartonization_package_hash,
      packagingMaterialGlobalId: row.packaging_material_global_id,
      packagingMaterialRowVersion: row.packaging_material_row_version,
      approvedPackRecipeGlobalId: row.approved_pack_recipe_global_id,
      approvedPackRecipeRowVersion:
        row.approved_pack_recipe_row_version,
      packageGlobalId: row.package_global_id,
      packageContentGlobalId: row.package_content_global_id,
      packageEvidenceHash: row.package_evidence_hash,
    },
    parcel: {
      innerDimensionsMm: row.parcel_inner_dimensions_mm,
      lengthMm: row.parcel_length_mm,
      widthMm: row.parcel_width_mm,
      heightMm: row.parcel_height_mm,
      contentWeightGrams: row.parcel_content_weight_grams,
      tareWeightGrams: row.parcel_tare_weight_grams,
      grossWeightGrams: row.parcel_gross_weight_grams,
    },
    destination: {
      shipToHash: row.ship_to_hash,
      region: row.destination_region,
      countryCode: row.destination_country_code,
    },
  })).digest('hex')
}

async function currentFaireEvidence(
  client: PoolClient,
  row: AuthorizationRow,
  packageGlobalId?: string | null,
) {
  const result = await client.query<{
    current: boolean
    package_global_id: string | null
  }>(
    `SELECT
       operations_sandbox_commerce_e2e_authorization_is_current(
         $1::uuid, $2::uuid, $3::uuid
       ) AS current,
       (
         SELECT evidence.package_global_id
         FROM operations_sandbox_commerce_e2e_faire_evidence evidence
         WHERE evidence.organization_id = $1::uuid
           AND evidence.authorization_id = $2::uuid
       ) AS package_global_id`,
    [row.organization_id, row.id, row.order_id],
  )
  const evidence = result.rows[0]
  return Boolean(
    evidence?.current
    && (!packageGlobalId || evidence.package_global_id === packageGlobalId),
  )
}

export async function authorizeSandboxCommerceE2eInPostgres(input: {
  organizationId: unknown
  actorEmail: unknown
  orderGlobalId: unknown
  confirmationStatement: unknown
  reason: unknown
  lifetimeMinutes?: unknown
}): Promise<SandboxCommerceE2eAuthorization> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const actorEmail = email(input.actorEmail)
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  if (!ORDER_GLOBAL_ID.test(orderGlobalId)) {
    fail('SANDBOX_E2E_ORDER_INVALID', 'Operations order is invalid', 400)
  }
  if (input.confirmationStatement !== SANDBOX_COMMERCE_E2E_CONFIRMATION) {
    fail('SANDBOX_E2E_CONFIRMATION_REQUIRED', 'The exact sandbox E2E confirmation is required', 400)
  }
  const authorizationReason = reason(input.reason)
  const lifetimeMinutes = input.lifetimeMinutes === undefined
    ? 120
    : Number(input.lifetimeMinutes)
  if (!Number.isSafeInteger(lifetimeMinutes) || lifetimeMinutes < 5 || lifetimeMinutes > 1_440) {
    fail('SANDBOX_E2E_LIFETIME_INVALID', 'Authorization lifetime must be 5-1440 minutes', 400)
  }
  return withTransaction(async (client) => {
    const orderResult = await client.query<{
      id: string
      external_order_id: string
      source_provider: string
      status: string
    }>(
      `SELECT id::text, external_order_id, source_provider, status
       FROM operations_orders
       WHERE organization_id = $1::uuid AND global_id = $2
       FOR UPDATE`,
      [scopedOrganizationId, orderGlobalId],
    )
    const order = orderResult.rows[0]
    if (!order) fail('SANDBOX_E2E_ORDER_NOT_FOUND', 'Operations order was not found', 404)
    if (
      !['shopify', 'faire'].includes(order.source_provider)
      || order.status !== 'packed'
    ) {
      fail(
        'SANDBOX_E2E_ORDER_INELIGIBLE',
        'Authorization requires one packed Shopify or Faire order',
      )
    }
    const faireEvidence = order.source_provider === 'faire'
      ? await readExactFaireEvidence(client, {
          organizationId: scopedOrganizationId,
          orderId: order.id,
        })
      : null
    const exactFaireEvidenceHash = faireEvidence
      ? faireEvidenceHash(faireEvidence)
      : null
    await client.query(
      `UPDATE operations_sandbox_commerce_e2e_authorizations
       SET state = 'expired'
       WHERE organization_id = $1::uuid AND order_id = $2::uuid
         AND state = 'active' AND expires_at <= now()`,
      [scopedOrganizationId, order.id],
    )
    const existingResult = await client.query<AuthorizationRow>(
      `${SELECT}
       WHERE auth.organization_id = $1::uuid
         AND auth.order_id = $2::uuid
         AND auth.state = 'active'
         AND auth.expires_at > now()
       FOR UPDATE OF auth`,
      [scopedOrganizationId, order.id],
    )
    const existing = existingResult.rows[0]
    if (existing) {
      if (
        existing.authorized_by === actorEmail
        && existing.reason === authorizationReason
      ) {
        if (
          existing.source_provider === 'faire'
          && !(await currentFaireEvidence(client, existing))
        ) {
          fail(
            'SANDBOX_E2E_FAIRE_EVIDENCE_STALE',
            'The existing Faire authorization no longer matches the exact order, item-pack, sealed parcel, or destination evidence',
          )
        }
        return map(existing)
      }
      fail(
        'SANDBOX_E2E_AUTHORIZATION_ALREADY_ACTIVE',
        'A different active sandbox E2E authorization already exists for this order',
      )
    }
    const confirmationHash = createHash('sha256').update(JSON.stringify({
      version: SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION,
      statement: SANDBOX_COMMERCE_E2E_CONFIRMATION,
      organizationId: scopedOrganizationId,
      orderGlobalId,
      externalOrderId: order.external_order_id,
      actorEmail,
      reason: authorizationReason,
      ...(faireEvidence
        ? {
            sourceProvider: 'faire',
            exactFaireEvidenceHash,
            orderCandidateGlobalId:
              faireEvidence.order_candidate_global_id,
            candidateLineGlobalId:
              faireEvidence.order_line_candidate_global_id,
            packProfileVersionGlobalId:
              faireEvidence.pack_profile_version_global_id,
            itemPackEvidenceHash:
              faireEvidence.item_pack_evidence_hash,
            cartonizationEvidenceGlobalId:
              faireEvidence.cartonization_evidence_global_id,
            cartonizationPackageKey:
              faireEvidence.cartonization_package_key,
            packageGlobalId: faireEvidence.package_global_id,
            packageEvidenceHash: faireEvidence.package_evidence_hash,
            shipToHash: faireEvidence.ship_to_hash,
          }
        : {}),
    })).digest('hex')
    const inserted = await client.query<AuthorizationRow>(
      `WITH created AS (
         INSERT INTO operations_sandbox_commerce_e2e_authorizations (
           organization_id, order_id, external_order_id,
           confirmation_statement_version, confirmation_hash, reason,
           authorized_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3,
           '${SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION}', $5, $6,
           $7, now() + ($8::integer * interval '1 minute')
         )
         RETURNING *
       )
       SELECT created.id::text, created.global_id,
              created.organization_id::text, created.order_id::text,
              $4 AS order_global_id, created.external_order_id, created.state,
              $9 AS source_provider,
              created.reason, created.authorized_by, created.authorized_at,
              created.expires_at, created.consumed_at, created.consumed_by
       FROM created`,
      [
        scopedOrganizationId, order.id, order.external_order_id, orderGlobalId,
        confirmationHash, authorizationReason, actorEmail, lifetimeMinutes,
        order.source_provider,
      ],
    )
    const authorization = inserted.rows[0]
    if (faireEvidence && exactFaireEvidenceHash) {
      await client.query(
        `INSERT INTO operations_sandbox_commerce_e2e_faire_evidence (
           authorization_id, organization_id, confirmation_hash,
           integration_account_id, pipeline_id, run_id, order_id,
           order_candidate_id, order_candidate_global_id,
           order_candidate_row_version, order_candidate_source_revision,
           order_candidate_source_hash, order_candidate_ship_to_hash,
           order_line_candidate_id, order_line_candidate_global_id,
           order_line_candidate_row_version,
           order_line_candidate_source_revision,
           order_line_candidate_source_hash, canonical_order_line_id,
           variant_pack_mapping_id, variant_pack_mapping_global_id,
           variant_pack_mapping_row_version, variant_pack_evidence_hash,
           pack_profile_version_id, pack_profile_version_global_id,
           pack_profile_version_row_version, external_product_id,
           external_variant_id, fulfillment_plan_id,
           fulfillment_plan_global_id, fulfillment_plan_version,
           warehouse_id, warehouse_address_hash,
           cartonization_evidence_id, cartonization_evidence_global_id,
           cartonization_request_hash, cartonization_plan_input_hash,
           cartonization_plan_result_hash, cartonization_package_key,
           cartonization_package_hash, packaging_material_id,
           packaging_material_global_id, packaging_material_row_version,
           approved_pack_recipe_id, approved_pack_recipe_global_id,
           approved_pack_recipe_row_version, package_id, package_global_id,
           package_content_id, package_content_global_id, package_number,
           item_quantity, item_pack_length_mm, item_pack_width_mm,
           item_pack_height_mm, item_pack_gross_weight_grams,
           item_pack_evidence_hash, parcel_inner_dimensions_mm,
           parcel_length_mm, parcel_width_mm, parcel_height_mm,
           parcel_content_weight_grams, parcel_tare_weight_grams,
           parcel_gross_weight_grams, ship_to_hash, destination_region,
           destination_country_code, package_evidence_hash, evidence_hash,
           created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
           $8::uuid, $9, $10::bigint, $11, $12, $13,
           $14::uuid, $15, $16::bigint, $17, $18, $19::uuid,
           $20::uuid, $21, $22::bigint, $23, $24::uuid, $25, $26::bigint,
           $27, $28, $29::uuid, $30, $31::integer, $32::uuid, $33,
           $34::uuid, $35, $36, $37, $38, $39, $40,
           $41::uuid, $42, $43::bigint, $44::uuid, $45, $46::bigint,
           $47::uuid, $48, $49::uuid, $50, $51::integer, $52::numeric,
           $53::integer, $54::integer, $55::integer, $56::integer, $57,
           $58::jsonb, $59::integer, $60::integer, $61::integer,
           $62::integer, $63::integer, $64::integer, $65, $66, $67,
           $68, $69, $70
         )`,
        [
          authorization.id,
          scopedOrganizationId,
          confirmationHash,
          faireEvidence.integration_account_id,
          faireEvidence.pipeline_id,
          faireEvidence.run_id,
          order.id,
          faireEvidence.order_candidate_id,
          faireEvidence.order_candidate_global_id,
          faireEvidence.order_candidate_row_version,
          faireEvidence.order_candidate_source_revision,
          faireEvidence.order_candidate_source_hash,
          faireEvidence.order_candidate_ship_to_hash,
          faireEvidence.order_line_candidate_id,
          faireEvidence.order_line_candidate_global_id,
          faireEvidence.order_line_candidate_row_version,
          faireEvidence.order_line_candidate_source_revision,
          faireEvidence.order_line_candidate_source_hash,
          faireEvidence.canonical_order_line_id,
          faireEvidence.variant_pack_mapping_id,
          faireEvidence.variant_pack_mapping_global_id,
          faireEvidence.variant_pack_mapping_row_version,
          faireEvidence.variant_pack_evidence_hash,
          faireEvidence.pack_profile_version_id,
          faireEvidence.pack_profile_version_global_id,
          faireEvidence.pack_profile_version_row_version,
          faireEvidence.external_product_id,
          faireEvidence.external_variant_id,
          faireEvidence.fulfillment_plan_id,
          faireEvidence.fulfillment_plan_global_id,
          faireEvidence.fulfillment_plan_version,
          faireEvidence.warehouse_id,
          faireEvidence.warehouse_address_hash,
          faireEvidence.cartonization_evidence_id,
          faireEvidence.cartonization_evidence_global_id,
          faireEvidence.cartonization_request_hash,
          faireEvidence.cartonization_plan_input_hash,
          faireEvidence.cartonization_plan_result_hash,
          faireEvidence.cartonization_package_key,
          faireEvidence.cartonization_package_hash,
          faireEvidence.packaging_material_id,
          faireEvidence.packaging_material_global_id,
          faireEvidence.packaging_material_row_version,
          faireEvidence.approved_pack_recipe_id,
          faireEvidence.approved_pack_recipe_global_id,
          faireEvidence.approved_pack_recipe_row_version,
          faireEvidence.package_id,
          faireEvidence.package_global_id,
          faireEvidence.package_content_id,
          faireEvidence.package_content_global_id,
          faireEvidence.package_number,
          faireEvidence.item_quantity,
          faireEvidence.item_pack_length_mm,
          faireEvidence.item_pack_width_mm,
          faireEvidence.item_pack_height_mm,
          faireEvidence.item_pack_gross_weight_grams,
          faireEvidence.item_pack_evidence_hash,
          JSON.stringify(faireEvidence.parcel_inner_dimensions_mm),
          faireEvidence.parcel_length_mm,
          faireEvidence.parcel_width_mm,
          faireEvidence.parcel_height_mm,
          faireEvidence.parcel_content_weight_grams,
          faireEvidence.parcel_tare_weight_grams,
          faireEvidence.parcel_gross_weight_grams,
          faireEvidence.ship_to_hash,
          faireEvidence.destination_region,
          faireEvidence.destination_country_code,
          faireEvidence.package_evidence_hash,
          exactFaireEvidenceHash,
          actorEmail,
        ],
      )
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.sandbox_commerce_e2e.authorized',
      aggregateType: 'operations.order',
      aggregateId: orderGlobalId,
      subject: authorization.global_id,
      organizationId: scopedOrganizationId,
      eventKey: `operations:sandbox-commerce-e2e-authorized:${authorization.global_id}`,
      payload: {
        authorizationGlobalId: authorization.global_id,
        externalOrderId: order.external_order_id,
        expiresAt: new Date(authorization.expires_at).toISOString(),
        confirmationStatementVersion: SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION,
        reason: authorizationReason,
        sourceProvider: order.source_provider,
        ...(faireEvidence
          ? {
              orderCandidateGlobalId:
                faireEvidence.order_candidate_global_id,
              candidateLineGlobalId:
                faireEvidence.order_line_candidate_global_id,
              variantPackMappingGlobalId:
                faireEvidence.variant_pack_mapping_global_id,
              packProfileVersionGlobalId:
                faireEvidence.pack_profile_version_global_id,
              itemPack: {
                quantity: faireEvidence.item_quantity,
                lengthMm: faireEvidence.item_pack_length_mm,
                widthMm: faireEvidence.item_pack_width_mm,
                heightMm: faireEvidence.item_pack_height_mm,
                grossWeightGrams:
                  faireEvidence.item_pack_gross_weight_grams,
                evidenceHash: faireEvidence.item_pack_evidence_hash,
              },
              cartonizationEvidenceGlobalId:
                faireEvidence.cartonization_evidence_global_id,
              cartonizationPackageKey:
                faireEvidence.cartonization_package_key,
              packagingMaterialGlobalId:
                faireEvidence.packaging_material_global_id,
              approvedPackRecipeGlobalId:
                faireEvidence.approved_pack_recipe_global_id,
              packageGlobalId: faireEvidence.package_global_id,
              parcel: {
                innerDimensionsMm:
                  faireEvidence.parcel_inner_dimensions_mm,
                lengthMm: faireEvidence.parcel_length_mm,
                widthMm: faireEvidence.parcel_width_mm,
                heightMm: faireEvidence.parcel_height_mm,
                contentWeightGrams:
                  faireEvidence.parcel_content_weight_grams,
                tareWeightGrams:
                  faireEvidence.parcel_tare_weight_grams,
                grossWeightGrams:
                  faireEvidence.parcel_gross_weight_grams,
              },
              shipToHash: faireEvidence.ship_to_hash,
              evidenceHash: exactFaireEvidenceHash,
            }
          : {}),
      },
    }, client)
    return map(authorization)
  })
}

export async function requireActiveSandboxCommerceE2eAuthorization(
  client: PoolClient,
  input: {
    organizationId: unknown
    authorizationGlobalId: unknown
    orderGlobalId: unknown
    actorEmail: unknown
    packageGlobalId?: unknown
  },
  options: { allowCommittedFaireShipment?: boolean } = {},
) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const authorizationGlobalId = String(input.authorizationGlobalId || '').trim()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const actorEmail = email(input.actorEmail)
  if (!AUTHORIZATION_GLOBAL_ID.test(authorizationGlobalId)) {
    fail('SANDBOX_E2E_AUTHORIZATION_INVALID', 'Sandbox E2E authorization is invalid', 400)
  }
  const result = await client.query<AuthorizationRow>(
    `${SELECT}
     WHERE auth.organization_id = $1::uuid
       AND auth.global_id = $2
       AND source_order.global_id = $3
     FOR UPDATE OF auth`,
    [scopedOrganizationId, authorizationGlobalId, orderGlobalId],
  )
  const row = result.rows[0]
  if (!row || row.authorized_by !== actorEmail) {
    fail('SANDBOX_E2E_AUTHORIZATION_REQUIRED', 'Exact actor-bound sandbox E2E authorization is required', 403)
  }
  if (row.state !== 'active' || Date.parse(new Date(row.expires_at).toISOString()) <= Date.now()) {
    fail('SANDBOX_E2E_AUTHORIZATION_EXPIRED', 'Sandbox E2E authorization is no longer active', 403)
  }
  if (
    row.source_provider === 'faire'
    && !options.allowCommittedFaireShipment
    && !(await currentFaireEvidence(
      client,
      row,
      String(input.packageGlobalId || '').trim() || null,
    ))
  ) {
    fail(
      'SANDBOX_E2E_FAIRE_EVIDENCE_STALE',
      'Faire sandbox E2E authority no longer matches the exact candidate, item-pack, sealed parcel, origin, or destination',
      403,
    )
  }
  return row
}

export async function consumeSandboxCommerceE2eAuthorization(
  client: PoolClient,
  input: {
    organizationId: unknown
    authorizationGlobalId: unknown
    orderGlobalId: unknown
    actorEmail: unknown
  },
) {
  // Shipment confirmation already revalidated the full Faire evidence before
  // mutating the order, plan, and package to their shipped states. Consumption
  // still re-locks and verifies the exact actor/order/authorization identity;
  // it skips only the now-intentionally-obsolete packed-state predicate.
  const row = await requireActiveSandboxCommerceE2eAuthorization(
    client,
    input,
    { allowCommittedFaireShipment: true },
  )
  const result = await client.query<AuthorizationRow>(
    `WITH updated AS (
         UPDATE operations_sandbox_commerce_e2e_authorizations
         SET state = 'consumed', consumed_at = now(), consumed_by = $3
         WHERE organization_id = $1::uuid AND id = $2::uuid AND state = 'active'
         RETURNING *
       )
       SELECT updated.id::text, updated.global_id,
              updated.organization_id::text, updated.order_id::text,
              source_order.global_id AS order_global_id,
              updated.external_order_id, source_order.source_provider,
              updated.state, updated.reason,
              updated.authorized_by, updated.authorized_at, updated.expires_at,
              updated.consumed_at, updated.consumed_by
       FROM updated
       JOIN operations_orders source_order
         ON source_order.organization_id = updated.organization_id
        AND source_order.id = updated.order_id`,
    [row.organization_id, row.id, row.authorized_by],
  )
  if (!result.rows[0]) fail('SANDBOX_E2E_AUTHORIZATION_CHANGED', 'Sandbox E2E authorization changed')
  return map(result.rows[0])
}

export async function readSandboxCommerceE2eAuthorizationInPostgres(input: {
  organizationId: unknown
  authorizationGlobalId: unknown
}) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const authorizationGlobalId = String(input.authorizationGlobalId || '').trim()
  const result = await query<AuthorizationRow>(
    `${SELECT}
     WHERE auth.organization_id = $1::uuid
       AND auth.global_id = $2`,
    [scopedOrganizationId, authorizationGlobalId],
  )
  return result.rows[0] ? map(result.rows[0]) : null
}

export async function readActiveSandboxCommerceE2eAuthorizationForOrderInPostgres(input: {
  organizationId: unknown
  orderGlobalId: unknown
  actorEmail: unknown
}) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const actorEmail = email(input.actorEmail)
  if (!ORDER_GLOBAL_ID.test(orderGlobalId)) {
    fail('SANDBOX_E2E_ORDER_INVALID', 'Operations order is invalid', 400)
  }
  return withTransaction(async (client) => {
    const result = await client.query<AuthorizationRow>(
      `${SELECT}
       WHERE auth.organization_id = $1::uuid
         AND source_order.global_id = $2
         AND auth.authorized_by = $3
         AND auth.state = 'active'
         AND auth.expires_at > now()
       ORDER BY auth.authorized_at DESC, auth.id DESC
       LIMIT 1
       FOR SHARE OF auth`,
      [scopedOrganizationId, orderGlobalId, actorEmail],
    )
    const row = result.rows[0]
    if (!row) return null
    if (
      row.source_provider === 'faire'
      && !(await currentFaireEvidence(client, row))
    ) return null
    return map(row)
  })
}
