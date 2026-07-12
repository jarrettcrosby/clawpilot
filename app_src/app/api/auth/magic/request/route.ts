import { NextRequest, NextResponse } from 'next/server'
import { requestAuthMagicCode } from '@/lib/authMagicCode'

const WINDOW_MS = 15 * 60 * 1000
const MAX_REQUESTS = 5
const GENERIC_MESSAGE = 'If this email is authorized, a six-digit sign-in code is on the way.'

type RequestAttempt = { count: number; resetAt: number }
type RequestRateLimitGlobal = typeof globalThis & {
  __clawpilotMagicCodeRequests?: Map<string, RequestAttempt>
}

function attemptsStore() {
  const runtime = globalThis as RequestRateLimitGlobal
  if (!runtime.__clawpilotMagicCodeRequests) runtime.__clawpilotMagicCodeRequests = new Map()
  return runtime.__clawpilotMagicCodeRequests
}

function clientKey(req: NextRequest) {
  return String(req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 100)
}

function recordRequest(key: string, now: number) {
  const store = attemptsStore()
  const current = store.get(key)
  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + WINDOW_MS }
    store.set(key, next)
    return next
  }
  const next = { ...current, count: current.count + 1 }
  store.set(key, next)
  return next
}

function pruneRequests(now: number) {
  const store = attemptsStore()
  if (store.size < 1000) return
  for (const [key, attempt] of store) {
    if (attempt.resetAt <= now) store.delete(key)
  }
  while (store.size > 5000) {
    const oldestKey = store.keys().next().value
    if (oldestKey === undefined) break
    store.delete(oldestKey)
  }
}

export async function POST(req: NextRequest) {
  const now = Date.now()
  pruneRequests(now)
  const attempt = recordRequest(clientKey(req), now)
  if (attempt.count > MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((attempt.resetAt - now) / 1000))
    return NextResponse.json(
      { ok: false, error: 'Too many code requests. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    )
  }

  try {
    const body = await req.json()
    const email = String(body?.email || '').trim().toLowerCase()
    if (!email.includes('@') || email.length > 254) {
      return NextResponse.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400 })
    }

    const result = await requestAuthMagicCode({ email })
    if (result.status === 'sent' || result.status === 'cooldown' || result.status === 'not-authorized') {
      return NextResponse.json({ ok: true, message: GENERIC_MESSAGE })
    }

    return NextResponse.json({ ok: false, error: 'Unable to send a sign-in code.' }, { status: 503 })
  } catch (error) {
    console.error('[auth] Magic-code request failed', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ ok: false, error: 'Unable to send a sign-in code.' }, { status: 503 })
  }
}
