import { query, withTransaction } from '@/lib/persistence/postgres'
import { recordAuditEvent } from '@/lib/auditWriter'
import { findSuiteCrmUser } from '@/lib/crm/suiteCrmClient'

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
  viewAccounting: boolean
  prepareAccounting: boolean
  approveAccounting: boolean
  viewOrganizationAudit: boolean
  viewSystemAudit: boolean
}

export const MEMBER_PERMISSIONS: AppUserPermissions = {
  inviteUsers: false,
  manageUserAccess: false,
  createBoards: true,
  createPipelines: true,
  viewFullReleaseHistory: false,
  manageBackups: false,
  manageLinks: false,
  viewAccounting: false,
  prepareAccounting: false,
  approveAccounting: false,
  viewOrganizationAudit: false,
  viewSystemAudit: false,
}

export const OWNER_PERMISSIONS: AppUserPermissions = {
  inviteUsers: true,
  manageUserAccess: true,
  createBoards: true,
  createPipelines: true,
  viewFullReleaseHistory: true,
  manageBackups: true,
  manageLinks: true,
  viewAccounting: true,
  prepareAccounting: true,
  approveAccounting: true,
  viewOrganizationAudit: true,
  viewSystemAudit: true,
}

export type AppUser = {
  email: string
  referenceCode: string | null
  contactReferenceCode: string
  crmUserEnabled: boolean
  role: AppUserRole
  status: AppUserStatus
  displayName: string | null
  jobTitle: string | null
  organizationId: string | null
  organizationName: string | null
  organizationRole: AppUserRole | null
  organizationPermissions: AppUserPermissions | null
  suiteCrmUserId: string | null
  suiteCrmUsername: string | null
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
  membershipCreated: boolean
  previousMembership: AppUserMembershipSnapshot | null
}

export type AppUserMembershipSnapshot = {
  role: AppUserRole
  permissions: AppUserPermissions
  status: AppUserStatus
  isDefault: boolean
}

type AppUserRow = {
  email: string
  reference_code: string | null
  contact_reference_code: string
  crm_user_enabled: boolean
  role: AppUserRole
  status: AppUserStatus
  display_name: string | null
  job_title: string | null
  organization_id: string | null
  organization_name: string | null
  suitecrm_user_id: string | null
  suitecrm_username: string | null
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

export function isRootAppOwner(user: Pick<AppUser, 'email' | 'role'>): boolean {
  try {
    return user.role === 'owner' && user.email === configuredOwnerEmail()
  } catch {
    return false
  }
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
    viewAccounting: input.viewAccounting === true,
    prepareAccounting: input.prepareAccounting === true,
    approveAccounting: input.approveAccounting === true,
    viewOrganizationAudit: input.viewOrganizationAudit === true,
    viewSystemAudit: input.viewSystemAudit === true,
  }
}

export function permissionsForRole(role: AppUserRole, value: unknown): AppUserPermissions {
  if (role === 'owner') return { ...OWNER_PERMISSIONS }
  const permissions = normalizePermissions(value)
  if (role === 'member') {
    permissions.inviteUsers = false
    permissions.manageUserAccess = false
    permissions.viewFullReleaseHistory = false
    permissions.manageBackups = false
    permissions.manageLinks = false
    permissions.approveAccounting = false
    permissions.viewOrganizationAudit = false
    permissions.viewSystemAudit = false
  }
  return permissions
}

type AuthorizationUser = Pick<AppUser, 'role' | 'permissions'>
  & Partial<Pick<AppUser, 'organizationRole' | 'organizationPermissions'>>

export function effectiveAuthorizationRole(user: AuthorizationUser): AppUserRole {
  return user.organizationRole || user.role
}

export function effectiveUserPermissions(user: AuthorizationUser): AppUserPermissions {
  return permissionsForRole(
    effectiveAuthorizationRole(user),
    user.organizationPermissions || user.permissions,
  )
}

