import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/persistence/postgres'

const COOKIE_NAME = 'clawpilot_session'
const HOSTED_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT_NAME
  || process.env.RAILWAY_ENVIRONMENT_ID
  || process.env.RAILWAY_PROJECT_ID
  || process.env.RAILWAY_ENVIRONMENT
  || process.env.VERCEL,
)
const AUTH_REQUIRED = process.env.APP_AUTH_REQUIRED === '1' || HOSTED_RUNTIME
const DEV_START_ROOT_HINT = process.env.CLAWPILOT_REPO_ROOT ?? '/Users/agentsuburbiasandwich/Desktop/clawpilot'

function base64UrlBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const decoded = atob(padded)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

async function validSession(token?: string | null): Promise<{ ok: true; user: string } | { ok: false }> {
  const secret = process.env.APP_SESSION_SECRET || process.env.NEXTAUTH_SECRET || ''
  if (!secret || !token || !token.includes('.')) return { ok: false }

  try {
    const [encoded, signature] = token.split('.', 2)
    if (!encoded || !signature) return { ok: false }
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const validSignature = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlBytes(signature),
      encoder.encode(encoded),
    )
    if (!validSignature) return { ok: false }

    const payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(encoded))) as { u?: string; exp?: number }
    if (!payload.u || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return { ok: false }
    return { ok: true, user: payload.u.toLowerCase() }
  } catch {
    return { ok: false }
  }
}

async function activeSessionUser(email: string): Promise<boolean> {
  const result = await query<{ status: string }>('SELECT status FROM app_users WHERE email = $1', [email])
  return result.rows[0]?.status === 'active'
}

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

  return required.filter((k) => !process.env[k])
}

function isPublicApi(pathname: string) {
  const normalizedPath = pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname

  return (
    normalizedPath === '/api/health' ||
    normalizedPath === '/api/version' ||
    normalizedPath === '/api/client-error' ||
    normalizedPath === '/api/invitations/accept' ||
    normalizedPath === '/api/pipeline/sync/outbox/process' ||
    normalizedPath === '/api/crm/outbox/process' ||
    normalizedPath === '/api/agents/dispatch/process' ||
    normalizedPath === '/api/docs/embeddings/process' ||
    normalizedPath === '/api/ai-radar/process' ||
    normalizedPath === '/api/shortlinks' ||
    normalizedPath.startsWith('/api/auth/')
  )
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

  const token = req.cookies.get(COOKIE_NAME)?.value
  const session = await validSession(token)
  let sessionActive = false
  if (session.ok) {
    try {
      sessionActive = await activeSessionUser(session.user)
    } catch {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ ok: false, error: 'Access validation unavailable' }, { status: 503 })
      }
      return new NextResponse('Access validation unavailable', { status: 503 })
    }
  }

  if (pathname === '/login') {
    return sessionActive ? NextResponse.redirect(new URL('/', req.url)) : NextResponse.next()
  }

  if (sessionActive) return NextResponse.next()

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
