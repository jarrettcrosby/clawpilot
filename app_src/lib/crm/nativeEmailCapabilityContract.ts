import { createHash } from 'node:crypto'
import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'

/** Prepared v2 contract only. It neither installs authority nor replaces the
 * v1 publisher's write denial. Evidence must be independently obtained under
 * the native policy/binding fence, not copied from the proposed contract.
 * Future-create writes require explicit review; history/readers cannot infer them. */
export const NATIVE_EMAIL_CAPABILITY_SURFACES = ['view', 'list', 'export', 'edit', 'delete'] as const
export type NativeEmailCapabilityMatrix = Record<typeof NATIVE_EMAIL_CAPABILITY_SURFACES[number], string[]>
export type NativeEmailHistoricalCapabilities = {
  suiteCrmId: string
  globalId: string
  capabilities: NativeEmailCapabilityMatrix
}
export type NativeEmailCapabilityContract = {
  version: 2
  pipelineId: string
  workspaceId: string
  ownerSuiteCrmId: string
  audienceFingerprint: string
  principalSuiteCrmUserIds: string[]
  futureCreate: NativeEmailCapabilityMatrix
  historical: NativeEmailHistoricalCapabilities[]
}
export type NativeEmailCapabilityEvidence = {
  binding: {
    pipelineId: string
    workspaceId: string
    ownerSuiteCrmId: string
    audienceFingerprint: string
    allowedReaderSuiteCrmUserIds: string[]
  }
  livePrincipalSuiteCrmUserIds: string[]
  approvedFutureCreate: NativeEmailCapabilityMatrix
  liveHistorical: NativeEmailHistoricalCapabilities[]
}
export type NativeEmailCapabilitySelection = { mode: 'future-create' }
  | { mode: 'historical'; suiteCrmId: string; globalId: string }

const ID = /^[a-z0-9][a-z0-9-]{0,35}(?![\s\S])/i
const SCOPE = /^[a-z0-9][a-z0-9-]{0,63}(?![\s\S])/i
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const GLOBAL = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/
const HASH = /^[a-f0-9]{64}(?![\s\S])/
function keys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), 'capability_shape')
}
function matches(value: unknown, pattern: RegExp): value is string { return typeof value === 'string' && pattern.test(value) }
function ids(value: unknown): asserts value is string[] {
  requireNativeEmail(Array.isArray(value) && value.length <= 500
    && Object.keys(value).length === value.length
    && value.every((id, index) => matches(id, ID) && (index === 0 || value[index - 1] < id)), 'capability_principal_ids')
}
function same(left: unknown, right: unknown): boolean { return nativeEmailCanonicalJson(left) === nativeEmailCanonicalJson(right) }
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value) }
  return value
}
function matrix(value: unknown, readers: string[], principals: string[]): asserts value is NativeEmailCapabilityMatrix {
  keys(value, [...NATIVE_EMAIL_CAPABILITY_SURFACES])
  for (const surface of NATIVE_EMAIL_CAPABILITY_SURFACES) {
    const allowed = value[surface]; ids(allowed)
    requireNativeEmail(allowed.every(id => principals.includes(id)), 'capability_unknown_principal')
    if (surface === 'edit' || surface === 'delete') {
      requireNativeEmail(allowed.every(id => readers.includes(id)), 'capability_write_without_read')
    } else requireNativeEmail(same(allowed, readers), 'capability_reader_binding')
  }
}
function history(value: unknown, readers: string[], principals: string[]): asserts value is NativeEmailHistoricalCapabilities[] {
  requireNativeEmail(Array.isArray(value) && value.length <= 500 && Object.keys(value).length === value.length, 'capability_history_bound')
  let prior = ''; const globals = new Set<string>()
  for (const entry of value) {
    keys(entry, ['suiteCrmId', 'globalId', 'capabilities'])
    requireNativeEmail(matches(entry.suiteCrmId, ID) && entry.suiteCrmId > prior
      && matches(entry.globalId, GLOBAL) && !globals.has(entry.globalId), 'capability_history_identity')
    prior = entry.suiteCrmId; globals.add(entry.globalId)
    matrix(entry.capabilities, readers, principals)
  }
}

