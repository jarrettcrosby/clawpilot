import crypto from 'crypto'
import { requestInvitationAuthMagicCode } from '@/lib/authMagicCode'
import { sendInvitationEmail, mailFromAddress } from '@/lib/matonMail'
import {
  resolveInvitationWorkspaceOrganization,
  retireUnusedWorkspaceOrganization,
} from '@/lib/organizations'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { appPublicUrl } from '@/lib/publicUrl'
import {
  getAppUser,
  inviteAppUser,
  normalizeUserEmail,
  requireActiveAppUser,
  restoreInvitedUserAssignment,
  type AppUser,
} from '@/lib/users'

const INVITATION_LIFETIME_DAYS = 7
const INVITATION_DELIVERY_STALE_MINUTES = 2

type InvitationRow = {
  id: string
  email: string
  inviter_name: string | null
  organization_name: string | null
  expires_at: string
}

type IssuedInvitationRow = {
  id: string
  expires_at: string
  supersedes_id: string | null
}

export type PublicInvitation = {
  email: string
  inviterName: string
  organizationName: string
  expiresAt: string
}

function tokenDigest(token: string): string {
  return crypto.createHash('sha256').update(`clawpilot-user-invitation:v1\n${token}`).digest('hex')
}

async function claimInvitation(input: {
  email: string
  actorEmail: string
  digest: string
  fromAddress: string
  organizationId: string
}): Promise<IssuedInvitationRow> {
  return withTransaction(async (client) => {
    await client.query('SELECT email FROM app_users WHERE email = $1 FOR UPDATE', [input.email])
    const pending = await client.query<{
      id: string
      delivery_recent: boolean
    }>(
      `
        SELECT
          id::text,
          delivery_pending_at > now() - ($2::text || ' minutes')::interval AS delivery_recent
        FROM app_user_invitations
        WHERE email = $1 AND delivery_pending_at IS NOT NULL
        ORDER BY delivery_pending_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [input.email, String(INVITATION_DELIVERY_STALE_MINUTES)],
    )
    const currentPending = pending.rows[0]
    if (currentPending?.delivery_recent) {
      throw new Error('An invitation for this email is already being sent')
    }
    if (currentPending) {
      await client.query('DELETE FROM app_user_invitations WHERE id = $1::uuid', [currentPending.id])
    }

    const active = await client.query<{ id: string }>(
      `
        SELECT id::text
        FROM app_user_invitations
        WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [input.email],
    )
    const supersedesId = active.rows[0]?.id || null

    const issued = await client.query<IssuedInvitationRow>(
      `
        INSERT INTO app_user_invitations (
          email, invited_by, workspace_organization_id, token_digest, from_address, expires_at, supersedes_id,
          delivery_pending_at, revoked_at, created_at, updated_at
        )
        VALUES (
          $1, $2, $3::uuid, $4, $5, now() + ($6::text || ' days')::interval, $7::uuid,
          now(), now(), now(), now()
        )
        RETURNING id::text, expires_at::text, supersedes_id::text
      `,
      [
        input.email,
        input.actorEmail,
        input.organizationId,
        input.digest,
        input.fromAddress,
        String(INVITATION_LIFETIME_DAYS),
        supersedesId,
      ],
    )
    return issued.rows[0]
  })
}

async function markInvitationDelivered(input: {
  invitationId: string
  email: string
  actorEmail: string
  deliveryId: string | null
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('SELECT email FROM app_users WHERE email = $1 FOR UPDATE', [input.email])
    await client.query(
      `
        UPDATE app_user_invitations
        SET revoked_at = now(), updated_at = now()
        WHERE email = $1
          AND id <> $2::uuid
          AND accepted_at IS NULL
          AND revoked_at IS NULL
      `,
      [input.email, input.invitationId],
    )
    const delivered = await client.query(
      `
        UPDATE app_user_invitations
        SET
          delivery_id = $2,
          sent_at = now(),
          delivery_pending_at = NULL,
          revoked_at = NULL,
          updated_at = now()
        WHERE id = $1::uuid AND accepted_at IS NULL AND delivery_pending_at IS NOT NULL
        RETURNING id
      `,
      [input.invitationId, input.deliveryId],
    )
    if (!delivered.rows[0]) throw new Error('Unable to activate the delivered invitation')
    await client.query(
      `
        UPDATE app_users
        SET invited_by = $2, invited_at = now(), updated_at = now()
        WHERE email = $1 AND status = 'invited'
      `,
      [input.email, input.actorEmail],
    )
  })
}

async function rollbackInvitation(input: {
  invitation: IssuedInvitationRow | null
  email: string
  deleteUser: boolean
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('SELECT email FROM app_users WHERE email = $1 FOR UPDATE', [input.email])
    if (input.invitation) {
      await client.query(
        'DELETE FROM app_user_invitations WHERE id = $1::uuid AND delivery_pending_at IS NOT NULL',
        [input.invitation.id],
      )
    }
    if (input.deleteUser) {
      await client.query(
        `
          DELETE FROM app_users user_record
          WHERE user_record.email = $1
            AND user_record.status = 'invited'
            AND NOT EXISTS (
              SELECT 1 FROM app_user_invitations invitation WHERE invitation.email = user_record.email
            )
        `,
        [input.email],
      )
    }
  })
}

