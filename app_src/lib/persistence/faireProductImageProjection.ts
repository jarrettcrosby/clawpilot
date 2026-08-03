import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import {
  assertRedactedCommerceExternalEffectEvidence,
  commerceExternalEffectHash,
} from '@/lib/persistence/commerceExternalEffects'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const ACTION = 'faire.product.image.publish' as const
const CONFIRMATION_VERSION =
  'faire-product-image-shadow-provider-write-v1' as const
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const CHANNEL_GLOBAL_ID = /^gpcs(?:[0-9]{7}|[0-9a-v]{12})$/
const EFFECT_GLOBAL_ID = /^gcef(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_REFERENCE = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const ACTIVE_TTL_SECONDS = 5 * 60
const SHADOW_TTL_SECONDS = 60

type TimestampValue = string | Date

type SelectionRow = QueryResultRow & {
  organization_id: string
  integration_account_id: string
  account_global_id: string
  account_status: string
  external_account_id: string
  credential_generation: number
  credential_version: number
  verification_status: string
  activation_state: string
  activation_revision: number
  pipeline_id: string
  product_id: string
  product_reference_code: string
  product_source_hash: string
  channel_state_id: string
  channel_state_global_id: string
  channel_state_row_version: string | number
  channel_source_revision: string
  channel_source_hash: string
  external_product_id: string
  external_variant_id: string
  provider_status_raw: string
  normalized_status: string
  provider_active: boolean
  image_asset_id: string
  asset_revision: string | number
  asset_row_version: string | number
  asset_content_sha256: string
  asset_mime_type: string
  asset_byte_length: number
  asset_pixel_width: number
  asset_pixel_height: number
  asset_alt_text: string
  next_aggregate_revision: string | number
}

type GrantRow = QueryResultRow & {
  id: string
  organization_id: string
  integration_account_id: string
  pipeline_id: string
  product_id: string
  channel_state_id: string
  image_asset_id: string
  idempotency_key: string
  desired_mode: 'shadow' | 'active'
  account_global_id: string
  external_account_id: string
  external_product_id: string
  external_variant_id: string
  product_reference_code: string
  product_source_hash: string
  channel_state_global_id: string
  channel_state_row_version: string | number
  channel_source_revision: string
  channel_source_hash: string
  asset_revision: string | number
  asset_row_version: string | number
  asset_content_sha256: string
  asset_mime_type: string
  asset_byte_length: number
  asset_pixel_width: number
  asset_pixel_height: number
  asset_alt_text: string
  credential_generation: number
  activation_revision: number
  aggregate_revision: string | number
  aggregate_hash: string
  issued_at: TimestampValue
  expires_at: TimestampValue
  effect_id: string
  effect_global_id: string
  effect_state: string
  effect_redacted_result: unknown
  lease_expired: boolean
  provider_write_count: number
  authorization_global_id: string | null
  authorization_fence_hash: string | null
  shadow_simulation_effect_global_id: string | null
}

type AssetRow = QueryResultRow & {
  content_bytes: Buffer
  mime_type: string
  content_sha256: string
  byte_length: number
}

type ReconciliationRow = QueryResultRow & {
  delivery_grant_id: string
  product_id: string
  account_global_id: string
  credential_generation: number
  external_product_id: string
  external_effect_id: string
  external_effect_global_id: string
  effect_state: string
  lease_expired: boolean
  provider_write_count: number
  uploaded_locator_sha256: string | null
  latest_outcome: string | null
  latest_observed_at: TimestampValue | null
}

export type FaireProductImageProjectionMode = 'shadow' | 'active'

export type FaireProductImageProjectionGrant = {
  id: string
  organizationId: string
  integrationAccountId: string
  pipelineId: string
  productId: string
  channelStateId: string
  imageAssetId: string
  idempotencyKey: string
  mode: FaireProductImageProjectionMode
  accountGlobalId: string
  externalAccountId: string
  externalProductId: string
  externalVariantId: string
  productReferenceCode: string
  productSourceHash: string
  channelStateGlobalId: string
  channelStateRowVersion: number
  channelSourceRevision: string
  channelSourceHash: string
  assetRevision: number
  assetRowVersion: number
  assetContentSha256: string
  assetMimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  assetByteLength: number
  assetPixelWidth: number
  assetPixelHeight: number
  assetAltText: string
  credentialGeneration: number
  activationRevision: number
  aggregateRevision: number
  aggregateHash: string
  issuedAt: string
  expiresAt: string
  effectId: string
  effectGlobalId: string
  effectState: string
  effectResult: Record<string, unknown> | null
  leaseExpired: boolean
  providerWriteCount: number
  replayed: boolean
  authorization: null | {
    globalId: string
    fenceHash: string
    shadowSimulationEffectGlobalId: string
  }
}

export type FaireProductImageReconciliationContext = {
  deliveryGrantId: string
  productId: string
  accountGlobalId: string
  credentialGeneration: number
  externalProductId: string
  externalEffectId: string
  externalEffectGlobalId: string
  effectState: string
  leaseExpired: boolean
  providerWriteCount: number
  uploadedLocatorSha256: string | null
  latestOutcome: string | null
  latestObservedAt: string | null
}

export class FaireProductImageProjectionPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'FaireProductImageProjectionPersistenceError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new FaireProductImageProjectionPersistenceError(code, message, status)
}

function integer(value: unknown, label: string, minimum = 0) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum) {
    fail('FAIRE_PRODUCT_IMAGE_EVIDENCE_INVALID', `${label} is invalid`, 500)
  }
  return number
}

function iso(value: TimestampValue) {
  return new Date(value).toISOString()
}

