import crypto from 'crypto'
import type { Task } from '@/lib/types'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query, withTransaction } from '@/lib/persistence/postgres'

type TaskRow = {
  payload: Task
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

export async function readTasksFromPostgres(): Promise<Task[]> {
  const result = await query<TaskRow>(
    'SELECT payload FROM tasks ORDER BY updated_at DESC, created_at DESC, id ASC',
  )
  return result.rows.map((row) => row.payload)
}

export async function replaceTasksInPostgres(tasks: Task[]): Promise<void> {
  await withTransaction(async (client) => {
    const ids = tasks.map((task) => String(task.id))

    for (const task of tasks) {
      const now = new Date().toISOString()
      const createdAt = safeIso(task.createdAt, now)
      const updatedAt = safeIso(task.updatedAt, createdAt)
      const archivedAt = task.archivedAt ? safeIso(task.archivedAt, updatedAt) : null
      const deletedAt = task.deletedAt ? safeIso(task.deletedAt, updatedAt) : null

      await client.query(
        `
          INSERT INTO tasks (
            id,
            title,
            status,
            priority,
            category,
            assigned_agent,
            due_date,
            created_at,
            updated_at,
            archived,
            archived_at,
            deleted_at,
            payload,
            payload_hash,
            source
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11::timestamptz, $12::timestamptz, $13::jsonb, $14, 'app')
          ON CONFLICT (id) DO UPDATE SET
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
            source = EXCLUDED.source
        `,
        [
          String(task.id),
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
          JSON.stringify(task),
          payloadHash(task),
        ],
      )
    }

    if (ids.length > 0) {
      await client.query('DELETE FROM tasks WHERE NOT (id = ANY($1::text[]))', [ids])
    } else {
      await client.query('DELETE FROM tasks')
    }

    await client.query('DELETE FROM agent_assignments')
    const assignments = tasks
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
  })
}

