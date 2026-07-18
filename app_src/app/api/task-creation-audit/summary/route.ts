import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres } from '@/lib/persistence/tasks'
import { requireRequestUser } from '@/lib/requestUser'
import { BOARD_SELECTION_COOKIE, resolveProjectBoardAccess } from '@/lib/tenancy'

type AuditEntry = {
  type?: string
  timestamp?: string
  source?: string
  actor?: string
  taskId?: string
  title?: string
  anomaly?: boolean
  recentCreatesInLastMinute?: number
}

const DEV_AUDIT_FILE = path.join(process.cwd(), '..', 'data-dev', 'task-creation-audit.jsonl')
const PROD_AUDIT_FILE = path.join(process.cwd(), '..', 'data', 'task-creation-audit.jsonl')
const AUDIT_FILE = (process.env.NODE_ENV === 'development' && fs.existsSync(path.join(process.cwd(), '..', 'data-dev')))
  ? DEV_AUDIT_FILE
  : PROD_AUDIT_FILE

function readEntries(): AuditEntry[] {
  if (!fs.existsSync(AUDIT_FILE)) return []
  const raw = fs.readFileSync(AUDIT_FILE, 'utf-8')
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as AuditEntry } catch { return null }
    })
    .filter(Boolean) as AuditEntry[]
}

export async function GET(req: NextRequest) {
  if (isPostgresTaskStoreEnabled()) {
    try {
      const actor = await requireRequestUser(req)
      const selected = req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
      const board = await resolveProjectBoardAccess({ actorEmail: actor, boardId: selected })
        .catch(() => resolveProjectBoardAccess({ actorEmail: actor }))
      const tasks = await readTasksFromPostgres({ boardId: board.id })
      const dayAgoMs = Date.now() - (24 * 60 * 60 * 1000)
      const ordered = [...tasks].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      const last = ordered.at(-1) || null
      const createdActivity = last?.activity?.find((entry) => entry.type === 'created')
      return NextResponse.json({
        created24h: tasks.filter((task) => Date.parse(task.createdAt) >= dayAgoMs).length,
        lastCreated: last ? {
          timestamp: last.createdAt,
          source: 'app',
          actor: createdActivity?.actor || null,
          taskId: last.id,
          title: last.title,
          anomaly: false,
          recentCreatesInLastMinute: 0,
        } : null,
      })
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load task audit' }, { status: 403 })
    }
  }

  const entries = readEntries()
  const nowMs = Date.now()
  const dayAgoMs = nowMs - (24 * 60 * 60 * 1000)

  const creations = entries.filter((entry) => entry.type === 'task_created')
  const last = creations[creations.length - 1] || null
  const created24h = creations.filter((entry) => {
    const ts = Date.parse(String(entry.timestamp || ''))
    return Number.isFinite(ts) && ts >= dayAgoMs
  }).length

  return NextResponse.json({
    created24h,
    lastCreated: last ? {
      timestamp: last.timestamp || null,
      source: last.source || null,
      actor: last.actor || null,
      taskId: last.taskId || null,
      title: last.title || null,
      anomaly: Boolean(last.anomaly),
      recentCreatesInLastMinute: last.recentCreatesInLastMinute || 0,
    } : null,
  })
}
