import { createHash } from 'node:crypto'
import {
  decryptCommerceCredential,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
  type ShopifyCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  createShopifyCarrierService,
  deleteShopifyCarrierService,
  listShopifyCarrierServices,
  queryShopifyCarrierService,
  SHOPIFY_CARRIER_SERVICE_API_VERSION,
  ShopifyCarrierServiceClientError,
  updateShopifyCarrierService,
  type ShopifyCarrierService,
  type ShopifyCarrierServiceCreateInput,
  type ShopifyCarrierServiceUpdateInput,
} from '@/lib/integrations/shopifyCarrierServiceClient'
import {
  normalizeShopifyShopDomain,
  requestShopifyAccessToken,
  ShopifyCommerceClientError,
  type ShopifyCommerceClientOptions,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  assertRedactedCommerceExternalEffectEvidence,
  claimCommerceExternalEffectsInPostgres,
  commerceExternalEffectHash,
  finalizeCommerceExternalEffectInPostgres,
  prepareCommerceExternalEffectInPostgres,
  type ClaimedCommerceExternalEffect,
  type CommerceExternalEffect,
  type CommerceExternalEffectMode,
} from '@/lib/persistence/commerceExternalEffects'
import {
  readCommerceRuntimeCredentialFromPostgres,
  type CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'
import {
  finalizeShopifyCarrierServiceMutationInPostgres,
  type ClaimedShopifyCarrierServiceMutationAuthorization,
  type ShopifyCarrierServiceMutationAuthorization,
} from '@/lib/persistence/shopifyCarrierServiceMutationAuthorization'

const CARRIER_SERVICE_GID_PATTERN =
  /^gid:\/\/shopify\/DeliveryCarrierService\/[1-9][0-9]*$/
const SHOPIFY_SHOP_GID_PATTERN =
  /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/
const PUBLIC_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/
const ACTIVE_TERMINAL_EFFECT_STATES = new Set([
  'succeeded',
  'failed',
  'unknown',
])

export const SHOPIFY_CARRIER_SERVICE_REGISTRATION_ADAPTER_VERSION =
  `shopify-graphql-${SHOPIFY_CARRIER_SERVICE_API_VERSION}-carrier-service-control-v1`
export const SHOPIFY_CARRIER_SERVICE_REQUIRED_SCOPE = 'write_shipping'
export const SHOPIFY_CARRIER_SERVICE_RECONCILIATION_REQUIRED_SCOPE =
  'read_shipping'
export const SHOPIFY_CARRIER_SERVICE_AGGREGATE_TYPE =
  'shopify_carrier_service_configuration'

export type ShopifyCarrierServiceRegistrationMutation =
  | {
      operation: 'create'
      name: string
      callbackUrl: string
      active: boolean
      supportsServiceDiscovery: boolean
    }
  | {
      operation: 'update'
      id: string
      name?: string
      callbackUrl?: string
      active?: boolean
      supportsServiceDiscovery?: boolean
    }
  | {
      operation: 'delete'
      id: string
    }

export type ShopifyCarrierServiceRegistrationInput = {
  organizationId: unknown
  accountGlobalId: unknown
  mode: CommerceExternalEffectMode
  credentialGeneration: unknown
  activationRevision: unknown
  aggregateId: unknown
  aggregateRevision: unknown
  aggregateHash: unknown
  idempotencyKey: unknown
  mutation: ShopifyCarrierServiceRegistrationMutation
  actorEmail?: string | null
  workerId?: string
}

type NormalizedRegistrationInput = {
  organizationId: string
  accountGlobalId: string
  mode: CommerceExternalEffectMode
  credentialGeneration: number
  activationRevision: number
  aggregateId: string
  aggregateRevision: number
  aggregateHash: string
  idempotencyKey: string
  mutation: ShopifyCarrierServiceRegistrationMutation
  redactedRequest: Record<string, unknown>
  action: string
  actorEmail: string | null
  workerId: string
}

export type ShopifyCarrierServiceRegistrationResult = {
  effect: CommerceExternalEffect
  operation: ShopifyCarrierServiceRegistrationMutation['operation']
  replayed: boolean
}

export class ShopifyCarrierServiceRegistrationError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean
  readonly effectGlobalId: string | null

  constructor(input: {
    code: string
    message: string
    status?: number
    retryable?: boolean
    effectGlobalId?: string | null
  }) {
    super(input.message)
    this.name = 'ShopifyCarrierServiceRegistrationError'
    this.code = input.code
    this.status = input.status || 409
    this.retryable = Boolean(input.retryable)
    this.effectGlobalId = input.effectGlobalId || null
  }
}

export type ShopifyCarrierServiceRegistrationDependencies = {
  prepareExternalEffect: typeof prepareCommerceExternalEffectInPostgres
  claimExternalEffects: typeof claimCommerceExternalEffectsInPostgres
  finalizeExternalEffect: typeof finalizeCommerceExternalEffectInPostgres
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  decryptCredential: typeof decryptCommerceCredential
  requestAccessToken: typeof requestShopifyAccessToken
  createCarrierService: typeof createShopifyCarrierService
  updateCarrierService: typeof updateShopifyCarrierService
  deleteCarrierService: typeof deleteShopifyCarrierService
}

export type AuthorizedShopifyCarrierServiceMutationDependencies = Pick<
  ShopifyCarrierServiceRegistrationDependencies,
  | 'readRuntimeCredential'
  | 'decryptCredential'
  | 'requestAccessToken'
  | 'createCarrierService'
  | 'updateCarrierService'
  | 'deleteCarrierService'
> & {
  finalizeAuthorizedMutation:
    typeof finalizeShopifyCarrierServiceMutationInPostgres
  queryCarrierService: typeof queryShopifyCarrierService
  listCarrierServices: typeof listShopifyCarrierServices
}

const DEFAULT_DEPENDENCIES: ShopifyCarrierServiceRegistrationDependencies = {
  prepareExternalEffect: prepareCommerceExternalEffectInPostgres,
  claimExternalEffects: claimCommerceExternalEffectsInPostgres,
  finalizeExternalEffect: finalizeCommerceExternalEffectInPostgres,
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  createCarrierService: createShopifyCarrierService,
  updateCarrierService: updateShopifyCarrierService,
  deleteCarrierService: deleteShopifyCarrierService,
}

const DEFAULT_AUTHORIZED_DEPENDENCIES:
AuthorizedShopifyCarrierServiceMutationDependencies = {
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  createCarrierService: createShopifyCarrierService,
  updateCarrierService: updateShopifyCarrierService,
  deleteCarrierService: deleteShopifyCarrierService,
  queryCarrierService: queryShopifyCarrierService,
  listCarrierServices: listShopifyCarrierServices,
  finalizeAuthorizedMutation:
    finalizeShopifyCarrierServiceMutationInPostgres,
}

