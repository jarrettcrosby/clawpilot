import { createHash, randomUUID } from 'node:crypto'
import type {
  PoolClient,
  QueryResultRow,
} from 'pg'
import {
  CRM_PRODUCT_IMAGE_MAX_BYTES,
  CRM_PRODUCT_IMAGE_MAX_DIMENSION,
  CRM_PRODUCT_IMAGE_MAX_PIXELS,
  CRM_PRODUCT_IMAGE_MIME_TYPES,
  type CrmProductImageMimeType,
} from '@/lib/crm/productImageAssets'
import {
  ShopifyProductMediaProjectionError,
  type ShopifyProductMediaDeliveryAsset,
  type ShopifyProductMediaProjectionGrant,
  type ShopifyProductMediaProjectionMode,
} from '@/lib/integrations/shopifyProductMediaProjectionTypes'
import { commerceExternalEffectHash } from '@/lib/persistence/commerceExternalEffects'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PRODUCT_REFERENCE_PATTERN = /^gp[0-9]{7}$/
const ACCOUNT_GLOBAL_PATTERN = /^gia[0-9]{7}$/
const CHANNEL_GLOBAL_PATTERN = /^gpcs[0-9]{7}$/
const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const ACTIVE_TTL_SECONDS = 15 * 60
const SHADOW_TTL_SECONDS = 60

type GrantRow = QueryResultRow & {
  id: string
  organization_id: string
  integration_account_id: string
  integration_account_global_id: string
  pipeline_id: string
  product_id: string
  channel_state_id: string
  image_asset_id: string
  idempotency_key: string
  product_write_authorization_id: string | null
  desired_mode: string
  public_origin: string
  product_reference_code: string
  product_source_hash: string
  product_gid: string
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
  issued_at_epoch: string | number
  expires_at_epoch: string | number
  created_by: string
}

type SelectionRow = QueryResultRow & {
  organization_id: string
  integration_account_id: string
  integration_account_global_id: string
  integration_account_status: string
  integration_account_provider: string
  credential_generation: number
  credential_version: number
  credential_verification_status: string
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
  image_asset_id: string
  asset_revision: string | number
  asset_row_version: string | number
  asset_content_sha256: string
  asset_mime_type: string
  asset_byte_length: number
  asset_pixel_width: number
  asset_pixel_height: number
  asset_alt_text: string
  issued_at_epoch: string | number
  next_aggregate_revision: string | number
}

type DeliveryRow = QueryResultRow & {
  desired_mode: string
  public_origin: string
  issued_at_epoch: string | number
  expires_at_epoch: string | number
  asset_content_sha256: string
  asset_mime_type: string
  asset_byte_length: number
  content_bytes: Buffer
  stored_mime_type: string
  stored_content_sha256: string
  stored_byte_length: number
}

type ReconciliationRow = QueryResultRow & {
  delivery_grant_id: string
  external_effect_id: string
  external_effect_global_id: string
  effect_state: string
  lease_expired: boolean
  integration_account_global_id: string
  credential_generation: number
  product_gid: string
  media_image_gid: string | null
  initial_media_status: string | null
  initial_media_errors: unknown
  latest_media_status: string | null
  latest_media_errors: unknown
  latest_observed_at: string | Date | null
}

export type ShopifyProductMediaReconciliationContext = {
  deliveryGrantId: string
  externalEffectId: string
  externalEffectGlobalId: string
  effectState:
    | 'pending'
    | 'claimed'
    | 'succeeded'
    | 'failed'
    | 'unknown'
  leaseExpired: boolean
  integrationAccountGlobalId: string
  credentialGeneration: number
  productGid: string
  mediaImageGid: string | null
  mediaStatus: 'FAILED' | 'PROCESSING' | 'READY' | 'UPLOADED' | null
  mediaErrors: Array<{
    code: string
    message: string
    details: string | null
  }>
  observedAt: string | null
}

const MEDIA_IMAGE_GID_PATTERN =
  /^gid:\/\/shopify\/MediaImage\/[1-9][0-9]*$/
const MEDIA_STATUSES = [
  'FAILED',
  'PROCESSING',
  'READY',
  'UPLOADED',
] as const

function mediaStatus(value: unknown) {
  return MEDIA_STATUSES.includes(
    value as typeof MEDIA_STATUSES[number],
  )
    ? value as typeof MEDIA_STATUSES[number]
    : null
}

function mediaErrors(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return []
    }
    const record = entry as Record<string, unknown>
    const code = String(record.code || '').trim()
    const message = String(record.message || '').trim()
    const details = record.details === null
      || record.details === undefined
      ? null
      : String(record.details).trim()
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(code)
      || !message
      || message.length > 2_048
      || (details !== null && details.length > 4_096)
    ) return []
    return [{ code, message, details }]
  })
}

