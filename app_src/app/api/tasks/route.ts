import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { Task, ActivityEntry, Comment, ChecklistItem } from '@/lib/types'
import { ensureNotFrozen } from '@/lib/freeze'
import { normalizeProductAgentId } from '@/lib/agents/routing'
import { assignmentKickoffText, commentTargetsAssignedAgent, prepareAgentDispatch } from '@/lib/agents/dispatch'
import { isCrmBoardCard, normalizeCrmBoardCard } from '@/lib/crm/boardCard.mjs'
import { normalizeExecutionStatus } from '@/lib/taskState'
import type { ExecutionStatus } from '@/lib/taskState'
import { withFileLock } from '@/lib/fileLock'
import { applyCanonicalWorkItem, canonicalizeTasks } from '@/lib/workItemModel'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres, replaceTasksInPostgres } from '@/lib/persistence/tasks'
import type { AgentDispatchEnqueueInput } from '@/lib/persistence/agentDispatch'
import { requireRequestUser } from '@/lib/requestUser'
import { resolveAgentDispatchWorker, type AgentDispatchWorkerContext } from '@/lib/workerAuth'
import {
  BOARD_SELECTION_COOKIE,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
  resolveProjectBoardAccess,
  type ProjectBoard,
} from '@/lib/tenancy'
import {
  CrmDescriptionConflictError,
  reconcileCrmBoardProjection,
  resolveCrmBoardBinding,
  updateCrmBoardTaskDescription,
} from '@/lib/crm/boardProjection'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const DELETED_TASKS_FILE = path.join(path.dirname(TASKS_FILE), 'deleted-tasks.json')
const TASK_CREATION_AUDIT_FILE = path.join(path.dirname(TASKS_FILE), 'task-creation-audit.jsonl')
const ASSIGNMENTS_FILE = process.env.AGENT_ASSIGNMENTS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'assignments.json')

type TaskRecord = Partial<Task> & Record<string, unknown>
type TaskBody = Record<string, unknown> & {
  actor?: string
  _actor?: string
  _createSource?: string
  title?: string
  desc?: string
  description?: string
  directive?: string
  category?: string
  status?: string
  priority?: string
  tags?: unknown
  assignedAgent?: string
  dueDate?: string
  workstream?: string
  outcomeStatement?: string
  acceptanceCriteria?: unknown
  checklist?: unknown
  delegatedAgents?: unknown
  initialComment?: string
  nextAction?: string
  workItem?: unknown
}
type TaskPatchBody = TaskBody & {
  id?: string
  crmDescription?: string
  crmDescriptionHash?: string
  _comment?: string
  _commentId?: string
  _editCommentId?: string
  _editCommentText?: string
  _deleteCommentId?: string
  _restoreCommentId?: string
  _checklistAdd?: Partial<ChecklistItem>
  _checklistToggle?: string
  _checklistDelete?: string
  _checklistUpdate?: Partial<ChecklistItem> & { id?: string }
  _execution?: Partial<NonNullable<Task['execution']>>
  _agentDispatchState?: {
    id?: string
    status?: 'queued' | 'running' | 'succeeded' | 'failed'
    attempts?: number
    error?: string
  }
  _suggestionAction?: {
    action?: string
    suggestion?: {
      title?: string
      summary?: string
      reason?: string
      suggestedAgent?: string
      timestamp?: string
    }
  }
  _actor?: string
  _archive?: boolean
  _unarchive?: boolean
  _deletePermanent?: boolean
  _deleteReason?: string
}

const MANUAL_CREATE_SOURCES = new Set([
  'manual-ui',
  'manual-api',
  'manual-operator',
  'manual-user',
])

const AUTOMATION_CREATE_SOURCES = new Set([
  'automation-clawpilot-approved',
])

const BLOCKED_AGENT_ACTORS = new Set([
  'clawpilot',
  'projects',
  'pipeline',
  'docs',
  'calendar',
  'projects-agent',
  'pipeline-agent',
  'docs-agent',
  'calendar-agent',
  'main',
  'builder',
])

function isAgentActor(actor: string) {
  const normalized = actor.toLowerCase().trim()
  if (!normalized) return false
  if (BLOCKED_AGENT_ACTORS.has(normalized)) return true
  return /\b(agent|clawpilot)\b/i.test(normalized)
}

function appendTaskCreationAudit(entry: Record<string, unknown>) {
  const lockPath = `${TASK_CREATION_AUDIT_FILE}.lock`
  return withFileLock(lockPath, () => {
    const line = `${JSON.stringify(entry)}\n`
    fs.appendFileSync(TASK_CREATION_AUDIT_FILE, line, 'utf-8')
  })
}

function readTaskCreationAuditEntries(): Array<Record<string, unknown>> {
  if (!fs.existsSync(TASK_CREATION_AUDIT_FILE)) return []
  const raw = fs.readFileSync(TASK_CREATION_AUDIT_FILE, 'utf-8')
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as Record<string, unknown> } catch { return null }
    })
    .filter(Boolean) as Array<Record<string, unknown>>
}

