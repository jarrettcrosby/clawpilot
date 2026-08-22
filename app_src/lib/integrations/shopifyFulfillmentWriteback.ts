import {
  decryptCommerceCredential,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  hasEffectiveShopifyScope,
} from '@/lib/integrations/commerceCapabilities'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'
import {
  requireCurrentCommerceProviderWritesInPostgres,
  requireSealedCommerceProviderWritesInPostgres,
  type CommerceProviderWriteAuthority,
} from '@/lib/persistence/commerceProviderWrites'
import {
  requireShopifyTestStoreFulfillmentWriteClaimInPostgres,
} from '@/lib/persistence/shopifyTestStoreCanonicalE2e'
import {
  requireLegacySandboxCommerceE2eFulfillmentWriteClaimInPostgres,
} from '@/lib/persistence/sandboxCommerceE2eAuthorization'

const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_GID = /^gid:\/\/shopify\/Fulfillment\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_ORDER_GID =
  /^gid:\/\/shopify\/FulfillmentOrder\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_ORDER_LINE_ITEM_GID =
  /^gid:\/\/shopify\/FulfillmentOrderLineItem\/[1-9][0-9]*$/
const SHOPIFY_LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]*$/
const SHOPIFY_LOCATION_GID = /^gid:\/\/shopify\/Location\/[1-9][0-9]*$/
const PROVIDER_ATTEMPT_GLOBAL_ID = /^gxa(?:[0-9]{7}|[0-9a-v]{12})$/
const COMMERCE_EXPORT_GLOBAL_ID = /^gfe(?:[0-9]{7}|[0-9a-v]{12})$/
const SHA256 = /^[a-f0-9]{64}$/
const REQUIRED_SCOPES = [
  'read_orders',
  'write_merchant_managed_fulfillment_orders',
] as const
type SandboxE2eAuthorityKind =
  | 'legacy_packed'
  | 'shopify_test_store_canonical'

export type ShopifyFulfillmentWritebackInput = {
  organizationId: unknown
  accountGlobalId: unknown
  externalOrderId: unknown
  trackingNumber?: unknown
  trackingNumbers?: unknown
  carrier: unknown
  notifyCustomer: unknown
  expectedLineItems: unknown
  attemptSignature?: unknown
  sandboxE2eAuthorizationGlobalId?: unknown
  sandboxE2eAuthorityKind?: unknown
  commerceExportGlobalId?: unknown
  providerWriteControlRowVersion?: unknown
  providerWriteCredentialGeneration?: unknown
  providerWriteScopeDigest?: unknown
  providerWriteAccountGlobalId?: unknown
  providerWriteProvider?: unknown
  providerWriteEnvironment?: unknown
  providerAttemptGlobalId?: unknown
  providerAttemptRequestHash?: unknown
}

export type ShopifyFulfillmentAttemptSignature = {
  version: 1
  externalOrderId: string
  fulfillmentOrders: Array<{
    fulfillmentOrderId: string
    locationId: string
    lineItems: Array<{
      fulfillmentOrderLineItemId: string
      lineItemId: string
      quantity: number
    }>
  }>
  lineItems: Array<{
    lineItemId: string
    quantity: number
  }>
  carrier: string
  trackingNumbers: string[]
  notifyCustomer: boolean
  sandboxE2eAuthorityKind: SandboxE2eAuthorityKind | null
}

export type ShopifyFulfillmentWritebackPreparation = {
  signature: ShopifyFulfillmentAttemptSignature
  existing: ShopifyFulfillmentWritebackResult | null
}

export type ShopifyFulfillmentWritebackResult = {
  providerReference: string
  trackingNumber: string
  trackingNumbers: string[]
  replayed: boolean
}

export class ShopifyFulfillmentWritebackError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly outcomeUnknown = false,
  ) {
    super(message)
    this.name = 'ShopifyFulfillmentWritebackError'
  }
}

type ShopifyFulfillmentWritebackDependencies = {
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  requireProviderWrites:
    typeof requireCurrentCommerceProviderWritesInPostgres
  requireSealedProviderWrites:
    typeof requireSealedCommerceProviderWritesInPostgres
  requireTestStoreClaim:
    typeof requireShopifyTestStoreFulfillmentWriteClaimInPostgres
  requireLegacySandboxClaim:
    typeof requireLegacySandboxCommerceE2eFulfillmentWriteClaimInPostgres
  decryptCredential: typeof decryptCommerceCredential
  requestAccessToken: typeof requestShopifyAccessToken
  probeConnection: typeof probeShopifyConnection
  readFulfillment: typeof readShopifyFulfillment
  writeFulfillment: typeof writeShopifyFulfillment
}

const DEFAULT_DEPENDENCIES: ShopifyFulfillmentWritebackDependencies = {
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  requireProviderWrites: requireCurrentCommerceProviderWritesInPostgres,
  requireSealedProviderWrites: requireSealedCommerceProviderWritesInPostgres,
  requireTestStoreClaim:
    requireShopifyTestStoreFulfillmentWriteClaimInPostgres,
  requireLegacySandboxClaim:
    requireLegacySandboxCommerceE2eFulfillmentWriteClaimInPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
  readFulfillment: readShopifyFulfillment,
  writeFulfillment: writeShopifyFulfillment,
}

function clean(value: unknown, label: string, max = 255) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_INPUT_INVALID',
      `${label} is invalid`,
    )
  }
  return normalized
}

function orderGid(value: unknown) {
  const gid = clean(value, 'Shopify order ID', 128)
  if (!SHOPIFY_ORDER_GID.test(gid)) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_ORDER_INVALID',
      'Shopify order ID is invalid',
    )
  }
  return gid
}

function normalizedTrackingNumbers(single: unknown, multiple: unknown) {
  const values = Array.isArray(multiple) ? multiple : [single]
  const normalized = [...new Set(values.map((value) => (
    clean(value, 'Tracking number', 128)
  )))]
  if (normalized.length < 1 || normalized.length > 10) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_TRACKING_INVALID',
      'Shopify fulfillment requires 1-10 unique tracking numbers',
    )
  }
  return normalized
}