function reconciliationContext(
  row: ReconciliationRow,
): ShopifyProductMediaReconciliationContext {
  const state = row.effect_state as
    ShopifyProductMediaReconciliationContext['effectState']
  if (
    !UUID_PATTERN.test(row.delivery_grant_id)
    || !UUID_PATTERN.test(row.external_effect_id)
    || !/^gcef[0-9]{7}$/.test(row.external_effect_global_id)
    || !['pending', 'claimed', 'succeeded', 'failed', 'unknown']
      .includes(state)
    || !ACCOUNT_GLOBAL_PATTERN.test(row.integration_account_global_id)
    || !Number.isSafeInteger(row.credential_generation)
    || row.credential_generation < 1
    || !PRODUCT_GID_PATTERN.test(row.product_gid)
    || (
      row.media_image_gid !== null
      && !MEDIA_IMAGE_GID_PATTERN.test(row.media_image_gid)
    )
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_RECONCILIATION_EVIDENCE_INVALID',
      'Stored Shopify Product-media reconciliation evidence is invalid',
      500,
    )
  }
  const latestStatus = mediaStatus(row.latest_media_status)
  const initialStatus = mediaStatus(row.initial_media_status)
  return {
    deliveryGrantId: row.delivery_grant_id,
    externalEffectId: row.external_effect_id,
    externalEffectGlobalId: row.external_effect_global_id,
    effectState: state,
    leaseExpired: row.lease_expired === true,
    integrationAccountGlobalId: row.integration_account_global_id,
    credentialGeneration: row.credential_generation,
    productGid: row.product_gid,
    mediaImageGid: row.media_image_gid,
    mediaStatus: latestStatus || initialStatus,
    mediaErrors: latestStatus
      ? mediaErrors(row.latest_media_errors)
      : mediaErrors(row.initial_media_errors),
    observedAt: row.latest_observed_at
      ? new Date(row.latest_observed_at).toISOString()
      : null,
  }
}

const GRANT_PROJECTION = `
  SELECT
    media_grant.id::text,
    media_grant.organization_id::text,
    media_grant.integration_account_id::text,
    media_grant.integration_account_global_id,
    media_grant.pipeline_id::text,
    media_grant.product_id::text,
    media_grant.channel_state_id::text,
    media_grant.image_asset_id::text,
    media_grant.idempotency_key,
    (
      SELECT auth.id::text
      FROM operations_shopify_product_media_write_authorizations auth
      WHERE auth.organization_id = media_grant.organization_id
        AND auth.delivery_grant_id = media_grant.id
      LIMIT 1
    ) AS product_write_authorization_id,
    media_grant.desired_mode,
    media_grant.public_origin,
    media_grant.product_reference_code,
    media_grant.product_source_hash,
    media_grant.product_gid,
    media_grant.channel_state_global_id,
    media_grant.channel_state_row_version::text,
    media_grant.channel_source_revision,
    media_grant.channel_source_hash,
    media_grant.asset_revision::text,
    media_grant.asset_row_version::text,
    media_grant.asset_content_sha256,
    media_grant.asset_mime_type,
    media_grant.asset_byte_length,
    media_grant.asset_pixel_width,
    media_grant.asset_pixel_height,
    media_grant.asset_alt_text,
    media_grant.credential_generation,
    media_grant.activation_revision,
    media_grant.aggregate_revision::text,
    media_grant.aggregate_hash,
    floor(extract(epoch FROM media_grant.issued_at))::text
      AS issued_at_epoch,
    floor(extract(epoch FROM media_grant.expires_at))::text
      AS expires_at_epoch,
    media_grant.created_by
  FROM operations_shopify_product_media_delivery_grants media_grant
`

function fail(code: string, message: string, status = 400): never {
  throw new ShopifyProductMediaProjectionError(code, message, status)
}

function integer(
  value: string | number,
  label: string,
  minimum = 0,
) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_EVIDENCE_CORRUPT',
      `Stored Shopify product media ${label} is invalid`,
      500,
    )
  }
  return parsed
}

