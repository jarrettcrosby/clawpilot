import { recordAuditEvent } from '@/lib/auditWriter'
import {
  brokeredTransportCredentialCommandRequestHash,
  brokeredTransportCredentialIdentifierLastFour,
  decryptBrokeredTransportCredential,
  encryptBrokeredTransportCredential,
  normalizeBrokeredTransportCredential,
  normalizeBrokeredTransportEnvironment,
  normalizeBrokeredTransportProvider,
  type BrokeredTransportCredential,
  type BrokeredTransportEnvironment,
  type BrokeredTransportProvider,
  type EncryptedBrokeredTransportCredential,
  type RlCarriersCredential,
  type WwexSpeedshipCredential,
} from '@/lib/integrations/brokeredTransportCredentialCrypto'
import {
  RlCarriersFreightClientError,
  verifyRlCarriersRuntimeCredential,
} from '@/lib/integrations/rlCarriersFreightClient'
import {
  verifyWwexSpeedshipRuntimeCredential,
  WwexSpeedshipClientError,
} from '@/lib/integrations/wwexSpeedshipClient'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

export class BrokeredTransportIntegrationError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'BrokeredTransportIntegrationError'
    this.status = status
    this.code = code
  }
}

type TimestampValue = string | Date

type ConnectionRow = {
  id: string
  global_id: string
  provider: BrokeredTransportProvider
  environment: BrokeredTransportEnvironment
  display_name: string
  status: 'active' | 'disabled' | 'error'
  configuration: Record<string, unknown>
  credential_ciphertext: Buffer | null
  credential_iv: Buffer | null
  credential_tag: Buffer | null
  credential_version: number | null
  credential_fingerprint: string | null
  credential_kind: 'oauth_client_credentials' | 'api_key' | null
  credential_identifier_last_four: string | null
  verification_status: 'unverified' | 'verified' | 'failed' | null
  verified_at: TimestampValue | null
  last_error_code: string | null
  updated_at: TimestampValue
}

export type BrokeredTransportIntegrationState = {
  globalId: string
  provider: BrokeredTransportProvider
  providerLabel: 'Worldwide Express' | 'R+L Carriers'
  environment: BrokeredTransportEnvironment
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  credentialVersion: number
  credentialKind: 'oauth_client_credentials' | 'api_key' | null
  credentialIdentifierLastFour: string | null
  verificationStatus: 'unverified' | 'verified' | 'failed'
  verifiedAt: string | null
  lastErrorCode: string | null
  allowedCapabilities: string[]
  supportedTransportModes: Array<'small_parcel' | 'ltl'>
  ratingActivation: {
    smallParcel: boolean
    ltl: boolean
  }
  tenderActivation: {
    smallParcel: boolean
    ltl: boolean
  }
  activationBlockers: string[]
  tenderActivationBlockers: string[]
  updatedAt: string
}

type BrokeredTransportRuntimeCredentialBase = {
  organizationId: string
  integrationAccountId: string
  integrationGlobalId: string
  credentialVersion: number
  credentialFingerprint: string
}

export type BrokeredTransportRuntimeCredential =
  | (BrokeredTransportRuntimeCredentialBase & {
      provider: 'wwex_speedship'
      environment: BrokeredTransportEnvironment
      credential: WwexSpeedshipCredential
    })
  | (BrokeredTransportRuntimeCredentialBase & {
      provider: 'rl_carriers'
      environment: 'production'
      credential: RlCarriersCredential
    })

const PROVIDER_CAPABILITIES: Record<BrokeredTransportProvider, string[]> = {
  wwex_speedship: [
    'small_parcel_rate',
    'small_parcel_pickup',
    'small_parcel_tender',
    'ltl_rate',
    'ltl_tender',
  ],
  rl_carriers: [
    'ltl_rate',
    'ltl_tender',
    'ltl_bol',
    'ltl_pickup',
  ],
}

function connectionSelect(credentialJoin: 'LEFT JOIN' | 'INNER JOIN') {
  return `SELECT
    account.id::text,
    account.global_id,
    account.provider,
    account.environment,
    account.display_name,
    account.status,
    account.configuration,
    credential.credential_ciphertext,
    credential.credential_iv,
    credential.credential_tag,
    credential.credential_version,
    credential.credential_fingerprint,
    credential.credential_kind,
    credential.credential_identifier_last_four,
    credential.verification_status,
    credential.verified_at,
    credential.last_error_code,
    GREATEST(
      account.updated_at,
      COALESCE(credential.updated_at, account.updated_at)
    ) AS updated_at
  FROM operations_integration_accounts account
  ${credentialJoin} operations_carrier_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id`
}

