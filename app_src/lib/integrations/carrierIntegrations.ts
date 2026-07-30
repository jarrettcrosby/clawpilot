import { createHash } from 'node:crypto'
import {
  CarrierCredentialClientError,
  verifyCarrierCredential,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'
import {
  CARRIER_SANDBOX_RATE_FIXTURE,
  buildCarrierSandboxRateFixture,
  buildCarrierSandboxShipmentRateFixture,
  carrierSandboxRateRequestEvidence,
  carrierSandboxShipmentRateRequestEvidence,
  requestCarrierSandboxRates,
  requestCarrierSandboxShipmentRates,
  type CarrierSandboxRateFixture,
  type CarrierSandboxRatePurpose,
  type CarrierSandboxShipmentRateFixture,
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
  type CarrierEnvironment,
  type DirectCarrierProvider,
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

const CARRIER_SANDBOX_RATE_ADAPTER_VERSION = 'direct-rest-v3'
const CARRIER_SANDBOX_SHIPMENT_RATE_ADAPTER_VERSION =
  'direct-rest-multi-package-v1'
const AG_ALCHEMY_EPISCS_RATING_DELEGATION =
  'ag-alchemy-episcs-sandbox-rating-delegation'
const AG_ALCHEMY_RATING_ORIGIN_WAREHOUSE = 'gwh5366613'

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

function carrierAccountSenderName(value: unknown) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new CarrierIntegrationRequestError('Carrier account sender name must be 1-120 characters')
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
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'CARRIER_DELEGATION_SOURCE_MANAGED'
    && 'status' in error
    && error.status === 403
  ) {
    return new CarrierIntegrationRequestError(
      error instanceof Error
        ? error.message
        : 'This sandbox rating delegation is managed by its source organization',
      403,
      'CARRIER_DELEGATION_SOURCE_MANAGED',
    )
  }
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

function isSourceManagedCarrierConfiguration(
  configuration: Record<string, unknown>,
) {
  return (
    configuration.managedBy === AG_ALCHEMY_EPISCS_RATING_DELEGATION
    || (
      configuration.authorizationScope === 'sandbox_rating_only'
      && configuration.credentialRevealAllowed === false
    )
  )
}

function isExactAgAlchemyRatingDelegation(
  configuration: Record<string, unknown>,
) {
  const capabilities = configuration.allowedCapabilities
  return (
    configuration.managedBy === AG_ALCHEMY_EPISCS_RATING_DELEGATION
    && configuration.authorizationScope === 'sandbox_rating_only'
    && configuration.credentialRevealAllowed === false
    && configuration.senderOriginWarehouseGlobalId
      === AG_ALCHEMY_RATING_ORIGIN_WAREHOUSE
    && Array.isArray(capabilities)
    && capabilities.length === 1
    && capabilities[0] === 'sandbox_rate'
  )
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
  configuration: Record<string, unknown>
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
    configuration: stored.configuration,
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
    if (
      isSourceManagedCarrierConfiguration(runtime.configuration)
      || runtime.configuration.credentialRevealAllowed === false
    ) {
      throw new CarrierIntegrationRequestError(
        'This delegated carrier credential is managed by its source organization and cannot be revealed here',
        403,
        'CARRIER_CREDENTIAL_REVEAL_NOT_ALLOWED',
      )
    }
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

function requiresConfiguredCapability(
  runtime: Pick<Awaited<ReturnType<typeof storedRuntimeCredential>>, 'configuration'>,
  capability: 'sandbox_rate' | 'sandbox_label',
) {
  const configured = runtime.configuration.allowedCapabilities
  if (isSourceManagedCarrierConfiguration(runtime.configuration)) {
    if (
      capability !== 'sandbox_rate'
      || !isExactAgAlchemyRatingDelegation(runtime.configuration)
    ) {
      throw new CarrierIntegrationRequestError(
        capability === 'sandbox_rate'
          ? 'This managed carrier rating connection requires repair'
          : 'This carrier connection is authorized for sandbox rating only',
        403,
        'CARRIER_CAPABILITY_NOT_AUTHORIZED',
      )
    }
    return
  }
  if (!Array.isArray(configured)) return
  if (!configured.includes(capability)) {
    throw new CarrierIntegrationRequestError(
      capability === 'sandbox_rate'
        ? 'This carrier connection is not authorized for sandbox rating'
        : 'This carrier connection is authorized for sandbox rating only',
      403,
      'CARRIER_CAPABILITY_NOT_AUTHORIZED',
    )
  }
}

async function requireUserManagedCarrierConnection(input: {
  organizationId: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
}) {
  const existing = await readCarrierRuntimeCredentialFromPostgres(input)
  if (
    existing
    && isSourceManagedCarrierConfiguration(existing.configuration)
  ) {
    throw new CarrierIntegrationRequestError(
      'This sandbox rating delegation is managed by its source organization',
      403,
      'CARRIER_DELEGATION_SOURCE_MANAGED',
    )
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
    await requireUserManagedCarrierConnection({
      organizationId,
      provider,
      environment,
    })
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
  senderName: unknown
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
    senderName: carrierAccountSenderName(input.senderName),
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
  senderName: unknown
  accountNumber: unknown
  registeredAddress: unknown
  allowSenderBilling?: unknown
  allowRecipientBilling?: unknown
  allowThirdPartyBilling?: unknown
  actorEmail: string
}) {
  try {
    const normalized = carrierAccountWrite(input)
    await requireUserManagedCarrierConnection(normalized)
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
  senderName: unknown
  accountNumber?: unknown
  registeredAddress: unknown
  allowSenderBilling?: unknown
  allowRecipientBilling?: unknown
  allowThirdPartyBilling?: unknown
  actorEmail: string
}) {
  try {
    const normalized = carrierAccountWrite(input)
    await requireUserManagedCarrierConnection(normalized)
    return updateCarrierAccountInPostgres({
      ...normalized,
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
    const dimensions = {
      organizationId: normalizeCarrierOrganizationId(input.organizationId),
      provider: normalizeDirectCarrierProvider(input.provider),
      environment: normalizeCarrierEnvironment(input.environment),
    }
    await requireUserManagedCarrierConnection(dimensions)
    return setCarrierAccountStatusInPostgres({
      ...dimensions,
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
    const dimensions = {
      organizationId: normalizeCarrierOrganizationId(input.organizationId),
      provider: normalizeDirectCarrierProvider(input.provider),
      environment: normalizeCarrierEnvironment(input.environment),
    }
    await requireUserManagedCarrierConnection(dimensions)
    return deleteCarrierAccountInPostgres({
      ...dimensions,
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
    await requireUserManagedCarrierConnection({
      organizationId,
      provider,
      environment,
    })
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
    if (sanitized.code !== 'CARRIER_DELEGATION_SOURCE_MANAGED') {
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

export type CarrierSandboxShippingRuntime = {
  organizationId: string
  integrationAccountId: string
  integrationGlobalId: string
  credentialVersion: number
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox'
  credential: CarrierRuntimeCredential['credential']
  carrierAccountId: string
  carrierAccountGlobalId: string
  carrierAccountDisplayName: string
  accountNumberLastFour: string
  accountNumberFingerprint: string
  billingRelationship: SandboxBillingSelection['relationship']
  billingSelectionSnapshot: Record<string, unknown>
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
  senderBillingOnly?: boolean
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
  const relationship = input.senderBillingOnly
    ? (() => {
        if (!account.allowSenderBilling) {
          throw new CarrierIntegrationRequestError(
            'The selected carrier account does not allow sender billing',
            409,
            'CARRIER_ACCOUNT_BILLING_NOT_ALLOWED',
          )
        }
        return 'sender' as const
      })()
    : sandboxBillingRelationship(account)
  return {
    account,
    relationship,
    mode,
    snapshot: {
      selectionMode: mode,
      carrierAccountGlobalId: account.globalId,
      carrierAccountDisplayName: account.displayName,
      senderName: account.senderName,
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

function redactedSandboxRateBillingSelection(selection: SandboxBillingSelection) {
  const redacted = { ...selection.snapshot }
  delete redacted.senderName
  delete redacted.registeredAddress
  return redacted
}

export async function resolveCarrierSandboxShippingRuntime(input: {
  organizationId: unknown
  provider: unknown
  carrierAccountGlobalId?: unknown
  senderBillingOnly?: boolean
}): Promise<CarrierSandboxShippingRuntime> {
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    if (provider !== 'ups_rest' && provider !== 'fedex_rest') {
      throw new CarrierIntegrationRequestError(
        'Sandbox label execution is not available for this carrier yet',
        409,
        'CARRIER_SANDBOX_LABEL_UNSUPPORTED',
      )
    }
    const runtime = await storedRuntimeCredential({
      organizationId,
      provider,
      environment: 'sandbox',
    })
    if (runtime.status !== 'active' || !runtime.verified) {
      throw new CarrierIntegrationRequestError(
        'Enable a verified sandbox carrier credential before creating labels',
        409,
        'CARRIER_CREDENTIAL_INACTIVE',
      )
    }
    requiresConfiguredCapability(runtime, 'sandbox_label')
    const selection = await sandboxBillingSelection({
      runtime,
      carrierAccountGlobalId: input.carrierAccountGlobalId,
      senderBillingOnly: input.senderBillingOnly,
    })
    const accountNumber = decryptCarrierAccountNumber(
      selection.account.encrypted,
      runtime.organizationId,
      runtime.provider,
      runtime.environment,
      selection.account.globalId,
    )
    return {
      organizationId: runtime.organizationId,
      integrationAccountId: runtime.integrationAccountId,
      integrationGlobalId: runtime.integrationGlobalId,
      credentialVersion: runtime.credentialVersion,
      provider,
      environment: 'sandbox',
      credential: { ...runtime.credential, accountNumber },
      carrierAccountId: selection.account.id,
      carrierAccountGlobalId: selection.account.globalId,
      carrierAccountDisplayName: selection.account.displayName,
      accountNumberLastFour: selection.account.accountNumberLastFour,
      accountNumberFingerprint: selection.account.accountNumberFingerprint,
      billingRelationship: selection.relationship,
      billingSelectionSnapshot: selection.snapshot,
    }
  } catch (error) {
    throw sanitize(error)
  }
}

export function carrierSandboxRateSelectionRequestHash(
  requestHash: string,
  selection: {
    account: Pick<CarrierRuntimeAccountRecord, 'globalId' | 'accountNumberFingerprint'>
    relationship: SandboxBillingSelection['relationship']
    mode: SandboxBillingSelection['mode']
  },
) {
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
  destination?: unknown
  parcel?: unknown
  actorEmail: string
}) {
  const requestedAt = new Date().toISOString()
  const purpose: CarrierSandboxRatePurpose = input.parcel === undefined
    ? 'sandbox_rate_test'
    : 'cartonization_package_rate'
  let runtime: Awaited<ReturnType<typeof storedRuntimeCredential>> | null = null
  let selection: SandboxBillingSelection | null = null
  let fixture: CarrierSandboxRateFixture | null = null
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
    requiresConfiguredCapability(runtime, 'sandbox_rate')
    selection = await sandboxBillingSelection({
      runtime,
      carrierAccountGlobalId: input.carrierAccountGlobalId,
      senderBillingOnly: true,
    })
    fixture = buildCarrierSandboxRateFixture({
      senderName: selection.account.senderName,
      registeredAddress: selection.account.registeredAddress,
      destination: input.destination,
      parcel: input.parcel,
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
    }, { fixture, purpose })
    const billingSelectionSnapshot = redactedSandboxRateBillingSelection(selection)
    const evidenceGlobalId = await writeCarrierSandboxRateEvidenceInPostgres({
      organizationId: runtime.organizationId,
      integrationAccountId: runtime.integrationAccountId,
      integrationGlobalId: runtime.integrationGlobalId,
      carrierAccountId: selection.account.id,
      carrierAccountGlobalId: selection.account.globalId,
      billingRelationship: selection.relationship,
      billingSelectionSnapshot,
      provider: runtime.provider,
      purpose,
      credentialVersion: runtime.credentialVersion,
      adapterVersion: CARRIER_SANDBOX_RATE_ADAPTER_VERSION,
      requestHash: carrierSandboxRateSelectionRequestHash(rate.evidence.requestHash, selection),
      redactedRequest: {
        ...rate.evidence.redactedRequest,
        billingSelection: billingSelectionSnapshot,
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
      && fixture
      && (runtime.provider === 'ups_rest' || runtime.provider === 'fedex_rest')
    ) {
      const safeRequest = carrierSandboxRateRequestEvidence(
        runtime.provider,
        fixture,
        purpose,
      )
      const billingSelectionSnapshot = redactedSandboxRateBillingSelection(selection)
      try {
        await writeCarrierSandboxRateEvidenceInPostgres({
          organizationId: runtime.organizationId,
          integrationAccountId: runtime.integrationAccountId,
          integrationGlobalId: runtime.integrationGlobalId,
          carrierAccountId: selection.account.id,
          carrierAccountGlobalId: selection.account.globalId,
          billingRelationship: selection.relationship,
          billingSelectionSnapshot,
          provider: runtime.provider,
          purpose,
          credentialVersion: runtime.credentialVersion,
          adapterVersion: CARRIER_SANDBOX_RATE_ADAPTER_VERSION,
          requestHash: carrierSandboxRateSelectionRequestHash(safeRequest.requestHash, selection),
          redactedRequest: {
            ...safeRequest.redactedRequest,
            billingSelection: billingSelectionSnapshot,
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

export async function testCarrierSandboxShipmentRate(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  carrierAccountGlobalId?: unknown
  destination: unknown
  parcels: unknown
  actorEmail: string
  timeoutMs?: number
  signal?: AbortSignal
}) {
  const requestedAt = new Date().toISOString()
  const purpose = 'cartonization_shipment_rate' as const
  let runtime: Awaited<ReturnType<typeof storedRuntimeCredential>> | null = null
  let selection: SandboxBillingSelection | null = null
  let fixture: CarrierSandboxShipmentRateFixture | null = null
  try {
    const organizationId = normalizeCarrierOrganizationId(
      input.organizationId,
    )
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
    runtime = await storedRuntimeCredential({
      organizationId,
      provider,
      environment,
    })
    if (runtime.status !== 'active' || !runtime.verified) {
      throw new CarrierIntegrationRequestError(
        'Enable a verified carrier credential before testing a rate',
        409,
        'CARRIER_CREDENTIAL_INACTIVE',
      )
    }
    requiresConfiguredCapability(runtime, 'sandbox_rate')
    selection = await sandboxBillingSelection({
      runtime,
      carrierAccountGlobalId: input.carrierAccountGlobalId,
      senderBillingOnly: true,
    })
    fixture = buildCarrierSandboxShipmentRateFixture({
      senderName: selection.account.senderName,
      registeredAddress: selection.account.registeredAddress,
      destination: input.destination,
      parcels: input.parcels,
    })
    const accountNumber = decryptCarrierAccountNumber(
      selection.account.encrypted,
      runtime.organizationId,
      runtime.provider,
      runtime.environment,
      selection.account.globalId,
    )
    const rate = await requestCarrierSandboxShipmentRates({
      provider: runtime.provider,
      environment: runtime.environment,
      credential: { ...runtime.credential, accountNumber },
    }, {
      fixture,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    })
    const billingSelectionSnapshot =
      redactedSandboxRateBillingSelection(selection)
    const evidenceGlobalId = await writeCarrierSandboxRateEvidenceInPostgres({
      organizationId: runtime.organizationId,
      integrationAccountId: runtime.integrationAccountId,
      integrationGlobalId: runtime.integrationGlobalId,
      carrierAccountId: selection.account.id,
      carrierAccountGlobalId: selection.account.globalId,
      billingRelationship: selection.relationship,
      billingSelectionSnapshot,
      provider: runtime.provider,
      purpose,
      credentialVersion: runtime.credentialVersion,
      adapterVersion: CARRIER_SANDBOX_SHIPMENT_RATE_ADAPTER_VERSION,
      requestHash: carrierSandboxRateSelectionRequestHash(
        rate.evidence.requestHash,
        selection,
      ),
      redactedRequest: {
        ...rate.evidence.redactedRequest,
        billingSelection: billingSelectionSnapshot,
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
      && fixture
      && (runtime.provider === 'ups_rest' || runtime.provider === 'fedex_rest')
    ) {
      const safeRequest = carrierSandboxShipmentRateRequestEvidence(
        runtime.provider,
        fixture,
      )
      const billingSelectionSnapshot =
        redactedSandboxRateBillingSelection(selection)
      try {
        await writeCarrierSandboxRateEvidenceInPostgres({
          organizationId: runtime.organizationId,
          integrationAccountId: runtime.integrationAccountId,
          integrationGlobalId: runtime.integrationGlobalId,
          carrierAccountId: selection.account.id,
          carrierAccountGlobalId: selection.account.globalId,
          billingRelationship: selection.relationship,
          billingSelectionSnapshot,
          provider: runtime.provider,
          purpose,
          credentialVersion: runtime.credentialVersion,
          adapterVersion: CARRIER_SANDBOX_SHIPMENT_RATE_ADAPTER_VERSION,
          requestHash: carrierSandboxRateSelectionRequestHash(
            safeRequest.requestHash,
            selection,
          ),
          redactedRequest: {
            ...safeRequest.redactedRequest,
            billingSelection: billingSelectionSnapshot,
          },
          redactedResponse: {
            rateScope: 'multi_package_shipment',
            packageCount: fixture.parcels.length,
            errorCode: sanitized.code,
          },
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
    await requireUserManagedCarrierConnection({
      organizationId,
      provider,
      environment,
    })
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
    const dimensions = {
      organizationId: normalizeCarrierOrganizationId(input.organizationId),
      provider: normalizeDirectCarrierProvider(input.provider),
      environment: normalizeCarrierEnvironment(input.environment),
    }
    await requireUserManagedCarrierConnection(dimensions)
    return disconnectCarrierCredentialInPostgres({
      ...dimensions,
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitize(error)
  }
}
