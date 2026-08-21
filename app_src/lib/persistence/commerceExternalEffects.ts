import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

export type CommerceExternalEffectProvider = 'shopify' | 'faire'
export type CommerceExternalEffectMode = 'shadow' | 'active'
export type CommerceExternalEffectState =
  | 'pending'
  | 'claimed'
  | 'simulated'
  | 'succeeded'
  | 'failed'
  | 'unknown'
export type CommerceExternalEffectTerminalState =
  | 'succeeded'
  | 'failed'
  | 'unknown'

type TimestampValue = string | Date

type ExternalEffectRow = {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  integration_account_global_id: string
  provider: CommerceExternalEffectProvider
  action: string
  desired_mode: CommerceExternalEffectMode
  credential_generation: number
  activation_revision: number
  aggregate_type: string
  aggregate_id: string
  aggregate_revision: string | number
  aggregate_hash: string
  idempotency_key: string
  request_hash: string
  redacted_request: Record<string, unknown>
  state: CommerceExternalEffectState
  provider_attempt_id: string | null
  lease_token: string | null
  lease_expires_at: TimestampValue | null
  claimed_by: string | null
  claimed_at: TimestampValue | null
  redacted_result: Record<string, unknown> | null
  terminal_evidence_hash: string | null
  provider_reference: string | null
  error_code: string | null
  provider_write_count: number
  completed_at: TimestampValue | null
  created_by: string | null
  created_at: TimestampValue
  updated_at: TimestampValue
  claimable?: boolean
  stale_reason?: string | null
}

type AccountFenceRow = {
  id: string
  global_id: string
  provider: CommerceExternalEffectProvider
  status: 'active' | 'disabled' | 'error'
  commerce_credential_generation: number
  credential_version: number
  verification_status: 'unverified' | 'verified' | 'failed'
  activation_state: string
  activation_revision: number
}

type AggregateFenceRow = {
  aggregate_revision: string | number
  aggregate_hash: string
}

export type CommerceExternalEffect = {
  id: string
  globalId: string
  organizationId: string
  integrationAccountId: string
  integrationAccountGlobalId: string
  provider: CommerceExternalEffectProvider
  action: string
  desiredMode: CommerceExternalEffectMode
  credentialGeneration: number
  activationRevision: number
  aggregateType: string
  aggregateId: string
  aggregateRevision: number
  aggregateHash: string
  idempotencyKey: string
  requestHash: string
  redactedRequest: Record<string, unknown>
  state: CommerceExternalEffectState
  providerAttemptId: string | null
  leaseToken: string | null
  leaseExpiresAt: string | null
  claimedBy: string | null
  claimedAt: string | null
  redactedResult: Record<string, unknown> | null
  terminalEvidenceHash: string | null
  providerReference: string | null
  errorCode: string | null
  providerWriteCount: number
  completedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  claimable: boolean
  staleReason: string | null
}

export type ClaimedCommerceExternalEffect = CommerceExternalEffect & {
  state: 'claimed'
  providerAttemptId: string
  leaseToken: string
  leaseExpiresAt: string
  claimedBy: string
  claimedAt: string
}

export class CommerceExternalEffectPersistenceError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CommerceExternalEffectPersistenceError'
    this.code = code
    this.status = status
  }
}

const SHA256 = /^[a-f0-9]{64}$/
const CODE = /^[a-z][a-z0-9_.:-]{0,127}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/
const FORBIDDEN_REDACTED_KEYS = new Set([
  'authorization',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'secret',
  'secretid',
  'password',
  'apikey',
  'privatekey',
  'xshopifyaccesstoken',
])
const TERMINAL_STATES = new Set<CommerceExternalEffectState>([
  'simulated',
  'succeeded',
  'failed',
  'unknown',
])

function externalEffectError(
  code: string,
  message: string,
  status = 409,
): never {
  throw new CommerceExternalEffectPersistenceError(code, message, status)
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      externalEffectError(
        'COMMERCE_EXTERNAL_EFFECT_JSON_INVALID',
        'External-effect evidence cannot contain a non-finite number',
        400,
      )
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object') {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_JSON_INVALID',
      'External-effect evidence must be valid JSON',
      400,
    )
  }
  if (ancestors.has(value)) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_JSON_INVALID',
      'External-effect evidence cannot be recursive',
      400,
    )
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      externalEffectError(
        'COMMERCE_EXTERNAL_EFFECT_JSON_INVALID',
        'External-effect evidence must contain plain JSON objects',
        400,
      )
    }
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key], ancestors)}`
    )).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function commerceExternalEffectHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function normalizedEvidenceKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function inspectRedactedEvidence(
  value: unknown,
  path: string,
  ancestors: Set<object>,
) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_EVIDENCE_INVALID',
      `External-effect evidence at ${path} contains a non-finite number`,
      400,
    )
  }
  if (typeof value !== 'object') {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_EVIDENCE_INVALID',
      `External-effect evidence at ${path} is not JSON`,
      400,
    )
  }
  if (ancestors.has(value)) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_EVIDENCE_INVALID',
      'External-effect evidence cannot be recursive',
      400,
    )
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        inspectRedactedEvidence(item, `${path}[${index}]`, ancestors)
      })
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      externalEffectError(
        'COMMERCE_EXTERNAL_EFFECT_EVIDENCE_INVALID',
        `External-effect evidence at ${path} must be a plain object`,
        400,
      )
    }
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_REDACTED_KEYS.has(normalizedEvidenceKey(key))) {
        externalEffectError(
          'COMMERCE_EXTERNAL_EFFECT_EVIDENCE_NOT_REDACTED',
          `External-effect evidence contains the sensitive field ${key}`,
          400,
        )
      }
      inspectRedactedEvidence(nested, `${path}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

export function assertRedactedCommerceExternalEffectEvidence(
  value: unknown,
  label = 'External-effect evidence',
): asserts value is Record<string, unknown> {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_EVIDENCE_INVALID',
      `${label} must be a JSON object`,
      400,
    )
  }
  inspectRedactedEvidence(value, '$', new Set())
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > 1048576) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_EVIDENCE_TOO_LARGE',
      `${label} exceeds the one-megabyte evidence limit`,
      413,
    )
  }
}

function validateIdentifier(value: string, label: string, maxLength = 512) {
  if (
    !value
    || value.trim() !== value
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_IDENTIFIER_INVALID',
      `${label} is invalid`,
      400,
    )
  }
}

