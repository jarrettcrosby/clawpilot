import fs from 'fs'
import path from 'path'
import { query } from '@/lib/persistence/postgres'
import type { AppUser } from '@/lib/users'

const PIPELINE_LOG_FILE = process.env.PIPELINE_LOG_PATH
  || path.join(process.cwd(), '..', 'data', 'logs', 'pipeline-events.jsonl')

const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token|api[-_]?key|code_digest|magic.?code)/i
const SAFE_DETAIL_KEYS = new Set([
  'eventType', 'aggregateType', 'aggregateId', 'method', 'outcome', 'reason', 'client',
  'networkFingerprint', 'requestId', 'organizationId', 'organizationName', 'pipelineId',
  'boardId', 'taskId', 'taskTitle', 'message', 'from', 'to', 'commentId', 'status',
  'previousStatus', 'previousRole', 'role', 'permissions', 'fields', 'userEmail', 'accessRole',
  'provider', 'app', 'actionType', 'referenceCode', 'attempts', 'availableAt', 'outboxId',
  'syncStatus', 'opportunityId', 'opportunityName', 'organization', 'fromStage', 'toStage',
  'reinvited', 'previousOrganizationId', 'dispatchId', 'agentId', 'trigger', 'sourceKey',
  'recordTitle',
  'eligible', 'queued', 'deletedReferenceCodes', 'matchedReferenceCodes', 'suiteCrmDeletesQueued',
])

export type ActivityScope = 'self' | 'organization' | 'global'

export type ActivityLogEvent = {
  id: string
  module: 'auth' | 'projects' | 'pipeline' | 'crm' | 'agents' | 'docs' | 'users' | 'integrations' | 'versions' | 'system'
  type: string
  eventType: string
  message: string
  timestamp: string
  actor: string
  actorName: string | null
  target: {
    section: 'projects' | 'pipeline' | 'crm' | 'agents' | 'docs' | 'versions'
    id?: string
    resourceId?: string
    label?: string
  } | null
  details: Record<string, unknown>
}

export type ActivityCapabilities = {
  canViewOrganization: boolean
  canViewGlobal: boolean
  defaultScope: ActivityScope
}

type AuditRow = {
  id: string
  actor: string | null
  actor_name: string | null
  event_type: string
  aggregate_type: string | null
  aggregate_id: string | null
  payload: Record<string, unknown> | null
  created_at: string
}

type TaskActivityRow = {
  task_id: string
  task_title: string
  board_id: string
  event: Record<string, unknown>
  ordinal: number
  occurred_at: string
}

type ScopeContext = {
  selfEmail: string
  organizationIds: string[]
  actorKeys: string[]
  actorNames: Map<string, string | null>
  boardIds: string[]
  pipelineIds: string[]
}

export function activityCapabilities(actor: AppUser): ActivityCapabilities {
  const canViewOrganization = actor.role === 'owner'
    || (actor.role === 'admin' && actor.permissions.viewOrganizationAudit)
  const canViewGlobal = actor.role === 'owner'
    || (actor.role === 'admin' && actor.permissions.viewSystemAudit)
  return {
    canViewOrganization,
    canViewGlobal,
    defaultScope: canViewOrganization ? 'organization' : 'self',
  }
}

export function authorizeActivityScope(actor: AppUser, requested: unknown): ActivityScope {
  const capabilities = activityCapabilities(actor)
  const scope = String(requested || capabilities.defaultScope) as ActivityScope
  if (scope === 'self') return scope
  if (scope === 'organization' && capabilities.canViewOrganization) return scope
  if (scope === 'global' && capabilities.canViewGlobal) return scope
  throw new Error('Activity scope access denied')
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => sanitizeValue(item, depth + 1))
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 1000) return `${value.slice(0, 997)}...`
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (depth === 0 && !SAFE_DETAIL_KEYS.has(key)) continue
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeValue(item, depth + 1)
  }
  return out
}

export function sanitizeAuditDetails(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(value)
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {}
}

