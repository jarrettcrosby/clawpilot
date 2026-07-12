import { NextRequest, NextResponse } from 'next/server'

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

async function hasValidSession(token?: string | null) {
  const secret = process.env.APP_SESSION_SECRET || process.env.NEXTAUTH_SECRET || ''
  if (!secret || !token || !token.includes('.')) return false

  try {
    const [encoded, signature] = token.split('.', 2)
    if (!encoded || !signature) return false
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
    if (!validSignature) return false

    const payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(encoded))) as { exp?: number }
    return Boolean(payload.exp && payload.exp >= Math.floor(Date.now() / 1000))
  } catch {
    return false
  }
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
    normalizedPath === '/api/pipeline/sync/outbox/process' ||
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

  const token = req.cookies.get(COOKIE_NAME)?.value
  const sessionOk = await hasValidSession(token)

  if (pathname === '/login') {
    return sessionOk ? NextResponse.redirect(new URL('/', req.url)) : NextResponse.next()
  }

  if (sessionOk) return NextResponse.next()

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
