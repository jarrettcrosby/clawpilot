import { requireNativeEmail } from './nativeEmailPublication'

type Principal = Record<string, unknown>
type Scope = { pipeline: Record<string, unknown>; principals: Principal[];
  members: Array<{ user_email: string; access_role: string }>; rootReaders?: NativeEmailRootReaderProjection[] }
/** Only constructed by the locked SQL source projector. Neither a browser DTO
 * nor a provider assertion can supply these proofs to admission: PostgreSQL
 * independently rebuilds their source/registry fingerprints at every phase. */
export type NativeEmailRootReaderProjection = {
  pipeline_id: string; workspace_id: string; grant_id: string; operator_account_id: string
  email: string; suitecrm_user_id: string | null; native_identity_count: number
  source_fingerprint: string; registry_fingerprint: string; allowed: boolean
}

/** Authority snapshots tag JSON objects/arrays to preserve their identity in
 * canonical hashes. Read the viewCrm field without weakening that encoding or
 * treating an absent/malformed object as an empty permissions grant. */
function viewCrmPermission(value: unknown, encoded: boolean): unknown {
  if (!encoded) {
    requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value), 'authority_principal_permissions_invalid')
    return (value as Principal).viewCrm
  }
  requireNativeEmail(Array.isArray(value) && value.length === 2 && value[0] === 'object' && Array.isArray(value[1]),
    'authority_principal_permissions_invalid')
  let previous: string | null = null, permission: unknown = undefined
  for (const entry of value[1]) {
    requireNativeEmail(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
      && (previous === null || previous < entry[0]), 'authority_principal_permissions_invalid')
    previous = entry[0]
    if (entry[0] === 'viewCrm') {
      requireNativeEmail(Array.isArray(entry[1]) && entry[1].length === 2 && entry[1][0] === 'boolean'
        && typeof entry[1][1] === 'boolean', 'authority_principal_permissions_invalid')
      permission = entry[1][1]
    }
  }
  return permission
}

/** App-only members have an explicit SQL NULL mapping and zero native matches;
 * their app access is separate from native readership. Missing/malformed fields
 * or ambiguous mapped identities are never inferred to be app-only or denied. */
export function nativeEmailPrincipalIsEligible(principal: Principal, encodedPermissions = false, allowAbsentMembership = false): boolean {
  const missingPermissions = encodedPermissions
    ? Array.isArray(principal.membership_permissions) && principal.membership_permissions.length === 1 && principal.membership_permissions[0] === 'null'
    : principal.membership_permissions === null
  if (allowAbsentMembership && principal.workspace_id === null && principal.membership_status === null
    && principal.membership_role === null && principal.membership_trashed_at === null && missingPermissions) {
    // Retain stale manual intent as a denied preimage. Do not reinterpret the
    // absence as an actual membership, owner/editor grant, or app-only identity.
    requireNativeEmail(typeof principal.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(principal.email)
      && principal.email === principal.email.toLowerCase() && ['active','invited','disabled'].includes(String(principal.status))
      && (principal.suitecrm_user_id === null ? principal.native_identity_count === 0
        : typeof principal.suitecrm_user_id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}(?![\s\S])/.test(principal.suitecrm_user_id)
          && principal.native_identity_count === 1), 'authority_principal_denied_or_ambiguous')
    return false
  }
  const permission = viewCrmPermission(principal.membership_permissions, encodedPermissions)
  requireNativeEmail(typeof principal.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(principal.email)
    && principal.email === principal.email.toLowerCase()
    && ['active', 'invited', 'disabled'].includes(String(principal.status))
    && ['active', 'invited', 'disabled'].includes(String(principal.membership_status))
    && ['owner', 'admin', 'member'].includes(String(principal.membership_role))
    && (principal.membership_trashed_at === null || typeof principal.membership_trashed_at === 'string'
      && Number.isFinite(Date.parse(principal.membership_trashed_at)))
    && (permission === undefined || typeof permission === 'boolean'), 'authority_principal_denied_or_ambiguous')
  if (principal.suitecrm_user_id === null && principal.native_identity_count === 0) return false
  requireNativeEmail(typeof principal.suitecrm_user_id === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}(?![\s\S])/.test(principal.suitecrm_user_id)
    && Number(principal.native_identity_count) === 1, 'authority_principal_denied_or_ambiguous')
  return principal.status === 'active' && principal.membership_status === 'active'
    && principal.membership_trashed_at === null && (principal.membership_role === 'owner' || permission !== false)
}

/** All intended members and complete authority preimages remain in the scope;
 * only effective principals feed reader/writer matrices. No membership mutation
 * or authority change is authorized by this shared derivation. */
