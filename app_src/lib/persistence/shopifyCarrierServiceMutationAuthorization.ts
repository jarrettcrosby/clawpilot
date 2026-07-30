import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
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

export type ShopifyCarrierServiceMutationOperation = 'create' | 'delete'
export type ShopifyCarrierServiceMutationEnvironment =
  | 'sandbox'
  | 'production'
export type ShopifyCarrierServiceMutationActorRole = 'owner' | 'admin'
export type ShopifyCarrierServiceMutationOutcomeState =
  | 'succeeded'
  | 'failed'
  | 'unknown'
export type ShopifyCarrierServiceMutationResolutionDisposition =
  | 'confirmed_applied'
  | 'confirmed_not_applied'

export const SHOPIFY_CARRIER_SERVICE_SANDBOX_CONFIRMATION_VERSION =
  'shopify-carrier-service-sandbox-provider-write-v1'
export const SHOPIFY_CARRIER_SERVICE_PRODUCTION_CONFIRMATION_VERSION =
  'shopify-carrier-service-production-provider-write-v1'
export const SHOPIFY_CARRIER_SERVICE_RECONCILIATION_CONFIRMATION_VERSION =
  'shopify-carrier-service-mutation-reconciliation-v1'

type TimestampValue = string | Date

type AuthorizationRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  account_global_id: string
  config_id: string
  config_global_id: string
  simulation_effect_id: string
  simulation_effect_global_id: string
  operation: ShopifyCarrierServiceMutationOperation
  account_environment: ShopifyCarrierServiceMutationEnvironment
  credential_generation: number
  config_row_version: string | number
  activation_state: 'shadow'
  activation_revision: number
  simulation_activation_revision: number
  provider_write_activation_revision: number | null
  aggregate_hash: string
  request_hash: string
  expected_service_gid: string | null
  confirmation_hash: string
  confirmation_statement_version: string
  idempotency_key: string
  authorization_fence_hash: string
  authorized_by: string
  authorized_role: ShopifyCarrierServiceMutationActorRole
  authorized_at: TimestampValue
  expires_at: TimestampValue
  attempt_id: string | null
  attempt_global_id: string | null
  lease_token: string | null
  lease_expires_at: TimestampValue | null
  claimed_at: TimestampValue | null
  outcome_id: string | null
  outcome_global_id: string | null
  outcome: ShopifyCarrierServiceMutationOutcomeState | null
  outcome_result_hash: string | null
  outcome_provider_reference: string | null
  outcome_error_code: string | null
  outcome_provider_write_count: number | null
  outcome_completed_at: TimestampValue | null
  resolution_id: string | null
  resolution_global_id: string | null
  resolution_disposition:
    | ShopifyCarrierServiceMutationResolutionDisposition
    | null
  resolution_provider_reference: string | null
  resolution_hash: string | null
  resolved_at: TimestampValue | null
}

export type ShopifyCarrierServiceMutationAuthorization = {
  id: string
  globalId: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  configId: string
  configGlobalId: string
  simulationEffectId: string
  simulationEffectGlobalId: string
  operation: ShopifyCarrierServiceMutationOperation
  accountEnvironment: ShopifyCarrierServiceMutationEnvironment
  credentialGeneration: number
  configRowVersion: number
  activationState: 'shadow'
  activationRevision: number
  simulationActivationRevision: number
  providerWriteActivationRevision: number | null
  aggregateHash: string
  requestHash: string
  expectedServiceGid: string | null
  confirmationHash: string
  confirmationStatementVersion: string
  idempotencyKey: string
  authorizationFenceHash: string
  authorizedBy: string
  authorizedRole: ShopifyCarrierServiceMutationActorRole
  authorizedAt: string
  expiresAt: string
  status:
    | 'authorized'
    | 'expired'
    | 'claimed'
    | 'succeeded'
    | 'failed'
    | 'unknown'
    | 'confirmed_applied'
    | 'confirmed_not_applied'
  reconciliationRequired: boolean
  attempt: null | {
    id: string
    globalId: string
    leaseToken: string
    leaseExpiresAt: string
    claimedAt: string
  }
  outcome: null | {
    id: string
    globalId: string
    state: ShopifyCarrierServiceMutationOutcomeState
    resultHash: string
    providerReference: string | null
    errorCode: string | null
    providerWriteCount: 0 | 1 | null
    completedAt: string
  }
  resolution: null | {
    id: string
    globalId: string
    disposition: ShopifyCarrierServiceMutationResolutionDisposition
    providerReference: string | null
    resolutionHash: string
    resolvedAt: string
  }
}

export type ClaimedShopifyCarrierServiceMutationAuthorization =
  ShopifyCarrierServiceMutationAuthorization & {
    status: 'claimed'
    attempt: NonNullable<
      ShopifyCarrierServiceMutationAuthorization['attempt']
    >
  }

export class ShopifyCarrierServiceMutationAuthorizationError
  extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'ShopifyCarrierServiceMutationAuthorizationError'
    this.code = code
    this.status = status
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/
const ACCOUNT_GLOBAL_ID = /^gia[0-9]{7}$/
const CONFIG_GLOBAL_ID = /^gscf[0-9]{7}$/
const EFFECT_GLOBAL_ID = /^gcef[0-9]{7}$/
const AUTHORIZATION_GLOBAL_ID = /^gsca[0-9]{7}$/
const ATTEMPT_GLOBAL_ID = /^gscm[0-9]{7}$/
const OUTCOME_GLOBAL_ID = /^gsco[0-9]{7}$/
const RESOLUTION_GLOBAL_ID = /^gscr[0-9]{7}$/
const SHOPIFY_SERVICE_GID =
  /^gid:\/\/shopify\/DeliveryCarrierService\/[0-9]+$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/

