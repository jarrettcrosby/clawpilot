import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  assertRedactedCommerceExternalEffectEvidence,
  commerceExternalEffectHash,
} from '@/lib/persistence/commerceExternalEffects'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const EFFECT_GLOBAL_ID = /^gcef(?:[0-9]{7}|[0-9a-v]{12})$/
const SCOPE_EVIDENCE_GLOBAL_ID = /^gfse(?:[0-9]{7}|[0-9a-v]{12})$/
const AUTHORIZATION_GLOBAL_ID = /^gfwa(?:[0-9]{7}|[0-9a-v]{12})$/
const SHA256 = /^[a-f0-9]{64}$/

export const FAIRE_PROVIDER_WRITE_CONFIRMATION_VERSION =
  'faire-provider-write-v1' as const
export const FAIRE_PROVIDER_WRITE_CONFIRMATION =
  'I authorize one production Faire draft-product creation for this exact reviewed request. An unknown outcome will not be retried.' as const
export const FAIRE_PROVIDER_WRITE_ACTION =
  'faire.product.draft.create' as const
export const FAIRE_PROVIDER_WRITE_ADAPTER_CAPABILITY =
  'product_draft_create' as const
export const FAIRE_PROVIDER_WRITE_REQUIRED_SCOPE = 'WRITE_PRODUCTS' as const

export type FaireProviderWriteScopeVerificationSource = 'oauth_grant'

type TimestampValue = string | Date

type AuthorizationRow = {
  id: string
  global_id: string
  authorization_revision: number
  authorization_fence_hash: string
  organization_id: string
  integration_account_id: string
  account_global_id: string
  external_account_id: string
  scope_evidence_id: string
  scope_evidence_global_id: string
  scope_verification_source: FaireProviderWriteScopeVerificationSource
  scope_evidence_hash: string
  verified_write_scopes: string[]
  capabilities: string[]
  credential_generation: number
  activation_revision: number
  action: typeof FAIRE_PROVIDER_WRITE_ACTION
  aggregate_type: string
  aggregate_id: string
  aggregate_revision: string | number
  aggregate_hash: string
  idempotency_key: string
  request_hash: string
  redacted_request: Record<string, unknown>
  state: 'active' | 'consumed' | 'expired' | 'revoked'
  provider_attempt_id: string | null
  authorized_by: string
  authorized_role: 'owner' | 'admin'
  authorized_at: TimestampValue
  expires_at: TimestampValue
  consumed_at: TimestampValue | null
  consumed_by: string | null
  effect_id: string | null
  effect_global_id: string | null
  effect_state: string | null
  provider_attempt_global_id: string | null
  attempt_number: number | null
  lease_token: string | null
  lease_expires_at: TimestampValue | null
  claimed_by: string | null
  claimed_at: TimestampValue | null
}

export type FaireProviderWriteAuthorization = {
  authorizationId: string
  authorizationGlobalId: string
  authorizationRevision: 1
  authorizationFenceHash: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  externalAccountId: string
  scopeEvidenceGlobalId: string
  scopeVerificationSource: FaireProviderWriteScopeVerificationSource
  scopeEvidenceHash: string
  verifiedWriteScopes: [typeof FAIRE_PROVIDER_WRITE_REQUIRED_SCOPE]
  capabilities: [typeof FAIRE_PROVIDER_WRITE_ADAPTER_CAPABILITY]
  credentialGeneration: number
  activationRevision: number
  action: typeof FAIRE_PROVIDER_WRITE_ACTION
  aggregateType: string
  aggregateId: string
  aggregateRevision: number
  aggregateHash: string
  idempotencyKey: string
  requestHash: string
  redactedRequest: Record<string, unknown>
  state: AuthorizationRow['state']
  authorizedBy: string
  authorizedRole: AuthorizationRow['authorized_role']
  authorizedAt: string
  expiresAt: string
  consumedAt: string | null
  consumedBy: string | null
  effectId: string
  effectGlobalId: string
  effectState: string
  providerAttemptId: string | null
  providerAttemptGlobalId: string | null
  attemptNumber: 1 | null
  leaseToken: string | null
  leaseExpiresAt: string | null
  claimedBy: string | null
  claimedAt: string | null
}

export type ClaimedFaireProviderWrite = FaireProviderWriteAuthorization & {
  state: 'consumed'
  effectState: 'claimed'
  providerAttemptId: string
  providerAttemptGlobalId: string
  attemptNumber: 1
  leaseToken: string
  leaseExpiresAt: string
  claimedBy: string
  claimedAt: string
}

export class FaireProviderWriteAuthorizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'FaireProviderWriteAuthorizationError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new FaireProviderWriteAuthorizationError(code, message, status)
}

