import { NextRequest, NextResponse } from 'next/server'
import {
  AUTH_CONTEXT_HEADER,
  AUTH_CONTEXT_PROOF_HEADER,
  createAuthAttributionHeaders,
} from '@/lib/authAttribution'
import {
  createBrowserSession,
  resolveRequestSession,
  setBrowserSessionCookie,
  type BrowserSession,
  type IssuedBrowserSession,
} from '@/lib/authSessions'
import { resolveAgentDispatchWorker } from '@/lib/workerAuth'
import { demoMutationIsRestricted } from '@/lib/demoMode'

const HOSTED_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT_NAME
  || process.env.RAILWAY_ENVIRONMENT_ID
  || process.env.RAILWAY_PROJECT_ID
  || process.env.RAILWAY_ENVIRONMENT
  || process.env.VERCEL,
)
const AUTH_REQUIRED = process.env.APP_AUTH_REQUIRED === '1' || HOSTED_RUNTIME
const DEV_START_ROOT_HINT = process.env.CLAWPILOT_REPO_ROOT ?? '/Users/agentsuburbiasandwich/Desktop/clawpilot'

function missingDevIsolationEnv(req: NextRequest) {
  const isDevRuntimePort = req.nextUrl.port === '4002' || req.headers.get('host')?.endsWith(':4002')
  if (!isDevRuntimePort) return [] as string[]

  const required = [
    'TASKS_PATH',
    'PIPELINE_NORMALIZED_PATH',
    'PIPELINE_LOG_PATH',
    'PIPELINE_DROPDOWN_CACHE_PATH',
    'AGENT_THREADS_PATH',
    'AGENT_ASSIGNMENTS_PATH',
  ]

  return required.filter((key) => !process.env[key])
}

function isPublicApi(pathname: string) {
  const normalizedPath = pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname

  return (
    normalizedPath === '/api/health'
    || normalizedPath === '/api/version'
    || normalizedPath === '/api/runtime'
    || normalizedPath === '/api/persistence/status'
    || normalizedPath === '/api/client-error'
    || normalizedPath === '/api/invitations/accept'
    || normalizedPath === '/api/pipeline/sync/outbox/process'
    || normalizedPath === '/api/crm/outbox/process'
    || normalizedPath === '/api/crm/integrations/process'
    || normalizedPath === '/api/agents/dispatch/process'
    || normalizedPath === '/api/agents/research/process'
    || normalizedPath === '/api/agents/repository-runs/process'
    || normalizedPath === '/api/integrations/toast/process'
    || normalizedPath === '/api/integrations/quickbooks/process'
    || normalizedPath === '/api/integrations/commerce/catalog/process'
    || normalizedPath === '/api/integrations/commerce/orders/process'
    || normalizedPath.startsWith('/api/integrations/commerce/shopify/webhooks/')
    || normalizedPath.startsWith('/api/integrations/commerce/shopify/carrier-service/')
    || normalizedPath.startsWith('/api/integrations/commerce/shopify/product-media/')
    || normalizedPath === '/api/integrations/commerce/faire/oauth/callback'
    || normalizedPath === '/api/docs/embeddings/process'
    || normalizedPath === '/api/ai-radar/process'
    || normalizedPath === '/api/operations/print-agent/jobs'
    || normalizedPath === '/api/shortlinks'
    || normalizedPath.startsWith('/api/auth/')
  )
}

function sensitiveMutationDuringImpersonation(req: NextRequest, session: BrowserSession): boolean {
  if (!session.impersonating || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false
  const path = req.nextUrl.pathname
  return [
    '/api/users',
    '/api/workspaces',
    '/api/settings/',
    '/api/integrations/',
    '/api/accounting/',
    '/api/agents/auth',
    '/api/railway-backups',
  ].some((prefix) => path === prefix || path.startsWith(prefix))
}

async function authorizedWorkerRequest(req: NextRequest): Promise<boolean> {
  const routeAllowed = (req.method === 'POST' && req.nextUrl.pathname === '/api/agents/threads')
    || (req.method === 'PATCH' && req.nextUrl.pathname === '/api/tasks')
  if (!routeAllowed || req.headers.get('x-clawpilot-worker') !== 'agent-dispatch') return false
  return Boolean(await resolveAgentDispatchWorker(req).catch(() => null))
}

async function durableSession(req: NextRequest): Promise<{
  session: BrowserSession | null
  issued: IssuedBrowserSession | null
}> {
  const session = await resolveRequestSession(req)
  if (!session) return { session: null, issued: null }
  if (!session.legacy) return { session, issued: null }
  const issued = await createBrowserSession({
    email: session.authenticatedUser,
    authMethod: 'legacy_upgrade',
    headers: req.headers,
  })
  return { session: issued.session, issued }
}

function responseWithSessionCookie(response: NextResponse, issued: IssuedBrowserSession | null) {
  if (issued) setBrowserSessionCookie(response, issued)
  return response
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  const missing = missingDevIsolationEnv(req)
  if (missing.length > 0) {
    const message = `Dev runtime requires isolated data env vars. Missing: ${missing.join(', ')}. Start via scripts/dev-start.sh from ${DEV_START_ROOT_HINT}.`
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ ok: false, error: message }, { status: 500 })
    }
    return new NextResponse(message, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  if (!AUTH_REQUIRED) return NextResponse.next()
  if (pathname.startsWith('/api/') && isPublicApi(pathname)) return NextResponse.next()
  if (pathname.startsWith('/s/')) return NextResponse.next()

  if (pathname === '/welcome') {
    const response = NextResponse.next()
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('X-Robots-Tag', 'noindex, nofollow')
    return response
  }
  if (pathname.startsWith('/brand/')) return NextResponse.next()

  if (await authorizedWorkerRequest(req)) return NextResponse.next()

  let session: BrowserSession | null = null
  let issued: IssuedBrowserSession | null = null
  try {
    const resolved = await durableSession(req)
    session = resolved.session
    issued = resolved.issued
  } catch {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ ok: false, error: 'Access validation unavailable' }, { status: 503 })
    }
    return new NextResponse('Access validation unavailable', { status: 503 })
  }

  if (pathname === '/login') {
    return session
      ? responseWithSessionCookie(NextResponse.redirect(new URL('/', req.url)), issued)
      : NextResponse.next()
  }

  if (session) {
    if (demoMutationIsRestricted(pathname, req.method, session.activeWorkspaceOrganizationId)) {
      return NextResponse.json(
        { ok: false, error: 'This demo account is read-only.' },
        { status: 403 },
      )
    }
    if (sensitiveMutationDuringImpersonation(req, session)) {
      return NextResponse.json(
        { ok: false, error: 'Exit user view before changing account access, integrations, or security settings.' },
        { status: 403 },
      )
    }
    const requestHeaders = new Headers(req.headers)
    requestHeaders.delete(AUTH_CONTEXT_HEADER)
    requestHeaders.delete(AUTH_CONTEXT_PROOF_HEADER)
    const attribution = createAuthAttributionHeaders({
      sessionId: session.id,
      authenticatedUser: session.authenticatedUser,
      effectiveUser: session.effectiveUser,
      activeWorkspaceOrganizationId: session.activeWorkspaceOrganizationId || '',
      impersonating: session.impersonating,
    })
    for (const [key, value] of Object.entries(attribution)) requestHeaders.set(key, value)
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    return responseWithSessionCookie(response, issued)
  }

  if (!pathname.startsWith('/api/')) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('next', `${pathname}${req.nextUrl.search}`)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
}
