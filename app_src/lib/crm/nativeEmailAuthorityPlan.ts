import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'
import { suiteCrmEmailAudienceFingerprint } from './suiteCrmNativeEmailProjection'
import { NATIVE_EMAIL_AUTHORITY_SURFACES, prepareNativeEmailAuthorityCommand, prepareNativeEmailAuthorityTransition,
  type NativeEmailAuthorityBindingV2, type NativeEmailAuthorityCapabilities, type NativeEmailAuthorityCommand,
  type NativeEmailAuthorityMembership } from './nativeEmailAuthorityTransition'
import type { NativeEmailCapabilityContract } from './nativeEmailCapabilityContract'
import type { PostgresNativeEmailAuthorityTransitionStore } from './nativeEmailAuthorityTransitionPostgres'
import { nativeEmailEffectivePipelinePrincipals, nativeEmailManualPipelinePrincipals, nativeEmailEffectiveRoleChanges } from './nativeEmailEligibility'
import { nativeEmailEligibilityFinalCapabilities } from './nativeEmailWorkspaceUserEligibility'

type AppPreview = Awaited<ReturnType<PostgresNativeEmailAuthorityTransitionStore['previewMemberChange']>> |
  Awaited<ReturnType<PostgresNativeEmailAuthorityTransitionStore['previewRootRegistryChange']>> |
  Awaited<ReturnType<PostgresNativeEmailAuthorityTransitionStore['previewUserIdentityLink']>> |
  Exclude<Awaited<ReturnType<PostgresNativeEmailAuthorityTransitionStore['previewWorkspaceUserEligibility']>>,{unchanged:true}>
export type NativeEmailAuthorityInspection = {
  version: 1; generation: number; nativePolicyFingerprint: string; runtimeFingerprint: string; beforeBindingsFingerprint: string
  bindings: NativeEmailAuthorityBindingV2[]; memberships: NativeEmailAuthorityMembership[]
  capabilities: Array<{ emailId: string; globalId: string; pipelineId: string; capabilities: NativeEmailAuthorityCapabilities }>
  principalSuiteCrmUserIds: string[]
}
export type NativeEmailAuthorityForecastInput = {
  version: 1; beforePolicyFingerprint: string; beforeBindingsFingerprint: string
  revokeMembershipChanges: NativeEmailAuthorityCommand['membershipChanges']
  grantMembershipChanges: NativeEmailAuthorityCommand['membershipChanges']
}
const HASH = /^[a-f0-9]{64}$/
const same = (a: unknown, b: unknown) => nativeEmailCanonicalJson(a) === nativeEmailCanonicalJson(b)
const copy = <T>(value: T): T => JSON.parse(nativeEmailCanonicalJson(value))
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(), keys.sort()), 'authority_inspection_shape')
}
/** Provider evidence is provisional, not authority. The durable PG adapter
 * independently authorizes every selected principal and compares exact native
 * identities and policy pins before it can sign either phase. */