function identifier(
  value: unknown,
  pattern: RegExp,
  label: string,
  status = 400,
) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!pattern.test(normalized)) {
    fail('FAIRE_PROVIDER_WRITE_IDENTIFIER_INVALID', `${label} is invalid`, status)
  }
  return normalized
}

function safeText(value: unknown, label: string, minimum: number, maximum: number) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail('FAIRE_PROVIDER_WRITE_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function actorEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase()
  if (!email || email.length > 320 || !email.includes('@')) {
    fail('FAIRE_PROVIDER_WRITE_ACTOR_INVALID', 'A signed-in actor is required', 401)
  }
  return email
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function normalizedEvidenceKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isForbiddenFaireSecretKey(value: string) {
  const key = normalizedEvidenceKey(value)
  return key.endsWith('applicationsecret')
    || (key.includes('faire') && key.endsWith('accesstoken'))
    || (key.includes('faire') && key.endsWith('brandtoken'))
    || (key.includes('faire') && key.endsWith('appcredentials'))
}

function assertFaireProviderWriteRedacted(
  value: Record<string, unknown>,
  path = '$',
) {
  const visit = (node: unknown, nodePath: string, ancestors: Set<object>) => {
    if (!node || typeof node !== 'object') return
    if (ancestors.has(node)) {
      fail(
        'FAIRE_PROVIDER_WRITE_EVIDENCE_INVALID',
        'Faire provider-write evidence cannot be recursive',
        400,
      )
    }
    ancestors.add(node)
    try {
      if (Array.isArray(node)) {
        node.forEach((child, index) => {
          visit(child, `${nodePath}[${index}]`, ancestors)
        })
        return
      }
      for (const [key, child] of Object.entries(node)) {
        if (isForbiddenFaireSecretKey(key)) {
          fail(
            'FAIRE_PROVIDER_WRITE_EVIDENCE_NOT_REDACTED',
            `Faire provider-write evidence contains the sensitive field ${nodePath}.${key}`,
            400,
          )
        }
        visit(child, `${nodePath}.${key}`, ancestors)
      }
    } finally {
      ancestors.delete(node)
    }
  }
  visit(value, path, new Set())
}

function authorization(row: AuthorizationRow): FaireProviderWriteAuthorization {
  if (
    !row.effect_id
    || !row.effect_global_id
    || !row.effect_state
    || row.authorization_revision !== 1
    || row.capabilities.length !== 1
    || row.capabilities[0] !== FAIRE_PROVIDER_WRITE_ADAPTER_CAPABILITY
    || row.verified_write_scopes.length !== 1
    || row.verified_write_scopes[0] !== FAIRE_PROVIDER_WRITE_REQUIRED_SCOPE
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_EVIDENCE_INVALID',
      'Durable Faire provider-write evidence is incomplete',
      500,
    )
  }
  return {
    authorizationId: row.id,
    authorizationGlobalId: row.global_id,
    authorizationRevision: 1,
    authorizationFenceHash: row.authorization_fence_hash,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    accountGlobalId: row.account_global_id,
    externalAccountId: row.external_account_id,
    scopeEvidenceGlobalId: row.scope_evidence_global_id,
    scopeVerificationSource: row.scope_verification_source,
    scopeEvidenceHash: row.scope_evidence_hash,
    verifiedWriteScopes: [FAIRE_PROVIDER_WRITE_REQUIRED_SCOPE],
    capabilities: [FAIRE_PROVIDER_WRITE_ADAPTER_CAPABILITY],
    credentialGeneration: Number(row.credential_generation),
    activationRevision: Number(row.activation_revision),
    action: row.action,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateRevision: Number(row.aggregate_revision),
    aggregateHash: row.aggregate_hash,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    redactedRequest: row.redacted_request,
    state: row.state,
    authorizedBy: row.authorized_by,
    authorizedRole: row.authorized_role,
    authorizedAt: iso(row.authorized_at)!,
    expiresAt: iso(row.expires_at)!,
    consumedAt: iso(row.consumed_at),
    consumedBy: row.consumed_by,
    effectId: row.effect_id,
    effectGlobalId: row.effect_global_id,
    effectState: row.effect_state,
    providerAttemptId: row.provider_attempt_id,
    providerAttemptGlobalId: row.provider_attempt_global_id,
    attemptNumber: row.attempt_number === null ? null : 1,
    leaseToken: row.lease_token,
    leaseExpiresAt: iso(row.lease_expires_at),
    claimedBy: row.claimed_by,
    claimedAt: iso(row.claimed_at),
  }
}

