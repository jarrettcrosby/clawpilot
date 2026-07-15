import { query, withTransaction } from '@/lib/persistence/postgres'
import {
  AppUserAuthorizationError,
  canInviteUsers,
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

  if (user.organizationId) {
    const current = await organizationById(user.organizationId)
    if (current) {
      await query(
        `UPDATE app_users SET organization_name = $2, updated_at = now() WHERE email = $1 AND organization_name IS DISTINCT FROM $2`,
        [email, current.name],
      )
      return current
    }
  }

  if (user.role !== 'owner' && user.invitedBy) {
    const inviterOrganization = await ensurePrimaryWorkspaceOrganization(user.invitedBy, visited)
    return withTransaction(async (client) => {
      const assigned = await client.query<{ organization_id: string | null }>(
        'SELECT organization_id::text FROM app_users WHERE email = $1 FOR UPDATE',
        [email],
      )
      if (!assigned.rows[0]) throw new Error('User was not found')
      const organizationId = assigned.rows[0].organization_id || inviterOrganization.id
      if (!assigned.rows[0].organization_id) {
        await client.query(
          `UPDATE app_users
           SET organization_id = $2::uuid, organization_name = $3, updated_at = now()
           WHERE email = $1`,
          [email, inviterOrganization.id, inviterOrganization.name],
        )
      }
      const organization = organizationId === inviterOrganization.id
        ? inviterOrganization
        : await organizationById(organizationId)
      if (!organization) throw new Error('User organization is not available')
      return organization
    })
  }

  const name = defaultOrganizationName({
    email,
    displayName: user.displayName,
    role: user.role,
    configuredName: user.organizationName,
  })
  const organizationType = user.role === 'owner' ? 'root' : 'member'

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
      [null, name, organizationType, email],
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
      parentName: null,
    }
  })
}

export async function resolveInvitationWorkspaceOrganization(input: {
  actorEmail: unknown
  organizationId?: unknown
  createOrganization?: unknown
  organizationName?: unknown
  parentOrganizationId?: unknown
}): Promise<{ organization: WorkspaceOrganization; created: boolean }> {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (!canInviteUsers(actor)) {
    throw new AppUserAuthorizationError('You do not have permission to assign invitation organizations')
  }
  const current = await ensurePrimaryWorkspaceOrganization(actor.email)
  const createOrganization = input.createOrganization === true
  const requestedId = String(input.organizationId || '').trim()

  if (!createOrganization) {
    const organization = requestedId ? await organizationById(requestedId) : current
    if (!organization) throw new Error('Invitation organization was not found')
    const lineage = await workspaceOrganizationAncestors(organization.id)
    if (!lineage.some((candidate) => candidate.id === current.id)) {
      throw new AppUserAuthorizationError('Invitation organization is outside your managed account graph')
    }
    return { organization, created: false }
  }

  const parentId = String(input.parentOrganizationId || '').trim() || current.id
  const parent = await organizationById(parentId)
  if (!parent) throw new Error('Parent organization was not found')
  const parentLineage = await workspaceOrganizationAncestors(parent.id)
  if (!parentLineage.some((candidate) => candidate.id === current.id)) {
    throw new AppUserAuthorizationError('Parent organization is outside your managed account graph')
  }
  const name = cleanOrganizationName(input.organizationName)

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${parent.id}:${name.toLowerCase()}`])
    const existing = await client.query<WorkspaceOrganizationRow>(
      `SELECT organization.id::text, organization.reference_code,
         organization.parent_id::text, parent.name AS parent_name,
         organization.name, organization.organization_type
       FROM workspace_organizations organization
       LEFT JOIN workspace_organizations parent ON parent.id = organization.parent_id
       WHERE organization.parent_id = $1::uuid AND lower(btrim(organization.name)) = lower(btrim($2))
       ORDER BY organization.created_at, organization.id
       LIMIT 1`,
      [parent.id, name],
    )
    if (existing.rows[0]) return { organization: toWorkspaceOrganization(existing.rows[0]), created: false }

    const matchingAccounts = await client.query<{ reference_code: string }>(
      `SELECT DISTINCT record.reference_code
       FROM pipeline_spaces pipeline
       JOIN crm_organizations record ON record.pipeline_id = pipeline.id
       WHERE pipeline.workspace_organization_id = $1::uuid
         AND record.relationship_type = 'customer'
         AND lower(btrim(record.name)) = lower(btrim($2))
       LIMIT 2`,
      [parent.id, name],
    )
    if (matchingAccounts.rows.length > 1) {
      throw new Error('More than one CRM account has this name. Select an existing organization or use a distinct name')
    }
    const promotedReferenceCode = matchingAccounts.rows[0]?.reference_code || null
    if (promotedReferenceCode) {
      const alreadyPromoted = await client.query<{ id: string }>(
        'SELECT id::text FROM workspace_organizations WHERE reference_code = $1 LIMIT 1',
        [promotedReferenceCode],
      )
      if (alreadyPromoted.rows[0]) throw new Error('This CRM account is already assigned to an organization')
    }
    const created = await client.query<WorkspaceOrganizationRow>(
      `INSERT INTO workspace_organizations (
         parent_id, name, organization_type, reference_code,
         created_by, updated_by, created_at, updated_at
       )
       VALUES ($1::uuid, $2, 'member', COALESCE($4, allocate_crm_reference('ga')), $3, $3, now(), now())
       RETURNING id::text, reference_code, parent_id::text, name, organization_type`,
      [parent.id, name, actor.email, promotedReferenceCode],
    )
    if (promotedReferenceCode) {
      await client.query(
        `UPDATE crm_organizations
         SET workspace_organization_id = $2::uuid,
             relationship_type = 'workspace_member',
             source_key = 'workspace:' || $2::text,
             identity_key = 'workspace:' || $2::text,
             source_payload = COALESCE(source_payload, '{}'::jsonb)
               || jsonb_build_object('source', 'clawpilot_workspace', 'workspaceOrganizationId', $2::text),
             updated_by = $3,
             updated_at = now()
         WHERE reference_code = $1`,
        [promotedReferenceCode, created.rows[0].id, actor.email],
      )
    }
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'organization.created_for_invitation', 'workspace_organization', $2, $3::jsonb)`,
      [actor.email, created.rows[0].id, JSON.stringify({
        parentId: parent.id,
        promotedReferenceCode,
      })],
    )
    return {
      organization: { ...toWorkspaceOrganization(created.rows[0]), parentName: parent.name },
      created: true,
    }
  })
}

