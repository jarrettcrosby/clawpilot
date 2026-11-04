import type { PoolClient } from 'pg'
import { lockCrmNativeEmailAuthorityWithClient } from './persistence/crmNativeEmailAuthority'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Same primary-first, deduplicated order used by invitation token acceptance. */
export function invitationWorkspaceIds(primary: string | null, values: string[] | null): string[] {
  const ids = [...new Set([...(primary ? [primary] : []), ...(values || [])])]
  if (ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('Invitation organization scope is invalid')
  return ids
}

/** Call before taking invitation or membership locks. No provider I/O may run
 * in this transaction. The control lock orders delivery against user removal;
 * it does not authorize native identity enrollment or membership activation. */
export async function lockInvitationUserWithClient(client: PoolClient, email: string): Promise<void> {
  await lockCrmNativeEmailAuthorityWithClient(client)
  const result = await client.query('SELECT email FROM app_users WHERE email = $1 FOR UPDATE', [email])
  if (result.rows.length !== 1) throw new Error('Invitation user is unavailable')
}

/** Recheck the current locked scope, not the membership state before email
 * delivery. A concurrent trash/disable must never reactivate its invitation. */
export async function requireInvitedWorkspaceScopeWithClient(
  client: PoolClient,
  email: string,
  organizationIds: string[],
): Promise<void> {
  if (!organizationIds.length || invitationWorkspaceIds(null, organizationIds).length !== organizationIds.length) {
    throw new Error('Invitation organization scope is unavailable')
  }
  const result = await client.query<{ organization_id: string; status: string; trashed_at: string | null; user_status: string }>(
    `SELECT membership.organization_id::text, membership.status, membership.trashed_at::text,
       app_user.status AS user_status
     FROM app_user_organization_memberships membership
     JOIN app_users app_user ON app_user.email = membership.user_email
     WHERE membership.user_email = $1 AND membership.organization_id = ANY($2::uuid[])
     ORDER BY array_position($2::uuid[], membership.organization_id)
     FOR SHARE OF membership`, [email, organizationIds],
  )
  if (result.rows.length !== organizationIds.length || result.rows.some((row, index) => (
    row.organization_id !== organizationIds[index] || row.status !== 'invited' || row.trashed_at !== null
    || !['invited', 'active'].includes(row.user_status)
  ))) throw new Error('Invitation organization access changed')
}

/** Reduce only the removed workspace's pending invitation rights. Other
 * originally assigned workspaces keep the same token and expiry. In-flight
 * delivery rows are included even though they start revoked; delivery rechecks
 * the reduced scope before activation. Accepted/expired/retired rows are not
 * rewritten, and no new token, membership or native identity is created. */
export async function removeWorkspaceFromPendingInvitationsWithClient(
  client: PoolClient,
  input: { email: string; organizationId: string },
): Promise<{ trimmedInvitationIds: string[]; revokedInvitationIds: string[] }> {
  if (!UUID.test(input.organizationId)) throw new Error('Invitation organization scope is invalid')
  await lockInvitationUserWithClient(client, input.email)
  const pending = await client.query<{ id: string; workspace_organization_id: string | null; workspace_organization_ids: string[] | null }>(
    `SELECT id::text, workspace_organization_id::text, workspace_organization_ids
     FROM app_user_invitations
     WHERE email = $1 AND accepted_at IS NULL AND expires_at > now()
       AND (revoked_at IS NULL OR delivery_pending_at IS NOT NULL)
       AND (workspace_organization_id = $2::uuid OR $2::uuid = ANY(workspace_organization_ids))
     ORDER BY id FOR UPDATE`, [input.email, input.organizationId],
  )
  const result = { trimmedInvitationIds: [] as string[], revokedInvitationIds: [] as string[] }
  for (const row of pending.rows) {
    const before = invitationWorkspaceIds(row.workspace_organization_id, row.workspace_organization_ids)
    const remaining = before.filter(id => id !== input.organizationId)
    if (remaining.length === before.length) throw new Error('Invitation organization scope changed')
    await client.query(
      `UPDATE app_user_invitations SET workspace_organization_id = $2::uuid,
         workspace_organization_ids = $3::uuid[],
         revoked_at = CASE WHEN cardinality($3::uuid[]) = 0 THEN COALESCE(revoked_at, now()) ELSE revoked_at END,
         updated_at = now()
       WHERE id = $1::uuid`, [row.id, remaining[0] || null, remaining],
    )
    if (remaining.length) result.trimmedInvitationIds.push(row.id)
    else result.revokedInvitationIds.push(row.id)
  }
  return result
}
