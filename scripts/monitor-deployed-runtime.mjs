#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const DEFAULT_ATTEMPTS = 3
const DEFAULT_DELAY_MS = 10_000
const DEFAULT_TIMEOUT_MS = 15_000

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function workerStatus(snapshot, key) {
  return asText(snapshot?.health?.[key]?.status)
}

export function validateMonitorSnapshot(snapshot, expectations = {}) {
  const failures = []
  const health = snapshot?.health || {}
  const persistence = snapshot?.persistence || {}
  const runtime = snapshot?.runtime || {}

  if (snapshot?.boundary?.rootRedirectsToLogin !== true) {
    failures.push('unauthenticated root request did not redirect to login')
  }
  if (snapshot?.boundary?.tasksRejected !== true) {
    failures.push('unauthenticated tasks request was not rejected')
  }
  if (health.status !== 'ok') failures.push(`health status is ${health.status || 'missing'}`)
  if (health.database?.status !== 'reachable') failures.push('database is not reachable')
  if (health.database?.migrationsCurrent !== true) failures.push('database migrations are not current')
  if (health.credentialStore?.status !== 'reachable') failures.push('credential store is not reachable')
  if (health.crm?.status !== 'reachable') failures.push('SuiteCRM worker is not reachable')
  if (health.capabilities?.quickBooks !== true) failures.push('QuickBooks capability is not reported')

  for (const [key, label] of [
    ['worker', 'pipeline outbox'],
    ['agentWorker', 'agent dispatch'],
    ['agentResearchWorker', 'agent research'],
    ['toastWorker', 'Toast sync'],
    ['quickBooksWorker', 'QuickBooks sync'],
  ]) {
    if (workerStatus(snapshot, key) !== 'reachable') failures.push(`${label} worker is not reachable`)
  }

  const knowledgeWorkers = Array.isArray(health.knowledgeWorkers) ? health.knowledgeWorkers : []
  for (const expectedName of ['ai-radar', 'document-embeddings']) {
    const worker = knowledgeWorkers.find((entry) => entry?.name === expectedName)
    if (worker?.status !== 'reachable' || worker?.phase === 'failed') {
      failures.push(`${expectedName} worker is not healthy`)
    }
  }

  if (persistence.ok !== true) failures.push('persistence status is not healthy')
  if (persistence.driver !== 'postgres') failures.push(`persistence driver is ${persistence.driver || 'missing'}`)
  if (persistence.database !== 'reachable') failures.push('persistence database is not reachable')
  if (!asText(persistence.databaseFingerprint)) failures.push('persistence database identity is missing')

  const expectedEnvironment = asText(expectations.environment)
  const expectedBranch = asText(expectations.branch)
  if (expectedEnvironment && runtime.environment !== expectedEnvironment) {
    failures.push(`runtime environment is ${runtime.environment || 'missing'}, expected ${expectedEnvironment}`)
  }
  if (expectedBranch && runtime.branch !== expectedBranch) {
    failures.push(`runtime branch is ${runtime.branch || 'missing'}, expected ${expectedBranch}`)
  }

  return failures
}

async function request(url, options = {}) {
  const startedAt = Date.now()
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ClawPilot-deployed-monitor/1.0',
      ...options.headers,
    },
    redirect: options.redirect || 'manual',
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  })
  return { response, latencyMs: Date.now() - startedAt }
}

async function requestJson(baseUrl, pathname, timeoutMs) {
  const { response, latencyMs } = await request(`${baseUrl}${pathname}`, { timeoutMs })
  const raw = await response.text()
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    throw new Error(`${pathname} returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}: ${raw.slice(0, 300)}`)
  }
  return { body, latencyMs }
}

export async function captureMonitorSnapshot(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const [root, tasks, health, persistence, runtime] = await Promise.all([
    request(`${baseUrl}/`, { timeoutMs }),
    request(`${baseUrl}/api/tasks`, { timeoutMs }),
    requestJson(baseUrl, '/api/health', timeoutMs),
    requestJson(baseUrl, '/api/persistence/status', timeoutMs),
    requestJson(baseUrl, '/api/runtime', timeoutMs),
  ])

  return {
    boundary: {
      rootRedirectsToLogin: [301, 302, 303, 307, 308].includes(root.response.status)
        && String(root.response.headers.get('location') || '').includes('/login'),
      tasksRejected: tasks.response.status === 401,
    },
    health: health.body,
    persistence: persistence.body,
    runtime: runtime.body,
    latencyMs: {
      root: root.latencyMs,
      tasks: tasks.latencyMs,
      health: health.latencyMs,
      persistence: persistence.latencyMs,
      runtime: runtime.latencyMs,
    },
  }
}

export async function main(env = process.env) {
  const baseUrl = asText(env.CLAWPILOT_BASE_URL).replace(/\/$/, '')
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
    throw new Error('Set CLAWPILOT_BASE_URL to an HTTPS ClawPilot deployment')
  }

  const attempts = positiveInteger(env.CLAWPILOT_MONITOR_ATTEMPTS, DEFAULT_ATTEMPTS)
  const delayMs = positiveInteger(env.CLAWPILOT_MONITOR_DELAY_MS, DEFAULT_DELAY_MS)
  const timeoutMs = positiveInteger(env.CLAWPILOT_MONITOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const expectations = {
    branch: asText(env.CLAWPILOT_EXPECT_BRANCH),
    environment: asText(env.CLAWPILOT_EXPECT_ENVIRONMENT),
  }
  let lastFailure = 'monitor did not run'

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const snapshot = await captureMonitorSnapshot(baseUrl, timeoutMs)
      const failures = validateMonitorSnapshot(snapshot, expectations)
      if (failures.length === 0) {
        process.stdout.write(`${JSON.stringify({
          ok: true,
          baseUrl,
          attempt,
          checkedAt: new Date().toISOString(),
          environment: snapshot.runtime?.environment || null,
          branch: snapshot.runtime?.branch || null,
          latencyMs: snapshot.latencyMs,
        }, null, 2)}\n`)
        return 0
      }
      lastFailure = failures.join('; ')
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }

    if (attempt < attempts) await sleep(delayMs)
  }

  throw new Error(`${baseUrl} failed ${attempts} monitor attempts: ${lastFailure}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error) => {
    console.error(`DEPLOYED_MONITOR_FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