const CONNECTION_SELECT = connectionSelect('LEFT JOIN')
const LOCKED_CREDENTIAL_CONNECTION_SELECT = connectionSelect('INNER JOIN')

function providerLabel(provider: BrokeredTransportProvider) {
  return provider === 'wwex_speedship'
    ? 'Worldwide Express' as const
    : 'R+L Carriers' as const
}

function iso(value: TimestampValue | null) {
  return value ? new Date(value).toISOString() : null
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function modeActivation(
  configuration: Record<string, unknown>,
  mode: 'small_parcel' | 'ltl',
) {
  const activation = object(configuration.transportActivation)
  const selected = object(activation[mode])
  return {
    ratingEnabled: selected.ratingEnabled === true,
    tenderEnabled: selected.tenderEnabled === true,
  }
}

function connectionState(row: ConnectionRow): BrokeredTransportIntegrationState {
  const configured = Boolean(
    row.credential_ciphertext
    && row.credential_iv
    && row.credential_tag
    && row.credential_version,
  )
  const allowedCapabilities = strings(row.configuration.allowedCapabilities)
    .filter((value) => PROVIDER_CAPABILITIES[row.provider].includes(value))
  const configuredBlockers = strings(row.configuration.activationBlockers)
  const activationBlockers = [
    ...(!configured ? ['credentials_required'] : []),
    ...(configured && row.verification_status !== 'verified'
      ? ['credential_verification_required']
      : []),
    ...configuredBlockers,
  ]
  const smallParcel = modeActivation(row.configuration, 'small_parcel')
  const ltl = modeActivation(row.configuration, 'ltl')
  const activationEffective = configured
    && row.status === 'active'
    && row.verification_status === 'verified'
    && row.configuration.activationStatus === 'active'
    && activationBlockers.length === 0
  return {
    globalId: row.global_id,
    provider: row.provider,
    providerLabel: providerLabel(row.provider),
    environment: row.environment,
    displayName: row.display_name,
    status: row.status,
    configured,
    credentialVersion: row.credential_version || 0,
    credentialKind: row.credential_kind,
    credentialIdentifierLastFour: row.credential_identifier_last_four,
    verificationStatus: row.verification_status || 'unverified',
    verifiedAt: iso(row.verified_at),
    lastErrorCode: row.last_error_code,
    allowedCapabilities,
    supportedTransportModes: row.provider === 'wwex_speedship'
      ? ['small_parcel', 'ltl']
      : ['ltl'],
    ratingActivation: {
      smallParcel: activationEffective && smallParcel.ratingEnabled,
      ltl: activationEffective && ltl.ratingEnabled,
    },
    tenderActivation: {
      smallParcel: activationEffective && smallParcel.tenderEnabled,
      ltl: activationEffective && ltl.tenderEnabled,
    },
    activationBlockers: [...new Set(activationBlockers)],
    tenderActivationBlockers: strings(
      row.configuration.tenderActivationBlockers,
    ),
    updatedAt: iso(row.updated_at) as string,
  }
}

function normalizeDisplayName(value: unknown) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ')
  if (
    normalized.length < 2
    || normalized.length > 120
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new BrokeredTransportIntegrationError(
      'Transport connection name must be 2-120 characters',
      400,
      'TRANSPORT_DISPLAY_NAME_INVALID',
    )
  }
  return normalized
}

function normalizeCredentialCommandIdempotencyKey(value: unknown) {
  if (typeof value !== 'string') {
    throw new BrokeredTransportIntegrationError(
      'A stable Idempotency-Key is required to store a transport credential',
      400,
      'TRANSPORT_IDEMPOTENCY_KEY_REQUIRED',
    )
  }
  const normalized = value.trim()
  if (
    normalized.length < 16
    || normalized.length > 200
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new BrokeredTransportIntegrationError(
      'The transport credential Idempotency-Key is invalid',
      400,
      'TRANSPORT_IDEMPOTENCY_KEY_INVALID',
    )
  }
  return normalized
}

