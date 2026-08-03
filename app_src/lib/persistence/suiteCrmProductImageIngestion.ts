import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'

import { recordAuditEvent } from '@/lib/auditWriter'
import {
  validateCrmProductImage,
  type ValidatedCrmProductImage,
} from '@/lib/crm/productImageAssets'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

export type SuiteCrmProductImageIngestionResolution =
  | 'echo_suppressed'
  | 'imported_primary'
  | 'imported_secondary'
  | 'identity_conflict'
  | 'media_integrity_conflict'
  | 'no_image'

export type SuiteCrmProductImageIngestionResult = {
  observationId: string | null
  observationGlobalId: string | null
  provenanceId: string | null
  provenanceGlobalId: string | null
  resolution: SuiteCrmProductImageIngestionResolution | 'stale_ignored'
  productId: string | null
  assetId: string | null
  contentSha256: string | null
  promotedToPrimary: boolean
  replayed: boolean
}

export type SuiteCrmProductImageIngestionHealth = {
  heartbeat: {
    phase: 'starting' | 'completed' | 'degraded' | 'disabled'
    checkedAt: string
    details: Record<string, unknown>
  } | null
  observations: number
  importedPrimary: number
  importedSecondary: number
  echoesSuppressed: number
  identityConflicts: number
  mediaIntegrityConflicts: number
  lastObservedAt: string | null
  providerWrites: 0
}

export class SuiteCrmProductImageIngestionError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'SuiteCrmProductImageIngestionError'
    this.code = code
    this.status = status
  }
}

type ProductRow = QueryResultRow & {
  organization_id: string
  pipeline_id: string
  product_id: string
  suitecrm_id: string | null
  reference_code: string
  name: string
}

type AssetRow = QueryResultRow & {
  id: string
  asset_revision: string | number
  row_version: string | number
  content_sha256: string
  source: string
  is_primary: boolean
}

type FenceRow = QueryResultRow & {
  accepted_suitecrm_modified_at: Date | string
  accepted_snapshot_sha256: string
  accepted_observation_id: string
  fence_revision: string | number
  pipeline_id: string | null
  product_id: string | null
}

type EvidenceRow = QueryResultRow & {
  observation_id: string
  observation_global_id: string
  provenance_id: string
  provenance_global_id: string
  resolution: SuiteCrmProductImageIngestionResolution
  product_id: string | null
  result_asset_id: string | null
  result_asset_content_sha256: string | null
  promoted_to_primary: boolean
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const PRODUCT_GLOBAL_ID_PATTERN = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/u
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const MAX_SUITECRM_CLOCK_SKEW_MS = 5 * 60 * 1000

function fail(code: string, message: string, status = 400): never {
  throw new SuiteCrmProductImageIngestionError(code, message, status)
}

function safeSuiteCrmId(value: unknown) {
  const id = String(value || '').trim()
  if (!id || id.length > 100 || CONTROL_CHARACTER_PATTERN.test(id)) {
    fail(
      'SUITECRM_PRODUCT_IMAGE_ID_INVALID',
      'SuiteCRM Product image record ID is invalid',
    )
  }
  return id
}

function safeGlobalId(value: unknown) {
  const globalId = String(value || '').trim().toLowerCase()
  return PRODUCT_GLOBAL_ID_PATTERN.test(globalId) ? globalId : null
}

function safeTimestamp(value: unknown, label: string) {
  const parsed = new Date(String(value || ''))
  if (!Number.isFinite(parsed.getTime())) {
    fail(
      'SUITECRM_PRODUCT_IMAGE_TIMESTAMP_INVALID',
      `SuiteCRM Product image ${label} is invalid`,
    )
  }
  return parsed.toISOString()
}

function positiveInteger(value: unknown, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(
      'SUITECRM_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
      `Stored SuiteCRM Product image ${label} is invalid`,
      500,
    )
  }
  return parsed
}

