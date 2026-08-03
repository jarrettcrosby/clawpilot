import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  CRM_PRODUCT_IMAGE_MAX_BYTES,
  validateCrmProductImage,
  type CrmProductImageMimeType,
} from '@/lib/crm/productImageAssets'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'
import {
  enqueueSuiteCrmProductImageProjectionWithClient,
} from '@/lib/persistence/suiteCrmProductImageProjection'

export type CommerceProductImageProvider = 'shopify' | 'faire'
export type CommerceProductImageLifecycle = 'active' | 'removed'
export type CommerceProductImageImportJobState =
  | 'waiting_mapping'
  | 'queued'
  | 'claimed'
  | 'retry'
  | 'succeeded'
  | 'dead'
  | 'cancelled'

export class CommerceProductImageImportError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'CommerceProductImageImportError'
    this.code = code
    this.status = status
  }
}

export type CommerceProductImageObservationReceipt = {
  observationId: string
  observationGlobalId: string
  observationRevision: number
  imageIdentitySha256: string
  jobId: string
  jobGlobalId: string
  jobState: CommerceProductImageImportJobState
  waitReason: string | null
  productId: string | null
  replayed: boolean
}

export type RecordCommerceProductImageObservationInput = {
  organizationId: string
  integrationAccountId: string
  provider: CommerceProductImageProvider
  credentialGeneration: number
  externalProductId: string
  providerImageId?: string | null
  locatorSha256: string
  sequence: number
  altText?: string | null
  pixelWidth?: number | null
  pixelHeight?: number | null
  lifecycle: CommerceProductImageLifecycle
  sourceHash: string
  providerUpdatedAt?: Date | string | null
  observedAt: Date | string
  actorEmail: string
  maxAttempts?: number
}

export type CommerceProductImageImportClaim = {
  jobId: string
  jobGlobalId: string
  observationId: string
  observationGlobalId: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  provider: CommerceProductImageProvider
  credentialGeneration: number
  externalProductId: string
  providerImageId: string | null
  imageIdentitySha256: string
  locatorSha256: string
  sourceHash: string
  sequence: number
  altText: string
  expectedPixelWidth: number | null
  expectedPixelHeight: number | null
  pipelineId: string
  productId: string
  productMappingId: string
  mappingCount: number
  mappingFingerprintSha256: string
  attemptCount: number
  maxAttempts: number
  leaseToken: string
  leaseExpiresAt: string
  actorEmail: string
}

export type CommerceProductImageImportCompletion = {
  jobId: string
  jobGlobalId: string
  assetId: string
  assetRevision: number
  assetContentSha256: string
  provenanceId: string
  provenanceGlobalId: string
  reusedAsset: boolean
  isPrimary: boolean
  targetCount: number
  replayed: boolean
}

export type CommerceProductImageImportWorkerPhase =
  | 'starting'
  | 'completed'
  | 'degraded'

export type CommerceProductImageImportQueueHealth = {
  waitingMappingCount: number
  queuedCount: number
  retryCount: number
  claimedCount: number
  deadCount: number
  historicalDeadCount: number
  staleLeaseCount: number
  overdueCount: number
  heartbeat: {
    phase: CommerceProductImageImportWorkerPhase
    checkedAt: string
  } | null
}

type ObservationRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  provider: CommerceProductImageProvider
  credential_generation: number
  observation_set_id: string
  external_product_id: string
  provider_image_id: string | null
  locator_sha256: string
  image_identity_sha256: string
  image_sequence: number
  alt_text: string | null
  pixel_width: number | null
  pixel_height: number | null
  lifecycle_state: CommerceProductImageLifecycle
  source_hash: string
  observation_revision: string | number
  provider_updated_at: Date | string | null
  observed_at: Date | string
}

type JobRow = QueryResultRow & {
  id: string
  global_id: string
  job_generation: number
  organization_id: string
  integration_account_id: string
  provider: CommerceProductImageProvider
  credential_generation: number
  observation_id: string
  observation_revision: string | number
  external_product_id: string
  image_identity_sha256: string
  locator_sha256: string
  observation_source_hash: string
  pipeline_id: string | null
  product_id: string | null
  product_mapping_id: string | null
  mapping_count: number | null
  mapping_fingerprint_sha256: string | null
  activation_revision: number | null
  asset_alt_text: string | null
  state: CommerceProductImageImportJobState
  wait_reason: string | null
  last_error_code: string | null
  attempt_count: number
  max_attempts: number
  lease_token: string | null
  lease_expires_at: Date | string | null
  result_asset_id: string | null
  result_content_sha256: string | null
  created_by: string
}

type MappingResolutionRow = QueryResultRow & {
  resolution_count: number
  pipeline_id: string | null
  product_id: string | null
  canonical_product_mapping_id: string | null
  mapping_count: number | null
  mapping_fingerprint_sha256: string | null
  activation_revision: number | null
  product_name: string | null
}

type MappingTargetRow = QueryResultRow & {
  pipeline_id: string
  product_id: string
  canonical_product_mapping_id: string
  target_mapping_count: number
  target_mapping_fingerprint_sha256: string
  activation_revision: number
  product_name: string
  mapping_count: number
  mapping_fingerprint_sha256: string
}

type CommerceProductImageMappingTarget = {
  pipelineId: string
  productId: string
  productMappingId: string
  targetMappingCount: number
  targetMappingFingerprintSha256: string
  activationRevision: number
  assetAltText: string
}

type ImageBindingRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  provider: CommerceProductImageProvider
  credential_generation: number
  external_product_id: string
  image_identity_sha256: string
  provider_image_id: string | null
  locator_sha256: string
  latest_observation_id: string
  latest_observation_revision: string | number
  latest_observation_set_id: string
  latest_import_job_id: string
  latest_import_job_generation: number
  provider_sequence: number
  effective_alt_text: string
  pipeline_id: string
  product_id: string
  activation_revision: number
  asset_id: string
  lifecycle_state: 'active' | 'inactive'
  row_version: string | number
}

const HASH_PATTERN = /^[0-9a-f]{64}$/
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,99}$/
const COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES = 16 * 1024 * 1024
const MAX_EXACT_IMAGE_FANOUT_TARGETS = 50
const COMMERCE_PROVIDER_IMAGE_NORMALIZATION_PATTERN =
  /^sharp-0\.35\.3-webp-auto-orient-v1-q(?:82|72|62|52|42|32)$/

type CommerceProviderImageSourceEvidence = {
  sourceByteLength: number
  sourceContentSha256: string
  normalizationVersion: string
}

function fail(code: string, message: string, status = 400): never {
  throw new CommerceProductImageImportError(code, message, status)
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
      `Stored commerce product image ${label} is invalid`,
      500,
    )
  }
  return parsed
}

function nonnegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
      `Stored commerce product image ${label} is invalid`,
      500,
    )
  }
  return parsed
}

function iso(value: Date | string, label: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
      `Stored commerce product image ${label} is invalid`,
      500,
    )
  }
  return parsed.toISOString()
}

function requiredTrimmed(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', `${label} is required`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', `${label} is invalid`)
  }
  return trimmed
}

function requiredHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', `${label} must be a lowercase SHA-256 digest`)
  }
  return value
}

function validatedSourceEvidence(
  input: {
    sourceByteLength: unknown
    sourceContentSha256: unknown
    normalizationVersion: unknown
  },
  image: ReturnType<typeof validateCrmProductImage>,
): CommerceProviderImageSourceEvidence {
  const sourceByteLength = Number(input.sourceByteLength)
  const sourceContentSha256 = requiredHash(
    input.sourceContentSha256,
    'Provider source content hash',
  )
  const normalizationVersion = requiredTrimmed(
    input.normalizationVersion,
    'Provider image normalization version',
    64,
  )
  const sourceLengthValid = Number.isSafeInteger(sourceByteLength)
    && sourceByteLength >= 1
    && sourceByteLength <= COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES
  const identity = normalizationVersion === 'identity-v1'
    && sourceByteLength === image.byteLength
    && sourceContentSha256 === image.contentSha256
  const normalized = COMMERCE_PROVIDER_IMAGE_NORMALIZATION_PATTERN.test(
    normalizationVersion,
  )
    && sourceByteLength > CRM_PRODUCT_IMAGE_MAX_BYTES
    && sourceContentSha256 !== image.contentSha256
    && image.mimeType === 'image/webp'
  if (!sourceLengthValid || (!identity && !normalized)) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_SOURCE_EVIDENCE_INVALID',
      'Provider image source and stored-content evidence do not match',
      409,
    )
  }
  return {
    sourceByteLength,
    sourceContentSha256,
    normalizationVersion,
  }
}

function optionalInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8192) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', `${label} is invalid`)
  }
  return parsed
}

function sourceTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' && !(value instanceof Date)) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', `${label} is required`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', `${label} is invalid`)
  }
  return parsed.toISOString()
}

export function commerceProductImageIdentitySha256(input: {
  providerImageId?: string | null
  locatorSha256: string
}): string {
  const locatorSha256 = requiredHash(input.locatorSha256, 'Image locator fingerprint')
  const providerImageId = input.providerImageId === null
    || input.providerImageId === undefined
    ? null
    : requiredTrimmed(input.providerImageId, 'Provider image ID', 512)
  if (providerImageId && /https?:\/\//iu.test(providerImageId)) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_RAW_LOCATOR_FORBIDDEN',
      'Provider image ID must not contain a raw URL',
    )
  }
  return createHash('sha256').update(
    providerImageId
      ? `provider-id:${providerImageId}`
      : `locator-sha256:${locatorSha256}`,
    'utf8',
  ).digest('hex')
}

function normalizeObservationInput(
  input: RecordCommerceProductImageObservationInput,
) {
  if (!['shopify', 'faire'].includes(input.provider)) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Commerce provider is invalid')
  }
  if (!['active', 'removed'].includes(input.lifecycle)) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Image lifecycle is invalid')
  }
  const credentialGeneration = Number(input.credentialGeneration)
  if (!Number.isSafeInteger(credentialGeneration) || credentialGeneration < 1) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Credential generation is invalid')
  }
  const sequence = Number(input.sequence)
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 10000) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Image sequence is invalid')
  }
  const pixelWidth = optionalInteger(input.pixelWidth, 'Image width')
  const pixelHeight = optionalInteger(input.pixelHeight, 'Image height')
  if ((pixelWidth === null) !== (pixelHeight === null)) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_INPUT_INVALID',
      'Image dimensions must both be present or both be absent',
    )
  }
  if (pixelWidth !== null && pixelHeight !== null && pixelWidth * pixelHeight > 40_000_000) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Image dimensions are too large')
  }
  const providerImageId = input.providerImageId === null
    || input.providerImageId === undefined
    ? null
    : requiredTrimmed(input.providerImageId, 'Provider image ID', 512)
  const locatorSha256 = requiredHash(input.locatorSha256, 'Image locator fingerprint')
  const maxAttempts = input.maxAttempts ?? 5
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Maximum import attempts are invalid')
  }
  const altText = input.altText === null || input.altText === undefined
    ? null
    : requiredTrimmed(input.altText, 'Image alt text', 500)
  return {
    organizationId: requiredTrimmed(input.organizationId, 'Organization ID', 64),
    integrationAccountId: requiredTrimmed(input.integrationAccountId, 'Integration account ID', 64),
    provider: input.provider,
    credentialGeneration,
    externalProductId: requiredTrimmed(input.externalProductId, 'External product ID', 512),
    providerImageId,
    locatorSha256,
    imageIdentitySha256: commerceProductImageIdentitySha256({
      providerImageId,
      locatorSha256,
    }),
    sequence,
    altText,
    pixelWidth,
    pixelHeight,
    lifecycle: input.lifecycle,
    sourceHash: requiredHash(input.sourceHash, 'Image source hash'),
    providerUpdatedAt: input.providerUpdatedAt === null
      || input.providerUpdatedAt === undefined
      ? null
      : sourceTimestamp(input.providerUpdatedAt, 'Provider update timestamp'),
    observedAt: sourceTimestamp(input.observedAt, 'Observation timestamp'),
    actorEmail: requiredTrimmed(input.actorEmail, 'Actor email', 255),
    maxAttempts,
  }
}

async function mappingResolution(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    provider: CommerceProductImageProvider
    externalProductId: string
  },
): Promise<MappingResolutionRow> {
  const result = await client.query<MappingResolutionRow>(
    `SELECT *
     FROM operations_commerce_product_image_mapping_resolution(
       $1::uuid, $2::uuid, $3, $4
     )`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.provider,
      input.externalProductId,
    ],
  )
  const row = result.rows[0]
  if (!row || !Number.isSafeInteger(row.resolution_count) || row.resolution_count < 0) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_MAPPING_EVIDENCE_CORRUPT',
      'Commerce product image mapping resolution is invalid',
      500,
    )
  }
  return row
}

function mappedJobValues(
  resolution: MappingResolutionRow,
  observation: Pick<ObservationRow, 'alt_text'>,
) {
  if (
    resolution.resolution_count !== 1
    || !resolution.pipeline_id
    || !resolution.product_id
    || !resolution.canonical_product_mapping_id
    || !resolution.mapping_count
    || !resolution.mapping_fingerprint_sha256
    || !HASH_PATTERN.test(resolution.mapping_fingerprint_sha256)
    || !resolution.activation_revision
    || !resolution.product_name?.trim()
  ) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_MAPPING_EVIDENCE_CORRUPT',
      'Resolved commerce product image mapping is incomplete',
      500,
    )
  }
  const fallbackAlt = resolution.product_name.trim().slice(0, 500)
  return {
    pipelineId: resolution.pipeline_id,
    productId: resolution.product_id,
    productMappingId: resolution.canonical_product_mapping_id,
    mappingCount: positiveInteger(resolution.mapping_count, 'mapping count'),
    mappingFingerprintSha256: resolution.mapping_fingerprint_sha256,
    activationRevision: positiveInteger(
      resolution.activation_revision,
      'activation revision',
    ),
    assetAltText: observation.alt_text?.trim() || fallbackAlt,
  }
}

