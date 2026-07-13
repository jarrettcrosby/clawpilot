import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { normalizeProductAgentId } from '@/lib/agents/routing'
import { withFileLock } from '@/lib/fileLock'
import { isPostgresTaskStoreEnabled } from '@/lib/persistence/tasks'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)

function readTasks(): Task[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

async function writeTasks(tasks: Task[]) {
  const lockPath = `${TASKS_FILE}.lock`
  await withFileLock(lockPath, () => {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2))
  })
}

export async function POST() {
  if (isPostgresTaskStoreEnabled()) {
    return NextResponse.json({ ok: false, error: 'Legacy assignment backfill is disabled for Postgres workspaces' }, { status: 410 })
  }
  const tasks = readTasks()
  let changed = 0
  const updated = tasks.map(task => {
    const legacy = task.assignedAgent || task.assignee
    const mapped = normalizeProductAgentId(legacy, { category: task.category, tags: task.tags })
    if (mapped && mapped !== task.assignedAgent) {
      changed += 1
      return { ...task, assignedAgent: mapped }
    }
    return task
  })

  if (changed > 0) await writeTasks(updated)
  return NextResponse.json({ ok: true, changed })
}