function normalizeTasks(tasks: unknown): Task[] {
  if (!Array.isArray(tasks)) return []
  return tasks.map((task) => {
    const t = (task && typeof task === 'object' ? task : {}) as TaskRecord
    const taskId = String(t.id ?? '')
    const taskTitle = String(t.title ?? '')

    // Normalize comments timestamps
    const rawComments = Array.isArray(t.comments) ? t.comments : []
    const comments = rawComments.map((comment) => {
      const c = (comment && typeof comment === 'object' ? comment : {}) as Partial<Comment> & Record<string, unknown>
      const createdAt = c.createdAt || c.timestamp
      return {
        id: String(c.id || `${taskId}-comment-${Date.now()}`),
        text: String(c.text || ''),
        author: String(c.author || 'Jarrett'),
        createdAt,
        // keep legacy timestamp for backward compat
        timestamp: c.timestamp || createdAt,
        deletedAt: typeof c.deletedAt === 'string' ? c.deletedAt : undefined,
      } satisfies Comment
    })

    // Normalize activity fields
    const rawActivity = Array.isArray(t.activity) ? t.activity : []
    const activity = rawActivity.map((entry) => {
      const e = (entry && typeof entry === 'object' ? entry : {}) as Partial<ActivityEntry> & Record<string, unknown>
      return {
        type: (e.type as ActivityEntry['type']) || 'updated',
        message: String(e.message || ''),
        from: typeof e.from === 'string' ? e.from : undefined,
        to: typeof e.to === 'string' ? e.to : undefined,
        timestamp: String(e.timestamp || t.updatedAt || t.createdAt || new Date(0).toISOString()),
        actor: e.actor || 'Jarrett',
        taskId: e.taskId || taskId,
        taskTitle: e.taskTitle || taskTitle,
        commentId: typeof e.commentId === 'string' ? e.commentId : undefined,
      } satisfies ActivityEntry
    })

    const crmCard = isCrmBoardCard(t)
    const assignedAgent = typeof t.assignedAgent === 'string' ? t.assignedAgent : undefined
    const mappedAssigned = crmCard ? undefined : normalizeProductAgentId(assignedAgent, {
      category: typeof t.category === 'string' ? t.category : undefined,
      tags: Array.isArray(t.tags) ? t.tags.map((tag) => String(tag)) : [],
    })
    const rawDeletedComments = Array.isArray(t.deletedComments) ? t.deletedComments : []
    const normalizedTask: Task = {
      id: taskId,
      boardId: typeof t.boardId === 'string' ? t.boardId : undefined,
      title: taskTitle,
      desc: typeof t.desc === 'string' ? t.desc : '',
      status: typeof t.status === 'string' ? toStatus(t.status) : 'backlog',
      priority: typeof t.priority === 'string' ? toPriority(t.priority) : 'medium',
      category: typeof t.category === 'string' ? t.category : 'clawpilot',
      tags: Array.isArray(t.tags) ? t.tags.map((tag) => String(tag)).filter(Boolean) : [],
      assignedAgent: mappedAssigned,
      assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
      dueDate: typeof t.dueDate === 'string' ? t.dueDate : undefined,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date(0).toISOString(),
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date(0).toISOString(),
      comments,
      activity,
      checklist: normalizeChecklist(t.checklist),
      deletedComments: rawDeletedComments.map((comment) => {
        const c = (comment && typeof comment === 'object' ? comment : {}) as Partial<Comment> & Record<string, unknown>
        return {
          id: String(c.id || `${taskId}-deleted-comment-${Date.now()}`),
          text: String(c.text || ''),
          author: String(c.author || 'Jarrett'),
          createdAt: c.createdAt || c.timestamp,
          timestamp: c.timestamp || c.createdAt,
          deletedAt: typeof c.deletedAt === 'string' ? c.deletedAt : undefined,
        } satisfies Comment
      }),
      archived: Boolean(t.archived),
      archivedAt: typeof t.archivedAt === 'string' ? t.archivedAt : undefined,
      deletedAt: typeof t.deletedAt === 'string' ? t.deletedAt : undefined,
      workstream: typeof t.workstream === 'string' ? t.workstream : undefined,
      outcomeStatement: typeof t.outcomeStatement === 'string' ? t.outcomeStatement : undefined,
      entityType: typeof t.entityType === 'string' ? t.entityType : undefined,
      crm: typeof t.crm === 'object' && t.crm !== null ? t.crm as Task['crm'] : undefined,
      governance: typeof t.governance === 'object' && t.governance !== null ? t.governance as Task['governance'] : undefined,
      execution: typeof t.execution === 'object' && t.execution !== null ? t.execution as Task['execution'] : undefined,
    }
    return crmCard
      ? normalizeCrmBoardCard(normalizedTask) as Task
      : applyCanonicalWorkItem(normalizedTask)
  })
}

function readTasksFromFile(): Task[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'))
    return normalizeTasks(raw)
  } catch {
    return []
  }
}

async function readTasks(boardId?: string, includeCrmCards = false): Promise<Task[]> {
  if (isPostgresTaskStoreEnabled()) {
    if (!boardId) throw new Error('Project board context is required')
    try {
      return normalizeTasks(await readTasksFromPostgres({ boardId, includeCrmCards }))
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[task-store] Postgres read failed; falling back to file store', error)
    }
  }

  return readTasksFromFile()
}

function projectAssignmentsFromTasks(tasks: Task[]) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => Boolean(task?.assignedAgent))
    .map((task) => ({
      taskId: String(task.id),
      agentId: String(task.assignedAgent || ''),
      updatedAt: String(task.updatedAt || new Date(0).toISOString()),
    }))
    .filter((row) => Boolean(row.agentId))
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
      console.warn('[task-store] Postgres write failed; falling back to file store', error)
    }
  }

  const lockPath = `${TASKS_FILE}.lock`
  await withFileLock(lockPath, () => {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(canonical, null, 2))
    fs.mkdirSync(path.dirname(ASSIGNMENTS_FILE), { recursive: true })
    fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(projectAssignmentsFromTasks(canonical), null, 2))
  })
}

async function resolveTaskBoard(
  req: NextRequest,
  requireEdit = false,
  workerContext?: AgentDispatchWorkerContext | null,
): Promise<ProjectBoard | null> {
  if (!isPostgresTaskStoreEnabled()) return null
  const worker = workerContext === undefined ? await resolveAgentDispatchWorker(req) : workerContext
  const actor = worker ? worker.actor : await requireRequestUser(req)
  const explicit = new URL(req.url).searchParams.get('boardId')
  if (worker && explicit && explicit !== worker.boardId) throw new Error('Worker board claim mismatch')
  const selected = worker?.boardId || explicit || req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
  let board: ProjectBoard
  try {
    board = await resolveProjectBoardAccess({ actorEmail: actor, boardId: selected })
  } catch (error) {
    if (explicit || worker) throw error
    board = await resolveProjectBoardAccess({ actorEmail: actor })
  }
  if (requireEdit) requireResourceEditor(board)
  return board
}

export type TaskIntent = {
  title: string
  description: string
  status: Task['status']
  priority: Task['priority']
  category: string
  labels: string[]
  checklist: { text: string; done?: boolean }[]
  assignedAgentId: string | null
  dueDate: string | null
}

const VALID_STATUS: Task['status'][] = ['backlog', 'todo', 'in-progress', 'review', 'done']
const VALID_PRIORITY: Task['priority'][] = ['high', 'medium', 'low']
const VALID_CATEGORY = new Set(['clawpilot', 'epi', 'suburbia', 'p9ine', 'personal', 'ops', 'tech', 'marketing', 'app', 'pipeline'])

function toStatus(v: unknown): Task['status'] {
  const s = String(v || '').toLowerCase()
  return (VALID_STATUS.includes(s as Task['status']) ? s : 'backlog') as Task['status']
}

function toPriority(v: unknown): Task['priority'] {
  const s = String(v || '').toLowerCase()
  return (VALID_PRIORITY.includes(s as Task['priority']) ? s : 'medium') as Task['priority']
}