export function canInviteUsers(user: AuthorizationUser): boolean {
  const role = effectiveAuthorizationRole(user)
  return (role === 'owner' || role === 'admin') && effectiveUserPermissions(user).inviteUsers
}

export function canManageUserAccess(user: AuthorizationUser): boolean {
  const role = effectiveAuthorizationRole(user)
  return (role === 'owner' || role === 'admin') && effectiveUserPermissions(user).manageUserAccess
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
    contactReferenceCode: row.contact_reference_code,
    crmUserEnabled: row.crm_user_enabled,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    jobTitle: row.job_title,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationRole: null,
    organizationPermissions: null,
    suiteCrmUserId: row.suitecrm_user_id,
    suiteCrmUsername: row.suitecrm_username,
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

type ScopedAppUserRow = AppUserRow & {
  membership_organization_id: string
  membership_organization_name: string
  membership_role: AppUserRole
  membership_permissions: unknown
  membership_status: AppUserStatus
}

function toScopedAppUser(row: ScopedAppUserRow): AppUser {
  const role = row.membership_role
  const permissions = permissionsForRole(role, row.membership_permissions)
  return {
    ...toAppUser(row),
    role,
    permissions,
    status: row.membership_status,
    organizationId: row.membership_organization_id,
    organizationName: row.membership_organization_name,
    organizationRole: role,
    organizationPermissions: permissions,
  }
}

function overlayIdentityOnMembership(identity: AppUser, membership: AppUser): AppUser {
  return {
    ...identity,
    role: membership.role,
    permissions: membership.permissions,
    status: membership.status,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    organizationRole: membership.organizationRole,
    organizationPermissions: membership.organizationPermissions,
  }
}

async function getScopedAppUser(email: string, organizationId: string): Promise<AppUser | null> {
  const result = await query<ScopedAppUserRow>(
    `SELECT app_user.*,
       membership.organization_id::text AS membership_organization_id,
       organization.name AS membership_organization_name,
       membership.role AS membership_role,
       membership.permissions AS membership_permissions,
       membership.status AS membership_status
     FROM app_users app_user
     JOIN app_user_organization_memberships membership ON membership.user_email = app_user.email
     JOIN workspace_organizations organization ON organization.id = membership.organization_id
     WHERE app_user.email = $1 AND membership.organization_id = $2::uuid
     LIMIT 1`,
    [email, organizationId],
  )
  return result.rows[0] ? toScopedAppUser(result.rows[0]) : null
}

export async function ensureOwnerUser(): Promise<AppUser> {
  const email = configuredOwnerEmail()
  const result = await query<AppUserRow>(
    `
      INSERT INTO app_users (
        email, reference_code, contact_reference_code, crm_user_enabled,
        role, status, permissions, activated_at, created_at, updated_at
      )
      VALUES (
        $1,
        COALESCE((SELECT reference_code FROM app_users WHERE email = $1), allocate_crm_reference('gu')),
        COALESCE((SELECT contact_reference_code FROM app_users WHERE email = $1), allocate_crm_reference('gc')),
        true, 'owner', 'active', $2::jsonb, now(), now(), now()
      )
      ON CONFLICT (email) DO UPDATE SET
        reference_code = COALESCE(app_users.reference_code, allocate_crm_reference('gu')),
        crm_user_enabled = true,
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

export async function resolveAppUserActor(value: AppUser | unknown): Promise<AppUser> {
  if (value && typeof value === 'object' && typeof (value as AppUser).email === 'string') {
    const actor = value as AppUser
    if (actor.status !== 'active') throw new Error('User access is not active')
    return actor
  }
  return requireActiveAppUser(value)
}

export async function listAppUsers(actorEmailValue: AppUser | unknown): Promise<{ actor: AppUser; users: AppUser[] }> {
  const actor = await resolveAppUserActor(actorEmailValue)
  const actorView = actor.organizationRole
    ? {
        ...actor,
        role: actor.organizationRole,
        permissions: actor.organizationPermissions || actor.permissions,
      }
    : actor
  if (!canInviteUsers(actor) && !canManageUserAccess(actor)) return { actor: actorView, users: [actorView] }
  if (!actor.organizationId) return { actor: actorView, users: [actorView] }
  const result = await query<AppUserRow>(
    `
      WITH RECURSIVE managed AS (
        SELECT id FROM workspace_organizations WHERE id = $1::uuid
        UNION ALL
        SELECT child.id
        FROM workspace_organizations child
        JOIN managed parent ON child.parent_id = parent.id
      )
      SELECT app_user.*,
        membership.organization_id::text AS membership_organization_id,
        organization.name AS membership_organization_name,
        membership.role AS membership_role,
        membership.permissions AS membership_permissions,
        membership.status AS membership_status
      FROM app_user_organization_memberships membership
      JOIN app_users app_user ON app_user.email = membership.user_email
      JOIN workspace_organizations organization ON organization.id = membership.organization_id
      JOIN managed ON managed.id = membership.organization_id
      ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
        membership.created_at ASC, app_user.email ASC
    `,
    [actor.organizationId],
  )
  return {
    actor: actorView,
    users: result.rows.map((row) => toScopedAppUser(row as ScopedAppUserRow)),
  }
}

export async function inviteAppUser(input: {
  actorEmail: unknown
  email: unknown
  organizationId: unknown
  crmUserEnabled?: unknown
}): Promise<InviteAppUserResult> {
  const actor = await resolveAppUserActor(input.actorEmail)
  if (!canInviteUsers(actor)) throw new AppUserAuthorizationError('You do not have permission to invite users')
  const email = normalizeUserEmail(input.email)
  const crmUserEnabled = input.crmUserEnabled === true
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
      membershipCreated: false,
      previousMembership: null,
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
    if (current?.status === 'disabled') {
      if (!canManageUserAccess(actor)) {
        throw new AppUserAuthorizationError('You do not have permission to restore disabled users')
      }
      throw new AppUserAuthorizationError('Restore the disabled user before sending a new invitation')
    }
    const existingMembership = await client.query<{
      role: AppUserRole
      permissions: unknown
      status: AppUserStatus
      is_default: boolean
    }>(
      `SELECT role, permissions, status, is_default
       FROM app_user_organization_memberships
       WHERE user_email = $1 AND organization_id = $2::uuid
       FOR UPDATE`,
      [email, organizationId],
    )
    const membershipRow = existingMembership.rows[0]
    const previousMembership = membershipRow
      ? {
          role: membershipRow.role,
          permissions: permissionsForRole(membershipRow.role, membershipRow.permissions),
          status: membershipRow.status,
          isDefault: membershipRow.is_default,
        }
      : null
    if (membershipRow?.status === 'active') {
      throw new AppUserAuthorizationError('This user already has active access to the selected organization')
    }
    const invitedCrmUserEnabled = current ? current.crm_user_enabled : crmUserEnabled

    const result = await client.query<AppUserRow>(
      `
        INSERT INTO app_users (
          email, reference_code, contact_reference_code, crm_user_enabled,
          role, status, permissions, invited_by, invited_at,
          organization_id, organization_name, created_at, updated_at
        )
        VALUES (
          $1,
          CASE WHEN $6::boolean
            THEN COALESCE((SELECT reference_code FROM app_users WHERE email = $1), allocate_crm_reference('gu'))
            ELSE NULL
          END,
          COALESCE((SELECT contact_reference_code FROM app_users WHERE email = $1), allocate_crm_reference('gc')),
          $6::boolean,
          'member', 'invited', $3::jsonb, $2, now(), $4::uuid, $5, now(), now()
        )
        ON CONFLICT (email) DO UPDATE SET
          status = CASE WHEN app_users.status = 'active' THEN 'active' ELSE 'invited' END,
          invited_by = EXCLUDED.invited_by,
          invited_at = now(),
          organization_id = COALESCE(app_users.organization_id, EXCLUDED.organization_id),
          organization_name = CASE
            WHEN app_users.organization_id IS NULL THEN EXCLUDED.organization_name
            ELSE app_users.organization_name
          END,
          updated_at = now()
        RETURNING *
      `,
      [email, actor.email, JSON.stringify(MEMBER_PERMISSIONS), organizationId, organization.rows[0].name, invitedCrmUserEnabled],
    )
    const membership = await client.query<{
      role: AppUserRole
      permissions: unknown
      status: AppUserStatus
      is_default: boolean
    }>(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status, is_default,
         created_by, updated_by, created_at, updated_at
       ) VALUES (
         $1, $2::uuid, 'member', $3::jsonb, 'invited',
         NOT EXISTS (
           SELECT 1 FROM app_user_organization_memberships
           WHERE user_email = $1 AND is_default
         ),
         $4, $4, now(), now()
       )
       ON CONFLICT (user_email, organization_id) DO UPDATE SET
         status = 'invited',
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING role, permissions, status, is_default`,
      [email, organizationId, JSON.stringify(MEMBER_PERMISSIONS), actor.email],
    )
    const invitedMembership = membership.rows[0]
    const invitedUser = {
      ...toAppUser(result.rows[0]),
      organizationId,
      organizationName: organization.rows[0].name,
      organizationRole: invitedMembership.role,
      organizationPermissions: permissionsForRole(invitedMembership.role, invitedMembership.permissions),
      status: invitedMembership.status,
    }
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'user.invited',
      aggregateType: 'app_user',
      aggregateId: email,
      subject: email,
      organizationId,
      payload: {
        organizationId,
        organizationName: organization.rows[0].name,
        previousOrganizationId: current?.organization_id || null,
        membershipCreated: !membershipRow,
        reinvited: Boolean(membershipRow),
        crmUserEnabled: result.rows[0].crm_user_enabled,
      },
    }, client)
    return {
      user: invitedUser,
      created: !current,
      previousOrganizationId: current?.organization_id || null,
      previousInvitedBy: current?.invited_by || null,
      membershipCreated: !membershipRow,
      previousMembership,
    }
  })
}

