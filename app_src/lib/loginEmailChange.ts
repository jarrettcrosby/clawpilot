import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { type BrowserSession, SESSION_POLICY } from '@/lib/authSessions'
import { currentLoginEmail } from '@/lib/authLoginIdentity'
import { recordAuditEvent } from '@/lib/auditWriter'
import { sendLoginEmailChangeCode, sendLoginEmailChangedNotice } from '@/lib/matonMail'
import { withTransaction } from '@/lib/persistence/postgres'
import { configuredOwnerEmail, normalizeUserEmail } from '@/lib/users'

export class LoginEmailChangeError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

export function assertLoginEmailChangeSession(session: BrowserSession) {
  if (session.legacy || session.impersonating || session.authenticatedUser !== session.effectiveUser) {
    throw new LoginEmailChangeError('Sign in as yourself before changing your login email.', 403)
  }
  const age = Date.now() - Date.parse(session.lastAuthenticatedAt)
  if (!Number.isFinite(age) || age < 0 || age > SESSION_POLICY.recentAuthSeconds * 1000) {
    throw new LoginEmailChangeError('For security, sign out and sign in again before changing your login email.', 403)
  }
}

function hashCode(user: string, email: string, code: string) {
  const secret = process.env.APP_SESSION_SECRET || process.env.NEXTAUTH_SECRET || ''
  if (secret.length < 32) throw new Error('Session secret is not configured')
  return crypto.createHmac('sha256', secret).update(`login-email-change:v1\n${user}\n${email}\n${code}`).digest('hex')
}

async function lockAccount(client: PoolClient, user: string) {
  const active = await client.query("SELECT email FROM app_users WHERE email = $1 AND status = 'active' FOR UPDATE", [user])
  if (!active.rows.length) throw new LoginEmailChangeError('User access is not active.', 403)
}

async function availableAddress(client: PoolClient, user: string, email: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('clawpilot-login-address:' || $1, 0))", [email])
  const existing = await client.query(`SELECT email FROM app_users WHERE email = $1 AND email <> $2
    UNION ALL SELECT user_email FROM app_user_login_addresses WHERE login_email = $1 AND user_email <> $2`, [email, user])
  const ownerAliases = String(process.env.APP_LOGIN_EMAIL_ALIASES || '').split(',').map((value) => value.trim().toLowerCase())
  if (existing.rows.length || (ownerAliases.includes(email) && user !== configuredOwnerEmail())) {
    throw new LoginEmailChangeError('This address is already associated with another account.', 409)
  }
}

export async function requestLoginEmailChange(session: BrowserSession, value: unknown) {
  assertLoginEmailChangeSession(session)
  const email = normalizeUserEmail(value)
  const user = session.authenticatedUser
  if (email === await currentLoginEmail(user)) throw new LoginEmailChangeError('This is already your login email.')
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
  const digest = hashCode(user, email, code)
  await withTransaction(async (client) => {
    await lockAccount(client, user)
    await availableAddress(client, user, email)
    const result = await client.query(`INSERT INTO app_login_email_changes
      (user_email, new_email, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '15 minutes')
      ON CONFLICT (user_email) DO UPDATE SET new_email = EXCLUDED.new_email, code_hash = EXCLUDED.code_hash,
        expires_at = EXCLUDED.expires_at, attempts = 0, consumed_at = NULL, requested_at = now(),
        request_count = CASE WHEN app_login_email_changes.request_window_started <= now() - interval '1 hour' THEN 1 ELSE app_login_email_changes.request_count + 1 END,
        request_window_started = CASE WHEN app_login_email_changes.request_window_started <= now() - interval '1 hour' THEN now() ELSE app_login_email_changes.request_window_started END
      WHERE app_login_email_changes.requested_at <= now() - interval '60 seconds'
        AND (app_login_email_changes.request_window_started <= now() - interval '1 hour' OR app_login_email_changes.request_count < 5)
      RETURNING user_email`, [user, email, digest])
    if (!result.rows.length) throw new LoginEmailChangeError('Please wait before requesting another verification code (maximum five per hour).', 429)
  })
  try {
    await sendLoginEmailChangeCode({ to: email, code })
  } catch {
    await withTransaction(async (client) => {
      await client.query('UPDATE app_login_email_changes SET consumed_at = now() WHERE user_email = $1 AND code_hash = $2', [user, digest])
    })
    throw new LoginEmailChangeError('Unable to deliver the verification code. Your login email has not changed.', 503)
  }
  return { pendingEmail: email }
}

export async function confirmLoginEmailChange(session: BrowserSession, input: { email: unknown; code: unknown }) {
  assertLoginEmailChangeSession(session)
  const user = session.authenticatedUser
  const email = normalizeUserEmail(input.email)
  const code = String(input.code || '').trim()
  if (!/^\d{6}$/.test(code)) throw new LoginEmailChangeError('Enter the six-digit verification code.')
  const result = await withTransaction(async (client) => {
    await lockAccount(client, user)
    const pending = await client.query<{ code_hash: string }>(`SELECT code_hash FROM app_login_email_changes
      WHERE user_email = $1 AND new_email = $2 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5 FOR UPDATE`, [user, email])
    if (!pending.rows[0]) return { verified: false as const }
    const expected = Buffer.from(pending.rows[0].code_hash, 'hex')
    const actual = Buffer.from(hashCode(user, email, code), 'hex')
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      await client.query('UPDATE app_login_email_changes SET attempts = attempts + 1 WHERE user_email = $1', [user])
      return { verified: false as const }
    }
    await availableAddress(client, user, email)
    const old = await client.query<{ login_email: string }>('SELECT login_email FROM app_user_login_addresses WHERE user_email = $1', [user])
    const oldEmail = old.rows[0]?.login_email || user
    await client.query(`INSERT INTO app_user_login_addresses (user_email, login_email) VALUES ($1, $2)
      ON CONFLICT (user_email) DO UPDATE SET login_email = EXCLUDED.login_email, verified_at = now()`, [user, email])
    await client.query('UPDATE app_login_email_changes SET consumed_at = now() WHERE user_email = $1', [user])
    const aliases = user === configuredOwnerEmail() ? String(process.env.APP_LOGIN_EMAIL_ALIASES || '').split(',').map((value) => value.trim().toLowerCase()) : []
    await client.query('DELETE FROM auth_magic_codes WHERE email = ANY($1::text[])', [[user, oldEmail, email, ...aliases]])
    await client.query(`UPDATE app_sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = 'login_email_changed'
      WHERE (authenticated_user_email = $1 OR effective_user_email = $1) AND revoked_at IS NULL`, [user])
    // A different login email must be explicitly linked to its Google subject after signing in again.
    await client.query('DELETE FROM app_user_google_login_bindings WHERE user_email = $1', [user])
    await recordAuditEvent({ actor: user, subject: user, eventType: 'auth.login_email.changed', aggregateType: 'app_user', aggregateId: user,
      organizationId: session.activeWorkspaceOrganizationId, payload: { oldEmail, loginEmail: email, sessionsRevoked: true } }, client)
    return { verified: true as const, oldEmail }
  })
  if (!result.verified) throw new LoginEmailChangeError('The verification code is invalid, expired, or used.')
  let notificationSent = true
  await sendLoginEmailChangedNotice({ to: result.oldEmail, newEmail: email }).catch(() => { notificationSent = false })
  return { loginEmail: email, signInRequired: true, notificationSent }
}