function registrationError(
  code: string,
  message: string,
  status = 400,
  retryable = false,
  effectGlobalId?: string | null,
): never {
  throw new ShopifyCarrierServiceRegistrationError({
    code,
    message,
    status,
    retryable,
    effectGlobalId,
  })
}

function safeIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      `${label} is invalid`,
    )
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_FENCE_INVALID',
      `${label} is invalid`,
    )
  }
  return number
}

function nonnegativeInteger(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_FENCE_INVALID',
      `${label} is invalid`,
    )
  }
  return number
}

function serviceId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !CARRIER_SERVICE_GID_PATTERN.test(value)
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      'A valid Shopify CarrierService ID is required',
    )
  }
  return value
}

function serviceName(value: unknown): string {
  if (typeof value !== 'string') {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      'A CarrierService name is required',
    )
  }
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (
    !normalized
    || normalized.length > 255
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      'The CarrierService name is invalid',
    )
  }
  return normalized
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      `${label} must be boolean`,
    )
  }
  return value
}

function callbackUrl(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > 2_048
    || value !== value.trim()
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      'A public HTTPS CarrierService callback URL is required',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      'A public HTTPS CarrierService callback URL is required',
    )
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.hostname === 'localhost'
    || !PUBLIC_HOSTNAME_PATTERN.test(parsed.hostname)
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      'The CarrierService callback must use a public HTTPS origin',
    )
  }
  return parsed.toString()
}

function callbackEvidence(value: string) {
  return {
    scheme: 'https',
    opaqueUrlSha256: createHash('sha256').update(value).digest('hex'),
  }
}

function normalizeMutation(
  value: ShopifyCarrierServiceRegistrationMutation,
): ShopifyCarrierServiceRegistrationMutation {
  if (!value || typeof value !== 'object') {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      'A CarrierService mutation is required',
    )
  }
  if (value.operation === 'create') {
    return {
      operation: 'create',
      name: serviceName(value.name),
      callbackUrl: callbackUrl(value.callbackUrl),
      active: booleanValue(value.active, 'CarrierService active state'),
      supportsServiceDiscovery: booleanValue(
        value.supportsServiceDiscovery,
        'CarrierService discovery state',
      ),
    }
  }
  if (value.operation === 'update') {
    const normalized: ShopifyCarrierServiceRegistrationMutation = {
      operation: 'update',
      id: serviceId(value.id),
    }
    let changes = 0
    if (value.name !== undefined) {
      normalized.name = serviceName(value.name)
      changes += 1
    }
    if (value.callbackUrl !== undefined) {
      normalized.callbackUrl = callbackUrl(value.callbackUrl)
      changes += 1
    }
    if (value.active !== undefined) {
      normalized.active = booleanValue(
        value.active,
        'CarrierService active state',
      )
      changes += 1
    }
    if (value.supportsServiceDiscovery !== undefined) {
      normalized.supportsServiceDiscovery = booleanValue(
        value.supportsServiceDiscovery,
        'CarrierService discovery state',
      )
      changes += 1
    }
    if (!changes) {
      registrationError(
        'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
        'A CarrierService update requires at least one changed field',
      )
    }
    return normalized
  }
  if (value.operation === 'delete') {
    return {
      operation: 'delete',
      id: serviceId(value.id),
    }
  }
  registrationError(
    'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
    'CarrierService mutation must create, update, or delete',
  )
}

function redactedMutation(
  mutation: ShopifyCarrierServiceRegistrationMutation,
): Record<string, unknown> {
  if (mutation.operation === 'delete') {
    return {
      operation: mutation.operation,
      carrierServiceId: mutation.id,
    }
  }
  return {
    operation: mutation.operation,
    ...(mutation.operation === 'update'
      ? { carrierServiceId: mutation.id }
      : {}),
    ...(mutation.name !== undefined
      ? { serviceName: mutation.name }
      : {}),
    ...(mutation.callbackUrl !== undefined
      ? { callback: callbackEvidence(mutation.callbackUrl) }
      : {}),
    ...(mutation.active !== undefined
      ? { active: mutation.active }
      : {}),
    ...(mutation.supportsServiceDiscovery !== undefined
      ? { supportsServiceDiscovery: mutation.supportsServiceDiscovery }
      : {}),
  }
}

export function shopifyCarrierServiceRegistrationRequestHash(
  mutation: ShopifyCarrierServiceRegistrationMutation,
) {
  const normalized = normalizeMutation(mutation)
  return commerceExternalEffectHash({
    provider: 'shopify',
    apiVersion: SHOPIFY_CARRIER_SERVICE_API_VERSION,
    requiredScope: SHOPIFY_CARRIER_SERVICE_REQUIRED_SCOPE,
    mutation: redactedMutation(normalized),
  })
}

function normalizeInput(
  input: ShopifyCarrierServiceRegistrationInput,
): NormalizedRegistrationInput {
  let organizationId: string
  let accountGlobalId: string
  try {
    organizationId = normalizeCommerceOrganizationId(input.organizationId)
    accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  } catch {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_INPUT_INVALID',
      'The organization or Shopify connection identity is invalid',
    )
  }
  if (input.mode !== 'shadow' && input.mode !== 'active') {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_MODE_INVALID',
      'CarrierService registration requires Shadow or Active mode',
    )
  }
  const credentialGeneration = positiveInteger(
    input.credentialGeneration,
    'Credential generation',
  )
  const activationRevision = positiveInteger(
    input.activationRevision,
    'Activation revision',
  )
  const aggregateRevision = nonnegativeInteger(
    input.aggregateRevision,
    'Aggregate revision',
  )
  const aggregateHash = safeIdentifier(
    input.aggregateHash,
    'Aggregate hash',
    64,
  )
  if (!SHA256_PATTERN.test(aggregateHash)) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_FENCE_INVALID',
      'Aggregate hash is invalid',
    )
  }
  const aggregateId = safeIdentifier(
    input.aggregateId,
    'Aggregate identifier',
    512,
  )
  const idempotencyKey = safeIdentifier(
    input.idempotencyKey,
    'Idempotency key',
    255,
  )
  const workerId = safeIdentifier(
    input.workerId || 'shopify-carrier-service-registration',
    'Worker identifier',
    255,
  )
  const mutation = normalizeMutation(input.mutation)
  const redactedRequest = {
    provider: 'shopify',
    apiVersion: SHOPIFY_CARRIER_SERVICE_API_VERSION,
    requiredScope: SHOPIFY_CARRIER_SERVICE_REQUIRED_SCOPE,
    mutation: redactedMutation(mutation),
  }
  assertRedactedCommerceExternalEffectEvidence(
    redactedRequest,
    'CarrierService redacted request',
  )
  return {
    organizationId,
    accountGlobalId,
    mode: input.mode,
    credentialGeneration,
    activationRevision,
    aggregateId,
    aggregateRevision,
    aggregateHash,
    idempotencyKey,
    mutation,
    redactedRequest,
    action: `shopify.carrier_service.${mutation.operation}`,
    actorEmail: input.actorEmail || null,
    workerId,
  }
}