export function prepareNativeEmailCapabilityContract(contract: NativeEmailCapabilityContract, evidence: NativeEmailCapabilityEvidence) {
  keys(contract, ['version', 'pipelineId', 'workspaceId', 'ownerSuiteCrmId', 'audienceFingerprint',
    'principalSuiteCrmUserIds', 'futureCreate', 'historical'])
  keys(evidence, ['binding', 'livePrincipalSuiteCrmUserIds', 'approvedFutureCreate', 'liveHistorical'])
  const binding = evidence.binding
  keys(binding, ['pipelineId', 'workspaceId', 'ownerSuiteCrmId', 'audienceFingerprint', 'allowedReaderSuiteCrmUserIds'])
  requireNativeEmail(contract.version === 2 && matches(binding.pipelineId, UUID) && matches(binding.workspaceId, SCOPE)
    && matches(binding.ownerSuiteCrmId, ID) && matches(binding.audienceFingerprint, HASH), 'capability_binding_identity')
  for (const key of ['pipelineId', 'workspaceId', 'ownerSuiteCrmId', 'audienceFingerprint'] as const) {
    requireNativeEmail(contract[key] === binding[key], 'capability_binding_changed')
  }
  const readers = binding.allowedReaderSuiteCrmUserIds
  ids(readers); ids(evidence.livePrincipalSuiteCrmUserIds); ids(contract.principalSuiteCrmUserIds)
  requireNativeEmail(readers.length > 0 && readers.includes(binding.ownerSuiteCrmId)
    && readers.every(id => evidence.livePrincipalSuiteCrmUserIds.includes(id))
    && same(contract.principalSuiteCrmUserIds, evidence.livePrincipalSuiteCrmUserIds), 'capability_principal_inventory_changed')
  // Existing audience v1 uses this defined key order, not recursively sorted JSON.
  const audience = createHash('sha256').update(JSON.stringify({ policy: 'pipeline-internal',
    ownerSuiteCrmId: binding.ownerSuiteCrmId, allowedSuiteCrmUserIds: readers,
    workspaceId: binding.workspaceId, pipelineId: binding.pipelineId })).digest('hex')
  requireNativeEmail(audience === binding.audienceFingerprint, 'capability_audience_fingerprint')
  matrix(contract.futureCreate, readers, contract.principalSuiteCrmUserIds)
  matrix(evidence.approvedFutureCreate, readers, evidence.livePrincipalSuiteCrmUserIds)
  history(contract.historical, readers, contract.principalSuiteCrmUserIds)
  history(evidence.liveHistorical, readers, evidence.livePrincipalSuiteCrmUserIds)
  requireNativeEmail(same(contract.futureCreate, evidence.approvedFutureCreate), 'capability_future_not_approved')
  requireNativeEmail(same(contract.historical, evidence.liveHistorical), 'capability_history_changed')
  const canonical = nativeEmailCanonicalJson(contract)
  requireNativeEmail(Buffer.byteLength(canonical, 'utf8') <= 600000, 'capability_contract_size')
  const scope = { version:contract.version, pipelineId:contract.pipelineId, workspaceId:contract.workspaceId,
    ownerSuiteCrmId:contract.ownerSuiteCrmId, audienceFingerprint:contract.audienceFingerprint,
    principalSuiteCrmUserIds:contract.principalSuiteCrmUserIds }
  const futurePolicy = { ...scope, futureCreate:contract.futureCreate }
  const historicalManifest = { ...scope, historical:contract.historical }
  // New Emails extend the historical manifest without changing reviewed future
  // write authority. Keep the stable policy pin separate from an exact bundle.
  return immutable({ contract: JSON.parse(canonical) as NativeEmailCapabilityContract, fingerprint: nativeEmailDigest(contract),
    futurePolicyFingerprint: nativeEmailDigest(futurePolicy), historicalFingerprint: nativeEmailDigest(historicalManifest) })
}

/** The future-policy pin belongs to the durable v2 binding; bundle/history pins
 * belong to exact reviewed transition/repair evidence. Never compute the
 * expected pin from an untrusted candidate to satisfy this check. */
export function verifyNativeEmailCapabilityFingerprint(contract: NativeEmailCapabilityContract, evidence: NativeEmailCapabilityEvidence,
  expectedFingerprint: string, scope: 'bundle' | 'future-policy' | 'historical' = 'bundle'): void {
  const prepared = prepareNativeEmailCapabilityContract(contract, evidence)
  requireNativeEmail(['bundle', 'future-policy', 'historical'].includes(scope), 'capability_fingerprint_scope')
  const fingerprint = scope === 'future-policy' ? prepared.futurePolicyFingerprint
    : scope === 'historical' ? prepared.historicalFingerprint : prepared.fingerprint
  requireNativeEmail(matches(expectedFingerprint, HASH) && fingerprint === expectedFingerprint, 'capability_fingerprint_changed')
}

/** Fail closed on a missing historical identity; never silently substitute the
 * future-create policy. Include every live principal so omitted denies cannot
 * hide an unexpected reader/editor. This does not itself evaluate native ACLs. */
export function verifyNativeEmailCapabilityReadback(contract: NativeEmailCapabilityContract, evidence: NativeEmailCapabilityEvidence,
  selection: NativeEmailCapabilitySelection, readback: { principalSuiteCrmUserIds: string[]; capabilities: NativeEmailCapabilityMatrix }): void {
  prepareNativeEmailCapabilityContract(contract, evidence)
  keys(readback, ['principalSuiteCrmUserIds', 'capabilities']); ids(readback.principalSuiteCrmUserIds)
  requireNativeEmail(same(readback.principalSuiteCrmUserIds, contract.principalSuiteCrmUserIds), 'capability_readback_inventory_changed')
  keys(selection, selection.mode === 'future-create' ? ['mode'] : ['mode', 'suiteCrmId', 'globalId'])
  requireNativeEmail(selection.mode === 'future-create' || selection.mode === 'historical', 'capability_selection')
  const expected = selection.mode === 'future-create' ? contract.futureCreate
    : contract.historical.find(row => row.suiteCrmId === selection.suiteCrmId && row.globalId === selection.globalId)?.capabilities
  requireNativeEmail(expected, 'capability_historical_record_missing')
  matrix(readback.capabilities, evidence.binding.allowedReaderSuiteCrmUserIds, contract.principalSuiteCrmUserIds)
  requireNativeEmail(same(readback.capabilities, expected), 'capability_readback_changed')
}
