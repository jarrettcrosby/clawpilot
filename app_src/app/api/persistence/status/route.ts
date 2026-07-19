import { NextResponse } from 'next/server'
import { getStorageDriver, isHostedRuntime } from '@/lib/persistence/config'
import { query as queryAgentCredentials } from '@/lib/persistence/agentCredentials'
import { query } from '@/lib/persistence/postgres'

export async function GET() {
  const driver = getStorageDriver()

  if (driver !== 'postgres') {
    const hosted = isHostedRuntime()
    return NextResponse.json({
      ok: !hosted,
      driver,
      database: 'not-configured',
    }, { status: hosted ? 503 : 200 })
  }

  const [databaseResult, credentialResult] = await Promise.allSettled([
    query<{ now: string; database_fingerprint: string | null }>(
      `SELECT now()::text AS now,
         (SELECT value ->> 'id' FROM app_settings WHERE key = 'deployment.database.identity') AS database_fingerprint`,
    ),
    queryAgentCredentials('SELECT operator_id FROM agent_chatgpt_credentials LIMIT 1'),
  ])
  const databaseFingerprint = databaseResult.status === 'fulfilled'
    ? databaseResult.value.rows[0]?.database_fingerprint || null
    : null
  const ok = databaseResult.status === 'fulfilled'
    && credentialResult.status === 'fulfilled'
    && Boolean(databaseFingerprint)
  const errors = [databaseResult, credentialResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))
  if (databaseResult.status === 'fulfilled' && !databaseFingerprint) {
    errors.push('database identity is missing')
  }

  return NextResponse.json({
    ok,
    driver,
    database: databaseResult.status === 'fulfilled' ? 'reachable' : 'unreachable',
    agentCredentials: credentialResult.status === 'fulfilled' ? 'reachable' : 'unreachable',
    databaseFingerprint,
    checkedAt: databaseResult.status === 'fulfilled'
      ? databaseResult.value.rows[0]?.now || new Date().toISOString()
      : new Date().toISOString(),
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  }, { status: ok ? 200 : 503 })
}
