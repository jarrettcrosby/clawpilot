import crypto from 'node:crypto'
import {
  resolveCommerceOrderRevisionEvidenceKeyConfig,
  summarizeCommerceOrderRevisionEvidenceKeyReadiness,
} from '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'
import { isHostedRuntime } from '@/lib/persistence/config'
import type { NormalizedCareerSiteMailRequest } from '@/lib/careerSiteMailContract'

const ENCRYPTION_VERSION = 1 as const
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/

export type EncryptedCareerSiteMailPayload = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  keyId: string
  encryptionVersion: typeof ENCRYPTION_VERSION
}

type CareerSiteMailPayloadIdentity = {
  sourceApp: string
  ownerEmail: string
  organizationId: string
  messageType: NormalizedCareerSiteMailRequest['messageType']
  idempotencyKey: string
  payloadHash: string
}

function keyRing() {
  const configuration = resolveCommerceOrderRevisionEvidenceKeyConfig({
    environment: process.env,
    hosted: isHostedRuntime(),
  })
  const keys = new Map<string, Buffer>()
  for (const keyId of configuration.keyIds) {
    const material = configuration.getEncryptionKeyMaterial(keyId)
    if (!material) throw new Error('Career-site mail encryption key is unavailable')
    keys.set(keyId, crypto.createHmac('sha256', material)
      .update(`clawpilot:career-site-mail:encryption-key:${keyId}:v1`, 'utf8')
      .digest())
  }
  return { activeKeyId: configuration.activeKeyId, keys }
}

export function careerSiteMailPayloadFingerprint(request: NormalizedCareerSiteMailRequest) {
  const configuration = resolveCommerceOrderRevisionEvidenceKeyConfig({
    environment: process.env,
    hosted: isHostedRuntime(),
  })
  return crypto.createHmac('sha256', configuration.getFingerprintKeyMaterial())
    .update('clawpilot:career-site-mail:payload-fingerprint:v1\0', 'utf8')
    .update(JSON.stringify(request), 'utf8')
    .digest('hex')
}

export function careerSiteMailEncryptionKeyReadiness(referencedKeyIds: readonly string[]) {
  const configuration = resolveCommerceOrderRevisionEvidenceKeyConfig({
    environment: process.env,
    hosted: isHostedRuntime(),
  })
  return summarizeCommerceOrderRevisionEvidenceKeyReadiness(configuration, {
    referencedKeyIds: [...referencedKeyIds],
  })
}

function authenticatedData(identity: CareerSiteMailPayloadIdentity, keyId: string) {
  if (!KEY_ID_PATTERN.test(keyId) || !HASH_PATTERN.test(identity.payloadHash)) {
    throw new Error('Career-site mail encryption identity is invalid')
  }
  return Buffer.from([
    'clawpilot',
    'career-site-mail-payload',
    `v${ENCRYPTION_VERSION}`,
    keyId,
    identity.sourceApp,
    identity.ownerEmail,
    identity.organizationId,
    identity.messageType,
    identity.idempotencyKey,
    identity.payloadHash,
  ].join('\0'), 'utf8')
}

export function encryptCareerSiteMailPayload(
  request: NormalizedCareerSiteMailRequest,
  identity: Omit<CareerSiteMailPayloadIdentity, 'messageType' | 'idempotencyKey'>,
): EncryptedCareerSiteMailPayload {
  const payload = Buffer.from(JSON.stringify(request), 'utf8')
  if (payload.byteLength < 2 || payload.byteLength > 16 * 1024) {
    throw new Error('Career-site mail payload must be 2-16384 bytes')
  }
  const { activeKeyId, keys } = keyRing()
  const key = keys.get(activeKeyId)
  if (!key) throw new Error('Career-site mail active encryption key is unavailable')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(authenticatedData({
    ...identity,
    messageType: request.messageType,
    idempotencyKey: request.idempotencyKey,
  }, activeKeyId))
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    keyId: activeKeyId,
    encryptionVersion: ENCRYPTION_VERSION,
  }
}

export function decryptCareerSiteMailPayload(
  fields: EncryptedCareerSiteMailPayload,
  identity: CareerSiteMailPayloadIdentity,
): unknown {
  try {
    if (fields.encryptionVersion !== ENCRYPTION_VERSION || !KEY_ID_PATTERN.test(fields.keyId)) {
      throw new Error('unsupported encryption metadata')
    }
    const key = keyRing().keys.get(fields.keyId)
    if (!key) throw new Error('missing encryption key')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, fields.iv)
    decipher.setAAD(authenticatedData(identity, fields.keyId))
    decipher.setAuthTag(fields.tag)
    return JSON.parse(Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ]).toString('utf8')) as unknown
  } catch {
    throw new Error('Stored career-site mail payload could not be decrypted')
  }
}
