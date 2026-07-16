import crypto from 'crypto'
import type { PoolClient } from 'pg'
import type { Task } from '@/lib/types'
import { isCrmBoardCard, normalizeCrmBoardCard } from '@/lib/crm/boardCard.mjs'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { insertAgentDispatchOutbox, type AgentDispatchEnqueueInput } from '@/lib/persistence/agentDispatch'
import { recordAuditEvent } from '@/lib/auditWriter'

type TaskRow = {
  payload: Task
  board_id: string
}

type TaskStoreScope = {
  boardId: string
  includeCrmCards?: boolean
  agentDispatches?: AgentDispatchEnqueueInput[]
}

function safeIso(value: unknown, fallback: string): string {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback
}

function safeDueDate(value: unknown): string | null {
  const raw = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  return raw
}

function payloadHash(task: Task): string {
  return crypto.createHash('sha256').update(JSON.stringify(task)).digest('hex')
}

export function isPostgresTaskStoreEnabled(): boolean {
  return isPostgresStorageEnabled()
}

export async function readTasksFromPostgres(scope: TaskStoreScope): Promise<Task[]> {
  const result = await query<TaskRow>(
    'SELECT payload, board_id::text FROM tasks WHERE board_id = $1::uuid ORDER BY updated_at DESC, created_at DESC, id ASC',
    [scope.boardId],
  )
  const tasks = result.rows.map((row) => ({ ...row.payload, boardId: row.board_id }))
  if (!scope.includeCrmCards) return tasks
  const cards = await query<TaskRow>(
    `SELECT payload, board_id::text
     FROM crm_board_cards
     WHERE board_id = $1::uuid
     ORDER BY updated_at DESC, created_at DESC, card_id ASC`,
    [scope.boardId],
  )
  return [
    ...tasks,
    ...cards.rows.map((row) => normalizeCrmBoardCard({ ...row.payload, boardId: row.board_id }) as Task),
  ]
}

export async function upsertTaskWithClient(
  client: PoolClient,
  task: Task,
  boardId: string,
  source = 'app',
): Promise<void> {
  const now = new Date().toISOString()
  const createdAt = safeIso(task.createdAt, now)
  const updatedAt = safeIso(task.updatedAt, createdAt)
  const archivedAt = task.archivedAt ? safeIso(task.archivedAt, updatedAt) : null
  const deletedAt = task.deletedAt ? safeIso(task.deletedAt, updatedAt) : null
  const canonicalTask = { ...task, boardId }
  const upsert = await client.query(
    `INSERT INTO tasks (
       id, board_id, title, status, priority, category, assigned_agent, due_date,
       created_at, updated_at, archived, archived_at, deleted_at, payload, payload_hash, source
     )
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz,
       $11, $12::timestamptz, $13::timestamptz, $14::jsonb, $15, $16)
     ON CONFLICT (id) DO UPDATE SET
       board_id = EXCLUDED.board_id,
       title = EXCLUDED.title,
       status = EXCLUDED.status,
       priority = EXCLUDED.priority,
       category = EXCLUDED.category,
       assigned_agent = EXCLUDED.assigned_agent,
       due_date = EXCLUDED.due_date,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at,
       archived = EXCLUDED.archived,
       archived_at = EXCLUDED.archived_at,
       deleted_at = EXCLUDED.deleted_at,
       payload = EXCLUDED.payload,
       payload_hash = EXCLUDED.payload_hash,
       source = CASE
         WHEN tasks.source = 'crm-projection' THEN tasks.source
         ELSE EXCLUDED.source
       END
     WHERE tasks.board_id = EXCLUDED.board_id`,
    [
      String(task.id),
      boardId,
      String(task.title || 'Untitled task'),
      task.status,
      task.priority,
      String(task.category || 'clawpilot'),
      task.assignedAgent || null,
      safeDueDate(task.dueDate),
      createdAt,
      updatedAt,
      Boolean(task.archived),
      archivedAt,
      deletedAt,
      JSON.stringify(canonicalTask),
      payloadHash(canonicalTask),
      source,
    ],
  )
  if (upsert.rowCount !== 1) throw new Error(`Task id collision across project boards: ${task.id}`)
}

