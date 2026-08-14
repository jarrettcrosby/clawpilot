import { createHash } from 'node:crypto'
import {
  CarrierCredentialClientError,
  verifyCarrierCredential,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'
import {
  carrierConfigurationAllowsSandboxLabel,
  isSourceManagedCarrierConfiguration,
  managedCarrierDelegationAllows,
  managedCarrierDelegationProfile,
} from '@/lib/integrations/carrierManagedDelegation'
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
export { carrierSandboxRateDestinationFingerprint } from '@/lib/integrations/carrierSandboxRate'
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
  readCarrierConnectionAuthorizationFromPostgres,
  readCarrierIntegrationsStateFromPostgres,
  readCarrierRuntimeCredentialFromPostgres,
  setCarrierAccountStatusInPostgres,
  setCarrierProductionLabelCapabilityInPostgres,
  setCarrierIntegrationEnabledInPostgres,
  updateCarrierAccountInPostgres,
  writeCarrierSandboxRateEvidenceInPostgres,
  writeCarrierCredentialInPostgres,
  type CarrierRuntimeAccountRecord,
} from '@/lib/persistence/carrierIntegrations'

const CARRIER_SANDBOX_RATE_ADAPTER_VERSION = 'direct-rest-v3'
const CARRIER_SANDBOX_SHIPMENT_RATE_ADAPTER_VERSION =
  'direct-rest-multi-package-v1'
export class CarrierIntegrationRequestError extends Error {
  readonly status: number
  readonly code: string
  readonly rateEvidenceGlobalId: string | null

  constructor(
    message: string,
    status = 400,
    code = 'CARRIER_REQUEST_INVALID',
    rateEvidenceGlobalId: string | null = null,
  ) {
    super(message)
    this.name = 'CarrierIntegrationRequestError'
    this.status = status
    this.code = code
    this.rateEvidenceGlobalId = rateEvidenceGlobalId
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
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'CARRIER_PRODUCTION_LABEL_NOT_READY'
    && 'status' in error
    && error.status === 409
  ) {
    const safeMessage = 'message' in error && typeof error.message === 'string'
      ? error.message
      : 'Live postage setup is not ready'
    return new CarrierIntegrationRequestError(
      safeMessage,
      409,
      'CARRIER_PRODUCTION_LABEL_NOT_READY',
    )
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

export function carrierProductionLabelAuthorizationAllowed(
  environment: Record<string, string | undefined> = process.env,
) {
  const rawMarkers = [
    environment.CLAWPILOT_ENV,
    environment.RAILWAY_ENVIRONMENT_NAME,
    environment.VERCEL_ENV,
    environment.RAILWAY_ENVIRONMENT,
  ]
  const markers = rawMarkers
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  const nonProductionMarkers = new Set([
    'dev',
    'development',
    'local',
    'preview',
    'sandbox',
    'staging',
    'test',
    'testing',
  ])
  if (markers.some((value) => nonProductionMarkers.has(value))) return false
  const canonicalMarker = rawMarkers
    .map((value) => String(value || '').trim().toLowerCase())
    .find(Boolean)
  return canonicalMarker === 'production'
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
  credentialFingerprint: string
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
    credentialFingerprint: stored.credentialFingerprint,
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
  capability: 'sandbox_rate' | 'sandbox_label' | 'production_rate' | 'production_label',
) {
  const configured = runtime.configuration.allowedCapabilities
  if (isSourceManagedCarrierConfiguration(runtime.configuration)) {
    if (!managedCarrierDelegationAllows(runtime.configuration, capability)) {
      const profile = managedCarrierDelegationProfile(runtime.configuration)
      throw new CarrierIntegrationRequestError(
        profile === 'drifted'
          ? 'This managed carrier rating connection requires repair'
          : capability === 'production_rate'
            ? 'This managed carrier connection is not authorized for production rating'
            : capability === 'production_label'
              ? 'Managed carrier delegation never authorizes live postage purchase'
              : 'This carrier connection is authorized for sandbox rating only',
        403,
        'CARRIER_CAPABILITY_NOT_AUTHORIZED',
      )
    }
    return
  }
  if (!Array.isArray(configured)) {
    if (capability !== 'production_rate' && capability !== 'production_label') return
    throw new CarrierIntegrationRequestError(
      capability === 'production_label'
        ? 'This carrier connection is not authorized for live label purchase'
        : 'This carrier connection is not authorized for production rating',
      403,
      'CARRIER_CAPABILITY_NOT_AUTHORIZED',
    )
  }
  if (!configured.includes(capability)) {
    throw new CarrierIntegrationRequestError(
      capability === 'sandbox_rate'
        ? 'This carrier connection is not authorized for sandbox rating'
        : capability === 'production_rate'
          ? 'This carrier connection is not authorized for production rating'
          : capability === 'production_label'
            ? 'This carrier connection is not authorized for live label purchase'
            : 'This carrier connection is authorized for sandbox rating only',
      403,
      'CARRIER_CAPABILITY_NOT_AUTHORIZED',
    )
  }
}

export async function assertCarrierRateTestArtifactCapability(input: {
  organizationId: unknown
  integrationAccountId: unknown
  provider: unknown
}) {
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const integrationAccountId = String(input.integrationAccountId || '').trim()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      integrationAccountId,
    )) {
      throw new CarrierIntegrationRequestError(
        'The carrier connection that created this test label is unavailable',
        403,
        'CARRIER_CAPABILITY_NOT_AUTHORIZED',
      )
    }
    const provider = normalizeDirectCarrierProvider(input.provider)
    const stored = await readCarrierConnectionAuthorizationFromPostgres({
      organizationId,
      integrationAccountId,
    })
    if (
      !stored
      || stored.provider !== provider
      || stored.environment !== 'sandbox'
      || stored.status !== 'active'
    ) {
      throw new CarrierIntegrationRequestError(
        'The carrier connection that created this test label is unavailable',
        403,
        'CARRIER_CAPABILITY_NOT_AUTHORIZED',
      )
    }
    if (!carrierConfigurationAllowsSandboxLabel(stored.configuration)) {
      throw new CarrierIntegrationRequestError(
        isSourceManagedCarrierConfiguration(stored.configuration)
          && managedCarrierDelegationProfile(stored.configuration) === 'drifted'
          ? 'This managed carrier connection requires repair'
          : 'This carrier connection is authorized for sandbox rating only',
        403,
        'CARRIER_CAPABILITY_NOT_AUTHORIZED',
      )
    }
  } catch (error) {
    throw sanitize(error)
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
  credentialFingerprint: string
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox'
  credential: CarrierRuntimeCredential['credential'] & { accountNumber: string }
  carrierAccountId: string
  carrierAccountGlobalId: string
  carrierAccountDisplayName: string
  accountNumberLastFour: string
  accountNumberFingerprint: string
  billingRelationship: SandboxBillingSelection['relationship']
  billingSelectionSnapshot: Record<string, unknown>
}

