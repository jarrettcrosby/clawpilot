import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { buildAutoPickupPlan, reconcileAssignments } from '@/lib/autoPickupService'

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

export async function GET() {
  const tasks = readTasks()
  const reconciled = reconcileAssignments(tasks)
  const plan = buildAutoPickupPlan(reconciled.tasks)
  return NextResponse.json(
    {
      eligibleCount: plan.eligible.length,
      dispatchCount: plan.dispatches.length,
      skipCount: plan.skipped.length,
      queueCount: Object.keys(plan.queues || {}).length,
      wouldChange: reconciled.changed,
      plan,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  )
}
