import crypto from 'node:crypto'
import {
  CAREER_SITE_LINKEDIN_MAX_SESSION_BYTES,
  type CareerSiteLinkedInSessionEnvelope,
} from '@/lib/careerSiteLinkedInContract'

const ENCRYPTION_VERSION = 1 as const
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type StoredCareerSiteLinkedInSession = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  keyId: string
  encryptionVersion: typeof ENCRYPTION_VERSION
  fingerprint: string
}

export type CareerSiteLinkedInSessionIdentity = {
  sourceApp: string
  ownerEmail: string
  organizationId: string
  generation: number
}

type LinkedInSessionKeyRing = {
  activeKeyId: string
  encryptionKeys: Map<string, Buffer>
  fingerprintKey: Buffer
}

export function careerSiteLinkedInSessionKeyReadiness() {
  try {
    const ring = keyRing()
    return {
      ready: true,
      activeKeyId: ring.activeKeyId,
      keyCount: ring.encryptionKeys.size,
    }
  } catch {
    return { ready: false, activeKeyId: null, keyCount: 0 }
  }
}

function decodedKey(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} must be base64-encoded key material`)
  }
  const key = Buffer.from(value, 'base64')
  if (key.byteLength !== 32 || key.toString('base64') !== value) {
    throw new Error(`${label} must decode to exactly 32 bytes`)
  }
  return key
}

function keyRing(): LinkedInSessionKeyRing {
  const activeKeyId = String(process.env.CAREER_LINKEDIN_SESSION_ACTIVE_KEY_ID || '').trim()
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new Error('LinkedIn session active encryption key ID is invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(String(process.env.CAREER_LINKEDIN_SESSION_ENCRYPTION_KEYS || ''))
  } catch {
    throw new Error('LinkedIn session encryption key ring is invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LinkedIn session encryption key ring is invalid')
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length < 1 || entries.length > 8) {
    throw new Error('LinkedIn session encryption key ring must contain 1-8 keys')
  }
  const encryptionKeys = new Map<string, Buffer>()
  for (const [keyId, value] of entries) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new Error('LinkedIn session encryption key ID is invalid')
    }
    encryptionKeys.set(keyId, decodedKey(value, `LinkedIn session encryption key ${keyId}`))
  }
  if (!encryptionKeys.has(activeKeyId)) {
    throw new Error('LinkedIn session active encryption key is unavailable')
  }
  const fingerprintKey = decodedKey(
    process.env.CAREER_LINKEDIN_SESSION_FINGERPRINT_KEY,
    'LinkedIn session fingerprint key',
  )
  if ([...encryptionKeys.values()].some((key) => key.equals(fingerprintKey))) {
    throw new Error('LinkedIn session fingerprint key must be isolated')
  }
  return { activeKeyId, encryptionKeys, fingerprintKey }
}

function assertSessionBlob(value: Buffer): Buffer {
  if (value.byteLength < 2 || value.byteLength > CAREER_SITE_LINKEDIN_MAX_SESSION_BYTES) {
    throw new Error('LinkedIn browser session is outside the supported size')
  }
  try {
    const parsed = JSON.parse(value.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error()
  } catch {
    throw new Error('LinkedIn browser session must be a JSON object or array')
  }
  return value
}

function storedAad(identity: CareerSiteLinkedInSessionIdentity, keyId: string): Buffer {
  if (
    !KEY_ID_PATTERN.test(keyId)
    || !Number.isSafeInteger(identity.generation)
    || identity.generation < 1
  ) {
    throw new Error('LinkedIn session encryption identity is invalid')
  }
  return Buffer.from([
    'clawpilot',
    'career-site-linkedin-session',
    `v${ENCRYPTION_VERSION}`,
    keyId,
    identity.sourceApp,
    identity.ownerEmail,
    identity.organizationId,
    String(identity.generation),
  ].join('\0'), 'utf8')
}

function workerAad(leaseId: string, ownerId: string): Buffer {
  return Buffer.from([
    'clawpilot',
    'career-site-linkedin-worker-envelope',
    `v${ENCRYPTION_VERSION}`,
    leaseId,
    ownerId,
  ].join('\0'), 'utf8')
}

function sessionFingerprint(blob: Buffer): string {
  return crypto.createHmac('sha256', keyRing().fingerprintKey)
    .update('clawpilot:career-site-linkedin-session-fingerprint:v1\0', 'utf8')
    .update(blob)
    .digest('hex')
}

export function encryptCareerSiteLinkedInSession(
  raw: Buffer,
  identity: CareerSiteLinkedInSessionIdentity,
): StoredCareerSiteLinkedInSession {
  const blob = assertSessionBlob(raw)
  const ring = keyRing()
  const key = ring.encryptionKeys.get(ring.activeKeyId)
  if (!key) throw new Error('LinkedIn session active encryption key is unavailable')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(storedAad(identity, ring.activeKeyId))
  const ciphertext = Buffer.concat([cipher.update(blob), cipher.final()])
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    keyId: ring.activeKeyId,
    encryptionVersion: ENCRYPTION_VERSION,
    fingerprint: sessionFingerprint(blob),
  }
}

export function decryptCareerSiteLinkedInSession(
  stored: StoredCareerSiteLinkedInSession,
  identity: CareerSiteLinkedInSessionIdentity,
): Buffer {
  try {
    if (stored.encryptionVersion !== ENCRYPTION_VERSION || !KEY_ID_PATTERN.test(stored.keyId)) {
      throw new Error()
    }
    const key = keyRing().encryptionKeys.get(stored.keyId)
    if (!key) throw new Error()
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, stored.iv)
    decipher.setAAD(storedAad(identity, stored.keyId))
    decipher.setAuthTag(stored.tag)
    const plaintext = assertSessionBlob(Buffer.concat([
      decipher.update(stored.ciphertext),
      decipher.final(),
    ]))
    const actualFingerprint = sessionFingerprint(plaintext)
    if (!crypto.timingSafeEqual(
      Buffer.from(actualFingerprint, 'hex'),
      Buffer.from(stored.fingerprint, 'hex'),
    )) throw new Error()
    return plaintext
  } catch {
    throw new Error('Stored LinkedIn browser session could not be decrypted')
  }
}

function transientKeys(leaseToken: string): Array<{ keyId: string; key: Buffer }> {
  const ring = keyRing()
  return [...ring.encryptionKeys.entries()].map(([keyId, rootKey]) => ({
    keyId,
    key: crypto.createHmac('sha256', rootKey)
      .update('clawpilot:career-site-linkedin-worker-data-key:v1\0', 'utf8')
      .update(leaseToken, 'utf8')
      .digest(),
  }))
}

export function careerSiteLinkedInTransientSessionDataKey(leaseToken: string): string {
  const ring = keyRing()
  const rootKey = ring.encryptionKeys.get(ring.activeKeyId)
  if (!rootKey) throw new Error('LinkedIn session active encryption key is unavailable')
  return crypto.createHmac('sha256', rootKey)
    .update('clawpilot:career-site-linkedin-worker-data-key:v1\0', 'utf8')
    .update(leaseToken, 'utf8')
    .digest('base64url')
}

export function encryptCareerSiteLinkedInWorkerEnvelope(input: {
  session: Buffer
  leaseId: string
  leaseToken: string
  ownerId: string
}): CareerSiteLinkedInSessionEnvelope {
  const key = Buffer.from(careerSiteLinkedInTransientSessionDataKey(input.leaseToken), 'base64url')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(workerAad(input.leaseId, input.ownerId))
  const ciphertext = Buffer.concat([cipher.update(assertSessionBlob(input.session)), cipher.final()])
  return {
    algorithm: 'A256GCM',
    version: ENCRYPTION_VERSION,
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
}

export function decryptCareerSiteLinkedInWorkerEnvelope(input: {
  envelope: CareerSiteLinkedInSessionEnvelope
  leaseId: string
  leaseToken: string
  ownerId: string
}): Buffer {
  for (const { key } of transientKeys(input.leaseToken)) {
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(input.envelope.iv, 'base64url'),
      )
      decipher.setAAD(workerAad(input.leaseId, input.ownerId))
      decipher.setAuthTag(Buffer.from(input.envelope.tag, 'base64url'))
      return assertSessionBlob(Buffer.concat([
        decipher.update(Buffer.from(input.envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]))
    } catch {
      // Key rotation can leave one of the configured keys owning a live lease.
    }
  }
  throw new Error('LinkedIn worker session envelope could not be decrypted')
}