function assertEffectMatches(
  effect: CommerceExternalEffect,
  input: NormalizedRegistrationInput,
) {
  if (
    effect.organizationId !== input.organizationId
    || effect.integrationAccountGlobalId !== input.accountGlobalId
    || effect.provider !== 'shopify'
    || effect.action !== input.action
    || effect.desiredMode !== input.mode
    || effect.credentialGeneration !== input.credentialGeneration
    || effect.activationRevision !== input.activationRevision
    || effect.aggregateType !== SHOPIFY_CARRIER_SERVICE_AGGREGATE_TYPE
    || effect.aggregateId !== input.aggregateId
    || effect.aggregateRevision !== input.aggregateRevision
    || effect.aggregateHash !== input.aggregateHash
    || effect.idempotencyKey !== input.idempotencyKey
    || effect.requestHash !== commerceExternalEffectHash(input.redactedRequest)
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_EFFECT_MISMATCH',
      'The durable CarrierService effect does not match this request',
      409,
      false,
      effect.globalId,
    )
  }
}

function assertClaimMatches(
  effect: ClaimedCommerceExternalEffect,
  prepared: CommerceExternalEffect,
  input: NormalizedRegistrationInput,
) {
  assertEffectMatches(effect, input)
  if (
    effect.globalId !== prepared.globalId
    || effect.state !== 'claimed'
    || !effect.leaseToken
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_CLAIM_MISMATCH',
      'The claimed CarrierService effect did not match the prepared effect',
      409,
      false,
      prepared.globalId,
    )
  }
}

function assertRuntimeMatches(
  runtime: CommerceRuntimeCredentialRecord | null,
  claim: ClaimedCommerceExternalEffect,
  input: NormalizedRegistrationInput,
): asserts runtime is CommerceRuntimeCredentialRecord {
  if (
    !runtime
    || runtime.organizationId !== input.organizationId
    || runtime.integrationAccountId !== claim.integrationAccountId
    || runtime.globalId !== input.accountGlobalId
    || runtime.provider !== 'shopify'
    || !SHOPIFY_SHOP_GID_PATTERN.test(runtime.externalAccountId)
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== input.credentialGeneration
    || runtime.authMode !== 'shopify_client_credentials'
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_RUNTIME_STALE',
      'The Shopify connection changed or is not Active and verified',
      409,
      false,
      claim.globalId,
    )
  }
}

function assertAuthorizedRuntimeMatches(
  runtime: CommerceRuntimeCredentialRecord | null,
  authorization: ShopifyCarrierServiceMutationAuthorization & {
    attempt: NonNullable<
      ShopifyCarrierServiceMutationAuthorization['attempt']
    >
  },
): asserts runtime is CommerceRuntimeCredentialRecord {
  if (
    !runtime
    || runtime.organizationId !== authorization.organizationId
    || runtime.integrationAccountId
      !== authorization.integrationAccountId
    || runtime.globalId !== authorization.accountGlobalId
    || runtime.provider !== 'shopify'
    || runtime.environment !== authorization.accountEnvironment
    || !SHOPIFY_SHOP_GID_PATTERN.test(runtime.externalAccountId)
    || !['active', 'disabled'].includes(runtime.status)
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== authorization.credentialGeneration
    || runtime.authMode !== 'shopify_client_credentials'
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_AUTHORIZED_RUNTIME_STALE',
      'The Shopify connection, credential, or environment changed after authorization',
      409,
      false,
      authorization.attempt.globalId,
    )
  }
}

export type ShopifyCarrierServiceMutationVerificationResult = {
  disposition: 'confirmed_applied' | 'confirmed_not_applied'
  providerReference: string | null
  resolutionEvidence: Record<string, unknown>
}

/**
 * Verify an uncertain one-time mutation through Shopify's read API.
 *
 * Create is reconciled by exhaustively enumerating the provider collection:
 * exactly one matching configuration confirms application, while a complete
 * enumeration with no match confirms that the create did not apply.
 * A name-only update is confirmed applied only when the exact GID returns the
 * exact desired name. Delete is confirmed applied only when the exact former
 * GID is absent.
 */
