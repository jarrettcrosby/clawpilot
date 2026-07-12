import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { Task } from '@/lib/types'
import { buildAutoPickupPlan, reconcileAssignments } from '@/lib/autoPickupService'
import { dispatchToOpenClaw } from '@/lib/dispatchBridge'
import { buildAssignmentActivity, buildAssignmentCommentText, buildExecutionCommentActivity, buildExecutionCommentText } from '@/lib/executionWriteback'
import { normalizeProductAgentId } from '@/lib/agents/routing'
import { withFileLock } from '@/lib/fileLock'
import {
  isOpenClawExecutionEnabled,
  shouldFallbackToFileOnDatabaseError,
} from '@/lib/persistence/config'
import { appendExecutionResultToPostgres, isPostgresExecutionStoreEnabled } from '@/lib/persistence/execution'
import {
  isPostgresTaskStoreEnabled,
  readTasksFromPostgres,
  replaceTasksInPostgres,
} from '@/lib/persistence/tasks'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const EXECUTION_LOG_FILE = process.env.EXECUTION_RESULTS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'execution-results.jsonl')

function readTasksFromFile(): Task[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

async function readTasks(): Promise<Task[]> {
  if (isPostgresTaskStoreEnabled()) {
    try {
      return await readTasksFromPostgres()
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[auto-pickup] Postgres task read failed; falling back to file store', error)
    }
  }
  return readTasksFromFile()
}

async function writeTasks(tasks: Task[]) {
  if (isPostgresTaskStoreEnabled()) {
    try {
      await replaceTasksInPostgres(tasks)
      return
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[auto-pickup] Postgres task write failed; falling back to file store', error)
    }
  }

  const lockPath = `${TASKS_FILE}.lock`
  await withFileLock(lockPath, () => {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2))
  })
}

async function appendExecutionLog(entry: Record<string, unknown>) {
  if (isPostgresExecutionStoreEnabled()) {
    try {
      await appendExecutionResultToPostgres(entry)
      return
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[auto-pickup] Postgres execution result append failed; falling back to file store', error)
    }
  }

  const dir = path.dirname(EXECUTION_LOG_FILE)
  fs.mkdirSync(dir, { recursive: true })
  const tempPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
  const lockPath = `${EXECUTION_LOG_FILE}.lock`
  await withFileLock(lockPath, () => {
    fs.writeFileSync(tempPath, `${JSON.stringify(entry)}\n`)
    try {
      fs.appendFileSync(EXECUTION_LOG_FILE, fs.readFileSync(tempPath))
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    }
  })
}

