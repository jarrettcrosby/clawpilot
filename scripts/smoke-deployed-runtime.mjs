#!/usr/bin/env node

const baseUrl = String(process.env.CLAWPILOT_BASE_URL || process.argv[2] || '').replace(/\/$/, '')
const expectedStorage = String(process.env.CLAWPILOT_EXPECT_STORAGE || '').trim()
const expectPipeline = String(process.env.CLAWPILOT_EXPECT_PIPELINE || '0') === '1'
const expectedBranch = String(process.env.CLAWPILOT_EXPECT_BRANCH || '').trim()
const expectedEnvironment = String(process.env.CLAWPILOT_EXPECT_ENVIRONMENT || '').trim()
const smokeWorkspace = String(process.env.CLAWPILOT_SMOKE_WORKSPACE || '').trim()

if (!baseUrl) {
  console.error('Usage: CLAWPILOT_BASE_URL=https://... npm run verify:deployed')
  process.exit(1)
}

const headers = { Accept: 'application/json' }
if (process.env.CLAWPILOT_SMOKE_BEARER) {
  headers.Authorization = `Bearer ${process.env.CLAWPILOT_SMOKE_BEARER}`
}
if (process.env.CLAWPILOT_SMOKE_COOKIE) {
  headers.Cookie = process.env.CLAWPILOT_SMOKE_COOKIE
}

function applySessionCookie(response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  const sessionCookie = setCookies.find((value) => (
    /^(?:__Host-)?clawpilot_session=/i.test(value)
    && !/Max-Age=0(?:;|$)/i.test(value)
  ))
  const cookie = sessionCookie?.split(';', 1)[0]
  if (!cookie) throw new Error('authentication response did not set a session cookie')
  headers.Cookie = cookie
}

async function authenticate() {
  const password = process.env.CLAWPILOT_SMOKE_PASSWORD
  const operatorSecret = process.env.CLAWPILOT_SMOKE_OPERATOR_SECRET || process.env.PIPELINE_OUTBOX_WORKER_SECRET
  if (!password || headers.Cookie) return
  if (!operatorSecret) throw new Error('smoke operator secret is required for password authentication')

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ClawPilot-Operator-Secret': operatorSecret },
    body: JSON.stringify({ password }),
  })
  if (!response.ok) throw new Error(`authentication failed with HTTP ${response.status}`)
  applySessionCookie(response)
  console.log('OK: authenticated smoke session')
}

async function selectSmokeWorkspace() {
  if (!smokeWorkspace) return
  const session = await getJson('/api/auth/session')
  const workspaces = Array.isArray(session?.availableWorkspaces) ? session.availableWorkspaces : []
  const normalizedTarget = smokeWorkspace.toLowerCase()
  const workspace = workspaces.find((entry) => [
    entry?.organizationId,
    entry?.referenceCode,
    entry?.name,
  ].some((value) => String(value || '').trim().toLowerCase() === normalizedTarget))
  if (!workspace?.organizationId) throw new Error(`smoke workspace is unavailable: ${smokeWorkspace}`)
  if (session?.activeWorkspace?.organizationId === workspace.organizationId) {
    console.log(`OK: smoke workspace is ${workspace.name}`)
    return
  }
  const response = await fetch(`${baseUrl}/api/auth/workspace`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'switch', organizationId: workspace.organizationId }),
    redirect: 'manual',
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`workspace switch failed with HTTP ${response.status}: ${raw.slice(0, 300)}`)
  applySessionCookie(response)
  console.log(`OK: switched smoke workspace to ${workspace.name}`)
}

async function verifyAuthenticationBoundary() {
  const page = await fetch(`${baseUrl}/`, { redirect: 'manual' })
  check(
    [301, 302, 303, 307, 308].includes(page.status) && String(page.headers.get('location') || '').includes('/login'),
    'unauthenticated page request redirects to login',
  )

  const api = await fetch(`${baseUrl}/api/tasks`, {
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  })
  check(api.status === 401, 'unauthenticated API request is rejected')

  const missingShortLink = await fetch(`${baseUrl}/s/clawpilot-smoke-route-not-found`, { redirect: 'manual' })
  check(missingShortLink.status === 404, 'public short-link resolver bypasses login and returns not found')
}

