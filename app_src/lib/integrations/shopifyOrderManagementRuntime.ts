const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u

export const SHOPIFY_ORDER_TEST_WRITE_FLAG =
  'CLAWPILOT_SHOPIFY_ORDER_TEST_WRITES_ENABLED' as const
export const SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_ALLOWLIST =
  'CLAWPILOT_SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_IDS' as const

export type ShopifyOrderManagementRuntimeBlocker =
  | 'SHOPIFY_ORDER_TEST_WRITES_DISABLED'
  | 'SHOPIFY_ORDER_TEST_WRITES_DEVELOPMENT_ONLY'
  | 'SHOPIFY_ORDER_TEST_WRITES_RAILWAY_OR_LOCAL_ONLY'
  | 'SHOPIFY_ORDER_TEST_WRITE_ALLOWLIST_REQUIRED'

export type ShopifyOrderManagementRuntime = Readonly<{
  available: boolean
  mode: 'development' | null
  blockerCode: ShopifyOrderManagementRuntimeBlocker | null
  allowedAccountGlobalIds: readonly string[]
  providerWritesEnabled: boolean
  productionAvailable: false
}>

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function deploymentMarkers() {
  return [
    process.env.CLAWPILOT_ENV,
    process.env.RAILWAY_ENVIRONMENT_NAME,
    process.env.RAILWAY_ENVIRONMENT,
    process.env.VERCEL_ENV,
  ].map(normalized).filter(Boolean)
}

function allowedAccounts() {
  const raw = String(
    process.env[SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_ALLOWLIST] || '',
  )
  const values = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (
    values.length < 1
    || values.length > 32
    || values.some((value) => !ACCOUNT_GLOBAL_ID.test(value))
  ) return []
  return [...new Set(values)].sort()
}

/**
 * Exact-order Shopify writes are initially a development proving lane. They
 * are never enabled by Shopify scopes, account classification, or NODE_ENV
 * alone. A production marker always wins, Vercel is read-only, and Railway
 * development/local execution requires both an explicit flag and exact
 * integration-account allowlist.
 */
export function shopifyOrderManagementRuntime(): ShopifyOrderManagementRuntime {
  const markers = deploymentMarkers()
  const production = markers.includes('production')
  if (production) {
    return Object.freeze({
      available: false,
      mode: null,
      blockerCode: 'SHOPIFY_ORDER_TEST_WRITES_DEVELOPMENT_ONLY',
      allowedAccountGlobalIds: Object.freeze([]),
      providerWritesEnabled: false,
      productionAvailable: false,
    })
  }
  if (process.env.VERCEL) {
    return Object.freeze({
      available: false,
      mode: null,
      blockerCode: 'SHOPIFY_ORDER_TEST_WRITES_RAILWAY_OR_LOCAL_ONLY',
      allowedAccountGlobalIds: Object.freeze([]),
      providerWritesEnabled: false,
      productionAvailable: false,
    })
  }
  const development = markers.some((value) => (
    value === 'dev' || value === 'development' || value === 'local'
  )) || (!markers.length && normalized(process.env.NODE_ENV) === 'development')
  if (!development) {
    return Object.freeze({
      available: false,
      mode: null,
      blockerCode: 'SHOPIFY_ORDER_TEST_WRITES_DEVELOPMENT_ONLY',
      allowedAccountGlobalIds: Object.freeze([]),
      providerWritesEnabled: false,
      productionAvailable: false,
    })
  }
  if (process.env[SHOPIFY_ORDER_TEST_WRITE_FLAG] !== '1') {
    return Object.freeze({
      available: false,
      mode: 'development',
      blockerCode: 'SHOPIFY_ORDER_TEST_WRITES_DISABLED',
      allowedAccountGlobalIds: Object.freeze([]),
      providerWritesEnabled: false,
      productionAvailable: false,
    })
  }
  const accounts = allowedAccounts()
  if (!accounts.length) {
    return Object.freeze({
      available: false,
      mode: 'development',
      blockerCode: 'SHOPIFY_ORDER_TEST_WRITE_ALLOWLIST_REQUIRED',
      allowedAccountGlobalIds: Object.freeze([]),
      providerWritesEnabled: false,
      productionAvailable: false,
    })
  }
  return Object.freeze({
    available: true,
    mode: 'development',
    blockerCode: null,
    allowedAccountGlobalIds: Object.freeze(accounts),
    providerWritesEnabled: true,
    productionAvailable: false,
  })
}

export function shopifyOrderManagementAccountAllowed(accountGlobalId: unknown) {
  const account = String(accountGlobalId || '').trim().toLowerCase()
  const runtime = shopifyOrderManagementRuntime()
  return runtime.available
    && ACCOUNT_GLOBAL_ID.test(account)
    && runtime.allowedAccountGlobalIds.includes(account)
}
