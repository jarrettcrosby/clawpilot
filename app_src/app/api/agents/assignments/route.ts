import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { normalizeProductAgentId } from '@/lib/agents/routing'
import { withFileLock } from '@/lib/fileLock'
import { canonicalizeTasks } from '@/lib/workItemModel'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const FILE = process.env.AGENT_ASSIGNMENTS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'assignments.json')

type Assignment = { taskId: string; agentId: string; updatedAt: string }

function normalizeAgentId(agentId: string): string {
  return normalizeProductAgentId(agentId) || ''
}

function projectAssignmentsFromTasks(tasks: Task[]): Assignment[] {
  return tasks
    .filter((task) => Boolean(task?.assignedAgent))
    .map((task) => ({
      taskId: String(task.id),
      agentId: normalizeAgentId(String(task.assignedAgent || '')),
      updatedAt: String(task.updatedAt || new Date(0).toISOString()),
    }))
    .filter((entry) => Boolean(entry.agentId))
}

function readAssignments(): Assignment[] {
  const tasks = readTasks()
  const projected = projectAssignmentsFromTasks(tasks)
  // Keep assignment file as projection cache, but canonical source is tasks.json.
  writeAssignments(projected)
  return projected
}

function writeAssignments(items: Assignment[]) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(items, null, 2))
}

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
  const canonical = canonicalizeTasks(tasks)
  await withFileLock(lockPath, () => {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(canonical, null, 2))
  })
}

export async function GET() {
  return NextResponse.json({ assignments: readAssignments() })
}

export async function PUT(req: NextRequest) {
  const body = await req.json()
  const taskId = String(body?.taskId || '')
  const agentId = normalizeAgentId(String(body?.agentId || ''))
  if (!taskId || !agentId) {
    return NextResponse.json({ ok: false, error: 'taskId and agentId required' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const tasks = readTasks()
  const idx = tasks.findIndex(t => String(t.id) === taskId)
  if (idx !== -1) {
    tasks[idx] = { ...tasks[idx], assignedAgent: agentId, updatedAt: now }
    await writeTasks(tasks)
  }

  const assignments = readAssignments()
  return NextResponse.json({ ok: true, assignments })
}
