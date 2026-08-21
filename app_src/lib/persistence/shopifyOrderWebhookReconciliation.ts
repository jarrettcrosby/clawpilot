import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS,
  SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS,
  type ShopifyOrderWebhookMutationCompletion,
  type ShopifyOrderWebhookMutationPlanItem,
  type ShopifyOrderWebhookSubscriptionReadiness,
} from '@/lib/integrations/shopifyOrderWebhook'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const SHOP_GID = /^gid:\/\/shopify\/Shop\/[1-9][0-9]{0,20}$/u
const SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u

export class ShopifyOrderWebhookReconciliationPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ShopifyOrderWebhookReconciliationPersistenceError'
  }
}

type CommandStatus =
  | 'prepared'
  | 'processing'
  | 'recoverable'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'reconciled'

type CommandRow = {
  id: string
  organization_id: string
  integration_account_id: string
  integration_account_global_id: string
  credential_generation: number
  external_account_id: string
  shop_domain: string
  callback_uri: string
  idempotency_key: string
  request_hash: string
  confirmation_hash: string
  status: CommandStatus
  authorized_by: string
  authorized_role: 'owner' | 'admin'
  processing_lease_expires_at: string | Date | null
  error_code: string | null
  result_snapshot: Record<string, unknown> | null
  outcome_state: 'succeeded' | 'failed' | 'unknown' | 'reconciled' | null
}

type BindingRow = {
  integration_account_id: string
  integration_account_global_id: string
  external_account_id: string
  account_status: string
  credential_generation: number
  credential_external_account_id: string
  credential_version: number
  verification_status: string
  shop_domain: string | null
  authorized_role: 'owner' | 'admin'
}

export type ShopifyOrderWebhookCommandState = Readonly<{
  commandId: string
  status: CommandStatus
  processingLeaseExpired: boolean
  replayed: boolean
  resultSnapshot: Readonly<Record<string, unknown>> | null
  errorCode: string | null
}>

function fail(code: string, message: string, status = 400): never {
  throw new ShopifyOrderWebhookReconciliationPersistenceError(
    code,
    message,
    status,
  )
}

function exactText(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximum = 512,
) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 1
    || value.length > maximum
    || !pattern.test(value)
  ) fail('SHOPIFY_ORDER_WEBHOOK_COMMAND_INVALID', `${label} is invalid`)
  return value
}

function exactUri(value: unknown, accountGlobalId: string) {
  if (typeof value !== 'string' || value !== value.trim()) {
    fail('SHOPIFY_ORDER_WEBHOOK_CALLBACK_INVALID', 'Shopify callback URL is invalid')
  }
  try {
    const parsed = new URL(value)
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.pathname !==
        `/api/integrations/commerce/shopify/webhooks/${accountGlobalId}`
      || parsed.toString() !== value
    ) throw new Error('invalid')
    return value
  } catch {
    fail('SHOPIFY_ORDER_WEBHOOK_CALLBACK_INVALID', 'Shopify callback URL is invalid')
  }
}

function exactGeneration(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(
      'SHOPIFY_ORDER_WEBHOOK_CREDENTIAL_INVALID',
      'Shopify credential generation is invalid',
    )
  }
  return Number(value)
}

function actorEmail(value: unknown) {
  return exactText(
    value,
    'Actor email',
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/u,
    320,
  )
}

function commandState(row: CommandRow, replayed: boolean): ShopifyOrderWebhookCommandState {
  const lease = row.processing_lease_expires_at
    ? new Date(row.processing_lease_expires_at).getTime()
    : null
  return Object.freeze({
    commandId: row.id,
    status: row.status,
    processingLeaseExpired: lease !== null
      && Number.isFinite(lease)
      && lease <= Date.now(),
    replayed,
    resultSnapshot: row.result_snapshot
      ? Object.freeze(row.result_snapshot)
      : null,
    errorCode: row.error_code,
  })
}