const AUTHORIZATION_SELECT = `SELECT
  auth.id::text,
  auth.global_id,
  auth.authorization_revision,
  auth.authorization_fence_hash,
  auth.organization_id::text,
  auth.integration_account_id::text,
  account.global_id AS account_global_id,
  auth.external_account_id,
  auth.scope_evidence_id::text,
  evidence.global_id AS scope_evidence_global_id,
  auth.scope_verification_source,
  auth.scope_evidence_hash,
  auth.verified_write_scopes,
  auth.capabilities,
  auth.credential_generation,
  auth.activation_revision,
  auth.action,
  auth.aggregate_type,
  auth.aggregate_id,
  auth.aggregate_revision::text,
  auth.aggregate_hash,
  auth.idempotency_key,
  auth.request_hash,
  auth.redacted_request,
  auth.state,
  auth.provider_attempt_id::text,
  auth.authorized_by,
  auth.authorized_role,
  auth.authorized_at,
  auth.expires_at,
  auth.consumed_at,
  auth.consumed_by,
  effect.id::text AS effect_id,
  effect.global_id AS effect_global_id,
  effect.state AS effect_state,
  attempt.global_id AS provider_attempt_global_id,
  attempt.attempt_number,
  effect.lease_token::text,
  effect.lease_expires_at,
  effect.claimed_by,
  effect.claimed_at
FROM operations_faire_provider_write_authorizations auth
JOIN operations_integration_accounts account
  ON account.organization_id = auth.organization_id
 AND account.id = auth.integration_account_id
JOIN operations_faire_provider_write_scope_evidence evidence
  ON evidence.organization_id = auth.organization_id
 AND evidence.id = auth.scope_evidence_id
JOIN operations_commerce_external_effect_intents effect
  ON effect.organization_id = auth.organization_id
 AND effect.faire_provider_write_authorization_id = auth.id
LEFT JOIN operations_commerce_provider_attempts attempt
  ON attempt.organization_id = auth.organization_id
 AND attempt.id = auth.provider_attempt_id`

