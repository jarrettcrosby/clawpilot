import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import type {
  CommerceAuthMode,
  CommerceEnvironment,
  CommerceProvider,
  EncryptedCommerceValue,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type TimestampValue = string | Date

type CommerceConnectionRow = {
  id: string
  global_id: string
  organization_id: string
  provider: CommerceProvider
  environment: CommerceEnvironment
  external_account_id: string | null
  display_name: string
  status: 'active' | 'disabled' | 'error'
  configuration: Record<string, unknown>
  commerce_credential_generation: number
  credential_ciphertext: Buffer | null
  credential_iv: Buffer | null
  credential_tag: Buffer | null
  credential_version: number | null
  auth_mode: CommerceAuthMode | null
  credential_identifier_last_four: string | null
  verification_status: 'unverified' | 'verified' | 'failed' | null
  verified_at: TimestampValue | null
  last_error_code: string | null
  webhook_verification_status:
    | 'not_applicable'
    | 'unverified'
    | 'verified'
    | null
  webhook_verified_at: TimestampValue | null
  updated_at: TimestampValue
}

type CommerceCursorRow = {
  integration_account_id: string
  resource: CommerceSyncResource
  provider_cursor: string | null
  high_watermark: TimestampValue | null
  reconciliation_status: 'idle' | 'running' | 'succeeded' | 'failed'
  records_seen: string | number
  records_applied: string | number
  records_held: string | number
  consecutive_failures: number
  last_error_code: string | null
  last_started_at: TimestampValue | null
  last_completed_at: TimestampValue | null
  updated_at: TimestampValue
}

type CommerceEvidenceSummaryRow = {
  integration_account_id: string
  webhook_receipts: string | number
  queued_webhooks: string | number
  dead_letter_webhooks: string | number
  last_webhook_at: TimestampValue | null
  provider_attempts: string | number
  failed_attempts: string | number
  dead_letter_attempts: string | number
  last_attempt_at: TimestampValue | null
}

export type CommerceSyncResource =
  | 'orders'
  | 'products'
  | 'inventory'
  | 'fulfillments'
  | 'returns'
  | 'shipments'

export type CommerceSyncCursorState = {
  resource: CommerceSyncResource
  cursorPresent: boolean
  highWatermark: string | null
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  recordsSeen: number
  recordsApplied: number
  recordsHeld: number
  consecutiveFailures: number
  lastErrorCode: string | null
  lastStartedAt: string | null
  lastCompletedAt: string | null
  updatedAt: string
}

export type CommerceIntegrationAccountState = {
  globalId: string
  provider: CommerceProvider
  environment: CommerceEnvironment
  externalAccountId: string | null
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  credentialVersion: number
  authMode: CommerceAuthMode | null
  credentialIdentifierLastFour: string | null
  verificationStatus: 'unverified' | 'verified' | 'failed'
  verifiedAt: string | null
  lastErrorCode: string | null
  webhookVerificationStatus: 'not_applicable' | 'unverified' | 'verified'
  webhookVerifiedAt: string | null
  configuration: Record<string, unknown>
  syncCursors: CommerceSyncCursorState[]
  evidence: {
    webhookReceipts: number
    queuedWebhooks: number
    deadLetterWebhooks: number
    lastWebhookAt: string | null
    providerAttempts: number
    failedAttempts: number
    deadLetterAttempts: number
    lastAttemptAt: string | null
  }
  updatedAt: string
}

export type CommerceIntegrationsState = {
  organizationId: string
  accounts: CommerceIntegrationAccountState[]
}

export type CommerceRuntimeCredentialRecord = {
  organizationId: string
  integrationAccountId: string
  globalId: string
  provider: CommerceProvider
  environment: CommerceEnvironment
  externalAccountId: string
  status: 'active' | 'disabled' | 'error'
  verificationStatus: 'unverified' | 'verified' | 'failed'
  credentialVersion: number
  authMode: CommerceAuthMode
  configuration: Record<string, unknown>
  encrypted: EncryptedCommerceValue
}

export type FaireOAuthInstallationRecord = {
  organizationId: string
  browserSessionId: string
  actorEmail: string
  stateHash: string
  redirectUrl: string
  displayName: string | null
  requestedScopes: string[]
  applicationIdLastFour: string
  encrypted: EncryptedCommerceValue
  expiresAt: string
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function numberValue(value: string | number | null | undefined) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

const CONNECTION_SELECT = `SELECT
    account.id::text,
    account.global_id,
    account.organization_id::text,
    account.provider,
    account.environment,
    account.external_account_id,
    account.display_name,
    account.status,
    account.configuration,
    account.commerce_credential_generation,
    credential.credential_ciphertext,
    credential.credential_iv,
    credential.credential_tag,
    credential.credential_version,
    credential.auth_mode,
    credential.credential_identifier_last_four,
    credential.verification_status,
    credential.verified_at,
    credential.last_error_code,
    credential.webhook_verification_status,
    credential.webhook_verified_at,
    GREATEST(
      account.updated_at,
      COALESCE(credential.updated_at, account.updated_at)
    ) AS updated_at
  FROM operations_integration_accounts account
  LEFT JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id`

function cursorState(row: CommerceCursorRow): CommerceSyncCursorState {
  return {
    resource: row.resource,
    cursorPresent: Boolean(row.provider_cursor),
    highWatermark: iso(row.high_watermark),
    status: row.reconciliation_status,
    recordsSeen: numberValue(row.records_seen),
    recordsApplied: numberValue(row.records_applied),
    recordsHeld: numberValue(row.records_held),
    consecutiveFailures: row.consecutive_failures,
    lastErrorCode: row.last_error_code,
    lastStartedAt: iso(row.last_started_at),
    lastCompletedAt: iso(row.last_completed_at),
    updatedAt: iso(row.updated_at) as string,
  }
}

function accountState(
  row: CommerceConnectionRow,
  cursors: CommerceSyncCursorState[],
  evidence?: CommerceEvidenceSummaryRow,
): CommerceIntegrationAccountState {
  return {
    globalId: row.global_id,
    provider: row.provider,
    environment: row.environment,
    externalAccountId: row.external_account_id,
    displayName: row.display_name,
    status: row.status,
    configured: Boolean(
      row.credential_ciphertext
      && row.credential_iv
      && row.credential_tag
      && row.credential_version === row.commerce_credential_generation,
    ),
    credentialVersion: row.commerce_credential_generation,
    authMode: row.auth_mode,
    credentialIdentifierLastFour: row.credential_identifier_last_four,
    verificationStatus: row.verification_status || 'unverified',
    verifiedAt: iso(row.verified_at),
    lastErrorCode: row.last_error_code,
    webhookVerificationStatus:
      row.webhook_verification_status || 'not_applicable',
    webhookVerifiedAt: iso(row.webhook_verified_at),
    configuration: row.configuration || {},
    syncCursors: cursors,
    evidence: {
      webhookReceipts: numberValue(evidence?.webhook_receipts),
      queuedWebhooks: numberValue(evidence?.queued_webhooks),
      deadLetterWebhooks: numberValue(evidence?.dead_letter_webhooks),
      lastWebhookAt: iso(evidence?.last_webhook_at),
      providerAttempts: numberValue(evidence?.provider_attempts),
      failedAttempts: numberValue(evidence?.failed_attempts),
      deadLetterAttempts: numberValue(evidence?.dead_letter_attempts),
      lastAttemptAt: iso(evidence?.last_attempt_at),
    },
    updatedAt: iso(row.updated_at) as string,
  }
}

export async function readCommerceIntegrationsStateFromPostgres(
  organizationId: string,
): Promise<CommerceIntegrationsState> {
  await purgeExpiredFaireOAuthInstallationsInPostgres()
  const [connections, cursorRows, evidenceRows] = await Promise.all([
    query<CommerceConnectionRow>(
      `${CONNECTION_SELECT}
       WHERE account.organization_id = $1::uuid
         AND account.integration_type = 'commerce'
         AND account.provider IN ('shopify', 'faire')
       ORDER BY account.provider, account.display_name, account.global_id`,
      [organizationId],
    ),
    query<CommerceCursorRow>(
      `SELECT
         integration_account_id::text,
         resource,
         provider_cursor,
         high_watermark,
         reconciliation_status,
         records_seen,
         records_applied,
         records_held,
         consecutive_failures,
         last_error_code,
         last_started_at,
         last_completed_at,
         updated_at
       FROM operations_commerce_sync_cursors
       WHERE organization_id = $1::uuid
       ORDER BY integration_account_id, resource`,
      [organizationId],
    ),
    query<CommerceEvidenceSummaryRow>(
      `SELECT
         account.id::text AS integration_account_id,
         COALESCE(webhook.receipts, 0) AS webhook_receipts,
         COALESCE(webhook.queued, 0) AS queued_webhooks,
         COALESCE(webhook.dead_letter, 0) AS dead_letter_webhooks,
         webhook.last_received_at AS last_webhook_at,
         COALESCE(attempt.attempts, 0) AS provider_attempts,
         COALESCE(attempt.failed, 0) AS failed_attempts,
         COALESCE(attempt.dead_letter, 0) AS dead_letter_attempts,
         attempt.last_requested_at AS last_attempt_at
       FROM operations_integration_accounts account
       LEFT JOIN LATERAL (
         SELECT
           count(*) AS receipts,
           count(*) FILTER (WHERE state IN ('queued', 'processing')) AS queued,
           count(*) FILTER (WHERE state = 'dead_letter') AS dead_letter,
           max(received_at) AS last_received_at
         FROM operations_commerce_webhook_receipts receipt
         WHERE receipt.organization_id = account.organization_id
           AND receipt.integration_account_id = account.id
       ) webhook ON true
       LEFT JOIN LATERAL (
         SELECT
           count(*) AS attempts,
           count(*) FILTER (WHERE state IN ('failed', 'unknown')) AS failed,
           count(*) FILTER (WHERE state = 'dead_letter') AS dead_letter,
           max(requested_at) AS last_requested_at
         FROM operations_commerce_provider_attempts provider_attempt
         WHERE provider_attempt.organization_id = account.organization_id
           AND provider_attempt.integration_account_id = account.id
       ) attempt ON true
       WHERE account.organization_id = $1::uuid
         AND account.integration_type = 'commerce'
         AND account.provider IN ('shopify', 'faire')`,
      [organizationId],
    ),
  ])

  const cursors = new Map<string, CommerceSyncCursorState[]>()
  for (const row of cursorRows.rows) {
    const list = cursors.get(row.integration_account_id) || []
    list.push(cursorState(row))
    cursors.set(row.integration_account_id, list)
  }
  const evidence = new Map(
    evidenceRows.rows.map((row) => [row.integration_account_id, row]),
  )
  return {
    organizationId,
    accounts: connections.rows.map((row) => accountState(
      row,
      cursors.get(row.id) || [],
      evidence.get(row.id),
    )),
  }
}

export async function purgeExpiredFaireOAuthInstallationsInPostgres() {
  const result = await query(
    `DELETE FROM operations_commerce_oauth_installations
     WHERE expires_at <= now()`,
  )
  return result.rowCount || 0
}

export async function readCommerceRuntimeCredentialFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
}): Promise<CommerceRuntimeCredentialRecord | null> {
  const result = await query<CommerceConnectionRow>(
    `${CONNECTION_SELECT}
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
     LIMIT 1`,
    [input.organizationId, input.accountGlobalId],
  )
  return runtimeCredential(result.rows[0])
}

