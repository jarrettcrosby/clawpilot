import { createHash } from 'node:crypto'

export function derivedOrderWorkbenchIdempotencyKey(input: {
  organizationId: string
  idempotencyKey: string
  candidateGlobalId: string
  purpose: 'provider' | 'rebase'
}) {
  const digest = createHash('sha256').update([
    input.organizationId,
    input.idempotencyKey,
    input.candidateGlobalId,
    input.purpose,
  ].join(':')).digest()
  if (input.purpose === 'provider') {
    const bytes = Buffer.from(digest.subarray(0, 16))
    bytes[6] = (bytes[6] & 0x0f) | 0x50
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = bytes.toString('hex')
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-')
  }
  return `order-workbench-${input.purpose}:${digest.toString('hex')}`
}
