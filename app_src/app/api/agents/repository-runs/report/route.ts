import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getRepositoryRunnerConfiguration } from '@/lib/agents/repositoryRunnerConfig'
import {
  applyRepositoryRunReportInPostgres,
  type RepositoryRunReport,
} from '@/lib/persistence/repositoryRuns'

const MAX_REPORT_BYTES = 128 * 1024
const MAX_CLOCK_SKEW_MS = 5 * 60_000
const REPORT_STATUSES = new Set<RepositoryRunReport['status']>([
  'running', 'patch_ready', 'policy_rejected', 'failed',
])

function secureEqual(left: string, right: string): boolean {
  if (!left || !right) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function validGitHubUrl(value: unknown): string | undefined {
  const raw = String(value || '').trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

function validChangedPath(value: unknown): string | null {
  const path = String(value || '').trim().replaceAll('\\', '/')
  if (!path || path.length > 500 || path.startsWith('/') || path.split('/').includes('..')) return null
  return path
}

export async function POST(req: NextRequest) {
  const configuration = getRepositoryRunnerConfiguration()
  if (configuration.reportSecret.length < 32) {
    return NextResponse.json({ error: 'Repository report authentication is not configured' }, { status: 503 })
  }
  const timestamp = String(req.headers.get('x-clawpilot-timestamp') || '').trim()
  const signature = String(req.headers.get('x-clawpilot-signature') || '').trim().toLowerCase()
  const timestampMs = Number(timestamp) * 1000
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
    return NextResponse.json({ error: 'Repository report timestamp is invalid' }, { status: 401 })
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REPORT_BYTES) {
    return NextResponse.json({ error: 'Repository report is too large' }, { status: 413 })
  }
  const expected = `sha256=${crypto
    .createHmac('sha256', configuration.reportSecret)
    .update(`${timestamp}.${raw}`)
    .digest('hex')}`
  if (!secureEqual(expected, signature)) {
    return NextResponse.json({ error: 'Repository report signature is invalid' }, { status: 401 })
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Repository report body is invalid' }, { status: 400 })
  }
  const runId = String(body.runId || '').trim()
  const status = String(body.status || '').trim() as RepositoryRunReport['status']
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    return NextResponse.json({ error: 'Repository run ID is invalid' }, { status: 400 })
  }
  if (!REPORT_STATUSES.has(status)) {
    return NextResponse.json({ error: 'Repository report status is invalid' }, { status: 400 })
  }
  const changedPaths = (Array.isArray(body.changedPaths) ? body.changedPaths : [])
    .map(validChangedPath)
    .filter((value): value is string => Boolean(value))
    .slice(0, 200)
  const validationResult = body.validationResult && typeof body.validationResult === 'object' && !Array.isArray(body.validationResult)
    ? body.validationResult as Record<string, unknown>
    : {}
  try {
    const run = await applyRepositoryRunReportInPostgres({
      runId,
      report: {
        status,
        workflowRunId: String(body.workflowRunId || '').trim() || undefined,
        workflowUrl: validGitHubUrl(body.workflowUrl),
        artifactUrl: validGitHubUrl(body.artifactUrl),
        patchDigest: String(body.patchDigest || '').trim().toLowerCase() || undefined,
        changedPaths,
        validationResult,
        summary: String(body.summary || '').trim().slice(0, 4000) || undefined,
        error: String(body.error || '').trim().slice(0, 2000) || undefined,
      },
    })
    return NextResponse.json({ ok: true, run })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to record repository report'
    const statusCode = /not found/i.test(message) ? 404 : /transition/i.test(message) ? 409 : 400
    return NextResponse.json({ error: message }, { status: statusCode })
  }
}
