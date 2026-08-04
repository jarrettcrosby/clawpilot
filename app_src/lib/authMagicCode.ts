import crypto from 'crypto'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { sendAuthMagicCodeEmail } from '@/lib/matonMail'
import { getAppUser, normalizeUserEmail } from '@/lib/users'

const RESEND_COOLDOWN_SECONDS = 60
const MAX_ATTEMPTS = 5
const DIGEST_CONTEXT = 'clawpilot-auth-magic-code:v1'
const AUTHORIZATION_CHANGED = 'AUTHORIZATION_CHANGED'

export type RequestAuthMagicCodeInput = {
  email: string
}

export type RequestAuthMagicCodeResult =
  | { status: 'sent'; expiresAt: string }
  | { status: 'cooldown'; retryAfterSeconds: number }
  | { status: 'not-authorized' }

export type VerifyAuthMagicCodeInput = {
  email: string
  code: string
}

export type VerifyAuthMagicCodeResult =
  | { status: 'verified'; email: string; organizationId: string | null }
  | { status: 'invalid'; attemptsRemaining: number }
  | { status: 'locked' | 'expired' | 'consumed' | 'not-found' | 'not-authorized' }

type IssuedRow = {
  id: string
  expires_at: string
}

type CooldownRow = {
  retry_after_seconds: number
}

type VerificationRow = {
  status: 'verified' | 'invalid' | 'locked' | 'expired' | 'consumed'
  attempts: number
  purpose: 'sign_in' | 'invitation'
  invitation_id: string | null
}

type VerificationOutcome = VerificationRow & {
  organization_id?: string | null
}

type InvitationAcceptanceRow = {
  id: string
  workspace_organization_id: string
  assigned_organization_ids: string[]
}

type InvitationMembershipRow = {
  organization_id: string
  status: 'invited' | 'active' | 'disabled'
}

function sessionSecret(): string {
  const secret = String(process.env.APP_SESSION_SECRET || '')
  if (secret.length < 32) throw new Error('APP_SESSION_SECRET must contain at least 32 characters')
  return secret
}

function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

function digestCode(email: string, code: string): string {
  return crypto
    .createHmac('sha256', sessionSecret())
    .update(`${DIGEST_CONTEXT}\n${email}\n${code}`)
    .digest('hex')
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('Postgres returned an invalid magic-code expiry')
  return new Date(parsed).toISOString()
}

async function issueAuthMagicCode(input: {
  email: string
  purpose: 'sign_in' | 'invitation'
  invitationId?: string | null
}): Promise<RequestAuthMagicCodeResult> {
  const requestedEmail = input.email
  const code = generateCode()
  const digest = digestCode(requestedEmail, code)
  const issuance = await withTransaction(async (client) => {
    const issued = await client.query<IssuedRow>(
      `
        INSERT INTO auth_magic_codes (
          id,
          email,
          code_digest,
          attempts,
          created_at,
          updated_at,
          expires_at,
          last_attempt_at,
          consumed_at,
          purpose,
          invitation_id
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          0,
          now(),
          now(),
          now() + interval '15 minutes',
          NULL,
          NULL,
          $3,
          $4::uuid
        )
        ON CONFLICT (email) DO UPDATE SET
          id = EXCLUDED.id,
          code_digest = EXCLUDED.code_digest,
          attempts = 0,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at,
          last_attempt_at = NULL,
          consumed_at = NULL,
          purpose = EXCLUDED.purpose,
          invitation_id = EXCLUDED.invitation_id
        WHERE auth_magic_codes.created_at <= now() - interval '60 seconds'
        RETURNING id::text AS id, expires_at::text AS expires_at
      `,
      [requestedEmail, digest, input.purpose, input.invitationId || null],
    )

    const row = issued.rows[0]
    if (row) return { kind: 'issued' as const, row }

    const cooldown = await client.query<CooldownRow>(
      `
        SELECT GREATEST(
          1,
          CEIL(EXTRACT(EPOCH FROM (created_at + interval '60 seconds' - now())))::integer
        ) AS retry_after_seconds
        FROM auth_magic_codes
        WHERE email = $1
      `,
      [requestedEmail],
    )

    return {
      kind: 'cooldown' as const,
      retryAfterSeconds: Math.max(1, Number(cooldown.rows[0]?.retry_after_seconds || RESEND_COOLDOWN_SECONDS)),
    }
  })

  if (issuance.kind === 'cooldown') {
    return { status: 'cooldown', retryAfterSeconds: issuance.retryAfterSeconds }
  }

  try {
    await sendAuthMagicCodeEmail({ to: requestedEmail, code })
  } catch {
    await query(
      `
        DELETE FROM auth_magic_codes
        WHERE id = $1::uuid
          AND email = $2
          AND code_digest = $3
          AND consumed_at IS NULL
      `,
      [issuance.row.id, requestedEmail, digest],
    ).catch(() => undefined)
    throw new Error('Unable to deliver sign-in code')
  }

  return {
    status: 'sent',
    expiresAt: normalizeIso(issuance.row.expires_at),
  }
}

