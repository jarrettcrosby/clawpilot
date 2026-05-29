import { NextRequest, NextResponse } from 'next/server'
import type { Task } from '@/lib/types'
import { dispatchToOpenClaw } from '@/lib/dispatchBridge'
import fs from 'fs'
import path from 'path'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')

export async function GET(req: NextRequest) {
  const isDevRuntime = process.env.NODE_ENV === 'development' || fs.existsSync(DEV_TASKS_FILE)
  if (!isDevRuntime) {
    return NextResponse.json({ error: 'not available' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId') || 'nonexistent-agent'
  const taskId = `queue-selftest-${Date.now()}`

  const task: Task = {
    id: taskId,
    title: 'Execution queue selftest',
    desc: 'Selftest dispatch to validate persistent queue recovery.',
    status: 'todo',
    priority: 'medium',
    category: 'clawpilot',
    tags: ['selftest', 'execution', 'queue'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activity: [],
    comments: [],
    checklist: [],
  }

  const result = await dispatchToOpenClaw(task, agentId)
  return NextResponse.json({ runId: result.runId, status: result.status })
}