function sandboxE2eAuthorityKind(value: unknown): SandboxE2eAuthorityKind | null {
  const normalized = String(value || '').trim()
  if (!normalized) return null
  if (
    normalized !== 'legacy_packed'
    && normalized !== 'shopify_test_store_canonical'
  ) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_TEST_E2E_AUTHORITY_KIND_INVALID',
      'Exact sandbox fulfillment authority kind is invalid',
    )
  }
  return normalized
}

async function authorizedShopifyFulfillmentWriteback(
  input: ShopifyFulfillmentWritebackInput,
  dependencies: ShopifyFulfillmentWritebackDependencies,
  mode: 'prepare' | 'execute' | 'reconcile',
) {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  const externalOrderId = orderGid(input.externalOrderId)
  const trackingNumbers = normalizedTrackingNumbers(
    input.trackingNumber,
    input.trackingNumbers,
  )
  const carrier = clean(input.carrier, 'Carrier', 64)
  if (typeof input.notifyCustomer !== 'boolean') {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_NOTIFICATION_DECISION_REQUIRED',
      'An explicit Shopify customer notification decision is required',
    )
  }
  const notifyCustomer = input.notifyCustomer
  const expectedLineItems = normalizeExpectedLineItems(input.expectedLineItems)
  const authorizationGlobalId = String(
    input.sandboxE2eAuthorizationGlobalId || '',
  ).trim() || null
  const commerceExportGlobalId = String(
    input.commerceExportGlobalId || '',
  ).trim() || null
  const requestedAuthorityKind = sandboxE2eAuthorityKind(
    input.sandboxE2eAuthorityKind,
  )
  if (
    (authorizationGlobalId && !commerceExportGlobalId)
    || (requestedAuthorityKind !== null && !authorizationGlobalId)
  ) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_TEST_E2E_FULFILLMENT_CLAIM_INVALID',
      'Exact sandbox authorization, authority kind, and commerce export evidence are required together',
    )
  }
  let providerWriteAuthority: CommerceProviderWriteAuthority | null = null
  if (mode !== 'reconcile') {
    if (mode === 'execute') {
      const providerAttemptGlobalId = String(
        input.providerAttemptGlobalId || '',
      ).trim().toLowerCase()
      const providerAttemptRequestHash = String(
        input.providerAttemptRequestHash || '',
      ).trim().toLowerCase()
      if (
        !PROVIDER_ATTEMPT_GLOBAL_ID.test(providerAttemptGlobalId)
        || !SHA256.test(providerAttemptRequestHash)
        || !commerceExportGlobalId
        || !COMMERCE_EXPORT_GLOBAL_ID.test(commerceExportGlobalId)
      ) {
        throw new ShopifyFulfillmentWritebackError(
          'SHOPIFY_FULFILLMENT_PROVIDER_ATTEMPT_INVALID',
          'Execution requires an exact durable prepared provider attempt, request hash, and commerce export',
        )
      }
      if (
        input.providerWriteAccountGlobalId !== accountGlobalId
        || input.providerWriteProvider !== 'shopify'
        || !['sandbox', 'production'].includes(
          String(input.providerWriteEnvironment || ''),
        )
      ) {
        throw new ShopifyFulfillmentWritebackError(
          'SHOPIFY_FULFILLMENT_PROVIDER_AUTHORITY_MISMATCH',
          'Registered provider attempt authority does not match the exact Shopify account',
        )
      }
      providerWriteAuthority =
        await dependencies.requireSealedProviderWrites({
          organizationId,
          accountGlobalId,
          provider: 'shopify',
          environment: input.providerWriteEnvironment as
            'sandbox' | 'production',
          providerAttemptGlobalId,
          providerAttemptRequestHash,
          commerceExportGlobalId,
          requiredScopes: REQUIRED_SCOPES,
          expectedControlRowVersion: input.providerWriteControlRowVersion,
          expectedCredentialGeneration:
            input.providerWriteCredentialGeneration,
          expectedGrantedScopeDigest: input.providerWriteScopeDigest,
        })
    } else {
      providerWriteAuthority = await dependencies.requireProviderWrites({
        organizationId,
        accountGlobalId,
        provider: 'shopify',
        requiredScopes: REQUIRED_SCOPES,
        expectedControlRowVersion: input.providerWriteControlRowVersion,
        expectedCredentialGeneration:
          input.providerWriteCredentialGeneration,
        expectedGrantedScopeDigest: input.providerWriteScopeDigest,
      })
    }
  }
  const runtimePromise = dependencies.readRuntimeCredential({
    organizationId,
    accountGlobalId,
  })
  let testStoreClaim: Awaited<ReturnType<typeof dependencies.requireTestStoreClaim>> | null = null
  let legacySandboxClaim: Awaited<ReturnType<typeof dependencies.requireLegacySandboxClaim>> | null = null
  let runtime: Awaited<ReturnType<typeof dependencies.readRuntimeCredential>>
  const claimInput = {
    organizationId,
    accountGlobalId,
    externalOrderId,
    authorizationGlobalId,
    commerceExportGlobalId,
  }
  if (requestedAuthorityKind === 'shopify_test_store_canonical') {
    [testStoreClaim, runtime] = await Promise.all([
      dependencies.requireTestStoreClaim(claimInput),
      runtimePromise,
    ])
  } else if (
    requestedAuthorityKind === 'legacy_packed'
    || (authorizationGlobalId && commerceExportGlobalId)
  ) {
    [legacySandboxClaim, runtime] =
      await Promise.all([
        dependencies.requireLegacySandboxClaim(claimInput),
        runtimePromise,
      ])
  } else {
    runtime = await runtimePromise
  }
  const authorityKind = testStoreClaim
    ? 'shopify_test_store_canonical' as const
    : legacySandboxClaim
      ? 'legacy_packed' as const
      : null
  const allowLegacySignatureWithoutAuthorityKind = Boolean(
    authorityKind === 'legacy_packed'
    && requestedAuthorityKind === null
    && legacySandboxClaim
    && legacySandboxClaim.authorityKindPersisted === false,
  )
  if (!runtime || runtime.provider !== 'shopify' || runtime.status !== 'active'
      || runtime.verificationStatus !== 'verified') {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_CONNECTION_INVALID',
      'A verified active Shopify connection is required',
    )
  }
  if (
    providerWriteAuthority
    && (
      providerWriteAuthority.accountGlobalId !== accountGlobalId
      || providerWriteAuthority.provider !== 'shopify'
      || providerWriteAuthority.environment !== runtime.environment
      || providerWriteAuthority.credentialGeneration
        !== runtime.credentialVersion
      || REQUIRED_SCOPES.some((scope) => (
        !hasEffectiveShopifyScope(
          providerWriteAuthority.grantedScopes,
          scope,
        )
      ))
    )
  ) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_PROVIDER_WRITES_STALE',
      'Provider writes no longer matches the current Shopify fulfillment credential',
    )
  }
  if (testStoreClaim) {
    if (
      notifyCustomer !== false
      || runtime.environment !== 'sandbox'
      || testStoreClaim.authorityKind
        !== 'shopify_test_store_canonical'
      || testStoreClaim.notifyCustomer !== false
      || testStoreClaim.credentialGeneration !== runtime.credentialVersion
      || testStoreClaim.externalAccountId !== runtime.externalAccountId
    ) {
      throw new ShopifyFulfillmentWritebackError(
        'SHOPIFY_TEST_E2E_FULFILLMENT_AUTHORIZATION_STALE',
        'Exact Shopify test-store fulfillment authority is stale or unsafe',
      )
    }
  } else if (
    authorityKind === 'legacy_packed'
      && (
        !legacySandboxClaim
        || legacySandboxClaim.authorityKind !== 'legacy_packed'
        || legacySandboxClaim.notifyCustomer !== false
        || (
          requestedAuthorityKind === 'legacy_packed'
          && legacySandboxClaim.authorityKindPersisted !== true
        )
        || (
          requestedAuthorityKind === null
          && legacySandboxClaim.authorityKindPersisted !== false
        )
        || notifyCustomer !== false
      )
  ) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_AUTHORIZATION_STALE',
      'Shopify fulfillment authorization is stale; review the exact order evidence again',
    )
  }
  const credential = dependencies.decryptCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (credential.provider !== 'shopify') {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_CREDENTIAL_INVALID',
      'Stored Shopify credential could not be decrypted',
    )
  }
  const shopDomain = normalizeShopifyShopDomain(runtime.configuration.shopDomain)
  const grant = await dependencies.requestAccessToken({
    shopDomain,
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
  })
  const probe = await dependencies.probeConnection({
    shopDomain,
    accessToken: grant.accessToken,
  })
  if (probe.shopId !== runtime.externalAccountId) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_STORE_CHANGED',
      'Shopify returned a different store identity',
    )
  }
  if (
    REQUIRED_SCOPES.some((scope) => (
      !hasEffectiveShopifyScope(grant.grantedScopes, scope)
      || !hasEffectiveShopifyScope(probe.grantedScopes, scope)
    ))
  ) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_SCOPE_REQUIRED',
      `Shopify must grant ${REQUIRED_SCOPES.join(' and ')}`,
    )
  }
  return {
    credential: { shopDomain, accessToken: grant.accessToken },
    providerInput: {
      externalOrderId,
      trackingNumbers,
      carrier,
      notifyCustomer,
      expectedLineItems,
      sandboxE2eAuthorityKind: authorityKind,
      allowLegacySignatureWithoutAuthorityKind,
    },
  }
}

