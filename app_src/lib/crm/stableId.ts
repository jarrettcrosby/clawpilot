import crypto from 'node:crypto'

const SUITECRM_NAMESPACE = 'ad5d6a0f-5942-5dc0-aab9-d9cba48a16b1'

function uuidBytes(value: string) {
  return Buffer.from(value.replaceAll('-', ''), 'hex')
}

export function stableSuiteCrmId(pipelineId: string, entity: string, sourceKey: string) {
  const hash = crypto.createHash('sha1')
    .update(uuidBytes(SUITECRM_NAMESPACE))
    .update(`${pipelineId}:${entity}:${sourceKey}`)
    .digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function stableGlobalSuiteCrmId(entity: string, identityKey: string) {
  return stableSuiteCrmId('global', entity, identityKey)
}

export function normalizedCrmIdentityText(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function organizationIdentityKey(input: {
  name: unknown
  workspaceOrganizationId?: string | null
}) {
  if (input.workspaceOrganizationId) return `workspace:${input.workspaceOrganizationId}`
  return `customer:name:${normalizedCrmIdentityText(input.name)}`
}

export function contactIdentityKey(input: {
  email?: unknown
  fullName: unknown
  organizationId?: string | null
}) {
  const email = normalizedCrmIdentityText(input.email)
  if (email) return `contact:email:${email}`
  return contactNameIdentityKey(input)
}

export function contactNameIdentityKey(input: {
  fullName: unknown
  organizationId?: string | null
}) {
  return `contact:name:${normalizedCrmIdentityText(input.fullName)}:organization:${input.organizationId || 'none'}`
}

export function crmSourceHash(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