async function currentMappingTargets(
  client: PoolClient,
  job: JobRow,
  observation: Pick<ObservationRow, 'alt_text'>,
): Promise<CommerceProductImageMappingTarget[]> {
  if (
    !job.pipeline_id
    || !job.product_id
    || !job.product_mapping_id
    || !job.mapping_count
    || !job.mapping_fingerprint_sha256
    || !job.activation_revision
  ) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_MAPPING_EVIDENCE_CORRUPT',
      'Mapped commerce product image job is incomplete',
      500,
    )
  }
  const result = await client.query<MappingTargetRow>(
    `SELECT
       target.pipeline_id::text,
       target.product_id::text,
       target.canonical_product_mapping_id::text,
       target.target_mapping_count,
       target.target_mapping_fingerprint_sha256,
       target.activation_revision,
       target.product_name,
       target.mapping_count,
       target.mapping_fingerprint_sha256
     FROM operations_commerce_product_image_mapping_targets(
       $1::uuid, $2::uuid, $3, $4
     ) target
     WHERE target.pipeline_id = $5::uuid
       AND target.activation_revision = $6
       AND target.mapping_count = $7
       AND target.mapping_fingerprint_sha256 = $8
     ORDER BY
       target.product_id::text,
       target.canonical_product_mapping_id::text
     LIMIT $9`,
    [
      job.organization_id,
      job.integration_account_id,
      job.provider,
      job.external_product_id,
      job.pipeline_id,
      job.activation_revision,
      job.mapping_count,
      job.mapping_fingerprint_sha256,
      MAX_EXACT_IMAGE_FANOUT_TARGETS + 1,
    ],
  )
  if (result.rows.length > MAX_EXACT_IMAGE_FANOUT_TARGETS) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_FANOUT_REVIEW_REQUIRED',
      `Product image fan-out exceeds the ${MAX_EXACT_IMAGE_FANOUT_TARGETS}-Product safety limit`,
      409,
    )
  }
  if (result.rows.length === 0 || result.rows.length > job.mapping_count) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_MAPPING_EVIDENCE_CORRUPT',
      'Exact commerce product image fan-out targets are incomplete',
      500,
    )
  }
  const targets = result.rows.map((row) => {
    if (
      row.pipeline_id !== job.pipeline_id
      || row.mapping_count !== job.mapping_count
      || row.mapping_fingerprint_sha256 !== job.mapping_fingerprint_sha256
      || row.activation_revision !== job.activation_revision
      || !row.product_id
      || !row.canonical_product_mapping_id
      || !Number.isSafeInteger(row.target_mapping_count)
      || row.target_mapping_count < 1
      || !HASH_PATTERN.test(row.target_mapping_fingerprint_sha256)
      || !row.product_name?.trim()
    ) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_MAPPING_EVIDENCE_CORRUPT',
        'Exact commerce product image fan-out target is invalid',
        500,
      )
    }
    return {
      pipelineId: row.pipeline_id,
      productId: row.product_id,
      productMappingId: row.canonical_product_mapping_id,
      targetMappingCount: row.target_mapping_count,
      targetMappingFingerprintSha256:
        row.target_mapping_fingerprint_sha256,
      activationRevision: row.activation_revision,
      assetAltText: observation.alt_text?.trim()
        || row.product_name.trim().slice(0, 500),
    }
  })
  const productIds = new Set(targets.map((target) => target.productId))
  if (
    productIds.size !== targets.length
    || targets[0]?.productId !== job.product_id
    || targets[0]?.productMappingId !== job.product_mapping_id
    || targets.reduce(
      (total, target) => total + target.targetMappingCount,
      0,
    ) !== job.mapping_count
  ) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_MAPPING_EVIDENCE_CORRUPT',
      'Exact commerce product image fan-out does not match the canonical job fence',
      500,
    )
  }
  return targets
}

async function selectObservation(
  client: PoolClient,
  observationId: string,
): Promise<ObservationRow> {
  const result = await client.query<ObservationRow>(
    `SELECT
       id::text,
       global_id,
       organization_id::text,
       integration_account_id::text,
       provider,
       credential_generation,
       observation_set_id::text,
       external_product_id,
       provider_image_id,
       locator_sha256,
       image_identity_sha256,
       image_sequence,
       alt_text,
       pixel_width,
       pixel_height,
       lifecycle_state,
       source_hash,
       observation_revision::text,
       provider_updated_at,
       observed_at
     FROM operations_commerce_product_image_observations
     WHERE id = $1::uuid
     LIMIT 1`,
    [observationId],
  )
  if (!result.rows[0]) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_OBSERVATION_NOT_FOUND',
      'Commerce product image observation was not found',
      404,
    )
  }
  return result.rows[0]
}

async function selectJob(
  client: PoolClient,
  organizationId: string,
  jobId: string,
  lock = false,
): Promise<JobRow> {
  const result = await client.query<JobRow>(
    `SELECT
       id::text,
       global_id,
       job_generation,
       organization_id::text,
       integration_account_id::text,
       provider,
       credential_generation,
       observation_id::text,
       observation_revision::text,
       external_product_id,
       image_identity_sha256,
       locator_sha256,
       observation_source_hash,
       pipeline_id::text,
       product_id::text,
       product_mapping_id::text,
       mapping_count,
       mapping_fingerprint_sha256,
       activation_revision,
       asset_alt_text,
       state,
       wait_reason,
       last_error_code,
       attempt_count,
       max_attempts,
       lease_token::text,
       lease_expires_at,
       result_asset_id::text,
       result_content_sha256,
       created_by
     FROM operations_commerce_product_image_import_jobs
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
     LIMIT 1
     ${lock ? 'FOR UPDATE' : ''}`,
    [organizationId, jobId],
  )
  if (!result.rows[0]) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_JOB_NOT_FOUND',
      'Commerce product image import job was not found',
      404,
    )
  }
  return result.rows[0]
}

async function observationIsLatestActiveEvidence(
  client: PoolClient,
  organizationId: string,
  observationId: string,
): Promise<boolean> {
  const result = await client.query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM operations_commerce_product_image_observations observation
       WHERE observation.organization_id = $1::uuid
         AND observation.id = $2::uuid
         AND observation.lifecycle_state = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM operations_commerce_product_image_observations later
           WHERE later.organization_id = observation.organization_id
             AND later.integration_account_id =
                   observation.integration_account_id
             AND later.credential_generation =
                   observation.credential_generation
             AND later.external_product_id = observation.external_product_id
             AND later.image_identity_sha256 =
                   observation.image_identity_sha256
             AND later.observation_revision >
                   observation.observation_revision
         )
     ) AS current`,
    [organizationId, observationId],
  )
  return result.rows[0]?.current === true
}

async function accountCredentialIsCurrent(
  client: PoolClient,
  job: JobRow,
): Promise<boolean> {
  const result = await client.query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.external_account_id = account.external_account_id
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.integration_type = 'commerce'
         AND account.provider = $3
         AND account.status = 'active'
         AND account.commerce_credential_generation = $4
         AND credential.credential_version = $4
         AND credential.verification_status = 'verified'
     ) AS current`,
    [
      job.organization_id,
      job.integration_account_id,
      job.provider,
      job.credential_generation,
    ],
  )
  return result.rows[0]?.current === true
}

async function jobFencesAreCurrent(
  client: PoolClient,
  organizationId: string,
  jobId: string,
): Promise<boolean> {
  const result = await client.query<{ current: boolean }>(
    `SELECT operations_commerce_product_image_job_fences_are_current(
       $1::uuid, $2::uuid
     ) AS current`,
    [organizationId, jobId],
  )
  return result.rows[0]?.current === true
}

async function cancelJob(
  client: PoolClient,
  job: JobRow,
  errorCode:
    | 'IMAGE_REMOVED'
    | 'SOURCE_SUPERSEDED'
    | 'CREDENTIAL_STALE'
    | 'MAPPING_CHANGED',
  updatedBy: string,
) {
  await client.query(
    `UPDATE operations_commerce_product_image_import_jobs
     SET state = 'cancelled',
         wait_reason = NULL,
         lease_token = NULL,
         claimed_by = NULL,
         claimed_at = NULL,
         lease_expires_at = NULL,
         last_error_code = $3,
         completed_at = clock_timestamp(),
         updated_by = $4
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND state NOT IN ('succeeded', 'dead', 'cancelled')`,
    [job.organization_id, job.id, errorCode, updatedBy],
  )
}

async function recoverJobToWaitingMapping(
  client: PoolClient,
  job: JobRow,
  updatedBy: string,
): Promise<boolean> {
  if (!await observationIsLatestActiveEvidence(
    client,
    job.organization_id,
    job.observation_id,
  ) || !await accountCredentialIsCurrent(client, job)) return false
  await client.query(
    `UPDATE operations_commerce_product_image_import_jobs
     SET pipeline_id = NULL,
         product_id = NULL,
         product_mapping_id = NULL,
         mapping_count = NULL,
         mapping_fingerprint_sha256 = NULL,
         activation_revision = NULL,
         asset_alt_text = NULL,
         state = 'waiting_mapping',
         wait_reason = 'mapping_changed',
         lease_token = NULL,
         claimed_by = NULL,
         claimed_at = NULL,
         lease_expires_at = NULL,
         last_error_code = NULL,
         completed_at = NULL,
         available_at = clock_timestamp(),
         updated_by = $3
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND state IN ('queued', 'retry', 'claimed')`,
    [job.organization_id, job.id, updatedBy],
  )
  return true
}

async function bindWaitingJob(
  client: PoolClient,
  job: JobRow,
  observation: ObservationRow,
  updatedBy: string,
): Promise<JobRow> {
  if (job.state !== 'waiting_mapping') return job
  if (!await observationIsLatestActiveEvidence(
    client,
    job.organization_id,
    job.observation_id,
  )) {
    await cancelJob(client, job, 'SOURCE_SUPERSEDED', updatedBy)
    return selectJob(client, job.organization_id, job.id)
  }
  if (!await accountCredentialIsCurrent(client, job)) {
    await cancelJob(client, job, 'CREDENTIAL_STALE', updatedBy)
    return selectJob(client, job.organization_id, job.id)
  }
  const resolution = await mappingResolution(client, {
    organizationId: job.organization_id,
    integrationAccountId: job.integration_account_id,
    provider: job.provider,
    externalProductId: job.external_product_id,
  })
  if (resolution.resolution_count !== 1) return job
  const mapping = mappedJobValues(resolution, observation)
  if (job.attempt_count >= job.max_attempts) {
    await cancelJob(client, job, 'MAPPING_CHANGED', updatedBy)
    return createCommerceProductImageSuccessorJob(client, {
      priorJob: await selectJob(client, job.organization_id, job.id, true),
      actorEmail: job.created_by,
      auditActor: updatedBy,
      auditReason: 'mapping_changed',
    })
  }
  const result = await client.query<JobRow>(
    `UPDATE operations_commerce_product_image_import_jobs
     SET pipeline_id = $3::uuid,
         product_id = $4::uuid,
         product_mapping_id = $5::uuid,
         mapping_count = $6,
         mapping_fingerprint_sha256 = $7,
         activation_revision = $8,
         asset_alt_text = $9,
         state = 'queued',
         wait_reason = NULL,
         available_at = clock_timestamp(),
         last_error_code = NULL,
         updated_by = $10
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND state = 'waiting_mapping'
     RETURNING *`,
    [
      job.organization_id,
      job.id,
      mapping.pipelineId,
      mapping.productId,
      mapping.productMappingId,
      mapping.mappingCount,
      mapping.mappingFingerprintSha256,
      mapping.activationRevision,
      mapping.assetAltText,
      updatedBy,
    ],
  )
  return result.rows[0] || selectJob(client, job.organization_id, job.id)
}

