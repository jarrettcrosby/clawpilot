import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const EXECUTION_RUNS_FILE = process.env.EXECUTION_RUNS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'execution-runs.jsonl')
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
  const runId = searchParams.get('runId')
  const limit = Math.min(Number(searchParams.get('limit') || 5), 20)

  if (!taskId && !runId) {
    return NextResponse.json({ error: 'taskId or runId required' }, { status: 400 })
  }

  const entries = readJsonl(EXECUTION_RUNS_FILE)
    .filter((entry) => {
      if (runId && entry.runId === runId) return true
      if (taskId && entry.taskId === taskId) return true
      return false
    })
    .slice(-limit)
    .reverse()

  return NextResponse.json({ taskId, runId, entries })
}
