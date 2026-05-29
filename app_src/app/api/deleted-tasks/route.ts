import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const DELETED_TASKS_FILE = path.join(path.dirname(TASKS_FILE), 'deleted-tasks.json')

export async function GET(_req: NextRequest) {
  try {
    if (!fs.existsSync(DELETED_TASKS_FILE)) return NextResponse.json([])
    const raw = fs.readFileSync(DELETED_TASKS_FILE, 'utf-8')
    const data = JSON.parse(raw)
    return NextResponse.json(Array.isArray(data) ? data : [])
  } catch {
    return NextResponse.json([])
  }
}