function eventModule(eventType: string): ActivityLogEvent['module'] {
  const prefix = eventType.split('.')[0]
  if (prefix === 'auth') return 'auth'
  if (prefix === 'project' || prefix === 'task') return 'projects'
  if (prefix === 'pipeline') return 'pipeline'
  if (prefix === 'crm') return 'crm'
  if (prefix === 'agent') return 'agents'
  if (prefix === 'document' || prefix === 'documents') return 'docs'
  if (prefix === 'user' || prefix === 'organization' || prefix === 'invitation') return 'users'
  if (prefix === 'google_workspace' || prefix === 'maton') return 'integrations'
  if (prefix === 'release' || prefix === 'checkpoint') return 'versions'
  return 'system'
}

function eventTypeGroup(eventType: string): string {
  const parts = eventType.split('.')
  const terminal = parts[parts.length - 1] || 'updated'
  if (['failed', 'dead', 'denied', 'locked'].includes(terminal)) return 'failed'
  if (['succeeded', 'verified', 'ready', 'completed'].includes(terminal)) return 'succeeded'
  if (['queued', 'requested', 'leased'].includes(terminal)) return 'queued'
  if (['created', 'staged', 'invited'].includes(terminal)) return 'created'
  if (['deleted', 'disabled', 'revoked', 'removed'].includes(terminal)) return 'deleted'
  return terminal.replaceAll('_', ' ')
}

