import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import type { Task, Comment, ActivityEntry } from '@/lib/types'
import { ensureNotFrozen } from '@/lib/freeze'
import { getAutoPickupEligibility } from '@/lib/taskState'
import { normalizeProductAgentId, resolveExecutionAgentForControlAgent } from '@/lib/agents/routing'
import { withFileLock } from '@/lib/fileLock'

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

export async function POST(req: NextRequest, ctx: { params: Promise<{ taskId: string }> }) {
  const freeze = ensureNotFrozen()
  if (freeze) return NextResponse.json(freeze, { status: 423 })

  const { taskId: rawTaskId } = await ctx.params
  const taskId = String(rawTaskId || '').trim()
  if (!taskId) return NextResponse.json({ ok: false, error: 'taskId required' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const productAgentId = normalizeProductAgentId(String(body?.productAgentId || body?.agentId || ''))
  if (!productAgentId) return NextResponse.json({ ok: false, error: 'agentId required' }, { status: 400 })

  const executionAgentId = String(body?.executionAgentId || resolveExecutionAgentForControlAgent(productAgentId) || '').trim() || productAgentId
  const actor = String(body?.actor || productAgentId || 'ClawPilot')
  const tasks = readTasks()
  const idx = tasks.findIndex(t => String(t.id) === taskId)
  if (idx === -1) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

  const task = tasks[idx]
  const eligibility = getAutoPickupEligibility(task)
  if (!eligibility.eligible) {
    return NextResponse.json({ ok: false, error: 'not_eligible', reasons: eligibility.reasons }, { status: 409 })
  }

  const now = new Date().toISOString()
  const execution = {
    ...(task.execution || {}),
    assignedAgent: executionAgentId,
    assignedAt: now,
    executionStatus: task.execution?.executionStatus || 'queued',
  }

  const commentText = `Execution claim: ${executionAgentId} claimed this task for execution.`
  const comment: Comment = { id: Date.now().toString(), text: commentText, createdAt: now, timestamp: now, author: actor }
  const activity: ActivityEntry[] = [
    ...(task.activity || []),
    { type: 'comment', message: `Commented: "${commentText.slice(0, 60)}${commentText.length > 60 ? '...' : ''}"`, timestamp: now, actor, taskId, taskTitle: task.title },
  ]

  const updated: Task = {
    ...task,
    assignedAgent: productAgentId,
    execution,
    comments: [...(task.comments || []), comment],
    activity,
    updatedAt: now,
  }

  tasks[idx] = updated
  await writeTasks(tasks)

  return NextResponse.json({ ok: true, task: updated })
}
