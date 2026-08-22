import {
  decryptCommerceCredential,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  executeFaireFulfillmentWriteback,
  reconcileFaireFulfillmentWritebackReadOnly,
  type FaireFulfillmentWritebackInput,
  type FaireFulfillmentWritebackResult,
} from '@/lib/integrations/faireFulfillmentWriteback'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'
import {
  requireCurrentFaireFulfillmentScopeEvidenceInPostgres,
} from '@/lib/persistence/commerceActiveTransitionAuthorization'
import {
  requireCurrentCommerceProviderWritesInPostgres,
  requireSealedCommerceProviderWritesInPostgres,
} from '@/lib/persistence/commerceProviderWrites'

const REQUIRED_READ_OAUTH_SCOPES = [
  'READ_BRAND',
  'READ_ORDERS',
  'READ_SHIPMENTS',
] as const
const REQUIRED_WRITE_OAUTH_SCOPES = [
  ...REQUIRED_READ_OAUTH_SCOPES,
  'WRITE_ORDERS',
] as const
const PROVIDER_ATTEMPT_GLOBAL_ID = /^gxa(?:[0-9]{7}|[0-9a-v]{12})$/
const COMMERCE_EXPORT_GLOBAL_ID = /^gfe(?:[0-9]{7}|[0-9a-v]{12})$/
const SHA256 = /^[a-f0-9]{64}$/
const PROVIDER_ATTEMPT_LEASE_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type FaireFulfillmentRuntimeAuthority = {
  authorizationRevision: number
  credentialGeneration: number
  externalAccountId: string
}

export type CurrentFaireFulfillmentWritebackInput = Omit<
  FaireFulfillmentWritebackInput,
  'credential' | 'authorization'
> & {
  organizationId: unknown
  accountGlobalId: unknown
  providerWriteControlRowVersion?: unknown
  providerWriteCredentialGeneration?: unknown
  providerWriteScopeDigest?: unknown
  providerWriteAccountGlobalId?: unknown
  providerWriteProvider?: unknown
  providerWriteEnvironment?: unknown
  providerAttemptGlobalId?: unknown
  providerAttemptRequestHash?: unknown
  providerAttemptLeaseToken?: unknown
  commerceExportGlobalId?: unknown
}

type FaireProviderWriteExpectation = {
  providerWriteControlRowVersion?: unknown
  providerWriteCredentialGeneration?: unknown
  providerWriteScopeDigest?: unknown
  providerWriteAccountGlobalId?: unknown
  providerWriteProvider?: unknown
  providerWriteEnvironment?: unknown
  providerAttemptGlobalId?: unknown
  providerAttemptRequestHash?: unknown
  providerAttemptLeaseToken?: unknown
  commerceExportGlobalId?: unknown
}

export class FaireFulfillmentRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FaireFulfillmentRuntimeError'
  }
}

type FaireFulfillmentRuntimeDependencies = {
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  requireProviderWrites:
    typeof requireCurrentCommerceProviderWritesInPostgres
  requireSealedProviderWrites:
    typeof requireSealedCommerceProviderWritesInPostgres
  requireTrustedScopeEvidence:
    typeof requireCurrentFaireFulfillmentScopeEvidenceInPostgres
  decryptCredential: typeof decryptCommerceCredential
  executeWriteback: typeof executeFaireFulfillmentWriteback
  reconcileReadOnly: typeof reconcileFaireFulfillmentWritebackReadOnly
}

const DEFAULT_DEPENDENCIES: FaireFulfillmentRuntimeDependencies = {
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  requireProviderWrites: requireCurrentCommerceProviderWritesInPostgres,
  requireSealedProviderWrites: requireSealedCommerceProviderWritesInPostgres,
  requireTrustedScopeEvidence:
    requireCurrentFaireFulfillmentScopeEvidenceInPostgres,
  decryptCredential: decryptCommerceCredential,
  executeWriteback: executeFaireFulfillmentWriteback,
  reconcileReadOnly: reconcileFaireFulfillmentWritebackReadOnly,
}