async function createCommerceProductImageSuccessorJob(
  client: PoolClient,
  input: {
    priorJob: JobRow
    actorEmail: string
    auditActor?: string
    auditReason: 'mapping_changed' | 'operator_retry'
    operatorReason?: string | null
  },
): Promise<JobRow> {
  const priorJob = input.priorJob
  if (!(
    ['succeeded', 'dead'].includes(priorJob.state)
    || (
      priorJob.state === 'cancelled'
      && input.auditReason === 'mapping_changed'
      && priorJob.last_error_code === 'MAPPING_CHANGED'
    )
  )) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_SUCCESSOR_NOT_ALLOWED',
      'This terminal image import cannot create the requested successor',
      409,
    )
  }
  if (!await observationIsLatestActiveEvidence(
    client,
    priorJob.organization_id,
    priorJob.observation_id,
  ) || !await accountCredentialIsCurrent(client, priorJob)) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_SUCCESSOR_FENCE_STALE',
      'Image import successor requires current source and credential evidence',
      409,
    )
  }
  const generationRows = await client.query<JobRow>(
    `SELECT *
     FROM operations_commerce_product_image_import_jobs
     WHERE organization_id = $1::uuid
       AND observation_id = $2::uuid
     ORDER BY job_generation
     FOR UPDATE`,
    [priorJob.organization_id, priorJob.observation_id],
  )
  if (generationRows.rows.some((job) => ![
    'succeeded', 'dead', 'cancelled',
  ].includes(job.state))) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_SUCCESSOR_ALREADY_ACTIVE',
      'This image observation already has active import work',
      409,
    )
  }
  const latest = generationRows.rows.at(-1)
  if (!latest || latest.id !== priorJob.id) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_SUCCESSOR_CONFLICT',
      'A newer image import generation already exists',
      409,
    )
  }
  const observation = await selectObservation(client, priorJob.observation_id)
  const resolution = await mappingResolution(client, {
    organizationId: priorJob.organization_id,
    integrationAccountId: priorJob.integration_account_id,
    provider: priorJob.provider,
    externalProductId: priorJob.external_product_id,
  })
  const mapping = resolution.resolution_count === 1
    ? mappedJobValues(resolution, observation)
    : null
  const state: CommerceProductImageImportJobState = mapping
    ? 'queued'
    : 'waiting_mapping'
  const waitReason = state === 'waiting_mapping'
    ? resolution.resolution_count === 0 ? 'unmapped' : 'ambiguous_mapping'
    : null
  const generation = positiveInteger(
    latest.job_generation,
    'prior job generation',
  ) + 1
  const inserted = await client.query<JobRow>(
    `INSERT INTO operations_commerce_product_image_import_jobs (
       job_generation,
       organization_id,
       integration_account_id,
       provider,
       credential_generation,
       observation_id,
       observation_revision,
       external_product_id,
       image_identity_sha256,
       locator_sha256,
       observation_source_hash,
       pipeline_id,
       product_id,
       product_mapping_id,
       mapping_count,
       mapping_fingerprint_sha256,
       activation_revision,
       asset_alt_text,
       state,
       wait_reason,
       max_attempts,
       created_by,
       updated_by
     ) VALUES (
       $1, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, $8, $9, $10,
       $11, $12::uuid, $13::uuid, $14::uuid, $15, $16, $17, $18,
       $19, $20, $21, $22, $22
     )
     RETURNING *`,
    [
      generation,
      priorJob.organization_id,
      priorJob.integration_account_id,
      priorJob.provider,
      priorJob.credential_generation,
      priorJob.observation_id,
      priorJob.observation_revision,
      priorJob.external_product_id,
      priorJob.image_identity_sha256,
      priorJob.locator_sha256,
      priorJob.observation_source_hash,
      mapping?.pipelineId || null,
      mapping?.productId || null,
      mapping?.productMappingId || null,
      mapping?.mappingCount || null,
      mapping?.mappingFingerprintSha256 || null,
      mapping?.activationRevision || null,
      mapping?.assetAltText || null,
      state,
      waitReason,
      priorJob.max_attempts,
      input.actorEmail,
    ],
  )
  const successor = inserted.rows[0]
  if (!successor) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_SUCCESSOR_SAVE_FAILED',
      'Image import successor could not be saved',
      500,
    )
  }
  await recordAuditEvent({
    actor: input.auditActor || input.actorEmail,
    eventType: 'operations.commerce_product_image_import.successor_created',
    aggregateType: 'operations_commerce_product_image_import_job',
    aggregateId: successor.global_id,
    organizationId: successor.organization_id,
    eventKey: `commerce-product-image-successor:${successor.global_id}`,
    payload: {
      priorJobGlobalId: priorJob.global_id,
      successorJobGlobalId: successor.global_id,
      observationId: successor.observation_id,
      jobGeneration: generation,
      reason: input.auditReason,
      operatorReason: input.operatorReason || null,
      state: successor.state,
      pipelineId: successor.pipeline_id,
      productId: successor.product_id,
      activationRevision: successor.activation_revision,
      requestedActorEmail: input.actorEmail,
      providerWrites: 0,
    },
  }, client)
  return successor
}

async function recordCommerceProductImageObservationWithClient(
  input: RecordCommerceProductImageObservationInput,
  client: PoolClient,
  observationSetId: string,
): Promise<CommerceProductImageObservationReceipt> {
  const normalized = normalizeObservationInput(input)
  {
    const inserted = await client.query<ObservationRow>(
      `INSERT INTO operations_commerce_product_image_observations (
         organization_id,
         integration_account_id,
         provider,
         credential_generation,
         external_product_id,
         provider_image_id,
         locator_sha256,
         image_identity_sha256,
         image_sequence,
         alt_text,
         pixel_width,
         pixel_height,
         lifecycle_state,
         source_hash,
         provider_updated_at,
         observed_at,
         observation_set_id,
         created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15::timestamptz,
         $16::timestamptz, $17::uuid, $18
       )
       ON CONFLICT (
         organization_id,
         integration_account_id,
         credential_generation,
         external_product_id,
         image_identity_sha256,
         lifecycle_state,
         source_hash
       ) DO NOTHING
       RETURNING *`,
      [
        normalized.organizationId,
        normalized.integrationAccountId,
        normalized.provider,
        normalized.credentialGeneration,
        normalized.externalProductId,
        normalized.providerImageId,
        normalized.locatorSha256,
        normalized.imageIdentitySha256,
        normalized.sequence,
        normalized.altText,
        normalized.pixelWidth,
        normalized.pixelHeight,
        normalized.lifecycle,
        normalized.sourceHash,
        normalized.providerUpdatedAt,
        normalized.observedAt,
        observationSetId,
        normalized.actorEmail,
      ],
    )
    const replayed = inserted.rowCount === 0
    let observation = inserted.rows[0]
    if (!observation) {
      const existing = await client.query<ObservationRow>(
        `SELECT *
         FROM operations_commerce_product_image_observations
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND credential_generation = $3
           AND external_product_id = $4
           AND image_identity_sha256 = $5
           AND lifecycle_state = $6
           AND source_hash = $7
         LIMIT 1
         FOR SHARE`,
        [
          normalized.organizationId,
          normalized.integrationAccountId,
          normalized.credentialGeneration,
          normalized.externalProductId,
          normalized.imageIdentitySha256,
          normalized.lifecycle,
          normalized.sourceHash,
        ],
      )
      observation = existing.rows[0]
      if (!observation) {
        fail(
          'COMMERCE_PRODUCT_IMAGE_OBSERVATION_SAVE_FAILED',
          'Commerce product image observation could not be saved',
          500,
        )
      }
      if (
        observation.provider !== normalized.provider
        || observation.provider_image_id !== normalized.providerImageId
        || observation.locator_sha256 !== normalized.locatorSha256
        || observation.image_sequence !== normalized.sequence
        || observation.alt_text !== normalized.altText
        || observation.pixel_width !== normalized.pixelWidth
        || observation.pixel_height !== normalized.pixelHeight
      ) {
        fail(
          'COMMERCE_PRODUCT_IMAGE_SOURCE_HASH_COLLISION',
          'Image source hash was reused for different immutable metadata',
          409,
        )
      }
    }

    let jobResult = await client.query<JobRow>(
      `SELECT *
       FROM operations_commerce_product_image_import_jobs
       WHERE organization_id = $1::uuid
         AND observation_id = $2::uuid
       ORDER BY job_generation DESC
       LIMIT 1
       FOR UPDATE`,
      [normalized.organizationId, observation.id],
    )

    if (!jobResult.rows[0]) {
      await client.query(
        `UPDATE operations_commerce_product_image_import_jobs
         SET state = 'cancelled',
             wait_reason = NULL,
             lease_token = NULL,
             claimed_by = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             last_error_code = 'SOURCE_SUPERSEDED',
             completed_at = clock_timestamp(),
             updated_by = $7
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND credential_generation = $3
           AND external_product_id = $4
           AND image_identity_sha256 = $5
           AND observation_id <> $6::uuid
           AND state NOT IN ('succeeded', 'dead', 'cancelled')`,
        [
          normalized.organizationId,
          normalized.integrationAccountId,
          normalized.credentialGeneration,
          normalized.externalProductId,
          normalized.imageIdentitySha256,
          observation.id,
          normalized.actorEmail,
        ],
      )

      const resolution = normalized.lifecycle === 'active'
        ? await mappingResolution(client, normalized)
        : null
      const mapping = resolution?.resolution_count === 1
        ? mappedJobValues(resolution, observation)
        : null
      const state: CommerceProductImageImportJobState = normalized.lifecycle === 'removed'
        ? 'cancelled'
        : mapping
          ? 'queued'
          : 'waiting_mapping'
      const waitReason = state === 'waiting_mapping'
        ? resolution?.resolution_count === 0
          ? 'unmapped'
          : 'ambiguous_mapping'
        : null
      const errorCode = state === 'cancelled' ? 'IMAGE_REMOVED' : null
      jobResult = await client.query<JobRow>(
        `INSERT INTO operations_commerce_product_image_import_jobs (
           organization_id,
           integration_account_id,
           provider,
           credential_generation,
           observation_id,
           observation_revision,
           external_product_id,
           image_identity_sha256,
           locator_sha256,
           observation_source_hash,
           pipeline_id,
           product_id,
           product_mapping_id,
           mapping_count,
           mapping_fingerprint_sha256,
           activation_revision,
           asset_alt_text,
           state,
           wait_reason,
           max_attempts,
           last_error_code,
           completed_at,
           created_by,
           updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::bigint,
           $7, $8, $9, $10, $11::uuid, $12::uuid, $13::uuid,
           $14, $15, $16, $17, $18, $19, $20, $21,
           CASE WHEN $18 = 'cancelled' THEN clock_timestamp() ELSE NULL END,
           $22, $22
         )
         RETURNING *`,
        [
          normalized.organizationId,
          normalized.integrationAccountId,
          normalized.provider,
          normalized.credentialGeneration,
          observation.id,
          observation.observation_revision,
          normalized.externalProductId,
          normalized.imageIdentitySha256,
          normalized.locatorSha256,
          normalized.sourceHash,
          mapping?.pipelineId || null,
          mapping?.productId || null,
          mapping?.productMappingId || null,
          mapping?.mappingCount || null,
          mapping?.mappingFingerprintSha256 || null,
          mapping?.activationRevision || null,
          mapping?.assetAltText || null,
          state,
          waitReason,
          normalized.maxAttempts,
          errorCode,
          normalized.actorEmail,
        ],
      )
    } else if (
      normalized.lifecycle === 'active'
      && jobResult.rows[0].state === 'succeeded'
      && !await jobFencesAreCurrent(
        client,
        normalized.organizationId,
        jobResult.rows[0].id,
      )
    ) {
      jobResult.rows[0] = await createCommerceProductImageSuccessorJob(client, {
        priorJob: jobResult.rows[0],
        actorEmail: normalized.actorEmail,
        auditReason: 'mapping_changed',
      })
    } else if (jobResult.rows[0].state === 'waiting_mapping') {
      jobResult.rows[0] = await bindWaitingJob(
        client,
        jobResult.rows[0],
        observation,
        normalized.actorEmail,
      )
    }

    const job = jobResult.rows[0]
    if (!job) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_JOB_SAVE_FAILED',
        'Commerce product image import job could not be saved',
        500,
      )
    }
    return {
      observationId: observation.id,
      observationGlobalId: observation.global_id,
      observationRevision: positiveInteger(
        observation.observation_revision,
        'observation revision',
      ),
      imageIdentitySha256: observation.image_identity_sha256,
      jobId: job.id,
      jobGlobalId: job.global_id,
      jobState: job.state,
      waitReason: job.wait_reason,
      productId: job.product_id,
      replayed,
    }
  }
}

export type ReconcileCommerceProductImageSetInput = {
  organizationId: string
  integrationAccountId: string
  provider: CommerceProductImageProvider
  credentialGeneration: number
  externalProductId: string
  productSourceHash: string
  productLifecycle?: 'active' | 'deleted'
  imageSetComplete: boolean
  observedAt: Date | string
  providerUpdatedAt?: Date | string | null
  actorEmail: string
  maxAttempts?: number
  images: Array<{
    providerImageId?: string | null
    locatorSha256: string
    sequence: number
    altText?: string | null
    pixelWidth?: number | null
    pixelHeight?: number | null
    sourceHash: string
  }>
}

export type ReconcileCommerceProductImageSetResult = {
  productSourceHash: string
  productLifecycle: 'active' | 'deleted'
  imageSetComplete: boolean
  staleSnapshotIgnored: boolean
  active: CommerceProductImageObservationReceipt[]
  removed: CommerceProductImageObservationReceipt[]
}

function transitionedImageSourceHash(
  lifecycle: CommerceProductImageLifecycle,
  imageEvidenceSourceHash: string,
  priorSourceHash: string,
  revisionFence: number,
): string {
  return createHash('sha256').update([
    'commerce-product-image-transition-v1',
    lifecycle,
    imageEvidenceSourceHash,
    priorSourceHash,
    String(revisionFence),
  ].join('\u001f'), 'utf8').digest('hex')
}

