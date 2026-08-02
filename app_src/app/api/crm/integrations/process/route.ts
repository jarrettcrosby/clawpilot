import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { processCalendarIngestion } from '@/lib/crm/calendarIngestion'
import { processInboundGmailIngestion } from '@/lib/crm/emailIngestion'
import { processDueCrmIntegrationActions } from '@/lib/crm/integrationActions'
import { processSuiteCrmAccountContactIngestion } from '@/lib/crm/suiteCrmAccountContactIngestion'
import { processSuiteCrmCallIngestion } from '@/lib/crm/suiteCrmCallIngestion'
import { processSuiteCrmInteractionIngestion } from '@/lib/crm/suiteCrmInteractionIngestion'
import { processSuiteCrmMeetingIngestion } from '@/lib/crm/suiteCrmMeetingIngestion'
import { processSuiteCrmProductImageIngestion } from '@/lib/crm/suiteCrmProductImageIngestion'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const runtime = 'nodejs'

function authorized(req: NextRequest): boolean {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const authorization = String(req.headers.get('authorization') || '')
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  const provided = match?.[1].trim() || ''
  if (!expected || !provided) return false
  const expectedHash = crypto.createHash('sha256').update(expected).digest()
  const providedHash = crypto.createHash('sha256').update(provided).digest()
  return crypto.timingSafeEqual(expectedHash, providedHash)
}

function boundedLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 10
  return Math.max(1, Math.min(Math.trunc(value), 25))
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'CRM integration processing requires Postgres storage' },
      { status: 409 },
    )
  }
  try {
    const body = await req.json().catch(() => ({})) as { limit?: unknown }
    const suiteCrmAccountContactIngestion = await processSuiteCrmAccountContactIngestion()
    const suiteCrmMeetingIngestion = await processSuiteCrmMeetingIngestion()
    const suiteCrmCallIngestion = await processSuiteCrmCallIngestion()
    const suiteCrmInteractionIngestion = await processSuiteCrmInteractionIngestion()
    const suiteCrmProductImageIngestion =
      await processSuiteCrmProductImageIngestion()
    const results = await processDueCrmIntegrationActions({ limit: boundedLimit(body.limit) })
    const actions = {
      claimed: results.length,
      processed: results.length,
      succeeded: results.filter((action) => action.status === 'succeeded').length,
      failed: results.filter((action) => action.status === 'failed').length,
      dead: results.filter((action) => action.status === 'dead').length,
      cancelled: results.filter((action) => action.status === 'cancelled').length,
    }
    const ingestion = await processInboundGmailIngestion()
    const calendarIngestion = await processCalendarIngestion()
    return NextResponse.json({
      ok: true,
      actions,
      ingestion,
      calendarIngestion,
      suiteCrmAccountContactIngestion,
      suiteCrmMeetingIngestion,
      suiteCrmCallIngestion,
      suiteCrmInteractionIngestion,
      suiteCrmProductImageIngestion,
    })
  } catch {
    return NextResponse.json(
      { ok: false, error: 'CRM integration processing failed' },
      { status: 500 },
    )
  }
}