const COMMAND_SELECT = `SELECT
  command.*,
  outcome.result_snapshot,
  outcome.outcome_state
FROM operations_shopify_order_webhook_commands command
LEFT JOIN LATERAL (
  SELECT terminal.result_snapshot, terminal.outcome_state
  FROM operations_shopify_order_webhook_outcomes terminal
  WHERE terminal.organization_id = command.organization_id
    AND terminal.command_id = command.id
  ORDER BY terminal.completed_at DESC, terminal.id DESC
  LIMIT 1
) outcome ON true`

async function binding(
  client: PoolClient,
  input: {
    organizationId: string
    accountGlobalId: string
    actorEmail: string
    lock: boolean
  },
) {
  const result = await client.query<BindingRow>(
    `SELECT
       account.id::text AS integration_account_id,
       account.global_id AS integration_account_global_id,
       account.external_account_id,
       account.status AS account_status,
       account.commerce_credential_generation AS credential_generation,
       credential.external_account_id AS credential_external_account_id,
       credential.credential_version,
       credential.verification_status,
       account.configuration->>'shopDomain' AS shop_domain,
       membership.role AS authorized_role
     FROM operations_integration_accounts account
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN app_user_organization_memberships membership
       ON membership.organization_id = account.organization_id
      AND membership.user_email = $3
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
     LIMIT 1
     ${input.lock ? 'FOR UPDATE OF account, credential' : 'FOR SHARE OF account, credential'}`,
    [input.organizationId, input.accountGlobalId, input.actorEmail],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'SHOPIFY_ORDER_WEBHOOK_ACCOUNT_FORBIDDEN',
      'An active organization owner or administrator must select this Shopify account',
      403,
    )
  }
  if (
    row.account_status !== 'active'
    || row.verification_status !== 'verified'
    || row.external_account_id !== row.credential_external_account_id
    || row.credential_generation !== row.credential_version
    || row.credential_generation < 1
    || !row.shop_domain
    || !SHOP_DOMAIN.test(row.shop_domain)
  ) {
    fail(
      'SHOPIFY_ORDER_WEBHOOK_ACCOUNT_NOT_CURRENT',
      'Verify and enable the exact Shopify connection before reconciling order webhooks',
      409,
    )
  }
  return row
}

function assertExpectedBinding(
  row: BindingRow,
  input: {
    integrationAccountId: string
    credentialGeneration: number
    externalAccountId: string
    shopDomain: string
  },
) {
  if (
    row.integration_account_id !== input.integrationAccountId
    || row.credential_generation !== input.credentialGeneration
    || row.external_account_id !== input.externalAccountId
    || row.shop_domain !== input.shopDomain
  ) {
    fail(
      'SHOPIFY_ORDER_WEBHOOK_BINDING_DRIFT',
      'Shopify account identity, credential generation, or domain changed before dispatch',
      409,
    )
  }
}

