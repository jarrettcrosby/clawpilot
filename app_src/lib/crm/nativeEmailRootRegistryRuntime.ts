import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withTransaction, query } from '../persistence/postgres'
import { lockCrmNativeEmailAuthorityWithClient } from '../persistence/crmNativeEmailAuthority'
import { recordAuditEvent } from '../auditWriter'
import { nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'
import { prepareRootEmployeeCrmRegistryChange } from './rootEmployeeCrmRegistryChange'
import { PostgresNativeEmailAuthorityTransitionStore } from './nativeEmailAuthorityTransitionPostgres'
import { createSuiteCrmNativeEmailAuthorityClient } from './nativeEmailAuthorityTransport'
import { buildNativeEmailMemberTransition, readNativeEmailAuthorityInspection } from './nativeEmailAuthorityPlan'
import { NativeEmailAccessPendingError, nativeEmailAuthorityConfiguration, resumeNativeEmailAuthorityChange } from './nativeEmailAuthorityRuntime'
import { prepareNativeEmailAuthorityTransition, type NativeEmailAuthorityTransitionInput } from './nativeEmailAuthorityTransition'

const HASH = /^[a-f0-9]{64}(?![\s\S])/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/
function actor(email: string, workspaceId: string) {
  requireNativeEmail(typeof email === 'string' && EMAIL.test(email) && email === email.toLowerCase()
    && typeof workspaceId === 'string' && UUID.test(workspaceId), 'authority_root_actor_invalid')
}
function selection(value: ReturnType<typeof prepareRootEmployeeCrmRegistryChange>) {
  const { contextFingerprint, ...selected } = value; void contextFingerprint
  return nativeEmailDigest(selected)
}

/** Internal coordinator for server-derived registry deltas, not a browser
 * endpoint. The normal owner workflow must first build exact rows from actual
 * SQL. An enabled native policy never falls through to ordinary registry SQL.
 * Both admission and resume re-authorize the immutable owner/root anchor and
 * complete source inventory; a mere pending ID or caller fingerprint grants
 * nothing. No native User creation, activation or provider reconnect occurs. */
export async function changeRootEmployeeCrmRegistryWithNativeAuthority(actorEmail: string, actorWorkspaceId: string,
  value: unknown, expectedTransitionId?: string): Promise<boolean> {
  let transitionId: string | null = null
  try {
    actor(actorEmail, actorWorkspaceId)
    const proposed = prepareRootEmployeeCrmRegistryChange(value)
    requireNativeEmail(proposed.ownerEmail === actorEmail && proposed.workspaceId === actorWorkspaceId, 'authority_root_actor_denied')
    if (expectedTransitionId !== undefined) requireNativeEmail(typeof expectedTransitionId === 'string' && HASH.test(expectedTransitionId), 'authority_resume_identity_invalid')
    const selected = await withTransaction(async tx => {
      await lockCrmNativeEmailAuthorityWithClient(tx)
      const control = (await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton')).rows[0]
      requireNativeEmail(control && typeof control.enabled === 'boolean', 'authority_control_missing')
      // Authorize the actual immutable root before reading dedicated provider
      // configuration or issuing even a read-only native inspection. This
      // check also applies to the disabled-policy legacy return.
      const owners = (await tx.query(`SELECT u.email FROM app_users u
        JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=$2::uuid
        JOIN workspace_organizations w ON w.id=m.organization_id
        WHERE u.email=$1 AND u.status='active' AND m.status='active' AND m.role='owner' AND m.trashed_at IS NULL
          AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo
          AND NOT EXISTS(SELECT 1 FROM crm_operator_accounts a
            WHERE (a.id=$3::uuid OR a.root_workspace_id=w.id)
              AND (a.id::text,a.root_workspace_id::text,a.owner_email) IS DISTINCT FROM ($3::text,$2::text,$1::text))`,
      [actorEmail,actorWorkspaceId,proposed.operatorAccountId])).rows
      requireNativeEmail(owners.length === 1, 'authority_root_actor_denied')
      if (!control.enabled) { requireNativeEmail(expectedTransitionId === undefined, 'authority_resume_changed'); return { disabled: true as const } }
      requireNativeEmail(control.active_operation_id === null, 'authority_publication_not_drained')
      if (expectedTransitionId !== undefined) {
        requireNativeEmail(control.active_transition_id === null || control.active_transition_id === expectedTransitionId, 'authority_resume_changed')
        return { disabled: false as const, activeId: expectedTransitionId }
      }
      return { disabled: false as const, activeId: control.active_transition_id as string | null }
    })
    if (selected.disabled) return false
    const config = nativeEmailAuthorityConfiguration(), client = createSuiteCrmNativeEmailAuthorityClient(config)
    const store = new PostgresNativeEmailAuthorityTransitionStore(withTransaction, { actorEmail, actorWorkspaceId,
      approvalIdentity: { keyId: config.keyId, nativeInstanceId: config.nativeInstanceId, serviceUserId: config.serviceUserId, oauthClientId: config.clientId } },
    async (tx, raw) => {
      const change = prepareRootEmployeeCrmRegistryChange(raw)
      requireNativeEmail(selection(change) === selection(proposed), 'authority_root_effect_scope')
      // Full-schema root registry triggers revoke only ineligible delegated
      // sessions. Do not revoke legitimate independent-organization sessions.
      await recordAuditEvent({ actor: actorEmail, eventType: 'crm.root_access.changed', aggregateType: 'crm_operator_account',
        aggregateId: change.operatorAccountId, organizationId: actorWorkspaceId,
        payload: { nativeAuthority: true, nativeGrantPending: true, transitionId, changes: change.changes.length,
          tables: [...new Set(change.changes.map(row => row.table))].sort() } }, tx as PoolClient)
    })
    if (selected.activeId) {
      const active = await store.load(selected.activeId), saved = prepareRootEmployeeCrmRegistryChange(active.plan.desiredAppChange)
      requireNativeEmail(selection(saved) === selection(proposed), 'authority_other_change_pending')
      transitionId = selected.activeId
    } else {
      const inspection = readNativeEmailAuthorityInspection(await client.inspect())
      const app = await store.previewRootRegistryChange(proposed, inspection.bindings.map(row => row.pipeline_id))
      const next = nativeEmailDigest(['root-registry-change', randomUUID()])
      const plan = await buildNativeEmailMemberTransition({ app, inspection, transitionId: next,
        timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '), newMembershipId: randomUUID, forecast: client.project })
      const { planHash, ...input } = plan; void planHash
      await store.admit(input); transitionId = next
    }
    return await resumeNativeEmailAuthorityChange({ store, client, config, transitionId })
  } catch (error) {
    if (error instanceof NativeEmailAccessPendingError) throw error
    throw new NativeEmailAccessPendingError(transitionId)
  }
}

/** One read-only, owner-scoped discovery query. No private rows, native
 * identities, approval material, locks or provider calls escape as a DTO. */
async function pending(actorEmail: string, workspaceId: string, exactId?: string) {
  actor(actorEmail, workspaceId)
  if (exactId !== undefined) requireNativeEmail(HASH.test(exactId), 'authority_resume_identity_invalid')
  const found = await query<{ transition_id: string; plan_hash: string; plan: Record<string, unknown> }>(`SELECT t.transition_id,t.plan_hash,t.plan
    FROM crm_native_email_publication_control c JOIN crm_native_email_authority_transitions t
      ON t.transition_id=COALESCE($3::text,c.active_transition_id)
    JOIN app_users u ON u.email=$1 AND u.status='active'
    JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=$2::uuid
      AND m.role='owner' AND m.status='active' AND m.trashed_at IS NULL
    JOIN workspace_organizations w ON w.id=m.organization_id AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo
    WHERE c.singleton AND c.enabled AND c.active_operation_id IS NULL
      AND (c.active_transition_id=t.transition_id OR $3::text IS NOT NULL AND c.active_transition_id IS NULL)
      AND t.actor_email=$1 AND t.plan->'desiredAppChange'->>'kind'='root_registry_v1'
      AND t.plan->'desiredAppChange'->>'workspaceId'=$2::text AND t.plan->'desiredAppChange'->>'ownerEmail'=$1
    LIMIT 1`, [actorEmail, workspaceId, exactId ?? null])
  requireNativeEmail(found.rows.length <= 1, 'authority_root_recovery_ambiguous')
  if (!found.rows.length) return null
  const row = found.rows[0], { planHash, ...raw } = row.plan
  const plan = prepareNativeEmailAuthorityTransition(raw as NativeEmailAuthorityTransitionInput)
  requireNativeEmail(planHash === plan.planHash && row.plan_hash === plan.planHash && plan.revoke.transitionId === row.transition_id,
    'authority_root_recovery_plan_changed')
  const change = prepareRootEmployeeCrmRegistryChange(plan.desiredAppChange)
  requireNativeEmail(HASH.test(row.transition_id) && change.workspaceId === workspaceId && change.ownerEmail === actorEmail,
    'authority_root_recovery_changed')
  return { row, change }
}
export async function getPendingRootEmployeeCrmRegistryChange(actorEmail: string, workspaceId: string) {
  try {
    const selected = await pending(actorEmail, workspaceId)
    return selected ? Object.freeze({ transitionId: selected.row.transition_id, workspaceId,
      operatorAccountId: selected.change.operatorAccountId, changes: selected.change.changes.length }) : null
  } catch { throw new NativeEmailAccessPendingError() }
}
export async function resumeRootEmployeeCrmRegistryChange(actorEmail: string, workspaceId: string, transitionId: string): Promise<true> {
  try {
    const selected = await pending(actorEmail, workspaceId, transitionId)
    requireNativeEmail(selected && selected.row.transition_id === transitionId, 'authority_root_recovery_not_owned')
    requireNativeEmail(await changeRootEmployeeCrmRegistryWithNativeAuthority(actorEmail, workspaceId, selected.change, transitionId),
      'authority_resume_changed')
    return true
  } catch (error) {
    if (error instanceof NativeEmailAccessPendingError) throw error
    throw new NativeEmailAccessPendingError()
  }
}