function externalEffect(row: ExternalEffectRow): CommerceExternalEffect {
  return {
    id: row.id,
    globalId: row.global_id,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    integrationAccountGlobalId: row.integration_account_global_id,
    provider: row.provider,
    action: row.action,
    desiredMode: row.desired_mode,
    credentialGeneration: row.credential_generation,
    activationRevision: row.activation_revision,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateRevision: Number(row.aggregate_revision),
    aggregateHash: row.aggregate_hash,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    redactedRequest: row.redacted_request,
    state: row.state,
    providerAttemptId: row.provider_attempt_id,
    leaseToken: row.lease_token,
    leaseExpiresAt: iso(row.lease_expires_at),
    claimedBy: row.claimed_by,
    claimedAt: iso(row.claimed_at),
    redactedResult: row.redacted_result,
    terminalEvidenceHash: row.terminal_evidence_hash,
    providerReference: row.provider_reference,
    errorCode: row.error_code,
    providerWriteCount: row.provider_write_count,
    completedAt: iso(row.completed_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    claimable: Boolean(row.claimable),
    staleReason: row.stale_reason || null,
  }
}

const EXTERNAL_EFFECT_SELECT = `SELECT
    intent.id::text,
    intent.global_id,
    intent.organization_id::text,
    intent.integration_account_id::text,
    account.global_id AS integration_account_global_id,
    intent.provider,
    intent.action,
    intent.desired_mode,
    intent.credential_generation,
    intent.activation_revision,
    intent.aggregate_type,
    intent.aggregate_id,
    intent.aggregate_revision::text,
    intent.aggregate_hash,
    intent.idempotency_key,
    intent.request_hash,
    intent.redacted_request,
    intent.state,
    intent.provider_attempt_id::text,
    intent.lease_token::text,
    intent.lease_expires_at,
    intent.claimed_by,
    intent.claimed_at,
    intent.redacted_result,
    intent.terminal_evidence_hash,
    intent.provider_reference,
    intent.error_code,
    intent.provider_write_count,
    intent.completed_at,
    intent.created_by,
    intent.created_at,
    intent.updated_at`

function assertInput(input: {
  provider: CommerceExternalEffectProvider
  action: string
  desiredMode: CommerceExternalEffectMode
  credentialGeneration: number
  activationRevision: number
  aggregateType: string
  aggregateId: string
  aggregateRevision: number
  aggregateHash: string
  idempotencyKey: string
  redactedRequest: Record<string, unknown>
  simulationEvidence?: Record<string, unknown> | null
}) {
  if (!['shopify', 'faire'].includes(input.provider)) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_PROVIDER_INVALID',
      'External effects support Shopify or Faire',
      400,
    )
  }
  if (!CODE.test(input.action) || !CODE.test(input.aggregateType)) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_CODE_INVALID',
      'External-effect action and aggregate type must use stable codes',
      400,
    )
  }
  if (!['shadow', 'active'].includes(input.desiredMode)) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_MODE_INVALID',
      'External-effect mode must be Shadow or Active',
      400,
    )
  }
  if (
    !Number.isSafeInteger(input.credentialGeneration)
    || input.credentialGeneration < 1
    || !Number.isSafeInteger(input.activationRevision)
    || input.activationRevision < 1
    || !Number.isSafeInteger(input.aggregateRevision)
    || input.aggregateRevision < 0
    || !SHA256.test(input.aggregateHash)
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_REVISION_INVALID',
      'External-effect revision fences are invalid',
      400,
    )
  }
  validateIdentifier(input.aggregateId, 'Aggregate identifier')
  validateIdentifier(input.idempotencyKey, 'Idempotency key', 255)
  assertRedactedCommerceExternalEffectEvidence(
    input.redactedRequest,
    'Redacted provider request',
  )
  if (input.desiredMode === 'shadow') {
    assertRedactedCommerceExternalEffectEvidence(
      input.simulationEvidence,
      'Shadow simulation evidence',
    )
    if (input.simulationEvidence.providerWrites !== 0) {
      externalEffectError(
        'COMMERCE_EXTERNAL_EFFECT_SHADOW_WRITE_INVALID',
        'Shadow simulation evidence must record zero provider writes',
        400,
      )
    }
  } else if (input.simulationEvidence !== undefined
    && input.simulationEvidence !== null) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_ACTIVE_SIMULATION_INVALID',
      'Active intents cannot be prepared with Shadow simulation evidence',
      400,
    )
  }
}

async function readAccountFence(
  client: PoolClient,
  input: {
    organizationId: string
    accountGlobalId: string
  },
) {
  const result = await client.query<AccountFenceRow>(
    `SELECT
       account.id::text,
       account.global_id,
       account.provider,
       account.status,
       account.commerce_credential_generation,
       credential.credential_version,
       credential.verification_status,
       activation.state AS activation_state,
       activation.revision AS activation_revision
     FROM operations_integration_accounts account
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
     FOR UPDATE OF account, activation`,
    [input.organizationId, input.accountGlobalId],
  )
  if (!result.rows[0]) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_ACCOUNT_UNAVAILABLE',
      'The commerce connection, credential, or Operations activation is unavailable',
      404,
    )
  }
  return result.rows[0]
}

function assertCurrentAccountFence(
  account: AccountFenceRow,
  input: {
    provider: CommerceExternalEffectProvider
    action: string
    desiredMode: CommerceExternalEffectMode
    credentialGeneration: number
    activationRevision: number
    aggregateType: string
  },
  exactProductMediaAuthority = false,
) {
  const checkoutCarrierServiceSimulation = (
    input.provider === 'shopify'
    && input.desiredMode === 'shadow'
    && input.aggregateType === 'shopify_carrier_service_configuration'
    && [
      'shopify.carrier_service.create',
      'shopify.carrier_service.update',
      'shopify.carrier_service.delete',
    ].includes(input.action)
  )
  if (
    account.provider !== input.provider
    || (
      input.desiredMode === 'active'
      && (
        exactProductMediaAuthority
          ? account.status === 'error'
          : account.status !== 'active'
      )
    )
    || (
      input.desiredMode === 'shadow'
      && account.status === 'error'
    )
    || account.commerce_credential_generation !== input.credentialGeneration
    || account.credential_version !== input.credentialGeneration
    || account.verification_status !== 'verified'
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_CREDENTIAL_STALE',
      'The commerce credential changed or is no longer verified',
    )
  }
  if (
    (
      !checkoutCarrierServiceSimulation
      && account.activation_state !== (
        exactProductMediaAuthority ? 'shadow' : input.desiredMode
      )
    )
    || account.activation_revision !== input.activationRevision
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_ACTIVATION_STALE',
      'Operations activation changed after this effect was reviewed',
    )
  }
}