function toGrant(row: GrantRow): ShopifyProductMediaProjectionGrant {
  const mode = row.desired_mode as ShopifyProductMediaProjectionMode
  if (
    !UUID_PATTERN.test(row.id)
    || !UUID_PATTERN.test(row.organization_id)
    || !UUID_PATTERN.test(row.integration_account_id)
    || !ACCOUNT_GLOBAL_PATTERN.test(row.integration_account_global_id)
    || !UUID_PATTERN.test(row.pipeline_id)
    || !UUID_PATTERN.test(row.product_id)
    || !UUID_PATTERN.test(row.channel_state_id)
    || !UUID_PATTERN.test(row.image_asset_id)
    || !row.idempotency_key
    || !['shadow', 'active'].includes(mode)
    || !row.public_origin.startsWith('https://')
    || !PRODUCT_REFERENCE_PATTERN.test(row.product_reference_code)
    || !SHA256_PATTERN.test(row.product_source_hash)
    || !PRODUCT_GID_PATTERN.test(row.product_gid)
    || !CHANNEL_GLOBAL_PATTERN.test(row.channel_state_global_id)
    || !row.channel_source_revision
    || !SHA256_PATTERN.test(row.channel_source_hash)
    || !SHA256_PATTERN.test(row.asset_content_sha256)
    || !CRM_PRODUCT_IMAGE_MIME_TYPES.includes(
      row.asset_mime_type as CrmProductImageMimeType,
    )
    || !Number.isSafeInteger(row.asset_byte_length)
    || row.asset_byte_length < 1
    || row.asset_byte_length > CRM_PRODUCT_IMAGE_MAX_BYTES
    || !Number.isSafeInteger(row.asset_pixel_width)
    || !Number.isSafeInteger(row.asset_pixel_height)
    || row.asset_pixel_width < 1
    || row.asset_pixel_height < 1
    || row.asset_pixel_width > CRM_PRODUCT_IMAGE_MAX_DIMENSION
    || row.asset_pixel_height > CRM_PRODUCT_IMAGE_MAX_DIMENSION
    || row.asset_pixel_width * row.asset_pixel_height
      > CRM_PRODUCT_IMAGE_MAX_PIXELS
    || !row.asset_alt_text.trim()
    || !Number.isSafeInteger(row.credential_generation)
    || row.credential_generation < 1
    || !Number.isSafeInteger(row.activation_revision)
    || row.activation_revision < 1
    || !row.created_by.trim()
    || (
      mode === 'active'
      && !UUID_PATTERN.test(row.product_write_authorization_id || '')
    )
    || (
      mode === 'shadow'
      && row.product_write_authorization_id !== null
    )
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_EVIDENCE_CORRUPT',
      'Stored Shopify product media evidence is invalid',
      500,
    )
  }
  const issuedAtEpoch = integer(row.issued_at_epoch, 'issue time', 1)
  const expiresAtEpoch = integer(row.expires_at_epoch, 'expiry time', 1)
  const maximumTtl = mode === 'active'
    ? ACTIVE_TTL_SECONDS
    : SHADOW_TTL_SECONDS
  if (
    expiresAtEpoch <= issuedAtEpoch
    || expiresAtEpoch - issuedAtEpoch > maximumTtl
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_EVIDENCE_CORRUPT',
      'Stored Shopify product media expiry evidence is invalid',
      500,
    )
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    integrationAccountGlobalId: row.integration_account_global_id,
    pipelineId: row.pipeline_id,
    productId: row.product_id,
    channelStateId: row.channel_state_id,
    imageAssetId: row.image_asset_id,
    idempotencyKey: row.idempotency_key,
    productWriteAuthorizationId:
      row.product_write_authorization_id,
    mode,
    publicOrigin: row.public_origin,
    productReferenceCode: row.product_reference_code,
    productSourceHash: row.product_source_hash,
    productGid: row.product_gid,
    channelStateGlobalId: row.channel_state_global_id,
    channelStateRowVersion: integer(
      row.channel_state_row_version,
      'channel revision',
    ),
    channelSourceRevision: row.channel_source_revision,
    channelSourceHash: row.channel_source_hash,
    assetRevision: integer(row.asset_revision, 'asset revision', 1),
    assetRowVersion: integer(row.asset_row_version, 'asset row revision', 1),
    assetContentSha256: row.asset_content_sha256,
    assetMimeType: row.asset_mime_type as CrmProductImageMimeType,
    assetByteLength: row.asset_byte_length,
    assetPixelWidth: row.asset_pixel_width,
    assetPixelHeight: row.asset_pixel_height,
    assetAltText: row.asset_alt_text,
    credentialGeneration: row.credential_generation,
    activationRevision: row.activation_revision,
    aggregateRevision: integer(
      row.aggregate_revision,
      'aggregate revision',
      1,
    ),
    aggregateHash: row.aggregate_hash,
    issuedAtEpoch,
    expiresAtEpoch,
    createdBy: row.created_by,
  }
}

function aggregateSnapshot(
  input: Omit<
    ShopifyProductMediaProjectionGrant,
    'aggregateHash' | 'createdBy' | 'productWriteAuthorizationId'
  >,
) {
  return {
    schemaVersion: 1,
    organizationId: input.organizationId,
    integrationAccountGlobalId: input.integrationAccountGlobalId,
    pipelineId: input.pipelineId,
    productId: input.productId,
    productReferenceCode: input.productReferenceCode,
    productSourceHash: input.productSourceHash,
    channelStateId: input.channelStateId,
    channelStateGlobalId: input.channelStateGlobalId,
    channelStateRowVersion: input.channelStateRowVersion,
    channelSourceRevision: input.channelSourceRevision,
    channelSourceHash: input.channelSourceHash,
    productGid: input.productGid,
    imageAssetId: input.imageAssetId,
    assetRevision: input.assetRevision,
    assetRowVersion: input.assetRowVersion,
    assetContentSha256: input.assetContentSha256,
    assetMimeType: input.assetMimeType,
    assetByteLength: input.assetByteLength,
    assetPixelWidth: input.assetPixelWidth,
    assetPixelHeight: input.assetPixelHeight,
    assetAltText: input.assetAltText,
    credentialGeneration: input.credentialGeneration,
    activationRevision: input.activationRevision,
    mode: input.mode,
    deliveryGrantId: input.id,
    publicOrigin: input.publicOrigin,
    issuedAtEpoch: input.issuedAtEpoch,
    expiresAtEpoch: input.expiresAtEpoch,
    aggregateRevision: input.aggregateRevision,
  }
}

function assertReplaySelection(
  grant: ShopifyProductMediaProjectionGrant,
  input: {
    productId: string
    channelStateGlobalId: string
    imageAssetId: string
    expectedMode: ShopifyProductMediaProjectionMode
  },
) {
  if (
    grant.productId !== input.productId
    || grant.channelStateGlobalId !== input.channelStateGlobalId
    || grant.imageAssetId !== input.imageAssetId
    || grant.mode !== input.expectedMode
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_IDEMPOTENCY_CONFLICT',
      'This idempotency key already identifies a different product media projection',
      409,
    )
  }
}

async function readExistingGrant(
  client: PoolClient,
  input: {
    organizationId: string
    idempotencyKey: string
  },
) {
  const result = await client.query<GrantRow>(
    `${GRANT_PROJECTION}
     WHERE media_grant.organization_id = $1::uuid
       AND media_grant.idempotency_key = $2
     LIMIT 1
     FOR SHARE OF media_grant`,
    [input.organizationId, input.idempotencyKey],
  )
  return result.rows[0] ? toGrant(result.rows[0]) : null
}

