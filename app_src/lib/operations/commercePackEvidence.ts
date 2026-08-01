import { createHash } from 'node:crypto'

export type CommercePackEvidenceInput = {
  integrationAccountId: string
  provider: 'shopify' | 'faire'
  externalProductId: string
  externalVariantId: string
  externalInventoryItemId: string | null
  normalizedStatus:
    | 'active'
    | 'draft'
    | 'archived'
    | 'unlisted'
    | 'unavailable'
    | 'unknown'
  providerActive: boolean | null
  requiresShipping: boolean | null
  weightGrams: number | null
}

function segment(value: string | null) {
  if (value === null) return '-1:'
  return `${Buffer.byteLength(value, 'utf8')}:${value}`
}

export function commercePackEvidenceHash(input: CommercePackEvidenceInput) {
  const canonical = [
    'clawpilot-pack-evidence-v1',
    input.integrationAccountId,
    input.provider,
    input.externalProductId,
    input.externalVariantId,
    input.externalInventoryItemId,
    input.normalizedStatus,
    input.providerActive === null
      ? null
      : input.providerActive ? '1' : '0',
    input.requiresShipping === null
      ? null
      : input.requiresShipping ? '1' : '0',
    input.weightGrams === null ? null : String(input.weightGrams),
  ].map(segment).join('')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