async function exactShopifyProductMediaAuthorityIsCurrent(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    provider: CommerceExternalEffectProvider
    action: string
    desiredMode: CommerceExternalEffectMode
    credentialGeneration: number
    activationRevision: number
    aggregateId: string
    aggregateRevision: number
    aggregateHash: string
    idempotencyKey: string
    redactedRequest: Record<string, unknown>
    shopifyProductMediaAuthorizationId?: string | null
    actorEmail?: string | null
  },
) {
  if (!input.shopifyProductMediaAuthorizationId) return false
  if (
    input.provider !== 'shopify'
    || input.action !== 'shopify.product.update'
    || input.desiredMode !== 'active'
    || !input.actorEmail
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_PRODUCT_MEDIA_AUTHORITY_INVALID',
      'Exact Shopify Product-image authority is invalid',
    )
  }
  const result = await client.query<{ authorized: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM operations_shopify_product_media_write_authorizations auth
       JOIN operations_shopify_product_media_delivery_grants media_grant
         ON media_grant.organization_id = auth.organization_id
        AND media_grant.id = auth.delivery_grant_id
       JOIN operations_shopify_product_media_source_bindings
         source_binding
         ON source_binding.organization_id = auth.organization_id
        AND source_binding.integration_account_id =
              auth.integration_account_id
        AND source_binding.authorization_id = auth.id
        AND source_binding.delivery_grant_id = media_grant.id
       JOIN operations_integration_accounts media_account
         ON media_account.organization_id = auth.organization_id
        AND media_account.id = auth.integration_account_id
       JOIN operations_commerce_credentials media_credential
         ON media_credential.organization_id = media_account.organization_id
        AND media_credential.integration_account_id = media_account.id
       JOIN operations_activation_scopes media_activation
         ON media_activation.organization_id = media_account.organization_id
       JOIN crm_products media_product
         ON media_product.pipeline_id = media_grant.pipeline_id
        AND media_product.id = media_grant.product_id
       JOIN operations_product_channel_states media_channel
         ON media_channel.organization_id = media_grant.organization_id
        AND media_channel.integration_account_id =
              media_grant.integration_account_id
        AND media_channel.id = media_grant.channel_state_id
       JOIN operations_product_mappings media_mapping
         ON media_mapping.organization_id = media_channel.organization_id
        AND media_mapping.integration_account_id =
              media_channel.integration_account_id
        AND media_mapping.pipeline_id = media_channel.pipeline_id
        AND media_mapping.id = media_channel.product_mapping_id
       JOIN crm_product_image_assets media_asset
         ON media_asset.organization_id = media_grant.organization_id
        AND media_asset.pipeline_id = media_grant.pipeline_id
        AND media_asset.product_id = media_grant.product_id
        AND media_asset.id = media_grant.image_asset_id
       JOIN operations_commerce_external_effect_intents simulation
         ON simulation.organization_id = auth.organization_id
        AND simulation.id = auth.simulation_effect_id
       JOIN operations_shopify_product_media_delivery_grants
         simulation_grant
         ON simulation_grant.organization_id = simulation.organization_id
        AND simulation_grant.integration_account_id =
              simulation.integration_account_id
        AND simulation_grant.idempotency_key = simulation.idempotency_key
       WHERE auth.organization_id = $1::uuid
         AND auth.id = $2::uuid
         AND auth.integration_account_id = $3::uuid
         AND auth.authorized_by = $4
         AND auth.expires_at > clock_timestamp()
         AND auth.provider_write_activation_revision = $6
         AND auth.confirmation_statement_version =
               'shopify-product-image-shadow-provider-write-v1'
         AND media_grant.desired_mode = 'active'
         AND media_grant.credential_generation = $5
         AND media_grant.activation_revision = $6
         AND media_grant.product_reference_code = $7
         AND media_grant.aggregate_revision = $8::bigint
         AND media_grant.aggregate_hash = $9
         AND media_grant.idempotency_key = $10
         AND $11::jsonb->>'productMediaAuthorizationId' =
               auth.id::text
         AND $11::jsonb->>'deliveryGrantId' =
               media_grant.id::text
         AND $11::jsonb
               ->'patch'->'media'->>'originalSourceSha256' =
               source_binding.source_url_sha256
         AND $11::jsonb
               ->'patch'->'media'->>'sourceHost' =
               source_binding.source_host
         AND media_grant.external_variant_id =
               media_channel.external_variant_id
         AND media_grant.channel_normalized_status = 'active'
         AND media_grant.channel_provider_active = true
         AND media_account.integration_type = 'commerce'
         AND media_account.provider = 'shopify'
         AND media_account.status IN ('active', 'disabled')
         AND media_account.commerce_credential_generation = $5
         AND media_credential.credential_version = $5
         AND media_credential.verification_status = 'verified'
         AND media_activation.state = 'shadow'
         AND media_activation.revision = $6
         AND media_product.reference_code =
               media_grant.product_reference_code
         AND media_product.source_hash = media_grant.product_source_hash
         AND media_channel.product_id = media_grant.product_id
         AND media_channel.global_id =
               media_grant.channel_state_global_id
         AND media_channel.external_product_id = media_grant.product_gid
         AND media_channel.external_variant_id =
               media_grant.external_variant_id
         AND media_channel.row_version =
               media_grant.channel_state_row_version
         AND media_channel.source_revision =
               media_grant.channel_source_revision
         AND media_channel.source_hash =
               media_grant.channel_source_hash
         AND media_channel.normalized_status = 'active'
         AND media_channel.provider_active = true
         AND media_mapping.product_id = media_grant.product_id
         AND media_mapping.external_product_id = media_grant.product_gid
         AND media_mapping.external_variant_id =
               media_grant.external_variant_id
         AND media_mapping.active = true
         AND media_asset.asset_revision = media_grant.asset_revision
         AND media_asset.row_version = media_grant.asset_row_version
         AND media_asset.content_sha256 =
               media_grant.asset_content_sha256
         AND media_asset.is_primary = true
         AND simulation.provider = 'shopify'
         AND simulation.action = 'shopify.product.update'
         AND simulation.desired_mode = 'shadow'
         AND simulation.state = 'simulated'
         AND simulation.provider_write_count = 0
         AND simulation_grant.desired_mode = 'shadow'
         AND simulation_grant.product_id = media_grant.product_id
         AND simulation_grant.channel_state_id =
               media_grant.channel_state_id
         AND simulation_grant.image_asset_id = media_grant.image_asset_id
         AND simulation_grant.product_reference_code =
               media_grant.product_reference_code
         AND simulation_grant.product_source_hash =
               media_grant.product_source_hash
         AND simulation_grant.product_gid = media_grant.product_gid
         AND simulation_grant.external_variant_id =
               media_grant.external_variant_id
         AND simulation_grant.channel_state_row_version =
               media_grant.channel_state_row_version
         AND simulation_grant.channel_source_revision =
               media_grant.channel_source_revision
         AND simulation_grant.channel_source_hash =
               media_grant.channel_source_hash
         AND simulation_grant.asset_revision = media_grant.asset_revision
         AND simulation_grant.asset_row_version =
               media_grant.asset_row_version
         AND simulation_grant.asset_content_sha256 =
               media_grant.asset_content_sha256
         AND simulation_grant.credential_generation =
               media_grant.credential_generation
         AND simulation_grant.activation_revision =
               media_grant.activation_revision
         AND NOT EXISTS (
           SELECT 1
           FROM operations_product_channel_states sibling
           WHERE sibling.organization_id = media_grant.organization_id
             AND sibling.integration_account_id =
                   media_grant.integration_account_id
             AND sibling.provider = 'shopify'
             AND sibling.external_product_id = media_grant.product_gid
             AND sibling.product_id IS NOT NULL
             AND sibling.product_id <> media_grant.product_id
         )
     ) AS authorized`,
    [
      input.organizationId,
      input.shopifyProductMediaAuthorizationId,
      input.integrationAccountId,
      input.actorEmail,
      input.credentialGeneration,
      input.activationRevision,
      input.aggregateId,
      input.aggregateRevision,
      input.aggregateHash,
      input.idempotencyKey,
      JSON.stringify(input.redactedRequest),
    ],
  )
  if (result.rows[0]?.authorized !== true) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_PRODUCT_MEDIA_AUTHORITY_STALE',
      'Exact Shopify Product-image authority is missing or stale',
    )
  }
  return true
}

async function readExistingEffect(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    action: string
    idempotencyKey: string
  },
) {
  const result = await client.query<ExternalEffectRow>(
    `${EXTERNAL_EFFECT_SELECT}
     FROM operations_commerce_external_effect_intents intent
     JOIN operations_integration_accounts account
       ON account.organization_id = intent.organization_id
      AND account.id = intent.integration_account_id
     WHERE intent.organization_id = $1::uuid
       AND intent.integration_account_id = $2::uuid
       AND intent.action = $3
       AND intent.idempotency_key = $4
     FOR SHARE OF intent`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.action,
      input.idempotencyKey,
    ],
  )
  return result.rows[0] || null
}

function assertReplayMatches(
  row: ExternalEffectRow,
  input: {
    provider: CommerceExternalEffectProvider
    desiredMode: CommerceExternalEffectMode
    credentialGeneration: number
    activationRevision: number
    aggregateType: string
    aggregateId: string
    aggregateRevision: number
    aggregateHash: string
    requestHash: string
    simulationEvidence?: Record<string, unknown> | null
  },
) {
  const simulationHash = input.simulationEvidence
    ? commerceExternalEffectHash(input.simulationEvidence)
    : null
  if (
    row.provider !== input.provider
    || row.desired_mode !== input.desiredMode
    || row.credential_generation !== input.credentialGeneration
    || row.activation_revision !== input.activationRevision
    || row.aggregate_type !== input.aggregateType
    || row.aggregate_id !== input.aggregateId
    || Number(row.aggregate_revision) !== input.aggregateRevision
    || row.aggregate_hash !== input.aggregateHash
    || row.request_hash !== input.requestHash
    || (
      input.desiredMode === 'shadow'
      && row.terminal_evidence_hash !== simulationHash
    )
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT',
      'This idempotency key was already used for different external-effect content',
    )
  }
}

async function advanceAggregateFence(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    provider: CommerceExternalEffectProvider
    aggregateType: string
    aggregateId: string
    aggregateRevision: number
    aggregateHash: string
  },
) {
  const advanced = await client.query<AggregateFenceRow>(
    `INSERT INTO operations_commerce_external_effect_aggregate_fences (
       organization_id, integration_account_id, provider,
       aggregate_type, aggregate_id, aggregate_revision, aggregate_hash
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::bigint, $7)
     ON CONFLICT (
       organization_id, integration_account_id, provider,
       aggregate_type, aggregate_id
     ) DO UPDATE SET
       aggregate_revision = EXCLUDED.aggregate_revision,
       aggregate_hash = EXCLUDED.aggregate_hash,
       updated_at = now()
     WHERE operations_commerce_external_effect_aggregate_fences
             .aggregate_revision < EXCLUDED.aggregate_revision
     RETURNING aggregate_revision::text, aggregate_hash`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.provider,
      input.aggregateType,
      input.aggregateId,
      input.aggregateRevision,
      input.aggregateHash,
    ],
  )
  if (advanced.rows[0]) return

  const current = await client.query<AggregateFenceRow>(
    `SELECT aggregate_revision::text, aggregate_hash
     FROM operations_commerce_external_effect_aggregate_fences
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND provider = $3
       AND aggregate_type = $4
       AND aggregate_id = $5
     FOR SHARE`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.provider,
      input.aggregateType,
      input.aggregateId,
    ],
  )
  const row = current.rows[0]
  if (
    row
    && Number(row.aggregate_revision) === input.aggregateRevision
    && row.aggregate_hash === input.aggregateHash
  ) return
  if (row && Number(row.aggregate_revision) > input.aggregateRevision) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_AGGREGATE_STALE',
      'The source aggregate advanced after this external effect was reviewed',
    )
  }
  externalEffectError(
    'COMMERCE_EXTERNAL_EFFECT_AGGREGATE_CONFLICT',
    'The source aggregate revision has conflicting content',
  )
}

export async function prepareCommerceExternalEffectInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  provider: CommerceExternalEffectProvider
  action: string
  desiredMode: CommerceExternalEffectMode
  credentialGeneration: number
  activationRevision: number
  aggregateType: string
  aggregateId: string
  aggregateRevision: number
  aggregateHash: string
  idempotencyKey: string
  redactedRequest: Record<string, unknown>
  simulationEvidence?: Record<string, unknown> | null
  shopifyProductMediaAuthorizationId?: string | null
  actorEmail?: string | null
}) {
  assertInput(input)
  const requestHash = commerceExternalEffectHash(input.redactedRequest)
  const simulationEvidence = input.simulationEvidence || null
  const simulationHash = simulationEvidence
    ? commerceExternalEffectHash(simulationEvidence)
    : null

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-external-effect:${input.organizationId}:${input.accountGlobalId}:${input.action}:${input.idempotencyKey}`,
    )
    const account = await readAccountFence(client, input)
    const existing = await readExistingEffect(client, {
      organizationId: input.organizationId,
      integrationAccountId: account.id,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
    })
    if (existing) {
      assertReplayMatches(existing, {
        ...input,
        requestHash,
        simulationEvidence,
      })
      return externalEffect(existing)
    }

    const exactProductMediaAuthority =
      await exactShopifyProductMediaAuthorityIsCurrent(client, {
        ...input,
        integrationAccountId: account.id,
      })
    assertCurrentAccountFence(
      account,
      input,
      exactProductMediaAuthority,
    )
    await advanceAggregateFence(client, {
      organizationId: input.organizationId,
      integrationAccountId: account.id,
      provider: input.provider,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      aggregateRevision: input.aggregateRevision,
      aggregateHash: input.aggregateHash,
    })

    const inserted = await client.query<ExternalEffectRow>(
      `INSERT INTO operations_commerce_external_effect_intents (
         organization_id, integration_account_id, provider, action,
         desired_mode, credential_generation, activation_revision,
         aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
         idempotency_key, request_hash, redacted_request,
         shopify_product_media_authorization_id, state,
         redacted_result, terminal_evidence_hash, provider_write_count,
         completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::bigint,
         $11, $12, $13, $14::jsonb, $15::uuid,
         CASE WHEN $5 = 'shadow' THEN 'simulated' ELSE 'pending' END,
         CASE WHEN $5 = 'shadow' THEN $16::jsonb ELSE NULL END,
         CASE WHEN $5 = 'shadow' THEN $17 ELSE NULL END,
         0,
         CASE WHEN $5 = 'shadow' THEN now() ELSE NULL END,
         $18
       )
       RETURNING
         id::text,
         global_id,
         organization_id::text,
         integration_account_id::text,
         $19 AS integration_account_global_id,
         provider,
         action,
         desired_mode,
         credential_generation,
         activation_revision,
         aggregate_type,
         aggregate_id,
         aggregate_revision::text,
         aggregate_hash,
         idempotency_key,
         request_hash,
         redacted_request,
         state,
         provider_attempt_id::text,
         lease_token::text,
         lease_expires_at,
         claimed_by,
         claimed_at,
         redacted_result,
         terminal_evidence_hash,
         provider_reference,
         error_code,
         provider_write_count,
         completed_at,
         created_by,
         created_at,
         updated_at`,
      [
        input.organizationId,
        account.id,
        input.provider,
        input.action,
        input.desiredMode,
        input.credentialGeneration,
        input.activationRevision,
        input.aggregateType,
        input.aggregateId,
        input.aggregateRevision,
        input.aggregateHash,
        input.idempotencyKey,
        requestHash,
        JSON.stringify(input.redactedRequest),
        input.shopifyProductMediaAuthorizationId || null,
        simulationEvidence ? JSON.stringify(simulationEvidence) : null,
        simulationHash,
        input.actorEmail || null,
        account.global_id,
      ],
    )
    return externalEffect(inserted.rows[0])
  })
}

