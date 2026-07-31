import {
  decryptCommerceCredential,
  type ShopifyCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  normalizeShopifyShopDomain,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  readShopifyCustomerRateZones,
} from '@/lib/integrations/shopifyCustomerRateZones'
import {
  readShopifyAppProxyShopHint,
  verifyShopifyAppProxyRequest,
} from '@/lib/integrations/shopifyAppProxy'
import {
  readShopifyCheckoutRateWarmPolicy,
} from '@/lib/operations/shopifyCheckoutRateWarmPolicy'
import {
  loadShopifyRateWarmResponse,
  type ShopifyRateWarmDependencies,
  type ShopifyRateWarmResponse,
  type ShopifyRateWarmTenant,
} from '@/lib/integrations/shopifyRateWarm'
import {
  readShopifyRateWarmRuntimeByShopFromPostgres,
} from '@/lib/persistence/shopifyRateWarm'

function decryptedShopifyCredential(
  record: Awaited<
    ReturnType<typeof readShopifyRateWarmRuntimeByShopFromPostgres>
  >,
): ShopifyCommerceCredential {
  if (!record) {
    throw new Error('Shopify rate-warming tenant was not found')
  }
  const credential = decryptCommerceCredential(
    record.runtime.encrypted,
    record.runtime.organizationId,
    record.runtime.provider,
    record.runtime.environment,
    record.runtime.externalAccountId,
  )
  if (
    credential.provider !== 'shopify'
    || credential.authMode !== 'shopify_client_credentials'
  ) {
    throw new Error('Shopify rate-warming credential was invalid')
  }
  return credential
}

const DEFAULT_DEPENDENCIES: ShopifyRateWarmDependencies = {
  readShopHint: readShopifyAppProxyShopHint,
  verifyProxy: verifyShopifyAppProxyRequest,
  readPolicy: readShopifyCheckoutRateWarmPolicy,
  async resolveTenant(shopDomain) {
    const record = await readShopifyRateWarmRuntimeByShopFromPostgres(
      shopDomain,
    )
    if (!record) return null
    const credential = decryptedShopifyCredential(record)
    const configuredShopDomain = normalizeShopifyShopDomain(
      record.runtime.configuration.shopDomain,
    )
    if (configuredShopDomain !== record.shopDomain) return null
    return {
      organizationId: record.runtime.organizationId,
      accountGlobalId: record.runtime.globalId,
      shopDomain: configuredShopDomain,
      activationState: record.activationState,
      policyRevision: record.policyRevision,
      policySnapshot: record.policySnapshot,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
    }
  },
  async requestAccessToken(tenant: ShopifyRateWarmTenant) {
    const grant = await requestShopifyAccessToken({
      shopDomain: tenant.shopDomain,
      clientId: tenant.clientId,
      clientSecret: tenant.clientSecret,
    }, { timeoutMs: 10_000 })
    return {
      accessToken: grant.accessToken,
      grantedScopes: grant.grantedScopes,
    }
  },
  async readCustomerRateZones(input) {
    return readShopifyCustomerRateZones({
      customerId: input.customerId,
      credential: {
        shopDomain: input.shopDomain,
        accessToken: input.accessToken,
      },
      grantedScopes: input.grantedScopes,
      graphql: shopifyAdminGraphql,
    })
  },
}

export async function executeShopifyRateWarmRequest(input: {
  parameters: URLSearchParams
  nowSeconds?: number
  dependencies?: ShopifyRateWarmDependencies
}): Promise<ShopifyRateWarmResponse> {
  return loadShopifyRateWarmResponse({
    parameters: input.parameters,
    nowSeconds: input.nowSeconds,
    dependencies: input.dependencies || DEFAULT_DEPENDENCIES,
  })
}
