import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { isPostgresExecutionStoreEnabled, listExecutionResultsFromPostgres } from '@/lib/persistence/execution'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const EXECUTION_LOG_FILE = process.env.EXECUTION_RESULTS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'execution-results.jsonl')
type JsonLineRecord = Record<string, unknown>

function readJsonl(filePath: string): JsonLineRecord[] {
  try {
    if (!fs.existsSync(filePath)) return []
    const raw = fs.readFileSync(filePath, 'utf-8')
    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const taskId = searchParams.get('taskId')
  const limit = Math.min(Number(searchParams.get('limit') || 5), 20)
  if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 })

  let entries: JsonLineRecord[] | null = null
  if (isPostgresExecutionStoreEnabled()) {
    try {
      entries = await listExecutionResultsFromPostgres({ taskId, limit })
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[execution-results] Postgres read failed; falling back to file store', error)
    }
  }

  if (!entries) {
    entries = readJsonl(EXECUTION_LOG_FILE)
      .filter((entry) => entry.taskId === taskId)
      .slice(-limit)
      .reverse()
  }

  return NextResponse.json({ taskId, entries })
}
