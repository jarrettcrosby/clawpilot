import { createHash } from 'node:crypto'

/** Prepared protocol, not an enabled route. PostgreSQL admissions and native
 * receipts form a durable barrier, NOT a distributed/atomic cross-DB commit.
 * The native endpoint must authenticate this app and serialize publish/cancel
 * on the same immutable operation key under its policy/binding locks. */
export type NativeEmailExpectedCapabilities = Record<'view' | 'list' | 'export' | 'edit' | 'delete', string[]>
export type NativeEmailCapabilityPins = {
  capabilityPolicyFingerprint: string
  principalSuiteCrmUserIds: string[]
  expectedCapabilities: NativeEmailExpectedCapabilities
}
type NativeEmailCommandFields = {
  operationId: string
  mode: 'publish' | 'repair'
  workspaceId: string
  pipelineId: string
  generation: number
  audienceFingerprint: string
  suiteCrmId: string
  globalId: string
  localId: string
  expectedRecordFingerprint: string | null
  projection: Record<string, unknown> | null
}
export type NativeEmailCommand = NativeEmailCommandFields & (
  { version: 1 } | ({ version: 2 } & NativeEmailCapabilityPins)
)
export type NativeEmailPublicationInput = {
  command: NativeEmailCommand
  nativePolicyFingerprint: string
  allowedReaderSuiteCrmUserIds: string[]
}
export type NativeEmailPublicationRequest = NativeEmailPublicationInput & {
  commandHash: string
  requestFingerprint: string
}
type NativeEmailCommittedResultFields = {
  mode: 'publish' | 'repair'
  suiteCrmId: string
  globalId: string
  pipelineId: string
  generation: number
  audienceFingerprint: string
  recordFingerprint: string
  readerSuiteCrmUserIds: string[]
  projection: Record<string, unknown> | null
}
export type NativeEmailCommittedResult = NativeEmailCommittedResultFields & (
  { version: 1 } | ({ version: 2 } & NativeEmailCapabilityPins)
)
type NativeEmailTerminalReceiptFields = {
  operationId: string
  commandHash: string
  replayed: boolean
}
export type NativeEmailTerminalReceipt = NativeEmailTerminalReceiptFields & (
  { version: 1 | 2; state: 'cancelled'; result: null }
  | { version: 1; state: 'committed'; result: NativeEmailCommittedResultFields & { version: 1 } }
  | { version: 2; state: 'committed'; result: NativeEmailCommittedResultFields & { version: 2 } & NativeEmailCapabilityPins }
)
export type NativeEmailAdmission = {
  request: NativeEmailPublicationRequest
  state: 'admitted' | 'dispatched' | 'unknown' | 'committed' | 'cancelled'
  receipt: NativeEmailTerminalReceipt | null
}
export class NativeEmailPublicationHeld extends Error {
  constructor(public readonly code: string) { super(`Native Email publication held: ${code}`); this.name = 'NativeEmailPublicationHeld' }
}
export function requireNativeEmail(value: unknown, code: string): asserts value {
  if (!value) throw new NativeEmailPublicationHeld(code)
}
// JavaScript `$` alone also matches before a final line terminator; PHP's /D
// native validators require the true end. No trailing character is admitted.
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const ID = /^[a-z0-9][a-z0-9-]{0,63}(?![\s\S])/i
const PRINCIPAL_ID = /^[a-z0-9][a-z0-9-]{0,35}(?![\s\S])/i
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const GLOBAL_ID = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
export const NATIVE_EMAIL_CAPABILITY_PIN_KEYS = ['capabilityPolicyFingerprint', 'principalSuiteCrmUserIds', 'expectedCapabilities'] as const
const CAPABILITY_SURFACES = ['view', 'list', 'export', 'edit', 'delete'] as const

/** Shape/binding validation only, never authority. The trusted persistence and
 * native implementations must independently compare these pins to the installed
 * policy and complete live principal inventory before admission/publication. */