function normalizeToken(value: unknown): string {
  const token = String(value || '').trim()
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(token)) throw new Error('This invitation link is invalid or expired')
  return token
}

async function invitationByToken(tokenValue: unknown): Promise<InvitationRow | null> {
  const token = normalizeToken(tokenValue)
  const result = await query<InvitationRow>(
    `
      SELECT
        invitation.id::text,
        invitation.email,
        inviter.display_name AS inviter_name,
        organization.name AS organization_name,
        invitation.expires_at::text
      FROM app_user_invitations invitation
      LEFT JOIN app_users inviter ON inviter.email = invitation.invited_by
      LEFT JOIN workspace_organizations organization ON organization.id = invitation.workspace_organization_id
      WHERE invitation.token_digest = $1
        AND invitation.revoked_at IS NULL
        AND invitation.expires_at > now()
        AND invitation.accepted_at IS NULL
      LIMIT 1
    `,
    [tokenDigest(token)],
  )
  return result.rows[0] || null
}

export async function createUserInvitation(input: {
  actorEmail: unknown
  email: unknown
  organizationId?: unknown
  createOrganization?: unknown
  organizationName?: unknown
  parentOrganizationId?: unknown
}): Promise<{ user: AppUser; delivery: 'sent'; expiresAt: string }> {
  const actor = await requireActiveAppUser(input.actorEmail)
  const email = normalizeUserEmail(input.email)
  const assignment = await resolveInvitationWorkspaceOrganization({
    actorEmail: actor.email,
    organizationId: input.organizationId,
    createOrganization: input.createOrganization,
    organizationName: input.organizationName,
    parentOrganizationId: input.parentOrganizationId,
  })
  let user: AppUser | null = null
  let userCreated = false
  let previousOrganizationId: string | null = null
  let previousInvitedBy: string | null = null
  let invitation: IssuedInvitationRow | null = null
  try {
    const invited = await inviteAppUser({
      actorEmail: actor.email,
      email,
      organizationId: assignment.organization.id,
    })
    user = invited.user
    userCreated = invited.created
    previousOrganizationId = invited.previousOrganizationId
    previousInvitedBy = invited.previousInvitedBy
    const token = crypto.randomBytes(32).toString('base64url')
    const digest = tokenDigest(token)
    const fromAddress = mailFromAddress()
    const publicUrl = appPublicUrl()
    invitation = await claimInvitation({
      email: user.email,
      actorEmail: actor.email,
      digest,
      fromAddress,
      organizationId: assignment.organization.id,
    })
    const welcomeUrl = new URL('/welcome', publicUrl)
    welcomeUrl.hash = `token=${encodeURIComponent(token)}`

    const sent = await sendInvitationEmail({
      to: user.email,
      inviterName: actor.displayName || actor.email,
      organizationName: assignment.organization.name,
      welcomeUrl: welcomeUrl.toString(),
      expiresAt: invitation.expires_at,
    })
    await markInvitationDelivered({
      invitationId: invitation.id,
      email: user.email,
      actorEmail: actor.email,
      deliveryId: sent.messageId,
    })

    const refreshedUser = await getAppUser(user.email)
    return {
      user: refreshedUser || user,
      delivery: 'sent',
      expiresAt: new Date(invitation.expires_at).toISOString(),
    }
  } catch (error) {
    if (user) await rollbackInvitation({ invitation, email: user.email, deleteUser: userCreated })
    if (user && !userCreated) {
      await restoreInvitedUserAssignment({
        email: user.email,
        organizationId: previousOrganizationId,
        invitedBy: previousInvitedBy,
      })
    }
    if (assignment.created) await retireUnusedWorkspaceOrganization(assignment.organization.id)
    throw error
  }
}

export async function openUserInvitation(tokenValue: unknown): Promise<PublicInvitation> {
  const row = await invitationByToken(tokenValue)
  if (!row) throw new Error('This invitation link is invalid or expired')
  await query(
    `UPDATE app_user_invitations SET opened_at = COALESCE(opened_at, now()), updated_at = now() WHERE id = $1::uuid`,
    [row.id],
  )
  return {
    email: normalizeUserEmail(row.email),
    inviterName: row.inviter_name || 'A ClawPilot administrator',
    organizationName: row.organization_name || 'your organization',
    expiresAt: new Date(row.expires_at).toISOString(),
  }
}

export async function requestUserInvitationCode(tokenValue: unknown): Promise<{
  email: string
  delivery: 'sent' | 'cooldown'
}> {
  const token = normalizeToken(tokenValue)
  const row = await invitationByToken(token)
  if (!row) throw new Error('This invitation link is invalid, expired, or already used')
  const delivery = await requestInvitationAuthMagicCode({ email: row.email, invitationId: row.id })
  if (delivery.status !== 'sent' && delivery.status !== 'cooldown') {
    throw new Error('Unable to send a sign-in code for this invitation')
  }
  await query(
    `
      UPDATE app_user_invitations
      SET opened_at = COALESCE(opened_at, now()), code_requested_at = now(), updated_at = now()
      WHERE id = $1::uuid
    `,
    [row.id],
  )
  return { email: row.email, delivery: delivery.status }
}
