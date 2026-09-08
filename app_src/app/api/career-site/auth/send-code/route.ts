import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { sendCareerDeskMagicCodeEmail } from '@/lib/matonMail'
import { normalizeUserEmail } from '@/lib/users'
import { resolveCareerSiteAgentConfiguration } from '@/lib/careerSiteAgentContract'
import { resolveShortLinkActor, validateShortLinkConfiguration } from '@/lib/shortlinks'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_BYTES = 2048
const WINDOW_MS = 15 * 60 * 1000
const attempts = new Map<string, { count: number; resetAt: number; lastAt: number }>()

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
}

async function readBody(req: NextRequest): Promise<{ email: string; code: string }> {
  if (Number(req.headers.get('content-length')) > MAX_BYTES || !req.body) throw new Error('invalid')
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new Error('invalid')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid')
  const record = body as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'email' && key !== 'code')) throw new Error('invalid')
  if (typeof record.email !== 'string' || typeof record.code !== 'string' || !/^\d{6}$/.test(record.code)) throw new Error('invalid')
  return { email: normalizeUserEmail(record.email), code: record.code }
}

export async function POST(req: NextRequest) {
  try {
    const configuration = resolveCareerSiteAgentConfiguration()
    validateShortLinkConfiguration({ requireServiceClient: true })
    const actor = await resolveShortLinkActor(req)
    if (!configuration.enabled || !actor.service
      || actor.sourceApp !== configuration.sourceApp
      || actor.ownerEmail !== configuration.ownerEmail
      || actor.organizationId !== configuration.organizationId) return json({ ok: false }, 403)
  } catch {
    return json({ ok: false }, 403)
  }

  let input: { email: string; code: string }
  try { input = await readBody(req) } catch { return json({ ok: false }, 400) }
  const now = Date.now()
  for (const [key, entry] of attempts) if (entry.resetAt <= now) attempts.delete(key)
  const key = crypto.createHash('sha256').update(input.email).digest('hex')
  const prior = attempts.get(key)
  if ((prior && (prior.count >= 5 || now - prior.lastAt < 60_000)) || attempts.size >= 1000) {
    return json({ ok: false }, 429)
  }
  attempts.set(key, { count: (prior?.count || 0) + 1, resetAt: prior?.resetAt || now + WINDOW_MS, lastAt: now })
  try {
    await sendCareerDeskMagicCodeEmail({ to: input.email, code: input.code })
    return json({ ok: true })
  } catch {
    // Delivery errors can contain provider details; never log request content or codes.
    return json({ ok: false }, 503)
  }
}
