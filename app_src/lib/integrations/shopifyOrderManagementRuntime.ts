const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u

export const SHOPIFY_ORDER_TEST_WRITE_FLAG =
  'CLAWPILOT_SHOPIFY_ORDER_TEST_WRITES_ENABLED' as const
export const SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_ALLOWLIST =
  'CLAWPILOT_SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_IDS' as const
export const SHOPIFY_ORDER_PRODUCTION_WRITE_FLAG =
  'CLAWPILOT_SHOPIFY_ORDER_PRODUCTION_WRITES_ENABLED' as const
export const SHOPIFY_ORDER_PRODUCTION_WRITE_ACCOUNT_ALLOWLIST =
  'CLAWPILOT_SHOPIFY_ORDER_PRODUCTION_WRITE_ACCOUNT_IDS' as const

const RAILWAY_PROJECT_ID = 'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
const RAILWAY_SERVICE_ID = 'f3fdf47c-6645-42ff-9a28-52843f8e4da2'
const RAILWAY_PRODUCTION_ENVIRONMENT_ID =
  '058ce52f-1d3b-44bb-afe2-0df2bf24efb9'

export type ShopifyOrderManagementRuntimeBlocker =
  | 'SHOPIFY_ORDER_TEST_WRITES_DISABLED'
  | 'SHOPIFY_ORDER_TEST_WRITES_DEVELOPMENT_ONLY'
  | 'SHOPIFY_ORDER_TEST_WRITES_RAILWAY_OR_LOCAL_ONLY'
  | 'SHOPIFY_ORDER_TEST_WRITE_ALLOWLIST_REQUIRED'
  | 'SHOPIFY_ORDER_PRODUCTION_WRITES_DISABLED'
  | 'SHOPIFY_ORDER_PRODUCTION_WRITE_ALLOWLIST_REQUIRED'
  | 'SHOPIFY_ORDER_PRODUCTION_RAILWAY_IDENTITY_MISMATCH'

export type ShopifyOrderManagementRuntime = Readonly<{
  available: boolean
  mode: 'development' | 'production' | null
  blockerCode: ShopifyOrderManagementRuntimeBlocker | null
  allowedAccountGlobalIds: readonly string[]
  providerWritesEnabled: boolean
  productionAvailable: boolean
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

function allowedAccounts(variable: string) {
  const raw = String(
    process.env[variable] || '',
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
 * Exact-order Shopify writes are never enabled by Shopify scopes, account
 * classification, or NODE_ENV alone. Development uses the existing explicit
 * test-write flag and account allowlist. Production defaults off and can run
 * only on the exact ClawPilot Railway production identity with its own
 * production-specific flag and account allowlist. Vercel is always read-only.
 */
export function shopifyOrderManagementRuntime(): ShopifyOrderManagementRuntime {
  const markers = deploymentMarkers()
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
  const production = markers.includes('production')
  if (production) {
    const exactRailwayProduction = (
      normalized(process.env.RAILWAY_ENVIRONMENT_NAME) === 'production'
      && normalized(process.env.RAILWAY_PROJECT_ID) === RAILWAY_PROJECT_ID
      && normalized(process.env.RAILWAY_SERVICE_ID) === RAILWAY_SERVICE_ID
      && normalized(process.env.RAILWAY_ENVIRONMENT_ID)
        === RAILWAY_PRODUCTION_ENVIRONMENT_ID
      && !markers.some((marker) => [
        'dev', 'development', 'local', 'preview', 'sandbox', 'staging',
        'test', 'testing',
      ].includes(marker))
    )
    if (!exactRailwayProduction) {
      return Object.freeze({
        available: false,
        mode: 'production',
        blockerCode: 'SHOPIFY_ORDER_PRODUCTION_RAILWAY_IDENTITY_MISMATCH',
        allowedAccountGlobalIds: Object.freeze([]),
        providerWritesEnabled: false,
        productionAvailable: false,
      })
    }
    if (process.env[SHOPIFY_ORDER_PRODUCTION_WRITE_FLAG] !== '1') {
      return Object.freeze({
        available: false,
        mode: 'production',
        blockerCode: 'SHOPIFY_ORDER_PRODUCTION_WRITES_DISABLED',
        allowedAccountGlobalIds: Object.freeze([]),
        providerWritesEnabled: false,
        productionAvailable: false,
      })
    }
    const accounts = allowedAccounts(
      SHOPIFY_ORDER_PRODUCTION_WRITE_ACCOUNT_ALLOWLIST,
    )
    if (!accounts.length) {
      return Object.freeze({
        available: false,
        mode: 'production',
        blockerCode: 'SHOPIFY_ORDER_PRODUCTION_WRITE_ALLOWLIST_REQUIRED',
        allowedAccountGlobalIds: Object.freeze([]),
        providerWritesEnabled: false,
        productionAvailable: false,
      })
    }
    return Object.freeze({
      available: true,
      mode: 'production',
      blockerCode: null,
      allowedAccountGlobalIds: Object.freeze(accounts),
      providerWritesEnabled: true,
      productionAvailable: true,
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
  const accounts = allowedAccounts(SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_ALLOWLIST)
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

export function shopifyOrderManagementAccountAllowed(
  accountGlobalId: unknown,
  accountEnvironment?: unknown,
) {
  const account = String(accountGlobalId || '').trim().toLowerCase()
  const runtime = shopifyOrderManagementRuntime()
  const expectedEnvironment = runtime.mode === 'production'
    ? 'production' : runtime.mode === 'development' ? 'sandbox' : null
  const suppliedEnvironment = accountEnvironment === undefined
    ? expectedEnvironment : normalized(accountEnvironment)
  return runtime.available
    && ACCOUNT_GLOBAL_ID.test(account)
    && suppliedEnvironment === expectedEnvironment
    && runtime.allowedAccountGlobalIds.includes(account)
}
