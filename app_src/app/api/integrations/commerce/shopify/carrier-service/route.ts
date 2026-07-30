import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  normalizeCommerceAccountGlobalId,
  shopifyCarrierServiceCallbackToken,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  executeAuthorizedShopifyCarrierServiceMutation,
  executeShopifyCarrierServiceRegistration,
  SHOPIFY_CARRIER_SERVICE_REGISTRATION_ADAPTER_VERSION,
  shopifyCarrierServiceRegistrationRequestHash,
  ShopifyCarrierServiceRegistrationError,
  verifyShopifyCarrierServiceMutationForReconciliation,
  type ShopifyCarrierServiceRegistrationMutation,
} from '@/lib/integrations/shopifyCarrierServiceRegistration'
import { CommerceIntegrationRequestError } from '@/lib/integrations/commerceIntegrations'
import { HYBRID_CARTONIZATION_ALGORITHM_VERSION } from '@/lib/operations/hybridCartonization'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  commerceExternalEffectHash,
  readCommerceExternalEffectByIdempotencyFromPostgres,
} from '@/lib/persistence/commerceExternalEffects'
import {
  readCommerceIntegrationsStateFromPostgres,
} from '@/lib/persistence/commerceIntegrations'
import {
  finalizeShopifyCarrierServiceRegistrationInPostgres,
  readShopifyCarrierServiceConfigFromPostgres,
  shopifyCheckoutRatingHash,
  ShopifyCheckoutRatingPersistenceError,
  upsertShopifyCarrierServiceConfigInPostgres,
  type ShopifyCarrierServiceConfig,
  type ShopifyCheckoutCarrierProvider,
} from '@/lib/persistence/shopifyCheckoutRating'
import {
  authorizeShopifyCarrierServiceMutationInPostgres,
  claimShopifyCarrierServiceMutationInPostgres,
  finalizeShopifyCarrierServiceConfigMutationInPostgres,
  readShopifyCarrierServiceMutationAuthorizationFromPostgres,
  readShopifyCarrierServiceMutationAuthorizationsFromPostgres,
  resolveShopifyCarrierServiceMutationInPostgres,
  shopifyCarrierServiceMutationConfirmationHash,
  shopifyCarrierServiceMutationConfirmationVersion,
  shopifyCarrierServiceMutationResolutionConfirmationHash,
  SHOPIFY_CARRIER_SERVICE_RECONCILIATION_CONFIRMATION_VERSION,
  ShopifyCarrierServiceMutationAuthorizationError,
  type ShopifyCarrierServiceMutationActorRole,
  type ShopifyCarrierServiceMutationOperation,
} from '@/lib/persistence/shopifyCarrierServiceMutationAuthorization'
import {
  readShopifyCarrierServiceSetupReferenceFromPostgres,
} from '@/lib/persistence/shopifyCarrierServiceSetup'
import { appPublicUrl } from '@/lib/publicUrl'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_REQUEST_BYTES = 32 * 1024
const ACCOUNT_GLOBAL_ID = /^gia[0-9]{7}$/
const MUTATION_AUTHORIZATION_GLOBAL_ID = /^gsca[0-9]{7}$/
const CONFIRMATION_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function fail(
  code: string,
  message: string,
  status = 400,
): never {
  throw new CommerceIntegrationRequestError(message, status, code)
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  if (
    error instanceof ShopifyCheckoutRatingPersistenceError
    || error instanceof ShopifyCarrierServiceMutationAuthorizationError
  ) {
    return json(
      { ok: false, error: error.message, code: error.code },
      error.status,
    )
  }
  if (error instanceof ShopifyCarrierServiceRegistrationError) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
      retryable: error.retryable,
      effectGlobalId: error.effectGlobalId,
    }, error.status)
  }
  if (error instanceof CommerceIntegrationRequestError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      error.status,
    )
  }
  return json({
    ok: false,
    error: 'Shopify checkout-rating setup failed',
    code: 'SHOPIFY_CARRIER_SERVICE_SETUP_FAILED',
  }, 500)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_POSTGRES_REQUIRED',
      'Shopify checkout rating requires Postgres storage',
      503,
    )
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_REQUEST_TOO_LARGE',
      'Shopify checkout-rating setup request is too large',
      413,
    )
  }
  const reader = req.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        fail(
          'SHOPIFY_CARRIER_SERVICE_REQUEST_TOO_LARGE',
          'Shopify checkout-rating setup request is too large',
          413,
        )
      }
      chunks.push(value)
    }
  }
  try {
    const parsed = JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        length,
      ).toString('utf8'),
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid')
    }
    return parsed as Record<string, unknown>
  } catch {
    fail(
      'SHOPIFY_CARRIER_SERVICE_REQUEST_INVALID',
      'Shopify checkout-rating setup request must be a JSON object',
    )
  }
}

