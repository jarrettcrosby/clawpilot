import crypto from 'crypto'
import type { NextRequest } from 'next/server'
import { recordAuditEvent } from '@/lib/auditWriter'
import { normalizeUserEmail } from '@/lib/users'

function normalizedEmail(value: unknown): string | null {
  try {
    return normalizeUserEmail(value)
  } catch {
    return null
  }
}

function requestAddress(req: NextRequest): string {
  return String(req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 200)
}

function networkFingerprint(req: NextRequest): string {
  const key = String(process.env.APP_SESSION_SECRET || 'clawpilot-audit-fallback')
  return crypto.createHmac('sha256', key).update(requestAddress(req)).digest('hex').slice(0, 16)
}

function clientSummary(req: NextRequest): string {
  const userAgent = String(req.headers.get('user-agent') || '')
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /CriOS\//.test(userAgent) ? 'Chrome iOS'
      : /Chrome\//.test(userAgent) ? 'Chrome'
        : /FxiOS\//.test(userAgent) ? 'Firefox iOS'
          : /Firefox\//.test(userAgent) ? 'Firefox'
            : /Safari\//.test(userAgent) ? 'Safari'
              : 'Unknown browser'
  const platform = /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Android/.test(userAgent) ? 'Android'
      : /Mac OS X/.test(userAgent) ? 'macOS'
        : /Windows/.test(userAgent) ? 'Windows'
          : /Linux/.test(userAgent) ? 'Linux'
            : 'Unknown platform'
  return `${browser} on ${platform}`
}

export async function recordAuthActivity(input: {
  req: NextRequest
  email: unknown
  eventType: 'auth.code.requested' | 'auth.code.request.denied' | 'auth.login.succeeded' | 'auth.login.failed' | 'auth.logout.succeeded'
  method: 'magic_code' | 'operator_password' | 'session'
  reason?: string
}): Promise<void> {
  const email = normalizedEmail(input.email)
  const authenticatedActor = input.eventType === 'auth.login.succeeded' || input.eventType === 'auth.logout.succeeded'
  await recordAuditEvent({
    actor: authenticatedActor ? email : null,
    subject: email,
    eventType: input.eventType,
    aggregateType: 'app_user',
    aggregateId: email || 'unknown',
    payload: {
      method: input.method,
      outcome: input.eventType.endsWith('.succeeded') ? 'succeeded' : input.eventType.endsWith('.failed') || input.eventType.endsWith('.denied') ? 'failed' : 'requested',
      reason: input.reason || undefined,
      client: clientSummary(input.req),
      networkFingerprint: networkFingerprint(input.req),
      requestId: input.req.headers.get('x-request-id') || input.req.headers.get('x-vercel-id') || undefined,
    },
  })
}
