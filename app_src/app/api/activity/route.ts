import { NextRequest, NextResponse } from 'next/server'
import { authorizeActivityScope, readActivityLog } from '@/lib/audit'
import { requireRequestUser } from '@/lib/requestUser'

function parseCursor(value: string | null): { snapshotAt: string; offset: number } {
  if (!value) return { snapshotAt: new Date().toISOString(), offset: 0 }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { snapshotAt?: unknown; offset?: unknown }
    const snapshotAt = String(parsed.snapshotAt || '')
    const offset = Math.trunc(Number(parsed.offset))
    if (!Number.isFinite(Date.parse(snapshotAt)) || !Number.isFinite(offset) || offset < 0 || offset > 5000) throw new Error('Invalid cursor')
    return { snapshotAt: new Date(snapshotAt).toISOString(), offset }
  } catch {
    throw new Error('Invalid activity cursor')
  }
}

function encodeCursor(snapshotAt: string, offset: number): string {
  return Buffer.from(JSON.stringify({ snapshotAt, offset })).toString('base64url')
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const params = new URL(req.url).searchParams
    const scope = authorizeActivityScope(actor, params.get('scope'))
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(params.get('limit')) || 100)))
    const cursor = parseCursor(params.get('cursor'))
    const page = await readActivityLog({ actor, scope, snapshotAt: cursor.snapshotAt, limit, offset: cursor.offset })
    return NextResponse.json({
      ok: true,
      ...page,
      nextCursor: page.nextOffset === null ? null : encodeCursor(cursor.snapshotAt, page.nextOffset),
      nextOffset: undefined,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load activity'
    const status = message === 'Unauthorized' ? 401 : /access denied/i.test(message) ? 403 : 500
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
