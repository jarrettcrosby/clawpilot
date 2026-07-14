import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { processDocumentEmbeddingJobs } from '@/lib/documentEmbeddings'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function authorized(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (expected.length < 32 || !provided) return false
  const expectedHash = crypto.createHash('sha256').update(expected).digest()
  const providedHash = crypto.createHash('sha256').update(provided).digest()
  return crypto.timingSafeEqual(expectedHash, providedHash)
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({})) as { limit?: unknown }
    return NextResponse.json({ ok: true, ...await processDocumentEmbeddingJobs(body.limit) })
  } catch (error) {
    console.error('[document-embeddings] processing failed', error)
    return NextResponse.json({ ok: false, error: 'Document embedding processing failed' }, { status: 500 })
  }
}
