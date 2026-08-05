import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  validateApprovedPackRecipeInput,
  validateProductPackProfileVersionInput,
  type ApprovedPackRecipeInput,
  type ProductPackProfileVersionInput,
  type ProductPackVariantMappingInput,
} from '@/lib/operations/productPackManagement'
import {
  isShopifySandboxCheckoutChannelEligible,
} from '@/lib/integrations/shopifyCheckoutChannelEligibility'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

export class ProductPackManagementRequestError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ProductPackManagementRequestError'
    this.code = code
    this.status = status
  }
}

type ProductRow = QueryResultRow & {
  id: string
  pipeline_id: string
  reference_code: string
  name: string
}

type ProfileRow = QueryResultRow & {
  id: string
  global_id: string
  profile_key: string
  profile_name: string
  package_level: 'each' | 'inner_pack' | 'case' | 'pallet'
  is_default: boolean
  status: 'draft' | 'active' | 'retired'
  row_version: string | number
  updated_at: Date | string
}

type VersionRow = QueryResultRow & {
  id: string
  global_id: string
  profile_id: string
  version_number: number
  lifecycle_state:
    | 'draft'
    | 'customer_confirmed'
    | 'active'
    | 'superseded'
    | 'retired'
  base_each_quantity: number
  unit_of_measure: string
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  dimension_basis: 'inner' | 'outer' | 'unspecified'
  gross_weight_grams: number | null
  weight_basis:
    | 'measured'
    | 'provider'
    | 'customer_stated'
    | 'derived'
    | 'legacy'
    | 'unspecified'
  fit_model: 'rigid_3d' | 'compressible' | 'approved_recipe_only'
  ships_as_own_package: boolean
  assembly_policy: 'never' | 'allow_from_child' | 'required_from_child'
  evidence_type:
    | 'unknown'
    | 'customer_confirmed'
    | 'measured'
    | 'provider'
    | 'derived'
    | 'legacy'
  evidence_reference: string | null
  confirmed_at: Date | string | null
  source: 'manual' | 'csv_import' | 'provider_sync' | 'customer_supplied'
  provider_weight_channel_state_id?: string | null
  provider_weight_channel_state_row_version?: string | number | null
  provider_weight_source_revision?: string | null
  provider_weight_source_hash?: string | null
  is_current: boolean
  row_version: string | number
  updated_at?: Date | string
  created_at: Date | string
  profile_global_id?: string
  profile_key?: string
  profile_name?: string
  package_level?: 'each' | 'inner_pack' | 'case' | 'pallet'
  profile_status?: 'draft' | 'active' | 'retired'
  provider_weight_channel_state_global_id?: string | null
}

type ChannelStateRow = QueryResultRow & {
  id: string
  global_id: string
  integration_account_id: string
  pipeline_id: string
  provider: 'shopify' | 'faire'
  external_product_id: string
  external_variant_id: string
  product_id: string | null
  provider_status_raw: string
  normalized_status:
    | 'active'
    | 'draft'
    | 'archived'
    | 'unlisted'
    | 'unavailable'
    | 'unknown'
  provider_active: boolean | null
  provider_updated_at: Date | string | null
  observed_at: Date | string
  source_revision: string
  source_hash: string
  pack_evidence_hash: string
  requires_shipping: boolean | null
  weight_grams: number | null
  row_version: string | number
  account_global_id: string
  account_provider: string
  account_type: string
  account_environment: string
  account_status: string
  credential_verification_status: string | null
}

type MappingRow = QueryResultRow & {
  id: string
  global_id: string
  integration_account_id: string
  provider: 'shopify' | 'faire'
  external_product_id: string
  external_variant_id: string
  default_pack_profile_version_id: string
  provider_lifecycle_state: string
  projection_state: 'current' | 'stale' | 'retired'
  mapping_purpose: 'catalog' | 'shopify_checkout'
  source_revision: string | null
  source_hash: string | null
  pack_evidence_hash: string | null
  is_current: boolean
  row_version: string | number
  updated_at: Date | string
  account_global_id?: string
  channel_state_global_id?: string
  channel_state_row_version?: string | number
  profile_version_global_id?: string
}

type MaterialRow = QueryResultRow & {
  id: string
  global_id: string
  name: string
  status: 'draft' | 'active'
  inner_length_mm: number | null
  inner_width_mm: number | null
  inner_height_mm: number | null
  rated_outer_length_mm: number | null
  rated_outer_width_mm: number | null
  rated_outer_height_mm: number | null
  rated_outer_dimension_evidence_type: string | null
  rated_outer_dimension_evidence_reference: string | null
  rated_outer_dimension_confirmed_at: Date | string | null
  dimension_basis: 'inner' | 'outer' | 'unspecified'
  dimension_evidence_type: string
  dimension_evidence_reference: string | null
  dimension_confirmed_at: Date | string | null
  tare_weight_grams: number | null
  max_weight_grams: number | null
  unit_cost_minor: string | number | null
  currency: string | null
  row_version: string | number
}

type RecipeRow = QueryResultRow & {
  id: string
  global_id: string
  recipe_key: string
  recipe_name: string
  version_number: number
  input_pack_profile_version_id: string
  output_pack_profile_version_id: string
  packaging_material_id: string
  input_quantity: number
  output_quantity: number
  packaging_material_quantity: number
  recipe_type: 'exact_case' | 'max_capacity' | 'ship_ready_unit'
  minimum_input_quantity: number | null
  content_compatibility_key: string | null
  allows_mixed_products: boolean
  fulfillment_policy:
    | 'case_required'
    | 'prefer_full_case'
    | 'each_pick_only'
  remainder_policy: 'case_plus_each' | 'all_each' | 'block'
  inventory_evidence_requirement:
    | 'pack_level_required'
    | 'each_assembly_allowed'
    | 'either'
  assembly_policy: 'never' | 'allowed' | 'required'
  exclusive_contents: boolean
  lifecycle_state: 'draft' | 'customer_confirmed' | 'active' | 'retired'
  fit_evidence_type: string
  fit_evidence_reference: string | null
  confirmed_at: Date | string | null
  source: string
  is_current: boolean
  row_version: string | number
  updated_at: Date | string
  input_profile_version_global_id?: string
  output_profile_version_global_id?: string
  packaging_material_global_id?: string
}

function fail(
  code: string,
  message: string,
  status = 400,
): never {
  throw new ProductPackManagementRequestError(code, message, status)
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail('PRODUCT_PACK_EVIDENCE_CORRUPT', `${label} is invalid`, 500)
  }
  return parsed
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    fail(
      'PRODUCT_PACK_EVIDENCE_CORRUPT',
      'Product pack timestamp is invalid',
      500,
    )
  }
  return parsed.toISOString()
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    )
  }
  return value
}

function requestHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex')
}

async function resolveProduct(
  client: PoolClient,
  organizationId: string,
  productGlobalId: string,
): Promise<ProductRow> {
  const result = await client.query<ProductRow>(
    `SELECT
       product.id::text,
       product.pipeline_id::text,
       product.reference_code,
       product.name
     FROM crm_products product
     JOIN pipeline_spaces pipeline
       ON pipeline.id = product.pipeline_id
      AND pipeline.workspace_organization_id = $1::uuid
     WHERE product.reference_code = $2
     LIMIT 1
     FOR UPDATE OF product`,
    [organizationId, productGlobalId],
  )
  if (!result.rows[0]) {
    fail(
      'PRODUCT_PACK_PRODUCT_NOT_FOUND',
      'Product was not found in the active organization',
      404,
    )
  }
  return result.rows[0]
}

async function executeIdempotentCommand<T extends Record<string, unknown>>(
  input: {
    organizationId: string
    actorEmail: string
    idempotencyKey: string
    productGlobalId: string
    commandType: string
    commandInput: unknown
  },
  execute: (client: PoolClient) => Promise<T>,
): Promise<T & { replayed: boolean }> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `product-pack:${input.organizationId}:${input.productGlobalId}`,
    )
    const hash = requestHash(input.commandInput)
    const prior = await client.query<{
      request_hash: string
      status: 'processing' | 'succeeded' | 'failed'
      result_payload: T | null
    }>(
      `SELECT request_hash, status, result_payload
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [
        input.organizationId,
        input.commandType,
        input.idempotencyKey,
      ],
    )
    const receipt = prior.rows[0]
    if (receipt) {
      if (receipt.request_hash !== hash) {
        fail(
          'PRODUCT_PACK_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different Product pack command',
          409,
        )
      }
      if (receipt.status === 'succeeded' && receipt.result_payload) {
        return { ...receipt.result_payload, replayed: true }
      }
      fail(
        'PRODUCT_PACK_COMMAND_IN_PROGRESS',
        'This Product pack command is already in progress',
        409,
      )
    }
    const created = await client.query<{ id: string }>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, 'processing', gen_random_uuid()
       )
       RETURNING id::text`,
      [
        input.organizationId,
        input.commandType,
        input.idempotencyKey,
        hash,
        input.actorEmail,
      ],
    )
    const result = await execute(client)
    const payload = { ...result, replayed: false }
    const resultGlobalId = typeof result.globalId === 'string'
      ? result.globalId
      : input.productGlobalId
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded',
           result_global_id = $2,
           result_payload = $3::jsonb,
           completed_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        created.rows[0].id,
        resultGlobalId,
        JSON.stringify(payload),
      ],
    )
    return payload
  })
}

