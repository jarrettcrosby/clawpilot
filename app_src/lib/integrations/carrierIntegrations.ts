import { createHash } from 'node:crypto'
import {
  CarrierCredentialClientError,
  verifyCarrierCredential,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'
import {
  CARRIER_SANDBOX_RATE_FIXTURE,
  carrierSandboxRateRequestEvidence,
  requestCarrierSandboxRates,
} from '@/lib/integrations/carrierSandboxRate'
import {
  carrierAccountAddressFingerprint,
  decryptCarrierAccountNumber,
  decryptCarrierCredential,
  encryptCarrierCredential,
  normalizeCarrierAccountAddress,
  normalizeCarrierAccountGlobalId,
  normalizeCarrierBillingAccountNumber,
  normalizeCarrierClientId,
  normalizeCarrierClientSecret,
  normalizeCarrierEnvironment,
  normalizeCarrierOrganizationId,
  normalizeDirectCarrierProvider,
} from '@/lib/integrations/carrierCredentialCrypto'
import {
  createCarrierAccountInPostgres,
  deleteCarrierAccountInPostgres,
  disconnectCarrierCredentialInPostgres,
  markCarrierCredentialVerificationInPostgres,
  recordCarrierCredentialRevealInPostgres,
  readActiveCarrierAccountsFromPostgres,
  readCarrierIntegrationsStateFromPostgres,
  readCarrierRuntimeCredentialFromPostgres,
  setCarrierAccountStatusInPostgres,
  setCarrierIntegrationEnabledInPostgres,
  updateCarrierAccountInPostgres,
  writeCarrierSandboxRateEvidenceInPostgres,
  writeCarrierCredentialInPostgres,
  type CarrierRuntimeAccountRecord,
} from '@/lib/persistence/carrierIntegrations'

const CARRIER_SANDBOX_RATE_ADAPTER_VERSION = 'direct-rest-v2'

export class CarrierIntegrationRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status = 400, code = 'CARRIER_REQUEST_INVALID') {
    super(message)
    this.name = 'CarrierIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

function displayName(value: unknown, provider: string, environment: string) {
  const fallback = `${provider === 'ups_rest' ? 'UPS' : provider === 'fedex_rest' ? 'FedEx' : 'USPS'} ${environment}`
  const normalized = String(value || fallback).trim()
  if (!normalized || normalized.length > 120) {
    throw new CarrierIntegrationRequestError('Carrier connection name must be 1-120 characters')
  }
  return normalized
}

function carrierAccountDisplayName(value: unknown) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 120) {
    throw new CarrierIntegrationRequestError('Carrier account name must be 1-120 characters')
  }
  return normalized
}

function billingFlag(value: unknown, defaultValue: boolean) {
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') {
    throw new CarrierIntegrationRequestError('Carrier billing permissions must be boolean values')
  }
  return value
}

function sanitize(error: unknown): CarrierIntegrationRequestError {
  if (error instanceof CarrierIntegrationRequestError) return error
  if (error instanceof CarrierCredentialClientError) {
    return new CarrierIntegrationRequestError(error.message, error.status, error.code)
  }
  const message = error instanceof Error ? error.message : ''
  if (message === 'Carrier credential encryption is not configured') {
    return new CarrierIntegrationRequestError(message, 503, 'CARRIER_ENCRYPTION_UNAVAILABLE')
  }
  if (message === 'Stored carrier credential could not be decrypted') {
    return new CarrierIntegrationRequestError(message, 500, 'CARRIER_CREDENTIAL_INVALID')
  }
  if (message === 'Stored carrier account number could not be decrypted') {
    return new CarrierIntegrationRequestError(message, 500, 'CARRIER_ACCOUNT_INVALID')
  }
  if (
    message.startsWith('Carrier ')
    || message.startsWith('The carrier ')
    || message.startsWith('A valid organization')
  ) {
    return new CarrierIntegrationRequestError(message, 400, 'CARRIER_REQUEST_INVALID')
  }
  return new CarrierIntegrationRequestError('Carrier integration request failed', 500, 'CARRIER_INTERNAL_ERROR')
}

