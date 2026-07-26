import crypto from 'node:crypto'
import { isHostedRuntime } from '@/lib/persistence/config'

export type CommerceProvider = 'shopify' | 'faire'
export type CommerceEnvironment = 'sandbox' | 'production'
export type CommerceAuthMode =
  | 'shopify_client_credentials'
  | 'faire_brand_token'

export type ShopifyCommerceCredential = {
  provider: 'shopify'
  authMode: 'shopify_client_credentials'
  clientId: string
  clientSecret: string
}

export type FaireCommerceCredential = {
  provider: 'faire'
  authMode: 'faire_brand_token'
  accessToken: string
}

export type CommerceCredentialPayload =
  | ShopifyCommerceCredential
  | FaireCommerceCredential

export type EncryptedCommerceValue = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

export function normalizeCommerceOrganizationId(value: unknown) {
  const organizationId = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(organizationId)) {
    throw new Error('A valid organization is required')
  }
  return organizationId
}

export function normalizeCommerceProvider(value: unknown): CommerceProvider {
  if (value === 'shopify' || value === 'faire') return value
  throw new Error('Commerce provider must be Shopify or Faire')
}

export function normalizeCommerceEnvironment(
  value: unknown,
  providerValue?: unknown,
): CommerceEnvironment {
  const provider = providerValue === undefined
    ? null
    : normalizeCommerceProvider(providerValue)
  if (value !== 'sandbox' && value !== 'production') {
    throw new Error('Commerce environment must be sandbox or production')
  }
  if (provider === 'faire' && value !== 'production') {
    throw new Error('Faire does not provide a public sandbox environment')
  }
  return value
}

export function normalizeCommerceAccountGlobalId(value: unknown) {
  const globalId = String(value || '').trim().toLowerCase()
  if (!/^gia[0-9]{7}$/.test(globalId)) {
    throw new Error('A valid commerce account Global ID is required')
  }
  return globalId
}

export function normalizeCommerceAuthMode(
  value: unknown,
  providerValue: unknown,
): CommerceAuthMode {
  const provider = normalizeCommerceProvider(providerValue)
  const allowed: CommerceAuthMode[] = provider === 'shopify'
    ? ['shopify_client_credentials']
    : ['faire_brand_token']
  if (allowed.includes(value as CommerceAuthMode)) {
    return value as CommerceAuthMode
  }
  throw new Error(`Unsupported ${provider === 'shopify' ? 'Shopify' : 'Faire'} authentication mode`)
}

function printable(value: unknown, label: string, minimum: number, maximum: number) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || !PRINTABLE_ASCII.test(normalized)
  ) {
    throw new Error(
      `${label} must be ${minimum}-${maximum} printable ASCII characters`,
    )
  }
  return normalized
}

export function normalizeCommerceExternalAccountId(value: unknown) {
  return printable(value, 'Provider account identity', 1, 255)
}

export function normalizeCommerceCredential(
  value: CommerceCredentialPayload,
): CommerceCredentialPayload {
  const provider = normalizeCommerceProvider(value.provider)
  const authMode = normalizeCommerceAuthMode(value.authMode, provider)

  if (provider === 'shopify') {
    const input = value as ShopifyCommerceCredential
    return {
      provider,
      authMode: authMode as ShopifyCommerceCredential['authMode'],
      clientId: printable(
        input.clientId,
        'Shopify app client ID',
        8,
        255,
      ),
      clientSecret: printable(
        input.clientSecret,
        'Shopify app client secret',
        16,
        4096,
      ),
    }
  }

  const input = value as FaireCommerceCredential
  return {
    provider,
    authMode: authMode as FaireCommerceCredential['authMode'],
    accessToken: printable(
      input.accessToken,
      'Provider access token',
      8,
      8192,
    ),
  }
}

