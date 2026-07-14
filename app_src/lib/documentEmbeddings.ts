import { createHash } from 'node:crypto'
import { withTransaction, query } from '@/lib/persistence/postgres'

const DEFAULT_MODEL = 'text-embedding-3-small'
const LOCAL_MODEL = 'clawpilot-hash-vector-v1'
const EMBEDDING_DIMENSIONS = 256
const MAX_ATTEMPTS = 5
const MAX_BATCH_SIZE = 24
const MAX_DOCUMENT_CHARACTERS = 24_000
const JOB_LEASE_MINUTES = 5

type EmbeddingJob = {
  document_id: string
  owner_email: string
  content_hash: string
  attempts: number
  title: string
  content: string
  locked_at: string
}

type EmbeddingResponse = {
  data?: Array<{ index?: number; embedding?: number[] }>
  error?: { message?: string }
}

export function documentEmbeddingConfiguration() {
  const providerValue = String(process.env.DOCUMENT_EMBEDDINGS_PROVIDER || 'local').trim().toLowerCase()
  if (!['local', 'openai'].includes(providerValue)) {
    throw new Error('DOCUMENT_EMBEDDINGS_PROVIDER must be local or openai')
  }
  const apiKey = String(process.env.OPENAI_EMBEDDING_API_KEY || '').trim()
  const openAiModel = String(process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL
  if (providerValue === 'openai') {
    if (apiKey.length < 20) {
      throw new Error('OPENAI_EMBEDDING_API_KEY is required when DOCUMENT_EMBEDDINGS_PROVIDER=openai')
    }
    return { apiKey, model: openAiModel, provider: 'openai' as const, sendsDocumentContentExternally: true }
  }
  return { apiKey: '', model: LOCAL_MODEL, provider: 'local' as const, sendsDocumentContentExternally: false }
}

function vectorLiteral(values: number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding response must contain ${EMBEDDING_DIMENSIONS} finite values`)
  }
  return `[${values.join(',')}]`
}

function embeddingInput(title: string, content: string): string {
  return `${title.trim()}\n\n${content.trim()}`.slice(0, MAX_DOCUMENT_CHARACTERS)
}

function localEmbedding(value: string): number[] {
  const words = value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,39}/g)?.slice(0, 8_000) || []
  const features = [...words, ...words.slice(1).map((word, index) => `${words[index]}:${word}`)]
  if (features.length === 0) features.push(value.trim().toLowerCase() || 'empty')
  const counts = new Map<string, number>()
  for (const feature of features) counts.set(feature, (counts.get(feature) || 0) + 1)
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0)
  for (const [feature, count] of counts) {
    const digest = createHash('sha256').update(feature).digest()
    const index = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS
    const sign = digest[4] % 2 === 0 ? 1 : -1
    vector[index] += sign * (1 + Math.log(count))
  }
  const magnitude = Math.sqrt(vector.reduce((sum, valueAtIndex) => sum + valueAtIndex ** 2, 0)) || 1
  return vector.map((valueAtIndex) => valueAtIndex / magnitude)
}

async function requestEmbeddings(input: string[], apiKey: string, model: string): Promise<number[][]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input, dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float' }),
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await response.json().catch(() => ({})) as EmbeddingResponse
  if (!response.ok) {
    throw new Error(payload.error?.message || `OpenAI embeddings request returned HTTP ${response.status}`)
  }
  const embeddings = Array.isArray(payload.data)
    ? payload.data.slice().sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
      .map((entry) => entry.embedding || [])
    : []
  if (embeddings.length !== input.length) {
    throw new Error(`OpenAI embeddings response contained ${embeddings.length} results for ${input.length} inputs`)
  }
  embeddings.forEach(vectorLiteral)
  return embeddings
}

async function recordHeartbeat(phase: string, details: Record<string, unknown>) {
  await query(
    `
      INSERT INTO knowledge_worker_heartbeat (worker_name, checked_at, phase, details)
      VALUES ('document-embeddings', now(), $1, $2::jsonb)
      ON CONFLICT (worker_name) DO UPDATE SET
        checked_at = now(), phase = EXCLUDED.phase, details = EXCLUDED.details
    `,
    [phase, JSON.stringify(details)],
  )
}

async function ensureJobsForModel(model: string) {
  await query(
    `
      INSERT INTO document_embedding_jobs (document_id, owner_email, content_hash)
      SELECT id, owner_email, content_hash
      FROM app_documents
      WHERE embedding_content_hash IS DISTINCT FROM content_hash
         OR embedding_model IS DISTINCT FROM $1
      ON CONFLICT (document_id) DO UPDATE SET
        owner_email = EXCLUDED.owner_email,
        content_hash = EXCLUDED.content_hash,
        status = 'pending',
        attempts = 0,
        available_at = now(),
        locked_at = NULL,
        last_error = NULL,
        updated_at = now()
      WHERE document_embedding_jobs.content_hash IS DISTINCT FROM EXCLUDED.content_hash
         OR document_embedding_jobs.status = 'completed'
    `,
    [model],
  )
}

async function claimJobs(limit: number): Promise<EmbeddingJob[]> {
  return withTransaction(async (client) => {
    await client.query(
      `
        UPDATE document_embedding_jobs
        SET status = 'failed',
            locked_at = NULL,
            last_error = 'Embedding worker lease expired after maximum attempts',
            updated_at = now()
        WHERE status = 'processing'
          AND locked_at <= now() - ($2::integer * interval '1 minute')
          AND attempts >= $1
      `,
      [MAX_ATTEMPTS, JOB_LEASE_MINUTES],
    )
    const claimed = await client.query<{ document_id: string; locked_at: string }>(
      `
        WITH candidates AS (
          SELECT jobs.document_id
          FROM document_embedding_jobs jobs
          WHERE (
              (jobs.status IN ('pending', 'failed') AND jobs.available_at <= now())
              OR (jobs.status = 'processing' AND jobs.locked_at <= now() - ($3::integer * interval '1 minute'))
            )
            AND jobs.attempts < $1
          ORDER BY jobs.available_at, jobs.updated_at, jobs.document_id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE document_embedding_jobs jobs
        SET status = 'processing',
            attempts = jobs.attempts + 1,
            locked_at = now(),
            last_error = NULL,
            updated_at = now()
        FROM candidates
        WHERE jobs.document_id = candidates.document_id
        RETURNING jobs.document_id::text, jobs.locked_at::text
      `,
      [MAX_ATTEMPTS, limit, JOB_LEASE_MINUTES],
    )
    if (claimed.rows.length === 0) return []
    const documents = await client.query<EmbeddingJob>(
      `
        SELECT
          jobs.document_id::text,
          jobs.owner_email,
          jobs.content_hash,
          jobs.attempts,
          jobs.locked_at::text,
          documents.title,
          documents.content
        FROM document_embedding_jobs jobs
        JOIN app_documents documents ON documents.id = jobs.document_id
        WHERE jobs.document_id = ANY($1::uuid[])
        ORDER BY jobs.updated_at, jobs.document_id
      `,
      [claimed.rows.map((row) => row.document_id)],
    )
    const lockByDocument = new Map(claimed.rows.map((row) => [row.document_id, row.locked_at]))
    return documents.rows.map((row) => ({ ...row, locked_at: lockByDocument.get(row.document_id) || row.locked_at }))
  })
}

async function markFailed(jobs: EmbeddingJob[], error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
  await withTransaction(async (client) => {
    for (const job of jobs) {
      await client.query(
        `
          UPDATE document_embedding_jobs
          SET status = 'failed',
              locked_at = NULL,
              last_error = $3,
              available_at = now() + (LEAST(60, power(2, attempts))::text || ' minutes')::interval,
              updated_at = now()
          WHERE document_id = $1::uuid
            AND status = 'processing'
            AND locked_at = $2::timestamptz
        `,
        [job.document_id, job.locked_at, message],
      )
    }
  })
}

export async function processDocumentEmbeddingJobs(limitValue: unknown = 12) {
  const config = documentEmbeddingConfiguration()
  await ensureJobsForModel(config.model)
  const limit = Math.max(1, Math.min(Math.trunc(Number(limitValue) || 12), MAX_BATCH_SIZE))
  const jobs = await claimJobs(limit)
  if (jobs.length === 0) {
    await recordHeartbeat('idle', { model: config.model, claimed: 0 })
    return { enabled: true, provider: config.provider, claimed: 0, completed: 0, failed: 0, model: config.model }
  }
  await recordHeartbeat('running', { model: config.model, claimed: jobs.length })
  try {
    const inputs = jobs.map((job) => embeddingInput(job.title, job.content))
    const provider = config.provider
    const model = config.model
    const embeddings = config.provider === 'openai'
      ? await requestEmbeddings(inputs, config.apiKey, config.model)
      : inputs.map(localEmbedding)
    let completed = 0
    for (const [index, job] of jobs.entries()) {
      const result = await query(
        `
          WITH embedded AS (
            UPDATE app_documents
            SET embedding = $2::vector,
                embedding_model = $3,
                embedding_content_hash = $4,
                embedded_at = now()
            WHERE id = $1::uuid
              AND content_hash = $4
            RETURNING id
          )
          UPDATE document_embedding_jobs jobs
          SET status = 'completed',
              locked_at = NULL,
              last_error = NULL,
              updated_at = now()
          FROM embedded
          WHERE jobs.document_id = embedded.id
            AND jobs.content_hash = $4
            AND jobs.status = 'processing'
            AND jobs.locked_at = $5::timestamptz
        `,
        [job.document_id, vectorLiteral(embeddings[index]), model, job.content_hash, job.locked_at],
      )
      completed += result.rowCount || 0
    }
    await recordHeartbeat('completed', {
      model,
      provider,
      claimed: jobs.length,
      completed,
    })
    return { enabled: true, provider, claimed: jobs.length, completed, failed: jobs.length - completed, model }
  } catch (error) {
    await markFailed(jobs, error)
    await recordHeartbeat('failed', {
      model: config.model,
      claimed: jobs.length,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    })
    throw error
  }
}

export async function embedSearchQuery(value: string): Promise<{ vector: string; model: string } | null> {
  const search = value.replace(/\s+/g, ' ').trim().slice(0, 500)
  const config = documentEmbeddingConfiguration()
  if (!search) return null
  if (config.provider === 'local') return { vector: vectorLiteral(localEmbedding(search)), model: config.model }
  try {
    const [embedding] = await requestEmbeddings([search], config.apiKey, config.model)
    return { vector: vectorLiteral(embedding), model: config.model }
  } catch (error) {
    console.warn('[document-embeddings] semantic query unavailable; using full-text search only', error)
    return null
  }
}
