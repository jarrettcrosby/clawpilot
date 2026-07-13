import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createSessionToken, getCookieName, getLoginPassword } from '@/lib/auth'
import { configuredOwnerEmail, ensureOwnerUser, markAppUserSignedIn } from '@/lib/users'

const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 5

type LoginAttempt = { count: number; resetAt: number }
type LoginRateLimitGlobal = typeof globalThis & { __clawpilotLoginAttempts?: Map<string, LoginAttempt> }

function attemptsStore() {
  const runtime = globalThis as LoginRateLimitGlobal
  if (!runtime.__clawpilotLoginAttempts) runtime.__clawpilotLoginAttempts = new Map()
  return runtime.__clawpilotLoginAttempts
}

function pruneAttempts(now: number) {
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

function clientKey(req: NextRequest) {
  return String(req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 100)
}

function activeAttempt(key: string, now: number) {
  const store = attemptsStore()
  const attempt = store.get(key)
  if (!attempt || attempt.resetAt <= now) {
    store.delete(key)
    return null
  }
  return attempt
}

function secureEqual(provided: string, expected: string) {
  const providedHash = crypto.createHash('sha256').update(provided).digest()
  const expectedHash = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(providedHash, expectedHash)
}

export async function POST(req: NextRequest) {
  try {
    const now = Date.now()
    pruneAttempts(now)
    const key = clientKey(req)
    const current = activeAttempt(key, now)
    if (current && current.count >= MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
      return NextResponse.json(
        { ok: false, error: 'Too many login attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      )
    }

    const body = await req.json()
    const password = String(body?.password || '')
    const expected = getLoginPassword()
    if (!expected) {
      return NextResponse.json({ ok: false, error: 'APP_LOGIN_PASSWORD not configured' }, { status: 500 })
    }
    if (!secureEqual(password, expected)) {
      attemptsStore().set(key, {
        count: (current?.count || 0) + 1,
        resetAt: current?.resetAt || now + WINDOW_MS,
      })
      return NextResponse.json({ ok: false, error: 'Invalid password' }, { status: 401 })
    }

    attemptsStore().delete(key)
    await ensureOwnerUser()
    const ownerEmail = configuredOwnerEmail()
    await markAppUserSignedIn(ownerEmail)
    const token = createSessionToken(ownerEmail)
    const res = NextResponse.json({ ok: true })
    res.cookies.set({
      name: getCookieName(),
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 12,
    })
    return res
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
