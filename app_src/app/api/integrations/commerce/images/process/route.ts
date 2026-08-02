import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  processCommerceProductImageImports,
} from '@/lib/commerceProductImageImportWorker'
import {
  commerceIntakeRuntimeAvailable,
} from '@/lib/integrations/commerceIntake'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'

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

function unavailableResult(errorCode: string) {
  return {
    waitingResolved: 0,
    waitingMapping: 0,
    claimed: 0,
    providerReads: 0,
    fetched: 0,
    succeeded: 0,
    retried: 0,
    dead: 0,
    cancelled: 0,
    leaseLost: 0,
    failed: 0,
    providerWrites: 0,
    errorCodes: { [errorCode]: 1 },
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, errorCode: 'UNAUTHORIZED' },
      { status: 401 },
    )
  }
  if (!commerceIntakeRuntimeAvailable()) {
    return NextResponse.json({
      ok: true,
      skipped: 1,
      ...unavailableResult('COMMERCE_PRODUCT_IMAGE_IMPORT_DISABLED'),
    })
  }
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: 'COMMERCE_PRODUCT_IMAGE_IMPORT_POSTGRES_REQUIRED',
      },
      { status: 409 },
    )
  }

  const body = await req.json().catch(() => ({})) as { limit?: number }
  const workerId = String(
    process.env.RAILWAY_REPLICA_ID
    || process.env.HOSTNAME
    || crypto.randomUUID(),
  ).slice(0, 100)
  try {
    const result = await processCommerceProductImageImports({
      limit: body.limit,
      workerId,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch {
    return NextResponse.json(
      { ok: false, errorCode: 'COMMERCE_PRODUCT_IMAGE_WORKER_FAILED' },
      { status: 500 },
    )
  }
}
