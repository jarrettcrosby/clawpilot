import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

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

export async function GET(_req: NextRequest) {
  const runs = inspect(path.join(LOG_DIR, 'execution-runs.jsonl'))
  const results = inspect(path.join(LOG_DIR, 'execution-results.jsonl'))
  return NextResponse.json({ runs, results })
}
