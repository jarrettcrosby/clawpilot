import { query, withTransaction } from '@/lib/persistence/postgres'

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

export type AppUserRole = 'owner' | 'admin' | 'member'
export type AppUserStatus = 'invited' | 'active' | 'disabled'

export class AppUserAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppUserAuthorizationError'
  }
}

export class AppUserNotFoundError extends Error {
  constructor(message = 'User was not found') {
    super(message)
    this.name = 'AppUserNotFoundError'
  }
}

export type AppUserPermissions = {
  inviteUsers: boolean
  manageUserAccess: boolean
  createBoards: boolean
  createPipelines: boolean
  viewFullReleaseHistory: boolean
  manageBackups: boolean
  manageLinks: boolean
}

export const MEMBER_PERMISSIONS: AppUserPermissions = {
  inviteUsers: false,
  manageUserAccess: false,
  createBoards: true,
  createPipelines: true,
  viewFullReleaseHistory: false,
  manageBackups: false,
  manageLinks: false,
}

export const OWNER_PERMISSIONS: AppUserPermissions = {
  inviteUsers: true,
  manageUserAccess: true,
  createBoards: true,
  createPipelines: true,
  viewFullReleaseHistory: true,
  manageBackups: true,
  manageLinks: true,
}

export type AppUser = {
  email: string
  referenceCode: string
  role: AppUserRole
  status: AppUserStatus
  displayName: string | null
  jobTitle: string | null
  organizationId: string | null
  organizationName: string | null
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

export type InviteAppUserResult = {
  user: AppUser
  created: boolean
  previousOrganizationId: string | null
  previousInvitedBy: string | null
}

type AppUserRow = {
  email: string
  reference_code: string
  role: AppUserRole
  status: AppUserStatus
  display_name: string | null
  job_title: string | null
  organization_id: string | null
  organization_name: string | null
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
    viewFullReleaseHistory: input.viewFullReleaseHistory === true,
    manageBackups: input.manageBackups === true,
    manageLinks: input.manageLinks === true,
  }
}

function permissionsForRole(role: AppUserRole, value: unknown): AppUserPermissions {
  if (role === 'owner') return { ...OWNER_PERMISSIONS }
  const permissions = normalizePermissions(value)
  if (role === 'member') {
    permissions.inviteUsers = false
    permissions.manageUserAccess = false
    permissions.viewFullReleaseHistory = false
    permissions.manageBackups = false
    permissions.manageLinks = false
  }
  return permissions
}

export function effectiveUserPermissions(user: Pick<AppUser, 'role' | 'permissions'>): AppUserPermissions {
  return permissionsForRole(user.role, user.permissions)
}

export function canInviteUsers(user: Pick<AppUser, 'role' | 'permissions'>): boolean {
  return (user.role === 'owner' || user.role === 'admin') && effectiveUserPermissions(user).inviteUsers
}

export function canManageUserAccess(user: Pick<AppUser, 'role' | 'permissions'>): boolean {
  return (user.role === 'owner' || user.role === 'admin') && effectiveUserPermissions(user).manageUserAccess
}

async function requireOrganizationInActorScope(actor: AppUser, organizationId: string | null) {
  if (!actor.organizationId || !organizationId) {
    throw new AppUserAuthorizationError('User organization is outside your managed account graph')
  }
  const result = await query<{ allowed: boolean }>(
    `WITH RECURSIVE managed AS (
       SELECT id FROM workspace_organizations WHERE id = $1::uuid
       UNION ALL
       SELECT child.id
       FROM workspace_organizations child
       JOIN managed parent ON child.parent_id = parent.id
     )
     SELECT EXISTS(SELECT 1 FROM managed WHERE id = $2::uuid) AS allowed`,
    [actor.organizationId, organizationId],
  )
  if (!result.rows[0]?.allowed) {
    throw new AppUserAuthorizationError('User organization is outside your managed account graph')
  }
}

function toAppUser(row: AppUserRow): AppUser {
  return {
    email: row.email,
    referenceCode: row.reference_code,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    jobTitle: row.job_title,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    timezone: row.timezone || 'America/New_York',
    locale: row.locale || 'en-US',
    permissions: permissionsForRole(row.role, row.permissions),
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
        email, reference_code, role, status, permissions, activated_at, created_at, updated_at
      )
      VALUES (
        $1,
        COALESCE((SELECT reference_code FROM app_users WHERE email = $1), allocate_crm_reference('gc')),
        'owner', 'active', $2::jsonb, now(), now(), now()
      )
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
  if (!actor.organizationId) return { actor, users: [actor] }
  const result = await query<AppUserRow>(
    `
      WITH RECURSIVE managed AS (
        SELECT id FROM workspace_organizations WHERE id = $1::uuid
        UNION ALL
        SELECT child.id
        FROM workspace_organizations child
        JOIN managed parent ON child.parent_id = parent.id
      )
      SELECT app_user.*
      FROM app_users app_user
      JOIN managed ON managed.id = app_user.organization_id
      ORDER BY CASE app_user.role WHEN 'owner' THEN 0 ELSE 1 END, app_user.created_at ASC, app_user.email ASC
    `,
    [actor.organizationId],
  )
  return { actor, users: result.rows.map(toAppUser) }
}

