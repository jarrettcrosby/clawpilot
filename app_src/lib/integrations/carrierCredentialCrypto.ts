import crypto from 'crypto'
import { isHostedRuntime } from '@/lib/persistence/config'

export type DirectCarrierProvider = 'ups_rest' | 'fedex_rest' | 'usps_rest'
export type CarrierEnvironment = 'sandbox' | 'production'

export type CarrierCredentialPayload = {
  clientId: string
  clientSecret: string
  accountNumber: string | null
}

export type CarrierAccountAddress = {
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  countryCode: string
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

export function normalizeCarrierAccountGlobalId(value: unknown) {
  const globalId = String(value || '').trim().toLowerCase()
  if (!/^gac[0-9]{7}$/.test(globalId)) {
    throw new Error('A valid carrier account Global ID is required')
  }
  return globalId
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

export function normalizeOptionalCarrierAccountNumber(value: unknown): string | null {
  const raw = String(value || '').trim()
  return raw ? printable(raw, 'Carrier account number', 2, 128) : null
}

export function normalizeCarrierBillingAccountNumber(value: unknown) {
  return printable(value, 'Carrier billing account number', 4, 128)
}

function addressPart(value: unknown, label: string, maximum: number) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must be 1-${maximum} characters`)
  }
  return normalized
}

export function normalizeCarrierAccountAddress(value: unknown): CarrierAccountAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A registered carrier account address is required')
  }
  const input = value as Record<string, unknown>
  const countryCode = String(input.countryCode || 'US').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error('Carrier account country must use a two-letter code')
  }
  const line2 = String(input.line2 || '').trim().replace(/\s+/g, ' ')
  if (line2.length > 120) throw new Error('Carrier account address line 2 must be 120 characters or fewer')
  return {
    line1: addressPart(input.line1, 'Carrier account address line 1', 160),
    line2: line2 || null,
    city: addressPart(input.city, 'Carrier account city', 100),
    region: addressPart(input.region, 'Carrier account region', 100),
    postalCode: addressPart(input.postalCode, 'Carrier account postal code', 32),
    countryCode,
  }
}

export function normalizeCarrierCredentialPayload(
  value: CarrierCredentialPayload,
  providerValue: unknown,
): CarrierCredentialPayload {
  normalizeDirectCarrierProvider(providerValue)
  return {
    clientId: normalizeCarrierClientId(value.clientId),
    clientSecret: normalizeCarrierClientSecret(value.clientSecret),
    accountNumber: normalizeOptionalCarrierAccountNumber(value.accountNumber),
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

function fingerprintKey() {
  return crypto
    .createHmac('sha256', encryptionKey())
    .update('clawpilot:carrier:fingerprint:v1', 'utf8')
    .digest()
}

export function carrierAccountNumberFingerprint(
  organizationIdValue: unknown,
  providerValue: unknown,
  environmentValue: unknown,
  accountNumberValue: unknown,
) {
  const organizationId = normalizeCarrierOrganizationId(organizationIdValue)
  const provider = normalizeDirectCarrierProvider(providerValue)
  const environment = normalizeCarrierEnvironment(environmentValue)
  const accountNumber = normalizeOptionalCarrierAccountNumber(accountNumberValue)
  if (!accountNumber) throw new Error('The carrier billing account number is required')
  return crypto
    .createHmac('sha256', fingerprintKey())
    .update(`${organizationId}:${provider}:${environment}:${accountNumber}`, 'utf8')
    .digest('hex')
}

export function carrierAccountAddressFingerprint(value: unknown) {
  const address = normalizeCarrierAccountAddress(value)
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      line1: address.line1.toLowerCase(),
      line2: address.line2?.toLowerCase() || null,
      city: address.city.toLowerCase(),
      region: address.region.toLowerCase(),
      postalCode: address.postalCode.toLowerCase().replace(/[\s-]/g, ''),
      countryCode: address.countryCode,
    }))
    .digest('hex')
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

function carrierAccountAuthenticatedData(
  organizationIdValue: unknown,
  providerValue: unknown,
  environmentValue: unknown,
  carrierAccountGlobalIdValue: unknown,
) {
  const organizationId = normalizeCarrierOrganizationId(organizationIdValue)
  const provider = normalizeDirectCarrierProvider(providerValue)
  const environment = normalizeCarrierEnvironment(environmentValue)
  const carrierAccountGlobalId = normalizeCarrierAccountGlobalId(carrierAccountGlobalIdValue)
  return Buffer.from(
    `clawpilot:carrier:${organizationId}:${provider}:${environment}:account:${carrierAccountGlobalId}:v1`,
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

export function encryptCarrierAccountNumber(
  accountNumberValue: unknown,
  organizationId: unknown,
  providerValue: unknown,
  environmentValue: unknown,
  carrierAccountGlobalId: unknown,
): EncryptedCarrierCredential {
  const accountNumber = normalizeOptionalCarrierAccountNumber(accountNumberValue)
  if (!accountNumber) throw new Error('The carrier billing account number is required')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(carrierAccountAuthenticatedData(
    organizationId,
    providerValue,
    environmentValue,
    carrierAccountGlobalId,
  ))
  const ciphertext = Buffer.concat([cipher.update(accountNumber, 'utf8'), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

export function decryptCarrierAccountNumber(
  fields: EncryptedCarrierCredential,
  organizationId: unknown,
  providerValue: unknown,
  environmentValue: unknown,
  carrierAccountGlobalId: unknown,
) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), fields.iv)
    decipher.setAAD(carrierAccountAuthenticatedData(
      organizationId,
      providerValue,
      environmentValue,
      carrierAccountGlobalId,
    ))
    decipher.setAuthTag(fields.tag)
    return normalizeOptionalCarrierAccountNumber(
      Buffer.concat([decipher.update(fields.ciphertext), decipher.final()]).toString('utf8'),
    ) as string
  } catch {
    throw new Error('Stored carrier account number could not be decrypted')
  }
}
