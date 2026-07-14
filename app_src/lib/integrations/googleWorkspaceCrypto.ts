import crypto from 'node:crypto'

const TOKEN_URI = 'https://oauth2.googleapis.com/token'
const AUTH_URI = 'https://accounts.google.com/o/oauth2/auth'
const AUTH_PROVIDER_CERT_URL = 'https://www.googleapis.com/oauth2/v1/certs'
const GOOGLE_UNIVERSE_DOMAIN = 'googleapis.com'
const MAX_SERVICE_ACCOUNT_JSON_BYTES = 64 * 1024
const SERVICE_ACCOUNT_FIELDS = new Set([
  'type',
  'project_id',
  'private_key_id',
  'private_key',
  'client_email',
  'client_id',
  'token_uri',
  'auth_uri',
  'auth_provider_x509_cert_url',
  'client_x509_cert_url',
  'universe_domain',
])

export type GoogleServiceAccountCredential = {
  type: 'service_account'
  project_id: string
  private_key_id: string
  private_key: string
  client_email: string
  client_id: string
  token_uri: typeof TOKEN_URI
}

export type EncryptedGoogleWorkspaceSecret = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

function encryptionKey(): Buffer {
  const secret = String(process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY || '')
  if (secret.length < 32) throw new Error('Google Workspace credential encryption is not configured')
  return crypto.createHash('sha256').update(secret).digest()
}

function aad(kind: 'api-key' | 'service-account') {
  return Buffer.from(`clawpilot:google-workspace:platform:${kind}:v1`, 'utf8')
}

function encrypt(value: string, kind: 'api-key' | 'service-account'): EncryptedGoogleWorkspaceSecret {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(aad(kind))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

function decrypt(fields: EncryptedGoogleWorkspaceSecret, kind: 'api-key' | 'service-account') {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), fields.iv)
    decipher.setAAD(aad(kind))
    decipher.setAuthTag(fields.tag)
    return Buffer.concat([decipher.update(fields.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Stored Google Workspace credential could not be decrypted')
  }
}

export function normalizeGoogleApiKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A Google API key is required')
  const apiKey = value.trim()
  if (apiKey.length < 20 || apiKey.length > 512 || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('Google API key must be 20-512 printable ASCII characters')
  }
  return apiKey
}

function serviceAccountObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_SERVICE_ACCOUNT_JSON_BYTES) {
      throw new Error('Service-account JSON is too large')
    }
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      return parsed as Record<string, unknown>
    } catch {
      throw new Error('Service-account JSON must be a valid JSON object')
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Service-account JSON must be an object or JSON string')
  }
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SERVICE_ACCOUNT_JSON_BYTES) {
    throw new Error('Service-account JSON is too large')
  }
  return value as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, field: string, maxLength: number) {
  const value = typeof input[field] === 'string' ? input[field].trim() : ''
  if (!value || value.length > maxLength) throw new Error(`Service-account ${field} is invalid`)
  return value
}

function optionalExactString(
  input: Record<string, unknown>,
  field: string,
  expected: string,
) {
  if (!Object.hasOwn(input, field)) return
  if (typeof input[field] !== 'string' || input[field] !== expected) {
    throw new Error(`Service-account ${field} is invalid`)
  }
}

function validateOptionalClientCertificateUrl(input: Record<string, unknown>, clientEmail: string) {
  if (!Object.hasOwn(input, 'client_x509_cert_url')) return
  if (typeof input.client_x509_cert_url !== 'string' || input.client_x509_cert_url.length > 1024) {
    throw new Error('Service-account client_x509_cert_url is invalid')
  }
  try {
    const url = new URL(input.client_x509_cert_url)
    const prefix = '/robot/v1/metadata/x509/'
    const encodedEmail = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
    if (
      url.origin !== 'https://www.googleapis.com'
      || url.username
      || url.password
      || url.search
      || url.hash
      || decodeURIComponent(encodedEmail).toLowerCase() !== clientEmail
    ) {
      throw new Error('invalid URL')
    }
  } catch {
    throw new Error('Service-account client_x509_cert_url is invalid')
  }
}

export function normalizeGoogleServiceAccount(value: unknown): GoogleServiceAccountCredential {
  const input = serviceAccountObject(value)
  const unsupported = Object.keys(input).find((field) => !SERVICE_ACCOUNT_FIELDS.has(field))
  if (unsupported) throw new Error(`Unsupported service-account field: ${unsupported}`)
  if (input.type !== 'service_account') throw new Error('Google credential type must be service_account')

  const projectId = requiredString(input, 'project_id', 63).toLowerCase()
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    throw new Error('Service-account project_id is invalid')
  }
  const privateKeyId = requiredString(input, 'private_key_id', 128)
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(privateKeyId)) {
    throw new Error('Service-account private_key_id is invalid')
  }
  const clientEmail = requiredString(input, 'client_email', 254).toLowerCase()
  if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.iam\.gserviceaccount\.com$/i.test(clientEmail)) {
    throw new Error('Service-account client_email is invalid')
  }
  const clientId = requiredString(input, 'client_id', 64)
  if (!/^\d{6,64}$/.test(clientId)) throw new Error('Service-account client_id is invalid')
  const tokenUri = requiredString(input, 'token_uri', 200)
  if (tokenUri !== TOKEN_URI) throw new Error(`Service-account token_uri must be ${TOKEN_URI}`)
  optionalExactString(input, 'auth_uri', AUTH_URI)
  optionalExactString(input, 'auth_provider_x509_cert_url', AUTH_PROVIDER_CERT_URL)
  optionalExactString(input, 'universe_domain', GOOGLE_UNIVERSE_DOMAIN)
  validateOptionalClientCertificateUrl(input, clientEmail)

  const privateKey = requiredString(input, 'private_key', 16 * 1024).replace(/\r\n/g, '\n')
  if (!privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n') || !privateKey.endsWith('\n-----END PRIVATE KEY-----')) {
    throw new Error('Service-account private_key must be a PKCS#8 private key')
  }
  try {
    crypto.createPrivateKey(privateKey)
  } catch {
    throw new Error('Service-account private_key is invalid')
  }

  return {
    type: 'service_account',
    project_id: projectId,
    private_key_id: privateKeyId,
    private_key: privateKey,
    client_email: clientEmail,
    client_id: clientId,
    token_uri: TOKEN_URI,
  }
}

export function encryptGoogleApiKey(value: unknown) {
  return encrypt(normalizeGoogleApiKey(value), 'api-key')
}

export function decryptGoogleApiKey(fields: EncryptedGoogleWorkspaceSecret) {
  return normalizeGoogleApiKey(decrypt(fields, 'api-key'))
}

export function encryptGoogleServiceAccount(value: unknown) {
  const credential = normalizeGoogleServiceAccount(value)
  return encrypt(JSON.stringify(credential), 'service-account')
}

export function decryptGoogleServiceAccount(fields: EncryptedGoogleWorkspaceSecret) {
  return normalizeGoogleServiceAccount(decrypt(fields, 'service-account'))
}