function exactProductMediaClaimAuthoritySql(alias: string) {
  return `EXISTS (
    SELECT 1
    FROM operations_shopify_product_media_write_authorizations auth
    JOIN operations_shopify_product_media_delivery_grants media_grant
      ON media_grant.organization_id = auth.organization_id
     AND media_grant.id = auth.delivery_grant_id
    JOIN operations_shopify_product_media_source_bindings source_binding
      ON source_binding.organization_id = auth.organization_id
     AND source_binding.integration_account_id =
           auth.integration_account_id
     AND source_binding.authorization_id = auth.id
     AND source_binding.delivery_grant_id = media_grant.id
    JOIN crm_products media_product
      ON media_product.pipeline_id = media_grant.pipeline_id
     AND media_product.id = media_grant.product_id
    JOIN operations_product_channel_states media_channel
      ON media_channel.organization_id = media_grant.organization_id
     AND media_channel.integration_account_id =
           media_grant.integration_account_id
     AND media_channel.id = media_grant.channel_state_id
    JOIN operations_product_mappings media_mapping
      ON media_mapping.organization_id = media_channel.organization_id
     AND media_mapping.integration_account_id =
           media_channel.integration_account_id
     AND media_mapping.pipeline_id = media_channel.pipeline_id
     AND media_mapping.id = media_channel.product_mapping_id
    JOIN crm_product_image_assets media_asset
      ON media_asset.organization_id = media_grant.organization_id
     AND media_asset.pipeline_id = media_grant.pipeline_id
     AND media_asset.product_id = media_grant.product_id
     AND media_asset.id = media_grant.image_asset_id
    JOIN operations_commerce_external_effect_intents simulation
      ON simulation.organization_id = auth.organization_id
     AND simulation.id = auth.simulation_effect_id
    JOIN operations_shopify_product_media_delivery_grants simulation_grant
      ON simulation_grant.organization_id = simulation.organization_id
     AND simulation_grant.integration_account_id =
           simulation.integration_account_id
     AND simulation_grant.idempotency_key = simulation.idempotency_key
    WHERE auth.organization_id = ${alias}.organization_id
      AND auth.id = ${alias}.shopify_product_media_authorization_id
      AND auth.integration_account_id = ${alias}.integration_account_id
      AND auth.expires_at > clock_timestamp()
      AND auth.provider_write_activation_revision =
            ${alias}.activation_revision
      AND auth.confirmation_statement_version =
            'shopify-product-image-shadow-provider-write-v1'
      AND media_grant.desired_mode = 'active'
      AND media_grant.credential_generation =
            ${alias}.credential_generation
      AND media_grant.activation_revision = ${alias}.activation_revision
      AND media_grant.product_reference_code = ${alias}.aggregate_id
      AND media_grant.aggregate_revision = ${alias}.aggregate_revision
      AND media_grant.aggregate_hash = ${alias}.aggregate_hash
      AND media_grant.idempotency_key = ${alias}.idempotency_key
      AND ${alias}.redacted_request->>'productMediaAuthorizationId' =
            auth.id::text
      AND ${alias}.redacted_request->>'deliveryGrantId' =
            media_grant.id::text
      AND ${alias}.redacted_request
            ->'patch'->'media'->>'originalSourceSha256' =
            source_binding.source_url_sha256
      AND ${alias}.redacted_request
            ->'patch'->'media'->>'sourceHost' =
            source_binding.source_host
      AND media_grant.channel_normalized_status = 'active'
      AND media_grant.channel_provider_active = true
      AND media_product.reference_code =
            media_grant.product_reference_code
      AND media_product.source_hash = media_grant.product_source_hash
      AND media_channel.product_id = media_grant.product_id
      AND media_channel.global_id = media_grant.channel_state_global_id
      AND media_channel.external_product_id = media_grant.product_gid
      AND media_channel.external_variant_id =
            media_grant.external_variant_id
      AND media_channel.row_version = media_grant.channel_state_row_version
      AND media_channel.source_revision =
            media_grant.channel_source_revision
      AND media_channel.source_hash = media_grant.channel_source_hash
      AND media_channel.normalized_status = 'active'
      AND media_channel.provider_active = true
      AND media_mapping.product_id = media_grant.product_id
      AND media_mapping.external_product_id = media_grant.product_gid
      AND media_mapping.external_variant_id =
            media_grant.external_variant_id
      AND media_mapping.active = true
      AND media_asset.asset_revision = media_grant.asset_revision
      AND media_asset.row_version = media_grant.asset_row_version
      AND media_asset.content_sha256 = media_grant.asset_content_sha256
      AND media_asset.is_primary = true
      AND simulation.provider = 'shopify'
      AND simulation.action = 'shopify.product.update'
      AND simulation.desired_mode = 'shadow'
      AND simulation.state = 'simulated'
      AND simulation.provider_write_count = 0
      AND simulation_grant.desired_mode = 'shadow'
      AND simulation_grant.product_id = media_grant.product_id
      AND simulation_grant.channel_state_id = media_grant.channel_state_id
      AND simulation_grant.image_asset_id = media_grant.image_asset_id
      AND simulation_grant.product_reference_code =
            media_grant.product_reference_code
      AND simulation_grant.product_source_hash =
            media_grant.product_source_hash
      AND simulation_grant.product_gid = media_grant.product_gid
      AND simulation_grant.external_variant_id =
            media_grant.external_variant_id
      AND simulation_grant.channel_state_row_version =
            media_grant.channel_state_row_version
      AND simulation_grant.channel_source_revision =
            media_grant.channel_source_revision
      AND simulation_grant.channel_source_hash =
            media_grant.channel_source_hash
      AND simulation_grant.asset_revision = media_grant.asset_revision
      AND simulation_grant.asset_row_version =
            media_grant.asset_row_version
      AND simulation_grant.asset_content_sha256 =
            media_grant.asset_content_sha256
      AND simulation_grant.credential_generation =
            media_grant.credential_generation
      AND simulation_grant.activation_revision =
            media_grant.activation_revision
      AND NOT EXISTS (
        SELECT 1
        FROM operations_product_channel_states sibling
        WHERE sibling.organization_id = media_grant.organization_id
          AND sibling.integration_account_id =
                media_grant.integration_account_id
          AND sibling.provider = 'shopify'
          AND sibling.external_product_id = media_grant.product_gid
          AND sibling.product_id IS NOT NULL
          AND sibling.product_id <> media_grant.product_id
      )
  )`
}

