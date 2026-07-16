import { query, withTransaction } from '@/lib/persistence/postgres'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  DEFAULT_PIPELINE_SHEET_ID,
  enqueuePipelinePermissionSyncWithClient,
  type PipelineProvisioningStatus,
  type PipelineSheetContext,
  type PipelineProjection,
  readPipelineProjectionFromPostgres,
} from '@/lib/persistence/pipeline'
import { shortLinkUrl } from '@/lib/shortlinks'
import { ensurePrimaryWorkspaceOrganization } from '@/lib/organizations'
import {
  effectiveUserPermissions,
  getAppUser,
  normalizeUserEmail,
  requireActiveAppUser,
  type AppUserStatus,
} from '@/lib/users'

export const BOARD_SELECTION_COOKIE = 'clawpilot_board_id'
export const PIPELINE_SELECTION_COOKIE = 'clawpilot_pipeline_id'

export type ResourceAccessRole = 'owner' | 'editor' | 'viewer'
export type SharedResourceMember = {
  email: string
  displayName: string | null
  status: AppUserStatus
  accessRole: 'editor' | 'viewer'
}

export type ProjectBoard = {
  id: string
  name: string
  ownerEmail: string
  isDefault: boolean
  accessRole: ResourceAccessRole
  members: SharedResourceMember[]
  createdAt: string
  updatedAt: string
}

export type PipelineSpace = {
  id: string
  name: string
  ownerEmail: string
  workspaceOrganizationId: string | null
  isDefault: boolean
  accessRole: ResourceAccessRole
  members: SharedResourceMember[]
  sheetBacked: boolean
  syncEnabled: boolean
  sheetId: string | null
  provisioningStatus: PipelineProvisioningStatus
  provisioningError: string | null
  provisioningRequestedAt: string | null
  provisioningStartedAt: string | null
  provisioningLastAttemptedAt: string | null
  provisioningCompletedAt: string | null
  shortLinkId: string | null
  shortLinkUrl: string | null
  projection: PipelineProjection
  createdAt: string
  updatedAt: string
}

export type WorkspacePreferences = {
  defaultBoardId: string | null
  defaultPipelineId: string | null
}

type ResourceMemberRow = {
  email?: string
  displayName?: string | null
  status?: AppUserStatus
  accessRole?: 'editor' | 'viewer'
}

type ProjectBoardRow = {
  id: string
  name: string
  owner_email: string
  is_default: boolean
  access_role: ResourceAccessRole
  members: ResourceMemberRow[] | null
  created_at: string
  updated_at: string
}

type PipelineSpaceRow = {
  id: string
  name: string
  owner_email: string
  workspace_organization_id: string | null
  is_default: boolean
  access_role: ResourceAccessRole
  members: ResourceMemberRow[] | null
  sheet_id: string | null
  sync_enabled: boolean
  provisioning_status: PipelineProvisioningStatus
  provisioning_error: string | null
  provisioning_requested_at: string | null
  provisioning_started_at: string | null
  provisioning_last_attempted_at: string | null
  provisioning_completed_at: string | null
  short_link_id: string | null
  short_link_slug: string | null
  projection: PipelineProjection
  created_at: string
  updated_at: string
}

type WorkspacePreferencesRow = {
  default_board_id: string | null
  default_pipeline_id: string | null
}

