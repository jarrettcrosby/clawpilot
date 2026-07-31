export type ShopifyCustomerRateZone = {
  countryCode: string
  provinceCode: string | null
  postalCode: string
}

export type ShopifyCustomerRateZoneResult = {
  zones: ShopifyCustomerRateZone[]
  counts: {
    scanned: number
    eligible: number
    duplicate: number
    skipped: number
  }
}

export type ShopifyRateWarmTenant = {
  organizationId: string
  accountGlobalId: string
  shopDomain: string
  activationState: 'shadow' | 'active'
  policyRevision: number
  policySnapshot: Record<string, unknown>
  clientId: string
  clientSecret: string
}

export type ShopifyRateWarmResponse = {
  version: 1
  enabled: boolean
  mode: 'hosted_ajax'
  policyRevision: number
  cartFingerprint: string
  concurrency: number
  debounceMs: number
  minIntervalMs: number
  staleCartAbort: true
  zones: ShopifyCustomerRateZone[]
  coverage: {
    scanned: number
    eligible: number
    duplicate: number
    invalid: number
    unsupported: number
  }
}

export type ShopifyRateWarmDependencies = {
  readShopHint: (parameters: URLSearchParams) => string
  verifyProxy: (input: {
    parameters: URLSearchParams
    clientSecret: string
    expectedShopDomain: string
    nowSeconds?: number
  }) => {
    customerId: string
    cartFingerprint: string
  }
  resolveTenant: (
    shopDomain: string,
  ) => Promise<ShopifyRateWarmTenant | null>
  requestAccessToken: (
    tenant: ShopifyRateWarmTenant,
  ) => Promise<{
    accessToken: string
    grantedScopes: string[]
  }>
  readCustomerRateZones: (input: {
    customerId: string
    shopDomain: string
    accessToken: string
    grantedScopes: string[]
  }) => Promise<ShopifyCustomerRateZoneResult>
  readPolicy: (
    policySnapshot: Record<string, unknown>,
  ) => ShopifyRateWarmPolicy
}

export type ShopifyRateWarmPolicy = {
  version: 'shopify-checkout-rate-warm-v1'
  enabled: boolean
  mode: 'hosted_ajax'
  zoneScope: 'all_saved_rate_zones'
  concurrency: number
  debounceMs: number
  minIntervalMs: number
  supportedCountries: ['US']
  staleCartAbort: true
}

export class ShopifyRateWarmError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 404) {
    super(message)
    this.name = 'ShopifyRateWarmError'
    this.code = code
    this.status = status
  }
}

function fail(code: string, message: string, status = 404): never {
  throw new ShopifyRateWarmError(code, message, status)
}

function disabledPolicy(): ShopifyRateWarmPolicy {
  return {
    version: 'shopify-checkout-rate-warm-v1',
    enabled: false,
    mode: 'hosted_ajax',
    zoneScope: 'all_saved_rate_zones',
    concurrency: 2,
    debounceMs: 350,
    minIntervalMs: 1_000,
    supportedCountries: ['US'],
    staleCartAbort: true,
  }
}

function tenantPolicy(
  tenant: ShopifyRateWarmTenant,
  dependencies: ShopifyRateWarmDependencies,
) {
  try {
    return dependencies.readPolicy(tenant.policySnapshot)
  } catch {
    return disabledPolicy()
  }
}

function response(input: {
  enabled: boolean
  tenant: ShopifyRateWarmTenant
  policy: ShopifyRateWarmPolicy
  cartFingerprint: string
  zones?: ShopifyCustomerRateZone[]
  coverage?: ShopifyRateWarmResponse['coverage']
}): ShopifyRateWarmResponse {
  return {
    version: 1,
    enabled: input.enabled,
    mode: 'hosted_ajax',
    policyRevision: Number.isSafeInteger(input.tenant.policyRevision)
      && input.tenant.policyRevision >= 0
      ? input.tenant.policyRevision
      : 0,
    cartFingerprint: input.cartFingerprint,
    concurrency: input.policy.concurrency,
    debounceMs: input.policy.debounceMs,
    minIntervalMs: input.policy.minIntervalMs,
    staleCartAbort: true,
    zones: input.zones || [],
    coverage: input.coverage || {
      scanned: 0,
      eligible: 0,
      duplicate: 0,
      invalid: 0,
      unsupported: 0,
    },
  }
}

export async function loadShopifyRateWarmResponse(input: {
  parameters: URLSearchParams
  dependencies: ShopifyRateWarmDependencies
  nowSeconds?: number
}): Promise<ShopifyRateWarmResponse> {
  const shopHint = input.dependencies.readShopHint(input.parameters)
  const tenant = await input.dependencies.resolveTenant(shopHint)
  if (!tenant) {
    fail(
      'SHOPIFY_RATE_WARM_TENANT_NOT_FOUND',
      'Shopify rate-warming tenant was not found',
    )
  }
  const identity = input.dependencies.verifyProxy({
    parameters: input.parameters,
    clientSecret: tenant.clientSecret,
    expectedShopDomain: tenant.shopDomain,
    nowSeconds: input.nowSeconds,
  })
  if (
    tenant.shopDomain !== shopHint
    || tenant.organizationId.length < 1
    || tenant.accountGlobalId.length < 1
  ) {
    fail(
      'SHOPIFY_RATE_WARM_TENANT_MISMATCH',
      'Shopify rate-warming tenant did not match the signed store',
    )
  }

  const policy = tenantPolicy(tenant, input.dependencies)
  const enabled = (
    tenant.activationState === 'active'
    && policy.enabled
    && policy.mode === 'hosted_ajax'
  )
  if (!enabled) {
    return response({
      enabled: false,
      tenant,
      policy,
      cartFingerprint: identity.cartFingerprint,
    })
  }

  const grant = await input.dependencies.requestAccessToken(tenant)
  const result = await input.dependencies.readCustomerRateZones({
    customerId: identity.customerId,
    shopDomain: tenant.shopDomain,
    accessToken: grant.accessToken,
    grantedScopes: grant.grantedScopes,
  })
  const supportedCountries: ReadonlySet<string> = new Set(
    policy.supportedCountries,
  )
  const unsupported = result.zones.filter((zone) => (
    !supportedCountries.has(zone.countryCode)
  )).length
  const zones = result.zones.filter((zone) => (
    supportedCountries.has(zone.countryCode)
  ))
  return response({
    enabled: true,
    tenant,
    policy,
    cartFingerprint: identity.cartFingerprint,
    zones,
    coverage: {
      scanned: result.counts.scanned,
      eligible: result.counts.eligible,
      duplicate: result.counts.duplicate,
      invalid: result.counts.skipped,
      unsupported,
    },
  })
}