async function currentAuthority(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
  } & FaireProviderWriteExpectation,
  dependencies: FaireFulfillmentRuntimeDependencies,
  authorityMode: 'provider_writes' | 'sealed_attempt' = 'provider_writes',
) {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  let providerWriteAuthority
  if (authorityMode === 'sealed_attempt') {
    const providerAttemptGlobalId = String(
      input.providerAttemptGlobalId || '',
    ).trim().toLowerCase()
    const providerAttemptRequestHash = String(
      input.providerAttemptRequestHash || '',
    ).trim().toLowerCase()
    const providerAttemptLeaseToken = String(
      input.providerAttemptLeaseToken || '',
    ).trim().toLowerCase()
    const commerceExportGlobalId = String(
      input.commerceExportGlobalId || '',
    ).trim().toLowerCase()
    if (
      !PROVIDER_ATTEMPT_GLOBAL_ID.test(providerAttemptGlobalId)
      || !SHA256.test(providerAttemptRequestHash)
      || !PROVIDER_ATTEMPT_LEASE_TOKEN.test(providerAttemptLeaseToken)
      || !COMMERCE_EXPORT_GLOBAL_ID.test(commerceExportGlobalId)
    ) {
      throw new FaireFulfillmentRuntimeError(
        'FAIRE_FULFILLMENT_PROVIDER_ATTEMPT_INVALID',
        'Execution requires an exact durable prepared provider attempt, request hash, and commerce export',
      )
    }
    if (
      input.providerWriteAccountGlobalId !== accountGlobalId
      || input.providerWriteProvider !== 'faire'
      || input.providerWriteEnvironment !== 'production'
    ) {
      throw new FaireFulfillmentRuntimeError(
        'FAIRE_FULFILLMENT_PROVIDER_AUTHORITY_MISMATCH',
        'Registered provider attempt authority does not match the exact Faire account',
      )
    }
    providerWriteAuthority =
      await dependencies.requireSealedProviderWrites({
        organizationId,
        accountGlobalId,
        provider: 'faire',
        environment: 'production',
        providerAttemptGlobalId,
        providerAttemptRequestHash,
        providerAttemptLeaseToken,
        commerceExportGlobalId,
        requiredScopes: REQUIRED_WRITE_OAUTH_SCOPES,
        expectedControlRowVersion: input.providerWriteControlRowVersion,
        expectedCredentialGeneration: input.providerWriteCredentialGeneration,
        expectedGrantedScopeDigest: input.providerWriteScopeDigest,
      })
  } else {
    providerWriteAuthority = await dependencies.requireProviderWrites({
      organizationId,
      accountGlobalId,
      provider: 'faire',
      requiredScopes: REQUIRED_WRITE_OAUTH_SCOPES,
      expectedControlRowVersion: input.providerWriteControlRowVersion,
      expectedCredentialGeneration: input.providerWriteCredentialGeneration,
      expectedGrantedScopeDigest: input.providerWriteScopeDigest,
    })
  }
  const runtime = await dependencies.readRuntimeCredential({
    organizationId,
    accountGlobalId,
  })
  if (
    !runtime
    || runtime.provider !== 'faire'
    || runtime.environment !== 'production'
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.authMode !== 'faire_oauth'
  ) {
    throw new FaireFulfillmentRuntimeError(
      'FAIRE_FULFILLMENT_CONNECTION_INVALID',
      'A verified active production Faire OAuth connection is required',
    )
  }
  if (
    providerWriteAuthority.provider !== 'faire'
    || providerWriteAuthority.environment !== 'production'
    || providerWriteAuthority.accountGlobalId !== accountGlobalId
    || providerWriteAuthority.credentialGeneration !== runtime.credentialVersion
    || REQUIRED_WRITE_OAUTH_SCOPES.some(
      (scope) => !providerWriteAuthority.grantedScopes.includes(scope),
    )
  ) {
    throw new FaireFulfillmentRuntimeError(
      'FAIRE_FULFILLMENT_AUTHORIZATION_STALE',
      'Faire fulfillment authority is stale; turn Provider writes Off, then On for the current connection',
    )
  }
  await dependencies.requireTrustedScopeEvidence({
    organizationId,
    accountGlobalId,
  })
  const credential = dependencies.decryptCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (
    credential.provider !== 'faire'
    || credential.authMode !== 'faire_oauth'
    || REQUIRED_WRITE_OAUTH_SCOPES.some(
      (scope) => !credential.scopes.includes(scope),
    )
  ) {
    throw new FaireFulfillmentRuntimeError(
      'FAIRE_FULFILLMENT_OAUTH_SCOPE_REQUIRED',
      'Faire OAuth must currently grant READ_BRAND, READ_ORDERS, READ_SHIPMENTS, and WRITE_ORDERS',
    )
  }
  const authorizationRevision = providerWriteAuthority.controlRowVersion
  return {
    organizationId,
    accountGlobalId,
    authority: {
      authorizationRevision,
      credentialGeneration: runtime.credentialVersion,
      externalAccountId: runtime.externalAccountId,
    } satisfies FaireFulfillmentRuntimeAuthority,
    credential: {
      accessToken: credential.accessToken,
      applicationId: credential.applicationId,
      applicationSecret: credential.applicationSecret,
      binding: {
        provider: 'faire' as const,
        environment: 'production' as const,
        accountGlobalId,
        externalAccountId: runtime.externalAccountId,
        credentialVersion: runtime.credentialVersion,
        connectionStatus: 'active' as const,
        verificationStatus: 'verified' as const,
      },
    },
    authorization: {
      provider: 'faire' as const,
      environment: 'production' as const,
      accountGlobalId,
      externalAccountId: runtime.externalAccountId,
      credentialVersion: runtime.credentialVersion,
      authorizationRevision,
      capabilities: [
        'order_processing' as const,
        'fulfillment_export' as const,
        'tracking_export' as const,
      ],
      verifiedWriteScopes: ['WRITE_ORDERS' as const],
      scopeVerificationSource: 'oauth_grant' as const,
    },
  }
}

