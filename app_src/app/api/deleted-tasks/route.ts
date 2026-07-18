import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { isPostgresTaskStoreEnabled } from '@/lib/persistence/tasks'
import { requireRequestUser } from '@/lib/requestUser'
import { BOARD_SELECTION_COOKIE, resolveProjectBoardAccess } from '@/lib/tenancy'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const DELETED_TASKS_FILE = path.join(path.dirname(TASKS_FILE), 'deleted-tasks.json')

export async function GET(req: NextRequest) {
  try {
    if (!fs.existsSync(DELETED_TASKS_FILE)) return NextResponse.json([])
    const raw = fs.readFileSync(DELETED_TASKS_FILE, 'utf-8')
    const data = JSON.parse(raw)
    const rows = Array.isArray(data) ? data : []
    if (!isPostgresTaskStoreEnabled()) return NextResponse.json(rows)
    const actor = await requireRequestUser(req)
    const selected = req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
    const board = await resolveProjectBoardAccess({ actorEmail: actor, boardId: selected })
      .catch(() => resolveProjectBoardAccess({ actorEmail: actor }))
    return NextResponse.json(rows.filter((row) => String(row?.boardId || '') === board.id))
  } catch {
    return NextResponse.json([])
  }
}