export async function readCommerceWebhookCredentialFromPostgres(
  accountGlobalId: string,
): Promise<CommerceRuntimeCredentialRecord | null> {
  const result = await query<CommerceConnectionRow>(
    `${CONNECTION_SELECT}
     WHERE account.global_id = $1
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
     LIMIT 1`,
    [accountGlobalId],
  )
  return runtimeCredential(result.rows[0])
}

function runtimeCredential(
  row: CommerceConnectionRow | undefined,
): CommerceRuntimeCredentialRecord | null {
  if (
    !row
    || !row.credential_ciphertext
    || !row.credential_iv
    || !row.credential_tag
    || !row.credential_version
    || row.credential_version !== row.commerce_credential_generation
    || !row.auth_mode
    || !row.external_account_id
  ) return null
  return {
    organizationId: row.organization_id,
    integrationAccountId: row.id,
    globalId: row.global_id,
    provider: row.provider,
    environment: row.environment,
    externalAccountId: row.external_account_id,
    status: row.status,
    verificationStatus: row.verification_status || 'unverified',
    credentialVersion: row.credential_version,
    authMode: row.auth_mode,
    configuration: row.configuration || {},
    encrypted: {
      ciphertext: row.credential_ciphertext,
      iv: row.credential_iv,
      tag: row.credential_tag,
    },
  }
}

