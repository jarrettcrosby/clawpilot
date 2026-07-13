import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

type GlobalWithAgentCredentialPg = typeof globalThis & {
  __clawpilotAgentCredentialPgPool?: Pool
}

function connectionOptions(): { connectionString: string; ssl?: { rejectUnauthorized: false } } {
  const configured = String(
    process.env.AGENT_CREDENTIAL_DATABASE_URL
      || process.env.DATABASE_URL
      || '',
  ).trim()
  if (!configured) throw new Error('AGENT_CREDENTIAL_DATABASE_URL or DATABASE_URL is required for ChatGPT authorization')

  let connectionString = configured
  let urlSslMode = ''
  try {
    const parsed = new URL(configured)
    urlSslMode = String(parsed.searchParams.get('sslmode') || '').toLowerCase()
    parsed.searchParams.delete('sslmode')
    connectionString = parsed.toString()
  } catch {
    // pg will report a useful connection error for non-URL connection strings.
  }

  const sslMode = String(
    process.env.AGENT_CREDENTIAL_DATABASE_SSL
      || urlSslMode
      || process.env.PGSSLMODE
      || process.env.DATABASE_SSL
      || '',
  ).toLowerCase()
  return {
    connectionString,
    ...(sslMode === 'require' || sslMode === 'true'
      ? { ssl: { rejectUnauthorized: false } as const }
      : {}),
  }
}

function buildPool(): Pool {
  return new Pool({
    ...connectionOptions(),
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    max: 5,
  })
}

export function getAgentCredentialPool(): Pool {
  const globalScope = globalThis as GlobalWithAgentCredentialPg
  if (!globalScope.__clawpilotAgentCredentialPgPool) {
    globalScope.__clawpilotAgentCredentialPgPool = buildPool()
  }
  return globalScope.__clawpilotAgentCredentialPgPool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return getAgentCredentialPool().query<T>(text, values)
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAgentCredentialPool().connect()
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