export async function POST() {
  if (!isOpenClawExecutionEnabled()) {
    return NextResponse.json({
      ok: false,
      error: 'OpenClaw execution is disabled for this hosted runtime.',
    }, { status: 503 })
  }

  const tasks = await readTasks()
  const reconciled = reconcileAssignments(tasks)
  if (reconciled.changed) await writeTasks(reconciled.tasks)
  const plan = buildAutoPickupPlan(reconciled.tasks)
  const now = new Date().toISOString()

  const updatedTasks: Task[] = []
  const dispatchResults: { taskId: string; status: string }[] = []

  for (const task of reconciled.tasks) {
    const dispatch = plan.dispatches.find(d => d.taskId === task.id)
    if (!dispatch || !dispatch.agentId || dispatch.agentId === 'unassigned') {
      updatedTasks.push(task)
      continue
    }

    const comments: Task['comments'] = [...(task.comments || [])]
    const activity: Task['activity'] = [...(task.activity || []), {
      type: 'updated',
      message: 'Execution status: running',
      timestamp: now,
      actor: 'ClawPilot',
      taskId: task.id,
      taskTitle: task.title,
    }]

    const assignedAt = task.execution?.assignedAt || now
    const isNewAssignment = task.execution?.assignedAgent !== dispatch.agentId || !task.execution?.assignedAt
    if (isNewAssignment) {
      const assignmentCommentId = crypto.randomUUID()
      const assignmentComment: Task['comments'][number] = {
        id: assignmentCommentId,
        text: buildAssignmentCommentText(dispatch.agentId, assignedAt, 'running'),
        author: dispatch.agentId,
        createdAt: assignedAt,
      }
      comments.push(assignmentComment)
      activity.push(buildAssignmentActivity(task, dispatch.agentId, assignmentCommentId, assignedAt))
    }

    const executionBase = {
      assignedAgent: dispatch.agentId,
      assignedAt,
      executionStatus: 'running' as NonNullable<Task['execution']>['executionStatus'],
      startedAt: task.execution?.startedAt || now,
      lastUpdatedAt: now,
      latestExecutionNote: `Auto-pickup execute-once started for ${dispatch.agentId}.`,
    }

    const interimTask: Task = {
      ...task,
      assignedAgent: normalizeProductAgentId(task.assignedAgent, { category: task.category, tags: task.tags }) || task.assignedAgent,
      status: 'in-progress' as Task['status'],
      execution: executionBase,
      comments,
      activity,
      updatedAt: now,
    }

    const result = await dispatchToOpenClaw(interimTask, dispatch.agentId)
    const finalStatus = result.status === 'blocked'
      ? 'blocked'
      : result.status === 'awaiting_input'
        ? 'awaiting_input'
        : result.status === 'completed'
          ? 'completed'
          : 'running'

    const nextActivity: Task['activity'] = [...(interimTask.activity || []), {
      type: 'updated',
      message: `Execution result: ${finalStatus}${result.summary ? ` — ${result.summary}` : ''}`,
      timestamp: new Date().toISOString(),
      actor: 'ClawPilot',
      taskId: task.id,
      taskTitle: task.title,
    }]

    const completedAt = new Date().toISOString()
    const suggestions = Array.isArray(result.suggestions)
      ? result.suggestions.map(s => ({
          title: s.title,
          summary: s.summary,
          reason: s.reason,
          suggestedAgent: s.suggestedAgent,
          timestamp: s.timestamp || completedAt,
        }))
      : []

    const updatedAtRaw = task.updatedAt || task.execution?.lastUpdatedAt || null
    let taskAgeDays: number | undefined
    if (updatedAtRaw) {
      const parsed = new Date(updatedAtRaw)
      if (!Number.isNaN(parsed.getTime())) {
        taskAgeDays = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24)))
      }
    }

    const structuredResult = {
      status: result.status,
      summary: result.summary,
      directAnswer: result.directAnswer,
      whatWasDone: result.whatWasDone,
      currentState: result.currentState,
      nextStep: result.nextStep,
      blockedReason: result.blockedReason,
      blockerClarification: result.blockerClarification,
      suggestedNextAction: result.suggestedNextAction,
      improvementRecommendation: result.improvementRecommendation,
      runId: result.runId,
    }

    const commentId = crypto.randomUUID()
    const commentText = buildExecutionCommentText({
      agentId: dispatch.agentId,
      executionStatus: finalStatus,
      summary: structuredResult.summary,
      directAnswer: structuredResult.directAnswer,
      whatWasDone: structuredResult.whatWasDone,
      currentState: structuredResult.currentState,
      nextStep: structuredResult.nextStep,
      taskAgeDays,
      blockedReason: structuredResult.blockedReason,
      blockerClarification: structuredResult.blockerClarification,
      suggestedNextAction: structuredResult.suggestedNextAction,
      improvementRecommendation: structuredResult.improvementRecommendation,
    })
    const completionComment: Task['comments'][number] = {
      id: commentId,
      text: commentText,
      author: dispatch.agentId,
      createdAt: completedAt,
    }

    const commentActivity = buildExecutionCommentActivity(task, dispatch.agentId, commentId, completedAt)

    updatedTasks.push({
      ...interimTask,
      execution: {
        ...executionBase,
        executionStatus: finalStatus as NonNullable<Task['execution']>['executionStatus'],
        lastUpdatedAt: completedAt,
        latestExecutionNote: result.summary || executionBase.latestExecutionNote,
        lastResult: structuredResult,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      },
      comments: [...(interimTask.comments || []), completionComment],
      activity: [...nextActivity, commentActivity],
      updatedAt: completedAt,
    })

    await appendExecutionLog({
      taskId: task.id,
      taskTitle: task.title,
      agentId: dispatch.agentId,
      status: result.status,
      executionStatus: finalStatus,
      summary: result.summary,
      blockedReason: result.blockedReason,
      blockerClarification: result.blockerClarification,
      suggestedNextAction: result.suggestedNextAction,
      improvementRecommendation: result.improvementRecommendation,
      runId: result.runId,
      model: result.model,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      suggestions,
      timestamp: completedAt,
    })

    dispatchResults.push({ taskId: task.id, status: result.status })
  }

  await writeTasks(updatedTasks)

  return NextResponse.json({
    eligibleCount: plan.eligible.length,
    dispatchCount: plan.dispatches.length,
    skipCount: plan.skipped.length,
    dispatches: plan.dispatches,
    results: dispatchResults,
  })
}