export async function inviteAppUser(input: {
  actorEmail: unknown
  email: unknown
  organizationId: unknown
}): Promise<InviteAppUserResult> {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (!canInviteUsers(actor)) throw new AppUserAuthorizationError('You do not have permission to invite users')
  const email = normalizeUserEmail(input.email)
  const organizationId = String(input.organizationId || '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error('A valid invitation organization is required')
  }
  if (email === actor.email) {
    if (actor.organizationId !== organizationId) throw new AppUserAuthorizationError('Your own organization cannot be changed by invitation')
    return {
      user: actor,
      created: false,
      previousOrganizationId: actor.organizationId,
      previousInvitedBy: actor.invitedBy,
    }
  }

  return withTransaction(async (client) => {
    if (!actor.organizationId) throw new AppUserAuthorizationError('Your organization is not configured')
    const organization = await client.query<{ id: string; name: string }>(
      `WITH RECURSIVE managed AS (
         SELECT id FROM workspace_organizations WHERE id = $2::uuid
         UNION ALL
         SELECT child.id
         FROM workspace_organizations child
         JOIN managed parent ON child.parent_id = parent.id
       )
       SELECT organization.id::text, organization.name
       FROM workspace_organizations organization
       JOIN managed ON managed.id = organization.id
       WHERE organization.id = $1::uuid
       FOR SHARE`,
      [organizationId, actor.organizationId],
    )
    if (!organization.rows[0]) throw new Error('Invitation organization was not found')
    const existing = await client.query<AppUserRow>('SELECT * FROM app_users WHERE email = $1 FOR UPDATE', [email])
    const current = existing.rows[0]
    if (current?.role === 'owner') throw new Error('The owner already has access')
    if (current?.role === 'admin' && actor.role !== 'owner') throw new AppUserAuthorizationError('Only the owner can invite administrators')
    if (current?.status === 'disabled') {
      if (!canManageUserAccess(actor)) {
        throw new AppUserAuthorizationError('You do not have permission to restore disabled users')
      }
      throw new AppUserAuthorizationError('Restore the disabled user before sending a new invitation')
    }
    if (current?.status === 'active') {
      if (current.organization_id !== organizationId) {
        throw new AppUserAuthorizationError('Active users must be moved by an administrator before reinviting')
      }
      return {
        user: toAppUser(current),
        created: false,
        previousOrganizationId: current.organization_id,
        previousInvitedBy: current.invited_by,
      }
    }

    const result = await client.query<AppUserRow>(
      `
        INSERT INTO app_users (
          email, reference_code, role, status, permissions, invited_by, invited_at,
          organization_id, organization_name, created_at, updated_at
        )
        VALUES (
          $1,
          COALESCE((SELECT reference_code FROM app_users WHERE email = $1), allocate_crm_reference('gc')),
          'member', 'invited', $3::jsonb, $2, now(), $4::uuid, $5, now(), now()
        )
        ON CONFLICT (email) DO UPDATE SET
          status = 'invited',
          invited_by = EXCLUDED.invited_by,
          invited_at = now(),
          organization_id = EXCLUDED.organization_id,
          organization_name = EXCLUDED.organization_name,
          updated_at = now()
        RETURNING *
      `,
      [email, actor.email, JSON.stringify(MEMBER_PERMISSIONS), organizationId, organization.rows[0].name],
    )
    return {
      user: toAppUser(result.rows[0]),
      created: !current,
      previousOrganizationId: current?.organization_id || null,
      previousInvitedBy: current?.invited_by || null,
    }
  })
}