export async function requestAuthMagicCode(
  input: RequestAuthMagicCodeInput,
): Promise<RequestAuthMagicCodeResult> {
  let requestedEmail: string
  try {
    requestedEmail = normalizeUserEmail(input.email)
  } catch {
    return { status: 'not-authorized' }
  }
  const user = await getAppUser(requestedEmail)
  if (!user || user.status !== 'active') return { status: 'not-authorized' }
  return issueAuthMagicCode({ email: requestedEmail, purpose: 'sign_in' })
}

export async function requestInvitationAuthMagicCode(input: {
  email: string
  invitationId: string
}): Promise<RequestAuthMagicCodeResult> {
  let requestedEmail: string
  try {
    requestedEmail = normalizeUserEmail(input.email)
  } catch {
    return { status: 'not-authorized' }
  }
  const invitation = await query<{ id: string }>(
    `
      SELECT invitation.id::text
      FROM app_user_invitations invitation
      INNER JOIN app_users user_record ON user_record.email = invitation.email
      CROSS JOIN LATERAL (
        SELECT ARRAY(
          SELECT grouped.organization_id
          FROM (
            SELECT
              candidate.organization_id,
              min(candidate.position) AS position
            FROM (
              SELECT
                invitation.workspace_organization_id AS organization_id,
                0::bigint AS position
              UNION ALL
              SELECT entry.organization_id, entry.position
              FROM unnest(
                COALESCE(
                  invitation.workspace_organization_ids,
                  ARRAY[]::uuid[]
                )
              ) WITH ORDINALITY AS entry(organization_id, position)
            ) candidate
            WHERE candidate.organization_id IS NOT NULL
            GROUP BY candidate.organization_id
          ) grouped
          ORDER BY grouped.position
        )::uuid[] AS organization_ids
      ) assigned
      WHERE invitation.id = $1::uuid
        AND invitation.email = $2
        AND invitation.revoked_at IS NULL
        AND invitation.accepted_at IS NULL
        AND invitation.expires_at > now()
        AND user_record.status IN ('invited', 'active')
        AND invitation.workspace_organization_id IS NOT NULL
        AND cardinality(assigned.organization_ids) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(assigned.organization_ids)
            AS assigned_organization(organization_id)
          LEFT JOIN app_user_organization_memberships membership
            ON membership.user_email = invitation.email
           AND membership.organization_id = assigned_organization.organization_id
          WHERE membership.organization_id IS NULL
             OR membership.status <> 'invited'
        )
      LIMIT 1
    `,
    [input.invitationId, requestedEmail],
  )
  if (!invitation.rows[0]) return { status: 'not-authorized' }
  return issueAuthMagicCode({ email: requestedEmail, purpose: 'invitation', invitationId: invitation.rows[0].id })
}

