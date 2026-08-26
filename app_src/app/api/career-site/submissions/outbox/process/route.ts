import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  CareerSiteSubmissionConfigurationError,
  resolveCareerSiteSubmissionConfiguration,
} from '@/lib/careerSiteSubmissionContract'
import {
  CareerSiteMailConfigurationError,
  resolveCareerSiteMailConfiguration,
} from '@/lib/careerSiteMailContract'
import { processCareerSiteMailOutbox } from '@/lib/careerSiteMailOutbox'
import { processCareerSiteSubmissionOutbox } from '@/lib/careerSiteSubmissionOutbox'
import {
  readCareerSiteMailOperationalHealthFromPostgres,
  recordCareerSiteMailWorkerHeartbeatInPostgres,
} from '@/lib/persistence/careerSiteMailOutbox'
import {
  readCareerSiteSubmissionOperationalHealthFromPostgres,
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
  let mailConfiguration
  try {
    configuration = resolveCareerSiteSubmissionConfiguration()
    mailConfiguration = resolveCareerSiteMailConfiguration()
  } catch (error) {
    const code = error instanceof CareerSiteSubmissionConfigurationError
      ? error.code
      : error instanceof CareerSiteMailConfigurationError
        ? 'CAREER_SITE_MAIL_CONFIGURATION_INVALID'
      : 'CAREER_SITE_SUBMISSIONS_CONFIGURATION_INVALID'
    return NextResponse.json({ ok: false, error: 'Career-site submissions are not configured', code }, { status: 503 })
  }
  if (!configuration.enabled || !mailConfiguration.enabled) {
    return NextResponse.json({ ok: false, error: 'Career-site submissions are disabled' }, { status: 409 })
  }
  const body = await requestLimit(req)
  if (!body) {
    return NextResponse.json({ ok: false, error: 'Invalid worker request' }, { status: 400 })
  }

  const workerId = String(process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'local-worker').slice(0, 200)
  try {
    await Promise.all([
      recordCareerSiteSubmissionWorkerHeartbeatInPostgres({
        phase: 'started',
        workerId,
        claimed: 0,
        succeeded: 0,
        failed: 0,
        dead: 0,
      }),
      recordCareerSiteMailWorkerHeartbeatInPostgres({
        phase: 'started',
        workerId,
        claimed: 0,
        succeeded: 0,
        failed: 0,
        dead: 0,
      }),
    ])
    const [submissionProcessing, mailProcessing] = await Promise.allSettled([
      processCareerSiteSubmissionOutbox({ limit: Number(body.limit) || undefined }),
      processCareerSiteMailOutbox(),
    ])
    if (submissionProcessing.status === 'rejected') {
      console.error('[career-site-submissions] projection worker failed', {
        name: submissionProcessing.reason instanceof Error
          ? submissionProcessing.reason.name
          : typeof submissionProcessing.reason,
      })
    }
    if (mailProcessing.status === 'rejected') {
      console.error('[career-site-mail] delivery worker failed', {
        name: mailProcessing.reason instanceof Error
          ? mailProcessing.reason.name
          : typeof mailProcessing.reason,
      })
    }
    const result = submissionProcessing.status === 'fulfilled'
      ? submissionProcessing.value
      : { claimed: 0, succeeded: 0, failed: 1, dead: 0, items: [] }
    const mailResult = mailProcessing.status === 'fulfilled'
      ? mailProcessing.value
      : { claimed: 0, succeeded: 0, failed: 1, dead: 0, items: [] }
    const submissionWorkerRejected = submissionProcessing.status === 'rejected'
    const mailWorkerRejected = mailProcessing.status === 'rejected'
    const phase = submissionWorkerRejected || result.dead > 0
      ? 'failed'
      : result.failed > 0 ? 'degraded' : 'completed'
    const mailPhase = mailWorkerRejected || mailResult.dead > 0
      ? 'failed'
      : mailResult.failed > 0 ? 'degraded' : 'completed'
    const heartbeat = await recordCareerSiteSubmissionWorkerHeartbeatInPostgres({
      phase,
      workerId,
      claimed: result.claimed,
      succeeded: result.succeeded,
      failed: result.failed,
      dead: result.dead,
    })
    const mailHeartbeat = await recordCareerSiteMailWorkerHeartbeatInPostgres({
      phase: mailPhase,
      workerId,
      claimed: mailResult.claimed,
      succeeded: mailResult.succeeded,
      failed: mailResult.failed,
      dead: mailResult.dead,
    })
    const health = await readCareerSiteSubmissionOperationalHealthFromPostgres({
      sourceApp: configuration.sourceApp,
      ownerEmail: configuration.ownerEmail!,
      organizationId: configuration.organizationId!,
      pollMs: Number(process.env.CAREER_SITE_SUBMISSIONS_POLL_MS) || undefined,
      leaseSeconds: 900,
    })
    const mailHealth = await readCareerSiteMailOperationalHealthFromPostgres({
      sourceApp: mailConfiguration.sourceApp,
      ownerEmail: mailConfiguration.ownerEmail!,
      organizationId: mailConfiguration.organizationId!,
      pollMs: Number(process.env.CAREER_SITE_SUBMISSIONS_POLL_MS) || undefined,
      leaseSeconds: 900,
    })
    const ok = health.healthy
      && mailHealth.healthy
      && result.failed === 0
      && result.dead === 0
      && mailResult.failed === 0
      && mailResult.dead === 0
    return NextResponse.json({
      ok,
      ...result,
      mail: mailResult,
      deliveryStatus: health.status,
      mailDeliveryStatus: mailHealth.status,
      heartbeatAt: heartbeat.checkedAt,
      mailHeartbeatAt: mailHeartbeat.checkedAt,
    }, { status: ok ? 200 : 503 })
  } catch (error) {
    try {
      await Promise.all([
        recordCareerSiteSubmissionWorkerHeartbeatInPostgres({
          phase: 'failed',
          workerId,
          claimed: 0,
          succeeded: 0,
          failed: 1,
          dead: 0,
        }),
        recordCareerSiteMailWorkerHeartbeatInPostgres({
          phase: 'failed',
          workerId,
          claimed: 0,
          succeeded: 0,
          failed: 1,
          dead: 0,
        }),
      ])
    } catch {
      // Preserve the original failure while leaving health to report a missing/stale heartbeat.
    }
    console.error('[career-site-submissions] worker failed', {
      name: error instanceof Error ? error.name : typeof error,
    })
    return NextResponse.json({
      ok: false,
      error: 'Career-site submission synchronization failed',
    }, { status: 503 })
  }
}
