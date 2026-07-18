import crypto from 'crypto'
import { isHostedRuntime } from '@/lib/persistence/config'

export type ToastAccessType = 'analytics' | 'standard'

export type EncryptedToastClientSecret = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function normalizeToastAccessType(value: unknown): ToastAccessType {
  if (value === 'analytics' || value === 'standard') return value
  throw new Error('Toast access type must be analytics or standard')
}

export function normalizeToastOrganizationId(value: unknown) {
  const organizationId = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(organizationId)) throw new Error('A valid organization is required')
  return organizationId
}

export function normalizeToastClientSecret(value: unknown) {
  const secret = String(value || '').trim()
  if (secret.length < 8 || secret.length > 4096 || !/^[\x21-\x7e]+$/.test(secret)) {
    throw new Error('Toast client secret must be 8-4096 printable ASCII characters')
  }
  return secret
}

function encryptionKey() {
  const dedicated = String(process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY || '')
  if (isHostedRuntime() && dedicated.length < 32) {
    throw new Error('Toast credential encryption is not configured')
  }
  const secret = dedicated || String(process.env.APP_SESSION_SECRET || '')
  if (secret.length < 32) throw new Error('Toast credential encryption is not configured')
  return crypto.createHash('sha256').update(secret).digest()
}

function authenticatedData(organizationIdValue: unknown, accessTypeValue: unknown) {
  const organizationId = normalizeToastOrganizationId(organizationIdValue)
  const accessType = normalizeToastAccessType(accessTypeValue)
  return Buffer.from(`clawpilot:toast:${organizationId}:${accessType}:client-secret:v1`, 'utf8')
}

export function encryptToastClientSecret(
  secretValue: unknown,
  organizationId: unknown,
  accessType: unknown,
): EncryptedToastClientSecret {
  const secret = normalizeToastClientSecret(secretValue)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(authenticatedData(organizationId, accessType))
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

export function decryptToastClientSecret(
  fields: EncryptedToastClientSecret,
  organizationId: unknown,
  accessType: unknown,
) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), fields.iv)
    decipher.setAAD(authenticatedData(organizationId, accessType))
    decipher.setAuthTag(fields.tag)
    const secret = Buffer.concat([decipher.update(fields.ciphertext), decipher.final()]).toString('utf8')
    return normalizeToastClientSecret(secret)
  } catch {
    throw new Error('Stored Toast credential could not be decrypted')
  }
}
