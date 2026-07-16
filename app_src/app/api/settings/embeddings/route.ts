import { NextRequest, NextResponse } from 'next/server'
import { readDocumentEmbeddingSettings } from '@/lib/documentEmbeddings'
import { withTransaction } from '@/lib/persistence/postgres'
import { requireRequestUser } from '@/lib/requestUser'

const SETTINGS_KEY = 'documents.embedding.configuration'

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Embedding settings request failed'
  const status = message === 'Unauthorized' ? 401 : /permission/i.test(message) ? 403 : 400
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (actor.role !== 'owner') throw new Error('You do not have permission to manage embedding settings')
    return NextResponse.json({ ok: true, settings: await readDocumentEmbeddingSettings() })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (actor.role !== 'owner') throw new Error('You do not have permission to manage embedding settings')
    const body = await req.json().catch(() => ({}))
    const provider = String(body?.provider || '').trim().toLowerCase()
    if (provider !== 'local' && provider !== 'openai') throw new Error('Embedding provider must be local or openai')
    if (provider === 'openai' && String(process.env.OPENAI_EMBEDDING_API_KEY || '').trim().length < 20) {
      throw new Error('Configure the dedicated OpenAI embedding key before enabling external embeddings')
    }
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [SETTINGS_KEY, JSON.stringify({ provider, updatedBy: actor.email, updatedAt: new Date().toISOString() })],
      )
      await client.query(
        `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
         VALUES ($1, 'documents.embedding.provider.updated', 'app_setting', $2, $3::jsonb)`,
        [actor.email, SETTINGS_KEY, JSON.stringify({ provider })],
      )
    })
    return NextResponse.json({ ok: true, settings: await readDocumentEmbeddingSettings() })
  } catch (error) {
    return errorResponse(error)
  }
}
