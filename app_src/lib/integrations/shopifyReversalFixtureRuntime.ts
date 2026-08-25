import {
  shopifyOrderManagementAccountAllowed,
  shopifyOrderManagementRuntime,
} from '@/lib/integrations/shopifyOrderManagementRuntime'

export const SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID =
  'giah34fedoa5b1o' as const
export const SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID =
  'c6c8e6e7-fffa-4969-9526-e99da0ab2754' as const
export const SHOPIFY_REVERSAL_FIXTURE_SHOP_GID =
  'gid://shopify/Shop/95083757815' as const
export const SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN =
  'test-pro-bakery-bites.myshopify.com' as const
export const SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID =
  'gid://shopify/ProductVariant/51028106379511' as const
export const SHOPIFY_REVERSAL_FIXTURE_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270' as const
export const SHOPIFY_REVERSAL_FIXTURE_RAILWAY_SERVICE_ID =
  'f3fdf47c-6645-42ff-9a28-52843f8e4da2' as const
export const SHOPIFY_REVERSAL_FIXTURE_RAILWAY_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98' as const
export const SHOPIFY_REVERSAL_FIXTURE_DATABASE_IDENTITY =
  '750aa268-0e31-4065-a99c-4016e4d4fab1' as const
export const SHOPIFY_REVERSAL_FIXTURE_FLAG =
  'CLAWPILOT_SHOPIFY_REVERSAL_FIXTURE_ENABLED' as const

export type ShopifyReversalFixtureRuntimeBlocker =
  | 'SHOPIFY_REVERSAL_FIXTURE_DISABLED'
  | 'SHOPIFY_REVERSAL_FIXTURE_RAILWAY_DEVELOPMENT_REQUIRED'
  | 'SHOPIFY_REVERSAL_FIXTURE_ORDER_MANAGEMENT_RUNTIME_REQUIRED'
  | 'SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_NOT_ALLOWED'

export type ShopifyReversalFixtureRuntime = Readonly<{
  available: boolean
  blockerCode: ShopifyReversalFixtureRuntimeBlocker | null
  accountGlobalId: typeof SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID
  routeOnly: true
  normalUiAvailable: false
  productionAvailable: false
}>

/**
 * This fixture is intentionally narrower than the development order-write
 * runtime: it runs only in the one exact ClawPilot Railway development
 * environment. Local, preview, Vercel, production, and label workers are not
 * eligible even when they inherit a write flag.
 */
export function shopifyReversalFixtureRuntime(): ShopifyReversalFixtureRuntime {
  const unavailable = (
    blockerCode: ShopifyReversalFixtureRuntimeBlocker,
  ): ShopifyReversalFixtureRuntime => Object.freeze({
    available: false,
    blockerCode,
    accountGlobalId: SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
    routeOnly: true,
    normalUiAvailable: false,
    productionAvailable: false,
  })
  if (process.env[SHOPIFY_REVERSAL_FIXTURE_FLAG] !== '1') {
    return unavailable('SHOPIFY_REVERSAL_FIXTURE_DISABLED')
  }
  if (
    process.env.VERCEL
    || String(process.env.RAILWAY_PROJECT_ID || '').trim()
      !== SHOPIFY_REVERSAL_FIXTURE_RAILWAY_PROJECT_ID
    || String(process.env.RAILWAY_SERVICE_ID || '').trim()
      !== SHOPIFY_REVERSAL_FIXTURE_RAILWAY_SERVICE_ID
    || String(process.env.RAILWAY_ENVIRONMENT_ID || '').trim()
      !== SHOPIFY_REVERSAL_FIXTURE_RAILWAY_ENVIRONMENT_ID
    || String(process.env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase()
      !== 'development'
  ) {
    return unavailable(
      'SHOPIFY_REVERSAL_FIXTURE_RAILWAY_DEVELOPMENT_REQUIRED',
    )
  }
  const orderRuntime = shopifyOrderManagementRuntime()
  if (!orderRuntime.available) {
    return unavailable(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_MANAGEMENT_RUNTIME_REQUIRED',
    )
  }
  if (!shopifyOrderManagementAccountAllowed(
    SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
  )) {
    return unavailable('SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_NOT_ALLOWED')
  }
  return Object.freeze({
    available: true,
    blockerCode: null,
    accountGlobalId: SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
    routeOnly: true,
    normalUiAvailable: false,
    productionAvailable: false,
  })
}
