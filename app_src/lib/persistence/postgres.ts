import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

type GlobalWithPg = typeof globalThis & {
  __clawpilotPgPool?: Pool
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
  return getPostgresPool().query<T>(text, values)
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
    throw error
  } finally {
    client.release()
  }
}