function snapshotHash(input: {
  suiteCrmId: string
  globalId: string | null
  modifiedAt: string
  media: ValidatedCrmProductImage | null
  mediaId: string | null
  originalName: string | null
}) {
  const canonical = JSON.stringify({
    version: 'suitecrm-product-image-snapshot-v1',
    suiteCrmId: input.suiteCrmId,
    globalId: input.globalId,
    modifiedAt: input.modifiedAt,
    media: input.media ? {
      mediaId: input.mediaId,
      originalName: input.originalName,
      mimeType: input.media.mimeType,
      contentSha256: input.media.contentSha256,
      byteLength: input.media.byteLength,
      pixelWidth: input.media.pixelWidth,
      pixelHeight: input.media.pixelHeight,
    } : null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function safeOriginalName(value: unknown) {
  const originalName = String(value || '').trim()
  if (
    !originalName
    || originalName.length > 512
    || CONTROL_CHARACTER_PATTERN.test(originalName)
  ) {
    fail(
      'SUITECRM_PRODUCT_IMAGE_MEDIA_INVALID',
      'SuiteCRM Product image filename is invalid',
    )
  }
  return originalName
}

function deterministicClawPilotImageIdentity(
  originalName: string,
  referenceCode: string,
) {
  const escapedReference = referenceCode.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = originalName.toLowerCase().match(
    new RegExp(
      `^${escapedReference}-([0-9a-f]{64})(?:-([0-9a-f]{64}))?\\.(?:jpg|jpeg|png|webp)$`,
      'u',
    ),
  )
  if (!match?.[1]) return null
  return {
    sourceContentSha256: match[1],
    mediaContentSha256: match[2] || match[1],
  }
}

function evidenceResult(row: EvidenceRow, replayed: boolean): SuiteCrmProductImageIngestionResult {
  return {
    observationId: row.observation_id,
    observationGlobalId: row.observation_global_id,
    provenanceId: row.provenance_id,
    provenanceGlobalId: row.provenance_global_id,
    resolution: row.resolution,
    productId: row.product_id,
    assetId: row.result_asset_id,
    contentSha256: row.result_asset_content_sha256,
    promotedToPrimary: row.promoted_to_primary,
    replayed,
  }
}

async function replayEvidence(
  client: PoolClient,
  organizationId: string,
  observationId: string,
) {
  const result = await client.query<EvidenceRow>(
    `SELECT
       observation.id::text AS observation_id,
       observation.global_id AS observation_global_id,
       provenance.id::text AS provenance_id,
       provenance.global_id AS provenance_global_id,
       provenance.resolution,
       provenance.product_id::text,
       provenance.result_asset_id::text,
       provenance.result_asset_content_sha256,
       provenance.promoted_to_primary
     FROM crm_suitecrm_product_image_observations observation
     JOIN crm_suitecrm_product_image_asset_provenance provenance
       ON provenance.organization_id = observation.organization_id
      AND provenance.suitecrm_id = observation.suitecrm_id
      AND provenance.observation_id = observation.id
     WHERE observation.organization_id = $1::uuid
       AND observation.id = $2::uuid
     LIMIT 1`,
    [organizationId, observationId],
  )
  if (!result.rows[0]) {
    fail(
      'SUITECRM_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
      'SuiteCRM Product image replay evidence is incomplete',
      500,
    )
  }
  return evidenceResult(result.rows[0], true)
}

export async function findSuiteCrmProductImageTargetInPostgres(
  globalIdValue: unknown,
): Promise<{
  organizationId: string
  productId: string
  actorEmail: string
} | null> {
  const globalId = safeGlobalId(globalIdValue)
  if (!globalId) return null
  const result = await query<{
    organization_id: string
    product_id: string
    actor_email: string
  }>(
    `SELECT
       pipeline.workspace_organization_id::text AS organization_id,
       product.id::text AS product_id,
       pipeline.owner_email AS actor_email
     FROM crm_products product
     JOIN pipeline_spaces pipeline ON pipeline.id = product.pipeline_id
     WHERE product.reference_code = $1
     ORDER BY pipeline.workspace_organization_id, product.id
     LIMIT 2`,
    [globalId],
  )
  const row = result.rows.length === 1 ? result.rows[0] : null
  return row ? {
    organizationId: row.organization_id,
    productId: row.product_id,
    actorEmail: row.actor_email,
  } : null
}

export async function findSuiteCrmProductImageOrganizationInPostgres(
  globalIdValue: unknown,
): Promise<string | null> {
  return (await findSuiteCrmProductImageTargetInPostgres(globalIdValue))
    ?.organizationId || null
}

async function selectSuiteCrmProductImageCandidates(
  client: PoolClient,
  input: {
    organizationId: string
    suiteCrmId: string
    globalId: string | null
    lock: boolean
  },
) {
  return client.query<ProductRow>(
    `SELECT
       pipeline.workspace_organization_id::text AS organization_id,
       product.pipeline_id::text,
       product.id::text AS product_id,
       product.suitecrm_id,
       product.reference_code,
       product.name
     FROM crm_products product
     JOIN pipeline_spaces pipeline
       ON pipeline.id = product.pipeline_id
      AND pipeline.workspace_organization_id = $1::uuid
     WHERE product.suitecrm_id = $2
        OR ($3 <> '' AND product.reference_code = $3)
     ORDER BY product.pipeline_id, product.id
     ${input.lock ? 'FOR UPDATE OF product' : ''}`,
    [input.organizationId, input.suiteCrmId, input.globalId || ''],
  )
}

export async function ingestSuiteCrmProductImageSnapshotInPostgres(input: {
  organizationId: string
  suiteCrmId: string
  suiteCrmGlobalId: string | null
  suiteCrmModifiedAt: string
  productName: string
  media: null | {
    mediaId: string
    originalName: string
    mimeType: string
    contentSha256: string
    bytes: Uint8Array
  }
  actorEmail: string
  observedAt?: string
}): Promise<SuiteCrmProductImageIngestionResult> {
  const suiteCrmId = safeSuiteCrmId(input.suiteCrmId)
  const globalId = safeGlobalId(input.suiteCrmGlobalId)
  const modifiedAt = safeTimestamp(input.suiteCrmModifiedAt, 'modified timestamp')
  const observedAt = safeTimestamp(input.observedAt || new Date(), 'observation timestamp')
  if (
    Date.parse(modifiedAt) > Date.parse(observedAt) + MAX_SUITECRM_CLOCK_SKEW_MS
  ) {
    fail(
      'SUITECRM_PRODUCT_IMAGE_MODIFIED_AT_FUTURE',
      'SuiteCRM Product image modified timestamp exceeds the allowed clock skew',
      409,
    )
  }
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (!actorEmail || actorEmail.length > 254 || CONTROL_CHARACTER_PATTERN.test(actorEmail)) {
    fail(
      'SUITECRM_PRODUCT_IMAGE_ACTOR_INVALID',
      'SuiteCRM Product image ingestion actor is invalid',
    )
  }
  const mediaId = input.media ? String(input.media.mediaId || '').trim() : null
  const originalName = input.media ? safeOriginalName(input.media.originalName) : null
  const image = input.media ? validateCrmProductImage({
    bytes: input.media.bytes,
    declaredMimeType: input.media.mimeType,
    altText: String(input.productName || '').trim() || 'SuiteCRM Product image',
  }) : null
  if (
    image
    && (
      !mediaId
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(mediaId)
      || !HASH_PATTERN.test(String(input.media?.contentSha256 || ''))
      || input.media?.contentSha256 !== image.contentSha256
    )
  ) {
    fail(
      'SUITECRM_PRODUCT_IMAGE_MEDIA_INVALID',
      'SuiteCRM Product image content evidence is invalid',
    )
  }
  const snapshotSha256 = snapshotHash({
    suiteCrmId,
    globalId,
    modifiedAt,
    media: image,
    mediaId,
    originalName,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `suitecrm-product-image:${input.organizationId}:${suiteCrmId}`,
    )
    const actorAuthority = await client.query(
      `SELECT 1
       FROM app_user_organization_memberships membership
       WHERE membership.user_email = $1
         AND membership.organization_id = $2::uuid
         AND membership.status = 'active'
       LIMIT 1`,
      [actorEmail, input.organizationId],
    )
    if (!actorAuthority.rows[0]) {
      fail(
        'SUITECRM_PRODUCT_IMAGE_ACTOR_FORBIDDEN',
        'SuiteCRM Product image ingestion actor lacks organization authority',
        403,
      )
    }
    // Discover candidate Product IDs without row locks, acquire the same
    // Product-image advisory locks used by every other image mutation, then
    // re-read under row lock. This preserves the global advisory-before-row
    // lock order and prevents a SuiteCRM ingest/import deadlock cycle.
    const preview = await selectSuiteCrmProductImageCandidates(client, {
      organizationId: input.organizationId,
      suiteCrmId,
      globalId,
      lock: false,
    })
    const protectedProductIds = new Set(
      preview.rows.map((candidate) => candidate.product_id),
    )
    for (const productId of [...protectedProductIds].sort()) {
      await acquireTransactionAdvisoryLock(
        client,
        `crm-product-images:${input.organizationId}:${productId}`,
      )
    }
    const candidates = await selectSuiteCrmProductImageCandidates(client, {
      organizationId: input.organizationId,
      suiteCrmId,
      globalId,
      lock: true,
    })
    const candidateScopeChanged = candidates.rows.some(
      (candidate) => !protectedProductIds.has(candidate.product_id),
    )
    const exactProduct = !candidateScopeChanged
      && candidates.rows.length === 1
      && candidates.rows[0]!.suitecrm_id === suiteCrmId
      && candidates.rows[0]!.reference_code === globalId
      ? candidates.rows[0]!
      : null
    const fenceResult = await client.query<FenceRow>(
      `SELECT
         accepted_suitecrm_modified_at,
         accepted_snapshot_sha256,
         accepted_observation_id::text,
         fence_revision::text,
         pipeline_id::text,
         product_id::text
       FROM crm_suitecrm_product_image_snapshot_fences
       WHERE organization_id = $1::uuid AND suitecrm_id = $2
       LIMIT 1
       FOR UPDATE`,
      [input.organizationId, suiteCrmId],
    )
    const fence = fenceResult.rows[0]
    if (fence) {
      const acceptedAt = new Date(fence.accepted_suitecrm_modified_at).getTime()
      const incomingAt = new Date(modifiedAt).getTime()
      if (incomingAt < acceptedAt) {
        return {
          observationId: null,
          observationGlobalId: null,
          provenanceId: null,
          provenanceGlobalId: null,
          resolution: 'stale_ignored',
          productId: exactProduct?.product_id || null,
          assetId: null,
          contentSha256: image?.contentSha256 || null,
          promotedToPrimary: false,
          replayed: false,
        }
      }
      if (incomingAt === acceptedAt) {
        if (fence.accepted_snapshot_sha256 !== snapshotSha256) {
          fail(
            'SUITECRM_PRODUCT_IMAGE_SNAPSHOT_CONFLICT',
            'SuiteCRM Product image timestamp identifies conflicting evidence',
            409,
          )
        }
        return replayEvidence(
          client,
          input.organizationId,
          fence.accepted_observation_id,
        )
      }
      if (
        fence.product_id
        && (!exactProduct || fence.product_id !== exactProduct.product_id)
      ) {
        fail(
          'SUITECRM_PRODUCT_IMAGE_IDENTITY_CONFLICT',
          'SuiteCRM Product image exact correlation changed',
          409,
        )
      }
    }

    const currentPrimaryResult = exactProduct
      ? await client.query<AssetRow>(
        `SELECT
           id::text,
           asset_revision::text,
           row_version::text,
           content_sha256,
           source,
           is_primary
         FROM crm_product_image_assets
         WHERE organization_id = $1::uuid
           AND pipeline_id = $2::uuid
           AND product_id = $3::uuid
           AND is_primary = true
         ORDER BY asset_revision, id
         LIMIT 1
         FOR UPDATE`,
        [input.organizationId, exactProduct.pipeline_id, exactProduct.product_id],
      )
      : { rows: [] as AssetRow[] }
    const currentPrimary = currentPrimaryResult.rows[0] || null
    const observationRevision = fence
      ? positiveInteger(fence.fence_revision, 'fence revision') + 1
      : 1
    const observation = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO crm_suitecrm_product_image_observations (
         organization_id,
         pipeline_id,
         product_id,
         suitecrm_id,
         suitecrm_global_id,
         suitecrm_modified_at,
         correlation_state,
         media_state,
         media_id,
         original_name,
         mime_type,
         content_sha256,
         byte_length,
         pixel_width,
         pixel_height,
         snapshot_sha256,
         observation_revision,
         local_primary_asset_id,
         local_primary_asset_revision,
         local_primary_row_version,
         local_primary_content_sha256,
         observed_by,
         observed_at,
         provider_write_count
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $7, $8,
         $9::uuid, $10, $11, $12, $13, $14, $15, $16, $17,
         $18::uuid, $19, $20, $21, $22, $23::timestamptz, 0
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        exactProduct?.pipeline_id || null,
        exactProduct?.product_id || null,
        suiteCrmId,
        globalId,
        modifiedAt,
        exactProduct ? 'exact' : 'identity_conflict',
        image ? 'present' : 'absent',
        mediaId,
        originalName,
        image?.mimeType || null,
        image?.contentSha256 || null,
        image?.byteLength || null,
        image?.pixelWidth || null,
        image?.pixelHeight || null,
        snapshotSha256,
        observationRevision,
        currentPrimary?.id || null,
        currentPrimary?.asset_revision || null,
        currentPrimary?.row_version || null,
        currentPrimary?.content_sha256 || null,
        actorEmail,
        observedAt,
      ],
    )
    const savedObservation = observation.rows[0]
    if (!savedObservation) {
      fail(
        'SUITECRM_PRODUCT_IMAGE_OBSERVATION_SAVE_FAILED',
        'SuiteCRM Product image observation could not be saved',
        500,
      )
    }

    let resolution: SuiteCrmProductImageIngestionResolution
    let conflictReason: string | null = null
    let resultAsset: AssetRow | null = null
    let promotedToPrimary = false
    let removedSuiteCrmImportedPrimary = false

    if (!exactProduct) {
      resolution = 'identity_conflict'
      conflictReason = candidates.rows.length === 0
        ? 'no_exact_local_identity'
        : candidates.rows.length > 1
          ? 'multiple_local_identity_candidates'
          : 'suitecrm_id_and_global_id_disagree'
    } else if (!image || !mediaId || !originalName) {
      resolution = 'no_image'
      if (currentPrimary?.source === 'suitecrm_import') {
        const demoted = await client.query(
          `UPDATE crm_product_image_assets
           SET is_primary = false,
               row_version = row_version + 1,
               updated_by = $5,
               updated_at = clock_timestamp()
           WHERE organization_id = $1::uuid
             AND pipeline_id = $2::uuid
             AND product_id = $3::uuid
             AND id = $4::uuid
             AND is_primary = true`,
          [
            input.organizationId,
            exactProduct.pipeline_id,
            exactProduct.product_id,
            currentPrimary.id,
            actorEmail,
          ],
        )
        if (demoted.rowCount !== 1) {
          fail(
            'SUITECRM_PRODUCT_IMAGE_ASSET_SAVE_FAILED',
            'SuiteCRM Product image removal could not clear the prior imported primary',
            500,
          )
        }
        removedSuiteCrmImportedPrimary = true
      }
    } else {
      const deterministicIdentity = deterministicClawPilotImageIdentity(
        originalName,
        exactProduct.reference_code,
      )
      const existingResult = await client.query<AssetRow>(
        `SELECT
           id::text,
           asset_revision::text,
           row_version::text,
           content_sha256,
           source,
           is_primary
         FROM crm_product_image_assets
         WHERE organization_id = $1::uuid
           AND pipeline_id = $2::uuid
           AND product_id = $3::uuid
           AND content_sha256 = $4
         LIMIT 1
         FOR UPDATE`,
        [
          input.organizationId,
          exactProduct.pipeline_id,
          exactProduct.product_id,
          image.contentSha256,
        ],
      )
      const existing = existingResult.rows[0] || null
      const sourceAssetResult = deterministicIdentity
        && deterministicIdentity.sourceContentSha256
          !== deterministicIdentity.mediaContentSha256
        ? await client.query<AssetRow>(
          `SELECT
             id::text,
             asset_revision::text,
             row_version::text,
             content_sha256,
             source,
             is_primary
           FROM crm_product_image_assets
           WHERE organization_id = $1::uuid
             AND pipeline_id = $2::uuid
             AND product_id = $3::uuid
             AND content_sha256 = $4
           LIMIT 1
           FOR UPDATE`,
          [
            input.organizationId,
            exactProduct.pipeline_id,
            exactProduct.product_id,
            deterministicIdentity.sourceContentSha256,
          ],
        )
        : null
      const sourceAsset = sourceAssetResult?.rows[0] || null
      if (
        deterministicIdentity
        && deterministicIdentity.mediaContentSha256 !== image.contentSha256
      ) {
        resolution = 'media_integrity_conflict'
        conflictReason = 'clawpilot_filename_content_mismatch'
      } else if (
        deterministicIdentity
        && !existing
        && deterministicIdentity.sourceContentSha256
          === deterministicIdentity.mediaContentSha256
      ) {
        resolution = 'media_integrity_conflict'
        conflictReason = 'clawpilot_echo_asset_missing'
      } else if (deterministicIdentity && !existing && !sourceAsset) {
        resolution = 'media_integrity_conflict'
        conflictReason = 'clawpilot_echo_asset_missing'
      } else if (deterministicIdentity && existing) {
        resolution = 'echo_suppressed'
        resultAsset = existing
      } else if (deterministicIdentity && sourceAsset) {
        const nextRevision = await client.query<{ next_revision: string }>(
          `SELECT (COALESCE(max(asset_revision), 0) + 1)::text AS next_revision
           FROM crm_product_image_assets
           WHERE organization_id = $1::uuid
             AND pipeline_id = $2::uuid
             AND product_id = $3::uuid`,
          [input.organizationId, exactProduct.pipeline_id, exactProduct.product_id],
        )
        const inserted = await client.query<AssetRow>(
          `INSERT INTO crm_product_image_assets (
             organization_id, pipeline_id, product_id, asset_revision,
             content_bytes, mime_type, content_sha256, byte_length,
             pixel_width, pixel_height, alt_text, source, is_primary,
             row_version, created_by, updated_by, created_at, updated_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5::bytea, $6, $7, $8,
             $9, $10, $11, 'suitecrm_import', false, 1, $12, $12,
             clock_timestamp(), clock_timestamp()
           )
           RETURNING id::text, asset_revision::text, row_version::text,
             content_sha256, source, is_primary`,
          [
            input.organizationId,
            exactProduct.pipeline_id,
            exactProduct.product_id,
            positiveInteger(
              nextRevision.rows[0]?.next_revision || 1,
              'next asset revision',
            ),
            Buffer.from(image.bytes),
            image.mimeType,
            image.contentSha256,
            image.byteLength,
            image.pixelWidth,
            image.pixelHeight,
            image.altText,
            actorEmail,
          ],
        )
        resultAsset = inserted.rows[0] || null
        if (!resultAsset) {
          fail(
            'SUITECRM_PRODUCT_IMAGE_ASSET_SAVE_FAILED',
            'SuiteCRM transformed Product image evidence could not be saved',
            500,
          )
        }
        resolution = 'echo_suppressed'
      } else if (existing?.is_primary) {
        resolution = 'echo_suppressed'
        resultAsset = existing
      } else {
        const makePrimary = !currentPrimary || currentPrimary.source === 'suitecrm_import'
        if (!existing) {
          const nextRevision = await client.query<{ next_revision: string }>(
            `SELECT (COALESCE(max(asset_revision), 0) + 1)::text AS next_revision
             FROM crm_product_image_assets
             WHERE organization_id = $1::uuid
               AND pipeline_id = $2::uuid
               AND product_id = $3::uuid`,
            [input.organizationId, exactProduct.pipeline_id, exactProduct.product_id],
          )
          if (makePrimary && currentPrimary) {
            await client.query(
              `UPDATE crm_product_image_assets
               SET is_primary = false,
                   row_version = row_version + 1,
                   updated_by = $4,
                   updated_at = clock_timestamp()
               WHERE organization_id = $1::uuid
                 AND pipeline_id = $2::uuid
                 AND product_id = $3::uuid
                 AND id = $5::uuid
                 AND is_primary = true`,
              [
                input.organizationId,
                exactProduct.pipeline_id,
                exactProduct.product_id,
                actorEmail,
                currentPrimary.id,
              ],
            )
          }
          const inserted = await client.query<AssetRow>(
            `INSERT INTO crm_product_image_assets (
               organization_id, pipeline_id, product_id, asset_revision,
               content_bytes, mime_type, content_sha256, byte_length,
               pixel_width, pixel_height, alt_text, source, is_primary,
               row_version, created_by, updated_by, created_at, updated_at
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4, $5::bytea, $6, $7, $8,
               $9, $10, $11, 'suitecrm_import', $12, 1, $13, $13,
               clock_timestamp(), clock_timestamp()
             )
             RETURNING id::text, asset_revision::text, row_version::text,
               content_sha256, source, is_primary`,
            [
              input.organizationId,
              exactProduct.pipeline_id,
              exactProduct.product_id,
              positiveInteger(
                nextRevision.rows[0]?.next_revision || 1,
                'next asset revision',
              ),
              Buffer.from(image.bytes),
              image.mimeType,
              image.contentSha256,
              image.byteLength,
              image.pixelWidth,
              image.pixelHeight,
              image.altText,
              makePrimary,
              actorEmail,
            ],
          )
          resultAsset = inserted.rows[0] || null
        } else {
          resultAsset = existing
          if (makePrimary) {
            if (currentPrimary) {
              await client.query(
                `UPDATE crm_product_image_assets
                 SET is_primary = false,
                     row_version = row_version + 1,
                     updated_by = $4,
                     updated_at = clock_timestamp()
                 WHERE organization_id = $1::uuid
                   AND pipeline_id = $2::uuid
                   AND product_id = $3::uuid
                   AND id = $5::uuid
                   AND is_primary = true`,
                [
                  input.organizationId,
                  exactProduct.pipeline_id,
                  exactProduct.product_id,
                  actorEmail,
                  currentPrimary.id,
                ],
              )
            }
            const promoted = await client.query<AssetRow>(
              `UPDATE crm_product_image_assets
               SET is_primary = true,
                   row_version = row_version + 1,
                   updated_by = $5,
                   updated_at = clock_timestamp()
               WHERE organization_id = $1::uuid
                 AND pipeline_id = $2::uuid
                 AND product_id = $3::uuid
                 AND id = $4::uuid
                 AND is_primary = false
               RETURNING id::text, asset_revision::text, row_version::text,
                 content_sha256, source, is_primary`,
              [
                input.organizationId,
                exactProduct.pipeline_id,
                exactProduct.product_id,
                existing.id,
                actorEmail,
              ],
            )
            resultAsset = promoted.rows[0] || resultAsset
          }
        }
        if (!resultAsset) {
          fail(
            'SUITECRM_PRODUCT_IMAGE_ASSET_SAVE_FAILED',
            'SuiteCRM Product image asset could not be saved',
            500,
          )
        }
        promotedToPrimary = makePrimary
        resolution = makePrimary ? 'imported_primary' : 'imported_secondary'
        if (!makePrimary) conflictReason = 'local_primary_has_independent_authority'
      }
    }

    const provenance = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO crm_suitecrm_product_image_asset_provenance (
         organization_id,
         suitecrm_id,
         observation_id,
         pipeline_id,
         product_id,
         resolution,
         conflict_reason,
         local_primary_before_asset_id,
         local_primary_before_revision,
         local_primary_before_row_version,
         local_primary_before_content_sha256,
         result_asset_id,
         result_asset_revision,
         result_asset_content_sha256,
         promoted_to_primary,
         provider_write_count,
         imported_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7,
         $8::uuid, $9, $10, $11, $12::uuid, $13, $14, $15, 0, $16
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        suiteCrmId,
        savedObservation.id,
        exactProduct?.pipeline_id || null,
        exactProduct?.product_id || null,
        resolution,
        conflictReason,
        currentPrimary?.id || null,
        currentPrimary?.asset_revision || null,
        currentPrimary?.row_version || null,
        currentPrimary?.content_sha256 || null,
        resultAsset?.id || null,
        resultAsset?.asset_revision || null,
        resultAsset?.content_sha256 || null,
        promotedToPrimary,
        actorEmail,
      ],
    )
    const savedProvenance = provenance.rows[0]
    if (!savedProvenance) {
      fail(
        'SUITECRM_PRODUCT_IMAGE_PROVENANCE_SAVE_FAILED',
        'SuiteCRM Product image provenance could not be saved',
        500,
      )
    }

    await client.query(
      `INSERT INTO crm_suitecrm_product_image_snapshot_fences (
         organization_id,
         suitecrm_id,
         pipeline_id,
         product_id,
         accepted_suitecrm_modified_at,
         accepted_snapshot_sha256,
         accepted_observation_id,
         fence_revision,
         created_by,
         updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::timestamptz, $6,
         $7::uuid, $8, $9, $9
       )
       ON CONFLICT (organization_id, suitecrm_id) DO UPDATE SET
         pipeline_id = EXCLUDED.pipeline_id,
         product_id = EXCLUDED.product_id,
         accepted_suitecrm_modified_at = EXCLUDED.accepted_suitecrm_modified_at,
         accepted_snapshot_sha256 = EXCLUDED.accepted_snapshot_sha256,
         accepted_observation_id = EXCLUDED.accepted_observation_id,
         fence_revision = EXCLUDED.fence_revision,
         updated_by = EXCLUDED.updated_by`,
      [
        input.organizationId,
        suiteCrmId,
        exactProduct?.pipeline_id || null,
        exactProduct?.product_id || null,
        modifiedAt,
        snapshotSha256,
        savedObservation.id,
        observationRevision,
        actorEmail,
      ],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'crm.product_image.suitecrm_ingested',
      aggregateType: exactProduct
        ? 'crm_product_image_asset'
        : 'suitecrm_product_image_observation',
      aggregateId: resultAsset?.id || savedObservation.id,
      organizationId: input.organizationId,
      eventKey: `suitecrm-product-image-ingested:${savedProvenance.id}`,
      payload: {
        suiteCrmId,
        suiteCrmGlobalId: globalId,
        suiteCrmModifiedAt: modifiedAt,
        observationId: savedObservation.id,
        observationGlobalId: savedObservation.global_id,
        observationRevision,
        provenanceId: savedProvenance.id,
        provenanceGlobalId: savedProvenance.global_id,
        productId: exactProduct?.product_id || null,
        assetId: resultAsset?.id || null,
        contentSha256: resultAsset?.content_sha256 || null,
        resolution,
        conflictReason,
        promotedToPrimary,
        removedSuiteCrmImportedPrimary,
        providerWrites: 0,
      },
    }, client)

    return {
      observationId: savedObservation.id,
      observationGlobalId: savedObservation.global_id,
      provenanceId: savedProvenance.id,
      provenanceGlobalId: savedProvenance.global_id,
      resolution,
      productId: exactProduct?.product_id || null,
      assetId: resultAsset?.id || null,
      contentSha256: resultAsset?.content_sha256 || null,
      promotedToPrimary,
      replayed: false,
    }
  })
}