export async function verifyShopifyCarrierServiceMutationForReconciliation(
  input: {
    authorization: ShopifyCarrierServiceMutationAuthorization
    mutation: ShopifyCarrierServiceRegistrationMutation
  },
  overrides: Partial<
    AuthorizedShopifyCarrierServiceMutationDependencies
  > = {},
): Promise<ShopifyCarrierServiceMutationVerificationResult> {
  const authorization = input.authorization
  const dependencies = {
    ...DEFAULT_AUTHORIZED_DEPENDENCIES,
    ...overrides,
  }
  const mutation = normalizeMutation(input.mutation)
  const requestHash =
    shopifyCarrierServiceRegistrationRequestHash(mutation)
  if (
    !authorization.attempt
    || authorization.resolution
    || !authorization.reconciliationRequired
    || authorization.operation !== mutation.operation
    || authorization.requestHash !== requestHash
    || (
      mutation.operation === 'create'
      && authorization.expectedServiceGid !== null
    )
    || (
      mutation.operation !== 'create'
      && authorization.expectedServiceGid !== mutation.id
    )
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_STATE_INVALID',
      'Only an uncertain consumed create, name update, or delete mutation can be verified',
      409,
      false,
      authorization.attempt?.globalId || authorization.globalId,
    )
  }
  const attemptedAuthorization = {
    ...authorization,
    attempt: authorization.attempt,
  }
  assertIntegrationCredentialProviderIoReady()
  let runtime: CommerceRuntimeCredentialRecord | null
  try {
    runtime = await dependencies.readRuntimeCredential({
      organizationId: authorization.organizationId,
      accountGlobalId: authorization.accountGlobalId,
    })
    assertAuthorizedRuntimeMatches(runtime, attemptedAuthorization)
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    if (error instanceof ShopifyCarrierServiceRegistrationError) throw error
    registrationError(
      safeErrorCode(
        error,
        'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_RUNTIME_FAILED',
      ),
      'The exact Shopify connection could not be verified for reconciliation',
      safeStatus(error, 409),
      false,
      authorization.attempt.globalId,
    )
  }
  let credential: ShopifyCommerceRuntimeCredential
  try {
    const storedCredential = decryptShopifyCredential(
      runtime,
      dependencies,
    )
    const shopDomain = normalizeShopifyShopDomain(
      runtime.configuration.shopDomain,
    )
    assertIntegrationCredentialProviderIoReady()
    const grant = await dependencies.requestAccessToken(
      {
        shopDomain,
        clientId: storedCredential.clientId,
        clientSecret: storedCredential.clientSecret,
      },
      { timeoutMs: 10_000 },
    )
    if (!grant.grantedScopes.includes(
      SHOPIFY_CARRIER_SERVICE_RECONCILIATION_REQUIRED_SCOPE,
    )) {
      registrationError(
        'SHOPIFY_CARRIER_SERVICE_READ_SHIPPING_SCOPE_REQUIRED',
        'Shopify did not grant read_shipping for conclusive CarrierService reconciliation',
        409,
      )
    }
    credential = {
      shopDomain,
      accessToken: grant.accessToken,
    }
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    if (error instanceof ShopifyCarrierServiceRegistrationError) throw error
    registrationError(
      safeErrorCode(
        error,
        'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_CREDENTIAL_FAILED',
      ),
      'Shopify credentials could not verify the uncertain mutation',
      safeStatus(error, 409),
      false,
      authorization.attempt.globalId,
    )
  }

  if (mutation.operation === 'create') {
    let observedServices: ShopifyCarrierService[]
    try {
      assertIntegrationCredentialProviderIoReady()
      observedServices = await dependencies.listCarrierServices(
        credential,
        { timeoutMs: 10_000 },
      )
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
      registrationError(
        safeErrorCode(
          error,
          'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_LIST_FAILED',
        ),
        'Shopify did not return a complete CarrierService collection',
        safeStatus(error, 503),
        false,
        authorization.attempt.globalId,
      )
    }
    const exactMatches = observedServices.filter((observed) => (
      observed.name === mutation.name
      && observed.callbackUrl === mutation.callbackUrl
      && observed.active === mutation.active
      && observed.supportsServiceDiscovery
        === mutation.supportsServiceDiscovery
    ))
    if (exactMatches.length > 1) {
      registrationError(
        'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_AMBIGUOUS',
        'Shopify returned more than one exact CarrierService match; provider state remains uncertain',
        409,
        false,
        authorization.attempt.globalId,
      )
    }
    const observed = exactMatches[0] || null
    const resolutionEvidence = {
      provider: 'shopify',
      operation: 'create',
      verification: 'admin_graphql_complete_carrier_service_enumeration',
      completeEnumeration: true,
      observedServiceCount: observedServices.length,
      exactMatchCount: exactMatches.length,
      providerResult: observed
        ? 'one_exact_match'
        : 'no_exact_match',
      providerReferenceSha256: observed
        ? createHash('sha256').update(observed.id).digest('hex')
        : null,
      callbackSha256: callbackEvidence(mutation.callbackUrl)
        .opaqueUrlSha256,
      active: mutation.active,
      supportsServiceDiscovery: mutation.supportsServiceDiscovery,
    }
    assertRedactedCommerceExternalEffectEvidence(
      resolutionEvidence,
      'CarrierService reconciliation evidence',
    )
    return {
      disposition: observed
        ? 'confirmed_applied'
        : 'confirmed_not_applied',
      providerReference: observed?.id || null,
      resolutionEvidence,
    }
  }

  const serviceGid = mutation.id
  let observed: ShopifyCarrierService | null
  try {
    assertIntegrationCredentialProviderIoReady()
    observed = await dependencies.queryCarrierService(
      credential,
      serviceGid,
      { timeoutMs: 10_000 },
    )
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    registrationError(
      safeErrorCode(
        error,
        'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_QUERY_FAILED',
      ),
      'Shopify did not return conclusive CarrierService state',
      safeStatus(error, 503),
      false,
      authorization.attempt.globalId,
    )
  }

  if (mutation.operation === 'update') {
    if (observed?.id !== mutation.id || observed.name !== mutation.name) {
      registrationError(
        'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_INCONCLUSIVE',
        'Shopify did not return the exact desired CarrierService name; the update remains uncertain and cannot be retried',
        409,
        false,
        authorization.attempt.globalId,
      )
    }
    const resolutionEvidence = {
      provider: 'shopify',
      operation: 'update',
      verification: 'admin_graphql_exact_carrier_service',
      providerResult: 'exact_service_name_match',
      providerReferenceSha256:
        createHash('sha256').update(mutation.id).digest('hex'),
      serviceName: mutation.name,
    }
    assertRedactedCommerceExternalEffectEvidence(
      resolutionEvidence,
      'CarrierService reconciliation evidence',
    )
    return {
      disposition: 'confirmed_applied',
      providerReference: mutation.id,
      resolutionEvidence,
    }
  }

  const resolutionEvidence = {
    provider: 'shopify',
    operation: 'delete',
    verification: 'admin_graphql_exact_carrier_service',
    providerResult: observed === null
      ? 'exact_service_absent'
      : 'exact_service_present',
    providerReferenceSha256:
      createHash('sha256').update(serviceGid).digest('hex'),
  }
  assertRedactedCommerceExternalEffectEvidence(
    resolutionEvidence,
    'CarrierService reconciliation evidence',
  )
  return {
    disposition: observed === null
      ? 'confirmed_applied'
      : 'confirmed_not_applied',
    providerReference: observed === null ? serviceGid : null,
    resolutionEvidence,
  }
}

function decryptShopifyCredential(
  runtime: CommerceRuntimeCredentialRecord,
  dependencies: Pick<
    ShopifyCarrierServiceRegistrationDependencies,
    'decryptCredential'
  >,
): ShopifyCommerceCredential {
  let credential
  try {
    credential = dependencies.decryptCredential(
      runtime.encrypted,
      runtime.organizationId,
      runtime.provider,
      runtime.environment,
      runtime.externalAccountId,
    )
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_CREDENTIAL_INVALID',
      'The verified Shopify credential could not be used',
      409,
    )
  }
  if (
    credential.provider !== 'shopify'
    || credential.authMode !== 'shopify_client_credentials'
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_REGISTRATION_CREDENTIAL_INVALID',
      'The verified Shopify credential could not be used',
      409,
    )
  }
  return credential
}

function safeErrorCode(error: unknown, fallback: string) {
  const candidate = error && typeof error === 'object'
    && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return SAFE_CODE_PATTERN.test(candidate) ? candidate : fallback
}

