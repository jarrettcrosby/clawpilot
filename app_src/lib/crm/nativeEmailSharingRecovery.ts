import { query } from '../persistence/postgres'
import { requireNativeEmail } from './nativeEmailPublication'
import { prepareNativeEmailAuthorityTransition, type NativeEmailAuthorityTransitionInput } from './nativeEmailAuthorityTransition'
import { prepareNativeEmailPipelineMemberChange } from './nativeEmailAuthorityTransitionPostgres'
import { NativeEmailAccessPendingError, changePipelineMemberWithNativeAuthority } from './nativeEmailAuthorityRuntime'

export type PendingPipelineSharingChange = Readonly<{
  transitionId: string; workspaceId: string; pipelineId: string; pipelineName: string
  userEmail: string; accessRole: 'viewer' | 'editor' | null
}>
type PendingRow = {
  enabled: boolean; active_transition_id: string | null; active_operation_id: string | null
  transition_id: string; actor_email: string; plan_hash: string; plan: unknown; grant_state: string
  pipeline_id: string; workspace_id: string; pipeline_name: string
}
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/

/** One read-only snapshot, never a signing/lease/provider operation. Match the
 * normal runtime's current owner/workspace authority, not browser form data or
 * a global-owner hint. An unrelated actor gets no pending ID or private plan. */
async function readPending(actorEmail: string, workspaceId: string) {
  requireNativeEmail(typeof actorEmail === 'string' && EMAIL.test(actorEmail) && actorEmail === actorEmail.toLowerCase()
    && typeof workspaceId === 'string' && UUID.test(workspaceId), 'authority_sharing_recovery_actor_invalid')
  const result = await query<PendingRow>(`SELECT c.enabled,c.active_transition_id,c.active_operation_id,
    t.transition_id,t.actor_email,t.plan_hash,t.plan,g.state AS grant_state,
    p.id::text AS pipeline_id,p.workspace_organization_id::text AS workspace_id,p.name AS pipeline_name
    FROM crm_native_email_publication_control c
    JOIN crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id
    JOIN crm_native_email_authority_phases g ON g.transition_id=t.transition_id AND g.phase='grant'
    JOIN pipeline_spaces p ON p.id::text=COALESCE(
      t.plan->'desiredAppChange'->'changes'->0->'after'->>'pipeline_id',
      t.plan->'desiredAppChange'->'changes'->0->'before'->>'pipeline_id')
      AND p.owner_email=$1 AND p.workspace_organization_id=$2::uuid AND NOT p.reference_access_disabled
    JOIN app_users actor ON actor.email=$1 AND actor.status='active'
    JOIN app_user_organization_memberships m ON m.user_email=actor.email AND m.organization_id=p.workspace_organization_id
      AND m.role IN ('owner','admin','member') AND m.status='active' AND m.trashed_at IS NULL
      AND jsonb_typeof(m.permissions)='object'
      AND (m.role='owner' OR m.permissions->'viewCrm' IS NULL OR m.permissions->'viewCrm'='true'::jsonb)
    JOIN workspace_organizations w ON w.id=m.organization_id AND NOT w.is_demo
    WHERE c.singleton AND c.enabled AND t.actor_email=$1 AND t.app_state<>'aborted' AND g.state<>'committed'
      AND t.plan->'desiredAppChange'->>'kind'='pipeline_members_v1'
      AND CASE WHEN jsonb_typeof(t.plan->'desiredAppChange'->'changes')='array'
        THEN jsonb_array_length(t.plan->'desiredAppChange'->'changes')=1 ELSE false END
    LIMIT 1`, [actorEmail,workspaceId])
  if (result.rows.length === 0) return null
  requireNativeEmail(result.rows.length === 1, 'authority_sharing_recovery_inventory_changed')
  const stored = result.rows[0]
  if (!stored.enabled || stored.active_transition_id === null || stored.actor_email !== actorEmail
    || stored.workspace_id !== workspaceId || stored.grant_state === 'committed') return null
  requireNativeEmail(stored.plan && typeof stored.plan === 'object' && !Array.isArray(stored.plan), 'authority_sharing_recovery_plan_invalid')
  const raw = stored.plan as Record<string, unknown>
  if ((raw.desiredAppChange as Record<string, unknown> | null)?.kind !== 'pipeline_members_v1') return null
  const { planHash, ...input } = raw
  const plan = prepareNativeEmailAuthorityTransition(input as NativeEmailAuthorityTransitionInput)
  const change = prepareNativeEmailPipelineMemberChange(plan.desiredAppChange)
  requireNativeEmail(change.changes.length === 1, 'authority_sharing_recovery_scope_invalid')
  const delta = change.changes[0], member = (delta.after ?? delta.before)!
  requireNativeEmail(HASH.test(stored.transition_id) && stored.active_transition_id === stored.transition_id
    && stored.active_operation_id === null && plan.revoke.transitionId === stored.transition_id
    && planHash === plan.planHash && stored.plan_hash === plan.planHash
    && ['prepared','dispatched','unknown','cancelled'].includes(stored.grant_state)
    && UUID.test(stored.pipeline_id) && member.pipeline_id === stored.pipeline_id
    && plan.revoke.bindings.some(b => b.before.pipeline_id === stored.pipeline_id && b.before.workspace_id === workspaceId)
    && typeof stored.pipeline_name === 'string' && stored.pipeline_name.length <= 300, 'authority_sharing_recovery_plan_changed')
  return Object.freeze({ transitionId:stored.transition_id,workspaceId,pipelineId:stored.pipeline_id,
    pipelineName:stored.pipeline_name,userEmail:member.user_email,accessRole:delta.after?.access_role ?? null })
}

export async function getPendingPipelineSharingChange(actorEmail: string, workspaceId: string): Promise<PendingPipelineSharingChange | null> {
  try { return await readPending(actorEmail,workspaceId) }
  catch { throw new NativeEmailAccessPendingError() }
}

/** Reconstruct the exact saved action. Runtime rechecks this expected ID under
 * the control lock, so a settled/replaced operation cannot become a new edit. */
export async function resumePipelineSharingChange(actorEmail: string, workspaceId: string, transitionId: string): Promise<void> {
  let authorizedId: string | null = null
  try {
    requireNativeEmail(typeof transitionId === 'string' && HASH.test(transitionId), 'authority_sharing_recovery_identity_invalid')
    const pending = await readPending(actorEmail,workspaceId)
    requireNativeEmail(pending && pending.transitionId === transitionId, 'authority_sharing_recovery_not_pending')
    authorizedId = transitionId
    const confirmed = await changePipelineMemberWithNativeAuthority({ actorEmail,workspaceId,
      pipelineId:pending.pipelineId,userEmail:pending.userEmail,accessRole:pending.accessRole },transitionId)
    requireNativeEmail(confirmed === true, 'authority_sharing_recovery_not_confirmed')
  } catch { throw new NativeEmailAccessPendingError(authorizedId) }
}
