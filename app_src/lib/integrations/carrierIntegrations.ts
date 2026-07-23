import {
  CarrierCredentialClientError,
  verifyCarrierCredential,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'
import {
  decryptCarrierCredential,
  encryptCarrierCredential,
  normalizeCarrierAccountNumber,
  normalizeCarrierClientId,
  normalizeCarrierClientSecret,
  normalizeCarrierEnvironment,
  normalizeCarrierOrganizationId,
  normalizeDirectCarrierProvider,
} from '@/lib/integrations/carrierCredentialCrypto'
import {
  disconnectCarrierCredentialInPostgres,
  markCarrierCredentialVerificationInPostgres,
  readCarrierIntegrationsStateFromPostgres,
  readCarrierRuntimeCredentialFromPostgres,
  setCarrierIntegrationEnabledInPostgres,
  writeCarrierCredentialInPostgres,
} from '@/lib/persistence/carrierIntegrations'

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
    throw new CarrierIntegrationRequestError('Carrier account name must be 1-120 characters')
  }
  return normalized
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
}): Promise<CarrierRuntimeCredential & { status: 'active' | 'disabled' | 'error'; verified: boolean }> {
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
  return {
    provider,
    environment,
    credential: decryptCarrierCredential(stored.encrypted, organizationId, provider, environment),
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

export async function updateCarrierCredential(input: {
  organizationId: unknown
  provider: unknown
  environment: unknown
  displayName?: unknown
  clientId: unknown
  clientSecret: unknown
  accountNumber?: unknown
  actorEmail: string
}) {
  try {
    const organizationId = normalizeCarrierOrganizationId(input.organizationId)
    const provider = normalizeDirectCarrierProvider(input.provider)
    const environment = normalizeCarrierEnvironment(input.environment)
    const credential = {
      clientId: normalizeCarrierClientId(input.clientId),
      clientSecret: normalizeCarrierClientSecret(input.clientSecret),
      accountNumber: normalizeCarrierAccountNumber(input.accountNumber, provider),
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
      accountNumberLastFour: credential.accountNumber?.slice(-4) || null,
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