function grant(
  row: GrantRow,
  replayed = false,
): FaireProductImageProjectionGrant {
  if (
    !UUID.test(row.id)
    || !UUID.test(row.effect_id)
    || !EFFECT_GLOBAL_ID.test(row.effect_global_id)
    || !ACCOUNT_GLOBAL_ID.test(row.account_global_id)
    || !CHANNEL_GLOBAL_ID.test(row.channel_state_global_id)
    || !PRODUCT_REFERENCE.test(row.product_reference_code)
    || !HASH.test(row.aggregate_hash)
    || !HASH.test(row.asset_content_sha256)
    || (
      row.desired_mode === 'active'
      && (
        !row.authorization_global_id
        || !row.authorization_fence_hash
        || !row.shadow_simulation_effect_global_id
      )
    )
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_EVIDENCE_INVALID',
      'Durable Faire Product-image evidence is incomplete',
      500,
    )
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    pipelineId: row.pipeline_id,
    productId: row.product_id,
    channelStateId: row.channel_state_id,
    imageAssetId: row.image_asset_id,
    idempotencyKey: row.idempotency_key,
    mode: row.desired_mode,
    accountGlobalId: row.account_global_id,
    externalAccountId: row.external_account_id,
    externalProductId: row.external_product_id,
    externalVariantId: row.external_variant_id,
    productReferenceCode: row.product_reference_code,
    productSourceHash: row.product_source_hash,
    channelStateGlobalId: row.channel_state_global_id,
    channelStateRowVersion: integer(row.channel_state_row_version, 'Channel revision'),
    channelSourceRevision: row.channel_source_revision,
    channelSourceHash: row.channel_source_hash,
    assetRevision: integer(row.asset_revision, 'Asset revision', 1),
    assetRowVersion: integer(row.asset_row_version, 'Asset row revision', 1),
    assetContentSha256: row.asset_content_sha256,
    assetMimeType: row.asset_mime_type as FaireProductImageProjectionGrant['assetMimeType'],
    assetByteLength: row.asset_byte_length,
    assetPixelWidth: row.asset_pixel_width,
    assetPixelHeight: row.asset_pixel_height,
    assetAltText: row.asset_alt_text,
    credentialGeneration: row.credential_generation,
    activationRevision: row.activation_revision,
    aggregateRevision: integer(row.aggregate_revision, 'Aggregate revision', 1),
    aggregateHash: row.aggregate_hash,
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    effectId: row.effect_id,
    effectGlobalId: row.effect_global_id,
    effectState: row.effect_state,
    effectResult: row.effect_redacted_result
      && typeof row.effect_redacted_result === 'object'
      && !Array.isArray(row.effect_redacted_result)
      ? row.effect_redacted_result as Record<string, unknown>
      : null,
    leaseExpired: row.lease_expired === true,
    providerWriteCount: row.provider_write_count,
    replayed,
    authorization: row.desired_mode === 'active' ? {
      globalId: row.authorization_global_id!,
      fenceHash: row.authorization_fence_hash!,
      shadowSimulationEffectGlobalId:
        row.shadow_simulation_effect_global_id!,
    } : null,
  }
}

const GRANT_SELECT = `SELECT
  image_grant.id::text,
  image_grant.organization_id::text,
  image_grant.integration_account_id::text,
  image_grant.pipeline_id::text,
  image_grant.product_id::text,
  image_grant.channel_state_id::text,
  image_grant.image_asset_id::text,
  image_grant.idempotency_key,
  image_grant.desired_mode,
  image_grant.account_global_id,
  image_grant.external_account_id,
  image_grant.external_product_id,
  image_grant.external_variant_id,
  image_grant.product_reference_code,
  image_grant.product_source_hash,
  image_grant.channel_state_global_id,
  image_grant.channel_state_row_version::text,
  image_grant.channel_source_revision,
  image_grant.channel_source_hash,
  image_grant.asset_revision::text,
  image_grant.asset_row_version::text,
  image_grant.asset_content_sha256,
  image_grant.asset_mime_type,
  image_grant.asset_byte_length,
  image_grant.asset_pixel_width,
  image_grant.asset_pixel_height,
  image_grant.asset_alt_text,
  image_grant.credential_generation,
  image_grant.activation_revision,
  image_grant.aggregate_revision::text,
  image_grant.aggregate_hash,
  image_grant.issued_at,
  image_grant.expires_at,
  effect.id::text AS effect_id,
  effect.global_id AS effect_global_id,
  effect.state AS effect_state,
  effect.redacted_result AS effect_redacted_result,
  (
    effect.state = 'claimed'
    AND effect.lease_expires_at <= clock_timestamp()
  ) AS lease_expired,
  effect.provider_write_count,
  auth.global_id AS authorization_global_id,
  auth.authorization_fence_hash,
  simulation.global_id AS shadow_simulation_effect_global_id`

async function readExistingGrant(
  client: PoolClient,
  input: { organizationId: string; idempotencyKey: string },
) {
  const result = await client.query<GrantRow>(
    `${GRANT_SELECT}
     FROM operations_faire_product_image_delivery_grants image_grant
     JOIN operations_commerce_external_effect_intents effect
       ON effect.organization_id = image_grant.organization_id
      AND effect.integration_account_id = image_grant.integration_account_id
      AND effect.action = '${ACTION}'
      AND effect.idempotency_key = image_grant.idempotency_key
     LEFT JOIN operations_faire_provider_write_authorizations auth
       ON auth.organization_id = effect.organization_id
      AND auth.id = effect.faire_provider_write_authorization_id
     LEFT JOIN operations_commerce_external_effect_intents simulation
       ON simulation.organization_id = auth.organization_id
      AND simulation.id = auth.shadow_simulation_effect_id
     WHERE image_grant.organization_id = $1::uuid
       AND image_grant.idempotency_key = $2
     LIMIT 1`,
    [input.organizationId, input.idempotencyKey],
  )
  return result.rows[0] ? grant(result.rows[0], true) : null
}

