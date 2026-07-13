#!/usr/bin/env node
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

function fail(message) {
  console.error(`db:import:tasks failed: ${message}`)
  process.exit(1)
}

function defaultTasksPath() {
  const devPath = resolve(root, 'data-dev', 'tasks.json')
  if (existsSync(devPath)) return devPath
  return resolve(root, 'data', 'tasks.json')
}

function safeIso(value, fallback) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback
}

function safeDueDate(value) {
  const raw = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

function safeStatus(value) {
  const raw = String(value || '').toLowerCase().trim()
  return ['backlog', 'todo', 'in-progress', 'review', 'done'].includes(raw) ? raw : 'backlog'
}

function safePriority(value) {
  const raw = String(value || '').toLowerCase().trim()
  return ['high', 'medium', 'low'].includes(raw) ? raw : 'medium'
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

if (!process.env.DATABASE_URL) {
  fail('DATABASE_URL is required')
}
const targetBoardId = String(process.env.TARGET_BOARD_ID || '').trim()
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetBoardId)) {
  fail('TARGET_BOARD_ID must identify the board receiving this import')
}

const sourcePath = process.env.TASKS_PATH || defaultTasksPath()
if (!existsSync(sourcePath)) {
  fail(`tasks file not found: ${sourcePath}`)
}

const tasks = JSON.parse(readFileSync(sourcePath, 'utf-8'))
if (!Array.isArray(tasks)) {
  fail(`tasks file must contain an array: ${sourcePath}`)
}

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
})

async function main() {
  const client = await pool.connect()
  const ids = tasks.map((task) => String(task.id || '')).filter(Boolean)

  try {
    await client.query('BEGIN')

    for (const task of tasks) {
      const now = new Date().toISOString()
      const id = String(task.id || '')
      if (!id) continue

      const createdAt = safeIso(task.createdAt, now)
      const updatedAt = safeIso(task.updatedAt, createdAt)
      const archivedAt = task.archivedAt ? safeIso(task.archivedAt, updatedAt) : null
      const deletedAt = task.deletedAt ? safeIso(task.deletedAt, updatedAt) : null

      const upsert = await client.query(
        `
          INSERT INTO tasks (
            id,
            board_id,
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
          VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, $12::timestamptz, $13::timestamptz, $14::jsonb, $15, 'json-import')
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
            source = EXCLUDED.source
          WHERE tasks.board_id = EXCLUDED.board_id
        `,
        [
          id,
          targetBoardId,
          String(task.title || 'Untitled task'),
          safeStatus(task.status),
          safePriority(task.priority),
          String(task.category || 'clawpilot'),
          task.assignedAgent ? String(task.assignedAgent) : null,
          safeDueDate(task.dueDate),
          createdAt,
          updatedAt,
          Boolean(task.archived),
          archivedAt,
          deletedAt,
          JSON.stringify({ ...task, boardId: targetBoardId }),
          hashPayload({ ...task, boardId: targetBoardId }),
        ],
      )
      if (upsert.rowCount !== 1) throw new Error(`task id collision outside target board: ${id}`)
    }

    await client.query(
      'DELETE FROM agent_assignments assignment USING tasks task WHERE assignment.task_id = task.id AND task.board_id = $1::uuid',
      [targetBoardId],
    )
    for (const task of tasks) {
      if (!task.id || !task.assignedAgent || task.archived || task.deletedAt) continue
      await client.query(
        `
          INSERT INTO agent_assignments (task_id, agent_id, updated_at)
          VALUES ($1, $2, $3::timestamptz)
          ON CONFLICT (task_id) DO UPDATE SET
            agent_id = EXCLUDED.agent_id,
            updated_at = EXCLUDED.updated_at
        `,
        [
          String(task.id),
          String(task.assignedAgent),
          safeIso(task.updatedAt, new Date().toISOString()),
        ],
      )
    }

    if (ids.length > 0) {
      await client.query('DELETE FROM tasks WHERE board_id = $1::uuid AND NOT (id = ANY($2::text[]))', [targetBoardId, ids])
    }

    await client.query('COMMIT')
    console.log(JSON.stringify({
      ok: true,
      sourcePath,
      taskCount: tasks.length,
      targetBoardId,
      dataDir: dirname(sourcePath),
      assignmentsProjected: tasks.filter((task) => task.id && task.assignedAgent && !task.archived && !task.deletedAt).length,
    }, null, 2))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
