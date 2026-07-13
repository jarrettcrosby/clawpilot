import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { inspectExecutionTablesFromPostgres, isPostgresExecutionStoreEnabled } from '@/lib/persistence/execution'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const LOG_DIR = path.join(path.dirname(TASKS_FILE), 'agents')

function inspect(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return { status: 'missing', lines: 0, malformed: 0 }
  }

  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  let malformed = 0

  for (const line of lines) {
    try {
      JSON.parse(line)
    } catch {
      malformed += 1
    }
  }

  return {
    status: malformed > 0 ? 'invalid' : 'ok',
    lines: lines.length,
    malformed,
  }
}

export async function GET() {
  if (isPostgresExecutionStoreEnabled()) {
    try {
      const summary = await inspectExecutionTablesFromPostgres()
      return NextResponse.json({ ...summary, driver: 'postgres' })
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[execution-log-integrity] Postgres read failed; falling back to file store', error)
    }
  }

  const runs = inspect(path.join(LOG_DIR, 'execution-runs.jsonl'))
  const results = inspect(path.join(LOG_DIR, 'execution-results.jsonl'))
  return NextResponse.json({ runs, results, driver: 'file' })
}
