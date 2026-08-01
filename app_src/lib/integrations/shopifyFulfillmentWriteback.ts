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
  requireCommerceActiveCapabilityClaimInPostgres,
} from '@/lib/persistence/commerceActiveTransitionAuthorization'

const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_GID = /^gid:\/\/shopify\/Fulfillment\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_ORDER_GID =
  /^gid:\/\/shopify\/FulfillmentOrder\/[1-9][0-9]*$/
const REQUIRED_SCOPE = 'write_merchant_managed_fulfillment_orders'

export type ShopifyFulfillmentWritebackInput = {
  organizationId: unknown
  accountGlobalId: unknown
  externalOrderId: unknown
  trackingNumber?: unknown
  trackingNumbers?: unknown
  carrier: unknown
  notifyCustomer?: boolean
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
  ) {
    super(message)
    this.name = 'ShopifyFulfillmentWritebackError'
  }
}

type ShopifyFulfillmentWritebackDependencies = {
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  requireCapability: typeof requireCommerceActiveCapabilityClaimInPostgres
  decryptCredential: typeof decryptCommerceCredential
  requestAccessToken: typeof requestShopifyAccessToken
  probeConnection: typeof probeShopifyConnection
  writeFulfillment: typeof writeShopifyFulfillment
}

const DEFAULT_DEPENDENCIES: ShopifyFulfillmentWritebackDependencies = {
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  requireCapability: requireCommerceActiveCapabilityClaimInPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
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

export async function executeShopifyFulfillmentWriteback(
  input: ShopifyFulfillmentWritebackInput,
  dependencies: ShopifyFulfillmentWritebackDependencies = DEFAULT_DEPENDENCIES,
): Promise<ShopifyFulfillmentWritebackResult> {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  const externalOrderId = orderGid(input.externalOrderId)
  const trackingNumbers = normalizedTrackingNumbers(
    input.trackingNumber,
    input.trackingNumbers,
  )
  const carrier = clean(input.carrier, 'Carrier', 64)

  const [fulfillmentClaim, trackingClaim, runtime] = await Promise.all([
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
  if (!runtime || runtime.provider !== 'shopify' || runtime.status !== 'active'
      || runtime.verificationStatus !== 'verified') {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_CONNECTION_INVALID',
      'A verified active Shopify connection is required',
    )
  }
  if (
    fulfillmentClaim.activationRevision !== trackingClaim.activationRevision
    || fulfillmentClaim.credentialGeneration !== runtime.credentialVersion
    || trackingClaim.credentialGeneration !== runtime.credentialVersion
  ) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_AUTHORIZATION_STALE',
      'Shopify fulfillment authorization is stale; review Active capabilities again',
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
    !hasEffectiveShopifyScope(grant.grantedScopes, REQUIRED_SCOPE)
    || !hasEffectiveShopifyScope(probe.grantedScopes, REQUIRED_SCOPE)
  ) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_SCOPE_REQUIRED',
      `Shopify must grant ${REQUIRED_SCOPE}`,
    )
  }
  return dependencies.writeFulfillment(
    { shopDomain, accessToken: grant.accessToken },
    {
      externalOrderId,
      trackingNumbers,
      carrier,
      notifyCustomer: Boolean(input.notifyCustomer),
    },
  )
}