async function replaySafeActiveSourceHash(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    credentialGeneration: number
    externalProductId: string
    imageIdentitySha256: string
    baseSourceHash: string
  },
): Promise<string> {
  const result = await client.query<{
    lifecycle_state: CommerceProductImageLifecycle
    source_hash: string
    observation_revision: string
    prior_observation_revision: string | null
    prior_observation_source_hash: string | null
    base_source_seen: boolean
  }>(
    `SELECT
       current_observation.lifecycle_state,
       current_observation.source_hash,
       current_observation.observation_revision::text,
       (
         SELECT prior.observation_revision::text
         FROM operations_commerce_product_image_observations prior
         WHERE prior.organization_id = current_observation.organization_id
           AND prior.integration_account_id =
                 current_observation.integration_account_id
           AND prior.credential_generation =
                 current_observation.credential_generation
           AND prior.external_product_id =
                 current_observation.external_product_id
           AND prior.image_identity_sha256 =
                 current_observation.image_identity_sha256
           AND prior.observation_revision <
                 current_observation.observation_revision
         ORDER BY prior.observation_revision DESC
         LIMIT 1
       ) AS prior_observation_revision,
       (
         SELECT prior.source_hash
         FROM operations_commerce_product_image_observations prior
         WHERE prior.organization_id = current_observation.organization_id
           AND prior.integration_account_id =
                 current_observation.integration_account_id
           AND prior.credential_generation =
                 current_observation.credential_generation
           AND prior.external_product_id =
                 current_observation.external_product_id
           AND prior.image_identity_sha256 =
                 current_observation.image_identity_sha256
           AND prior.observation_revision <
                 current_observation.observation_revision
         ORDER BY prior.observation_revision DESC
         LIMIT 1
       ) AS prior_observation_source_hash,
       EXISTS (
         SELECT 1
         FROM operations_commerce_product_image_observations prior
         WHERE prior.organization_id = current_observation.organization_id
           AND prior.integration_account_id =
                 current_observation.integration_account_id
           AND prior.credential_generation =
                 current_observation.credential_generation
           AND prior.external_product_id =
                 current_observation.external_product_id
           AND prior.image_identity_sha256 =
                 current_observation.image_identity_sha256
           AND prior.lifecycle_state = 'active'
           AND prior.source_hash = $6
       ) AS base_source_seen
     FROM operations_commerce_product_image_observations current_observation
     WHERE current_observation.organization_id = $1::uuid
       AND current_observation.integration_account_id = $2::uuid
       AND current_observation.credential_generation = $3
       AND current_observation.external_product_id = $4
       AND current_observation.image_identity_sha256 = $5
     ORDER BY current_observation.observation_revision DESC
     LIMIT 1
     FOR SHARE OF current_observation`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.credentialGeneration,
      input.externalProductId,
      input.imageIdentitySha256,
      input.baseSourceHash,
    ],
  )
  const latest = result.rows[0]
  if (!latest) return input.baseSourceHash
  if (latest.lifecycle_state === 'removed') {
    return transitionedImageSourceHash(
      'active',
      input.baseSourceHash,
      latest.source_hash,
      positiveInteger(latest.observation_revision, 'removal revision'),
    )
  }
  if (latest.source_hash === input.baseSourceHash) return input.baseSourceHash
  if (
    latest.prior_observation_revision
    && latest.prior_observation_source_hash
  ) {
    const replaySource = transitionedImageSourceHash(
      'active',
      input.baseSourceHash,
      latest.prior_observation_source_hash,
      positiveInteger(
        latest.prior_observation_revision,
        'prior observation revision',
      ),
    )
    if (latest.source_hash === replaySource) return replaySource
  }
  if (latest.base_source_seen) {
    return transitionedImageSourceHash(
      'active',
      input.baseSourceHash,
      latest.source_hash,
      positiveInteger(latest.observation_revision, 'latest observation revision'),
    )
  }
  return input.baseSourceHash
}

async function electCurrentProviderImagePrimary(
  client: PoolClient,
  input: {
    organizationId: string
    pipelineId: string
    productId: string
    actorEmail: string
    auditFence: string
  },
): Promise<boolean> {
  await acquireTransactionAdvisoryLock(
    client,
    `crm-product-images:${input.organizationId}:${input.productId}`,
  )
  const manualPrimary = await client.query<{ id: string }>(
    `SELECT asset.id::text
     FROM crm_product_image_assets asset
     WHERE asset.organization_id = $1::uuid
       AND asset.pipeline_id = $2::uuid
       AND asset.product_id = $3::uuid
       AND asset.source IN ('manual_upload', 'migration')
       AND asset.is_primary = true
     LIMIT 1
     FOR SHARE`,
    [input.organizationId, input.pipelineId, input.productId],
  )
  const elected = manualPrimary.rows[0]
    ? null
    : (await client.query<{ id: string }>(
      `SELECT asset.id::text
       FROM operations_commerce_product_image_bindings binding
       JOIN crm_product_image_assets asset
         ON asset.organization_id = binding.organization_id
        AND asset.pipeline_id = binding.pipeline_id
        AND asset.product_id = binding.product_id
        AND asset.id = binding.asset_id
       WHERE binding.organization_id = $1::uuid
         AND binding.pipeline_id = $2::uuid
         AND binding.product_id = $3::uuid
         AND binding.lifecycle_state = 'active'
         AND operations_commerce_product_image_observation_is_current_active(
           binding.organization_id,
           binding.latest_observation_id
         )
         AND operations_commerce_product_image_account_is_current(
           binding.organization_id,
           binding.integration_account_id,
           binding.provider,
           binding.credential_generation
         )
         AND operations_commerce_product_image_job_fences_are_current(
           binding.organization_id,
           binding.latest_import_job_id
         )
         AND EXISTS (
           SELECT 1
           FROM operations_activation_scopes activation
           WHERE activation.organization_id = binding.organization_id
             AND activation.data_pipeline_id = binding.pipeline_id
             AND activation.state IN ('shadow', 'active')
             AND activation.revision = binding.activation_revision
         )
       ORDER BY
         binding.provider_sequence,
         binding.provider,
         binding.integration_account_id::text,
         binding.external_product_id,
         binding.image_identity_sha256,
         asset.asset_revision,
         asset.id
       LIMIT 1
       FOR SHARE OF asset`,
      [input.organizationId, input.pipelineId, input.productId],
    )).rows[0] || null
  const electedAssetId = elected?.id || null
  const demoted = await client.query<{ id: string; row_version: string }>(
    `UPDATE crm_product_image_assets asset
     SET is_primary = false,
         row_version = asset.row_version + 1,
         updated_by = $5,
         updated_at = clock_timestamp()
     WHERE asset.organization_id = $1::uuid
       AND asset.pipeline_id = $2::uuid
       AND asset.product_id = $3::uuid
       AND (
         (
           $4::uuid IS NOT NULL
           AND asset.source NOT IN ('manual_upload', 'migration')
         )
         OR ($4::uuid IS NULL AND asset.source = 'provider_import')
       )
       AND asset.is_primary = true
       AND ($4::uuid IS NULL OR asset.id <> $4::uuid)
     RETURNING asset.id::text, asset.row_version::text`,
    [
      input.organizationId,
      input.pipelineId,
      input.productId,
      electedAssetId,
      input.actorEmail,
    ],
  )
  let promoted: { id: string; row_version: string } | null = null
  if (electedAssetId) {
    const promotedResult = await client.query<{
      id: string
      row_version: string
    }>(
      `UPDATE crm_product_image_assets asset
       SET is_primary = true,
           row_version = asset.row_version + 1,
           updated_by = $5,
           updated_at = clock_timestamp()
       WHERE asset.organization_id = $1::uuid
         AND asset.pipeline_id = $2::uuid
         AND asset.product_id = $3::uuid
         AND asset.id = $4::uuid
         AND asset.is_primary = false
       RETURNING asset.id::text, asset.row_version::text`,
      [
        input.organizationId,
        input.pipelineId,
        input.productId,
        electedAssetId,
        input.actorEmail,
      ],
    )
    promoted = promotedResult.rows[0] || null
  }
  if (demoted.rows.length === 0 && !promoted) return false
  await recordAuditEvent({
    actor: input.actorEmail,
    eventType: 'crm.product_image.provider_primary_reconciled',
    aggregateType: 'crm_product',
    aggregateId: input.productId,
    organizationId: input.organizationId,
    eventKey: `crm-product-image-provider-primary:${input.auditFence}`,
    payload: {
      pipelineId: input.pipelineId,
      productId: input.productId,
      electedAssetId,
      promotedAssetId: promoted?.id || null,
      promotedRowVersion: promoted
        ? positiveInteger(promoted.row_version, 'promoted asset row version')
        : null,
      demotedAssets: demoted.rows.map((row) => ({
        assetId: row.id,
        rowVersion: positiveInteger(row.row_version, 'demoted asset row version'),
      })),
      selection: 'active_provider_sequence',
    },
  }, client)
  return true
}

async function inactivateCommerceProductImageBindingForObservation(
  client: PoolClient,
  observation: ObservationRow,
  actorEmail: string,
): Promise<void> {
  const lookups = await client.query<Pick<
    ImageBindingRow,
    'pipeline_id' | 'product_id'
  >>(
    `SELECT binding.pipeline_id::text, binding.product_id::text
     FROM operations_commerce_product_image_bindings binding
     WHERE binding.organization_id = $1::uuid
       AND binding.integration_account_id = $2::uuid
       AND binding.provider = $3
       AND binding.credential_generation = $4
       AND binding.external_product_id = $5
       AND binding.image_identity_sha256 = $6
     ORDER BY binding.pipeline_id::text, binding.product_id::text`,
    [
      observation.organization_id,
      observation.integration_account_id,
      observation.provider,
      observation.credential_generation,
      observation.external_product_id,
      observation.image_identity_sha256,
    ],
  )
  const observationRevision = positiveInteger(
    observation.observation_revision,
    'removal observation revision',
  )
  for (const lookup of lookups.rows) {
    await acquireTransactionAdvisoryLock(
      client,
      `crm-product-images:${observation.organization_id}:${lookup.product_id}`,
    )
    const current = await client.query<ImageBindingRow>(
      `SELECT binding.*
       FROM operations_commerce_product_image_bindings binding
       WHERE binding.organization_id = $1::uuid
         AND binding.integration_account_id = $2::uuid
         AND binding.provider = $3
         AND binding.credential_generation = $4
         AND binding.external_product_id = $5
         AND binding.image_identity_sha256 = $6
         AND binding.pipeline_id = $7::uuid
         AND binding.product_id = $8::uuid
       LIMIT 1
       FOR UPDATE`,
      [
        observation.organization_id,
        observation.integration_account_id,
        observation.provider,
        observation.credential_generation,
        observation.external_product_id,
        observation.image_identity_sha256,
        lookup.pipeline_id,
        lookup.product_id,
      ],
    )
    const binding = current.rows[0]
    if (!binding || positiveInteger(
      binding.latest_observation_revision,
      'binding observation revision',
    ) >= observationRevision) continue
    const updated = await client.query<ImageBindingRow>(
      `UPDATE operations_commerce_product_image_bindings
       SET provider_image_id = $9,
           locator_sha256 = $10,
           latest_observation_id = $11::uuid,
           latest_observation_revision = $12,
           latest_observation_set_id = $13::uuid,
           provider_sequence = $14,
           effective_alt_text = COALESCE($15, effective_alt_text),
           lifecycle_state = 'inactive',
           row_version = row_version + 1,
           inactivated_at = clock_timestamp(),
           updated_by = $16,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND provider = $3
         AND credential_generation = $4
         AND external_product_id = $5
         AND image_identity_sha256 = $6
         AND pipeline_id = $7::uuid
         AND product_id = $8::uuid
       RETURNING *`,
      [
        observation.organization_id,
        observation.integration_account_id,
        observation.provider,
        observation.credential_generation,
        observation.external_product_id,
        observation.image_identity_sha256,
        lookup.pipeline_id,
        lookup.product_id,
        observation.provider_image_id,
        observation.locator_sha256,
        observation.id,
        observationRevision,
        observation.observation_set_id,
        observation.image_sequence,
        observation.alt_text,
        actorEmail,
      ],
    )
    const saved = updated.rows[0]
    if (!saved) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_BINDING_SAVE_FAILED',
        'Commerce product image fan-out binding could not be inactivated',
        500,
      )
    }
    const rowVersion = positiveInteger(saved.row_version, 'binding row version')
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.commerce_product_image_binding.inactivated',
      aggregateType: 'operations_commerce_product_image_binding',
      aggregateId: saved.global_id,
      organizationId: saved.organization_id,
      eventKey: `commerce-product-image-binding:${saved.global_id}:${rowVersion}`,
      payload: {
        bindingGlobalId: saved.global_id,
        rowVersion,
        provider: saved.provider,
        integrationAccountId: saved.integration_account_id,
        credentialGeneration: saved.credential_generation,
        externalProductId: saved.external_product_id,
        imageIdentitySha256: saved.image_identity_sha256,
        latestObservationId: saved.latest_observation_id,
        latestObservationRevision: observationRevision,
        pipelineId: saved.pipeline_id,
        productId: saved.product_id,
        assetId: saved.asset_id,
        lifecycleState: 'inactive',
        providerWrites: 0,
      },
    }, client)
    const primaryChanged = await electCurrentProviderImagePrimary(client, {
      organizationId: saved.organization_id,
      pipelineId: saved.pipeline_id,
      productId: saved.product_id,
      actorEmail,
      auditFence: `${saved.global_id}:${rowVersion}`,
    })
    if (primaryChanged) {
      await enqueueSuiteCrmProductImageProjectionWithClient(client, {
        organizationId: saved.organization_id,
        pipelineId: saved.pipeline_id,
        productId: saved.product_id,
        actorEmail,
      })
    }
  }
}