function accountGlobalId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!ACCOUNT_GLOBAL_ID.test(normalized)) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_ACCOUNT_INVALID',
      'A valid Shopify connection is required',
    )
  }
  return normalizeCommerceAccountGlobalId(normalized)
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_REQUEST_INVALID',
      `${label} is invalid`,
    )
  }
  return parsed
}

function record(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_REQUEST_INVALID',
      `${label} is invalid`,
    )
  }
  return value as Record<string, unknown>
}

function array(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_REQUEST_INVALID',
      `${label} is invalid`,
    )
  }
  return value
}

function tokenHash(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function callbackUrl(
  accountId: string,
  token: string,
) {
  return new URL(
    `/api/integrations/commerce/shopify/carrier-service/${
      encodeURIComponent(accountId)
    }/${encodeURIComponent(token)}`,
    appPublicUrl(),
  ).toString()
}

function configAggregateHash(
  config: PublicShopifyCarrierServiceConfig,
) {
  return shopifyCheckoutRatingHash({
    configGlobalId: config.globalId,
    configRowVersion: config.rowVersion,
    credentialGeneration: config.credentialGeneration,
    activationRevision: config.activationRevision,
    callbackTokenVersion: config.callbackTokenVersion,
    policyRevision: config.policyRevision,
    policyHash: config.policyHash,
    warehouseGlobalId: config.warehouseGlobalId,
    materialBindings: config.materials.map((material) => ({
      materialGlobalId: material.materialGlobalId,
      expectedRowVersion: material.expectedRowVersion,
    })),
    carrierBindings: config.carriers.map((carrier) => ({
      provider: carrier.provider,
      carrierAccountGlobalId: carrier.carrierAccountGlobalId,
    })),
  })
}

function publicMutationAuthorization(
  authorization: Awaited<
    ReturnType<
      typeof readShopifyCarrierServiceMutationAuthorizationsFromPostgres
    >
  >[number],
) {
  return {
    globalId: authorization.globalId,
    configGlobalId: authorization.configGlobalId,
    operation: authorization.operation,
    accountEnvironment: authorization.accountEnvironment,
    configRowVersion: authorization.configRowVersion,
    status: authorization.status,
    reconciliationRequired: authorization.reconciliationRequired,
    authorizedAt: authorization.authorizedAt,
    expiresAt: authorization.expiresAt,
    attempt: authorization.attempt
      ? {
          globalId: authorization.attempt.globalId,
          leaseExpiresAt: authorization.attempt.leaseExpiresAt,
          claimedAt: authorization.attempt.claimedAt,
        }
      : null,
    outcome: authorization.outcome
      ? {
          globalId: authorization.outcome.globalId,
          state: authorization.outcome.state,
          providerReference: authorization.outcome.providerReference,
          errorCode: authorization.outcome.errorCode,
          providerWriteCount:
            authorization.outcome.providerWriteCount,
          completedAt: authorization.outcome.completedAt,
        }
      : null,
    resolution: authorization.resolution
      ? {
          globalId: authorization.resolution.globalId,
          disposition: authorization.resolution.disposition,
          providerReference:
            authorization.resolution.providerReference,
          resolvedAt: authorization.resolution.resolvedAt,
        }
      : null,
  }
}

function publicCarrierServiceConfig(
  config: ShopifyCarrierServiceConfig | null,
) {
  if (!config) return null
  return {
    globalId: config.globalId,
    accountGlobalId: config.accountGlobalId,
    accountEnvironment: config.accountEnvironment,
    accountStatus: config.accountStatus,
    warehouseGlobalId: config.warehouseGlobalId,
    warehouseName: config.warehouseName,
    serviceGid: config.serviceGid,
    registrationState: config.registrationState,
    credentialGeneration: config.credentialGeneration,
    activationRevision: config.activationRevision,
    callbackTokenVersion: config.callbackTokenVersion,
    policyRevision: config.policyRevision,
    policyHash: config.policyHash,
    inventoryMaxAgeSeconds: config.inventoryMaxAgeSeconds,
    quoteTtlSeconds: config.quoteTtlSeconds,
    orderReconciliationWindowSeconds:
      config.orderReconciliationWindowSeconds,
    algorithmVersion: config.algorithmVersion,
    lastErrorCode: config.lastErrorCode,
    rowVersion: config.rowVersion,
    ready: config.ready,
    materials: config.materials.map((material) => ({
      selectionSequence: material.selectionSequence,
      materialGlobalId: material.materialGlobalId,
      materialCode: material.materialCode,
      materialName: material.materialName,
      expectedRowVersion: material.expectedRowVersion,
      currentRowVersion: material.currentRowVersion,
      ratedOuterDimensionsMm: material.ratedOuterDimensionsMm,
      tareWeightGrams: material.tareWeightGrams,
      maxWeightGrams: material.maxWeightGrams,
      evidenceType: material.evidenceType,
      evidenceReference: material.evidenceReference,
      evidenceConfirmedAt: material.evidenceConfirmedAt,
      stockAvailable: material.stockAvailable,
      stockOnHandQuantity: material.stockOnHandQuantity,
    })),
    carriers: config.carriers.map((carrier) => ({
      provider: carrier.provider,
      carrierAccountGlobalId: carrier.carrierAccountGlobalId,
      credentialVersion: carrier.credentialVersion,
      displayName: carrier.displayName,
      accountStatus: carrier.accountStatus,
      integrationStatus: carrier.integrationStatus,
      environment: carrier.environment,
    })),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  }
}

type PublicShopifyCarrierServiceConfig = NonNullable<
  ReturnType<typeof publicCarrierServiceConfig>
>

function confirmationRequestId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!CONFIRMATION_REQUEST_ID.test(normalized)) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_CONFIRMATION_REQUEST_INVALID',
      'A unique confirmation request is required for this one-time Shopify write',
    )
  }
  return normalized
}