function activationBlockers(
  provider: BrokeredTransportProvider,
  environment: BrokeredTransportEnvironment,
) {
  if (provider === 'wwex_speedship' && environment === 'sandbox') {
    return [
      'credential_verification_required',
    ]
  }
  if (provider === 'wwex_speedship') {
    return [
      'credential_verification_required',
      'provider_platform_review_required',
      'production_endpoint_configuration_required',
      'billing_account_configuration_required',
      'production_certification_required',
      'cancel_contract_required',
    ]
  }
  return [
    'credential_verification_required',
  ]
}

function tenderActivationBlockers(
  provider: BrokeredTransportProvider,
  environment: BrokeredTransportEnvironment,
) {
  if (provider === 'wwex_speedship' && environment === 'sandbox') {
    return [
      'one_off_tender_orchestration_required',
      'billing_account_configuration_required',
      'package_code_confirmation_required',
      'document_reconciliation_required',
      'cancel_contract_required',
    ]
  }
  if (provider === 'wwex_speedship') {
    return [
      'one_off_tender_orchestration_required',
      'provider_platform_review_required',
      'production_endpoint_configuration_required',
      'billing_account_configuration_required',
      'production_certification_required',
      'document_reconciliation_required',
      'cancel_contract_required',
    ]
  }
  return [
    'one_off_tender_orchestration_required',
    'billing_account_configuration_required',
    'account_tariff_verification_required',
    'bol_pickup_certification_required',
    'document_reconciliation_required',
    'shipment_void_unsupported',
  ]
}

export async function getBrokeredTransportIntegrations(
  organizationId: string,
) {
  const result = await query<ConnectionRow>(
    `${CONNECTION_SELECT}
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'carrier'
       AND account.provider IN ('wwex_speedship', 'rl_carriers')
       AND account.environment IN ('sandbox', 'production')
     ORDER BY account.provider, account.environment`,
    [organizationId],
  )
  return {
    organizationId,
    accounts: result.rows.map(connectionState),
  }
}

