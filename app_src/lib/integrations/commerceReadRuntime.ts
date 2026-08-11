export type CommerceReadRuntimeMode = 'development' | 'production'

type CommerceReadCredential = {
  environment: 'sandbox' | 'production'
  status: 'active' | 'disabled' | 'error'
  verificationStatus: 'unverified' | 'verified' | 'failed'
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
 * authority: only active, verified production accounts are eligible. The
 * development lane retains the existing sandbox/test-account behavior.
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
  options: { developmentRequiresActive?: boolean } = {},
) {
  if (credential.verificationStatus !== 'verified') return false
  if (commerceReadRuntimeMode() === 'production') {
    return (
      credential.environment === 'production'
      && credential.status === 'active'
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
  options: { developmentRequiresActive?: boolean } = {},
) {
  if (!/^[a-z][a-z0-9_]*$/u.test(alias)) {
    throw new Error('Commerce read SQL alias is invalid')
  }
  // The database fence follows the deployment lane even while the feature is
  // disabled. This prevents a module initialized before worker activation from
  // ever compiling a development-strength account predicate in production.
  if (runtimeLane() === 'production') {
    return `(${alias}.status = 'active' AND ${alias}.environment = 'production')`
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
      ? 'active_verified_production_only'
      : 'not_applicable',
    productionTestOrdersAllowed: false,
    automaticOrderPromotionAvailable: mode === 'development',
  } as const
}