export async function verifyAuthMagicCode(
  input: VerifyAuthMagicCodeInput,
): Promise<VerifyAuthMagicCodeResult> {
  let requestedEmail: string
  try {
    requestedEmail = normalizeUserEmail(input.email)
  } catch {
    return { status: 'not-authorized' }
  }
  const user = await getAppUser(requestedEmail)
  if (!user || user.status === 'disabled') return { status: 'not-authorized' }

  const submittedCode = String(input.code || '').trim().slice(0, 128)
  const submittedDigest = digestCode(requestedEmail, submittedCode)
  let row: VerificationRow | undefined
  try {
    row = await withTransaction(async (client) => {
      const result = await client.query<VerificationRow>(`
      WITH candidate AS (
        SELECT
          id,
          code_digest,
          attempts,
          expires_at,
          last_attempt_at,
          consumed_at,
          purpose,
          invitation_id
        FROM auth_magic_codes
        WHERE email = $1
        FOR UPDATE
      ),
      evaluation AS (
        SELECT
          candidate.*,
          code_digest = $2 AS matches,
          consumed_at IS NULL
            AND expires_at > now()
            AND attempts < 5 AS eligible
        FROM candidate
      ),
      outcome AS (
        SELECT
          evaluation.*,
          CASE
            WHEN consumed_at IS NOT NULL THEN 'consumed'
            WHEN expires_at <= now() THEN 'expired'
            WHEN attempts >= 5 THEN 'locked'
            WHEN matches THEN 'verified'
            WHEN attempts + 1 >= 5 THEN 'locked'
            ELSE 'invalid'
          END AS status,
          CASE
            WHEN eligible AND NOT matches THEN LEAST(attempts + 1, 5)::smallint
            ELSE attempts
          END AS next_attempts,
          CASE WHEN eligible AND matches THEN now() ELSE consumed_at END AS next_consumed_at,
          CASE WHEN eligible THEN now() ELSE last_attempt_at END AS next_last_attempt_at
        FROM evaluation
      ),
      updated AS (
        UPDATE auth_magic_codes AS codes
        SET attempts = outcome.next_attempts,
            consumed_at = outcome.next_consumed_at,
            last_attempt_at = outcome.next_last_attempt_at,
            updated_at = CASE WHEN outcome.eligible THEN now() ELSE codes.updated_at END
        FROM outcome
        WHERE codes.id = outcome.id
        RETURNING codes.id
      )
      SELECT
        outcome.status,
        outcome.next_attempts::integer AS attempts,
        outcome.purpose,
        outcome.invitation_id::text
      FROM outcome
      INNER JOIN updated ON updated.id = outcome.id
    `,
      [requestedEmail, submittedDigest],
      )

      const verified = result.rows[0]
      if (verified?.status !== 'verified') return verified
      if (verified.purpose === 'invitation') {
        const invitedUser = await client.query(
          `
            SELECT email
            FROM app_users
            WHERE email = $1
              AND status IN ('invited', 'active')
            FOR UPDATE
          `,
          [requestedEmail],
        )
        if (invitedUser.rowCount !== 1) throw new Error(AUTHORIZATION_CHANGED)
        const invitation = await client.query<InvitationAcceptanceRow>(
          `
            SELECT
              invitation.id::text,
              invitation.workspace_organization_id::text,
              assigned.organization_ids::uuid[] AS assigned_organization_ids
            FROM app_user_invitations AS invitation
            CROSS JOIN LATERAL (
              SELECT ARRAY(
                SELECT grouped.organization_id
                FROM (
                  SELECT
                    candidate.organization_id,
                    min(candidate.position) AS position
                  FROM (
                    SELECT
                      invitation.workspace_organization_id AS organization_id,
                      0::bigint AS position
                    UNION ALL
                    SELECT entry.organization_id, entry.position
                    FROM unnest(
                      COALESCE(
                        invitation.workspace_organization_ids,
                        ARRAY[]::uuid[]
                      )
                    ) WITH ORDINALITY AS entry(organization_id, position)
                  ) candidate
                  WHERE candidate.organization_id IS NOT NULL
                  GROUP BY candidate.organization_id
                ) grouped
                ORDER BY grouped.position
              )::uuid[] AS organization_ids
            ) assigned
            WHERE invitation.id = $1::uuid
              AND invitation.email = $2
              AND invitation.accepted_at IS NULL
              AND invitation.revoked_at IS NULL
              AND invitation.code_requested_at IS NOT NULL
              AND invitation.expires_at > now()
              AND invitation.workspace_organization_id IS NOT NULL
              AND cardinality(assigned.organization_ids) > 0
            FOR UPDATE OF invitation
          `,
          [verified.invitation_id, requestedEmail],
        )
        if (!invitation.rows[0]) throw new Error(AUTHORIZATION_CHANGED)
        const inviteOrganizationIds = invitation.rows[0]
          .assigned_organization_ids
        const lockedMemberships = await client.query<InvitationMembershipRow>(
          `
            SELECT organization_id::text, status
            FROM app_user_organization_memberships
            WHERE user_email = $1
              AND organization_id = ANY($2::uuid[])
            ORDER BY array_position($2::uuid[], organization_id)
            FOR UPDATE
          `,
          [requestedEmail, inviteOrganizationIds],
        )
        if (
          lockedMemberships.rowCount !== inviteOrganizationIds.length
          || lockedMemberships.rows.some((membership, index) => (
            membership.organization_id !== inviteOrganizationIds[index]
            || membership.status !== 'invited'
          ))
        ) {
          throw new Error(AUTHORIZATION_CHANGED)
        }
        const activatedMembership = await client.query(
          `UPDATE app_user_organization_memberships
           SET status = 'active', updated_at = now()
           WHERE user_email = $1
             AND organization_id = ANY($2::uuid[])
             AND status = 'invited'
           RETURNING organization_id::text`,
          [
            requestedEmail,
            inviteOrganizationIds,
          ],
        )
        if (activatedMembership.rowCount !== inviteOrganizationIds.length) {
          throw new Error(AUTHORIZATION_CHANGED)
        }
        const accepted = await client.query(
          `
            UPDATE app_user_invitations
            SET accepted_at = now(), updated_at = now()
            WHERE id = $1::uuid
              AND email = $2
              AND accepted_at IS NULL
              AND revoked_at IS NULL
              AND code_requested_at IS NOT NULL
              AND expires_at > now()
            RETURNING id
          `,
          [verified.invitation_id, requestedEmail],
        )
        if (accepted.rowCount !== 1) throw new Error(AUTHORIZATION_CHANGED)
        const activated = await client.query(
          `
            UPDATE app_users
            SET status = 'active',
                activated_at = COALESCE(activated_at, now()),
                last_login_at = now(),
                updated_at = now()
            WHERE email = $1
              AND status IN ('invited', 'active')
            RETURNING email
          `,
          [requestedEmail],
        )
        if (!activated.rows[0]) throw new Error(AUTHORIZATION_CHANGED)
        return {
          ...verified,
          organization_id: invitation.rows[0].workspace_organization_id,
        } satisfies VerificationOutcome
      } else {
        const signedIn = await client.query(
          `
            UPDATE app_users
            SET last_login_at = now(), updated_at = now()
            WHERE email = $1
              AND status = 'active'
            RETURNING email
          `,
          [requestedEmail],
        )
        if (!signedIn.rows[0]) throw new Error(AUTHORIZATION_CHANGED)
      }
      return { ...verified, organization_id: null } satisfies VerificationOutcome
    })
  } catch (error) {
    if (error instanceof Error && error.message === AUTHORIZATION_CHANGED) return { status: 'not-authorized' }
    throw error
  }

  if (!row) return { status: 'not-found' }
  if (row.status === 'verified') {
    return {
      status: 'verified',
      email: requestedEmail,
      organizationId: (row as VerificationOutcome).organization_id || null,
    }
  }
  if (row.status === 'invalid') {
    return { status: 'invalid', attemptsRemaining: Math.max(0, MAX_ATTEMPTS - Number(row.attempts || 0)) }
  }
  return { status: row.status }
}