export function sanitizedCarrierIntegrationError(error: unknown) {
  return sanitize(error)
}

async function storedRuntimeCredential(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
}): Promise<CarrierRuntimeCredential & {
  organizationId: string
  integrationAccountId: string
  integrationGlobalId: string
  credentialVersion: number
  status: 'active' | 'disabled' | 'error'
  verified: boolean
}> {
  const organizationId = normalizeCarrierOrganizationId(input.organizationId)
  const provider = normalizeDirectCarrierProvider(input.provider)
  const environment = normalizeCarrierEnvironment(input.environment)
  const stored = await readCarrierRuntimeCredentialFromPostgres({ organizationId, provider, environment })
  if (!stored) {
    throw new CarrierIntegrationRequestError(
      'Carrier credentials are not configured',
      409,
      'CARRIER_CREDENTIAL_REQUIRED',
    )
  }
  const providerCredential = decryptCarrierCredential(
    stored.encrypted,
    organizationId,
    provider,
    environment,
  )
  return {
    organizationId,
    integrationAccountId: stored.integrationAccountId,
    integrationGlobalId: stored.globalId,
    credentialVersion: stored.credentialVersion,
    provider,
    environment,
    credential: { ...providerCredential, accountNumber: null },
    status: stored.status,
    verified: stored.verificationStatus === 'verified',
  }
}

export async function resolveActiveCarrierCredential(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
}): Promise<CarrierRuntimeCredential> {
  try {
    const runtime = await storedRuntimeCredential(input)
    if (runtime.status !== 'active' || !runtime.verified) {
      throw new CarrierIntegrationRequestError(
        'Carrier credentials are not active and verified',
        409,
        'CARRIER_CREDENTIAL_INACTIVE',
      )
    }
    return { provider: runtime.provider, environment: runtime.environment, credential: runtime.credential }
  } catch (error) {
    throw sanitize(error)
  }
}

export async function getCarrierIntegrationsState(organizationIdValue: unknown) {
  return readCarrierIntegrationsStateFromPostgres(normalizeCarrierOrganizationId(organizationIdValue))
}

export async function revealCarrierCredential(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  actorEmail: string
}) {
  try {
    const runtime = await storedRuntimeCredential(input)
    await recordCarrierCredentialRevealInPostgres({
      organizationId: runtime.organizationId,
      provider: runtime.provider,
      environment: runtime.environment,
      actorEmail: input.actorEmail,
      credentialVersion: runtime.credentialVersion,
    })
    const revealedAt = new Date()
    return {
      provider: runtime.provider,
      environment: runtime.environment,
      clientId: runtime.credential.clientId,
      clientSecret: runtime.credential.clientSecret,
      credentialVersion: runtime.credentialVersion,
      revealedAt: revealedAt.toISOString(),
      expiresAt: new Date(revealedAt.getTime() + 30_000).toISOString(),
    }
  } catch (error) {
    throw sanitize(error)
  }
}