async function currentReadAuthority(
  input: { organizationId: unknown; accountGlobalId: unknown },
  dependencies: FaireFulfillmentRuntimeDependencies,
) {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  const runtime = await dependencies.readRuntimeCredential({
    organizationId,
    accountGlobalId,
  })
  if (
    !runtime
    || runtime.provider !== 'faire'
    || runtime.environment !== 'production'
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.authMode !== 'faire_oauth'
  ) {
    throw new FaireFulfillmentRuntimeError(
      'FAIRE_FULFILLMENT_CONNECTION_INVALID',
      'A verified active production Faire OAuth connection is required for read-only reconciliation',
    )
  }
  const credential = dependencies.decryptCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (
    credential.provider !== 'faire'
    || credential.authMode !== 'faire_oauth'
    || REQUIRED_READ_OAUTH_SCOPES.some(
      (scope) => !credential.scopes.includes(scope),
    )
  ) {
    throw new FaireFulfillmentRuntimeError(
      'FAIRE_FULFILLMENT_READ_SCOPE_REQUIRED',
      'Faire OAuth must currently include READ_BRAND, READ_ORDERS, and READ_SHIPMENTS for read-only reconciliation',
    )
  }
  return {
    organizationId,
    accountGlobalId,
    credential: {
      accessToken: credential.accessToken,
      applicationId: credential.applicationId,
      applicationSecret: credential.applicationSecret,
      binding: {
        provider: 'faire' as const,
        environment: 'production' as const,
        accountGlobalId,
        externalAccountId: runtime.externalAccountId,
        credentialVersion: runtime.credentialVersion,
        connectionStatus: 'active' as const,
        verificationStatus: 'verified' as const,
      },
    },
  }
}

export async function prepareCurrentFaireFulfillmentAuthority(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
  } & FaireProviderWriteExpectation,
  dependencies: FaireFulfillmentRuntimeDependencies = DEFAULT_DEPENDENCIES,
): Promise<FaireFulfillmentRuntimeAuthority> {
  return (await currentAuthority(input, dependencies)).authority
}

export async function executeCurrentFaireFulfillmentWriteback(
  input: CurrentFaireFulfillmentWritebackInput,
  dependencies: FaireFulfillmentRuntimeDependencies = DEFAULT_DEPENDENCIES,
): Promise<FaireFulfillmentWritebackResult> {
  if (input.mode === 'reconcile_unknown') {
    const current = await currentReadAuthority(input, dependencies)
    return dependencies.reconcileReadOnly({
      mode: 'reconcile_unknown',
      writeAttempt: input.writeAttempt,
      credential: current.credential,
      externalOrderId: input.externalOrderId,
      ...(input.expectedShipDate === undefined
        ? {}
        : { expectedShipDate: input.expectedShipDate }),
      packages: input.packages,
    })
  }
  if (
    String(input.providerAttemptGlobalId || '').trim().toLowerCase()
      !== String(input.writeAttempt.attemptId || '').trim().toLowerCase()
  ) {
    throw new FaireFulfillmentRuntimeError(
      'FAIRE_FULFILLMENT_PROVIDER_ATTEMPT_INVALID',
      'The durable provider attempt does not match the exact Faire write attempt',
    )
  }
  const current = await currentAuthority(
    input,
    dependencies,
    'sealed_attempt',
  )
  return dependencies.executeWriteback(
    {
      mode: input.mode,
      writeAttempt: input.writeAttempt,
      credential: current.credential,
      authorization: current.authorization,
      externalOrderId: input.externalOrderId,
      ...(input.expectedShipDate === undefined
        ? {}
        : { expectedShipDate: input.expectedShipDate }),
      packages: input.packages,
    },
    undefined,
    async () => {
      await dependencies.requireSealedProviderWrites({
        organizationId: input.organizationId,
        accountGlobalId: input.accountGlobalId,
        provider: 'faire',
        environment: 'production',
        providerAttemptGlobalId: input.providerAttemptGlobalId,
        providerAttemptRequestHash: input.providerAttemptRequestHash,
        providerAttemptLeaseToken: input.providerAttemptLeaseToken,
        commerceExportGlobalId: input.commerceExportGlobalId,
        requiredScopes: REQUIRED_WRITE_OAUTH_SCOPES,
        expectedControlRowVersion: input.providerWriteControlRowVersion,
        expectedCredentialGeneration:
          input.providerWriteCredentialGeneration,
        expectedGrantedScopeDigest: input.providerWriteScopeDigest,
        leaseCheckPhase: 'provider_mutation',
      })
    },
  )
}
