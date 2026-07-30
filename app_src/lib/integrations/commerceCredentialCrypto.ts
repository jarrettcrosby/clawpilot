import crypto from 'node:crypto'
import { isHostedRuntime } from '@/lib/persistence/config'

export type CommerceProvider = 'shopify' | 'faire'
export type CommerceEnvironment = 'sandbox' | 'production'
export type CommerceAuthMode =
  | 'shopify_client_credentials'
  | 'faire_brand_token'
  | 'faire_oauth'

export type ShopifyCommerceCredential = {
  provider: 'shopify'
  authMode: 'shopify_client_credentials'
  clientId: string
  clientSecret: string
}

export type FaireBrandTokenCommerceCredential = {
  provider: 'faire'
  authMode: 'faire_brand_token'
  accessToken: string
}

export type FaireOAuthCommerceCredential = {
  provider: 'faire'
  authMode: 'faire_oauth'
  applicationId: string
  applicationSecret: string
  accessToken: string
  scopes: string[]
}

export type FaireCommerceCredential =
  | FaireBrandTokenCommerceCredential
  | FaireOAuthCommerceCredential

export type FaireOAuthPendingCredential = {
  applicationId: string
  applicationSecret: string
}

export type CommerceCredentialPayload =
  | ShopifyCommerceCredential
  | FaireCommerceCredential

export type EncryptedCommerceValue = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

export type CommerceIntakeContinuationPayload = {
  orderCursor: string
}

export type CommerceIntakeReadResultPayload = {
  envelope: Record<string, unknown>
  page: Record<string, unknown>
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

function normalizeCommerceCredentialGeneration(value: unknown) {
  const generation = Number(value)
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('A valid commerce credential generation is required')
  }
  return generation
}

export function normalizeCommerceAuthMode(
  value: unknown,
  providerValue: unknown,
): CommerceAuthMode {
  const provider = normalizeCommerceProvider(providerValue)
  const allowed: CommerceAuthMode[] = provider === 'shopify'
    ? ['shopify_client_credentials']
    : ['faire_brand_token', 'faire_oauth']
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

export function normalizeFaireApplicationId(value: unknown) {
  return printable(
    value,
    'Faire application ID',
    1,
    255,
  )
}

export function normalizeFaireApplicationSecret(value: unknown) {
  return printable(value, 'Faire Secret ID', 16, 4096)
}

export function normalizeFaireOAuthScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new Error('Faire OAuth scopes must contain 1-10 permissions')
  }
  const scopes = value.map((scope) => {
    const normalized = printable(scope, 'Faire OAuth scope', 3, 64)
    if (!/^[A-Z][A-Z_]+$/.test(normalized)) {
      throw new Error('Faire OAuth scope is invalid')
    }
    return normalized
  })
  if (new Set(scopes).size !== scopes.length) {
    throw new Error('Faire OAuth scopes must not contain duplicates')
  }
  return scopes
}

