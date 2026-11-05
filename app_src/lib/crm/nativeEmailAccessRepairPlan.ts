import { createHash } from 'node:crypto'
import { suiteCrmEmailAudienceFingerprint, type SuiteCrmEmailProjection } from './suiteCrmNativeEmailProjection'

type Audience = SuiteCrmEmailProjection['audience']
export type NativeEmailPipelineBinding = {
  groupId: string
  workspaceId: string
  pipelineId: string
  generation: number
  audienceFingerprint: string
  memberSuiteCrmUserIds: string[]
  nativePolicyFingerprint: string
}
export type NativeEmailAccessRepairInput = {
  version: 1
  capturedAt: string
  complete: { localEmails: boolean; nativeEmails: boolean; pipelineAudiences: boolean }
  nativePolicyFingerprint: string
  writerFence: { state: 'drained' | 'not_drained'; generation: string }
  pipelines: Array<{ audience: Audience; generation: number; binding: NativeEmailPipelineBinding | null }>
  localEmails: Array<{ localId: string; globalId: string; nativeId: string | null; pipelineId: string; archived: boolean }>
  nativeEmails: Array<{
    nativeId: string
    globalId: string | null
    /** Digest of content, headers, ownership, dates and company/contact links, excluding access rows. */
    recordFingerprint: string
    groupIds: string[]
    readerSuiteCrmUserIds: string[]
  }>
}

export type NativeEmailAccessHold = {
  code: 'invalid_input' | 'incomplete_inventory' | 'stale_inventory' | 'writer_not_drained'
    | 'duplicate_pipeline' | 'duplicate_group_binding' | 'invalid_audience' | 'missing_binding' | 'binding_drift'
    | 'duplicate_local_identity' | 'duplicate_native_identity' | 'unmapped_native_email'
    | 'missing_native_email' | 'identity_mismatch' | 'missing_pipeline' | 'unmanaged_group' | 'unexpected_native_reader'
  localId?: string
  nativeId?: string
  pipelineId?: string
}

export type NativeEmailAccessRepairCommand = {
  action: 'attach_existing_email_to_verified_pipeline_group'
  localId: string
  globalId: string
  nativeId: string
  archived: boolean
  pipelineId: string
  workspaceId: string
  groupId: string
  generation: number
  audienceFingerprint: string
  allowedSuiteCrmUserIds: string[]
  expectedNativePolicyFingerprint: string
  expectedWriterFenceGeneration: string
  expectedNativeRecordFingerprint: string
  expectedGroupIds: string[]
  expectedReaderSuiteCrmUserIds: string[]
  idempotencyKey: string
}

/** Both historical repair and future publication must satisfy this contract.
 * This is a review manifest, NOT an executor, native proof or permission grant. */
export const NATIVE_EMAIL_ACCESS_PUBLICATION_CONTRACT = Object.freeze({
  version: 1,
  audiencePolicy: 'pipeline-internal',
  scope: 'exact-verified-pipeline-group',
  nativeTransactionRequired: true,
  policyAndMembershipFenceRequired: true,
  oldWriterDrainRequired: true,
  freshBindingAndAudienceReadbackRequired: true,
  exactFinalNativeReadersRequired: true,
  secureNewUserDefaultsRequired: true,
  pipelineReadAndWriteAuthorityMustRemainSeparate: true,
  exactContentIdentityOwnershipAndRelationshipsReadbackRequired: true,
  mutationOnUnknownPolicy: 'none',
  createHistoricalEmail: false,
  changeRolesOrGroupMembersDuringPublication: false,
  fallbackToOrganizationGroup: false,
} as const)

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/i
const GLOBAL_ID = /^gi(?:[0-9]{7}|[0-9a-v]{12})$/
const DIGEST = /^[a-f0-9]{64}$/
const MAX_AGE_MS = 300_000
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) }
function validDigest(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value) }
function validGlobalId(value: unknown): value is string { return typeof value === 'string' && GLOBAL_ID.test(value) }
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function requireCondition(value: unknown): asserts value { if (!value) throw new Error('Invalid access repair input') }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()))
}
function ids(value: unknown, limit = 200): string[] {
  requireCondition(Array.isArray(value) && value.length <= limit && value.every(id => typeof id === 'string' && ID.test(id)))
  requireCondition(new Set(value).size === value.length)
  return [...value].sort()
}
function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right) }
function index<T>(values: T[], key: (value: T) => string | null): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const value of values) { const id = key(value); if (id !== null) result.set(id, [...(result.get(id) || []), value]) }
  return result
}