function mutationAuthorizationGlobalId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!MUTATION_AUTHORIZATION_GLOBAL_ID.test(normalized)) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_AUTHORIZATION_INVALID',
      'A valid one-time Shopify mutation authorization is required',
    )
  }
  return normalized
}

function shadowSimulationIdempotencyKey(input: {
  config: PublicShopifyCarrierServiceConfig
  operation: ShopifyCarrierServiceMutationOperation
}) {
  return `shopify-carrier-service:shadow-${input.operation}:${
    input.config.globalId
  }:${input.config.rowVersion}`
}

async function exactShadowSimulation(input: {
  organizationId: string
  accountGlobalId: string
  config: PublicShopifyCarrierServiceConfig
  operation: ShopifyCarrierServiceMutationOperation
}) {
  const aggregateHash = configAggregateHash(input.config)
  const action = `shopify.carrier_service.${input.operation}`
  const effect =
    await readCommerceExternalEffectByIdempotencyFromPostgres({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      action,
      idempotencyKey: shadowSimulationIdempotencyKey({
        config: input.config,
        operation: input.operation,
      }),
    })
  return effect
    && (
    effect.provider === 'shopify'
    && effect.action === action
    && effect.desiredMode === 'shadow'
    && effect.state === 'simulated'
    && effect.providerWriteCount === 0
    && effect.credentialGeneration
      === input.config.credentialGeneration
    && effect.aggregateType
      === 'shopify_carrier_service_configuration'
    && effect.aggregateId === input.config.globalId
    && effect.aggregateRevision === input.config.rowVersion
    && effect.aggregateHash === aggregateHash
    )
    ? effect
    : null
}

function mutationActorRole(
  role: ReturnType<typeof effectiveAuthorizationRole>,
): ShopifyCarrierServiceMutationActorRole {
  if (role !== 'owner' && role !== 'admin') {
    fail(
      'SHOPIFY_CARRIER_SERVICE_ACTIVATOR_REQUIRED',
      'Organization-owner or authorized administrator permission is required',
      403,
    )
  }
  return role
}

function carrierServiceMutation(input: {
  operation: ShopifyCarrierServiceMutationOperation
  organizationId: string
  accountGlobalId: string
  config: PublicShopifyCarrierServiceConfig
}): ShopifyCarrierServiceRegistrationMutation {
  if (input.operation === 'delete') {
    if (!input.config.serviceGid) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_PROVIDER_REFERENCE_REQUIRED',
        'The exact registered Shopify CarrierService identity is required',
        409,
      )
    }
    return {
      operation: 'delete',
      id: input.config.serviceGid,
    }
  }
  const token = shopifyCarrierServiceCallbackToken({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    credentialGeneration: input.config.credentialGeneration,
    callbackTokenVersion: input.config.callbackTokenVersion,
  })
  return {
    operation: 'create',
    name: 'ClawPilot calculated shipping',
    callbackUrl: callbackUrl(input.accountGlobalId, token),
    active: true,
    supportsServiceDiscovery: false,
  }
}

