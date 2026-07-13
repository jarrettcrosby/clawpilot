import { query, withTransaction } from '@/lib/persistence/postgres'

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

export type AppUserRole = 'owner' | 'member'
export type AppUserStatus = 'invited' | 'active' | 'disabled'

export type AppUser = {
  email: string
  role: AppUserRole
  status: AppUserStatus
  invitedBy: string | null
  invitedAt: string | null
  activatedAt: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

type AppUserRow = {
  email: string
  role: AppUserRole
  status: AppUserStatus
  invited_by: string | null
  invited_at: string | null
  activated_at: string | null
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export function normalizeUserEmail(value: unknown): string {
  const email = String(value || '').trim().toLowerCase()
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email) || !/^[\x21-\x7e]+$/.test(email)) {
    throw new Error('A valid ASCII email address is required')
  }
  return email
}

export function configuredOwnerEmail(): string {
  return normalizeUserEmail(process.env.APP_LOGIN_EMAIL)
}

function toAppUser(row: AppUserRow): AppUser {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by,
    invitedAt: row.invited_at,
    activatedAt: row.activated_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function ensureOwnerUser(): Promise<AppUser> {
  const email = configuredOwnerEmail()
  const result = await query<AppUserRow>(
    `
      INSERT INTO app_users (
        email, role, status, activated_at, created_at, updated_at
      )
      VALUES ($1, 'owner', 'active', now(), now(), now())
      ON CONFLICT (email) DO UPDATE SET
        role = 'owner',
        status = CASE WHEN app_users.status = 'disabled' THEN 'disabled' ELSE 'active' END,
        activated_at = COALESCE(app_users.activated_at, now()),
        updated_at = now()
      RETURNING *
    `,
    [email],
  )
  return toAppUser(result.rows[0])
}

export async function getAppUser(emailValue: unknown): Promise<AppUser | null> {
  const email = normalizeUserEmail(emailValue)
  await ensureOwnerUser()
  const result = await query<AppUserRow>('SELECT * FROM app_users WHERE email = $1', [email])
  return result.rows[0] ? toAppUser(result.rows[0]) : null
}

export async function requireActiveAppUser(emailValue: unknown): Promise<AppUser> {
  const user = await getAppUser(emailValue)
  if (!user || user.status !== 'active') throw new Error('User access is not active')
  return user
}

export async function listAppUsers(actorEmailValue: unknown): Promise<{ actor: AppUser; users: AppUser[] }> {
  const actor = await requireActiveAppUser(actorEmailValue)
  const result = await query<AppUserRow>(
    `
      SELECT *
      FROM app_users
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC, email ASC
    `,
  )
  return { actor, users: result.rows.map(toAppUser) }
}

export async function inviteAppUser(input: { actorEmail: unknown; email: unknown }): Promise<AppUser> {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (actor.role !== 'owner') throw new Error('Only an owner can invite users')
  const email = normalizeUserEmail(input.email)
  if (email === actor.email) return actor

  return withTransaction(async (client) => {
    const existing = await client.query<AppUserRow>('SELECT * FROM app_users WHERE email = $1 FOR UPDATE', [email])
    const current = existing.rows[0]
    if (current?.role === 'owner') return toAppUser(current)
    if (current?.status === 'active') return toAppUser(current)

    const result = await client.query<AppUserRow>(
      `
        INSERT INTO app_users (
          email, role, status, invited_by, invited_at, created_at, updated_at
        )
        VALUES ($1, 'member', 'invited', $2, now(), now(), now())
        ON CONFLICT (email) DO UPDATE SET
          role = 'member',
          status = 'invited',
          invited_by = EXCLUDED.invited_by,
          invited_at = now(),
          updated_at = now()
        RETURNING *
      `,
      [email, actor.email],
    )
    return toAppUser(result.rows[0])
  })
}

export async function setAppUserStatus(input: {
  actorEmail: unknown
  email: unknown
  status: 'active' | 'disabled'
}): Promise<AppUser> {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (actor.role !== 'owner') throw new Error('Only an owner can manage users')
  const email = normalizeUserEmail(input.email)
  if (email === actor.email && input.status === 'disabled') throw new Error('The owner account cannot disable itself')

  const result = await query<AppUserRow>(
    `
      UPDATE app_users
      SET status = $2,
          activated_at = CASE WHEN $2 = 'active' THEN COALESCE(activated_at, now()) ELSE activated_at END,
          updated_at = now()
      WHERE email = $1
        AND role <> 'owner'
      RETURNING *
    `,
    [email, input.status],
  )
  if (!result.rows[0]) throw new Error('User was not found')
  return toAppUser(result.rows[0])
}

export async function markAppUserSignedIn(emailValue: unknown): Promise<AppUser> {
  const email = normalizeUserEmail(emailValue)
  const result = await query<AppUserRow>(
    `
      UPDATE app_users
      SET status = 'active',
          activated_at = COALESCE(activated_at, now()),
          last_login_at = now(),
          updated_at = now()
      WHERE email = $1
        AND status IN ('invited', 'active')
      RETURNING *
    `,
    [email],
  )
  if (!result.rows[0]) throw new Error('User access is not active')
  return toAppUser(result.rows[0])
}