export async function executeShopifyFulfillmentWriteback(
  input: ShopifyFulfillmentWritebackInput,
  dependencies: ShopifyFulfillmentWritebackDependencies = DEFAULT_DEPENDENCIES,
): Promise<ShopifyFulfillmentWritebackResult> {
  const authorized = await authorizedShopifyFulfillmentWriteback(
    input,
    dependencies,
    'execute',
  )
  return dependencies.writeFulfillment(
    authorized.credential,
    authorized.providerInput,
    input.attemptSignature,
  )
}

/**
 * Authorizes the provider connection and snapshots the exact Shopify work that
 * a later mutation is allowed to perform. The returned signature is safe to
 * persist as JSON and must be supplied to unknown-outcome reconciliation.
 */
export async function prepareShopifyFulfillmentWriteback(
  input: ShopifyFulfillmentWritebackInput,
  dependencies: ShopifyFulfillmentWritebackDependencies = DEFAULT_DEPENDENCIES,
): Promise<ShopifyFulfillmentWritebackPreparation> {
  const authorized = await authorizedShopifyFulfillmentWriteback(
    input,
    dependencies,
    'prepare',
  )
  const inspection = await inspectShopifyFulfillment(
    authorized.credential,
    authorized.providerInput,
  )
  const plan = deriveOpenFulfillmentPlan(
    inspection.order,
    authorized.providerInput,
  )
  requirePlanMatchesExpectedLines(plan, authorized.providerInput)
  return {
    signature: plan.signature,
    existing: findExactExistingFulfillment(
      inspection.fulfillments,
      plan.signature,
      authorized.providerInput,
    ),
  }
}

/**
 * Reconciles an unknown Shopify fulfillment outcome without issuing a provider
 * mutation. A stale export lease must use this path before it can become
 * retryable, preventing lease recovery from racing a delayed customer-emailing
 * fulfillment mutation.
 */
export async function reconcileShopifyFulfillmentWriteback(
  input: ShopifyFulfillmentWritebackInput,
  dependencies: ShopifyFulfillmentWritebackDependencies = DEFAULT_DEPENDENCIES,
): Promise<ShopifyFulfillmentWritebackResult | null> {
  if (input.attemptSignature === undefined) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_SIGNATURE_REQUIRED',
      'Shopify fulfillment reconciliation requires the prepared attempt signature',
    )
  }
  const authorized = await authorizedShopifyFulfillmentWriteback(
    input,
    dependencies,
    'reconcile',
  )
  return dependencies.readFulfillment(
    authorized.credential,
    authorized.providerInput,
    input.attemptSignature,
  )
}

const ORDER_FULFILLMENT_QUERY = `query ClawPilotOrderFulfillment($id: ID!) {
  order(id: $id) {
    id
    canNotifyCustomer
    fulfillments(first: 250) {
      id
      status
      fulfillmentOrders(first: 100) {
        nodes { id assignedLocation { location { id } } }
        pageInfo { hasNextPage }
      }
      fulfillmentLineItems(first: 250) {
        nodes { lineItem { id } quantity }
        pageInfo { hasNextPage }
      }
      trackingInfo(first: 11) { company number }
    }
    fulfillmentOrders(first: 100) {
      nodes {
        id
        status
        requestStatus
        assignedLocation { location { id } }
        lineItems(first: 250) {
          nodes { id lineItem { id } remainingQuantity }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}`

