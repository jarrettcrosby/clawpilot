import { nativeEmailCanonicalJson, nativeEmailDigest, prepareNativeEmailPublication, requireNativeEmail,
  verifyNativeEmailTerminalReceipt, type NativeEmailCommand, type NativeEmailTerminalReceipt } from './nativeEmailPublication'
import { suiteCrmEmailAudienceFingerprint } from './suiteCrmNativeEmailProjection'
import { prepareNativeEmailCapabilityContract, type NativeEmailCapabilityContract } from './nativeEmailCapabilityContract'

/** Internal protocol, not activated or wired into user-management routes. A
 * separate narrow PostgreSQL adapter and signed native bridge implement exact
 * member transitions; neither is a general authority SQL bypass. Hashes
 * identify evidence; none confer authority. */
export const NATIVE_EMAIL_AUTHORITY_SURFACES = ['view', 'list', 'export', 'edit', 'delete'] as const
type Surface = typeof NATIVE_EMAIL_AUTHORITY_SURFACES[number]
export type NativeEmailAuthorityCapabilities = Record<Surface, string[]>
export type NativeEmailAuthorityRoleChange = { pipelineId:string;userId:string;beforeRole:'viewer'|'editor';afterRole:'viewer'|'editor' }
export type NativeEmailAuthorityIdentityLink = { userId:string;globalId:string;username:string }
export type NativeEmailAuthorityBinding = {
  pipeline_id: string; workspace_id: string; group_id: string; generation: string; owner_id: string
  readers_json: string; audience_fingerprint: string; policy_fingerprint: string; runtime_fingerprint: string; enabled: '1'
}
export type NativeEmailAuthorityBindingV2 = NativeEmailAuthorityBinding & {
  capability_policy_json: string | null; capability_policy_fingerprint: string | null
}
export type NativeEmailAuthorityMembership = { id: string; date_modified: string | null; deleted: '0' | '1';
  securitygroup_id: string; user_id: string; primary_group: '0' | '1' | null; noninheritable: '1' }
type NativeEmailAuthorityCommandCommon = {
  operationId: string; transitionId: string; phase: 'revoke' | 'grant'
  generationFrom: number; generationTo: number; desiredAppChangeHash: string
  beforePolicyFingerprint: string; afterPolicyFingerprint: string
  beforeBindingsFingerprint: string; afterBindingsFingerprint: string; runtimeFingerprint: string
  membershipChanges: Array<{ before: NativeEmailAuthorityMembership | null; after: NativeEmailAuthorityMembership }>
  capabilities: Array<{ emailId: string; globalId: string; pipelineId: string;
    before: NativeEmailAuthorityCapabilities; after: NativeEmailAuthorityCapabilities }>
  pendingPublicationCommand: NativeEmailCommand | null
  // Present only for an explicitly approved retained-member role transition.
  // Absence preserves the original membership-only wire contract exactly.
  roleChanges?: NativeEmailAuthorityRoleChange[]
  // Existing native account metadata, rechecked under the native fence. This
  // is never a request to create/rename a native principal or infer its grants.
  identityLinks?: NativeEmailAuthorityIdentityLink[]
}
export type NativeEmailAuthorityCommand = NativeEmailAuthorityCommandCommon & (
  { version: 1; bindings: Array<{ before: NativeEmailAuthorityBinding; after: NativeEmailAuthorityBinding }> }
  | { version: 2; bindings: Array<{ before: NativeEmailAuthorityBindingV2; after: NativeEmailAuthorityBindingV2 }> }
)
export type NativeEmailAuthorityRequest = { command: NativeEmailAuthorityCommand; commandHash: string }
export type NativeEmailAuthorityReceipt = { version: 1 | 2; operationId: string; transitionId: string; phase: 'revoke' | 'grant';
  commandHash: string; replayed: boolean } & ({ state: 'cancelled'; result: null } | { state: 'committed'; result: {
    desiredAppChangeHash: string; generationFrom: number; generationTo: number
    beforePolicyFingerprint: string; afterPolicyFingerprint: string; beforeBindingsFingerprint: string; afterBindingsFingerprint: string
    capabilitiesFingerprint: string; pendingPublicationTerminalReceipt: NativeEmailTerminalReceipt | null
  } })
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const ID = /^[a-z0-9][a-z0-9-]{0,63}(?![\s\S])/i
const GLOBAL = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/
const BINDING_KEYS = ['pipeline_id','workspace_id','group_id','generation','owner_id','readers_json',
  'audience_fingerprint','policy_fingerprint','runtime_fingerprint','enabled']
