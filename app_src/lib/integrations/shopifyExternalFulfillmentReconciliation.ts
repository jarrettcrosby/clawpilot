import {
  decryptCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  hasEffectiveShopifyScope,
} from '@/lib/integrations/commerceCapabilities'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
  ShopifyCommerceClientError,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  normalizeShopifyExternalFulfillmentEvidence,
  ShopifyExternalFulfillmentEvidenceError,
  type ShopifyExternalFulfillmentEvidence,
  type ShopifyExternalFulfillmentTarget,
} from '@/lib/integrations/shopifyExternalFulfillmentEvidence'
import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'

const REQUIRED_SCOPES = [
  'read_orders',
  'read_merchant_managed_fulfillment_orders',
] as const
const MAX_ORDER_LINES = 250
const MAX_FULFILLMENT_ORDERS = 25
const MAX_FULFILLMENT_ORDER_LINES = 250
const MAX_FULFILLMENTS = 250
const MAX_FULFILLMENT_LINES = 250

const SHOPIFY_EXTERNAL_FULFILLMENT_QUERY = `query ClawPilotExternalFulfillmentReconciliation($id: ID!) {
  order(id: $id) {
    id
    name
    updatedAt
    cancelledAt
    closedAt
    displayFulfillmentStatus
    fulfillable
    lineItems(first: ${MAX_ORDER_LINES}) {
      nodes {
        id
        currentQuantity
        unfulfilledQuantity
        requiresShipping
      }
      pageInfo { hasNextPage }
    }
    fulfillmentOrders(first: ${MAX_FULFILLMENT_ORDERS}) {
      nodes {
        id
        status
        requestStatus
        updatedAt
        assignedLocation { location { id } }
        lineItems(first: ${MAX_FULFILLMENT_ORDER_LINES}) {
          nodes {
            lineItem { id }
            totalQuantity
            remainingQuantity
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage }
    }
    fulfillments(first: ${MAX_FULFILLMENTS}) {
      id
      name
      status
      displayStatus
      createdAt
      updatedAt
      trackingInfo(first: 11) { company number url }
      fulfillmentOrders(first: ${MAX_FULFILLMENT_ORDERS}) {
        nodes {
          id
          assignedLocation { location { id } }
        }
        pageInfo { hasNextPage }
      }
      fulfillmentLineItems(first: ${MAX_FULFILLMENT_LINES}) {
        nodes {
          quantity
          lineItem { id }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`

export class ShopifyExternalFulfillmentReconciliationError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean

  constructor(
    code: string,
    message: string,
    status = 409,
    retryable = false,
  ) {
    super(message)
    this.name = 'ShopifyExternalFulfillmentReconciliationError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

type Dependencies = {
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  requestAccessToken: typeof requestShopifyAccessToken
  probeConnection: typeof probeShopifyConnection
  readOrder: typeof shopifyAdminGraphql
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
  readOrder: shopifyAdminGraphql,
}

export async function inspectShopifyExternalFulfillment(input: {
  organizationId: string
  accountGlobalId: string
  target: ShopifyExternalFulfillmentTarget
}, dependencies: Dependencies = DEFAULT_DEPENDENCIES): Promise<
  ShopifyExternalFulfillmentEvidence & {
    providerReads: 2
    providerWrites: 0
  }
> {
  assertIntegrationCredentialProviderIoReady()
  const runtime = await dependencies.readRuntimeCredential({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
  })
  if (
    !runtime
    || runtime.provider !== 'shopify'
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
  ) {
    throw new ShopifyExternalFulfillmentReconciliationError(
      'SHOPIFY_EXTERNAL_FULFILLMENT_CONNECTION_INVALID',
      'A verified active Shopify connection is required for reconciliation',
    )
  }
  let credential
  try {
    credential = decryptCommerceCredential(
      runtime.encrypted,
      runtime.organizationId,
      runtime.provider,
      runtime.environment,
      runtime.externalAccountId,
    )
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    throw new ShopifyExternalFulfillmentReconciliationError(
      'SHOPIFY_EXTERNAL_FULFILLMENT_CREDENTIAL_INVALID',
      'Stored Shopify credentials could not be decrypted',
      500,
    )
  }
  if (credential.provider !== 'shopify') {
    throw new ShopifyExternalFulfillmentReconciliationError(
      'SHOPIFY_EXTERNAL_FULFILLMENT_CREDENTIAL_INVALID',
      'Stored Shopify credentials could not be decrypted',
      500,
    )
  }
  const shopDomain = normalizeShopifyShopDomain(
    runtime.configuration.shopDomain,
  )
  try {
    assertIntegrationCredentialProviderIoReady()
    const grant = await dependencies.requestAccessToken({
      shopDomain,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
    })
    assertIntegrationCredentialProviderIoReady()
    const probe = await dependencies.probeConnection({
      shopDomain,
      accessToken: grant.accessToken,
    })
    if (probe.shopId !== runtime.externalAccountId) {
      throw new ShopifyExternalFulfillmentReconciliationError(
        'SHOPIFY_EXTERNAL_FULFILLMENT_STORE_CHANGED',
        'Shopify returned a different store identity',
      )
    }
    const missingScopes = REQUIRED_SCOPES.filter((scope) => (
      !hasEffectiveShopifyScope(grant.grantedScopes, scope)
      || !hasEffectiveShopifyScope(probe.grantedScopes, scope)
    ))
    if (missingScopes.length > 0) {
      throw new ShopifyExternalFulfillmentReconciliationError(
        'SHOPIFY_EXTERNAL_FULFILLMENT_SCOPE_REQUIRED',
        `Shopify must grant ${missingScopes.join(' and ')} for fulfillment reconciliation`,
      )
    }
    assertIntegrationCredentialProviderIoReady()
    const data = await dependencies.readOrder<{ order?: unknown }>(
      { shopDomain, accessToken: grant.accessToken },
      {
        query: SHOPIFY_EXTERNAL_FULFILLMENT_QUERY,
        operationName: 'ClawPilotExternalFulfillmentReconciliation',
        variables: { id: input.target.externalOrderId },
      },
      { timeoutMs: 12_000 },
    )
    if (!data.order) {
      throw new ShopifyExternalFulfillmentReconciliationError(
        'SHOPIFY_EXTERNAL_FULFILLMENT_ORDER_NOT_FOUND',
        'The Shopify order is unavailable for reconciliation',
        404,
      )
    }
    return {
      ...normalizeShopifyExternalFulfillmentEvidence({
        target: input.target,
        providerOrder: data.order,
      }),
      providerReads: 2,
      providerWrites: 0,
    }
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    if (error instanceof ShopifyExternalFulfillmentReconciliationError) {
      throw error
    }
    if (error instanceof ShopifyExternalFulfillmentEvidenceError) {
      throw new ShopifyExternalFulfillmentReconciliationError(
        error.code,
        error.message,
        error.status,
      )
    }
    if (error instanceof ShopifyCommerceClientError) {
      throw new ShopifyExternalFulfillmentReconciliationError(
        'SHOPIFY_EXTERNAL_FULFILLMENT_PROVIDER_READ_FAILED',
        'Shopify fulfillment authority is temporarily unavailable',
        error.status >= 500 ? error.status : 502,
        error.retryable,
      )
    }
    throw error
  }
}
