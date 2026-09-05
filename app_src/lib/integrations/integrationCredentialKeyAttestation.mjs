import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

export const INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERSION =
  'integration-credential-key-attestation-v1'
export const INTEGRATION_CREDENTIAL_KEY_ATTESTATION_TABLE =
  'operations_integration_credential_key_attestations'
export const INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERIFICATION_FAILED =
  'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERIFICATION_FAILED'
export const INTEGRATION_CREDENTIAL_KEY_ATTESTATION_CONFIGURATION_INVALID =
  'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_CONFIGURATION_INVALID'

const SENTINEL_MAGIC = 'clawpilot:integration-credential-key-attestation'
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MINIMUM_KEY_LENGTH = 32
const CHALLENGE_BYTES = 32

export class IntegrationCredentialKeyAttestationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'IntegrationCredentialKeyAttestationError'
    this.code = code
  }
}

function configurationError() {
  return new IntegrationCredentialKeyAttestationError(
    INTEGRATION_CREDENTIAL_KEY_ATTESTATION_CONFIGURATION_INVALID,
    'Integration credential key attestation configuration is invalid',
  )
}

function verificationError() {
  return new IntegrationCredentialKeyAttestationError(
    INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERIFICATION_FAILED,
    'Integration credential key attestation verification failed',
  )
}

function environmentValue(environment, name) {
  return String(environment?.[name] || '')
}

export function integrationCredentialHostedRuntime(
  environment = process.env,
) {
  return Boolean(
    environment?.RAILWAY_ENVIRONMENT_NAME
    || environment?.RAILWAY_ENVIRONMENT_ID
    || environment?.RAILWAY_PROJECT_ID
    || environment?.RAILWAY_ENVIRONMENT
    || environment?.VERCEL,
  )
}

export function normalizeIntegrationCredentialKeyId(value) {
  const keyId = String(value || '').trim()
  if (!KEY_ID_PATTERN.test(keyId)) throw configurationError()
  return keyId
}

export function normalizeIntegrationCredentialDatabaseIdentity(value) {
  const databaseIdentity = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(databaseIdentity)) throw configurationError()
  return databaseIdentity
}

function normalizeKeyMaterial(value) {
  const keyMaterial = typeof value === 'string' ? value : ''
  if (keyMaterial.length < MINIMUM_KEY_LENGTH) throw configurationError()
  return keyMaterial
}

export function deriveIntegrationCredentialEncryptionKey(keyMaterial) {
  return createHash('sha256')
    .update(normalizeKeyMaterial(keyMaterial), 'utf8')
    .digest()
}

/**
 * Resolves the historical local key precedence used by commerce, carrier, and
 * brokered-transport credential encryption. Hosted runtime paths require the
 * dedicated integration key. The legacy hosted agent-key fallback is exposed
 * only through an explicit adoption-only option. Secret accessors are
 * deliberately non-enumerable, so JSON/log serialization exposes only the
 * non-secret configuration summary.
 */
export function resolveIntegrationCredentialEncryptionKeyConfig(
  options = {},
) {
  const environment = options.environment || process.env
  const hosted = options.hosted === undefined
    ? integrationCredentialHostedRuntime(environment)
    : Boolean(options.hosted)
  const integrationKey = environmentValue(
    environment,
    'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY',
  )
  const agentKey = environmentValue(
    environment,
    'AGENT_CREDENTIAL_ENCRYPTION_KEY',
  )
  const sessionKey = environmentValue(environment, 'APP_SESSION_SECRET')
  const allowHostedLegacyAgentFallback = (
    hosted
    && options.allowHostedLegacyAgentFallback === true
  )
  const keyMaterial = integrationKey
    || (!hosted || allowHostedLegacyAgentFallback ? agentKey : '')
    || (!hosted ? sessionKey : '')
  const mode = integrationKey
    ? 'integration'
    : hosted && agentKey && allowHostedLegacyAgentFallback
      ? 'hosted_legacy_adoption_agent_fallback'
      : agentKey
      ? 'agent_fallback'
      : 'local_session_fallback'
  normalizeKeyMaterial(keyMaterial)

  const configuredKeyId = environmentValue(
    environment,
    'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID',
  ).trim()
  const requireKeyId = options.requireKeyId === undefined
    ? true
    : Boolean(options.requireKeyId)
  const keyId = configuredKeyId
    || (!hosted && !requireKeyId ? 'local-legacy-v1' : '')
  normalizeIntegrationCredentialKeyId(keyId)

  const summary = { hosted, mode, keyId }
  Object.defineProperties(summary, {
    getKeyMaterial: {
      enumerable: false,
      value() {
        return keyMaterial
      },
    },
    getDerivedKey: {
      enumerable: false,
      value() {
        return deriveIntegrationCredentialEncryptionKey(keyMaterial)
      },
    },
  })
  return Object.freeze(summary)
}

function uint32(value) {
  const output = Buffer.allocUnsafe(4)
  output.writeUInt32BE(value)
  return output
}

