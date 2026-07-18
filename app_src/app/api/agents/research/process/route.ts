import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { processAgentResearchOutbox } from '@/lib/agentResearchWorker'
import { recordAgentResearchWorkerHeartbeatInPostgres } from '@/lib/persistence/agentResearch'
import { isPostgresTaskStoreEnabled } from '@/lib/persistence/tasks'

export const runtime = 'nodejs'
export const maxDuration = 300

function authorized(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!expected || !provided) return false
  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  return expectedBuffer.length === providedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  if (!isPostgresTaskStoreEnabled()) {
    return NextResponse.json({ ok: false, error: 'Agent research requires Postgres storage' }, { status: 409 })
  }

  const body = await req.json().catch(() => ({})) as { limit?: number }
  const workerId = String(process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'local-worker').slice(0, 200)
  await recordAgentResearchWorkerHeartbeatInPostgres({
    phase: 'started', workerId, claimed: 0, succeeded: 0, failed: 0, dead: 0,
  })
  const result = await processAgentResearchOutbox({ limit: body.limit })
  const heartbeat = await recordAgentResearchWorkerHeartbeatInPostgres({
    phase: 'completed', workerId,
    claimed: result.claimed, succeeded: result.succeeded, failed: result.failed, dead: result.dead,
  })
  return NextResponse.json({ ok: true, ...result, heartbeatAt: heartbeat.checkedAt })
}
