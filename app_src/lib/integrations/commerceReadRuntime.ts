export type CommerceReadRuntimeMode = 'development' | 'production'
export type CommerceReadCapability =
  | 'catalog'
  | 'images'
  | 'inventory'
  | 'orders_history'
  | 'webhook_hydration'

const COMMERCE_READ_CAPABILITIES = new Set<CommerceReadCapability>([
  'catalog',
  'images',
  'inventory',
  'orders_history',
  'webhook_hydration',
])

function exactReadCapability(value: unknown): CommerceReadCapability {
  if (!COMMERCE_READ_CAPABILITIES.has(value as CommerceReadCapability)) {
    throw new Error('Commerce read capability is invalid')
  }
  return value as CommerceReadCapability
}

type CommerceReadCredential = {
  environment: 'sandbox' | 'production'
  status: 'active' | 'disabled' | 'error'
  verificationStatus: 'unverified' | 'verified' | 'failed'
  hostedProductionSandboxReadCapabilities?: CommerceReadCapability[]
}

function runtimeLane() {
  const hostedLanes = [
    process.env.CLAWPILOT_ENV,
    process.env.RAILWAY_ENVIRONMENT_NAME,
    process.env.VERCEL_ENV,
  ].map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  // A production marker always wins over a conflicting development marker.
  // NODE_ENV is only a fallback because hosted development builds also run
  // compiled Next.js with NODE_ENV=production.
  if (hostedLanes.includes('production')) return 'production'
  return hostedLanes[0]
    || String(process.env.NODE_ENV || '').trim().toLowerCase()
}

/**
 * Provider reads and local reconciliation use the established commerce-intake
 * feature flag in both hosted lanes. Production is deliberately a narrower
 * authority: active, verified production accounts are eligible. The two
 * compiled Shopify demo accounts additionally need a current, capability-
 * specific hosted-production sandbox-read authorization. The development lane
 * retains the existing sandbox/test-account behavior.
 */
export function commerceReadRuntimeMode(): CommerceReadRuntimeMode | null {
  if (process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED !== '1') return null
  const lane = runtimeLane()
  if (lane === 'production') return 'production'
  if (['dev', 'development', 'local', 'preview'].includes(lane)) {
    return 'development'
  }
  return null
}

export function commerceReadRuntimeAvailable() {
  return commerceReadRuntimeMode() !== null
}

export function productionCommerceReadRuntime() {
  return commerceReadRuntimeMode() === 'production'
}

export function commerceReadCredentialEligible(
  credential: CommerceReadCredential,
  options: {
    developmentRequiresActive?: boolean
    capability?: CommerceReadCapability
  } = {},
) {
  if (credential.verificationStatus !== 'verified') return false
  if (commerceReadRuntimeMode() === 'production') {
    const capability = exactReadCapability(options.capability || 'orders_history')
    return (
      credential.status === 'active'
      && (
        credential.environment === 'production'
        || (
          credential.environment === 'sandbox'
          && credential.hostedProductionSandboxReadCapabilities?.includes(capability) === true
        )
      )
    )
  }
  if (commerceReadRuntimeMode() !== 'development') return false
  return options.developmentRequiresActive
    ? credential.status === 'active'
    : credential.status !== 'error'
}

/** Trusted SQL fragment; alias is restricted before interpolation. */
export function commerceReadAccountSql(
  alias = 'account',
  options: {
    developmentRequiresActive?: boolean
    capability?: CommerceReadCapability
  } = {},
) {
  if (!/^[a-z][a-z0-9_]*$/u.test(alias)) {
    throw new Error('Commerce read SQL alias is invalid')
  }
  // The database fence follows the deployment lane even while the feature is
  // disabled. This prevents a module initialized before worker activation from
  // ever compiling a development-strength account predicate in production.
  if (runtimeLane() === 'production') {
    const capability = exactReadCapability(options.capability || 'orders_history')
    return `(${alias}.status = 'active' AND (`
      + `${alias}.environment = 'production' OR (`
      + `${alias}.provider = 'shopify' AND `
      + `${alias}.integration_type = 'commerce' AND `
      + `${alias}.environment = 'sandbox' AND `
      + 'operations_commerce_hosted_production_sandbox_read_is_current('
      + `${alias}.organization_id, ${alias}.id, '${capability}'`
      + '))))'
  }
  return options.developmentRequiresActive
    ? `${alias}.status = 'active'`
    : `${alias}.status <> 'error'`
}

export function commerceReadRuntimeSummary() {
  const mode = commerceReadRuntimeMode()
  return {
    available: mode !== null,
    mode,
    providerWrites: 0,
    productionAccountPolicy: mode === 'production'
      ? 'active_verified_production_or_exact_expiring_shopify_sandbox_read_authority'
      : 'not_applicable',
    productionTestOrdersAllowed: false,
    productionSandboxProviderWritesAllowed: false,
    automaticOrderPromotionAvailable: mode === 'development',
  } as const
}