export async function prepareShopifyOrderWebhookReconciliationInPostgres(
  raw: {
    organizationId: unknown
    accountGlobalId: unknown
    integrationAccountId: unknown
    credentialGeneration: unknown
    externalAccountId: unknown
    shopDomain: unknown
    callbackUri: unknown
    idempotencyKey: unknown
    requestHash: unknown
    confirmationHash: unknown
    actorEmail: unknown
  },
) {
  const organizationId = exactText(raw.organizationId, 'Organization', UUID, 64)
  const accountGlobalId = exactText(
    raw.accountGlobalId,
    'Shopify account',
    ACCOUNT_GLOBAL_ID,
    32,
  )
  const integrationAccountId = exactText(
    raw.integrationAccountId,
    'Shopify account identity',
    UUID,
    64,
  )
  const credentialGeneration = exactGeneration(raw.credentialGeneration)
  const externalAccountId = exactText(
    raw.externalAccountId,
    'Shopify store identity',
    SHOP_GID,
    128,
  )
  const shopDomain = exactText(raw.shopDomain, 'Shopify domain', SHOP_DOMAIN, 255)
  const callbackUri = exactUri(raw.callbackUri, accountGlobalId)
  const idempotencyKey = exactText(
    raw.idempotencyKey,
    'Idempotency-Key',
    IDEMPOTENCY_KEY,
    200,
  )
  const requestHash = exactText(raw.requestHash, 'Request hash', SHA256, 64)
  const confirmationHash = exactText(
    raw.confirmationHash,
    'Confirmation hash',
    SHA256,
    64,
  )
  const authorizedBy = actorEmail(raw.actorEmail)

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-webhook:${organizationId}:${accountGlobalId}`,
    )
    const current = await binding(client, {
      organizationId,
      accountGlobalId,
      actorEmail: authorizedBy,
      lock: true,
    })
    assertExpectedBinding(current, {
      integrationAccountId,
      credentialGeneration,
      externalAccountId,
      shopDomain,
    })
    const existing = await client.query<CommandRow>(
      `${COMMAND_SELECT}
       WHERE command.organization_id = $1::uuid
         AND command.integration_account_id = $2::uuid
         AND command.idempotency_key = $3
       LIMIT 1`,
      [organizationId, integrationAccountId, idempotencyKey],
    )
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (
        row.request_hash !== requestHash
        || row.confirmation_hash !== confirmationHash
        || row.authorized_by !== authorizedBy
        || row.credential_generation !== credentialGeneration
        || row.external_account_id !== externalAccountId
        || row.shop_domain !== shopDomain
        || row.callback_uri !== callbackUri
      ) {
        fail(
          'SHOPIFY_ORDER_WEBHOOK_IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used for different Shopify webhook authority',
          409,
        )
      }
      return commandState(row, true)
    }
    const open = await client.query<{ id: string }>(
      `SELECT id::text
       FROM operations_shopify_order_webhook_commands
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND status IN ('prepared', 'processing', 'recoverable', 'unknown')
       LIMIT 1
       FOR UPDATE`,
      [organizationId, integrationAccountId],
    )
    if (open.rows[0]) {
      fail(
        'SHOPIFY_ORDER_WEBHOOK_COMMAND_OPEN',
        'Retry the existing Shopify order webhook action before starting another',
        409,
      )
    }
    const inserted = await client.query<CommandRow>(
      `INSERT INTO operations_shopify_order_webhook_commands (
         organization_id, integration_account_id,
         integration_account_global_id, credential_generation,
         external_account_id, shop_domain, callback_uri,
         desired_topics, include_fields, idempotency_key,
         request_hash, confirmation_hash, authorized_by, authorized_role
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
         $8::text[], $9::text[], $10, $11, $12, $13, $14
       )
       RETURNING *, NULL::jsonb AS result_snapshot,
         NULL::text AS outcome_state`,
      [
        organizationId,
        integrationAccountId,
        accountGlobalId,
        credentialGeneration,
        externalAccountId,
        shopDomain,
        callbackUri,
        [...SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS],
        [...SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS],
        idempotencyKey,
        requestHash,
        confirmationHash,
        authorizedBy,
        current.authorized_role,
      ],
    )
    return commandState(inserted.rows[0], false)
  })
}

export async function claimShopifyOrderWebhookReconciliationInPostgres(input: {
  organizationId: string
  commandId: string
  actorEmail: string
  currentCallbackUri: string
  mutationPlan: readonly ShopifyOrderWebhookMutationPlanItem[]
}) {
  const planSnapshot = JSON.parse(JSON.stringify(input.mutationPlan)) as unknown
  const planHash = createHash('sha256')
    .update(JSON.stringify(planSnapshot))
    .digest('hex')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-webhook-claim:${input.organizationId}:${input.commandId}`,
    )
    const commandResult = await client.query<CommandRow>(
      `${COMMAND_SELECT}
       WHERE command.organization_id = $1::uuid
         AND command.id = $2::uuid
       LIMIT 1
       FOR UPDATE OF command`,
      [input.organizationId, input.commandId],
    )
    const command = commandResult.rows[0]
    if (!command) fail('SHOPIFY_ORDER_WEBHOOK_COMMAND_NOT_FOUND', 'Shopify webhook command was not found', 404)
    if (command.status !== 'prepared' && command.status !== 'recoverable') {
      fail(
        'SHOPIFY_ORDER_WEBHOOK_COMMAND_NOT_PREPARED',
        'Shopify webhook command is not available for provider dispatch',
        409,
      )
    }
    const current = await binding(client, {
      organizationId: command.organization_id,
      accountGlobalId: command.integration_account_global_id,
      actorEmail: input.actorEmail,
      lock: true,
    })
    assertExpectedBinding(current, {
      integrationAccountId: command.integration_account_id,
      credentialGeneration: command.credential_generation,
      externalAccountId: command.external_account_id,
      shopDomain: command.shop_domain,
    })
    if (command.callback_uri !== input.currentCallbackUri) {
      fail(
        'SHOPIFY_ORDER_WEBHOOK_CALLBACK_DRIFT',
        'The public callback URL changed before Shopify dispatch',
        409,
      )
    }
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO operations_shopify_order_webhook_attempts (
         organization_id, command_id, integration_account_id,
         credential_generation, external_account_id, shop_domain,
         callback_uri, request_hash, attempt_number, plan_hash,
         mutation_plan, claimed_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
         $8,
         (SELECT COALESCE(max(existing.attempt_number), 0) + 1
          FROM operations_shopify_order_webhook_attempts existing
          WHERE existing.organization_id = $1::uuid
            AND existing.command_id = $2::uuid),
         $9, $10::jsonb, $11
       ) RETURNING id::text`,
      [
        command.organization_id,
        command.id,
        command.integration_account_id,
        command.credential_generation,
        command.external_account_id,
        command.shop_domain,
        command.callback_uri,
        command.request_hash,
        planHash,
        JSON.stringify(planSnapshot),
        input.actorEmail,
      ],
    )
    const processingAt = new Date()
    await client.query(
      `UPDATE operations_shopify_order_webhook_commands
       SET status = 'processing',
           processing_at = $3::timestamptz,
           processing_lease_expires_at = $3::timestamptz + interval '2 minutes',
           completed_at = NULL,
           error_code = NULL,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [command.organization_id, command.id, processingAt.toISOString()],
    )
    return Object.freeze({
      commandId: command.id,
      attemptId: attempt.rows[0].id,
      requestHash: command.request_hash,
      planHash,
      credentialGeneration: command.credential_generation,
      externalAccountId: command.external_account_id,
      shopDomain: command.shop_domain,
      callbackUri: command.callback_uri,
    })
  })
}