async function readWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    authorizationGlobalId: string
    forUpdate?: boolean
  },
) {
  const result = await client.query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
     WHERE auth.organization_id = $1::uuid
       AND auth.global_id = $2
     ${input.forUpdate ? 'FOR UPDATE OF auth, effect' : ''}`,
    [input.organizationId, input.authorizationGlobalId],
  )
  return result.rows[0] || null
}

export async function authorizeAndPrepareFaireProviderWriteInPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  shadowEffectGlobalId: unknown
  scopeEvidenceGlobalId: unknown
  idempotencyKey: unknown
  confirmationStatement: unknown
  actorEmail: unknown
  lifetimeSeconds?: unknown
}): Promise<FaireProviderWriteAuthorization> {
  const organizationId = identifier(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const accountGlobalId = identifier(
    input.accountGlobalId,
    ACCOUNT_GLOBAL_ID,
    'Faire account Global ID',
  )
  const shadowEffectGlobalId = identifier(
    input.shadowEffectGlobalId,
    EFFECT_GLOBAL_ID,
    'Shadow effect Global ID',
  )
  const scopeEvidenceGlobalId = identifier(
    input.scopeEvidenceGlobalId,
    SCOPE_EVIDENCE_GLOBAL_ID,
    'Scope-evidence Global ID',
  )
  const idempotencyKey = safeText(
    input.idempotencyKey,
    'Provider-write idempotency key',
    8,
    255,
  )
  const authorizedBy = actorEmail(input.actorEmail)
  const lifetimeSeconds = input.lifetimeSeconds === undefined
    ? 300
    : Number(input.lifetimeSeconds)
  if (
    input.confirmationStatement !== FAIRE_PROVIDER_WRITE_CONFIRMATION
    || !Number.isSafeInteger(lifetimeSeconds)
    || lifetimeSeconds < 15
    || lifetimeSeconds > 300
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_CONFIRMATION_REQUIRED',
      'The exact Faire provider-write confirmation and a 15-300 second lifetime are required',
      400,
    )
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `faire-provider-write-authorize:${organizationId}:${accountGlobalId}:${idempotencyKey}`,
    )
    const facts = await client.query<{
      integration_account_id: string
      external_account_id: string
      credential_generation: number
      activation_revision: number
      authorized_role: 'owner' | 'admin'
      scope_evidence_id: string
      scope_verification_source: FaireProviderWriteScopeVerificationSource
      scope_evidence_hash: string
      aggregate_type: string
      aggregate_id: string
      aggregate_revision: string
      aggregate_hash: string
      request_hash: string
      redacted_request: Record<string, unknown>
    }>(
      `SELECT
         account.id::text AS integration_account_id,
         account.external_account_id,
         account.commerce_credential_generation AS credential_generation,
         activation.revision AS activation_revision,
         membership.role AS authorized_role,
         evidence.id::text AS scope_evidence_id,
         evidence.verification_source AS scope_verification_source,
         evidence.evidence_hash AS scope_evidence_hash,
         simulation.aggregate_type,
         simulation.aggregate_id,
         simulation.aggregate_revision::text,
         simulation.aggregate_hash,
         simulation.request_hash,
         simulation.redacted_request
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       JOIN app_user_organization_memberships membership
         ON membership.organization_id = account.organization_id
        AND membership.user_email = $5
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin')
       JOIN operations_faire_provider_write_scope_evidence evidence
         ON evidence.organization_id = account.organization_id
        AND evidence.integration_account_id = account.id
        AND evidence.global_id = $4
        AND evidence.external_account_id = account.external_account_id
        AND evidence.credential_generation =
              account.commerce_credential_generation
        AND evidence.verified_write_scopes @>
              ARRAY['WRITE_PRODUCTS']::text[]
        AND operations_faire_provider_write_scope_evidence_is_current(
              account.organization_id,
              evidence.id,
              account.id,
              account.commerce_credential_generation
            )
       JOIN operations_commerce_external_effect_intents simulation
         ON simulation.organization_id = account.organization_id
        AND simulation.integration_account_id = account.id
        AND simulation.global_id = $3
        AND simulation.provider = 'faire'
        AND simulation.action = 'faire.product.draft.create'
        AND simulation.desired_mode = 'shadow'
        AND simulation.state = 'simulated'
        AND simulation.provider_attempt_id IS NULL
        AND simulation.provider_write_count = 0
        AND simulation.redacted_result->>'providerWrites' = '0'
        AND simulation.credential_generation =
              account.commerce_credential_generation
        AND simulation.activation_revision = activation.revision
        AND simulation.request_hash =
              operations_faire_provider_write_request_hash(
                simulation.redacted_request
              )
        AND operations_faire_provider_write_json_is_redacted(
              simulation.redacted_request
            )
       JOIN operations_commerce_external_effect_aggregate_fences fence
         ON fence.organization_id = simulation.organization_id
        AND fence.integration_account_id = simulation.integration_account_id
        AND fence.provider = simulation.provider
        AND fence.aggregate_type = simulation.aggregate_type
        AND fence.aggregate_id = simulation.aggregate_id
        AND fence.aggregate_revision = simulation.aggregate_revision
        AND fence.aggregate_hash = simulation.aggregate_hash
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'faire'
         AND account.environment = 'production'
         AND account.status = 'active'
         AND account.external_account_id IS NOT NULL
         AND credential.credential_version =
               account.commerce_credential_generation
         AND credential.verification_status = 'verified'
         AND activation.state = 'shadow'
       FOR UPDATE OF account, activation, simulation, fence`,
      [
        organizationId,
        accountGlobalId,
        shadowEffectGlobalId,
        scopeEvidenceGlobalId,
        authorizedBy,
      ],
    )
    const source = facts.rows[0]
    if (!source) {
      fail(
        'FAIRE_PROVIDER_WRITE_AUTHORIZATION_UNAVAILABLE',
        'Exact Shadow simulation, trusted WRITE_PRODUCTS evidence, and current Faire credential are required',
        403,
      )
    }
    assertRedactedCommerceExternalEffectEvidence(
      source.redacted_request,
      'Faire provider-write request',
    )
    assertFaireProviderWriteRedacted(source.redacted_request)
    if (
      source.redacted_request.operation !== 'productDraftCreate'
      || !source.redacted_request.draft
      || typeof source.redacted_request.draft !== 'object'
      || Array.isArray(source.redacted_request.draft)
    ) {
      fail(
        'FAIRE_PROVIDER_WRITE_REQUEST_INVALID',
        'Shadow evidence is not an exact Faire draft-product request',
      )
    }

    const requestHash = commerceExternalEffectHash(source.redacted_request)
    if (source.request_hash !== requestHash) {
      fail(
        'FAIRE_PROVIDER_WRITE_REQUEST_HASH_INVALID',
        'Shadow request hash does not match the exact redacted Faire request',
      )
    }

    const confirmationHash = commerceExternalEffectHash({
      schema: FAIRE_PROVIDER_WRITE_CONFIRMATION_VERSION,
      statement: FAIRE_PROVIDER_WRITE_CONFIRMATION,
      organizationId,
      accountGlobalId,
      externalAccountId: source.external_account_id,
      credentialGeneration: source.credential_generation,
      activationRevision: source.activation_revision,
      action: FAIRE_PROVIDER_WRITE_ACTION,
      aggregateType: source.aggregate_type,
      aggregateId: source.aggregate_id,
      aggregateRevision: Number(source.aggregate_revision),
      aggregateHash: source.aggregate_hash,
      idempotencyKey,
      requestHash,
      scopeEvidenceGlobalId,
      scopeEvidenceHash: source.scope_evidence_hash,
      actorEmail: authorizedBy,
    })

    const inserted = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO operations_faire_provider_write_authorizations (
         organization_id, integration_account_id, scope_evidence_id,
         external_account_id, credential_generation, activation_revision,
         action, aggregate_type, aggregate_id, aggregate_revision,
         aggregate_hash, idempotency_key, request_hash, redacted_request,
         capabilities, verified_write_scopes, scope_verification_source,
         scope_evidence_hash, confirmation_statement_version,
         confirmation_hash, authorized_by, authorized_role, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
         'faire.product.draft.create', $7, $8, $9::bigint,
         $10, $11, $12, $13::jsonb,
         ARRAY['product_draft_create']::text[],
         ARRAY['WRITE_PRODUCTS']::text[], $14, $15,
         '${FAIRE_PROVIDER_WRITE_CONFIRMATION_VERSION}', $16, $17, $18,
         now() + ($19::text || ' seconds')::interval
       )
       ON CONFLICT DO NOTHING
       RETURNING id::text, global_id`,
      [
        organizationId,
        source.integration_account_id,
        source.scope_evidence_id,
        source.external_account_id,
        source.credential_generation,
        source.activation_revision,
        source.aggregate_type,
        source.aggregate_id,
        source.aggregate_revision,
        source.aggregate_hash,
        idempotencyKey,
        requestHash,
        JSON.stringify(source.redacted_request),
        source.scope_verification_source,
        source.scope_evidence_hash,
        confirmationHash,
        authorizedBy,
        source.authorized_role,
        lifetimeSeconds,
      ],
    )

    let authorizationGlobalId = inserted.rows[0]?.global_id
    if (inserted.rows[0]) {
      await client.query(
        `INSERT INTO operations_commerce_external_effect_intents (
           organization_id, integration_account_id, provider, action,
           desired_mode, credential_generation, activation_revision,
           aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
           idempotency_key, request_hash, redacted_request,
           faire_provider_write_authorization_id, state,
           provider_write_count, created_by
         ) VALUES (
           $1::uuid, $2::uuid, 'faire', 'faire.product.draft.create',
           'active', $3, $4, $5, $6, $7::bigint, $8,
           $9, $10, $11::jsonb, $12::uuid, 'pending', 0, $13
         )`,
        [
          organizationId,
          source.integration_account_id,
          source.credential_generation,
          source.activation_revision,
          source.aggregate_type,
          source.aggregate_id,
          source.aggregate_revision,
          source.aggregate_hash,
          idempotencyKey,
          requestHash,
          JSON.stringify(source.redacted_request),
          inserted.rows[0].id,
          authorizedBy,
        ],
      )
    } else {
      const replay = await client.query<{ global_id: string }>(
        `SELECT auth.global_id
         FROM operations_faire_provider_write_authorizations auth
         JOIN operations_faire_provider_write_scope_evidence evidence
           ON evidence.organization_id = auth.organization_id
          AND evidence.id = auth.scope_evidence_id
         WHERE auth.organization_id = $1::uuid
           AND auth.integration_account_id = $2::uuid
           AND auth.action = 'faire.product.draft.create'
           AND auth.idempotency_key = $3
           AND auth.scope_evidence_id = $4::uuid
           AND auth.external_account_id = $5
           AND auth.credential_generation = $6
           AND auth.activation_revision = $7
           AND auth.aggregate_type = $8
           AND auth.aggregate_id = $9
           AND auth.aggregate_revision = $10::bigint
           AND auth.aggregate_hash = $11
           AND auth.request_hash = $12
           AND auth.redacted_request = $13::jsonb
           AND auth.scope_verification_source = $14
           AND auth.scope_evidence_hash = $15
           AND auth.confirmation_hash = $16
           AND auth.authorized_by = $17
           AND auth.authorized_role = $18
           AND evidence.global_id = $19`,
        [
          organizationId,
          source.integration_account_id,
          idempotencyKey,
          source.scope_evidence_id,
          source.external_account_id,
          source.credential_generation,
          source.activation_revision,
          source.aggregate_type,
          source.aggregate_id,
          source.aggregate_revision,
          source.aggregate_hash,
          requestHash,
          JSON.stringify(source.redacted_request),
          source.scope_verification_source,
          source.scope_evidence_hash,
          confirmationHash,
          authorizedBy,
          source.authorized_role,
          scopeEvidenceGlobalId,
        ],
      )
      authorizationGlobalId = replay.rows[0]?.global_id
      if (!authorizationGlobalId) {
        const tombstone = await client.query<{
          global_id: string
          state: AuthorizationRow['state']
        }>(
          `SELECT global_id, state
           FROM operations_faire_provider_write_authorizations
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND action = 'faire.product.draft.create'
             AND aggregate_type = $3
             AND aggregate_id = $4
             AND aggregate_revision = $5::bigint`,
          [
            organizationId,
            source.integration_account_id,
            source.aggregate_type,
            source.aggregate_id,
            source.aggregate_revision,
          ],
        )
        if (tombstone.rows[0]) {
          fail(
            'FAIRE_PROVIDER_WRITE_ALREADY_AUTHORIZED',
            'This exact Faire aggregate revision already has a permanent provider-write tombstone',
          )
        }
        fail(
          'FAIRE_PROVIDER_WRITE_IDEMPOTENCY_CONFLICT',
          'Faire provider-write idempotency key was used for different evidence',
        )
      }
    }

    if (!authorizationGlobalId) {
      fail(
        'FAIRE_PROVIDER_WRITE_AUTHORIZATION_NOT_FOUND',
        'Durable Faire provider-write authorization was not allocated',
        500,
      )
    }

    const created = await readWithClient(client, {
      organizationId,
      authorizationGlobalId,
    })
    if (!created) {
      fail(
        'FAIRE_PROVIDER_WRITE_AUTHORIZATION_NOT_FOUND',
        'Durable Faire provider-write authorization was not found',
        500,
      )
    }
    if (inserted.rows[0]) {
      await recordAuditEvent({
        actor: authorizedBy,
        eventType: 'operations.faire_provider_write.authorized',
        aggregateType: 'operations.commerce_external_effect_intent',
        aggregateId: created.effect_global_id!,
        subject: accountGlobalId,
        organizationId,
        eventKey: `operations:faire-provider-write:${created.global_id}:authorized`,
        payload: {
          authorizationGlobalId: created.global_id,
          authorizationFenceHash: created.authorization_fence_hash,
          scopeEvidenceGlobalId,
          action: created.action,
          requestHash: created.request_hash,
          expiresAt: iso(created.expires_at),
        },
      }, client)
    }
    return authorization(created)
  })
}

