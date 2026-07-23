import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import type {
  CarrierEnvironment,
  DirectCarrierProvider,
  EncryptedCarrierCredential,
} from '@/lib/integrations/carrierCredentialCrypto'
import { acquireTransactionAdvisoryLock, query, withTransaction } from '@/lib/persistence/postgres'

type TimestampValue = string | Date

type CarrierAccountRow = {
  id: string
  global_id: string
  organization_id: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  display_name: string
  status: 'active' | 'disabled' | 'error'
  configuration: Record<string, unknown>
  credential_ciphertext: Buffer | null
  credential_iv: Buffer | null
  credential_tag: Buffer | null
  credential_version: number | null
  client_id_last_four: string | null
  account_number_last_four: string | null
  verification_status: 'unverified' | 'verified' | 'failed' | null
  verified_at: TimestampValue | null
  last_error_code: string | null
  updated_at: TimestampValue
}

export type CarrierIntegrationAccountState = {
  globalId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  credentialVersion: number
  clientIdLastFour: string | null
  accountNumberLastFour: string | null
  verificationStatus: 'unverified' | 'verified' | 'failed'
  verifiedAt: string | null
  lastErrorCode: string | null
  updatedAt: string
}

export type CarrierIntegrationsState = {
  organizationId: string
  accounts: CarrierIntegrationAccountState[]
}

export type CarrierRuntimeCredentialRecord = {
  organizationId: string
  integrationAccountId: string
  globalId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  status: 'active' | 'disabled' | 'error'
  verificationStatus: 'unverified' | 'verified' | 'failed'
  credentialVersion: number
  encrypted: EncryptedCarrierCredential
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function state(row: CarrierAccountRow): CarrierIntegrationAccountState {
  return {
    globalId: row.global_id,
    provider: row.provider,
    environment: row.environment,
    displayName: row.display_name,
    status: row.status,
    configured: Boolean(row.credential_ciphertext && row.credential_iv && row.credential_tag),
    credentialVersion: row.credential_version || 0,
    clientIdLastFour: row.client_id_last_four,
    accountNumberLastFour: row.account_number_last_four,
    verificationStatus: row.verification_status || 'unverified',
    verifiedAt: iso(row.verified_at),
    lastErrorCode: row.last_error_code,
    updatedAt: iso(row.updated_at) as string,
  }
}

const ACCOUNT_SELECT = `SELECT
    account.id::text,
    account.global_id,
    account.organization_id::text,
    account.provider,
    account.environment,
    account.display_name,
    account.status,
    account.configuration,
    credential.credential_ciphertext,
    credential.credential_iv,
    credential.credential_tag,
    credential.credential_version,
    credential.client_id_last_four,
    credential.account_number_last_four,
    credential.verification_status,
    credential.verified_at,
    credential.last_error_code,
    GREATEST(account.updated_at, COALESCE(credential.updated_at, account.updated_at)) AS updated_at
  FROM operations_integration_accounts account
  LEFT JOIN operations_carrier_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id`

export async function readCarrierIntegrationsStateFromPostgres(
  organizationId: string,
): Promise<CarrierIntegrationsState> {
  const result = await query<CarrierAccountRow>(
    `${ACCOUNT_SELECT}
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'carrier'
       AND account.provider IN ('ups_rest', 'fedex_rest', 'usps_rest')
       AND account.environment IN ('sandbox', 'production')
     ORDER BY account.provider, account.environment`,
    [organizationId],
  )
  return { organizationId, accounts: result.rows.map(state) }
}

export async function readCarrierRuntimeCredentialFromPostgres(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
}): Promise<CarrierRuntimeCredentialRecord | null> {
  const result = await query<CarrierAccountRow>(
    `${ACCOUNT_SELECT}
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'carrier'
       AND account.provider = $2
       AND account.environment = $3
     LIMIT 1`,
    [input.organizationId, input.provider, input.environment],
  )
  const row = result.rows[0]
  if (
    !row
    || !row.credential_ciphertext
    || !row.credential_iv
    || !row.credential_tag
    || !row.credential_version
  ) return null
  return {
    organizationId: row.organization_id,
    integrationAccountId: row.id,
    globalId: row.global_id,
    provider: row.provider,
    environment: row.environment,
    status: row.status,
    verificationStatus: row.verification_status || 'unverified',
    credentialVersion: row.credential_version,
    encrypted: {
      ciphertext: row.credential_ciphertext,
      iv: row.credential_iv,
      tag: row.credential_tag,
    },
  }
}