const FULFILLMENT_CREATE_MUTATION = `mutation ClawPilotFulfillmentCreate($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status trackingInfo(first: 10) { number } }
    userErrors { field message }
  }
}`

type ProviderWriteInput = {
  externalOrderId: string
  trackingNumbers: string[]
  carrier: string
  notifyCustomer: boolean
  expectedLineItems: Array<{ lineItemId: string; quantity: number }>
  sandboxE2eAuthorityKind: SandboxE2eAuthorityKind | null
  allowLegacySignatureWithoutAuthorityKind: boolean
}

type ObservedFulfillment = {
  providerReference: string
  status: string
  matchShape: ObservedFulfillmentMatchShape | null
}

type ObservedFulfillmentMatchShape = {
  externalOrderId: string
  fulfillmentOrders: Array<{
    fulfillmentOrderId: string
    locationId: string
  }>
  lineItems: Array<{ lineItemId: string; quantity: number }>
  carrier: string
  trackingNumbers: string[]
}

type ShopifyFulfillmentInspection = {
  order: Record<string, unknown>
  fulfillments: ObservedFulfillment[]
}

type OpenFulfillmentPlan = {
  signature: ShopifyFulfillmentAttemptSignature
  lineItemsByFulfillmentOrder: Array<{
    fulfillmentOrderId: string
    fulfillmentOrderLineItems: Array<{ id: string; quantity: number }>
  }>
}

function providerShapeError(message: string): never {
  throw new ShopifyFulfillmentWritebackError(
    'SHOPIFY_FULFILLMENT_RESPONSE_INVALID',
    message,
    true,
  )
}

function providerRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return providerShapeError(`Shopify returned malformed ${label}`)
  }
  return value as Record<string, unknown>
}

function providerRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return providerShapeError(`Shopify returned malformed ${label}`)
  }
  return value.map((item, index) => providerRecord(item, `${label}[${index}]`))
}

function providerText(value: unknown, label: string, max = 255) {
  if (typeof value !== 'string') {
    return providerShapeError(`Shopify returned malformed ${label}`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return providerShapeError(`Shopify returned malformed ${label}`)
  }
  return normalized
}

function providerInteger(value: unknown, label: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    return providerShapeError(`Shopify returned malformed ${label}`)
  }
  return Number(value)
}

function pagedNodes(
  value: unknown,
  label: string,
  paginationCode: string,
  paginationMessage: string,
) {
  const connection = providerRecord(value, label)
  const pageInfo = providerRecord(connection.pageInfo, `${label}.pageInfo`)
  if (typeof pageInfo.hasNextPage !== 'boolean') {
    return providerShapeError(`Shopify returned malformed ${label}.pageInfo.hasNextPage`)
  }
  if (pageInfo.hasNextPage) {
    throw new ShopifyFulfillmentWritebackError(
      paginationCode,
      paginationMessage,
    )
  }
  return providerRecords(connection.nodes, `${label}.nodes`)
}

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function addLineQuantity(
  aggregate: Map<string, number>,
  lineItemId: string,
  quantity: number,
) {
  const next = (aggregate.get(lineItemId) || 0) + quantity
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_SIGNATURE_INVALID',
      'Shopify fulfillment line-item quantity is outside the supported range',
    )
  }
  aggregate.set(lineItemId, next)
}

function lineItemsFromAggregate(aggregate: Map<string, number>) {
  return [...aggregate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([lineItemId, quantity]) => ({ lineItemId, quantity }))
}

function signatureInvalid(message: string): never {
  throw new ShopifyFulfillmentWritebackError(
    'SHOPIFY_FULFILLMENT_SIGNATURE_INVALID',
    message,
  )
}

function normalizeExpectedLineItems(
  value: unknown,
): Array<{ lineItemId: string; quantity: number }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 25_000) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_EXPECTED_LINES_REQUIRED',
      'Shopify fulfillment requires the packaged Shopify line-item IDs and quantities',
    )
  }
  const aggregate = new Map<string, number>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return signatureInvalid('Shopify expected line-item input is invalid')
    }
    const line = item as Record<string, unknown>
    if (line.lineItemId != null && line.externalLineId != null
        && String(line.lineItemId).trim() !== String(line.externalLineId).trim()) {
      return signatureInvalid('Shopify expected line-item aliases disagree')
    }
    const lineItemId = clean(
      line.lineItemId ?? line.externalLineId,
      'Shopify line item ID',
      128,
    )
    if (!SHOPIFY_LINE_ITEM_GID.test(lineItemId)
        || !Number.isSafeInteger(line.quantity)
        || Number(line.quantity) < 1) {
      return signatureInvalid('Shopify expected line-item input is invalid')
    }
    addLineQuantity(aggregate, lineItemId, Number(line.quantity))
  }
  return lineItemsFromAggregate(aggregate)
}

type SignatureFulfillmentOrder = ShopifyFulfillmentAttemptSignature['fulfillmentOrders'][number]

function canonicalSignature(input: {
  externalOrderId: string
  fulfillmentOrders: SignatureFulfillmentOrder[]
  carrier: string
  trackingNumbers: string[]
  notifyCustomer: boolean
  sandboxE2eAuthorityKind: SandboxE2eAuthorityKind | null
}): ShopifyFulfillmentAttemptSignature {
  const fulfillmentOrders = input.fulfillmentOrders
    .map((fulfillmentOrder) => ({
      ...fulfillmentOrder,
      lineItems: [...fulfillmentOrder.lineItems].sort((left, right) => (
        left.fulfillmentOrderLineItemId.localeCompare(right.fulfillmentOrderLineItemId)
      )),
    }))
    .sort((left, right) => (
      left.fulfillmentOrderId.localeCompare(right.fulfillmentOrderId)
    ))
  const lineAggregate = new Map<string, number>()
  for (const fulfillmentOrder of fulfillmentOrders) {
    for (const line of fulfillmentOrder.lineItems) {
      addLineQuantity(lineAggregate, line.lineItemId, line.quantity)
    }
  }
  return {
    version: 1,
    externalOrderId: input.externalOrderId,
    fulfillmentOrders,
    lineItems: lineItemsFromAggregate(lineAggregate),
    carrier: input.carrier,
    trackingNumbers: sortedUnique(input.trackingNumbers),
    notifyCustomer: input.notifyCustomer,
    sandboxE2eAuthorityKind: input.sandboxE2eAuthorityKind ?? null,
  }
}