function safeStatus(error: unknown, fallback: number) {
  const candidate = error && typeof error === 'object'
    && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : NaN
  return Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : fallback
}

function unknownProviderOutcome(error: unknown) {
  if (error instanceof ShopifyCommerceClientError) {
    if (error.retryable) return true
    return new Set([
      'SHOPIFY_TIMEOUT',
      'SHOPIFY_UNAVAILABLE',
      'SHOPIFY_UPSTREAM_FAILED',
      'SHOPIFY_RESPONSE_INVALID',
      'SHOPIFY_RESPONSE_TOO_LARGE',
    ]).has(error.code)
  }
  return true
}

function explicitProviderMutationRejection(error: unknown) {
  return error instanceof ShopifyCarrierServiceClientError
    && error.userErrors.length > 0
    && /^SHOPIFY_CARRIER_SERVICE_(?:CREATE|UPDATE|DELETE)_REJECTED$/.test(
      error.code,
    )
}

function assertExactAuthorizedProviderResult(input: {
  mutation: ShopifyCarrierServiceRegistrationMutation
  result: ShopifyCarrierService | string
  priorService?: ShopifyCarrierService | null
}) {
  if (input.mutation.operation === 'delete') {
    if (
      typeof input.result !== 'string'
      || input.result !== input.mutation.id
    ) {
      registrationError(
        'SHOPIFY_CARRIER_SERVICE_PROVIDER_RESPONSE_MISMATCH',
        'Shopify returned a different CarrierService than the exact authorized removal',
        502,
      )
    }
    return
  }
  if (input.mutation.operation === 'update') {
    if (
      typeof input.result === 'string'
      || input.result.id !== input.mutation.id
      || input.result.name !== input.mutation.name
      || !input.priorService
      || input.priorService.id !== input.mutation.id
      || input.result.callbackUrl !== input.priorService.callbackUrl
      || input.result.active !== input.priorService.active
      || input.result.supportsServiceDiscovery
        !== input.priorService.supportsServiceDiscovery
    ) {
      registrationError(
        'SHOPIFY_CARRIER_SERVICE_PROVIDER_RESPONSE_MISMATCH',
        'Shopify did not return the exact authorized name-only CarrierService update',
        502,
      )
    }
    return
  }
  if (
    typeof input.result === 'string'
    || !CARRIER_SERVICE_GID_PATTERN.test(input.result.id)
    || input.result.name !== input.mutation.name
    || input.result.callbackUrl !== input.mutation.callbackUrl
    || input.result.active !== input.mutation.active
    || input.result.supportsServiceDiscovery
      !== input.mutation.supportsServiceDiscovery
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_PROVIDER_RESPONSE_MISMATCH',
      'Shopify did not return the exact authorized CarrierService configuration',
      502,
    )
  }
}

function successfulResultEvidence(
  operation: ShopifyCarrierServiceRegistrationMutation['operation'],
  result: ShopifyCarrierService | string,
) {
  if (typeof result === 'string') {
    return {
      provider: 'shopify',
      operation,
      outcome: 'succeeded',
      carrierServiceId: result,
      providerMutationAttempted: true,
      confirmedProviderWrites: 1,
    }
  }
  return {
    provider: 'shopify',
    operation,
    outcome: 'succeeded',
    carrierServiceId: result.id,
    serviceName: result.name,
    callback: result.callbackUrl
      ? callbackEvidence(result.callbackUrl)
      : null,
    active: result.active,
    supportsServiceDiscovery: result.supportsServiceDiscovery,
    providerMutationAttempted: true,
    confirmedProviderWrites: 1,
  }
}

function failedResultEvidence(input: {
  operation: ShopifyCarrierServiceRegistrationMutation['operation']
  stage: string
  outcome: 'failed' | 'unknown'
  errorCode: string
  providerMutationAttempted: boolean
}) {
  return {
    provider: 'shopify',
    operation: input.operation,
    outcome: input.outcome,
    stage: input.stage,
    errorCode: input.errorCode,
    providerMutationAttempted: input.providerMutationAttempted,
    confirmedProviderWrites: 0,
  }
}

async function finalizeFailure(input: {
  claim: ClaimedCommerceExternalEffect
  normalized: NormalizedRegistrationInput
  dependencies: ShopifyCarrierServiceRegistrationDependencies
  error: unknown
  stage: string
  providerMutationAttempted: boolean
}): Promise<never> {
  // Runtime proof loss did not reach Shopify. Preserve the claimed no-replay
  // effect for reconciliation rather than manufacturing terminal evidence.
  if (isIntegrationCredentialRuntimeGateError(input.error)) throw input.error
  const outcome = input.providerMutationAttempted
    && unknownProviderOutcome(input.error)
    ? 'unknown'
    : 'failed'
  const fallbackCode = outcome === 'unknown'
    ? 'SHOPIFY_CARRIER_SERVICE_PROVIDER_OUTCOME_UNKNOWN'
    : 'SHOPIFY_CARRIER_SERVICE_REGISTRATION_FAILED'
  const errorCode = safeErrorCode(input.error, fallbackCode)
  const redactedResult = failedResultEvidence({
    operation: input.normalized.mutation.operation,
    stage: input.stage,
    outcome,
    errorCode,
    providerMutationAttempted: input.providerMutationAttempted,
  })
  assertRedactedCommerceExternalEffectEvidence(
    redactedResult,
    'CarrierService failure evidence',
  )
  try {
    await input.dependencies.finalizeExternalEffect({
      organizationId: input.normalized.organizationId,
      globalId: input.claim.globalId,
      leaseToken: input.claim.leaseToken,
      outcome,
      redactedResult,
      providerReference: null,
      errorCode,
      providerWriteCount: 0,
    })
  } catch {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_EVIDENCE_FINALIZE_FAILED',
      'CarrierService provider evidence could not be finalized',
      500,
      true,
      input.claim.globalId,
    )
  }
  registrationError(
    errorCode,
    outcome === 'unknown'
      ? 'Shopify CarrierService mutation outcome requires reconciliation'
      : 'Shopify CarrierService registration did not complete',
    outcome === 'unknown' ? 503 : safeStatus(input.error, 409),
    outcome === 'unknown',
    input.claim.globalId,
  )
}