async function assertNoUnresolvedActiveImagePublish(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    productGid: string
    idempotencyKey: string
  },
) {
  const unresolved = await client.query<{ id: string }>(
    `SELECT media_grant.id::text
     FROM operations_shopify_product_media_delivery_grants media_grant
     LEFT JOIN operations_commerce_external_effect_intents effect
       ON effect.organization_id = media_grant.organization_id
      AND effect.integration_account_id =
            media_grant.integration_account_id
      AND effect.action = 'shopify.product.update'
      AND effect.idempotency_key = media_grant.idempotency_key
     LEFT JOIN LATERAL (
       SELECT observation.media_status
       FROM operations_shopify_product_media_status_observations observation
       WHERE observation.organization_id = media_grant.organization_id
         AND observation.external_effect_id = effect.id
       ORDER BY observation.observed_at DESC, observation.id DESC
       LIMIT 1
     ) latest_media ON true
     WHERE media_grant.organization_id = $1::uuid
       AND media_grant.integration_account_id = $2::uuid
       AND media_grant.product_gid = $3
       AND media_grant.desired_mode = 'active'
       AND media_grant.idempotency_key <> $4
       AND (
         (
           effect.id IS NULL
           AND media_grant.expires_at > clock_timestamp()
         )
         OR effect.state IN ('pending', 'claimed', 'unknown')
         OR (
           effect.state = 'succeeded'
           AND effect.redacted_result->>'mediaRequested' = 'true'
           AND COALESCE(
             latest_media.media_status,
             effect.redacted_result->'media'->>'status',
             'UNRESOLVED'
           ) NOT IN ('READY', 'FAILED')
         )
       )
     LIMIT 1
     FOR SHARE OF media_grant`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.productGid,
      input.idempotencyKey,
    ],
  )
  if (unresolved.rows[0]) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_PUBLISH_UNRESOLVED',
      'A prior Shopify product image publish is unresolved; reconcile its provider media status before appending another image',
      409,
    )
  }
}

export async function resolveShopifyProductMediaProviderIdentityInPostgres(
  input: {
    organizationId: string
    productId: string
    channelStateGlobalId: string
    imageAssetId: string
  },
): Promise<{
  integrationAccountGlobalId: string
  productGid: string
}> {
  const result = await withTransaction(async (client) => client.query<{
    integration_account_global_id: string
    product_gid: string
  }>(
    `SELECT
       account.global_id AS integration_account_global_id,
       channel_state.external_product_id AS product_gid
     FROM operations_product_channel_states channel_state
     JOIN operations_integration_accounts account
       ON account.organization_id = channel_state.organization_id
      AND account.id = channel_state.integration_account_id
     JOIN crm_products product
       ON product.pipeline_id = channel_state.pipeline_id
      AND product.id = channel_state.product_id
     JOIN pipeline_spaces pipeline
       ON pipeline.id = product.pipeline_id
      AND pipeline.workspace_organization_id = account.organization_id
     JOIN operations_product_mappings product_mapping
       ON product_mapping.organization_id = channel_state.organization_id
      AND product_mapping.integration_account_id =
            channel_state.integration_account_id
      AND product_mapping.pipeline_id = channel_state.pipeline_id
      AND product_mapping.id = channel_state.product_mapping_id
      AND product_mapping.product_id = channel_state.product_id
      AND product_mapping.external_product_id =
            channel_state.external_product_id
      AND product_mapping.external_variant_id =
            channel_state.external_variant_id
      AND product_mapping.active = true
     JOIN crm_product_image_assets image_asset
       ON image_asset.organization_id = account.organization_id
      AND image_asset.pipeline_id = product.pipeline_id
      AND image_asset.product_id = product.id
      AND image_asset.id = $4::uuid
      AND image_asset.is_primary = true
     WHERE account.organization_id = $1::uuid
       AND product.id = $2::uuid
       AND channel_state.global_id = $3
       AND channel_state.provider = 'shopify'
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
     LIMIT 1`,
    [
      input.organizationId,
      input.productId,
      input.channelStateGlobalId,
      input.imageAssetId,
    ],
  ))
  const row = result.rows[0]
  if (
    !row
    || !ACCOUNT_GLOBAL_PATTERN.test(row.integration_account_global_id)
    || !PRODUCT_GID_PATTERN.test(row.product_gid)
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_SELECTION_NOT_FOUND',
      'The exact mapped Shopify Product and primary image were not found in the active organization',
      404,
    )
  }
  return {
    integrationAccountGlobalId: row.integration_account_global_id,
    productGid: row.product_gid,
  }
}