function normalizeAttemptSignature(
  value: unknown,
): ShopifyFulfillmentAttemptSignature {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return signatureInvalid('Shopify fulfillment attempt signature is invalid')
  }
  const signature = value as Record<string, unknown>
  if (signature.version !== 1) {
    return signatureInvalid('Shopify fulfillment attempt signature version is invalid')
  }
  const externalOrderId = orderGid(signature.externalOrderId)
  if (!Array.isArray(signature.fulfillmentOrders)
      || signature.fulfillmentOrders.length < 1
      || signature.fulfillmentOrders.length > 100) {
    return signatureInvalid('Shopify fulfillment-order signature set is invalid')
  }
  const seenFulfillmentOrderIds = new Set<string>()
  const seenFulfillmentOrderLineItemIds = new Set<string>()
  const fulfillmentOrders: SignatureFulfillmentOrder[] = []
  for (const value of signature.fulfillmentOrders) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return signatureInvalid('Shopify fulfillment-order signature set is invalid')
    }
    const fulfillmentOrder = value as Record<string, unknown>
    const fulfillmentOrderId = clean(
      fulfillmentOrder.fulfillmentOrderId,
      'Shopify fulfillment order ID',
      128,
    )
    const locationId = clean(fulfillmentOrder.locationId, 'Shopify location ID', 128)
    if (!SHOPIFY_FULFILLMENT_ORDER_GID.test(fulfillmentOrderId)
        || !SHOPIFY_LOCATION_GID.test(locationId)
        || seenFulfillmentOrderIds.has(fulfillmentOrderId)
        || !Array.isArray(fulfillmentOrder.lineItems)
        || fulfillmentOrder.lineItems.length < 1
        || fulfillmentOrder.lineItems.length > 512) {
      return signatureInvalid('Shopify fulfillment-order signature set is invalid')
    }
    seenFulfillmentOrderIds.add(fulfillmentOrderId)
    const lineItems: SignatureFulfillmentOrder['lineItems'] = []
    for (const lineValue of fulfillmentOrder.lineItems) {
      if (!lineValue || typeof lineValue !== 'object' || Array.isArray(lineValue)) {
        return signatureInvalid('Shopify fulfillment-order line-item signature is invalid')
      }
      const line = lineValue as Record<string, unknown>
      const fulfillmentOrderLineItemId = clean(
        line.fulfillmentOrderLineItemId,
        'Shopify fulfillment order line item ID',
        128,
      )
      const lineItemId = clean(line.lineItemId, 'Shopify line item ID', 128)
      if (!SHOPIFY_FULFILLMENT_ORDER_LINE_ITEM_GID.test(fulfillmentOrderLineItemId)
          || !SHOPIFY_LINE_ITEM_GID.test(lineItemId)
          || seenFulfillmentOrderLineItemIds.has(fulfillmentOrderLineItemId)
          || !Number.isSafeInteger(line.quantity)
          || Number(line.quantity) < 1) {
        return signatureInvalid('Shopify fulfillment-order line-item signature is invalid')
      }
      seenFulfillmentOrderLineItemIds.add(fulfillmentOrderLineItemId)
      lineItems.push({
        fulfillmentOrderLineItemId,
        lineItemId,
        quantity: Number(line.quantity),
      })
    }
    fulfillmentOrders.push({ fulfillmentOrderId, locationId, lineItems })
  }
  const carrier = clean(signature.carrier, 'Carrier', 64)
  if (!Array.isArray(signature.trackingNumbers)) {
    return signatureInvalid('Shopify fulfillment tracking signature is invalid')
  }
  const trackingNumbers = normalizedTrackingNumbers(
    undefined,
    signature.trackingNumbers,
  )
  if (typeof signature.notifyCustomer !== 'boolean') {
    return signatureInvalid('Shopify fulfillment notification signature is invalid')
  }
  const authorityKind = sandboxE2eAuthorityKind(
    signature.sandboxE2eAuthorityKind,
  )
  const normalized = canonicalSignature({
    externalOrderId,
    fulfillmentOrders,
    carrier,
    trackingNumbers,
    notifyCustomer: signature.notifyCustomer,
    sandboxE2eAuthorityKind: authorityKind,
  })
  const suppliedLineItems = normalizeExpectedLineItems(signature.lineItems)
  if (JSON.stringify(normalized.lineItems) !== JSON.stringify(suppliedLineItems)) {
    return signatureInvalid('Shopify fulfillment aggregate line-item signature is invalid')
  }
  return normalized
}

function normalizeAttemptSignatureForInput(
  value: unknown,
  input: ProviderWriteInput,
) {
  const normalized = normalizeAttemptSignature(value)
  const omittedAuthorityKind = Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !Object.prototype.hasOwnProperty.call(
      value,
      'sandboxE2eAuthorityKind',
    ),
  )
  if (
    input.allowLegacySignatureWithoutAuthorityKind === true
    && input.sandboxE2eAuthorityKind === 'legacy_packed'
    && omittedAuthorityKind
    && normalized.sandboxE2eAuthorityKind === null
  ) {
    return {
      ...normalized,
      sandboxE2eAuthorityKind: 'legacy_packed' as const,
    }
  }
  return normalized
}

function signaturesEqual(
  left: ShopifyFulfillmentAttemptSignature,
  right: ShopifyFulfillmentAttemptSignature,
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function requireSignatureMatchesInput(
  signature: ShopifyFulfillmentAttemptSignature,
  input: ProviderWriteInput,
) {
  const requestShape = {
    externalOrderId: input.externalOrderId,
    carrier: input.carrier,
    trackingNumbers: sortedUnique(input.trackingNumbers),
    lineItems: input.expectedLineItems,
    notifyCustomer: input.notifyCustomer,
    sandboxE2eAuthorityKind: input.sandboxE2eAuthorityKind ?? null,
  }
  if (
    signature.externalOrderId !== requestShape.externalOrderId
    || signature.carrier !== requestShape.carrier
    || JSON.stringify(signature.trackingNumbers) !== JSON.stringify(requestShape.trackingNumbers)
    || JSON.stringify(signature.lineItems) !== JSON.stringify(requestShape.lineItems)
    || signature.notifyCustomer !== requestShape.notifyCustomer
    || signature.sandboxE2eAuthorityKind
      !== requestShape.sandboxE2eAuthorityKind
  ) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_SIGNATURE_INPUT_MISMATCH',
      'Shopify fulfillment attempt signature does not match the requested order, packaged lines, carrier, and tracking set',
    )
  }
}