export async function updateBrokeredTransportCredential(input: {
  organizationId: string
  provider: unknown
  environment: unknown
  displayName: unknown
  credential: unknown
  idempotencyKey: unknown
  actorEmail: string
}) {
  let provider: BrokeredTransportProvider
  let environment: BrokeredTransportEnvironment
  let credential: BrokeredTransportCredential
  try {
    provider = normalizeBrokeredTransportProvider(input.provider)
    environment = normalizeBrokeredTransportEnvironment(provider, input.environment)
    credential = normalizeBrokeredTransportCredential(provider, input.credential)
  } catch (error) {
    throw new BrokeredTransportIntegrationError(
      error instanceof Error ? error.message : 'Transport credential is invalid',
      400,
      'TRANSPORT_CREDENTIAL_INVALID',
    )
  }
  const displayName = normalizeDisplayName(input.displayName)
  const idempotencyKey = normalizeCredentialCommandIdempotencyKey(
    input.idempotencyKey,
  )
  const commandRequestHash = brokeredTransportCredentialCommandRequestHash(
    input.organizationId,
    provider,
    environment,
    displayName,
    credential,
  )
  const identifierLastFour = brokeredTransportCredentialIdentifierLastFour(
    provider,
    credential,
  )
  const credentialKind = credential.authKind
  const configuration = {
    authMode: credentialKind,
    accountOwnerType: 'customer_owned',
    transportModes: provider === 'wwex_speedship'
      ? ['small_parcel', 'ltl']
      : ['ltl'],
    allowedCapabilities: [],
    supportedCapabilities: PROVIDER_CAPABILITIES[provider],
    transportActivation: {
      small_parcel: { ratingEnabled: false, tenderEnabled: false },
      ltl: { ratingEnabled: false, tenderEnabled: false },
    },
    activationStatus: 'pre_activation',
    activationBlockers: activationBlockers(provider, environment),
    tenderActivationBlockers: tenderActivationBlockers(provider, environment),
    credentialRevealAllowed: false,
  }
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `brokered-transport:${input.organizationId}:${provider}:${environment}`,
    )
    const priorCommand = await client.query<{
      id: string
      request_hash: string
      status: 'processing' | 'succeeded' | 'failed'
    }>(
      `SELECT id::text, request_hash, status
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = 'update_brokered_transport_credential'
         AND idempotency_key = $2
       FOR UPDATE`,
      [input.organizationId, idempotencyKey],
    )
    if (priorCommand.rowCount) {
      const receipt = priorCommand.rows[0]
      if (receipt.request_hash !== commandRequestHash) {
        throw new BrokeredTransportIntegrationError(
          'This Idempotency-Key was already used for different transport credentials',
          409,
          'TRANSPORT_IDEMPOTENCY_CONFLICT',
        )
      }
      if (receipt.status === 'succeeded') return
      throw new BrokeredTransportIntegrationError(
        'This transport credential command is already in progress',
        409,
        'TRANSPORT_COMMAND_IN_PROGRESS',
      )
    }
    const commandReceipt = await client.query<{ id: string }>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id
       ) VALUES (
         $1::uuid, 'update_brokered_transport_credential', $2, $3,
         $4, 'processing', gen_random_uuid()
       )
       RETURNING id::text`,
      [
        input.organizationId,
        idempotencyKey,
        commandRequestHash,
        input.actorEmail,
      ],
    )
    const encrypted = encryptBrokeredTransportCredential(
      credential,
      input.organizationId,
      provider,
      environment,
    )
    const accountResult = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment, display_name,
         status, configuration, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, 'carrier', $3, $4, 'disabled', $5::jsonb, $6, $6
       )
       ON CONFLICT (organization_id, integration_type, provider, environment)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         status = 'disabled',
         configuration = EXCLUDED.configuration,
         credential_reference = NULL,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        provider,
        environment,
        displayName,
        JSON.stringify(configuration),
        input.actorEmail,
      ],
    )
    const account = accountResult.rows[0]
    const previous = await client.query<{ credential_version: number }>(
      `SELECT credential_version
       FROM operations_carrier_credentials
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
       FOR UPDATE`,
      [input.organizationId, account.id],
    )
    const version = (previous.rows[0]?.credential_version || 0) + 1
    await client.query(
      `INSERT INTO operations_carrier_credentials (
         organization_id, integration_account_id,
         credential_ciphertext, credential_iv, credential_tag,
         credential_version, client_id_last_four,
         credential_kind, credential_identifier_last_four,
         account_number_last_four, verification_status, verified_at,
         last_error_code, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $7,
         NULL, 'unverified', NULL, NULL, $9, $9
       )
       ON CONFLICT (organization_id, integration_account_id)
       DO UPDATE SET
         credential_ciphertext = EXCLUDED.credential_ciphertext,
         credential_iv = EXCLUDED.credential_iv,
         credential_tag = EXCLUDED.credential_tag,
         credential_version = EXCLUDED.credential_version,
         credential_fingerprint = EXCLUDED.credential_fingerprint,
         client_id_last_four = EXCLUDED.client_id_last_four,
         credential_kind = EXCLUDED.credential_kind,
         credential_identifier_last_four = EXCLUDED.credential_identifier_last_four,
         account_number_last_four = NULL,
         verification_status = 'unverified',
         verified_at = NULL,
         last_error_code = NULL,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        input.organizationId,
        account.id,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        version,
        identifierLastFour,
        credentialKind,
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
        `brokered-transport:${account.id}:v${version}`,
        input.actorEmail,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: previous.rowCount
        ? 'transport.credential.rotated'
        : 'transport.credential.connected',
      aggregateType: 'operations_integration_account',
      aggregateId: account.global_id,
      organizationId: input.organizationId,
      payload: {
        provider,
        environment,
        credentialVersion: version,
        activationStatus: 'pre_activation',
      },
    }, client)
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_global_id = $2,
           result_payload = $3::jsonb, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [
        commandReceipt.rows[0].id,
        account.global_id,
        JSON.stringify({
          provider,
          environment,
          integrationGlobalId: account.global_id,
          credentialVersion: version,
        }),
      ],
    )
  })
  return getBrokeredTransportIntegrations(input.organizationId)
}

function normalizeRatingModes(
  provider: BrokeredTransportProvider,
  value: unknown,
) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new BrokeredTransportIntegrationError(
      'Select at least one supported transport mode for read-only rating',
      400,
      'TRANSPORT_RATING_MODE_INVALID',
    )
  }
  const modes = value.map((mode) => String(mode || '').trim())
  if (
    new Set(modes).size !== modes.length
    || modes.some((mode) => mode !== 'small_parcel' && mode !== 'ltl')
    || (provider === 'rl_carriers' && modes.some((mode) => mode !== 'ltl'))
  ) {
    throw new BrokeredTransportIntegrationError(
      'The selected provider does not support the requested rating mode',
      400,
      'TRANSPORT_RATING_MODE_INVALID',
    )
  }
  return modes as Array<'small_parcel' | 'ltl'>
}