async function auditCarrier(
  client: PoolClient,
  input: {
    actorEmail: string
    organizationId: string
    eventType: string
    globalId: string
    provider: DirectCarrierProvider
    environment: CarrierEnvironment
    payload?: Record<string, unknown>
  },
) {
  await recordAuditEvent({
    actor: input.actorEmail,
    eventType: input.eventType,
    aggregateType: 'carrier_integration',
    aggregateId: input.globalId,
    organizationId: input.organizationId,
    payload: {
      provider: input.provider,
      environment: input.environment,
      ...(input.payload || {}),
    },
  }, client)
}

export async function writeCarrierCredentialInPostgres(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  displayName: string
  encrypted: EncryptedCarrierCredential
  clientIdLastFour: string
  accountNumberLastFour: string | null
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `carrier-credential:${input.organizationId}:${input.provider}:${input.environment}`,
    )
    const accountResult = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment, display_name,
         status, configuration, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, 'carrier', $3, $4, 'disabled',
         '{"authMode":"oauth_client_credentials","accountOwnerType":"customer_owned"}'::jsonb,
         $5, $5
       )
       ON CONFLICT (organization_id, integration_type, provider, environment)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         configuration = EXCLUDED.configuration,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING id::text, global_id`,
      [input.organizationId, input.provider, input.environment, input.displayName, input.actorEmail],
    )
    const account = accountResult.rows[0]
    const previous = await client.query<{ credential_version: number }>(
      `SELECT credential_version
       FROM operations_carrier_credentials
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid
       FOR UPDATE`,
      [input.organizationId, account.id],
    )
    const version = (previous.rows[0]?.credential_version || 0) + 1
    await client.query(
      `INSERT INTO operations_carrier_credentials (
         organization_id, integration_account_id,
         credential_ciphertext, credential_iv, credential_tag,
         credential_version, client_id_last_four, account_number_last_four,
         verification_status, verified_at, last_error_code, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
         'verified', now(), NULL, $9, $9
       )
       ON CONFLICT (organization_id, integration_account_id)
       DO UPDATE SET
         credential_ciphertext = EXCLUDED.credential_ciphertext,
         credential_iv = EXCLUDED.credential_iv,
         credential_tag = EXCLUDED.credential_tag,
         credential_version = EXCLUDED.credential_version,
         client_id_last_four = EXCLUDED.client_id_last_four,
         account_number_last_four = EXCLUDED.account_number_last_four,
         verification_status = 'verified',
         verified_at = now(),
         last_error_code = NULL,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        input.organizationId,
        account.id,
        input.encrypted.ciphertext,
        input.encrypted.iv,
        input.encrypted.tag,
        version,
        input.clientIdLastFour,
        input.accountNumberLastFour,
        input.actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET credential_reference = $3, updated_at = now(), updated_by = $4
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, account.id, `carrier-credential:${account.id}:v${version}`, input.actorEmail],
    )
    await auditCarrier(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: previous.rowCount ? 'carrier.credential.rotated' : 'carrier.credential.connected',
      globalId: account.global_id,
      provider: input.provider,
      environment: input.environment,
      payload: { credentialVersion: version },
    })
  })
  return readCarrierIntegrationsStateFromPostgres(input.organizationId)
}

