#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const homeDir = os.homedir()
const cronRunsDir = path.join(homeDir, '.openclaw', 'cron', 'runs')
const defaultCronRunsFile = path.join(cronRunsDir, '1a7392b4-c39c-46b1-b316-2f2345aa0fe8.jsonl')
const getEnv = (name, fallbackName) => process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined)

const cronRunsFile = getEnv('NIGHTLY_CRON_RUNS_FILE', 'CLAWPILOT_NIGHTLY_CRON_RUNS_FILE') || defaultCronRunsFile
const defaultBriefingsDir = path.join(homeDir, '.openclaw', 'workspace', 'second-brain', 'daily')
const briefingsDir = getEnv('NIGHTLY_BRIEFINGS_DIR', 'CLAWPILOT_NIGHTLY_BRIEFINGS_DIR') || defaultBriefingsDir
const maxStaleHours = Number(getEnv('NIGHTLY_MAX_STALE_HOURS', 'CLAWPILOT_NIGHTLY_MAX_STALE_HOURS') || '24')
const strictStaleness = getEnv('NIGHTLY_STRICT_STALENESS', 'CLAWPILOT_NIGHTLY_STRICT_STALENESS') === '1'
const strictRunStatus = getEnv('NIGHTLY_STRICT_RUN_STATUS', 'CLAWPILOT_NIGHTLY_STRICT_RUN_STATUS') === '1'
const strictBriefingStaleness = getEnv('NIGHTLY_STRICT_BRIEFING_STALENESS', 'CLAWPILOT_NIGHTLY_STRICT_BRIEFING_STALENESS') === '1'
const maxFutureSkewMinutes = Number(getEnv('NIGHTLY_MAX_FUTURE_SKEW_MINUTES', 'CLAWPILOT_NIGHTLY_MAX_FUTURE_SKEW_MINUTES') || '10')
const successfulRunStatuses = new Set(['success', 'ok', 'completed'])

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function validatePositiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive number`)
  }
}

function parseLatestJsonLine(rawChunk) {
  const lines = rawChunk.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i])
    } catch {
      // Continue scanning backward for the most recent valid JSON line.
    }
  }
  return null
}

function normalizeCronRecord(record) {
  if (!record || typeof record !== 'object') return null

  const normalized = { ...record }
  if (typeof normalized.ts !== 'number') {
    if (typeof normalized.finishedAtMs === 'number') {
      normalized.ts = normalized.finishedAtMs
    } else if (typeof normalized.runAtMs === 'number') {
      normalized.ts = normalized.runAtMs
    } else {
      return null
    }
  }

  return normalized
}

function readLatestRecordFromFile(filePath) {
  const { size } = fs.statSync(filePath)
  if (size === 0) return null

  let latest = null
  let windowSize = Math.min(size, 256 * 1024)

  const fd = fs.openSync(filePath, 'r')
  try {
    while (!latest && windowSize <= size) {
      const start = Math.max(0, size - windowSize)
      const length = size - start
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      latest = parseLatestJsonLine(buffer.toString('utf8'))

      if (latest || start === 0) break
      windowSize = Math.min(size, windowSize * 2)
    }
  } finally {
    fs.closeSync(fd)
  }

  return normalizeCronRecord(latest)
}

function listCronRunFiles() {
  if (!fs.existsSync(cronRunsDir)) {
    fail(`Cron runs directory not found: ${cronRunsDir}`)
  }

  return fs
    .readdirSync(cronRunsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(cronRunsDir, name))
}

function readLatestCronRun(filePath) {
  if (getEnv('NIGHTLY_CRON_RUNS_FILE', 'CLAWPILOT_NIGHTLY_CRON_RUNS_FILE')) {
    if (!fs.existsSync(filePath)) {
      fail(`Cron runs file not found: ${filePath}`)
    }

    const latest = readLatestRecordFromFile(filePath)
    if (!latest) {
      fail(`No valid JSON records found in cron runs file: ${filePath}`)
    }

    latest._sourceFile = filePath
    return latest
  }

  const files = listCronRunFiles()
  if (files.length === 0) {
    fail(`No cron run files found in ${cronRunsDir}`)
  }

  let best = null
  for (const candidateFile of files) {
    const latest = readLatestRecordFromFile(candidateFile)
    if (!latest) continue

    if (!best || latest.ts > best.ts) {
      best = {
        ...latest,
        _sourceFile: candidateFile,
      }
    }
  }

  if (!best) {
    fail(`No valid JSON records found in cron runs files under ${cronRunsDir}`)
  }

  return best
}

function readLatestBriefing(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return { exists: false, latestFile: null, latestMtimeMs: null }
  }

  const files = fs
    .readdirSync(dirPath)
    .filter((name) => name.endsWith('-nightly-brief.md'))
    .map((name) => {
      const fullPath = path.join(dirPath, name)
      const stat = fs.statSync(fullPath)
      return { name, mtimeMs: stat.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  if (files.length === 0) {
    return { exists: false, latestFile: null, latestMtimeMs: null }
  }

  return {
    exists: true,
    latestFile: files[0].name,
    latestMtimeMs: files[0].mtimeMs,
  }
}

validatePositiveNumber(maxStaleHours, 'NIGHTLY_MAX_STALE_HOURS')
validatePositiveNumber(maxFutureSkewMinutes, 'NIGHTLY_MAX_FUTURE_SKEW_MINUTES')

const latestRun = readLatestCronRun(cronRunsFile)
const now = Date.now()
const ageHours = (now - latestRun.ts) / (1000 * 60 * 60)
const futureSkewMinutes = (latestRun.ts - now) / (1000 * 60)

if (futureSkewMinutes > maxFutureSkewMinutes) {
  fail(
    `Latest cron run timestamp is too far in the future (${futureSkewMinutes.toFixed(1)}m; max ${maxFutureSkewMinutes}m)`
  )
}

let staleWarning = null
if (ageHours > maxStaleHours) {
  staleWarning = `Latest cron run is stale (${ageHours.toFixed(1)}h old; max ${maxStaleHours}h)`
  if (strictStaleness) {
    fail(staleWarning)
  }
}

const latestRunStatus = String(latestRun.status || 'unknown').toLowerCase()
let runWarning = null
if (!successfulRunStatuses.has(latestRunStatus)) {
  runWarning = `Latest cron run status is not successful (${latestRunStatus})`
  if (strictRunStatus) {
    fail(runWarning)
  }
}

const latestBriefing = readLatestBriefing(briefingsDir)
let briefingWarning = null
if (!latestBriefing.exists || !latestBriefing.latestMtimeMs) {
  briefingWarning = `No nightly briefing found in ${briefingsDir}`
  if (strictBriefingStaleness) {
    fail(briefingWarning)
  }
} else {
  const briefingAgeHours = (now - latestBriefing.latestMtimeMs) / (1000 * 60 * 60)
  latestBriefing.ageHours = Number(briefingAgeHours.toFixed(2))
  if (briefingAgeHours > maxStaleHours) {
    briefingWarning = `Latest nightly briefing is stale (${briefingAgeHours.toFixed(1)}h old; max ${maxStaleHours}h)`
    if (strictBriefingStaleness) {
      fail(briefingWarning)
    }
  }
}

const status = {
  ok: !staleWarning && !runWarning && !briefingWarning,
  maxStaleHours,
  maxFutureSkewMinutes,
  strictStaleness,
  strictRunStatus,
  strictBriefingStaleness,
  staleWarning,
  runWarning,
  briefingWarning,
  latestRun: {
    sourceFile: latestRun._sourceFile || cronRunsFile,
    status: latestRun.status || 'unknown',
    runAtMs: latestRun.runAtMs ?? null,
    finishedAtMs: latestRun.ts,
    summary: latestRun.summary || null,
    ageHours: Number(ageHours.toFixed(2)),
    futureSkewMinutes: Number(futureSkewMinutes.toFixed(2)),
  },
  briefingsDir,
  latestBriefing,
}

console.log(JSON.stringify(status, null, 2))