const CAPABILITY_BINDING_KEYS = ['capability_policy_json','capability_policy_fingerprint']
const MEMBERSHIP_KEYS = ['id','date_modified','deleted','securitygroup_id','user_id','primary_group','noninheritable']
const same = (a: unknown, b: unknown) => nativeEmailCanonicalJson(a) === nativeEmailCanonicalJson(b)
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), 'authority_shape')
}
function hash(value: unknown): asserts value is string { requireNativeEmail(typeof value === 'string' && HASH.test(value), 'authority_hash') }
function id(value: unknown, max = 64): asserts value is string {
  requireNativeEmail(typeof value === 'string' && ID.test(value) && value.length <= max, 'authority_id')
}
function ids(value: unknown): asserts value is string[] {
  requireNativeEmail(Array.isArray(value) && value.length <= 500, 'authority_ids')
  let previous = ''
  for (const item of value) { id(item, 36); requireNativeEmail(item > previous, 'authority_ids_order'); previous = item }
}
function monotonic(before: string[], after: string[], phase: 'revoke' | 'grant') {
  requireNativeEmail((phase === 'revoke' ? after.every(value => before.includes(value)) : before.every(value => after.includes(value))), 'authority_not_monotonic')
}
function memberCapabilityDelta(before: string[], after: string[], beforeReaders: string[], afterReaders: string[], phase: 'revoke' | 'grant', roles:NativeEmailAuthorityRoleChange[] = []) {
  // This v2 slice changes membership only. Retained members' existing write
  // rights cannot be narrowed or upgraded as an incidental policy rewrite.
  const demoted=new Set(roles.filter(row=>row.afterRole==='viewer').map(row=>row.userId))
  const promoted=roles.filter(row=>row.afterRole==='editor').map(row=>row.userId)
  requireNativeEmail(phase === 'revoke' ? same(after,before.filter(value => afterReaders.includes(value)&&!demoted.has(value)))
    : same([...new Set([...before,...promoted])].sort(),after.filter(value => beforeReaders.includes(value))), 'authority_retained_capability_changed')
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value) }
  return value
}
function binding(value: unknown, version: 1 | 2): asserts value is NativeEmailAuthorityBinding | NativeEmailAuthorityBindingV2 {
  exact(value, version === 1 ? BINDING_KEYS : [...BINDING_KEYS,...CAPABILITY_BINDING_KEYS])
  for (const key of ['pipeline_id','workspace_id']) id(value[key])
  for (const key of ['group_id','owner_id']) id(value[key],36)
  for (const key of ['audience_fingerprint','policy_fingerprint','runtime_fingerprint']) hash(value[key])
  requireNativeEmail(typeof value.generation === 'string' && /^[1-9][0-9]{0,15}(?![\s\S])/.test(value.generation)
    && Number.isSafeInteger(Number(value.generation)) && value.enabled === '1' && typeof value.readers_json === 'string', 'authority_binding_shape')
  let readers: unknown
  try { readers = JSON.parse(value.readers_json as string) } catch { requireNativeEmail(false, 'authority_readers_json') }
  ids(readers)
  requireNativeEmail(readers.includes(value.owner_id as string) && nativeEmailCanonicalJson(readers) === value.readers_json, 'authority_readers_canonical')
  requireNativeEmail(suiteCrmEmailAudienceFingerprint({ policy:'pipeline-internal', ownerSuiteCrmId:value.owner_id as string,
    allowedSuiteCrmUserIds:readers, workspaceId:value.workspace_id as string, pipelineId:value.pipeline_id as string, fingerprint:'' }) === value.audience_fingerprint,
  'authority_audience_fingerprint')
}
/** This checks wire consistency, not approval. The durable PG/native adapters
 * must compare both policy columns with independently locked trusted preimages.
 * Preserve the original JSON bytes in binding fingerprints: old installed rows
 * need not have used recursively sorted JSON. */
function capabilityPolicy(value: NativeEmailAuthorityBindingV2): NativeEmailCapabilityContract | null {
  if (value.capability_policy_json === null || value.capability_policy_fingerprint === null) {
    requireNativeEmail(value.capability_policy_json === null && value.capability_policy_fingerprint === null,
      'authority_capability_policy_pair')
    return null
  }
  hash(value.capability_policy_fingerprint)
  requireNativeEmail(typeof value.capability_policy_json === 'string'
    && Buffer.byteLength(value.capability_policy_json,'utf8') <= 600000, 'authority_capability_policy_shape')
  let policy: NativeEmailCapabilityContract
  try { policy = JSON.parse(value.capability_policy_json) } catch { requireNativeEmail(false,'authority_capability_policy_json') }
  requireNativeEmail(policy! && Array.isArray(policy!.historical) && policy!.historical.length === 0,
    'authority_capability_policy_history')
  const prepared = prepareNativeEmailCapabilityContract(policy!, {
    binding:{ pipelineId:value.pipeline_id,workspaceId:value.workspace_id,ownerSuiteCrmId:value.owner_id,
      audienceFingerprint:value.audience_fingerprint,allowedReaderSuiteCrmUserIds:JSON.parse(value.readers_json) },
    livePrincipalSuiteCrmUserIds:policy!.principalSuiteCrmUserIds,
    approvedFutureCreate:policy!.futureCreate,liveHistorical:[],
  })
  requireNativeEmail(prepared.futurePolicyFingerprint === value.capability_policy_fingerprint,
    'authority_capability_policy_fingerprint')
  return prepared.contract
}
function membership(value: unknown, before: boolean): asserts value is NativeEmailAuthorityMembership {
  exact(value, MEMBERSHIP_KEYS)
  for (const key of ['id','securitygroup_id','user_id']) id(value[key],36)
  requireNativeEmail(['0','1'].includes(String(value.deleted)) && typeof value.deleted === 'string'
    && ['0','1',null].includes(value.primary_group as string | null) && value.noninheritable === '1', 'authority_membership_flags')
  if (before && value.date_modified === null) return
  requireNativeEmail(typeof value.date_modified === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?![\s\S])/.test(value.date_modified), 'authority_membership_date')
  const date = new Date(value.date_modified.replace(' ','T') + 'Z')
  requireNativeEmail(Number.isFinite(date.getTime()) && date.toISOString().slice(0,19).replace('T',' ') === value.date_modified, 'authority_membership_date')
}

