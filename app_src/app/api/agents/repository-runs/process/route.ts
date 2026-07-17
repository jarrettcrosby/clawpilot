import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { processRepositoryRunOutbox } from '@/lib/repositoryRunWorker'

function secureEqual(left: string, right: string): boolean {
  if (!left || !right) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (expected.length < 32 || !secureEqual(expected, provided)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(body.maxAttempts) || 5), 10))
  try {
    return NextResponse.json(await processRepositoryRunOutbox({ maxAttempts }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Repository runner failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