export async function prepareShopifyProductMediaProjectionInPostgres(input: {
  organizationId: string
  productId: string
  channelStateGlobalId: string
  imageAssetId: string
  idempotencyKey: string
  expectedIntegrationAccountGlobalId: string
  expectedProductGid: string
  expectedMode: ShopifyProductMediaProjectionMode
  publicOrigin: string
  actorEmail: string
}): Promise<ShopifyProductMediaProjectionGrant> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-product-media:${input.organizationId}:${input.expectedIntegrationAccountGlobalId}:${input.expectedProductGid}`,
    )
    const existing = await readExistingGrant(client, input)
    if (existing) {
      assertReplaySelection(existing, input)
      if (
        existing.integrationAccountGlobalId
          !== input.expectedIntegrationAccountGlobalId
        || existing.productGid !== input.expectedProductGid
      ) {
        fail(
          'SHOPIFY_PRODUCT_MEDIA_PROVIDER_IDENTITY_MISMATCH',
          'The mapped Shopify Product changed before projection',
          409,
        )
      }
      return existing
    }

    const selected = await client.query<SelectionRow>(
      `SELECT
         account.organization_id::text,
         account.id::text AS integration_account_id,
         account.global_id AS integration_account_global_id,
         account.status AS integration_account_status,
         account.provider AS integration_account_provider,
         account.commerce_credential_generation AS credential_generation,
         credential.credential_version,
         credential.verification_status AS credential_verification_status,
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
         image_asset.id::text AS image_asset_id,
         image_asset.asset_revision::text,
         image_asset.row_version::text AS asset_row_version,
         image_asset.content_sha256 AS asset_content_sha256,
         image_asset.mime_type AS asset_mime_type,
         image_asset.byte_length AS asset_byte_length,
         image_asset.pixel_width AS asset_pixel_width,
         image_asset.pixel_height AS asset_pixel_height,
         image_asset.alt_text AS asset_alt_text,
         floor(extract(epoch FROM clock_timestamp()))::text
           AS issued_at_epoch,
         (
           COALESCE((
             SELECT max(prior.aggregate_revision)
             FROM operations_shopify_product_media_delivery_grants prior
             WHERE prior.organization_id = account.organization_id
               AND prior.integration_account_id = account.id
               AND prior.product_id = product.id
           ), 0) + 1
         )::text AS next_aggregate_revision
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
       JOIN pipeline_spaces pipeline
         ON pipeline.id = product.pipeline_id
        AND pipeline.workspace_organization_id = account.organization_id
       JOIN operations_product_mappings product_mapping
         ON product_mapping.organization_id = channel_state.organization_id
        AND product_mapping.integration_account_id =
              channel_state.integration_account_id
        AND product_mapping.pipeline_id = channel_state.pipeline_id
        AND product_mapping.id = channel_state.product_mapping_id
        AND product_mapping.product_id = channel_state.product_id
        AND product_mapping.external_product_id =
              channel_state.external_product_id
        AND product_mapping.external_variant_id =
              channel_state.external_variant_id
        AND product_mapping.active = true
       JOIN crm_product_image_assets image_asset
         ON image_asset.organization_id = account.organization_id
        AND image_asset.pipeline_id = product.pipeline_id
        AND image_asset.product_id = product.id
        AND image_asset.id = $4::uuid
        AND image_asset.is_primary = true
       WHERE account.organization_id = $1::uuid
         AND product.id = $2::uuid
         AND channel_state.global_id = $3
         AND channel_state.provider = 'shopify'
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       LIMIT 1
       FOR SHARE OF
         account,
         credential,
         activation,
         product,
         channel_state,
         product_mapping,
         image_asset`,
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
        'SHOPIFY_PRODUCT_MEDIA_SELECTION_NOT_FOUND',
        'The exact mapped Shopify product and primary image were not found in the active organization',
        404,
      )
    }
    if (
      row.integration_account_provider !== 'shopify'
      || row.integration_account_global_id
        !== input.expectedIntegrationAccountGlobalId
      || row.external_product_id !== input.expectedProductGid
      || row.credential_generation < 1
      || row.credential_version !== row.credential_generation
      || row.credential_verification_status !== 'verified'
      || !['shadow', 'active'].includes(row.activation_state)
      || (
        row.activation_state === 'active'
        && row.integration_account_status === 'error'
      )
      || (
        row.activation_state === 'shadow'
        && row.integration_account_status === 'error'
      )
    ) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_CONNECTION_NOT_READY',
        'The Shopify connection or Operations activation is not ready for product media projection',
        409,
      )
    }
    const mode = row.activation_state as ShopifyProductMediaProjectionMode
    if (mode !== input.expectedMode) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_MODE_CONFIRMATION_MISMATCH',
        mode === 'active'
          ? 'Confirm the exact Active provider write before publishing the product image'
          : 'Shadow mode cannot accept an Active provider-write confirmation',
        409,
      )
    }
    if (mode === 'active') {
      await assertNoUnresolvedActiveImagePublish(client, {
        organizationId: row.organization_id,
        integrationAccountId: row.integration_account_id,
        productGid: row.external_product_id,
        idempotencyKey: input.idempotencyKey,
      })
    }
    const issuedAtEpoch = integer(row.issued_at_epoch, 'issue time', 1)
    const expiresAtEpoch = issuedAtEpoch + (
      mode === 'active' ? ACTIVE_TTL_SECONDS : SHADOW_TTL_SECONDS
    )
    const grantWithoutHash = {
      id: randomUUID(),
      organizationId: row.organization_id,
      integrationAccountId: row.integration_account_id,
      integrationAccountGlobalId: row.integration_account_global_id,
      pipelineId: row.pipeline_id,
      productId: row.product_id,
      channelStateId: row.channel_state_id,
      imageAssetId: row.image_asset_id,
      idempotencyKey: input.idempotencyKey,
      mode,
      publicOrigin: input.publicOrigin,
      productReferenceCode: row.product_reference_code,
      productSourceHash: row.product_source_hash,
      productGid: row.external_product_id,
      channelStateGlobalId: row.channel_state_global_id,
      channelStateRowVersion: integer(
        row.channel_state_row_version,
        'channel revision',
      ),
      channelSourceRevision: row.channel_source_revision,
      channelSourceHash: row.channel_source_hash,
      assetRevision: integer(row.asset_revision, 'asset revision', 1),
      assetRowVersion: integer(
        row.asset_row_version,
        'asset row revision',
        1,
      ),
      assetContentSha256: row.asset_content_sha256,
      assetMimeType: row.asset_mime_type as CrmProductImageMimeType,
      assetByteLength: row.asset_byte_length,
      assetPixelWidth: row.asset_pixel_width,
      assetPixelHeight: row.asset_pixel_height,
      assetAltText: row.asset_alt_text,
      credentialGeneration: row.credential_generation,
      activationRevision: row.activation_revision,
      aggregateRevision: integer(
        row.next_aggregate_revision,
        'next aggregate revision',
        1,
      ),
      issuedAtEpoch,
      expiresAtEpoch,
    }
    const aggregateHash = commerceExternalEffectHash(
      aggregateSnapshot(grantWithoutHash),
    )
    const inserted = await client.query<GrantRow>(
      `INSERT INTO operations_shopify_product_media_delivery_grants (
         id, organization_id, integration_account_id,
         integration_account_global_id, pipeline_id, product_id,
         channel_state_id, image_asset_id, idempotency_key, desired_mode,
         public_origin, product_reference_code, product_source_hash,
         product_gid, channel_state_global_id, channel_state_row_version,
         channel_source_revision, channel_source_hash, asset_revision,
         asset_row_version, asset_content_sha256, asset_mime_type,
         asset_byte_length, asset_pixel_width, asset_pixel_height,
         asset_alt_text, credential_generation, activation_revision,
         aggregate_revision, aggregate_hash, issued_at, expires_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid,
         $7::uuid, $8::uuid, $9, $10, $11, $12, $13, $14, $15, $16::bigint,
         $17, $18, $19::bigint, $20::bigint, $21, $22, $23, $24, $25,
         $26, $27, $28, $29::bigint, $30, to_timestamp($31),
         to_timestamp($32), $33
       )
       RETURNING
         id::text,
         organization_id::text,
         integration_account_id::text,
         integration_account_global_id,
         pipeline_id::text,
         product_id::text,
         channel_state_id::text,
         image_asset_id::text,
         idempotency_key,
         NULL::text AS product_write_authorization_id,
         desired_mode,
         public_origin,
         product_reference_code,
         product_source_hash,
         product_gid,
         channel_state_global_id,
         channel_state_row_version::text,
         channel_source_revision,
         channel_source_hash,
         asset_revision::text,
         asset_row_version::text,
         asset_content_sha256,
         asset_mime_type,
         asset_byte_length,
         asset_pixel_width,
         asset_pixel_height,
         asset_alt_text,
         credential_generation,
         activation_revision,
         aggregate_revision::text,
         aggregate_hash,
         floor(extract(epoch FROM issued_at))::text AS issued_at_epoch,
         floor(extract(epoch FROM expires_at))::text AS expires_at_epoch,
         created_by`,
      [
        grantWithoutHash.id,
        grantWithoutHash.organizationId,
        grantWithoutHash.integrationAccountId,
        grantWithoutHash.integrationAccountGlobalId,
        grantWithoutHash.pipelineId,
        grantWithoutHash.productId,
        grantWithoutHash.channelStateId,
        grantWithoutHash.imageAssetId,
        grantWithoutHash.idempotencyKey,
        grantWithoutHash.mode,
        grantWithoutHash.publicOrigin,
        grantWithoutHash.productReferenceCode,
        grantWithoutHash.productSourceHash,
        grantWithoutHash.productGid,
        grantWithoutHash.channelStateGlobalId,
        grantWithoutHash.channelStateRowVersion,
        grantWithoutHash.channelSourceRevision,
        grantWithoutHash.channelSourceHash,
        grantWithoutHash.assetRevision,
        grantWithoutHash.assetRowVersion,
        grantWithoutHash.assetContentSha256,
        grantWithoutHash.assetMimeType,
        grantWithoutHash.assetByteLength,
        grantWithoutHash.assetPixelWidth,
        grantWithoutHash.assetPixelHeight,
        grantWithoutHash.assetAltText,
        grantWithoutHash.credentialGeneration,
        grantWithoutHash.activationRevision,
        grantWithoutHash.aggregateRevision,
        aggregateHash,
        grantWithoutHash.issuedAtEpoch,
        grantWithoutHash.expiresAtEpoch,
        input.actorEmail,
      ],
    )
    if (!inserted.rows[0]) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_GRANT_SAVE_FAILED',
        'Shopify product media delivery evidence could not be saved',
        500,
      )
    }
    let productWriteAuthorizationId: string | null = null
    if (mode === 'active') {
      const authorization = await client.query<{ id: string }>(
        `INSERT INTO
           operations_shopify_product_media_write_authorizations (
             organization_id,
             integration_account_id,
             delivery_grant_id,
             authorized_by,
             authorized_role,
             expires_at
           )
         SELECT
           $1::uuid,
           $2::uuid,
           $3::uuid,
           membership.user_email,
           membership.role,
           to_timestamp($4)
         FROM app_user_organization_memberships membership
         WHERE membership.organization_id = $1::uuid
           AND membership.user_email = $5
           AND membership.status = 'active'
           AND membership.role IN ('owner', 'admin')
         RETURNING id::text`,
        [
          grantWithoutHash.organizationId,
          grantWithoutHash.integrationAccountId,
          grantWithoutHash.id,
          grantWithoutHash.expiresAtEpoch,
          input.actorEmail,
        ],
      )
      productWriteAuthorizationId = authorization.rows[0]?.id || null
      if (!productWriteAuthorizationId) {
        fail(
          'SHOPIFY_PRODUCT_MEDIA_AUTHORITY_SAVE_FAILED',
          'Exact Shopify Product-image write authority could not be saved',
          403,
        )
      }
    }
    return toGrant({
      ...inserted.rows[0],
      product_write_authorization_id: productWriteAuthorizationId,
    })
  })
}

async function readReconciliationContext(
  client: PoolClient,
  input: {
    organizationId: string
    productId: string
    externalEffectGlobalId: string
    forUpdate?: boolean
  },
) {
  const result = await client.query<ReconciliationRow>(
    `SELECT
       media_grant.id::text AS delivery_grant_id,
       effect.id::text AS external_effect_id,
       effect.global_id AS external_effect_global_id,
       effect.state AS effect_state,
       (
         effect.state = 'claimed'
         AND effect.lease_expires_at <= clock_timestamp()
       ) AS lease_expired,
       media_grant.integration_account_global_id,
       media_grant.credential_generation,
       media_grant.product_gid,
       effect.redacted_result->'media'->>'id' AS media_image_gid,
       effect.redacted_result->'media'->>'status'
         AS initial_media_status,
       effect.redacted_result->'media'->'mediaErrors'
         AS initial_media_errors,
       latest.media_status AS latest_media_status,
       latest.media_errors AS latest_media_errors,
       latest.observed_at AS latest_observed_at
     FROM operations_commerce_external_effect_intents effect
     JOIN operations_shopify_product_media_delivery_grants media_grant
       ON media_grant.organization_id = effect.organization_id
      AND media_grant.integration_account_id =
            effect.integration_account_id
      AND media_grant.idempotency_key = effect.idempotency_key
     LEFT JOIN LATERAL (
       SELECT
         observation.media_status,
         observation.media_errors,
         observation.observed_at
       FROM operations_shopify_product_media_status_observations observation
       WHERE observation.organization_id = effect.organization_id
         AND observation.external_effect_id = effect.id
       ORDER BY observation.observed_at DESC, observation.id DESC
       LIMIT 1
     ) latest ON true
     WHERE effect.organization_id = $1::uuid
       AND media_grant.product_id = $2::uuid
       AND effect.global_id = $3
       AND effect.provider = 'shopify'
       AND effect.action = 'shopify.product.update'
       AND effect.desired_mode = 'active'
     LIMIT 1
     ${input.forUpdate ? 'FOR UPDATE OF effect' : ''}`,
    [
      input.organizationId,
      input.productId,
      input.externalEffectGlobalId,
    ],
  )
  if (!result.rows[0]) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_RECONCILIATION_NOT_FOUND',
      'Shopify Product-image publication evidence was not found',
      404,
    )
  }
  return reconciliationContext(result.rows[0])
}

export async function readShopifyProductMediaReconciliationContextInPostgres(
  input: {
    organizationId: string
    productId: string
    externalEffectGlobalId: string
  },
) {
  return withTransaction((client) => readReconciliationContext(
    client,
    input,
  ))
}

export async function recoverExpiredShopifyProductMediaClaimInPostgres(
  input: {
    organizationId: string
    productId: string
    externalEffectGlobalId: string
    actorEmail: string
  },
) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-product-media-recover:${input.organizationId}:${input.externalEffectGlobalId}`,
    )
    const current = await readReconciliationContext(client, {
      ...input,
      forUpdate: true,
    })
    if (current.effectState !== 'claimed' || !current.leaseExpired) {
      return current
    }
    const evidence = {
      provider: 'shopify',
      operation: 'productUpdate',
      outcome: 'unknown',
      stage: 'expired_claim_reconciliation',
      errorCode: 'SHOPIFY_PRODUCT_MEDIA_EXPIRED_CLAIM_UNKNOWN',
      productGid: current.productGid,
      providerMutationAttempted: true,
      providerWritesKnown: false,
      providerWrites: 0,
      reconciledBy: input.actorEmail,
    }
    const evidenceHash = commerceExternalEffectHash(evidence)
    const attempt = await client.query<{ id: string }>(
      `UPDATE operations_commerce_provider_attempts attempt
       SET state = 'unknown',
           redacted_response = $4::jsonb,
           provider_reference = NULL,
           error_code =
             'SHOPIFY_PRODUCT_MEDIA_EXPIRED_CLAIM_UNKNOWN',
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = clock_timestamp()
       FROM operations_commerce_external_effect_intents effect
       WHERE effect.organization_id = $1::uuid
         AND effect.id = $2::uuid
         AND effect.provider_attempt_id = attempt.id
         AND attempt.organization_id = effect.organization_id
         AND attempt.integration_account_id =
               effect.integration_account_id
         AND effect.state = 'claimed'
         AND effect.lease_expires_at <= clock_timestamp()
         AND effect.global_id = $3
         AND attempt.state = 'prepared'
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
        'SHOPIFY_PRODUCT_MEDIA_RECOVERY_CONFLICT',
        'Expired Shopify Product-image claim changed during recovery',
        409,
      )
    }
    const finalized = await client.query<{ id: string }>(
      `UPDATE operations_commerce_external_effect_intents
       SET state = 'unknown',
           lease_token = NULL,
           lease_expires_at = NULL,
           redacted_result = $4::jsonb,
           terminal_evidence_hash = $5,
           provider_reference = NULL,
           error_code =
             'SHOPIFY_PRODUCT_MEDIA_EXPIRED_CLAIM_UNKNOWN',
           provider_write_count = 0,
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
      ],
    )
    if (!finalized.rows[0]) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_RECOVERY_UNKNOWN',
        'Expired Shopify Product-image provider attempt was made terminal but its effect did not finalize',
        500,
      )
    }
    return readReconciliationContext(client, input)
  })
}