function deriveOpenFulfillmentPlan(
  order: Record<string, unknown>,
  input: ProviderWriteInput,
): OpenFulfillmentPlan {
  if (typeof order.canNotifyCustomer !== 'boolean') {
    return providerShapeError('Shopify returned malformed order.canNotifyCustomer')
  }
  if (input.notifyCustomer && !order.canNotifyCustomer) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_CUSTOMER_NOTIFICATION_UNAVAILABLE',
      'Shopify reports that this order cannot receive a fulfillment notification',
    )
  }
  const fulfillmentOrders = pagedNodes(
    order.fulfillmentOrders,
    'order.fulfillmentOrders',
    'SHOPIFY_FULFILLMENT_PAGINATION_REQUIRED',
    'Shopify order exceeds the bounded fulfillment read; manual review is required',
  )
  const seenOrderIds = new Set<string>()
  const seenOrderLineItemIds = new Set<string>()
  const assignedLocations = new Set<string>()
  const selectedOrders: SignatureFulfillmentOrder[] = []

  for (const fulfillmentOrder of fulfillmentOrders) {
    const id = providerText(fulfillmentOrder.id, 'fulfillment order ID', 128)
    if (!SHOPIFY_FULFILLMENT_ORDER_GID.test(id) || seenOrderIds.has(id)) {
      return providerShapeError('Shopify returned malformed fulfillment-order IDs')
    }
    seenOrderIds.add(id)
    const status = providerText(fulfillmentOrder.status, 'fulfillment order status', 64)
    const lines = pagedNodes(
      fulfillmentOrder.lineItems,
      `fulfillment order ${id} lineItems`,
      'SHOPIFY_FULFILLMENT_LINE_PAGINATION_REQUIRED',
      'Shopify fulfillment order exceeds the bounded line read; manual review is required',
    )
    const eligible = !['CANCELLED', 'CLOSED'].includes(status)
    let remaining = 0
    const orderLines: SignatureFulfillmentOrder['lineItems'] = []
    for (const line of lines) {
      const fulfillmentOrderLineItemId = providerText(
        line.id,
        `fulfillment order ${id} line item ID`,
        128,
      )
      if (!SHOPIFY_FULFILLMENT_ORDER_LINE_ITEM_GID.test(fulfillmentOrderLineItemId)
          || seenOrderLineItemIds.has(fulfillmentOrderLineItemId)) {
        return providerShapeError('Shopify returned malformed fulfillment-order line-item IDs')
      }
      seenOrderLineItemIds.add(fulfillmentOrderLineItemId)
      const lineItem = providerRecord(line.lineItem, `fulfillment order ${id} lineItem`)
      const lineItemId = providerText(lineItem.id, 'Shopify line item ID', 128)
      if (!SHOPIFY_LINE_ITEM_GID.test(lineItemId)) {
        return providerShapeError('Shopify returned malformed line-item IDs')
      }
      const quantity = providerInteger(
        line.remainingQuantity,
        `fulfillment order ${id} remainingQuantity`,
        0,
      )
      if (quantity > 0) {
        remaining += quantity
        if (!Number.isSafeInteger(remaining)) {
          return providerShapeError('Shopify returned an unsupported remaining quantity')
        }
        orderLines.push({
          fulfillmentOrderLineItemId,
          lineItemId,
          quantity,
        })
      }
    }
    if (!eligible || remaining === 0) continue

    const assignedLocation = providerRecord(
      fulfillmentOrder.assignedLocation,
      `fulfillment order ${id} assignedLocation`,
    )
    const location = providerRecord(
      assignedLocation.location,
      `fulfillment order ${id} assignedLocation.location`,
    )
    const locationId = providerText(location.id, 'Shopify location ID', 128)
    if (!SHOPIFY_LOCATION_GID.test(locationId)) {
      return providerShapeError('Shopify returned malformed location IDs')
    }
    assignedLocations.add(locationId)
    selectedOrders.push({
      fulfillmentOrderId: id,
      locationId,
      lineItems: orderLines,
    })
  }

  if (selectedOrders.length === 0) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_NOT_OPEN',
      'Shopify has no open merchant-managed fulfillment order to fulfill',
    )
  }
  if (assignedLocations.size !== 1) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_MULTIPLE_LOCATIONS',
      'Shopify fulfillment orders span multiple locations; split fulfillment is required',
    )
  }
  const signature = canonicalSignature({
    externalOrderId: input.externalOrderId,
    fulfillmentOrders: selectedOrders,
    carrier: input.carrier,
    trackingNumbers: input.trackingNumbers,
    notifyCustomer: input.notifyCustomer,
    sandboxE2eAuthorityKind: input.sandboxE2eAuthorityKind,
  })
  return {
    signature,
    lineItemsByFulfillmentOrder: signature.fulfillmentOrders.map((fulfillmentOrder) => ({
      fulfillmentOrderId: fulfillmentOrder.fulfillmentOrderId,
      fulfillmentOrderLineItems: fulfillmentOrder.lineItems.map((line) => ({
        id: line.fulfillmentOrderLineItemId,
        quantity: line.quantity,
      })),
    })),
  }
}

function requirePlanMatchesExpectedLines(
  plan: OpenFulfillmentPlan,
  input: ProviderWriteInput,
) {
  if (JSON.stringify(plan.signature.lineItems) !== JSON.stringify(input.expectedLineItems)) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_EXPECTED_LINES_MISMATCH',
      'Shopify open fulfillment lines do not exactly match the packaged Shopify line items; refresh the order before fulfilling',
    )
  }
}

