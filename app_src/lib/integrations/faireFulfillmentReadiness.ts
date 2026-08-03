export const FAIRE_FULFILLMENT_REQUIRED_OAUTH_SCOPES = [
  'READ_BRAND',
  'READ_ORDERS',
  'READ_SHIPMENTS',
  'WRITE_ORDERS',
] as const

export const FAIRE_FULFILLMENT_REQUIRED_ACTIVE_CAPABILITIES = [
  'order_update',
  'fulfillment_export',
  'tracking_export',
] as const

export type FaireFulfillmentWriteReadiness = {
  ready: boolean
  authMode: string | null
  requiredAuthMode: 'faire_oauth'
  requiredScopes: readonly string[]
  credentialBinding: {
    configured: boolean
    production: boolean
    active: boolean
    verified: boolean
    externalIdentityMatches: boolean
    credentialGenerationMatches: boolean
    current: boolean
  }
  providerScopeEvidence: {
    recordedForCredentialGeneration: boolean
    current: boolean
    verificationSource: string | null
  }
  activeCapabilities: {
    required: readonly string[]
    current: string[]
    missing: string[]
  }
  blockedBy: {
    code: string
    message: string
  } | null
  providerWrites: 0
}

export type FaireFulfillmentWriteReadinessInput = {
  authMode: string | null
  environment: string
  status: string
  configured: boolean
  verificationStatus: string
  externalIdentityMatches: boolean
  credentialGenerationMatches: boolean
  scopeEvidenceRecorded: boolean
  scopeEvidenceCurrent: boolean
  scopeVerificationSource: string | null
  currentCapabilities: readonly string[]
}

function block(code: string, message: string) {
  return { code, message }
}

export function faireFulfillmentWriteReadiness(
  input: FaireFulfillmentWriteReadinessInput,
): FaireFulfillmentWriteReadiness {
  const currentCapabilities = [
    ...new Set(input.currentCapabilities.filter((capability) => (
      FAIRE_FULFILLMENT_REQUIRED_ACTIVE_CAPABILITIES.includes(
        capability as typeof FAIRE_FULFILLMENT_REQUIRED_ACTIVE_CAPABILITIES[number],
      )
    ))),
  ].sort()
  const missingCapabilities =
    FAIRE_FULFILLMENT_REQUIRED_ACTIVE_CAPABILITIES.filter(
      (capability) => !currentCapabilities.includes(capability),
    )
  const credentialBinding = {
    configured: input.configured,
    production: input.environment === 'production',
    active: input.status === 'active',
    verified: input.verificationStatus === 'verified',
    externalIdentityMatches: input.externalIdentityMatches,
    credentialGenerationMatches: input.credentialGenerationMatches,
    current: false,
  }
  credentialBinding.current = (
    credentialBinding.configured
    && credentialBinding.production
    && credentialBinding.active
    && credentialBinding.verified
    && credentialBinding.externalIdentityMatches
    && credentialBinding.credentialGenerationMatches
  )

  let blockedBy: FaireFulfillmentWriteReadiness['blockedBy'] = null
  if (!input.configured) {
    blockedBy = block(
      'FAIRE_FULFILLMENT_CREDENTIAL_REQUIRED',
      'Connect a current Faire credential before fulfillment can be authorized.',
    )
  } else if (input.authMode !== 'faire_oauth') {
    blockedBy = block(
      'FAIRE_FULFILLMENT_OAUTH_REQUIRED',
      'Faire fulfillment requires Custom App OAuth; a generated brand API key remains read-only in ClawPilot.',
    )
  } else if (!credentialBinding.production) {
    blockedBy = block(
      'FAIRE_FULFILLMENT_PRODUCTION_ACCOUNT_REQUIRED',
      'Faire fulfillment requires the verified production brand identity.',
    )
  } else if (!credentialBinding.active) {
    blockedBy = block(
      'FAIRE_FULFILLMENT_CONNECTION_ACTIVE_REQUIRED',
      'Enable the Faire connection before fulfillment can be authorized.',
    )
  } else if (!credentialBinding.verified) {
    blockedBy = block(
      'FAIRE_FULFILLMENT_CONNECTION_VERIFICATION_REQUIRED',
      'Verify the current Faire OAuth credential before fulfillment can be authorized.',
    )
  } else if (
    !credentialBinding.externalIdentityMatches
    || !credentialBinding.credentialGenerationMatches
  ) {
    blockedBy = block(
      'FAIRE_FULFILLMENT_CREDENTIAL_BINDING_MISMATCH',
      'The Faire credential no longer matches the exact brand identity or credential generation.',
    )
  } else if (!input.scopeEvidenceCurrent) {
    blockedBy = block(
      input.scopeEvidenceRecorded
        ? 'FAIRE_FULFILLMENT_SCOPE_EVIDENCE_STALE'
        : 'FAIRE_FULFILLMENT_SCOPE_EVIDENCE_UNAVAILABLE',
      input.scopeEvidenceRecorded
        ? 'Recorded Faire scope evidence is not current for this exact credential generation.'
        : 'Faire has not supplied provider-verifiable granted-scope evidence; requested scopes cannot authorize writes.',
    )
  } else if (missingCapabilities.length) {
    blockedBy = block(
      'FAIRE_FULFILLMENT_ACTIVE_CAPABILITIES_REQUIRED',
      `Authorize the current Active cohort for ${missingCapabilities.join(', ')}.`,
    )
  }

  return {
    ready: blockedBy === null,
    authMode: input.authMode,
    requiredAuthMode: 'faire_oauth',
    requiredScopes: [...FAIRE_FULFILLMENT_REQUIRED_OAUTH_SCOPES],
    credentialBinding,
    providerScopeEvidence: {
      recordedForCredentialGeneration: input.scopeEvidenceRecorded,
      current: input.scopeEvidenceCurrent,
      verificationSource: input.scopeVerificationSource,
    },
    activeCapabilities: {
      required: [...FAIRE_FULFILLMENT_REQUIRED_ACTIVE_CAPABILITIES],
      current: currentCapabilities,
      missing: missingCapabilities,
    },
    blockedBy,
    providerWrites: 0,
  }
}
