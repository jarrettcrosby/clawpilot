import {
  deriveIntegrationCredentialEncryptionKey,
} from '../../app_src/lib/integrations/integrationCredentialKeyAttestation.mjs'

export class IntegrationCredentialRuntimeGateError extends Error {
  constructor(code) {
    super(code)
    this.name = 'IntegrationCredentialRuntimeGateError'
    this.code = code
  }
}

export function isIntegrationCredentialRuntimeGateError(error) {
  return error instanceof IntegrationCredentialRuntimeGateError
}

/**
 * Test-only crypto adapter for older VM-based unit suites. Hosted attestation
 * behavior is covered by test-integration-credential-runtime-gate.mjs; these
 * suites isolate payload/AAD behavior and intentionally have no database.
 */
export function integrationCredentialRuntimeEncryptionKey(options = {}) {
  const environment = options.environment || process.env
  const secret = String(
    environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
    || environment.AGENT_CREDENTIAL_ENCRYPTION_KEY
    || environment.APP_SESSION_SECRET
    || '',
  )
  return deriveIntegrationCredentialEncryptionKey(secret)
}

export function assertIntegrationCredentialProviderIoReady() {
  return Object.freeze({
    mode: 'test',
    status: 'verified',
    providerIoReady: true,
  })
}