export type CarrierProductionRatingRuntime = {
  organizationId: string
  integrationAccountId: string
  integrationGlobalId: string
  credentialVersion: number
  credentialFingerprint: string
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'production'
  credential: CarrierRuntimeCredential['credential'] & { accountNumber: string }
  carrierAccountId: string
  carrierAccountGlobalId: string
  carrierAccountDisplayName: string
  senderName: string
  registeredAddress: CarrierRuntimeAccountRecord['registeredAddress']
  registeredAddressFingerprint: string
  accountNumberLastFour: string
  accountNumberFingerprint: string
  billingRelationship: 'sender'
}

/**
 * Resolve one exact, active, verified production rating binding. This only
 * releases credentials to the server-side read-only rerate executor; callers
 * still must persist and validate a production rerate attempt before I/O.
 */
export async function resolveCarrierProductionRatingRuntime(input: {
  organizationId: unknown
  provider: unknown
  integrationAccountGlobalId: unknown
  carrierAccountGlobalId: unknown
}): Promise<CarrierProductionRatingRuntime> {
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    if (provider !== 'ups_rest' && provider !== 'fedex_rest') {
      throw new CarrierIntegrationRequestError(
        'Production whole-shipment rating is not available for this carrier',
        409,
        'CARRIER_PRODUCTION_RATE_UNSUPPORTED',
      )
    }
    const integrationAccountGlobalId = String(
      input.integrationAccountGlobalId || '',
    ).trim()
    const carrierAccountGlobalId = normalizeCarrierAccountGlobalId(
      input.carrierAccountGlobalId,
    )
    const runtime = await storedRuntimeCredential({
      organizationId,
      provider,
      environment: 'production',
    })
    if (
      runtime.integrationGlobalId !== integrationAccountGlobalId
      || runtime.status !== 'active'
      || !runtime.verified
    ) {
      throw new CarrierIntegrationRequestError(
        'The selected production carrier credential is not active and verified',
        409,
        'CARRIER_CREDENTIAL_INACTIVE',
      )
    }
    requiresConfiguredCapability(runtime, 'production_rate')
    const accounts = await readActiveCarrierAccountsFromPostgres({
      organizationId,
      integrationAccountId: runtime.integrationAccountId,
    })
    const account = accounts.find(
      (candidate) => candidate.globalId === carrierAccountGlobalId,
    )
    if (!account) {
      throw new CarrierIntegrationRequestError(
        'The selected production carrier account is not active',
        409,
        'CARRIER_ACCOUNT_REQUIRED',
      )
    }
    if (!account.allowSenderBilling) {
      throw new CarrierIntegrationRequestError(
        'Production whole-shipment rating currently requires sender billing',
        409,
        'CARRIER_ACCOUNT_BILLING_NOT_ALLOWED',
      )
    }
    const accountNumber = decryptCarrierAccountNumber(
      account.encrypted,
      organizationId,
      provider,
      'production',
      account.globalId,
    )
    return {
      organizationId,
      integrationAccountId: runtime.integrationAccountId,
      integrationGlobalId: runtime.integrationGlobalId,
      credentialVersion: runtime.credentialVersion,
      credentialFingerprint: runtime.credentialFingerprint,
      provider,
      environment: 'production',
      credential: { ...runtime.credential, accountNumber },
      carrierAccountId: account.id,
      carrierAccountGlobalId: account.globalId,
      carrierAccountDisplayName: account.displayName,
      senderName: account.senderName,
      registeredAddress: account.registeredAddress,
      registeredAddressFingerprint: account.registeredAddressFingerprint,
      accountNumberLastFour: account.accountNumberLastFour,
      accountNumberFingerprint: account.accountNumberFingerprint,
      billingRelationship: 'sender',
    }
  } catch (error) {
    throw sanitize(error)
  }
}