async function performProviderMutation(input: {
  mutation: ShopifyCarrierServiceRegistrationMutation
  credential: ShopifyCommerceRuntimeCredential
  dependencies: Pick<
    ShopifyCarrierServiceRegistrationDependencies,
    'createCarrierService' | 'updateCarrierService' | 'deleteCarrierService'
  >
  options: ShopifyCommerceClientOptions
}) {
  if (input.mutation.operation === 'create') {
    const providerInput: ShopifyCarrierServiceCreateInput = {
      name: input.mutation.name,
      callbackUrl: input.mutation.callbackUrl,
      active: input.mutation.active,
      supportsServiceDiscovery: input.mutation.supportsServiceDiscovery,
    }
    return input.dependencies.createCarrierService(
      input.credential,
      providerInput,
      input.options,
    )
  }
  if (input.mutation.operation === 'update') {
    const providerInput: ShopifyCarrierServiceUpdateInput = {
      id: input.mutation.id,
      ...(input.mutation.name !== undefined
        ? { name: input.mutation.name }
        : {}),
      ...(input.mutation.callbackUrl !== undefined
        ? { callbackUrl: input.mutation.callbackUrl }
        : {}),
      ...(input.mutation.active !== undefined
        ? { active: input.mutation.active }
        : {}),
      ...(input.mutation.supportsServiceDiscovery !== undefined
        ? {
            supportsServiceDiscovery:
              input.mutation.supportsServiceDiscovery,
          }
        : {}),
    }
    return input.dependencies.updateCarrierService(
      input.credential,
      providerInput,
      input.options,
    )
  }
  return input.dependencies.deleteCarrierService(
    input.credential,
    input.mutation.id,
    input.options,
  )
}

/**
 * Register, revise, or remove ClawPilot's Shopify CarrierService.
 *
 * Shadow ends after durable simulation evidence. Active claims one exact
 * revision-fenced intent before decrypting credentials or contacting Shopify.
 */
export async function executeShopifyCarrierServiceRegistration(
  input: ShopifyCarrierServiceRegistrationInput,
  overrides: Partial<ShopifyCarrierServiceRegistrationDependencies> = {},
): Promise<ShopifyCarrierServiceRegistrationResult> {
  const normalized = normalizeInput(input)
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  }
  const simulationEvidence = normalized.mode === 'shadow'
    ? {
        provider: 'shopify',
        operation: normalized.mutation.operation,
        outcome: 'simulated',
        providerWrites: 0,
        requiredScope: SHOPIFY_CARRIER_SERVICE_REQUIRED_SCOPE,
        providerCredentialDecrypted: false,
        providerNetworkCalls: 0,
        requestSha256: commerceExternalEffectHash(
          normalized.redactedRequest,
        ),
      }
    : null
  let prepared: CommerceExternalEffect
  try {
    prepared = await dependencies.prepareExternalEffect({
      organizationId: normalized.organizationId,
      accountGlobalId: normalized.accountGlobalId,
      provider: 'shopify',
      action: normalized.action,
      desiredMode: normalized.mode,
      credentialGeneration: normalized.credentialGeneration,
      activationRevision: normalized.activationRevision,
      aggregateType: SHOPIFY_CARRIER_SERVICE_AGGREGATE_TYPE,
      aggregateId: normalized.aggregateId,
      aggregateRevision: normalized.aggregateRevision,
      aggregateHash: normalized.aggregateHash,
      idempotencyKey: normalized.idempotencyKey,
      redactedRequest: normalized.redactedRequest,
      ...(simulationEvidence ? { simulationEvidence } : {}),
      actorEmail: normalized.actorEmail,
    })
  } catch (error) {
    if (error instanceof ShopifyCarrierServiceRegistrationError) throw error
    registrationError(
      safeErrorCode(
        error,
        'SHOPIFY_CARRIER_SERVICE_EFFECT_PREPARE_FAILED',
      ),
      'CarrierService registration could not be prepared',
      safeStatus(error, 409),
    )
  }
  assertEffectMatches(prepared, normalized)

  if (normalized.mode === 'shadow') {
    if (
      prepared.state !== 'simulated'
      || prepared.providerWriteCount !== 0
    ) {
      registrationError(
        'SHOPIFY_CARRIER_SERVICE_SHADOW_EFFECT_INVALID',
        'Shadow registration did not produce terminal zero-write evidence',
        500,
        false,
        prepared.globalId,
      )
    }
    return {
      effect: prepared,
      operation: normalized.mutation.operation,
      replayed: false,
    }
  }

  if (ACTIVE_TERMINAL_EFFECT_STATES.has(prepared.state)) {
    return {
      effect: prepared,
      operation: normalized.mutation.operation,
      replayed: true,
    }
  }
  if (prepared.state !== 'pending') {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_EFFECT_BUSY',
      'CarrierService registration is already being reconciled',
      409,
      true,
      prepared.globalId,
    )
  }
  assertIntegrationCredentialProviderIoReady()

  let claims: ClaimedCommerceExternalEffect[]
  try {
    claims = await dependencies.claimExternalEffects({
      workerId: normalized.workerId,
      adapterVersion:
        SHOPIFY_CARRIER_SERVICE_REGISTRATION_ADAPTER_VERSION,
      provider: 'shopify',
      globalId: prepared.globalId,
      limit: 1,
      leaseSeconds: 60,
    })
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    registrationError(
      safeErrorCode(
        error,
        'SHOPIFY_CARRIER_SERVICE_EFFECT_CLAIM_FAILED',
      ),
      'CarrierService registration could not claim its exact effect',
      safeStatus(error, 409),
      true,
      prepared.globalId,
    )
  }
  if (claims.length !== 1) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_EFFECT_NOT_CLAIMABLE',
      'CarrierService registration is stale or no longer Active',
      409,
      false,
      prepared.globalId,
    )
  }
  const claim = claims[0]
  assertClaimMatches(claim, prepared, normalized)
  // Close the preflight/claim race without weakening the no-replay state
  // machine. Proof loss leaves this exact claim for reconciliation.
  assertIntegrationCredentialProviderIoReady()

  let runtime: CommerceRuntimeCredentialRecord | null
  try {
    runtime = await dependencies.readRuntimeCredential({
      organizationId: normalized.organizationId,
      accountGlobalId: normalized.accountGlobalId,
    })
    assertRuntimeMatches(runtime, claim, normalized)
  } catch (error) {
    return finalizeFailure({
      claim,
      normalized,
      dependencies,
      error,
      stage: 'runtime_fence',
      providerMutationAttempted: false,
    })
  }

  let runtimeCredential: ShopifyCommerceRuntimeCredential
  try {
    const storedCredential = decryptShopifyCredential(
      runtime,
      dependencies,
    )
    const shopDomain = normalizeShopifyShopDomain(
      runtime.configuration.shopDomain,
    )
    assertIntegrationCredentialProviderIoReady()
    const grant = await dependencies.requestAccessToken(
      {
        shopDomain,
        clientId: storedCredential.clientId,
        clientSecret: storedCredential.clientSecret,
      },
      { timeoutMs: 10_000 },
    )
    if (
      !grant.grantedScopes.includes(
        SHOPIFY_CARRIER_SERVICE_REQUIRED_SCOPE,
      )
    ) {
      registrationError(
        'SHOPIFY_CARRIER_SERVICE_WRITE_SHIPPING_SCOPE_REQUIRED',
        'Shopify did not grant the required CarrierService scope',
        409,
      )
    }
    runtimeCredential = {
      shopDomain,
      accessToken: grant.accessToken,
    }
  } catch (error) {
    return finalizeFailure({
      claim,
      normalized,
      dependencies,
      error,
      stage: 'credential_and_scope',
      providerMutationAttempted: false,
    })
  }

  let providerResult: ShopifyCarrierService | string
  try {
    assertIntegrationCredentialProviderIoReady()
    providerResult = await performProviderMutation({
      mutation: normalized.mutation,
      credential: runtimeCredential,
      dependencies,
      options: { timeoutMs: 10_000 },
    })
  } catch (error) {
    return finalizeFailure({
      claim,
      normalized,
      dependencies,
      error,
      stage: 'provider_mutation',
      providerMutationAttempted: true,
    })
  }

  const redactedResult = successfulResultEvidence(
    normalized.mutation.operation,
    providerResult,
  )
  assertRedactedCommerceExternalEffectEvidence(
    redactedResult,
    'CarrierService success evidence',
  )
  let finalized: CommerceExternalEffect
  try {
    finalized = await dependencies.finalizeExternalEffect({
      organizationId: normalized.organizationId,
      globalId: claim.globalId,
      leaseToken: claim.leaseToken,
      outcome: 'succeeded',
      redactedResult,
      providerReference: typeof providerResult === 'string'
        ? providerResult
        : providerResult.id,
      errorCode: null,
      providerWriteCount: 1,
    })
  } catch {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_EVIDENCE_FINALIZE_FAILED',
      'CarrierService was changed but its provider evidence did not finalize',
      500,
      true,
      claim.globalId,
    )
  }
  if (
    finalized.state !== 'succeeded'
    || finalized.providerWriteCount !== 1
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_SUCCESS_EFFECT_INVALID',
      'CarrierService success evidence is inconsistent',
      500,
      false,
      claim.globalId,
    )
  }
  return {
    effect: finalized,
    operation: normalized.mutation.operation,
    replayed: false,
  }
}