export async function resolveFaireProductImageSelectionInPostgres(input: {
  organizationId: string
  productId: string
  channelStateGlobalId: string
  imageAssetId: string
}) {
  const result = await query<SelectionRow & { conflicting_product_count: string | number }>(
    `SELECT
       account.organization_id::text,
       account.id::text AS integration_account_id,
       account.global_id AS account_global_id,
       account.status AS account_status,
       account.external_account_id,
       account.commerce_credential_generation AS credential_generation,
       credential.credential_version,
       credential.verification_status,
       activation.state AS activation_state,
       activation.revision AS activation_revision,
       product.pipeline_id::text,
       product.id::text AS product_id,
       product.reference_code AS product_reference_code,
       product.source_hash AS product_source_hash,
       channel_state.id::text AS channel_state_id,
       channel_state.global_id AS channel_state_global_id,
       channel_state.row_version::text AS channel_state_row_version,
       channel_state.source_revision AS channel_source_revision,
       channel_state.source_hash AS channel_source_hash,
       channel_state.external_product_id,
       channel_state.external_variant_id,
       channel_state.provider_status_raw,
       channel_state.normalized_status,
       channel_state.provider_active,
       image_asset.id::text AS image_asset_id,
       image_asset.asset_revision::text,
       image_asset.row_version::text AS asset_row_version,
       image_asset.content_sha256 AS asset_content_sha256,
       image_asset.mime_type AS asset_mime_type,
       image_asset.byte_length AS asset_byte_length,
       image_asset.pixel_width AS asset_pixel_width,
       image_asset.pixel_height AS asset_pixel_height,
       image_asset.alt_text AS asset_alt_text,
       1::text AS next_aggregate_revision,
       (
         SELECT count(DISTINCT sibling.product_id)
         FROM operations_product_channel_states sibling
         WHERE sibling.organization_id = account.organization_id
           AND sibling.integration_account_id = account.id
           AND sibling.provider = 'faire'
           AND sibling.external_product_id = channel_state.external_product_id
           AND sibling.product_id IS NOT NULL
           AND sibling.product_id <> product.id
       ) AS conflicting_product_count
     FROM operations_product_channel_states channel_state
     JOIN operations_integration_accounts account
       ON account.organization_id = channel_state.organization_id
      AND account.id = channel_state.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     JOIN crm_products product
       ON product.pipeline_id = channel_state.pipeline_id
      AND product.id = channel_state.product_id
     JOIN operations_product_mappings mapping
       ON mapping.organization_id = channel_state.organization_id
      AND mapping.integration_account_id = channel_state.integration_account_id
      AND mapping.pipeline_id = channel_state.pipeline_id
      AND mapping.id = channel_state.product_mapping_id
      AND mapping.product_id = channel_state.product_id
      AND mapping.external_product_id = channel_state.external_product_id
      AND mapping.external_variant_id = channel_state.external_variant_id
      AND mapping.active = true
     JOIN crm_product_image_assets image_asset
       ON image_asset.organization_id = account.organization_id
      AND image_asset.pipeline_id = product.pipeline_id
      AND image_asset.product_id = product.id
      AND image_asset.id = $4::uuid
      AND image_asset.is_primary = true
     WHERE account.organization_id = $1::uuid
       AND product.id = $2::uuid
       AND channel_state.global_id = $3
       AND channel_state.provider = 'faire'
     LIMIT 1`,
    [
      input.organizationId,
      input.productId,
      input.channelStateGlobalId,
      input.imageAssetId,
    ],
  )
  const row = result.rows[0]
  if (!row || integer(row.conflicting_product_count, 'Parent mapping count') !== 0) {
    fail(
      row
        ? 'FAIRE_PRODUCT_IMAGE_PARENT_PRODUCT_AMBIGUOUS'
        : 'FAIRE_PRODUCT_IMAGE_SELECTION_NOT_FOUND',
      row
        ? 'This Faire Product is mapped to more than one ClawPilot Product'
        : 'The exact mapped Faire Product and primary image were not found',
      row ? 409 : 404,
    )
  }
  return {
    accountGlobalId: row.account_global_id,
    externalAccountId: row.external_account_id,
    externalProductId: row.external_product_id,
    externalVariantId: row.external_variant_id,
    productReferenceCode: row.product_reference_code,
    channelStateRowVersion: integer(row.channel_state_row_version, 'Channel revision'),
    channelSourceRevision: row.channel_source_revision,
    channelSourceHash: row.channel_source_hash,
    assetRevision: integer(row.asset_revision, 'Asset revision', 1),
    assetRowVersion: integer(row.asset_row_version, 'Asset row revision', 1),
    assetContentSha256: row.asset_content_sha256,
  }
}

function assertExpectedSelection(
  row: SelectionRow,
  input: PrepareFaireProductImageProjectionInput,
) {
  if (
    row.account_global_id !== input.expectedAccountGlobalId
    || row.external_product_id !== input.expectedExternalProductId
    || row.external_variant_id !== input.expectedExternalVariantId
    || row.product_reference_code !== input.expectedProductReferenceCode
    || integer(row.channel_state_row_version, 'Channel revision')
      !== input.expectedChannelStateRowVersion
    || row.channel_source_revision !== input.expectedChannelSourceRevision
    || row.channel_source_hash !== input.expectedChannelSourceHash
    || integer(row.asset_revision, 'Asset revision', 1)
      !== input.expectedAssetRevision
    || integer(row.asset_row_version, 'Asset row revision', 1)
      !== input.expectedAssetRowVersion
    || row.asset_content_sha256 !== input.expectedAssetContentSha256
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_SELECTION_STALE',
      'The selected Product, Faire listing, or primary image changed after review',
    )
  }
  const providerLifecycle = row.provider_status_raw.trim().toUpperCase()
  const writableListing = (
    ['DRAFT', 'PUBLISHED', 'ACTIVE'].includes(providerLifecycle)
    && (
      (row.normalized_status === 'active' && row.provider_active === true)
      || (
        row.normalized_status === 'unavailable'
        && row.provider_active === false
      )
    )
  )
  if (
    row.account_status !== 'active'
    || row.credential_generation !== row.credential_version
    || row.verification_status !== 'verified'
    || row.activation_state !== 'shadow'
    || !writableListing
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_CONNECTION_NOT_READY',
      'The Faire connection, listing, credential, or Operations Shadow fence is not ready',
    )
  }
}

export type PrepareFaireProductImageProjectionInput = {
  organizationId: string
  productId: string
  channelStateGlobalId: string
  imageAssetId: string
  idempotencyKey: string
  mode: FaireProductImageProjectionMode
  expectedAccountGlobalId: string
  expectedExternalProductId: string
  expectedExternalVariantId: string
  expectedProductReferenceCode: string
  expectedChannelStateRowVersion: number
  expectedChannelSourceRevision: string
  expectedChannelSourceHash: string
  expectedAssetRevision: number
  expectedAssetRowVersion: number
  expectedAssetContentSha256: string
  shadowSimulationEffectGlobalId: string | null
  actorEmail: string
}