const AUTHORIZATION_SELECT = `
  SELECT
    authorized_mutation.id::text,
    authorized_mutation.global_id,
    authorized_mutation.organization_id::text,
    authorized_mutation.integration_account_id::text,
    account.global_id AS account_global_id,
    authorized_mutation.config_id::text,
    config.global_id AS config_global_id,
    authorized_mutation.simulation_effect_id::text,
    simulation.global_id AS simulation_effect_global_id,
    authorized_mutation.operation,
    authorized_mutation.account_environment,
    authorized_mutation.credential_generation,
    authorized_mutation.config_row_version::text,
    authorized_mutation.activation_state,
    authorized_mutation.activation_revision,
    authorized_mutation.simulation_activation_revision,
    authorized_mutation.provider_write_activation_revision,
    authorized_mutation.aggregate_hash,
    authorized_mutation.request_hash,
    authorized_mutation.expected_service_gid,
    authorized_mutation.confirmation_hash,
    authorized_mutation.confirmation_statement_version,
    authorized_mutation.idempotency_key,
    CASE
      WHEN authorized_mutation.provider_write_activation_revision IS NULL
        THEN authorized_mutation.authorization_fence_hash
      ELSE
        operations_shopify_cs_active_authorization_fence_hash(
          authorized_mutation.authorization_fence_hash,
          authorized_mutation.simulation_activation_revision,
          authorized_mutation.provider_write_activation_revision
        )
    END AS authorization_fence_hash,
    authorized_mutation.authorized_by,
    authorized_mutation.authorized_role,
    authorized_mutation.authorized_at,
    authorized_mutation.expires_at,
    attempt.id::text AS attempt_id,
    attempt.global_id AS attempt_global_id,
    attempt.lease_token::text,
    attempt.lease_expires_at,
    attempt.claimed_at,
    outcome.id::text AS outcome_id,
    outcome.global_id AS outcome_global_id,
    outcome.outcome,
    outcome.result_hash AS outcome_result_hash,
    outcome.provider_reference AS outcome_provider_reference,
    outcome.error_code AS outcome_error_code,
    outcome.provider_write_count AS outcome_provider_write_count,
    outcome.completed_at AS outcome_completed_at,
    resolution.id::text AS resolution_id,
    resolution.global_id AS resolution_global_id,
    resolution.disposition AS resolution_disposition,
    resolution.provider_reference AS resolution_provider_reference,
    resolution.resolution_hash,
    resolution.resolved_at
  FROM operations_shopify_carrier_service_mutation_authorizations
    authorized_mutation
  JOIN operations_integration_accounts account
    ON account.organization_id = authorized_mutation.organization_id
   AND account.id = authorized_mutation.integration_account_id
  JOIN operations_shopify_carrier_service_configs config
    ON config.organization_id = authorized_mutation.organization_id
   AND config.id = authorized_mutation.config_id
  JOIN operations_commerce_external_effect_intents simulation
    ON simulation.organization_id = authorized_mutation.organization_id
   AND simulation.id = authorized_mutation.simulation_effect_id
  LEFT JOIN operations_shopify_carrier_service_mutation_attempts attempt
    ON attempt.organization_id = authorized_mutation.organization_id
   AND attempt.authorization_id = authorized_mutation.id
  LEFT JOIN operations_shopify_carrier_service_mutation_outcomes outcome
    ON outcome.organization_id = attempt.organization_id
   AND outcome.attempt_id = attempt.id
  LEFT JOIN operations_shopify_carrier_service_mutation_resolutions
    resolution
    ON resolution.organization_id = attempt.organization_id
   AND resolution.attempt_id = attempt.id`

function fail(code: string, message: string, status = 409): never {
  throw new ShopifyCarrierServiceMutationAuthorizationError(
    code,
    message,
    status,
  )
}

function identifier(
  value: unknown,
  pattern: RegExp,
  label: string,
  maximum = 512,
) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 1
    || normalized.length > maximum
    || !pattern.test(normalized)
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_IDENTIFIER_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function text(value: unknown, label: string, minimum: number, maximum: number) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return parsed
}

function actorEmail(value: unknown) {
  const normalized = text(value, 'Actor email', 3, 320).toLowerCase()
  if (!normalized.includes('@')) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_ACTOR_INVALID',
      'Actor email is invalid',
      400,
    )
  }
  return normalized
}

function actorRole(
  value: unknown,
): ShopifyCarrierServiceMutationActorRole {
  if (value !== 'owner' && value !== 'admin') {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_ACTOR_ROLE_INVALID',
      'An owner or authorized administrator is required',
      403,
    )
  }
  return value
}

function iso(value: TimestampValue) {
  return new Date(value).toISOString()
}

function authorization(row: AuthorizationRow) {
  const resolution = row.resolution_id
    ? {
        id: row.resolution_id,
        globalId: row.resolution_global_id as string,
        disposition: row.resolution_disposition!,
        providerReference: row.resolution_provider_reference,
        resolutionHash: row.resolution_hash as string,
        resolvedAt: iso(row.resolved_at as TimestampValue),
      }
    : null
  const outcome = row.outcome_id
    ? {
        id: row.outcome_id,
        globalId: row.outcome_global_id as string,
        state:
          row.outcome as ShopifyCarrierServiceMutationOutcomeState,
        resultHash: row.outcome_result_hash as string,
        providerReference: row.outcome_provider_reference,
        errorCode: row.outcome_error_code,
        providerWriteCount:
          row.outcome_provider_write_count as 0 | 1 | null,
        completedAt: iso(
          row.outcome_completed_at as TimestampValue,
        ),
      }
    : null
  const attempt = row.attempt_id
    ? {
        id: row.attempt_id,
        globalId: row.attempt_global_id as string,
        leaseToken: row.lease_token as string,
        leaseExpiresAt: iso(row.lease_expires_at as TimestampValue),
        claimedAt: iso(row.claimed_at as TimestampValue),
      }
    : null
  let status: ShopifyCarrierServiceMutationAuthorization['status']
  if (resolution) {
    status = resolution.disposition
  } else if (outcome) {
    status = outcome.state
  } else if (attempt) {
    status = 'claimed'
  } else if (new Date(row.expires_at).getTime() <= Date.now()) {
    status = 'expired'
  } else {
    status = 'authorized'
  }
  return {
    id: row.id,
    globalId: row.global_id,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    accountGlobalId: row.account_global_id,
    configId: row.config_id,
    configGlobalId: row.config_global_id,
    simulationEffectId: row.simulation_effect_id,
    simulationEffectGlobalId: row.simulation_effect_global_id,
    operation: row.operation,
    accountEnvironment: row.account_environment,
    credentialGeneration: row.credential_generation,
    configRowVersion: Number(row.config_row_version),
    activationState: row.activation_state,
    activationRevision: row.activation_revision,
    simulationActivationRevision:
      row.simulation_activation_revision,
    providerWriteActivationRevision:
      row.provider_write_activation_revision,
    aggregateHash: row.aggregate_hash,
    requestHash: row.request_hash,
    expectedServiceGid: row.expected_service_gid,
    confirmationHash: row.confirmation_hash,
    confirmationStatementVersion:
      row.confirmation_statement_version,
    idempotencyKey: row.idempotency_key,
    authorizationFenceHash: row.authorization_fence_hash,
    authorizedBy: row.authorized_by,
    authorizedRole: row.authorized_role,
    authorizedAt: iso(row.authorized_at),
    expiresAt: iso(row.expires_at),
    status,
    reconciliationRequired:
      Boolean(attempt)
      && new Date(
        attempt?.leaseExpiresAt || row.expires_at,
      ).getTime() <= Date.now()
      && (!outcome || outcome.state === 'unknown')
      && !resolution,
    attempt,
    outcome,
    resolution,
  } satisfies ShopifyCarrierServiceMutationAuthorization
}

async function readAuthorizationWithClient(
  client: PoolClient | null,
  input: {
    organizationId: string
    authorizationGlobalId: string
    forUpdate?: boolean
  },
) {
  const sql = `${AUTHORIZATION_SELECT}
    WHERE authorized_mutation.organization_id = $1::uuid
      AND authorized_mutation.global_id = $2
    ${input.forUpdate ? 'FOR UPDATE OF authorized_mutation' : ''}`
  const result = client
    ? await client.query<AuthorizationRow>(sql, [
        input.organizationId,
        input.authorizationGlobalId,
      ])
    : await query<AuthorizationRow>(sql, [
        input.organizationId,
        input.authorizationGlobalId,
      ])
  return result.rows[0] ? authorization(result.rows[0]) : null
}

