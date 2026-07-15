import { query, withTransaction } from '@/lib/persistence/postgres'
import {
  AppUserAuthorizationError,
  canManageUserAccess,
  getAppUser,
  normalizeUserEmail,
  requireActiveAppUser,
} from '@/lib/users'

export type WorkspaceOrganization = {
  id: string
  referenceCode: string
  parentId: string | null
  parentName: string | null
  name: string
  organizationType: 'root' | 'member'
  depth: number
  members: Array<{
    email: string
    displayName: string | null
    role: 'owner' | 'admin' | 'member'
    status: 'invited' | 'active' | 'disabled'
  }>
}

type WorkspaceOrganizationRow = {
  id: string
  reference_code: string
  parent_id: string | null
  parent_name?: string | null
  name: string
  organization_type: 'root' | 'member'
  depth?: number | string
  members?: WorkspaceOrganization['members'] | null
}

function cleanOrganizationName(value: unknown) {
  const name = String(value || '').replace(/\s+/g, ' ').trim()
  if (!name) throw new Error('Organization name is required')
  if (name.length > 200) throw new Error('Organization name must be 200 characters or fewer')
  return name
}

function defaultOrganizationName(input: {
  email: string
  displayName: string | null
  role: 'owner' | 'admin' | 'member'
  configuredName: string | null
}) {
  if (input.configuredName) return cleanOrganizationName(input.configuredName)
  if (input.role === 'owner') {
    const configuredRoot = String(process.env.CLAWPILOT_ROOT_ORGANIZATION_NAME || '').trim()
    if (configuredRoot) return cleanOrganizationName(configuredRoot)
    const domain = input.email.split('@')[1]?.split('.')[0] || 'ClawPilot'
    const words = domain.replace(/co$/i, ' Co').replace(/[-_]+/g, ' ')
    return cleanOrganizationName(words.replace(/\b\w/g, (letter) => letter.toUpperCase()))
  }
  const person = input.displayName?.trim() || input.email.split('@')[0]
  return cleanOrganizationName(`${person}'s Organization`)
}

function toWorkspaceOrganization(row: WorkspaceOrganizationRow): WorkspaceOrganization {
  return {
    id: row.id,
    referenceCode: row.reference_code,
    parentId: row.parent_id,
    parentName: row.parent_name || null,
    name: row.name,
    organizationType: row.organization_type,
    depth: Number(row.depth || 0),
    members: Array.isArray(row.members) ? row.members : [],
  }
}

async function organizationById(id: string) {
  const result = await query<WorkspaceOrganizationRow>(
    `SELECT organization.id::text, organization.reference_code,
       organization.parent_id::text, parent.name AS parent_name,
       organization.name, organization.organization_type
     FROM workspace_organizations organization
     LEFT JOIN workspace_organizations parent ON parent.id = organization.parent_id
     WHERE organization.id = $1::uuid
     LIMIT 1`,
    [id],
  )
  return result.rows[0] ? toWorkspaceOrganization(result.rows[0]) : null
}

