import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { isPostgresExecutionStoreEnabled, summarizeExecutionResultsFromPostgres } from '@/lib/persistence/execution'
import { requireRequestUser } from '@/lib/requestUser'
import { BOARD_SELECTION_COOKIE, resolveProjectBoardAccess } from '@/lib/tenancy'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const EXECUTION_RESULTS_FILE = process.env.EXECUTION_RESULTS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'execution-results.jsonl')

async function summarizeJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return { count: 0, last: null as unknown }

  let count = 0
  let last: unknown = null

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        last = JSON.parse(trimmed)
        count += 1
      } catch {
        // Ignore malformed JSON lines so one bad write doesn't break summary reads.
      }
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return { count, last }
}

export async function GET(req: NextRequest) {
  if (isPostgresExecutionStoreEnabled()) {
    try {
      const actor = await requireRequestUser(req)
      const selected = req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
      const board = await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: selected })
        .catch(() => resolveProjectBoardAccess({ actorEmail: actor.email }))
      return NextResponse.json(await summarizeExecutionResultsFromPostgres({ operatorId: actor.email, boardId: board.id }))
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[execution-results-summary] Postgres read failed; falling back to file store', error)
    }
  }

  const { count, last } = await summarizeJsonl(EXECUTION_RESULTS_FILE)
  return NextResponse.json({ count, last })
}