export async function writeSuiteCrmProductImageIngestionHeartbeatInPostgres(
  input: {
    phase: 'starting' | 'completed' | 'degraded' | 'disabled'
    details?: Record<string, unknown>
  },
) {
  await query(
    `INSERT INTO crm_suitecrm_product_image_ingestion_worker_heartbeat (
       worker_name, checked_at, phase, details
     ) VALUES (
       'suitecrm-product-image-ingestion', clock_timestamp(), $1, $2::jsonb
     )
     ON CONFLICT (worker_name) DO UPDATE SET
       checked_at = EXCLUDED.checked_at,
       phase = EXCLUDED.phase,
       details = EXCLUDED.details`,
    [input.phase, JSON.stringify(input.details || {})],
  )
}

export async function readSuiteCrmProductImageIngestionHealthInPostgres(): Promise<
  SuiteCrmProductImageIngestionHealth
> {
  const result = await query<{
    heartbeat_phase: string | null
    heartbeat_checked_at: Date | string | null
    heartbeat_details: unknown
    observations: number
    imported_primary: number
    imported_secondary: number
    echoes_suppressed: number
    identity_conflicts: number
    media_integrity_conflicts: number
    last_observed_at: Date | string | null
    provider_writes: number
  }>(
    `SELECT
       heartbeat.phase AS heartbeat_phase,
       heartbeat.checked_at AS heartbeat_checked_at,
       heartbeat.details AS heartbeat_details,
       count(provenance.id)::integer AS observations,
       count(*) FILTER (
         WHERE provenance.resolution = 'imported_primary'
       )::integer AS imported_primary,
       count(*) FILTER (
         WHERE provenance.resolution = 'imported_secondary'
       )::integer AS imported_secondary,
       count(*) FILTER (
         WHERE provenance.resolution = 'echo_suppressed'
       )::integer AS echoes_suppressed,
       count(*) FILTER (
         WHERE provenance.resolution = 'identity_conflict'
       )::integer AS identity_conflicts,
       count(*) FILTER (
         WHERE provenance.resolution = 'media_integrity_conflict'
       )::integer AS media_integrity_conflicts,
       max(observation.observed_at) AS last_observed_at,
       COALESCE(sum(provenance.provider_write_count), 0)::integer
         AS provider_writes
     FROM (
       SELECT phase, checked_at, details
       FROM crm_suitecrm_product_image_ingestion_worker_heartbeat
       WHERE worker_name = 'suitecrm-product-image-ingestion'
     ) heartbeat
     FULL JOIN crm_suitecrm_product_image_asset_provenance provenance
       ON true
     LEFT JOIN crm_suitecrm_product_image_observations observation
       ON observation.id = provenance.observation_id
     GROUP BY heartbeat.phase, heartbeat.checked_at, heartbeat.details`,
  )
  const row = result.rows[0]
  const phase = String(row?.heartbeat_phase || '')
  const providerWrites = Number(row?.provider_writes || 0)
  if (providerWrites !== 0) {
    fail(
      'SUITECRM_PRODUCT_IMAGE_PROVIDER_WRITE_DETECTED',
      'SuiteCRM Product image ingestion recorded a provider write',
      500,
    )
  }
  return {
    heartbeat: row?.heartbeat_checked_at && [
      'starting', 'completed', 'degraded', 'disabled',
    ].includes(phase) ? {
        phase: phase as 'starting' | 'completed' | 'degraded' | 'disabled',
        checkedAt: new Date(row.heartbeat_checked_at).toISOString(),
        details: row.heartbeat_details
          && typeof row.heartbeat_details === 'object'
          && !Array.isArray(row.heartbeat_details)
          ? row.heartbeat_details as Record<string, unknown>
          : {},
      } : null,
    observations: Number(row?.observations || 0),
    importedPrimary: Number(row?.imported_primary || 0),
    importedSecondary: Number(row?.imported_secondary || 0),
    echoesSuppressed: Number(row?.echoes_suppressed || 0),
    identityConflicts: Number(row?.identity_conflicts || 0),
    mediaIntegrityConflicts: Number(row?.media_integrity_conflicts || 0),
    lastObservedAt: row?.last_observed_at
      ? new Date(row.last_observed_at).toISOString()
      : null,
    providerWrites: 0,
  }
}