function encryptionKey() {
  const dedicated = String(
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
    || process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY
    || '',
  )
  if (isHostedRuntime() && dedicated.length < 32) {
    throw new Error('Commerce credential encryption is not configured')
  }
  const secret = dedicated || String(process.env.APP_SESSION_SECRET || '')
  if (secret.length < 32) {
    throw new Error('Commerce credential encryption is not configured')
  }
  return crypto.createHash('sha256').update(secret).digest()
}

function credentialAuthenticatedData(
  organizationIdValue: unknown,
  providerValue: unknown,
  environmentValue: unknown,
  externalAccountIdValue: unknown,
) {
  const organizationId = normalizeCommerceOrganizationId(organizationIdValue)
  const provider = normalizeCommerceProvider(providerValue)
  const environment = normalizeCommerceEnvironment(environmentValue, provider)
  const externalAccountId = normalizeCommerceExternalAccountId(
    externalAccountIdValue,
  )
  return Buffer.from(
    `clawpilot:commerce:${organizationId}:${provider}:${environment}:${externalAccountId}:credential:v1`,
    'utf8',
  )
}

function webhookAuthenticatedData(
  accountGlobalIdValue: unknown,
  providerEventIdValue: unknown,
  topicValue: unknown,
) {
  const accountGlobalId = normalizeCommerceAccountGlobalId(accountGlobalIdValue)
  const providerEventId = printable(
    providerEventIdValue,
    'Provider event ID',
    1,
    255,
  )
  const topic = printable(topicValue, 'Webhook topic', 1, 255)
  return Buffer.from(
    `clawpilot:commerce:${accountGlobalId}:shopify:${providerEventId}:${topic}:webhook:v1`,
    'utf8',
  )
}

export function encryptCommerceCredential(
  credentialValue: CommerceCredentialPayload,
  organizationId: unknown,
  environmentValue: unknown,
  externalAccountId: unknown,
): EncryptedCommerceValue {
  const credential = normalizeCommerceCredential(credentialValue)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(credentialAuthenticatedData(
    organizationId,
    credential.provider,
    environmentValue,
    externalAccountId,
  ))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final(),
  ])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

export function decryptCommerceCredential(
  fields: EncryptedCommerceValue,
  organizationId: unknown,
  providerValue: unknown,
  environmentValue: unknown,
  externalAccountId: unknown,
): CommerceCredentialPayload {
  try {
    const provider = normalizeCommerceProvider(providerValue)
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      fields.iv,
    )
    decipher.setAAD(credentialAuthenticatedData(
      organizationId,
      provider,
      environmentValue,
      externalAccountId,
    ))
    decipher.setAuthTag(fields.tag)
    const raw = Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ]).toString('utf8')
    const credential = normalizeCommerceCredential(
      JSON.parse(raw) as CommerceCredentialPayload,
    )
    if (credential.provider !== provider) throw new Error('provider mismatch')
    return credential
  } catch {
    throw new Error('Stored commerce credential could not be decrypted')
  }
}

export function encryptCommerceWebhookPayload(
  rawPayload: Buffer,
  accountGlobalId: unknown,
  providerEventId: unknown,
  topic: unknown,
): EncryptedCommerceValue {
  if (rawPayload.byteLength < 2 || rawPayload.byteLength > 512 * 1024) {
    throw new Error('Shopify webhook payload must be 2-524288 bytes')
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(webhookAuthenticatedData(
    accountGlobalId,
    providerEventId,
    topic,
  ))
  const ciphertext = Buffer.concat([cipher.update(rawPayload), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

export function decryptCommerceWebhookPayload(
  fields: EncryptedCommerceValue,
  accountGlobalId: unknown,
  providerEventId: unknown,
  topic: unknown,
) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      fields.iv,
    )
    decipher.setAAD(webhookAuthenticatedData(
      accountGlobalId,
      providerEventId,
      topic,
    ))
    decipher.setAuthTag(fields.tag)
    return Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ])
  } catch {
    throw new Error('Stored commerce webhook payload could not be decrypted')
  }
}