function observedFulfillmentMatchShape(
  fulfillment: Record<string, unknown>,
  externalOrderId: string,
): ObservedFulfillmentMatchShape | null {
  const fulfillmentOrders = pagedNodes(
    fulfillment.fulfillmentOrders,
    'fulfillment.fulfillmentOrders',
    'SHOPIFY_FULFILLMENT_RECONCILIATION_PAGINATION_REQUIRED',
    'Shopify fulfillment-order readback is paginated; manual review is required',
  )
  const observedOrders = fulfillmentOrders.map((fulfillmentOrder) => {
    const fulfillmentOrderId = providerText(
      fulfillmentOrder.id,
      'observed fulfillment order ID',
      128,
    )
    if (!SHOPIFY_FULFILLMENT_ORDER_GID.test(fulfillmentOrderId)) {
      return providerShapeError('Shopify returned malformed observed fulfillment-order IDs')
    }
    const assignedLocation = providerRecord(
      fulfillmentOrder.assignedLocation,
      `observed fulfillment order ${fulfillmentOrderId} assignedLocation`,
    )
    const location = providerRecord(
      assignedLocation.location,
      `observed fulfillment order ${fulfillmentOrderId} assignedLocation.location`,
    )
    const locationId = providerText(location.id, 'observed Shopify location ID', 128)
    if (!SHOPIFY_LOCATION_GID.test(locationId)) {
      return providerShapeError('Shopify returned malformed observed location IDs')
    }
    return { fulfillmentOrderId, locationId }
  }).sort((left, right) => left.fulfillmentOrderId.localeCompare(right.fulfillmentOrderId))
  if (new Set(observedOrders.map((item) => item.fulfillmentOrderId)).size
      !== observedOrders.length) {
    return providerShapeError('Shopify returned duplicate observed fulfillment-order IDs')
  }

  const lineAggregate = new Map<string, number>()
  for (const line of pagedNodes(
    fulfillment.fulfillmentLineItems,
    'fulfillment.fulfillmentLineItems',
    'SHOPIFY_FULFILLMENT_RECONCILIATION_PAGINATION_REQUIRED',
    'Shopify fulfillment line-item readback is paginated; manual review is required',
  )) {
    const lineItem = providerRecord(line.lineItem, 'observed fulfillment lineItem')
    const lineItemId = providerText(lineItem.id, 'observed Shopify line item ID', 128)
    if (!SHOPIFY_LINE_ITEM_GID.test(lineItemId)) {
      return providerShapeError('Shopify returned malformed observed line-item IDs')
    }
    addLineQuantity(
      lineAggregate,
      lineItemId,
      providerInteger(line.quantity, 'observed fulfillment line-item quantity', 1),
    )
  }

  const trackingInfo = providerRecords(
    fulfillment.trackingInfo,
    'fulfillment.trackingInfo',
  )
  if (trackingInfo.length > 10) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_RECONCILIATION_PAGINATION_REQUIRED',
      'Shopify tracking readback exceeds the bounded tracking set; manual review is required',
    )
  }
  const carriers = new Set<string>()
  const trackingNumbers: string[] = []
  for (const tracking of trackingInfo) {
    if (tracking.company == null || tracking.number == null) return null
    const company = providerText(tracking.company, 'tracking company', 64)
    const number = providerText(tracking.number, 'tracking number', 128)
    carriers.add(company)
    trackingNumbers.push(number)
  }
  if (
    observedOrders.length === 0
    || lineAggregate.size === 0
    || trackingNumbers.length === 0
    || carriers.size !== 1
  ) return null

  return {
    externalOrderId,
    fulfillmentOrders: observedOrders,
    lineItems: lineItemsFromAggregate(lineAggregate),
    carrier: [...carriers][0],
    trackingNumbers: sortedUnique(trackingNumbers),
  }
}

function observedMatchesSignature(
  observed: ObservedFulfillmentMatchShape,
  signature: ShopifyFulfillmentAttemptSignature,
) {
  const expectedOrders = signature.fulfillmentOrders.map((fulfillmentOrder) => ({
    fulfillmentOrderId: fulfillmentOrder.fulfillmentOrderId,
    locationId: fulfillmentOrder.locationId,
  }))
  return (
    observed.externalOrderId === signature.externalOrderId
    && JSON.stringify(observed.fulfillmentOrders) === JSON.stringify(expectedOrders)
    && JSON.stringify(observed.lineItems) === JSON.stringify(signature.lineItems)
    && observed.carrier === signature.carrier
    && JSON.stringify(observed.trackingNumbers) === JSON.stringify(signature.trackingNumbers)
  )
}

function findExactExistingFulfillment(
  fulfillments: ObservedFulfillment[],
  signature: ShopifyFulfillmentAttemptSignature,
  input: ProviderWriteInput,
): ShopifyFulfillmentWritebackResult | null {
  const matches = fulfillments.filter((fulfillment) => (
    fulfillment.status === 'SUCCESS'
    && fulfillment.matchShape !== null
    && observedMatchesSignature(fulfillment.matchShape, signature)
  ))
  if (matches.length > 1) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_RECONCILIATION_AMBIGUOUS',
      'Shopify returned multiple fulfillments for the same exact attempt signature; manual review is required',
    )
  }
  if (matches.length === 0) return null
  return {
    providerReference: matches[0].providerReference,
    trackingNumber: input.trackingNumbers[0],
    trackingNumbers: input.trackingNumbers,
    replayed: true,
  }
}