async function setupState(input: {
  organizationId: string
  accountGlobalId: string
  canActivate: boolean
}) {
  const integrations = await readCommerceIntegrationsStateFromPostgres(
    input.organizationId,
  )
  const account = integrations.accounts.find(
    (candidate) => candidate.globalId === input.accountGlobalId,
  )
  if (!account || account.provider !== 'shopify') {
    fail(
      'SHOPIFY_CARRIER_SERVICE_ACCOUNT_NOT_FOUND',
      'Shopify connection was not found',
      404,
    )
  }
  const [
    config,
    reference,
    mutationAuthorizations,
  ] = await Promise.all([
    readShopifyCarrierServiceConfigFromPostgres({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    }),
    readShopifyCarrierServiceSetupReferenceFromPostgres({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    }),
    readShopifyCarrierServiceMutationAuthorizationsFromPostgres({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      limit: 10,
    }),
  ])
  let publicCallbackUrl: string | null = null
  if (config && input.canActivate) {
    const token = shopifyCarrierServiceCallbackToken({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      credentialGeneration: config.credentialGeneration,
      callbackTokenVersion: config.callbackTokenVersion,
    })
    publicCallbackUrl = callbackUrl(input.accountGlobalId, token)
  }
  const publicConfig = publicCarrierServiceConfig(config)
  const operation: ShopifyCarrierServiceMutationOperation | null =
    publicConfig?.registrationState === 'registered'
      && publicConfig.serviceGid
      ? 'delete'
      : publicConfig?.registrationState === 'shadow_simulated'
        && !publicConfig.serviceGid
        ? 'create'
        : null
  const simulation = publicConfig && operation
    ? await exactShadowSimulation({
        organizationId: input.organizationId,
        accountGlobalId: input.accountGlobalId,
        config: publicConfig,
        operation,
      })
    : null
  return {
    account,
    config: publicConfig,
    shadowSimulation: simulation
      ? {
          globalId: simulation.globalId,
          operation,
          activationRevision: simulation.activationRevision,
          configRowVersion: simulation.aggregateRevision,
          requestHash: simulation.requestHash,
          completedAt: simulation.completedAt,
        }
      : null,
    reference,
    mutationAuthorizations: mutationAuthorizations.map(
      publicMutationAuthorization,
    ),
    callbackUrl: publicCallbackUrl,
    canActivate: input.canActivate,
    boundaries: {
      checkoutCustomerFieldsPersisted: false,
      providerWritesDuringCallback: 0,
      inventoryReservedDuringCallback: false,
      crmMutatedDuringCallback: false,
      postagePurchasedDuringCallback: false,
      labelsCreatedDuringCallback: false,
      shadowProviderRegistrationWrites: 0,
      oneTimeProviderMutationConfirmationRequired: true,
      globalOperationsModeChangedForRegistration: false,
      wholeShipmentCarrierCalls: true,
      oneServiceForEveryPackage: true,
    },
  }
}

async function actorContext(req: NextRequest) {
  requirePostgres()
  const actor = await requireRequestUser(req)
  const capabilities = operationsCapabilities(actor)
  if (!capabilities.canManage) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MANAGER_REQUIRED',
      'Operations-management permission is required',
      403,
    )
  }
  return {
    actor,
    organizationId: activeOperationsOrganizationId(actor),
    capabilities,
  }
}

function requireActivator(canActivate: boolean) {
  if (!canActivate) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_ACTIVATOR_REQUIRED',
      'Organization-owner or authorized administrator permission is required',
      403,
    )
  }
}