export async function restoreInvitedUserAssignment(input: {
  email: unknown
  organizationId: string
  invitedBy: string | null
  previousMembership: AppUserMembershipSnapshot | null
}): Promise<void> {
  const email = normalizeUserEmail(input.email)
  await withTransaction(async (client) => {
    if (input.previousMembership) {
      await client.query(
        `UPDATE app_user_organization_memberships
         SET role = $3,
             permissions = $4::jsonb,
             status = $5,
             is_default = $6,
             updated_at = now()
         WHERE user_email = $1 AND organization_id = $2::uuid`,
        [
          email,
          input.organizationId,
          input.previousMembership.role,
          JSON.stringify(input.previousMembership.permissions),
          input.previousMembership.status,
          input.previousMembership.isDefault,
        ],
      )
    } else {
      await client.query(
        `DELETE FROM app_user_organization_memberships
         WHERE user_email = $1 AND organization_id = $2::uuid`,
        [email, input.organizationId],
      )
    }
    await client.query(
      `UPDATE app_users
       SET invited_by = $2,
           updated_at = now()
       WHERE email = $1`,
      [email, input.invitedBy],
    )
  })
}

export async function setAppUserStatus(input: {
  actorEmail: unknown
  email: unknown
  organizationId?: unknown
  status: 'active' | 'disabled'
}): Promise<AppUser> {
  const actor = await resolveAppUserActor(input.actorEmail)
  if (!canManageUserAccess(actor)) throw new AppUserAuthorizationError('You do not have permission to manage users')
  const email = normalizeUserEmail(input.email)
  if (email === actor.email && input.status === 'disabled') throw new AppUserAuthorizationError('You cannot disable your own account')

  const organizationId = String(input.organizationId || actor.organizationId || '').trim()
  if (!organizationId) throw new AppUserAuthorizationError('Active workspace is not configured')
  await requireOrganizationInActorScope(actor, organizationId)
  const target = await getScopedAppUser(email, organizationId)
  if (!target) throw new AppUserNotFoundError()
  if (target.role === 'owner') throw new AppUserAuthorizationError('The owner account cannot be changed')
  if (effectiveAuthorizationRole(actor) !== 'owner' && target.role !== 'member') {
    throw new AppUserAuthorizationError('Only the owner can manage administrators')
  }
  if (input.status === 'active' && target.status === 'invited') {
    throw new AppUserAuthorizationError('Invited users must accept their welcome link before activation')
  }

  await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE app_user_organization_memberships
       SET status = $3,
           updated_by = $4,
           updated_at = now()
       WHERE user_email = $1
         AND organization_id = $2::uuid
         AND role <> 'owner'
       RETURNING user_email`,
      [email, organizationId, input.status, actor.email],
    )
    if (!result.rows[0]) throw new AppUserNotFoundError()
    await client.query(
      `UPDATE app_users app_user
       SET status = CASE
             WHEN $2 = 'active' THEN 'active'
             WHEN EXISTS (
               SELECT 1
               FROM app_user_organization_memberships membership
               WHERE membership.user_email = app_user.email
                 AND membership.status = 'active'
             ) THEN 'active'
             ELSE 'disabled'
           END,
           activated_at = CASE WHEN $2 = 'active' THEN COALESCE(activated_at, now()) ELSE activated_at END,
           updated_at = now()
       WHERE email = $1`,
      [email, input.status],
    )
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'user.status.updated',
      aggregateType: 'app_user',
      aggregateId: email,
      subject: email,
      organizationId,
      payload: { previousStatus: target.status, status: input.status, organizationId },
    }, client)
  })
  const updated = await getScopedAppUser(email, organizationId)
  if (!updated) throw new AppUserNotFoundError()
  return updated
}

export async function updateAppUserCrmEmployee(input: {
  actorEmail: unknown
  email: unknown
  organizationId?: unknown
  enabled: unknown
}): Promise<AppUser> {
  const actor = await resolveAppUserActor(input.actorEmail)
  if (!canManageUserAccess(actor)) {
    throw new AppUserAuthorizationError('You do not have permission to manage CRM employees')
  }
  const email = normalizeUserEmail(input.email)
  const enabled = input.enabled === true
  const organizationId = String(input.organizationId || actor.organizationId || '').trim()
  if (!organizationId) throw new AppUserAuthorizationError('Active workspace is not configured')
  await requireOrganizationInActorScope(actor, organizationId)
  const target = await getScopedAppUser(email, organizationId)
  if (!target) throw new AppUserNotFoundError()
  if (target.role === 'owner' && !enabled) {
    throw new AppUserAuthorizationError('The owner must remain a CRM employee')
  }
  if (effectiveAuthorizationRole(actor) !== 'owner' && target.role !== 'member' && target.email !== actor.email) {
    throw new AppUserAuthorizationError('Only the owner can manage another administrator as a CRM employee')
  }

  return withTransaction(async (client) => {
    const locked = await client.query<AppUserRow>('SELECT * FROM app_users WHERE email = $1 FOR UPDATE', [email])
    const current = locked.rows[0]
    if (!current) throw new AppUserNotFoundError()
    if (current.crm_user_enabled === enabled) {
      return overlayIdentityOnMembership(toAppUser(current), target)
    }

    let updated: AppUserRow | undefined
    if (enabled) {
      const result = await client.query<AppUserRow>(
        `UPDATE app_users
         SET crm_user_enabled = true,
             reference_code = COALESCE(reference_code, allocate_crm_reference('gu')),
             updated_at = now()
         WHERE email = $1
         RETURNING *`,
        [email],
      )
      updated = result.rows[0]
    } else {
      const ownedContacts = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM crm_contacts
         WHERE owner_user_reference_code = $1`,
        [current.reference_code],
      )
      const ownedCount = Number(ownedContacts.rows[0]?.count || 0)
      if (ownedCount > 0) {
        throw new Error(`Reassign ${ownedCount} CRM Contact${ownedCount === 1 ? '' : 's'} before removing this employee`)
      }
      const result = await client.query<AppUserRow>(
        `UPDATE app_users
         SET crm_user_enabled = false,
             reference_code = NULL,
             suitecrm_user_id = NULL,
             suitecrm_username = NULL,
             updated_at = now()
         WHERE email = $1
         RETURNING *`,
        [email],
      )
      updated = result.rows[0]
      if (current.reference_code) {
        await client.query(
          `UPDATE crm_reference_registry
           SET status = 'retired', retired_at = COALESCE(retired_at, now())
           WHERE reference_code = $1 AND status = 'active'`,
          [current.reference_code],
        )
      }
    }
    if (!updated) throw new AppUserNotFoundError()
    const user = overlayIdentityOnMembership(toAppUser(updated), target)
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'user.crm_employee.updated',
      aggregateType: 'app_user',
      aggregateId: email,
      subject: target.displayName || email,
      organizationId,
      payload: {
        enabled,
        previousReferenceCode: current.reference_code,
        referenceCode: user.referenceCode,
        suiteCrmMappingCleared: !enabled && Boolean(current.suitecrm_user_id),
      },
    }, client)
    return user
  })
}

