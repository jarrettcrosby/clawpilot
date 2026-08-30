import crypto from 'node:crypto'
import type { NextRequest } from 'next/server'
import { CareerSiteLinkedInRequestError } from '@/lib/careerSiteLinkedInContract'

const SIGNATURE_VERSION = 'clawpilot-linkedin-worker-v1'
const NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i
export const CAREER_SITE_LINKEDIN_WORKER_CLOCK_SKEW_SECONDS = 300

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)
}

export function careerSiteLinkedInWorkerSignature(input: {
  secret: string
  method: string
  pathname: string
  timestamp: string
  nonce: string
  body: string
}): string {
  const bodyHash = crypto.createHash('sha256').update(input.body, 'utf8').digest('hex')
  const canonical = [
    SIGNATURE_VERSION,
    input.method.toUpperCase(),
    input.pathname,
    input.timestamp,
    input.nonce.toLowerCase(),
    bodyHash,
  ].join('\n')
  return crypto.createHmac('sha256', input.secret).update(canonical, 'utf8').digest('hex')
}

/**
 * Worker requests use an isolated Bearer token plus a distinct HMAC secret.
 * The caller signs the exact UTF-8 request bytes with the HMAC secret:
 *
 *   HMAC-SHA256(secret,
 *     "clawpilot-linkedin-worker-v1\\n" + METHOD + "\\n" + PATH + "\\n" +
 *     UNIX_SECONDS + "\\n" + LOWERCASE_UUID_NONCE + "\\n" + SHA256_HEX(BODY))
 *
 * Headers are x-clawpilot-linkedin-worker-id, -timestamp, -nonce, and
 * -signature. ClawPilot accepts at most five minutes of clock skew and stores
 * each valid worker-id/nonce pair before executing it, so a signed request can
 * be used only once. Retries must use a fresh nonce and signature; durable
 * request/lease IDs make the command itself idempotent.
 */
export function verifyCareerSiteLinkedInWorkerSignature(input: {
  req: NextRequest
  body: string
  bearerToken: string
  hmacSecret: string
  now?: Date
}): {
  workerId: string
  nonce: string
  requestTimestamp: string
  expiresAt: string
} {
  const authorization = String(input.req.headers.get('authorization') || '')
  const expectedAuthorization = `Bearer ${input.bearerToken}`
  const workerId = String(input.req.headers.get('x-clawpilot-linkedin-worker-id') || '').trim()
  const timestamp = String(input.req.headers.get('x-clawpilot-linkedin-timestamp') || '').trim()
  const nonce = String(input.req.headers.get('x-clawpilot-linkedin-nonce') || '').trim().toLowerCase()
  const signature = String(input.req.headers.get('x-clawpilot-linkedin-signature') || '').trim().toLowerCase()
  const seconds = Number(timestamp)
  const now = input.now || new Date()
  if (
    !safeEqual(authorization, expectedAuthorization)
    || !WORKER_ID_PATTERN.test(workerId)
    || !/^\d{10}$/.test(timestamp)
    || !Number.isSafeInteger(seconds)
    || Math.abs(Math.floor(now.getTime() / 1000) - seconds) > CAREER_SITE_LINKEDIN_WORKER_CLOCK_SKEW_SECONDS
    || !NONCE_PATTERN.test(nonce)
    || !SIGNATURE_PATTERN.test(signature)
  ) {
    throw new CareerSiteLinkedInRequestError(
      'LinkedIn browser worker authorization failed',
      401,
      'CAREER_SITE_LINKEDIN_WORKER_UNAUTHORIZED',
    )
  }
  const expected = careerSiteLinkedInWorkerSignature({
    secret: input.hmacSecret,
    method: input.req.method,
    pathname: input.req.nextUrl.pathname,
    timestamp,
    nonce,
    body: input.body,
  })
  if (!safeEqual(signature, expected)) {
    throw new CareerSiteLinkedInRequestError(
      'LinkedIn browser worker authorization failed',
      401,
      'CAREER_SITE_LINKEDIN_WORKER_UNAUTHORIZED',
    )
  }
  const requestTimestamp = new Date(seconds * 1000).toISOString()
  return {
    workerId,
    nonce,
    requestTimestamp,
    expiresAt: new Date((seconds + CAREER_SITE_LINKEDIN_WORKER_CLOCK_SKEW_SECONDS) * 1000).toISOString(),
  }
}