async function activateCommerceProductImageBinding(
  client: PoolClient,
  input: {
    job: JobRow
    observation: ObservationRow
    target: CommerceProductImageMappingTarget
    assetId: string
    actorEmail: string
  },
): Promise<{ binding: ImageBindingRow; isPrimary: boolean }> {
  const { job, observation, target } = input
  if (
    !job.activation_revision
    || !job.asset_alt_text
  ) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_JOB_CORRUPT',
      'Mapped image import job is incomplete',
      500,
    )
  }
  await acquireTransactionAdvisoryLock(
    client,
    `crm-product-images:${job.organization_id}:${target.productId}`,
  )
  const savedResult = await client.query<ImageBindingRow>(
    `INSERT INTO operations_commerce_product_image_bindings (
       organization_id,
       integration_account_id,
       provider,
       credential_generation,
       external_product_id,
       image_identity_sha256,
       provider_image_id,
       locator_sha256,
       latest_observation_id,
       latest_observation_revision,
       latest_observation_set_id,
       latest_import_job_id,
       latest_import_job_generation,
       provider_sequence,
       effective_alt_text,
       pipeline_id,
       product_id,
       activation_revision,
       asset_id,
       lifecycle_state,
       row_version,
       activated_at,
       inactivated_at,
       created_by,
       updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid, $10,
       $11::uuid, $12::uuid, $13, $14, $15, $16::uuid, $17::uuid,
       $18, $19::uuid, 'active', 1, clock_timestamp(), NULL, $20, $20
     )
     ON CONFLICT (
       organization_id,
       integration_account_id,
       provider,
       credential_generation,
       external_product_id,
       image_identity_sha256,
       product_id
     ) DO UPDATE SET
       provider_image_id = EXCLUDED.provider_image_id,
       locator_sha256 = EXCLUDED.locator_sha256,
       latest_observation_id = EXCLUDED.latest_observation_id,
       latest_observation_revision = EXCLUDED.latest_observation_revision,
       latest_observation_set_id = EXCLUDED.latest_observation_set_id,
       latest_import_job_id = EXCLUDED.latest_import_job_id,
       latest_import_job_generation = EXCLUDED.latest_import_job_generation,
       provider_sequence = EXCLUDED.provider_sequence,
       effective_alt_text = EXCLUDED.effective_alt_text,
       pipeline_id = EXCLUDED.pipeline_id,
       product_id = EXCLUDED.product_id,
       activation_revision = EXCLUDED.activation_revision,
       asset_id = EXCLUDED.asset_id,
       lifecycle_state = 'active',
       row_version =
         operations_commerce_product_image_bindings.row_version + 1,
       activated_at = clock_timestamp(),
       inactivated_at = NULL,
       updated_by = EXCLUDED.updated_by,
       updated_at = clock_timestamp()
     WHERE (
       operations_commerce_product_image_bindings
         .latest_observation_revision < EXCLUDED.latest_observation_revision
       OR (
         operations_commerce_product_image_bindings
           .latest_observation_revision = EXCLUDED.latest_observation_revision
         AND operations_commerce_product_image_bindings
           .latest_import_job_generation < EXCLUDED.latest_import_job_generation
       )
     )
     RETURNING *`,
    [
      job.organization_id,
      job.integration_account_id,
      job.provider,
      job.credential_generation,
      job.external_product_id,
      job.image_identity_sha256,
      observation.provider_image_id,
      observation.locator_sha256,
      observation.id,
      positiveInteger(observation.observation_revision, 'observation revision'),
      observation.observation_set_id,
      job.id,
      positiveInteger(job.job_generation, 'job generation'),
      observation.image_sequence,
      target.assetAltText,
      target.pipelineId,
      target.productId,
      positiveInteger(target.activationRevision, 'activation revision'),
      input.assetId,
      input.actorEmail,
    ],
  )
  const saved = savedResult.rows[0]
  if (!saved) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_BINDING_REVISION_CONFLICT',
      'Commerce product image binding is newer than this import completion',
      409,
    )
  }
  const rowVersion = positiveInteger(saved.row_version, 'binding row version')
  await recordAuditEvent({
    actor: input.actorEmail,
    eventType: 'operations.commerce_product_image_binding.activated',
    aggregateType: 'operations_commerce_product_image_binding',
    aggregateId: saved.global_id,
    organizationId: saved.organization_id,
    eventKey: `commerce-product-image-binding:${saved.global_id}:${rowVersion}`,
    payload: {
      bindingGlobalId: saved.global_id,
      rowVersion,
      provider: saved.provider,
      integrationAccountId: saved.integration_account_id,
      credentialGeneration: saved.credential_generation,
      externalProductId: saved.external_product_id,
      imageIdentitySha256: saved.image_identity_sha256,
      latestObservationId: saved.latest_observation_id,
      latestObservationRevision: positiveInteger(
        saved.latest_observation_revision,
        'binding observation revision',
      ),
      latestImportJobId: saved.latest_import_job_id,
      latestImportJobGeneration: positiveInteger(
        saved.latest_import_job_generation,
        'binding import job generation',
      ),
      providerSequence: saved.provider_sequence,
      effectiveAltText: saved.effective_alt_text,
      pipelineId: saved.pipeline_id,
      productId: saved.product_id,
      activationRevision: positiveInteger(
        saved.activation_revision,
        'binding activation revision',
      ),
      mappingCount: job.mapping_count,
      mappingFingerprintSha256: job.mapping_fingerprint_sha256,
      targetMappingCount: target.targetMappingCount,
      targetMappingFingerprintSha256:
        target.targetMappingFingerprintSha256,
      assetId: saved.asset_id,
      lifecycleState: 'active',
      providerWrites: 0,
    },
  }, client)
  const currentPrimaryChanged = await electCurrentProviderImagePrimary(client, {
    organizationId: saved.organization_id,
    pipelineId: saved.pipeline_id,
    productId: saved.product_id,
    actorEmail: input.actorEmail,
    auditFence: `${saved.global_id}:${rowVersion}`,
  })
  if (currentPrimaryChanged) {
    await enqueueSuiteCrmProductImageProjectionWithClient(client, {
      organizationId: saved.organization_id,
      pipelineId: saved.pipeline_id,
      productId: saved.product_id,
      actorEmail: input.actorEmail,
    })
  }
  const primary = await client.query<{ is_primary: boolean }>(
    `SELECT asset.is_primary
     FROM crm_product_image_assets asset
     WHERE asset.organization_id = $1::uuid
       AND asset.pipeline_id = $2::uuid
       AND asset.product_id = $3::uuid
       AND asset.id = $4::uuid
     LIMIT 1`,
    [saved.organization_id, saved.pipeline_id, saved.product_id, saved.asset_id],
  )
  return { binding: saved, isPrimary: primary.rows[0]?.is_primary === true }
}

export async function reconcileCommerceProductImageSetWithClient(
  input: ReconcileCommerceProductImageSetInput,
  client: PoolClient,
): Promise<ReconcileCommerceProductImageSetResult> {
  const organizationId = requiredTrimmed(input.organizationId, 'Organization ID', 64)
  const integrationAccountId = requiredTrimmed(
    input.integrationAccountId,
    'Integration account ID',
    64,
  )
  const externalProductId = requiredTrimmed(
    input.externalProductId,
    'External product ID',
    512,
  )
  const actorEmail = requiredTrimmed(input.actorEmail, 'Actor email', 255)
  const productSourceHash = requiredHash(
    input.productSourceHash,
    'Product image-set source hash',
  )
  const productLifecycle = input.productLifecycle ?? 'active'
  if (!['active', 'deleted'].includes(productLifecycle)) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Product lifecycle is invalid')
  }
  if (typeof input.imageSetComplete !== 'boolean') {
    fail(
      'COMMERCE_PRODUCT_IMAGE_COMPLETENESS_ATTESTATION_REQUIRED',
      'Image-set completeness must be explicitly attested',
    )
  }
  if (!Array.isArray(input.images) || input.images.length > 500) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Product image set is invalid')
  }
  const imageSetComplete = productLifecycle === 'deleted'
    ? true
    : input.imageSetComplete
  const inputImages = productLifecycle === 'deleted' ? [] : input.images
  if (!['shopify', 'faire'].includes(input.provider)) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Commerce provider is invalid')
  }
  if (!Number.isSafeInteger(input.credentialGeneration)
    || input.credentialGeneration < 1) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Credential generation is invalid')
  }
  const observedAt = sourceTimestamp(input.observedAt, 'Observation timestamp')
  const providerUpdatedAt = input.providerUpdatedAt === null
    || input.providerUpdatedAt === undefined
    ? null
    : sourceTimestamp(input.providerUpdatedAt, 'Provider update timestamp')
  const activeIdentities = new Set<string>()
  const candidates = inputImages.map((candidate) => {
    const normalized = normalizeObservationInput({
      organizationId,
      integrationAccountId,
      provider: input.provider,
      credentialGeneration: input.credentialGeneration,
      externalProductId,
      providerImageId: candidate.providerImageId,
      locatorSha256: candidate.locatorSha256,
      sequence: candidate.sequence,
      altText: candidate.altText,
      pixelWidth: candidate.pixelWidth,
      pixelHeight: candidate.pixelHeight,
      lifecycle: 'active',
      sourceHash: candidate.sourceHash,
      providerUpdatedAt,
      observedAt,
      actorEmail,
      maxAttempts: input.maxAttempts,
    })
    const identity = normalized.imageIdentitySha256
    if (activeIdentities.has(identity)) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_DUPLICATE_IDENTITY',
        'A product image set cannot repeat an image identity',
        409,
      )
    }
    activeIdentities.add(identity)
    return { normalized, identity }
  })
  const identitySetSha256 = createHash('sha256').update([
    'commerce-product-image-identity-set-v1',
    ...[...activeIdentities].sort(),
  ].join('\u001f'), 'utf8').digest('hex')
  const snapshotSha256 = createHash('sha256').update([
    'commerce-product-image-snapshot-v1',
    input.provider,
    String(input.credentialGeneration),
    externalProductId,
    productSourceHash,
    productLifecycle,
    imageSetComplete ? 'complete' : 'partial',
    providerUpdatedAt || '',
    identitySetSha256,
    ...candidates
      .map(({ normalized }) => [
        normalized.imageIdentitySha256,
        normalized.providerImageId || '',
        normalized.locatorSha256,
        String(normalized.sequence),
        normalized.altText || '',
        normalized.pixelWidth === null ? '' : String(normalized.pixelWidth),
        normalized.pixelHeight === null ? '' : String(normalized.pixelHeight),
        normalized.sourceHash,
      ].join('\u001e'))
      .sort(),
  ].join('\u001f'), 'utf8').digest('hex')

  await acquireTransactionAdvisoryLock(
    client,
    `commerce-product-image-set:${organizationId}:${integrationAccountId}:${input.provider}:${input.credentialGeneration}:${externalProductId}`,
  )
  const authority = await client.query<{
    account_is_current: boolean
    actor_exists: boolean
  }>(
    `SELECT
       operations_commerce_product_image_account_is_current(
         $1::uuid, $2::uuid, $3, $4
       ) AS account_is_current,
       EXISTS (
         SELECT 1 FROM app_users WHERE email = $5
       ) AS actor_exists`,
    [
      organizationId,
      integrationAccountId,
      input.provider,
      input.credentialGeneration,
      actorEmail,
    ],
  )
  if (!authority.rows[0]?.account_is_current) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_ACCOUNT_NOT_CURRENT',
      'Commerce product image snapshot requires the current verified account credential',
      409,
    )
  }
  if (!authority.rows[0]?.actor_exists) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_ACTOR_NOT_FOUND',
      'Commerce product image snapshot actor is not registered',
      409,
    )
  }
  const fenceResult = await client.query<{
    accepted_observed_at: Date | string
    accepted_snapshot_sha256: string
  }>(
    `SELECT accepted_observed_at, accepted_snapshot_sha256
     FROM operations_commerce_product_image_snapshot_fences
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND provider = $3
       AND credential_generation = $4
       AND external_product_id = $5
     FOR UPDATE`,
    [
      organizationId,
      integrationAccountId,
      input.provider,
      input.credentialGeneration,
      externalProductId,
    ],
  )
  const fence = fenceResult.rows[0]
  if (fence) {
    const acceptedObservedAt = iso(
      fence.accepted_observed_at,
      'snapshot fence timestamp',
    )
    if (observedAt < acceptedObservedAt) {
      return {
        productSourceHash,
        productLifecycle,
        imageSetComplete,
        staleSnapshotIgnored: true,
        active: [],
        removed: [],
      }
    }
    if (
      observedAt === acceptedObservedAt
      && fence.accepted_snapshot_sha256 !== snapshotSha256
    ) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_SNAPSHOT_COLLISION',
        'One observation timestamp cannot identify different product image snapshots',
        409,
      )
    }
    if (observedAt > acceptedObservedAt) {
      await client.query(
        `UPDATE operations_commerce_product_image_snapshot_fences
         SET accepted_observed_at = $6::timestamptz,
             accepted_snapshot_sha256 = $7,
             updated_by = $8
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND provider = $3
           AND credential_generation = $4
           AND external_product_id = $5`,
        [
          organizationId,
          integrationAccountId,
          input.provider,
          input.credentialGeneration,
          externalProductId,
          observedAt,
          snapshotSha256,
          actorEmail,
        ],
      )
    }
  } else {
    await client.query(
      `INSERT INTO operations_commerce_product_image_snapshot_fences (
         organization_id,
         integration_account_id,
         provider,
         credential_generation,
         external_product_id,
         accepted_observed_at,
         accepted_snapshot_sha256,
         created_by,
         updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz, $7, $8, $8
       )`,
      [
        organizationId,
        integrationAccountId,
        input.provider,
        input.credentialGeneration,
        externalProductId,
        observedAt,
        snapshotSha256,
        actorEmail,
      ],
    )
  }
    const insertedSet = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_commerce_product_image_observation_sets (
         organization_id,
         integration_account_id,
         provider,
         credential_generation,
         external_product_id,
         product_source_hash,
         image_set_complete,
         image_identity_count,
         image_identity_set_sha256,
         snapshot_sha256,
         provider_updated_at,
         observed_at,
         created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
         $10, $11::timestamptz, $12::timestamptz, $13
       )
       ON CONFLICT (
         organization_id,
         integration_account_id,
         provider,
         credential_generation,
         external_product_id,
         observed_at,
         product_source_hash,
         image_set_complete,
         image_identity_set_sha256,
         snapshot_sha256
       ) DO NOTHING
       RETURNING id::text, global_id`,
      [
        organizationId,
        integrationAccountId,
        input.provider,
        input.credentialGeneration,
        externalProductId,
        productSourceHash,
        imageSetComplete,
        activeIdentities.size,
        identitySetSha256,
        snapshotSha256,
        providerUpdatedAt,
        observedAt,
        actorEmail,
      ],
    )
    let observationSet = insertedSet.rows[0]
    if (!observationSet) {
      const replayedSet = await client.query<{ id: string; global_id: string }>(
        `SELECT id::text, global_id
         FROM operations_commerce_product_image_observation_sets
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND provider = $3
           AND credential_generation = $4
           AND external_product_id = $5
           AND observed_at = $6::timestamptz
           AND product_source_hash = $7
           AND image_set_complete = $8
           AND image_identity_set_sha256 = $9
           AND snapshot_sha256 = $10
         LIMIT 1
         FOR SHARE`,
        [
          organizationId,
          integrationAccountId,
          input.provider,
          input.credentialGeneration,
          externalProductId,
          observedAt,
          productSourceHash,
          imageSetComplete,
          identitySetSha256,
          snapshotSha256,
        ],
      )
      observationSet = replayedSet.rows[0]
    }
    if (!observationSet) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_SET_SAVE_FAILED',
        'Commerce product image-set evidence could not be saved',
        500,
      )
    }
    const active: CommerceProductImageObservationReceipt[] = []
    for (const { normalized: candidate, identity } of candidates) {
      const baseSourceHash = candidate.sourceHash
      const sourceHash = await replaySafeActiveSourceHash(client, {
        organizationId,
        integrationAccountId,
        credentialGeneration: input.credentialGeneration,
        externalProductId,
        imageIdentitySha256: identity,
        baseSourceHash,
      })
      const receipt = await recordCommerceProductImageObservationWithClient({
        organizationId,
        integrationAccountId,
        provider: input.provider,
        credentialGeneration: input.credentialGeneration,
        externalProductId,
        providerImageId: candidate.providerImageId,
        locatorSha256: candidate.locatorSha256,
        sequence: candidate.sequence,
        altText: candidate.altText,
        pixelWidth: candidate.pixelWidth,
        pixelHeight: candidate.pixelHeight,
        lifecycle: 'active',
        sourceHash,
        providerUpdatedAt,
        observedAt,
        actorEmail,
        maxAttempts: input.maxAttempts,
      }, client, observationSet.id)
      active.push(receipt)
      await client.query(
        `INSERT INTO
           operations_commerce_product_image_observation_set_memberships (
             organization_id,
             integration_account_id,
             provider,
             credential_generation,
             external_product_id,
             observation_set_id,
             image_identity_sha256,
             observation_id,
             observation_revision,
             locator_sha256,
             observation_source_hash
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7,
             $8::uuid, $9, $10, $11
           )
         ON CONFLICT (
           organization_id,
           integration_account_id,
           observation_set_id,
           image_identity_sha256
         ) DO NOTHING`,
        [
          organizationId,
          integrationAccountId,
          input.provider,
          input.credentialGeneration,
          externalProductId,
          observationSet.id,
          receipt.imageIdentitySha256,
          receipt.observationId,
          receipt.observationRevision,
          candidate.locatorSha256,
          sourceHash,
        ],
      )
    }

    const removed: CommerceProductImageObservationReceipt[] = []
    if (imageSetComplete) {
      const absent = await client.query<ObservationRow>(
        `SELECT DISTINCT ON (observation.image_identity_sha256)
           observation.*
         FROM operations_commerce_product_image_observations observation
         WHERE observation.organization_id = $1::uuid
           AND observation.integration_account_id = $2::uuid
           AND observation.provider = $3
           AND observation.credential_generation = $4
           AND observation.external_product_id = $5
           AND NOT (
             observation.image_identity_sha256 = ANY($6::text[])
           )
         ORDER BY
           observation.image_identity_sha256,
           observation.observation_revision DESC`,
        [
          organizationId,
          integrationAccountId,
          input.provider,
          input.credentialGeneration,
          externalProductId,
          [...activeIdentities],
        ],
      )
      for (const prior of absent.rows) {
        if (prior.lifecycle_state !== 'active') continue
        const removalSourceHash = transitionedImageSourceHash(
          'removed',
          prior.source_hash,
          prior.source_hash,
          positiveInteger(prior.observation_revision, 'prior observation revision'),
        )
        const removal = await recordCommerceProductImageObservationWithClient({
          organizationId,
          integrationAccountId,
          provider: input.provider,
          credentialGeneration: input.credentialGeneration,
          externalProductId,
          providerImageId: prior.provider_image_id,
          locatorSha256: prior.locator_sha256,
          sequence: prior.image_sequence,
          altText: prior.alt_text,
          pixelWidth: prior.pixel_width,
          pixelHeight: prior.pixel_height,
          lifecycle: 'removed',
          sourceHash: removalSourceHash,
          providerUpdatedAt,
          observedAt,
          actorEmail,
          maxAttempts: input.maxAttempts,
        }, client, observationSet.id)
        removed.push(removal)
        await inactivateCommerceProductImageBindingForObservation(
          client,
          await selectObservation(client, removal.observationId),
          actorEmail,
        )
      }
    }
    return {
      productSourceHash,
      productLifecycle,
      imageSetComplete,
      staleSnapshotIgnored: false,
      active,
      removed,
    }
}

export async function reconcileCommerceProductImageSetInPostgres(
  input: ReconcileCommerceProductImageSetInput,
): Promise<ReconcileCommerceProductImageSetResult> {
  return withTransaction((client) =>
    reconcileCommerceProductImageSetWithClient(input, client))
}

export async function resolveWaitingCommerceProductImageImportJobsInPostgres(input: {
  organizationId?: string
  updatedBy: string
  limit?: number
}): Promise<Array<{
  jobId: string
  jobGlobalId: string
  state: CommerceProductImageImportJobState
  waitReason: string | null
  productId: string | null
}>> {
  const organizationId = input.organizationId === undefined
    ? null
    : requiredTrimmed(input.organizationId, 'Organization ID', 64)
  const updatedBy = requiredTrimmed(input.updatedBy, 'Worker ID', 255)
  const limit = input.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Resolution limit is invalid')
  }
  return withTransaction(async (client) => {
    const candidates = await client.query<JobRow>(
      `SELECT *
       FROM operations_commerce_product_image_import_jobs
       WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)
         AND state = 'waiting_mapping'
       ORDER BY created_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [organizationId, limit],
    )
    const resolved = []
    for (const job of candidates.rows) {
      const observation = await selectObservation(client, job.observation_id)
      const current = await bindWaitingJob(client, job, observation, updatedBy)
      resolved.push({
        jobId: current.id,
        jobGlobalId: current.global_id,
        state: current.state,
        waitReason: current.wait_reason,
        productId: current.product_id,
      })
    }
    return resolved
  })
}