async function lockProviderWeightEvidence(
  client: PoolClient,
  input: {
    organizationId: string
    product: ProductRow
    evidence: NonNullable<
      ProductPackProfileVersionInput['providerWeightEvidence']
    >
    expectedGrossWeightGrams: number | null
  },
) {
  const result = await client.query<ChannelStateRow>(
    `SELECT
       state.id::text,
       state.global_id,
       state.integration_account_id::text,
       state.pipeline_id::text,
       state.provider,
       state.external_product_id,
       state.external_variant_id,
       state.product_id::text,
       state.provider_status_raw,
       state.normalized_status,
       state.provider_active,
       state.provider_updated_at,
       state.observed_at,
       state.source_revision,
       state.source_hash,
       state.pack_evidence_hash,
       state.requires_shipping,
       state.weight_grams,
       state.row_version::text,
       account.global_id AS account_global_id,
       account.provider AS account_provider,
       account.integration_type AS account_type,
       account.environment AS account_environment,
       account.status AS account_status,
       credential.verification_status AS credential_verification_status
     FROM operations_product_channel_states state
     JOIN operations_integration_accounts account
       ON account.organization_id = state.organization_id
      AND account.id = state.integration_account_id
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE state.organization_id = $1::uuid
       AND state.global_id = $2
     LIMIT 1
     FOR UPDATE OF state`,
    [
      input.organizationId,
      input.evidence.channelStateGlobalId,
    ],
  )
  const row = result.rows[0]
  if (
    !row
    || row.pipeline_id !== input.product.pipeline_id
    || row.product_id !== input.product.id
  ) {
    fail(
      'PRODUCT_PACK_PROVIDER_WEIGHT_SCOPE_MISMATCH',
      'Provider weight evidence does not belong to this Product',
      409,
    )
  }
  if (
    integer(row.row_version, 'Channel-state row version')
    !== input.evidence.expectedChannelStateRowVersion
  ) {
    fail(
      'PRODUCT_PACK_CHANNEL_STATE_VERSION_CONFLICT',
      'Provider Product evidence changed; reload before saving the pack profile',
      409,
    )
  }
  if (
    !Number.isSafeInteger(row.weight_grams)
    || Number(row.weight_grams) < 1
    || row.weight_grams !== input.expectedGrossWeightGrams
  ) {
    fail(
      'PRODUCT_PACK_PROVIDER_WEIGHT_CONFLICT',
      'Pack gross weight must exactly match current provider Product evidence',
      409,
    )
  }
  return row
}

function savedProfileResult(
  profile: ProfileRow,
  version: VersionRow,
) {
  return {
    globalId: profile.global_id,
    profileGlobalId: profile.global_id,
    profileRowVersion: integer(
      profile.row_version,
      'Profile row version',
    ),
    versionGlobalId: version.global_id,
    versionNumber: Number(version.version_number),
    versionRowVersion: integer(
      version.row_version,
      'Profile-version row version',
    ),
    lifecycleState: version.lifecycle_state,
    packageLevel: profile.package_level,
    baseEachQuantity: Number(version.base_each_quantity),
  }
}

export async function saveProductPackProfileVersionInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  profile: ProductPackProfileVersionInput
}) {
  const normalized = validateProductPackProfileVersionInput(input.profile)
  return executeIdempotentCommand({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    idempotencyKey: input.idempotencyKey,
    productGlobalId: normalized.productGlobalId,
    commandType: 'operations.product_pack.save_profile_version',
    commandInput: normalized,
  }, async (client) => {
    const product = await resolveProduct(
      client,
      input.organizationId,
      normalized.productGlobalId,
    )
    const providerEvidence = normalized.providerWeightEvidence
      ? await lockProviderWeightEvidence(client, {
          organizationId: input.organizationId,
          product,
          evidence: normalized.providerWeightEvidence,
          expectedGrossWeightGrams: normalized.grossWeightGrams,
        })
      : null
    const profiles = await client.query<ProfileRow>(
      `SELECT
         id::text,
         global_id,
         profile_key,
         profile_name,
         package_level,
         is_default,
         status,
         row_version::text,
         updated_at
       FROM operations_product_pack_profiles
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND product_id = $3::uuid
         AND (
           ($4::text IS NOT NULL AND global_id = $4)
           OR profile_key = $5
         )
       ORDER BY id
       FOR UPDATE`,
      [
        input.organizationId,
        product.pipeline_id,
        product.id,
        normalized.profileGlobalId,
        normalized.profileKey,
      ],
    )
    if (profiles.rows.length > 1) {
      fail(
        'PRODUCT_PACK_PROFILE_IDENTITY_CONFLICT',
        'Profile Global ID and key identify different profiles',
        409,
      )
    }
    let profile = profiles.rows[0] || null
    if (
      normalized.profileGlobalId
      && (
        !profile
        || profile.global_id !== normalized.profileGlobalId
        || profile.profile_key !== normalized.profileKey
      )
    ) {
      fail(
        'PRODUCT_PACK_PROFILE_NOT_FOUND',
        'The expected Product pack profile was not found',
        404,
      )
    }
    if (!normalized.profileGlobalId && profile) {
      fail(
        'PRODUCT_PACK_PROFILE_ALREADY_EXISTS',
        'This Product pack profile already exists; reload before editing it',
        409,
      )
    }
    if (
      profile
      && (
        normalized.expectedProfileRowVersion === null
        || integer(profile.row_version, 'Profile row version')
          !== normalized.expectedProfileRowVersion
      )
    ) {
      fail(
        'PRODUCT_PACK_PROFILE_VERSION_CONFLICT',
        'The Product pack profile changed; reload before saving',
        409,
      )
    }
    if (
      profile
      && (
        profile.package_level !== normalized.packageLevel
        || profile.status === 'retired'
      )
    ) {
      fail(
        'PRODUCT_PACK_PROFILE_IDENTITY_IMMUTABLE',
        'Package level cannot change and retired profiles cannot be reused',
        409,
      )
    }
    const currentVersions = profile
      ? await client.query<VersionRow>(
          `SELECT
             id::text,
             global_id,
             profile_id::text,
             version_number,
             lifecycle_state,
             base_each_quantity,
             unit_of_measure,
             length_mm,
             width_mm,
             height_mm,
             dimension_basis,
             gross_weight_grams,
             weight_basis,
             fit_model,
             ships_as_own_package,
             assembly_policy,
             evidence_type,
             evidence_reference,
             confirmed_at,
             source,
             is_current,
             row_version::text,
             created_at
           FROM operations_product_pack_profile_versions
           WHERE organization_id = $1::uuid
             AND profile_id = $2::uuid
             AND is_current = true
           FOR UPDATE`,
          [input.organizationId, profile.id],
        )
      : { rows: [] as VersionRow[] }
    if (currentVersions.rows.length > 1) {
      fail(
        'PRODUCT_PACK_CURRENT_VERSION_CONFLICT',
        'Product pack profile has multiple current versions',
        500,
      )
    }
    const current = currentVersions.rows[0] || null
    if (
      profile
      && (
        !current
        || normalized.expectedCurrentVersionGlobalId
          !== current.global_id
        || normalized.expectedCurrentVersionRowVersion === null
        || integer(current.row_version, 'Current profile-version row version')
          !== normalized.expectedCurrentVersionRowVersion
      )
    ) {
      fail(
        'PRODUCT_PACK_CURRENT_VERSION_CONFLICT',
        'The current Product pack version changed; reload before saving',
        409,
      )
    }
    if (
      !profile
      && (
        normalized.expectedProfileRowVersion !== null
        || normalized.expectedCurrentVersionGlobalId !== null
        || normalized.expectedCurrentVersionRowVersion !== null
      )
    ) {
      fail(
        'PRODUCT_PACK_CREATE_EXPECTATION_INVALID',
        'New profiles cannot include existing-row expectations',
        400,
      )
    }
    if (
      profile?.status === 'active'
      && normalized.profileStatus !== 'active'
    ) {
      fail(
        'PRODUCT_PACK_DEACTIVATION_REQUIRES_RETIRE_COMMAND',
        'An active Product pack profile cannot be downgraded by a version save',
        409,
      )
    }
    if (normalized.isDefault && normalized.profileStatus === 'active') {
      const competing = await client.query<{ global_id: string }>(
        `SELECT global_id
         FROM operations_product_pack_profiles
         WHERE organization_id = $1::uuid
           AND product_id = $2::uuid
           AND is_default = true
           AND status = 'active'
           AND ($3::uuid IS NULL OR id <> $3::uuid)
         LIMIT 1
         FOR UPDATE`,
        [input.organizationId, product.id, profile?.id || null],
      )
      if (competing.rows[0]) {
        fail(
          'PRODUCT_PACK_DEFAULT_CONFLICT',
          'Another active default pack profile already exists for this Product',
          409,
        )
      }
    }
    let invalidatedMappingCount = 0
    let retiredRecipeCount = 0
    if (current) {
      const invalidatedMappings = await client.query(
        `UPDATE operations_commerce_variant_pack_mappings
         SET projection_state = 'stale',
             is_current = false,
             effective_to = GREATEST(
               clock_timestamp(),
               effective_from + interval '1 microsecond'
             ),
             row_version = row_version + 1,
             updated_by = $3,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND default_pack_profile_version_id = $2::uuid
           AND is_current = true`,
        [input.organizationId, current.id, input.actorEmail],
      )
      invalidatedMappingCount = invalidatedMappings.rowCount || 0
      const retiredRecipes = await client.query(
        `UPDATE operations_approved_pack_recipes
         SET lifecycle_state = 'retired',
             is_current = false,
             effective_to = GREATEST(
               clock_timestamp(),
               effective_from + interval '1 microsecond'
             ),
             row_version = row_version + 1,
             updated_by = $3,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND (
             input_pack_profile_version_id = $2::uuid
             OR output_pack_profile_version_id = $2::uuid
           )
           AND is_current = true`,
        [input.organizationId, current.id, input.actorEmail],
      )
      retiredRecipeCount = retiredRecipes.rowCount || 0
      const superseded = await client.query(
        `UPDATE operations_product_pack_profile_versions
         SET lifecycle_state = 'superseded',
             is_current = false,
             effective_to = GREATEST(
               clock_timestamp(),
               effective_from + interval '1 microsecond'
             ),
             row_version = row_version + 1
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND row_version = $3::bigint
           AND is_current = true`,
        [
          input.organizationId,
          current.id,
          normalized.expectedCurrentVersionRowVersion,
        ],
      )
      if (superseded.rowCount !== 1) {
        fail(
          'PRODUCT_PACK_CURRENT_VERSION_CONFLICT',
          'The current Product pack version changed; reload before saving',
          409,
        )
      }
    }
    if (profile) {
      const updated = await client.query<ProfileRow>(
        `UPDATE operations_product_pack_profiles
         SET profile_name = $4,
             is_default = $5,
             status = $6,
             row_version = row_version + 1,
             updated_by = $7,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND pipeline_id = $2::uuid
           AND id = $3::uuid
           AND row_version = $8::bigint
         RETURNING
           id::text,
           global_id,
           profile_key,
           profile_name,
           package_level,
           is_default,
           status,
           row_version::text,
           updated_at`,
        [
          input.organizationId,
          product.pipeline_id,
          profile.id,
          normalized.profileName,
          normalized.isDefault,
          normalized.profileStatus,
          input.actorEmail,
          normalized.expectedProfileRowVersion,
        ],
      )
      if (!updated.rows[0]) {
        fail(
          'PRODUCT_PACK_PROFILE_VERSION_CONFLICT',
          'The Product pack profile changed; reload before saving',
          409,
        )
      }
      profile = updated.rows[0]
    } else {
      const inserted = await client.query<ProfileRow>(
        `INSERT INTO operations_product_pack_profiles (
           organization_id,
           pipeline_id,
           product_id,
           profile_key,
           profile_name,
           package_level,
           is_default,
           status,
           created_by,
           updated_by
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4,
           $5,
           $6,
           $7,
           $8,
           $9,
           $9
         )
         RETURNING
           id::text,
           global_id,
           profile_key,
           profile_name,
           package_level,
           is_default,
           status,
           row_version::text,
           updated_at`,
        [
          input.organizationId,
          product.pipeline_id,
          product.id,
          normalized.profileKey,
          normalized.profileName,
          normalized.packageLevel,
          normalized.isDefault,
          normalized.profileStatus,
          input.actorEmail,
        ],
      )
      profile = inserted.rows[0]
    }
    const versionNumber = current
      ? Number(current.version_number) + 1
      : 1
    const dimensions = normalized.dimensionsMm
    const confirmed = normalized.evidenceType === 'unknown'
      ? false
      : true
    const evidenceReference = providerEvidence
      ? [
          normalized.evidenceReference,
          `Provider weight ${providerEvidence.global_id}`,
          `source ${providerEvidence.source_revision}`,
        ].filter(Boolean).join(' · ').slice(0, 500)
      : normalized.evidenceReference
    const insertedVersion = await client.query<VersionRow>(
      `INSERT INTO operations_product_pack_profile_versions (
         organization_id,
         pipeline_id,
         product_id,
         profile_id,
         version_number,
         lifecycle_state,
         base_each_quantity,
         unit_of_measure,
         length_mm,
         width_mm,
         height_mm,
         dimension_basis,
         gross_weight_grams,
         weight_basis,
         fit_model,
         ships_as_own_package,
         assembly_policy,
         evidence_type,
         evidence_reference,
         confirmed_at,
         confirmed_by,
         source,
         provider_weight_channel_state_id,
         provider_weight_channel_state_row_version,
         provider_weight_source_revision,
         provider_weight_source_hash,
         is_current,
         created_by
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4::uuid,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         $13,
         $14,
         $15,
         $16,
         $17,
         $18,
         $19,
         CASE WHEN $20::boolean THEN now() ELSE NULL END,
         CASE WHEN $20::boolean THEN $21 ELSE NULL END,
         $22,
         $23::uuid,
         $24::bigint,
         $25,
         $26,
         true,
         $21
       )
       RETURNING
         id::text,
         global_id,
         profile_id::text,
         version_number,
         lifecycle_state,
         base_each_quantity,
         unit_of_measure,
         length_mm,
         width_mm,
         height_mm,
         dimension_basis,
         gross_weight_grams,
         weight_basis,
         fit_model,
         ships_as_own_package,
         assembly_policy,
         evidence_type,
         evidence_reference,
         confirmed_at,
         source,
         provider_weight_channel_state_id::text,
         provider_weight_channel_state_row_version::text,
         provider_weight_source_revision,
         provider_weight_source_hash,
         is_current,
         row_version::text,
         created_at`,
      [
        input.organizationId,
        product.pipeline_id,
        product.id,
        profile.id,
        versionNumber,
        normalized.lifecycleState,
        normalized.baseEachQuantity,
        normalized.unitOfMeasure,
        dimensions?.length || null,
        dimensions?.width || null,
        dimensions?.height || null,
        normalized.dimensionBasis,
        normalized.grossWeightGrams,
        normalized.weightBasis,
        normalized.fitModel,
        normalized.shipsAsOwnPackage,
        normalized.assemblyPolicy,
        normalized.evidenceType,
        evidenceReference,
        confirmed,
        input.actorEmail,
        normalized.source,
        providerEvidence?.id || null,
        providerEvidence
          ? integer(
              providerEvidence.row_version,
              'Provider channel-state row version',
            )
          : null,
        providerEvidence?.source_revision || null,
        providerEvidence?.source_hash || null,
      ],
    )
    const version = insertedVersion.rows[0]
    const result = savedProfileResult(profile, version)
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.product_pack.profile_version_saved',
      aggregateType: 'operations.product_pack_profile',
      aggregateId: profile.global_id,
      subject: product.name,
      organizationId: input.organizationId,
      eventKey:
        `operations:product-pack-profile:${profile.global_id}`
        + `:version:${version.version_number}`,
      payload: {
        productGlobalId: product.reference_code,
        profileGlobalId: profile.global_id,
        profileKey: profile.profile_key,
        profileStatus: profile.status,
        profileRowVersion: result.profileRowVersion,
        versionGlobalId: version.global_id,
        versionNumber: version.version_number,
        lifecycleState: version.lifecycle_state,
        packageLevel: profile.package_level,
        baseEachQuantity: version.base_each_quantity,
        unitOfMeasure: version.unit_of_measure,
        dimensionsMm: dimensions,
        grossWeightGrams: normalized.grossWeightGrams,
        weightBasis: normalized.weightBasis,
        evidenceType: normalized.evidenceType,
        providerWeightChannelStateGlobalId:
          providerEvidence?.global_id || null,
        invalidatedMappingCount,
        retiredRecipeCount,
      },
    }, client)
    return result
  })
}