const ORDER_FULFILLMENT_QUERY = `query ClawPilotOrderFulfillment($id: ID!) {
  order(id: $id) {
    id
    fulfillments(first: 250) { id status trackingInfo(first: 10) { number } }
    fulfillmentOrders(first: 100) {
      nodes { id status requestStatus assignedLocation { location { id } } lineItems(first: 250) { nodes { id remainingQuantity } pageInfo { hasNextPage } } }
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
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => (
        Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      ))
    : []
}

function nodes(connection: unknown) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return []
  return records((connection as Record<string, unknown>).nodes)
}

function hasNextPage(connection: unknown) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return false
  const pageInfo = (connection as Record<string, unknown>).pageInfo
  return Boolean(pageInfo && typeof pageInfo === 'object'
    && !Array.isArray(pageInfo)
    && (pageInfo as Record<string, unknown>).hasNextPage)
}

export async function writeShopifyFulfillment(
  credential: ShopifyCommerceRuntimeCredential,
  input: ProviderWriteInput,
): Promise<ShopifyFulfillmentWritebackResult> {
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
  if (hasNextPage(order.fulfillmentOrders)) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_PAGINATION_REQUIRED',
      'Shopify order exceeds the bounded fulfillment read; manual review is required',
    )
  }
  for (const fulfillment of records(order.fulfillments)) {
    const observed = new Set(records(fulfillment.trackingInfo)
      .map((tracking) => String(tracking.number || '').trim())
      .filter(Boolean))
    const match = input.trackingNumbers.every(
      (trackingNumber) => observed.has(trackingNumber),
    )
    if (match && typeof fulfillment.id === 'string'
        && SHOPIFY_FULFILLMENT_GID.test(fulfillment.id)) {
      return {
        providerReference: fulfillment.id,
        trackingNumber: input.trackingNumbers[0],
        trackingNumbers: input.trackingNumbers,
        replayed: true,
      }
    }
  }
  const lineItemsByFulfillmentOrder: Array<Record<string, unknown>> = []
  const assignedLocations = new Set<string>()
  for (const fulfillmentOrder of nodes(order.fulfillmentOrders)) {
    if (hasNextPage(fulfillmentOrder.lineItems)) {
      throw new ShopifyFulfillmentWritebackError(
        'SHOPIFY_FULFILLMENT_LINE_PAGINATION_REQUIRED',
        'Shopify fulfillment order exceeds the bounded line read; manual review is required',
      )
    }
    const remaining = nodes(fulfillmentOrder.lineItems).reduce(
      (total, line) => total + Number(line.remainingQuantity || 0),
      0,
    )
    if (
      remaining > 0
      && typeof fulfillmentOrder.id === 'string'
      && SHOPIFY_FULFILLMENT_ORDER_GID.test(fulfillmentOrder.id)
      && !['CANCELLED', 'CLOSED'].includes(String(fulfillmentOrder.status || ''))
    ) {
      const assignedLocation = fulfillmentOrder.assignedLocation
      const location = assignedLocation && typeof assignedLocation === 'object'
        && !Array.isArray(assignedLocation)
        ? (assignedLocation as Record<string, unknown>).location
        : null
      const locationId = location && typeof location === 'object' && !Array.isArray(location)
        ? String((location as Record<string, unknown>).id || '')
        : ''
      if (!locationId) {
        throw new ShopifyFulfillmentWritebackError(
          'SHOPIFY_FULFILLMENT_LOCATION_REQUIRED',
          'Shopify fulfillment order has no assigned location',
        )
      }
      assignedLocations.add(locationId)
      lineItemsByFulfillmentOrder.push({
        fulfillmentOrderId: fulfillmentOrder.id,
      })
    }
  }
  if (lineItemsByFulfillmentOrder.length === 0) {
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
  const mutation = await shopifyAdminGraphql<{
    fulfillmentCreate?: {
      fulfillment?: Record<string, unknown> | null
      userErrors?: Array<{ field?: unknown; message?: unknown }>
    }
  }>(credential, {
    query: FULFILLMENT_CREATE_MUTATION,
    operationName: 'ClawPilotFulfillmentCreate',
    variables: {
      fulfillment: {
        lineItemsByFulfillmentOrder,
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
  const payload = mutation.fulfillmentCreate
  const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : []
  if (errors.length > 0) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_REJECTED',
      errors.map((error) => String(error.message || 'Shopify rejected fulfillment')).join('; ').slice(0, 500),
    )
  }
  const providerReference = String(payload?.fulfillment?.id || '')
  if (!SHOPIFY_FULFILLMENT_GID.test(providerReference)) {
    throw new ShopifyFulfillmentWritebackError(
      'SHOPIFY_FULFILLMENT_RESPONSE_INVALID',
      'Shopify returned an invalid fulfillment response',
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