export async function retryDeadCommerceProductImageImportJobInPostgres(input: {
  organizationId: string
  jobId: string
  actorEmail: string
  reason: string
}): Promise<{
  jobId: string
  jobGlobalId: string
  jobGeneration: number
  state: CommerceProductImageImportJobState
  productId: string | null
}> {
  const organizationId = requiredTrimmed(
    input.organizationId,
    'Organization ID',
    64,
  )
  const jobId = requiredTrimmed(input.jobId, 'Import job ID', 64)
  const actorEmail = requiredTrimmed(input.actorEmail, 'Actor email', 255)
  const reason = requiredTrimmed(input.reason, 'Retry reason', 500)
  return withTransaction(async (client) => {
    const authority = await client.query<{ authorized: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM app_users app_user
         JOIN app_user_organization_memberships membership
           ON membership.user_email = app_user.email
          AND membership.organization_id = $1::uuid
          AND membership.status = 'active'
          AND membership.role IN ('owner', 'admin')
         WHERE app_user.email = $2
           AND app_user.status = 'active'
       ) AS authorized`,
      [organizationId, actorEmail],
    )
    if (!authority.rows[0]?.authorized) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_RETRY_FORBIDDEN',
        'Owner or admin authority is required to retry dead image work',
        403,
      )
    }
    const priorJob = await selectJob(client, organizationId, jobId, true)
    if (priorJob.state !== 'dead') {
      fail(
        'COMMERCE_PRODUCT_IMAGE_RETRY_STATE_INVALID',
        'Only a dead image import can be retried explicitly',
        409,
      )
    }
    const successor = await createCommerceProductImageSuccessorJob(client, {
      priorJob,
      actorEmail,
      auditReason: 'operator_retry',
      operatorReason: reason,
    })
    return {
      jobId: successor.id,
      jobGlobalId: successor.global_id,
      jobGeneration: positiveInteger(
        successor.job_generation,
        'job generation',
      ),
      state: successor.state,
      productId: successor.product_id,
    }
  })
}

function claimFromRows(rows: Array<JobRow & {
  observation_global_id: string
  account_global_id: string
  provider_image_id: string | null
  image_sequence: number
  pixel_width: number | null
  pixel_height: number | null
  requested_actor_email: string
}>): CommerceProductImageImportClaim[] {
  return rows.map((row) => {
    if (
      !row.pipeline_id
      || !row.product_id
      || !row.product_mapping_id
      || !row.mapping_count
      || !row.mapping_fingerprint_sha256
      || !row.asset_alt_text
      || !row.lease_token
      || !row.lease_expires_at
      || !row.account_global_id
      || !row.requested_actor_email
    ) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
        'Claimed commerce product image job is incomplete',
        500,
      )
    }
    return {
      jobId: row.id,
      jobGlobalId: row.global_id,
      observationId: row.observation_id,
      observationGlobalId: row.observation_global_id,
      organizationId: row.organization_id,
      integrationAccountId: row.integration_account_id,
      accountGlobalId: row.account_global_id,
      provider: row.provider,
      credentialGeneration: positiveInteger(
        row.credential_generation,
        'credential generation',
      ),
      externalProductId: row.external_product_id,
      providerImageId: row.provider_image_id,
      imageIdentitySha256: row.image_identity_sha256,
      locatorSha256: row.locator_sha256,
      sourceHash: row.observation_source_hash,
      sequence: nonnegativeInteger(row.image_sequence, 'sequence'),
      altText: row.asset_alt_text,
      expectedPixelWidth: row.pixel_width,
      expectedPixelHeight: row.pixel_height,
      pipelineId: row.pipeline_id,
      productId: row.product_id,
      productMappingId: row.product_mapping_id,
      mappingCount: positiveInteger(row.mapping_count, 'mapping count'),
      mappingFingerprintSha256: row.mapping_fingerprint_sha256,
      attemptCount: positiveInteger(row.attempt_count, 'attempt count'),
      maxAttempts: positiveInteger(row.max_attempts, 'maximum attempts'),
      leaseToken: row.lease_token,
      leaseExpiresAt: iso(row.lease_expires_at, 'lease expiry'),
      actorEmail: row.requested_actor_email,
    }
  })
}

export async function claimCommerceProductImageImportJobsInPostgres(input: {
  organizationId?: string
  workerId: string
  limit?: number
  leaseSeconds?: number
}): Promise<CommerceProductImageImportClaim[]> {
  const organizationId = input.organizationId === undefined
    ? null
    : requiredTrimmed(input.organizationId, 'Organization ID', 64)
  const workerId = requiredTrimmed(input.workerId, 'Worker ID', 100)
  const limit = input.limit ?? 10
  const leaseSeconds = input.leaseSeconds ?? 60
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Claim limit is invalid')
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 900) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Lease duration is invalid')
  }
  return withTransaction(async (client) => {
    const expired = await client.query<JobRow>(
      `SELECT *
       FROM operations_commerce_product_image_import_jobs
       WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)
         AND state = 'claimed'
         AND lease_expires_at <= statement_timestamp()
       ORDER BY lease_expires_at, id
       LIMIT 500
       FOR UPDATE SKIP LOCKED`,
      [organizationId],
    )
    for (const job of expired.rows) {
      if (!await jobFencesAreCurrent(
        client,
        job.organization_id,
        job.id,
      )) {
        if (!await recoverJobToWaitingMapping(client, job, workerId)) {
          await cancelJob(
            client,
            job,
            await accountCredentialIsCurrent(client, job)
              ? 'SOURCE_SUPERSEDED'
              : 'CREDENTIAL_STALE',
            workerId,
          )
        }
      } else if (job.attempt_count >= job.max_attempts) {
        await client.query(
          `UPDATE operations_commerce_product_image_import_jobs
           SET state = 'dead',
               lease_token = NULL,
               claimed_by = NULL,
               claimed_at = NULL,
               lease_expires_at = NULL,
               last_error_code = 'LEASE_EXPIRED',
               completed_at = clock_timestamp(),
               updated_by = $3
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [job.organization_id, job.id, workerId],
        )
      } else {
        await client.query(
          `UPDATE operations_commerce_product_image_import_jobs
           SET state = 'retry',
               lease_token = NULL,
               claimed_by = NULL,
               claimed_at = NULL,
               lease_expires_at = NULL,
               last_error_code = 'LEASE_EXPIRED',
               available_at = clock_timestamp(),
               updated_by = $3
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [job.organization_id, job.id, workerId],
        )
      }
    }

    const candidates = await client.query<JobRow>(
      `SELECT *
       FROM operations_commerce_product_image_import_jobs
       WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)
         AND state IN ('queued', 'retry')
         AND available_at <= statement_timestamp()
         AND attempt_count < max_attempts
       ORDER BY available_at, created_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [organizationId, limit * 4],
    )
    const claimable: string[] = []
    for (const job of candidates.rows) {
      if (await jobFencesAreCurrent(client, job.organization_id, job.id)) {
        if (claimable.length < limit) claimable.push(job.id)
        continue
      }
      if (!await recoverJobToWaitingMapping(client, job, workerId)) {
        await cancelJob(
          client,
          job,
          await accountCredentialIsCurrent(client, job)
            ? 'SOURCE_SUPERSEDED'
            : 'CREDENTIAL_STALE',
          workerId,
        )
      }
    }
    if (claimable.length === 0) return []
    const claimed = await client.query<JobRow & {
      observation_global_id: string
      account_global_id: string
      provider_image_id: string | null
      image_sequence: number
      pixel_width: number | null
      pixel_height: number | null
      requested_actor_email: string
    }>(
      `UPDATE operations_commerce_product_image_import_jobs job
       SET state = 'claimed',
           attempt_count = job.attempt_count + 1,
           lease_token = gen_random_uuid(),
           claimed_by = $3,
           claimed_at = statement_timestamp(),
           lease_expires_at = statement_timestamp()
             + make_interval(secs => $4),
           last_error_code = NULL,
           updated_by = $3
       FROM operations_commerce_product_image_observations observation,
            operations_integration_accounts account
       WHERE ($1::uuid IS NULL OR job.organization_id = $1::uuid)
         AND job.id = ANY($2::uuid[])
         AND observation.organization_id = job.organization_id
         AND observation.id = job.observation_id
         AND account.organization_id = job.organization_id
         AND account.id = job.integration_account_id
       RETURNING
         job.*,
         observation.global_id AS observation_global_id,
         account.global_id AS account_global_id,
         observation.provider_image_id,
         observation.image_sequence,
         observation.pixel_width,
         observation.pixel_height,
         job.created_by AS requested_actor_email`,
      [organizationId, claimable, workerId, leaseSeconds],
    )
    return claimFromRows(claimed.rows)
  })
}