function verificationFailure(error: unknown) {
  if (
    error instanceof WwexSpeedshipClientError
    || error instanceof RlCarriersFreightClientError
  ) {
    return {
      code: error.code,
      status: error.status >= 400 && error.status < 500 ? error.status : 503,
      message: error.message,
    }
  }
  return {
    code: 'TRANSPORT_CREDENTIAL_VERIFICATION_FAILED',
    status: 503,
    message: 'The carrier credential could not be verified',
  }
}

async function recordVerificationFailure(input: {
  organizationId: string
  provider: BrokeredTransportProvider
  environment: BrokeredTransportEnvironment
  actorEmail: string
  credentialVersion: number
  code: string
}) {
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `brokered-transport:${input.organizationId}:${input.provider}:${input.environment}`,
    )
    const current = await client.query<{ id: string; global_id: string }>(
      `SELECT account.id::text, account.global_id
       FROM operations_integration_accounts account
       JOIN operations_carrier_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.integration_type = 'carrier'
         AND account.provider = $2
         AND account.environment = $3
         AND credential.credential_version = $4
       FOR UPDATE OF account, credential`,
      [
        input.organizationId,
        input.provider,
        input.environment,
        input.credentialVersion,
      ],
    )
    if (!current.rowCount) return
    await client.query(
      `UPDATE operations_carrier_credentials
       SET verification_status = 'failed', verified_at = NULL,
           last_error_code = $3, updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [
        input.organizationId,
        current.rows[0].id,
        input.code,
        input.actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'error', updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, current.rows[0].id, input.actorEmail],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'transport.credential.verification_failed',
      aggregateType: 'operations_integration_account',
      aggregateId: current.rows[0].global_id,
      organizationId: input.organizationId,
      payload: {
        provider: input.provider,
        environment: input.environment,
        credentialVersion: input.credentialVersion,
        errorCode: input.code,
      },
    }, client)
  })
}

export async function verifyAndActivateBrokeredTransportRates(input: {
  organizationId: string
  provider: unknown
  environment: unknown
  ratingModes: unknown
  verificationPostalCode?: unknown
  verificationCountryCode?: unknown
  actorEmail: string
}) {
  let provider: BrokeredTransportProvider
  let environment: BrokeredTransportEnvironment
  try {
    provider = normalizeBrokeredTransportProvider(input.provider)
    environment = normalizeBrokeredTransportEnvironment(provider, input.environment)
  } catch (error) {
    throw new BrokeredTransportIntegrationError(
      error instanceof Error ? error.message : 'Transport connection is invalid',
      400,
      'TRANSPORT_CONNECTION_INVALID',
    )
  }
  const ratingModes = normalizeRatingModes(provider, input.ratingModes)
  if (provider === 'wwex_speedship' && environment !== 'sandbox') {
    throw new BrokeredTransportIntegrationError(
      'Worldwide Express production endpoints and audience have not been issued',
      409,
      'WWEX_PRODUCTION_CONFIGURATION_REQUIRED',
    )
  }
  const result = await query<ConnectionRow>(
    `${CONNECTION_SELECT}
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'carrier'
       AND account.provider = $2
       AND account.environment = $3
     LIMIT 1`,
    [input.organizationId, provider, environment],
  )
  const row = result.rows[0]
  if (
    !row
    || !row.credential_ciphertext
    || !row.credential_iv
    || !row.credential_tag
    || !row.credential_version
    || !row.credential_fingerprint
  ) {
    throw new BrokeredTransportIntegrationError(
      'Store the carrier credential before activating read-only rates',
      409,
      'TRANSPORT_CREDENTIAL_REQUIRED',
    )
  }
  const credential = decryptBrokeredTransportCredential(
    {
      ciphertext: row.credential_ciphertext,
      iv: row.credential_iv,
      tag: row.credential_tag,
    },
    input.organizationId,
    provider,
    environment,
  )
  const common = {
    credentialVersion: row.credential_version,
    credentialFingerprint: row.credential_fingerprint,
  }
  let verification: {
    verificationType: string
    completedAt: string
    providerHttpStatus: number
  }
  try {
    if (provider === 'wwex_speedship') {
      if (credential.authKind !== 'oauth_client_credentials') {
        throw new Error('Credential shape mismatch')
      }
      verification = await verifyWwexSpeedshipRuntimeCredential({
        runtimeCredential: {
          ...common,
          provider,
          environment: 'sandbox',
          credential,
        },
      })
    } else {
      if (credential.authKind !== 'api_key') {
        throw new Error('Credential shape mismatch')
      }
      const country = String(input.verificationCountryCode || 'USA')
        .trim()
        .toUpperCase()
      verification = await verifyRlCarriersRuntimeCredential({
        runtimeCredential: {
          ...common,
          provider,
          environment: 'production',
          credential,
        },
        zipOrPostalCode: String(input.verificationPostalCode || ''),
        countryCode: country as 'USA' | 'CAN',
      })
    }
  } catch (error) {
    const failure = verificationFailure(error)
    await recordVerificationFailure({
      organizationId: input.organizationId,
      provider,
      environment,
      actorEmail: input.actorEmail,
      credentialVersion: row.credential_version,
      code: failure.code,
    })
    throw new BrokeredTransportIntegrationError(
      failure.message,
      failure.status,
      failure.code,
    )
  }

  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `brokered-transport:${input.organizationId}:${provider}:${environment}`,
    )
    const current = await client.query<ConnectionRow>(
      `${LOCKED_CREDENTIAL_CONNECTION_SELECT}
       WHERE account.organization_id = $1::uuid
         AND account.integration_type = 'carrier'
         AND account.provider = $2
         AND account.environment = $3
       FOR UPDATE OF account, credential`,
      [input.organizationId, provider, environment],
    )
    const locked = current.rows[0]
    if (
      !locked
      || locked.credential_version !== row.credential_version
      || locked.credential_fingerprint !== row.credential_fingerprint
    ) {
      throw new BrokeredTransportIntegrationError(
        'The carrier credential changed during verification; verify the current version',
        409,
        'TRANSPORT_CREDENTIAL_CHANGED',
      )
    }
    const allowedCapabilities = ratingModes.map((mode) => (
      mode === 'small_parcel' ? 'small_parcel_rate' : 'ltl_rate'
    ))
    const configuration = {
      ...locked.configuration,
      allowedCapabilities,
      transportActivation: {
        small_parcel: {
          ratingEnabled: ratingModes.includes('small_parcel'),
          tenderEnabled: false,
        },
        ltl: {
          ratingEnabled: ratingModes.includes('ltl'),
          tenderEnabled: false,
        },
      },
      activationStatus: 'active',
      activationBlockers: [],
      tenderActivationBlockers: tenderActivationBlockers(provider, environment),
      rateVerification: {
        verificationType: verification.verificationType,
        completedAt: verification.completedAt,
        providerHttpStatus: verification.providerHttpStatus,
      },
    }
    await client.query(
      `UPDATE operations_carrier_credentials
       SET verification_status = 'verified', verified_at = $3::timestamptz,
           last_error_code = NULL, updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [
        input.organizationId,
        locked.id,
        verification.completedAt,
        input.actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'active', configuration = $3::jsonb,
           updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        input.organizationId,
        locked.id,
        JSON.stringify(configuration),
        input.actorEmail,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'transport.rating.activated',
      aggregateType: 'operations_integration_account',
      aggregateId: locked.global_id,
      organizationId: input.organizationId,
      payload: {
        provider,
        environment,
        credentialVersion: locked.credential_version,
        ratingModes,
        verificationType: verification.verificationType,
      },
    }, client)
  })
  return getBrokeredTransportIntegrations(input.organizationId)
}

