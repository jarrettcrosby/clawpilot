import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

type CronRun = {
  status?: string
  ts?: number
  runAtMs?: number
  summary?: string
}

const SUCCESS_RUN_STATUSES = new Set(['ok', 'success', 'completed'])

const OPENCLAW_ROOT = path.join(process.cwd(), '..', '..', '.openclaw')
const CRON_RUNS_DIR = path.join(OPENCLAW_ROOT, 'cron', 'runs')
const DEFAULT_CRON_RUN_ID = '1a7392b4-c39c-46b1-b316-2f2345aa0fe8'
const BRIEFINGS_DIR = path.join(OPENCLAW_ROOT, 'workspace', 'second-brain', 'daily')

function getCronRunsFilePath() {
  const configuredId = (process.env.CLAWPILOT_NIGHTLY_CRON_ID || process.env.NIGHTLY_CRON_ID || '').trim()
  const candidateIds = [configuredId, DEFAULT_CRON_RUN_ID].filter(Boolean)

  for (const id of candidateIds) {
    const filePath = path.join(CRON_RUNS_DIR, `${id}.jsonl`)
    if (fs.existsSync(filePath)) return filePath
  }

  if (!fs.existsSync(CRON_RUNS_DIR)) return null
  const latestJsonl = fs.readdirSync(CRON_RUNS_DIR)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => ({ name, filePath: path.join(CRON_RUNS_DIR, name), mtimeMs: fs.statSync(path.join(CRON_RUNS_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]

  return latestJsonl?.filePath || null
}

function getLatestBriefing() {
  if (!fs.existsSync(BRIEFINGS_DIR)) return null
  const files = fs.readdirSync(BRIEFINGS_DIR)
    .filter(name => name.endsWith('-nightly-brief.md'))
    .map(name => ({ name, path: path.join(BRIEFINGS_DIR, name) }))
    .filter(entry => fs.existsSync(entry.path))
  if (files.length === 0) return null
  const latest = files
    .map(entry => ({ ...entry, mtime: fs.statSync(entry.path).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0]
  return { name: latest.name, mtime: latest.mtime.toISOString() }
}

function getLatestCronRun() {
  const cronRunsFilePath = getCronRunsFilePath()
  if (!cronRunsFilePath || !fs.existsSync(cronRunsFilePath)) return null
  const lines = fs.readFileSync(cronRunsFilePath, 'utf-8').trim().split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return null

  let last: CronRun | null = null
  let lastSuccess: CronRun | null = null
  let lastFailure: CronRun | null = null

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const data = JSON.parse(lines[i]) as CronRun
      if (!last) last = data
      const normalizedStatus = String(data.status || '').toLowerCase()
      const isSuccess = SUCCESS_RUN_STATUSES.has(normalizedStatus)
      if (!lastSuccess && isSuccess) lastSuccess = data
      if (!lastFailure && normalizedStatus && !isSuccess) lastFailure = data
      if (last && lastSuccess && lastFailure) break
    } catch {
      continue
    }
  }

  return {
    status: last?.status || 'unknown',
    finishedAtMs: last?.ts || null,
    runAtMs: last?.runAtMs || null,
    summary: last?.summary || null,
    lastSuccessAtMs: lastSuccess?.ts || null,
    lastFailureReason: lastFailure?.summary || null,
  }
}

export async function GET() {
  const run = getLatestCronRun()
  const briefing = getLatestBriefing()

  const staleAfterMinutes = Number.parseInt(process.env.CLAWPILOT_NIGHTLY_STALE_AFTER_MINUTES || '180', 10)
  const staleThresholdMs = Number.isFinite(staleAfterMinutes) && staleAfterMinutes > 0
    ? staleAfterMinutes * 60 * 1000
    : 180 * 60 * 1000

  const nowMs = Date.now()
  const latestRunMs = run?.finishedAtMs || run?.runAtMs || null
  const ageMs = latestRunMs ? Math.max(0, nowMs - latestRunMs) : null
  const isStale = ageMs !== null ? ageMs > staleThresholdMs : null

  const normalizedRunStatus = String(run?.status || 'unknown').toLowerCase()
  const isSuccessfulRun = SUCCESS_RUN_STATUSES.has(normalizedRunStatus)

  return NextResponse.json({
    run: run ? {
      status: run.status,
      runAt: run.runAtMs ? new Date(run.runAtMs).toISOString() : null,
      finishedAt: run.finishedAtMs ? new Date(run.finishedAtMs).toISOString() : null,
      summary: run.summary,
      lastSuccessAt: run.lastSuccessAtMs ? new Date(run.lastSuccessAtMs).toISOString() : null,
      lastFailureReason: run.lastFailureReason || null,
      ageMinutes: ageMs === null ? null : Math.floor(ageMs / 60000),
      staleAfterMinutes: Math.floor(staleThresholdMs / 60000),
      isStale,
      health: isSuccessfulRun && isStale === false ? 'healthy' : 'degraded',
    } : null,
    briefing,
  }, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  })
}