export async function claimFaireProviderWriteInPostgres(input: {
  organizationId: unknown
  authorizationGlobalId: unknown
  expectedAuthorizationFenceHash: unknown
  workerId: unknown
  adapterVersion: unknown
  leaseSeconds?: unknown
}): Promise<ClaimedFaireProviderWrite> {
  const organizationId = identifier(input.organizationId, UUID, 'Organization ID')
  const authorizationGlobalId = identifier(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'Faire authorization Global ID',
  )
  const expectedAuthorizationFenceHash = String(
    input.expectedAuthorizationFenceHash || '',
  ).trim().toLowerCase()
  if (!SHA256.test(expectedAuthorizationFenceHash)) {
    fail(
      'FAIRE_PROVIDER_WRITE_FENCE_INVALID',
      'Authorization fence hash is invalid',
      400,
    )
  }
  const workerId = safeText(input.workerId, 'Worker ID', 1, 255)
  const adapterVersion = safeText(input.adapterVersion, 'Adapter version', 1, 128)
  const leaseSeconds = input.leaseSeconds === undefined
    ? 60
    : Number(input.leaseSeconds)
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
    fail(
      'FAIRE_PROVIDER_WRITE_LEASE_INVALID',
      'Claim lease must be 5-300 seconds',
      400,
    )
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `faire-provider-write-claim:${organizationId}:${authorizationGlobalId}`,
    )
    const current = await readWithClient(client, {
      organizationId,
      authorizationGlobalId,
      forUpdate: true,
    })
    if (!current) {
      fail(
        'FAIRE_PROVIDER_WRITE_AUTHORIZATION_NOT_FOUND',
        'Faire provider-write authorization was not found',
        404,
      )
    }
    if (current.authorization_fence_hash !== expectedAuthorizationFenceHash) {
      fail(
        'FAIRE_PROVIDER_WRITE_FENCE_STALE',
        'Faire provider-write authorization fence changed',
      )
    }
    if (current.state !== 'active' || current.effect_state !== 'pending') {
      fail(
        'FAIRE_PROVIDER_WRITE_RECONCILIATION_REQUIRED',
        'This one-shot Faire provider write was already claimed or terminated',
      )
    }
    const expiry = await client.query<{ is_expired: boolean }>(
      `SELECT $1::timestamptz <= clock_timestamp() AS is_expired`,
      [current.expires_at],
    )
    if (expiry.rows[0]?.is_expired) {
      fail(
        'FAIRE_PROVIDER_WRITE_AUTHORIZATION_EXPIRED',
        'Faire provider-write authorization expired before claim',
        403,
      )
    }

    const leaseToken = randomUUID()
    const attempt = await client.query<{
      id: string
      global_id: string
      lease_expires_at: TimestampValue
    }>(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, state, attempt_number,
         lease_token, lease_expires_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'external_effect:' || $3, $4,
         $5, $6, $7, $8::jsonb, 'prepared', 1,
         $9::uuid, clock_timestamp() + ($10::text || ' seconds')::interval,
         $11
       )
       RETURNING id::text, global_id, lease_expires_at`,
      [
        organizationId,
        current.integration_account_id,
        current.action,
        adapterVersion,
        current.effect_global_id,
        current.idempotency_key,
        current.request_hash,
        JSON.stringify(current.redacted_request),
        leaseToken,
        leaseSeconds,
        current.authorized_by,
      ],
    )
    const providerAttempt = attempt.rows[0]
    if (!providerAttempt) {
      fail(
        'FAIRE_PROVIDER_WRITE_ATTEMPT_INSERT_FAILED',
        'Faire provider-write attempt could not be prepared',
        500,
      )
    }

    const consumed = await client.query(
      `UPDATE operations_faire_provider_write_authorizations
       SET state = 'consumed',
           provider_attempt_id = $3::uuid,
           consumed_at = clock_timestamp(),
           consumed_by = authorized_by
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND state = 'active'
         AND expires_at > clock_timestamp()
       RETURNING id`,
      [organizationId, current.id, providerAttempt.id],
    )
    if (consumed.rowCount !== 1) {
      fail(
        'FAIRE_PROVIDER_WRITE_AUTHORIZATION_CHANGED',
        'Faire provider-write authorization changed during claim',
      )
    }

    const claimed = await client.query(
      `UPDATE operations_commerce_external_effect_intents
       SET state = 'claimed',
           provider_attempt_id = $3::uuid,
           lease_token = $4::uuid,
           lease_expires_at = $5::timestamptz,
           claimed_by = $6,
           claimed_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND state = 'pending'
         AND desired_mode = 'active'
         AND faire_provider_write_authorization_id = $7::uuid
       RETURNING id`,
      [
        organizationId,
        current.effect_id,
        providerAttempt.id,
        leaseToken,
        providerAttempt.lease_expires_at,
        workerId,
        current.id,
      ],
    )
    if (claimed.rowCount !== 1) {
      fail(
        'FAIRE_PROVIDER_WRITE_EFFECT_CHANGED',
        'Faire external effect changed during claim',
      )
    }

    const result = await readWithClient(client, {
      organizationId,
      authorizationGlobalId,
    })
    if (
      !result
      || result.state !== 'consumed'
      || result.effect_state !== 'claimed'
      || result.provider_attempt_id !== providerAttempt.id
      || result.provider_attempt_global_id !== providerAttempt.global_id
      || result.attempt_number !== 1
      || result.lease_token !== leaseToken
    ) {
      fail(
        'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
        'One-shot Faire provider write was not claimed exactly once',
        500,
      )
    }
    await recordAuditEvent({
      actor: result.authorized_by,
      eventType: 'operations.faire_provider_write.claimed',
      aggregateType: 'operations.commerce_provider_attempt',
      aggregateId: result.provider_attempt_global_id,
      subject: result.account_global_id,
      organizationId,
      eventKey: `operations:faire-provider-write:${result.global_id}:claimed`,
      payload: {
        authorizationGlobalId: result.global_id,
        effectGlobalId: result.effect_global_id,
        providerAttemptGlobalId: result.provider_attempt_global_id,
        authorizationFenceHash: result.authorization_fence_hash,
        workerId,
        adapterVersion,
        leaseExpiresAt: iso(result.lease_expires_at),
      },
    }, client)
    return authorization(result) as ClaimedFaireProviderWrite
  })
}

export async function finalizeExpiredFaireProviderWriteClaimUnknownInPostgres(
  input: {
    organizationId: unknown
    authorizationGlobalId: unknown
    reconciledBy: unknown
  },
): Promise<FaireProviderWriteAuthorization> {
  const organizationId = identifier(input.organizationId, UUID, 'Organization ID')
  const authorizationGlobalId = identifier(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'Faire authorization Global ID',
  )
  const reconciledBy = safeText(input.reconciledBy, 'Reconciliation worker', 1, 255)

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `faire-provider-write-expired-claim:${organizationId}:${authorizationGlobalId}`,
    )
    const current = await readWithClient(client, {
      organizationId,
      authorizationGlobalId,
      forUpdate: true,
    })
    if (!current) {
      fail(
        'FAIRE_PROVIDER_WRITE_AUTHORIZATION_NOT_FOUND',
        'Faire provider-write authorization was not found',
        404,
      )
    }
    if (
      current.effect_state === 'unknown'
      && current.state === 'consumed'
    ) return authorization(current)
    if (
      current.state !== 'consumed'
      || current.effect_state !== 'claimed'
      || !current.provider_attempt_id
      || !current.lease_token
      || !current.lease_expires_at
    ) {
      fail(
        'FAIRE_PROVIDER_WRITE_EXPIRED_CLAIM_REQUIRED',
        'Only an expired claimed Faire provider write can become unknown',
      )
    }

    const redactedResult = {
      provider: 'faire',
      operation: 'productDraftCreate',
      outcome: 'unknown',
      stage: 'claim_lease_expired',
      errorCode: 'FAIRE_PROVIDER_WRITE_CLAIM_EXPIRED',
      providerMutationAttempted: true,
      providerWritesKnown: false,
      providerWrites: 0,
      reconciledBy,
    }
    assertRedactedCommerceExternalEffectEvidence(
      redactedResult,
      'Expired Faire provider-write claim evidence',
    )
    const terminalEvidenceHash = commerceExternalEffectHash(redactedResult)

    const attempt = await client.query(
      `UPDATE operations_commerce_provider_attempts
       SET state = 'unknown',
           redacted_response = $4::jsonb,
           error_code = 'FAIRE_PROVIDER_WRITE_CLAIM_EXPIRED',
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND integration_account_id = $3::uuid
         AND state = 'prepared'
         AND lease_expires_at <= clock_timestamp()
       RETURNING id`,
      [
        organizationId,
        current.provider_attempt_id,
        current.integration_account_id,
        JSON.stringify(redactedResult),
      ],
    )
    if (attempt.rowCount !== 1) {
      fail(
        'FAIRE_PROVIDER_WRITE_ATTEMPT_CHANGED',
        'Faire provider-write attempt changed during expired-claim finalization',
      )
    }

    const effect = await client.query(
      `UPDATE operations_commerce_external_effect_intents
       SET state = 'unknown',
           lease_token = NULL,
           lease_expires_at = NULL,
           redacted_result = $3::jsonb,
           terminal_evidence_hash = $4,
           error_code = 'FAIRE_PROVIDER_WRITE_CLAIM_EXPIRED',
           provider_write_count = 0,
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND state = 'claimed'
         AND provider_attempt_id = $5::uuid
       RETURNING id`,
      [
        organizationId,
        current.effect_id,
        JSON.stringify(redactedResult),
        terminalEvidenceHash,
        current.provider_attempt_id,
      ],
    )
    if (effect.rowCount !== 1) {
      fail(
        'FAIRE_PROVIDER_WRITE_EFFECT_CHANGED',
        'Faire external effect changed during expired-claim finalization',
      )
    }

    const finalized = await readWithClient(client, {
      organizationId,
      authorizationGlobalId,
    })
    if (!finalized || finalized.effect_state !== 'unknown') {
      fail(
        'FAIRE_PROVIDER_WRITE_UNKNOWN_FINALIZATION_FAILED',
        'Expired Faire provider-write claim did not become terminal unknown',
        500,
      )
    }
    await recordAuditEvent({
      actor: null,
      eventType: 'operations.faire_provider_write.outcome_unknown',
      aggregateType: 'operations.commerce_external_effect_intent',
      aggregateId: finalized.effect_global_id!,
      subject: finalized.account_global_id,
      organizationId,
      eventKey: `operations:faire-provider-write:${finalized.global_id}:unknown`,
      payload: {
        authorizationGlobalId: finalized.global_id,
        providerAttemptGlobalId: finalized.provider_attempt_global_id,
        errorCode: 'FAIRE_PROVIDER_WRITE_CLAIM_EXPIRED',
        reconciledBy,
      },
    }, client)
    return authorization(finalized)
  })
}

export async function readFaireProviderWriteAuthorizationInPostgres(input: {
  organizationId: unknown
  authorizationGlobalId: unknown
}) {
  const organizationId = identifier(input.organizationId, UUID, 'Organization ID')
  const authorizationGlobalId = identifier(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'Faire authorization Global ID',
  )
  const result = await query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
     WHERE auth.organization_id = $1::uuid
       AND auth.global_id = $2`,
    [organizationId, authorizationGlobalId],
  )
  return result.rows[0] ? authorization(result.rows[0]) : null
}

export async function readFaireProviderWriteClaimsRequiringReconciliationInPostgres(
  input: { organizationId: unknown; limit?: unknown },
) {
  const organizationId = identifier(input.organizationId, UUID, 'Organization ID')
  const limit = input.limit === undefined ? 50 : Number(input.limit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    fail('FAIRE_PROVIDER_WRITE_LIMIT_INVALID', 'Limit must be 1-200', 400)
  }
  const result = await query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
     WHERE auth.organization_id = $1::uuid
       AND auth.state = 'consumed'
       AND effect.state = 'claimed'
       AND effect.lease_expires_at <= clock_timestamp()
     ORDER BY effect.lease_expires_at, effect.id
     LIMIT $2`,
    [organizationId, limit],
  )
  return result.rows.map(authorization)
}