async function lockChannelState(
  client: PoolClient,
  input: {
    organizationId: string
    channelStateGlobalId: string
    expectedRowVersion: number
  },
) {
  const result = await client.query<ChannelStateRow>(
    `SELECT
       state.id::text,
       state.global_id,
       state.integration_account_id::text,
       state.pipeline_id::text,
       state.provider,
       state.external_product_id,
       state.external_variant_id,
       state.product_id::text,
       state.provider_status_raw,
       state.normalized_status,
       state.provider_active,
       state.provider_updated_at,
       state.observed_at,
       state.source_revision,
       state.source_hash,
       state.pack_evidence_hash,
       state.requires_shipping,
       state.weight_grams,
       state.row_version::text,
       account.global_id AS account_global_id,
       account.provider AS account_provider,
       account.integration_type AS account_type,
       account.environment AS account_environment,
       account.status AS account_status,
       credential.verification_status AS credential_verification_status
     FROM operations_product_channel_states state
     JOIN operations_integration_accounts account
       ON account.organization_id = state.organization_id
      AND account.id = state.integration_account_id
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE state.organization_id = $1::uuid
       AND state.global_id = $2
     LIMIT 1
     FOR UPDATE OF state`,
    [input.organizationId, input.channelStateGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'PRODUCT_PACK_CHANNEL_STATE_NOT_FOUND',
      'Product sales-channel state was not found',
      404,
    )
  }
  if (
    integer(row.row_version, 'Channel-state row version')
    !== input.expectedRowVersion
  ) {
    fail(
      'PRODUCT_PACK_CHANNEL_STATE_VERSION_CONFLICT',
      'Product sales-channel state changed; reload before saving',
      409,
    )
  }
  if (
    row.account_type !== 'commerce'
    || row.account_provider !== row.provider
    || row.account_status === 'error'
    || row.credential_verification_status !== 'verified'
  ) {
    fail(
      'PRODUCT_PACK_CHANNEL_ACCOUNT_NOT_READY',
      'The exact commerce connection is not eligible and verified',
      409,
    )
  }
  return row
}

async function lockProfileVersion(
  client: PoolClient,
  input: {
    organizationId: string
    product: ProductRow
    versionGlobalId: string
    expectedRowVersion: number
  },
): Promise<VersionRow> {
  const result = await client.query<VersionRow>(
    `SELECT
       version.id::text,
       version.global_id,
       version.profile_id::text,
       version.version_number,
       version.lifecycle_state,
       version.base_each_quantity,
       version.unit_of_measure,
       version.length_mm,
       version.width_mm,
       version.height_mm,
       version.dimension_basis,
       version.gross_weight_grams,
       version.weight_basis,
       version.fit_model,
       version.ships_as_own_package,
       version.assembly_policy,
       version.evidence_type,
       version.evidence_reference,
       version.confirmed_at,
       version.source,
       version.is_current,
       version.row_version::text,
       version.created_at,
       profile.global_id AS profile_global_id,
       profile.profile_key,
       profile.profile_name,
       profile.package_level,
       profile.status AS profile_status
     FROM operations_product_pack_profile_versions version
     JOIN operations_product_pack_profiles profile
       ON profile.organization_id = version.organization_id
      AND profile.pipeline_id = version.pipeline_id
      AND profile.product_id = version.product_id
      AND profile.id = version.profile_id
     WHERE version.organization_id = $1::uuid
       AND version.pipeline_id = $2::uuid
       AND version.product_id = $3::uuid
       AND version.global_id = $4
     LIMIT 1
     FOR UPDATE OF version, profile`,
    [
      input.organizationId,
      input.product.pipeline_id,
      input.product.id,
      input.versionGlobalId,
    ],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'PRODUCT_PACK_PROFILE_VERSION_NOT_FOUND',
      'Product pack version was not found',
      404,
    )
  }
  if (
    integer(row.row_version, 'Product pack version row version')
    !== input.expectedRowVersion
  ) {
    fail(
      'PRODUCT_PACK_PROFILE_VERSION_CONFLICT',
      'Product pack version changed; reload before saving',
      409,
    )
  }
  if (row.is_current !== true) {
    fail(
      'PRODUCT_PACK_PROFILE_VERSION_NOT_CURRENT',
      'Only the exact current Product pack version can be mapped',
      409,
    )
  }
  return row
}

async function requireShopifyCheckoutPackReady(
  client: PoolClient,
  input: {
    organizationId: string
    state: ChannelStateRow
    version: VersionRow
  },
) {
  if (
    !isShopifySandboxCheckoutChannelEligible({
      provider: input.state.provider,
      accountEnvironment: input.state.account_environment,
      providerStatusRaw: input.state.provider_status_raw,
      normalizedStatus: input.state.normalized_status,
      providerActive: input.state.provider_active,
      requiresShipping: input.state.requires_shipping,
      weightGrams: input.state.weight_grams,
    })
  ) {
    fail(
      'PRODUCT_PACK_SHOPIFY_CHECKOUT_CHANNEL_NOT_READY',
      'Shopify checkout mapping requires an eligible sandbox shipping variant with positive provider weight',
      409,
    )
  }
  if (
    input.version.is_current !== true
    || input.version.lifecycle_state !== 'active'
    || input.version.profile_status !== 'active'
    || input.version.evidence_type === 'unknown'
    || !input.version.evidence_reference
    || input.version.confirmed_at === null
    || input.version.gross_weight_grams !== input.state.weight_grams
  ) {
    fail(
      'PRODUCT_PACK_SHOPIFY_CHECKOUT_PROFILE_NOT_READY',
      'Shopify checkout mapping requires the exact active confirmed pack version with matching provider weight',
      409,
    )
  }
  const readyConfig = await client.query<{
    config_global_id: string
  }>(
    `SELECT
       config.global_id AS config_global_id
     FROM operations_shopify_carrier_service_configs config
     WHERE config.organization_id = $1::uuid
       AND config.integration_account_id = $2::uuid
       AND config.registration_state = 'registered'
       AND operations_shopify_carrier_service_config_is_ready(
         config.organization_id,
         config.id
       )
     ORDER BY config.global_id
     LIMIT 1`,
    [
      input.organizationId,
      input.state.integration_account_id,
    ],
  )
  if (!readyConfig.rows[0]) {
    fail(
      'PRODUCT_PACK_SHOPIFY_CHECKOUT_CARRIER_SERVICE_NOT_READY',
      'Register a ready Shopify CarrierService before checkout mapping',
      409,
    )
  }
  const selfPackage = (
    input.version.package_level === 'case'
    && Number(input.version.base_each_quantity) > 1
    && input.version.ships_as_own_package === true
  )
  if (selfPackage) {
    return {
      ...readyConfig.rows[0],
      recipe_global_id: null,
      planning_method: 'self_package' as const,
    }
  }
  const readyRecipe = await client.query<{
    recipe_global_id: string
  }>(
    `SELECT recipe.global_id AS recipe_global_id
     FROM operations_approved_pack_recipes recipe
     JOIN operations_shopify_carrier_service_config_materials selected
       ON selected.organization_id = recipe.organization_id
      AND selected.config_id = (
        SELECT config.id
        FROM operations_shopify_carrier_service_configs config
        WHERE config.organization_id = $1::uuid
          AND config.global_id = $2
        LIMIT 1
      )
      AND selected.packaging_material_id = recipe.packaging_material_id
     JOIN operations_packaging_materials material
       ON material.organization_id = selected.organization_id
      AND material.id = selected.packaging_material_id
      AND material.row_version = selected.packaging_material_row_version
     WHERE recipe.organization_id = $1::uuid
       AND recipe.input_pack_profile_version_id = $3::uuid
       AND recipe.lifecycle_state = 'active'
       AND recipe.is_current = true
     ORDER BY recipe.global_id
     LIMIT 1`,
    [
      input.organizationId,
      readyConfig.rows[0].config_global_id,
      input.version.id,
    ],
  )
  if (!readyRecipe.rows[0]) {
    fail(
      'PRODUCT_PACK_SHOPIFY_CHECKOUT_RECIPE_NOT_READY',
      'Activate an approved recipe using a selected CarrierService material before checkout mapping this sell unit',
      409,
    )
  }
  return {
    ...readyConfig.rows[0],
    ...readyRecipe.rows[0],
    planning_method: 'approved_recipe' as const,
  }
}

export async function saveCommerceVariantPackMappingInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  mapping: ProductPackVariantMappingInput
}) {
  return executeIdempotentCommand({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    idempotencyKey: input.idempotencyKey,
    productGlobalId: input.mapping.productGlobalId,
    commandType: 'operations.product_pack.save_variant_mapping',
    commandInput: input.mapping,
  }, async (client) => {
    const product = await resolveProduct(
      client,
      input.organizationId,
      input.mapping.productGlobalId,
    )
    const state = await lockChannelState(client, {
      organizationId: input.organizationId,
      channelStateGlobalId: input.mapping.channelStateGlobalId,
      expectedRowVersion: input.mapping.expectedChannelStateRowVersion,
    })
    if (
      state.pipeline_id !== product.pipeline_id
      || state.product_id !== product.id
    ) {
      fail(
        'PRODUCT_PACK_CHANNEL_PRODUCT_MISMATCH',
        'Product sales-channel state does not belong to this Product',
        409,
      )
    }
    const version = await lockProfileVersion(client, {
      organizationId: input.organizationId,
      product,
      versionGlobalId: input.mapping.profileVersionGlobalId,
      expectedRowVersion: input.mapping.expectedProfileVersionRowVersion,
    })
    let checkoutReadiness: {
      config_global_id: string
      recipe_global_id: string | null
      planning_method: 'approved_recipe' | 'self_package'
    } | null = null
    if (input.mapping.purpose === 'shopify_checkout') {
      checkoutReadiness = await requireShopifyCheckoutPackReady(client, {
        organizationId: input.organizationId,
        state,
        version,
      })
    }
    const currentMappings = await client.query<MappingRow>(
      `SELECT
         id::text,
         global_id,
         integration_account_id::text,
         provider,
         external_product_id,
         external_variant_id,
         default_pack_profile_version_id::text,
         provider_lifecycle_state,
         projection_state,
         mapping_purpose,
         source_revision,
         source_hash,
         pack_evidence_hash,
         is_current,
         row_version::text,
         updated_at
       FROM operations_commerce_variant_pack_mappings
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND provider = $3
         AND external_variant_id = $4
         AND mapping_purpose = $5
         AND is_current = true
       FOR UPDATE`,
      [
        input.organizationId,
        state.integration_account_id,
        state.provider,
        state.external_variant_id,
        input.mapping.purpose,
      ],
    )
    if (currentMappings.rows.length > 1) {
      fail(
        'PRODUCT_PACK_MAPPING_CURRENT_CONFLICT',
        'Variant has multiple current pack mappings for this purpose',
        500,
      )
    }
    const current = currentMappings.rows[0] || null
    if (
      current
      && (
        !input.mapping.expectedCurrentMappingGlobalId
        || input.mapping.expectedCurrentMappingGlobalId
          !== current.global_id
        || input.mapping.expectedCurrentMappingRowVersion === null
        || input.mapping.expectedCurrentMappingRowVersion
          !== integer(current.row_version, 'Current mapping row version')
      )
    ) {
      fail(
        'PRODUCT_PACK_MAPPING_VERSION_CONFLICT',
        'Variant pack mapping changed; reload before saving',
        409,
      )
    }
    if (
      !current
      && (
        input.mapping.expectedCurrentMappingGlobalId !== null
        || input.mapping.expectedCurrentMappingRowVersion !== null
      )
    ) {
      fail(
        'PRODUCT_PACK_MAPPING_EXPECTATION_CONFLICT',
        'Expected variant pack mapping was not found',
        409,
      )
    }
    if (current) {
      const superseded = await client.query(
        `UPDATE operations_commerce_variant_pack_mappings
         SET projection_state = 'stale',
             is_current = false,
             effective_to = GREATEST(
               clock_timestamp(),
               effective_from + interval '1 microsecond'
             ),
             row_version = row_version + 1,
             updated_by = $4,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND row_version = $3::bigint
           AND is_current = true`,
        [
          input.organizationId,
          current.id,
          input.mapping.expectedCurrentMappingRowVersion,
          input.actorEmail,
        ],
      )
      if (superseded.rowCount !== 1) {
        fail(
          'PRODUCT_PACK_MAPPING_VERSION_CONFLICT',
          'Variant pack mapping changed; reload before saving',
          409,
        )
      }
    }
    const inserted = await client.query<MappingRow>(
      `INSERT INTO operations_commerce_variant_pack_mappings (
         organization_id,
         integration_account_id,
         pipeline_id,
         product_id,
         provider,
         external_product_id,
         external_variant_id,
         default_pack_profile_version_id,
         provider_lifecycle_state,
         projection_state,
         mapping_purpose,
         source_revision,
         source_hash,
         pack_evidence_hash,
         provider_updated_at,
         observed_at,
         is_current,
         created_by,
         updated_by
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4::uuid,
         $5,
         $6,
         $7,
         $8::uuid,
         $9,
         'current',
         $15,
         $10,
         $11,
         $16,
         $12::timestamptz,
         $13::timestamptz,
         true,
         $14,
         $14
       )
       RETURNING
         id::text,
         global_id,
         integration_account_id::text,
         provider,
         external_product_id,
         external_variant_id,
         default_pack_profile_version_id::text,
         provider_lifecycle_state,
         projection_state,
         mapping_purpose,
         source_revision,
         source_hash,
         pack_evidence_hash,
         is_current,
         row_version::text,
         updated_at`,
      [
        input.organizationId,
        state.integration_account_id,
        product.pipeline_id,
        product.id,
        state.provider,
        state.external_product_id,
        state.external_variant_id,
        version.id,
        state.normalized_status,
        state.source_revision,
        state.source_hash,
        state.provider_updated_at,
        state.observed_at,
        input.actorEmail,
        input.mapping.purpose,
        state.pack_evidence_hash,
      ],
    )
    const mapping = inserted.rows[0]
    const result = {
      globalId: mapping.global_id,
      mappingGlobalId: mapping.global_id,
      mappingRowVersion: integer(
        mapping.row_version,
        'Mapping row version',
      ),
      productGlobalId: product.reference_code,
      accountGlobalId: state.account_global_id,
      provider: state.provider,
      channelStateGlobalId: state.global_id,
      channelStateRowVersion: integer(
        state.row_version,
        'Channel-state row version',
      ),
      profileVersionGlobalId: version.global_id,
      profileVersionRowVersion: integer(
        version.row_version,
        'Profile-version row version',
      ),
      purpose: mapping.mapping_purpose,
      checkoutConfigGlobalId:
        checkoutReadiness?.config_global_id || null,
      checkoutRecipeGlobalId:
        checkoutReadiness?.recipe_global_id || null,
      checkoutPlanningMethod:
        checkoutReadiness?.planning_method || null,
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.product_pack.variant_mapping_saved',
      aggregateType: 'operations.commerce_variant_pack_mapping',
      aggregateId: mapping.global_id,
      subject: product.name,
      organizationId: input.organizationId,
      eventKey:
        `operations:variant-pack-mapping:${mapping.global_id}:version:0`,
      payload: {
        ...result,
        externalProductId: state.external_product_id,
        externalVariantId: state.external_variant_id,
        sourceRevision: state.source_revision,
        sourceHash: state.source_hash,
      },
    }, client)
    return result
  })
}

function assertActiveRecipeMaterial(material: MaterialRow) {
  if (
    material.status !== 'active'
    || material.dimension_basis !== 'inner'
    || material.dimension_evidence_type === 'unknown'
    || !material.dimension_evidence_reference
    || material.dimension_confirmed_at === null
    || !Number.isSafeInteger(material.inner_length_mm)
    || Number(material.inner_length_mm) < 1
    || !Number.isSafeInteger(material.inner_width_mm)
    || Number(material.inner_width_mm) < 1
    || !Number.isSafeInteger(material.inner_height_mm)
    || Number(material.inner_height_mm) < 1
    || !Number.isSafeInteger(material.rated_outer_length_mm)
    || Number(material.rated_outer_length_mm) < 1
    || !Number.isSafeInteger(material.rated_outer_width_mm)
    || Number(material.rated_outer_width_mm) < 1
    || !Number.isSafeInteger(material.rated_outer_height_mm)
    || Number(material.rated_outer_height_mm) < 1
    || !material.rated_outer_dimension_evidence_type
    || !material.rated_outer_dimension_evidence_reference
    || material.rated_outer_dimension_confirmed_at === null
    || !Number.isSafeInteger(material.tare_weight_grams)
    || Number(material.tare_weight_grams) < 1
    || !Number.isSafeInteger(material.max_weight_grams)
    || Number(material.max_weight_grams)
      <= Number(material.tare_weight_grams)
    || material.unit_cost_minor === null
    || Number(material.unit_cost_minor) < 1
    || !material.currency
  ) {
    fail(
      'PRODUCT_PACK_RECIPE_MATERIAL_NOT_READY',
      'Recipe activation requires an active material with confirmed inner and rated outer dimensions, tare/capacity, cost, and currency',
      409,
    )
  }
}

export async function saveApprovedPackRecipeInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  recipe: ApprovedPackRecipeInput
}) {
  const normalized = validateApprovedPackRecipeInput(input.recipe)
  return executeIdempotentCommand({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    idempotencyKey: input.idempotencyKey,
    productGlobalId: normalized.productGlobalId,
    commandType: 'operations.product_pack.save_approved_recipe',
    commandInput: normalized,
  }, async (client) => {
    const product = await resolveProduct(
      client,
      input.organizationId,
      normalized.productGlobalId,
    )
    const inputVersion = await lockProfileVersion(client, {
      organizationId: input.organizationId,
      product,
      versionGlobalId: normalized.inputProfileVersionGlobalId,
      expectedRowVersion:
        normalized.expectedInputProfileVersionRowVersion,
    })
    const outputVersion = await lockProfileVersion(client, {
      organizationId: input.organizationId,
      product,
      versionGlobalId: normalized.outputProfileVersionGlobalId,
      expectedRowVersion:
        normalized.expectedOutputProfileVersionRowVersion,
    })
    if (
      inputVersion.package_level !== 'each'
      || outputVersion.package_level !== 'case'
    ) {
      fail(
        'PRODUCT_PACK_RECIPE_LEVELS_INVALID',
        'This API slice supports recipes from an each input to a case output',
        409,
      )
    }
    if (
      normalized.recipeType === 'exact_case'
      && (
        Number(inputVersion.base_each_quantity)
          * normalized.inputQuantity
        !== Number(outputVersion.base_each_quantity)
          * normalized.outputQuantity
      )
    ) {
      fail(
        'PRODUCT_PACK_RECIPE_QUANTITY_CONFLICT',
        'Exact-case recipe quantities do not conserve base eaches',
        409,
      )
    }
    if (
      normalized.lifecycleState === 'active'
      && (
        inputVersion.is_current !== true
        || outputVersion.is_current !== true
        || inputVersion.lifecycle_state !== 'active'
        || outputVersion.lifecycle_state !== 'active'
        || inputVersion.profile_status !== 'active'
        || outputVersion.profile_status !== 'active'
      )
    ) {
      fail(
        'PRODUCT_PACK_RECIPE_PROFILE_NOT_READY',
        'Recipe activation requires exact current active each and case versions',
        409,
      )
    }
    const materials = await client.query<MaterialRow>(
      `SELECT
         id::text,
         global_id,
         name,
         status,
         inner_length_mm,
         inner_width_mm,
         inner_height_mm,
         rated_outer_length_mm,
         rated_outer_width_mm,
         rated_outer_height_mm,
         rated_outer_dimension_evidence_type,
         rated_outer_dimension_evidence_reference,
         rated_outer_dimension_confirmed_at,
         dimension_basis,
         dimension_evidence_type,
         dimension_evidence_reference,
         dimension_confirmed_at,
         tare_weight_grams,
         max_weight_grams,
         unit_cost_minor::text,
         currency,
         row_version::text
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid
         AND global_id = $2
       LIMIT 1
       FOR UPDATE`,
      [
        input.organizationId,
        normalized.packagingMaterialGlobalId,
      ],
    )
    const material = materials.rows[0]
    if (!material) {
      fail(
        'PRODUCT_PACK_RECIPE_MATERIAL_NOT_FOUND',
        'Packaging material was not found',
        404,
      )
    }
    if (
      integer(material.row_version, 'Packaging material row version')
      !== normalized.expectedPackagingMaterialRowVersion
    ) {
      fail(
        'PRODUCT_PACK_RECIPE_MATERIAL_VERSION_CONFLICT',
        'Packaging material changed; reload before saving',
        409,
      )
    }
    if (normalized.lifecycleState === 'active') {
      assertActiveRecipeMaterial(material)
    }
    const recipes = await client.query<RecipeRow>(
      `SELECT
         id::text,
         global_id,
         recipe_key,
         recipe_name,
         version_number,
         input_pack_profile_version_id::text,
         output_pack_profile_version_id::text,
         packaging_material_id::text,
         input_quantity,
         output_quantity,
         packaging_material_quantity,
         recipe_type,
         minimum_input_quantity,
         content_compatibility_key,
         allows_mixed_products,
         fulfillment_policy,
         remainder_policy,
         inventory_evidence_requirement,
         assembly_policy,
         exclusive_contents,
         lifecycle_state,
         fit_evidence_type,
         fit_evidence_reference,
         confirmed_at,
         source,
         is_current,
         row_version::text,
         updated_at
       FROM operations_approved_pack_recipes
       WHERE organization_id = $1::uuid
         AND product_id = $2::uuid
         AND is_current = true
         AND (
           ($3::text IS NOT NULL AND global_id = $3)
           OR recipe_key = $4
         )
       ORDER BY id
       FOR UPDATE`,
      [
        input.organizationId,
        product.id,
        normalized.recipeGlobalId,
        normalized.recipeKey,
      ],
    )
    if (recipes.rows.length > 1) {
      fail(
        'PRODUCT_PACK_RECIPE_IDENTITY_CONFLICT',
        'Recipe Global ID and key identify different recipes',
        409,
      )
    }
    const current = recipes.rows[0] || null
    if (
      normalized.recipeGlobalId
      && (
        !current
        || current.global_id !== normalized.recipeGlobalId
        || current.recipe_key !== normalized.recipeKey
      )
    ) {
      fail(
        'PRODUCT_PACK_RECIPE_NOT_FOUND',
        'The expected pack recipe was not found',
        404,
      )
    }
    if (!normalized.recipeGlobalId && current) {
      fail(
        'PRODUCT_PACK_RECIPE_ALREADY_EXISTS',
        'This recipe already exists; reload before editing it',
        409,
      )
    }
    if (
      current
      && (
        normalized.expectedRecipeRowVersion === null
        || integer(current.row_version, 'Recipe row version')
          !== normalized.expectedRecipeRowVersion
      )
    ) {
      fail(
        'PRODUCT_PACK_RECIPE_VERSION_CONFLICT',
        'Pack recipe changed; reload before saving',
        409,
      )
    }
    if (
      !current
      && normalized.expectedRecipeRowVersion !== null
    ) {
      fail(
        'PRODUCT_PACK_RECIPE_EXPECTATION_CONFLICT',
        'Expected pack recipe was not found',
        409,
      )
    }
    if (current) {
      const retired = await client.query(
        `UPDATE operations_approved_pack_recipes
         SET lifecycle_state = 'retired',
             is_current = false,
             effective_to = GREATEST(
               clock_timestamp(),
               effective_from + interval '1 microsecond'
             ),
             row_version = row_version + 1,
             updated_by = $4,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND row_version = $3::bigint
           AND is_current = true`,
        [
          input.organizationId,
          current.id,
          normalized.expectedRecipeRowVersion,
          input.actorEmail,
        ],
      )
      if (retired.rowCount !== 1) {
        fail(
          'PRODUCT_PACK_RECIPE_VERSION_CONFLICT',
          'Pack recipe changed; reload before saving',
          409,
        )
      }
    }
    const versionNumber = current
      ? Number(current.version_number) + 1
      : 1
    const confirmed = normalized.fitEvidenceType !== 'unknown'
    const inserted = await client.query<RecipeRow>(
      `INSERT INTO operations_approved_pack_recipes (
         organization_id,
         pipeline_id,
         product_id,
         recipe_key,
         recipe_name,
         version_number,
         input_pack_profile_version_id,
         output_pack_profile_version_id,
         packaging_material_id,
         input_quantity,
         output_quantity,
         packaging_material_quantity,
         recipe_type,
         fulfillment_policy,
         remainder_policy,
         inventory_evidence_requirement,
         assembly_policy,
         exclusive_contents,
         minimum_input_quantity,
         content_compatibility_key,
         allows_mixed_products,
         lifecycle_state,
         fit_evidence_type,
         fit_evidence_reference,
         confirmed_at,
         confirmed_by,
         source,
         is_current,
         created_by,
         updated_by
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4,
         $5,
         $6,
         $7::uuid,
         $8::uuid,
         $9::uuid,
         $10,
         $11,
         $12,
         $13,
         $14,
         $15,
         $16,
         $17,
         $18,
         $19,
         $20,
         $21,
         $22,
         $23,
         $24,
         CASE WHEN $25::boolean THEN now() ELSE NULL END,
         CASE WHEN $25::boolean THEN $26 ELSE NULL END,
         $27,
         true,
         $26,
         $26
       )
       RETURNING
         id::text,
         global_id,
         recipe_key,
         recipe_name,
         version_number,
         input_pack_profile_version_id::text,
         output_pack_profile_version_id::text,
         packaging_material_id::text,
         input_quantity,
         output_quantity,
         packaging_material_quantity,
         recipe_type,
         minimum_input_quantity,
         content_compatibility_key,
         allows_mixed_products,
         fulfillment_policy,
         remainder_policy,
         inventory_evidence_requirement,
         assembly_policy,
         exclusive_contents,
         lifecycle_state,
         fit_evidence_type,
         fit_evidence_reference,
         confirmed_at,
         source,
         is_current,
         row_version::text,
         updated_at`,
      [
        input.organizationId,
        product.pipeline_id,
        product.id,
        normalized.recipeKey,
        normalized.recipeName,
        versionNumber,
        inputVersion.id,
        outputVersion.id,
        material.id,
        normalized.inputQuantity,
        normalized.outputQuantity,
        normalized.packagingMaterialQuantity,
        normalized.recipeType,
        normalized.fulfillmentPolicy,
        normalized.remainderPolicy,
        normalized.inventoryEvidenceRequirement,
        normalized.assemblyPolicy,
        normalized.exclusiveContents,
        normalized.minimumInputQuantity,
        normalized.contentCompatibilityKey,
        normalized.allowsMixedProducts,
        normalized.lifecycleState,
        normalized.fitEvidenceType,
        normalized.fitEvidenceReference,
        confirmed,
        input.actorEmail,
        normalized.source,
      ],
    )
    const recipe = inserted.rows[0]
    const result = {
      globalId: recipe.global_id,
      recipeGlobalId: recipe.global_id,
      recipeVersionNumber: Number(recipe.version_number),
      recipeRowVersion: integer(
        recipe.row_version,
        'Recipe row version',
      ),
      lifecycleState: recipe.lifecycle_state,
      productGlobalId: product.reference_code,
      inputProfileVersionGlobalId: inputVersion.global_id,
      outputProfileVersionGlobalId: outputVersion.global_id,
      packagingMaterialGlobalId: material.global_id,
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.product_pack.approved_recipe_saved',
      aggregateType: 'operations.approved_pack_recipe',
      aggregateId: recipe.global_id,
      subject: product.name,
      organizationId: input.organizationId,
      eventKey:
        `operations:approved-pack-recipe:${recipe.global_id}`
        + `:version:${recipe.version_number}`,
      payload: {
        ...result,
        recipeKey: recipe.recipe_key,
        recipeType: recipe.recipe_type,
        inputQuantity: recipe.input_quantity,
        outputQuantity: recipe.output_quantity,
        minimumInputQuantity: recipe.minimum_input_quantity,
        allowsMixedProducts: recipe.allows_mixed_products,
        fitEvidenceType: recipe.fit_evidence_type,
      },
    }, client)
    return result
  })
}

