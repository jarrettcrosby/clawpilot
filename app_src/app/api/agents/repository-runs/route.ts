import { NextRequest, NextResponse } from 'next/server'
import { getRepositoryRunnerConfiguration, requireRepositoryRunnerConfiguration } from '@/lib/agents/repositoryRunnerConfig'
import { isCrmBoardCard } from '@/lib/crm/boardCard.mjs'
import { readTasksFromPostgres } from '@/lib/persistence/tasks'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  createRepositoryRunInPostgres,
  latestRepositoryRunForTask,
  RepositoryRunConflictError,
} from '@/lib/persistence/repositoryRuns'
import { requireRequestUser } from '@/lib/requestUser'
import {
  BOARD_SELECTION_COOKIE,
  requireResourceEditor,
  resolveProjectBoardAccess,
} from '@/lib/tenancy'

function clean(value: unknown, limit: number): string {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, limit)
}

async function requestContext(req: NextRequest, requireEdit: boolean) {
  const actor = await requireRequestUser(req)
  const selected = req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
  const board = await resolveProjectBoardAccess({ actorEmail: actor, boardId: selected })
    .catch(() => resolveProjectBoardAccess({ actorEmail: actor }))
  if (requireEdit) requireResourceEditor(board)
  return { actor, board }
}

export async function GET(req: NextRequest) {
  try {
    const { board } = await requestContext(req, false)
    const taskId = clean(new URL(req.url).searchParams.get('taskId'), 240)
    if (!taskId) return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
    const configuration = getRepositoryRunnerConfiguration()
    const run = isPostgresStorageEnabled()
      ? await latestRepositoryRunForTask({ boardId: board.id, taskId })
      : null
    return NextResponse.json({
      runner: {
        enabled: configuration.enabled,
        ready: configuration.ready,
        reason: configuration.reason,
        repository: configuration.repositoryFullName,
        baseBranch: configuration.baseBranch,
        patchOnly: true,
      },
      run,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read repository-run status'
    const status = /Unauthorized/i.test(message) ? 401 : /access|editor|viewer/i.test(message) ? 403 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { actor, board } = await requestContext(req, true)
    const configuration = requireRepositoryRunnerConfiguration()
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const taskId = clean(body.taskId, 240)
    if (!taskId) return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
    const tasks = await readTasksFromPostgres({ boardId: board.id })
    const task = tasks.find((entry) => String(entry.id) === taskId && !isCrmBoardCard(entry))
    if (!task) return NextResponse.json({ error: 'Task was not found on this project board' }, { status: 404 })
    if (!task.assignedAgent) {
      return NextResponse.json({ error: 'Assign the task to an agent before generating a repository patch' }, { status: 422 })
    }
    const operatorInstruction = clean(body.instruction, 4000)
      || clean(task.workItem?.nextAction, 4000)
      || 'Implement the task as described and provide the smallest validated patch.'
    const checklist = (task.checklist || []).map((item) => `${item.done ? '[x]' : '[ ]'} ${clean(item.text, 240)}`).join('\n')
    const instruction = [
      'Generate a reviewable patch for this ClawPilot repository task.',
      `Task ID: ${task.id}`,
      `Task title: ${clean(task.title, 500)}`,
      `Assigned product agent: ${task.assignedAgent}`,
      `Task description:\n${clean(task.desc, 6000) || 'No description supplied.'}`,
      checklist ? `Checklist:\n${checklist}` : 'Checklist: none',
      `Operator instruction:\n${operatorInstruction}`,
      'Work only inside the checked-out repository. Do not access external customer data, credentials, browser sessions, email, calendar, CRM, deployment systems, or unrelated task history. Do not push, merge, deploy, or create a pull request. Make the smallest coherent change, add focused tests, and leave a clean git diff for validation.',
    ].join('\n\n').slice(0, 12_000)
    const run = await createRepositoryRunInPostgres({
      boardId: board.id,
      actorEmail: actor.email,
      taskId,
      instruction,
      configuration,
    })
    return NextResponse.json({ ok: true, queued: true, run }, { status: 202 })
  } catch (error) {
    if (error instanceof RepositoryRunConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    const message = error instanceof Error ? error.message : 'Unable to queue repository work'
    const status = /disabled|configuration is incomplete|not configured/i.test(message)
      ? 503
      : /Unauthorized/i.test(message)
        ? 401
        : /access|editor|viewer/i.test(message)
          ? 403
          : 400
    return NextResponse.json({ error: message }, { status })
  }
}