async function executeResourceScopedCarrierServiceMutation(input: {
  organizationId: string
  accountGlobalId: string
  accountEnvironment: 'sandbox' | 'production'
  config: PublicShopifyCarrierServiceConfig
  resourceAuthorizationRevision: number
  operation: ShopifyCarrierServiceMutationOperation
  simulation: {
    globalId: string
    activationRevision: number
    configRowVersion: number
    requestHash: string
  }
  confirmationRequestId: string
  actorEmail: string
  actorRole: ShopifyCarrierServiceMutationActorRole
}) {
  if (
    input.operation === 'create'
    && input.accountEnvironment !== 'sandbox'
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CREATE_BLOCKED',
      'New Shopify CarrierService registration is sandbox-only; production is limited to exact removal and reconciliation',
      409,
    )
  }
  if (
    input.simulation.configRowVersion !== input.config.rowVersion
    || (
      input.operation === 'create'
      && (
        input.config.registrationState !== 'shadow_simulated'
        || input.config.serviceGid !== null
      )
    )
    || (
      input.operation === 'delete'
      && (
        input.config.registrationState !== 'registered'
        || !input.config.serviceGid
      )
    )
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_ACTIVE_CONFIG_STALE',
      'The exact configuration changed after its zero-write Shadow simulation',
      409,
    )
  }
  const mutation = carrierServiceMutation({
    operation: input.operation,
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    config: input.config,
  })
  const currentRequestHash =
    shopifyCarrierServiceRegistrationRequestHash(mutation)
  if (currentRequestHash !== input.simulation.requestHash) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_ACTIVE_REQUEST_STALE',
      'The exact Shopify CarrierService request changed after its zero-write Shadow simulation',
      409,
    )
  }
  const confirmationStatementVersion =
    shopifyCarrierServiceMutationConfirmationVersion(
      input.accountEnvironment,
    )
  const confirmationHash =
    shopifyCarrierServiceMutationConfirmationHash({
      accountGlobalId: input.accountGlobalId,
      configGlobalId: input.config.globalId,
      configRowVersion: input.config.rowVersion,
      operation: input.operation,
      environment: input.accountEnvironment,
      requestHash: currentRequestHash,
      actorEmail: input.actorEmail,
      statementVersion: confirmationStatementVersion,
    })
  const authorization =
    await authorizeShopifyCarrierServiceMutationInPostgres({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      configGlobalId: input.config.globalId,
      expectedConfigRowVersion: input.config.rowVersion,
      simulationEffectGlobalId: input.simulation.globalId,
      operation: input.operation,
      accountEnvironment: input.accountEnvironment,
      credentialGeneration: input.config.credentialGeneration,
      configActivationRevision: input.config.activationRevision,
      simulationActivationRevision:
        input.simulation.activationRevision,
      providerWriteActivationRevision:
        input.resourceAuthorizationRevision,
      aggregateHash: configAggregateHash(input.config),
      requestHash: currentRequestHash,
      expectedServiceGid: input.operation === 'delete'
        ? input.config.serviceGid
        : null,
      confirmationHash,
      confirmationStatementVersion,
      idempotencyKey:
        `shopify-cs-active-auth:${input.config.globalId}:${
          input.config.rowVersion
        }:${input.confirmationRequestId}`,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      expiresInSeconds: 120,
    })
  const claimed = await claimShopifyCarrierServiceMutationInPostgres({
    organizationId: input.organizationId,
    authorizationGlobalId: authorization.globalId,
    expectedAuthorizationFenceHash:
      authorization.authorizationFenceHash,
    workerId: 'shopify-carrier-service-api',
    adapterVersion:
      SHOPIFY_CARRIER_SERVICE_REGISTRATION_ADAPTER_VERSION,
    leaseSeconds: 60,
  })
  const executed =
    await executeAuthorizedShopifyCarrierServiceMutation({
      authorization: claimed,
      mutation,
      finalizedBy:
        SHOPIFY_CARRIER_SERVICE_REGISTRATION_ADAPTER_VERSION,
    })
  const outcomeGlobalId = executed.authorization.outcome?.globalId
  if (!outcomeGlobalId) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_PROVIDER_OUTCOME_REQUIRED',
      'Exact durable Shopify provider outcome evidence is required',
      500,
    )
  }
  return finalizeShopifyCarrierServiceConfigMutationInPostgres({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    expectedConfigRowVersion: input.config.rowVersion,
    attemptGlobalId: claimed.attempt.globalId,
    evidenceGlobalId: outcomeGlobalId,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
  })
}

