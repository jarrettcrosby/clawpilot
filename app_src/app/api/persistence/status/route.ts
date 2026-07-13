import { NextResponse } from 'next/server'
import { getStorageDriver } from '@/lib/persistence/config'
import { query as queryAgentCredentials } from '@/lib/persistence/agentCredentials'
import { query } from '@/lib/persistence/postgres'

export async function GET() {
  const driver = getStorageDriver()

  if (driver !== 'postgres') {
    return NextResponse.json({
      ok: true,
      driver,
      database: 'not-configured',
    })
  }

  const [databaseResult, credentialResult] = await Promise.allSettled([
    query<{ now: string }>('SELECT now()::text AS now'),
    queryAgentCredentials('SELECT operator_id FROM agent_chatgpt_credentials LIMIT 1'),
  ])
  const ok = databaseResult.status === 'fulfilled' && credentialResult.status === 'fulfilled'
  const errors = [databaseResult, credentialResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))

  return NextResponse.json({
    ok,
    driver,
    database: databaseResult.status === 'fulfilled' ? 'reachable' : 'unreachable',
    agentCredentials: credentialResult.status === 'fulfilled' ? 'reachable' : 'unreachable',
    checkedAt: databaseResult.status === 'fulfilled'
      ? databaseResult.value.rows[0]?.now || new Date().toISOString()
      : new Date().toISOString(),
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  }, { status: ok ? 200 : 503 })
}