function lengthPrefixed(parts) {
  const chunks = []
  for (const value of parts) {
    const part = Buffer.isBuffer(value)
      ? value
      : Buffer.from(String(value), 'utf8')
    chunks.push(uint32(part.byteLength), part)
  }
  return Buffer.concat(chunks)
}

export function integrationCredentialKeyAttestationAuthenticatedData(input) {
  const databaseIdentity = normalizeIntegrationCredentialDatabaseIdentity(
    input?.databaseIdentity,
  )
  const keyId = normalizeIntegrationCredentialKeyId(input?.keyId)
  const version = String(
    input?.attestationVersion
    || INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERSION,
  )
  if (version !== INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERSION) {
    throw configurationError()
  }
  return lengthPrefixed([
    SENTINEL_MAGIC,
    version,
    databaseIdentity,
    keyId,
  ])
}

function sentinelPayload(input, challenge) {
  return lengthPrefixed([
    SENTINEL_MAGIC,
    input.attestationVersion,
    input.databaseIdentity,
    input.keyId,
    challenge,
  ])
}

function parseLengthPrefixed(value, expectedParts) {
  const parts = []
  let offset = 0
  while (offset < value.byteLength) {
    if (value.byteLength - offset < 4) throw verificationError()
    const length = value.readUInt32BE(offset)
    offset += 4
    if (length > value.byteLength - offset) throw verificationError()
    parts.push(value.subarray(offset, offset + length))
    offset += length
  }
  if (parts.length !== expectedParts) throw verificationError()
  return parts
}

function asBuffer(value, expectedLength, minimumLength = expectedLength) {
  const output = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : null
  if (
    !output
    || output.byteLength < minimumLength
    || (expectedLength !== null && output.byteLength !== expectedLength)
  ) {
    throw verificationError()
  }
  return output
}

export function createIntegrationCredentialKeyAttestation(input) {
  const databaseIdentity = normalizeIntegrationCredentialDatabaseIdentity(
    input?.databaseIdentity,
  )
  const keyId = normalizeIntegrationCredentialKeyId(input?.keyId)
  const key = deriveIntegrationCredentialEncryptionKey(input?.keyMaterial)
  const attestationVersion = INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERSION
  const randomSource = input?.randomBytes || randomBytes
  let challenge
  let plaintext
  try {
    challenge = asBuffer(randomSource(CHALLENGE_BYTES), CHALLENGE_BYTES)
    const iv = asBuffer(randomSource(12), 12)
    const aad = integrationCredentialKeyAttestationAuthenticatedData({
      attestationVersion,
      databaseIdentity,
      keyId,
    })
    plaintext = sentinelPayload({
      attestationVersion,
      databaseIdentity,
      keyId,
    }, challenge)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    return Object.freeze({
      attestationVersion,
      databaseIdentity,
      keyId,
      sentinelCiphertext: ciphertext,
      sentinelIv: iv,
      sentinelTag: tag,
    })
  } finally {
    key.fill(0)
    challenge?.fill(0)
    plaintext?.fill(0)
  }
}

function recordField(record, camelName, snakeName) {
  return record?.[camelName] ?? record?.[snakeName]
}

function normalizeAttestationRecord(record) {
  const singletonId = Number(recordField(record, 'singletonId', 'singleton_id'))
  const attestationVersion = String(recordField(
    record,
    'attestationVersion',
    'attestation_version',
  ) || '')
  const databaseIdentity = normalizeIntegrationCredentialDatabaseIdentity(
    recordField(record, 'databaseIdentity', 'database_identity'),
  )
  const keyId = normalizeIntegrationCredentialKeyId(
    recordField(record, 'keyId', 'key_id'),
  )
  const bootstrapMode = String(recordField(
    record,
    'bootstrapMode',
    'bootstrap_mode',
  ) || '')
  const adoptionEvidenceSha256 = recordField(
    record,
    'adoptionEvidenceSha256',
    'adoption_evidence_sha256',
  )
  const createdBy = String(recordField(record, 'createdBy', 'created_by') || '')
  const createdAtValue = recordField(record, 'createdAt', 'created_at')
  const createdAt = createdAtValue instanceof Date
    ? createdAtValue.toISOString()
    : new Date(String(createdAtValue || '')).toISOString()
  if (
    singletonId !== 1
    || attestationVersion !== INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERSION
    || !['empty', 'reviewed_adoption'].includes(bootstrapMode)
    || !createdBy
    || (bootstrapMode === 'empty' && adoptionEvidenceSha256 != null)
    || (
      bootstrapMode === 'reviewed_adoption'
      && !SHA256_PATTERN.test(String(adoptionEvidenceSha256 || ''))
    )
  ) {
    throw verificationError()
  }
  return {
    singletonId,
    attestationVersion,
    databaseIdentity,
    keyId,
    sentinelCiphertext: asBuffer(
      recordField(record, 'sentinelCiphertext', 'sentinel_ciphertext'),
      null,
      32,
    ),
    sentinelIv: asBuffer(
      recordField(record, 'sentinelIv', 'sentinel_iv'),
      12,
    ),
    sentinelTag: asBuffer(
      recordField(record, 'sentinelTag', 'sentinel_tag'),
      16,
    ),
    bootstrapMode,
    adoptionEvidenceSha256: adoptionEvidenceSha256 == null
      ? null
      : String(adoptionEvidenceSha256),
    createdBy,
    createdAt,
  }
}