function claimabilitySql(alias = 'intent') {
  const exactProductMediaAuthority =
    exactProductMediaClaimAuthoritySql(alias)
  return `(
    ${alias}.state = 'pending'
    AND ${alias}.desired_mode = 'active'
    AND ${alias}.faire_provider_write_authorization_id IS NULL
    AND (
      account.status = 'active'
      OR (
        account.status = 'disabled'
        AND ${exactProductMediaAuthority}
      )
    )
    AND account.integration_type = 'commerce'
    AND account.provider = ${alias}.provider
    AND account.commerce_credential_generation =
      ${alias}.credential_generation
    AND credential.credential_version = ${alias}.credential_generation
    AND credential.verification_status = 'verified'
    AND (
      activation.state = 'active'
      OR (
        activation.state = 'shadow'
        AND ${exactProductMediaAuthority}
      )
    )
    AND activation.revision = ${alias}.activation_revision
    AND fence.aggregate_revision = ${alias}.aggregate_revision
    AND fence.aggregate_hash = ${alias}.aggregate_hash
  )`
}

export async function claimCommerceExternalEffectsInPostgres(input: {
  workerId: string
  adapterVersion: string
  provider?: CommerceExternalEffectProvider | null
  globalId?: string | null
  limit?: number
  leaseSeconds?: number
}): Promise<ClaimedCommerceExternalEffect[]> {
  validateIdentifier(input.workerId, 'Worker identifier', 255)
  validateIdentifier(input.adapterVersion, 'Adapter version', 128)
  if (
    input.provider
    && !['shopify', 'faire'].includes(input.provider)
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_PROVIDER_INVALID',
      'External effects support Shopify or Faire',
      400,
    )
  }
  if (
    input.globalId
    && !/^gcef(?:[0-9]{7}|[0-9a-v]{12})$/.test(input.globalId)
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_GLOBAL_ID_INVALID',
      'External-effect Global ID is invalid',
      400,
    )
  }
  const limit = Math.max(1, Math.min(Number(input.limit || 10), 50))
  const leaseSeconds = Math.max(
    5,
    Math.min(Number(input.leaseSeconds || 60), 300),
  )

  return withTransaction(async (client) => {
    const candidates = await client.query<ExternalEffectRow>(
      `${EXTERNAL_EFFECT_SELECT},
         true AS claimable,
         NULL::text AS stale_reason
       FROM operations_commerce_external_effect_intents intent
       JOIN operations_integration_accounts account
         ON account.organization_id = intent.organization_id
        AND account.id = intent.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = intent.organization_id
        AND credential.integration_account_id = intent.integration_account_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = intent.organization_id
       JOIN operations_commerce_external_effect_aggregate_fences fence
         ON fence.organization_id = intent.organization_id
        AND fence.integration_account_id = intent.integration_account_id
        AND fence.provider = intent.provider
        AND fence.aggregate_type = intent.aggregate_type
        AND fence.aggregate_id = intent.aggregate_id
       WHERE ${claimabilitySql()}
         AND ($1::text IS NULL OR intent.provider = $1)
         AND ($2::text IS NULL OR intent.global_id = $2)
       ORDER BY intent.created_at, intent.id
       FOR UPDATE OF intent SKIP LOCKED
       LIMIT $3`,
      [input.provider || null, input.globalId || null, limit],
    )

    const claimed: ClaimedCommerceExternalEffect[] = []
    for (const candidate of candidates.rows) {
      const leaseToken = randomUUID()
      const attempt = await client.query<{ id: string }>(
        `INSERT INTO operations_commerce_provider_attempts (
           organization_id, integration_account_id, action, adapter_version,
           idempotency_key, request_hash, redacted_request, state,
           attempt_number, lease_token, lease_expires_at
         ) VALUES (
           $1::uuid, $2::uuid, 'external_effect:' || $3, $4,
           $5, $6, $7::jsonb, 'prepared', 1, $8::uuid,
           now() + ($9::text || ' seconds')::interval
         )
         RETURNING id::text`,
        [
          candidate.organization_id,
          candidate.integration_account_id,
          candidate.action,
          input.adapterVersion,
          candidate.idempotency_key,
          candidate.request_hash,
          JSON.stringify(candidate.redacted_request),
          leaseToken,
          leaseSeconds,
        ],
      )
      const updated = await client.query<ExternalEffectRow>(
        `UPDATE operations_commerce_external_effect_intents intent
         SET state = 'claimed',
             provider_attempt_id = $3::uuid,
             lease_token = $4::uuid,
             lease_expires_at =
               now() + ($5::text || ' seconds')::interval,
             claimed_by = $6,
             claimed_at = now(),
             updated_at = now()
         FROM operations_integration_accounts account
         WHERE intent.organization_id = $1::uuid
           AND intent.id = $2::uuid
           AND intent.state = 'pending'
           AND intent.desired_mode = 'active'
           AND account.organization_id = intent.organization_id
           AND account.id = intent.integration_account_id
         RETURNING
           intent.id::text,
           intent.global_id,
           intent.organization_id::text,
           intent.integration_account_id::text,
           account.global_id AS integration_account_global_id,
           intent.provider,
           intent.action,
           intent.desired_mode,
           intent.credential_generation,
           intent.activation_revision,
           intent.aggregate_type,
           intent.aggregate_id,
           intent.aggregate_revision::text,
           intent.aggregate_hash,
           intent.idempotency_key,
           intent.request_hash,
           intent.redacted_request,
           intent.state,
           intent.provider_attempt_id::text,
           intent.lease_token::text,
           intent.lease_expires_at,
           intent.claimed_by,
           intent.claimed_at,
           intent.redacted_result,
           intent.terminal_evidence_hash,
           intent.provider_reference,
           intent.error_code,
           intent.provider_write_count,
           intent.completed_at,
           intent.created_by,
           intent.created_at,
           intent.updated_at,
           false AS claimable,
           NULL::text AS stale_reason`,
        [
          candidate.organization_id,
          candidate.id,
          attempt.rows[0].id,
          leaseToken,
          leaseSeconds,
          input.workerId,
        ],
      )
      if (!updated.rows[0]) {
        externalEffectError(
          'COMMERCE_EXTERNAL_EFFECT_CLAIM_CONFLICT',
          'The external effect changed while it was being claimed',
        )
      }
      claimed.push(
        externalEffect(updated.rows[0]) as ClaimedCommerceExternalEffect,
      )
    }
    return claimed
  })
}

