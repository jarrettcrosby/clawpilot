const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MINIMUM_KEY_LENGTH = 32

export class CommerceOrderRevisionEvidenceKeyConfigError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CommerceOrderRevisionEvidenceKeyConfigError'
    this.code = code
  }
}

function configurationError(code, message) {
  return new CommerceOrderRevisionEvidenceKeyConfigError(code, message)
}

function environmentValue(environment, name) {
  return String(environment?.[name] || '')
}

export function commerceOrderRevisionEvidenceHostedRuntime(
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

function localLegacyCompatibilityAllowed(environment, hosted) {
  return !hosted
    && environmentValue(
      environment,
      'CLAWPILOT_ALLOW_LEGACY_REVISION_EVIDENCE_KEYS',
    ) === '1'
}

function legacyKeyMaterial(environment) {
  return environmentValue(environment, 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY')
    || environmentValue(environment, 'AGENT_CREDENTIAL_ENCRYPTION_KEY')
    || environmentValue(environment, 'APP_SESSION_SECRET')
}

function parseEncryptionKeyRing(rawRing) {
  let parsed
  try {
    parsed = JSON.parse(rawRing)
  } catch {
    throw configurationError(
      'COMMERCE_ORDER_REVISION_EVIDENCE_KEY_RING_INVALID',
      'Commerce revision evidence encryption keys must be a JSON object',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configurationError(
      'COMMERCE_ORDER_REVISION_EVIDENCE_KEY_RING_INVALID',
      'Commerce revision evidence encryption keys must be a JSON object',
    )
  }

  const keys = new Map()
  for (const [keyId, value] of Object.entries(parsed)) {
    if (
      !KEY_ID_PATTERN.test(keyId)
      || typeof value !== 'string'
      || value.length < MINIMUM_KEY_LENGTH
    ) {
      throw configurationError(
        'COMMERCE_ORDER_REVISION_EVIDENCE_KEY_RING_INVALID',
        'Commerce revision evidence encryption key configuration is invalid',
      )
    }
    keys.set(keyId, value)
  }
  return keys
}

/**
 * Resolve the revision-evidence key configuration without making secret
 * material enumerable. Callers that perform cryptography may use the two
 * explicit key-material accessors; health, logs, and API responses must use
 * summarizeCommerceOrderRevisionEvidenceKeyReadiness instead.
 *
 * Hosted runtimes always require all three dedicated variables. A non-hosted
 * runtime may use the historical integration/agent/session secret only when
 * CLAWPILOT_ALLOW_LEGACY_REVISION_EVIDENCE_KEYS is exactly `1`.
 */
export function resolveCommerceOrderRevisionEvidenceKeyConfig(options = {}) {
  const environment = options.environment || process.env
  const hosted = options.hosted === undefined
    ? commerceOrderRevisionEvidenceHostedRuntime(environment)
    : Boolean(options.hosted)
  const allowLegacy = localLegacyCompatibilityAllowed(environment, hosted)

  const dedicatedFingerprintKey = environmentValue(
    environment,
    'INTEGRATION_EVIDENCE_FINGERPRINT_KEY',
  )
  const legacyKey = legacyKeyMaterial(environment)
  const fingerprintKey = dedicatedFingerprintKey
    || (allowLegacy ? legacyKey : '')
  if (fingerprintKey.length < MINIMUM_KEY_LENGTH) {
    throw configurationError(
      'COMMERCE_ORDER_REVISION_EVIDENCE_FINGERPRINT_KEY_REQUIRED',
      'Commerce revision evidence requires a dedicated fingerprint key',
    )
  }

  const configuredActiveKeyId = environmentValue(
    environment,
    'INTEGRATION_EVIDENCE_ACTIVE_KEY_ID',
  ).trim()
  const activeKeyId = configuredActiveKeyId
    || (allowLegacy ? 'legacy-v1' : '')
  if (!activeKeyId) {
    throw configurationError(
      'COMMERCE_ORDER_REVISION_EVIDENCE_ACTIVE_KEY_ID_REQUIRED',
      'Commerce revision evidence requires an explicit active key ID',
    )
  }
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw configurationError(
      'COMMERCE_ORDER_REVISION_EVIDENCE_ACTIVE_KEY_ID_INVALID',
      'Commerce revision evidence active key ID is invalid',
    )
  }

  const rawRing = environmentValue(
    environment,
    'INTEGRATION_EVIDENCE_ENCRYPTION_KEYS',
  ).trim()
  let encryptionKeys
  let legacyRingUsed = false
  if (rawRing) {
    encryptionKeys = parseEncryptionKeyRing(rawRing)
  } else if (allowLegacy && activeKeyId === 'legacy-v1') {
    if (legacyKey.length < MINIMUM_KEY_LENGTH) {
      throw configurationError(
        'COMMERCE_ORDER_REVISION_EVIDENCE_LEGACY_KEY_REQUIRED',
        'Local legacy revision evidence key material is unavailable',
      )
    }
    encryptionKeys = new Map([['legacy-v1', legacyKey]])
    legacyRingUsed = true
  } else {
    throw configurationError(
      'COMMERCE_ORDER_REVISION_EVIDENCE_KEY_RING_REQUIRED',
      'Commerce revision evidence requires an explicit encryption key ring',
    )
  }

  if (!encryptionKeys.has(activeKeyId)) {
    throw configurationError(
      'COMMERCE_ORDER_REVISION_EVIDENCE_ACTIVE_KEY_UNAVAILABLE',
      'Commerce revision evidence active key is absent from the key ring',
    )
  }

  const keyIds = Object.freeze([...encryptionKeys.keys()].sort())
  const legacyFingerprintUsed = !dedicatedFingerprintKey && allowLegacy
  const mode = legacyFingerprintUsed || legacyRingUsed
    ? 'local_legacy_compatibility'
    : 'explicit'

  return Object.freeze({
    hosted,
    mode,
    activeKeyId,
    keyIds,
    legacyCompatibilityUsed: mode === 'local_legacy_compatibility',
    hasEncryptionKey(keyIdValue) {
      const keyId = String(keyIdValue || '').trim()
      return KEY_ID_PATTERN.test(keyId) && encryptionKeys.has(keyId)
    },
    getFingerprintKeyMaterial() {
      return fingerprintKey
    },
    getEncryptionKeyMaterial(keyIdValue) {
      const keyId = String(keyIdValue || '').trim()
      return KEY_ID_PATTERN.test(keyId)
        ? encryptionKeys.get(keyId) || null
        : null
    },
  })
}

/**
 * Return serialization-safe configuration and database-reference readiness.
 * Key IDs are operational metadata; key values never enter this result.
 */
export function summarizeCommerceOrderRevisionEvidenceKeyReadiness(
  configuration,
  options = {},
) {
  if (
    !configuration
    || typeof configuration !== 'object'
    || typeof configuration.hasEncryptionKey !== 'function'
  ) {
    throw new TypeError('Resolved commerce revision evidence key configuration is required')
  }

  const inputKeyIds = Array.isArray(options.referencedKeyIds)
    ? options.referencedKeyIds
    : []
  const referenced = new Set()
  let invalidReferencedKeyIdCount = 0
  for (const value of inputKeyIds) {
    const keyId = String(value || '').trim()
    if (!KEY_ID_PATTERN.test(keyId)) {
      invalidReferencedKeyIdCount += 1
      continue
    }
    referenced.add(keyId)
  }
  const referencedKeyIds = [...referenced].sort()
  const missingReferencedKeyIds = referencedKeyIds.filter(
    (keyId) => !configuration.hasEncryptionKey(keyId),
  )
  const unpurgedProtectedReadCount = Number(
    options.unpurgedProtectedReadCount || 0,
  )
  if (
    !Number.isSafeInteger(unpurgedProtectedReadCount)
    || unpurgedProtectedReadCount < 0
  ) {
    throw new TypeError('Unpurged protected read count must be a nonnegative integer')
  }
  const ready = missingReferencedKeyIds.length === 0
    && invalidReferencedKeyIdCount === 0

  return Object.freeze({
    status: ready ? 'ready' : 'blocked',
    ready,
    hosted: Boolean(configuration.hosted),
    mode: configuration.mode,
    activeKeyId: configuration.activeKeyId,
    configuredKeyIds: Object.freeze([...configuration.keyIds]),
    referencedKeyIds: Object.freeze(referencedKeyIds),
    missingReferencedKeyIds: Object.freeze(missingReferencedKeyIds),
    invalidReferencedKeyIdCount,
    unpurgedProtectedReadCount,
    fingerprintKeyConfigured: true,
    legacyCompatibilityUsed: Boolean(configuration.legacyCompatibilityUsed),
  })
}