export async function updateCarrierCredential(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  displayName?: unknown
  clientId: unknown
  clientSecret: unknown
  actorEmail: string
}) {
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    const environment = normalizeCarrierEnvironment(input.environment)
    const credential = {
      clientId: normalizeCarrierClientId(input.clientId),
      clientSecret: normalizeCarrierClientSecret(input.clientSecret),
      accountNumber: null,
    }
    await verifyCarrierCredential({ provider, environment, credential })
    const encrypted = encryptCarrierCredential(credential, organizationId, provider, environment)
    return writeCarrierCredentialInPostgres({
      organizationId,
      provider,
      environment,
      displayName: displayName(input.displayName, provider, environment),
      encrypted,
      clientIdLastFour: credential.clientId.slice(-4),
      accountNumberLastFour: null,
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

function carrierAccountWrite(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  displayName: unknown
  accountNumber?: unknown
  registeredAddress: unknown
  allowSenderBilling?: unknown
  allowRecipientBilling?: unknown
  allowThirdPartyBilling?: unknown
  actorEmail: string
}) {
  const allowSenderBilling = billingFlag(input.allowSenderBilling, true)
  const allowRecipientBilling = billingFlag(input.allowRecipientBilling, true)
  const allowThirdPartyBilling = billingFlag(input.allowThirdPartyBilling, true)
  if (!allowSenderBilling && !allowRecipientBilling && !allowThirdPartyBilling) {
    throw new CarrierIntegrationRequestError('Carrier account must allow at least one billing relationship')
  }
  return {
    organizationId: normalizeCarrierOrganizationId(input.organizationId),
    provider: normalizeDirectCarrierProvider(input.provider),
    environment: normalizeCarrierEnvironment(input.environment),
    displayName: carrierAccountDisplayName(input.displayName),
    accountNumber: input.accountNumber === undefined
      ? null
      : normalizeCarrierBillingAccountNumber(input.accountNumber),
    registeredAddress: normalizeCarrierAccountAddress(input.registeredAddress),
    allowSenderBilling,
    allowRecipientBilling,
    allowThirdPartyBilling,
    actorEmail: input.actorEmail,
  }
}

export async function createCarrierAccount(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  displayName: unknown
  accountNumber: unknown
  registeredAddress: unknown
  allowSenderBilling?: unknown
  allowRecipientBilling?: unknown
  allowThirdPartyBilling?: unknown
  actorEmail: string
}) {
  try {
    const normalized = carrierAccountWrite(input)
    if (!normalized.accountNumber) {
      throw new CarrierIntegrationRequestError('The carrier billing account number is required')
    }
    return createCarrierAccountInPostgres(normalized)
  } catch (error) {
    throw sanitize(error)
  }
}

export async function updateCarrierAccount(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  carrierAccountGlobalId: unknown
  displayName: unknown
  accountNumber?: unknown
  registeredAddress: unknown
  allowSenderBilling?: unknown
  allowRecipientBilling?: unknown
  allowThirdPartyBilling?: unknown
  actorEmail: string
}) {
  try {
    return updateCarrierAccountInPostgres({
      ...carrierAccountWrite(input),
      carrierAccountGlobalId: normalizeCarrierAccountGlobalId(input.carrierAccountGlobalId),
    })
  } catch (error) {
    throw sanitize(error)
  }
}