function toCategory(v: unknown): string {
  const s = String(v || '').toLowerCase().trim()
  return VALID_CATEGORY.has(s) ? s : 'clawpilot'
}

function isActiveColumnStatus(status: Task['status']): boolean {
  return status === 'todo' || status === 'in-progress' || status === 'review'
}

async function resolveRequestActor(
  req: NextRequest,
  fallback: string,
  workerContext?: AgentDispatchWorkerContext | null,
): Promise<string> {
  const worker = workerContext === undefined ? await resolveAgentDispatchWorker(req) : workerContext
  if (worker) return worker.operatorId
  try {
    return (await requireRequestUser(req)).email
  } catch {
    // Preserve local callers when app-user persistence is unavailable.
  }
  return fallback.trim()
}

function deriveMissingActionableFields(task: Partial<Task>): string[] {
  const missing: string[] = []
  const owner = String(task.assignedAgent || '').trim()
  const nextAction = String((task.workItem as { nextAction?: string } | undefined)?.nextAction || '').trim()
  if (!owner) missing.push('owner')
  if (!nextAction) missing.push('next action')
  return missing
}

function shortDesc(v: unknown): string {
  const normalized = String(v || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  if (!normalized) return ''

  const withoutWhitespace = normalized.replace(/\s+/g, '')
  const repeatedNoise = withoutWhitespace.length >= 80
    && (/^(.)\1+$/.test(withoutWhitespace) || new Set(withoutWhitespace.toLowerCase()).size <= 2)
  if (repeatedNoise) return 'Task created from directive. See checklist/comments for execution details.'

  return normalized.slice(0, 10_000)
}

function normalizeChecklist(input: unknown): ChecklistItem[] {
  const arr = Array.isArray(input) ? input : []
  return arr
    .map((x, i: number) => {
      if (typeof x === 'string') return { id: `${Date.now()}-${i}`, text: x.trim(), done: false }
      if (!x || typeof x !== 'object') return null
      const item = x as Partial<ChecklistItem> & Record<string, unknown>
      const text = String(item.text || '').trim()
      if (!text) return null
      return {
        id: String(item.id || `${Date.now()}-${i}`),
        text,
        done: !!item.done,
        assignee: normalizeProductAgentId(item.assignee ? String(item.assignee) : undefined) || (item.assignee ? String(item.assignee) : undefined),
        agentId: normalizeProductAgentId(item.agentId ? String(item.agentId) : undefined) || (item.agentId ? String(item.agentId) : undefined),
        dueDate: item.dueDate ? String(item.dueDate) : undefined,
      } as ChecklistItem
    })
    .filter(Boolean) as ChecklistItem[]
}

function normalizeTags(input: unknown): string[] {
  return Array.isArray(input) ? input.map((x) => String(x).trim()).filter(Boolean) : []
}

function normalizeAcceptanceCriteria(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((x) => String(x).trim()).filter(Boolean)
  if (typeof input === 'string' && input.trim()) return input.split(/\r?\n|;/).map((x) => x.trim()).filter(Boolean)
  return []
}

const PLACEHOLDER_TOKENS = new Set(['x', 'xx', 'xxx', 'test', 'tmp', 'tbd', 'todo', 'na', 'n/a', 'asdf'])

function isPlaceholderValue(input: unknown): boolean {
  const v = String(input || '').trim().toLowerCase()
  if (!v) return false
  if (PLACEHOLDER_TOKENS.has(v)) return true
  if (/^x+$/i.test(v)) return true
  return false
}

function hasMeaningfulTitle(input: unknown): boolean {
  const raw = String(input || '').trim()
  if (!raw) return false
  if (isPlaceholderValue(raw)) return false
  const meaningful = raw.replace(/[^a-z0-9]/gi, '')
  return meaningful.length >= 3
}

function parseChecklistFromDirective(text: string): { text: string; done?: boolean }[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l) || /^\d+[.)]\s+/.test(l))
    .map((l) => ({ text: l.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim(), done: false }))
    .filter((x) => x.text)
    .slice(0, 12)
}

function buildTaskIntent(body: TaskBody): TaskIntent {
  const directive = String(body.directive || '').trim()
  const title = String(body.title || '').trim() || 'Untitled task'
  const description = shortDesc(body.desc || body.description || directive)
  const parsedChecklist = parseChecklistFromDirective(directive)
  const explicitChecklist = normalizeChecklist(body.checklist).map((c) => ({ text: c.text, done: c.done }))
  const checklist = explicitChecklist.length ? explicitChecklist : parsedChecklist

  const labels = [...new Set([
    ...normalizeTags(body.tags),
    ...(directive ? ['directive'] : []),
  ])]

  const assignedAgentId = normalizeProductAgentId(body.assignedAgent ? String(body.assignedAgent).trim() : '')
    || ''
  const assignedAgentIdFinal = assignedAgentId || null

  const status = toStatus(body.status || 'backlog')
  const priority = toPriority(body.priority || 'medium')
  const category = toCategory(body.category || 'clawpilot')
  const dueDate = body.dueDate ? String(body.dueDate) : null

  return { title, description, status, priority, category, labels, checklist, assignedAgentId: assignedAgentIdFinal, dueDate }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const includeArchived = searchParams.get('includeArchived') === 'true'
    const includeCrmCards = searchParams.get('includeCrmCards') === 'true'
    const board = await resolveTaskBoard(req)
    if (board) {
      const binding = await resolveCrmBoardBinding(board.id)
      if (binding) {
        const actor = await requireRequestUser(req)
        await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: binding.pipeline_id })
      }
      await reconcileCrmBoardProjection({ boardId: board.id })
    }
    const tasks = (await readTasks(board?.id, includeCrmCards)).filter((task) => includeCrmCards || !isCrmBoardCard(task))
    return NextResponse.json(includeArchived ? tasks : tasks.filter((task) => !task.archived))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load tasks'
    return NextResponse.json({ error: message }, { status: message === 'Unauthorized' ? 401 : 403 })
  }
}