/** Consumes a complete, explicitly selected managed-Email inventory. The collector
 * must include archived local mappings and all active mapped/global-ID native
 * Emails; an absent native row is a hold, never permission to recreate it.
 * Readiness assumes a corrected-policy snapshot from an isolated rehearsal or
 * the fenced atomic cutover; never mutate live roles just to produce this plan.
 * Group membership is the exact allowed set, including administrators, without
 * role or inheritance grants. Callers must re-read policy/bindings/records at
 * execution; this pure planner cannot authenticate supplied evidence or make a
 * stale snapshot authoritative. */
export function planNativeEmailAccessRepair(input: NativeEmailAccessRepairInput, now: number) {
  const holds: NativeEmailAccessHold[] = []
  const commands: NativeEmailAccessRepairCommand[] = []
  const unchanged: Array<{ localId: string; nativeId: string; globalId: string; audienceFingerprint: string }> = []
  let capturedAt: string | null = null
  let expiresAt: string | null = null
  let normalizedInputFingerprint: string | null = null
  let futureBindings: NativeEmailPipelineBinding[] = []
  try {
    exact(input, ['version', 'capturedAt', 'complete', 'nativePolicyFingerprint', 'writerFence', 'pipelines', 'localEmails', 'nativeEmails'])
    requireCondition(input.version === 1 && typeof input.capturedAt === 'string' && Number.isFinite(now)
      && validDigest(input.nativePolicyFingerprint))
    const capturedMs = Date.parse(input.capturedAt)
    requireCondition(Number.isFinite(capturedMs))
    capturedAt = new Date(capturedMs).toISOString()
    expiresAt = new Date(capturedMs + MAX_AGE_MS).toISOString()
    exact(input.complete, ['localEmails', 'nativeEmails', 'pipelineAudiences'])
    requireCondition(Object.values(input.complete).every(value => typeof value === 'boolean'))
    if (Object.values(input.complete).some(value => !value)) holds.push({ code: 'incomplete_inventory' })
    if (capturedMs > now || now - capturedMs > MAX_AGE_MS) holds.push({ code: 'stale_inventory' })
    exact(input.writerFence, ['state', 'generation'])
    requireCondition(['drained', 'not_drained'].includes(input.writerFence.state) && validDigest(input.writerFence.generation))
    if (input.writerFence.state !== 'drained') holds.push({ code: 'writer_not_drained' })
    for (const list of [input.pipelines, input.localEmails, input.nativeEmails]) requireCondition(Array.isArray(list) && list.length <= 10_000)
    const pipelines = input.pipelines.map(entry => {
      exact(entry, ['audience', 'generation', 'binding'])
      exact(entry.audience, ['policy', 'ownerSuiteCrmId', 'allowedSuiteCrmUserIds', 'fingerprint', 'workspaceId', 'pipelineId'])
      const raw = entry.audience
      requireCondition(raw.policy === 'pipeline-internal' && validId(raw.ownerSuiteCrmId)
        && validId(raw.workspaceId) && validId(raw.pipelineId) && validDigest(raw.fingerprint)
        && Number.isSafeInteger(entry.generation) && entry.generation > 0)
      const audience: Audience = { policy: 'pipeline-internal', ownerSuiteCrmId: raw.ownerSuiteCrmId,
        allowedSuiteCrmUserIds: ids(raw.allowedSuiteCrmUserIds), fingerprint: raw.fingerprint,
        workspaceId: raw.workspaceId, pipelineId: raw.pipelineId }
      if (!audience.allowedSuiteCrmUserIds.includes(audience.ownerSuiteCrmId)
        || suiteCrmEmailAudienceFingerprint(audience) !== audience.fingerprint) holds.push({ code: 'invalid_audience', pipelineId: audience.pipelineId })
      let binding: NativeEmailPipelineBinding | null = null
      if (entry.binding === null) holds.push({ code: 'missing_binding', pipelineId: audience.pipelineId })
      else {
        exact(entry.binding, ['groupId', 'workspaceId', 'pipelineId', 'generation', 'audienceFingerprint', 'memberSuiteCrmUserIds', 'nativePolicyFingerprint'])
        const rawBinding = entry.binding
        requireCondition(validId(rawBinding.groupId) && validId(rawBinding.workspaceId) && validId(rawBinding.pipelineId)
          && Number.isSafeInteger(rawBinding.generation) && rawBinding.generation > 0
          && validDigest(rawBinding.audienceFingerprint) && validDigest(rawBinding.nativePolicyFingerprint))
        binding = { groupId: rawBinding.groupId, workspaceId: rawBinding.workspaceId, pipelineId: rawBinding.pipelineId,
          generation: rawBinding.generation, audienceFingerprint: rawBinding.audienceFingerprint,
          memberSuiteCrmUserIds: ids(rawBinding.memberSuiteCrmUserIds), nativePolicyFingerprint: rawBinding.nativePolicyFingerprint }
        if (binding.workspaceId !== audience.workspaceId || binding.pipelineId !== audience.pipelineId
          || binding.generation !== entry.generation || binding.audienceFingerprint !== audience.fingerprint
          || binding.nativePolicyFingerprint !== input.nativePolicyFingerprint
          || !same(binding.memberSuiteCrmUserIds, audience.allowedSuiteCrmUserIds)) holds.push({ code: 'binding_drift', pipelineId: audience.pipelineId })
      }
      return { audience, generation: entry.generation, binding }
    }).sort((a, b) => a.audience.pipelineId.localeCompare(b.audience.pipelineId))
    const pipelineIndex = index(pipelines, value => value.audience.pipelineId)
    for (const [pipelineId, entries] of pipelineIndex) if (entries.length !== 1) holds.push({ code: 'duplicate_pipeline', pipelineId })
    const groupIndex = index(pipelines, value => value.binding?.groupId || null)
    for (const entries of groupIndex.values()) if (entries.length !== 1) for (const entry of entries) holds.push({ code: 'duplicate_group_binding', pipelineId: entry.audience.pipelineId })
    const locals = input.localEmails.map(row => {
      exact(row, ['localId', 'globalId', 'nativeId', 'pipelineId', 'archived'])
      requireCondition(validId(row.localId) && validGlobalId(row.globalId) && validId(row.pipelineId)
        && (row.nativeId === null || validId(row.nativeId)) && typeof row.archived === 'boolean')
      return { localId: row.localId, globalId: row.globalId, nativeId: row.nativeId, pipelineId: row.pipelineId, archived: row.archived }
    }).sort((a, b) => a.localId.localeCompare(b.localId))
    const natives = input.nativeEmails.map(row => {
      exact(row, ['nativeId', 'globalId', 'recordFingerprint', 'groupIds', 'readerSuiteCrmUserIds'])
      requireCondition(validId(row.nativeId) && (row.globalId === null || validGlobalId(row.globalId)) && validDigest(row.recordFingerprint))
      return { nativeId: row.nativeId, globalId: row.globalId, recordFingerprint: row.recordFingerprint,
        groupIds: ids(row.groupIds), readerSuiteCrmUserIds: ids(row.readerSuiteCrmUserIds) }
    }).sort((a, b) => a.nativeId.localeCompare(b.nativeId))
    normalizedInputFingerprint = digest({ version: 1, capturedAt,
      complete: { localEmails: input.complete.localEmails, nativeEmails: input.complete.nativeEmails, pipelineAudiences: input.complete.pipelineAudiences },
      nativePolicyFingerprint: input.nativePolicyFingerprint,
      writerFence: { state: input.writerFence.state, generation: input.writerFence.generation }, pipelines, localEmails: locals, nativeEmails: natives })
    const localById = index(locals, row => row.localId), localByGlobal = index(locals, row => row.globalId), localByNative = index(locals, row => row.nativeId)
    const nativeById = index(natives, row => row.nativeId), nativeByGlobal = index(natives, row => row.globalId)
    const duplicateLocals = new Set<string>(), duplicateNatives = new Set<string>()
    for (const lookup of [localById, localByGlobal, localByNative]) for (const entries of lookup.values()) if (entries.length !== 1) for (const row of entries) duplicateLocals.add(row.localId)
    for (const lookup of [nativeById, nativeByGlobal]) for (const entries of lookup.values()) if (entries.length !== 1) for (const row of entries) duplicateNatives.add(row.nativeId)
    for (const localId of [...duplicateLocals].sort()) holds.push({ code: 'duplicate_local_identity', localId })
    for (const nativeId of [...duplicateNatives].sort()) holds.push({ code: 'duplicate_native_identity', nativeId })
    for (const native of natives) if (!localByNative.has(native.nativeId)) holds.push({ code: 'unmapped_native_email', nativeId: native.nativeId })
    for (const local of locals) {
      if (duplicateLocals.has(local.localId)) continue
      if (!local.nativeId || !nativeById.has(local.nativeId)) { holds.push({ code: 'missing_native_email', localId: local.localId }); continue }
      if (duplicateNatives.has(local.nativeId)) continue
      const native = nativeById.get(local.nativeId)![0]
      if (native.globalId !== local.globalId || nativeByGlobal.get(local.globalId)?.length !== 1) {
        holds.push({ code: 'identity_mismatch', localId: local.localId, nativeId: local.nativeId }); continue
      }
      const entries = pipelineIndex.get(local.pipelineId)
      if (!entries) { holds.push({ code: 'missing_pipeline', localId: local.localId, pipelineId: local.pipelineId }); continue }
      const pipeline = entries[0], binding = pipeline.binding
      if (!binding || holds.some(hold => hold.pipelineId === local.pipelineId)) continue
      if (native.groupIds.some(groupId => groupId !== binding.groupId)) {
        holds.push({ code: 'unmanaged_group', nativeId: native.nativeId, pipelineId: local.pipelineId }); continue
      }
      // Attaching a group cannot revoke an unrelated default-all/owner/role grant.
      // The separately approved correction must be verified within the fenced
      // cutover or isolated rehearsal, not as an unfenced preparatory live write.
      if (native.readerSuiteCrmUserIds.some(reader => !pipeline.audience.allowedSuiteCrmUserIds.includes(reader))) {
        holds.push({ code: 'unexpected_native_reader', nativeId: native.nativeId, pipelineId: local.pipelineId }); continue
      }
      if (same(native.groupIds, [binding.groupId]) && same(native.readerSuiteCrmUserIds, pipeline.audience.allowedSuiteCrmUserIds)) {
        unchanged.push({ localId: local.localId, nativeId: local.nativeId, globalId: local.globalId, audienceFingerprint: pipeline.audience.fingerprint }); continue
      }
      const command = {
        action: 'attach_existing_email_to_verified_pipeline_group' as const,
        localId: local.localId, globalId: local.globalId, nativeId: local.nativeId, archived: local.archived,
        pipelineId: local.pipelineId, workspaceId: pipeline.audience.workspaceId,
        groupId: binding.groupId, generation: binding.generation, audienceFingerprint: binding.audienceFingerprint,
        allowedSuiteCrmUserIds: [...pipeline.audience.allowedSuiteCrmUserIds],
        expectedNativePolicyFingerprint: input.nativePolicyFingerprint, expectedNativeRecordFingerprint: native.recordFingerprint,
        expectedWriterFenceGeneration: input.writerFence.generation,
        expectedGroupIds: [...native.groupIds], expectedReaderSuiteCrmUserIds: [...native.readerSuiteCrmUserIds],
      }
      commands.push({ ...command, idempotencyKey: `crm-email-access:v1:${digest(command)}` })
    }
    futureBindings = pipelines.flatMap(entry => entry.binding && !holds.some(hold => hold.pipelineId === entry.audience.pipelineId) ? [entry.binding] : [])
  } catch {
    holds.push({ code: 'invalid_input' })
    commands.length = 0
    unchanged.length = 0
    futureBindings = []
  }
  holds.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const manifest = {
    version: 1 as const, status: holds.length ? 'held' as const : 'ready_for_review' as const,
    executable: false as const, capturedAt, expiresAt, inventoryFingerprint: normalizedInputFingerprint,
    contract: NATIVE_EMAIL_ACCESS_PUBLICATION_CONTRACT,
    // Do not let a caller mistake a partial inventory's safe subset for an approved repair.
    commands: holds.length ? [] : commands, unchanged, futureBindings: holds.length ? [] : futureBindings, holds,
  }
  return { ...manifest, manifestFingerprint: digest(manifest) }
}