export async function restoreInvitedUserAssignment(input: {
  email: unknown
  organizationId: string | null
  invitedBy: string | null
}): Promise<void> {
  const email = normalizeUserEmail(input.email)
  await withTransaction(async (client) => {
    const organization = input.organizationId
      ? await client.query<{ name: string }>(
        'SELECT name FROM workspace_organizations WHERE id = $1::uuid',
        [input.organizationId],
      )
      : null
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid,
           organization_name = $3,
           invited_by = $4,
           updated_at = now()
       WHERE email = $1 AND status = 'invited'`,
      [email, input.organizationId, organization?.rows[0]?.name || null, input.invitedBy],
    )
  })
}

export async function setAppUserStatus(input: {
  actorEmail: unknown
  email: unknown
  status: 'active' | 'disabled'
}): Promise<AppUser> {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (!canManageUserAccess(actor)) throw new AppUserAuthorizationError('You do not have permission to manage users')
  const email = normalizeUserEmail(input.email)
  if (email === actor.email && input.status === 'disabled') throw new AppUserAuthorizationError('You cannot disable your own account')

  const target = await getAppUser(email)
  if (!target) throw new AppUserNotFoundError()
  await requireOrganizationInActorScope(actor, target.organizationId)
  if (target.role === 'owner') throw new AppUserAuthorizationError('The owner account cannot be changed')
  if (actor.role !== 'owner' && target.role !== 'member') throw new AppUserAuthorizationError('Only the owner can manage administrators')
  if (input.status === 'active' && target.status === 'invited') {
    throw new AppUserAuthorizationError('Invited users must accept their welcome link before activation')
  }

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
  if (!result.rows[0]) throw new AppUserNotFoundError()
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
  organizationName?: unknown
  timezone?: unknown
  locale?: unknown
}): Promise<AppUser> {
  const actor = await requireActiveAppUser(input.actorEmail)
  const displayName = cleanOptionalText(input.displayName, 100)
  if (!displayName) throw new Error('Name is required')
  const jobTitle = cleanOptionalText(input.jobTitle, 120)
  const requestedOrganizationName = cleanOptionalText(input.organizationName, 200)
  if (!requestedOrganizationName) throw new Error('Organization name is required')
  const timezone = normalizeTimezone(input.timezone)
  const locale = normalizeLocale(input.locale)
  const row = await withTransaction(async (client) => {
    const locked = await client.query<{ organization_id: string | null; organization_name: string }>(
      `SELECT app_user.organization_id::text, organization.name AS organization_name
       FROM app_users app_user
       LEFT JOIN workspace_organizations organization ON organization.id = app_user.organization_id
       WHERE app_user.email = $1
       FOR UPDATE OF app_user`,
      [actor.email],
    )
    const organizationId = locked.rows[0]?.organization_id
    if (!organizationId) throw new Error('User organization is not configured')
    const organizationName = canManageUserAccess(actor)
      ? requestedOrganizationName
      : locked.rows[0].organization_name
    if (!canManageUserAccess(actor) && requestedOrganizationName !== organizationName) {
      throw new AppUserAuthorizationError('Only an administrator can rename a shared organization')
    }

    if (canManageUserAccess(actor)) {
      await client.query(
        `UPDATE workspace_organizations
         SET name = $2, updated_by = $3, updated_at = now()
         WHERE id = $1::uuid`,
        [organizationId, organizationName, actor.email],
      )
      await client.query(
        `UPDATE app_users
         SET organization_name = $2, updated_at = now()
         WHERE organization_id = $1::uuid`,
        [organizationId, organizationName],
      )
    }
    const updated = await client.query<AppUserRow>(
      `UPDATE app_users
       SET display_name = $2,
           job_title = $3,
           organization_name = $4,
           timezone = $5,
           locale = $6,
           updated_at = now()
       WHERE email = $1
       RETURNING *`,
      [actor.email, displayName, jobTitle, organizationName, timezone, locale],
    )

    await client.query(
      `INSERT INTO sync_outbox (
         aggregate_type, aggregate_id, operation, target_system, payload,
         status, attempts, idempotency_key, created_at, available_at, updated_at
       )
       SELECT 'pipeline_space', pipeline.id::text, 'provision_pipeline', 'google_workspace',
         jsonb_build_object('pipelineId', pipeline.id::text), 'queued', 0,
         'pipeline:' || pipeline.id::text || ':provision', now(), now(), now()
       FROM pipeline_spaces pipeline
       WHERE pipeline.owner_email = $1
         AND pipeline.google_service_account_email IS NOT NULL
         AND pipeline.google_shared_drive_id IS NOT NULL
       ON CONFLICT (target_system, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO UPDATE SET status = 'queued', attempts = 0, last_error = NULL,
         available_at = now(), processed_at = NULL, locked_at = NULL,
         lock_token = NULL, updated_at = now()`,
      [actor.email],
    )
    await client.query(
      `UPDATE pipeline_spaces
       SET provisioning_status = 'queued', provisioning_error = NULL, updated_at = now()
       WHERE owner_email = $1
         AND google_service_account_email IS NOT NULL
         AND google_shared_drive_id IS NOT NULL`,
      [actor.email],
    )
    return updated.rows[0]
  })
  return toAppUser(row)
}

export async function updateAppUserAccess(input: {
  actorEmail: unknown
  email: unknown
  role?: 'admin' | 'member'
  permissions?: Partial<AppUserPermissions>
}): Promise<AppUser> {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (!canManageUserAccess(actor)) throw new AppUserAuthorizationError('You do not have permission to manage users')
  const email = normalizeUserEmail(input.email)
  const target = await getAppUser(email)
  if (!target) throw new AppUserNotFoundError()
  await requireOrganizationInActorScope(actor, target.organizationId)
  if (target.role === 'owner') throw new AppUserAuthorizationError('The owner account cannot be changed')
  if (actor.role !== 'owner' && (target.role !== 'member' || input.role === 'admin')) {
    throw new AppUserAuthorizationError('Only the owner can manage administrators')
  }

  const role = input.role || target.role
  const base = input.role && input.role !== target.role
    ? role === 'admin' ? { ...OWNER_PERMISSIONS } : { ...MEMBER_PERMISSIONS }
    : target.permissions
  const requested = input.permissions && typeof input.permissions === 'object' ? input.permissions : {}
  const permissions = permissionsForRole(role, { ...base, ...requested })
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