export async function markCarrierCredentialVerificationInPostgres(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  actorEmail: string
  errorCode: string | null
}) {
  await withTransaction(async (client) => {
    const result = await client.query<{ global_id: string }>(
      `UPDATE operations_integration_accounts account
       SET status = CASE
             WHEN $4::text IS NOT NULL THEN 'error'
             WHEN account.status = 'error' THEN 'disabled'
             ELSE account.status
           END,
           updated_by = $5,
           updated_at = now()
       FROM operations_carrier_credentials credential
       WHERE account.organization_id = $1::uuid
         AND account.provider = $2
         AND account.environment = $3
         AND account.integration_type = 'carrier'
         AND credential.organization_id = account.organization_id
         AND credential.integration_account_id = account.id
       RETURNING account.global_id`,
      [input.organizationId, input.provider, input.environment, input.errorCode, input.actorEmail],
    )
    if (!result.rowCount) return
    await client.query(
      `UPDATE operations_carrier_credentials credential
       SET verification_status = CASE WHEN $4::text IS NULL THEN 'verified' ELSE 'failed' END,
           verified_at = CASE WHEN $4::text IS NULL THEN now() ELSE verified_at END,
           last_error_code = $4,
           updated_by = $5,
           updated_at = now()
       FROM operations_integration_accounts account
       WHERE credential.organization_id = $1::uuid
         AND account.organization_id = credential.organization_id
         AND account.id = credential.integration_account_id
         AND account.provider = $2
         AND account.environment = $3
         AND account.integration_type = 'carrier'`,
      [input.organizationId, input.provider, input.environment, input.errorCode, input.actorEmail],
    )
    await auditCarrier(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: input.errorCode ? 'carrier.credential.verification_failed' : 'carrier.credential.verified',
      globalId: result.rows[0].global_id,
      provider: input.provider,
      environment: input.environment,
      payload: input.errorCode ? { errorCode: input.errorCode } : {},
    })
  })
  return readCarrierIntegrationsStateFromPostgres(input.organizationId)
}

export async function setCarrierIntegrationEnabledInPostgres(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  enabled: boolean
  actorEmail: string
}) {
  const result = await withTransaction(async (client) => {
    const updated = await client.query<{ global_id: string }>(
      `UPDATE operations_integration_accounts account
       SET status = CASE WHEN $4::boolean THEN 'active' ELSE 'disabled' END,
           updated_by = $5,
           updated_at = now()
       WHERE account.organization_id = $1::uuid
         AND account.provider = $2
         AND account.environment = $3
         AND account.integration_type = 'carrier'
         AND (
           NOT $4::boolean
           OR EXISTS (
             SELECT 1 FROM operations_carrier_credentials credential
             WHERE credential.organization_id = account.organization_id
               AND credential.integration_account_id = account.id
               AND credential.verification_status = 'verified'
           )
         )
       RETURNING global_id`,
      [input.organizationId, input.provider, input.environment, input.enabled, input.actorEmail],
    )
    if (!updated.rowCount) return false
    await auditCarrier(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: input.enabled ? 'carrier.integration.enabled' : 'carrier.integration.disabled',
      globalId: updated.rows[0].global_id,
      provider: input.provider,
      environment: input.environment,
    })
    return true
  })
  return { updated: result, state: await readCarrierIntegrationsStateFromPostgres(input.organizationId) }
}

export async function disconnectCarrierCredentialInPostgres(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    const account = await client.query<{ id: string; global_id: string }>(
      `SELECT id::text, global_id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND provider = $2
         AND environment = $3
         AND integration_type = 'carrier'
       FOR UPDATE`,
      [input.organizationId, input.provider, input.environment],
    )
    if (!account.rowCount) return
    await client.query(
      `DELETE FROM operations_carrier_credentials
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [input.organizationId, account.rows[0].id],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'disabled', credential_reference = NULL, updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, account.rows[0].id, input.actorEmail],
    )
    await auditCarrier(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: 'carrier.credential.disconnected',
      globalId: account.rows[0].global_id,
      provider: input.provider,
      environment: input.environment,
    })
  })
  return readCarrierIntegrationsStateFromPostgres(input.organizationId)
}
