import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import type {
  CarrierAccountAddress,
  CarrierEnvironment,
  DirectCarrierProvider,
  EncryptedCarrierCredential,
} from '@/lib/integrations/carrierCredentialCrypto'
import {
  carrierAccountAddressFingerprint,
  carrierAccountNumberFingerprint,
  encryptCarrierAccountNumber,
} from '@/lib/integrations/carrierCredentialCrypto'
import { acquireTransactionAdvisoryLock, query, withTransaction } from '@/lib/persistence/postgres'

type TimestampValue = string | Date

type CarrierConnectionRow = {
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

type OperationsCarrierAccountRow = {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  display_name: string
  account_number_ciphertext: string
  account_number_iv: string
  account_number_tag: string
  encryption_version: number
  account_number_last_four: string
  account_number_fingerprint: string
  registered_address: CarrierAccountAddress
  registered_address_fingerprint: string
  address_verification: 'unverified' | 'operator_attested' | 'provider_verified'
  allow_sender_billing: boolean
  allow_recipient_billing: boolean
  allow_third_party_billing: boolean
  status: 'needs_configuration' | 'active' | 'disabled'
  updated_at: TimestampValue
}

export type OperationsCarrierAccountState = {
  globalId: string
  displayName: string
  accountNumberLastFour: string
  registeredAddress: CarrierAccountAddress
  addressVerification: 'unverified' | 'operator_attested' | 'provider_verified'
  allowSenderBilling: boolean
  allowRecipientBilling: boolean
  allowThirdPartyBilling: boolean
  status: 'needs_configuration' | 'active' | 'disabled'
  updatedAt: string
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
  carrierAccounts: OperationsCarrierAccountState[]
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

export type CarrierRuntimeAccountRecord = {
  id: string
  globalId: string
  integrationAccountId: string
  displayName: string
  accountNumberLastFour: string
  accountNumberFingerprint: string
  registeredAddress: CarrierAccountAddress
  registeredAddressFingerprint: string
  addressVerification: 'unverified' | 'operator_attested' | 'provider_verified'
  allowSenderBilling: boolean
  allowRecipientBilling: boolean
  allowThirdPartyBilling: boolean
  encrypted: EncryptedCarrierCredential
}

export type CarrierSandboxRateEvidenceInput = {
  organizationId: string
  integrationAccountId: string
  integrationGlobalId: string
  carrierAccountId: string
  carrierAccountGlobalId: string
  billingRelationship: 'sender' | 'recipient' | 'third_party'
  billingSelectionSnapshot: Record<string, unknown>
  provider: DirectCarrierProvider
  credentialVersion: number
  adapterVersion: string
  requestHash: string
  redactedRequest: Record<string, unknown>
  redactedResponse: Record<string, unknown>
  status: 'succeeded' | 'failed'
  providerReference: string | null
  errorCode: string | null
  actorEmail: string
  requestedAt: string
  completedAt: string
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function accountState(row: OperationsCarrierAccountRow): OperationsCarrierAccountState {
  return {
    globalId: row.global_id,
    displayName: row.display_name,
    accountNumberLastFour: row.account_number_last_four,
    registeredAddress: row.registered_address,
    addressVerification: row.address_verification,
    allowSenderBilling: row.allow_sender_billing,
    allowRecipientBilling: row.allow_recipient_billing,
    allowThirdPartyBilling: row.allow_third_party_billing,
    status: row.status,
    updatedAt: iso(row.updated_at) as string,
  }
}

function state(
  row: CarrierConnectionRow,
  carrierAccounts: OperationsCarrierAccountState[],
): CarrierIntegrationAccountState {
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
    carrierAccounts,
  }
}

const CONNECTION_SELECT = `SELECT
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
  const [connections, carrierAccounts] = await Promise.all([
    query<CarrierConnectionRow>(
      `${CONNECTION_SELECT}
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'carrier'
       AND account.provider IN ('ups_rest', 'fedex_rest', 'usps_rest')
       AND account.environment IN ('sandbox', 'production')
     ORDER BY account.provider, account.environment`,
      [organizationId],
    ),
    query<OperationsCarrierAccountRow>(
      `SELECT
         carrier_account.id::text,
         carrier_account.global_id,
         carrier_account.organization_id::text,
         carrier_account.integration_account_id::text,
         connection.provider,
         connection.environment,
         carrier_account.display_name,
         carrier_account.account_number_ciphertext,
         carrier_account.account_number_iv,
         carrier_account.account_number_tag,
         carrier_account.encryption_version,
         carrier_account.account_number_last_four,
         carrier_account.account_number_fingerprint,
         carrier_account.registered_address,
         carrier_account.registered_address_fingerprint,
         carrier_account.address_verification,
         carrier_account.allow_sender_billing,
         carrier_account.allow_recipient_billing,
         carrier_account.allow_third_party_billing,
         carrier_account.status,
         carrier_account.updated_at
       FROM operations_carrier_accounts carrier_account
       JOIN operations_integration_accounts connection
         ON connection.organization_id = carrier_account.organization_id
        AND connection.id = carrier_account.integration_account_id
       WHERE carrier_account.organization_id = $1::uuid
       ORDER BY connection.provider, connection.environment,
                carrier_account.display_name, carrier_account.global_id`,
      [organizationId],
    ),
  ])
  const nested = new Map<string, OperationsCarrierAccountState[]>()
  for (const row of carrierAccounts.rows) {
    const list = nested.get(row.integration_account_id) || []
    list.push(accountState(row))
    nested.set(row.integration_account_id, list)
  }
  return {
    organizationId,
    accounts: connections.rows.map((row) => state(row, nested.get(row.id) || [])),
  }
}

export async function readCarrierRuntimeCredentialFromPostgres(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
}): Promise<CarrierRuntimeCredentialRecord | null> {
  const result = await query<CarrierConnectionRow>(
    `${CONNECTION_SELECT}
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

export async function recordCarrierCredentialRevealInPostgres(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  actorEmail: string
  credentialVersion: number
}) {
  await withTransaction(async (client) => {
    const result = await client.query<{
      global_id: string
      credential_version: number
    }>(
      `SELECT account.global_id, credential.credential_version
       FROM operations_integration_accounts account
       JOIN operations_carrier_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.integration_type = 'carrier'
         AND account.provider = $2
         AND account.environment = $3
       FOR SHARE`,
      [input.organizationId, input.provider, input.environment],
    )
    const row = result.rows[0]
    if (!row || row.credential_version !== input.credentialVersion) {
      throw new Error('Carrier credentials are not configured')
    }
    await auditCarrier(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: 'carrier.credential.revealed',
      globalId: row.global_id,
      provider: input.provider,
      environment: input.environment,
      payload: { credentialVersion: row.credential_version },
    })
  })
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

type CarrierAccountWriteInput = {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  displayName: string
  accountNumber: string | null
  registeredAddress: CarrierAccountAddress
  allowSenderBilling: boolean
  allowRecipientBilling: boolean
  allowThirdPartyBilling: boolean
  actorEmail: string
}

function encryptedText(value: Buffer) {
  return value.toString('base64')
}

function encryptedBuffer(value: string) {
  return Buffer.from(value, 'base64')
}

function carrierAccountPersistenceError(error: unknown): never {
  const code = (error as { code?: string } | null)?.code
  if (code === '23505') {
    throw new Error('Carrier account number is already configured for this provider connection')
  }
  if (code === '23503') {
    throw new Error('Carrier account is in use and cannot be deleted')
  }
  throw error
}

async function lockedCarrierConnection(
  client: PoolClient,
  input: Pick<CarrierAccountWriteInput, 'organizationId' | 'provider' | 'environment'>,
) {
  const result = await client.query<{ id: string; global_id: string }>(
    `SELECT account.id::text, account.global_id
     FROM operations_integration_accounts account
     JOIN operations_carrier_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.provider = $2
       AND account.environment = $3
       AND account.integration_type = 'carrier'
     FOR UPDATE OF account`,
    [input.organizationId, input.provider, input.environment],
  )
  if (!result.rowCount) {
    throw new Error('Carrier credentials must be configured before adding billing accounts')
  }
  return result.rows[0]
}

export async function createCarrierAccountInPostgres(input: CarrierAccountWriteInput) {
  try {
    await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `carrier-account:${input.organizationId}:${input.provider}:${input.environment}`,
      )
      const connection = await lockedCarrierConnection(client, input)
      const globalIdResult = await client.query<{ global_id: string }>(
        `SELECT allocate_global_reference('gac') AS global_id`,
      )
      const globalId = globalIdResult.rows[0].global_id
      const encrypted = encryptCarrierAccountNumber(
        input.accountNumber,
        input.organizationId,
        input.provider,
        input.environment,
        globalId,
      )
      await client.query(
        `INSERT INTO operations_carrier_accounts (
           global_id, organization_id, integration_account_id, display_name,
           account_number_ciphertext, account_number_iv, account_number_tag,
           encryption_version, account_number_last_four, account_number_fingerprint,
           registered_address, registered_address_fingerprint,
           address_verification, allow_sender_billing, allow_recipient_billing,
           allow_third_party_billing, status, created_by, updated_by
         ) VALUES (
           $1, $2::uuid, $3::uuid, $4,
           $5, $6, $7, 1, $8, $9,
           $10::jsonb, $11, 'operator_attested', $12, $13, $14,
           'active', $15, $15
         )`,
        [
          globalId,
          input.organizationId,
          connection.id,
          input.displayName,
          encryptedText(encrypted.ciphertext),
          encryptedText(encrypted.iv),
          encryptedText(encrypted.tag),
          input.accountNumber?.slice(-4),
          carrierAccountNumberFingerprint(
            input.organizationId,
            input.provider,
            input.environment,
            input.accountNumber,
          ),
          JSON.stringify(input.registeredAddress),
          carrierAccountAddressFingerprint(input.registeredAddress),
          input.allowSenderBilling,
          input.allowRecipientBilling,
          input.allowThirdPartyBilling,
          input.actorEmail,
        ],
      )
      await auditCarrier(client, {
        actorEmail: input.actorEmail,
        organizationId: input.organizationId,
        eventType: 'carrier.account.created',
        globalId,
        provider: input.provider,
        environment: input.environment,
        payload: { integrationGlobalId: connection.global_id },
      })
    })
  } catch (error) {
    carrierAccountPersistenceError(error)
  }
  return readCarrierIntegrationsStateFromPostgres(input.organizationId)
}