export async function ensurePrimaryWorkspaceOrganization(
  emailValue: unknown,
  visited = new Set<string>(),
): Promise<WorkspaceOrganization> {
  const email = normalizeUserEmail(emailValue)
  if (visited.has(email) || visited.size > 20) throw new Error('Organization invitation hierarchy is invalid')
  visited.add(email)
  const user = await getAppUser(email)
  if (!user || user.status === 'disabled') throw new Error('User access is not available for organization provisioning')

  let parent: WorkspaceOrganization | null = null
  if (user.role !== 'owner' && user.invitedBy) {
    parent = await ensurePrimaryWorkspaceOrganization(user.invitedBy, visited)
  }

  if (user.organizationId) {
    const current = await organizationById(user.organizationId)
    if (current) {
      if (user.role !== 'owner' && parent && !current.parentId) {
        const repaired = await query<WorkspaceOrganizationRow>(
          `UPDATE workspace_organizations
           SET parent_id = $2::uuid, organization_type = 'member', updated_by = $3, updated_at = now()
           WHERE id = $1::uuid AND parent_id IS NULL
           RETURNING id::text, reference_code, parent_id::text, name, organization_type`,
          [current.id, parent.id, email],
        )
        if (repaired.rows[0]) {
          await query(
            'UPDATE pipeline_spaces SET workspace_organization_id = $2::uuid, updated_at = now() WHERE owner_email = $1',
            [email, current.id],
          )
          return { ...toWorkspaceOrganization(repaired.rows[0]), parentName: parent.name }
        }
      }
      await query(
        `UPDATE app_users SET organization_name = $2, updated_at = now() WHERE email = $1 AND organization_name IS DISTINCT FROM $2`,
        [email, current.name],
      )
      await query(
        `UPDATE pipeline_spaces SET workspace_organization_id = $2::uuid, updated_at = now()
         WHERE owner_email = $1 AND workspace_organization_id IS DISTINCT FROM $2::uuid`,
        [email, current.id],
      )
      return current
    }
  }

  const name = defaultOrganizationName({
    email,
    displayName: user.displayName,
    role: user.role,
    configuredName: user.organizationName,
  })
  const organizationType = user.role === 'owner' && !parent ? 'root' : 'member'

  return withTransaction(async (client) => {
    const locked = await client.query<{
      organization_id: string | null
      organization_name: string | null
    }>('SELECT organization_id::text, organization_name FROM app_users WHERE email = $1 FOR UPDATE', [email])
    if (!locked.rows[0]) throw new Error('User was not found')
    if (locked.rows[0].organization_id) {
      const existing = await client.query<WorkspaceOrganizationRow>(
        `SELECT organization.id::text, organization.reference_code,
           organization.parent_id::text, parent.name AS parent_name,
           organization.name, organization.organization_type
         FROM workspace_organizations organization
         LEFT JOIN workspace_organizations parent ON parent.id = organization.parent_id
         WHERE organization.id = $1::uuid`,
        [locked.rows[0].organization_id],
      )
      if (existing.rows[0]) return toWorkspaceOrganization(existing.rows[0])
    }

    const created = await client.query<WorkspaceOrganizationRow>(
      `INSERT INTO workspace_organizations (
         parent_id, name, organization_type, created_by, updated_by, created_at, updated_at
       )
       VALUES ($1::uuid, $2, $3, $4, $4, now(), now())
       RETURNING id::text, reference_code, parent_id::text, name, organization_type`,
      [parent?.id || null, name, organizationType, email],
    )
    const organization = created.rows[0]
    await client.query(
      `UPDATE app_users SET organization_id = $2::uuid, organization_name = $3, updated_at = now() WHERE email = $1`,
      [email, organization.id, organization.name],
    )
    await client.query(
      `UPDATE pipeline_spaces SET workspace_organization_id = $2::uuid, updated_at = now() WHERE owner_email = $1`,
      [email, organization.id],
    )
    return {
      ...toWorkspaceOrganization(organization),
      parentName: parent?.name || null,
    }
  })
}

export async function updatePrimaryWorkspaceOrganization(input: {
  actorEmail: unknown
  name: unknown
}) {
  const actor = await requireActiveAppUser(input.actorEmail)
  const organization = await ensurePrimaryWorkspaceOrganization(actor.email)
  const name = cleanOrganizationName(input.name)
  const result = await withTransaction(async (client) => {
    const updated = await client.query<WorkspaceOrganizationRow>(
      `UPDATE workspace_organizations
       SET name = $2, updated_by = $3, updated_at = now()
       WHERE id = $1::uuid
       RETURNING id::text, reference_code, parent_id::text, name, organization_type`,
      [organization.id, name, actor.email],
    )
    await client.query(
      'UPDATE app_users SET organization_name = $2, updated_at = now() WHERE organization_id = $1::uuid',
      [organization.id, name],
    )
    return updated.rows[0]
  })
  return { ...toWorkspaceOrganization(result), parentName: organization.parentName }
}

export async function listWorkspaceOrganizationHierarchy(actorEmailValue: unknown) {
  const actor = await requireActiveAppUser(actorEmailValue)
  const current = await ensurePrimaryWorkspaceOrganization(actor.email)
  const canViewAll = actor.role === 'owner' || actor.role === 'admin'
  if (canViewAll) {
    const missing = await query<{ email: string }>(
      `SELECT email
       FROM app_users
       WHERE status IN ('invited', 'active') AND organization_id IS NULL
       ORDER BY created_at, email`,
    )
    for (const user of missing.rows) await ensurePrimaryWorkspaceOrganization(user.email)
  }
  const result = await query<WorkspaceOrganizationRow>(
    canViewAll
      ? `WITH RECURSIVE organization_tree AS (
           SELECT organization.id, organization.reference_code, organization.parent_id, organization.name,
             organization.organization_type, 0 AS depth, ARRAY[organization.id] AS path
           FROM workspace_organizations organization
           WHERE organization.parent_id IS NULL
           UNION ALL
           SELECT child.id, child.reference_code, child.parent_id, child.name, child.organization_type,
             tree.depth + 1, tree.path || child.id
           FROM workspace_organizations child
           JOIN organization_tree tree ON child.parent_id = tree.id
           WHERE NOT child.id = ANY(tree.path)
         )
         SELECT tree.id::text, tree.reference_code, tree.parent_id::text, parent.name AS parent_name,
           tree.name, tree.organization_type, tree.depth,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'email', app_user.email,
               'displayName', app_user.display_name,
               'role', app_user.role,
               'status', app_user.status
             ) ORDER BY app_user.created_at, app_user.email)
             FROM app_users app_user WHERE app_user.organization_id = tree.id
           ), '[]'::jsonb) AS members
         FROM organization_tree tree
         LEFT JOIN workspace_organizations parent ON parent.id = tree.parent_id
         ORDER BY tree.path`
      : `WITH RECURSIVE ancestors AS (
           SELECT organization.id, organization.reference_code, organization.parent_id, organization.name,
             organization.organization_type, 0 AS distance, ARRAY[organization.id] AS path
           FROM workspace_organizations organization
           WHERE organization.id = $1::uuid
           UNION ALL
           SELECT parent.id, parent.reference_code, parent.parent_id, parent.name, parent.organization_type,
             ancestor.distance + 1, ancestor.path || parent.id
           FROM workspace_organizations parent
           JOIN ancestors ancestor ON ancestor.parent_id = parent.id
           WHERE NOT parent.id = ANY(ancestor.path)
         )
         SELECT ancestor.id::text, ancestor.reference_code,
           ancestor.parent_id::text, parent.name AS parent_name,
           ancestor.name, ancestor.organization_type,
           max(ancestor.distance) OVER () - ancestor.distance AS depth,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'email', app_user.email,
               'displayName', app_user.display_name,
               'role', app_user.role,
               'status', app_user.status
             ) ORDER BY app_user.created_at, app_user.email)
             FROM app_users app_user WHERE app_user.organization_id = ancestor.id
           ), '[]'::jsonb) AS members
         FROM ancestors ancestor
         LEFT JOIN workspace_organizations parent ON parent.id = ancestor.parent_id
         ORDER BY depth`,
    canViewAll ? [] : [current.id],
  )
  return result.rows.map(toWorkspaceOrganization)
}