async function recoverOneTimeCarrierServiceMutation(input: {
  organizationId: string
  accountGlobalId: string
  config: PublicShopifyCarrierServiceConfig
  authorizationGlobalId: string
  confirmReconciliation: boolean
  actorEmail: string
  actorRole: ShopifyCarrierServiceMutationActorRole
}) {
  const authorization =
    await readShopifyCarrierServiceMutationAuthorizationFromPostgres({
      organizationId: input.organizationId,
      authorizationGlobalId: input.authorizationGlobalId,
    })
  if (
    !authorization
    || authorization.accountGlobalId !== input.accountGlobalId
    || authorization.configGlobalId !== input.config.globalId
    || !authorization.attempt
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_MUTATION_AUTHORIZATION_NOT_FOUND',
      'The exact Shopify mutation authorization was not found',
      404,
    )
  }
  const appliedEvidenceGlobalId =
    authorization.outcome?.state === 'succeeded'
      ? authorization.outcome.globalId
      : authorization.resolution?.disposition === 'confirmed_applied'
        ? authorization.resolution.globalId
        : null
  if (appliedEvidenceGlobalId) {
    return finalizeShopifyCarrierServiceConfigMutationInPostgres({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      expectedConfigRowVersion: authorization.configRowVersion,
      attemptGlobalId: authorization.attempt.globalId,
      evidenceGlobalId: appliedEvidenceGlobalId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
    })
  }
  if (
    !authorization.reconciliationRequired
    || !input.confirmReconciliation
    || input.config.rowVersion !== authorization.configRowVersion
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_REQUIRED',
      'This uncertain provider mutation must be explicitly verified against its unchanged configuration',
      409,
    )
  }
  const mutation = carrierServiceMutation({
    operation: authorization.operation,
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    config: input.config,
  })
  const verification =
    await verifyShopifyCarrierServiceMutationForReconciliation({
      authorization,
      mutation,
    })
  const resolutionHash = commerceExternalEffectHash(
    verification.resolutionEvidence,
  )
  const confirmationHash =
    shopifyCarrierServiceMutationResolutionConfirmationHash({
      attemptGlobalId: authorization.attempt.globalId,
      disposition: verification.disposition,
      providerReference: verification.providerReference,
      resolutionHash,
      actorEmail: input.actorEmail,
      statementVersion:
        SHOPIFY_CARRIER_SERVICE_RECONCILIATION_CONFIRMATION_VERSION,
    })
  const resolved = await resolveShopifyCarrierServiceMutationInPostgres({
    organizationId: input.organizationId,
    attemptGlobalId: authorization.attempt.globalId,
    disposition: verification.disposition,
    providerReference: verification.providerReference,
    resolutionEvidence: verification.resolutionEvidence,
    confirmationHash,
    confirmationStatementVersion:
      SHOPIFY_CARRIER_SERVICE_RECONCILIATION_CONFIRMATION_VERSION,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
  })
  if (
    verification.disposition !== 'confirmed_applied'
    || !resolved?.resolution
  ) {
    return {
      authorizationGlobalId: authorization.globalId,
      attemptGlobalId: authorization.attempt.globalId,
      evidenceGlobalId: resolved?.resolution?.globalId || null,
      operation: authorization.operation,
      registrationState: input.config.registrationState,
      serviceGid: input.config.serviceGid,
      rowVersion: input.config.rowVersion,
      providerStateConfirmedNotApplied: true,
    }
  }
  return finalizeShopifyCarrierServiceConfigMutationInPostgres({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    expectedConfigRowVersion: authorization.configRowVersion,
    attemptGlobalId: authorization.attempt.globalId,
    evidenceGlobalId: resolved.resolution.globalId,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
  })
}

