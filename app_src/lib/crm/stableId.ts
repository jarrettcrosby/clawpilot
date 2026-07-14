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

export function crmSourceHash(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
