import crypto from 'crypto'
import { isHostedRuntime } from '@/lib/persistence/config'

export type DirectCarrierProvider = 'ups_rest' | 'fedex_rest' | 'usps_rest'
export type CarrierEnvironment = 'sandbox' | 'production'

export type CarrierCredentialPayload = {
  clientId: string
  clientSecret: string
  accountNumber: string | null
}

export type EncryptedCarrierCredential = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

export function normalizeCarrierOrganizationId(value: unknown) {
  const organizationId = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(organizationId)) throw new Error('A valid organization is required')
  return organizationId
}

export function normalizeDirectCarrierProvider(value: unknown): DirectCarrierProvider {
  if (value === 'ups_rest' || value === 'fedex_rest' || value === 'usps_rest') return value
  throw new Error('Carrier provider must be UPS, FedEx, or USPS')
}

export function normalizeCarrierEnvironment(value: unknown): CarrierEnvironment {
  if (value === 'sandbox' || value === 'production') return value
  throw new Error('Carrier environment must be sandbox or production')
}

function printable(value: unknown, label: string, minimum: number, maximum: number) {
  const normalized = String(value || '').trim()
  if (normalized.length < minimum || normalized.length > maximum || !PRINTABLE_ASCII.test(normalized)) {
    throw new Error(`${label} must be ${minimum}-${maximum} printable ASCII characters`)
  }
  return normalized
}

export function normalizeCarrierClientId(value: unknown) {
  return printable(value, 'Carrier client ID', 3, 512)
}

export function normalizeCarrierClientSecret(value: unknown) {
  return printable(value, 'Carrier client secret', 8, 4096)
}

export function normalizeCarrierAccountNumber(
  value: unknown,
  providerValue: unknown,
): string | null {
  const provider = normalizeDirectCarrierProvider(providerValue)
  const raw = String(value || '').trim()
  if (!raw) {
    if (provider === 'ups_rest' || provider === 'fedex_rest') {
      throw new Error('The carrier billing account number is required')
    }
    return null
  }
  return printable(raw, 'Carrier account number', 2, 128)
}

export function normalizeCarrierCredentialPayload(
  value: CarrierCredentialPayload,
  providerValue: unknown,
): CarrierCredentialPayload {
  const provider = normalizeDirectCarrierProvider(providerValue)
  return {
    clientId: normalizeCarrierClientId(value.clientId),
    clientSecret: normalizeCarrierClientSecret(value.clientSecret),
    accountNumber: normalizeCarrierAccountNumber(value.accountNumber, provider),
  }
}

function encryptionKey() {
  const dedicated = String(
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
    || process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY
    || '',
  )
  if (isHostedRuntime() && dedicated.length < 32) {
    throw new Error('Carrier credential encryption is not configured')
  }
  const secret = dedicated || String(process.env.APP_SESSION_SECRET || '')
  if (secret.length < 32) throw new Error('Carrier credential encryption is not configured')
  return crypto.createHash('sha256').update(secret).digest()
}

function authenticatedData(
  organizationIdValue: unknown,
  providerValue: unknown,
  environmentValue: unknown,
) {
  const organizationId = normalizeCarrierOrganizationId(organizationIdValue)
  const provider = normalizeDirectCarrierProvider(providerValue)
  const environment = normalizeCarrierEnvironment(environmentValue)
  return Buffer.from(
    `clawpilot:carrier:${organizationId}:${provider}:${environment}:credential:v1`,
    'utf8',
  )
}

export function encryptCarrierCredential(
  credentialValue: CarrierCredentialPayload,
  organizationId: unknown,
  providerValue: unknown,
  environmentValue: unknown,
): EncryptedCarrierCredential {
  const provider = normalizeDirectCarrierProvider(providerValue)
  const credential = normalizeCarrierCredentialPayload(credentialValue, provider)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(authenticatedData(organizationId, provider, environmentValue))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final(),
  ])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

export function decryptCarrierCredential(
  fields: EncryptedCarrierCredential,
  organizationId: unknown,
  providerValue: unknown,
  environmentValue: unknown,
) {
  try {
    const provider = normalizeDirectCarrierProvider(providerValue)
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), fields.iv)
    decipher.setAAD(authenticatedData(organizationId, provider, environmentValue))
    decipher.setAuthTag(fields.tag)
    const raw = Buffer.concat([decipher.update(fields.ciphertext), decipher.final()]).toString('utf8')
    return normalizeCarrierCredentialPayload(JSON.parse(raw) as CarrierCredentialPayload, provider)
  } catch {
    throw new Error('Stored carrier credential could not be decrypted')
  }
}