function readinessConfiguration(
  readiness: ShopifyOrderWebhookSubscriptionReadiness,
  input: { accountGlobalId: string; credentialGeneration: number },
) {
  const observedAt = new Date().toISOString()
  return {
    accountGlobalId: input.accountGlobalId,
    credentialGeneration: input.credentialGeneration,
    desiredUri: readiness.desiredUri,
    requiredTopics: readiness.requiredTopics,
    requiredIncludeFields: readiness.requiredIncludeFields,
    observedCount: readiness.subscriptions.length,
    matchingCount: readiness.matchingTopics.length,
    missingTopics: readiness.missingTopics,
    conflictingTopics: readiness.conflictingTopics,
    subscriptionReady: readiness.ready,
    processorState: readiness.processorState,
    exactReadProcessorReady: true,
    scheduledPollBackstop: true,
    ready: readiness.ready,
    observedAt,
    discoveryState: 'succeeded',
    discoveryErrorCode: null,
    providerWrites: 0,
  }
}

export async function finalizeShopifyOrderWebhookReconciliationInPostgres(input: {
  organizationId: string
  commandId: string
  attemptId: string
  actorEmail: string
  outcome: 'recoverable' | 'succeeded' | 'failed' | 'unknown' | 'reconciled'
  providerWriteCount: number | null
  providerReferences: readonly string[]
  completedMutations: readonly ShopifyOrderWebhookMutationCompletion[]
  stoppedMutation: ShopifyOrderWebhookMutationPlanItem | null
  stopClassification: 'deterministic_rejection' | 'ambiguous' | null
  errorCode: string | null
  resultSnapshot: Record<string, unknown>
  readiness?: ShopifyOrderWebhookSubscriptionReadiness
}) {
  const resultJson = JSON.stringify(input.resultSnapshot)
  if (Buffer.byteLength(resultJson, 'utf8') > 64 * 1024) {
    fail(
      'SHOPIFY_ORDER_WEBHOOK_RESULT_TOO_LARGE',
      'Shopify webhook reconciliation result is too large',
      500,
    )
  }
  const resultHash = createHash('sha256').update(resultJson).digest('hex')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-webhook-finalize:${input.organizationId}:${input.commandId}`,
    )
    const commandResult = await client.query<CommandRow>(
      `${COMMAND_SELECT}
       WHERE command.organization_id = $1::uuid
         AND command.id = $2::uuid
       LIMIT 1
       FOR UPDATE OF command`,
      [input.organizationId, input.commandId],
    )
    const command = commandResult.rows[0]
    if (!command) fail('SHOPIFY_ORDER_WEBHOOK_COMMAND_NOT_FOUND', 'Shopify webhook command was not found', 404)
    const expectedStatuses = input.outcome === 'reconciled'
      ? ['recoverable', 'unknown']
      : ['processing']
    if (!expectedStatuses.includes(command.status)) {
      if (
        command.status === input.outcome
        && command.result_snapshot
      ) return commandState(command, true)
      fail(
        'SHOPIFY_ORDER_WEBHOOK_OUTCOME_CONFLICT',
        'Shopify webhook command outcome no longer matches its provider attempt',
        409,
      )
    }
    const attempt = await client.query<{ id: string }>(
      `SELECT id::text
       FROM operations_shopify_order_webhook_attempts
       WHERE organization_id = $1::uuid
         AND command_id = $2::uuid
         AND id = $3::uuid
         AND NOT EXISTS (
           SELECT 1
           FROM operations_shopify_order_webhook_attempts later
           WHERE later.organization_id = $1::uuid
             AND later.command_id = $2::uuid
             AND later.attempt_number >
               operations_shopify_order_webhook_attempts.attempt_number
         )
       FOR SHARE`,
      [input.organizationId, input.commandId, input.attemptId],
    )
    if (!attempt.rows[0]) {
      fail(
        'SHOPIFY_ORDER_WEBHOOK_ATTEMPT_MISMATCH',
        'Shopify webhook provider attempt is not current',
        409,
      )
    }
    await client.query(
      `INSERT INTO operations_shopify_order_webhook_outcomes (
         organization_id, command_id, provider_attempt_id, outcome_state,
         provider_write_count, provider_references, completed_mutations,
         stopped_mutation, stop_classification, result_hash,
         result_snapshot, error_code, completed_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[], $7::jsonb,
         $8::jsonb, $9, $10, $11::jsonb, $12, $13
       )`,
      [
        input.organizationId,
        input.commandId,
        input.attemptId,
        input.outcome,
        input.providerWriteCount,
        [...input.providerReferences],
        JSON.stringify(input.completedMutations),
        input.stoppedMutation === null
          ? null
          : JSON.stringify(input.stoppedMutation),
        input.stopClassification,
        resultHash,
        resultJson,
        input.errorCode,
        input.actorEmail,
      ],
    )
    const completedAt = new Date().toISOString()
    await client.query(
      `UPDATE operations_shopify_order_webhook_commands
       SET status = $3,
           completed_at = $4::timestamptz,
           error_code = $5,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        input.organizationId,
        input.commandId,
        input.outcome,
        completedAt,
        input.errorCode,
      ],
    )
    if (
      (input.outcome === 'succeeded' || input.outcome === 'reconciled')
      && input.readiness?.ready === true
    ) {
      const evidence = readinessConfiguration(input.readiness, {
        accountGlobalId: command.integration_account_global_id,
        credentialGeneration: command.credential_generation,
      })
      const summary = {
        commandId: command.id,
        status: input.outcome,
        providerWriteCount: input.providerWriteCount,
        completedAt,
      }
      const updated = await client.query(
        `UPDATE operations_integration_accounts
         SET configuration = jsonb_set(
               jsonb_set(
                 configuration,
                 '{orderWebhookSubscriptions}',
                 $4::jsonb,
                 true
               ),
               '{orderWebhookReconciliation}',
               $5::jsonb,
               true
             ),
             updated_by = $6,
             updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND global_id = $3
           AND provider = 'shopify'
           AND status = 'active'
           AND commerce_credential_generation = $7
           AND external_account_id = $8
           AND configuration->>'shopDomain' = $9`,
        [
          command.organization_id,
          command.integration_account_id,
          command.integration_account_global_id,
          JSON.stringify(evidence),
          JSON.stringify(summary),
          input.actorEmail,
          command.credential_generation,
          command.external_account_id,
          command.shop_domain,
        ],
      )
      if (updated.rowCount !== 1) {
        fail(
          'SHOPIFY_ORDER_WEBHOOK_BINDING_DRIFT',
          'Shopify account binding changed before readiness could be stored',
          409,
        )
      }
    }
    const finalized = await client.query<CommandRow>(
      `${COMMAND_SELECT}
       WHERE command.organization_id = $1::uuid
         AND command.id = $2::uuid
       LIMIT 1`,
      [input.organizationId, input.commandId],
    )
    return commandState(finalized.rows[0], false)
  })
}