export function readNativeEmailAuthorityInspection(value: unknown): NativeEmailAuthorityInspection {
  exact(value, ['version','generation','nativePolicyFingerprint','runtimeFingerprint','beforeBindingsFingerprint',
    'bindings','memberships','capabilities','principalSuiteCrmUserIds'])
  requireNativeEmail(value.version === 1 && Number.isSafeInteger(value.generation) && Number(value.generation) > 0
    && Number(value.generation) < Number.MAX_SAFE_INTEGER - 2, 'authority_inspection_generation')
  for (const field of ['nativePolicyFingerprint','runtimeFingerprint','beforeBindingsFingerprint'])
    requireNativeEmail(typeof value[field] === 'string' && HASH.test(value[field] as string), 'authority_inspection_hash')
  requireNativeEmail(Array.isArray(value.bindings) && value.bindings.length > 0 && value.bindings.length <= 100
    && Array.isArray(value.memberships) && value.memberships.length <= 500
    && Array.isArray(value.capabilities) && value.capabilities.length <= 500
    && Array.isArray(value.principalSuiteCrmUserIds) && value.principalSuiteCrmUserIds.length <= 500,
  'authority_inspection_bounds')
  const snapshot = copy(value) as NativeEmailAuthorityInspection
  requireNativeEmail(snapshot.principalSuiteCrmUserIds.every((id,index) => typeof id === 'string'
    && /^[a-z0-9][a-z0-9-]{0,35}$/i.test(id) && (index === 0 || snapshot.principalSuiteCrmUserIds[index-1] < id)),
  'authority_inspection_principals')
  requireNativeEmail(nativeEmailDigest(snapshot.bindings) === snapshot.beforeBindingsFingerprint, 'authority_inspection_bindings')
  // Reuse the exact full wire validators via a harmless empty-delta command.
  // No admission, signing, provider mutation or database write occurs here.
  const noChange: NativeEmailAuthorityCommand = { version:2,operationId:'a'.repeat(64),transitionId:'b'.repeat(64),phase:'revoke',
    generationFrom:snapshot.generation,generationTo:snapshot.generation+1,desiredAppChangeHash:'c'.repeat(64),
    beforePolicyFingerprint:snapshot.nativePolicyFingerprint,afterPolicyFingerprint:snapshot.nativePolicyFingerprint,
    beforeBindingsFingerprint:snapshot.beforeBindingsFingerprint,afterBindingsFingerprint:'',runtimeFingerprint:snapshot.runtimeFingerprint,
    bindings:snapshot.bindings.map(before => ({ before, after:{ ...before,generation:String(snapshot.generation+1) } })),
    membershipChanges:[],capabilities:snapshot.capabilities.map(row => ({ emailId:row.emailId,globalId:row.globalId,pipelineId:row.pipelineId,
      before:row.capabilities,after:row.capabilities })),pendingPublicationCommand:null }
  noChange.afterBindingsFingerprint = nativeEmailDigest(noChange.bindings.map(pair => pair.after))
  prepareNativeEmailAuthorityCommand(noChange)
  const groups = new Map(snapshot.bindings.map(binding => [binding.group_id,binding]))
  let previous = ''
  const pairs = new Set<string>()
  for (const row of snapshot.memberships) {
    exact(row, ['id','date_modified','deleted','securitygroup_id','user_id','primary_group','noninheritable'])
    requireNativeEmail(typeof row.id === 'string' && /^[a-z0-9][a-z0-9-]{0,35}$/i.test(row.id) && row.id > previous
      && typeof row.user_id === 'string' && snapshot.principalSuiteCrmUserIds.includes(row.user_id)
      && groups.has(row.securitygroup_id) && ['0','1'].includes(row.deleted)
      && ['0','1',null].includes(row.primary_group) && row.noninheritable === '1'
      && (row.date_modified === null || typeof row.date_modified === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(row.date_modified)),
    'authority_inspection_membership')
    previous = row.id
    const key = row.securitygroup_id + ':' + row.user_id
    requireNativeEmail(!pairs.has(key), 'authority_inspection_duplicate_member'); pairs.add(key)
  }
  for (const binding of snapshot.bindings) {
    const policy = binding.capability_policy_json === null ? null : JSON.parse(binding.capability_policy_json) as NativeEmailCapabilityContract
    requireNativeEmail((policy === null || same(policy.principalSuiteCrmUserIds,snapshot.principalSuiteCrmUserIds))
      && same(snapshot.memberships.filter(row => row.securitygroup_id === binding.group_id && row.deleted === '0')
        .map(row => row.user_id).sort(),JSON.parse(binding.readers_json)), 'authority_inspection_reader_inventory')
  }
  return snapshot
}

/** Build an exact membership/role plan only from locked PG preview plus authenticated
 * native inspection/forecast. Never accept a browser-supplied matrix or proof.
 * Existing native editor subsets are preserved, not reset to future defaults. */
