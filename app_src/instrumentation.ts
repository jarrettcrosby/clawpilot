/**
 * Platform-neutral hosted runtime bootstrap.
 *
 * Railway also verifies the durable integration-key sentinel before starting
 * Next.js. This hook covers any Next.js Node runtime that is explicitly given
 * the authenticated Postgres production contract. Normal Vercel previews are
 * compile/UI-only, have no production database or secrets, and return below.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const runtimeGate = await import(
    './lib/integrations/integrationCredentialRuntimeGate.mjs'
  )
  if (!runtimeGate.integrationCredentialRuntimeEnforcementRequired()) return

  const postgres = await import('./lib/persistence/postgres')
  const client = { query: postgres.query }
  await runtimeGate.refreshIntegrationCredentialRuntimeReadiness({
    client,
    allowMissingProof: true,
  })
  runtimeGate.scheduleIntegrationCredentialRuntimeRefresh({ client })
}
