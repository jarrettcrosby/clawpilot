import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const EXECUTION_LOG_FILE = process.env.EXECUTION_RESULTS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'execution-results.jsonl')

function readJsonl(filePath: string) {
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

  const entries = readJsonl(EXECUTION_LOG_FILE)
    .filter((entry: any) => entry?.taskId === taskId)
    .slice(-limit)
    .reverse()

  return NextResponse.json({ taskId, entries })
}
