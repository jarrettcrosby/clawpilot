import crypto from 'node:crypto'

export type BrokeredTransportProvider = 'wwex_speedship' | 'rl_carriers'
export type BrokeredTransportEnvironment = 'sandbox' | 'production'

export type WwexSpeedshipCredential = {
  authKind: 'oauth_client_credentials'
  clientId: string
  clientSecret: string
  audience: string
}

export type RlCarriersCredential = {
  authKind: 'api_key'
  apiKey: string
}

export type BrokeredTransportCredential =
  | WwexSpeedshipCredential
  | RlCarriersCredential

export type EncryptedBrokeredTransportCredential = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

function printable(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be ${minimum}-${maximum} printable ASCII characters`)
  }
  const normalized = value.trim()
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || !PRINTABLE_ASCII.test(normalized)
  ) {
    throw new Error(`${label} must be ${minimum}-${maximum} printable ASCII characters`)
  }
  return normalized
}

export function normalizeBrokeredTransportProvider(
  value: unknown,
): BrokeredTransportProvider {
  if (value === 'wwex_speedship' || value === 'rl_carriers') return value
  throw new Error('Transport provider must be Worldwide Express or R+L Carriers')
}

export function normalizeBrokeredTransportEnvironment(
  providerValue: unknown,
  value: unknown,
): BrokeredTransportEnvironment {
  const provider = normalizeBrokeredTransportProvider(providerValue)
  if (value !== 'sandbox' && value !== 'production') {
    throw new Error('Transport environment must be sandbox or production')
  }
  if (provider === 'rl_carriers' && value !== 'production') {
    throw new Error('R+L has not supplied a sandbox API environment')
  }
  return value
}

function organizationId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID.test(normalized)) throw new Error('A valid organization is required')
  return normalized
}

export function normalizeBrokeredTransportCredential(
  providerValue: unknown,
  value: unknown,
): BrokeredTransportCredential {
  const provider = normalizeBrokeredTransportProvider(providerValue)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Transport credential must be an object')
  }
  const input = value as Record<string, unknown>
  if (provider === 'wwex_speedship') {
    const unexpected = Object.keys(input).find((key) => ![
      'authKind', 'clientId', 'clientSecret', 'audience',
    ].includes(key))
    if (unexpected) {
      throw new Error(`Worldwide Express credential field ${unexpected} is not supported`)
    }
    if (input.authKind !== 'oauth_client_credentials') {
      throw new Error('Worldwide Express requires OAuth client credentials')
    }
    return {
      authKind: 'oauth_client_credentials',
      clientId: printable(input.clientId, 'Worldwide Express client ID', 3, 512),
      clientSecret: printable(
        input.clientSecret,
        'Worldwide Express client secret',
        8,
        4096,
      ),
      audience: printable(input.audience, 'Worldwide Express audience', 3, 512),
    }
  }
  const unexpected = Object.keys(input).find((key) => ![
    'authKind', 'apiKey',
  ].includes(key))
  if (unexpected) {
    throw new Error(`R+L credential field ${unexpected} is not supported`)
  }
  if (input.authKind !== 'api_key') {
    throw new Error('R+L requires an API key')
  }
  return {
    authKind: 'api_key',
    apiKey: printable(input.apiKey, 'R+L API key', 8, 4096),
  }
}

function encryptionKey() {
  const dedicated = String(
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
    || process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY
    || '',
  )
  const hosted = Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.RAILWAY_ENVIRONMENT_ID
    || process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.VERCEL,
  )
  if (hosted && dedicated.length < 32) {
    throw new Error('Transport credential encryption is not configured')
  }
  const secret = dedicated || String(process.env.APP_SESSION_SECRET || '')
  if (secret.length < 32) {
    throw new Error('Transport credential encryption is not configured')
  }
  return crypto.createHash('sha256').update(secret).digest()
}

function authenticatedData(
  organizationValue: unknown,
  providerValue: unknown,
  environmentValue: unknown,
) {
  const organization = organizationId(organizationValue)
  const provider = normalizeBrokeredTransportProvider(providerValue)
  const environment = normalizeBrokeredTransportEnvironment(
    provider,
    environmentValue,
  )
  return Buffer.from(
    `clawpilot:brokered-transport:${organization}:${provider}:${environment}:credential:v1`,
    'utf8',
  )
}

export function brokeredTransportCredentialIdentifierLastFour(
  providerValue: unknown,
  credentialValue: unknown,
) {
  const provider = normalizeBrokeredTransportProvider(providerValue)
  const credential = normalizeBrokeredTransportCredential(provider, credentialValue)
  const identifier = credential.authKind === 'oauth_client_credentials'
    ? credential.clientId
    : credential.apiKey
  return identifier.slice(-4)
}

/**
 * Creates the server-keyed request identity for the credential-storage
 * command. This is intentionally not a credential fingerprint: it exists only
 * to make one browser command replayable without persisting an offline-
 * guessable digest of an API key or client secret.
 */
export function brokeredTransportCredentialCommandRequestHash(
  organizationValue: unknown,
  providerValue: unknown,
  environmentValue: unknown,
  displayNameValue: unknown,
  credentialValue: unknown,
) {
  const provider = normalizeBrokeredTransportProvider(providerValue)
  const environment = normalizeBrokeredTransportEnvironment(
    provider,
    environmentValue,
  )
  const credential = normalizeBrokeredTransportCredential(
    provider,
    credentialValue,
  )
  if (typeof displayNameValue !== 'string') {
    throw new Error('Transport connection name is invalid')
  }
  const displayName = displayNameValue.trim().replace(/\s+/g, ' ')
  if (
    displayName.length < 2
    || displayName.length > 120
    || /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw new Error('Transport connection name is invalid')
  }
  const requestKey = crypto
    .createHmac('sha256', encryptionKey())
    .update('clawpilot:brokered-transport:credential-command-request:v1', 'utf8')
    .digest()
  return crypto
    .createHmac('sha256', requestKey)
    .update(authenticatedData(
      organizationValue,
      provider,
      environment,
    ))
    .update('\0', 'utf8')
    .update(JSON.stringify({
      provider,
      environment,
      displayName,
      credential,
    }), 'utf8')
    .digest('hex')
}

/**
 * Produces the persistence-safe identity for a WWEX billing account. The raw
 * account number is still used only in the ephemeral provider request; an
 * unkeyed digest would permit offline guessing of short numeric accounts.
 */
export function wwexSpeedshipBillingAccountFingerprint(
  organizationValue: unknown,
  environmentValue: unknown,
  accountNumberValue: unknown,
) {
  const accountNumber = printable(
    accountNumberValue,
    'Worldwide Express billing account number',
    3,
    64,
  )
  const key = crypto
    .createHmac('sha256', encryptionKey())
    .update('clawpilot:wwex-speedship:billing-account-fingerprint:v1', 'utf8')
    .digest()
  return crypto
    .createHmac('sha256', key)
    .update(authenticatedData(
      organizationValue,
      'wwex_speedship',
      environmentValue,
    ))
    .update(accountNumber, 'utf8')
    .digest('hex')
}

export function encryptBrokeredTransportCredential(
  credentialValue: unknown,
  organizationValue: unknown,
  providerValue: unknown,
  environmentValue: unknown,
): EncryptedBrokeredTransportCredential {
  const provider = normalizeBrokeredTransportProvider(providerValue)
  const credential = normalizeBrokeredTransportCredential(provider, credentialValue)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(authenticatedData(
    organizationValue,
    provider,
    environmentValue,
  ))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final(),
  ])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

export function decryptBrokeredTransportCredential(
  encrypted: EncryptedBrokeredTransportCredential,
  organizationValue: unknown,
  providerValue: unknown,
  environmentValue: unknown,
) {
  try {
    const provider = normalizeBrokeredTransportProvider(providerValue)
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), encrypted.iv)
    decipher.setAAD(authenticatedData(
      organizationValue,
      provider,
      environmentValue,
    ))
    decipher.setAuthTag(encrypted.tag)
    const value = JSON.parse(Buffer.concat([
      decipher.update(encrypted.ciphertext),
      decipher.final(),
    ]).toString('utf8'))
    return normalizeBrokeredTransportCredential(provider, value)
  } catch {
    throw new Error('Stored transport credential could not be decrypted')
  }
}