export function nativeEmailManualPipelinePrincipals(scope: Scope, encodedPermissions = true): Principal[] {
  const selected = new Set([String(scope.pipeline.owner_email)])
  const memberEmails = new Set<string>()
  for (const member of scope.members) {
    requireNativeEmail(['viewer', 'editor'].includes(member.access_role) && !memberEmails.has(member.user_email),
      'authority_pipeline_member_invalid')
    memberEmails.add(member.user_email)
    selected.add(member.user_email)
  }
  const emails = new Set<string>(), nativeIds = new Set<string>(), eligible: Principal[] = []
  for (const principal of scope.principals) {
    const allowed = nativeEmailPrincipalIsEligible(principal, encodedPermissions, true)
    const email = String(principal.email), nativeId = principal.suitecrm_user_id
    requireNativeEmail(!emails.has(email) && (nativeId === null || !nativeIds.has(String(nativeId))), 'authority_principal_denied_or_ambiguous')
    emails.add(email)
    if (nativeId !== null) nativeIds.add(String(nativeId))
    if (selected.has(email) && allowed) eligible.push(principal)
  }
  requireNativeEmail([...selected].every(email => emails.has(email)), 'authority_principal_missing')
  requireNativeEmail(eligible.some(row => row.email === scope.pipeline.owner_email), 'authority_owner_ineligible')
  return eligible
}

export function nativeEmailEffectivePipelinePrincipals(scope: Scope, encodedPermissions = true): Principal[] {
  const effective = new Map(nativeEmailManualPipelinePrincipals(scope,encodedPermissions).map(principal => [String(principal.email),principal]))
  const identities = new Map(scope.principals.filter(principal=>principal.suitecrm_user_id!==null)
    .map(principal=>[String(principal.suitecrm_user_id),String(principal.email)]))
  const roots = scope.rootReaders ?? []
  requireNativeEmail(Array.isArray(roots) && roots.length <= 500, 'authority_root_reader_bound')
  let previous = ''
  for (const root of roots) {
    requireNativeEmail(root && typeof root==='object' && !Array.isArray(root)
      && Object.keys(root).sort().join() === ['pipeline_id','workspace_id','grant_id','operator_account_id','email',
        'suitecrm_user_id','native_identity_count','source_fingerprint','registry_fingerprint','allowed'].sort().join()
      && ['pipeline_id','workspace_id','grant_id','operator_account_id'].every(key=>typeof root[key as keyof typeof root]==='string'
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(root[key as keyof typeof root] as string))
      && root.grant_id > previous && root.pipeline_id === scope.pipeline.id && root.workspace_id === scope.pipeline.workspace_organization_id
      && typeof root.email==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(root.email) && root.email===root.email.toLowerCase()
      && [root.source_fingerprint,root.registry_fingerprint].every(value=>typeof value==='string' && /^[a-f0-9]{64}(?![\s\S])/.test(value))
      && typeof root.allowed==='boolean' && (root.suitecrm_user_id===null ? root.native_identity_count===0
        : typeof root.suitecrm_user_id==='string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}(?![\s\S])/.test(root.suitecrm_user_id)
          && root.native_identity_count===1), 'authority_root_reader_invalid')
    previous=root.grant_id
    if(root.suitecrm_user_id!==null){
      requireNativeEmail(!identities.has(root.suitecrm_user_id)||identities.get(root.suitecrm_user_id)===root.email,'authority_root_identity_ambiguous')
      identities.set(root.suitecrm_user_id,root.email)
    }
    if(root.allowed && root.suitecrm_user_id!==null){
      const manual=effective.get(root.email)
      requireNativeEmail(!manual||manual.suitecrm_user_id===root.suitecrm_user_id,'authority_root_identity_ambiguous')
      if(!manual)effective.set(root.email,{email:root.email,suitecrm_user_id:root.suitecrm_user_id,root_grant_id:root.grant_id})
    }
  }
  return [...effective.values()]
}

/** Native roles describe effective write permission, not whether a PM row
 * remains. Removing an explicit editor while root reading remains is a native
 * editor-to-viewer transition, never permission to retain those write rights. */
export function nativeEmailEffectiveRoleChanges(changes: Array<{
  before: {pipeline_id:string;user_email:string;access_role:'viewer'|'editor'} | null
  after: {pipeline_id:string;user_email:string;access_role:'viewer'|'editor'} | null
}>, beforeScopes: Scope[], afterScopes: Scope[]) {
  const result: Array<{pipelineId:string;userId:string;beforeRole:'viewer'|'editor';afterRole:'viewer'|'editor'}> = []
  for(const delta of changes){
    if(!delta.before)continue
    const before=beforeScopes.find(scope=>scope.pipeline.id===delta.before!.pipeline_id)
    const after=afterScopes.find(scope=>scope.pipeline.id===delta.before!.pipeline_id)
    requireNativeEmail(before&&after,'authority_role_pipeline_missing')
    const principal=before.principals.find(row=>row.email===delta.before!.user_email)
    requireNativeEmail(principal,'authority_principal_missing')
    if(principal.suitecrm_user_id===null)continue
    let afterRole=delta.after?.access_role
    if(!delta.after && delta.before.access_role==='editor'
      && nativeEmailEffectivePipelinePrincipals(after).some(row=>row.suitecrm_user_id===principal.suitecrm_user_id))afterRole='viewer'
    if(afterRole && afterRole!==delta.before.access_role)result.push({pipelineId:delta.before.pipeline_id,
      userId:String(principal.suitecrm_user_id),beforeRole:delta.before.access_role,afterRole})
  }
  return result.sort((a,b)=>(a.pipelineId+'\0'+a.userId)<(b.pipelineId+'\0'+b.userId)?-1:1)
}
