export const CARRIER_PRODUCTION_LABEL_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'

export const CARRIER_PRODUCTION_LABEL_RAILWAY_SERVICE_ID =
  'f3fdf47c-6645-42ff-9a28-52843f8e4da2'

export const CARRIER_PRODUCTION_LABEL_RAILWAY_PRODUCTION_ENVIRONMENT_ID =
  '058ce52f-1d3b-44bb-afe2-0df2bf24efb9'

export type CarrierProductionLabelRuntimeLane = 'production'

export type CarrierProductionLabelRuntimePolicy = Readonly<{
  allowed: boolean
  lane: CarrierProductionLabelRuntimeLane | null
}>

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

/**
 * Production postage is a hosted mutation. The selected carrier connection
 * still decides which provider environment and capability are used; this
 * policy only decides whether the current ClawPilot runtime may expose that
 * already-authorized mutation.
 *
 * The sole hosted production lane is exact-identity gated so a generic
 * development, local, test, staging, foreign Railway, or Vercel runtime cannot
 * become eligible from NODE_ENV or an ambiguous lane marker alone.
 */
export function carrierProductionLabelRuntimePolicy(
  environment: Record<string, string | undefined> = process.env,
): CarrierProductionLabelRuntimePolicy {
  const vercel = Boolean(environment.VERCEL)
    || Boolean(normalized(environment.VERCEL_ENV))
  if (vercel) return Object.freeze({ allowed: false, lane: null })

  const markers = [
    environment.CLAWPILOT_ENV,
    environment.RUNTIME_LANE,
    environment.RAILWAY_ENVIRONMENT_NAME,
    environment.RAILWAY_ENVIRONMENT,
  ].map(normalized).filter(Boolean)
  const nonProductionMarkers = new Set([
    'dev',
    'development',
    'local',
    'preview',
    'sandbox',
    'staging',
    'test',
    'testing',
  ])
  const hasProductionMarker = markers.some((value) => value === 'production')
  const hasNonProductionMarker = markers.some((value) => (
    nonProductionMarkers.has(value)
  ))
  if (hasProductionMarker && hasNonProductionMarker) {
    return Object.freeze({ allowed: false, lane: null })
  }

  const railwayProjectMatches = (
    normalized(environment.RAILWAY_PROJECT_ID)
      === CARRIER_PRODUCTION_LABEL_RAILWAY_PROJECT_ID
  )
  const railwayServiceMatches = (
    normalized(environment.RAILWAY_SERVICE_ID)
      === CARRIER_PRODUCTION_LABEL_RAILWAY_SERVICE_ID
  )
  const trustedRailwayProduction = (
    normalized(environment.RAILWAY_ENVIRONMENT_NAME) === 'production'
    && railwayProjectMatches
    && railwayServiceMatches
    && normalized(environment.RAILWAY_ENVIRONMENT_ID)
      === CARRIER_PRODUCTION_LABEL_RAILWAY_PRODUCTION_ENVIRONMENT_ID
    && hasProductionMarker
    && !hasNonProductionMarker
  )
  if (trustedRailwayProduction) {
    return Object.freeze({ allowed: true, lane: 'production' })
  }

  return Object.freeze({ allowed: false, lane: null })
}

export function carrierProductionLabelAuthorizationAllowed(
  environment: Record<string, string | undefined> = process.env,
) {
  return carrierProductionLabelRuntimePolicy(environment).allowed
}