function validateTerminalInput(input: {
  outcome: CommerceExternalEffectTerminalState
  redactedResult: Record<string, unknown>
  providerReference?: string | null
  errorCode?: string | null
  providerWriteCount: number
}) {
  if (!['succeeded', 'failed', 'unknown'].includes(input.outcome)) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_OUTCOME_INVALID',
      'External-effect outcome is invalid',
      400,
    )
  }
  assertRedactedCommerceExternalEffectEvidence(
    input.redactedResult,
    'Redacted provider result',
  )
  if (
    !Number.isSafeInteger(input.providerWriteCount)
    || input.providerWriteCount < 0
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_WRITE_COUNT_INVALID',
      'Provider write count must be a nonnegative integer',
      400,
    )
  }
  if (input.redactedResult.providerWrites !== input.providerWriteCount) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_WRITE_COUNT_MISMATCH',
      'Provider result evidence must equal the explicit provider write count',
      400,
    )
  }
  if (input.providerReference) {
    validateIdentifier(input.providerReference, 'Provider reference')
  }
  if (input.outcome === 'succeeded' && input.errorCode) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_ERROR_STATE_INVALID',
      'A successful external effect cannot include an error code',
      400,
    )
  }
  if (
    input.outcome !== 'succeeded'
    && (!input.errorCode || !ERROR_CODE.test(input.errorCode))
  ) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_ERROR_STATE_INVALID',
      'Failed or uncertain external effects require a stable error code',
      400,
    )
  }
}