export async function prepareFaireProductImageProjectionInPostgres(
  input: PrepareFaireProductImageProjectionInput,
): Promise<FaireProductImageProjectionGrant> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `faire-product-image:${input.organizationId}:${input.expectedAccountGlobalId}:crm.product:${input.productId}`,
    )
    const existing = await readExistingGrant(client, input)
    if (existing) {
      if (
        existing.productId !== input.productId
        || existing.channelStateGlobalId !== input.channelStateGlobalId
        || existing.imageAssetId !== input.imageAssetId
        || existing.mode !== input.mode
        || existing.assetContentSha256 !== input.expectedAssetContentSha256
      ) {
        fail(
          'FAIRE_PRODUCT_IMAGE_IDEMPOTENCY_CONFLICT',
          'The Faire Product-image command identity was already used for different evidence',
        )
      }
      return existing
    }
    if (
      (input.mode === 'active'
        && !EFFECT_GLOBAL_ID.test(input.shadowSimulationEffectGlobalId || ''))
      || (input.mode === 'shadow' && input.shadowSimulationEffectGlobalId !== null)
    ) {
      fail(
        'FAIRE_PRODUCT_IMAGE_SHADOW_SIMULATION_REQUIRED',
        'Run the exact zero-write Shadow simulation before the one-use provider authorization',
      )
    }

    const selected = await client.query<SelectionRow>(
      `SELECT
         account.organization_id::text,
         account.id::text AS integration_account_id,
         account.global_id AS account_global_id,
         account.status AS account_status,
         account.external_account_id,
         account.commerce_credential_generation AS credential_generation,
         credential.credential_version,
         credential.verification_status,
         activation.state AS activation_state,
         activation.revision AS activation_revision,
         product.pipeline_id::text,
         product.id::text AS product_id,
         product.reference_code AS product_reference_code,
         product.source_hash AS product_source_hash,
         channel_state.id::text AS channel_state_id,
         channel_state.global_id AS channel_state_global_id,
         channel_state.row_version::text AS channel_state_row_version,
         channel_state.source_revision AS channel_source_revision,
         channel_state.source_hash AS channel_source_hash,
         channel_state.external_product_id,
         channel_state.external_variant_id,
         channel_state.provider_status_raw,
         channel_state.normalized_status,
         channel_state.provider_active,
         image_asset.id::text AS image_asset_id,
         image_asset.asset_revision::text,
         image_asset.row_version::text AS asset_row_version,
         image_asset.content_sha256 AS asset_content_sha256,
         image_asset.mime_type AS asset_mime_type,
         image_asset.byte_length AS asset_byte_length,
         image_asset.pixel_width AS asset_pixel_width,
         image_asset.pixel_height AS asset_pixel_height,
         image_asset.alt_text AS asset_alt_text,
         (COALESCE((
           SELECT max(prior.aggregate_revision)
           FROM operations_faire_product_image_delivery_grants prior
           WHERE prior.organization_id = account.organization_id
             AND prior.integration_account_id = account.id
             AND prior.product_id = product.id
         ), 0) + 1)::text AS next_aggregate_revision
       FROM operations_product_channel_states channel_state
       JOIN operations_integration_accounts account
         ON account.organization_id = channel_state.organization_id
        AND account.id = channel_state.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       JOIN crm_products product
         ON product.pipeline_id = channel_state.pipeline_id
        AND product.id = channel_state.product_id
       JOIN operations_product_mappings mapping
         ON mapping.organization_id = channel_state.organization_id
        AND mapping.integration_account_id = channel_state.integration_account_id
        AND mapping.pipeline_id = channel_state.pipeline_id
        AND mapping.id = channel_state.product_mapping_id
        AND mapping.product_id = channel_state.product_id
        AND mapping.external_product_id = channel_state.external_product_id
        AND mapping.external_variant_id = channel_state.external_variant_id
        AND mapping.active = true
       JOIN crm_product_image_assets image_asset
         ON image_asset.organization_id = account.organization_id
        AND image_asset.pipeline_id = product.pipeline_id
        AND image_asset.product_id = product.id
        AND image_asset.id = $4::uuid
        AND image_asset.is_primary = true
       WHERE account.organization_id = $1::uuid
         AND product.id = $2::uuid
         AND channel_state.global_id = $3
         AND channel_state.provider = 'faire'
         AND NOT EXISTS (
           SELECT 1
           FROM operations_product_channel_states sibling
           WHERE sibling.organization_id = account.organization_id
             AND sibling.integration_account_id = account.id
             AND sibling.provider = 'faire'
             AND sibling.external_product_id = channel_state.external_product_id
             AND sibling.product_id IS NOT NULL
             AND sibling.product_id <> product.id
         )
       LIMIT 1
       FOR SHARE OF account, credential, activation, product,
         channel_state, mapping, image_asset`,
      [
        input.organizationId,
        input.productId,
        input.channelStateGlobalId,
        input.imageAssetId,
      ],
    )
    const row = selected.rows[0]
    if (!row) {
      fail(
        'FAIRE_PRODUCT_IMAGE_SELECTION_NOT_FOUND',
        'The exact unambiguous Faire Product, listing, and primary image were not found',
        404,
      )
    }
    assertExpectedSelection(row, input)

    const grantId = randomUUID()
    const aggregateRevision = integer(
      row.next_aggregate_revision,
      'Aggregate revision',
      1,
    )
    const aggregateHash = commerceExternalEffectHash({
      schema: 'faire-product-image-projection-v1',
      organizationId: row.organization_id,
      accountGlobalId: row.account_global_id,
      externalAccountId: row.external_account_id,
      productId: row.product_id,
      productReferenceCode: row.product_reference_code,
      productSourceHash: row.product_source_hash,
      externalProductId: row.external_product_id,
      externalVariantId: row.external_variant_id,
      channelStateGlobalId: row.channel_state_global_id,
      channelStateRowVersion: integer(row.channel_state_row_version, 'Channel revision'),
      channelSourceRevision: row.channel_source_revision,
      channelSourceHash: row.channel_source_hash,
      imageAssetId: row.image_asset_id,
      assetRevision: integer(row.asset_revision, 'Asset revision', 1),
      assetRowVersion: integer(row.asset_row_version, 'Asset row revision', 1),
      assetContentSha256: row.asset_content_sha256,
      credentialGeneration: row.credential_generation,
      activationRevision: row.activation_revision,
      mode: input.mode,
      shadowSimulationEffectGlobalId: input.shadowSimulationEffectGlobalId,
    })
    const insertedGrant = await client.query(
      `INSERT INTO operations_faire_product_image_delivery_grants (
         id, organization_id, integration_account_id, pipeline_id,
         product_id, channel_state_id, image_asset_id, idempotency_key,
         desired_mode, account_global_id, external_account_id,
         external_product_id, external_variant_id, product_reference_code,
         product_source_hash, channel_state_global_id,
         channel_state_row_version, channel_source_revision,
         channel_source_hash, channel_normalized_status,
         channel_provider_active, asset_revision, asset_row_version,
         asset_content_sha256, asset_mime_type, asset_byte_length,
         asset_pixel_width, asset_pixel_height, asset_alt_text,
         credential_generation, activation_revision, aggregate_revision,
         aggregate_hash, issued_at, expires_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::uuid, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17::bigint, $18, $19, $20, $21, $22::bigint, $23::bigint,
         $24, $25, $26, $27, $28, $29, $30, $31, $32::bigint, $33,
         statement_timestamp(),
         statement_timestamp() + ($34::text || ' seconds')::interval, $35
       ) RETURNING id`,
      [
        grantId,
        row.organization_id,
        row.integration_account_id,
        row.pipeline_id,
        row.product_id,
        row.channel_state_id,
        row.image_asset_id,
        input.idempotencyKey,
        input.mode,
        row.account_global_id,
        row.external_account_id,
        row.external_product_id,
        row.external_variant_id,
        row.product_reference_code,
        row.product_source_hash,
        row.channel_state_global_id,
        integer(row.channel_state_row_version, 'Channel revision'),
        row.channel_source_revision,
        row.channel_source_hash,
        row.normalized_status,
        row.provider_active,
        integer(row.asset_revision, 'Asset revision', 1),
        integer(row.asset_row_version, 'Asset row revision', 1),
        row.asset_content_sha256,
        row.asset_mime_type,
        row.asset_byte_length,
        row.asset_pixel_width,
        row.asset_pixel_height,
        row.asset_alt_text,
        row.credential_generation,
        row.activation_revision,
        aggregateRevision,
        aggregateHash,
        input.mode === 'active' ? ACTIVE_TTL_SECONDS : SHADOW_TTL_SECONDS,
        input.actorEmail,
      ],
    )
    if (insertedGrant.rowCount !== 1) {
      fail('FAIRE_PRODUCT_IMAGE_GRANT_SAVE_FAILED', 'Faire Product-image evidence could not be saved', 500)
    }

    await client.query(
      `INSERT INTO operations_commerce_external_effect_aggregate_fences (
         organization_id, integration_account_id, provider,
         aggregate_type, aggregate_id, aggregate_revision, aggregate_hash
       ) VALUES ($1::uuid, $2::uuid, 'faire', 'crm.product', $3, $4::bigint, $5)
       ON CONFLICT (
         organization_id, integration_account_id, provider,
         aggregate_type, aggregate_id
       ) DO UPDATE SET
         aggregate_revision = EXCLUDED.aggregate_revision,
         aggregate_hash = EXCLUDED.aggregate_hash,
         updated_at = clock_timestamp()
       WHERE operations_commerce_external_effect_aggregate_fences.aggregate_revision
         < EXCLUDED.aggregate_revision`,
      [
        row.organization_id,
        row.integration_account_id,
        row.product_reference_code,
        aggregateRevision,
        aggregateHash,
      ],
    )

    let shadowSimulationEffectId: string | null = null
    if (input.mode === 'active') {
      const simulation = await client.query<{ id: string }>(
        `SELECT simulation.id::text
         FROM operations_commerce_external_effect_intents simulation
         JOIN operations_faire_product_image_delivery_grants shadow_grant
           ON shadow_grant.organization_id = simulation.organization_id
          AND shadow_grant.integration_account_id = simulation.integration_account_id
          AND shadow_grant.idempotency_key = simulation.idempotency_key
         WHERE simulation.organization_id = $1::uuid
           AND simulation.global_id = $2
           AND simulation.provider = 'faire'
           AND simulation.action = '${ACTION}'
           AND simulation.desired_mode = 'shadow'
           AND simulation.state = 'simulated'
           AND simulation.provider_write_count = 0
           AND shadow_grant.desired_mode = 'shadow'
           AND shadow_grant.expires_at > clock_timestamp()
           AND simulation.completed_at IS NOT NULL
           AND simulation.completed_at >= shadow_grant.issued_at
           AND simulation.completed_at <= shadow_grant.expires_at
           AND shadow_grant.product_id = $3::uuid
           AND shadow_grant.channel_state_id = $4::uuid
           AND shadow_grant.image_asset_id = $5::uuid
           AND shadow_grant.external_product_id = $6
           AND shadow_grant.external_variant_id = $7
           AND shadow_grant.product_source_hash = $8
           AND shadow_grant.channel_state_row_version = $9::bigint
           AND shadow_grant.channel_source_revision = $10
           AND shadow_grant.channel_source_hash = $11
           AND shadow_grant.asset_revision = $12::bigint
           AND shadow_grant.asset_row_version = $13::bigint
           AND shadow_grant.asset_content_sha256 = $14
           AND shadow_grant.credential_generation = $15
           AND shadow_grant.activation_revision = $16
         FOR SHARE OF simulation, shadow_grant`,
        [
          row.organization_id,
          input.shadowSimulationEffectGlobalId,
          row.product_id,
          row.channel_state_id,
          row.image_asset_id,
          row.external_product_id,
          row.external_variant_id,
          row.product_source_hash,
          integer(row.channel_state_row_version, 'Channel revision'),
          row.channel_source_revision,
          row.channel_source_hash,
          integer(row.asset_revision, 'Asset revision', 1),
          integer(row.asset_row_version, 'Asset row revision', 1),
          row.asset_content_sha256,
          row.credential_generation,
          row.activation_revision,
        ],
      )
      shadowSimulationEffectId = simulation.rows[0]?.id || null
      if (!shadowSimulationEffectId) {
        fail(
          'FAIRE_PRODUCT_IMAGE_SHADOW_SIMULATION_STALE',
          'The exact prior zero-write Shadow simulation is missing or stale',
          403,
        )
      }
    }

    const redactedRequest = {
      provider: 'faire',
      operation: 'productImagePublish',
      deliveryGrantId: grantId,
      shadowSimulationEffectId,
      patch: {
        externalProductId: row.external_product_id,
        externalVariantId: row.external_variant_id,
        assetContentSha256: row.asset_content_sha256,
        assetMimeType: row.asset_mime_type,
        assetByteLength: row.asset_byte_length,
        preserveExistingImages: true,
      },
      providerWritesPlanned: input.mode === 'active' ? 2 : 0,
    }
    const requestHash = commerceExternalEffectHash(redactedRequest)
    let authorizationId: string | null = null
    if (input.mode === 'active') {
      const confirmationHash = commerceExternalEffectHash({
        schema: CONFIRMATION_VERSION,
        organizationId: row.organization_id,
        accountGlobalId: row.account_global_id,
        externalAccountId: row.external_account_id,
        credentialGeneration: row.credential_generation,
        activationRevision: row.activation_revision,
        action: ACTION,
        aggregateId: row.product_reference_code,
        aggregateRevision,
        aggregateHash,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        deliveryGrantId: grantId,
        shadowSimulationEffectId,
        actorEmail: input.actorEmail,
      })
      const authorization = await client.query<{ id: string }>(
        `INSERT INTO operations_faire_provider_write_authorizations (
           organization_id, integration_account_id, scope_evidence_id,
           external_account_id, credential_generation, activation_revision,
           action, aggregate_type, aggregate_id, aggregate_revision,
           aggregate_hash, idempotency_key, request_hash, redacted_request,
           capabilities, verified_write_scopes, scope_verification_source,
           scope_evidence_hash, confirmation_statement_version,
           confirmation_hash, authorized_by, authorized_role, expires_at,
           product_image_delivery_grant_id, shadow_simulation_effect_id
         )
         SELECT
           account.organization_id, account.id, evidence.id,
           account.external_account_id, account.commerce_credential_generation,
           activation.revision, '${ACTION}', 'crm.product', $3, $4::bigint,
           $5, $6, $7, $8::jsonb,
           ARRAY['product_draft_update', 'product_image_upload']::text[],
           ARRAY['WRITE_PRODUCTS']::text[], evidence.verification_source,
           evidence.evidence_hash, '${CONFIRMATION_VERSION}', $9,
           membership.user_email, membership.role,
           LEAST($10::timestamptz, now() + interval '5 minutes'),
           $11::uuid, $12::uuid
         FROM operations_integration_accounts account
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
         JOIN app_user_organization_memberships membership
           ON membership.organization_id = account.organization_id
          AND membership.user_email = $13
          AND membership.status = 'active'
          AND membership.role IN ('owner', 'admin')
         JOIN LATERAL (
           SELECT candidate.*
           FROM operations_faire_provider_write_scope_evidence candidate
           WHERE candidate.organization_id = account.organization_id
             AND candidate.integration_account_id = account.id
             AND candidate.credential_generation = account.commerce_credential_generation
             AND candidate.verified_write_scopes @> ARRAY['WRITE_PRODUCTS']::text[]
             AND operations_faire_provider_write_scope_evidence_is_current(
               candidate.organization_id, candidate.id,
               candidate.integration_account_id, candidate.credential_generation
             )
           ORDER BY candidate.observed_at DESC, candidate.id DESC
           LIMIT 1
         ) evidence ON true
         WHERE account.organization_id = $1::uuid
           AND account.id = $2::uuid
           AND account.provider = 'faire'
           AND account.environment = 'production'
           AND account.status = 'active'
           AND account.commerce_credential_generation = $14
           AND credential.credential_version = $14
           AND credential.verification_status = 'verified'
           AND activation.state = 'shadow'
           AND activation.revision = $15
         RETURNING id::text`,
        [
          row.organization_id,
          row.integration_account_id,
          row.product_reference_code,
          aggregateRevision,
          aggregateHash,
          input.idempotencyKey,
          requestHash,
          JSON.stringify(redactedRequest),
          confirmationHash,
          new Date(Date.now() + ACTIVE_TTL_SECONDS * 1_000).toISOString(),
          grantId,
          shadowSimulationEffectId,
          input.actorEmail,
          row.credential_generation,
          row.activation_revision,
        ],
      )
      authorizationId = authorization.rows[0]?.id || null
      if (!authorizationId) {
        fail(
          'FAIRE_PRODUCT_IMAGE_AUTHORIZATION_UNAVAILABLE',
          'Current OAuth WRITE_PRODUCTS grant evidence and manager authority are required',
          403,
        )
      }
    }

    const simulationEvidence = {
      provider: 'faire',
      operation: 'productImagePublish',
      outcome: 'simulated',
      deliveryGrantId: grantId,
      exactProductId: row.external_product_id,
      assetContentSha256: row.asset_content_sha256,
      existingImagesPreserved: true,
      providerWrites: 0,
    }
    const effect = await client.query<{ id: string }>(
      `INSERT INTO operations_commerce_external_effect_intents (
         organization_id, integration_account_id, provider, action,
         desired_mode, credential_generation, activation_revision,
         aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
         idempotency_key, request_hash, redacted_request,
         faire_provider_write_authorization_id, state, redacted_result,
         terminal_evidence_hash, provider_write_count, completed_at,
         created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', '${ACTION}', $3, $4, $5,
         'crm.product', $6, $7::bigint, $8, $9, $10, $11::jsonb,
         $12::uuid,
         CASE WHEN $3 = 'shadow' THEN 'simulated' ELSE 'pending' END,
         CASE WHEN $3 = 'shadow' THEN $13::jsonb ELSE NULL END,
         CASE WHEN $3 = 'shadow' THEN $14 ELSE NULL END,
         0,
         CASE WHEN $3 = 'shadow' THEN clock_timestamp() ELSE NULL END,
         $15
       ) RETURNING id::text`,
      [
        row.organization_id,
        row.integration_account_id,
        input.mode,
        row.credential_generation,
        row.activation_revision,
        row.product_reference_code,
        aggregateRevision,
        aggregateHash,
        input.idempotencyKey,
        requestHash,
        JSON.stringify(redactedRequest),
        authorizationId,
        input.mode === 'shadow' ? JSON.stringify(simulationEvidence) : null,
        input.mode === 'shadow'
          ? commerceExternalEffectHash(simulationEvidence)
          : null,
        input.actorEmail,
      ],
    )
    if (effect.rowCount !== 1) {
      fail('FAIRE_PRODUCT_IMAGE_EFFECT_SAVE_FAILED', 'Faire Product-image effect could not be saved', 500)
    }
    const stored = await readExistingGrant(client, input)
    if (!stored) {
      fail('FAIRE_PRODUCT_IMAGE_EVIDENCE_INVALID', 'Faire Product-image evidence could not be reloaded', 500)
    }
    return { ...stored, replayed: false }
  })
}