export async function readProductPackManagementStateInPostgres(input: {
  organizationId: string
  productGlobalId: string
}) {
  const products = await query<ProductRow>(
    `SELECT
       product.id::text,
       product.pipeline_id::text,
       product.reference_code,
       product.name
     FROM crm_products product
     JOIN pipeline_spaces pipeline
       ON pipeline.id = product.pipeline_id
      AND pipeline.workspace_organization_id = $1::uuid
     WHERE product.reference_code = $2
     LIMIT 1`,
    [input.organizationId, input.productGlobalId],
  )
  const product = products.rows[0]
  if (!product) {
    fail(
      'PRODUCT_PACK_PRODUCT_NOT_FOUND',
      'Product was not found in the active organization',
      404,
    )
  }
  const [
    profiles,
    versions,
    channelStates,
    mappings,
    materials,
    recipes,
  ] = await Promise.all([
    query<ProfileRow>(
      `SELECT
         id::text,
         global_id,
         profile_key,
         profile_name,
         package_level,
         is_default,
         status,
         row_version::text,
         updated_at
       FROM operations_product_pack_profiles
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND product_id = $3::uuid
       ORDER BY package_level, profile_key, id`,
      [input.organizationId, product.pipeline_id, product.id],
    ),
    query<VersionRow>(
      `SELECT
         version.id::text,
         version.global_id,
         version.profile_id::text,
         version.version_number,
         version.lifecycle_state,
         version.base_each_quantity,
         version.unit_of_measure,
         version.length_mm,
         version.width_mm,
         version.height_mm,
         version.dimension_basis,
         version.gross_weight_grams,
         version.weight_basis,
         version.fit_model,
         version.ships_as_own_package,
         version.assembly_policy,
         version.evidence_type,
         version.evidence_reference,
         version.confirmed_at,
         version.source,
         version.provider_weight_channel_state_id::text,
         version.provider_weight_channel_state_row_version::text,
         version.provider_weight_source_revision,
         version.provider_weight_source_hash,
         version.is_current,
         version.row_version::text,
         version.created_at,
         profile.global_id AS profile_global_id,
         provider_state.global_id
           AS provider_weight_channel_state_global_id
       FROM operations_product_pack_profile_versions version
       JOIN operations_product_pack_profiles profile
        ON profile.organization_id = version.organization_id
        AND profile.id = version.profile_id
       LEFT JOIN operations_product_channel_states provider_state
         ON provider_state.organization_id = version.organization_id
        AND provider_state.id = version.provider_weight_channel_state_id
       WHERE version.organization_id = $1::uuid
         AND version.pipeline_id = $2::uuid
         AND version.product_id = $3::uuid
       ORDER BY profile.profile_key, version.version_number DESC`,
      [input.organizationId, product.pipeline_id, product.id],
    ),
    query<ChannelStateRow>(
      `SELECT
         state.id::text,
         state.global_id,
         state.integration_account_id::text,
         state.pipeline_id::text,
         state.provider,
         state.external_product_id,
         state.external_variant_id,
         state.product_id::text,
         state.normalized_status,
         state.provider_active,
         state.provider_updated_at,
         state.observed_at,
         state.source_revision,
         state.source_hash,
         state.pack_evidence_hash,
         state.requires_shipping,
         state.weight_grams,
         state.row_version::text,
         account.global_id AS account_global_id,
         account.provider AS account_provider,
         account.integration_type AS account_type,
         account.environment AS account_environment,
         account.status AS account_status,
         credential.verification_status
           AS credential_verification_status
       FROM operations_product_channel_states state
       JOIN operations_integration_accounts account
         ON account.organization_id = state.organization_id
        AND account.id = state.integration_account_id
       LEFT JOIN operations_commerce_credentials credential
         ON credential.organization_id = state.organization_id
        AND credential.integration_account_id = state.integration_account_id
       WHERE state.organization_id = $1::uuid
         AND state.pipeline_id = $2::uuid
         AND state.product_id = $3::uuid
       ORDER BY
         state.provider,
         state.observed_at DESC,
         state.global_id`,
      [input.organizationId, product.pipeline_id, product.id],
    ),
    query<MappingRow>(
      `SELECT
         mapping.id::text,
         mapping.global_id,
         mapping.integration_account_id::text,
         mapping.provider,
         mapping.external_product_id,
         mapping.external_variant_id,
         mapping.default_pack_profile_version_id::text,
         mapping.provider_lifecycle_state,
         mapping.projection_state,
         mapping.mapping_purpose,
         mapping.source_revision,
         mapping.source_hash,
         mapping.pack_evidence_hash,
         mapping.is_current,
         mapping.row_version::text,
         mapping.updated_at,
         account.global_id AS account_global_id,
         state.global_id AS channel_state_global_id,
         state.row_version::text AS channel_state_row_version,
         version.global_id AS profile_version_global_id
       FROM operations_commerce_variant_pack_mappings mapping
       JOIN operations_integration_accounts account
         ON account.organization_id = mapping.organization_id
        AND account.id = mapping.integration_account_id
       JOIN operations_product_channel_states state
         ON state.organization_id = mapping.organization_id
        AND state.integration_account_id = mapping.integration_account_id
        AND state.external_product_id = mapping.external_product_id
        AND state.external_variant_id = mapping.external_variant_id
       JOIN operations_product_pack_profile_versions version
         ON version.organization_id = mapping.organization_id
        AND version.id = mapping.default_pack_profile_version_id
       WHERE mapping.organization_id = $1::uuid
         AND mapping.pipeline_id = $2::uuid
         AND mapping.product_id = $3::uuid
       ORDER BY
         mapping.is_current DESC,
         mapping.updated_at DESC,
         mapping.global_id`,
      [input.organizationId, product.pipeline_id, product.id],
    ),
    query<MaterialRow>(
      `SELECT
         material.id::text,
         material.global_id,
         material.name,
         material.status,
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
         material.unit_cost_minor,
         material.currency,
         material.row_version::text
       FROM operations_packaging_materials material
       WHERE material.organization_id = $1::uuid
       ORDER BY
         material.status DESC,
         material.name,
         material.global_id`,
      [input.organizationId],
    ),
    query<RecipeRow>(
      `SELECT
         recipe.id::text,
         recipe.global_id,
         recipe.recipe_key,
         recipe.recipe_name,
         recipe.version_number,
         recipe.input_pack_profile_version_id::text,
         recipe.output_pack_profile_version_id::text,
         recipe.packaging_material_id::text,
         recipe.input_quantity,
         recipe.output_quantity,
         recipe.packaging_material_quantity,
         recipe.recipe_type,
         recipe.minimum_input_quantity,
         recipe.content_compatibility_key,
         recipe.allows_mixed_products,
         recipe.fulfillment_policy,
         recipe.remainder_policy,
         recipe.inventory_evidence_requirement,
         recipe.assembly_policy,
         recipe.exclusive_contents,
         recipe.lifecycle_state,
         recipe.fit_evidence_type,
         recipe.fit_evidence_reference,
         recipe.confirmed_at,
         recipe.source,
         recipe.is_current,
         recipe.row_version::text,
         recipe.updated_at,
         input_version.global_id AS input_profile_version_global_id,
         output_version.global_id AS output_profile_version_global_id,
         material.global_id AS packaging_material_global_id
       FROM operations_approved_pack_recipes recipe
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
         AND recipe.pipeline_id = $2::uuid
         AND recipe.product_id = $3::uuid
       ORDER BY
         recipe.recipe_key,
         recipe.version_number DESC`,
      [input.organizationId, product.pipeline_id, product.id],
    ),
  ])
  const versionsByProfile = new Map<string, VersionRow[]>()
  for (const version of versions.rows) {
    const grouped = versionsByProfile.get(version.profile_id) || []
    grouped.push(version)
    versionsByProfile.set(version.profile_id, grouped)
  }
  return {
    product: {
      globalId: product.reference_code,
      name: product.name,
    },
    profiles: profiles.rows.map((profile) => ({
      globalId: profile.global_id,
      profileKey: profile.profile_key,
      profileName: profile.profile_name,
      packageLevel: profile.package_level,
      isDefault: profile.is_default,
      status: profile.status,
      rowVersion: integer(profile.row_version, 'Profile row version'),
      updatedAt: iso(profile.updated_at),
      versions: (versionsByProfile.get(profile.id) || []).map(
        (version) => ({
          globalId: version.global_id,
          versionNumber: Number(version.version_number),
          lifecycleState: version.lifecycle_state,
          baseEachQuantity: Number(version.base_each_quantity),
          unitOfMeasure: version.unit_of_measure,
          dimensionsMm: version.length_mm === null
            ? null
            : {
                length: Number(version.length_mm),
                width: Number(version.width_mm),
                height: Number(version.height_mm),
              },
          dimensionBasis: version.dimension_basis,
          grossWeightGrams: version.gross_weight_grams,
          weightBasis: version.weight_basis,
          fitModel: version.fit_model,
          shipsAsOwnPackage: version.ships_as_own_package,
          assemblyPolicy: version.assembly_policy,
          evidenceType: version.evidence_type,
          evidenceReference: version.evidence_reference,
          confirmedAt: iso(version.confirmed_at),
          source: version.source,
          providerWeightEvidence:
            version.provider_weight_channel_state_id
              ? {
                  channelStateGlobalId:
                    version.provider_weight_channel_state_global_id,
                  channelStateRowVersion: integer(
                    version.provider_weight_channel_state_row_version,
                    'Provider channel-state row version',
                  ),
                  sourceRevision:
                    version.provider_weight_source_revision,
                  sourceHash: version.provider_weight_source_hash,
                }
              : null,
          isCurrent: version.is_current,
          rowVersion: integer(
            version.row_version,
            'Profile-version row version',
          ),
          createdAt: iso(version.created_at),
        }),
      ),
    })),
    channelStates: channelStates.rows.map((state) => ({
      globalId: state.global_id,
      accountGlobalId: state.account_global_id,
      provider: state.provider,
      environment: state.account_environment,
      accountStatus: state.account_status,
      credentialVerificationStatus:
        state.credential_verification_status,
      externalProductId: state.external_product_id,
      externalVariantId: state.external_variant_id,
      normalizedStatus: state.normalized_status,
      providerActive: state.provider_active,
      providerUpdatedAt: iso(state.provider_updated_at),
      observedAt: iso(state.observed_at),
      sourceRevision: state.source_revision,
      sourceHash: state.source_hash,
      requiresShipping: state.requires_shipping,
      weightGrams: state.weight_grams,
      rowVersion: integer(
        state.row_version,
        'Channel-state row version',
      ),
    })),
    mappings: mappings.rows.map((mapping) => ({
      globalId: mapping.global_id,
      accountGlobalId: mapping.account_global_id,
      provider: mapping.provider,
      channelStateGlobalId: mapping.channel_state_global_id,
      channelStateRowVersion: integer(
        mapping.channel_state_row_version,
        'Channel-state row version',
      ),
      externalProductId: mapping.external_product_id,
      externalVariantId: mapping.external_variant_id,
      profileVersionGlobalId: mapping.profile_version_global_id,
      providerLifecycleState: mapping.provider_lifecycle_state,
      projectionState: mapping.projection_state,
      purpose: mapping.mapping_purpose,
      sourceRevision: mapping.source_revision,
      sourceHash: mapping.source_hash,
      isCurrent: mapping.is_current,
      rowVersion: integer(mapping.row_version, 'Mapping row version'),
      updatedAt: iso(mapping.updated_at),
    })),
    packagingMaterials: materials.rows.map((material) => ({
      globalId: material.global_id,
      name: material.name,
      status: material.status,
      innerDimensionsMm: material.inner_length_mm === null
        ? null
        : {
            length: Number(material.inner_length_mm),
            width: Number(material.inner_width_mm),
            height: Number(material.inner_height_mm),
          },
      ratedOuterDimensionsMm:
        material.rated_outer_length_mm === null
          ? null
          : {
              length: Number(material.rated_outer_length_mm),
              width: Number(material.rated_outer_width_mm),
              height: Number(material.rated_outer_height_mm),
            },
      ratedOuterDimensionEvidenceType:
        material.rated_outer_dimension_evidence_type,
      ratedOuterDimensionEvidenceReference:
        material.rated_outer_dimension_evidence_reference,
      ratedOuterDimensionConfirmedAt:
        iso(material.rated_outer_dimension_confirmed_at),
      dimensionBasis: material.dimension_basis,
      dimensionEvidenceType: material.dimension_evidence_type,
      dimensionEvidenceReference:
        material.dimension_evidence_reference,
      dimensionConfirmedAt: iso(material.dimension_confirmed_at),
      tareWeightGrams: material.tare_weight_grams,
      maxWeightGrams: material.max_weight_grams,
      unitCostMinor: material.unit_cost_minor === null
        ? null
        : integer(material.unit_cost_minor, 'Packaging material unit cost'),
      currency: material.currency,
      rowVersion: integer(
        material.row_version,
        'Packaging material row version',
      ),
    })),
    recipes: recipes.rows.map((recipe) => ({
      globalId: recipe.global_id,
      recipeKey: recipe.recipe_key,
      recipeName: recipe.recipe_name,
      versionNumber: Number(recipe.version_number),
      inputProfileVersionGlobalId:
        recipe.input_profile_version_global_id,
      outputProfileVersionGlobalId:
        recipe.output_profile_version_global_id,
      packagingMaterialGlobalId:
        recipe.packaging_material_global_id,
      inputQuantity: Number(recipe.input_quantity),
      outputQuantity: Number(recipe.output_quantity),
      packagingMaterialQuantity:
        Number(recipe.packaging_material_quantity),
      recipeType: recipe.recipe_type,
      minimumInputQuantity: recipe.minimum_input_quantity,
      contentCompatibilityKey: recipe.content_compatibility_key,
      allowsMixedProducts: recipe.allows_mixed_products,
      fulfillmentPolicy: recipe.fulfillment_policy,
      remainderPolicy: recipe.remainder_policy,
      inventoryEvidenceRequirement:
        recipe.inventory_evidence_requirement,
      assemblyPolicy: recipe.assembly_policy,
      exclusiveContents: recipe.exclusive_contents,
      lifecycleState: recipe.lifecycle_state,
      fitEvidenceType: recipe.fit_evidence_type,
      fitEvidenceReference: recipe.fit_evidence_reference,
      confirmedAt: iso(recipe.confirmed_at),
      source: recipe.source,
      isCurrent: recipe.is_current,
      rowVersion: integer(recipe.row_version, 'Recipe row version'),
      updatedAt: iso(recipe.updated_at),
    })),
  }
}