async function readEffectForUpdate(
  client: PoolClient,
  input: { organizationId: string; globalId: string },
) {
  const result = await client.query<ExternalEffectRow>(
    `${EXTERNAL_EFFECT_SELECT}
     FROM operations_commerce_external_effect_intents intent
     JOIN operations_integration_accounts account
       ON account.organization_id = intent.organization_id
      AND account.id = intent.integration_account_id
     WHERE intent.organization_id = $1::uuid
       AND intent.global_id = $2
     FOR UPDATE OF intent`,
    [input.organizationId, input.globalId],
  )
  if (!result.rows[0]) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_NOT_FOUND',
      'The commerce external effect was not found',
      404,
    )
  }
  return result.rows[0]
}

export async function finalizeCommerceExternalEffectInPostgres(input: {
  organizationId: string
  globalId: string
  leaseToken: string
  outcome: CommerceExternalEffectTerminalState
  redactedResult: Record<string, unknown>
  providerReference?: string | null
  errorCode?: string | null
  providerWriteCount: number
}) {
  validateIdentifier(input.globalId, 'External-effect Global ID', 32)
  validateIdentifier(input.leaseToken, 'External-effect lease token', 64)
  validateTerminalInput(input)
  const terminalEvidenceHash = commerceExternalEffectHash(
    input.redactedResult,
  )
  const providerReference = input.providerReference || null
  const errorCode = input.errorCode || null
  const providerWriteCount = input.providerWriteCount

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-external-effect-finalize:${input.organizationId}:${input.globalId}`,
    )
    const current = await readEffectForUpdate(client, input)
    if (TERMINAL_STATES.has(current.state)) {
      if (
        current.state === input.outcome
        && current.terminal_evidence_hash === terminalEvidenceHash
        && current.provider_reference === providerReference
        && current.error_code === errorCode
        && current.provider_write_count === providerWriteCount
      ) return externalEffect(current)
      externalEffectError(
        'COMMERCE_EXTERNAL_EFFECT_TERMINAL_CONFLICT',
        'Terminal external-effect evidence cannot be changed',
      )
    }
    if (
      current.state !== 'claimed'
      || !current.provider_attempt_id
      || current.lease_token !== input.leaseToken
    ) {
      externalEffectError(
        'COMMERCE_EXTERNAL_EFFECT_LEASE_STALE',
        'The external-effect claim is no longer current',
      )
    }

    const attempt = await client.query<{ id: string }>(
      `UPDATE operations_commerce_provider_attempts
       SET state = $4,
           redacted_response = $5::jsonb,
           provider_reference = $6,
           error_code = $7,
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = now()
       WHERE id = $1::uuid
         AND organization_id = $2::uuid
         AND integration_account_id = $3::uuid
         AND state = 'prepared'
         AND lease_token = $8::uuid
       RETURNING id::text`,
      [
        current.provider_attempt_id,
        input.organizationId,
        current.integration_account_id,
        input.outcome,
        JSON.stringify(input.redactedResult),
        providerReference,
        errorCode,
        input.leaseToken,
      ],
    )
    if (!attempt.rows[0]) {
      externalEffectError(
        'COMMERCE_EXTERNAL_EFFECT_ATTEMPT_STALE',
        'The provider attempt is no longer prepared for this claim',
      )
    }

    const finalized = await client.query<ExternalEffectRow>(
      `UPDATE operations_commerce_external_effect_intents intent
       SET state = $3,
           lease_token = NULL,
           lease_expires_at = NULL,
           redacted_result = $4::jsonb,
           terminal_evidence_hash = $5,
           provider_reference = $6,
           error_code = $7,
           provider_write_count = $8,
           completed_at = now(),
           updated_at = now()
       FROM operations_integration_accounts account
       WHERE intent.organization_id = $1::uuid
         AND intent.global_id = $2
         AND intent.state = 'claimed'
         AND intent.provider_attempt_id = $9::uuid
         AND intent.lease_token = $10::uuid
         AND account.organization_id = intent.organization_id
         AND account.id = intent.integration_account_id
       RETURNING
         intent.id::text,
         intent.global_id,
         intent.organization_id::text,
         intent.integration_account_id::text,
         account.global_id AS integration_account_global_id,
         intent.provider,
         intent.action,
         intent.desired_mode,
         intent.credential_generation,
         intent.activation_revision,
         intent.aggregate_type,
         intent.aggregate_id,
         intent.aggregate_revision::text,
         intent.aggregate_hash,
         intent.idempotency_key,
         intent.request_hash,
         intent.redacted_request,
         intent.state,
         intent.provider_attempt_id::text,
         intent.lease_token::text,
         intent.lease_expires_at,
         intent.claimed_by,
         intent.claimed_at,
         intent.redacted_result,
         intent.terminal_evidence_hash,
         intent.provider_reference,
         intent.error_code,
         intent.provider_write_count,
         intent.completed_at,
         intent.created_by,
         intent.created_at,
         intent.updated_at,
         false AS claimable,
         NULL::text AS stale_reason`,
      [
        input.organizationId,
        input.globalId,
        input.outcome,
        JSON.stringify(input.redactedResult),
        terminalEvidenceHash,
        providerReference,
        errorCode,
        providerWriteCount,
        current.provider_attempt_id,
        input.leaseToken,
      ],
    )
    if (!finalized.rows[0]) {
      externalEffectError(
        'COMMERCE_EXTERNAL_EFFECT_FINALIZE_UNKNOWN',
        'The provider attempt completed but its intent did not finalize',
      )
    }
    return externalEffect(finalized.rows[0])
  })
}

export async function readCommerceExternalEffectsStateFromPostgres(input: {
  organizationId: string
  accountGlobalId?: string | null
  globalId?: string | null
  limit?: number
}) {
  const limit = Math.max(1, Math.min(Number(input.limit || 100), 500))
  const claimable = claimabilitySql()
  const result = await query<ExternalEffectRow>(
    `${EXTERNAL_EFFECT_SELECT},
       ${claimable} AS claimable,
       CASE
         WHEN intent.state = 'claimed'
              AND intent.lease_expires_at <= now()
           THEN 'claim_lease_expired_reconciliation_required'
         WHEN intent.state <> 'pending' THEN NULL
         WHEN intent.desired_mode <> 'active' THEN 'shadow_not_claimable'
         WHEN intent.faire_provider_write_authorization_id IS NOT NULL
           THEN 'faire_authorization_requires_dedicated_claim'
         WHEN account.status <> 'active'
              OR account.integration_type <> 'commerce'
              OR account.provider <> intent.provider
           THEN 'integration_not_active'
         WHEN account.commerce_credential_generation
                <> intent.credential_generation
              OR credential.credential_version
                <> intent.credential_generation
              OR credential.verification_status <> 'verified'
           THEN 'credential_generation_stale'
         WHEN activation.state <> 'active'
              OR activation.revision <> intent.activation_revision
           THEN 'activation_revision_stale'
         WHEN fence.aggregate_revision <> intent.aggregate_revision
              OR fence.aggregate_hash <> intent.aggregate_hash
           THEN 'aggregate_revision_stale'
         ELSE NULL
       END AS stale_reason
     FROM operations_commerce_external_effect_intents intent
     JOIN operations_integration_accounts account
       ON account.organization_id = intent.organization_id
      AND account.id = intent.integration_account_id
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = intent.organization_id
      AND credential.integration_account_id = intent.integration_account_id
     LEFT JOIN operations_activation_scopes activation
       ON activation.organization_id = intent.organization_id
     LEFT JOIN operations_commerce_external_effect_aggregate_fences fence
       ON fence.organization_id = intent.organization_id
      AND fence.integration_account_id = intent.integration_account_id
      AND fence.provider = intent.provider
      AND fence.aggregate_type = intent.aggregate_type
      AND fence.aggregate_id = intent.aggregate_id
     WHERE intent.organization_id = $1::uuid
       AND ($2::text IS NULL OR account.global_id = $2)
       AND ($3::text IS NULL OR intent.global_id = $3)
     ORDER BY intent.created_at DESC, intent.id DESC
     LIMIT $4`,
    [
      input.organizationId,
      input.accountGlobalId || null,
      input.globalId || null,
      limit,
    ],
  )
  return result.rows.map(externalEffect)
}

export async function readCommerceExternalEffectByIdempotencyFromPostgres(
  input: {
    organizationId: string
    accountGlobalId: string
    action: string
    idempotencyKey: string
  },
) {
  validateIdentifier(input.organizationId, 'Organization identifier', 64)
  validateIdentifier(
    input.accountGlobalId,
    'Integration account Global ID',
    32,
  )
  if (!CODE.test(input.action)) {
    externalEffectError(
      'COMMERCE_EXTERNAL_EFFECT_CODE_INVALID',
      'External-effect action must use a stable code',
      400,
    )
  }
  validateIdentifier(input.idempotencyKey, 'Idempotency key', 255)
  const result = await query<ExternalEffectRow>(
    `${EXTERNAL_EFFECT_SELECT},
       false AS claimable,
       NULL::text AS stale_reason
     FROM operations_commerce_external_effect_intents intent
     JOIN operations_integration_accounts account
       ON account.organization_id = intent.organization_id
      AND account.id = intent.integration_account_id
     WHERE intent.organization_id = $1::uuid
       AND account.global_id = $2
       AND intent.action = $3
       AND intent.idempotency_key = $4
     LIMIT 1`,
    [
      input.organizationId,
      input.accountGlobalId,
      input.action,
      input.idempotencyKey,
    ],
  )
  return result.rows[0] ? externalEffect(result.rows[0]) : null
}