export async function writeShopifyFulfillment(
  credential: ShopifyCommerceRuntimeCredential,
  input: ProviderWriteInput,
  attemptSignature?: unknown,
): Promise<ShopifyFulfillmentWritebackResult> {
  const suppliedSignature = attemptSignature === undefined
    ? null
    : normalizeAttemptSignatureForInput(attemptSignature, input)
  if (suppliedSignature) requireSignatureMatchesInput(suppliedSignature, input)
  const inspection = await inspectShopifyFulfillment(credential, input)

  if (suppliedSignature) {
    const existing = findExactExistingFulfillment(
      inspection.fulfillments,
      suppliedSignature,
      input,
    )
    if (existing) return existing
  }

  const plan = deriveOpenFulfillmentPlan(inspection.order, input)
  if (suppliedSignature && !signaturesEqual(plan.signature, suppliedSignature)) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_PLAN_CHANGED',
      'Shopify fulfillment orders or remaining line quantities changed after the attempt was prepared; prepare a new attempt',
    )
  }
  requirePlanMatchesExpectedLines(plan, input)
  if (!suppliedSignature) {
    const existing = findExactExistingFulfillment(
      inspection.fulfillments,
      plan.signature,
      input,
    )
    if (existing) return existing
  }
  type FulfillmentCreateResponse = {
    fulfillmentCreate?: {
      fulfillment?: Record<string, unknown> | null
      userErrors?: Array<{ field?: unknown; message?: unknown }>
    }
  }
  let mutation: FulfillmentCreateResponse
  try {
    mutation = await shopifyAdminGraphql<FulfillmentCreateResponse>(credential, {
      query: FULFILLMENT_CREATE_MUTATION,
      operationName: 'ClawPilotFulfillmentCreate',
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: plan.lineItemsByFulfillmentOrder,
          notifyCustomer: input.notifyCustomer,
          trackingInfo: {
            ...(input.trackingNumbers.length === 1
              ? { number: input.trackingNumbers[0] }
              : { numbers: input.trackingNumbers }),
            company: input.carrier,
          },
        },
      },
    })
  } catch {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_OUTCOME_UNKNOWN',
      'Shopify fulfillment dispatch did not return a verifiable outcome; reconcile the prepared attempt before any further write',
      true,
      true,
    )
  }

  const payload = mutation.fulfillmentCreate
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !Array.isArray(payload.userErrors)) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_OUTCOME_UNKNOWN',
      'Shopify fulfillment dispatch returned an unverifiable response; reconcile the prepared attempt before any further write',
      true,
      true,
    )
  }
  const errors = payload.userErrors
  if (errors.some((error) => (
    !error
    || typeof error !== 'object'
    || Array.isArray(error)
    || typeof error.message !== 'string'
    || !error.message.trim()
  ))) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_OUTCOME_UNKNOWN',
      'Shopify fulfillment dispatch returned malformed user errors; reconcile the prepared attempt before any further write',
      true,
      true,
    )
  }
  if (errors.length > 0) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_REJECTED',
      errors.map((error) => String(error.message || 'Shopify rejected fulfillment')).join('; ').slice(0, 500),
    )
  }
  const providerReference = String(payload?.fulfillment?.id || '')
  const fulfillmentStatus = String(payload?.fulfillment?.status || '')
  if (!SHOPIFY_FULFILLMENT_GID.test(providerReference)
      || fulfillmentStatus !== 'SUCCESS') {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_OUTCOME_UNKNOWN',
      'Shopify fulfillment dispatch returned no valid fulfillment ID; reconcile the prepared attempt before any further write',
      true,
      true,
    )
  }
  return {
    providerReference,
    trackingNumber: input.trackingNumbers[0],
    trackingNumbers: input.trackingNumbers,
    replayed: false,
  }
}

async function inspectShopifyFulfillment(
  credential: ShopifyCommerceRuntimeCredential,
  input: ProviderWriteInput,
): Promise<ShopifyFulfillmentInspection> {
  const data = await shopifyAdminGraphql<{ order?: unknown }>(credential, {
    query: ORDER_FULFILLMENT_QUERY,
    operationName: 'ClawPilotOrderFulfillment',
    variables: { id: input.externalOrderId },
  })
  if (!data.order || typeof data.order !== 'object' || Array.isArray(data.order)) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_ORDER_NOT_FOUND',
      'Shopify order was not found',
    )
  }
  const order = data.order as Record<string, unknown>
  const observedOrderId = providerText(order.id, 'order ID', 128)
  if (observedOrderId !== input.externalOrderId) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_ORDER_MISMATCH',
      'Shopify returned a different order than the requested order',
      true,
    )
  }
  if (typeof order.canNotifyCustomer !== 'boolean') {
    return providerShapeError('Shopify returned malformed order.canNotifyCustomer')
  }
  const currentFulfillmentOrders = pagedNodes(
    order.fulfillmentOrders,
    'order.fulfillmentOrders',
    'SHOPIFY_FULFILLMENT_PAGINATION_REQUIRED',
    'Shopify order exceeds the bounded fulfillment read; manual review is required',
  )
  for (const fulfillmentOrder of currentFulfillmentOrders) {
    const id = providerText(fulfillmentOrder.id, 'fulfillment order ID', 128)
    if (!SHOPIFY_FULFILLMENT_ORDER_GID.test(id)) {
      return providerShapeError('Shopify returned malformed fulfillment-order IDs')
    }
    pagedNodes(
      fulfillmentOrder.lineItems,
      `fulfillment order ${id} lineItems`,
      'SHOPIFY_FULFILLMENT_LINE_PAGINATION_REQUIRED',
      'Shopify fulfillment order exceeds the bounded line read; manual review is required',
    )
  }

  const fulfillments = providerRecords(order.fulfillments, 'order.fulfillments')
  if (fulfillments.length >= 250) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_RECONCILIATION_PAGINATION_REQUIRED',
      'Shopify order reached the bounded fulfillment read; manual review is required',
    )
  }
  const observedFulfillments = fulfillments.map((fulfillment) => {
    const providerReference = providerText(fulfillment.id, 'fulfillment ID', 128)
    if (!SHOPIFY_FULFILLMENT_GID.test(providerReference)) {
      return providerShapeError('Shopify returned malformed fulfillment IDs')
    }
    const status = providerText(fulfillment.status, 'fulfillment status', 64)
    return {
      providerReference,
      status,
      matchShape: observedFulfillmentMatchShape(fulfillment, observedOrderId),
    }
  })
  return {
    order,
    fulfillments: observedFulfillments,
  }
}

export async function readShopifyFulfillment(
  credential: ShopifyCommerceRuntimeCredential,
  input: ProviderWriteInput,
  attemptSignature: unknown,
): Promise<ShopifyFulfillmentWritebackResult | null> {
  if (attemptSignature === undefined) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_SIGNATURE_REQUIRED',
      'Shopify fulfillment reconciliation requires the prepared attempt signature',
    )
  }
  const signature = normalizeAttemptSignatureForInput(attemptSignature, input)
  requireSignatureMatchesInput(signature, input)
  const inspection = await inspectShopifyFulfillment(credential, input)
  return findExactExistingFulfillment(
    inspection.fulfillments,
    signature,
    input,
  )
}
