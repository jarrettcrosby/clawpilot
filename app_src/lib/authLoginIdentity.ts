import { query } from '@/lib/persistence/postgres'
import { configuredOwnerEmail, normalizeUserEmail } from '@/lib/users'

/** Login addresses are separate from the durable email key used by memberships and history. */
export async function resolveLoginAccountEmail(value: unknown): Promise<string | null> {
  const email = normalizeUserEmail(value)
  const configured = String(process.env.APP_LOGIN_EMAIL_ALIASES || '').trim()
  if (!configured) return email
  const entries = configured.split(',').map((entry) => normalizeUserEmail(entry))
  if (entries.length > 8 || new Set(entries).size !== entries.length) {
    throw new Error('APP_LOGIN_EMAIL_ALIASES must contain at most eight unique email addresses')
  }
  const ownerEmail = configuredOwnerEmail()
  if (email === ownerEmail || !entries.includes(email)) return email

  // An alias must never take over an existing independent account.
  const collision = await query<{ email: string }>(
    'SELECT email FROM app_users WHERE email = $1 LIMIT 1',
    [email],
  )
  return collision.rows.length ? null : ownerEmail
}
