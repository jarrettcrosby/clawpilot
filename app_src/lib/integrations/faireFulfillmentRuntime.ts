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
  requireCommerceActiveCapabilityClaimInPostgres,
  requireCurrentFaireFulfillmentScopeEvidenceInPostgres,
} from '@/lib/persistence/commerceActiveTransitionAuthorization'

const REQUIRED_READ_OAUTH_SCOPES = [
  'READ_BRAND',
  'READ_ORDERS',
  'READ_SHIPMENTS',
] as const
const REQUIRED_WRITE_OAUTH_SCOPES = [
  ...REQUIRED_READ_OAUTH_SCOPES,
  'WRITE_ORDERS',
] as const

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
}

export class FaireFulfillmentRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FaireFulfillmentRuntimeError'
  }
}

type FaireFulfillmentRuntimeDependencies = {
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  requireCapability: typeof requireCommerceActiveCapabilityClaimInPostgres
  requireTrustedScopeEvidence:
    typeof requireCurrentFaireFulfillmentScopeEvidenceInPostgres
  decryptCredential: typeof decryptCommerceCredential
  executeWriteback: typeof executeFaireFulfillmentWriteback
  reconcileReadOnly: typeof reconcileFaireFulfillmentWritebackReadOnly
}

const DEFAULT_DEPENDENCIES: FaireFulfillmentRuntimeDependencies = {
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  requireCapability: requireCommerceActiveCapabilityClaimInPostgres,
  requireTrustedScopeEvidence:
    requireCurrentFaireFulfillmentScopeEvidenceInPostgres,
  decryptCredential: decryptCommerceCredential,
  executeWriteback: executeFaireFulfillmentWriteback,
  reconcileReadOnly: reconcileFaireFulfillmentWritebackReadOnly,
}

async function currentAuthority(
  input: { organizationId: unknown; accountGlobalId: unknown },
  dependencies: FaireFulfillmentRuntimeDependencies,
) {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  const [orderUpdateClaim, fulfillmentClaim, trackingClaim, runtime] =
    await Promise.all([
      dependencies.requireCapability({
        organizationId,
        accountGlobalId,
        capability: 'order_update',
      }),
      dependencies.requireCapability({
        organizationId,
        accountGlobalId,
        capability: 'fulfillment_export',
      }),
      dependencies.requireCapability({
        organizationId,
        accountGlobalId,
        capability: 'tracking_export',
      }),
      dependencies.readRuntimeCredential({ organizationId, accountGlobalId }),
    ])
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
    orderUpdateClaim.provider !== 'faire'
    || fulfillmentClaim.provider !== 'faire'
    || trackingClaim.provider !== 'faire'
    || orderUpdateClaim.environment !== 'production'
    || fulfillmentClaim.environment !== 'production'
    || trackingClaim.environment !== 'production'
    || orderUpdateClaim.accountGlobalId !== accountGlobalId
    || fulfillmentClaim.accountGlobalId !== accountGlobalId
    || trackingClaim.accountGlobalId !== accountGlobalId
    || orderUpdateClaim.externalAccountId !== runtime.externalAccountId
    || fulfillmentClaim.externalAccountId !== runtime.externalAccountId
    || trackingClaim.externalAccountId !== runtime.externalAccountId
    || orderUpdateClaim.activationRevision !== fulfillmentClaim.activationRevision
    || fulfillmentClaim.activationRevision !== trackingClaim.activationRevision
    || orderUpdateClaim.credentialGeneration !== runtime.credentialVersion
    || fulfillmentClaim.credentialGeneration !== runtime.credentialVersion
    || trackingClaim.credentialGeneration !== runtime.credentialVersion
  ) {
    throw new FaireFulfillmentRuntimeError(
      'FAIRE_FULFILLMENT_AUTHORIZATION_STALE',
      'Faire fulfillment authority is stale; review the Active capability cohort again',
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
  const authorizationRevision = orderUpdateClaim.activationRevision
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
  input: { organizationId: unknown; accountGlobalId: unknown },
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
  const current = await currentAuthority(input, dependencies)
  return dependencies.executeWriteback({
    mode: input.mode,
    writeAttempt: input.writeAttempt,
    credential: current.credential,
    authorization: current.authorization,
    externalOrderId: input.externalOrderId,
    ...(input.expectedShipDate === undefined
      ? {}
      : { expectedShipDate: input.expectedShipDate }),
    packages: input.packages,
  })
}