export type AuthorizedShopifyCarrierServiceMutationResult = {
  authorization: ShopifyCarrierServiceMutationAuthorization
  operation: 'create' | 'update' | 'delete'
  providerReference: string
}

function authorizedFailureEvidence(input: {
  operation: 'create' | 'update' | 'delete'
  stage: string
  outcome: 'failed' | 'unknown'
  errorCode: string
  providerMutationAttempted: boolean
}) {
  return {
    provider: 'shopify',
    operation: input.operation,
    outcome: input.outcome,
    stage: input.stage,
    errorCode: input.errorCode,
    providerMutationAttempted: input.providerMutationAttempted,
    confirmedProviderWrites: input.outcome === 'failed' ? 0 : null,
  }
}

async function finalizeAuthorizedFailure(input: {
  authorization: ClaimedShopifyCarrierServiceMutationAuthorization
  dependencies: AuthorizedShopifyCarrierServiceMutationDependencies
  error: unknown
  stage: string
  providerMutationAttempted: boolean
  finalizedBy: string
}): Promise<never> {
  // A revoked credential proof is maintenance, not a provider outcome. The
  // one-time authorization remains consumed and unresolved by design.
  if (isIntegrationCredentialRuntimeGateError(input.error)) throw input.error
  // Once the mutation request has been dispatched, only Shopify's explicit
  // GraphQL userErrors prove that no mutation ID was returned and therefore
  // that zero writes occurred. A timeout, malformed response, mismatched ID,
  // or any other post-dispatch failure is uncertain and must be reconciled.
  const outcome = input.providerMutationAttempted
    ? (
        explicitProviderMutationRejection(input.error)
          ? 'failed'
          : 'unknown'
      )
    : 'failed'
  const fallbackCode = outcome === 'unknown'
    ? 'SHOPIFY_CARRIER_SERVICE_PROVIDER_OUTCOME_UNKNOWN'
    : 'SHOPIFY_CARRIER_SERVICE_AUTHORIZED_MUTATION_FAILED'
  const errorCode = safeErrorCode(input.error, fallbackCode)
  const redactedResult = authorizedFailureEvidence({
    operation: input.authorization.operation,
    stage: input.stage,
    outcome,
    errorCode,
    providerMutationAttempted: input.providerMutationAttempted,
  })
  assertRedactedCommerceExternalEffectEvidence(
    redactedResult,
    'Authorized CarrierService failure evidence',
  )
  try {
    await input.dependencies.finalizeAuthorizedMutation({
      organizationId: input.authorization.organizationId,
      attemptGlobalId: input.authorization.attempt.globalId,
      leaseToken: input.authorization.attempt.leaseToken,
      outcome,
      redactedResult,
      providerReference: null,
      errorCode,
      providerWriteCount: outcome === 'failed' ? 0 : null,
      finalizedBy: input.finalizedBy,
    })
  } catch {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_AUTHORIZED_EVIDENCE_FINALIZE_FAILED',
      'The one-time Shopify mutation was consumed but its outcome requires reconciliation',
      500,
      false,
      input.authorization.attempt.globalId,
    )
  }
  registrationError(
    errorCode,
    outcome === 'unknown'
      ? 'Shopify CarrierService mutation outcome requires reconciliation before any retry'
      : 'Shopify CarrierService mutation did not complete and made zero provider writes',
    outcome === 'unknown' ? 503 : safeStatus(input.error, 409),
    false,
    input.authorization.attempt.globalId,
  )
}

/**
 * Execute the sole Shopify provider mutation authorized by a consumed,
 * credential/config/simulation-fenced, resource-scoped checkout-setup grant.
 * The caller must claim the authorization while Operations remains in a
 * provider-write-capable safety state
 * before invoking this function; credential decryption and every provider
 * network call happen strictly after that durable single-consumption record.
 */