async function auditCommerce(
  client: PoolClient,
  input: {
    actorEmail?: string | null
    organizationId: string
    eventType: string
    globalId: string
    provider: CommerceProvider
    environment: CommerceEnvironment
    payload?: Record<string, unknown>
    isSystem?: boolean
  },
) {
  await recordAuditEvent({
    actor: input.actorEmail || null,
    eventType: input.eventType,
    aggregateType: 'commerce_integration',
    aggregateId: input.globalId,
    organizationId: input.organizationId,
    isSystem: input.isSystem,
    payload: {
      provider: input.provider,
      environment: input.environment,
      ...(input.payload || {}),
    },
  }, client)
}

export async function createFaireOAuthInstallationInPostgres(input: {
  organizationId: string
  browserSessionId: string
  actorEmail: string
  stateHash: string
  redirectUrl: string
  displayName: string | null
  requestedScopes: string[]
  applicationIdLastFour: string
  encrypted: EncryptedCommerceValue
  expiresAt: string
}) {
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-oauth:${input.organizationId}:faire:${input.browserSessionId}`,
    )
    await client.query(
      `INSERT INTO operations_commerce_oauth_installations (
         organization_id, provider, browser_session_id, actor_email,
         state_hash, redirect_url, display_name, requested_scopes,
         application_id_last_four, application_credential_ciphertext,
         application_credential_iv, application_credential_tag, expires_at
       ) VALUES (
         $1::uuid, 'faire', $2::uuid, $3, $4, $5, $6, $7::text[],
         $8, $9, $10, $11, $12::timestamptz
       )
       ON CONFLICT (organization_id, provider, browser_session_id)
       DO UPDATE SET
         actor_email = EXCLUDED.actor_email,
         state_hash = EXCLUDED.state_hash,
         redirect_url = EXCLUDED.redirect_url,
         display_name = EXCLUDED.display_name,
         requested_scopes = EXCLUDED.requested_scopes,
         application_id_last_four = EXCLUDED.application_id_last_four,
         application_credential_ciphertext =
           EXCLUDED.application_credential_ciphertext,
         application_credential_iv = EXCLUDED.application_credential_iv,
         application_credential_tag = EXCLUDED.application_credential_tag,
         created_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [
        input.organizationId,
        input.browserSessionId,
        input.actorEmail,
        input.stateHash,
        input.redirectUrl,
        input.displayName,
        input.requestedScopes,
        input.applicationIdLastFour,
        input.encrypted.ciphertext,
        input.encrypted.iv,
        input.encrypted.tag,
        input.expiresAt,
      ],
    )
  })
}