export async function failCommerceProductImageImportJobInPostgres(input: {
  organizationId: string
  jobId: string
  leaseToken: string
  workerId: string
  errorCode: string
  retryable: boolean
  retryAfterSeconds?: number
}): Promise<{
  state: 'waiting_mapping' | 'retry' | 'dead' | 'cancelled'
  attemptCount: number
}> {
  const organizationId = requiredTrimmed(input.organizationId, 'Organization ID', 64)
  const jobId = requiredTrimmed(input.jobId, 'Import job ID', 64)
  const leaseToken = requiredTrimmed(input.leaseToken, 'Lease token', 64)
  const workerId = requiredTrimmed(input.workerId, 'Worker ID', 100)
  if (!ERROR_CODE_PATTERN.test(input.errorCode)) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Import error code is invalid')
  }
  const retryAfterSeconds = input.retryAfterSeconds ?? 30
  if (!Number.isSafeInteger(retryAfterSeconds)
    || retryAfterSeconds < 0
    || retryAfterSeconds > 86_400) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Retry delay is invalid')
  }
  return withTransaction(async (client) => {
    const job = await selectJob(client, organizationId, jobId, true)
    if (
      job.state !== 'claimed'
      || job.lease_token !== leaseToken
      || !job.lease_expires_at
      || new Date(job.lease_expires_at).getTime() <= Date.now()
    ) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_LEASE_LOST',
        'Commerce product image import lease is no longer current',
        409,
      )
    }
    if (!await jobFencesAreCurrent(client, organizationId, job.id)) {
      if (await recoverJobToWaitingMapping(client, job, workerId)) {
        return { state: 'waiting_mapping', attemptCount: job.attempt_count }
      }
      await cancelJob(
        client,
        job,
        await accountCredentialIsCurrent(client, job)
          ? 'SOURCE_SUPERSEDED'
          : 'CREDENTIAL_STALE',
        workerId,
      )
      return { state: 'cancelled', attemptCount: job.attempt_count }
    }
    const retry = input.retryable && job.attempt_count < job.max_attempts
    const state = retry ? 'retry' : 'dead'
    await client.query(
      `UPDATE operations_commerce_product_image_import_jobs
       SET state = $3,
           lease_token = NULL,
           claimed_by = NULL,
           claimed_at = NULL,
           lease_expires_at = NULL,
           last_error_code = $4,
           available_at = CASE WHEN $3 = 'retry'
             THEN statement_timestamp() + make_interval(secs => $5)
             ELSE available_at END,
           completed_at = CASE WHEN $3 = 'dead'
             THEN clock_timestamp() ELSE NULL END,
           updated_by = $6
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        organizationId,
        job.id,
        state,
        input.errorCode,
        retryAfterSeconds,
        workerId,
      ],
    )
    return { state, attemptCount: job.attempt_count }
  })
}

type PersistedCommerceProductImageFanoutTarget = {
  target: CommerceProductImageMappingTarget
  asset: {
    id: string
    asset_revision: string
    is_primary: boolean
  }
  provenance: {
    id: string
    global_id: string
  }
  reusedAsset: boolean
}

async function persistCommerceProductImageFanoutTarget(
  client: PoolClient,
  input: {
    organizationId: string
    job: JobRow
    target: CommerceProductImageMappingTarget
    image: ReturnType<typeof validateCrmProductImage>
    sourceEvidence: CommerceProviderImageSourceEvidence
    actorEmail: string
  },
): Promise<PersistedCommerceProductImageFanoutTarget> {
  const {
    organizationId,
    job,
    target,
    image,
    sourceEvidence,
    actorEmail,
  } = input
  const product = await client.query<{ id: string }>(
    `SELECT product.id::text
     FROM crm_products product
     JOIN pipeline_spaces pipeline
       ON pipeline.id = product.pipeline_id
      AND pipeline.workspace_organization_id = $1::uuid
     WHERE product.pipeline_id = $2::uuid
       AND product.id = $3::uuid
     LIMIT 1
     FOR UPDATE OF product`,
    [organizationId, target.pipelineId, target.productId],
  )
  if (!product.rows[0]) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_PRODUCT_NOT_FOUND',
      'Exact fan-out Product was not found in the active organization',
      409,
    )
  }
  const existing = await client.query<{
    id: string
    asset_revision: string
    is_primary: boolean
  }>(
    `SELECT id::text, asset_revision::text, is_primary
     FROM crm_product_image_assets
     WHERE organization_id = $1::uuid
       AND pipeline_id = $2::uuid
       AND product_id = $3::uuid
       AND content_sha256 = $4
     LIMIT 1
     FOR SHARE`,
    [organizationId, target.pipelineId, target.productId, image.contentSha256],
  )
  let asset = existing.rows[0]
  const reusedAsset = Boolean(asset)
  if (!asset) {
    const next = await client.query<{ next_revision: string }>(
      `SELECT
         (COALESCE(max(asset_revision), 0) + 1)::text AS next_revision
       FROM crm_product_image_assets
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND product_id = $3::uuid`,
      [organizationId, target.pipelineId, target.productId],
    )
    const revision = positiveInteger(
      next.rows[0]?.next_revision || 1,
      'next asset revision',
    )
    const inserted = await client.query<{
      id: string
      asset_revision: string
      is_primary: boolean
    }>(
      `INSERT INTO crm_product_image_assets (
         organization_id,
         pipeline_id,
         product_id,
         asset_revision,
         content_bytes,
         mime_type,
         content_sha256,
         byte_length,
         pixel_width,
         pixel_height,
         alt_text,
         source,
         is_primary,
         row_version,
         created_by,
         updated_by,
         created_at,
         updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::bytea, $6, $7,
         $8, $9, $10, $11, 'provider_import', false, 1, $12, $12,
         clock_timestamp(), clock_timestamp()
       )
       RETURNING id::text, asset_revision::text, is_primary`,
      [
        organizationId,
        target.pipelineId,
        target.productId,
        revision,
        Buffer.from(image.bytes),
        image.mimeType,
        image.contentSha256,
        image.byteLength,
        image.pixelWidth,
        image.pixelHeight,
        target.assetAltText,
        actorEmail,
      ],
    )
    asset = inserted.rows[0]
  }
  if (!asset) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_ASSET_SAVE_FAILED',
      'Validated commerce product image fan-out asset could not be saved',
      500,
    )
  }
  const provenance = await client.query<{ id: string; global_id: string }>(
    `INSERT INTO operations_commerce_product_image_asset_provenance (
       organization_id,
       integration_account_id,
       provider,
       credential_generation,
       observation_id,
       import_job_id,
       import_job_generation,
       external_product_id,
       image_identity_sha256,
       locator_sha256,
       observation_source_hash,
       pipeline_id,
       product_id,
       product_mapping_id,
       mapping_count,
       mapping_fingerprint_sha256,
       activation_revision,
       asset_id,
       asset_revision,
       asset_content_sha256,
       source_content_sha256,
       source_byte_length,
       normalization_version,
       imported_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7, $8, $9,
       $10, $11, $12::uuid, $13::uuid, $14::uuid, $15, $16, $17,
       $18::uuid, $19::bigint, $20, $21, $22, $23, $24
     )
     RETURNING id::text, global_id`,
    [
      organizationId,
      job.integration_account_id,
      job.provider,
      job.credential_generation,
      job.observation_id,
      job.id,
      positiveInteger(job.job_generation, 'job generation'),
      job.external_product_id,
      job.image_identity_sha256,
      job.locator_sha256,
      job.observation_source_hash,
      target.pipelineId,
      target.productId,
      target.productMappingId,
      job.mapping_count,
      job.mapping_fingerprint_sha256,
      target.activationRevision,
      asset.id,
      asset.asset_revision,
      image.contentSha256,
      sourceEvidence.sourceContentSha256,
      sourceEvidence.sourceByteLength,
      sourceEvidence.normalizationVersion,
      actorEmail,
    ],
  )
  if (!provenance.rows[0]) {
    fail(
      'COMMERCE_PRODUCT_IMAGE_PROVENANCE_SAVE_FAILED',
      'Commerce product image fan-out provenance could not be saved',
      500,
    )
  }
  return {
    target,
    asset,
    provenance: provenance.rows[0],
    reusedAsset,
  }
}

export async function completeCommerceProductImageImportJobInPostgres(input: {
  organizationId: string
  jobId: string
  leaseToken: string
  actorEmail: string
  bytes: Uint8Array
  declaredMimeType: unknown
  sourceByteLength: unknown
  sourceContentSha256: unknown
  normalizationVersion: unknown
}): Promise<CommerceProductImageImportCompletion> {
  const organizationId = requiredTrimmed(input.organizationId, 'Organization ID', 64)
  const jobId = requiredTrimmed(input.jobId, 'Import job ID', 64)
  const leaseToken = requiredTrimmed(input.leaseToken, 'Lease token', 64)
  const actorEmail = requiredTrimmed(input.actorEmail, 'Actor email', 255)
  return withTransaction(async (client) => {
    const job = await selectJob(client, organizationId, jobId, true)
    if (job.created_by !== actorEmail) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_ACTOR_FENCE_MISMATCH',
        'Image import attribution does not match the durable job actor',
        403,
      )
    }
    if (job.state === 'succeeded') {
      const image = validateCrmProductImage({
        bytes: input.bytes,
        declaredMimeType: input.declaredMimeType,
        altText: job.asset_alt_text,
      })
      const sourceEvidence = validatedSourceEvidence(input, image)
      if (!job.result_asset_id || job.result_content_sha256 !== image.contentSha256) {
        fail(
          'COMMERCE_PRODUCT_IMAGE_COMPLETION_CONFLICT',
          'Completed image import does not match these bytes',
          409,
        )
      }
      const prior = await client.query<{
        asset_revision: string
        is_primary: boolean
        provenance_id: string
        provenance_global_id: string
        source_byte_length: string
        source_content_sha256: string
        normalization_version: string
        target_count: string
      }>(
        `SELECT
           asset.asset_revision::text,
           asset.is_primary,
           provenance.id::text AS provenance_id,
           provenance.global_id AS provenance_global_id,
           provenance.source_byte_length::text,
           provenance.source_content_sha256,
           provenance.normalization_version,
           (
             SELECT count(*)::text
             FROM operations_commerce_product_image_asset_provenance target
             WHERE target.organization_id = provenance.organization_id
               AND target.import_job_id = provenance.import_job_id
           ) AS target_count
         FROM crm_product_image_assets asset
         JOIN operations_commerce_product_image_asset_provenance provenance
           ON provenance.organization_id = asset.organization_id
          AND provenance.pipeline_id = asset.pipeline_id
          AND provenance.product_id = asset.product_id
          AND provenance.asset_id = asset.id
          AND provenance.import_job_id = $2::uuid
         WHERE asset.organization_id = $1::uuid
           AND asset.id = $3::uuid
         LIMIT 1`,
        [organizationId, job.id, job.result_asset_id],
      )
      const replay = prior.rows[0]
      if (!replay) {
        fail(
          'COMMERCE_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
          'Completed image import provenance is missing',
          500,
        )
      }
      if (
        positiveInteger(
          replay.source_byte_length,
          'source byte length',
        ) !== sourceEvidence.sourceByteLength
        || replay.source_content_sha256
          !== sourceEvidence.sourceContentSha256
        || replay.normalization_version
          !== sourceEvidence.normalizationVersion
      ) {
        fail(
          'COMMERCE_PRODUCT_IMAGE_COMPLETION_CONFLICT',
          'Completed image import does not match this provider source evidence',
          409,
        )
      }
      return {
        jobId: job.id,
        jobGlobalId: job.global_id,
        assetId: job.result_asset_id,
        assetRevision: positiveInteger(replay.asset_revision, 'asset revision'),
        assetContentSha256: image.contentSha256,
        provenanceId: replay.provenance_id,
        provenanceGlobalId: replay.provenance_global_id,
        reusedAsset: true,
        isPrimary: replay.is_primary,
        targetCount: positiveInteger(replay.target_count, 'fan-out target count'),
        replayed: true,
      }
    }
    if (
      job.state !== 'claimed'
      || job.lease_token !== leaseToken
      || !job.lease_expires_at
      || new Date(job.lease_expires_at).getTime() <= Date.now()
      || !job.pipeline_id
      || !job.product_id
      || !job.product_mapping_id
      || !job.mapping_count
      || !job.mapping_fingerprint_sha256
      || !job.activation_revision
      || !job.asset_alt_text
    ) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_LEASE_LOST',
        'Commerce product image import lease is no longer current',
        409,
      )
    }
    if (!await jobFencesAreCurrent(client, organizationId, job.id)) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_FENCE_STALE',
        'Commerce product image import fences changed before persistence',
        409,
      )
    }
    const image = validateCrmProductImage({
      bytes: input.bytes,
      declaredMimeType: input.declaredMimeType,
      altText: job.asset_alt_text,
    })
    const sourceEvidence = validatedSourceEvidence(input, image)
    const observation = await selectObservation(client, job.observation_id)
    if (
      (observation.pixel_width !== null
        && observation.pixel_width !== image.pixelWidth)
      || (observation.pixel_height !== null
        && observation.pixel_height !== image.pixelHeight)
    ) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_DIMENSIONS_MISMATCH',
        'Validated image dimensions do not match provider metadata',
        409,
      )
    }

    const targets = await currentMappingTargets(client, job, observation)
    const priorBindingScopes = await client.query<{
      pipeline_id: string
      product_id: string
      global_id: string
    }>(
      `SELECT
         binding.pipeline_id::text,
         binding.product_id::text,
         binding.global_id
       FROM operations_commerce_product_image_bindings binding
       WHERE binding.organization_id = $1::uuid
         AND binding.integration_account_id = $2::uuid
         AND binding.provider = $3
         AND binding.credential_generation = $4
         AND binding.external_product_id = $5
         AND binding.image_identity_sha256 = $6
       ORDER BY binding.pipeline_id::text, binding.product_id::text`,
      [
        organizationId,
        job.integration_account_id,
        job.provider,
        job.credential_generation,
        job.external_product_id,
        job.image_identity_sha256,
      ],
    )
    const productLockIds = new Set([
      ...targets.map((target) => target.productId),
      ...priorBindingScopes.rows.map((scope) => scope.product_id),
    ])
    for (const productId of [...productLockIds].sort()) {
      await acquireTransactionAdvisoryLock(
        client,
        `crm-product-images:${organizationId}:${productId}`,
      )
    }
    const persistedTargets: PersistedCommerceProductImageFanoutTarget[] = []
    for (const target of targets) {
      persistedTargets.push(await persistCommerceProductImageFanoutTarget(
        client,
        {
          organizationId,
          job,
          target,
          image,
          sourceEvidence,
          actorEmail,
        },
      ))
    }
    const canonical = persistedTargets.find((entry) => (
      entry.target.productId === job.product_id
      && entry.target.productMappingId === job.product_mapping_id
    ))
    if (!canonical) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_MAPPING_EVIDENCE_CORRUPT',
        'Canonical commerce product image fan-out target is missing',
        500,
      )
    }
    await client.query(
      `UPDATE operations_commerce_product_image_import_jobs
       SET state = 'succeeded',
           lease_token = NULL,
           claimed_by = NULL,
           claimed_at = NULL,
           lease_expires_at = NULL,
           last_error_code = NULL,
           result_asset_id = $3::uuid,
           result_content_sha256 = $4,
           completed_at = clock_timestamp(),
           updated_by = $5
      WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        organizationId,
        job.id,
        canonical.asset.id,
        image.contentSha256,
        actorEmail,
      ],
    )
    const activeBindings = []
    for (const persisted of persistedTargets) {
      activeBindings.push(await activateCommerceProductImageBinding(client, {
        job,
        observation,
        target: persisted.target,
        assetId: persisted.asset.id,
        actorEmail,
      }))
    }
    const currentTargetKeys = new Set(targets.map((target) => (
      `${target.pipelineId}:${target.productId}`
    )))
    for (const prior of priorBindingScopes.rows) {
      if (currentTargetKeys.has(`${prior.pipeline_id}:${prior.product_id}`)) {
        continue
      }
      const primaryChanged = await electCurrentProviderImagePrimary(client, {
        organizationId,
        pipelineId: prior.pipeline_id,
        productId: prior.product_id,
        actorEmail,
        auditFence: `${job.global_id}:${prior.global_id}:fanout-target-removed`,
      })
      if (primaryChanged) {
        await enqueueSuiteCrmProductImageProjectionWithClient(client, {
          organizationId,
          pipelineId: prior.pipeline_id,
          productId: prior.product_id,
          actorEmail,
        })
      }
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.commerce_product_image_import.fanout_completed',
      aggregateType: 'operations_commerce_product_image_import_job',
      aggregateId: job.global_id,
      organizationId,
      eventKey: `commerce-product-image-fanout:${job.global_id}`,
      payload: {
        jobGlobalId: job.global_id,
        observationId: job.observation_id,
        provider: job.provider,
        integrationAccountId: job.integration_account_id,
        credentialGeneration: job.credential_generation,
        externalProductId: job.external_product_id,
        imageIdentitySha256: job.image_identity_sha256,
        mappingCount: job.mapping_count,
        mappingFingerprintSha256: job.mapping_fingerprint_sha256,
        activationRevision: job.activation_revision,
        targetCount: persistedTargets.length,
        storedByteLength: image.byteLength,
        storedContentSha256: image.contentSha256,
        storedMimeType: image.mimeType,
        sourceByteLength: sourceEvidence.sourceByteLength,
        sourceContentSha256: sourceEvidence.sourceContentSha256,
        normalizationVersion: sourceEvidence.normalizationVersion,
        targets: persistedTargets.map((entry) => ({
          pipelineId: entry.target.pipelineId,
          productId: entry.target.productId,
          productMappingId: entry.target.productMappingId,
          targetMappingCount: entry.target.targetMappingCount,
          targetMappingFingerprintSha256:
            entry.target.targetMappingFingerprintSha256,
          assetId: entry.asset.id,
          assetRevision: positiveInteger(
            entry.asset.asset_revision,
            'fan-out asset revision',
          ),
          assetContentSha256: image.contentSha256,
          provenanceGlobalId: entry.provenance.global_id,
          reusedAsset: entry.reusedAsset,
        })),
        providerWrites: 0,
      },
    }, client)
    const canonicalBinding = activeBindings[
      persistedTargets.indexOf(canonical)
    ]
    if (!canonicalBinding) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_BINDING_SAVE_FAILED',
        'Canonical commerce product image fan-out binding is missing',
        500,
      )
    }
    return {
      jobId: job.id,
      jobGlobalId: job.global_id,
      assetId: canonical.asset.id,
      assetRevision: positiveInteger(
        canonical.asset.asset_revision,
        'asset revision',
      ),
      assetContentSha256: image.contentSha256,
      provenanceId: canonical.provenance.id,
      provenanceGlobalId: canonical.provenance.global_id,
      reusedAsset: canonical.reusedAsset,
      isPrimary: canonicalBinding.isPrimary,
      targetCount: persistedTargets.length,
      replayed: false,
    }
  })
}

