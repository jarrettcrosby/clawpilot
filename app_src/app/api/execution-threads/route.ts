import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { isPostgresExecutionStoreEnabled } from '@/lib/persistence/execution'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const EXECUTION_THREADS_FILE = process.env.EXECUTION_THREADS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'execution-threads.jsonl')
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
  if (isPostgresExecutionStoreEnabled()) {
    return NextResponse.json({ error: 'Legacy execution threads are disabled; use task agent threads' }, { status: 410 })
  }
  const { searchParams } = new URL(req.url)
  const taskId = searchParams.get('taskId')
  const limit = Math.min(Number(searchParams.get('limit') || 3), 10)
  if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 })

  const entries = readJsonl(EXECUTION_THREADS_FILE)
    .filter((entry) => entry.taskId === taskId)
    .slice(-limit)
    .reverse()

  return NextResponse.json({ taskId, entries })
}