export async function discardFaireOAuthInstallationInPostgres(input: {
  organizationId: string
  browserSessionId: string
  actorEmail: string
  stateHash: string
}) {
  const result = await query<{ id: string }>(
    `DELETE FROM operations_commerce_oauth_installations
     WHERE organization_id = $1::uuid
       AND provider = 'faire'
       AND browser_session_id = $2::uuid
       AND actor_email = $3
       AND state_hash = $4
     RETURNING id::text`,
    [
      input.organizationId,
      input.browserSessionId,
      input.actorEmail,
      input.stateHash,
    ],
  )
  return Boolean(result.rows[0])
}

export async function claimFaireOAuthInstallationInPostgres(input: {
  organizationId: string
  browserSessionId: string
  actorEmail: string
  stateHash: string
}): Promise<FaireOAuthInstallationRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      organization_id: string
      browser_session_id: string
      actor_email: string
      state_hash: string
      redirect_url: string
      display_name: string | null
      requested_scopes: string[]
      application_id_last_four: string
      application_credential_ciphertext: Buffer
      application_credential_iv: Buffer
      application_credential_tag: Buffer
      expires_at: TimestampValue
    }>(
      `DELETE FROM operations_commerce_oauth_installations
       WHERE organization_id = $1::uuid
         AND provider = 'faire'
         AND browser_session_id = $2::uuid
         AND actor_email = $3
         AND state_hash = $4
         AND expires_at > now()
       RETURNING
         organization_id::text,
         browser_session_id::text,
         actor_email,
         state_hash,
         redirect_url,
         display_name,
         requested_scopes,
         application_id_last_four,
         application_credential_ciphertext,
         application_credential_iv,
         application_credential_tag,
         expires_at`,
      [
        input.organizationId,
        input.browserSessionId,
        input.actorEmail,
        input.stateHash,
      ],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      organizationId: row.organization_id,
      browserSessionId: row.browser_session_id,
      actorEmail: row.actor_email,
      stateHash: row.state_hash,
      redirectUrl: row.redirect_url,
      displayName: row.display_name,
      requestedScopes: row.requested_scopes,
      applicationIdLastFour: row.application_id_last_four,
      encrypted: {
        ciphertext: row.application_credential_ciphertext,
        iv: row.application_credential_iv,
        tag: row.application_credential_tag,
      },
      expiresAt: iso(row.expires_at) as string,
    }
  })
}

