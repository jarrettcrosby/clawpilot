import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { quickBooksWorkerId, recordQuickBooksWorkerHeartbeatInPostgres } from '@/lib/persistence/quickBooksIntegrations'
import { processQuickBooksSyncOutbox } from '@/lib/quickBooksSyncWorker'
import { processQuickBooksWriteOutbox } from '@/lib/quickBooksWriteWorker'

export const runtime = 'nodejs'
export const maxDuration = 300

function authorized(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (expected.length < 32 || !provided) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json({ ok: false, error: 'QuickBooks sync requires Postgres storage' }, { status: 409 })
  }
  const body = await req.json().catch(() => ({})) as { limit?: number }
  const workerId = quickBooksWorkerId()
  await recordQuickBooksWorkerHeartbeatInPostgres({ phase: 'started', workerId })
  const writes = await processQuickBooksWriteOutbox({ limit: body.limit, workerId })
  const catalog = await processQuickBooksSyncOutbox({ limit: body.limit, workerId })
  const heartbeat = await recordQuickBooksWorkerHeartbeatInPostgres({ phase: 'completed', workerId, writes, catalog })
  return NextResponse.json({ ok: true, writes, catalog, heartbeatAt: heartbeat.checkedAt })
}