export function normalizeFaireOAuthPendingCredential(
  value: FaireOAuthPendingCredential,
): FaireOAuthPendingCredential {
  return {
    applicationId: normalizeFaireApplicationId(value.applicationId),
    applicationSecret: normalizeFaireApplicationSecret(
      value.applicationSecret,
    ),
  }
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

  if (authMode === 'faire_oauth') {
    const input = value as FaireOAuthCommerceCredential
    return {
      provider,
      authMode,
      applicationId: normalizeFaireApplicationId(input.applicationId),
      applicationSecret: normalizeFaireApplicationSecret(
        input.applicationSecret,
      ),
      accessToken: printable(
        input.accessToken,
        'Provider access token',
        8,
        8192,
      ),
      scopes: normalizeFaireOAuthScopes(input.scopes),
    }
  }

  const input = value as FaireBrandTokenCommerceCredential
  return {
    provider,
    authMode: 'faire_brand_token',
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

function normalizedCheckoutDestinationPart(
  value: unknown,
  casing: 'lower' | 'upper',
) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
  return casing === 'upper'
    ? normalized.toUpperCase()
    : normalized.toLowerCase()
}

/**
 * Produces the customer-neutral destination identity shared by the live
 * CarrierService callback and the later Shopify order-intake record. The
 * plaintext address is never retained at the checkout boundary.
 */
export function shopifyCheckoutDestinationFingerprint(input: {
  countryCode?: unknown
  postalCode?: unknown
  provinceCode?: unknown
  city?: unknown
  address1?: unknown
  address2?: unknown
}) {
  const canonical = {
    version: 'shopify-destination-fingerprint-v1',
    countryCode: normalizedCheckoutDestinationPart(
      input.countryCode,
      'upper',
    ),
    postalCode: normalizedCheckoutDestinationPart(
      input.postalCode,
      'upper',
    ),
    provinceCode:
      normalizedCheckoutDestinationPart(input.provinceCode, 'upper') || null,
    city: normalizedCheckoutDestinationPart(input.city, 'lower') || null,
    address1:
      normalizedCheckoutDestinationPart(input.address1, 'lower') || null,
    address2:
      normalizedCheckoutDestinationPart(input.address2, 'lower') || null,
  }
  if (
    !canonical.countryCode
    || !canonical.postalCode
  ) {
    throw new Error(
      'Shopify checkout destination fingerprint requires country and postal code',
    )
  }
  return crypto
    .createHmac('sha256', encryptionKey())
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex')
}

/**
 * Shopify CarrierService callbacks do not include a Shopify signature. Keep
 * the account-specific callback URL unguessable instead. The token is derived
 * from the current credential generation, so rotating the app credential
 * invalidates the prior callback URL without retaining another plaintext
 * secret in Postgres.
 */
export function shopifyCarrierServiceCallbackToken(input: {
  organizationId: unknown
  accountGlobalId: unknown
  credentialGeneration: unknown
  callbackTokenVersion: unknown
}) {
  const organizationId = normalizeCommerceOrganizationId(
    input.organizationId,
  )
  const accountGlobalId = normalizeCommerceAccountGlobalId(
    input.accountGlobalId,
  )
  const credentialGeneration = normalizeCommerceCredentialGeneration(
    input.credentialGeneration,
  )
  const callbackTokenVersion = normalizeCommerceCredentialGeneration(
    input.callbackTokenVersion,
  )
  return crypto
    .createHmac('sha256', encryptionKey())
    .update(
      [
        'clawpilot',
        'shopify',
        'carrier-service-callback',
        'v1',
        organizationId,
        accountGlobalId,
        credentialGeneration,
        callbackTokenVersion,
      ].join(':'),
    )
    .digest('base64url')
}

export function shopifyCarrierServiceCallbackTokenMatches(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
    credentialGeneration: unknown
    callbackTokenVersion: unknown
  },
  tokenValue: unknown,
) {
  const supplied = String(tokenValue || '').trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false
  const expected = shopifyCarrierServiceCallbackToken(input)
  return crypto.timingSafeEqual(
    Buffer.from(supplied, 'ascii'),
    Buffer.from(expected, 'ascii'),
  )
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

function oauthInstallationAuthenticatedData(
  organizationIdValue: unknown,
  browserSessionIdValue: unknown,
  stateHashValue: unknown,
) {
  const organizationId = normalizeCommerceOrganizationId(organizationIdValue)
  const browserSessionId = String(browserSessionIdValue || '')
    .trim()
    .toLowerCase()
  if (!UUID_PATTERN.test(browserSessionId)) {
    throw new Error('A valid browser session is required')
  }
  const stateHash = String(stateHashValue || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(stateHash)) {
    throw new Error('Faire OAuth state digest is invalid')
  }
  return Buffer.from(
    `clawpilot:commerce:${organizationId}:faire:${browserSessionId}:${stateHash}:oauth-installation:v1`,
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

function candidateSnapshotAuthenticatedData(
  organizationIdValue: unknown,
  accountGlobalIdValue: unknown,
  externalOrderIdValue: unknown,
  sourceHashValue: unknown,
  kindValue: unknown,
) {
  const organizationId = normalizeCommerceOrganizationId(organizationIdValue)
  const accountGlobalId = normalizeCommerceAccountGlobalId(accountGlobalIdValue)
  const externalOrderId = printable(
    externalOrderIdValue,
    'External order identity',
    1,
    512,
  )
  const sourceHash = String(sourceHashValue || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) {
    throw new Error('Commerce candidate source digest is invalid')
  }
  const kind = String(kindValue || '').trim()
  if (kind !== 'party' && kind !== 'ship_to') {
    throw new Error('Commerce candidate snapshot kind is invalid')
  }
  return Buffer.from(
    `clawpilot:commerce:${organizationId}:${accountGlobalId}:${externalOrderId}:${sourceHash}:${kind}:candidate-snapshot:v1`,
    'utf8',
  )
}

function intakeContinuationAuthenticatedData(
  organizationIdValue: unknown,
  accountGlobalIdValue: unknown,
  providerValue: unknown,
  sessionIdValue: unknown,
  batchNumberValue: unknown,
  queryHashValue: unknown,
) {
  const organizationId = normalizeCommerceOrganizationId(organizationIdValue)
  const accountGlobalId = normalizeCommerceAccountGlobalId(accountGlobalIdValue)
  const provider = normalizeCommerceProvider(providerValue)
  const sessionId = String(sessionIdValue || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error('Commerce intake continuation session is invalid')
  }
  const batchNumber = Number(batchNumberValue)
  if (
    !Number.isSafeInteger(batchNumber)
    || batchNumber < 1
    || batchNumber > 1_000_000
  ) {
    throw new Error('Commerce intake continuation batch is invalid')
  }
  const queryHash = String(queryHashValue || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(queryHash)) {
    throw new Error('Commerce intake continuation query digest is invalid')
  }
  return Buffer.from(
    `clawpilot:commerce:${organizationId}:${accountGlobalId}:${provider}:${sessionId}:${batchNumber}:${queryHash}:intake-continuation:v1`,
    'utf8',
  )
}

function intakeReadResultAuthenticatedData(
  organizationIdValue: unknown,
  accountGlobalIdValue: unknown,
  providerValue: unknown,
  intentIdValue: unknown,
  providerAttemptIdValue: unknown,
  requestHashValue: unknown,
) {
  const organizationId = normalizeCommerceOrganizationId(organizationIdValue)
  const accountGlobalId = normalizeCommerceAccountGlobalId(accountGlobalIdValue)
  const provider = normalizeCommerceProvider(providerValue)
  const intentId = String(intentIdValue || '').trim().toLowerCase()
  const providerAttemptId = String(providerAttemptIdValue || '')
    .trim()
    .toLowerCase()
  if (!UUID_PATTERN.test(intentId) || !UUID_PATTERN.test(providerAttemptId)) {
    throw new Error('Commerce intake read evidence identity is invalid')
  }
  const requestHash = String(requestHashValue || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(requestHash)) {
    throw new Error('Commerce intake read request digest is invalid')
  }
  return Buffer.from(
    `clawpilot:commerce:${organizationId}:${accountGlobalId}:${provider}:${intentId}:${providerAttemptId}:${requestHash}:intake-read-result:v1`,
    'utf8',
  )
}

function encodeCommerceIntakeReadResult(
  value: CommerceIntakeReadResultPayload,
) {
  if (
    !value
    || typeof value !== 'object'
    || !value.envelope
    || typeof value.envelope !== 'object'
    || Array.isArray(value.envelope)
    || !value.page
    || typeof value.page !== 'object'
    || Array.isArray(value.page)
  ) {
    throw new Error('Commerce intake read result is invalid')
  }
  return Buffer.from(JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint'
      ? { __clawpilotCommerceBigIntV1: item.toString() }
      : item
  )), 'utf8')
}

function decodeCommerceIntakeReadResult(
  payload: Buffer,
): CommerceIntakeReadResultPayload {
  const value = JSON.parse(payload.toString('utf8'), (_key, item) => {
    const marker = item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>).__clawpilotCommerceBigIntV1
      : null
    if (
      item
      && typeof item === 'object'
      && !Array.isArray(item)
      && Object.keys(item).length === 1
      && typeof marker === 'string'
      && /^-?[0-9]+$/.test(marker)
    ) {
      return BigInt(marker)
    }
    return item
  }) as CommerceIntakeReadResultPayload
  if (
    !value
    || typeof value !== 'object'
    || !value.envelope
    || typeof value.envelope !== 'object'
    || Array.isArray(value.envelope)
    || !value.page
    || typeof value.page !== 'object'
    || Array.isArray(value.page)
  ) {
    throw new Error('invalid read result')
  }
  return value
}