export async function writeCommerceCredentialInPostgres(input: {
  organizationId: string
  provider: CommerceProvider
  environment: CommerceEnvironment
  externalAccountId: string
  displayName: string
  configuration: Record<string, unknown>
  authMode: CommerceAuthMode
  encrypted: EncryptedCommerceValue
  credentialIdentifierLastFour: string
  webhookVerificationStatus: 'not_applicable' | 'unverified'
  resources: CommerceSyncResource[]
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-credential:${input.organizationId}:${input.provider}:${input.environment}:${input.externalAccountId}`,
    )
    const existingAccount = await client.query<{
      id: string
      global_id: string
      external_account_id: string | null
    }>(
      `SELECT id::text, global_id, external_account_id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND integration_type = 'commerce'
         AND provider = $2
         AND environment = $3
       FOR UPDATE`,
      [input.organizationId, input.provider, input.environment],
    )
    if (
      existingAccount.rows[0]?.external_account_id
      && existingAccount.rows[0].external_account_id
        !== input.externalAccountId
    ) {
      throw new Error(
        'The commerce connection is permanently bound to its original provider account',
      )
    }
    const accountResult = await client.query<{
      id: string
      global_id: string
      commerce_credential_generation: number
    }>(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment,
         external_account_id, display_name, status, configuration,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, 'commerce', $3, $4, $5, 'disabled', $6::jsonb,
         1, $7, $7
       )
       ON CONFLICT (organization_id, integration_type, provider, environment)
       DO UPDATE SET
         external_account_id = COALESCE(
           operations_integration_accounts.external_account_id,
           EXCLUDED.external_account_id
         ),
         display_name = EXCLUDED.display_name,
         status = 'disabled',
         configuration = EXCLUDED.configuration,
         commerce_credential_generation =
           operations_integration_accounts.commerce_credential_generation + 1,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING
         id::text,
         global_id,
         commerce_credential_generation`,
      [
        input.organizationId,
        input.provider,
        input.environment,
        input.externalAccountId,
        input.displayName,
        JSON.stringify(input.configuration),
        input.actorEmail,
      ],
    )
    const account = accountResult.rows[0]
    const previous = await client.query<{
      credential_version: number
      external_account_id: string
    }>(
      `SELECT credential_version, external_account_id
       FROM operations_commerce_credentials
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
       FOR UPDATE`,
      [input.organizationId, account.id],
    )
    if (
      previous.rows[0]
      && previous.rows[0].external_account_id !== input.externalAccountId
    ) {
      throw new Error(
        'Disconnect the existing commerce account before connecting a different provider account',
      )
    }
    const credentialVersion = account.commerce_credential_generation
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id, auth_mode,
         credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, last_error_code,
         webhook_verification_status, webhook_verified_at,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
         'verified', now(), NULL, $10, NULL, $11, $11
       )
       ON CONFLICT (organization_id, integration_account_id)
       DO UPDATE SET
         auth_mode = EXCLUDED.auth_mode,
         external_account_id = EXCLUDED.external_account_id,
         credential_ciphertext = EXCLUDED.credential_ciphertext,
         credential_iv = EXCLUDED.credential_iv,
         credential_tag = EXCLUDED.credential_tag,
         credential_version = EXCLUDED.credential_version,
         credential_identifier_last_four =
           EXCLUDED.credential_identifier_last_four,
         verification_status = 'verified',
         verified_at = now(),
         last_error_code = NULL,
         webhook_verification_status =
           EXCLUDED.webhook_verification_status,
         webhook_verified_at = NULL,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        input.organizationId,
        account.id,
        input.externalAccountId,
        input.authMode,
        input.encrypted.ciphertext,
        input.encrypted.iv,
        input.encrypted.tag,
        credentialVersion,
        input.credentialIdentifierLastFour,
        input.webhookVerificationStatus,
        input.actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET credential_reference = $3, updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        input.organizationId,
        account.id,
        `commerce-credential:${account.id}:v${credentialVersion}`,
        input.actorEmail,
      ],
    )
    for (const resource of input.resources) {
      await client.query(
        `INSERT INTO operations_commerce_sync_cursors (
           organization_id, integration_account_id, resource
         ) VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (
           organization_id, integration_account_id, resource
         ) DO NOTHING`,
        [input.organizationId, account.id, resource],
      )
    }
    await auditCommerce(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: previous.rowCount
        ? 'commerce.credential.rotated'
        : 'commerce.credential.connected',
      globalId: account.global_id,
      provider: input.provider,
      environment: input.environment,
      payload: {
        credentialVersion,
        externalAccountId: input.externalAccountId,
        authMode: input.authMode,
      },
    })
  })
  return readCommerceIntegrationsStateFromPostgres(input.organizationId)
}

export async function markCommerceCredentialVerificationInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  credentialVersion: number
  actorEmail: string
  errorCode: string | null
  configuration?: Record<string, unknown>
  disableIntegration?: boolean
}) {
  await withTransaction(async (client) => {
    const result = await client.query<{
      global_id: string
      provider: CommerceProvider
      environment: CommerceEnvironment
    }>(
      `UPDATE operations_integration_accounts account
       SET status = CASE
             WHEN $3::text IS NOT NULL THEN 'error'
             WHEN $7::boolean THEN 'disabled'
             WHEN account.status = 'error' THEN 'disabled'
             ELSE account.status
           END,
           configuration = CASE
             WHEN $4::jsonb IS NULL THEN account.configuration
             ELSE $4::jsonb
           END,
           updated_by = $5,
           updated_at = now()
       FROM operations_commerce_credentials credential
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.commerce_credential_generation = $6
         AND credential.organization_id = account.organization_id
         AND credential.integration_account_id = account.id
         AND credential.credential_version = $6
       RETURNING account.global_id, account.provider, account.environment`,
      [
        input.organizationId,
        input.accountGlobalId,
        input.errorCode,
        input.configuration ? JSON.stringify(input.configuration) : null,
        input.actorEmail,
        input.credentialVersion,
        input.disableIntegration === true,
      ],
    )
    const row = result.rows[0]
    if (!row) return
    await client.query(
      `UPDATE operations_commerce_credentials credential
       SET verification_status = CASE
             WHEN $3::text IS NULL THEN 'verified'
             ELSE 'failed'
           END,
           verified_at = CASE
             WHEN $3::text IS NULL THEN now()
             ELSE credential.verified_at
           END,
           last_error_code = $3,
           updated_by = $4,
           updated_at = now()
       FROM operations_integration_accounts account
       WHERE credential.organization_id = $1::uuid
         AND account.organization_id = credential.organization_id
         AND account.id = credential.integration_account_id
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.commerce_credential_generation = $5
         AND credential.credential_version = $5`,
      [
        input.organizationId,
        input.accountGlobalId,
        input.errorCode,
        input.actorEmail,
        input.credentialVersion,
      ],
    )
    await auditCommerce(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: input.errorCode
        ? 'commerce.credential.verification_failed'
        : 'commerce.credential.verified',
      globalId: row.global_id,
      provider: row.provider,
      environment: row.environment,
      payload: input.errorCode ? { errorCode: input.errorCode } : {},
    })
    if (input.disableIntegration) {
      await auditCommerce(client, {
        actorEmail: input.actorEmail,
        organizationId: input.organizationId,
        eventType: 'commerce.integration.disabled',
        globalId: row.global_id,
        provider: row.provider,
        environment: row.environment,
        payload: {
          automatic: true,
          reason: 'shopify_scope_profile_incomplete',
        },
      })
    }
  })
  return readCommerceIntegrationsStateFromPostgres(input.organizationId)
}

export async function setCommerceIntegrationEnabledInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  enabled: boolean
  actorEmail: string
}) {
  const updated = await withTransaction(async (client) => {
    const result = await client.query<{
      global_id: string
      provider: CommerceProvider
      environment: CommerceEnvironment
    }>(
      `UPDATE operations_integration_accounts account
       SET status = CASE WHEN $3::boolean THEN 'active' ELSE 'disabled' END,
           updated_by = $4,
           updated_at = now()
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND (
           NOT $3::boolean
           OR EXISTS (
             SELECT 1
             FROM operations_commerce_credentials credential
             WHERE credential.organization_id = account.organization_id
               AND credential.integration_account_id = account.id
               AND credential.credential_version =
                 account.commerce_credential_generation
               AND credential.verification_status = 'verified'
               AND (
                 account.provider <> 'shopify'
                 OR (
                   credential.webhook_verification_status = 'verified'
                   AND account.configuration->>'scopeProfile' =
                     'receipt_evidence_v1'
                   AND account.configuration->'missingScopes' = '[]'::jsonb
                 )
               )
           )
         )
       RETURNING global_id, provider, environment`,
      [
        input.organizationId,
        input.accountGlobalId,
        input.enabled,
        input.actorEmail,
      ],
    )
    const row = result.rows[0]
    if (!row) return false
    await auditCommerce(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: input.enabled
        ? 'commerce.integration.enabled'
        : 'commerce.integration.disabled',
      globalId: row.global_id,
      provider: row.provider,
      environment: row.environment,
    })
    return true
  })
  return {
    updated,
    state: await readCommerceIntegrationsStateFromPostgres(
      input.organizationId,
    ),
  }
}

export async function disconnectCommerceCredentialInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    const account = await client.query<{
      id: string
      global_id: string
      provider: CommerceProvider
      environment: CommerceEnvironment
    }>(
      `SELECT id::text, global_id, provider, environment
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND integration_type = 'commerce'
       FOR UPDATE`,
      [input.organizationId, input.accountGlobalId],
    )
    const row = account.rows[0]
    if (!row) return
    if (row.provider === 'shopify') {
      await client.query(
        `DELETE FROM operations_commerce_order_preview_runs
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [input.organizationId, row.id],
      )
    }
    await client.query(
      `DELETE FROM operations_commerce_credentials
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [input.organizationId, row.id],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'disabled',
           credential_reference = NULL,
           updated_by = $3,
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, row.id, input.actorEmail],
    )
    await auditCommerce(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: 'commerce.credential.disconnected',
      globalId: row.global_id,
      provider: row.provider,
      environment: row.environment,
    })
  })
  return readCommerceIntegrationsStateFromPostgres(input.organizationId)
}

export async function recordCommerceProviderAttemptInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  action: string
  adapterVersion: string
  idempotencyKey: string
  requestHash: string
  redactedRequest: Record<string, unknown>
  redactedResponse: Record<string, unknown>
  state: 'succeeded' | 'failed' | 'unknown' | 'dead_letter'
  providerReference: string | null
  errorCode: string | null
  actorEmail: string
  requestedAt: string
  completedAt: string
}) {
  return withTransaction(async (client) => {
    const result = await client.query<{
      global_id: string
      provider: CommerceProvider
      environment: CommerceEnvironment
    }>(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         idempotency_key, request_hash, redacted_request, redacted_response,
         state, provider_reference, error_code, requested_at, completed_at,
         created_by
       )
       SELECT
         account.organization_id, account.id, $3, $4, $5, $6,
         $7::jsonb, $8::jsonb, $9, $10, $11,
         $12::timestamptz, $13::timestamptz, $14
       FROM operations_integration_accounts account
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
       ON CONFLICT (
         organization_id, integration_account_id, action, idempotency_key,
         attempt_number
       )
       DO NOTHING
       RETURNING global_id`,
      [
        input.organizationId,
        input.accountGlobalId,
        input.action,
        input.adapterVersion,
        input.idempotencyKey,
        input.requestHash,
        JSON.stringify(input.redactedRequest),
        JSON.stringify(input.redactedResponse),
        input.state,
        input.providerReference,
        input.errorCode,
        input.requestedAt,
        input.completedAt,
        input.actorEmail,
      ],
    )
    return result.rows[0]?.global_id || null
  })
}

export async function markShopifyWebhookSecretVerifiedInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
}) {
  await withTransaction(async (client) => {
    const account = await client.query(
      `SELECT id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND commerce_credential_generation = $3
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.runtime.credentialVersion,
      ],
    )
    if (!account.rowCount) return
    const updated = await client.query(
      `UPDATE operations_commerce_credentials credential
       SET webhook_verification_status = 'verified',
           webhook_verified_at = COALESCE(
             credential.webhook_verified_at,
             now()
           ),
           updated_at = now()
       WHERE credential.organization_id = $1::uuid
         AND credential.integration_account_id = $2::uuid
         AND credential.credential_version = $3
         AND credential.auth_mode = 'shopify_client_credentials'
         AND credential.webhook_verification_status = 'unverified'
       RETURNING credential.integration_account_id`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.runtime.credentialVersion,
      ],
    )
    if (!updated.rowCount) return
    await client.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration,
             '{webhookSecretVerified}',
             'true'::jsonb,
             true
           ),
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.runtime.organizationId, input.runtime.integrationAccountId],
    )
    await auditCommerce(client, {
      actorEmail: null,
      organizationId: input.runtime.organizationId,
      eventType: 'commerce.webhook_secret.verified',
      globalId: input.runtime.globalId,
      provider: 'shopify',
      environment: input.runtime.environment,
      isSystem: true,
    })
  })
}

export async function recordShopifyWebhookReceiptInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  providerEventId: string
  topic: string
  sourceDomain: string
  providerApiVersion: string | null
  payloadHash: string
  encryptedPayload: EncryptedCommerceValue
  payloadBytes: number
  providerTriggeredAt: string | null
  scopeAudit?: {
    requestedScopes: string[]
    grantedScopes: string[]
    missingScopes: string[]
    restrictedScopes: string[]
  } | null
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-webhook:${input.runtime.globalId}:${input.providerEventId}`,
    )
    const fence = await client.query<{
      status: 'active' | 'disabled' | 'error'
      commerce_credential_generation: number
      credential_version: number
      verification_status: 'unverified' | 'verified' | 'failed'
      configuration: Record<string, unknown>
    }>(
      `SELECT
         account.status,
         account.commerce_credential_generation,
         credential.credential_version,
         credential.verification_status,
         account.configuration
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       FOR UPDATE OF account, credential`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
      ],
    )
    const current = fence.rows[0]
    if (
      !current
      || current.status === 'error'
      || current.verification_status !== 'verified'
      || current.commerce_credential_generation
        !== input.runtime.credentialVersion
      || current.credential_version !== input.runtime.credentialVersion
    ) {
      throw new Error(
        'Shopify webhook credential generation changed before receipt commit',
      )
    }
    const existing = await client.query<{
      global_id: string
      payload_hash: string
    }>(
      `SELECT global_id, payload_hash
       FROM operations_commerce_webhook_receipts
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND provider_event_id = $3`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.providerEventId,
      ],
    )
    if (existing.rowCount) {
      if (existing.rows[0].payload_hash !== input.payloadHash) {
        throw new Error(
          'Shopify reused a webhook event ID with a different payload',
        )
      }
      return { globalId: existing.rows[0].global_id, duplicate: true }
    }
    const scopeProfileIncomplete = Boolean(
      input.scopeAudit?.missingScopes.length,
    )
    if (input.scopeAudit) {
      await client.query(
        `UPDATE operations_integration_accounts
         SET status = CASE
               WHEN $4::boolean THEN 'disabled'
               ELSE status
             END,
             configuration = $5::jsonb,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND commerce_credential_generation = $3`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          input.runtime.credentialVersion,
          scopeProfileIncomplete,
          JSON.stringify({
            ...(current.configuration || {}),
            scopeProfile: 'receipt_evidence_v1',
            requestedScopes: input.scopeAudit.requestedScopes,
            grantedScopes: input.scopeAudit.grantedScopes,
            missingScopes: input.scopeAudit.missingScopes,
            restrictedScopes: input.scopeAudit.restrictedScopes,
            lastScopeWebhookAt: new Date().toISOString(),
          }),
        ],
      )
      await auditCommerce(client, {
        actorEmail: null,
        organizationId: input.runtime.organizationId,
        eventType: 'commerce.shopify.scopes_updated',
        globalId: input.runtime.globalId,
        provider: 'shopify',
        environment: input.runtime.environment,
        isSystem: true,
        payload: {
          grantedScopes: input.scopeAudit.grantedScopes,
          missingScopes: input.scopeAudit.missingScopes,
          intakeDisabled: scopeProfileIncomplete,
        },
      })
    }
    const effectiveStatus = scopeProfileIncomplete
      ? 'disabled'
      : current.status
    const receiptState = effectiveStatus === 'active' ? 'queued' : 'held'
    const inserted = await client.query<{ global_id: string }>(
      `INSERT INTO operations_commerce_webhook_receipts (
         organization_id, integration_account_id, provider,
         credential_version, provider_event_id, topic, source_domain,
         provider_api_version, payload_hash,
         payload_ciphertext, payload_iv, payload_tag, payload_bytes,
         provider_triggered_at, state
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13::timestamptz, $14
       )
       RETURNING global_id`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.runtime.credentialVersion,
        input.providerEventId,
        input.topic,
        input.sourceDomain,
        input.providerApiVersion,
        input.payloadHash,
        input.encryptedPayload.ciphertext,
        input.encryptedPayload.iv,
        input.encryptedPayload.tag,
        input.payloadBytes,
        input.providerTriggeredAt,
        receiptState,
      ],
    )
    const globalId = inserted.rows[0].global_id
    await auditCommerce(client, {
      actorEmail: null,
      organizationId: input.runtime.organizationId,
      eventType: 'commerce.webhook.received',
      globalId: input.runtime.globalId,
      provider: 'shopify',
      environment: input.runtime.environment,
      isSystem: true,
      payload: {
        receiptGlobalId: globalId,
        topic: input.topic,
        providerEventId: input.providerEventId,
        credentialVersion: input.runtime.credentialVersion,
      },
    })
    return { globalId, duplicate: false }
  })
}
