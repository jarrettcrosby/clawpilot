#!/usr/bin/env node

import { createRequire } from 'node:module'

import {
  INTEGRATION_CREDENTIAL_RUNTIME_PROOF_ENV,
  IntegrationCredentialRuntimeGateError,
  refreshIntegrationCredentialRuntimeReadiness,
  resolveIntegrationCredentialRuntimeConfiguration,
} from '../app_src/lib/integrations/integrationCredentialRuntimeGate.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

function safeErrorCode(error) {
  return error instanceof IntegrationCredentialRuntimeGateError
    ? error.code
    : 'INTEGRATION_CREDENTIAL_RUNTIME_VERIFICATION_FAILED'
}

async function main() {
  const configuration = resolveIntegrationCredentialRuntimeConfiguration()
  if (!configuration.hosted) {
    throw new IntegrationCredentialRuntimeGateError(
      'INTEGRATION_CREDENTIAL_RUNTIME_HOSTED_REQUIRED',
    )
  }
  const sslMode = String(
    process.env.PGSSLMODE || process.env.DATABASE_SSL || '',
  ).toLowerCase()
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslMode === 'require' || sslMode === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    max: 1,
  })
  try {
    const attestation = await refreshIntegrationCredentialRuntimeReadiness({
      client: pool,
      configuration,
      allowMissingProof: true,
    })
    if (!attestation.providerIoReady) {
      process.stderr.write(
        `[integration-credential-runtime] ${attestation.status}; `
        + 'provider credential access remains disabled\n',
      )
    }
    process.stdout.write(
      String(process.env[INTEGRATION_CREDENTIAL_RUNTIME_PROOF_ENV] || ''),
    )
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  process.stderr.write(
    `[integration-credential-runtime] ${safeErrorCode(error)}\n`,
  )
  process.exitCode = 1
})
