import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  commerceReadRuntimeAvailable,
  commerceReadRuntimeMode,
} from '@/lib/integrations/commerceIntake'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import { processCommerceCatalogSyncOutbox } from '@/lib/commerceCatalogSyncWorker'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  recordCommerceCatalogWorkerHeartbeatInPostgres,
} from '@/lib/persistence/commerceCatalogSync'

export const runtime = 'nodejs'
export const maxDuration = 300

function authorized(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(
    req.headers.get('authorization') || '',
  ).replace(/^Bearer\s+/i, '')
  if (expected.length < 32 || !provided) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  return (
    left.length === right.length
    && crypto.timingSafeEqual(left, right)
  )
}

function runtimeMaintenanceResponse(error: unknown) {
  if (!isIntegrationCredentialRuntimeGateError(error)) return null
  const code = String((error as { code?: unknown }).code || '')
  return NextResponse.json({
    ok: false,
    maintenance: true,
    retryable: true,
    code,
    error: 'Integration credential runtime is temporarily unavailable',
  }, {
    status: 503,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'Retry-After': '60',
    },
  })
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 },
    )
  }
  if (!commerceReadRuntimeAvailable()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'commerce-read-reconciliation-disabled',
    })
  }
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Commerce catalog sync requires Postgres storage',
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
  await recordCommerceCatalogWorkerHeartbeatInPostgres({
    phase: 'started',
    workerId,
    runtimeMode: commerceReadRuntimeMode?.() || null,
    providerReadOnly: true,
    providerWrites: 0,
  })
  try {
    const result = await processCommerceCatalogSyncOutbox({
      limit: body.limit,
      workerId,
    })
    const heartbeat = await recordCommerceCatalogWorkerHeartbeatInPostgres({
      phase: 'completed',
      workerId,
      ...result,
      runtimeMode: commerceReadRuntimeMode?.() || null,
      providerReadOnly: true,
      providerWrites: 0,
    })
    return NextResponse.json({
      ok: true,
      ...result,
      heartbeatAt: heartbeat.checkedAt,
    })
  } catch (error) {
    const maintenance = runtimeMaintenanceResponse(error)
    if (maintenance) {
      await recordCommerceCatalogWorkerHeartbeatInPostgres({
        phase: 'maintenance',
        workerId,
        errorCode: String((error as { code?: unknown }).code || ''),
        runtimeMode: commerceReadRuntimeMode?.() || null,
        providerReadOnly: true,
        providerWrites: 0,
      }).catch(() => undefined)
      return maintenance
    }
    throw error
  }
}