export async function disconnectBrokeredTransportCredential(input: {
  organizationId: string
  provider: unknown
  environment: unknown
  actorEmail: string
}) {
  let provider: BrokeredTransportProvider
  let environment: BrokeredTransportEnvironment
  try {
    provider = normalizeBrokeredTransportProvider(input.provider)
    environment = normalizeBrokeredTransportEnvironment(provider, input.environment)
  } catch (error) {
    throw new BrokeredTransportIntegrationError(
      error instanceof Error ? error.message : 'Transport connection is invalid',
      400,
      'TRANSPORT_CONNECTION_INVALID',
    )
  }
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `brokered-transport:${input.organizationId}:${provider}:${environment}`,
    )
    const account = await client.query<{ id: string; global_id: string }>(
      `SELECT id::text, global_id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND integration_type = 'carrier'
         AND provider = $2
         AND environment = $3
       FOR UPDATE`,
      [input.organizationId, provider, environment],
    )
    if (!account.rowCount) return
    await client.query(
      `DELETE FROM operations_carrier_credentials
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [input.organizationId, account.rows[0].id],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'disabled', credential_reference = NULL,
           configuration = configuration
             || '{"allowedCapabilities":[],"transportActivation":{"small_parcel":{"ratingEnabled":false,"tenderEnabled":false},"ltl":{"ratingEnabled":false,"tenderEnabled":false}},"activationStatus":"pre_activation"}'::jsonb,
           updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, account.rows[0].id, input.actorEmail],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'transport.credential.disconnected',
      aggregateType: 'operations_integration_account',
      aggregateId: account.rows[0].global_id,
      organizationId: input.organizationId,
      payload: { provider, environment },
    }, client)
  })
  return getBrokeredTransportIntegrations(input.organizationId)
}

export async function readActiveBrokeredTransportRuntimeCredential(input: {
  organizationId: string
  provider: BrokeredTransportProvider
  environment: BrokeredTransportEnvironment
  capability:
    | 'small_parcel_rate'
    | 'small_parcel_pickup'
    | 'small_parcel_tender'
    | 'ltl_rate'
    | 'ltl_tender'
    | 'ltl_bol'
    | 'ltl_pickup'
}): Promise<BrokeredTransportRuntimeCredential | null> {
  const result = await query<ConnectionRow>(
    `${CONNECTION_SELECT}
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'carrier'
       AND account.provider = $2
       AND account.environment = $3
       AND account.status = 'active'
       AND credential.verification_status = 'verified'
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
    || !row.credential_fingerprint
  ) return null
  const allowedCapabilities = strings(row.configuration.allowedCapabilities)
  const activation = row.configuration.transportActivation
  const activationRecord = activation && typeof activation === 'object'
    && !Array.isArray(activation)
    ? activation as Record<string, unknown>
    : {}
  const mode = input.capability.startsWith('small_parcel_')
    ? 'small_parcel'
    : 'ltl'
  const modeActivation = activationRecord[mode]
  const modeActivationRecord = modeActivation && typeof modeActivation === 'object'
    && !Array.isArray(modeActivation)
    ? modeActivation as Record<string, unknown>
    : {}
  const activationField = input.capability.endsWith('_rate')
    ? 'ratingEnabled'
    : 'tenderEnabled'
  if (
    !PROVIDER_CAPABILITIES[row.provider].includes(input.capability)
    || !allowedCapabilities.includes(input.capability)
    || modeActivationRecord[activationField] !== true
    || row.configuration.activationStatus !== 'active'
    || strings(row.configuration.activationBlockers).length > 0
  ) return null
  const encrypted: EncryptedBrokeredTransportCredential = {
    ciphertext: row.credential_ciphertext,
    iv: row.credential_iv,
    tag: row.credential_tag,
  }
  const credential = decryptBrokeredTransportCredential(
    encrypted,
    input.organizationId,
    row.provider,
    row.environment,
  )
  const common = {
    organizationId: input.organizationId,
    integrationAccountId: row.id,
    integrationGlobalId: row.global_id,
    credentialVersion: row.credential_version,
    credentialFingerprint: row.credential_fingerprint,
  }
  if (row.provider === 'wwex_speedship') {
    if (credential.authKind !== 'oauth_client_credentials') return null
    return {
      ...common,
      provider: 'wwex_speedship',
      environment: row.environment,
      credential,
    }
  }
  if (row.environment !== 'production' || credential.authKind !== 'api_key') {
    return null
  }
  return {
    ...common,
    provider: 'rl_carriers',
    environment: 'production',
    credential,
  }
}

export function sanitizedBrokeredTransportIntegrationError(error: unknown) {
  if (error instanceof BrokeredTransportIntegrationError) return error
  return new BrokeredTransportIntegrationError(
    'The transport integration request could not be completed',
    500,
    'TRANSPORT_INTEGRATION_FAILED',
  )
}
