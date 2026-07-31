import {
  normalizeShopifyShopDomain,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  readCommerceRuntimeCredentialFromPostgres,
  type CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'
import { query } from '@/lib/persistence/postgres'

type ShopifyRateWarmTenantRow = {
  organization_id: string
  account_global_id: string
  shop_domain: string
  activation_state: 'shadow' | 'active'
  policy_revision: string | number | null
  policy_snapshot: Record<string, unknown> | null
}

export type ShopifyRateWarmRuntimeRecord = {
  runtime: CommerceRuntimeCredentialRecord
  shopDomain: string
  activationState: 'shadow' | 'active'
  policyRevision: number
  policySnapshot: Record<string, unknown>
}

export class ShopifyRateWarmPersistenceError extends Error {
  readonly code = 'SHOPIFY_RATE_WARM_TENANT_AMBIGUOUS'

  constructor() {
    super('Shopify rate-warming tenant resolution was ambiguous')
    this.name = 'ShopifyRateWarmPersistenceError'
  }
}

export async function readShopifyRateWarmRuntimeByShopFromPostgres(
  rawShopDomain: string,
): Promise<ShopifyRateWarmRuntimeRecord | null> {
  const shopDomain = normalizeShopifyShopDomain(rawShopDomain)
  const candidates = await query<ShopifyRateWarmTenantRow>(
    `SELECT
       account.organization_id::text,
       account.global_id AS account_global_id,
       lower(account.configuration ->> 'shopDomain') AS shop_domain,
       activation.state AS activation_state,
       config.policy_revision::text,
       config.policy_snapshot
     FROM operations_integration_accounts account
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
      AND credential.credential_version =
        account.commerce_credential_generation
      AND credential.verification_status = 'verified'
     JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     LEFT JOIN operations_shopify_carrier_service_configs config
       ON config.organization_id = account.organization_id
      AND config.integration_account_id = account.id
     WHERE account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND account.status = 'active'
       AND lower(account.configuration ->> 'shopDomain') = $1
     ORDER BY account.global_id
     LIMIT 2`,
    [shopDomain],
  )
  if (candidates.rows.length > 1) {
    throw new ShopifyRateWarmPersistenceError()
  }
  const candidate = candidates.rows[0]
  if (!candidate) return null
  if (
    normalizeShopifyShopDomain(candidate.shop_domain) !== shopDomain
    || (
      candidate.activation_state !== 'shadow'
      && candidate.activation_state !== 'active'
    )
  ) {
    return null
  }
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId: candidate.organization_id,
    accountGlobalId: candidate.account_global_id,
  })
  if (
    !runtime
    || runtime.provider !== 'shopify'
    || runtime.organizationId !== candidate.organization_id
    || runtime.globalId !== candidate.account_global_id
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
  ) {
    return null
  }
  const policyRevision = Number(candidate.policy_revision || 0)
  return {
    runtime,
    shopDomain,
    activationState: candidate.activation_state,
    policyRevision: Number.isSafeInteger(policyRevision)
      && policyRevision >= 0
      ? policyRevision
      : 0,
    policySnapshot: candidate.policy_snapshot || {},
  }
}
