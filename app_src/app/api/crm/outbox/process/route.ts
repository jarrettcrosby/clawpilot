import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { processSuiteCrmOutbox } from '@/lib/crm/worker'
import { processCustomerFolderJobs } from '@/lib/crm/customerFolderJobs'
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
  // Stop before resume/claim, so a provider outage cannot consume retry budget.
  // Drive folder work is independent and continues through this shared route.
  const result = process.env.CLAWPILOT_CRM_SYNC_MAINTENANCE === '1'
    ? { paused: true, claimed: 0, succeeded: 0, failed: 0, dead: 0, held: 0,
      nativeResolutionHeld: false, projectionsQueued: 0, items: [] }
    : await processSuiteCrmOutbox({ limit: body.limit })
  const customerFolders = await processCustomerFolderJobs({ limit: 1 })
  return NextResponse.json({ ok: true, ...result, customerFolders })
}
