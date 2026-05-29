import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'clawpilot_session'
const AUTH_REQUIRED = process.env.APP_AUTH_REQUIRED === '1'
const DEV_START_ROOT_HINT = process.env.CLAWPILOT_REPO_ROOT ?? '/Users/agentsuburbiasandwich/Desktop/clawd-app'

function missingDevIsolationEnv(req: NextRequest) {
  const isDevRuntimePort = req.nextUrl.port === '4002' || req.headers.get('host')?.endsWith(':4002')
  if (!isDevRuntimePort) return [] as string[]

  const required = [
    'TASKS_PATH',
    'PIPELINE_NORMALIZED_PATH',
    'PIPELINE_LOG_PATH',
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
    normalizedPath.startsWith('/api/auth/')
  )
}

export function middleware(req: NextRequest) {
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


  // Only guard APIs in auth-required mode.
  if (!pathname.startsWith('/api/')) return NextResponse.next()
  if (isPublicApi(pathname)) return NextResponse.next()

  const token = req.cookies.get(COOKIE_NAME)?.value
  if (token) return NextResponse.next()

  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
}

export const config = {
  matcher: ['/:path*'],
}