export async function readFaireProductImageAssetForClaimInPostgres(input: {
  organizationId: string
  deliveryGrantId: string
  externalEffectGlobalId: string
  imageAssetId: string
  contentSha256: string
}) {
  const result = await query<AssetRow>(
    `SELECT
       image_asset.content_bytes,
       image_asset.mime_type,
       image_asset.content_sha256,
       image_asset.byte_length
     FROM operations_faire_product_image_delivery_grants image_grant
     JOIN operations_commerce_external_effect_intents effect
       ON effect.organization_id = image_grant.organization_id
      AND effect.integration_account_id = image_grant.integration_account_id
      AND effect.idempotency_key = image_grant.idempotency_key
      AND effect.provider = 'faire'
      AND effect.action = '${ACTION}'
      AND effect.state = 'claimed'
     JOIN crm_product_image_assets image_asset
       ON image_asset.organization_id = image_grant.organization_id
      AND image_asset.pipeline_id = image_grant.pipeline_id
      AND image_asset.product_id = image_grant.product_id
      AND image_asset.id = image_grant.image_asset_id
     WHERE image_grant.organization_id = $1::uuid
       AND image_grant.id = $2::uuid
       AND effect.global_id = $3
       AND image_grant.image_asset_id = $4::uuid
       AND image_grant.asset_content_sha256 = $5
       AND image_asset.content_sha256 = image_grant.asset_content_sha256
       AND image_asset.asset_revision = image_grant.asset_revision
       AND image_asset.row_version = image_grant.asset_row_version
       AND image_asset.is_primary = true
     LIMIT 1`,
    [
      input.organizationId,
      input.deliveryGrantId,
      input.externalEffectGlobalId,
      input.imageAssetId,
      input.contentSha256,
    ],
  )
  const row = result.rows[0]
  if (!row || row.content_sha256 !== input.contentSha256
      || row.byte_length !== row.content_bytes.byteLength) {
    fail(
      'FAIRE_PRODUCT_IMAGE_ASSET_STALE',
      'The exact authorized primary image is no longer available',
    )
  }
  return {
    bytes: new Uint8Array(row.content_bytes),
    mimeType: row.mime_type,
    contentSha256: row.content_sha256,
    byteLength: row.byte_length,
  }
}