export async function POST(req: NextRequest) {
  const freeze = ensureNotFrozen()
  if (freeze) return NextResponse.json(freeze, { status: 423 })

  let board: ProjectBoard | null
  try {
    board = await resolveTaskBoard(req, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Project board access denied'
    return NextResponse.json({ error: message }, { status: message === 'Unauthorized' ? 401 : 403 })
  }
  if (board && await resolveCrmBoardBinding(board.id)) {
    return NextResponse.json({ error: 'CRM cards are created from CRM accounts and contacts' }, { status: 409 })
  }
  const tasks = await readTasks(board?.id)
  const body = await req.json() as TaskBody
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const actorRaw = String(body._actor || '').trim()
  const actor = await resolveRequestActor(req, actorRaw)
  const createSource = String(body._createSource || req.headers.get('x-claw-task-create-source') || '').toLowerCase().trim()

  // canonical task-creation policy: explicit source metadata + default-deny automation
  const allowAutomationCreate = process.env.ENABLE_AUTOMATION_TASK_CREATE === 'true'

  if (!actor) {
    return NextResponse.json({
      error: 'Task creation requires explicit actor metadata',
      blocked: true,
      policyCode: 'TASK_CREATE_ACTOR_REQUIRED',
      operatorMessage: 'Creation blocked: include `_actor` in the request body.',
    }, { status: 400 })
  }

  if (!createSource) {
    return NextResponse.json({
      error: 'Task creation requires explicit create source metadata',
      blocked: true,
      policyCode: 'TASK_CREATE_SOURCE_REQUIRED',
      operatorMessage: 'Creation blocked: include `_createSource` or `x-claw-task-create-source` with an allowed manual source.',
      allowedManualSources: Array.from(MANUAL_CREATE_SOURCES),
    }, { status: 400 })
  }

  const isManualSource = MANUAL_CREATE_SOURCES.has(createSource)
  const isAutomationSource = AUTOMATION_CREATE_SOURCES.has(createSource)

  if (!isManualSource && !isAutomationSource) {
    return NextResponse.json({
      error: 'Task creation source is not allowed by policy',
      blocked: true,
      policyCode: 'TASK_CREATE_SOURCE_DENIED',
      operatorMessage: 'Creation blocked by policy: source is not in the allow-list for this containment phase.',
      createSource,
      allowedManualSources: Array.from(MANUAL_CREATE_SOURCES),
      allowedAutomationSources: Array.from(AUTOMATION_CREATE_SOURCES),
    }, { status: 403 })
  }

  if (isAgentActor(actor)) {
    return NextResponse.json({
      error: 'Agent-originated task creation is forbidden by policy',
      blocked: true,
      policyCode: 'TASK_CREATE_AGENT_FORBIDDEN',
      operatorMessage: 'Agents never create tasks. Agents may only suggest work; operators create tasks explicitly.',
      actor,
      createSource,
    }, { status: 400 })
  }

  if (isAutomationSource && !allowAutomationCreate) {
    return NextResponse.json({
      error: 'Automated task creation is temporarily disabled pending policy approval',
      blocked: true,
      policyCode: 'TASK_CREATE_AUTOMATION_DISABLED',
      operatorMessage: 'Creation blocked: automation path is default-deny. Use a manual source or explicitly enable approved automation.',
      actor,
      createSource,
      allowedManualSources: Array.from(MANUAL_CREATE_SOURCES),
      approvedAutomationPath: 'automation-clawpilot-approved + ENABLE_AUTOMATION_TASK_CREATE=true',
    }, { status: 409 })
  }

  const intent = buildTaskIntent(body)
  const title = intent.title
  const desc = intent.description
  const status = intent.status
  const priority = intent.priority
  const category = intent.category
  const tags = [...intent.labels]
  const dueDate = intent.dueDate || undefined

  const workstream = body.workstream ? String(body.workstream).toLowerCase() : undefined
  const outcomeStatement = body.outcomeStatement ? String(body.outcomeStatement).trim() : undefined
  const acceptanceCriteria = normalizeAcceptanceCriteria(body.acceptanceCriteria)
  const explicitNextAction = String(
    body.nextAction
    || ((body.workItem && typeof body.workItem === 'object') ? (body.workItem as Record<string, unknown>).nextAction : '')
    || '',
  ).trim()

  if (!hasMeaningfulTitle(title)) {
    return NextResponse.json({
      error: 'Task quality validation failed',
      blocked: true,
      policyCode: 'TASK_INVALID_QUALITY',
      operatorMessage: 'Task must include a meaningful title.',
    }, { status: 400 })
  }

  const assignedAgent = intent.assignedAgentId || undefined

  const checklistInput = intent.checklist.length > 0
    ? intent.checklist
    : acceptanceCriteria.map((text) => ({ text, done: false }))
  const checklist = checklistInput.map((c, i) => ({ id: `${id}-ck-${i}`, text: c.text, done: !!c.done })) as ChecklistItem[]

  const activeMissing = isActiveColumnStatus(status)
    ? [
        ...(!String(desc || '').trim() || isPlaceholderValue(desc) ? ['description'] : []),
        ...(!assignedAgent ? ['owner'] : []),
        ...(!explicitNextAction ? ['next action'] : []),
      ]
    : []
  if (activeMissing.length > 0) {
    return NextResponse.json({
      error: 'Active task is missing required operating context',
      blocked: true,
      policyCode: 'TASK_NOT_ACTIONABLE',
      operatorMessage: `Add ${activeMissing.join(', ')} before moving this task into active work.`,
      missing: activeMissing,
    }, { status: 400 })
  }

  const activity: ActivityEntry[] = [
    { type: 'created', message: 'Card created', timestamp: now, actor, taskId: id, taskTitle: title },
  ]
  const comments: Comment[] = []

  const initialComment = String(body.initialComment || '').trim()
  if (initialComment) {
    comments.push({ id: `${id}-c1`, text: initialComment, createdAt: now, timestamp: now, author: actor })
    activity.push({ type: 'comment', message: `Commented: "${initialComment.slice(0, 60)}${initialComment.length > 60 ? '...' : ''}"`, timestamp: now, actor, taskId: id, taskTitle: title })
  }

  const taskObj: Task = {
    id,
    boardId: board?.id,
    title,
    desc,
    status,
    priority,
    category,
    tags,
    assignedAgent,
    dueDate,
    workstream: workstream || undefined,
    outcomeStatement,
    execution: explicitNextAction ? {
      executionStatus: 'queued',
      startedAt: now,
      lastUpdatedAt: now,
      latestExecutionNote: `Next action: ${explicitNextAction}`,
      lastResult: { nextAction: explicitNextAction },
    } : undefined,
    createdAt: now,
    updatedAt: now,
    activity,
    comments,
    checklist,
  }

  let actionableCandidate = applyCanonicalWorkItem(taskObj)
  const agentDispatches: AgentDispatchEnqueueInput[] = []
  if (board && assignedAgent && isPostgresTaskStoreEnabled()) {
    const prepared = prepareAgentDispatch({
      operatorId: actor,
      boardId: board.id,
      task: actionableCandidate,
      agentId: assignedAgent,
      text: assignmentKickoffText(),
      trigger: 'assignment',
      eventId: id,
      queuedAt: now,
    })
    actionableCandidate = applyCanonicalWorkItem(prepared.task)
    agentDispatches.push(prepared.dispatch)
  }

  tasks.push(actionableCandidate)
  await writeTasks(tasks, board?.id, agentDispatches)

  const existingAudit = readTaskCreationAuditEntries()
  const oneMinuteAgo = Date.now() - 60 * 1000
  const recentCount = existingAudit.filter((entry) => {
    const ts = String(entry.timestamp || '')
    if (!ts) return false
    const ms = Date.parse(ts)
    return Number.isFinite(ms) && ms >= oneMinuteAgo
  }).length + 1
  const anomaly = recentCount > 3

  const auditEntry = {
    type: 'task_created',
    timestamp: now,
    taskId: id,
    title,
    source: createSource,
    actor,
    anomaly,
    recentCreatesInLastMinute: recentCount,
  }
  await appendTaskCreationAudit(auditEntry)

  if (anomaly) {
    const warning = {
      type: 'anomaly_warning',
      timestamp: now,
      warning: 'Task creation anomaly: more than 3 tasks created within 1 minute',
      actor,
      source: createSource,
      recentCreatesInLastMinute: recentCount,
      taskId: id,
    }
    await appendTaskCreationAudit(warning)
    console.warn('[task-create-anomaly]', warning)
  }

  return NextResponse.json(actionableCandidate, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const freeze = ensureNotFrozen()
  if (freeze) return NextResponse.json(freeze, { status: 423 })

  const workerContext = await resolveAgentDispatchWorker(req).catch(() => null)
  let board: ProjectBoard | null
  try {
    board = await resolveTaskBoard(req, true, workerContext)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Project board access denied'
    return NextResponse.json({ error: message }, { status: message === 'Unauthorized' ? 401 : 403 })
  }
  if (board) {
    const binding = await resolveCrmBoardBinding(board.id)
    if (binding) {
      const actor = workerContext?.actor || await requireRequestUser(req)
      const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: binding.pipeline_id })
      requireResourceEditor(pipeline)
    }
  }
  const tasks = await readTasks(board?.id, true)
  const body = await req.json() as TaskPatchBody
  const { id, crmDescription, crmDescriptionHash, _comment, _editCommentId, _editCommentText, _deleteCommentId, _restoreCommentId, _checklistAdd, _checklistToggle, _checklistDelete, _checklistUpdate, _execution, _agentDispatchState, _suggestionAction, _actor, _deleteReason, ...rawUpdates } = body
  if (_agentDispatchState && !workerContext) {
    return NextResponse.json({ error: 'Agent dispatch state updates require worker authorization' }, { status: 403 })
  }
  const actor = await resolveRequestActor(req, String(_actor || 'Jarrett'), workerContext) || 'Jarrett'

  const idx = tasks.findIndex(t => t.id === id)
  if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const now = new Date().toISOString()
  const prev = tasks[idx]
  const crmCard = isCrmBoardCard(prev)
  const hasCrmDescriptionUpdate = Boolean(prev.crm) && (
    Object.prototype.hasOwnProperty.call(body, 'crmDescription')
    || Object.prototype.hasOwnProperty.call(rawUpdates, 'desc')
  )
  if (hasCrmDescriptionUpdate) {
    if (!board) return NextResponse.json({ error: 'CRM board context is required' }, { status: 409 })
    try {
      const updated = await updateCrmBoardTaskDescription({
        boardId: board.id,
        taskId: prev.id,
        description: Object.prototype.hasOwnProperty.call(body, 'crmDescription') ? crmDescription : rawUpdates.desc,
        expectedDescriptionHash: crmDescriptionHash,
        actorEmail: actor,
      })
      return NextResponse.json(updated)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update CRM description'
      return NextResponse.json({ error: message }, { status: error instanceof CrmDescriptionConflictError ? 409 : 400 })
    }
  }
  const hasAssignedAgentUpdate = Object.prototype.hasOwnProperty.call(rawUpdates, 'assignedAgent')
  const hasNextActionUpdate = Object.prototype.hasOwnProperty.call(rawUpdates, 'nextAction')
    || Object.prototype.hasOwnProperty.call(rawUpdates, 'workItem')
  if (crmCard && hasAssignedAgentUpdate) {
    return NextResponse.json({ error: 'CRM board cards cannot be assigned to agents' }, { status: 409 })
  }
  if (crmCard && (
    hasNextActionUpdate
    || Object.prototype.hasOwnProperty.call(rawUpdates, 'dueDate')
    || Object.prototype.hasOwnProperty.call(rawUpdates, 'workstream')
    || Object.prototype.hasOwnProperty.call(rawUpdates, 'outcomeStatement')
    || Boolean(_checklistAdd || _checklistToggle || _checklistDelete || _checklistUpdate)
    || Boolean(_execution || _agentDispatchState || _suggestionAction)
  )) {
    return NextResponse.json({ error: 'CRM board cards do not participate in task execution workflows' }, { status: 409 })
  }
  const updates: Partial<Task> = {}

  if (Object.prototype.hasOwnProperty.call(rawUpdates, 'title') && typeof rawUpdates.title === 'string') {
    if (!prev.crm) updates.title = rawUpdates.title
  }
  if (Object.prototype.hasOwnProperty.call(rawUpdates, 'desc') && typeof rawUpdates.desc === 'string') {
    updates.desc = rawUpdates.desc
  }
  if (Object.prototype.hasOwnProperty.call(rawUpdates, 'status')) {
    updates.status = rawUpdates.status ? toStatus(rawUpdates.status) : prev.status
  }
  if (Object.prototype.hasOwnProperty.call(rawUpdates, 'priority')) {
    updates.priority = rawUpdates.priority ? toPriority(rawUpdates.priority) : prev.priority
  }
  if (Object.prototype.hasOwnProperty.call(rawUpdates, 'category')) {
    updates.category = rawUpdates.category ? toCategory(rawUpdates.category) : prev.category
  }
  if (Object.prototype.hasOwnProperty.call(rawUpdates, 'dueDate')) {
    updates.dueDate = rawUpdates.dueDate === '' || rawUpdates.dueDate === null
      ? undefined
      : (typeof rawUpdates.dueDate === 'string' ? rawUpdates.dueDate : prev.dueDate)
  }
  if (Object.prototype.hasOwnProperty.call(rawUpdates, 'tags')) {
    updates.tags = normalizeTags(rawUpdates.tags)
  }
  if (Object.prototype.hasOwnProperty.call(rawUpdates, 'workstream') && typeof rawUpdates.workstream === 'string') {
    updates.workstream = rawUpdates.workstream
  }
  if (Object.prototype.hasOwnProperty.call(rawUpdates, 'outcomeStatement') && typeof rawUpdates.outcomeStatement === 'string') {
    updates.outcomeStatement = rawUpdates.outcomeStatement
  }
  if (hasAssignedAgentUpdate) {
    updates.assignedAgent = rawUpdates.assignedAgent === '' || rawUpdates.assignedAgent === null
      ? undefined
      : normalizeProductAgentId(typeof rawUpdates.assignedAgent === 'string' ? rawUpdates.assignedAgent : undefined, { category: prev.category, tags: prev.tags })
  }
  const requestedNextAction = String(
    (typeof rawUpdates.nextAction === 'string' ? rawUpdates.nextAction : '')
    || ((rawUpdates.workItem && typeof rawUpdates.workItem === 'object') ? String((rawUpdates.workItem as Record<string, unknown>).nextAction || '') : '')
    || '',
  ).trim()

  const activity: ActivityEntry[] = [...(prev.activity || [])]

  let comments: Comment[] = [...(prev.comments || [])]
  let deletedComments: Comment[] = [...(prev.deletedComments || [])]
  let checklist: ChecklistItem[] = [...(prev.checklist || [])]
  let addedComment: Comment | null = null
  const base = { taskId: id, taskTitle: prev.title, actor }

  if (_editCommentId) {
    const prevComment = comments.find(c => c.id === _editCommentId)
    const nextText = String(_editCommentText || '').trim()
    if (prevComment && nextText) {
      comments = comments.map(c => c.id === _editCommentId ? { ...c, text: nextText, createdAt: c.createdAt || c.timestamp || now, timestamp: c.timestamp || c.createdAt || now } : c)
      activity.push({ ...base, type: 'comment', message: 'Comment edited', timestamp: now, commentId: _editCommentId })
    }
  }

  if (_deleteCommentId) {
    const toDelete = comments.find(c => c.id === _deleteCommentId)
    comments = comments.filter(c => c.id !== _deleteCommentId)
    if (toDelete) {
      deletedComments.push({ ...toDelete, deletedAt: now })
    }
    activity.push({ ...base, type: 'comment', message: 'Comment deleted', timestamp: now, commentId: toDelete?.id })
  }

  if (_restoreCommentId) {
    const toRestore = deletedComments.find(c => c.id === _restoreCommentId)
    deletedComments = deletedComments.filter(c => c.id !== _restoreCommentId)
    if (toRestore) {
      const restored: Comment = { ...toRestore, deletedAt: undefined }
      comments.push(restored)
      activity.push({ ...base, type: 'comment', message: 'Comment restored', timestamp: now, commentId: toRestore.id })
    }
  }
  if (_comment) {
    const requestedCommentId = String(body._commentId || '').trim().toLowerCase()
    const commentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedCommentId)
      ? requestedCommentId
      : crypto.randomUUID()
    const existingComment = comments.find((comment) => comment.id === commentId)
    if (existingComment && existingComment.text !== _comment) {
      return NextResponse.json({ error: 'Comment id was already used for different content' }, { status: 409 })
    }
    if (!existingComment) {
      const comment: Comment = { id: commentId, text: _comment, createdAt: now, timestamp: now, author: actor }
      comments.push(comment)
      addedComment = comment
      activity.push({ type: 'comment', message: `Commented: "${_comment.slice(0, 60)}${_comment.length > 60 ? '...' : ''}"`, timestamp: now, ...base })
    }
  }
  if (_checklistAdd) {
    const item: ChecklistItem = {
      id: Date.now().toString(),
      text: String(_checklistAdd.text || ''),
      done: false,
      assignee: _checklistAdd.assignee ? String(_checklistAdd.assignee) : undefined,
      agentId: _checklistAdd.agentId ? String(_checklistAdd.agentId) : undefined,
      dueDate: _checklistAdd.dueDate ? String(_checklistAdd.dueDate) : undefined,
    }
    checklist.push(item)
    activity.push({ type: 'checklist', message: `Checklist item added: "${_checklistAdd.text}"`, timestamp: now, ...base })
  }
  if (_checklistToggle) {
    checklist = checklist.map(c => c.id === _checklistToggle ? { ...c, done: !c.done } : c)
    const item = checklist.find(c => c.id === _checklistToggle)
    if (item) activity.push({ type: 'checklist', message: `"${item.text}" marked ${item.done ? 'complete' : 'incomplete'}`, timestamp: now, ...base })
  }
  if (_checklistDelete) {
    const item = checklist.find(c => c.id === _checklistDelete)
    checklist = checklist.filter(c => c.id !== _checklistDelete)
    if (item) activity.push({ type: 'checklist', message: `Checklist item removed: "${item.text}"`, timestamp: now, ...base })
  }
  if (_checklistUpdate?.id) {
    checklist = checklist.map(c => c.id === _checklistUpdate.id ? {
      ...c,
      text: _checklistUpdate.text !== undefined ? String(_checklistUpdate.text) : c.text,
      assignee: _checklistUpdate.assignee !== undefined ? (String(_checklistUpdate.assignee || '') || undefined) : c.assignee,
      agentId: _checklistUpdate.agentId !== undefined ? (String(_checklistUpdate.agentId || '') || undefined) : c.agentId,
      dueDate: _checklistUpdate.dueDate !== undefined ? (String(_checklistUpdate.dueDate || '') || undefined) : c.dueDate,
    } : c)
    const item = checklist.find(c => c.id === _checklistUpdate.id)
    if (item) activity.push({ type: 'checklist', message: `Checklist item updated: "${item.text}"`, timestamp: now, ...base })
  }
  let execution = prev.execution
  if (hasNextActionUpdate) {
    const nextResult = {
      ...((execution?.lastResult && typeof execution.lastResult === 'object') ? execution.lastResult as Record<string, unknown> : {}),
      nextAction: requestedNextAction || undefined,
    }
    execution = {
      ...(execution || {}),
      lastResult: nextResult,
      latestExecutionNote: requestedNextAction ? `Next action: ${requestedNextAction}` : execution?.latestExecutionNote,
      lastUpdatedAt: now,
    }
  }
  if (_suggestionAction && typeof _suggestionAction === 'object') {
    const action = String(_suggestionAction.action || '').toLowerCase()
    const suggestion = _suggestionAction.suggestion || {}
    const suggestions = Array.isArray(execution?.suggestions) ? [...execution.suggestions] : []
    const suggestionIndex = suggestions.findIndex((item) => {
      if (!item || typeof item !== 'object') return false
      const candidate = item as Record<string, unknown>
      return candidate.title === suggestion.title && candidate.timestamp === suggestion.timestamp
    })
    const target = suggestionIndex >= 0 && suggestions[suggestionIndex] && typeof suggestions[suggestionIndex] === 'object'
      ? suggestions[suggestionIndex] as Record<string, unknown>
      : null

    if (target) {
      if (action === 'comment') {
        const text = `Agent suggestion: ${String(target.title || '')}\nSummary: ${String(target.summary || '')}\nReason: ${String(target.reason || '')}`
        const comment: Comment = { id: Date.now().toString(), text, createdAt: now, timestamp: now, author: actor }
        comments.push(comment)
        activity.push({ type: 'comment', message: `Agent suggestion converted to comment: "${String(target.title || '')}"`, timestamp: now, ...base })
      }

      if (action === 'checklist') {
        const text = `${String(target.title || '')} — ${String(target.summary || '')}`.trim()
        const suggestedAgent = normalizeProductAgentId(typeof target.suggestedAgent === 'string' ? target.suggestedAgent : undefined, { category: prev.category, tags: prev.tags })
        const item: ChecklistItem = {
          id: Date.now().toString(),
          text,
          done: false,
          agentId: suggestedAgent,
          assignee: suggestedAgent,
        }
        checklist.push(item)
        activity.push({ type: 'checklist', message: `Agent suggestion converted to checklist: "${String(target.title || '')}"`, timestamp: now, ...base })
      }

      if (action === 'task') {
        const allowSuggestionTaskCreate = process.env.ENABLE_SUGGESTION_TASK_CREATE === 'true'
        if (!allowSuggestionTaskCreate) {
          activity.push({ type: 'updated', message: `Suggestion-to-task creation blocked by containment guard: "${String(target.title || '')}"`, timestamp: now, ...base })
        } else {
          const newId = Date.now().toString()
          const title = String(target.title || 'Agent suggestion')
          const desc = `${String(target.summary || '')}\n\nReason: ${String(target.reason || '')}`.trim()
          const newTask: Task = {
            id: newId,
            title,
            desc,
            status: 'backlog',
            priority: 'medium',
            category: prev.category || 'clawpilot',
            tags: ['agents', 'suggestion'],
            assignedAgent: normalizeProductAgentId(typeof target.suggestedAgent === 'string' ? target.suggestedAgent : undefined, { category: prev.category, tags: prev.tags }),
            createdAt: now,
            updatedAt: now,
            activity: [{ type: 'created', message: 'Card created from agent suggestion', timestamp: now, actor, taskId: newId, taskTitle: title }],
            comments: [],
            checklist: [],
          }
          tasks.push(newTask)
          activity.push({ type: 'updated', message: `Agent suggestion converted to task: "${String(target.title || '')}"`, timestamp: now, ...base })
        }
      }

      if (action === 'dismiss') {
        activity.push({ type: 'updated', message: `Agent suggestion dismissed: "${String(target.title || '')}"`, timestamp: now, ...base })
      }

      const taskConversionApplied = action === 'task' && process.env.ENABLE_SUGGESTION_TASK_CREATE === 'true'
      if (suggestionIndex >= 0 && (['comment', 'checklist', 'dismiss'].includes(action) || taskConversionApplied)) {
        suggestions.splice(suggestionIndex, 1)
        execution = { ...(execution || {}), suggestions: suggestions.length > 0 ? suggestions : undefined }
      }
    }
  }
  if (_execution && typeof _execution === 'object') {
    const prevStatus = execution?.executionStatus as ExecutionStatus | undefined
    const requestedStatus = typeof _execution.executionStatus === 'string' ? _execution.executionStatus as ExecutionStatus : undefined
    const nextStatus = requestedStatus ? normalizeExecutionStatus(prevStatus, requestedStatus) : prevStatus
    const nextExecution = { ...(execution || {}), ..._execution, ...(nextStatus ? { executionStatus: nextStatus } : {}) }
    if (!nextExecution.startedAt) nextExecution.startedAt = now
    nextExecution.lastUpdatedAt = now
    execution = nextExecution
    if (nextStatus && nextStatus !== prevStatus) {
      activity.push({ type: 'updated', message: `Execution status: ${nextStatus}`, timestamp: now, ...base })
    }
  }
  if (_agentDispatchState && execution?.agentDispatch?.id === String(_agentDispatchState.id || '')) {
    const dispatchStatus = _agentDispatchState.status
    if (dispatchStatus && ['queued', 'running', 'succeeded', 'failed'].includes(dispatchStatus)) {
      const previousDispatchStatus = execution.agentDispatch.status
      const error = String(_agentDispatchState.error || '').trim().slice(0, 1000) || undefined
      const semanticStatus = String(execution.executionStatus || '') as ExecutionStatus
      const preservedSuccessStatus = ['running', 'triaged', 'responded', 'blocked', 'awaiting_input', 'completed'].includes(semanticStatus)
        ? semanticStatus
        : 'responded'
      const executionStatus = dispatchStatus === 'running'
        ? 'running'
        : dispatchStatus === 'succeeded'
          ? preservedSuccessStatus
          : dispatchStatus === 'failed'
            ? 'blocked'
            : 'queued'
      const note = dispatchStatus === 'running'
        ? 'Agent run is processing.'
        : dispatchStatus === 'failed'
          ? `Agent run failed: ${error || 'Unknown execution error'}`
          : dispatchStatus === 'queued' && error
            ? `Agent run retry scheduled: ${error}`
            : dispatchStatus === 'succeeded' && !execution.latestExecutionNote
              ? 'Agent response recorded; no completion evidence was reported.'
              : undefined
      execution = {
        ...execution,
        executionStatus,
        lastUpdatedAt: now,
        ...(note ? { latestExecutionNote: note } : {}),
        agentDispatch: {
          ...execution.agentDispatch,
          status: dispatchStatus,
          attempts: Math.max(execution.agentDispatch.attempts, Math.trunc(Number(_agentDispatchState.attempts) || 0)),
          updatedAt: now,
          ...(error ? { error } : { error: undefined }),
        },
      }
      if (dispatchStatus !== previousDispatchStatus) {
        activity.push({
          type: 'updated',
          message: `Agent dispatch ${dispatchStatus}.`,
          timestamp: now,
          ...base,
        })
      }
    }
  }
  if (updates.status && updates.status !== prev.status)
    activity.push({ type: 'moved', from: prev.status, to: updates.status, message: `Moved from ${({'backlog':'Backlog','todo':'To Do','in-progress':'In Progress','review':'Review','done':'Done'} as Record<string,string>)[prev.status]||prev.status} to ${({'backlog':'Backlog','todo':'To Do','in-progress':'In Progress','review':'Review','done':'Done'} as Record<string,string>)[updates.status]||updates.status}`, timestamp: now, ...base })
  if (updates.title && updates.title !== prev.title)
    activity.push({ type: 'updated', message: `Title updated to "${updates.title}"`, timestamp: now, ...base })
  if (updates.desc !== undefined && updates.desc !== prev.desc)
    activity.push({ type: 'updated', message: 'Description updated', timestamp: now, ...base })
  const prevAssigned = prev.assignedAgent
  if (hasAssignedAgentUpdate && updates.assignedAgent !== prevAssigned)
    activity.push({ type: 'updated', message: updates.assignedAgent ? `Assigned to ${updates.assignedAgent}` : 'Assignment cleared', timestamp: now, ...base })
  if (updates.dueDate !== undefined && updates.dueDate !== prev.dueDate)
    activity.push({ type: 'updated', message: updates.dueDate ? `Due date set to ${updates.dueDate}` : 'Due date removed', timestamp: now, ...base })
  if (updates.tags) {
    const prevTags = new Set(prev.tags || []), newTags = new Set(updates.tags as string[])
    for (const tag of newTags) if (!prevTags.has(tag)) activity.push({ type: 'label_added', message: `Label "${tag}" added`, timestamp: now, ...base })
    for (const tag of prevTags) if (!newTags.has(tag)) activity.push({ type: 'label_removed', message: `Label "${tag}" removed`, timestamp: now, ...base })
  }
  if (updates.priority && updates.priority !== prev.priority)
    activity.push({ type: 'updated', message: `Priority changed to ${updates.priority}`, timestamp: now, ...base })
  if (updates.category && updates.category !== prev.category)
    activity.push({ type: 'updated', message: `Category changed to ${updates.category}`, timestamp: now, ...base })

  if (prev.crm && (body._archive || body._unarchive || body._deletePermanent)) {
    return NextResponse.json({ error: 'CRM cards follow the lifecycle of their CRM record' }, { status: 409 })
  }
  if (body._archive) {
    tasks[idx] = { ...prev, ...updates, execution, archived: true, archivedAt: now, comments, deletedComments, checklist, activity: [...activity, { type: 'archived', message: 'Card archived', timestamp: now, ...base }], updatedAt: now }
    await writeTasks(tasks, board?.id)
    return NextResponse.json(tasks[idx])
  }
  if (body._unarchive) {
    tasks[idx] = { ...prev, ...updates, execution, archived: false, archivedAt: undefined, comments, deletedComments, checklist, activity: [...activity, { type: 'unarchived', message: 'Card restored to board', timestamp: now, ...base }], updatedAt: now }
    await writeTasks(tasks, board?.id)
    return NextResponse.json(tasks[idx])
  }
  if (body._deletePermanent) {
    if (!prev.archived) return NextResponse.json({ error: 'Card must be archived before permanent delete' }, { status: 400 })
    const deleteReason = String(_deleteReason || '').trim() || 'No reason provided'
    const deletedEntry = {
      id: prev.id,
      boardId: board?.id || prev.boardId || null,
      title: prev.title,
      category: prev.category,
      deletedAt: now,
      actor,
      deleteReason,
      archivedAt: prev.archivedAt || null,
      activity: [...activity, { type: 'deleted', message: `Card permanently deleted (${deleteReason})`, timestamp: now, ...base }],
    }
    const existingDeleted = fs.existsSync(DELETED_TASKS_FILE) ? JSON.parse(fs.readFileSync(DELETED_TASKS_FILE, 'utf-8')) : []
    const nextDeleted = Array.isArray(existingDeleted) ? existingDeleted : []
    nextDeleted.push(deletedEntry)
    fs.writeFileSync(DELETED_TASKS_FILE, JSON.stringify(nextDeleted, null, 2))
    const remaining = tasks.filter(t => t.id !== id)
    await writeTasks(remaining, board?.id)
    return NextResponse.json({ ok: true })
  }
  let nextTask: Task = { ...prev, ...updates, execution, comments, deletedComments, checklist, activity, updatedAt: now }
  nextTask = crmCard
    ? normalizeCrmBoardCard(nextTask) as Task
    : applyCanonicalWorkItem(nextTask)

  if (!crmCard && isActiveColumnStatus(nextTask.status)) {
    const missing = deriveMissingActionableFields(nextTask)
    if (missing.length > 0) {
      return NextResponse.json({
        error: 'Active task is missing required operating context',
        blocked: true,
        policyCode: 'TASK_NOT_ACTIONABLE',
        operatorMessage: `Add ${missing.join(', ')} before moving this task into active work.`,
        actionabilityGuard: {
          blocked: true,
          message: `Missing: ${missing.join(', ')}`,
          missing,
        },
      }, { status: 409 })
    }
  }

  const agentDispatches: AgentDispatchEnqueueInput[] = []
  if (board && isPostgresTaskStoreEnabled() && !crmCard) {
    const targetAgent = String(nextTask.assignedAgent || '')
    if (hasAssignedAgentUpdate && targetAgent && targetAgent !== prevAssigned) {
      const prepared = prepareAgentDispatch({
        operatorId: actor,
        boardId: board.id,
        task: nextTask,
        agentId: targetAgent,
        text: assignmentKickoffText(),
        trigger: 'assignment',
        queuedAt: now,
      })
      nextTask = prepared.task
      agentDispatches.push(prepared.dispatch)
    }
    if (addedComment && targetAgent && commentTargetsAssignedAgent(addedComment.text, targetAgent)) {
      const prepared = prepareAgentDispatch({
        operatorId: actor,
        boardId: board.id,
        task: nextTask,
        agentId: targetAgent,
        text: addedComment.text,
        trigger: 'comment',
        eventId: addedComment.id,
        queuedAt: now,
      })
      nextTask = prepared.task
      agentDispatches.push(prepared.dispatch)
    }
  }

  tasks[idx] = crmCard
    ? normalizeCrmBoardCard(nextTask) as Task
    : applyCanonicalWorkItem(nextTask)
  await writeTasks(tasks, board?.id, agentDispatches)
  return NextResponse.json(tasks[idx])
}