const EMPTY_PIPELINE: PipelineProjection = {
  syncedAt: null,
  source: 'app',
  summary: { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
  opportunities: [],
}

function normalizeMembers(value: ResourceMemberRow[] | null): SharedResourceMember[] {
  return (Array.isArray(value) ? value : []).flatMap((member) => {
    if (!member?.email || (member.accessRole !== 'editor' && member.accessRole !== 'viewer')) return []
    return [{
      email: member.email,
      displayName: member.displayName || null,
      status: member.status || 'invited',
      accessRole: member.accessRole,
    }]
  })
}

function toProjectBoard(row: ProjectBoardRow): ProjectBoard {
  return {
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    isDefault: row.is_default,
    accessRole: row.access_role,
    members: normalizeMembers(row.members),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function hostedShortLinkUrl(slug: string | null) {
  if (!slug) return null
  try {
    const url = new URL(shortLinkUrl(slug))
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

function toPipelineSpace(row: PipelineSpaceRow): PipelineSpace {
  return {
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    workspaceOrganizationId: row.workspace_organization_id,
    isDefault: row.is_default,
    accessRole: row.access_role,
    members: normalizeMembers(row.members),
    sheetBacked: Boolean(row.sheet_id),
    syncEnabled: row.sync_enabled,
    sheetId: row.sheet_id,
    provisioningStatus: row.provisioning_status,
    provisioningError: row.provisioning_error,
    provisioningRequestedAt: row.provisioning_requested_at,
    provisioningStartedAt: row.provisioning_started_at,
    provisioningLastAttemptedAt: row.provisioning_last_attempted_at,
    provisioningCompletedAt: row.provisioning_completed_at,
    shortLinkId: row.short_link_id,
    shortLinkUrl: hostedShortLinkUrl(row.short_link_slug),
    projection: row.projection || { ...EMPTY_PIPELINE },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function cleanResourceName(value: unknown, fallback: string): string {
  const name = String(value || '').trim() || fallback
  if (name.length > 100) throw new Error('Name must be 100 characters or fewer')
  return name
}

export async function ensureDefaultResourcesForUser(emailValue: unknown): Promise<{
  boardId: string
  pipelineId: string
  crmBoardId: string
  pipelineProvisioningRequired: boolean
}> {
  const user = await requireActiveAppUser(emailValue)
  const organization = await ensurePrimaryWorkspaceOrganization(user.email)
  const ownerEmail = normalizeUserEmail(user.email)
  const configuredOwner = normalizeUserEmail(process.env.APP_LOGIN_EMAIL)
  const isConfiguredOwner = ownerEmail === configuredOwner

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [organization.id])
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [ownerEmail])

    await client.query(
      `
        INSERT INTO project_boards (name, owner_email, is_default)
        VALUES ($1, $2, true)
        ON CONFLICT (owner_email) WHERE is_default DO NOTHING
      `,
      [isConfiguredOwner ? 'ClawPilot board' : 'My board', ownerEmail],
    )
    const board = await client.query<{ id: string }>(
      'SELECT id::text FROM project_boards WHERE owner_email = $1 AND is_default LIMIT 1',
      [ownerEmail],
    )
    if (!board.rows[0]) throw new Error('Unable to provision a project board')

    type PipelineResourceRow = {
      id: string
      owner_email: string
      provisioning_status: string
      sheet_id: string | null
      short_link_id: string | null
      sync_enabled: boolean
    }
    let personalPipeline = await client.query<PipelineResourceRow>(
      `SELECT id::text, owner_email, provisioning_status, sheet_id, short_link_id::text, sync_enabled
       FROM pipeline_spaces
       WHERE owner_email = $1 AND is_default
       LIMIT 1
       FOR UPDATE`,
      [ownerEmail],
    )

    if (!personalPipeline.rows[0]) {
      personalPipeline = await client.query<PipelineResourceRow>(
        `INSERT INTO pipeline_spaces (
           name, owner_email, workspace_organization_id, is_default, sheet_id, sync_enabled
         )
         VALUES ($1, $2, $3::uuid, true, $4, $5)
         RETURNING id::text, owner_email, provisioning_status, sheet_id, short_link_id::text, sync_enabled`,
        [
          isConfiguredOwner ? 'Sales pipeline' : 'My pipeline',
          ownerEmail,
          organization.id,
          isConfiguredOwner ? DEFAULT_PIPELINE_SHEET_ID : null,
          isConfiguredOwner,
        ],
      )
    }
    if (!personalPipeline.rows[0]) throw new Error('Unable to provision a personal pipeline')

    const crmPipeline = await client.query<{ id: string; owner_email: string }>(
      `SELECT pipeline.id::text, pipeline.owner_email
       FROM pipeline_spaces pipeline
       WHERE pipeline.workspace_organization_id = $1::uuid
       ORDER BY
         EXISTS (
           SELECT 1 FROM crm_board_projections projection
           WHERE projection.pipeline_id = pipeline.id
             AND projection.workspace_organization_id = $1::uuid
         ) DESC,
         (pipeline.owner_email = $2) DESC,
         pipeline.created_at,
         pipeline.id
       LIMIT 1
       FOR UPDATE OF pipeline`,
      [organization.id, configuredOwner],
    )
    if (!crmPipeline.rows[0]) throw new Error('Unable to provision an organization CRM pipeline')

    await client.query(
      `INSERT INTO project_boards (name, owner_email, is_default, created_at, updated_at)
       SELECT 'CRM Board', $1, false, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM project_boards
         WHERE owner_email = $1 AND lower(btrim(name)) = 'crm board'
       )`,
      [ownerEmail],
    )
    const crmBoard = await client.query<{ id: string }>(
      `SELECT id::text
       FROM project_boards
       WHERE owner_email = $1 AND lower(btrim(name)) = 'crm board'
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE`,
      [ownerEmail],
    )
    if (!crmBoard.rows[0]) throw new Error('Unable to provision a CRM board')

    const previousBinding = await client.query<{ pipeline_id: string }>(
      'SELECT pipeline_id::text FROM crm_board_projections WHERE board_id = $1::uuid FOR UPDATE',
      [crmBoard.rows[0].id],
    )
    if (previousBinding.rows[0] && previousBinding.rows[0].pipeline_id !== crmPipeline.rows[0].id) {
      await client.query(
        'DELETE FROM crm_board_cards WHERE board_id = $1::uuid',
        [crmBoard.rows[0].id],
      )
    }

    await client.query(
      `INSERT INTO crm_board_projections (
         board_id, pipeline_id, workspace_organization_id, created_at, updated_at
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, now(), now())
       ON CONFLICT (board_id) DO UPDATE SET
         pipeline_id = EXCLUDED.pipeline_id,
         workspace_organization_id = EXCLUDED.workspace_organization_id,
         updated_at = now()`,
      [crmBoard.rows[0].id, crmPipeline.rows[0].id, organization.id],
    )

    if (crmPipeline.rows[0].owner_email !== ownerEmail) {
      await client.query(
        `INSERT INTO pipeline_space_members (
           pipeline_id, user_email, access_role, shared_by, created_at, updated_at
         )
         VALUES ($1::uuid, $2, 'editor', $3, now(), now())
         ON CONFLICT (pipeline_id, user_email) DO UPDATE SET
           access_role = 'editor', shared_by = EXCLUDED.shared_by, updated_at = now()`,
        [crmPipeline.rows[0].id, ownerEmail, crmPipeline.rows[0].owner_email],
      )
    }

    if (isConfiguredOwner) {
      await client.query('UPDATE tasks SET board_id = $1::uuid WHERE board_id IS NULL', [board.rows[0].id])
      await client.query(
        `
          UPDATE pipeline_spaces
          SET sheet_id = $2,
              sync_enabled = true,
              provisioning_status = 'ready',
              provisioning_error = NULL,
              provisioning_completed_at = COALESCE(provisioning_completed_at, now()),
              projection = COALESCE(
                (SELECT value FROM app_settings WHERE key = 'pipeline.normalized.current'),
                pipeline_spaces.projection
              ),
              updated_at = now()
          WHERE id = $1::uuid
        `,
        [personalPipeline.rows[0].id, DEFAULT_PIPELINE_SHEET_ID],
      )
    }

    return {
      boardId: board.rows[0].id,
      pipelineId: personalPipeline.rows[0].id,
      crmBoardId: crmBoard.rows[0].id,
      pipelineProvisioningRequired: (
        personalPipeline.rows[0].provisioning_status !== 'ready'
        || !personalPipeline.rows[0].sheet_id
        || !personalPipeline.rows[0].short_link_id
        || !personalPipeline.rows[0].sync_enabled
      ),
    }
  })
}

export async function listProjectBoards(actorEmailValue: unknown): Promise<ProjectBoard[]> {
  const actor = await requireActiveAppUser(actorEmailValue)
  await ensureDefaultResourcesForUser(actor.email)
  const result = await query<ProjectBoardRow>(
    `
      SELECT
        board.id::text,
        board.name,
        board.owner_email,
        board.is_default,
        CASE WHEN board.owner_email = $1 THEN 'owner' ELSE membership.access_role END AS access_role,
        CASE WHEN board.owner_email = $1 THEN COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'email', member.user_email,
            'displayName', app_user.display_name,
            'status', app_user.status,
            'accessRole', member.access_role
          ) ORDER BY member.created_at ASC)
          FROM project_board_members member
          JOIN app_users app_user ON app_user.email = member.user_email
          WHERE member.board_id = board.id
        ), '[]'::jsonb) ELSE '[]'::jsonb END AS members,
        board.created_at::text,
        board.updated_at::text
      FROM project_boards board
      LEFT JOIN project_board_members membership
        ON membership.board_id = board.id
       AND membership.user_email = $1
      WHERE board.owner_email = $1 OR membership.user_email = $1
      ORDER BY
        CASE WHEN board.owner_email = $1 AND board.is_default THEN 0 WHEN board.owner_email = $1 THEN 1 ELSE 2 END,
        board.created_at ASC
    `,
    [actor.email],
  )
  return result.rows.map(toProjectBoard)
}

export async function listPipelineSpaces(actorEmailValue: unknown): Promise<PipelineSpace[]> {
  const actor = await requireActiveAppUser(actorEmailValue)
  await ensureDefaultResourcesForUser(actor.email)
  const result = await query<PipelineSpaceRow>(
    `
      SELECT
        pipeline.id::text,
        pipeline.name,
        pipeline.owner_email,
        pipeline.workspace_organization_id::text,
        pipeline.is_default,
        CASE WHEN pipeline.owner_email = $1 THEN 'owner' ELSE membership.access_role END AS access_role,
        CASE WHEN pipeline.owner_email = $1 THEN COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'email', member.user_email,
            'displayName', app_user.display_name,
            'status', app_user.status,
            'accessRole', member.access_role
          ) ORDER BY member.created_at ASC)
          FROM pipeline_space_members member
          JOIN app_users app_user ON app_user.email = member.user_email
          WHERE member.pipeline_id = pipeline.id
        ), '[]'::jsonb) ELSE '[]'::jsonb END AS members,
        pipeline.sheet_id,
        pipeline.sync_enabled,
        pipeline.provisioning_status,
        pipeline.provisioning_error,
        pipeline.provisioning_requested_at::text,
        pipeline.provisioning_started_at::text,
        pipeline.provisioning_last_attempted_at::text,
        pipeline.provisioning_completed_at::text,
        pipeline.short_link_id::text,
        CASE
          WHEN short_link.id IS NOT NULL
            AND short_link.deleted_at IS NULL
            AND short_link.disabled_at IS NULL
            AND (short_link.expires_at IS NULL OR short_link.expires_at > now())
            AND (short_link.max_clicks IS NULL OR short_link.click_count < short_link.max_clicks)
          THEN short_link.slug
          ELSE NULL
        END AS short_link_slug,
        pipeline.projection,
        pipeline.created_at::text,
        pipeline.updated_at::text
      FROM pipeline_spaces pipeline
      LEFT JOIN pipeline_space_members membership
        ON membership.pipeline_id = pipeline.id
       AND membership.user_email = $1
      LEFT JOIN short_links short_link
        ON short_link.id = pipeline.short_link_id
      WHERE pipeline.owner_email = $1 OR membership.user_email = $1
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM crm_board_projections crm_projection
            JOIN project_boards crm_board ON crm_board.id = crm_projection.board_id
            WHERE crm_projection.pipeline_id = pipeline.id
              AND crm_board.owner_email = $1
              AND lower(btrim(crm_board.name)) = 'crm board'
          ) THEN 0
          WHEN pipeline.owner_email = $1 AND pipeline.is_default THEN 1
          WHEN pipeline.owner_email = $1 THEN 2
          ELSE 3
        END,
        pipeline.created_at ASC
    `,
    [actor.email],
  )
  return result.rows.map(toPipelineSpace)
}

export async function readWorkspacePreferences(actorEmailValue: unknown): Promise<WorkspacePreferences> {
  const actor = await requireActiveAppUser(actorEmailValue)
  const result = await query<WorkspacePreferencesRow>(
    `SELECT default_board_id::text, default_pipeline_id::text
     FROM app_user_workspace_preferences
     WHERE user_email = $1`,
    [actor.email],
  )
  return {
    defaultBoardId: result.rows[0]?.default_board_id || null,
    defaultPipelineId: result.rows[0]?.default_pipeline_id || null,
  }
}

export async function saveWorkspacePreferences(input: {
  actorEmail: unknown
  boardId?: unknown
  pipelineId?: unknown
}): Promise<WorkspacePreferences> {
  const actor = await requireActiveAppUser(input.actorEmail)
  const hasBoard = input.boardId !== undefined
  const hasPipeline = input.pipelineId !== undefined
  if (!hasBoard && !hasPipeline) throw new Error('A dashboard board or pipeline is required')

  const board = hasBoard
    ? await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: input.boardId })
    : null
  const pipeline = hasPipeline
    ? await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: input.pipelineId })
    : null

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO app_user_workspace_preferences (
         user_email, default_board_id, default_pipeline_id, created_at, updated_at
       )
       VALUES ($1, $2::uuid, $3::uuid, now(), now())
       ON CONFLICT (user_email) DO UPDATE SET
         default_board_id = COALESCE(EXCLUDED.default_board_id, app_user_workspace_preferences.default_board_id),
         default_pipeline_id = COALESCE(EXCLUDED.default_pipeline_id, app_user_workspace_preferences.default_pipeline_id),
         updated_at = now()`,
      [actor.email, board?.id || null, pipeline?.id || null],
    )
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'user.dashboard.preferences.updated',
      aggregateType: 'app_user',
      aggregateId: actor.email,
      organizationId: actor.organizationId,
      payload: {
        boardId: board?.id,
        pipelineId: pipeline?.id,
        organizationId: actor.organizationId,
      },
    }, client)
  })

  return readWorkspacePreferences(actor.email)
}

export async function resolveProjectBoardAccess(input: {
  actorEmail: unknown
  boardId?: unknown
}): Promise<ProjectBoard> {
  const boards = await listProjectBoards(input.actorEmail)
  const requested = String(input.boardId || '').trim()
  if (requested) {
    const board = boards.find((candidate) => candidate.id === requested)
    if (!board) throw new Error('Project board access denied')
    return board
  }
  const actor = normalizeUserEmail(input.actorEmail)
  const fallback = boards.find((board) => board.ownerEmail === actor && board.isDefault) || boards[0]
  if (!fallback) throw new Error('No project board is available')
  return fallback
}

export async function resolvePipelineSpaceAccess(input: {
  actorEmail: unknown
  pipelineId?: unknown
}): Promise<PipelineSpace> {
  const pipelines = await listPipelineSpaces(input.actorEmail)
  const requested = String(input.pipelineId || '').trim()
  if (requested) {
    const pipeline = pipelines.find((candidate) => candidate.id === requested)
    if (!pipeline) throw new Error('Pipeline access denied')
    return pipeline
  }
  const fallback = pipelines[0]
  if (!fallback) throw new Error('No pipeline is available')
  return fallback
}

export function requireResourceEditor(resource: Pick<ProjectBoard | PipelineSpace, 'accessRole'>): void {
  if (resource.accessRole === 'viewer') throw new Error('This resource is view-only')
}

export function requirePipelineSheetContext(
  space: Pick<PipelineSpace, 'id' | 'sheetId' | 'syncEnabled'>,
): PipelineSheetContext {
  if (!space.syncEnabled || !space.sheetId) {
    throw new Error('This pipeline has no external Sheet sync source')
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(space.sheetId)) {
    throw new Error('This pipeline has an invalid external Sheet source')
  }
  return { pipelineId: space.id, sheetId: space.sheetId }
}

export function isLegacyOwnerSheetPipeline(
  space: Pick<PipelineSpace, 'ownerEmail' | 'isDefault' | 'sheetId'> | null,
): boolean {
  const configuredOwner = String(process.env.APP_LOGIN_EMAIL || '').trim().toLowerCase()
  return Boolean(
    space
    && configuredOwner
    && space.isDefault
    && space.ownerEmail.toLowerCase() === configuredOwner
    && space.sheetId === DEFAULT_PIPELINE_SHEET_ID,
  )
}

export async function createProjectBoard(input: { actorEmail: unknown; name: unknown }): Promise<ProjectBoard> {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (!effectiveUserPermissions(actor).createBoards) throw new Error('You do not have permission to create boards')
  const name = cleanResourceName(input.name, 'New board')
  const boardId = await withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      'INSERT INTO project_boards (name, owner_email) VALUES ($1, $2) RETURNING id::text',
      [name, actor.email],
    )
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'project.board.created',
      aggregateType: 'project_board',
      aggregateId: result.rows[0].id,
      organizationId: actor.organizationId,
      payload: { name, organizationId: actor.organizationId },
    }, client)
    return result.rows[0].id
  })
  return resolveProjectBoardAccess({ actorEmail: actor.email, boardId })
}

export async function createPipelineSpace(input: { actorEmail: unknown; name: unknown }): Promise<PipelineSpace> {
  const actor = await requireActiveAppUser(input.actorEmail)
  if (!effectiveUserPermissions(actor).createPipelines) throw new Error('You do not have permission to create pipelines')
  const name = cleanResourceName(input.name, 'New pipeline')
  const organization = await ensurePrimaryWorkspaceOrganization(actor.email)
  const pipelineId = await withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO pipeline_spaces (name, owner_email, workspace_organization_id)
       VALUES ($1, $2, $3::uuid)
       RETURNING id::text`,
      [name, actor.email, organization.id],
    )
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'pipeline.space.created',
      aggregateType: 'pipeline_space',
      aggregateId: result.rows[0].id,
      organizationId: organization.id,
      payload: { name, pipelineId: result.rows[0].id, organizationId: organization.id },
    }, client)
    return result.rows[0].id
  })
  return resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId })
}

