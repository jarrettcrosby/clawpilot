import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { reconcileAssignments, buildAutoPickupPlan } from '@/lib/autoPickupService'
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

export async function POST() {
  const tasks = readTasks()
  const reconciled = reconcileAssignments(tasks)
  if (reconciled.changed) await writeTasks(reconciled.tasks)
  const plan = buildAutoPickupPlan(reconciled.tasks)
  return NextResponse.json({ ok: true, changed: reconciled.changed, eligibleCount: plan.eligible.length, dispatchCount: plan.dispatches.length, queueCount: Object.keys(plan.queues || {}).length, plan })
}