export async function syncAppUserSuiteCrmIdentity(input: {
  actorEmail: unknown
  email: unknown
  organizationId?: unknown
}): Promise<AppUser> {
  const actor = await resolveAppUserActor(input.actorEmail)
  if (!canManageUserAccess(actor)) {
    throw new AppUserAuthorizationError('You do not have permission to manage CRM user mappings')
  }
  const email = normalizeUserEmail(input.email)
  const organizationId = String(input.organizationId || actor.organizationId || '').trim()
  if (!organizationId) throw new AppUserAuthorizationError('Active workspace is not configured')
  await requireOrganizationInActorScope(actor, organizationId)
  const target = await getScopedAppUser(email, organizationId)
  if (!target) throw new AppUserNotFoundError()
  if (!target.crmUserEnabled || !target.referenceCode) {
    throw new Error('Configure this user as a CRM employee before matching a SuiteCRM user')
  }
  if (target.role === 'owner' && target.email !== actor.email) {
    throw new AppUserAuthorizationError('Only the owner can update the owner CRM mapping')
  }
  if (effectiveAuthorizationRole(actor) !== 'owner' && target.role === 'admin' && target.email !== actor.email) {
    throw new AppUserAuthorizationError('Only the owner can update another administrator CRM mapping')
  }
  const referenceCode = target.referenceCode.toLowerCase()
  let suiteCrmUserId = String(target.suiteCrmUserId || '').trim().toLowerCase()
  let matchedBy = suiteCrmUserId ? 'existing_mapping' : ''
  if (!suiteCrmUserId) {
    const match = await findSuiteCrmUser({ globalId: referenceCode })
      || await findSuiteCrmUser({ email: target.email })
    if (!match) {
      throw new Error(`No active SuiteCRM employee matches ${referenceCode} or ${target.email}. Create the employee in SuiteCRM with this email, then sync again.`)
    }
    if (match.globalId && match.globalId !== referenceCode) {
      throw new Error('SuiteCRM employee already has a different permanent ClawPilot Global ID')
    }
    suiteCrmUserId = match.id.toLowerCase()
    matchedBy = match.globalId === referenceCode ? 'global_id' : 'email'
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(suiteCrmUserId)) {
    throw new Error('SuiteCRM user ID is invalid')
  }
  return withTransaction(async (client) => {
    const result = await client.query<AppUserRow>(
      `UPDATE app_users
       SET suitecrm_user_id = $2,
           suitecrm_username = $3,
           updated_at = now()
       WHERE email = $1
       RETURNING *`,
      [email, suiteCrmUserId, referenceCode],
    )
    if (!result.rows[0]) throw new AppUserNotFoundError()
    const user = overlayIdentityOnMembership(toAppUser(result.rows[0]), target)
    if (!user.suiteCrmUserId) throw new Error('SuiteCRM user mapping was not persisted')
    if (!user.referenceCode) throw new Error('CRM employee Global ID was not persisted')
    const payload = {
      localId: user.email,
      suiteCrmUserId: user.suiteCrmUserId,
      referenceCode: user.referenceCode,
      username: user.referenceCode,
    }
    await client.query(
      `INSERT INTO sync_outbox (
         aggregate_type, aggregate_id, operation, target_system, payload,
         status, attempts, idempotency_key, created_at, available_at, updated_at
       )
       VALUES ('app_users', $1, 'upsert_user_identity', 'suitecrm', $2::jsonb,
         'queued', 0, $3, now(), now(), now())
       ON CONFLICT (target_system, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO UPDATE SET
         payload = EXCLUDED.payload,
         status = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.status ELSE 'queued' END,
         attempts = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.attempts ELSE 0 END,
         last_error = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.last_error ELSE NULL END,
         available_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.available_at ELSE now() END,
         processed_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.processed_at ELSE NULL END,
         updated_at = now()`,
      [user.email, JSON.stringify(payload), `crm:suitecrm-user-identity:v2:${user.email}:${user.suiteCrmUserId}:${user.referenceCode}`],
    )
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'user.crm_identity.synced',
      aggregateType: 'app_user',
      aggregateId: email,
      subject: target.displayName || email,
      organizationId,
      payload: {
        suiteCrmUsername: referenceCode,
        referenceCode: user.referenceCode,
        matchedBy,
        identitySync: 'queued',
      },
    }, client)
    return user
  })
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
  const actor = await resolveAppUserActor(input.actorEmail)
  const displayName = cleanOptionalText(input.displayName, 100)
  if (!displayName) throw new Error('Name is required')
  const jobTitle = cleanOptionalText(input.jobTitle, 120)
  const requestedOrganizationName = cleanOptionalText(input.organizationName, 200)
  if (!requestedOrganizationName) throw new Error('Organization name is required')
  const timezone = normalizeTimezone(input.timezone)
  const locale = normalizeLocale(input.locale)
  const row = await withTransaction(async (client) => {
    if (!actor.organizationId) throw new Error('Active workspace is not configured')
    await client.query('SELECT email FROM app_users WHERE email = $1 FOR UPDATE', [actor.email])
    const locked = await client.query<{ organization_name: string }>(
      `SELECT name AS organization_name
       FROM workspace_organizations
       WHERE id = $1::uuid
       FOR UPDATE`,
      [actor.organizationId],
    )
    const organizationId = actor.organizationId
    if (!locked.rows[0]) throw new Error('Active workspace is not available')
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
           organization_name = CASE WHEN organization_id = $4::uuid THEN $5 ELSE organization_name END,
           timezone = $6,
           locale = $7,
           updated_at = now()
       WHERE email = $1
       RETURNING *`,
      [actor.email, displayName, jobTitle, organizationId, organizationName, timezone, locale],
    )

    await recordAuditEvent({
      actor: actor.email,
      eventType: 'user.profile.updated',
      aggregateType: 'app_user',
      aggregateId: actor.email,
      subject: actor.email,
      organizationId,
      payload: {
        organizationId,
        fields: ['displayName', 'jobTitle', 'organizationName', 'timezone', 'locale'],
      },
    }, client)

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
         AND pipeline.workspace_organization_id = $2::uuid
         AND pipeline.google_service_account_email IS NOT NULL
         AND pipeline.google_shared_drive_id IS NOT NULL
       ON CONFLICT (target_system, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO UPDATE SET status = 'queued', attempts = 0, last_error = NULL,
         available_at = now(), processed_at = NULL, locked_at = NULL,
         lock_token = NULL, updated_at = now()`,
      [actor.email, organizationId],
    )
    await client.query(
      `UPDATE pipeline_spaces
       SET provisioning_status = 'queued', provisioning_error = NULL, updated_at = now()
       WHERE owner_email = $1
         AND workspace_organization_id = $2::uuid
         AND google_service_account_email IS NOT NULL
         AND google_shared_drive_id IS NOT NULL`,
      [actor.email, organizationId],
    )
    return updated.rows[0]
  })
  return {
    ...overlayIdentityOnMembership(toAppUser(row), actor),
    organizationName: requestedOrganizationName,
  }
}

