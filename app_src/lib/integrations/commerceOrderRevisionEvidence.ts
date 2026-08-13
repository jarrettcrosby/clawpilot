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
  return createHash('sha256').update(canonicalJson(content)).digest('hex')
}

/**
 * Produces the one canonical plaintext shape used by both the redacted
 * revision fingerprint and the recoverable encrypted exact-read snapshot.
 * Keeping this outside the provider adapters makes decrypt-and-compare a real
 * integrity check instead of comparing hashes of two subtly different
 * CommerceDataField shapes.
 */
export function commerceOrderRevisionProtectedPlaintext(
  field: unknown,
  kind: 'party' | 'ship_to',
): Record<string, unknown> | null {
  const source = field && typeof field === 'object' && !Array.isArray(field)
    ? field as Record<string, unknown>
    : null
  if (source?.state !== 'available') return null
  const value = source.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const fieldValue = (candidate: unknown) => {
    const nested = candidate && typeof candidate === 'object'
      && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : null
    return nested?.state === 'available' ? nested.value ?? null : null
  }
  const normalized = kind === 'party'
    ? {
        role: record.role ?? null,
        partyType: record.partyType ?? null,
        externalIdentity: fieldValue(record.externalIdentity),
        organizationName: fieldValue(record.organizationName),
        contactName: fieldValue(record.contactName),
        email: fieldValue(record.email),
        phone: fieldValue(record.phone),
      }
    : {
        name: fieldValue(record.name),
        organizationName: fieldValue(record.organizationName),
        line1: fieldValue(record.line1),
        line2: fieldValue(record.line2),
        city: fieldValue(record.city),
        region: fieldValue(record.region),
        regionCode: fieldValue(record.regionCode),
        postalCode: fieldValue(record.postalCode),
        country: fieldValue(record.country),
        countryCode: fieldValue(record.countryCode),
        phone: fieldValue(record.phone),
      }
  return canonicalValue(normalized) as Record<string, unknown>
}

export function canonicalCommerceOrderRevisionJson(value: unknown) {
  return canonicalJson(value)
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(source).sort().map((key) => [key, canonicalValue(source[key])]),
    )
  }
  return value
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