export async function replaceTasksInPostgres(tasks: Task[], scope: TaskStoreScope): Promise<void> {
  await withTransaction(async (client) => {
    const appTasks = tasks.filter((task) => !isCrmBoardCard(task))
    const crmCards = tasks.filter((task) => isCrmBoardCard(task))
    const ids = appTasks.map((task) => String(task.id))
    const previous = await client.query<{ id: string; payload: Task }>(
      `SELECT id, payload FROM tasks WHERE board_id = $1::uuid AND source <> 'crm-projection' FOR UPDATE`,
      [scope.boardId],
    )
    const previousById = new Map(previous.rows.map((row) => [row.id, row.payload]))
    const boardOrganization = await client.query<{ organization_id: string | null }>(
      `SELECT app_user.organization_id::text
       FROM project_boards board
       JOIN app_users app_user ON app_user.email = board.owner_email
       WHERE board.id = $1::uuid`,
      [scope.boardId],
    )
    const organizationId = boardOrganization.rows[0]?.organization_id || null

    for (const task of appTasks) {
      await upsertTaskWithClient(client, task, scope.boardId)
      const activity = Array.isArray(task.activity) ? task.activity : []
      for (let index = 0; index < activity.length; index += 1) {
        const event = activity[index]
        const timestamp = safeIso(event.timestamp, safeIso(task.updatedAt, new Date().toISOString()))
        await recordAuditEvent({
          actor: String(event.actor || 'system'),
          eventType: `project.task.${String(event.type || 'updated').replaceAll(' ', '_')}`,
          aggregateType: 'project_task',
          aggregateId: String(task.id),
          organizationId,
          eventKey: `project-task:${scope.boardId}:${task.id}:${index}`,
          payload: {
            boardId: scope.boardId,
            taskId: String(task.id),
            taskTitle: String(task.title || 'Untitled task'),
            activityOrdinal: index + 1,
            occurredAt: timestamp,
            message: event.message,
            from: event.from,
            to: event.to,
            commentId: event.commentId,
          },
        }, client)
      }
    }

    for (const [taskId, previousTask] of previousById) {
      if (ids.includes(taskId)) continue
      const lastActor = [...(previousTask.activity || [])].reverse().find((event) => event.actor)?.actor || 'system'
      await recordAuditEvent({
        actor: String(lastActor),
        eventType: 'project.task.deleted',
        aggregateType: 'project_task',
        aggregateId: taskId,
        organizationId,
        eventKey: `project-task:${scope.boardId}:${taskId}:deleted`,
        payload: {
          boardId: scope.boardId,
          taskId,
          taskTitle: previousTask.title,
          message: 'Card permanently deleted',
        },
      }, client)
    }

    for (const task of crmCards) {
      const result = await client.query(
        `UPDATE crm_board_cards
         SET payload = $3::jsonb, updated_at = now()
         WHERE board_id = $1::uuid AND card_id = $2`,
        [scope.boardId, String(task.id), JSON.stringify(normalizeCrmBoardCard(task))],
      )
      if (result.rowCount !== 1) throw new Error(`CRM board card was not found: ${task.id}`)
    }

    if (ids.length > 0) {
      await client.query(
        "DELETE FROM tasks WHERE board_id = $1::uuid AND source <> 'crm-projection' AND NOT (id = ANY($2::text[]))",
        [scope.boardId, ids],
      )
    } else {
      await client.query("DELETE FROM tasks WHERE board_id = $1::uuid AND source <> 'crm-projection'", [scope.boardId])
    }

    await client.query(
      `DELETE FROM agent_assignments assignment
       USING tasks task
       WHERE assignment.task_id = task.id
         AND task.board_id = $1::uuid
         AND (task.source <> 'crm-projection' OR task.id = ANY($2::text[]))`,
      [scope.boardId, ids],
    )
    const assignments = appTasks
      .filter((task) => task.assignedAgent && !task.archived && !task.deletedAt)
      .map((task) => ({
        taskId: String(task.id),
        agentId: String(task.assignedAgent),
        updatedAt: safeIso(task.updatedAt, new Date().toISOString()),
      }))

    for (const assignment of assignments) {
      await client.query(
        `
          INSERT INTO agent_assignments (task_id, agent_id, updated_at)
          VALUES ($1, $2, $3::timestamptz)
          ON CONFLICT (task_id) DO UPDATE SET
            agent_id = EXCLUDED.agent_id,
            updated_at = EXCLUDED.updated_at
        `,
        [assignment.taskId, assignment.agentId, assignment.updatedAt],
      )
    }

    for (const dispatch of scope.agentDispatches || []) {
      await insertAgentDispatchOutbox(client, dispatch)
    }
  })
}