function normalizeCommerceIntakeContinuation(
  value: CommerceIntakeContinuationPayload,
): CommerceIntakeContinuationPayload {
  return {
    orderCursor: printable(
      value?.orderCursor,
      'Commerce intake provider cursor',
      1,
      4096,
    ),
  }
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

export function encryptFaireOAuthPendingCredential(
  credentialValue: FaireOAuthPendingCredential,
  organizationId: unknown,
  browserSessionId: unknown,
  stateHash: unknown,
): EncryptedCommerceValue {
  const credential = normalizeFaireOAuthPendingCredential(credentialValue)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(oauthInstallationAuthenticatedData(
    organizationId,
    browserSessionId,
    stateHash,
  ))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final(),
  ])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

export function decryptFaireOAuthPendingCredential(
  fields: EncryptedCommerceValue,
  organizationId: unknown,
  browserSessionId: unknown,
  stateHash: unknown,
): FaireOAuthPendingCredential {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      fields.iv,
    )
    decipher.setAAD(oauthInstallationAuthenticatedData(
      organizationId,
      browserSessionId,
      stateHash,
    ))
    decipher.setAuthTag(fields.tag)
    const raw = Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ]).toString('utf8')
    return normalizeFaireOAuthPendingCredential(
      JSON.parse(raw) as FaireOAuthPendingCredential,
    )
  } catch {
    throw new Error('Stored Faire OAuth installation could not be decrypted')
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

export function encryptCommerceCandidateSnapshot(
  value: Record<string, unknown>,
  organizationId: unknown,
  accountGlobalId: unknown,
  externalOrderId: unknown,
  sourceHash: unknown,
  kind: 'party' | 'ship_to',
): EncryptedCommerceValue & { hash: string; encryptionVersion: 1 } {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  if (payload.byteLength < 2 || payload.byteLength > 65_536) {
    throw new Error('Commerce candidate snapshot must be 2-65536 bytes')
  }
  const iv = crypto.randomBytes(12)
  const key = encryptionKey()
  const authenticatedData = candidateSnapshotAuthenticatedData(
    organizationId,
    accountGlobalId,
    externalOrderId,
    sourceHash,
    kind,
  )
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(authenticatedData)
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    hash: crypto.createHmac('sha256', key)
      .update('clawpilot:commerce:candidate-snapshot-digest:v1\0', 'utf8')
      .update(authenticatedData)
      .update(payload)
      .digest('hex'),
    encryptionVersion: 1,
  }
}