function titleCase(value: string): string {
  return value
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function auditMessage(row: AuditRow): string {
  const payload = row.payload || {}
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim()
  const method = typeof payload.method === 'string' ? titleCase(payload.method) : 'Account'
  if (row.event_type === 'auth.login.succeeded') return `${method} sign-in completed`
  if (row.event_type === 'auth.login.failed') return `${method} sign-in failed`
  if (row.event_type === 'auth.logout.succeeded') return 'Signed out'
  if (row.event_type === 'auth.code.requested') return 'Sign-in code requested'
  if (row.event_type === 'auth.code.request.denied') return 'Sign-in code request denied'
  if (row.event_type === 'crm.record.staged') return 'CRM record queued for synchronization'
  if (row.event_type === 'organization.parent.updated') return 'Organization hierarchy updated'
  if (row.event_type === 'user.profile.updated') return 'User profile updated'
  if (row.event_type === 'user.access.updated') return 'User access updated'
  if (row.event_type === 'user.status.updated') return 'User status updated'
  if (row.event_type === 'user.invited') return 'User invited'
  return titleCase(row.event_type)
}

async function loadScopeContext(actor: AppUser, scope: ActivityScope): Promise<ScopeContext> {
  if (scope === 'global') {
    return {
      selfEmail: actor.email.toLowerCase(),
      organizationIds: [],
      actorKeys: [actor.email.toLowerCase()],
      actorNames: new Map([[actor.email.toLowerCase(), actor.displayName]]),
      boardIds: [],
      pipelineIds: [],
    }
  }

  const users = scope === 'organization' && actor.organizationId
      ? await query<{ email: string; display_name: string | null; organization_id: string | null }>(
        `WITH RECURSIVE managed AS (
           SELECT id FROM workspace_organizations WHERE id = $1::uuid
           UNION ALL
           SELECT child.id FROM workspace_organizations child JOIN managed parent ON child.parent_id = parent.id
         )
         SELECT app_user.email, app_user.display_name, app_user.organization_id::text
         FROM app_users app_user JOIN managed ON managed.id = app_user.organization_id`,
        [actor.organizationId],
      )
      : { rows: [{ email: actor.email, display_name: actor.displayName, organization_id: actor.organizationId }] }

  const actorNames = new Map<string, string | null>()
  const actorKeys = new Set<string>()
  const organizationIds = new Set<string>()
  for (const user of users.rows) {
    actorNames.set(user.email.toLowerCase(), user.display_name)
    actorKeys.add(user.email.toLowerCase())
    if (user.display_name) actorKeys.add(user.display_name.toLowerCase())
    if (user.organization_id) organizationIds.add(user.organization_id)
  }
  if (actor.role === 'owner') actorKeys.add('jarrett')

  const resourceParams = scope === 'organization'
    ? [[...organizationIds]]
    : [actor.email]
  const boardResult = scope === 'organization'
      ? await query<{ id: string }>(
        `SELECT DISTINCT board.id::text
         FROM project_boards board
         LEFT JOIN app_users owner_user ON owner_user.email = board.owner_email
         LEFT JOIN project_board_members member ON member.board_id = board.id
         LEFT JOIN app_users member_user ON member_user.email = member.user_email
         WHERE owner_user.organization_id = ANY($1::uuid[])
            OR member_user.organization_id = ANY($1::uuid[])`,
        resourceParams,
      )
      : await query<{ id: string }>(
        `SELECT board.id::text FROM project_boards board
         WHERE board.owner_email = $1
            OR EXISTS (SELECT 1 FROM project_board_members member WHERE member.board_id = board.id AND member.user_email = $1)`,
        resourceParams,
      )
  const pipelineResult = scope === 'organization'
      ? await query<{ id: string }>(
        `SELECT DISTINCT pipeline.id::text
         FROM pipeline_spaces pipeline
         LEFT JOIN app_users owner_user ON owner_user.email = pipeline.owner_email
         LEFT JOIN pipeline_space_members member ON member.pipeline_id = pipeline.id
         LEFT JOIN app_users member_user ON member_user.email = member.user_email
         WHERE pipeline.workspace_organization_id = ANY($1::uuid[])
            OR owner_user.organization_id = ANY($1::uuid[])
            OR member_user.organization_id = ANY($1::uuid[])`,
        resourceParams,
      )
      : await query<{ id: string }>(
        `SELECT pipeline.id::text FROM pipeline_spaces pipeline
         WHERE pipeline.owner_email = $1
            OR EXISTS (SELECT 1 FROM pipeline_space_members member WHERE member.pipeline_id = pipeline.id AND member.user_email = $1)`,
        resourceParams,
      )

  return {
    selfEmail: actor.email.toLowerCase(),
    organizationIds: [...organizationIds],
    actorKeys: [...actorKeys],
    actorNames,
    boardIds: boardResult.rows.map((row) => row.id),
    pipelineIds: pipelineResult.rows.map((row) => row.id),
  }
}

async function readAuditRows(scope: ActivityScope, context: ScopeContext, snapshotAt: string, fetchLimit: number): Promise<ActivityLogEvent[]> {
  const conditions = scope === 'global'
    ? 'event.is_system = true AND event.created_at <= $1::timestamptz'
    : scope === 'organization'
      ? `event.organization_id = ANY($1::uuid[]) AND event.created_at <= $2::timestamptz`
      : `(lower(COALESCE(event.actor, '')) = $1 OR lower(COALESCE(event.subject, '')) = $1)
         AND event.created_at <= $2::timestamptz`
  const values = scope === 'global'
    ? [snapshotAt, fetchLimit]
    : scope === 'organization'
      ? [context.organizationIds, snapshotAt, fetchLimit]
      : [context.selfEmail, snapshotAt, fetchLimit]
  const limitParameter = scope === 'global' ? '$2' : '$3'
  const result = await query<AuditRow>(
    `SELECT event.id::text, event.actor, actor_user.display_name AS actor_name,
       event.event_type, event.aggregate_type, event.aggregate_id, event.payload,
       CASE
         WHEN COALESCE(event.payload->>'occurredAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
           THEN (event.payload->>'occurredAt')::timestamptz
         ELSE event.created_at
       END::text AS created_at
     FROM audit_events event
     LEFT JOIN app_users actor_user ON lower(actor_user.email) = lower(event.actor)
     WHERE ${conditions}
     ORDER BY CASE
       WHEN COALESCE(event.payload->>'occurredAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
         THEN (event.payload->>'occurredAt')::timestamptz
       ELSE event.created_at
     END DESC, event.id DESC
     LIMIT ${limitParameter}`,
    values,
  )
  return result.rows.map((row) => {
    const activityModule = eventModule(row.event_type)
    const details = sanitizeAuditDetails({
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      ...(row.payload || {}),
    })
    const resourceId = typeof row.payload?.pipelineId === 'string' ? row.payload.pipelineId : undefined
    return {
      id: `audit:${row.id}`,
      module: activityModule,
      type: eventTypeGroup(row.event_type),
      eventType: row.event_type,
      message: auditMessage(row),
      timestamp: new Date(row.created_at).toISOString(),
      actor: row.actor || 'system',
      actorName: row.actor_name,
      target: activityModule === 'projects' && !row.event_type.endsWith('.deleted') && typeof row.payload?.boardId === 'string'
        ? { section: 'projects', id: row.aggregate_id || undefined, resourceId: row.payload.boardId, label: String(row.payload?.taskTitle || 'Project card') }
        : activityModule === 'pipeline' && resourceId
          ? { section: 'pipeline', resourceId, label: String(row.aggregate_id || 'Pipeline') }
          : activityModule === 'crm'
          ? {
            section: 'crm',
            id: typeof row.payload?.referenceCode === 'string' ? row.payload.referenceCode : undefined,
            label: String(row.payload?.recordTitle || row.payload?.referenceCode || row.aggregate_id || 'CRM record'),
          }
          : activityModule === 'agents'
            ? { section: 'agents', id: row.aggregate_id || undefined, label: 'Agent activity' }
            : activityModule === 'docs'
              ? { section: 'docs', id: row.aggregate_id || undefined, label: 'Document activity' }
              : activityModule === 'versions'
                ? { section: 'versions', id: row.aggregate_id || undefined, label: 'Release activity' }
                : null,
      details,
    }
  })
}

async function readTaskRows(scope: ActivityScope, context: ScopeContext, snapshotAt: string, fetchLimit: number): Promise<ActivityLogEvent[]> {
  if (context.boardIds.length === 0) return []
  const actorCondition = scope === 'self' ? `AND lower(COALESCE(activity.event->>'actor', '')) = ANY($2::text[])` : ''
  const values = scope === 'self'
    ? [context.boardIds, context.actorKeys, snapshotAt, fetchLimit]
    : [context.boardIds, snapshotAt, fetchLimit]
  const snapshotParameter = scope === 'self' ? '$3' : '$2'
  const limitParameter = scope === 'self' ? '$4' : '$3'
  const result = await query<TaskActivityRow>(
    `SELECT task.id AS task_id, task.title AS task_title, task.board_id::text,
       activity.event, activity.ordinal::integer,
       CASE
         WHEN COALESCE(activity.event->>'timestamp', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
           THEN (activity.event->>'timestamp')::timestamptz
         ELSE task.updated_at
       END::text AS occurred_at
     FROM tasks task
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(task.payload->'activity', '[]'::jsonb))
       WITH ORDINALITY AS activity(event, ordinal)
     WHERE task.board_id = ANY($1::uuid[])
       ${actorCondition}
       AND CASE
         WHEN COALESCE(activity.event->>'timestamp', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
           THEN (activity.event->>'timestamp')::timestamptz
         ELSE task.updated_at
       END <= ${snapshotParameter}::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM audit_events durable
         WHERE durable.aggregate_type = 'project_task'
           AND durable.aggregate_id = task.id
           AND durable.payload->>'boardId' = task.board_id::text
           AND durable.payload->>'activityOrdinal' = activity.ordinal::text
       )
     ORDER BY occurred_at DESC, task.id DESC, activity.ordinal DESC
     LIMIT ${limitParameter}`,
    values,
  )
  return result.rows.map((row) => {
    const event = row.event || {}
    const eventType = `project.task.${String(event.type || 'updated').replaceAll(' ', '_')}`
    const actor = String(event.actor || 'system')
    return {
      id: `task:${row.task_id}:${row.ordinal}:${String(event.timestamp || row.occurred_at)}`,
      module: 'projects',
      type: String(event.type || 'updated'),
      eventType,
      message: String(event.message || titleCase(eventType)),
      timestamp: new Date(row.occurred_at).toISOString(),
      actor,
      actorName: context.actorNames.get(actor.toLowerCase()) || null,
      target: { section: 'projects', id: row.task_id, resourceId: row.board_id, label: row.task_title },
      details: sanitizeAuditDetails({
        eventType,
        boardId: row.board_id,
        taskId: row.task_id,
        taskTitle: row.task_title,
        from: event.from,
        to: event.to,
        commentId: event.commentId,
      }),
    }
  })
}

function readPipelineEvents(scope: ActivityScope, context: ScopeContext, snapshotAt: string, fetchLimit: number): ActivityLogEvent[] {
  if (!fs.existsSync(PIPELINE_LOG_FILE)) return []
  const pipelineIds = new Set(context.pipelineIds)
  const actorKeys = new Set(context.actorKeys)
  const lines = fs.readFileSync(PIPELINE_LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
  const events: ActivityLogEvent[] = []
  for (let index = lines.length - 1; index >= 0 && events.length < fetchLimit; index -= 1) {
    try {
      const row = JSON.parse(lines[index]) as Record<string, unknown>
      const activityType = String(row.activityType || '')
      if (!['updated', 'moved', 'comment'].includes(activityType)) continue
      const pipelineId = String(row.pipelineId || '')
      const actor = String(row.changedBy || row.actor || 'system')
      if (scope === 'self' && !actorKeys.has(actor.toLowerCase())) continue
      if (scope === 'organization' && !pipelineIds.has(pipelineId) && !actorKeys.has(actor.toLowerCase())) continue
      const timestamp = String(row.ts || row.timestamp || '')
      if (!Number.isFinite(Date.parse(timestamp))) continue
      if (Date.parse(timestamp) > Date.parse(snapshotAt)) continue
      const recordId = String(row.recordId || 'pipeline')
      events.push({
        id: `pipeline:${recordId}:${timestamp}:${activityType}:${index}`,
        module: 'pipeline',
        type: activityType,
        eventType: `pipeline.opportunity.${activityType}`,
        message: String(row.message || `Pipeline ${activityType}`),
        timestamp: new Date(timestamp).toISOString(),
        actor,
        actorName: context.actorNames.get(actor.toLowerCase()) || null,
        target: { section: 'pipeline', id: recordId, resourceId: pipelineId || undefined, label: String(row.opportunityName || row.organization || 'Pipeline opportunity') },
        details: sanitizeAuditDetails({
          eventType: `pipeline.opportunity.${activityType}`,
          pipelineId: pipelineId || undefined,
          opportunityId: recordId,
          opportunityName: row.opportunityName,
          organization: row.organization,
          fromStage: row.fromStage,
          toStage: row.toStage,
          detail: row.detail,
        }),
      })
    } catch {
      // A malformed operational log line must not prevent the audit drawer from loading.
    }
  }
  return events
}

export async function readActivityLog(input: {
  actor: AppUser
  scope: ActivityScope
  snapshotAt: string
  limit: number
  offset: number
}): Promise<{ events: ActivityLogEvent[]; nextOffset: number | null; capabilities: ActivityCapabilities; scope: ActivityScope }> {
  const fetchLimit = Math.min(5250, input.offset + input.limit + 1)
  const context = await loadScopeContext(input.actor, input.scope)
  const [auditEvents, taskEvents] = await Promise.all([
    readAuditRows(input.scope, context, input.snapshotAt, fetchLimit),
    input.scope === 'global' ? Promise.resolve([]) : readTaskRows(input.scope, context, input.snapshotAt, fetchLimit),
  ])
  const pipelineEvents = input.scope === 'global' ? [] : readPipelineEvents(input.scope, context, input.snapshotAt, fetchLimit)
  const combined = [...auditEvents, ...taskEvents, ...pipelineEvents]
    .sort((left, right) => {
      const timeDifference = Date.parse(right.timestamp) - Date.parse(left.timestamp)
      return timeDifference || right.id.localeCompare(left.id)
    })
  const page = combined.slice(input.offset, input.offset + input.limit)
  return {
    events: page,
    nextOffset: combined.length > input.offset + input.limit ? input.offset + input.limit : null,
    capabilities: activityCapabilities(input.actor),
    scope: input.scope,
  }
}
