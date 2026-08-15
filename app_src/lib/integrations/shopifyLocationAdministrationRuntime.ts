const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u

export const SHOPIFY_LOCATION_ADMINISTRATION_ENABLED =
  'CLAWPILOT_SHOPIFY_LOCATION_ADMINISTRATION_ENABLED' as const
export const SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_ALLOWLIST =
  'CLAWPILOT_SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_IDS' as const

// Exact ClawPilot Railway deployment identity. These are not operator-supplied
// comparison values: a production or foreign service cannot make itself
// trusted by setting both sides of the comparison.
export const SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270' as const
export const SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_SERVICE_ID =
  'f3fdf47c-6645-42ff-9a28-52843f8e4da2' as const
export const SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98' as const

export type ShopifyLocationAdministrationRuntimeBlocker =
  | 'SHOPIFY_LOCATION_ADMINISTRATION_DISABLED'
  | 'SHOPIFY_LOCATION_ADMINISTRATION_DEVELOPMENT_ONLY'
  | 'SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_ONLY'
  | 'SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_IDENTITY_MISMATCH'
  | 'SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_ALLOWLIST_REQUIRED'

export type ShopifyLocationAdministrationRuntime = Readonly<{
  available: boolean
  mode: 'development' | null
  blockerCode: ShopifyLocationAdministrationRuntimeBlocker | null
  allowedAccountGlobalIds: readonly string[]
  providerWritesEnabled: boolean
  productionAvailable: false
  railwayIdentityMatched: boolean
  railwayEnvironmentIdMatched: boolean
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

function allowlistedAccounts() {
  const entries = String(
    process.env[SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_ALLOWLIST] || '',
  )
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (
    entries.length < 1
    || entries.length > 32
    || entries.some((value) => !ACCOUNT_GLOBAL_ID.test(value))
  ) return []
  return [...new Set(entries)].sort()
}

function unavailable(
  blockerCode: ShopifyLocationAdministrationRuntimeBlocker,
  input: {
    mode?: 'development' | null
    railwayIdentityMatched?: boolean
    railwayEnvironmentIdMatched?: boolean
  } = {},
): ShopifyLocationAdministrationRuntime {
  return Object.freeze({
    available: false,
    mode: input.mode ?? null,
    blockerCode,
    allowedAccountGlobalIds: Object.freeze([]),
    providerWritesEnabled: false,
    productionAvailable: false,
    railwayIdentityMatched: Boolean(input.railwayIdentityMatched),
    railwayEnvironmentIdMatched:
      Boolean(input.railwayEnvironmentIdMatched),
  })
}

/**
 * Merchant-location writes are a deliberately narrow Railway development
 * proving lane. NODE_ENV or a friendly environment name is never sufficient:
 * the deployment must present the exact ClawPilot Railway project, service,
 * and development environment identity, plus an explicit enable flag and
 * exact account Global-ID allowlist. Vercel, local shells, preview
 * environments, foreign services, and production always fail closed.
 */
export function shopifyLocationAdministrationRuntime():
ShopifyLocationAdministrationRuntime {
  const markers = deploymentMarkers()
  // Railway serves built Next.js applications with NODE_ENV=production in
  // every environment. Deployment identity, not the Node optimization mode,
  // decides whether this development-only lane can exist.
  if (markers.includes('production')) {
    return unavailable('SHOPIFY_LOCATION_ADMINISTRATION_DEVELOPMENT_ONLY')
  }
  if (process.env.VERCEL) {
    return unavailable('SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_ONLY')
  }
  const development = normalized(process.env.RAILWAY_ENVIRONMENT_NAME)
    === 'development'
    && !markers.some((marker) => (
      marker === 'local'
      || marker === 'preview'
      || marker === 'sandbox'
      || marker === 'staging'
      || marker === 'test'
      || marker === 'testing'
    ))
  if (!development) {
    return unavailable('SHOPIFY_LOCATION_ADMINISTRATION_DEVELOPMENT_ONLY')
  }
  if (
    !process.env.RAILWAY_PROJECT_ID
    || !process.env.RAILWAY_SERVICE_ID
    || !process.env.RAILWAY_ENVIRONMENT_ID
  ) {
    return unavailable(
      'SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_ONLY',
      { mode: 'development' },
    )
  }
  const identityMatched = (
    normalized(process.env.RAILWAY_PROJECT_ID)
      === SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_PROJECT_ID
    && normalized(process.env.RAILWAY_SERVICE_ID)
      === SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_SERVICE_ID
    && normalized(process.env.RAILWAY_ENVIRONMENT_ID)
      === SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
  )
  if (!identityMatched) {
    return unavailable(
      'SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_IDENTITY_MISMATCH',
      { mode: 'development' },
    )
  }
  if (process.env[SHOPIFY_LOCATION_ADMINISTRATION_ENABLED] !== '1') {
    return unavailable(
      'SHOPIFY_LOCATION_ADMINISTRATION_DISABLED',
      {
        mode: 'development',
        railwayIdentityMatched: true,
        railwayEnvironmentIdMatched: true,
      },
    )
  }
  const accounts = allowlistedAccounts()
  if (!accounts.length) {
    return unavailable(
      'SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_ALLOWLIST_REQUIRED',
      {
        mode: 'development',
        railwayIdentityMatched: true,
        railwayEnvironmentIdMatched: true,
      },
    )
  }
  return Object.freeze({
    available: true,
    mode: 'development',
    blockerCode: null,
    allowedAccountGlobalIds: Object.freeze(accounts),
    providerWritesEnabled: true,
    productionAvailable: false,
    railwayIdentityMatched: true,
    railwayEnvironmentIdMatched: true,
  })
}

export function shopifyLocationAdministrationAccountAllowed(
  accountGlobalId: unknown,
) {
  const candidate = normalized(accountGlobalId)
  const runtime = shopifyLocationAdministrationRuntime()
  return runtime.available
    && ACCOUNT_GLOBAL_ID.test(candidate)
    && runtime.allowedAccountGlobalIds.includes(candidate)
}
