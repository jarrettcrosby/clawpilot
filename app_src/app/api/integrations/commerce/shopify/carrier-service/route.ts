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
import {
  shopifyStoreEntityCarrierServiceName,
} from '@/lib/integrations/shopifyCarrierServiceBranding'
import {
  CommerceIntegrationRequestError,
  testCommerceConnection,
} from '@/lib/integrations/commerceIntegrations'
import { HYBRID_CARTONIZATION_ALGORITHM_VERSION } from '@/lib/operations/hybridCartonization'
import {
  normalizeShopifyCheckoutPlanRatePolicy,
  readShopifyCheckoutPlanRatePolicy,
  ShopifyCheckoutPlanRatePolicyError,
} from '@/lib/operations/shopifyCheckoutPlanRatePolicy'
import {
  normalizeShopifyCheckoutRateWarmPolicy,
  readShopifyCheckoutRateWarmPolicy,
  ShopifyCheckoutRateWarmPolicyError,
} from '@/lib/operations/shopifyCheckoutRateWarmPolicy'
import {
  normalizeShopifyCheckoutAudiencePolicy,
  readShopifyCheckoutAudiencePolicy,
  ShopifyCheckoutAudiencePolicyError,
} from '@/lib/operations/shopifyCheckoutAudiencePolicy'
import {
  normalizeShopifyCheckoutRateControl,
  readShopifyCheckoutRateControl,
  shopifyCheckoutRateControlEmptyReason,
  SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON,
  SHOPIFY_CHECKOUT_RATE_CONTROL_VERSION,
  ShopifyCheckoutRateControlError,
} from '@/lib/operations/shopifyCheckoutRateControl'
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
  readCommerceStoreSyncControlsFromPostgres,
} from '@/lib/persistence/commerceStoreSync'
import {
  readShopifyCustomerRatePolicySummaryFromPostgres,
} from '@/lib/persistence/shopifyCustomerRatePolicies'
import {
  finalizeShopifyCarrierServiceRegistrationInPostgres,
  readShopifyCarrierServiceConfigFromPostgres,
  shopifyCheckoutRatingHash,
  ShopifyCheckoutRatingPersistenceError,
  updateShopifyCarrierServiceBrandNameOverrideInPostgres,
  updateRegisteredShopifyCarrierServiceRateSourcesInPostgres,
  updateShopifyCarrierServiceRateControlInPostgres,
  updateShopifyCarrierServicePlanRatePolicyInPostgres,
  updateShopifyCarrierServiceRateWarmPolicyInPostgres,
  upsertShopifyCarrierServiceConfigInPostgres,
  type ShopifyCarrierServiceConfig,
  type ShopifyCheckoutCarrierProvider,
} from '@/lib/persistence/shopifyCheckoutRating'
import {
  authorizeShopifyCarrierServiceMutationInPostgres,
  claimShopifyCarrierServiceMutationInPostgres,
  finalizeShopifyCarrierServiceConfigMutationInPostgres,
  finalizeShopifyCarrierServiceNameAlignmentInPostgres,
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
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const MUTATION_AUTHORIZATION_GLOBAL_ID = /^gsca(?:[0-9]{7}|[0-9a-v]{12})$/
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
  if (error instanceof ShopifyCheckoutPlanRatePolicyError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      400,
    )
  }
  if (error instanceof ShopifyCheckoutRateWarmPolicyError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      400,
    )
  }
  if (error instanceof ShopifyCheckoutAudiencePolicyError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      400,
    )
  }
  if (error instanceof ShopifyCheckoutRateControlError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      400,
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

function requireExactBodyFields(
  body: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(body).sort()
  const required = [...expected].sort()
  if (actual.join('\n') !== required.join('\n')) {
    fail(
      'SHOPIFY_CHECKOUT_RATE_CONTROL_REQUEST_INVALID',
      'Checkout-rate control request fields are invalid',
    )
  }
}

function rateControlIdempotencyKey(req: NextRequest) {
  const key = String(req.headers.get('idempotency-key') || '').trim()
  if (key.length < 8 || key.length > 200
      || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    fail(
      'SHOPIFY_CHECKOUT_RATE_CONTROL_IDEMPOTENCY_INVALID',
      'A stable Idempotency-Key header of 8-200 URL-safe characters is required',
    )
  }
  return key
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
    requestHash: authorization.requestHash,
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
  activationState:
    | 'disabled' | 'shadow' | 'read_only' | 'active' | 'frozen',
) {
  if (!config) return null
  return {
    globalId: config.globalId,
    accountGlobalId: config.accountGlobalId,
    accountEnvironment: config.accountEnvironment,
    accountStatus: config.accountStatus,
    warehouseGlobalId: config.warehouseGlobalId,
    warehouseName: config.warehouseName,
    checkoutBrandNameOverride: config.checkoutBrandNameOverride,
    registeredServiceName: config.registeredServiceName,
    serviceGid: config.serviceGid,
    registrationState: config.registrationState,
    credentialGeneration: config.credentialGeneration,
    activationRevision: config.activationRevision,
    callbackTokenVersion: config.callbackTokenVersion,
    policyRevision: config.policyRevision,
    policyHash: config.policyHash,
    planRateOptimization: readShopifyCheckoutPlanRatePolicy(
      config.policySnapshot,
    ),
    checkoutRateWarm: readShopifyCheckoutRateWarmPolicy(
      config.policySnapshot,
    ),
    shadowCheckoutAudience: readShopifyCheckoutAudiencePolicy(
      config.policySnapshot,
    ),
    checkoutRateControl: readShopifyCheckoutRateControl(
      config.policySnapshot,
      {
        activationState,
        accountEnvironment: config.accountEnvironment,
      },
    ),
    inventoryMaxAgeSeconds: config.inventoryMaxAgeSeconds,
    quoteTtlSeconds: config.quoteTtlSeconds,
    orderReconciliationWindowSeconds:
      config.orderReconciliationWindowSeconds,
    algorithmVersion: config.algorithmVersion,
    lastErrorCode: config.lastErrorCode,
    rowVersion: config.rowVersion,
    ready: config.ready,
    ratingRuntimeReady: config.ratingRuntimeReady,
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

function checkoutBrandNameOverride(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    fail(
      'SHOPIFY_CARRIER_SERVICE_NAME_OVERRIDE_INVALID',
      'The optional checkout name must be text or null',
    )
  }
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = shopifyStoreEntityCarrierServiceName(trimmed)
  if (normalized.length > 120) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_NAME_OVERRIDE_INVALID',
      'The optional checkout name must be 120 characters or fewer',
    )
  }
  return normalized
}