export async function recordShopifyProductMediaStatusObservationInPostgres(
  input: {
    organizationId: string
    deliveryGrantId: string
    externalEffectId: string
    mediaImageGid: string
    status: 'FAILED' | 'PROCESSING' | 'READY' | 'UPLOADED'
    errors: Array<{
      code: string
      message: string
      details: string | null
    }>
    actorEmail: string
  },
) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-product-media-observe:${input.organizationId}:${input.externalEffectId}`,
    )
    const terminal = input.status === 'READY' || input.status === 'FAILED'
    if (terminal) {
      const existing = await client.query<{
        media_status: string
        media_errors: unknown
        observed_at: string | Date
      }>(
        `SELECT media_status, media_errors, observed_at
         FROM operations_shopify_product_media_status_observations
         WHERE organization_id = $1::uuid
           AND external_effect_id = $2::uuid
           AND terminal = true
         LIMIT 1`,
        [input.organizationId, input.externalEffectId],
      )
      if (existing.rows[0]) {
        if (existing.rows[0].media_status !== input.status) {
          fail(
            'SHOPIFY_PRODUCT_MEDIA_TERMINAL_STATUS_CONFLICT',
            'Shopify returned conflicting terminal Product-media status',
            502,
          )
        }
        return {
          status: input.status,
          errors: mediaErrors(existing.rows[0].media_errors),
          observedAt: new Date(
            existing.rows[0].observed_at,
          ).toISOString(),
          replayed: true,
        }
      }
    }
    const inserted = await client.query<{
      media_status: string
      media_errors: unknown
      observed_at: string | Date
    }>(
      `INSERT INTO operations_shopify_product_media_status_observations (
         organization_id,
         delivery_grant_id,
         external_effect_id,
         media_image_gid,
         media_status,
         media_errors,
         observed_by
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4,
         $5,
         $6::jsonb,
         $7
       )
       RETURNING media_status, media_errors, observed_at`,
      [
        input.organizationId,
        input.deliveryGrantId,
        input.externalEffectId,
        input.mediaImageGid,
        input.status,
        JSON.stringify(input.errors),
        input.actorEmail,
      ],
    )
    return {
      status: input.status,
      errors: mediaErrors(inserted.rows[0].media_errors),
      observedAt: new Date(inserted.rows[0].observed_at).toISOString(),
      replayed: false,
    }
  })
}

export async function readShopifyProductMediaDeliveryAssetInPostgres(input: {
  grantId: string
  organizationId: string
  productId: string
  imageAssetId: string
  contentSha256: string
  issuedAtEpoch: number
  expiresAtEpoch: number
  nowEpoch: number
}): Promise<ShopifyProductMediaDeliveryAsset> {
  return withTransaction(async (client) => {
    const result = await client.query<DeliveryRow>(
      `SELECT
         media_grant.desired_mode,
         media_grant.public_origin,
         floor(extract(epoch FROM media_grant.issued_at))::text
           AS issued_at_epoch,
         floor(extract(epoch FROM media_grant.expires_at))::text
           AS expires_at_epoch,
         media_grant.asset_content_sha256,
         media_grant.asset_mime_type,
         media_grant.asset_byte_length,
         image_asset.content_bytes,
         image_asset.mime_type AS stored_mime_type,
         image_asset.content_sha256 AS stored_content_sha256,
         image_asset.byte_length AS stored_byte_length
       FROM operations_shopify_product_media_delivery_grants media_grant
       JOIN crm_product_image_assets image_asset
         ON image_asset.organization_id = media_grant.organization_id
        AND image_asset.pipeline_id = media_grant.pipeline_id
        AND image_asset.product_id = media_grant.product_id
        AND image_asset.id = media_grant.image_asset_id
       WHERE media_grant.id = $1::uuid
         AND media_grant.organization_id = $2::uuid
         AND media_grant.product_id = $3::uuid
         AND media_grant.image_asset_id = $4::uuid
         AND media_grant.asset_content_sha256 = $5
         AND media_grant.desired_mode = 'active'
         AND floor(extract(epoch FROM media_grant.issued_at)) = $6
         AND floor(extract(epoch FROM media_grant.expires_at)) = $7
         AND media_grant.expires_at > to_timestamp($8)
       LIMIT 1
       FOR SHARE OF media_grant, image_asset`,
      [
        input.grantId,
        input.organizationId,
        input.productId,
        input.imageAssetId,
        input.contentSha256,
        input.issuedAtEpoch,
        input.expiresAtEpoch,
        input.nowEpoch,
      ],
    )
    const row = result.rows[0]
    if (!row) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_ASSET_UNAVAILABLE',
        'Shopify product media is unavailable',
        404,
      )
    }
    const bytes = new Uint8Array(row.content_bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (
      row.desired_mode !== 'active'
      || row.asset_content_sha256 !== input.contentSha256
      || row.stored_content_sha256 !== input.contentSha256
      || digest !== input.contentSha256
      || row.asset_mime_type !== row.stored_mime_type
      || !CRM_PRODUCT_IMAGE_MIME_TYPES.includes(
        row.asset_mime_type as CrmProductImageMimeType,
      )
      || row.asset_byte_length !== row.stored_byte_length
      || row.asset_byte_length !== bytes.byteLength
      || row.asset_byte_length < 1
      || row.asset_byte_length > CRM_PRODUCT_IMAGE_MAX_BYTES
      || integer(row.issued_at_epoch, 'delivery issue time', 1)
        !== input.issuedAtEpoch
      || integer(row.expires_at_epoch, 'delivery expiry time', 1)
        !== input.expiresAtEpoch
    ) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_EVIDENCE_CORRUPT',
        'Stored Shopify product media delivery evidence is invalid',
        500,
      )
    }
    return {
      bytes,
      mimeType: row.asset_mime_type as CrmProductImageMimeType,
      byteLength: bytes.byteLength,
      contentSha256: digest,
    }
  })
}
