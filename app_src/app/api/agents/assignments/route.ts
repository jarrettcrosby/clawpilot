import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { normalizeProductAgentId } from '@/lib/agents/routing'
import { assignmentKickoffText, prepareAgentDispatch } from '@/lib/agents/dispatch'
import { withFileLock } from '@/lib/fileLock'
import { applyCanonicalWorkItem, canonicalizeTasks } from '@/lib/workItemModel'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres, replaceTasksInPostgres } from '@/lib/persistence/tasks'
import type { AgentDispatchEnqueueInput } from '@/lib/persistence/agentDispatch'
import { requireRequestUser } from '@/lib/requestUser'
import { BOARD_SELECTION_COOKIE, requireResourceEditor, resolveProjectBoardAccess, type ProjectBoard } from '@/lib/tenancy'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const FILE = process.env.AGENT_ASSIGNMENTS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'assignments.json')

type Assignment = { taskId: string; agentId: string; updatedAt: string }
type TestingTaskRecord = Task & {
  description?: unknown
  labels?: unknown
}

function normalizeAgentId(agentId: string): string {
  return normalizeProductAgentId(agentId) || ''
}

function isTestingRecord(task: Task): boolean {
  const record = task as TestingTaskRecord
  const hay = [
    String(record.title || ''),
    String(record.desc || ''),
    String(record.description || ''),
    String(record.category || ''),
    ...(Array.isArray(record.labels) ? record.labels.map((v) => String(v || '')) : []),
    ...(Array.isArray(record.tags) ? record.tags.map((v) => String(v || '')) : []),
  ].join(' ').toLowerCase()

  return /(\btest\b|testing|synthetic|dummy|placeholder|sandbox|qa\b|doer mode|ui acceptance governance|critical path acceptance|aig legit flow)/i.test(hay)
}

function projectAssignmentsFromTasks(tasks: Task[]): Assignment[] {
  return tasks
    .filter((task) => Boolean(task?.assignedAgent))
    .filter((task) => !task?.archived && !task?.deletedAt)
    .filter((task) => !isTestingRecord(task))
    .map((task) => ({
      taskId: String(task.id),
      agentId: normalizeAgentId(String(task.assignedAgent || '')),
      updatedAt: String(task.updatedAt || new Date(0).toISOString()),
    }))
    .filter((entry) => Boolean(entry.agentId))
}

async function readAssignments(boardId?: string): Promise<Assignment[]> {
  const tasks = await readTasks(boardId)
  const projected = projectAssignmentsFromTasks(tasks)
  // File mode keeps assignments.json as a projection cache; Postgres mode stores
  // the projection in agent_assignments during task writes.
  if (!isPostgresTaskStoreEnabled()) writeAssignments(projected)
  return projected
}

function writeAssignments(items: Assignment[]) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(items, null, 2))
}

function readTasksFromFile(): Task[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

async function readTasks(boardId?: string): Promise<Task[]> {
  if (isPostgresTaskStoreEnabled()) {
    if (!boardId) throw new Error('Project board context is required')
    try {
      return await readTasksFromPostgres({ boardId })
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[assignments] Postgres read failed; falling back to file store', error)
    }
  }

  return readTasksFromFile()
}

async function writeTasks(tasks: Task[], boardId?: string, agentDispatches: AgentDispatchEnqueueInput[] = []) {
  const canonical = canonicalizeTasks(tasks)
  if (isPostgresTaskStoreEnabled()) {
    if (!boardId) throw new Error('Project board context is required')
    try {
      await replaceTasksInPostgres(canonical, { boardId, agentDispatches })
      return
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[assignments] Postgres write failed; falling back to file store', error)
    }
  }

  const lockPath = `${TASKS_FILE}.lock`
  await withFileLock(lockPath, () => {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(canonical, null, 2))
  })
}

async function resolveAssignmentBoard(req: NextRequest, requireEdit = false): Promise<{
  board: ProjectBoard | null
  actorEmail: string
}> {
  if (!isPostgresTaskStoreEnabled()) return { board: null, actorEmail: 'Operator' }
  const actor = await requireRequestUser(req)
  const selected = req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
  let board: ProjectBoard
  try {
    board = await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: selected })
  } catch {
    board = await resolveProjectBoardAccess({ actorEmail: actor.email })
  }
  if (requireEdit) requireResourceEditor(board)
  return { board, actorEmail: actor.email }
}

export async function GET(req: NextRequest) {
  try {
    const { board } = await resolveAssignmentBoard(req)
    return NextResponse.json({ assignments: await readAssignments(board?.id) })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Unable to load assignments' }, { status: 403 })
  }
}

export async function PUT(req: NextRequest) {
  let board: ProjectBoard | null
  let actorEmail = 'Operator'
  try {
    const context = await resolveAssignmentBoard(req, true)
    board = context.board
    actorEmail = context.actorEmail
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Assignment access denied' }, { status: 403 })
  }
  const body = await req.json()
  const taskId = String(body?.taskId || '')
  const requestedAgentId = String(body?.agentId || '').trim()
  const agentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : ''
  if (!taskId || (requestedAgentId && !agentId)) {
    return NextResponse.json({ ok: false, error: 'taskId and a valid agentId are required' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const tasks = await readTasks(board?.id)
  const idx = tasks.findIndex(t => String(t.id) === taskId)
  if (idx === -1) {
    return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  }

  const previous = tasks[idx]
  let updated: Task = {
    ...previous,
    assignedAgent: agentId || undefined,
    updatedAt: now,
    activity: agentId !== String(previous.assignedAgent || '')
      ? [
          ...(previous.activity || []),
          {
            type: 'updated',
            message: agentId ? `Assigned to ${agentId}` : 'Assignment cleared',
            timestamp: now,
            actor: actorEmail,
            taskId: previous.id,
            taskTitle: previous.title,
          },
        ]
      : previous.activity,
  }
  const agentDispatches: AgentDispatchEnqueueInput[] = []
  if (board && agentId && agentId !== String(previous.assignedAgent || '')) {
    const prepared = prepareAgentDispatch({
      operatorId: actorEmail,
      boardId: board.id,
      task: updated,
      agentId,
      text: assignmentKickoffText(),
      trigger: 'assignment',
      queuedAt: now,
    })
    updated = prepared.task
    agentDispatches.push(prepared.dispatch)
  }
  tasks[idx] = applyCanonicalWorkItem(updated)
  await writeTasks(tasks, board?.id, agentDispatches)

  const assignments = await readAssignments(board?.id)
  return NextResponse.json({ ok: true, assignments, task: tasks[idx] })
}
