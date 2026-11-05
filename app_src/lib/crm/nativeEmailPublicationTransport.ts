import {
  nativeEmailCanonicalJson, requireNativeEmail, verifyNativeEmailTerminalReceipt,
  NATIVE_EMAIL_CAPABILITY_PIN_KEYS, verifyNativeEmailCapabilityPins,
  type NativeEmailCommand, type NativeEmailPublicationBridge, type NativeEmailTerminalReceipt, type NativeEmailPublicationRequest,
} from './nativeEmailPublication'

type Request = (path: string, init: RequestInit) => Promise<unknown>
const HASH = /^[a-f0-9]{64}$/
const same = (left: unknown, right: unknown) => nativeEmailCanonicalJson(left) === nativeEmailCanonicalJson(right)
function object(value: unknown): Record<string, unknown> {
  requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value), 'invalid_native_projection')
  return value as Record<string, unknown>
}
function exact(value: unknown, keys: string[]) {
  const record = object(value)
  requireNativeEmail(same(Object.keys(record).sort(), [...keys].sort()), 'invalid_native_projection_keys')
  return record
}

/** Uses the existing authenticated native request transport, never a browser
 * cookie or arbitrary URL. A timeout remains unknown even after fetch aborts. */
export function nativeEmailPublicationBridge(request: Request): NativeEmailPublicationBridge {
  const call = (operation: 'publish' | 'resolve', command: NativeEmailCommand) => request(
    `/Api/V8/custom/clawpilot-email-publication/${operation}`, {
      method: 'POST', headers: { 'Content-Type': 'application/vnd.api+json' },
      body: nativeEmailCanonicalJson(command), signal: AbortSignal.timeout(20_000),
    })
  return { publish: command => call('publish', command), resolveOrCancel: command => call('resolve', command) }
}

/** Read-only freshness check. Never adopt a changed existing native pre-image
 * merely because it is the latest: the reviewed/last-verified hash must match. */
export async function verifyNativeEmailPreparation(command: NativeEmailCommand, request: Request): Promise<void> {
  const response = exact(await request('/Api/V8/custom/clawpilot-email-publication/prepare', {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.api+json' },
    body: nativeEmailCanonicalJson(command), signal: AbortSignal.timeout(20_000),
  }), ['version','suiteCrmId','globalId','pipelineId','generation','audienceFingerprint','expectedRecordFingerprint',
    ...(command.version === 2 ? NATIVE_EMAIL_CAPABILITY_PIN_KEYS : [])])
  requireNativeEmail(response.version === command.version && response.suiteCrmId === command.suiteCrmId && response.globalId === command.globalId
    && response.pipelineId === command.pipelineId && response.generation === command.generation
    && response.audienceFingerprint === command.audienceFingerprint
    && response.expectedRecordFingerprint === command.expectedRecordFingerprint, 'native_preimage_changed')
  if (command.version === 2) verifyNativeEmailCapabilityPins(command, response)
}

function utc(value: unknown): string {
  requireNativeEmail(typeof value === 'string' && /^(?:\d{4}-\d\d-\d\d \d\d:\d\d:\d\d|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.000)?Z)$/.test(value), 'invalid_native_utc')
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  requireNativeEmail(Number.isFinite(parsed.getTime()), 'invalid_native_utc')
  const result = parsed.toISOString().replace('.000Z', 'Z')
  requireNativeEmail(result === value.replace(' ', 'T').replace('.000Z', 'Z').replace(/(?<!Z)$/, 'Z'), 'invalid_native_utc')
  return result
}
function header(value: unknown, single: boolean): string {
  requireNativeEmail(typeof value === 'string' && value.length <= (single ? 255 : 8000) && !/[\r\n\t]/.test(value), 'invalid_native_header')
  if (value === '') return ''
  const parts = value.split(',')
  requireNativeEmail(parts.length <= (single ? 1 : 50), 'unsupported_native_header')
  const seen = new Set<string>()
  return parts.map(raw => {
    const part = raw.trim(), match = part.match(/^([^<>]*)<([^<>]+)>$/u)
    let name = match ? match[1].trim() : ''
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1)
    const address = (match ? match[2].trim() : part).toLowerCase()
    requireNativeEmail((!match || !!name) && !/[<>;,'"\\]/u.test(name)
      && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(address)
      && address.length <= 254 && !seen.has(address), 'unsupported_native_header')
    seen.add(address)
    return name ? `${name} <${address}>` : address
  }).join(', ')
}

