import { query } from '@/lib/persistence/postgres'
import { configuredOwnerEmail, normalizeUserEmail } from '@/lib/users'
import type { PoolClient } from 'pg'

export async function currentLoginEmail(userEmail: string): Promise<string> {
  const result = await query<{ login_email: string }>('SELECT login_email FROM app_user_login_addresses WHERE user_email = $1', [userEmail])
  return result.rows[0]?.login_email || userEmail
}

/** Login addresses are separate from the durable email key used by memberships and history. */
export async function resolveLoginAccountEmail(value: unknown, client?: PoolClient): Promise<string | null> {
  const email = normalizeUserEmail(value)
  const execute = client ? client.query.bind(client) : query
  const mapped = await execute<{ user_email: string; login_email: string }>(
    'SELECT user_email, login_email FROM app_user_login_addresses WHERE login_email = $1 OR user_email = $1', [email],
  )
  const login = mapped.rows.find((row) => row.login_email === email)
  if (login) return login.user_email
  // The durable identity key stops being a login once its address has changed.
  if (mapped.rows.length) return null
  const configured = String(process.env.APP_LOGIN_EMAIL_ALIASES || '').trim()
  if (!configured) return email
  const entries = configured.split(',').map((entry) => normalizeUserEmail(entry))
  if (entries.length > 8 || new Set(entries).size !== entries.length) {
    throw new Error('APP_LOGIN_EMAIL_ALIASES must contain at most eight unique email addresses')
  }
  const ownerEmail = configuredOwnerEmail()
  if (email === ownerEmail || !entries.includes(email)) return email
  const ownerOverride = await execute('SELECT 1 FROM app_user_login_addresses WHERE user_email = $1', [ownerEmail])
  if (ownerOverride.rows.length) return null

  // An alias must never take over an existing independent account.
  const collision = await execute<{ email: string }>(
    'SELECT email FROM app_users WHERE email = $1 LIMIT 1',
    [email],
  )
  return collision.rows.length ? null : ownerEmail
}
