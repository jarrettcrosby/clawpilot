import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { buildCanonicalWorkItem } from '@/lib/workItemModel'

const PIPELINE_FILE = process.env.PIPELINE_NORMALIZED_PATH || path.join(process.cwd(), '..', 'data', 'pipeline', 'normalized', 'current.json')
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

function pipelineWorkItemsFromTasks(tasks: Task[]) {
  return tasks
    .filter((task) => {
      const tags = Array.isArray(task.tags) ? task.tags.map((t) => String(t).toLowerCase()) : []
      return String(task.category || '').toLowerCase() === 'pipeline' || tags.includes('pipeline')
    })
    .map((task) => ({
      taskId: String(task.id),
      title: String(task.title || ''),
      ...buildCanonicalWorkItem(task),
      updatedAt: task.updatedAt,
    }))
}

export async function GET() {
  try {
    if (!fs.existsSync(PIPELINE_FILE)) {
      return NextResponse.json({
        syncedAt: null,
        summary: { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
        opportunities: [],
        workItems: pipelineWorkItemsFromTasks(readTasks()),
        error: 'Pipeline data not synced yet',
      })
    }

    const raw = fs.readFileSync(PIPELINE_FILE, 'utf-8')
    const data = JSON.parse(raw)

    return NextResponse.json({
      syncedAt: data.syncedAt || null,
      summary: data.summary || { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
      opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
      workItems: pipelineWorkItemsFromTasks(readTasks()),
    })
  } catch (e: unknown) {
    return NextResponse.json({
      syncedAt: null,
      summary: { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
      opportunities: [],
      workItems: pipelineWorkItemsFromTasks(readTasks()),
      error: String(e),
    }, { status: 500 })
  }
}
