import crypto from 'crypto'
import { isHostedRuntime } from '@/lib/persistence/config'
import { normalizeUserEmail } from '@/lib/users'

export type EncryptedMatonApiKey = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

export function normalizeMatonApiKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A Maton API key is required')
  const apiKey = value.trim()
  if (apiKey.length < 16 || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('Maton API key must be 16-4096 printable ASCII characters')
  }
  return apiKey
}

function encryptionKey(): Buffer {
  const dedicated = String(process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY || '')
  if (isHostedRuntime() && dedicated.length < 32) {
    throw new Error('Maton credential encryption is not configured')
  }
  const secret = dedicated || String(process.env.APP_SESSION_SECRET || '')
  if (secret.length < 32) throw new Error('Maton credential encryption is not configured')
  return crypto.createHash('sha256').update(secret).digest()
}

function additionalAuthenticatedData(ownerEmailValue: unknown): Buffer {
  const ownerEmail = normalizeUserEmail(ownerEmailValue)
  return Buffer.from(`clawpilot:maton:${ownerEmail}:api-key:v1`, 'utf8')
}

export function encryptMatonApiKey(apiKeyValue: unknown, ownerEmail: unknown): EncryptedMatonApiKey {
  const apiKey = normalizeMatonApiKey(apiKeyValue)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(additionalAuthenticatedData(ownerEmail))
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

export function decryptMatonApiKey(fields: EncryptedMatonApiKey, ownerEmail: unknown): string {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), fields.iv)
    decipher.setAAD(additionalAuthenticatedData(ownerEmail))
    decipher.setAuthTag(fields.tag)
    const apiKey = Buffer.concat([decipher.update(fields.ciphertext), decipher.final()]).toString('utf8')
    return normalizeMatonApiKey(apiKey)
  } catch {
    throw new Error('Stored Maton credential could not be decrypted')
  }
}
