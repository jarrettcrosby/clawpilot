import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

type GlobalWithPg = typeof globalThis & {
  __clawpilotPgPool?: Pool
}

export const SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY_CODE =
  'OPERATIONS_SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY'

export class PostgresPersistenceConflictError extends Error {
  readonly status = 409

  constructor(readonly code: string) {
    super(code)
    this.name = 'PostgresPersistenceConflictError'
  }
}

export function normalizePostgresPersistenceError(error: unknown): unknown {
  if (error instanceof PostgresPersistenceConflictError) return error
  if (
    error instanceof Error
    && error.message === SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY_CODE
    && error
    && typeof error === 'object'
    && 'code' in error
    && error.code === '55P03'
  ) {
    return new PostgresPersistenceConflictError(
      SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY_CODE,
    )
  }
  return error
}

function buildPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for Postgres storage')
  }

  const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  })
}

export function getPostgresPool(): Pool {
  const g = globalThis as GlobalWithPg
  if (!g.__clawpilotPgPool) {
    g.__clawpilotPgPool = buildPool()
  }
  return g.__clawpilotPgPool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  try {
    return await getPostgresPool().query<T>(text, values)
  } catch (error) {
    throw normalizePostgresPersistenceError(error)
  }
}

export async function acquireTransactionAdvisoryLock(client: PoolClient, key: string) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    [key],
  )
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw normalizePostgresPersistenceError(error)
  } finally {
    client.release()
  }
}
