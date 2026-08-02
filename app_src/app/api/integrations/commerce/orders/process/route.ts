import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { commerceIntakeRuntimeAvailable } from '@/lib/integrations/commerceIntake'
import { processCommerceOrderReconciliation } from '@/lib/commerceOrderReconciliationWorker'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  recordCommerceOrderReconciliationWorkerHeartbeatInPostgres,
} from '@/lib/persistence/commerceOrderReconciliation'

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
  if (!commerceIntakeRuntimeAvailable()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'commerce-intake-disabled',
    })
  }
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'Commerce order reconciliation requires Postgres storage' },
      { status: 409 },
    )
  }
  const body = await req.json().catch(() => ({})) as { limit?: number }
  const workerId = String(
    process.env.RAILWAY_REPLICA_ID
    || process.env.HOSTNAME
    || crypto.randomUUID(),
  ).slice(0, 200)
  await recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
    phase: 'started',
    workerId,
    providerReadOnly: true,
    localCanonicalOrderWritesPossible: true,
    providerWrites: 0,
  })
  try {
    const result = await processCommerceOrderReconciliation({ limit: body.limit })
    const heartbeat =
      await recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
        phase: 'completed',
        workerId,
        ...result,
      })
    return NextResponse.json({
      ok: true,
      ...result,
      heartbeatAt: heartbeat.checkedAt,
    })
  } catch (error) {
    await recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
      phase: 'failed',
      workerId,
      providerReadOnly: true,
      localCanonicalOrderWritesPossible: true,
      providerWrites: 0,
    }).catch(() => undefined)
    throw error
  }
}