export function integrationCredentialKeyAttestationRecordDigest(record) {
  try {
    const normalized = normalizeAttestationRecord(record)
    return createHash('sha256').update(lengthPrefixed([
      String(normalized.singletonId),
      normalized.attestationVersion,
      normalized.databaseIdentity,
      normalized.keyId,
      normalized.sentinelCiphertext,
      normalized.sentinelIv,
      normalized.sentinelTag,
      normalized.bootstrapMode,
      normalized.adoptionEvidenceSha256 || '',
      normalized.createdBy,
      normalized.createdAt,
    ])).digest('hex')
  } catch {
    throw verificationError()
  }
}

export function verifyIntegrationCredentialKeyAttestationRecord(input) {
  let plaintext
  try {
    const record = normalizeAttestationRecord(input?.record)
    const databaseIdentity = normalizeIntegrationCredentialDatabaseIdentity(
      input?.expectedDatabaseIdentity,
    )
    const keyId = normalizeIntegrationCredentialKeyId(input?.keyId)
    if (
      record.databaseIdentity !== databaseIdentity
      || record.keyId !== keyId
    ) {
      throw verificationError()
    }
    const key = deriveIntegrationCredentialEncryptionKey(input?.keyMaterial)
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        record.sentinelIv,
      )
      decipher.setAAD(integrationCredentialKeyAttestationAuthenticatedData({
        attestationVersion: record.attestationVersion,
        databaseIdentity: record.databaseIdentity,
        keyId: record.keyId,
      }))
      decipher.setAuthTag(record.sentinelTag)
      const chunks = []
      try {
        chunks.push(decipher.update(record.sentinelCiphertext))
        chunks.push(decipher.final())
        plaintext = Buffer.concat(chunks)
      } finally {
        chunks.forEach((chunk) => chunk.fill(0))
      }
    } finally {
      key.fill(0)
    }
    const [magicPart, versionPart, databasePart, keyIdPart, challengePart] =
      parseLengthPrefixed(plaintext, 5)
    const expected = [
      SENTINEL_MAGIC,
      record.attestationVersion,
      record.databaseIdentity,
      record.keyId,
    ].map((value) => Buffer.from(value, 'utf8'))
    const actual = [magicPart, versionPart, databasePart, keyIdPart]
    for (const [index, expectedPart] of expected.entries()) {
      if (
        actual[index].byteLength !== expectedPart.byteLength
        || !timingSafeEqual(
          actual[index],
          expectedPart,
        )
      ) {
        throw verificationError()
      }
    }
    if (challengePart.byteLength !== CHALLENGE_BYTES) throw verificationError()
    return Object.freeze({
      status: 'verified',
      keyId: record.keyId,
      recordDigest: integrationCredentialKeyAttestationRecordDigest(record),
      databaseIdentity: record.databaseIdentity,
    })
  } catch {
    throw verificationError()
  } finally {
    plaintext?.fill(0)
  }
}

function explicitConfig(options) {
  if (typeof options.secret !== 'string' || options.keyId === undefined) {
    return null
  }
  const keyMaterial = normalizeKeyMaterial(options.secret)
  const keyId = normalizeIntegrationCredentialKeyId(options.keyId)
  return { keyId, getKeyMaterial: () => keyMaterial }
}

export async function verifyIntegrationCredentialKeyAttestation(options) {
  try {
    if (!options?.client || typeof options.client.query !== 'function') {
      throw verificationError()
    }
    const expectedDatabaseIdentity =
      normalizeIntegrationCredentialDatabaseIdentity(
        options.expectedDatabaseIdentity,
      )
    const config = explicitConfig(options)
      || resolveIntegrationCredentialEncryptionKeyConfig({
        environment: options.environment,
        hosted: options.hosted,
        requireKeyId: true,
      })
    const result = await options.client.query(
      `SELECT singleton_id, attestation_version,
              database_identity::text AS database_identity, key_id,
              sentinel_ciphertext, sentinel_iv, sentinel_tag,
              bootstrap_mode, adoption_evidence_sha256,
              created_by, created_at
       FROM operations_integration_credential_key_attestations
       WHERE singleton_id = 1`,
    )
    if (!result || result.rows?.length !== 1) throw verificationError()
    return verifyIntegrationCredentialKeyAttestationRecord({
      record: result.rows[0],
      expectedDatabaseIdentity,
      keyId: config.keyId,
      keyMaterial: config.getKeyMaterial(),
    })
  } catch {
    throw verificationError()
  }
}
