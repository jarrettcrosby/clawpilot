import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  CareerSiteSubmissionConfigurationError,
  resolveCareerSiteSubmissionConfiguration,
} from '@/lib/careerSiteSubmissionContract'
import { processCareerSiteSubmissionOutbox } from '@/lib/careerSiteSubmissionOutbox'
import {
  recordCareerSiteSubmissionWorkerHeartbeatInPostgres,
} from '@/lib/persistence/careerSiteSubmissions'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 4096

function authorized(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!expected || !provided) return false
  const expectedHash = crypto.createHash('sha256').update(expected).digest()
  const providedHash = crypto.createHash('sha256').update(provided).digest()
  return crypto.timingSafeEqual(expectedHash, providedHash)
}

async function requestLimit(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) return null
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) return null
  if (!raw) return {}
  try {
    const body = JSON.parse(raw)
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as { limit?: unknown }
      : null
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  let configuration
  try {
    configuration = resolveCareerSiteSubmissionConfiguration()
  } catch (error) {
    const code = error instanceof CareerSiteSubmissionConfigurationError
      ? error.code
      : 'CAREER_SITE_SUBMISSIONS_CONFIGURATION_INVALID'
    return NextResponse.json({ ok: false, error: 'Career-site submissions are not configured', code }, { status: 503 })
  }
  if (!configuration.enabled) {
    return NextResponse.json({ ok: false, error: 'Career-site submissions are disabled' }, { status: 409 })
  }
  const body = await requestLimit(req)
  if (!body) {
    return NextResponse.json({ ok: false, error: 'Invalid worker request' }, { status: 400 })
  }

  const workerId = String(process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'local-worker').slice(0, 200)
  try {
    await recordCareerSiteSubmissionWorkerHeartbeatInPostgres({
      phase: 'started',
      workerId,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
    })
    const result = await processCareerSiteSubmissionOutbox({ limit: Number(body.limit) || undefined })
    const heartbeat = await recordCareerSiteSubmissionWorkerHeartbeatInPostgres({
      phase: 'completed',
      workerId,
      claimed: result.claimed,
      succeeded: result.succeeded,
      failed: result.failed,
      dead: result.dead,
    })
    return NextResponse.json({ ok: true, ...result, heartbeatAt: heartbeat.checkedAt })
  } catch (error) {
    console.error('[career-site-submissions] worker failed', {
      name: error instanceof Error ? error.name : typeof error,
    })
    return NextResponse.json({
      ok: false,
      error: 'Career-site submission synchronization failed',
    }, { status: 503 })
  }
}