export async function recordCommerceProductImageImportWorkerHeartbeatInPostgres(
  input: {
    phase: CommerceProductImageImportWorkerPhase
    checkedAt?: Date | string
  },
): Promise<{ phase: CommerceProductImageImportWorkerPhase; checkedAt: string }> {
  if (!['starting', 'completed', 'degraded'].includes(input.phase)) {
    fail('COMMERCE_PRODUCT_IMAGE_INPUT_INVALID', 'Worker heartbeat phase is invalid')
  }
  const checkedAt = input.checkedAt === undefined
    ? new Date().toISOString()
    : sourceTimestamp(input.checkedAt, 'Worker heartbeat timestamp')
  return withTransaction(async (client) => {
    const saved = await client.query<{
      phase: CommerceProductImageImportWorkerPhase
      checked_at: Date | string
    }>(
      `INSERT INTO operations_commerce_product_image_import_worker_heartbeat (
         singleton, phase, checked_at
       ) VALUES (true, $1, $2::timestamptz)
       ON CONFLICT (singleton) DO UPDATE SET
         phase = EXCLUDED.phase,
         checked_at = EXCLUDED.checked_at
       WHERE operations_commerce_product_image_import_worker_heartbeat
               .checked_at <= EXCLUDED.checked_at
       RETURNING phase, checked_at`,
      [input.phase, checkedAt],
    )
    let row = saved.rows[0]
    if (!row) {
      const current = await client.query<{
        phase: CommerceProductImageImportWorkerPhase
        checked_at: Date | string
      }>(
        `SELECT phase, checked_at
         FROM operations_commerce_product_image_import_worker_heartbeat
         WHERE singleton = true`,
      )
      row = current.rows[0]
    }
    if (!row || !['starting', 'completed', 'degraded'].includes(row.phase)) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
        'Stored image import worker heartbeat is invalid',
        500,
      )
    }
    return { phase: row.phase, checkedAt: iso(row.checked_at, 'heartbeat timestamp') }
  })
}

export async function readCommerceProductImageImportQueueHealthInPostgres():
Promise<CommerceProductImageImportQueueHealth> {
  return withTransaction(async (client) => {
    const counts = await client.query<{
      waiting_mapping_count: string
      queued_count: string
      retry_count: string
      claimed_count: string
      dead_count: string
      historical_dead_count: string
      stale_lease_count: string
      overdue_count: string
    }>(
      `SELECT
         count(*) FILTER (WHERE state = 'waiting_mapping')::text
           AS waiting_mapping_count,
         count(*) FILTER (WHERE state = 'queued')::text AS queued_count,
         count(*) FILTER (WHERE state = 'retry')::text AS retry_count,
         count(*) FILTER (WHERE state = 'claimed')::text AS claimed_count,
         count(*) FILTER (
           WHERE job.state = 'dead'
             AND NOT EXISTS (
               SELECT 1
               FROM operations_commerce_product_image_import_jobs newer
               WHERE newer.organization_id = job.organization_id
                 AND newer.observation_id = job.observation_id
                 AND newer.job_generation > job.job_generation
             )
         )::text AS dead_count,
         count(*) FILTER (
           WHERE job.state = 'dead'
             AND EXISTS (
               SELECT 1
               FROM operations_commerce_product_image_import_jobs newer
               WHERE newer.organization_id = job.organization_id
                 AND newer.observation_id = job.observation_id
                 AND newer.job_generation > job.job_generation
             )
         )::text AS historical_dead_count,
         count(*) FILTER (
           WHERE state = 'claimed'
             AND lease_expires_at <= statement_timestamp()
         )::text AS stale_lease_count,
         count(*) FILTER (
           WHERE state IN ('queued', 'retry')
             AND available_at <=
                   statement_timestamp() - interval '5 minutes'
         )::text AS overdue_count
       FROM operations_commerce_product_image_import_jobs job`,
    )
    const heartbeat = await client.query<{
      phase: CommerceProductImageImportWorkerPhase
      checked_at: Date | string
    }>(
      `SELECT phase, checked_at
       FROM operations_commerce_product_image_import_worker_heartbeat
       WHERE singleton = true`,
    )
    const row = counts.rows[0]
    if (!row) {
      fail(
        'COMMERCE_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
        'Image import queue health evidence is missing',
        500,
      )
    }
    const latestHeartbeat = heartbeat.rows[0]
    return {
      waitingMappingCount: nonnegativeInteger(
        row.waiting_mapping_count,
        'waiting mapping count',
      ),
      queuedCount: nonnegativeInteger(row.queued_count, 'queued count'),
      retryCount: nonnegativeInteger(row.retry_count, 'retry count'),
      claimedCount: nonnegativeInteger(row.claimed_count, 'claimed count'),
      deadCount: nonnegativeInteger(row.dead_count, 'dead count'),
      historicalDeadCount: nonnegativeInteger(
        row.historical_dead_count,
        'historical dead count',
      ),
      staleLeaseCount: nonnegativeInteger(
        row.stale_lease_count,
        'stale lease count',
      ),
      overdueCount: nonnegativeInteger(row.overdue_count, 'overdue count'),
      heartbeat: latestHeartbeat
        ? {
            phase: latestHeartbeat.phase,
            checkedAt: iso(latestHeartbeat.checked_at, 'heartbeat timestamp'),
          }
        : null,
    }
  })
}

// This persistence boundary intentionally contains no provider adapter, fetch,
// URL, mutation intent, or provider-write accounting. A later worker may claim
// one exact job, validate bytes outside provider state, and call the atomic
// completion function above.
export const COMMERCE_PRODUCT_IMAGE_IMPORT_SUPPORTED_MIME_TYPES:
  readonly CrmProductImageMimeType[] = [
    'image/png',
    'image/jpeg',
    'image/webp',
  ]