export async function GET(req: NextRequest) {
  try {
    const context = await actorContext(req)
    const accountId = accountGlobalId(
      req.nextUrl.searchParams.get('accountGlobalId'),
    )
    return json({
      ok: true,
      setup: await setupState({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        canActivate: context.capabilities.canActivate,
      }),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const context = await actorContext(req)
    const body = await requestBody(req)
    const action = String(body.action || '').trim()
    const accountId = accountGlobalId(body.accountGlobalId)
    const current = await setupState({
      organizationId: context.organizationId,
      accountGlobalId: accountId,
      canActivate: context.capabilities.canActivate,
    })

    if (action === 'save-config') {
      requireActivator(context.capabilities.canActivate)
      if (
        !current.account.configured
        || current.account.verificationStatus !== 'verified'
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_CREDENTIAL_REQUIRED',
          'Verify the Shopify connection before configuring checkout rating',
          409,
        )
      }
      if (
        current.reference.activation.revision === null
        || !['shadow', 'active'].includes(
          current.reference.activation.state,
        )
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_SHADOW_REQUIRED',
          'Set Operations to Shadow before configuring checkout rating',
          409,
        )
      }
      const materials = array(body.materials, 'Packaging materials')
        .map((item) => {
          const selected = record(item, 'Packaging material')
          return {
            materialGlobalId: String(
              selected.materialGlobalId || '',
            ),
            expectedRowVersion: Number(selected.expectedRowVersion),
          }
        })
      const carriers = array(body.carriers, 'Carrier accounts')
        .map((item) => {
          const selected = record(item, 'Carrier account')
          return {
            provider: selected.provider as ShopifyCheckoutCarrierProvider,
            carrierAccountGlobalId: selected.carrierAccountGlobalId as string,
          }
        })
      const callbackTokenVersion = current.config
        ? current.config.callbackTokenVersion + 1
        : 1
      const policyRevision = current.config
        ? current.config.policyRevision + 1
        : 1
      const policySnapshot = {
        version: 'shopify-checkout-rating-policy-v1',
        ratingMode: 'whole_shipment',
        inventoryPolicy: 'fresh_atp_fail_closed',
        materialPolicy: 'revision_fenced_rated_outer_dimensions',
        carrierPolicy: 'all_configured_providers_once',
        pricingPolicy: 'carrier_cost_without_effective_directive',
        servicePolicy: 'one_service_for_every_package',
        algorithmVersion: HYBRID_CARTONIZATION_ALGORITHM_VERSION,
      }
      const token = shopifyCarrierServiceCallbackToken({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        credentialGeneration: current.account.credentialVersion,
        callbackTokenVersion,
      })
      await upsertShopifyCarrierServiceConfigInPostgres({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        expectedRowVersion: current.config?.rowVersion ?? null,
        credentialGeneration: current.account.credentialVersion,
        activationRevision: current.reference.activation.revision,
        callbackTokenVersion,
        callbackTokenHash: tokenHash(token),
        policyRevision,
        policyHash: shopifyCheckoutRatingHash(policySnapshot),
        policySnapshot,
        warehouseGlobalId: String(body.warehouseGlobalId || ''),
        materials,
        carriers,
        inventoryMaxAgeSeconds: integer(
          body.inventoryMaxAgeSeconds ?? 900,
          'Inventory maximum age',
          30,
          86400,
        ),
        quoteTtlSeconds: integer(
          body.quoteTtlSeconds ?? 900,
          'Quote TTL',
          30,
          900,
        ),
        orderReconciliationWindowSeconds: integer(
          body.orderReconciliationWindowSeconds ?? 86400,
          'Order reconciliation window',
          60,
          172800,
        ),
        algorithmVersion: HYBRID_CARTONIZATION_ALGORITHM_VERSION,
        actorEmail: context.actor.email,
      })
    } else if (action === 'simulate-registration') {
      requireActivator(context.capabilities.canActivate)
      if (
        !current.config
        || current.reference.activation.state !== 'shadow'
        || current.reference.activation.revision === null
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_SIMULATION_STALE',
          'Save a configuration and set Operations to Shadow before simulating',
          409,
        )
      }
      const operation: ShopifyCarrierServiceMutationOperation =
        current.config.registrationState === 'registered'
          && current.config.serviceGid
          ? 'delete'
          : 'create'
      if (
        operation === 'create'
        && current.account.environment !== 'sandbox'
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CREATE_BLOCKED',
          'New Shopify CarrierService simulation and registration are sandbox-only',
          409,
        )
      }
      if (
        operation === 'create'
        && current.reference.activation.revision
          !== current.config.activationRevision
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_SIMULATION_STALE',
          'Save the exact current Shadow configuration before simulating',
          409,
        )
      }
      const mutation = carrierServiceMutation({
        operation,
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        config: current.config,
      })
      await executeShopifyCarrierServiceRegistration({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        mode: 'shadow',
        credentialGeneration: current.config.credentialGeneration,
        activationRevision: current.reference.activation.revision,
        aggregateId: current.config.globalId,
        aggregateRevision: current.config.rowVersion,
        aggregateHash: configAggregateHash(current.config),
        idempotencyKey: shadowSimulationIdempotencyKey({
          config: current.config,
          operation,
        }),
        mutation,
        actorEmail: context.actor.email,
      })
      if (
        operation === 'create'
        && current.config.registrationState !== 'shadow_simulated'
      ) {
        const finalized =
          await finalizeShopifyCarrierServiceRegistrationInPostgres({
            organizationId: context.organizationId,
            accountGlobalId: accountId,
            expectedRowVersion: current.config.rowVersion,
            activationRevision:
              current.reference.activation.revision,
            registrationState: 'shadow_simulated',
            serviceGid: null,
            lastErrorCode: null,
            actorEmail: context.actor.email,
          })
        const exactConfig = publicCarrierServiceConfig(finalized)
        if (!exactConfig) {
          fail(
            'SHOPIFY_CARRIER_SERVICE_SIMULATION_FINALIZE_FAILED',
            'The exact Shadow-simulated configuration was not found',
            500,
          )
        }
        await executeShopifyCarrierServiceRegistration({
          organizationId: context.organizationId,
          accountGlobalId: accountId,
          mode: 'shadow',
          credentialGeneration: exactConfig.credentialGeneration,
          activationRevision:
            current.reference.activation.revision,
          aggregateId: exactConfig.globalId,
          aggregateRevision: exactConfig.rowVersion,
          aggregateHash: configAggregateHash(exactConfig),
          idempotencyKey: shadowSimulationIdempotencyKey({
            config: exactConfig,
            operation,
          }),
          mutation: carrierServiceMutation({
            operation,
            organizationId: context.organizationId,
            accountGlobalId: accountId,
            config: exactConfig,
          }),
          actorEmail: context.actor.email,
        })
      }
    } else if (action === 'register' || action === 'unregister') {
      requireActivator(context.capabilities.canActivate)
      if (body.confirmProviderWrite !== true) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_PROVIDER_WRITE_CONFIRMATION_REQUIRED',
          'Confirm the exact one-time Shopify CarrierService provider write',
          400,
        )
      }
      if (!current.config) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_CONFIG_REQUIRED',
          'Save and simulate the exact Shopify callback configuration first',
          409,
        )
      }
      const operation: ShopifyCarrierServiceMutationOperation =
        action === 'register' ? 'create' : 'delete'
      if (
        current.reference.activation.state !== 'shadow'
        || current.reference.activation.revision === null
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_RESOURCE_AUTHORIZATION_REQUIRES_SHADOW',
          'The one-time CarrierService write requires the exact current Shadow revision and does not activate unrelated Operations writes',
          409,
        )
      }
      if (
        !current.shadowSimulation
        || current.shadowSimulation.operation !== operation
        || current.shadowSimulation.configRowVersion
          !== current.config.rowVersion
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_SHADOW_EVIDENCE_REQUIRED',
          'Return Operations to Shadow and run the exact zero-write simulation before activating this provider change',
          409,
        )
      }
      if (
        current.account.environment !== 'sandbox'
        && current.account.environment !== 'production'
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_ENVIRONMENT_INVALID',
          'The Shopify account must have an exact sandbox or production environment',
          409,
        )
      }
      if (
        current.account.environment === 'production'
        && body.confirmProductionProviderWrite !== true
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CONFIRMATION_REQUIRED',
          'Production confirmation is required: this changes the live Shopify checkout CarrierService',
          400,
        )
      }
      await executeResourceScopedCarrierServiceMutation({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        accountEnvironment: current.account.environment,
        config: current.config,
        resourceAuthorizationRevision:
          current.reference.activation.revision,
        operation,
        simulation: current.shadowSimulation,
        confirmationRequestId: confirmationRequestId(
          body.confirmationRequestId,
        ),
        actorEmail: context.actor.email,
        actorRole: mutationActorRole(
          effectiveAuthorizationRole(context.actor),
        ),
      })
    } else if (action === 'recover-mutation') {
      requireActivator(context.capabilities.canActivate)
      if (!current.config) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_CONFIG_REQUIRED',
          'The exact Shopify callback configuration is required for recovery',
          409,
        )
      }
      if (body.confirmRecovery !== true) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_RECOVERY_CONFIRMATION_REQUIRED',
          'Confirm the exact read-only Shopify provider-state verification and local recovery',
          400,
        )
      }
      await recoverOneTimeCarrierServiceMutation({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        config: current.config,
        authorizationGlobalId: mutationAuthorizationGlobalId(
          body.authorizationGlobalId,
        ),
        confirmReconciliation:
          body.confirmReconciliation === true,
        actorEmail: context.actor.email,
        actorRole: mutationActorRole(
          effectiveAuthorizationRole(context.actor),
        ),
      })
    } else {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTION_INVALID',
        'Shopify checkout-rating setup action is invalid',
      )
    }

    return json({
      ok: true,
      setup: await setupState({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        canActivate: context.capabilities.canActivate,
      }),
    })
  } catch (error) {
    return errorResponse(error)
  }
}