/**
 * Resolve a production Ship binding. `production_label` is deliberately a
 * second capability in addition to read-only `production_rate`; reconnecting
 * or verifying a production credential never silently authorizes postage.
 */
export async function resolveCarrierProductionShippingRuntime(input: {
  organizationId: unknown
  provider: unknown
  integrationAccountGlobalId: unknown
  carrierAccountGlobalId: unknown
}): Promise<CarrierProductionRatingRuntime> {
  try {
    if (!carrierProductionLabelAuthorizationAllowed()) {
      throw new CarrierIntegrationRequestError(
        'Production label purchase is disabled outside the production deployment',
        403,
        'CARRIER_PRODUCTION_LABEL_ENVIRONMENT_FORBIDDEN',
      )
    }
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    const runtime = await storedRuntimeCredential({
      organizationId,
      provider,
      environment: 'production',
    })
    if (runtime.status !== 'active' || !runtime.verified) {
      throw new CarrierIntegrationRequestError(
        'The selected production carrier credential is not active and verified',
        409,
        'CARRIER_CREDENTIAL_INACTIVE',
      )
    }
    requiresConfiguredCapability(runtime, 'production_label')
    return await resolveCarrierProductionRatingRuntime(input)
  } catch (error) {
    throw sanitize(error)
  }
}

/**
 * Resolve the exact account needed to cancel an already purchased one-off
 * shipment. Revoking the purchase capability must stop new postage, but must
 * not strand a paid label. Cancellation therefore requires a current active,
 * verified credential and the same active sender account without rechecking
 * the label-purchase capability flag.
 */