export async function recordFaireProductImageProviderStepInPostgres(input: {
  organizationId: string
  deliveryGrantId: string
  externalEffectId: string
  providerAttemptId: string | null
  stage: 'upload' | 'attach' | 'reconcile'
  outcome:
    | 'succeeded'
    | 'failed'
    | 'unknown'
    | 'observed_applied'
    | 'observed_absent'
    | 'manual_review'
  uploadedLocatorSha256: string | null
  providerWriteCount: number
  redactedEvidence: Record<string, unknown>
  actorEmail: string | null
}) {
  assertRedactedCommerceExternalEffectEvidence(
    input.redactedEvidence,
    'Faire Product-image provider-step evidence',
  )
  if (input.uploadedLocatorSha256 && !HASH.test(input.uploadedLocatorSha256)) {
    fail('FAIRE_PRODUCT_IMAGE_LOCATOR_INVALID', 'Faire image locator evidence is invalid', 400)
  }
  const evidenceHash = commerceExternalEffectHash(input.redactedEvidence)
  const result = await query<{ id: string; observed_at: TimestampValue }>(
    `INSERT INTO operations_faire_product_image_provider_steps (
       organization_id, integration_account_id, idempotency_key,
       delivery_grant_id, external_effect_id, provider_attempt_id,
       stage, outcome, uploaded_locator_sha256, provider_write_count,
       redacted_evidence, evidence_hash, recorded_by
     )
     SELECT
       grant_row.organization_id, grant_row.integration_account_id,
       grant_row.idempotency_key, grant_row.id, $3::uuid, $4::uuid,
       $5, $6, $7, $8, $9::jsonb, $10, $11
     FROM operations_faire_product_image_delivery_grants grant_row
     WHERE grant_row.organization_id = $1::uuid
       AND grant_row.id = $2::uuid
     RETURNING id::text, observed_at`,
    [
      input.organizationId,
      input.deliveryGrantId,
      input.externalEffectId,
      input.providerAttemptId,
      input.stage,
      input.outcome,
      input.uploadedLocatorSha256,
      input.providerWriteCount,
      JSON.stringify(input.redactedEvidence),
      evidenceHash,
      input.actorEmail,
    ],
  )
  if (!result.rows[0]) {
    fail('FAIRE_PRODUCT_IMAGE_STEP_SAVE_FAILED', 'Faire provider-step evidence could not be saved', 500)
  }
  return {
    id: result.rows[0].id,
    observedAt: iso(result.rows[0].observed_at),
    evidenceHash,
  }
}

async function readFaireProductImageReconciliationContextWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    productId: string
    externalEffectGlobalId: string
    forUpdate?: boolean
  },
): Promise<FaireProductImageReconciliationContext> {
  const result = await client.query<ReconciliationRow>(
    `SELECT
       image_grant.id::text AS delivery_grant_id,
       image_grant.product_id::text,
       image_grant.account_global_id,
       image_grant.credential_generation,
       image_grant.external_product_id,
       effect.id::text AS external_effect_id,
       effect.global_id AS external_effect_global_id,
       effect.state AS effect_state,
       (
         effect.state = 'claimed'
         AND effect.lease_expires_at <= clock_timestamp()
       ) AS lease_expired,
       GREATEST(
         effect.provider_write_count,
         COALESCE(progress.provider_write_count, 0)
       ) AS provider_write_count,
       COALESCE(
         upload.uploaded_locator_sha256,
         CASE
           WHEN effect.redacted_result->>'provider' = 'faire'
            AND effect.redacted_result->>'operation' = 'productImagePublish'
            AND effect.redacted_result->>'deliveryGrantId' = image_grant.id::text
            AND effect.redacted_result->>'assetContentSha256' =
                  image_grant.asset_content_sha256
            AND effect.redacted_result->>'uploadedLocatorSha256'
                  ~ '^[a-f0-9]{64}$'
           THEN effect.redacted_result->>'uploadedLocatorSha256'
           ELSE NULL
         END
       ) AS uploaded_locator_sha256,
       latest.outcome AS latest_outcome,
       latest.observed_at AS latest_observed_at
     FROM operations_commerce_external_effect_intents effect
     JOIN operations_faire_product_image_delivery_grants image_grant
       ON image_grant.organization_id = effect.organization_id
      AND image_grant.integration_account_id = effect.integration_account_id
      AND image_grant.idempotency_key = effect.idempotency_key
     LEFT JOIN LATERAL (
       SELECT max(step.provider_write_count)::integer AS provider_write_count
       FROM operations_faire_product_image_provider_steps step
       WHERE step.organization_id = effect.organization_id
         AND step.external_effect_id = effect.id
     ) progress ON true
     LEFT JOIN LATERAL (
       SELECT step.uploaded_locator_sha256
       FROM operations_faire_product_image_provider_steps step
       WHERE step.organization_id = effect.organization_id
         AND step.external_effect_id = effect.id
         AND step.stage = 'upload'
         AND step.outcome = 'succeeded'
         AND step.uploaded_locator_sha256 IS NOT NULL
         AND step.redacted_evidence->>'assetContentSha256' =
               image_grant.asset_content_sha256
         AND step.redacted_evidence->>'uploadedLocatorSha256' =
               step.uploaded_locator_sha256
       ORDER BY step.observed_at DESC, step.id DESC
       LIMIT 1
     ) upload ON true
     LEFT JOIN LATERAL (
       SELECT step.outcome, step.observed_at
       FROM operations_faire_product_image_provider_steps step
       WHERE step.organization_id = effect.organization_id
         AND step.external_effect_id = effect.id
       ORDER BY step.observed_at DESC, step.id DESC
       LIMIT 1
     ) latest ON true
     WHERE effect.organization_id = $1::uuid
       AND image_grant.product_id = $2::uuid
       AND effect.global_id = $3
       AND effect.provider = 'faire'
       AND effect.action = '${ACTION}'
       AND effect.desired_mode = 'active'
     LIMIT 1
     ${input.forUpdate ? 'FOR UPDATE OF effect' : ''}`,
    [input.organizationId, input.productId, input.externalEffectGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'FAIRE_PRODUCT_IMAGE_RECONCILIATION_NOT_FOUND',
      'Faire Product-image publication evidence was not found',
      404,
    )
  }
  return {
    deliveryGrantId: row.delivery_grant_id,
    productId: row.product_id,
    accountGlobalId: row.account_global_id,
    credentialGeneration: row.credential_generation,
    externalProductId: row.external_product_id,
    externalEffectId: row.external_effect_id,
    externalEffectGlobalId: row.external_effect_global_id,
    effectState: row.effect_state,
    leaseExpired: row.lease_expired === true,
    providerWriteCount: row.provider_write_count,
    uploadedLocatorSha256: row.uploaded_locator_sha256,
    latestOutcome: row.latest_outcome,
    latestObservedAt: row.latest_observed_at
      ? iso(row.latest_observed_at)
      : null,
  }
}