export async function updateCarrierAccountInPostgres(
  input: CarrierAccountWriteInput & { carrierAccountGlobalId: string },
) {
  try {
    await withTransaction(async (client) => {
      const existing = await client.query<{
        id: string
        global_id: string
        integration_account_id: string
      }>(
        `SELECT carrier_account.id::text, carrier_account.global_id,
                carrier_account.integration_account_id::text
         FROM operations_carrier_accounts carrier_account
         JOIN operations_integration_accounts connection
           ON connection.organization_id = carrier_account.organization_id
          AND connection.id = carrier_account.integration_account_id
         WHERE carrier_account.organization_id = $1::uuid
           AND carrier_account.global_id = $2
           AND connection.provider = $3
           AND connection.environment = $4
           AND connection.integration_type = 'carrier'
         FOR UPDATE OF carrier_account`,
        [input.organizationId, input.carrierAccountGlobalId, input.provider, input.environment],
      )
      if (!existing.rowCount) throw new Error('Carrier account was not found')
      const account = existing.rows[0]
      const encrypted = input.accountNumber
        ? encryptCarrierAccountNumber(
            input.accountNumber,
            input.organizationId,
            input.provider,
            input.environment,
            account.global_id,
          )
        : null
      await client.query(
        `UPDATE operations_carrier_accounts
         SET display_name = $3,
             account_number_ciphertext = COALESCE($4, account_number_ciphertext),
             account_number_iv = COALESCE($5, account_number_iv),
             account_number_tag = COALESCE($6, account_number_tag),
             encryption_version = CASE WHEN $4::text IS NULL
               THEN encryption_version ELSE encryption_version + 1 END,
             account_number_last_four = COALESCE($7, account_number_last_four),
             account_number_fingerprint = COALESCE($8, account_number_fingerprint),
             registered_address = $9::jsonb,
             registered_address_fingerprint = $10,
             address_verification = CASE
               WHEN registered_address_fingerprint = $10 THEN address_verification
               ELSE 'operator_attested'
             END,
             allow_sender_billing = $11,
             allow_recipient_billing = $12,
             allow_third_party_billing = $13,
             updated_by = $14,
             updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [
          input.organizationId,
          account.id,
          input.displayName,
          encrypted ? encryptedText(encrypted.ciphertext) : null,
          encrypted ? encryptedText(encrypted.iv) : null,
          encrypted ? encryptedText(encrypted.tag) : null,
          input.accountNumber?.slice(-4) || null,
          input.accountNumber
            ? carrierAccountNumberFingerprint(
                input.organizationId,
                input.provider,
                input.environment,
                input.accountNumber,
              )
            : null,
          JSON.stringify(input.registeredAddress),
          carrierAccountAddressFingerprint(input.registeredAddress),
          input.allowSenderBilling,
          input.allowRecipientBilling,
          input.allowThirdPartyBilling,
          input.actorEmail,
        ],
      )
      await auditCarrier(client, {
        actorEmail: input.actorEmail,
        organizationId: input.organizationId,
        eventType: 'carrier.account.updated',
        globalId: account.global_id,
        provider: input.provider,
        environment: input.environment,
        payload: { accountNumberRotated: Boolean(input.accountNumber) },
      })
    })
  } catch (error) {
    carrierAccountPersistenceError(error)
  }
  return readCarrierIntegrationsStateFromPostgres(input.organizationId)
}

export async function setCarrierAccountStatusInPostgres(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  carrierAccountGlobalId: string
  status: 'active' | 'disabled'
  actorEmail: string
}) {
  const updated = await withTransaction(async (client) => {
    const result = await client.query<{ global_id: string }>(
      `UPDATE operations_carrier_accounts carrier_account
       SET status = $5, updated_by = $6, updated_at = now()
       FROM operations_integration_accounts connection
       WHERE carrier_account.organization_id = $1::uuid
         AND carrier_account.global_id = $2
         AND connection.organization_id = carrier_account.organization_id
         AND connection.id = carrier_account.integration_account_id
         AND connection.provider = $3
         AND connection.environment = $4
         AND connection.integration_type = 'carrier'
       RETURNING carrier_account.global_id`,
      [
        input.organizationId,
        input.carrierAccountGlobalId,
        input.provider,
        input.environment,
        input.status,
        input.actorEmail,
      ],
    )
    if (!result.rowCount) return false
    await auditCarrier(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: input.status === 'active' ? 'carrier.account.enabled' : 'carrier.account.disabled',
      globalId: result.rows[0].global_id,
      provider: input.provider,
      environment: input.environment,
    })
    return true
  })
  if (!updated) throw new Error('Carrier account was not found')
  return readCarrierIntegrationsStateFromPostgres(input.organizationId)
}

export async function deleteCarrierAccountInPostgres(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  carrierAccountGlobalId: string
  actorEmail: string
}) {
  try {
    await withTransaction(async (client) => {
      const deleted = await client.query<{ global_id: string }>(
        `DELETE FROM operations_carrier_accounts carrier_account
         USING operations_integration_accounts connection
         WHERE carrier_account.organization_id = $1::uuid
           AND carrier_account.global_id = $2
           AND connection.organization_id = carrier_account.organization_id
           AND connection.id = carrier_account.integration_account_id
           AND connection.provider = $3
           AND connection.environment = $4
           AND connection.integration_type = 'carrier'
         RETURNING carrier_account.global_id`,
        [input.organizationId, input.carrierAccountGlobalId, input.provider, input.environment],
      )
      if (!deleted.rowCount) throw new Error('Carrier account was not found')
      await client.query(
        `UPDATE crm_reference_registry
         SET status = 'retired', retired_at = COALESCE(retired_at, now())
         WHERE reference_code = $1`,
        [deleted.rows[0].global_id],
      )
      await auditCarrier(client, {
        actorEmail: input.actorEmail,
        organizationId: input.organizationId,
        eventType: 'carrier.account.deleted',
        globalId: deleted.rows[0].global_id,
        provider: input.provider,
        environment: input.environment,
      })
    })
  } catch (error) {
    carrierAccountPersistenceError(error)
  }
  return readCarrierIntegrationsStateFromPostgres(input.organizationId)
}

export async function readActiveCarrierAccountsFromPostgres(input: {
  organizationId: string
  integrationAccountId: string
}): Promise<CarrierRuntimeAccountRecord[]> {
  const result = await query<OperationsCarrierAccountRow>(
    `SELECT
       carrier_account.id::text,
       carrier_account.global_id,
       carrier_account.organization_id::text,
       carrier_account.integration_account_id::text,
       connection.provider,
       connection.environment,
       carrier_account.display_name,
       carrier_account.account_number_ciphertext,
       carrier_account.account_number_iv,
       carrier_account.account_number_tag,
       carrier_account.encryption_version,
       carrier_account.account_number_last_four,
       carrier_account.account_number_fingerprint,
       carrier_account.registered_address,
       carrier_account.registered_address_fingerprint,
       carrier_account.address_verification,
       carrier_account.allow_sender_billing,
       carrier_account.allow_recipient_billing,
       carrier_account.allow_third_party_billing,
       carrier_account.status,
       carrier_account.updated_at
     FROM operations_carrier_accounts carrier_account
     JOIN operations_integration_accounts connection
       ON connection.organization_id = carrier_account.organization_id
      AND connection.id = carrier_account.integration_account_id
     WHERE carrier_account.organization_id = $1::uuid
       AND carrier_account.integration_account_id = $2::uuid
       AND carrier_account.status = 'active'
     ORDER BY carrier_account.display_name, carrier_account.global_id`,
    [input.organizationId, input.integrationAccountId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    globalId: row.global_id,
    integrationAccountId: row.integration_account_id,
    displayName: row.display_name,
    accountNumberLastFour: row.account_number_last_four,
    accountNumberFingerprint: row.account_number_fingerprint,
    registeredAddress: row.registered_address,
    registeredAddressFingerprint: row.registered_address_fingerprint,
    addressVerification: row.address_verification,
    allowSenderBilling: row.allow_sender_billing,
    allowRecipientBilling: row.allow_recipient_billing,
    allowThirdPartyBilling: row.allow_third_party_billing,
    encrypted: {
      ciphertext: encryptedBuffer(row.account_number_ciphertext),
      iv: encryptedBuffer(row.account_number_iv),
      tag: encryptedBuffer(row.account_number_tag),
    },
  }))
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

export async function writeCarrierSandboxRateEvidenceInPostgres(
  input: CarrierSandboxRateEvidenceInput,
) {
  return withTransaction(async (client) => {
    const result = await client.query<{ global_id: string }>(
      `INSERT INTO operations_carrier_rate_requests (
         organization_id, integration_account_id, carrier_account_id,
         provider, environment, purpose, adapter_version, credential_version, request_hash,
         billing_relationship, billing_selection_snapshot,
         redacted_request, redacted_response, status, provider_reference,
         error_code, actor_email, requested_at, completed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'sandbox',
         'sandbox_rate_test', $5, $6, $7, $8, $9::jsonb,
         $10::jsonb, $11::jsonb, $12, $13,
         $14, $15, $16::timestamptz, $17::timestamptz
       )
       RETURNING global_id`,
      [
        input.organizationId,
        input.integrationAccountId,
        input.carrierAccountId,
        input.provider,
        input.adapterVersion,
        input.credentialVersion,
        input.requestHash,
        input.billingRelationship,
        JSON.stringify(input.billingSelectionSnapshot),
        JSON.stringify(input.redactedRequest),
        JSON.stringify(input.redactedResponse),
        input.status,
        input.providerReference,
        input.errorCode,
        input.actorEmail,
        input.requestedAt,
        input.completedAt,
      ],
    )
    const globalId = result.rows[0].global_id
    await auditCarrier(client, {
      actorEmail: input.actorEmail,
      organizationId: input.organizationId,
      eventType: input.status === 'succeeded'
        ? 'carrier.sandbox_rate.succeeded'
        : 'carrier.sandbox_rate.failed',
      globalId: input.integrationGlobalId,
      provider: input.provider,
      environment: 'sandbox',
      payload: {
        evidenceGlobalId: globalId,
        carrierAccountGlobalId: input.carrierAccountGlobalId,
        billingRelationship: input.billingRelationship,
        adapterVersion: input.adapterVersion,
        credentialVersion: input.credentialVersion,
        requestHash: input.requestHash,
        rateCount: Array.isArray(input.redactedResponse.rates)
          ? input.redactedResponse.rates.length
          : 0,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      },
    })
    return globalId
  })
}