/** Exact TS counterpart of the frozen PHP authority wire contract. */
export function prepareNativeEmailAuthorityCommand(input: NativeEmailAuthorityCommand): NativeEmailAuthorityRequest {
  exact(input, ['version','operationId','transitionId','phase','generationFrom','generationTo','desiredAppChangeHash',
    'beforePolicyFingerprint','afterPolicyFingerprint','beforeBindingsFingerprint','afterBindingsFingerprint','runtimeFingerprint',
    'bindings','membershipChanges','capabilities','pendingPublicationCommand',...(Object.hasOwn(input,'roleChanges')?['roleChanges']:[]),
    ...(Object.hasOwn(input,'identityLinks')?['identityLinks']:[])])
  requireNativeEmail((input.version === 1 || input.version === 2) && ['revoke','grant'].includes(input.phase), 'authority_version')
  requireNativeEmail(input.version !== 2 || input.pendingPublicationCommand === null, 'authority_v2_pending_publication_held')
  const roles=input.roleChanges??[]
  if(Object.hasOwn(input,'roleChanges')){
    requireNativeEmail(input.version===2 && Array.isArray(roles) && roles.length>0 && roles.length<=100,'authority_role_change_bound')
    let previousRole=''
    for(const role of roles){
      exact(role,['pipelineId','userId','beforeRole','afterRole']);id(role.pipelineId);id(role.userId,36)
      const key=role.pipelineId+'\0'+role.userId
      requireNativeEmail(key>previousRole && ['viewer','editor'].includes(role.beforeRole)
        && ['viewer','editor'].includes(role.afterRole) && role.beforeRole!==role.afterRole,'authority_role_change_invalid')
      previousRole=key
    }
  }
  if(Object.hasOwn(input,'identityLinks')){
    requireNativeEmail(input.version===2 && !Object.hasOwn(input,'roleChanges') && Array.isArray(input.identityLinks)
      && input.identityLinks.length>0 && input.identityLinks.length<=100,'authority_identity_link_bound')
    let previousIdentity='';const references=new Set<string>()
    for(const link of input.identityLinks){
      exact(link,['userId','globalId','username']);id(link.userId,36)
      requireNativeEmail(link.userId>previousIdentity && typeof link.globalId==='string'
        && /^gu(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/.test(link.globalId)
        && link.username===link.globalId && !references.has(link.globalId),'authority_identity_link_invalid')
      previousIdentity=link.userId;references.add(link.globalId)
    }
  }
  for (const key of ['operationId','transitionId','desiredAppChangeHash','beforePolicyFingerprint','afterPolicyFingerprint',
    'beforeBindingsFingerprint','afterBindingsFingerprint','runtimeFingerprint'] as const) hash(input[key])
  requireNativeEmail(Number.isSafeInteger(input.generationFrom) && input.generationFrom > 0
    && Number.isSafeInteger(input.generationTo) && input.generationTo === input.generationFrom + 1, 'authority_generation')
  requireNativeEmail(Array.isArray(input.bindings) && input.bindings.length > 0 && input.bindings.length <= 100, 'authority_binding_bound')
  const pipelines = new Map<string, NativeEmailAuthorityCommand['bindings'][number]>(), groups = new Set<string>()
  let previous = ''
  let principalInventory: string[] | null = null
  for (const pair of input.bindings) {
    exact(pair,['before','after']); binding(pair.before,input.version); binding(pair.after,input.version)
    const { before, after } = pair
    requireNativeEmail(before.pipeline_id > previous && !groups.has(before.group_id), 'authority_binding_order')
    previous = before.pipeline_id; pipelines.set(previous,pair); groups.add(before.group_id)
    for (const key of ['pipeline_id','workspace_id','group_id','owner_id','runtime_fingerprint','enabled'] as const) {
      requireNativeEmail(before[key] === after[key], 'authority_binding_identity')
    }
    requireNativeEmail(before.generation === String(input.generationFrom) && after.generation === String(input.generationTo)
      && before.policy_fingerprint === input.beforePolicyFingerprint && after.policy_fingerprint === input.afterPolicyFingerprint
      && before.runtime_fingerprint === input.runtimeFingerprint, 'authority_binding_pins')
    monotonic(JSON.parse(before.readers_json),JSON.parse(after.readers_json),input.phase)
    if (input.version === 2) {
      const beforePolicy = capabilityPolicy(before as NativeEmailAuthorityBindingV2)
      const afterPolicy = capabilityPolicy(after as NativeEmailAuthorityBindingV2)
      requireNativeEmail((beforePolicy === null) === (afterPolicy === null), 'authority_capability_mode_changed')
      if (beforePolicy && afterPolicy) {
        requireNativeEmail(same(beforePolicy.principalSuiteCrmUserIds,afterPolicy.principalSuiteCrmUserIds)
          && (principalInventory === null || same(principalInventory,beforePolicy.principalSuiteCrmUserIds)),
        'authority_capability_inventory_changed')
        principalInventory = beforePolicy.principalSuiteCrmUserIds
        for (const surface of NATIVE_EMAIL_AUTHORITY_SURFACES) {
          monotonic(beforePolicy.futureCreate[surface],afterPolicy.futureCreate[surface],input.phase)
          memberCapabilityDelta(beforePolicy.futureCreate[surface],afterPolicy.futureCreate[surface],
            JSON.parse(before.readers_json),JSON.parse(after.readers_json),input.phase,
            surface==='edit'||surface==='delete'?roles.filter(role=>role.pipelineId===before.pipeline_id):[])
        }
      }
    }
  }
  requireNativeEmail(nativeEmailDigest(input.bindings.map(pair => pair.before)) === input.beforeBindingsFingerprint
    && nativeEmailDigest(input.bindings.map(pair => pair.after)) === input.afterBindingsFingerprint, 'authority_bindings_fingerprint')
  for(const role of roles){
    const pair=pipelines.get(role.pipelineId)
    requireNativeEmail(pair && role.userId!==pair.before.owner_id
      && 'capability_policy_json' in pair.before && pair.before.capability_policy_json!==null
      && JSON.parse(pair.before.readers_json).includes(role.userId) && JSON.parse(pair.after.readers_json).includes(role.userId),
    'authority_role_change_scope')
  }
  if(input.identityLinks)requireNativeEmail(principalInventory!==null
    && input.identityLinks.every(link=>principalInventory!.includes(link.userId)),'authority_identity_link_principal')
  requireNativeEmail(Array.isArray(input.membershipChanges) && input.membershipChanges.length <= 500, 'authority_membership_bound')
  previous = ''
  for (const change of input.membershipChanges) {
    exact(change,['before','after']); membership(change.after,false)
    const { before, after } = change
    requireNativeEmail(after.id > previous, 'authority_membership_order'); previous = after.id
    if (before !== null) {
      membership(before,true)
      for (const key of ['id','securitygroup_id','user_id','primary_group','noninheritable'] as const) requireNativeEmail(before[key] === after[key], 'authority_membership_identity')
    }
    requireNativeEmail(input.phase === 'revoke' ? before !== null && before.deleted === '0' && after.deleted === '1'
      : (before === null || before.deleted === '1') && after.deleted === '0' && (before !== null || after.primary_group === '0'), 'authority_membership_phase')
    const pair = input.bindings.find(value => value.before.group_id === after.securitygroup_id)
    requireNativeEmail(pair && pair.before.owner_id !== after.user_id, 'authority_membership_scope')
    requireNativeEmail(!roles.some(role=>role.pipelineId===pair!.before.pipeline_id && role.userId===after.user_id),'authority_role_membership_churn')
  }
  requireNativeEmail(Array.isArray(input.capabilities) && input.capabilities.length <= 500, 'authority_capability_bound')
  previous = ''; const globals = new Set<string>()
  for (const entry of input.capabilities) {
    exact(entry,['emailId','globalId','pipelineId','before','after']); id(entry.emailId,36); id(entry.pipelineId)
    requireNativeEmail(typeof entry.globalId === 'string' && GLOBAL.test(entry.globalId) && !globals.has(entry.globalId)
      && entry.emailId > previous && pipelines.has(entry.pipelineId), 'authority_email_identity')
    previous = entry.emailId; globals.add(entry.globalId)
    for (const stage of ['before','after'] as const) {
      exact(entry[stage],[...NATIVE_EMAIL_AUTHORITY_SURFACES])
      for (const surface of NATIVE_EMAIL_AUTHORITY_SURFACES) ids(entry[stage][surface])
      const readers: string[] = JSON.parse(pipelines.get(entry.pipelineId)![stage].readers_json)
      for (const surface of ['view','list','export'] as const) requireNativeEmail(same(readers,entry[stage][surface]), 'authority_read_binding_mismatch')
      for (const surface of ['edit','delete'] as const) requireNativeEmail(entry[stage][surface].every(value => readers.includes(value)), 'authority_write_requires_read')
    }
    for (const surface of NATIVE_EMAIL_AUTHORITY_SURFACES) {
      monotonic(entry.before[surface],entry.after[surface],input.phase)
      if (input.version === 2) memberCapabilityDelta(entry.before[surface],entry.after[surface],
        JSON.parse(pipelines.get(entry.pipelineId)!.before.readers_json),
        JSON.parse(pipelines.get(entry.pipelineId)!.after.readers_json),input.phase,
        surface==='edit'||surface==='delete'?roles.filter(role=>role.pipelineId===entry.pipelineId):[])
    }
  }
  if (input.pendingPublicationCommand !== null) {
    // Legacy authority has only the legacy publication wire. In particular,
    // do not tunnel v2 publication through a version-one authority command.
    requireNativeEmail(input.pendingPublicationCommand.version === 1, 'authority_pending_publication_version')
    const pending = input.pendingPublicationCommand, pair = pipelines.get(pending.pipelineId)
    requireNativeEmail(input.phase === 'revoke' && pair && pending.generation === input.generationFrom
      && pending.workspaceId === pair.before.workspace_id && pending.audienceFingerprint === pair.before.audience_fingerprint,
    'authority_pending_publication_scope')
    prepareNativeEmailPublication({ command:pending, nativePolicyFingerprint:input.beforePolicyFingerprint,
      allowedReaderSuiteCrmUserIds:JSON.parse(pair.before.readers_json) })
  }
  const canonical = nativeEmailCanonicalJson(input)
  requireNativeEmail(Buffer.byteLength(canonical,'utf8') <= 800000, 'authority_command_size')
  const command = JSON.parse(canonical) as NativeEmailAuthorityCommand
  return immutable({ command, commandHash:nativeEmailDigest(command) })
}

export function verifyNativeEmailAuthorityReceipt(request: NativeEmailAuthorityRequest, value: unknown): NativeEmailAuthorityReceipt {
  const expected = prepareNativeEmailAuthorityCommand(request.command)
  requireNativeEmail(expected.commandHash === request.commandHash, 'authority_request_changed')
  exact(value,['version','operationId','transitionId','phase','commandHash','state','replayed','result'])
  const c = request.command
  requireNativeEmail(value.version === c.version && value.operationId === c.operationId && value.transitionId === c.transitionId
    && value.phase === c.phase && value.commandHash === request.commandHash && typeof value.replayed === 'boolean', 'authority_receipt_identity')
  if (value.state === 'cancelled') {
    requireNativeEmail(value.result === null, 'authority_cancelled_result')
  } else {
    requireNativeEmail(value.state === 'committed', 'authority_receipt_state')
    exact(value.result,['desiredAppChangeHash','generationFrom','generationTo','beforePolicyFingerprint','afterPolicyFingerprint',
      'beforeBindingsFingerprint','afterBindingsFingerprint','capabilitiesFingerprint','pendingPublicationTerminalReceipt'])
    for (const key of ['desiredAppChangeHash','generationFrom','generationTo','beforePolicyFingerprint','afterPolicyFingerprint',
      'beforeBindingsFingerprint','afterBindingsFingerprint'] as const) requireNativeEmail(value.result[key] === c[key], 'authority_receipt_chain')
    requireNativeEmail(value.result.capabilitiesFingerprint === nativeEmailDigest(c.capabilities.map(entry => ({ emailId:entry.emailId,
      globalId:entry.globalId,pipelineId:entry.pipelineId,capabilities:entry.after }))), 'authority_capability_receipt_mismatch')
    if (c.pendingPublicationCommand === null) requireNativeEmail(value.result.pendingPublicationTerminalReceipt === null, 'authority_unexpected_publication_receipt')
    else {
      const pair = c.bindings.find(value => value.before.pipeline_id === c.pendingPublicationCommand!.pipelineId)!
      verifyNativeEmailTerminalReceipt(prepareNativeEmailPublication({ command:c.pendingPublicationCommand,
        nativePolicyFingerprint:c.beforePolicyFingerprint,allowedReaderSuiteCrmUserIds:JSON.parse(pair.before.readers_json) }),value.result.pendingPublicationTerminalReceipt)
      // Envelope only. A real settlement adapter MUST run the full raw Email
      // verifier before settling the pending app publication/outbox.
    }
  }
  requireNativeEmail(Buffer.byteLength(nativeEmailCanonicalJson(value),'utf8') <= 850000, 'authority_receipt_size')
  return immutable(JSON.parse(nativeEmailCanonicalJson(value)) as NativeEmailAuthorityReceipt)
}

export type NativeEmailAuthorityTransitionInput = {
  version: 1
  /** Opaque bounded JSON here; the persistence adapter MUST strictly authorize and
   * interpret its exact before/after scope. This module cannot apply it. */
  desiredAppChange: Record<string, unknown>
  expectedAppAuthorityBeforeFingerprint: string
  expectedAppAuthorityAfterFingerprint: string
  revoke: NativeEmailAuthorityCommand
  grant: NativeEmailAuthorityCommand
}
export type NativeEmailAuthorityTransitionPlan = NativeEmailAuthorityTransitionInput & { planHash: string }
export function prepareNativeEmailAuthorityTransition(input: NativeEmailAuthorityTransitionInput): NativeEmailAuthorityTransitionPlan {
  exact(input,['version','desiredAppChange','expectedAppAuthorityBeforeFingerprint','expectedAppAuthorityAfterFingerprint','revoke','grant'])
  requireNativeEmail(input.version === 1 && input.desiredAppChange && typeof input.desiredAppChange === 'object'
    && !Array.isArray(input.desiredAppChange), 'authority_transition_shape')
  requireNativeEmail(Buffer.byteLength(nativeEmailCanonicalJson(input.desiredAppChange),'utf8') <= 64000, 'authority_app_change_size')
  hash(input.expectedAppAuthorityBeforeFingerprint); hash(input.expectedAppAuthorityAfterFingerprint)
  const r = prepareNativeEmailAuthorityCommand(input.revoke).command, g = prepareNativeEmailAuthorityCommand(input.grant).command
  requireNativeEmail(r.version === g.version && r.phase === 'revoke' && g.phase === 'grant' && r.transitionId === g.transitionId && r.operationId !== g.operationId
    && r.desiredAppChangeHash === nativeEmailDigest(input.desiredAppChange) && r.desiredAppChangeHash === g.desiredAppChangeHash
    && r.runtimeFingerprint === g.runtimeFingerprint && r.generationTo === g.generationFrom
    && r.afterPolicyFingerprint === g.beforePolicyFingerprint && r.afterBindingsFingerprint === g.beforeBindingsFingerprint
    && same(r.bindings.map(value => value.after),g.bindings.map(value => value.before))
    && same(r.roleChanges??[],g.roleChanges??[]) && same(r.identityLinks??[],g.identityLinks??[]), 'authority_transition_chain')
  requireNativeEmail(r.capabilities.length === g.capabilities.length, 'authority_transition_matrix_coverage')
  for (const [index, first] of r.capabilities.entries()) {
    const second = g.capabilities[index]
    requireNativeEmail(first.emailId === second.emailId && first.globalId === second.globalId && first.pipelineId === second.pipelineId
      && same(first.after,second.before), 'authority_transition_matrix_chain')
    for (const surface of NATIVE_EMAIL_AUTHORITY_SURFACES) requireNativeEmail(same(first.after[surface],
      first.before[surface].filter(value => second.after[surface].includes(value))), 'authority_transition_not_exact_intersection')
  }
  for (const [index,pair] of r.bindings.entries()) {
    const final = g.bindings[index].after
    const before: string[] = JSON.parse(pair.before.readers_json), after: string[] = JSON.parse(final.readers_json)
    requireNativeEmail(same(JSON.parse(pair.after.readers_json),before.filter(value => after.includes(value))), 'authority_binding_not_exact_intersection')
    if (r.version === 2) {
      const initial = capabilityPolicy(pair.before as NativeEmailAuthorityBindingV2)
      const intermediate = capabilityPolicy(pair.after as NativeEmailAuthorityBindingV2)
      const desired = capabilityPolicy(final as NativeEmailAuthorityBindingV2)
      // Each command already proves immutable mode and principal inventory;
      // the exact intermediate binding also chains both commands above.
      if (initial && intermediate && desired) for (const surface of NATIVE_EMAIL_AUTHORITY_SURFACES)
        requireNativeEmail(same(intermediate.futureCreate[surface],initial.futureCreate[surface]
          .filter(value => desired.futureCreate[surface].includes(value))), 'authority_future_not_exact_intersection')
    }
  }
  for (const change of g.membershipChanges) {
    const prior = r.membershipChanges.find(value => value.after.id === change.after.id)
    if (prior) requireNativeEmail(same(prior.after,change.before), 'authority_membership_chain_changed')
  }
  const clone = JSON.parse(nativeEmailCanonicalJson(input)) as NativeEmailAuthorityTransitionInput
  return immutable({ ...clone,planHash:nativeEmailDigest(clone) })
}

export type NativeEmailAppAuthorityCommitReceipt = { version: 1; transitionId: string; planHash: string;
  desiredAppChangeHash: string; revokeReceiptHash: string; appAuthorityBeforeFingerprint: string; appAuthorityAfterFingerprint: string }
export function nativeEmailAuthorityReceiptHash(receipt: NativeEmailAuthorityReceipt): string {
  return nativeEmailDigest({ ...receipt,replayed:false })
}
function validateAppCommit(plan: NativeEmailAuthorityTransitionPlan, revoke: NativeEmailAuthorityReceipt, value: unknown): asserts value is NativeEmailAppAuthorityCommitReceipt {
  exact(value,['version','transitionId','planHash','desiredAppChangeHash','revokeReceiptHash','appAuthorityBeforeFingerprint','appAuthorityAfterFingerprint'])
  requireNativeEmail(revoke.state === 'committed' && value.version === 1 && value.transitionId === plan.revoke.transitionId
    && value.planHash === plan.planHash && value.desiredAppChangeHash === plan.revoke.desiredAppChangeHash
    && value.revokeReceiptHash === nativeEmailAuthorityReceiptHash(revoke)
    && value.appAuthorityBeforeFingerprint === plan.expectedAppAuthorityBeforeFingerprint
    && value.appAuthorityAfterFingerprint === plan.expectedAppAuthorityAfterFingerprint, 'authority_app_commit_proof_changed')
}
type PhaseState = { state: 'prepared' | 'dispatched' | 'unknown' | 'committed' | 'cancelled'; receipt: NativeEmailAuthorityReceipt | null }
export type NativeEmailGrantAttempt = { ordinal:number; originalOperationId:string; originalCommandHash:string;
  previousOperationId:string; previousCommandHash:string; previousCancellationReceiptHash:string }
export type NativeEmailAuthorityTransitionRecord = {
  enabled: boolean; plan: NativeEmailAuthorityTransitionPlan; revoke: PhaseState; grant: PhaseState
  appCommit: NativeEmailAppAuthorityCommitReceipt | null
  /** Must be authenticated native-registry readback, never caller-supplied
   * hashes. Grant approval creation/provisioning is deliberately NOT here. */
  grantApproval: { operationId: string; commandHash: string; appCommitFingerprint: string } | null
  /** Append-only attempt selection. The original plan and app receipt never
   * change; persistence independently verifies the retained cancelled parent. */
  grantAttempt?: NativeEmailGrantAttempt
}
/** Reconstruct, never accept, a retry command. Only its operation identity can
 * differ from the immutable original grant. Hashes are evidence, not authority:
 * both stores must verify the actual predecessor cancellation and approval. */
export function nativeEmailAuthorityPhaseCommand(record: Pick<NativeEmailAuthorityTransitionRecord,'plan'|'appCommit'|'grantAttempt'>,
  phase:'revoke'|'grant'):NativeEmailAuthorityCommand {
  const original=record.plan[phase]
  if(phase==='revoke' || !record.grantAttempt)return original
  const a=record.grantAttempt
  exact(a,['ordinal','originalOperationId','originalCommandHash','previousOperationId','previousCommandHash','previousCancellationReceiptHash'])
  requireNativeEmail(record.appCommit && Number.isSafeInteger(a.ordinal) && a.ordinal>0,'authority_grant_attempt_shape')
  for(const key of ['originalOperationId','originalCommandHash','previousOperationId','previousCommandHash','previousCancellationReceiptHash'] as const)hash(a[key])
  requireNativeEmail(a.originalOperationId===original.operationId && a.originalCommandHash===nativeEmailDigest(original)
    && a.previousOperationId!==record.plan.revoke.operationId
    && (a.ordinal===1 ? a.previousOperationId===original.operationId : a.previousOperationId!==original.operationId),
  'authority_grant_attempt_origin')
  const previous={...original,operationId:a.previousOperationId}
  requireNativeEmail(a.previousCommandHash===nativeEmailDigest(previous)
    && a.previousCancellationReceiptHash===nativeEmailAuthorityReceiptHash({version:original.version,
      operationId:previous.operationId,transitionId:original.transitionId,phase:'grant',commandHash:a.previousCommandHash,
      state:'cancelled',result:null,replayed:false}),'authority_grant_attempt_parent')
  const operationId=nativeEmailDigest({version:1,purpose:'clawpilot-native-email-grant-attempt',
    transitionId:original.transitionId,planHash:record.plan.planHash,...a,appCommitFingerprint:nativeEmailDigest(record.appCommit)})
  return prepareNativeEmailAuthorityCommand({...original,operationId}).command
}
export type NativeEmailAuthorityClaim = { owner: string; fence: number }
export interface NativeEmailAuthorityTransitionStore {
  load(transitionId: string): Promise<NativeEmailAuthorityTransitionRecord>
  /** Authorize resolver, freeze current app authority, persist dispatch exactly
   * once under control-first locks. Existing dispatch/unknown MUST return resolve.
   * Expiry only reassigns ownership; it never releases either native barrier.
   * For grant, verify provisioned native approval binds exact appCommit hash. */
  claimPhase(transitionId: string, phase: 'revoke' | 'grant', owner: string): Promise<{
    record: NativeEmailAuthorityTransitionRecord; claim: NativeEmailAuthorityClaim; action: 'execute' | 'resolve'
  }>
  markUnknown(transitionId: string, phase: 'revoke' | 'grant', claim: NativeEmailAuthorityClaim): Promise<void>
  /** Same transaction: verify current claim + immutable plan + full pending
   * publication raw receipt, retain outcome, settle phase. Never unlock on TTL.
   * A cancelled grant retains the restrictive state until a separately
   * admitted append-only retry commits. */
  settlePhase(transitionId: string, phase: 'revoke' | 'grant', claim: NativeEmailAuthorityClaim,
    receipt: NativeEmailAuthorityReceipt): Promise<NativeEmailAuthorityTransitionRecord>
  /** Single PG transaction: current actor/scope authorization, exact before-image
   * + plan/desiredAppChangeHash, committed revoke receipt, apply ONLY approved
   * change, verify full after authority, store app receipt. Lost commit response
   * is resolved by load; never by reapplying an unrecorded change. This contract
   * does NOT create a GUC bypass or permit direct writes around migration0375. */
  commitAppChange(transitionId: string, expectedPlanHash: string): Promise<NativeEmailAuthorityTransitionRecord>
}
export type NativeEmailAuthorityTransitionBridge = {
  execute(command: NativeEmailAuthorityCommand): Promise<unknown>
  /** Exact command/id; atomically return retained receipt or cancellation
   * tombstone. A timeout, 404 or pending response is never proof of no mutation. */
  resolveOrCancel(command: NativeEmailAuthorityCommand): Promise<unknown>
}
function validateRecord(record: NativeEmailAuthorityTransitionRecord, transitionId: string) {
  exact(record,['enabled','plan','revoke','grant','appCommit','grantApproval',...(record.grantAttempt ? ['grantAttempt'] : [])])
  requireNativeEmail(typeof record.enabled === 'boolean', 'authority_mode_invalid')
  const { planHash, ...input } = record.plan, prepared = prepareNativeEmailAuthorityTransition(input)
  requireNativeEmail(prepared.planHash === planHash && prepared.revoke.transitionId === transitionId, 'authority_stored_plan_changed')
  for (const phase of ['revoke','grant'] as const) {
    const state = record[phase]
    exact(state,['state','receipt'])
    requireNativeEmail(['prepared','dispatched','unknown','committed','cancelled'].includes(state.state)
      && (['committed','cancelled'].includes(state.state) === (state.receipt !== null)), 'authority_phase_state_changed')
    if (state.receipt) requireNativeEmail(verifyNativeEmailAuthorityReceipt(prepareNativeEmailAuthorityCommand(nativeEmailAuthorityPhaseCommand(record,phase)),state.receipt).state === state.state, 'authority_stored_receipt_changed')
  }
  if (record.appCommit) {
    requireNativeEmail(record.revoke.state === 'committed' && record.revoke.receipt, 'authority_app_commit_before_revoke')
    validateAppCommit(prepared,record.revoke.receipt,record.appCommit)
  }
  requireNativeEmail(record.grant.state === 'prepared' || record.appCommit !== null, 'authority_grant_before_app_commit')
  if (record.grantApproval) {
    const grant=nativeEmailAuthorityPhaseCommand(record,'grant')
    exact(record.grantApproval,['operationId','commandHash','appCommitFingerprint'])
    requireNativeEmail(record.appCommit && record.grantApproval.operationId === grant.operationId
      && record.grantApproval.commandHash === nativeEmailDigest(grant)
      && record.grantApproval.appCommitFingerprint === nativeEmailDigest(record.appCommit), 'authority_grant_approval_changed')
  }
  if(record.grantAttempt)nativeEmailAuthorityPhaseCommand(record,'grant')
  requireNativeEmail(record.grant.state === 'prepared' || record.grantApproval !== null, 'authority_grant_approval_missing')
}

/** One bounded step: one native action OR one atomic app commit. Unwired and
 * unusable without an independently tested/authorized persistence adapter. */
export function createNativeEmailAuthorityTransitionCoordinator(store: NativeEmailAuthorityTransitionStore,
  bridge: NativeEmailAuthorityTransitionBridge, owner: string) {
  return { async step(transitionId: string): Promise<{ state: 'disabled' | 'revoked' | 'app_committed' | 'complete' | 'held'; code?: string }> {
    hash(transitionId); id(owner)
    const record = await store.load(transitionId); validateRecord(record,transitionId)
    if (!record.enabled) return { state:'disabled' }
    if (record.revoke.state === 'cancelled' || record.grant.state === 'cancelled') return { state:'held',code:'authority_phase_cancelled' }
    if (record.grant.state === 'committed') return { state:'complete' }
    if (record.revoke.state === 'committed' && !record.appCommit) {
      // No automatic retry after unknown commit. The next invocation loads the
      // ledger first; adapter must make receipt + change atomic and idempotent.
      const updated = await store.commitAppChange(transitionId,record.plan.planHash); validateRecord(updated,transitionId)
      requireNativeEmail(updated.plan.planHash === record.plan.planHash && updated.appCommit, 'authority_app_commit_not_recorded')
      return { state:'app_committed' }
    }
    const phase = record.appCommit ? 'grant' : 'revoke'
    if (phase === 'grant' && !record.grantApproval) return { state:'held',code:'authority_grant_approval_required' }
    const claimed = await store.claimPhase(transitionId,phase,owner); validateRecord(claimed.record,transitionId)
    exact(claimed,['record','claim','action']); exact(claimed.claim,['owner','fence'])
    requireNativeEmail(claimed.record.enabled && claimed.record.plan.planHash === record.plan.planHash
      && claimed.claim.owner === owner && Number.isSafeInteger(claimed.claim.fence) && claimed.claim.fence > 0
      && ['dispatched','unknown'].includes(claimed.record[phase].state), 'authority_claim_changed')
    requireNativeEmail(claimed.action === 'resolve' || claimed.action === 'execute' && record[phase].state === 'prepared'
      && claimed.record[phase].state === 'dispatched', 'authority_dispatch_must_resolve')
    requireNativeEmail(same(claimed.record.grantAttempt??null,record.grantAttempt??null),'authority_grant_attempt_changed')
    const request = prepareNativeEmailAuthorityCommand(nativeEmailAuthorityPhaseCommand(claimed.record,phase))
    let receipt: NativeEmailAuthorityReceipt
    try { receipt = verifyNativeEmailAuthorityReceipt(request,await (claimed.action === 'execute'
      ? bridge.execute(request.command) : bridge.resolveOrCancel(request.command))) }
    catch { await store.markUnknown(transitionId,phase,claimed.claim); return { state:'held',code:'authority_native_outcome_unknown' } }
    const updated = await store.settlePhase(transitionId,phase,claimed.claim,receipt); validateRecord(updated,transitionId)
    requireNativeEmail(updated.plan.planHash === record.plan.planHash && updated[phase].receipt
      && nativeEmailAuthorityReceiptHash(updated[phase].receipt!) === nativeEmailAuthorityReceiptHash(receipt), 'authority_settlement_not_recorded')
    return receipt.state === 'cancelled' ? { state:'held',code:'authority_phase_cancelled' }
      : { state:phase === 'revoke' ? 'revoked' : 'complete' }
  } }
}