export function validateNativeEmailCapabilityPins(value: unknown, allowedReaderIds: readonly string[]): asserts value is NativeEmailCapabilityPins {
  requireNativeEmail(exact(value, [...NATIVE_EMAIL_CAPABILITY_PIN_KEYS]), 'invalid_capability_pins')
  const sortedIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length <= 500
    && Object.keys(ids).length === ids.length && Object.keys(ids).every((key, index) => key === String(index))
    && ids.every((id, index) => matches(id, PRINCIPAL_ID)
      && (index === 0 || ids[index - 1] < id))
  const principals = value.principalSuiteCrmUserIds
  requireNativeEmail(matches(value.capabilityPolicyFingerprint, HASH) && sortedIds(principals)
    && principals.length > 0, 'invalid_capability_policy')
  requireNativeEmail(sortedIds(allowedReaderIds) && allowedReaderIds.length > 0
    && allowedReaderIds.every(id => principals.includes(id)), 'invalid_capability_readers')
  const capabilities = value.expectedCapabilities
  requireNativeEmail(exact(capabilities, [...CAPABILITY_SURFACES]), 'invalid_capability_matrix')
  for (const surface of CAPABILITY_SURFACES) {
    const ids = capabilities[surface]
    requireNativeEmail(sortedIds(ids) && ids.every(id => principals.includes(id)), 'invalid_capability_principals')
    requireNativeEmail(surface === 'edit' || surface === 'delete'
      ? ids.every(id => allowedReaderIds.includes(id))
      : JSON.stringify(ids) === JSON.stringify(allowedReaderIds), 'invalid_capability_surface')
  }
}

/** Compare all three v2 pins on a prepare/result response. Equality does not
 * authorize a proposed matrix; the caller must use an independently pinned one. */
export function verifyNativeEmailCapabilityPins(command: NativeEmailCommand & { version: 2 }, value: Record<string, unknown>,
  allowedReaderIds: readonly string[] = command.expectedCapabilities?.view): void {
  const pins = (input: Record<string, unknown>) => ({ capabilityPolicyFingerprint: input.capabilityPolicyFingerprint,
    principalSuiteCrmUserIds: input.principalSuiteCrmUserIds, expectedCapabilities: input.expectedCapabilities })
  const expected = pins(command), actual = pins(value)
  validateNativeEmailCapabilityPins(expected, allowedReaderIds)
  validateNativeEmailCapabilityPins(actual, allowedReaderIds)
  requireNativeEmail(nativeEmailCanonicalJson(actual) === nativeEmailCanonicalJson(expected), 'native_capabilities_changed')
}

/** Canonical JSON for this fixed wire protocol, NOT arbitrary JSON. PHP decodes
 * objects to associative arrays, so empty objects/numeric keys are ambiguous;
 * floats and malformed UTF-16 also cannot round-trip with an identical hash.
 * Restrict keys to nonempty ASCII identifiers, numbers to safe integers and
 * strings to well-formed Unicode before creating a durable admission. */