async function validateShareTarget(actorEmail: string, targetEmailValue: unknown) {
  const targetEmail = normalizeUserEmail(targetEmailValue)
  if (targetEmail === actorEmail) throw new Error('The owner already has access')
  const target = await getAppUser(targetEmail)
  if (!target || target.status === 'disabled') throw new Error('Invite or restore this user before sharing')
  return target
}

function normalizeShareRole(value: unknown): 'editor' | 'viewer' {
  return value === 'editor' ? 'editor' : 'viewer'
}

export async function shareProjectBoard(input: {
  actorEmail: unknown
  boardId: unknown
  userEmail: unknown
  accessRole: unknown
}): Promise<ProjectBoard> {
  const actor = await requireActiveAppUser(input.actorEmail)
  const board = await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: input.boardId })
  if (board.ownerEmail !== actor.email) throw new Error('Only the board owner can share it')
  const target = await validateShareTarget(actor.email, input.userEmail)
  const accessRole = normalizeShareRole(input.accessRole)
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO project_board_members (board_id, user_email, access_role, shared_by, updated_at)
       VALUES ($1::uuid, $2, $3, $4, now())
       ON CONFLICT (board_id, user_email) DO UPDATE SET
         access_role = EXCLUDED.access_role,
         shared_by = EXCLUDED.shared_by,
         updated_at = now()`,
      [board.id, target.email, accessRole, actor.email],
    )
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'project.board.shared',
      aggregateType: 'project_board',
      aggregateId: board.id,
      organizationId: actor.organizationId,
      payload: { userEmail: target.email, accessRole, organizationId: actor.organizationId },
    }, client)
  })
  return resolveProjectBoardAccess({ actorEmail: actor.email, boardId: board.id })
}

export async function sharePipelineSpace(input: {
  actorEmail: unknown
  pipelineId: unknown
  userEmail: unknown
  accessRole: unknown
}): Promise<PipelineSpace> {
  const actor = await requireActiveAppUser(input.actorEmail)
  const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: input.pipelineId })
  if (pipeline.ownerEmail !== actor.email) throw new Error('Only the pipeline owner can share it')
  const target = await validateShareTarget(actor.email, input.userEmail)
  const accessRole = normalizeShareRole(input.accessRole)
  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO pipeline_space_members (pipeline_id, user_email, access_role, shared_by, updated_at)
        VALUES ($1::uuid, $2, $3, $4, now())
        ON CONFLICT (pipeline_id, user_email) DO UPDATE SET
          access_role = EXCLUDED.access_role,
          shared_by = EXCLUDED.shared_by,
          updated_at = now()
      `,
      [pipeline.id, target.email, accessRole, actor.email],
    )
    await enqueuePipelinePermissionSyncWithClient(client, { pipelineId: pipeline.id, actor: actor.email })
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'pipeline.space.shared',
      aggregateType: 'pipeline_space',
      aggregateId: pipeline.id,
      organizationId: pipeline.workspaceOrganizationId,
      payload: { pipelineId: pipeline.id, userEmail: target.email, accessRole, organizationId: pipeline.workspaceOrganizationId },
    }, client)
  })
  return resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: pipeline.id })
}

