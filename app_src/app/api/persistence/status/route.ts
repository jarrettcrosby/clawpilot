import { NextResponse } from 'next/server'
import { resolveCareerSiteSubmissionConfiguration } from '@/lib/careerSiteSubmissionContract'
import { getStorageDriver, isHostedRuntime } from '@/lib/persistence/config'
import { query as queryAgentCredentials } from '@/lib/persistence/agentCredentials'
import { readCareerSiteSubmissionOperationalHealthFromPostgres } from '@/lib/persistence/careerSiteSubmissions'
import { query } from '@/lib/persistence/postgres'

export async function GET() {
  const driver = getStorageDriver()

  if (driver !== 'postgres') {
    const hosted = isHostedRuntime()
    const careerSiteEnabled = process.env.CAREER_SITE_SUBMISSIONS_ENABLED === '1'
    return NextResponse.json({
      ok: !hosted && !careerSiteEnabled,
      driver,
      database: 'not-configured',
      careerSiteSubmissions: {
        enabled: careerSiteEnabled,
        healthy: !careerSiteEnabled,
        status: careerSiteEnabled ? 'unhealthy' : 'disabled',
      },
    }, { status: hosted || careerSiteEnabled ? 503 : 200 })
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
  let ok = databaseResult.status === 'fulfilled'
    && credentialResult.status === 'fulfilled'
    && Boolean(databaseFingerprint)
  const errors = [databaseResult, credentialResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))
  if (databaseResult.status === 'fulfilled' && !databaseFingerprint) {
    errors.push('database identity is missing')
  }
  let careerSiteSubmissions: Record<string, unknown> = {
    enabled: false,
    healthy: true,
    status: 'disabled',
  }
  if (process.env.CAREER_SITE_SUBMISSIONS_ENABLED === '1') {
    try {
      const configuration = resolveCareerSiteSubmissionConfiguration()
      if (!configuration.ownerEmail) throw new Error('career-site owner identity is missing')
      careerSiteSubmissions = await readCareerSiteSubmissionOperationalHealthFromPostgres({
        sourceApp: configuration.sourceApp,
        ownerEmail: configuration.ownerEmail,
        pollMs: Number(process.env.CAREER_SITE_SUBMISSIONS_POLL_MS) || undefined,
        leaseSeconds: 900,
      })
      if (careerSiteSubmissions.healthy !== true) {
        ok = false
        errors.push('career-site submission delivery is unhealthy')
      }
    } catch {
      careerSiteSubmissions = {
        enabled: true,
        healthy: false,
        status: 'unhealthy',
      }
      ok = false
      errors.push('career-site submission delivery health could not be verified')
    }
  }

  return NextResponse.json({
    ok,
    driver,
    database: databaseResult.status === 'fulfilled' ? 'reachable' : 'unreachable',
    agentCredentials: credentialResult.status === 'fulfilled' ? 'reachable' : 'unreachable',
    careerSiteSubmissions,
    databaseFingerprint,
    checkedAt: databaseResult.status === 'fulfilled'
      ? databaseResult.value.rows[0]?.now || new Date().toISOString()
      : new Date().toISOString(),
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  }, { status: ok ? 200 : 503 })
}
