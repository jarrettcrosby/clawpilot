import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
} from 'node:crypto'

const RUNTIME_CREDENTIAL = /^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i
const PAIRING_GRANT = /^cppair\.v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BASE64URL = /^[A-Za-z0-9_-]+$/

function decodeBase64Url(value, label, expectedLength = null) {
  const encoded = String(value || '')
  if (!BASE64URL.test(encoded)) throw new Error(`ClawPilot returned an invalid ${label}`)
  const decoded = Buffer.from(encoded, 'base64url')
  if (
    decoded.toString('base64url') !== encoded
    || (expectedLength !== null && decoded.byteLength !== expectedLength)
  ) throw new Error(`ClawPilot returned an invalid ${label}`)
  return decoded
}

function requiredText(value, label, maximumLength = 200) {
  const text = String(value || '').trim()
  if (!text || text.length > maximumLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`ClawPilot returned an invalid ${label}`)
  }
  return text
}

function exactObjectKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ClawPilot returned an invalid ${label}`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`ClawPilot returned an unsupported ${label}`)
  }
}

export function printAgentPairingSecretKind(value) {
  const secret = String(value || '').trim()
  if (PAIRING_GRANT.test(secret)) return 'pairing_grant'
  if (RUNTIME_CREDENTIAL.test(secret)) return 'legacy_runtime_credential'
  return null
}

export function assertPrintAgentRuntimeCredential(value) {
  const credential = String(value || '').trim()
  if (!RUNTIME_CREDENTIAL.test(credential)) {
    throw new Error('ClawPilot did not return a valid print-agent runtime credential')
  }
  return credential
}

export function printAgentPairingGrantId(pairingCode) {
  const match = String(pairingCode || '').trim().match(PAIRING_GRANT)
  if (!match) throw new Error('The supplied value is not a ClawPilot print-agent pairing grant')
  return match[1].toLowerCase()
}

export function printAgentPairingCodeHash(pairingCode) {
  printAgentPairingGrantId(pairingCode)
  return createHash('sha256').update(String(pairingCode).trim()).digest('hex')
}

export function normalizedPrintAgentIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ClawPilot did not return an authoritative print-agent identity')
  }
  const id = requiredText(value.id, 'print-agent internal identity', 80)
  const warehouseId = requiredText(value.warehouseId, 'print-agent warehouse internal identity', 80)
  const globalId = requiredText(value.globalId, 'print-agent global identity')
  const warehouseGlobalId = requiredText(value.warehouseGlobalId, 'print-agent warehouse identity')
  if (!UUID.test(id) || !UUID.test(warehouseId)) {
    throw new Error('ClawPilot returned an invalid print-agent internal identity')
  }
  for (const [label, identifier] of [
    ['print-agent global identity', globalId],
    ['print-agent warehouse identity', warehouseGlobalId],
  ]) {
    if (!/^[A-Za-z0-9._:-]{3,200}$/.test(identifier)) {
      throw new Error(`ClawPilot returned an invalid ${label}`)
    }
  }
  return Object.freeze({
    id,
    globalId,
    name: requiredText(value.name, 'print-agent name', 120),
    warehouseId,
    warehouseGlobalId,
    warehouseName: requiredText(value.warehouseName, 'print-agent warehouse name', 160),
  })
}

export function createPrintAgentPairingRecovery(pairingCode) {
  const pairingCodeHash = printAgentPairingCodeHash(pairingCode)
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const publicDer = publicKey.export({ type: 'spki', format: 'der' })
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' })
  const installationId = randomUUID()
  return Object.freeze({
    schemaVersion: 2,
    installationId,
    clientPublicKey: publicDer.toString('base64url'),
    clientKeyFingerprint: createHash('sha256').update(publicDer).digest('base64url'),
    privateKeyPkcs8: privateDer.toString('base64url'),
    idempotencyKey: `print-agent-pair-v2:${installationId}`,
    pairingCodeHash,
  })
}

export function assertPrintAgentPairingRecovery(value, pairingCode) {
  exactObjectKeys(value, [
    'schemaVersion',
    'installationId',
    'clientPublicKey',
    'clientKeyFingerprint',
    'privateKeyPkcs8',
    'idempotencyKey',
    'pairingCodeHash',
  ], 'local pairing-recovery state')
  if (
    value.schemaVersion !== 2
    || !UUID.test(value.installationId)
    || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.idempotencyKey)
    || !/^[a-f0-9]{64}$/.test(value.pairingCodeHash)
    || value.pairingCodeHash !== printAgentPairingCodeHash(pairingCode)
  ) throw new Error('The local pairing-recovery state failed identity validation')
  const publicDer = decodeBase64Url(value.clientPublicKey, 'client X25519 public key', 44)
  const privateDer = decodeBase64Url(value.privateKeyPkcs8, 'client X25519 private key', 48)
  if (
    decodeBase64Url(value.clientKeyFingerprint, 'client key fingerprint', 32)
      .toString('base64url')
    !== createHash('sha256').update(publicDer).digest('base64url')
  ) throw new Error('The local pairing-recovery fingerprint does not match its public key')
  let privateKey
  let publicKey
  try {
    privateKey = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' })
    publicKey = createPublicKey({ key: publicDer, format: 'der', type: 'spki' })
  } catch {
    throw new Error('The local pairing-recovery X25519 key is invalid')
  }
  if (
    privateKey.asymmetricKeyType !== 'x25519'
    || publicKey.asymmetricKeyType !== 'x25519'
    || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicDer)
  ) throw new Error('The local pairing-recovery keypair does not match')
  return Object.freeze({ ...value })
}

function pairingEndpoint(baseUrl) {
  const parsedBase = new URL(String(baseUrl || '').trim())
  if (
    parsedBase.protocol !== 'https:'
    && parsedBase.hostname !== '127.0.0.1'
    && parsedBase.hostname !== 'localhost'
  ) {
    throw new Error('Print-agent pairing redemption requires HTTPS outside local development')
  }
  return new URL('/api/operations/print-agent/pair', parsedBase)
}

function pairingFailure(message, {
  cause,
  code,
  retryableRecovery = false,
  outcomeUnknown = false,
} = {}) {
  const error = new Error(message)
  error.code = code
  error.retryableRecovery = retryableRecovery
  error.outcomeUnknown = outcomeUnknown
  error.cause = cause
  return error
}

function assertBinding(binding, {
  pairingCode,
  recovery,
  outerAgent,
  recoveryExpiresAt,
}) {
  exactObjectKeys(binding, [
    'endpoint',
    'pairingGrantId',
    'organizationId',
    'printAgentId',
    'printAgentGlobalId',
    'installationId',
    'clientKeyFingerprint',
    'idempotencyKey',
    'redemptionRequestFingerprint',
    'recoveryExpiresAt',
  ], 'pairing authenticated context')
  if (
    binding.endpoint !== '/api/operations/print-agent/pair'
    || binding.pairingGrantId !== printAgentPairingGrantId(pairingCode)
    || !UUID.test(binding.organizationId)
    || binding.printAgentId !== outerAgent.id
    || binding.printAgentGlobalId !== outerAgent.globalId
    || binding.installationId !== recovery.installationId
    || binding.clientKeyFingerprint !== recovery.clientKeyFingerprint
    || binding.idempotencyKey !== recovery.idempotencyKey
    || !/^[a-f0-9]{64}$/i.test(binding.redemptionRequestFingerprint)
    || binding.recoveryExpiresAt !== recoveryExpiresAt
  ) throw new Error('The sealed pairing binding does not match this installation and agent')
}

function decryptEnrollment(result, pairingCode, recovery) {
  if (
    result?.schemaVersion !== 2
    || typeof result.replayed !== 'boolean'
    || result.installationId !== recovery.installationId
    || result.clientKeyFingerprint !== recovery.clientKeyFingerprint
    || !Number.isFinite(Date.parse(result.recoveryExpiresAt))
  ) throw new Error('ClawPilot returned an invalid pairing-recovery response')
  const outerAgent = normalizedPrintAgentIdentity(result.agent)
  const sealed = result.sealedEnrollment
  exactObjectKeys(sealed, [
    'schemaVersion',
    'keyAgreement',
    'keyDerivation',
    'contentEncryption',
    'serverPublicKey',
    'salt',
    'iv',
    'ciphertext',
    'authTag',
    'authenticatedContext',
  ], 'sealed print-agent enrollment')
  if (
    sealed.schemaVersion !== 1
    || sealed.keyAgreement !== 'X25519'
    || sealed.keyDerivation !== 'HKDF-SHA256'
    || sealed.contentEncryption !== 'A256GCM'
  ) throw new Error('ClawPilot returned an unsupported sealed enrollment algorithm')
  const serverPublicDer = decodeBase64Url(sealed.serverPublicKey, 'server X25519 public key', 44)
  const salt = decodeBase64Url(sealed.salt, 'pairing HKDF salt', 32)
  const iv = decodeBase64Url(sealed.iv, 'pairing AES-GCM IV', 12)
  const ciphertext = decodeBase64Url(sealed.ciphertext, 'pairing ciphertext')
  const authTag = decodeBase64Url(sealed.authTag, 'pairing AES-GCM tag', 16)
  const context = decodeBase64Url(sealed.authenticatedContext, 'pairing authenticated context')
  if (!ciphertext.byteLength || !context.byteLength) {
    throw new Error('ClawPilot returned an empty sealed enrollment')
  }
  let serverPublicKey
  let privateKey
  try {
    serverPublicKey = createPublicKey({ key: serverPublicDer, format: 'der', type: 'spki' })
    privateKey = createPrivateKey({
      key: decodeBase64Url(recovery.privateKeyPkcs8, 'client X25519 private key', 48),
      format: 'der',
      type: 'pkcs8',
    })
  } catch {
    throw new Error('The sealed enrollment X25519 key material is invalid')
  }
  if (serverPublicKey.asymmetricKeyType !== 'x25519' || privateKey.asymmetricKeyType !== 'x25519') {
    throw new Error('The sealed enrollment key type is invalid')
  }
  const shared = diffieHellman({ privateKey, publicKey: serverPublicKey })
  const key = Buffer.from(hkdfSync('sha256', shared, salt, context, 32))
  let plaintext
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(context)
    decipher.setAuthTag(authTag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('The sealed print-agent enrollment failed authenticated decryption')
  }
  let binding
  let enrollment
  try {
    binding = JSON.parse(context.toString('utf8'))
    enrollment = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new Error('The sealed print-agent enrollment is not valid JSON')
  }
  assertBinding(binding, {
    pairingCode,
    recovery,
    outerAgent,
    recoveryExpiresAt: result.recoveryExpiresAt,
  })
  exactObjectKeys(enrollment, ['schemaVersion', 'credential', 'agent', 'binding'], 'sealed enrollment')
  if (enrollment.schemaVersion !== 1) throw new Error('The sealed enrollment schema is unsupported')
  exactObjectKeys(enrollment.agent, [
    'id',
    'globalId',
    'name',
    'warehouseId',
    'warehouseGlobalId',
    'warehouseName',
  ], 'sealed print-agent identity')
  const innerAgent = normalizedPrintAgentIdentity(enrollment.agent)
  for (const field of [
    'id',
    'globalId',
    'name',
    'warehouseId',
    'warehouseGlobalId',
    'warehouseName',
  ]) {
    if (innerAgent[field] !== outerAgent[field]) {
      throw new Error('The sealed print-agent identity does not match the authoritative response')
    }
  }
  assertBinding(enrollment.binding, {
    pairingCode,
    recovery,
    outerAgent,
    recoveryExpiresAt: result.recoveryExpiresAt,
  })
  for (const field of Object.keys(binding)) {
    if (enrollment.binding[field] !== binding[field]) {
      throw new Error('The sealed enrollment binding does not match its authenticated context')
    }
  }
  const credential = assertPrintAgentRuntimeCredential(enrollment.credential)
  if (credential.split('.')[2].toLowerCase() !== outerAgent.id.toLowerCase()) {
    throw new Error('The sealed runtime credential is not bound to the authoritative agent')
  }
  return Object.freeze({
    credential,
    agent: outerAgent,
    replayed: result.replayed,
    recoveryExpiresAt: result.recoveryExpiresAt,
  })
}

export async function redeemPrintAgentPairingGrant({
  baseUrl,
  pairingCode,
  recovery,
  fetchImplementation = fetch,
}) {
  const validatedRecovery = assertPrintAgentPairingRecovery(recovery, pairingCode)
  const endpoint = pairingEndpoint(baseUrl)
  let response
  try {
    response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': validatedRecovery.idempotencyKey,
      },
      body: JSON.stringify({
        schemaVersion: 2,
        pairingCode: String(pairingCode).trim(),
        installationId: validatedRecovery.installationId,
        clientPublicKey: validatedRecovery.clientPublicKey,
        clientKeyFingerprint: validatedRecovery.clientKeyFingerprint,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (cause) {
    throw pairingFailure(
      'The pairing response was lost after the recovery-safe request was sent',
      {
        cause,
        code: 'PAIRING_REDEMPTION_RESPONSE_LOST',
        retryableRecovery: true,
        outcomeUnknown: true,
      },
    )
  }
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = String(result?.code || `HTTP_${response.status}`)
    const retryableRecovery = response.status >= 500
      && code !== 'OPERATIONS_PRINT_AGENT_PAIRING_RECOVERY_CORRUPT'
    const outcomeUnknown = retryableRecovery || /(?:CLIENT|REPLAY)_MISMATCH|RECOVERY_(?:EXPIRED|UNAVAILABLE|CORRUPT)/.test(code)
    throw pairingFailure(
      `The ClawPilot pairing grant could not be redeemed (${code})`,
      { code, retryableRecovery, outcomeUnknown },
    )
  }
  try {
    return decryptEnrollment(result, pairingCode, validatedRecovery)
  } catch (cause) {
    throw pairingFailure(
      'ClawPilot returned a sealed enrollment that this installation could not verify',
      {
        cause,
        code: 'PAIRING_ENROLLMENT_VERIFICATION_FAILED',
        outcomeUnknown: true,
        retryableRecovery: true,
      },
    )
  }
}