export async function retireUnusedWorkspaceOrganization(organizationIdValue: unknown): Promise<void> {
  const organizationId = String(organizationIdValue || '').trim()
  if (!organizationId) return
  await withTransaction(async (client) => {
    const organization = await client.query<{ reference_code: string; parent_id: string | null }>(
      `SELECT reference_code, parent_id::text
       FROM workspace_organizations
       WHERE id = $1::uuid
       FOR UPDATE`,
      [organizationId],
    )
    if (!organization.rows[0]?.parent_id) return
    const inUse = await client.query<{ in_use: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM app_users WHERE organization_id = $1::uuid)
          OR EXISTS(SELECT 1 FROM pipeline_spaces WHERE workspace_organization_id = $1::uuid)
          OR EXISTS(SELECT 1 FROM workspace_organizations WHERE parent_id = $1::uuid)
          OR EXISTS(SELECT 1 FROM crm_organizations WHERE workspace_organization_id = $1::uuid) AS in_use`,
      [organizationId],
    )
    if (inUse.rows[0]?.in_use) return
    await client.query('DELETE FROM workspace_organizations WHERE id = $1::uuid', [organizationId])
    await client.query(
      `UPDATE crm_reference_registry
       SET status = 'retired', retired_at = COALESCE(retired_at, now())
       WHERE reference_code = $1 AND status = 'active'`,
      [organization.rows[0].reference_code],
    )
  })
}

export async function updatePrimaryWorkspaceOrganization(input: {
  actorEmail: unknown
  name: unknown
}) {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (!canManageUserAccess(actor)) {
    throw new AppUserAuthorizationError('You do not have permission to rename the shared organization')
  }
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
  const canViewAll = canInviteUsers(actor) || canManageUserAccess(actor)
  const result = await query<WorkspaceOrganizationRow>(
    canViewAll
      ? `WITH RECURSIVE organization_tree AS (
           SELECT organization.id, organization.reference_code, organization.parent_id, organization.name,
             organization.organization_type, 0 AS depth, ARRAY[organization.id] AS path
           FROM workspace_organizations organization
           WHERE organization.id = $1::uuid
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
      : `SELECT organization.id::text, organization.reference_code,
           organization.parent_id::text, parent.name AS parent_name,
           organization.name, organization.organization_type, 0 AS depth,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'email', app_user.email,
               'displayName', app_user.display_name,
               'role', app_user.role,
               'status', app_user.status
             ) ORDER BY app_user.created_at, app_user.email)
             FROM app_users app_user WHERE app_user.organization_id = organization.id
           ), '[]'::jsonb) AS members
         FROM workspace_organizations organization
         LEFT JOIN workspace_organizations parent ON parent.id = organization.parent_id
         WHERE organization.id = $1::uuid`,
    [current.id],
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
  const actorOrganization = await ensurePrimaryWorkspaceOrganization(actor.email)
  if (organizationId === actorOrganization.id) {
    throw new AppUserAuthorizationError('You cannot reparent the organization that defines your admin scope')
  }

  await withTransaction(async (client) => {
    const target = await client.query<{ organization_type: 'root' | 'member' }>(
      `WITH RECURSIVE managed AS (
         SELECT id FROM workspace_organizations WHERE id = $2::uuid
         UNION ALL
         SELECT child.id
         FROM workspace_organizations child
         JOIN managed parent ON child.parent_id = parent.id
       )
       SELECT organization.organization_type
       FROM workspace_organizations organization
       JOIN managed ON managed.id = organization.id
       WHERE organization.id = $1::uuid
       FOR UPDATE`,
      [organizationId, actorOrganization.id],
    )
    if (!target.rows[0]) throw new Error('Organization was not found')
    if (target.rows[0].organization_type === 'root') throw new Error('The root organization cannot be reparented')

    const parent = await client.query<{ id: string }>(
      `WITH RECURSIVE managed AS (
         SELECT id FROM workspace_organizations WHERE id = $2::uuid
         UNION ALL
         SELECT child.id
         FROM workspace_organizations child
         JOIN managed parent ON child.parent_id = parent.id
       )
       SELECT organization.id::text
       FROM workspace_organizations organization
       JOIN managed ON managed.id = organization.id
       WHERE organization.id = $1::uuid
       FOR UPDATE`,
      [parentId, actorOrganization.id],
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
