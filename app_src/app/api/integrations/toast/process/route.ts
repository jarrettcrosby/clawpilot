import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { recordToastWorkerHeartbeatInPostgres } from '@/lib/persistence/toastIntegrations'
import { processToastSyncOutbox } from '@/lib/toastSyncWorker'

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
    return NextResponse.json({ ok: false, error: 'Toast sync requires Postgres storage' }, { status: 409 })
  }
  const body = await req.json().catch(() => ({})) as { limit?: number }
  const workerId = String(process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'local-worker').slice(0, 200)
  await recordToastWorkerHeartbeatInPostgres({ phase: 'started', workerId })
  const result = await processToastSyncOutbox({ limit: body.limit, workerId })
  const heartbeat = await recordToastWorkerHeartbeatInPostgres({ phase: 'completed', workerId, ...result })
  return NextResponse.json({ ok: true, ...result, heartbeatAt: heartbeat.checkedAt })
}