/** Additional mandatory finalizer check, after envelope/command/audience checks.
 * The native endpoint proves its HTML sanitizer output and raw storage under
 * lock. This validator retains that actual representation instead of claiming
 * an echoed source object is the native stored value. */
export function verifyNativeEmailProjectionReceipt(command: NativeEmailCommand, receipt: NativeEmailTerminalReceipt) {
  if (receipt.state === 'cancelled' || command.mode === 'repair') return null
  const expected = exact(command.projection, ['attributes','accounts','contacts','contactAccounts','previousManaged'])
  const source = object(expected.attributes)
  const p = exact(receipt.result.projection, ['version','suiteCrmId','attributes','sourceAttributes','accounts','contacts',
    'contactAccounts','snapshotFingerprint','dateSentReceivedUtc'])
  requireNativeEmail(p.version === 2 && p.suiteCrmId === command.suiteCrmId && same(p.sourceAttributes, source)
    && p.snapshotFingerprint === receipt.result.recordFingerprint && typeof p.snapshotFingerprint === 'string' && HASH.test(p.snapshotFingerprint), 'native_projection_identity_mismatch')
  const fields = ['name','date_sent_received','type','status','parent_type','parent_id','assigned_user_id','created_by','deleted',
    'global_id_c','description','description_html','from_addr_name','to_addrs_names','cc_addrs_names','bcc_addrs_names','reply_to_addrs_names']
  const actual = exact(p.attributes, fields)
  requireNativeEmail(Object.values(actual).every(value => typeof value === 'string' && value.length <= 200_000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value as string)), 'invalid_native_attributes')
  for (const key of ['global_id_c','name','type','status','parent_type','parent_id','assigned_user_id','description'])
    requireNativeEmail(actual[key] === source[key], 'native_attribute_changed')
  requireNativeEmail(actual.global_id_c === command.globalId && actual.deleted === '0' && actual.created_by === source.assigned_user_id
    && source.description_html === '' && typeof actual.description_html === 'string'
    && (source.description === '' || actual.description_html !== ''), 'native_projection_lifecycle_changed')
  requireNativeEmail(utc(actual.date_sent_received) === utc(source.date_sent_received)
    && p.dateSentReceivedUtc === utc(actual.date_sent_received), 'native_date_changed')
  for (const key of ['from_addr_name','to_addrs_names','cc_addrs_names','bcc_addrs_names','reply_to_addrs_names']) {
    // Omitted optional headers are preserved natively on updates; only compare
    // admitted source fields. All returned headers still must be supported.
    const actualHeader = header(actual[key], key === 'from_addr_name' || key === 'reply_to_addrs_names')
    requireNativeEmail(actualHeader === actual[key], 'noncanonical_native_header')
    if (Object.hasOwn(source, key)) requireNativeEmail(actualHeader === header(source[key], key === 'from_addr_name' || key === 'reply_to_addrs_names'), 'native_header_changed')
  }
  for (const key of ['accounts','contacts','contactAccounts']) requireNativeEmail(same(p[key], expected[key]), 'native_relationship_changed')
  return p
}

/** The finalizer-facing entry point: envelope and full projection checks cannot
 * accidentally be separated. Stored terminal receipts are historical operation
 * evidence, never proof of today's readability or latest-source sync status. */
export function verifyNativeEmailPublicationReceipt(request: NativeEmailPublicationRequest, value: unknown): NativeEmailTerminalReceipt {
  const receipt = verifyNativeEmailTerminalReceipt(request, value)
  verifyNativeEmailProjectionReceipt(request.command, receipt)
  return receipt
}
