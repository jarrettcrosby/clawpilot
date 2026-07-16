import crypto from 'crypto'

const LEGACY_COOKIE_NAME = 'clawpilot_session'
const HOST_COOKIE_NAME = '__Host-clawpilot_session'
const SESSION_TTL_SECONDS = 60 * 60 * 12 // 12h

function getSecret() {
  const s = process.env.APP_SESSION_SECRET || process.env.NEXTAUTH_SECRET || ''
  if (!s) throw new Error('APP_SESSION_SECRET (or NEXTAUTH_SECRET) is required')
  return s
}

function b64url(input: Buffer | string) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function sign(payload: string) {
  return b64url(crypto.createHmac('sha256', getSecret()).update(payload).digest())
}

export function createSessionToken(username = 'jarrett') {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  const payload = JSON.stringify({ u: username, exp })
  const encoded = b64url(payload)
  return `${encoded}.${sign(encoded)}`
}

export function verifySessionToken(token?: string | null) {
  if (!token || !token.includes('.')) return { ok: false as const }
  const [encoded, sig] = token.split('.', 2)
  if (!encoded || !sig) return { ok: false as const }
  const expected = sign(encoded)
  if (sig.length !== expected.length) return { ok: false as const }
  const okSig = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  if (!okSig) return { ok: false as const }
  try {
    const json = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    const data = JSON.parse(json) as { u: string; exp: number }
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return { ok: false as const }
    return { ok: true as const, user: data.u, exp: data.exp }
  } catch {
    return { ok: false as const }
  }
}

export function getCookieName() {
  return process.env.NODE_ENV === 'production' ? HOST_COOKIE_NAME : LEGACY_COOKIE_NAME
}

export function getCookieNames() {
  return Array.from(new Set([getCookieName(), LEGACY_COOKIE_NAME]))
}

export function getLoginPassword() {
  return process.env.APP_LOGIN_PASSWORD || ''
}