export async function markStaleShopifyOrderWebhookAttemptUnknownInPostgres(input: {
  organizationId: string
  commandId: string
  actorEmail: string
}) {
  return withTransaction(async (client) => {
    const row = await client.query<{
      attempt_id: string
      status: string
      lease_expired: boolean
    }>(
      `SELECT attempt.id::text AS attempt_id, command.status,
         command.processing_lease_expires_at <= clock_timestamp()
           AS lease_expired
       FROM operations_shopify_order_webhook_commands command
       JOIN LATERAL (
         SELECT candidate.id
         FROM operations_shopify_order_webhook_attempts candidate
         WHERE candidate.organization_id = command.organization_id
           AND candidate.command_id = command.id
         ORDER BY candidate.attempt_number DESC
         LIMIT 1
       ) attempt ON true
       WHERE command.organization_id = $1::uuid
         AND command.id = $2::uuid
       FOR UPDATE OF command`,
      [input.organizationId, input.commandId],
    )
    const current = row.rows[0]
    if (!current || current.status !== 'processing' || !current.lease_expired) {
      fail(
        'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_IN_PROGRESS',
        'Shopify webhook reconciliation is still processing',
        409,
      )
    }
    const snapshot = { recovery: 'processing_lease_expired', providerWrites: null }
    const resultJson = JSON.stringify(snapshot)
    await client.query(
      `INSERT INTO operations_shopify_order_webhook_outcomes (
         organization_id, command_id, provider_attempt_id, outcome_state,
         provider_write_count, provider_references, completed_mutations,
         stopped_mutation, stop_classification, result_hash,
         result_snapshot, error_code, completed_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'unknown', NULL, '{}'::text[],
         '[]'::jsonb, NULL, 'ambiguous', $4, $5::jsonb,
         'SHOPIFY_ORDER_WEBHOOK_LOST_RESPONSE', $6
       )`,
      [
        input.organizationId,
        input.commandId,
        current.attempt_id,
        createHash('sha256').update(resultJson).digest('hex'),
        resultJson,
        input.actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_shopify_order_webhook_commands
       SET status = 'unknown', completed_at = clock_timestamp(),
           error_code = 'SHOPIFY_ORDER_WEBHOOK_LOST_RESPONSE',
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, input.commandId],
    )
    return current.attempt_id
  })
}

export async function readShopifyOrderWebhookAttemptIdInPostgres(input: {
  organizationId: string
  commandId: string
}) {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id::text
       FROM operations_shopify_order_webhook_attempts
       WHERE organization_id = $1::uuid AND command_id = $2::uuid
       ORDER BY attempt_number DESC
       LIMIT 1
       FOR SHARE`,
      [input.organizationId, input.commandId],
    )
    return result.rows[0]?.id || null
  })
}
