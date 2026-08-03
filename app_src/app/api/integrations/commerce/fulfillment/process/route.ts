import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  commerceFulfillmentRecoveryRuntimeAvailable,
  processCommerceFulfillmentRecovery,
} from '@/lib/commerceFulfillmentRecoveryWorker'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readCommerceFulfillmentRecoveryHealthInPostgres,
  recordCommerceFulfillmentRecoveryHeartbeatInPostgres,
} from '@/lib/persistence/commerceFulfillmentRecovery'

export const runtime = 'nodejs'
export const maxDuration = 300

function authorized(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
  if (expected.length < 32 || !provided) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!commerceFulfillmentRecoveryRuntimeAvailable()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'commerce-fulfillment-recovery-disabled',
    })
  }
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Commerce fulfillment recovery requires Postgres storage',
      },
      { status: 409 },
    )
  }
  const body = await req.json().catch(() => ({})) as { limit?: number }
  const workerId = String(
    process.env.RAILWAY_REPLICA_ID
    || process.env.HOSTNAME
    || crypto.randomUUID(),
  ).slice(0, 200)
  await recordCommerceFulfillmentRecoveryHeartbeatInPostgres({
    phase: 'started',
    workerId,
  })
  try {
    const result = await processCommerceFulfillmentRecovery({
      limit: body.limit,
      workerId,
    })
    const queue = await readCommerceFulfillmentRecoveryHealthInPostgres()
    const heartbeat =
      await recordCommerceFulfillmentRecoveryHeartbeatInPostgres({
        phase: 'completed',
        workerId,
        ...result,
        automaticCeilingReached: queue.automaticCeilingReached,
        manualReviewFailures: queue.manualReviewFailures,
      })
    return NextResponse.json({
      ok: true,
      ...result,
      queue,
      heartbeatAt: heartbeat.checkedAt,
    })
  } catch (error) {
    await recordCommerceFulfillmentRecoveryHeartbeatInPostgres({
      phase: 'failed',
      workerId,
    }).catch(() => undefined)
    throw error
  }
}
