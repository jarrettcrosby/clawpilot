import { createHash } from 'node:crypto'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Hash only provider content. Local observation time, credential generation,
 * account-row identity, and canonical row/version fences remain retained on
 * the observation but cannot make an unchanged provider revision look new.
 */
export function commerceOrderRevisionHash(value: unknown) {
  const source = record(value)
  const content = source
    ? {
        version: source.version,
        provider: source.provider,
        externalAccountId: source.externalAccountId,
        order: source.order,
      }
    : value
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}