export function decryptCommerceCandidateSnapshot(
  fields: EncryptedCommerceValue,
  organizationId: unknown,
  accountGlobalId: unknown,
  externalOrderId: unknown,
  sourceHash: unknown,
  kind: 'party' | 'ship_to',
): Record<string, unknown> {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      fields.iv,
    )
    decipher.setAAD(candidateSnapshotAuthenticatedData(
      organizationId,
      accountGlobalId,
      externalOrderId,
      sourceHash,
      kind,
    ))
    decipher.setAuthTag(fields.tag)
    const value = JSON.parse(Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ]).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid snapshot')
    }
    return value as Record<string, unknown>
  } catch {
    throw new Error('Stored commerce candidate snapshot could not be decrypted')
  }
}

export function encryptCommerceIntakeReadResult(
  value: CommerceIntakeReadResultPayload,
  organizationId: unknown,
  accountGlobalId: unknown,
  provider: unknown,
  intentId: unknown,
  providerAttemptId: unknown,
  requestHash: unknown,
): EncryptedCommerceValue & {
  hash: string
  bytes: number
  encryptionVersion: 1
} {
  const payload = encodeCommerceIntakeReadResult(value)
  if (payload.byteLength < 2 || payload.byteLength > 8_388_608) {
    throw new Error(
      'Commerce intake read result must be 2-8388608 bytes',
    )
  }
  const iv = crypto.randomBytes(12)
  const key = encryptionKey()
  const authenticatedData = intakeReadResultAuthenticatedData(
    organizationId,
    accountGlobalId,
    provider,
    intentId,
    providerAttemptId,
    requestHash,
  )
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(authenticatedData)
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    hash: crypto.createHmac('sha256', key)
      .update('clawpilot:commerce:intake-read-result-digest:v1\0', 'utf8')
      .update(authenticatedData)
      .update(payload)
      .digest('hex'),
    bytes: payload.byteLength,
    encryptionVersion: 1,
  }
}

