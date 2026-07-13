import fs from 'fs/promises'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { requireRequestUser } from '@/lib/requestUser'

const REPO = path.resolve(process.cwd(), '..')
const DATA_DIR = REPO.includes('clawd-app-dev') ? 'data-dev' : 'data'
const HOSTED_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT_NAME
  || process.env.RAILWAY_ENVIRONMENT_ID
  || process.env.RAILWAY_PROJECT_ID
  || process.env.VERCEL,
)

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (actor.role !== 'owner') {
      return NextResponse.json({ ok: false, error: 'Owner access required' }, { status: 403 })
    }
    if (HOSTED_RUNTIME) {
      return NextResponse.json({ ok: false, error: 'Hosted releases are managed through GitHub deployments' }, { status: 409 })
    }

    const { hash, backup } = await req.json()
    if (hash) {
      return NextResponse.json({ ok: false, error: 'Code rollback is disabled in the web application' }, { status: 410 })
    }
    const backupName = String(backup || '').trim()
    if (!/^[A-Za-z0-9._-]+\.json$/.test(backupName)) {
      return NextResponse.json({ ok: false, error: 'A valid backup filename is required' }, { status: 400 })
    }

    const backupsDir = path.join(REPO, DATA_DIR, 'backups')
    const source = path.join(backupsDir, backupName)
    if (path.dirname(source) !== backupsDir) {
      return NextResponse.json({ ok: false, error: 'Invalid backup path' }, { status: 400 })
    }
    await fs.copyFile(source, path.join(REPO, DATA_DIR, 'tasks.json'))
    return NextResponse.json({ ok: true, message: `Restored data backup: ${backupName}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to restore backup'
    return NextResponse.json({ ok: false, error: message }, { status: message === 'Unauthorized' ? 401 : 500 })
  }
}
