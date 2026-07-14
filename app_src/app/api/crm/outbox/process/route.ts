import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { processSuiteCrmOutbox } from '@/lib/crm/worker'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'

export const runtime = 'nodejs'

function authorized(req: NextRequest) {
  const expected = process.env.PIPELINE_OUTBOX_WORKER_SECRET || ''
  const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!expected || !provided) return false
  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  if (!isPostgresStorageEnabled()) return NextResponse.json({ ok: false, error: 'CRM outbox requires Postgres storage' }, { status: 409 })
  const body = await req.json().catch(() => ({})) as { limit?: number }
  const result = await processSuiteCrmOutbox({ limit: body.limit })
  return NextResponse.json({ ok: true, ...result })
}