export function nativeEmailCanonicalJson(value: unknown): string {
  const unicode = (input: string): string => {
    requireNativeEmail(Buffer.from(input, 'utf8').toString('utf8') === input, 'invalid_json_unicode')
    return input
  }
  const visit = (input: unknown, depth: number): unknown => {
    // Stay comfortably below native json_decode(depth: 48), whose root/container
    // counting differs from this visitor. Supported wire shapes need < 10 levels.
    requireNativeEmail(depth <= 32, 'invalid_json_depth')
    if (typeof input === 'string') return unicode(input)
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') { requireNativeEmail(Number.isSafeInteger(input), 'invalid_json_number'); return input }
    requireNativeEmail(input && typeof input === 'object', 'invalid_json_value')
    if (Array.isArray(input)) {
      const keys = Object.keys(input)
      requireNativeEmail(keys.length === input.length && keys.every((key, index) => key === String(index)), 'invalid_json_array')
      return input.map(item => visit(item, depth + 1))
    }
    requireNativeEmail(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
      'invalid_json_object')
    const keys = Object.keys(input).sort()
    requireNativeEmail(keys.length > 0, 'invalid_json_empty_object')
    for (const key of keys) {
      unicode(key)
      requireNativeEmail(/^[A-Za-z][A-Za-z0-9_]*(?![\s\S])/.test(key), 'invalid_json_key')
    }
    return Object.fromEntries(keys.map(key => [key, visit((input as Record<string, unknown>)[key], depth + 1)]))
  }
  return JSON.stringify(visit(value, 0)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
export function nativeEmailDigest(value: unknown): string {
  return createHash('sha256').update(nativeEmailCanonicalJson(value)).digest('hex')
}
export function prepareNativeEmailPublication(input: NativeEmailPublicationInput): NativeEmailPublicationRequest {
  requireNativeEmail(exact(input, ['command', 'nativePolicyFingerprint', 'allowedReaderSuiteCrmUserIds']), 'invalid_request')
  const c = input.command
  const capabilityKeys = c?.version === 2 ? [...NATIVE_EMAIL_CAPABILITY_PIN_KEYS] : []
  requireNativeEmail(exact(c, ['version','operationId','mode','workspaceId','pipelineId','generation','audienceFingerprint',
    'suiteCrmId','globalId','localId','expectedRecordFingerprint','projection', ...capabilityKeys]), 'invalid_command')
  requireNativeEmail((c.version === 1 || c.version === 2) && (c.mode === 'publish' || c.mode === 'repair') && Number.isSafeInteger(c.generation)
    && c.generation > 0 && matches(c.operationId, HASH) && matches(c.audienceFingerprint, HASH)
    && matches(input.nativePolicyFingerprint, HASH), 'invalid_command_identity')
  requireNativeEmail(matches(c.pipelineId, UUID) && matches(c.localId, UUID) && matches(c.workspaceId, ID)
    && matches(c.suiteCrmId, ID) && c.suiteCrmId.length <= 36 && matches(c.globalId, GLOBAL_ID)
    && (c.expectedRecordFingerprint === null || matches(c.expectedRecordFingerprint, HASH)), 'invalid_record_identity')
  requireNativeEmail(c.mode === 'repair' ? c.projection === null && c.expectedRecordFingerprint !== null
    : !!c.projection && typeof c.projection === 'object' && !Array.isArray(c.projection), 'invalid_projection')
  const readers = input.allowedReaderSuiteCrmUserIds
  requireNativeEmail(Array.isArray(readers) && readers.length > 0 && readers.length <= 500
    && readers.every(id => typeof id === 'string' && ID.test(id)) && new Set(readers).size === readers.length, 'invalid_readers')
  if (c.version === 2) validateNativeEmailCapabilityPins({ capabilityPolicyFingerprint: c.capabilityPolicyFingerprint,
    principalSuiteCrmUserIds: c.principalSuiteCrmUserIds, expectedCapabilities: c.expectedCapabilities }, [...readers].sort())
  const canonical = nativeEmailCanonicalJson(c)
  requireNativeEmail(Buffer.byteLength(canonical, 'utf8') <= 600000, 'command_too_large')
  // Native validateCommand also bounds PHP's default json_encode output, which
  // escapes every non-ASCII UTF-16 code unit and slash. Check BOTH representations
  // before admission: otherwise even resolve/cancel could reject a large command.
  const nativeBoundedJson = canonical.replace(/\//g, '\\/').replace(/[^\x00-\x7f]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  requireNativeEmail(Buffer.byteLength(nativeBoundedJson, 'utf8') <= 600000, 'native_command_too_large')
  const command = JSON.parse(canonical) as NativeEmailCommand
  const commandHash = nativeEmailDigest(command)
  const allowedReaderSuiteCrmUserIds = [...readers].sort()
  const nativePolicyFingerprint = input.nativePolicyFingerprint
  return { command, commandHash, allowedReaderSuiteCrmUserIds, nativePolicyFingerprint,
    requestFingerprint: nativeEmailDigest({ commandHash, allowedReaderSuiteCrmUserIds, nativePolicyFingerprint }) }
}

/** Envelope/identity/reader verification only. Full raw projection validation
 * against the admitted source MUST also run in the settlement transaction. */
export function verifyNativeEmailTerminalReceipt(request: NativeEmailPublicationRequest, value: unknown): NativeEmailTerminalReceipt {
  requireNativeEmail(exact(value, ['version','operationId','commandHash','state','replayed','result']), 'invalid_native_receipt')
  requireNativeEmail(value.version === request.command.version && value.operationId === request.command.operationId
    && value.commandHash === request.commandHash && typeof value.replayed === 'boolean', 'native_receipt_identity_mismatch')
  if (value.state === 'cancelled') {
    requireNativeEmail(value.result === null, 'invalid_cancellation_tombstone')
    return value as NativeEmailTerminalReceipt
  }
  const capabilityKeys = request.command.version === 2 ? [...NATIVE_EMAIL_CAPABILITY_PIN_KEYS] : []
  requireNativeEmail(value.state === 'committed' && exact(value.result, ['version','mode','suiteCrmId','globalId','pipelineId',
    'generation','audienceFingerprint','recordFingerprint','readerSuiteCrmUserIds','projection', ...capabilityKeys]), 'invalid_committed_receipt')
  const r = value.result, c = request.command
  requireNativeEmail(r.version === c.version && r.mode === c.mode && r.suiteCrmId === c.suiteCrmId && r.globalId === c.globalId
    && r.pipelineId === c.pipelineId && r.generation === c.generation && r.audienceFingerprint === c.audienceFingerprint
    && typeof r.recordFingerprint === 'string' && HASH.test(r.recordFingerprint)
    && JSON.stringify(r.readerSuiteCrmUserIds) === JSON.stringify(request.allowedReaderSuiteCrmUserIds), 'native_result_mismatch')
  if (c.version === 2) verifyNativeEmailCapabilityPins(c, r, request.allowedReaderSuiteCrmUserIds)
  requireNativeEmail(c.mode === 'repair' ? r.projection === null && r.recordFingerprint === c.expectedRecordFingerprint
    : !!r.projection && typeof r.projection === 'object' && !Array.isArray(r.projection), 'native_projection_missing')
  requireNativeEmail(Buffer.byteLength(nativeEmailCanonicalJson(value), 'utf8') <= 850000, 'receipt_too_large')
  return value as NativeEmailTerminalReceipt
}

export type NativeEmailAuthorityValidator<Tx> = (tx: Tx, request: NativeEmailPublicationRequest) => Promise<void>
/** Required: validate complete raw projection against the immutable admitted
 * command and exact audience, under an authorized current worker/resolver claim;
 * then finish operation/outbox state in this SAME transaction. Do not require an
 * expired original lease or an unchanged latest source to acknowledge a proven
 * historical outcome. If the source revision changed, settle this operation as
 * superseded and leave/queue the current revision unsynced; never mark the latest
 * source synced using an older receipt. Cancellation records only the terminal
 * no-write outcome and must not mark an Email synced. */
export type NativeEmailFinalizer<Tx> = (tx: Tx, request: NativeEmailPublicationRequest, receipt: NativeEmailTerminalReceipt) => Promise<void>
export interface NativeEmailPublicationStore<Tx> {
  admit(input: NativeEmailPublicationInput, validate: NativeEmailAuthorityValidator<Tx>): Promise<NativeEmailAdmission>
  get(operationId: string): Promise<NativeEmailAdmission>
  markDispatched(operationId: string): Promise<boolean>
  markUnknown(operationId: string): Promise<void>
  settle(operationId: string, value: unknown, finalize: NativeEmailFinalizer<Tx>): Promise<NativeEmailTerminalReceipt>
}
export type NativeEmailPublicationBridge = {
  /** Exact stored command, no regenerated timestamps/identities. */
  publish(command: NativeEmailCommand): Promise<unknown>
  /** Resolves committed receipt OR atomically installs cancellation tombstone.
   * A 404, pending status, timeout, or disconnected socket is NOT terminal. */
  resolveOrCancel(command: NativeEmailCommand): Promise<unknown>
}

/** Commit app admission before native I/O. Only a single dispatcher may send;
 * a crash even before send requires explicit reconciliation, not blind retry. */
export async function dispatchNativeEmailPublication<Tx>(store: NativeEmailPublicationStore<Tx>,
  input: NativeEmailPublicationInput, bridge: NativeEmailPublicationBridge,
  validate: NativeEmailAuthorityValidator<Tx>, finalize: NativeEmailFinalizer<Tx>): Promise<NativeEmailTerminalReceipt> {
  const admission = await store.admit(input, validate)
  if (admission.receipt) return admission.receipt
  const id = admission.request.command.operationId
  requireNativeEmail(await store.markDispatched(id), 'reconciliation_required')
  let receipt: NativeEmailTerminalReceipt
  try { receipt = verifyNativeEmailTerminalReceipt(admission.request, await bridge.publish(admission.request.command)) }
  catch {
    await store.markUnknown(id)
    throw new NativeEmailPublicationHeld('native_outcome_unknown')
  }
  // If local finalization fails, the durable dispatched admission remains.
  // Never release or mark ordinary provider failure when native may have committed.
  return store.settle(id, receipt, finalize)
}

export async function reconcileNativeEmailPublication<Tx>(store: NativeEmailPublicationStore<Tx>, operationId: string,
  bridge: NativeEmailPublicationBridge, finalize: NativeEmailFinalizer<Tx>): Promise<NativeEmailTerminalReceipt> {
  const admission = await store.get(operationId)
  if (admission.receipt) return admission.receipt
  let receipt: NativeEmailTerminalReceipt
  try { receipt = verifyNativeEmailTerminalReceipt(admission.request, await bridge.resolveOrCancel(admission.request.command)) }
  catch {
    await store.markUnknown(operationId)
    throw new NativeEmailPublicationHeld('native_outcome_unknown')
  }
  return store.settle(operationId, receipt, finalize)
}