export async function buildNativeEmailMemberTransition(input: {
  app: AppPreview; inspection: unknown; transitionId: string; timestamp: string
  newMembershipId: () => string; forecast: (request: NativeEmailAuthorityForecastInput) => Promise<unknown>
}) {
  const native = readNativeEmailAuthorityInspection(input.inspection)
  requireNativeEmail(HASH.test(input.transitionId) && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(input.timestamp), 'authority_plan_identity')
  const change = input.app.desiredAppChange
  const memberChanges = change.kind==='pipeline_members_v1'?change.changes:[]
  for (const delta of memberChanges) requireNativeEmail(native.bindings.find(row => row.pipeline_id === (delta.after ?? delta.before)!.pipeline_id)
    ?.capability_policy_json != null, 'authority_lifecycle_requires_v2_policy')
  const finalReaders = new Map<string,string[]>(), addedEditors = new Map<string,string[]>(), demotedEditors = new Map<string,Set<string>>()
  requireNativeEmail(same(native.bindings.map(row => row.pipeline_id),input.app.snapshots.before.pipelines.map(row => row.pipeline.id)),
    'authority_plan_pipeline_coverage')
  for (const scope of input.app.snapshots.after.pipelines) {
    const effective = nativeEmailEffectivePipelinePrincipals(scope)
    const manual = nativeEmailManualPipelinePrincipals(scope)
    finalReaders.set(String(scope.pipeline.id),effective.map(row => String(row.suitecrm_user_id)).sort())
    addedEditors.set(String(scope.pipeline.id),change.kind==='user_identity_link_v1'
      ?manual.filter(row=>row.email===change.userEmail&&scope.members.some(member=>member.user_email===row.email&&member.access_role==='editor'))
        .map(row=>String(row.suitecrm_user_id)).sort()
      :memberChanges.filter(delta => delta.after !== null && delta.after.pipeline_id === scope.pipeline.id && delta.after.access_role === 'editor')
        .flatMap(delta => manual.filter(row => row.email === delta.after!.user_email).map(row => String(row.suitecrm_user_id))).sort())
    demotedEditors.set(String(scope.pipeline.id),new Set(memberChanges.filter(delta => delta.before !== null && delta.before.pipeline_id === scope.pipeline.id
      && delta.before.access_role === 'editor' && delta.after?.access_role !== 'editor')
      .flatMap(delta => effective.filter(row => row.email === delta.before!.user_email).map(row => String(row.suitecrm_user_id)))))
  }
  const revokeChanges: NativeEmailAuthorityCommand['membershipChanges'] = [], grantChanges: NativeEmailAuthorityCommand['membershipChanges'] = []
  for (const binding of native.bindings) {
    const before: string[] = JSON.parse(binding.readers_json), after = finalReaders.get(binding.pipeline_id)!
    if(!same(before,after))requireNativeEmail(binding.capability_policy_json!==null,'authority_lifecycle_requires_v2_policy')
    for (const userId of before.filter(id => !after.includes(id))) {
      const row = native.memberships.find(row => row.securitygroup_id === binding.group_id && row.user_id === userId && row.deleted === '0')
      requireNativeEmail(row && userId !== binding.owner_id, 'authority_plan_revoke_identity')
      revokeChanges.push({ before:row,after:{ ...row,deleted:'1',date_modified:input.timestamp } })
    }
    for (const userId of after.filter(id => !before.includes(id))) {
      const row = native.memberships.find(row => row.securitygroup_id === binding.group_id && row.user_id === userId)
      requireNativeEmail(!row || row.deleted === '1', 'authority_plan_grant_identity')
      grantChanges.push({ before:row ?? null,after:row ? { ...row,deleted:'0',date_modified:input.timestamp }
        : { id:input.newMembershipId(),securitygroup_id:binding.group_id,user_id:userId,date_modified:input.timestamp,
          deleted:'0',primary_group:'0',noninheritable:'1' } })
    }
  }
  const sort = (a: typeof revokeChanges[number], b: typeof revokeChanges[number]) => a.after.id < b.after.id ? -1 : a.after.id > b.after.id ? 1 : 0
  revokeChanges.sort(sort); grantChanges.sort(sort)
  const forecast = await input.forecast({ version:1,beforePolicyFingerprint:native.nativePolicyFingerprint,
    beforeBindingsFingerprint:native.beforeBindingsFingerprint,revokeMembershipChanges:revokeChanges,grantMembershipChanges:grantChanges })
  exact(forecast,['version','beforePolicyFingerprint','revokePolicyFingerprint','grantPolicyFingerprint'])
  requireNativeEmail(forecast.version === 1 && forecast.beforePolicyFingerprint === native.nativePolicyFingerprint
    && typeof forecast.revokePolicyFingerprint === 'string' && HASH.test(forecast.revokePolicyFingerprint)
    && typeof forecast.grantPolicyFingerprint === 'string' && HASH.test(forecast.grantPolicyFingerprint), 'authority_forecast_changed')
  const finalMatrix = (pipelineId: string, prior: NativeEmailAuthorityCapabilities, emailId:string|null=null) => {
    const readers = finalReaders.get(pipelineId)!, editors = addedEditors.get(pipelineId)!
    if(change.kind==='workspace_user_eligibility_v1')return nativeEmailEligibilityFinalCapabilities({change,
      restoration:input.app.snapshots.restoration,pipelineId,emailId,readers,before:prior})
    return Object.fromEntries(NATIVE_EMAIL_AUTHORITY_SURFACES.map(surface => [surface,
      surface === 'edit' || surface === 'delete' ? [...new Set([...prior[surface].filter(id => readers.includes(id)
        && !demotedEditors.get(pipelineId)!.has(id)),...editors])].sort() : [...readers]])) as NativeEmailAuthorityCapabilities
  }
  const middleMatrix = (prior: NativeEmailAuthorityCapabilities, after: NativeEmailAuthorityCapabilities) =>
    Object.fromEntries(NATIVE_EMAIL_AUTHORITY_SURFACES.map(surface => [surface,prior[surface].filter(id => after[surface].includes(id))])) as NativeEmailAuthorityCapabilities
  const binding = (before: NativeEmailAuthorityBindingV2, stage: 'middle'|'after'): NativeEmailAuthorityBindingV2 => {
    if (before.capability_policy_json === null) {
      // Unchanged legacy scopes remain in the full snapshot and phase hash.
      // Never enroll/downgrade them or infer future rights from a historical
      // matrix. The PG adapter still independently validates their authority.
      requireNativeEmail(same(JSON.parse(before.readers_json),finalReaders.get(before.pipeline_id)), 'authority_legacy_reader_change')
      return { ...before,generation:String(native.generation+(stage === 'middle' ? 1 : 2)),
        policy_fingerprint:String(stage === 'middle' ? forecast.revokePolicyFingerprint : forecast.grantPolicyFingerprint) }
    }
    const policy = JSON.parse(before.capability_policy_json!) as NativeEmailCapabilityContract
    const final = finalMatrix(before.pipeline_id,policy.futureCreate)
    policy.futureCreate = stage === 'middle' ? middleMatrix(policy.futureCreate,final) : final
    const readers = policy.futureCreate.view
    policy.audienceFingerprint = suiteCrmEmailAudienceFingerprint({ policy:'pipeline-internal',ownerSuiteCrmId:before.owner_id,
      allowedSuiteCrmUserIds:readers,workspaceId:before.workspace_id,pipelineId:before.pipeline_id,fingerprint:'' })
    const { historical, ...future } = policy; void historical
    return { ...before,generation:String(native.generation+(stage === 'middle' ? 1 : 2)),readers_json:nativeEmailCanonicalJson(readers),
      audience_fingerprint:policy.audienceFingerprint,policy_fingerprint:String(stage === 'middle' ? forecast.revokePolicyFingerprint : forecast.grantPolicyFingerprint),
      capability_policy_json:nativeEmailCanonicalJson(policy),capability_policy_fingerprint:nativeEmailDigest(future) }
  }
  const middle = native.bindings.map(row => binding(row,'middle')), after = native.bindings.map(row => binding(row,'after'))
  const roleChanges=nativeEmailEffectiveRoleChanges(memberChanges,input.app.snapshots.before.pipelines,input.app.snapshots.after.pipelines)
  const command = (phase: 'revoke'|'grant'): NativeEmailAuthorityCommand => {
    const beforeBindings = phase === 'revoke' ? native.bindings : middle, afterBindings = phase === 'revoke' ? middle : after
    return { version:2,operationId:nativeEmailDigest([input.transitionId,phase]),transitionId:input.transitionId,phase,
      generationFrom:native.generation+(phase === 'revoke' ? 0 : 1),generationTo:native.generation+(phase === 'revoke' ? 1 : 2),
      desiredAppChangeHash:nativeEmailDigest(change),beforePolicyFingerprint:phase === 'revoke' ? native.nativePolicyFingerprint : String(forecast.revokePolicyFingerprint),
      afterPolicyFingerprint:String(phase === 'revoke' ? forecast.revokePolicyFingerprint : forecast.grantPolicyFingerprint),
      beforeBindingsFingerprint:nativeEmailDigest(beforeBindings),afterBindingsFingerprint:nativeEmailDigest(afterBindings),runtimeFingerprint:native.runtimeFingerprint,
      bindings:beforeBindings.map((before,index) => ({ before,after:afterBindings[index] })),
      membershipChanges:phase === 'revoke' ? revokeChanges : grantChanges,
      capabilities:native.capabilities.map(row => {
        const final = finalMatrix(row.pipelineId,row.capabilities,row.emailId), intermediate = middleMatrix(row.capabilities,final)
        return { emailId:row.emailId,globalId:row.globalId,pipelineId:row.pipelineId,
          before:phase === 'revoke' ? row.capabilities : intermediate,after:phase === 'revoke' ? intermediate : final }
      }),pendingPublicationCommand:null,...(roleChanges.length?{roleChanges}:{}),
      ...(change.kind==='user_identity_link_v1'?{identityLinks:[change.nativeIdentity]}:{}) }
  }
  return prepareNativeEmailAuthorityTransition({ version:1,desiredAppChange:change,
    expectedAppAuthorityBeforeFingerprint:input.app.appAuthorityBeforeFingerprint,
    expectedAppAuthorityAfterFingerprint:input.app.appAuthorityAfterFingerprint,revoke:command('revoke'),grant:command('grant') })
}