export async function resolveCarrierOneOffVoidRuntime(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  integrationAccountGlobalId: unknown
  carrierAccountGlobalId: unknown
}): Promise<CarrierSandboxShippingRuntime | (CarrierProductionRatingRuntime & {
  billingSelectionSnapshot: Record<string, unknown>
})> {
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    const environment = normalizeCarrierEnvironment(input.environment)
    if (provider !== 'ups_rest' && provider !== 'fedex_rest') {
      throw new CarrierIntegrationRequestError(
        'Whole-shipment cancellation is available only for UPS and FedEx',
        409,
        'CARRIER_ONE_OFF_VOID_UNSUPPORTED',
      )
    }
    const integrationAccountGlobalId = String(
      input.integrationAccountGlobalId || '',
    ).trim()
    const carrierAccountGlobalId = normalizeCarrierAccountGlobalId(
      input.carrierAccountGlobalId,
    )
    const runtime = await storedRuntimeCredential({
      organizationId,
      provider,
      environment,
    })
    if (
      runtime.integrationGlobalId !== integrationAccountGlobalId
      || runtime.status !== 'active'
      || !runtime.verified
    ) {
      throw new CarrierIntegrationRequestError(
        'Reconnect and verify the original carrier credential before cancelling this shipment',
        409,
        'CARRIER_ONE_OFF_VOID_CREDENTIAL_UNAVAILABLE',
      )
    }
    const accounts = await readActiveCarrierAccountsFromPostgres({
      organizationId,
      integrationAccountId: runtime.integrationAccountId,
    })
    const account = accounts.find(
      (candidate) => candidate.globalId === carrierAccountGlobalId,
    )
    if (!account || !account.allowSenderBilling) {
      throw new CarrierIntegrationRequestError(
        'Restore the original active sender account before cancelling this shipment',
        409,
        'CARRIER_ONE_OFF_VOID_ACCOUNT_UNAVAILABLE',
      )
    }
    const accountNumber = decryptCarrierAccountNumber(
      account.encrypted,
      organizationId,
      provider,
      environment,
      account.globalId,
    )
    const common = {
      organizationId,
      integrationAccountId: runtime.integrationAccountId,
      integrationGlobalId: runtime.integrationGlobalId,
      credentialVersion: runtime.credentialVersion,
      credentialFingerprint: runtime.credentialFingerprint,
      provider,
      environment,
      credential: { ...runtime.credential, accountNumber },
      carrierAccountId: account.id,
      carrierAccountGlobalId: account.globalId,
      carrierAccountDisplayName: account.displayName,
      accountNumberLastFour: account.accountNumberLastFour,
      accountNumberFingerprint: account.accountNumberFingerprint,
      billingRelationship: 'sender' as const,
      billingSelectionSnapshot: {
        mode: 'original_one_off_shipment_account',
        carrierAccountGlobalId: account.globalId,
        registeredAddressFingerprint: account.registeredAddressFingerprint,
      },
    }
    return environment === 'production'
      ? {
          ...common,
          environment,
          senderName: account.senderName,
          registeredAddress: account.registeredAddress,
          registeredAddressFingerprint: account.registeredAddressFingerprint,
        }
      : { ...common, environment }
  } catch (error) {
    throw sanitize(error)
  }
}

export async function setCarrierProductionLabelEnabled(input: {
  organizationId: unknown
  provider: unknown
  enabled: unknown
  reason: unknown
  actorEmail: string
}) {
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    if (provider !== 'ups_rest' && provider !== 'fedex_rest') {
      throw new CarrierIntegrationRequestError(
        'Live postage is available only for UPS and FedEx production connections',
        409,
        'CARRIER_PRODUCTION_LABEL_UNSUPPORTED',
      )
    }
    if (input.enabled === true && !carrierProductionLabelAuthorizationAllowed()) {
      throw new CarrierIntegrationRequestError(
        'Production label purchase cannot be authorized from a development deployment',
        403,
        'CARRIER_PRODUCTION_LABEL_ENVIRONMENT_FORBIDDEN',
      )
    }
    const reason = String(input.reason || '').trim()
    if (typeof input.enabled !== 'boolean' || reason.length < 3 || reason.length > 500) {
      throw new CarrierIntegrationRequestError(
        'A valid live-postage authorization decision and reason are required',
      )
    }
    return await setCarrierProductionLabelCapabilityInPostgres({
      organizationId,
      provider,
      enabled: input.enabled,
      reason,
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitize(error)
  }
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
      credentialFingerprint: runtime.credentialFingerprint,
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
  requireFailureEvidence?: boolean
  carrierSelectionKey?: string | null
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
      carrierSelectionKey: input.carrierSelectionKey || null,
    })
    return {
      ...rate.result,
      carrierAccountGlobalId: selection.account.globalId,
      billingRelationship: selection.relationship,
      evidenceGlobalId,
    }
  } catch (error) {
    const sanitized = sanitize(error)
    let rateEvidenceGlobalId: string | null = null
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
        rateEvidenceGlobalId =
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
          carrierSelectionKey: input.carrierSelectionKey || null,
          })
      } catch {
        if (
          input.requireFailureEvidence === true
          || input.actorEmail === 'system:shopify-carrier-service'
        ) {
          throw new CarrierIntegrationRequestError(
            'Carrier shipment-rate failure evidence could not be persisted',
            503,
            'CARRIER_RATE_EVIDENCE_PERSISTENCE_FAILED',
          )
        }
        // Diagnostic callers retain the original provider error when evidence
        // storage is not contractually required.
      }
    }
    throw new CarrierIntegrationRequestError(
      sanitized.message,
      sanitized.status,
      sanitized.code,
      rateEvidenceGlobalId,
    )
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
