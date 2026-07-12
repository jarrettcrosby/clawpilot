import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { buildCanonicalWorkItem } from '@/lib/workItemModel'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres } from '@/lib/persistence/tasks'
import { isPostgresPipelineStoreEnabled, readPipelineProjectionFromPostgres } from '@/lib/persistence/pipeline'

const PIPELINE_FILE = process.env.PIPELINE_NORMALIZED_PATH || path.join(process.cwd(), '..', 'data', 'pipeline', 'normalized', 'current.json')
const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)

async function readTasks(): Promise<Task[]> {
  if (isPostgresTaskStoreEnabled()) {
    try {
      return await readTasksFromPostgres()
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[pipeline] Postgres task read failed; falling back to file store', error)
    }
  }

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
  const workItems = pipelineWorkItemsFromTasks(await readTasks())

  try {
    if (isPostgresPipelineStoreEnabled()) {
      try {
        const projection = await readPipelineProjectionFromPostgres()
        if (projection) {
          return NextResponse.json({
            syncedAt: projection.syncedAt || null,
            summary: projection.summary || { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
            opportunities: Array.isArray(projection.opportunities) ? projection.opportunities : [],
            workItems,
            storage: 'postgres',
          })
        }
      } catch (error) {
        if (!shouldFallbackToFileOnDatabaseError()) throw error
        console.warn('[pipeline] Postgres projection read failed; falling back to file store', error)
      }
    }

    if (!fs.existsSync(PIPELINE_FILE)) {
      return NextResponse.json({
        syncedAt: null,
        summary: { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
        opportunities: [],
        workItems,
        error: 'Pipeline data not synced yet',
      })
    }

    const raw = fs.readFileSync(PIPELINE_FILE, 'utf-8')
    const data = JSON.parse(raw)

    return NextResponse.json({
      syncedAt: data.syncedAt || null,
      summary: data.summary || { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
      opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
      workItems,
      storage: 'file',
    })
  } catch (e: unknown) {
    return NextResponse.json({
      syncedAt: null,
      summary: { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
      opportunities: [],
      workItems,
      error: String(e),
    }, { status: 500 })
  }
}