export async function removeProjectBoardShare(input: {
  actorEmail: unknown
  boardId: unknown
  userEmail: unknown
}): Promise<ProjectBoard> {
  const actor = await requireActiveAppUser(input.actorEmail)
  const board = await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: input.boardId })
  if (board.ownerEmail !== actor.email) throw new Error('Only the board owner can change sharing')
  const userEmail = normalizeUserEmail(input.userEmail)
  await withTransaction(async (client) => {
    await client.query('DELETE FROM project_board_members WHERE board_id = $1::uuid AND user_email = $2', [board.id, userEmail])
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'project.board.share.removed',
      aggregateType: 'project_board',
      aggregateId: board.id,
      organizationId: actor.organizationId,
      payload: { userEmail, organizationId: actor.organizationId },
    }, client)
  })
  return resolveProjectBoardAccess({ actorEmail: actor.email, boardId: board.id })
}

export async function removePipelineShare(input: {
  actorEmail: unknown
  pipelineId: unknown
  userEmail: unknown
}): Promise<PipelineSpace> {
  const actor = await requireActiveAppUser(input.actorEmail)
  const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: input.pipelineId })
  if (pipeline.ownerEmail !== actor.email) throw new Error('Only the pipeline owner can change sharing')
  const userEmail = normalizeUserEmail(input.userEmail)
  await withTransaction(async (client) => {
    await client.query(
      'DELETE FROM pipeline_space_members WHERE pipeline_id = $1::uuid AND user_email = $2',
      [pipeline.id, userEmail],
    )
    await enqueuePipelinePermissionSyncWithClient(client, { pipelineId: pipeline.id, actor: actor.email })
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'pipeline.space.share.removed',
      aggregateType: 'pipeline_space',
      aggregateId: pipeline.id,
      organizationId: pipeline.workspaceOrganizationId,
      payload: { pipelineId: pipeline.id, userEmail, organizationId: pipeline.workspaceOrganizationId },
    }, client)
  })
  return resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: pipeline.id })
}

export async function readPipelineProjectionForSpace(space: PipelineSpace): Promise<PipelineProjection> {
  if (space.syncEnabled) {
    const context = requirePipelineSheetContext(space)
    return (await readPipelineProjectionFromPostgres(context)) || space.projection || { ...EMPTY_PIPELINE }
  }
  return space.projection || { ...EMPTY_PIPELINE }
}

export async function writeAppPipelineProjection(space: PipelineSpace, projection: PipelineProjection): Promise<void> {
  if (space.syncEnabled) throw new Error('Sheet-backed pipelines must use the sync outbox')
  await query(
    'UPDATE pipeline_spaces SET projection = $2::jsonb, updated_at = now() WHERE id = $1::uuid',
    [space.id, JSON.stringify(projection)],
  )
}