export async function setCarrierAccountStatus(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  carrierAccountGlobalId: unknown
  status: unknown
  actorEmail: string
}) {
  try {
    if (input.status !== 'active' && input.status !== 'disabled') {
      throw new CarrierIntegrationRequestError('Carrier account status must be active or disabled')
    }
    return setCarrierAccountStatusInPostgres({
      organizationId: normalizeCarrierOrganizationId(input.organizationId),
      provider: normalizeDirectCarrierProvider(input.provider),
      environment: normalizeCarrierEnvironment(input.environment),
      carrierAccountGlobalId: normalizeCarrierAccountGlobalId(input.carrierAccountGlobalId),
      status: input.status,
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

export async function deleteCarrierAccount(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  carrierAccountGlobalId: unknown
  actorEmail: string
}) {
  try {
    return deleteCarrierAccountInPostgres({
      organizationId: normalizeCarrierOrganizationId(input.organizationId),
      provider: normalizeDirectCarrierProvider(input.provider),
      environment: normalizeCarrierEnvironment(input.environment),
      carrierAccountGlobalId: normalizeCarrierAccountGlobalId(input.carrierAccountGlobalId),
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitize(error)
  }
}

export async function testCarrierCredential(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  actorEmail: string
}) {
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    const environment = normalizeCarrierEnvironment(input.environment)
    const runtime = await storedRuntimeCredential({ organizationId, provider, environment })
    await verifyCarrierCredential({
      provider: runtime.provider,
      environment: runtime.environment,
      credential: runtime.credential,
    })
    return await markCarrierCredentialVerificationInPostgres({
      organizationId,
      provider,
      environment,
      actorEmail: input.actorEmail,
      errorCode: null,
    })
  } catch (error) {
    const sanitized = sanitize(error)
    try {
      await markCarrierCredentialVerificationInPostgres({
        organizationId: normalizeCarrierOrganizationId(input.organizationId),
        provider: normalizeDirectCarrierProvider(input.provider),
        environment: normalizeCarrierEnvironment(input.environment),
        actorEmail: input.actorEmail,
        errorCode: sanitized.code,
      })
    } catch {
      // Invalid request dimensions cannot identify a stored credential to mark failed.
    }
    throw sanitized
  }
}

type SandboxBillingSelection = {
  account: CarrierRuntimeAccountRecord
  relationship: 'sender' | 'recipient' | 'third_party'
  mode: 'explicit' | 'single_active_account'
  snapshot: Record<string, unknown>
}

const SANDBOX_SENDER_ADDRESS = normalizeCarrierAccountAddress({
  line1: CARRIER_SANDBOX_RATE_FIXTURE.origin.street,
  line2: null,
  city: CARRIER_SANDBOX_RATE_FIXTURE.origin.city,
  region: CARRIER_SANDBOX_RATE_FIXTURE.origin.state,
  postalCode: CARRIER_SANDBOX_RATE_FIXTURE.origin.postalCode,
  countryCode: CARRIER_SANDBOX_RATE_FIXTURE.origin.countryCode,
})

const SANDBOX_RECIPIENT_ADDRESS = normalizeCarrierAccountAddress({
  line1: CARRIER_SANDBOX_RATE_FIXTURE.destination.street,
  line2: null,
  city: CARRIER_SANDBOX_RATE_FIXTURE.destination.city,
  region: CARRIER_SANDBOX_RATE_FIXTURE.destination.state,
  postalCode: CARRIER_SANDBOX_RATE_FIXTURE.destination.postalCode,
  countryCode: CARRIER_SANDBOX_RATE_FIXTURE.destination.countryCode,
})

export function sandboxBillingRelationship(account: CarrierRuntimeAccountRecord) {
  const registeredFingerprint = carrierAccountAddressFingerprint(account.registeredAddress)
  if (registeredFingerprint === carrierAccountAddressFingerprint(SANDBOX_SENDER_ADDRESS)) {
    if (!account.allowSenderBilling) {
      throw new CarrierIntegrationRequestError(
        'The selected carrier account does not allow sender billing',
        409,
        'CARRIER_ACCOUNT_BILLING_NOT_ALLOWED',
      )
    }
    return 'sender' as const
  }
  if (registeredFingerprint === carrierAccountAddressFingerprint(SANDBOX_RECIPIENT_ADDRESS)) {
    if (!account.allowRecipientBilling) {
      throw new CarrierIntegrationRequestError(
        'The selected carrier account does not allow recipient billing',
        409,
        'CARRIER_ACCOUNT_BILLING_NOT_ALLOWED',
      )
    }
    return 'recipient' as const
  }
  if (!account.allowThirdPartyBilling) {
    throw new CarrierIntegrationRequestError(
      'The selected carrier account does not allow third-party billing for this fixture',
      409,
      'CARRIER_ACCOUNT_BILLING_NOT_ALLOWED',
    )
  }
  return 'third_party' as const
}

async function sandboxBillingSelection(input: {
  runtime: Awaited<ReturnType<typeof storedRuntimeCredential>>
  carrierAccountGlobalId?: unknown
}): Promise<SandboxBillingSelection> {
  const activeAccounts = await readActiveCarrierAccountsFromPostgres({
    organizationId: input.runtime.organizationId,
    integrationAccountId: input.runtime.integrationAccountId,
  })
  const requestedGlobalId = String(input.carrierAccountGlobalId || '').trim()
  const normalizedRequestedGlobalId = requestedGlobalId
    ? normalizeCarrierAccountGlobalId(requestedGlobalId)
    : null
  const account = normalizedRequestedGlobalId
    ? activeAccounts.find((candidate) => candidate.globalId === normalizedRequestedGlobalId)
    : activeAccounts.length === 1 ? activeAccounts[0] : null
  if (!account) {
    if (!requestedGlobalId && activeAccounts.length > 1) {
      throw new CarrierIntegrationRequestError(
        'Select a carrier account before testing a sandbox rate',
        409,
        'CARRIER_ACCOUNT_SELECTION_REQUIRED',
      )
    }
    throw new CarrierIntegrationRequestError(
      requestedGlobalId
        ? 'The selected carrier account is not active'
        : 'An active carrier account is required for sandbox rating',
      409,
      'CARRIER_ACCOUNT_REQUIRED',
    )
  }
  const mode = requestedGlobalId ? 'explicit' : 'single_active_account'
  const relationship = sandboxBillingRelationship(account)
  return {
    account,
    relationship,
    mode,
    snapshot: {
      selectionMode: mode,
      carrierAccountGlobalId: account.globalId,
      carrierAccountDisplayName: account.displayName,
      accountNumberLastFour: account.accountNumberLastFour,
      registeredAddress: account.registeredAddress,
      registeredAddressFingerprint: account.registeredAddressFingerprint,
      addressVerification: account.addressVerification,
      billingRelationship: relationship,
      payerAddressSource: 'registered_carrier_account',
      precedence: ['sender', 'recipient', 'third_party'],
      fixtureAddressMatch: relationship === 'third_party' ? 'none' : relationship,
    },
  }
}

function selectionRequestHash(requestHash: string, selection: SandboxBillingSelection) {
  return createHash('sha256')
    .update([
      requestHash,
      selection.account.globalId,
      selection.account.accountNumberFingerprint,
      selection.relationship,
      selection.mode,
    ].join(':'))
    .digest('hex')
}

export async function testCarrierSandboxRate(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  carrierAccountGlobalId?: unknown
  actorEmail: string
}) {
  const requestedAt = new Date().toISOString()
  let runtime: Awaited<ReturnType<typeof storedRuntimeCredential>> | null = null
  let selection: SandboxBillingSelection | null = null
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    const environment = normalizeCarrierEnvironment(input.environment)
    if (environment !== 'sandbox') {
      throw new CarrierIntegrationRequestError(
        'Rate testing is limited to carrier sandbox accounts',
        409,
        'CARRIER_SANDBOX_REQUIRED',
      )
    }
    if (provider !== 'ups_rest' && provider !== 'fedex_rest') {
      throw new CarrierIntegrationRequestError(
        'Sandbox rating is not available for this carrier yet',
        409,
        'CARRIER_SANDBOX_RATE_UNSUPPORTED',
      )
    }
    runtime = await storedRuntimeCredential({ organizationId, provider, environment })
    if (runtime.status !== 'active' || !runtime.verified) {
      throw new CarrierIntegrationRequestError(
        'Enable a verified carrier credential before testing a rate',
        409,
        'CARRIER_CREDENTIAL_INACTIVE',
      )
    }
    selection = await sandboxBillingSelection({
      runtime,
      carrierAccountGlobalId: input.carrierAccountGlobalId,
    })
    const accountNumber = decryptCarrierAccountNumber(
      selection.account.encrypted,
      runtime.organizationId,
      runtime.provider,
      runtime.environment,
      selection.account.globalId,
    )
    const rate = await requestCarrierSandboxRates({
      provider: runtime.provider,
      environment: runtime.environment,
      credential: { ...runtime.credential, accountNumber },
    })
    const evidenceGlobalId = await writeCarrierSandboxRateEvidenceInPostgres({
      organizationId: runtime.organizationId,
      integrationAccountId: runtime.integrationAccountId,
      integrationGlobalId: runtime.integrationGlobalId,
      carrierAccountId: selection.account.id,
      carrierAccountGlobalId: selection.account.globalId,
      billingRelationship: selection.relationship,
      billingSelectionSnapshot: selection.snapshot,
      provider: runtime.provider,
      credentialVersion: runtime.credentialVersion,
      adapterVersion: CARRIER_SANDBOX_RATE_ADAPTER_VERSION,
      requestHash: selectionRequestHash(rate.evidence.requestHash, selection),
      redactedRequest: {
        ...rate.evidence.redactedRequest,
        billingSelection: selection.snapshot,
      },
      redactedResponse: rate.evidence.redactedResponse,
      status: 'succeeded',
      providerReference: rate.evidence.providerReference,
      errorCode: null,
      actorEmail: input.actorEmail,
      requestedAt: rate.evidence.requestedAt,
      completedAt: rate.evidence.completedAt,
    })
    return {
      ...rate.result,
      carrierAccountGlobalId: selection.account.globalId,
      billingRelationship: selection.relationship,
      evidenceGlobalId,
    }
  } catch (error) {
    const sanitized = sanitize(error)
    if (
      runtime
      && selection
      && (runtime.provider === 'ups_rest' || runtime.provider === 'fedex_rest')
    ) {
      const safeRequest = carrierSandboxRateRequestEvidence(runtime.provider)
      try {
        await writeCarrierSandboxRateEvidenceInPostgres({
          organizationId: runtime.organizationId,
          integrationAccountId: runtime.integrationAccountId,
          integrationGlobalId: runtime.integrationGlobalId,
          carrierAccountId: selection.account.id,
          carrierAccountGlobalId: selection.account.globalId,
          billingRelationship: selection.relationship,
          billingSelectionSnapshot: selection.snapshot,
          provider: runtime.provider,
          credentialVersion: runtime.credentialVersion,
          adapterVersion: CARRIER_SANDBOX_RATE_ADAPTER_VERSION,
          requestHash: selectionRequestHash(safeRequest.requestHash, selection),
          redactedRequest: {
            ...safeRequest.redactedRequest,
            billingSelection: selection.snapshot,
          },
          redactedResponse: { errorCode: sanitized.code },
          status: 'failed',
          providerReference: null,
          errorCode: sanitized.code,
          actorEmail: input.actorEmail,
          requestedAt,
          completedAt: new Date().toISOString(),
        })
      } catch {
        // The original carrier error remains authoritative if evidence storage fails.
      }
    }
    throw sanitized
  }
}

export async function setCarrierIntegrationEnabled(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  enabled: unknown
  actorEmail: string
}) {
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    const environment = normalizeCarrierEnvironment(input.environment)
    const enabled = input.enabled === true
    if (enabled) {
      await testCarrierCredential({ organizationId, provider, environment, actorEmail: input.actorEmail })
    }
    const result = await setCarrierIntegrationEnabledInPostgres({
      organizationId,
      provider,
      environment,
      enabled,
      actorEmail: input.actorEmail,
    })
    if (!result.updated) {
      throw new CarrierIntegrationRequestError(
        'A verified carrier credential is required',
        409,
        'CARRIER_CREDENTIAL_REQUIRED',
      )
    }
    return result.state
  } catch (error) {
    throw sanitize(error)
  }
}

export async function disconnectCarrierCredential(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  actorEmail: string
}) {
  try {
    return disconnectCarrierCredentialInPostgres({
      organizationId: normalizeCarrierOrganizationId(input.organizationId),
      provider: normalizeDirectCarrierProvider(input.provider),
      environment: normalizeCarrierEnvironment(input.environment),
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitize(error)
  }
}
