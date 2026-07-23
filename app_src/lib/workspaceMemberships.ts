import { recordAuditEvent } from '@/lib/auditWriter'
import { query, withTransaction } from '@/lib/persistence/postgres'
import {
  MEMBER_PERMISSIONS,
  OWNER_PERMISSIONS,
  AppUserAuthorizationError,
  appUserHasDemoAccess,
  getAppUser,
  isRootAppOwner,
  normalizeUserEmail,
  permissionsForRole,
  type AppUser,
  type AppUserPermissions,
  type AppUserRole,
  type AppUserStatus,
} from '@/lib/users'
import {
  DEMO_BOARD_ID,
  DEMO_PIPELINE_ID,
  DEMO_SYSTEM_EMAIL,
  DEMO_WORKSPACE_ID,
} from '@/lib/demoMode'

export type WorkspaceMembership = {
  organizationId: string
  organizationReferenceCode: string
  organizationName: string
  organizationType: 'root' | 'member'
  isDemo: boolean
  role: AppUserRole
  permissions: AppUserPermissions
  status: AppUserStatus
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

type WorkspaceMembershipRow = {
  organization_id: string
  organization_reference_code: string
  organization_name: string
  organization_type: 'root' | 'member'
  is_demo: boolean
  role: AppUserRole
  permissions: unknown
  status: AppUserStatus
  is_default: boolean
  created_at: string
  updated_at: string
}

const MEMBERSHIP_SELECT = `SELECT membership.organization_id::text,
  organization.reference_code AS organization_reference_code,
  organization.name AS organization_name,
  organization.organization_type,
  organization.is_demo,
  membership.role,
  membership.permissions,
  membership.status,
  membership.is_default,
  membership.created_at::text,
  membership.updated_at::text
  FROM app_user_organization_memberships membership
  JOIN workspace_organizations organization ON organization.id = membership.organization_id`

function toWorkspaceMembership(row: WorkspaceMembershipRow): WorkspaceMembership {
  return {
    organizationId: row.organization_id,
    organizationReferenceCode: row.organization_reference_code,
    organizationName: row.organization_name,
    organizationType: row.organization_type,
    isDemo: row.is_demo,
    role: row.role,
    permissions: permissionsForRole(row.role, row.permissions),
    status: row.status,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function ensureDemoWorkspaceMembership(actor: AppUser): Promise<WorkspaceMembership> {
  if (!await appUserHasDemoAccess(actor.email)) {
    throw new AppUserAuthorizationError('Demo access is not enabled for this user')
  }
  const permissions: AppUserPermissions = {
    ...MEMBER_PERMISSIONS,
    accessDemo: true,
    createBoards: false,
    createPipelines: false,
    viewOperations: true,
    manageOperations: false,
    executeWarehouse: false,
    manageCarrierRateNetworks: false,
    grantCarrierRateAccess: false,
    viewCarrierCost: false,
    reconcileCarrierBilling: false,
    approveCarrierSettlement: false,
    viewAccounting: true,
  }
  return withTransaction(async (client) => {
    const demo = await client.query<{ id: string }>(
      `SELECT id::text FROM workspace_organizations
       WHERE id = $1::uuid AND is_demo = true
       FOR SHARE`,
      [DEMO_WORKSPACE_ID],
    )
    if (!demo.rows[0]) throw new Error('Demo account is not available')
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status, is_default,
         created_by, updated_by, created_at, updated_at
       ) VALUES ($1, $2::uuid, 'member', $3::jsonb, 'active', false,
         $4, $4, now(), now())
       ON CONFLICT (user_email, organization_id) DO UPDATE SET
         role = 'member', permissions = EXCLUDED.permissions, status = 'active',
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [actor.email, DEMO_WORKSPACE_ID, JSON.stringify(permissions), DEMO_SYSTEM_EMAIL],
    )
    await client.query(
      `INSERT INTO project_board_members (
         board_id, user_email, access_role, shared_by, created_at, updated_at
       ) VALUES ($1::uuid, $2, 'viewer', $3, now(), now())
       ON CONFLICT (board_id, user_email) DO UPDATE SET
         access_role = 'viewer', shared_by = EXCLUDED.shared_by, updated_at = now()`,
      [DEMO_BOARD_ID, actor.email, DEMO_SYSTEM_EMAIL],
    )
    await client.query(
      `INSERT INTO pipeline_space_members (
         pipeline_id, user_email, access_role, shared_by, created_at, updated_at
       ) VALUES ($1::uuid, $2, 'viewer', $3, now(), now())
       ON CONFLICT (pipeline_id, user_email) DO UPDATE SET
         access_role = 'viewer', shared_by = EXCLUDED.shared_by, updated_at = now()`,
      [DEMO_PIPELINE_ID, actor.email, DEMO_SYSTEM_EMAIL],
    )
    await client.query(
      `INSERT INTO app_user_workspace_preferences (
         user_email, workspace_organization_id, default_board_id, default_pipeline_id,
         created_at, updated_at
       ) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, now(), now())
       ON CONFLICT (user_email, workspace_organization_id) DO UPDATE SET
         default_board_id = EXCLUDED.default_board_id,
         default_pipeline_id = EXCLUDED.default_pipeline_id,
         updated_at = now()`,
      [actor.email, DEMO_WORKSPACE_ID, DEMO_BOARD_ID, DEMO_PIPELINE_ID],
    )
    const result = await client.query<WorkspaceMembershipRow>(
      `${MEMBERSHIP_SELECT}
       WHERE membership.user_email = $1
         AND membership.organization_id = $2::uuid
       LIMIT 1`,
      [actor.email, DEMO_WORKSPACE_ID],
    )
    if (!result.rows[0]) throw new Error('Demo account access could not be prepared')
    return toWorkspaceMembership(result.rows[0])
  })
}

export async function listWorkspaceMemberships(emailValue: unknown): Promise<WorkspaceMembership[]> {
  const email = normalizeUserEmail(emailValue)
  const user = await getAppUser(email)
  if (!user || user.status === 'disabled') throw new Error('User access is not active')
  const result = await query<WorkspaceMembershipRow>(
    `${MEMBERSHIP_SELECT}
     WHERE membership.user_email = $1
       AND membership.status = 'active'
     ORDER BY membership.is_default DESC, lower(organization.name), membership.created_at`,
    [email],
  )
  return result.rows.map(toWorkspaceMembership)
}

export async function requireWorkspaceAppUser(
  emailValue: unknown,
  organizationIdValue?: unknown,
): Promise<AppUser> {
  const email = normalizeUserEmail(emailValue)
  const user = await getAppUser(email)
  if (!user || user.status !== 'active') throw new Error('User access is not active')
  const organizationId = String(organizationIdValue || '').trim()
  const result = await query<WorkspaceMembershipRow>(
    `${MEMBERSHIP_SELECT}
     WHERE membership.user_email = $1
       AND membership.status = 'active'
       ${organizationId ? 'AND membership.organization_id = $2::uuid' : ''}
     ORDER BY membership.is_default DESC, membership.created_at
     LIMIT 1`,
    organizationId ? [email, organizationId] : [email],
  )
  const membership = result.rows[0] ? toWorkspaceMembership(result.rows[0]) : null
  if (!membership) throw new Error('Active workspace access is not available')
  return {
    ...user,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    organizationRole: membership.role,
    organizationPermissions: membership.permissions,
  }
}

function cleanWorkspaceName(value: unknown): string {
  const name = String(value || '').replace(/\s+/g, ' ').trim()
  if (!name) throw new Error('Business name is required')
  if (name.length > 200) throw new Error('Business name must be 200 characters or fewer')
  return name
}

export async function createIndependentRootWorkspace(input: {
  actor: AppUser
  name: unknown
}): Promise<WorkspaceMembership> {
  if (!isRootAppOwner(input.actor)) throw new Error('Root administrator access required')
  const name = cleanWorkspaceName(input.name)
  return withTransaction(async (client) => {
    const existing = await client.query<WorkspaceMembershipRow>(
      `${MEMBERSHIP_SELECT}
       WHERE membership.user_email = $1
         AND organization.parent_id IS NULL
         AND lower(btrim(organization.name)) = lower($2)
       LIMIT 1
       FOR UPDATE OF membership, organization`,
      [input.actor.email, name],
    )
    if (existing.rows[0]) return toWorkspaceMembership(existing.rows[0])

    const organization = await client.query<{
      id: string
      reference_code: string
      name: string
    }>(
      `INSERT INTO workspace_organizations (
         parent_id, name, organization_type, created_by, updated_by, created_at, updated_at
       ) VALUES (NULL, $1, 'root', $2, $2, now(), now())
       RETURNING id::text, reference_code, name`,
      [name, input.actor.email],
    )
    const created = organization.rows[0]
    const membership = await client.query<WorkspaceMembershipRow>(
      `WITH inserted AS (
         INSERT INTO app_user_organization_memberships (
           user_email, organization_id, role, permissions, status, is_default,
           created_by, updated_by, created_at, updated_at
         ) VALUES ($1, $2::uuid, 'owner', $3::jsonb, 'active', false, $1, $1, now(), now())
         RETURNING *
       )
       ${MEMBERSHIP_SELECT.replace('FROM app_user_organization_memberships membership', 'FROM inserted membership')}`,
      [input.actor.email, created.id, JSON.stringify(OWNER_PERMISSIONS)],
    )
    await recordAuditEvent({
      actor: input.actor.email,
      subject: created.name,
      eventType: 'workspace.organization.created',
      aggregateType: 'workspace_organization',
      aggregateId: created.id,
      organizationId: created.id,
      payload: {
        organizationId: created.id,
        organizationReferenceCode: created.reference_code,
        organizationName: created.name,
        organizationType: 'root',
      },
    }, client)
    return toWorkspaceMembership(membership.rows[0])
  })
}