export async function updateAppUserAccess(input: {
  actorEmail: unknown
  email: unknown
  organizationId?: unknown
  role?: 'admin' | 'member'
  permissions?: Partial<AppUserPermissions>
}): Promise<AppUser> {
  const actor = await resolveAppUserActor(input.actorEmail)
  if (!canManageUserAccess(actor)) throw new AppUserAuthorizationError('You do not have permission to manage users')
  const email = normalizeUserEmail(input.email)
  const organizationId = String(input.organizationId || actor.organizationId || '').trim()
  if (!organizationId) throw new AppUserAuthorizationError('Active workspace is not configured')
  await requireOrganizationInActorScope(actor, organizationId)
  const target = await getScopedAppUser(email, organizationId)
  if (!target) throw new AppUserNotFoundError()
  if (target.role === 'owner') throw new AppUserAuthorizationError('The owner account cannot be changed')
  if (effectiveAuthorizationRole(actor) !== 'owner' && (target.role !== 'member' || input.role === 'admin')) {
    throw new AppUserAuthorizationError('Only the owner can manage administrators')
  }

  const role = input.role || target.role
  const base = input.role && input.role !== target.role
    ? role === 'admin' ? { ...OWNER_PERMISSIONS } : { ...MEMBER_PERMISSIONS }
    : target.permissions
  const requested = input.permissions && typeof input.permissions === 'object' ? input.permissions : {}
  const permissions = permissionsForRole(role, { ...base, ...requested })
  await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE app_user_organization_memberships
       SET role = $2,
           permissions = $3::jsonb,
           updated_by = $5,
           updated_at = now()
       WHERE user_email = $1
         AND organization_id = $4::uuid
         AND role <> 'owner'
       RETURNING user_email`,
      [email, role, JSON.stringify(permissions), organizationId, actor.email],
    )
    if (!result.rows[0]) throw new AppUserNotFoundError()
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'user.access.updated',
      aggregateType: 'app_user',
      aggregateId: email,
      subject: email,
      organizationId,
      payload: {
        organizationId,
        previousRole: target.role,
        role,
        permissions,
      },
    }, client)
  })
  const updated = await getScopedAppUser(email, organizationId)
  if (!updated) throw new AppUserNotFoundError()
  return updated
}

export async function markAppUserSignedIn(emailValue: unknown): Promise<AppUser> {
  const email = normalizeUserEmail(emailValue)
  return withTransaction(async (client) => {
    const result = await client.query<AppUserRow>(
      `UPDATE app_users
       SET status = 'active',
           activated_at = COALESCE(activated_at, now()),
           last_login_at = now(),
           updated_at = now()
       WHERE email = $1
         AND status IN ('invited', 'active')
       RETURNING *`,
      [email],
    )
    if (!result.rows[0]) throw new Error('User access is not active')
    await client.query(
      `UPDATE app_user_organization_memberships
       SET status = 'active', updated_at = now()
       WHERE user_email = $1 AND status = 'invited' AND is_default`,
      [email],
    )
    return toAppUser(result.rows[0])
  })
}