export function shopifyCarrierServiceMutationConfirmationVersion(
  environment: ShopifyCarrierServiceMutationEnvironment,
) {
  return environment === 'production'
    ? SHOPIFY_CARRIER_SERVICE_PRODUCTION_CONFIRMATION_VERSION
    : SHOPIFY_CARRIER_SERVICE_SANDBOX_CONFIRMATION_VERSION
}

export function shopifyCarrierServiceMutationConfirmationHash(input: {
  accountGlobalId: string
  configGlobalId: string
  configRowVersion: number
  operation: ShopifyCarrierServiceMutationOperation
  environment: ShopifyCarrierServiceMutationEnvironment
  requestHash: string
  actorEmail: string
  statementVersion: string
}) {
  return commerceExternalEffectHash({
    confirmed: true,
    accountGlobalId: identifier(
      input.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    configGlobalId: identifier(
      input.configGlobalId,
      CONFIG_GLOBAL_ID,
      'CarrierService configuration Global ID',
    ),
    configRowVersion: integer(
      input.configRowVersion,
      'Configuration row version',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    operation: input.operation,
    environment: input.environment,
    requestHash: identifier(
      input.requestHash,
      SHA256,
      'Provider request hash',
      64,
    ),
    actorEmail: actorEmail(input.actorEmail),
    statementVersion: text(
      input.statementVersion,
      'Confirmation statement version',
      8,
      160,
    ),
  })
}

export function shopifyCarrierServiceMutationResolutionConfirmationHash(
  input: {
    attemptGlobalId: string
    disposition: ShopifyCarrierServiceMutationResolutionDisposition
    providerReference?: string | null
    resolutionHash: string
    actorEmail: string
    statementVersion: string
  },
) {
  return commerceExternalEffectHash({
    confirmed: true,
    attemptGlobalId: identifier(
      input.attemptGlobalId,
      ATTEMPT_GLOBAL_ID,
      'Mutation attempt Global ID',
    ),
    disposition: input.disposition,
    providerReference: input.providerReference || null,
    resolutionHash: identifier(
      input.resolutionHash,
      SHA256,
      'Resolution hash',
      64,
    ),
    actorEmail: actorEmail(input.actorEmail),
    statementVersion: text(
      input.statementVersion,
      'Reconciliation confirmation version',
      8,
      160,
    ),
  })
}

export async function authorizeShopifyCarrierServiceMutationInPostgres(
  rawInput: {
    organizationId: string
    accountGlobalId: string
    configGlobalId: string
    expectedConfigRowVersion: number
    simulationEffectGlobalId: string
    operation: ShopifyCarrierServiceMutationOperation
    accountEnvironment: ShopifyCarrierServiceMutationEnvironment
    credentialGeneration: number
    configActivationRevision: number
    simulationActivationRevision: number
    providerWriteActivationRevision: number
    aggregateHash: string
    requestHash: string
    expectedServiceGid?: string | null
    confirmationHash: string
    confirmationStatementVersion: string
    idempotencyKey: string
    actorEmail: string
    actorRole: ShopifyCarrierServiceMutationActorRole
    expiresInSeconds?: number
  },
) {
  const input = {
    organizationId: identifier(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: identifier(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    configGlobalId: identifier(
      rawInput.configGlobalId,
      CONFIG_GLOBAL_ID,
      'CarrierService configuration Global ID',
    ),
    expectedConfigRowVersion: integer(
      rawInput.expectedConfigRowVersion,
      'Configuration row version',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    simulationEffectGlobalId: identifier(
      rawInput.simulationEffectGlobalId,
      EFFECT_GLOBAL_ID,
      'Shadow simulation Global ID',
    ),
    operation: rawInput.operation,
    accountEnvironment: rawInput.accountEnvironment,
    credentialGeneration: integer(
      rawInput.credentialGeneration,
      'Credential generation',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    configActivationRevision: integer(
      rawInput.configActivationRevision,
      'Configuration activation revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    simulationActivationRevision: integer(
      rawInput.simulationActivationRevision,
      'Shadow simulation activation revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    providerWriteActivationRevision: integer(
      rawInput.providerWriteActivationRevision,
      'Active provider-write activation revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    aggregateHash: identifier(
      rawInput.aggregateHash,
      SHA256,
      'Aggregate hash',
      64,
    ),
    requestHash: identifier(
      rawInput.requestHash,
      SHA256,
      'Provider request hash',
      64,
    ),
    expectedServiceGid: rawInput.expectedServiceGid
      ? identifier(
          rawInput.expectedServiceGid,
          SHOPIFY_SERVICE_GID,
          'Expected Shopify CarrierService ID',
        )
      : null,
    confirmationHash: identifier(
      rawInput.confirmationHash,
      SHA256,
      'Confirmation hash',
      64,
    ),
    confirmationStatementVersion: text(
      rawInput.confirmationStatementVersion,
      'Confirmation statement version',
      8,
      160,
    ),
    idempotencyKey: text(
      rawInput.idempotencyKey,
      'Authorization idempotency key',
      8,
      200,
    ),
    actorEmail: actorEmail(rawInput.actorEmail),
    actorRole: actorRole(rawInput.actorRole),
    expiresInSeconds: integer(
      rawInput.expiresInSeconds ?? 120,
      'Authorization lifetime',
      15,
      300,
    ),
  }
  if (!['create', 'delete'].includes(input.operation)) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_OPERATION_INVALID',
      'Only Shopify CarrierService create or delete can be authorized',
      400,
    )
  }
  if (!['sandbox', 'production'].includes(input.accountEnvironment)) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_ENVIRONMENT_INVALID',
      'CarrierService provider writes require an exact sandbox or production environment',
      400,
    )
  }
  if (
    input.operation === 'create'
    && input.accountEnvironment !== 'sandbox'
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CREATE_BLOCKED',
      'New Shopify CarrierService registration is sandbox-only; production is limited to exact removal and reconciliation',
      409,
    )
  }
  if (
    input.confirmationStatementVersion
    !== shopifyCarrierServiceMutationConfirmationVersion(
      input.accountEnvironment,
    )
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_CONFIRMATION_VERSION_INVALID',
      'Confirmation statement does not match the exact Shopify environment',
      400,
    )
  }
  if (
    input.confirmationHash
    !== shopifyCarrierServiceMutationConfirmationHash({
      accountGlobalId: input.accountGlobalId,
      configGlobalId: input.configGlobalId,
      configRowVersion: input.expectedConfigRowVersion,
      operation: input.operation,
      environment: input.accountEnvironment,
      requestHash: input.requestHash,
      actorEmail: input.actorEmail,
      statementVersion: input.confirmationStatementVersion,
    })
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_CONFIRMATION_HASH_INVALID',
      'Explicit provider-write confirmation does not match the exact request',
      400,
    )
  }
  if (
    (input.operation === 'create' && input.expectedServiceGid)
    || (input.operation === 'delete' && !input.expectedServiceGid)
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_SERVICE_FENCE_INVALID',
      'CarrierService identity does not match the requested operation',
      400,
    )
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-authorization:${input.organizationId}:${input.configGlobalId}`,
    )
    const facts = await client.query<{
      integration_account_id: string
      config_id: string
      simulation_effect_id: string
    }>(
      `SELECT
         account.id::text AS integration_account_id,
         config.id::text AS config_id,
         simulation.id::text AS simulation_effect_id
       FROM operations_integration_accounts account
       JOIN operations_shopify_carrier_service_configs config
         ON config.organization_id = account.organization_id
        AND config.integration_account_id = account.id
       JOIN operations_commerce_external_effect_intents simulation
         ON simulation.organization_id = account.organization_id
        AND simulation.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND config.global_id = $3
         AND simulation.global_id = $4
       FOR UPDATE OF config`,
      [
        input.organizationId,
        input.accountGlobalId,
        input.configGlobalId,
        input.simulationEffectGlobalId,
      ],
    )
    if (!facts.rows[0]) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_FENCE_NOT_FOUND',
        'Exact Shopify account, configuration, or Shadow simulation was not found',
        404,
      )
    }
    const inserted = await client.query<{ global_id: string }>(
      `INSERT INTO
         operations_shopify_carrier_service_mutation_authorizations (
           organization_id, integration_account_id, config_id,
           simulation_effect_id, operation, account_environment,
           credential_generation, config_row_version, activation_state,
           activation_revision, simulation_activation_revision,
           provider_write_activation_revision, aggregate_hash, request_hash,
           expected_service_gid, confirmation_hash,
           confirmation_statement_version, idempotency_key,
           authorized_by, authorized_role, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
           $8::bigint, 'shadow', $9, $10, $11, $12, $13, $14, $15,
           $16, $17, $18, $19, now() + ($20::text || ' seconds')::interval
         )
         ON CONFLICT (
           organization_id, integration_account_id, operation,
           idempotency_key
         ) DO NOTHING
         RETURNING global_id`,
      [
        input.organizationId,
        facts.rows[0].integration_account_id,
        facts.rows[0].config_id,
        facts.rows[0].simulation_effect_id,
        input.operation,
        input.accountEnvironment,
        input.credentialGeneration,
        input.expectedConfigRowVersion,
        input.configActivationRevision,
        input.simulationActivationRevision,
        input.providerWriteActivationRevision,
        input.aggregateHash,
        input.requestHash,
        input.expectedServiceGid,
        input.confirmationHash,
        input.confirmationStatementVersion,
        input.idempotencyKey,
        input.actorEmail,
        input.actorRole,
        input.expiresInSeconds,
      ],
    )
    let globalId = inserted.rows[0]?.global_id
    if (!globalId) {
      const replay = await client.query<{ global_id: string }>(
        `SELECT authorized_mutation.global_id
         FROM operations_shopify_carrier_service_mutation_authorizations
           authorized_mutation
         WHERE authorized_mutation.organization_id = $1::uuid
           AND authorized_mutation.integration_account_id = $2::uuid
           AND authorized_mutation.operation = $3
           AND authorized_mutation.idempotency_key = $4
           AND authorized_mutation.config_id = $5::uuid
           AND authorized_mutation.simulation_effect_id = $6::uuid
           AND authorized_mutation.account_environment = $7
           AND authorized_mutation.credential_generation = $8
           AND authorized_mutation.config_row_version = $9::bigint
           AND authorized_mutation.activation_revision = $10
           AND authorized_mutation.simulation_activation_revision = $11
           AND authorized_mutation.provider_write_activation_revision = $12
           AND authorized_mutation.aggregate_hash = $13
           AND authorized_mutation.request_hash = $14
           AND authorized_mutation.expected_service_gid IS NOT DISTINCT FROM $15
           AND authorized_mutation.confirmation_hash = $16
           AND authorized_mutation.confirmation_statement_version = $17
           AND authorized_mutation.authorized_by = $18
           AND authorized_mutation.authorized_role = $19`,
        [
          input.organizationId,
          facts.rows[0].integration_account_id,
          input.operation,
          input.idempotencyKey,
          facts.rows[0].config_id,
          facts.rows[0].simulation_effect_id,
          input.accountEnvironment,
          input.credentialGeneration,
          input.expectedConfigRowVersion,
          input.configActivationRevision,
          input.simulationActivationRevision,
          input.providerWriteActivationRevision,
          input.aggregateHash,
          input.requestHash,
          input.expectedServiceGid,
          input.confirmationHash,
          input.confirmationStatementVersion,
          input.actorEmail,
          input.actorRole,
        ],
      )
      globalId = replay.rows[0]?.global_id
      if (!globalId) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_MUTATION_IDEMPOTENCY_CONFLICT',
          'Authorization idempotency key was used for different provider-write evidence',
        )
      }
    }
    const created = await readAuthorizationWithClient(client, {
      organizationId: input.organizationId,
      authorizationGlobalId: globalId,
    })
    if (!created) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_AUTHORIZATION_NOT_FOUND',
        'Durable Shopify CarrierService authorization was not found',
        500,
      )
    }
    if (inserted.rows[0]) {
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType:
          'operations.shopify_carrier_service.mutation_authorized',
        aggregateType:
          'operations.shopify_carrier_service_mutation_authorization',
        aggregateId: created.globalId,
        subject: input.accountGlobalId,
        organizationId: input.organizationId,
        eventKey:
          `operations:shopify-carrier-service-authorization:${created.globalId}`,
        payload: {
          accountGlobalId: input.accountGlobalId,
          configGlobalId: input.configGlobalId,
          configRowVersion: input.expectedConfigRowVersion,
          simulationEffectGlobalId: input.simulationEffectGlobalId,
          operation: input.operation,
          accountEnvironment: input.accountEnvironment,
          credentialGeneration: input.credentialGeneration,
          simulationMode: 'shadow',
          configActivationRevision:
            input.configActivationRevision,
          simulationActivationRevision:
            input.simulationActivationRevision,
          providerWriteMode: 'active',
          providerWriteActivationRevision:
            input.providerWriteActivationRevision,
          aggregateHash: input.aggregateHash,
          requestHash: input.requestHash,
          confirmationHash: input.confirmationHash,
          confirmationStatementVersion:
            input.confirmationStatementVersion,
          authorizationFenceHash: created.authorizationFenceHash,
          expiresAt: created.expiresAt,
        },
      }, client)
    }
    return created
  })
}

export async function claimShopifyCarrierServiceMutationInPostgres(
  rawInput: {
    organizationId: string
    authorizationGlobalId: string
    expectedAuthorizationFenceHash: string
    workerId: string
    adapterVersion: string
    leaseSeconds?: number
  },
): Promise<ClaimedShopifyCarrierServiceMutationAuthorization> {
  const input = {
    organizationId: identifier(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    authorizationGlobalId: identifier(
      rawInput.authorizationGlobalId,
      AUTHORIZATION_GLOBAL_ID,
      'Mutation authorization Global ID',
    ),
    expectedAuthorizationFenceHash: identifier(
      rawInput.expectedAuthorizationFenceHash,
      SHA256,
      'Authorization fence hash',
      64,
    ),
    workerId: text(rawInput.workerId, 'Worker ID', 1, 200),
    adapterVersion: text(
      rawInput.adapterVersion,
      'Adapter version',
      1,
      160,
    ),
    leaseSeconds: integer(
      rawInput.leaseSeconds ?? 60,
      'Claim lease',
      5,
      300,
    ),
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-mutation-claim:${input.organizationId}:${input.authorizationGlobalId}`,
    )
    const current = await readAuthorizationWithClient(client, {
      organizationId: input.organizationId,
      authorizationGlobalId: input.authorizationGlobalId,
      forUpdate: true,
    })
    if (!current) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_AUTHORIZATION_NOT_FOUND',
        'Shopify CarrierService mutation authorization was not found',
        404,
      )
    }
    if (
      current.authorizationFenceHash
      !== input.expectedAuthorizationFenceHash
    ) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_AUTHORIZATION_FENCE_STALE',
        'Shopify CarrierService mutation authorization fence changed',
      )
    }
    if (current.providerWriteActivationRevision === null) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_LEGACY_SHADOW_AUTHORIZATION_DISABLED',
        'Legacy Shadow provider-write authorizations are audit-only and cannot be claimed',
      )
    }
    if (current.attempt) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_RECONCILIATION_REQUIRED',
        'This one-time provider mutation was already claimed and cannot be retried; reconcile its outcome',
      )
    }
    if (current.status !== 'authorized') {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_AUTHORIZATION_EXPIRED',
        'Shopify CarrierService mutation authorization expired before claim',
      )
    }
    const leaseToken = randomUUID()
    const attempt = await client.query<{ global_id: string }>(
      `INSERT INTO operations_shopify_carrier_service_mutation_attempts (
         organization_id, authorization_id, worker_id, adapter_version,
         lease_token, lease_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5::uuid,
         now() + ($6::text || ' seconds')::interval
       )
       RETURNING global_id`,
      [
        input.organizationId,
        current.id,
        input.workerId,
        input.adapterVersion,
        leaseToken,
        input.leaseSeconds,
      ],
    )
    const claimed = await readAuthorizationWithClient(client, {
      organizationId: input.organizationId,
      authorizationGlobalId: input.authorizationGlobalId,
    })
    if (
      !claimed
      || claimed.status !== 'claimed'
      || claimed.attempt?.globalId !== attempt.rows[0]?.global_id
      || claimed.attempt.leaseToken !== leaseToken
    ) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_CLAIM_INVALID',
        'One-time Shopify provider mutation was not claimed exactly once',
        500,
      )
    }
    await recordAuditEvent({
      actor: current.authorizedBy,
      eventType: 'operations.shopify_carrier_service.mutation_claimed',
      aggregateType:
        'operations.shopify_carrier_service_mutation_attempt',
      aggregateId: claimed.attempt.globalId,
      subject: current.accountGlobalId,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-carrier-service-mutation:${claimed.attempt.globalId}:claimed`,
      payload: {
        authorizationGlobalId: current.globalId,
        authorizationFenceHash: current.authorizationFenceHash,
        operation: current.operation,
        accountEnvironment: current.accountEnvironment,
        requestHash: current.requestHash,
        workerId: input.workerId,
        adapterVersion: input.adapterVersion,
        claimedAt: claimed.attempt.claimedAt,
      },
    }, client)
    return claimed as ClaimedShopifyCarrierServiceMutationAuthorization
  })
}

export async function finalizeShopifyCarrierServiceMutationInPostgres(
  rawInput: {
    organizationId: string
    attemptGlobalId: string
    leaseToken: string
    outcome: ShopifyCarrierServiceMutationOutcomeState
    redactedResult: Record<string, unknown>
    providerReference?: string | null
    errorCode?: string | null
    providerWriteCount?: 0 | 1 | null
    finalizedBy: string
  },
) {
  assertRedactedCommerceExternalEffectEvidence(
    rawInput.redactedResult,
    'Shopify CarrierService mutation result',
  )
  const input = {
    organizationId: identifier(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    attemptGlobalId: identifier(
      rawInput.attemptGlobalId,
      ATTEMPT_GLOBAL_ID,
      'Mutation attempt Global ID',
    ),
    leaseToken: identifier(
      rawInput.leaseToken,
      UUID,
      'Mutation lease token',
    ),
    outcome: rawInput.outcome,
    redactedResult: rawInput.redactedResult,
    resultHash: commerceExternalEffectHash(rawInput.redactedResult),
    providerReference: rawInput.providerReference
      ? identifier(
          rawInput.providerReference,
          SHOPIFY_SERVICE_GID,
          'Shopify CarrierService ID',
        )
      : null,
    errorCode: rawInput.errorCode
      ? identifier(rawInput.errorCode, ERROR_CODE, 'Mutation error code', 128)
      : null,
    providerWriteCount: rawInput.providerWriteCount ?? null,
    finalizedBy: text(
      rawInput.finalizedBy,
      'Mutation finalizer',
      1,
      200,
    ),
  }
  if (!['succeeded', 'failed', 'unknown'].includes(input.outcome)) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_OUTCOME_INVALID',
      'Mutation outcome is invalid',
      400,
    )
  }
  if (
    (
      input.outcome === 'succeeded'
      && (
        !input.providerReference
        || input.errorCode
        || input.providerWriteCount !== 1
      )
    )
    || (
      input.outcome === 'failed'
      && (
        input.providerReference
        || !input.errorCode
        || input.providerWriteCount !== 0
      )
    )
    || (
      input.outcome === 'unknown'
      && (
        !input.errorCode
        || input.providerWriteCount !== null
      )
    )
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_OUTCOME_EVIDENCE_INVALID',
      'Mutation outcome evidence is internally inconsistent',
      400,
    )
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-mutation-finalize:${input.organizationId}:${input.attemptGlobalId}`,
    )
    const attempt = await client.query<{
      id: string
      lease_token: string
      authorization_global_id: string
      account_global_id: string
      resolution_global_id: string | null
    }>(
      `SELECT
         attempt.id::text,
         attempt.lease_token::text,
         authorized_mutation.global_id AS authorization_global_id,
         account.global_id AS account_global_id,
         resolution.global_id AS resolution_global_id
       FROM operations_shopify_carrier_service_mutation_attempts attempt
       JOIN operations_shopify_carrier_service_mutation_authorizations
         authorized_mutation
         ON authorized_mutation.organization_id = attempt.organization_id
        AND authorized_mutation.id = attempt.authorization_id
       JOIN operations_integration_accounts account
         ON account.organization_id = authorized_mutation.organization_id
        AND account.id = authorized_mutation.integration_account_id
       LEFT JOIN operations_shopify_carrier_service_mutation_resolutions
         resolution
         ON resolution.organization_id = attempt.organization_id
        AND resolution.attempt_id = attempt.id
       WHERE attempt.organization_id = $1::uuid
         AND attempt.global_id = $2
       FOR UPDATE OF attempt`,
      [input.organizationId, input.attemptGlobalId],
    )
    if (!attempt.rows[0]) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_ATTEMPT_NOT_FOUND',
        'Shopify CarrierService mutation attempt was not found',
        404,
      )
    }
    if (attempt.rows[0].lease_token !== input.leaseToken) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_LEASE_STALE',
        'Shopify CarrierService mutation lease is stale',
      )
    }
    if (attempt.rows[0].resolution_global_id) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_ALREADY_RECONCILED',
        'A reconciled Shopify CarrierService mutation cannot later receive a provider outcome',
      )
    }
    const existing = await client.query<{
      global_id: string
      outcome: ShopifyCarrierServiceMutationOutcomeState
      result_hash: string
      provider_reference: string | null
      error_code: string | null
      provider_write_count: number | null
    }>(
      `SELECT
         global_id,
         outcome,
         result_hash,
         provider_reference,
         error_code,
         provider_write_count
       FROM operations_shopify_carrier_service_mutation_outcomes
       WHERE organization_id = $1::uuid
         AND attempt_id = $2::uuid`,
      [input.organizationId, attempt.rows[0].id],
    )
    if (existing.rows[0]) {
      const replay = existing.rows[0]
      if (
        replay.outcome !== input.outcome
        || replay.result_hash !== input.resultHash
        || replay.provider_reference !== input.providerReference
        || replay.error_code !== input.errorCode
        || replay.provider_write_count !== input.providerWriteCount
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_MUTATION_OUTCOME_CONFLICT',
          'Append-only Shopify CarrierService mutation outcome cannot change',
        )
      }
      return readAuthorizationWithClient(client, {
        organizationId: input.organizationId,
        authorizationGlobalId:
          attempt.rows[0].authorization_global_id,
      })
    }
    await client.query(
      `INSERT INTO
         operations_shopify_carrier_service_mutation_outcomes (
           organization_id, attempt_id, lease_token, outcome,
           redacted_result, result_hash, provider_reference, error_code,
           provider_write_count, finalized_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7, $8, $9, $10
         )`,
      [
        input.organizationId,
        attempt.rows[0].id,
        input.leaseToken,
        input.outcome,
        JSON.stringify(input.redactedResult),
        input.resultHash,
        input.providerReference,
        input.errorCode,
        input.providerWriteCount,
        input.finalizedBy,
      ],
    )
    await recordAuditEvent({
      actor: null,
      eventType:
        `operations.shopify_carrier_service.mutation_${input.outcome}`,
      aggregateType:
        'operations.shopify_carrier_service_mutation_attempt',
      aggregateId: input.attemptGlobalId,
      subject: attempt.rows[0].account_global_id,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-carrier-service-mutation:${input.attemptGlobalId}:${input.outcome}`,
      payload: {
        authorizationGlobalId:
          attempt.rows[0].authorization_global_id,
        outcome: input.outcome,
        resultHash: input.resultHash,
        providerReference: input.providerReference,
        errorCode: input.errorCode,
        providerWriteCount: input.providerWriteCount,
        finalizedBy: input.finalizedBy,
      },
    }, client)
    const finalized = await readAuthorizationWithClient(client, {
      organizationId: input.organizationId,
      authorizationGlobalId:
        attempt.rows[0].authorization_global_id,
    })
    if (!finalized) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_OUTCOME_NOT_FOUND',
        'Durable Shopify CarrierService mutation outcome was not found',
        500,
      )
    }
    return finalized
  })
}

export async function resolveShopifyCarrierServiceMutationInPostgres(
  rawInput: {
    organizationId: string
    attemptGlobalId: string
    disposition: ShopifyCarrierServiceMutationResolutionDisposition
    providerReference?: string | null
    resolutionEvidence: Record<string, unknown>
    confirmationHash: string
    confirmationStatementVersion: string
    actorEmail: string
    actorRole: ShopifyCarrierServiceMutationActorRole
  },
) {
  assertRedactedCommerceExternalEffectEvidence(
    rawInput.resolutionEvidence,
    'Shopify CarrierService reconciliation evidence',
  )
  const input = {
    organizationId: identifier(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    attemptGlobalId: identifier(
      rawInput.attemptGlobalId,
      ATTEMPT_GLOBAL_ID,
      'Mutation attempt Global ID',
    ),
    disposition: rawInput.disposition,
    providerReference: rawInput.providerReference
      ? identifier(
          rawInput.providerReference,
          SHOPIFY_SERVICE_GID,
          'Shopify CarrierService ID',
        )
      : null,
    resolutionEvidence: rawInput.resolutionEvidence,
    resolutionHash: commerceExternalEffectHash(
      rawInput.resolutionEvidence,
    ),
    confirmationHash: identifier(
      rawInput.confirmationHash,
      SHA256,
      'Reconciliation confirmation hash',
      64,
    ),
    confirmationStatementVersion: text(
      rawInput.confirmationStatementVersion,
      'Reconciliation confirmation version',
      8,
      160,
    ),
    actorEmail: actorEmail(rawInput.actorEmail),
    actorRole: actorRole(rawInput.actorRole),
  }
  if (
    !['confirmed_applied', 'confirmed_not_applied'].includes(
      input.disposition,
    )
    || (
      input.disposition === 'confirmed_applied'
      && !input.providerReference
    )
    || (
      input.disposition === 'confirmed_not_applied'
      && input.providerReference
    )
    || input.confirmationStatementVersion
      !== SHOPIFY_CARRIER_SERVICE_RECONCILIATION_CONFIRMATION_VERSION
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_RESOLUTION_INVALID',
      'Mutation reconciliation evidence is invalid',
      400,
    )
  }
  if (
    input.confirmationHash
    !== shopifyCarrierServiceMutationResolutionConfirmationHash({
      attemptGlobalId: input.attemptGlobalId,
      disposition: input.disposition,
      providerReference: input.providerReference,
      resolutionHash: input.resolutionHash,
      actorEmail: input.actorEmail,
      statementVersion: input.confirmationStatementVersion,
    })
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_RESOLUTION_CONFIRMATION_INVALID',
      'Explicit reconciliation confirmation does not match the exact evidence',
      400,
    )
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-mutation-resolve:${input.organizationId}:${input.attemptGlobalId}`,
    )
    const attempt = await client.query<{
      id: string
      authorization_global_id: string
      account_global_id: string
      lease_expires_at: TimestampValue
      outcome: ShopifyCarrierServiceMutationOutcomeState | null
      resolution_global_id: string | null
    }>(
      `SELECT
         attempt.id::text,
         authorized_mutation.global_id AS authorization_global_id,
         account.global_id AS account_global_id,
         attempt.lease_expires_at,
         outcome.outcome,
         resolution.global_id AS resolution_global_id
       FROM operations_shopify_carrier_service_mutation_attempts attempt
       JOIN operations_shopify_carrier_service_mutation_authorizations
         authorized_mutation
         ON authorized_mutation.organization_id = attempt.organization_id
        AND authorized_mutation.id = attempt.authorization_id
       JOIN operations_integration_accounts account
         ON account.organization_id = authorized_mutation.organization_id
        AND account.id = authorized_mutation.integration_account_id
       LEFT JOIN operations_shopify_carrier_service_mutation_outcomes outcome
         ON outcome.organization_id = attempt.organization_id
        AND outcome.attempt_id = attempt.id
       LEFT JOIN operations_shopify_carrier_service_mutation_resolutions
         resolution
         ON resolution.organization_id = attempt.organization_id
        AND resolution.attempt_id = attempt.id
       WHERE attempt.organization_id = $1::uuid
         AND attempt.global_id = $2
       FOR UPDATE OF attempt`,
      [input.organizationId, input.attemptGlobalId],
    )
    if (!attempt.rows[0]) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_ATTEMPT_NOT_FOUND',
        'Shopify CarrierService mutation attempt was not found',
        404,
      )
    }
    if (attempt.rows[0].resolution_global_id) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_RESOLUTION_CONFLICT',
        'This Shopify CarrierService mutation was already reconciled',
      )
    }
    if (
      attempt.rows[0].outcome === 'succeeded'
      || attempt.rows[0].outcome === 'failed'
    ) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_OUTCOME_ALREADY_KNOWN',
        'A known Shopify CarrierService mutation outcome cannot be reconciled differently',
      )
    }
    if (
      new Date(attempt.rows[0].lease_expires_at).getTime()
        > Date.now()
    ) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_STILL_IN_FLIGHT',
        'Wait for the provider-call lease to expire before reconciling this mutation, including an unknown outcome',
      )
    }
    const inserted = await client.query<{ global_id: string }>(
      `INSERT INTO
         operations_shopify_carrier_service_mutation_resolutions (
           organization_id, attempt_id, disposition, provider_reference,
           redacted_evidence, resolution_hash, confirmation_hash,
           confirmation_statement_version, resolved_by, resolved_role
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8, $9, $10
         )
         ON CONFLICT (attempt_id) DO NOTHING
         RETURNING global_id`,
      [
        input.organizationId,
        attempt.rows[0].id,
        input.disposition,
        input.providerReference,
        JSON.stringify(input.resolutionEvidence),
        input.resolutionHash,
        input.confirmationHash,
        input.confirmationStatementVersion,
        input.actorEmail,
        input.actorRole,
      ],
    )
    if (!inserted.rows[0]) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_RESOLUTION_CONFLICT',
        'This Shopify CarrierService mutation was already reconciled',
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType:
        `operations.shopify_carrier_service.${input.disposition}`,
      aggregateType:
        'operations.shopify_carrier_service_mutation_resolution',
      aggregateId: inserted.rows[0].global_id,
      subject: attempt.rows[0].account_global_id,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-carrier-service-mutation:${input.attemptGlobalId}:${input.disposition}`,
      payload: {
        authorizationGlobalId:
          attempt.rows[0].authorization_global_id,
        attemptGlobalId: input.attemptGlobalId,
        disposition: input.disposition,
        providerReference: input.providerReference,
        resolutionHash: input.resolutionHash,
        confirmationHash: input.confirmationHash,
        confirmationStatementVersion:
          input.confirmationStatementVersion,
      },
    }, client)
    return readAuthorizationWithClient(client, {
      organizationId: input.organizationId,
      authorizationGlobalId:
        attempt.rows[0].authorization_global_id,
    })
  })
}

/**
 * Link immutable succeeded or confirmed-applied provider evidence to the exact
 * unchanged CarrierService configuration. This transaction is local-only.
 * Active revision and verified credential-generation fences were enforced
 * before the attempt was inserted; a later organization-activation change or
 * credential rotation/verification change must not strand provider state that
 * Shopify already applied.
 */
export async function finalizeShopifyCarrierServiceConfigMutationInPostgres(
  rawInput: {
    organizationId: string
    accountGlobalId: string
    expectedConfigRowVersion: number
    attemptGlobalId: string
    evidenceGlobalId: string
    actorEmail: string
    actorRole: ShopifyCarrierServiceMutationActorRole
  },
) {
  const input = {
    organizationId: identifier(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: identifier(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    expectedConfigRowVersion: integer(
      rawInput.expectedConfigRowVersion,
      'Configuration row version',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    attemptGlobalId: identifier(
      rawInput.attemptGlobalId,
      ATTEMPT_GLOBAL_ID,
      'Mutation attempt Global ID',
    ),
    evidenceGlobalId: identifier(
      rawInput.evidenceGlobalId,
      /^(?:gsco|gscr)[0-9]{7}$/,
      'Applied mutation evidence Global ID',
    ),
    actorEmail: actorEmail(rawInput.actorEmail),
    actorRole: actorRole(rawInput.actorRole),
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-config-mutation:${input.organizationId}:${input.accountGlobalId}`,
    )
    const facts = await client.query<{
      config_id: string
      config_global_id: string
      row_version: string
      registration_state: string
      service_gid: string | null
      authorization_id: string
      authorization_global_id: string
      operation: ShopifyCarrierServiceMutationOperation
      provider_write_activation_revision: number | null
      attempt_id: string
      outcome_id: string | null
      outcome_global_id: string | null
      outcome: ShopifyCarrierServiceMutationOutcomeState | null
      outcome_provider_reference: string | null
      resolution_id: string | null
      resolution_global_id: string | null
      resolution_disposition:
        | ShopifyCarrierServiceMutationResolutionDisposition
        | null
      resolution_provider_reference: string | null
      link_global_id: string | null
      link_outcome_id: string | null
      link_resolution_id: string | null
      link_from_row_version: string | null
      link_to_row_version: string | null
      link_to_registration_state: string | null
      link_to_service_gid: string | null
    }>(
      `SELECT
         config.id::text AS config_id,
         config.global_id AS config_global_id,
         config.row_version::text,
         config.registration_state,
         config.service_gid,
         authorized_mutation.id::text AS authorization_id,
         authorized_mutation.global_id AS authorization_global_id,
         authorized_mutation.operation,
         authorized_mutation.provider_write_activation_revision,
         attempt.id::text AS attempt_id,
         outcome.id::text AS outcome_id,
         outcome.global_id AS outcome_global_id,
         outcome.outcome,
         outcome.provider_reference AS outcome_provider_reference,
         resolution.id::text AS resolution_id,
         resolution.global_id AS resolution_global_id,
         resolution.disposition AS resolution_disposition,
         resolution.provider_reference AS resolution_provider_reference,
         link.global_id AS link_global_id,
         link.outcome_id::text AS link_outcome_id,
         link.resolution_id::text AS link_resolution_id,
         link.from_row_version::text AS link_from_row_version,
         link.to_row_version::text AS link_to_row_version,
         link.to_registration_state AS link_to_registration_state,
         link.to_service_gid AS link_to_service_gid
       FROM operations_shopify_carrier_service_mutation_attempts attempt
       JOIN operations_shopify_carrier_service_mutation_authorizations
         authorized_mutation
         ON authorized_mutation.organization_id = attempt.organization_id
        AND authorized_mutation.id = attempt.authorization_id
       JOIN operations_integration_accounts account
         ON account.organization_id = authorized_mutation.organization_id
        AND account.id = authorized_mutation.integration_account_id
       JOIN operations_shopify_carrier_service_configs config
         ON config.organization_id = authorized_mutation.organization_id
        AND config.id = authorized_mutation.config_id
       LEFT JOIN operations_shopify_carrier_service_mutation_outcomes outcome
         ON outcome.organization_id = attempt.organization_id
        AND outcome.attempt_id = attempt.id
       LEFT JOIN operations_shopify_carrier_service_mutation_resolutions
         resolution
         ON resolution.organization_id = attempt.organization_id
        AND resolution.attempt_id = attempt.id
       LEFT JOIN operations_shopify_carrier_service_config_mutation_links
         link
         ON link.organization_id = attempt.organization_id
        AND link.attempt_id = attempt.id
       WHERE attempt.organization_id = $1::uuid
         AND attempt.global_id = $2
         AND account.global_id = $3
       FOR UPDATE OF config`,
      [
        input.organizationId,
        input.attemptGlobalId,
        input.accountGlobalId,
      ],
    )
    const row = facts.rows[0]
    if (!row) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_ATTEMPT_NOT_FOUND',
        'Exact Shopify CarrierService mutation attempt was not found',
        404,
      )
    }
    const usingOutcome = OUTCOME_GLOBAL_ID.test(input.evidenceGlobalId)
    if (row.link_global_id) {
      const linkedEvidenceMatches = usingOutcome
        ? (
            row.outcome_global_id === input.evidenceGlobalId
            && row.link_outcome_id === row.outcome_id
            && row.link_resolution_id === null
          )
        : (
            RESOLUTION_GLOBAL_ID.test(input.evidenceGlobalId)
            && row.resolution_global_id === input.evidenceGlobalId
            && row.link_resolution_id === row.resolution_id
            && row.link_outcome_id === null
          )
      if (
        !linkedEvidenceMatches
        || Number(row.link_from_row_version)
          !== input.expectedConfigRowVersion
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_MUTATION_CONFIG_LINK_CONFLICT',
          'This provider mutation was already linked to different immutable configuration evidence',
        )
      }
      return {
        configGlobalId: row.config_global_id,
        configMutationLinkGlobalId: row.link_global_id,
        authorizationGlobalId: row.authorization_global_id,
        attemptGlobalId: input.attemptGlobalId,
        evidenceGlobalId: input.evidenceGlobalId,
        operation: row.operation,
        registrationState: row.link_to_registration_state,
        serviceGid: row.link_to_service_gid,
        rowVersion: Number(row.link_to_row_version),
      }
    }
    if (Number(row.row_version) !== input.expectedConfigRowVersion) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_CONFIG_STALE',
        'CarrierService configuration changed before provider-state finalization',
      )
    }
    if (row.provider_write_activation_revision === null) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_LEGACY_SHADOW_AUTHORIZATION_DISABLED',
        'Legacy Shadow provider-write evidence cannot change the current CarrierService configuration',
      )
    }
    const evidenceMatches = usingOutcome
      ? (
          row.outcome_global_id === input.evidenceGlobalId
          && row.outcome === 'succeeded'
        )
      : (
          RESOLUTION_GLOBAL_ID.test(input.evidenceGlobalId)
          && row.resolution_global_id === input.evidenceGlobalId
          && row.resolution_disposition === 'confirmed_applied'
        )
    if (!evidenceMatches) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_APPLIED_EVIDENCE_REQUIRED',
        'Registered or disabled state requires exact applied provider evidence',
      )
    }
    const providerReference = usingOutcome
      ? row.outcome_provider_reference
      : row.resolution_provider_reference
    const targetState = row.operation === 'create'
      ? 'registered'
      : 'disabled'
    const targetServiceGid = row.operation === 'create'
      ? providerReference
      : null
    if (
      !providerReference
      || (
        row.operation === 'create'
        && (
          row.registration_state !== 'shadow_simulated'
          || row.service_gid !== null
        )
      )
      || (
        row.operation === 'delete'
        && (
          row.registration_state !== 'registered'
          || row.service_gid !== providerReference
        )
      )
    ) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_CONFIG_TRANSITION_INVALID',
        'Provider evidence does not match the current CarrierService state',
      )
    }
    const link = await client.query<{ global_id: string }>(
      `INSERT INTO
         operations_shopify_carrier_service_config_mutation_links (
           organization_id, config_id, authorization_id, attempt_id,
           outcome_id, resolution_id, from_row_version, to_row_version,
           from_registration_state, to_registration_state,
           from_service_gid, to_service_gid, linked_by, linked_role
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::bigint, $7::bigint + 1, $8, $9, $10, $11, $12, $13
         )
         RETURNING global_id`,
      [
        input.organizationId,
        row.config_id,
        row.authorization_id,
        row.attempt_id,
        usingOutcome ? row.outcome_id : null,
        usingOutcome ? null : row.resolution_id,
        input.expectedConfigRowVersion,
        row.registration_state,
        targetState,
        row.service_gid,
        targetServiceGid,
        input.actorEmail,
        input.actorRole,
      ],
    )
    const updated = await client.query<{
      global_id: string
      row_version: string
    }>(
      `UPDATE operations_shopify_carrier_service_configs
       SET registration_state = $3,
           service_gid = $4,
           last_error_code = NULL,
           activation_revision = $5,
           row_version = row_version + 1,
           updated_by = $6,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND row_version = $7::bigint
       RETURNING global_id, row_version::text`,
      [
        input.organizationId,
        row.config_id,
        targetState,
        targetServiceGid,
        row.provider_write_activation_revision,
        input.actorEmail,
        input.expectedConfigRowVersion,
      ],
    )
    if (!updated.rows[0]) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_MUTATION_CONFIG_STALE',
        'CarrierService configuration changed during provider-state finalization',
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType:
        `operations.shopify_carrier_service.${targetState}`,
      aggregateType: 'operations.shopify_carrier_service_config',
      aggregateId: row.config_global_id,
      subject: input.accountGlobalId,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-carrier-service:${row.config_global_id}:version:${updated.rows[0].row_version}`,
      payload: {
        accountGlobalId: input.accountGlobalId,
        authorizationGlobalId: row.authorization_global_id,
        attemptGlobalId: input.attemptGlobalId,
        evidenceGlobalId: input.evidenceGlobalId,
        configMutationLinkGlobalId: link.rows[0].global_id,
        operation: row.operation,
        registrationState: targetState,
        serviceGid: targetServiceGid,
        providerWriteActivationRevision:
          row.provider_write_activation_revision,
        fromRowVersion: input.expectedConfigRowVersion,
        rowVersion: Number(updated.rows[0].row_version),
      },
    }, client)
    return {
      configGlobalId: updated.rows[0].global_id,
      configMutationLinkGlobalId: link.rows[0].global_id,
      authorizationGlobalId: row.authorization_global_id,
      attemptGlobalId: input.attemptGlobalId,
      evidenceGlobalId: input.evidenceGlobalId,
      operation: row.operation,
      registrationState: targetState,
      serviceGid: targetServiceGid,
      rowVersion: Number(updated.rows[0].row_version),
    }
  })
}

export async function readShopifyCarrierServiceMutationAuthorizationFromPostgres(
  rawInput: {
    organizationId: string
    authorizationGlobalId: string
  },
) {
  return readAuthorizationWithClient(null, {
    organizationId: identifier(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    authorizationGlobalId: identifier(
      rawInput.authorizationGlobalId,
      AUTHORIZATION_GLOBAL_ID,
      'Mutation authorization Global ID',
    ),
  })
}

export async function readShopifyCarrierServiceMutationAuthorizationsFromPostgres(
  rawInput: {
    organizationId: string
    accountGlobalId: string
    limit?: number
  },
) {
  const input = {
    organizationId: identifier(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: identifier(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    limit: integer(
      rawInput.limit ?? 25,
      'Authorization history limit',
      1,
      100,
    ),
  }
  const result = await query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
     WHERE authorized_mutation.organization_id = $1::uuid
       AND account.global_id = $2
     ORDER BY authorized_mutation.authorized_at DESC, authorized_mutation.id DESC
     LIMIT $3`,
    [input.organizationId, input.accountGlobalId, input.limit],
  )
  return result.rows.map(authorization)
}