export async function readFaireProductImageReconciliationContextInPostgres(
  input: {
    organizationId: string
    productId: string
    externalEffectGlobalId: string
  },
) {
  return withTransaction((client) => (
    readFaireProductImageReconciliationContextWithClient(client, input)
  ))
}

export async function recoverExpiredFaireProductImageClaimInPostgres(input: {
  organizationId: string
  productId: string
  externalEffectGlobalId: string
  actorEmail: string
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `faire-product-image-recover:${input.organizationId}:${input.externalEffectGlobalId}`,
    )
    const current = await readFaireProductImageReconciliationContextWithClient(
      client,
      { ...input, forUpdate: true },
    )
    if (current.effectState !== 'claimed' || !current.leaseExpired) {
      return current
    }
    const evidence = {
      provider: 'faire',
      operation: 'productImagePublish',
      outcome: 'unknown',
      stage: 'expired_claim_reconciliation',
      errorCode: 'FAIRE_PRODUCT_IMAGE_EXPIRED_CLAIM_UNKNOWN',
      externalProductId: current.externalProductId,
      uploadedLocatorAvailable: current.uploadedLocatorSha256 !== null,
      providerMutationAttempted: true,
      providerWritesKnown: false,
      providerWriteCountLowerBound: current.providerWriteCount,
      providerWrites: current.providerWriteCount,
      reconciledBy: input.actorEmail,
    }
    assertRedactedCommerceExternalEffectEvidence(
      evidence,
      'Expired Faire Product-image claim evidence',
    )
    const evidenceHash = commerceExternalEffectHash(evidence)
    const attempt = await client.query<{ id: string }>(
      `UPDATE operations_commerce_provider_attempts attempt
       SET state = 'unknown',
           redacted_response = $4::jsonb,
           provider_reference = NULL,
           error_code = 'FAIRE_PRODUCT_IMAGE_EXPIRED_CLAIM_UNKNOWN',
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = clock_timestamp()
       FROM operations_commerce_external_effect_intents effect
       WHERE effect.organization_id = $1::uuid
         AND effect.id = $2::uuid
         AND effect.global_id = $3
         AND effect.provider_attempt_id = attempt.id
         AND attempt.organization_id = effect.organization_id
         AND attempt.integration_account_id = effect.integration_account_id
         AND effect.state = 'claimed'
         AND effect.lease_expires_at <= clock_timestamp()
         AND attempt.state = 'prepared'
         AND attempt.lease_expires_at <= clock_timestamp()
       RETURNING attempt.id::text`,
      [
        input.organizationId,
        current.externalEffectId,
        input.externalEffectGlobalId,
        JSON.stringify(evidence),
      ],
    )
    if (!attempt.rows[0]) {
      fail(
        'FAIRE_PRODUCT_IMAGE_RECOVERY_CONFLICT',
        'Expired Faire Product-image claim changed during recovery',
      )
    }
    const effect = await client.query<{ id: string }>(
      `UPDATE operations_commerce_external_effect_intents
       SET state = 'unknown',
           lease_token = NULL,
           lease_expires_at = NULL,
           redacted_result = $4::jsonb,
           terminal_evidence_hash = $5,
           provider_reference = NULL,
           error_code = 'FAIRE_PRODUCT_IMAGE_EXPIRED_CLAIM_UNKNOWN',
           provider_write_count = $6,
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND global_id = $3
         AND state = 'claimed'
       RETURNING id::text`,
      [
        input.organizationId,
        current.externalEffectId,
        input.externalEffectGlobalId,
        JSON.stringify(evidence),
        evidenceHash,
        current.providerWriteCount,
      ],
    )
    if (!effect.rows[0]) {
      fail(
        'FAIRE_PRODUCT_IMAGE_RECOVERY_UNKNOWN',
        'Expired Faire Product-image attempt was made terminal but its effect did not finalize',
        500,
      )
    }
    return readFaireProductImageReconciliationContextWithClient(
      client,
      input,
    )
  })
}

export async function readFaireProductImageProjectionHealthInPostgres() {
  const result = await query<{
    state: string
    count: string | number
    unresolved_count: string | number
    expired_claimed_count: string | number
    latest_at: TimestampValue | null
  }>(
    `SELECT
       effect.state,
       count(*)::text AS count,
       count(*) FILTER (
         WHERE effect.state IN ('unknown', 'failed')
           AND NOT EXISTS (
             SELECT 1
             FROM operations_faire_product_image_provider_steps resolution
             WHERE resolution.organization_id = effect.organization_id
               AND resolution.external_effect_id = effect.id
               AND resolution.stage = 'reconcile'
               AND resolution.outcome IN (
                 'observed_applied', 'observed_absent'
               )
           )
       )::text AS unresolved_count,
       count(*) FILTER (
         WHERE effect.state = 'claimed'
           AND effect.lease_expires_at <= clock_timestamp()
       )::text AS expired_claimed_count,
       max(COALESCE(effect.completed_at, effect.claimed_at, effect.created_at))
         AS latest_at
     FROM operations_commerce_external_effect_intents effect
     WHERE effect.provider = 'faire'
       AND effect.action = '${ACTION}'
     GROUP BY effect.state`,
  )
  const counts: Record<string, number> = {}
  const unresolvedCounts: Record<string, number> = {}
  let latestAt: string | null = null
  let expiredClaimed = 0
  for (const row of result.rows) {
    counts[row.state] = integer(row.count, 'Faire Product-image health count')
    unresolvedCounts[row.state] = integer(
      row.unresolved_count,
      'Faire Product-image unresolved health count',
    )
    expiredClaimed += integer(
      row.expired_claimed_count,
      'Faire Product-image expired-claim count',
    )
    if (row.latest_at) {
      const candidate = iso(row.latest_at)
      if (!latestAt || candidate > latestAt) latestAt = candidate
    }
  }
  return { counts, unresolvedCounts, expiredClaimed, latestAt }
}