export async function executeAuthorizedShopifyCarrierServiceMutation(
  input: {
    authorization: ClaimedShopifyCarrierServiceMutationAuthorization
    mutation: ShopifyCarrierServiceRegistrationMutation
    finalizedBy?: string
  },
  overrides: Partial<
    AuthorizedShopifyCarrierServiceMutationDependencies
  > = {},
): Promise<AuthorizedShopifyCarrierServiceMutationResult> {
  const authorization = input.authorization
  const dependencies = {
    ...DEFAULT_AUTHORIZED_DEPENDENCIES,
    ...overrides,
  }
  const mutation = normalizeMutation(input.mutation)
  if (
    mutation.operation === 'update'
    && (
      mutation.name === undefined
      || mutation.callbackUrl !== undefined
      || mutation.active !== undefined
      || mutation.supportsServiceDiscovery !== undefined
    )
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_AUTHORIZATION_OPERATION_INVALID',
      'One-time CarrierService update authorization supports the exact provider-verified name only',
      400,
      false,
      authorization.attempt.globalId,
    )
  }
  const requestHash =
    shopifyCarrierServiceRegistrationRequestHash(mutation)
  if (
    authorization.status !== 'claimed'
    || !['shadow', 'read_only', 'active'].includes(
      authorization.activationState,
    )
    || authorization.providerWriteActivationRevision === null
    || authorization.operation !== mutation.operation
    || authorization.requestHash !== requestHash
    || (
      mutation.operation === 'create'
      && authorization.expectedServiceGid !== null
    )
    || (
      mutation.operation !== 'create'
      && authorization.expectedServiceGid !== mutation.id
    )
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_AUTHORIZATION_MISMATCH',
      'The consumed one-time authorization does not match this exact Shopify mutation',
      409,
      false,
      authorization.attempt.globalId,
    )
  }
  const finalizedBy = safeIdentifier(
    input.finalizedBy
      || SHOPIFY_CARRIER_SERVICE_REGISTRATION_ADAPTER_VERSION,
    'Mutation finalizer',
    200,
  )
  assertIntegrationCredentialProviderIoReady()
  let runtime: CommerceRuntimeCredentialRecord | null
  try {
    runtime = await dependencies.readRuntimeCredential({
      organizationId: authorization.organizationId,
      accountGlobalId: authorization.accountGlobalId,
    })
    assertAuthorizedRuntimeMatches(runtime, authorization)
  } catch (error) {
    return finalizeAuthorizedFailure({
      authorization,
      dependencies,
      error,
      stage: 'runtime_fence',
      providerMutationAttempted: false,
      finalizedBy,
    })
  }

  let runtimeCredential: ShopifyCommerceRuntimeCredential
  try {
    const storedCredential = decryptShopifyCredential(
      runtime,
      dependencies,
    )
    const shopDomain = normalizeShopifyShopDomain(
      runtime.configuration.shopDomain,
    )
    assertIntegrationCredentialProviderIoReady()
    const grant = await dependencies.requestAccessToken(
      {
        shopDomain,
        clientId: storedCredential.clientId,
        clientSecret: storedCredential.clientSecret,
      },
      { timeoutMs: 10_000 },
    )
    if (
      !grant.grantedScopes.includes(
        SHOPIFY_CARRIER_SERVICE_REQUIRED_SCOPE,
      )
    ) {
      registrationError(
        'SHOPIFY_CARRIER_SERVICE_WRITE_SHIPPING_SCOPE_REQUIRED',
        'Shopify did not grant the required CarrierService scope',
        409,
      )
    }
    runtimeCredential = {
      shopDomain,
      accessToken: grant.accessToken,
    }
  } catch (error) {
    return finalizeAuthorizedFailure({
      authorization,
      dependencies,
      error,
      stage: 'credential_and_scope',
      providerMutationAttempted: false,
      finalizedBy,
    })
  }

  let priorService: ShopifyCarrierService | null = null
  if (mutation.operation === 'update') {
    try {
      assertIntegrationCredentialProviderIoReady()
      priorService = await dependencies.queryCarrierService(
        runtimeCredential,
        mutation.id,
        { timeoutMs: 10_000 },
      )
      if (!priorService || priorService.id !== mutation.id) {
        registrationError(
          'SHOPIFY_CARRIER_SERVICE_PROVIDER_PRECONDITION_FAILED',
          'The exact Shopify CarrierService could not be read before its name-only update',
          409,
        )
      }
    } catch (error) {
      return finalizeAuthorizedFailure({
        authorization,
        dependencies,
        error,
        stage: 'provider_precondition',
        providerMutationAttempted: false,
        finalizedBy,
      })
    }
  }

  let providerResult: ShopifyCarrierService | string
  try {
    assertIntegrationCredentialProviderIoReady()
    providerResult = await performProviderMutation({
      mutation,
      credential: runtimeCredential,
      dependencies,
      options: { timeoutMs: 10_000 },
    })
  } catch (error) {
    return finalizeAuthorizedFailure({
      authorization,
      dependencies,
      error,
      stage: 'provider_mutation',
      providerMutationAttempted: true,
      finalizedBy,
    })
  }

  let providerReference: string
  let redactedResult: Record<string, unknown>
  try {
    assertExactAuthorizedProviderResult({
      mutation,
      result: providerResult,
      priorService,
    })
    providerReference = typeof providerResult === 'string'
      ? providerResult
      : providerResult.id
    redactedResult = successfulResultEvidence(
      mutation.operation,
      providerResult,
    )
    assertRedactedCommerceExternalEffectEvidence(
      redactedResult,
      'Authorized CarrierService success evidence',
    )
  } catch (error) {
    return finalizeAuthorizedFailure({
      authorization,
      dependencies,
      error,
      stage: 'provider_response_verification',
      providerMutationAttempted: true,
      finalizedBy,
    })
  }
  let finalized: ShopifyCarrierServiceMutationAuthorization | null
  try {
    finalized = await dependencies.finalizeAuthorizedMutation({
      organizationId: authorization.organizationId,
      attemptGlobalId: authorization.attempt.globalId,
      leaseToken: authorization.attempt.leaseToken,
      outcome: 'succeeded',
      redactedResult,
      providerReference,
      errorCode: null,
      providerWriteCount: 1,
      finalizedBy,
    })
  } catch {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_AUTHORIZED_EVIDENCE_FINALIZE_FAILED',
      'Shopify changed the CarrierService, but durable outcome evidence requires reconciliation',
      500,
      false,
      authorization.attempt.globalId,
    )
  }
  if (
    !finalized
    || finalized.status !== 'succeeded'
    || finalized.outcome?.providerWriteCount !== 1
    || finalized.outcome.providerReference !== providerReference
  ) {
    registrationError(
      'SHOPIFY_CARRIER_SERVICE_AUTHORIZED_SUCCESS_INVALID',
      'Durable CarrierService success evidence is inconsistent',
      500,
      false,
      authorization.attempt.globalId,
    )
  }
  return {
    authorization: finalized,
    operation: mutation.operation,
    providerReference,
  }
}