export function decryptCommerceIntakeReadResult(
  fields: EncryptedCommerceValue,
  organizationId: unknown,
  accountGlobalId: unknown,
  provider: unknown,
  intentId: unknown,
  providerAttemptId: unknown,
  requestHash: unknown,
  expectedHash?: unknown,
): CommerceIntakeReadResultPayload {
  try {
    const key = encryptionKey()
    const authenticatedData = intakeReadResultAuthenticatedData(
      organizationId,
      accountGlobalId,
      provider,
      intentId,
      providerAttemptId,
      requestHash,
    )
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      fields.iv,
    )
    decipher.setAAD(authenticatedData)
    decipher.setAuthTag(fields.tag)
    const payload = Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ])
    if (expectedHash !== undefined) {
      const normalizedExpectedHash = String(expectedHash || '')
        .trim()
        .toLowerCase()
      const computedHash = crypto.createHmac('sha256', key)
        .update('clawpilot:commerce:intake-read-result-digest:v1\0', 'utf8')
        .update(authenticatedData)
        .update(payload)
        .digest('hex')
      if (
        !/^[a-f0-9]{64}$/.test(normalizedExpectedHash)
        || !crypto.timingSafeEqual(
          Buffer.from(computedHash, 'hex'),
          Buffer.from(normalizedExpectedHash, 'hex'),
        )
      ) {
        throw new Error('read result digest mismatch')
      }
    }
    return decodeCommerceIntakeReadResult(payload)
  } catch {
    throw new Error(
      'Stored commerce intake read result could not be decrypted',
    )
  }
}

export function encryptCommerceIntakeContinuation(
  value: CommerceIntakeContinuationPayload,
  organizationId: unknown,
  accountGlobalId: unknown,
  provider: unknown,
  sessionId: unknown,
  batchNumber: unknown,
  queryHash: unknown,
): EncryptedCommerceValue & { hash: string; encryptionVersion: 1 } {
  const normalized = normalizeCommerceIntakeContinuation(value)
  const payload = Buffer.from(JSON.stringify(normalized), 'utf8')
  if (payload.byteLength < 2 || payload.byteLength > 8192) {
    throw new Error('Commerce intake continuation must be 2-8192 bytes')
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(intakeContinuationAuthenticatedData(
    organizationId,
    accountGlobalId,
    provider,
    sessionId,
    batchNumber,
    queryHash,
  ))
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    hash: crypto.createHash('sha256').update(payload).digest('hex'),
    encryptionVersion: 1,
  }
}

export function decryptCommerceIntakeContinuation(
  fields: EncryptedCommerceValue,
  organizationId: unknown,
  accountGlobalId: unknown,
  provider: unknown,
  sessionId: unknown,
  batchNumber: unknown,
  queryHash: unknown,
): CommerceIntakeContinuationPayload {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      fields.iv,
    )
    decipher.setAAD(intakeContinuationAuthenticatedData(
      organizationId,
      accountGlobalId,
      provider,
      sessionId,
      batchNumber,
      queryHash,
    ))
    decipher.setAuthTag(fields.tag)
    const value = JSON.parse(Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ]).toString('utf8')) as CommerceIntakeContinuationPayload
    return normalizeCommerceIntakeContinuation(value)
  } catch {
    throw new Error('Stored commerce intake continuation could not be decrypted')
  }
}