function check(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`OK: ${message}`)
}

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers, redirect: 'manual' })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${pathname} returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  return body
}

try {
  await verifyAuthenticationBoundary()
  await authenticate()
  await selectSmokeWorkspace()
  const health = await getJson('/api/health')
  check(health?.status === 'ok', 'health status is ok')

  const persistence = await getJson('/api/persistence/status')
  check(persistence?.ok === true, 'persistence status is healthy')
  if (expectedStorage) {
    check(persistence?.driver === expectedStorage, `persistence driver is ${expectedStorage}`)
  }
  if (expectedStorage === 'postgres') {
    check(persistence?.database === 'reachable', 'Postgres is reachable')
    check(typeof persistence?.databaseFingerprint === 'string' && persistence.databaseFingerprint.length > 0,
      'Postgres deployment identity is available')
    check(health?.database?.migrationsCurrent === true, 'database migrations are current')
    if (health?.runtime === 'railway') {
      check(health?.worker?.status === 'reachable', 'pipeline outbox worker heartbeat is fresh')
      check(health?.agentWorker?.status === 'reachable', 'agent dispatch worker heartbeat is fresh')
      check(health?.agentResearchWorker?.status === 'reachable', 'agent research worker heartbeat is fresh')
      check(health?.toastWorker?.status === 'reachable', 'Toast sync worker heartbeat is fresh')
      check(health?.quickBooksWorker?.status === 'reachable', 'QuickBooks sync worker heartbeat is fresh')
      if (health?.commerceProductImageImportWorker?.status !== 'disabled') {
        check(
          health?.commerceProductImageImportWorker?.livenessStatus === 'reachable',
          'commerce product image import worker heartbeat is fresh',
        )
      }
      check(health?.credentialStore?.status === 'reachable', 'shared agent credential store is reachable')
      check(health?.capabilities?.quickBooks === true, 'QuickBooks capability is available')
      const knowledgeWorkers = Array.isArray(health?.knowledgeWorkers) ? health.knowledgeWorkers : []
      const aiRadar = knowledgeWorkers.find((entry) => entry?.name === 'ai-radar')
      const documentEmbeddings = knowledgeWorkers.find((entry) => entry?.name === 'document-embeddings')
      check(aiRadar?.status === 'reachable' && aiRadar?.phase !== 'failed', 'AI Radar worker heartbeat is fresh')
      check(
        documentEmbeddings?.status === 'reachable' && documentEmbeddings?.phase !== 'failed',
        'document embedding worker heartbeat is fresh',
      )
    }
  }

  const runtime = await getJson('/api/runtime')
  if (expectedBranch) check(runtime?.branch === expectedBranch, `runtime branch is ${expectedBranch}`)
  if (expectedEnvironment) {
    check(runtime?.environment === expectedEnvironment, `runtime environment is ${expectedEnvironment}`)
  }

  const tasks = await getJson('/api/tasks?includeArchived=true')
  check(Array.isArray(tasks), 'tasks endpoint returns an array')

  const threads = await getJson('/api/agents/threads')
  check(Array.isArray(threads?.threads), 'agent threads endpoint returns a thread array')

  const shortLinks = await getJson('/api/shortlinks')
  check(Array.isArray(shortLinks?.links), 'short-link endpoint returns a link array')

  const runs = await getJson('/api/execution-runs/summary')
  const results = await getJson('/api/execution-results/summary')
  check(Number.isFinite(Number(runs?.count)), 'execution run summary is readable')
  check(Number.isFinite(Number(results?.count)), 'execution result summary is readable')

  const pipeline = await getJson('/api/pipeline')
  check(Array.isArray(pipeline?.opportunities), 'pipeline endpoint returns an opportunity array')
  if (expectPipeline) {
    check(pipeline.opportunities.length > 0, 'pipeline projection contains opportunities')
    if (expectedStorage) check(pipeline?.storage === expectedStorage, `pipeline storage is ${expectedStorage}`)
  }

  const syncStatus = await getJson('/api/pipeline/sync-status')
  check(syncStatus?.ok === true, 'pipeline sync diagnostics are readable')

  console.log(`DEPLOYED_SMOKE_OK base=${baseUrl}`)
} catch (error) {
  console.error(`DEPLOYED_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