function shadowSimulationIdempotencyKey(input: {
  config: PublicShopifyCarrierServiceConfig
  operation: ShopifyCarrierServiceMutationOperation
  requestHash: string
}) {
  return `shopify-carrier-service:shadow-${input.operation}:${
    input.config.globalId
  }:${input.config.rowVersion}:${input.requestHash}`
}

async function exactShadowSimulation(input: {
  organizationId: string
  accountGlobalId: string
  config: PublicShopifyCarrierServiceConfig
  operation: ShopifyCarrierServiceMutationOperation
  requestHash: string
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
        requestHash: input.requestHash,
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
    && effect.requestHash === input.requestHash
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

function storeEntityNamePreference(input: {
  providerStoreEntityName: unknown
  providerVerifiedAt?: unknown
  checkoutBrandNameOverride?: string | null
}) {
  const providerStoreEntityName =
    shopifyStoreEntityCarrierServiceName(
      input.providerStoreEntityName,
    )
  const overrideName = input.checkoutBrandNameOverride
    ? shopifyStoreEntityCarrierServiceName(
        input.checkoutBrandNameOverride,
      )
    : null
  return {
    providerStoreEntityName,
    overrideName,
    effectiveName: overrideName || providerStoreEntityName,
    providerVerifiedAt:
      typeof input.providerVerifiedAt === 'string'
        ? input.providerVerifiedAt
        : null,
    source: overrideName
      ? 'administrator_override' as const
      : 'provider_verified_shop_name' as const,
  }
}

function carrierServiceMutation(input: {
  operation: ShopifyCarrierServiceMutationOperation
  organizationId: string
  accountGlobalId: string
  config: PublicShopifyCarrierServiceConfig
  storeEntityName: unknown
}): ShopifyCarrierServiceRegistrationMutation {
  if (input.operation !== 'create') {
    if (!input.config.serviceGid) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_PROVIDER_REFERENCE_REQUIRED',
        'The exact registered Shopify CarrierService identity is required',
        409,
      )
    }
    if (input.operation === 'update') {
      return {
        operation: 'update',
        id: input.config.serviceGid,
        name: shopifyStoreEntityCarrierServiceName(
          input.storeEntityName,
        ),
      }
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
    name: shopifyStoreEntityCarrierServiceName(input.storeEntityName),
    callbackUrl: callbackUrl(input.accountGlobalId, token),
    active: true,
    supportsServiceDiscovery: false,
  }
}

async function setupState(input: {
  organizationId: string
  accountGlobalId: string
  canActivate: boolean
  canManage: boolean
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
    customerPolicySummary,
    storeSyncControls,
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
    readShopifyCustomerRatePolicySummaryFromPostgres({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    }),
    readCommerceStoreSyncControlsFromPostgres(input.organizationId),
  ])
  const storeSync = storeSyncControls.find(
    (control) => control.accountGlobalId === input.accountGlobalId,
  )
  if (!storeSync) {
    fail(
      'COMMERCE_STORE_SYNC_CONTROL_MISSING',
      'This Shopify connection has no Store sync control; migration health must be repaired',
      409,
    )
  }
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
  const runtimeActivationState = reference.activation.state === 'missing'
    ? 'disabled'
    : reference.activation.state
  const publicConfig = publicCarrierServiceConfig(
    config,
    runtimeActivationState,
  )
  const namePreference = storeEntityNamePreference({
    providerStoreEntityName: account.configuration.accountName,
    providerVerifiedAt: account.configuration.lastVerifiedAt,
    checkoutBrandNameOverride:
      publicConfig?.checkoutBrandNameOverride,
  })
  const operation: ShopifyCarrierServiceMutationOperation | null =
    publicConfig?.registrationState === 'registered'
      && publicConfig.serviceGid
      ? 'delete'
      : publicConfig?.registrationState === 'shadow_simulated'
        && !publicConfig.serviceGid
        ? 'create'
        : null
  const operationRequestHash = publicConfig && operation
    ? shopifyCarrierServiceRegistrationRequestHash(
        carrierServiceMutation({
          operation,
          organizationId: input.organizationId,
          accountGlobalId: input.accountGlobalId,
          config: publicConfig,
          storeEntityName: namePreference.effectiveName,
        }),
      )
    : null
  const simulation = publicConfig && operation && operationRequestHash
    ? await exactShadowSimulation({
        organizationId: input.organizationId,
        accountGlobalId: input.accountGlobalId,
        config: publicConfig,
        operation,
        requestHash: operationRequestHash,
      })
    : null
  let nameAlignment: {
    desiredName: string
    appliedName: string | null
    aligned: boolean
    serviceGid: string
    simulation: null | {
      globalId: string
      operation: 'update'
      activationRevision: number
      configRowVersion: number
      requestHash: string
      completedAt: string | null
    }
  } | null = null
  if (
    publicConfig?.registrationState === 'registered'
    && publicConfig.serviceGid
  ) {
    const desiredName = namePreference.effectiveName
    const nameMutation = carrierServiceMutation({
      operation: 'update',
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      config: publicConfig,
      storeEntityName: desiredName,
    })
    const requestHash =
      shopifyCarrierServiceRegistrationRequestHash(nameMutation)
    const alignmentSimulation = await exactShadowSimulation({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      config: publicConfig,
      operation: 'update',
      requestHash,
    })
    nameAlignment = {
      desiredName,
      appliedName: publicConfig.registeredServiceName,
      aligned: publicConfig.registeredServiceName === desiredName,
      serviceGid: publicConfig.serviceGid,
      simulation: alignmentSimulation
        ? {
            globalId: alignmentSimulation.globalId,
            operation: 'update',
            activationRevision:
              alignmentSimulation.activationRevision,
            configRowVersion:
              alignmentSimulation.aggregateRevision,
            requestHash: alignmentSimulation.requestHash,
            completedAt: alignmentSimulation.completedAt,
          }
        : null,
    }
  }
  const checkoutAccountReady = (
    account.status === 'active'
    && account.verificationStatus === 'verified'
  )
  const shadowCheckoutAudienceMode =
    publicConfig?.checkoutRateControl.audience || 'restricted_customers'
  const checkoutRateEmptyReason = publicConfig
    ? shopifyCheckoutRateControlEmptyReason({
        control: publicConfig.checkoutRateControl,
        accountEnvironment: account.environment,
        activationState: runtimeActivationState,
      })
    : null
  const checkoutRateEffectiveReason = checkoutRateEmptyReason
    || (publicConfig?.ratingRuntimeReady
      ? SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON.Serving
      : SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON.RuntimeNotReady)
  const callbackRegistrationReady = Boolean(
    publicConfig?.registrationState === 'registered'
    && publicConfig.serviceGid
    && publicConfig.ratingRuntimeReady === true
  )
  const callbackServingReady = callbackRegistrationReady
    && checkoutRateEmptyReason === null
  const checkoutRateWarmBlockers = [
    ...(!callbackRegistrationReady
      ? ['registered callback-ready CarrierService']
      : []),
    ...(shadowCheckoutAudienceMode === 'off'
      ? ['checkout audience is Off']
      : []),
    ...(shadowCheckoutAudienceMode === 'restricted_customers'
      && customerPolicySummary.checkoutEligibleCount < 1
      ? ['at least one eligible local customer policy in Checkout audience']
      : []),
    ...(checkoutRateEmptyReason
      === SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON
        .RestrictedLiveEnforcementRequired
      ? ['verified customer-specific provider enforcement for Restricted LIVE']
      : []),
  ]
  const checkoutRateWarmEffective = (
    checkoutAccountReady
    && callbackServingReady
    && checkoutRateWarmBlockers.length === 0
  )
  return {
    account,
    storeSync,
    config: publicConfig,
    namePreference,
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
    nameAlignment,
    reference,
    mutationAuthorizations: mutationAuthorizations.map(
      publicMutationAuthorization,
    ),
    callbackUrl: publicCallbackUrl,
    canActivate: input.canActivate,
    canManage: input.canManage,
    checkoutRateOperatingProfile: {
      desiredAudience:
        publicConfig?.checkoutRateControl.audience || null,
      desiredRateSource:
        publicConfig?.checkoutRateControl.rateSource || null,
      effectiveState: !publicConfig
        ? 'not_configured'
        : checkoutRateEmptyReason
          ? 'empty'
          : publicConfig.ratingRuntimeReady
            ? 'serving'
            : 'not_ready',
      effectiveReason: checkoutRateEffectiveReason,
      serving: Boolean(
        publicConfig
        && !checkoutRateEmptyReason
        && publicConfig.ratingRuntimeReady,
      ),
      emergencyOverride: reference.activation.state === 'disabled'
        || reference.activation.state === 'frozen',
    },
    checkoutAudience: {
      state: shadowCheckoutAudienceMode === 'off'
        ? 'shadow_off'
        : shadowCheckoutAudienceMode === 'all_eligible'
          ? checkoutAccountReady && callbackServingReady
            ? 'shadow_all_eligible_ready'
            : 'shadow_all_eligible_unavailable'
          : customerPolicySummary.checkoutEligibleCount > 0
            && checkoutAccountReady
            && callbackServingReady
            ? 'shadow_restricted_ready'
            : 'shadow_customer_required',
      mode: shadowCheckoutAudienceMode,
      defaultPolicy: shadowCheckoutAudienceMode === 'all_eligible'
        ? 'show_all'
        : 'hide_all',
      policyCount: customerPolicySummary.policyCount,
      unexpiredShadowPolicyCount: customerPolicySummary.simulatedCount,
      shadowAllowedCustomerCount: customerPolicySummary.shadowAllowedCount,
      eligibleCustomerCount: customerPolicySummary.checkoutEligibleCount,
      expiredShadowPolicyCount:
        customerPolicySummary.expiredSimulatedCount,
      blockedPolicyCount: customerPolicySummary.blockedCount,
      enforcedPolicyCount: customerPolicySummary.enforcedCount,
      earliestShadowExpiresAt:
        customerPolicySummary.earliestShadowExpiresAt,
      shadowBinaryTestReady: checkoutAccountReady
        && callbackServingReady
        && (
          shadowCheckoutAudienceMode === 'all_eligible'
          || (
            shadowCheckoutAudienceMode === 'restricted_customers'
            && customerPolicySummary.checkoutEligibleCount > 0
          )
        ),
      providerEnforcementState: customerPolicySummary.enforcement.state,
      providerEnforcementAvailable:
        customerPolicySummary.enforcement.providerWriteAvailable,
      providerWritesPerformed:
        customerPolicySummary.enforcement.providerWritesPerformed,
      providerEnforcementRequirement:
        'Customer-specific and per-service Shopify enforcement requires an eligible Delivery Customization delivered by a limited-visibility public app or a custom app on Shopify Plus, followed by provider activation and verification.',
    },
    rateWarmReadiness: {
      deliveryCustomizationDurable: false,
      activationAllowed: checkoutRateWarmEffective,
      reason: checkoutRateWarmEffective
        ? shadowCheckoutAudienceMode === 'all_eligible'
          ? `Bounded saved-address cache preparation is available without a customer allow policy. Exact product mapping, inventory, packaging, and the saved ${publicConfig?.checkoutRateControl.rateSource === 'production' ? 'LIVE' : 'TEST'} carrier lane still fail closed.`
          : `Bounded cache preparation is available only for an allowed customer${
            customerPolicySummary.earliestShadowExpiresAt
              ? ` until ${customerPolicySummary.earliestShadowExpiresAt}`
              : ''
          }. Shopify does not guarantee Customer GID in CarrierService callbacks, and its successful-rate cache is customer-neutral; this is not deterministic customer enforcement.`
        : !checkoutAccountReady
          ? 'Use a verified Shopify connection to configure saved-address cache preparation.'
          : `Cache preparation is currently dormant: configure ${checkoutRateWarmBlockers.join(', ')}.`,
    },
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

function checkoutCarrierServiceProviderWriteAuthority(input: {
  state: string
  revision: number | null
}) {
  if (
    !['shadow', 'read_only', 'active'].includes(input.state)
    || !Number.isSafeInteger(input.revision)
    || Number(input.revision) < 1
  ) {
    fail(
      'SHOPIFY_CARRIER_SERVICE_PROVIDER_WRITE_SAFETY_BLOCKED',
      'CarrierService provider changes are blocked while Operations is Disabled or Frozen',
      409,
    )
  }
  return {
    state: input.state as 'shadow' | 'read_only' | 'active',
    revision: Number(input.revision),
  }
}

async function executeResourceScopedCarrierServiceMutation(input: {
  organizationId: string
  accountGlobalId: string
  accountEnvironment: 'sandbox' | 'production'
  storeEntityName: unknown
  config: PublicShopifyCarrierServiceConfig
  resourceAuthorizationState: 'shadow' | 'read_only' | 'active'
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
    input.simulation.configRowVersion !== input.config.rowVersion
    || (
      input.operation === 'create'
      && (
        input.config.registrationState !== 'shadow_simulated'
        || input.config.serviceGid !== null
      )
    )
    || (
      input.operation !== 'create'
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
    storeEntityName: input.storeEntityName,
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
      providerWriteActivationState: input.resourceAuthorizationState,
      configActivationRevision: input.config.activationRevision,
      simulationActivationRevision:
        input.simulation.activationRevision,
      providerWriteActivationRevision:
        input.resourceAuthorizationRevision,
      aggregateHash: configAggregateHash(input.config),
      requestHash: currentRequestHash,
      expectedServiceGid: input.operation === 'create'
        ? null
        : input.config.serviceGid,
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
  if (input.operation === 'update') {
    return finalizeShopifyCarrierServiceNameAlignmentInPostgres({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      expectedConfigRowVersion: input.config.rowVersion,
      attemptGlobalId: claimed.attempt.globalId,
      evidenceGlobalId: outcomeGlobalId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
    })
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
  storeEntityName: unknown
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
    if (authorization.operation === 'update') {
      return finalizeShopifyCarrierServiceNameAlignmentInPostgres({
        organizationId: input.organizationId,
        accountGlobalId: input.accountGlobalId,
        expectedConfigRowVersion: authorization.configRowVersion,
        attemptGlobalId: authorization.attempt.globalId,
        evidenceGlobalId: appliedEvidenceGlobalId,
        actorEmail: input.actorEmail,
        actorRole: input.actorRole,
      })
    }
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
    storeEntityName: input.storeEntityName,
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
  if (authorization.operation === 'update') {
    return finalizeShopifyCarrierServiceNameAlignmentInPostgres({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      expectedConfigRowVersion: authorization.configRowVersion,
      attemptGlobalId: authorization.attempt.globalId,
      evidenceGlobalId: resolved.resolution.globalId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
    })
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
        canManage: context.capabilities.canManage,
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
    let current = await setupState({
      organizationId: context.organizationId,
      accountGlobalId: accountId,
      canActivate: context.capabilities.canActivate,
      canManage: context.capabilities.canManage,
    })
    const refreshShopifyIdentity = async () => {
      await testCommerceConnection({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        actorEmail: context.actor.email,
      })
      current = await setupState({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        canActivate: context.capabilities.canActivate,
        canManage: context.capabilities.canManage,
      })
    }

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
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_ACTIVATION_REFERENCE_REQUIRED',
          'Operations safety authority is unavailable',
          409,
        )
      }
      const carriers = array(body.carriers, 'Carrier accounts')
        .map((item) => {
          const selected = record(item, 'Carrier account')
          return {
            provider: selected.provider as ShopifyCheckoutCarrierProvider,
            carrierAccountGlobalId: selected.carrierAccountGlobalId as string,
          }
        })
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
      if (current.config?.registrationState === 'registered') {
        await updateRegisteredShopifyCarrierServiceRateSourcesInPostgres({
          organizationId: context.organizationId,
          accountGlobalId: accountId,
          expectedRowVersion: current.config.rowVersion,
          warehouseGlobalId: String(body.warehouseGlobalId || ''),
          materials,
          carriers,
          actorEmail: context.actor.email,
        })
      } else {
      const callbackTokenVersion = current.config
        ? current.config.callbackTokenVersion + 1
        : 1
      const policyRevision = current.config
        ? current.config.policyRevision + 1
        : 1
      const planRateOptimization = Object.prototype.hasOwnProperty.call(
        body,
        'planRateOptimization',
      )
        ? normalizeShopifyCheckoutPlanRatePolicy(
            body.planRateOptimization,
          )
        : current.config
          ? normalizeShopifyCheckoutPlanRatePolicy(
              current.config.planRateOptimization,
            )
          : normalizeShopifyCheckoutPlanRatePolicy(undefined)
      const checkoutRateWarm = Object.prototype.hasOwnProperty.call(
        body,
        'checkoutRateWarm',
      )
        ? normalizeShopifyCheckoutRateWarmPolicy(body.checkoutRateWarm)
        : current.config
          ? normalizeShopifyCheckoutRateWarmPolicy(
              current.config.checkoutRateWarm,
            )
          : normalizeShopifyCheckoutRateWarmPolicy(undefined)
      const shadowCheckoutAudience = Object.prototype.hasOwnProperty.call(
        body,
        'shadowCheckoutAudience',
      )
        ? normalizeShopifyCheckoutAudiencePolicy(
            body.shadowCheckoutAudience,
          )
        : current.config
          ? normalizeShopifyCheckoutAudiencePolicy(
              current.config.shadowCheckoutAudience,
            )
          : normalizeShopifyCheckoutAudiencePolicy(undefined)
      const checkoutRateControl = Object.prototype.hasOwnProperty.call(
        body,
        'checkoutRateControl',
      )
        ? normalizeShopifyCheckoutRateControl(body.checkoutRateControl)
        : current.config
          ? normalizeShopifyCheckoutRateControl(
              current.config.checkoutRateControl,
            )
          : normalizeShopifyCheckoutRateControl({
              version: SHOPIFY_CHECKOUT_RATE_CONTROL_VERSION,
              audience: shadowCheckoutAudience.mode,
              rateSource:
                current.account.environment === 'production'
                || current.reference.activation.state === 'active'
                  ? 'production'
                  : 'sandbox',
            })
      const policySnapshot = {
        version: 'shopify-checkout-rating-policy-v1',
        ratingMode: 'whole_shipment',
        inventoryPolicy: 'fresh_atp_fail_closed',
        materialPolicy: 'revision_fenced_rated_outer_dimensions',
        carrierPolicy: 'all_configured_accounts_once',
        pricingPolicy:
          'carton_selection_uses_landed_cost_customer_charge_is_carrier_cost',
        servicePolicy: 'one_service_for_every_package',
        algorithmVersion: HYBRID_CARTONIZATION_ALGORITHM_VERSION,
        planRateOptimization,
        checkoutRateWarm,
        shadowCheckoutAudience,
        checkoutRateControl,
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
      }
    } else if (action === 'save-checkout-rate-control') {
      requireActivator(context.capabilities.canActivate)
      requireExactBodyFields(body, [
        'action',
        'accountGlobalId',
        'expectedRowVersion',
        'checkoutRateControl',
        'reason',
      ])
      if (!current.config) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_CONFIG_REQUIRED',
          'Save the Shopify checkout-rating configuration first',
          404,
        )
      }
      const result =
        await updateShopifyCarrierServiceRateControlInPostgres({
          organizationId: context.organizationId,
          accountGlobalId: accountId,
          expectedRowVersion: integer(
            body.expectedRowVersion,
            'Configuration row version',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          checkoutRateControl: normalizeShopifyCheckoutRateControl(
            body.checkoutRateControl,
          ),
          idempotencyKey: rateControlIdempotencyKey(req),
          reason: String(body.reason || ''),
          actorEmail: context.actor.email,
        })
      return json({ ok: true, result })
    } else if (action === 'save-plan-rate-policy') {
      requireActivator(context.capabilities.canActivate)
      if (!current.config) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_CONFIG_REQUIRED',
          'Save the Shopify checkout-rating configuration first',
          404,
        )
      }
      if (
        !Object.prototype.hasOwnProperty.call(
          body,
          'planRateOptimization',
        )
      ) {
        fail(
          'SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_REQUIRED',
          'Checkout plan-rate policy is required',
          400,
        )
      }
      await updateShopifyCarrierServicePlanRatePolicyInPostgres({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        expectedRowVersion: current.config.rowVersion,
        planRateOptimization: normalizeShopifyCheckoutPlanRatePolicy(
          body.planRateOptimization,
        ),
        actorEmail: context.actor.email,
      })
    } else if (action === 'save-checkout-audience') {
      fail(
        'SHOPIFY_CHECKOUT_RATE_CONTROL_MIGRATION_REQUIRED',
        'Use the desired checkout audience and rate-source control; the legacy Shadow audience command no longer changes runtime behavior',
        410,
      )
    } else if (action === 'save-rate-warm-policy') {
      requireActivator(context.capabilities.canActivate)
      if (!current.config) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_CONFIG_REQUIRED',
          'Save the Shopify checkout-rating configuration first',
          404,
        )
      }
      if (
        !Object.prototype.hasOwnProperty.call(
          body,
          'checkoutRateWarm',
        )
      ) {
        fail(
          'SHOPIFY_CHECKOUT_RATE_WARM_POLICY_REQUIRED',
          'Checkout rate-warming policy is required',
          400,
        )
      }
      const checkoutRateWarm = normalizeShopifyCheckoutRateWarmPolicy(
        body.checkoutRateWarm,
      )
      await updateShopifyCarrierServiceRateWarmPolicyInPostgres({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        expectedRowVersion: current.config.rowVersion,
        checkoutRateWarm,
        actorEmail: context.actor.email,
      })
    } else if (action === 'save-name-preference') {
      requireActivator(context.capabilities.canActivate)
      await refreshShopifyIdentity()
      if (!current.config) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_CONFIG_REQUIRED',
          'Save the Shopify checkout-rating configuration before changing its customer-facing name',
          409,
        )
      }
      const unsafeMutation = current.mutationAuthorizations.find(
        (authorization) => (
          authorization.reconciliationRequired
          || (
            Boolean(authorization.attempt)
            && !authorization.outcome
            && !authorization.resolution
          )
          || authorization.outcome?.state === 'unknown'
          || (
            authorization.configRowVersion
              === current.config?.rowVersion
            && (
              authorization.status === 'succeeded'
              || authorization.status === 'confirmed_applied'
            )
            && (
              (
                authorization.operation === 'create'
                && current.config?.registrationState !== 'registered'
              )
              || (
                authorization.operation === 'delete'
                && current.config?.registrationState !== 'disabled'
              )
              || (
                authorization.operation === 'update'
                && current.nameAlignment?.aligned !== true
              )
            )
          )
        ),
      )
      if (unsafeMutation) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_NAME_CHANGE_BLOCKED',
          'Resolve the in-flight or uncertain CarrierService mutation before changing its customer-facing name',
          409,
        )
      }
      await updateShopifyCarrierServiceBrandNameOverrideInPostgres({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        expectedRowVersion: current.config.rowVersion,
        checkoutBrandNameOverride: checkoutBrandNameOverride(
          body.checkoutBrandNameOverride,
        ),
        actorEmail: context.actor.email,
      })
    } else if (action === 'simulate-registration') {
      requireActivator(context.capabilities.canActivate)
      await refreshShopifyIdentity()
      if (
        !current.config
        || current.reference.activation.state === 'missing'
        || current.reference.activation.revision === null
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_SIMULATION_STALE',
          'Save an exact configuration before running the zero-write simulation',
          409,
        )
      }
      const operation: ShopifyCarrierServiceMutationOperation =
        current.config.registrationState === 'registered'
          && current.config.serviceGid
          ? 'delete'
          : 'create'
      const mutation = carrierServiceMutation({
        operation,
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        config: current.config,
        storeEntityName: current.namePreference.effectiveName,
      })
      const requestHash =
        shopifyCarrierServiceRegistrationRequestHash(mutation)
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
          requestHash,
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
        const exactConfig = publicCarrierServiceConfig(
          finalized,
          current.reference.activation.state,
        )
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
            requestHash,
          }),
          mutation: carrierServiceMutation({
            operation,
            organizationId: context.organizationId,
            accountGlobalId: accountId,
            config: exactConfig,
            storeEntityName: current.namePreference.effectiveName,
          }),
          actorEmail: context.actor.email,
        })
      }
    } else if (action === 'simulate-name-alignment') {
      requireActivator(context.capabilities.canActivate)
      await refreshShopifyIdentity()
      if (
        !current.config
        || !current.nameAlignment
        || current.config.registrationState !== 'registered'
        || current.reference.activation.revision === null
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_NAME_SIMULATION_STALE',
          'The exact registered CarrierService is required before name alignment can be simulated',
          409,
        )
      }
      const mutation = carrierServiceMutation({
        operation: 'update',
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        config: current.config,
        storeEntityName: current.namePreference.effectiveName,
      })
      const requestHash =
        shopifyCarrierServiceRegistrationRequestHash(mutation)
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
          operation: 'update',
          requestHash,
        }),
        mutation,
        actorEmail: context.actor.email,
      })
    } else if (action === 'align-registration-name') {
      requireActivator(context.capabilities.canActivate)
      await refreshShopifyIdentity()
      if (body.confirmProviderWrite !== true) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_PROVIDER_WRITE_CONFIRMATION_REQUIRED',
          'Confirm the exact one-time Shopify CarrierService name update',
          400,
        )
      }
      if (
        !current.config
        || !current.nameAlignment?.simulation
        || current.config.registrationState !== 'registered'
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_NAME_SIMULATION_EVIDENCE_REQUIRED',
          'Run the exact zero-write name-alignment simulation before changing Shopify',
          409,
        )
      }
      const providerWriteAuthority =
        checkoutCarrierServiceProviderWriteAuthority(
          current.reference.activation,
        )
      if (
        current.account.environment === 'production'
        && body.confirmProductionProviderWrite !== true
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CONFIRMATION_REQUIRED',
          'Production confirmation is required: this updates the live Shopify CarrierService name',
          400,
        )
      }
      await executeResourceScopedCarrierServiceMutation({
        organizationId: context.organizationId,
        accountGlobalId: accountId,
        accountEnvironment: current.account.environment,
        storeEntityName: current.namePreference.effectiveName,
        config: current.config,
        resourceAuthorizationState: providerWriteAuthority.state,
        resourceAuthorizationRevision:
          providerWriteAuthority.revision,
        operation: 'update',
        simulation: current.nameAlignment.simulation,
        confirmationRequestId: confirmationRequestId(
          body.confirmationRequestId,
        ),
        actorEmail: context.actor.email,
        actorRole: mutationActorRole(
          effectiveAuthorizationRole(context.actor),
        ),
      })
    } else if (action === 'register' || action === 'unregister') {
      requireActivator(context.capabilities.canActivate)
      await refreshShopifyIdentity()
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
      const providerWriteAuthority =
        checkoutCarrierServiceProviderWriteAuthority(
          current.reference.activation,
        )
      if (
        !current.shadowSimulation
        || current.shadowSimulation.operation !== operation
        || current.shadowSimulation.configRowVersion
          !== current.config.rowVersion
      ) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_SIMULATION_EVIDENCE_REQUIRED',
          'Run the exact zero-write simulation before activating this provider change',
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
        storeEntityName: current.namePreference.effectiveName,
        config: current.config,
        resourceAuthorizationState: providerWriteAuthority.state,
        resourceAuthorizationRevision:
          providerWriteAuthority.revision,
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
        storeEntityName: current.namePreference.effectiveName,
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
        canManage: context.capabilities.canManage,
      }),
    })
  } catch (error) {
    return errorResponse(error)
  }
}
