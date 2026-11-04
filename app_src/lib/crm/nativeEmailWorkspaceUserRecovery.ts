import { query } from '../persistence/postgres'
import { requireNativeEmail } from './nativeEmailPublication'
import { prepareNativeEmailAuthorityTransition, type NativeEmailAuthorityTransitionInput } from './nativeEmailAuthorityTransition'
import { NativeEmailAccessPendingError } from './nativeEmailAuthorityRuntime'
import { changeWorkspaceUserWithNativeAuthority, resumePendingExistingUserIdentityWithNativeAuthority } from './nativeEmailWorkspaceUserRuntime'
import { prepareNativeEmailWorkspaceUserEligibilityChange, type NativeEmailWorkspaceUserEligibilityRequest } from './nativeEmailWorkspaceUserEligibility'
import { prepareNativeEmailUserIdentityLinkChange } from './nativeEmailIdentityLinkChange'

export type PendingWorkspaceUserAuthorityChange = Readonly<{
  transitionId: string
  userEmail: string
  workspaceId: string
  actionKind: 'status' | 'trash' | 'access' | 'identity_link'
}>
type PendingRow = {
  enabled: boolean; active_transition_id: string | null; active_operation_id: string | null
  transition_id: string; actor_email: string; plan_hash: string; plan: unknown
}
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/

/** Discovery only: one MVCC read, no lock, lease, signing or provider request.
 * The actor must still be an active manager in the original selected source
 * workspace. Native/app authorization is independently rechecked on resume. */
async function readPending(actorEmail: string, actorWorkspaceId: string) {
  requireNativeEmail(typeof actorEmail === 'string' && EMAIL.test(actorEmail) && actorEmail === actorEmail.toLowerCase()
    && typeof actorWorkspaceId === 'string' && UUID.test(actorWorkspaceId), 'authority_recovery_actor_invalid')
  const result = await query<PendingRow>(`SELECT c.enabled,c.active_transition_id,c.active_operation_id,
    t.transition_id,t.actor_email,t.plan_hash,t.plan
    FROM crm_native_email_publication_control c
    JOIN crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id
    JOIN app_users actor ON actor.email=$1 AND actor.status='active'
    JOIN app_user_organization_memberships m ON m.user_email=actor.email AND m.organization_id=$2::uuid
      AND m.status='active' AND m.trashed_at IS NULL
      AND (m.role='owner' OR (m.role='admin' AND m.permissions->'manageUserAccess'='true'::jsonb))
    JOIN workspace_organizations source ON source.id=m.organization_id AND NOT source.is_demo
    WHERE c.singleton AND c.enabled AND c.active_transition_id IS NOT NULL AND t.actor_email=$1
      AND t.plan->'desiredAppChange'->>'kind' IN ('workspace_user_eligibility_v1','user_identity_link_v1')
      AND t.plan->'desiredAppChange'->'actorScope'->>'workspaceId'=$2::text
    LIMIT 1`, [actorEmail,actorWorkspaceId])
  if (result.rows.length === 0) return null
  requireNativeEmail(result.rows.length === 1, 'authority_recovery_inventory_changed')
  const stored = result.rows[0]
  if (!stored.enabled || stored.active_transition_id === null || stored.actor_email !== actorEmail) return null
  requireNativeEmail(stored.plan && typeof stored.plan === 'object' && !Array.isArray(stored.plan), 'authority_recovery_plan_invalid')
  const raw = stored.plan as Record<string, unknown>
  const desired = raw.desiredAppChange as Record<string, unknown> | null
  if (!desired || !['workspace_user_eligibility_v1','user_identity_link_v1'].includes(String(desired.kind))) return null
  const actorScope = desired.actorScope as Record<string, unknown> | null
  if (!actorScope || actorScope.workspaceId !== actorWorkspaceId) return null
  const { planHash, ...input } = raw
  const plan = prepareNativeEmailAuthorityTransition(input as NativeEmailAuthorityTransitionInput)
  requireNativeEmail(HASH.test(stored.transition_id) && stored.active_transition_id === stored.transition_id
    && stored.active_operation_id === null && plan.revoke.transitionId === stored.transition_id
    && planHash === plan.planHash && stored.plan_hash === plan.planHash, 'authority_recovery_plan_changed')
  const change = desired.kind === 'user_identity_link_v1'
    ? prepareNativeEmailUserIdentityLinkChange(plan.desiredAppChange)
    : prepareNativeEmailWorkspaceUserEligibilityChange(plan.desiredAppChange)
  return { change, metadata: Object.freeze({ transitionId:stored.transition_id,userEmail:change.userEmail,
    workspaceId:change.workspaceId,actionKind:change.kind==='user_identity_link_v1'?'identity_link' as const:change.action.kind }) }
}

export async function getPendingWorkspaceUserAuthorityChange(
  actorEmail: string, actorWorkspaceId: string,
): Promise<PendingWorkspaceUserAuthorityChange | null> {
  try { return (await readPending(actorEmail,actorWorkspaceId))?.metadata ?? null }
  catch { throw new NativeEmailAccessPendingError() }
}

/** Reconstruct only the admitted action, never browser-supplied desired state.
 * The explicit expected ID is rechecked under the runtime control lock, so a
 * settled/replaced transition cannot race this read into a new user mutation. */
export async function resumeWorkspaceUserAuthorityChange(
  actorEmail: string, actorWorkspaceId: string, transitionId: string,
): Promise<Readonly<{ userEmail: string; workspaceId: string }>> {
  let authorizedId: string | null = null
  try {
    requireNativeEmail(typeof transitionId === 'string' && HASH.test(transitionId), 'authority_recovery_identity_invalid')
    const pending = await readPending(actorEmail,actorWorkspaceId)
    requireNativeEmail(pending && pending.metadata.transitionId === transitionId, 'authority_recovery_not_pending')
    authorizedId = transitionId
    const { change } = pending
    if(change.kind==='user_identity_link_v1'){
      const confirmed=await resumePendingExistingUserIdentityWithNativeAuthority(
        actorEmail,change.workspaceId,change.userEmail,transitionId,actorWorkspaceId)
      requireNativeEmail(confirmed===true,'authority_recovery_not_confirmed')
      return Object.freeze({userEmail:change.userEmail,workspaceId:change.workspaceId})
    }
    const request: NativeEmailWorkspaceUserEligibilityRequest = { workspaceId:change.workspaceId,userEmail:change.userEmail,
      action:change.action.kind === 'access'
        ? { kind:'access',role:change.action.role,permissions:JSON.parse(change.action.permissionsJson) as Record<string,boolean> }
        : change.action }
    const confirmed = await changeWorkspaceUserWithNativeAuthority(actorEmail,request,actorWorkspaceId,transitionId)
    requireNativeEmail(confirmed === true, 'authority_recovery_not_confirmed')
    return Object.freeze({ userEmail:change.userEmail,workspaceId:change.workspaceId })
  } catch {
    // Do not expose another actor's pending ID, full command, provider or SQL.
    throw new NativeEmailAccessPendingError(authorizedId)
  }
}