export async function workspaceOrganizationAncestors(organizationId: string) {
  const result = await query<WorkspaceOrganizationRow>(
    `WITH RECURSIVE ancestors AS (
       SELECT organization.id, organization.reference_code, organization.parent_id, organization.name,
         organization.organization_type, 0 AS distance, ARRAY[organization.id] AS path
       FROM workspace_organizations organization
       WHERE organization.id = $1::uuid
       UNION ALL
       SELECT parent.id, parent.reference_code, parent.parent_id, parent.name, parent.organization_type,
         ancestor.distance + 1, ancestor.path || parent.id
       FROM workspace_organizations parent
       JOIN ancestors ancestor ON ancestor.parent_id = parent.id
       WHERE NOT parent.id = ANY(ancestor.path)
     )
     SELECT id::text, reference_code, parent_id::text, name, organization_type,
       max(distance) OVER () - distance AS depth
     FROM ancestors
     ORDER BY depth`,
    [organizationId],
  )
  return result.rows.map(toWorkspaceOrganization)
}

export async function workspaceOrganizationRootId(emailValue: unknown) {
  const organization = await ensurePrimaryWorkspaceOrganization(emailValue)
  const ancestors = await workspaceOrganizationAncestors(organization.id)
  return (ancestors.find((candidate) => candidate.parentId === null) || organization).id
}

export async function updateWorkspaceOrganizationParent(input: {
  actorEmail: unknown
  organizationId: unknown
  parentId: unknown
}) {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (!canManageUserAccess(actor)) {
    throw new AppUserAuthorizationError('You do not have permission to manage organization hierarchy')
  }
  const organizationId = String(input.organizationId || '').trim()
  const parentId = String(input.parentId || '').trim()
  if (!organizationId || !parentId) throw new Error('Organization and parent organization are required')
  if (organizationId === parentId) throw new Error('An organization cannot be its own parent')

  await withTransaction(async (client) => {
    const target = await client.query<{ organization_type: 'root' | 'member' }>(
      `SELECT organization_type
       FROM workspace_organizations
       WHERE id = $1::uuid
       FOR UPDATE`,
      [organizationId],
    )
    if (!target.rows[0]) throw new Error('Organization was not found')
    if (target.rows[0].organization_type === 'root') throw new Error('The root organization cannot be reparented')

    const parent = await client.query<{ id: string }>(
      'SELECT id::text FROM workspace_organizations WHERE id = $1::uuid FOR UPDATE',
      [parentId],
    )
    if (!parent.rows[0]) throw new Error('Parent organization was not found')
    const cycle = await client.query<{ cycle: boolean }>(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM workspace_organizations WHERE parent_id = $1::uuid
         UNION ALL
         SELECT child.id
         FROM workspace_organizations child
         JOIN descendants parent ON child.parent_id = parent.id
       )
       SELECT EXISTS(SELECT 1 FROM descendants WHERE id = $2::uuid) AS cycle`,
      [organizationId, parentId],
    )
    if (cycle.rows[0]?.cycle) throw new Error('Organization hierarchy cannot contain a cycle')

    await client.query(
      `UPDATE workspace_organizations
       SET parent_id = $2::uuid, organization_type = 'member', updated_by = $3, updated_at = now()
       WHERE id = $1::uuid`,
      [organizationId, parentId, actor.email],
    )
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'organization.parent.updated', 'workspace_organization', $2, $3::jsonb)`,
      [actor.email, organizationId, JSON.stringify({ parentId })],
    )
  })
  return listWorkspaceOrganizationHierarchy(actor.email)
}
