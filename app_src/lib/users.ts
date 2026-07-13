import { query, withTransaction } from '@/lib/persistence/postgres'

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

export type AppUserRole = 'owner' | 'admin' | 'member'
export type AppUserStatus = 'invited' | 'active' | 'disabled'

export type AppUserPermissions = {
  inviteUsers: boolean
  manageUserAccess: boolean
  createBoards: boolean
  createPipelines: boolean
}

export const MEMBER_PERMISSIONS: AppUserPermissions = {
  inviteUsers: false,
  manageUserAccess: false,
  createBoards: true,
  createPipelines: true,
}

export const OWNER_PERMISSIONS: AppUserPermissions = {
  inviteUsers: true,
  manageUserAccess: true,
  createBoards: true,
  createPipelines: true,
}

export type AppUser = {
  email: string
  role: AppUserRole
  status: AppUserStatus
  displayName: string | null
  jobTitle: string | null
  timezone: string
  locale: string
  permissions: AppUserPermissions
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
  display_name: string | null
  job_title: string | null
  timezone: string
  locale: string
  permissions: unknown
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

function normalizePermissions(value: unknown): AppUserPermissions {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    inviteUsers: input.inviteUsers === true,
    manageUserAccess: input.manageUserAccess === true,
    createBoards: input.createBoards !== false,
    createPipelines: input.createPipelines !== false,
  }
}

export function effectiveUserPermissions(user: Pick<AppUser, 'role' | 'permissions'>): AppUserPermissions {
  return user.role === 'owner' ? { ...OWNER_PERMISSIONS } : normalizePermissions(user.permissions)
}

export function canInviteUsers(user: Pick<AppUser, 'role' | 'permissions'>): boolean {
  return effectiveUserPermissions(user).inviteUsers
}

export function canManageUserAccess(user: Pick<AppUser, 'role' | 'permissions'>): boolean {
  return effectiveUserPermissions(user).manageUserAccess
}

function toAppUser(row: AppUserRow): AppUser {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    jobTitle: row.job_title,
    timezone: row.timezone || 'America/New_York',
    locale: row.locale || 'en-US',
    permissions: row.role === 'owner' ? { ...OWNER_PERMISSIONS } : normalizePermissions(row.permissions),
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
        email, role, status, permissions, activated_at, created_at, updated_at
      )
      VALUES ($1, 'owner', 'active', $2::jsonb, now(), now(), now())
      ON CONFLICT (email) DO UPDATE SET
        role = 'owner',
        status = CASE WHEN app_users.status = 'disabled' THEN 'disabled' ELSE 'active' END,
        permissions = $2::jsonb,
        activated_at = COALESCE(app_users.activated_at, now()),
        updated_at = now()
      RETURNING *
    `,
    [email, JSON.stringify(OWNER_PERMISSIONS)],
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
  if (!canInviteUsers(actor) && !canManageUserAccess(actor)) return { actor, users: [actor] }
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
  if (!canInviteUsers(actor)) throw new Error('You do not have permission to invite users')
  const email = normalizeUserEmail(input.email)
  if (email === actor.email) return actor

  return withTransaction(async (client) => {
    const existing = await client.query<AppUserRow>('SELECT * FROM app_users WHERE email = $1 FOR UPDATE', [email])
    const current = existing.rows[0]
    if (current?.role === 'owner') throw new Error('The owner already has access')
    if (current?.role === 'admin' && actor.role !== 'owner') throw new Error('Only the owner can invite administrators')
    if (current?.status === 'disabled' && !canManageUserAccess(actor)) {
      throw new Error('You do not have permission to restore disabled users')
    }
    if (current?.status === 'active') return toAppUser(current)

    const result = await client.query<AppUserRow>(
      `
        INSERT INTO app_users (
          email, role, status, permissions, invited_by, invited_at, created_at, updated_at
        )
        VALUES ($1, 'member', 'invited', $3::jsonb, $2, now(), now(), now())
        ON CONFLICT (email) DO UPDATE SET
          status = 'invited',
          invited_by = EXCLUDED.invited_by,
          invited_at = now(),
          updated_at = now()
        RETURNING *
      `,
      [email, actor.email, JSON.stringify(MEMBER_PERMISSIONS)],
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
  if (!canManageUserAccess(actor)) throw new Error('You do not have permission to manage users')
  const email = normalizeUserEmail(input.email)
  if (email === actor.email && input.status === 'disabled') throw new Error('You cannot disable your own account')

  const target = await getAppUser(email)
  if (!target) throw new Error('User was not found')
  if (target.role === 'owner') throw new Error('The owner account cannot be changed')
  if (actor.role !== 'owner' && target.role !== 'member') throw new Error('Only the owner can manage administrators')

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

function cleanOptionalText(value: unknown, maxLength: number): string | null {
  const text = String(value || '').trim()
  if (!text) return null
  if (text.length > maxLength) throw new Error(`Value must be ${maxLength} characters or fewer`)
  return text
}

function normalizeTimezone(value: unknown): string {
  const timezone = String(value || '').trim() || 'America/New_York'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw new Error('A valid timezone is required')
  }
  return timezone
}

function normalizeLocale(value: unknown): string {
  const locale = String(value || '').trim() || 'en-US'
  try {
    return Intl.getCanonicalLocales(locale)[0] || 'en-US'
  } catch {
    throw new Error('A valid locale is required')
  }
}

export async function updateAppUserProfile(input: {
  actorEmail: unknown
  displayName: unknown
  jobTitle?: unknown
  timezone?: unknown
  locale?: unknown
}): Promise<AppUser> {
  const actor = await requireActiveAppUser(input.actorEmail)
  const displayName = cleanOptionalText(input.displayName, 100)
  if (!displayName) throw new Error('Name is required')
  const jobTitle = cleanOptionalText(input.jobTitle, 120)
  const timezone = normalizeTimezone(input.timezone)
  const locale = normalizeLocale(input.locale)
  const result = await query<AppUserRow>(
    `
      UPDATE app_users
      SET display_name = $2,
          job_title = $3,
          timezone = $4,
          locale = $5,
          updated_at = now()
      WHERE email = $1
      RETURNING *
    `,
    [actor.email, displayName, jobTitle, timezone, locale],
  )
  return toAppUser(result.rows[0])
}

export async function updateAppUserAccess(input: {
  actorEmail: unknown
  email: unknown
  role?: 'admin' | 'member'
  permissions?: Partial<AppUserPermissions>
}): Promise<AppUser> {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (!canManageUserAccess(actor)) throw new Error('You do not have permission to manage users')
  const email = normalizeUserEmail(input.email)
  const target = await getAppUser(email)
  if (!target) throw new Error('User was not found')
  if (target.role === 'owner') throw new Error('The owner account cannot be changed')
  if (actor.role !== 'owner' && (target.role !== 'member' || input.role === 'admin')) {
    throw new Error('Only the owner can manage administrators')
  }

  const role = input.role || target.role
  const base = input.role && input.role !== target.role
    ? role === 'admin' ? { ...OWNER_PERMISSIONS } : { ...MEMBER_PERMISSIONS }
    : target.permissions
  const requested = input.permissions && typeof input.permissions === 'object' ? input.permissions : {}
  const permissions = normalizePermissions({ ...base, ...requested })
  const result = await query<AppUserRow>(
    `
      UPDATE app_users
      SET role = $2,
          permissions = $3::jsonb,
          updated_at = now()
      WHERE email = $1
      RETURNING *
    `,
    [email, role, JSON.stringify(permissions)],
  )
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
