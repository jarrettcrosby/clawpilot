export const AG_ALCHEMY_EPISCS_CARRIER_DELEGATION =
  'ag-alchemy-episcs-sandbox-rating-delegation'

export const AG_ALCHEMY_CARRIER_ORIGIN_WAREHOUSE = 'gwh5366613'

export const AG_ALCHEMY_PRODUCTION_SOURCE_AUTHORITY_ORGANIZATION = 'ga5122758'

export const AG_ALCHEMY_PRODUCTION_SOURCE_AUTHORITY_IDENTITIES = Object.freeze([
  'gia7335302:gac2368052',
  'gia2057284:gac5139730',
])

const AG_ALCHEMY_PRODUCTION_SOURCE_AUTHORITY_PAIRS = new Set(
  AG_ALCHEMY_PRODUCTION_SOURCE_AUTHORITY_IDENTITIES,
)

export const MANAGED_SANDBOX_RATING_SCOPE = 'sandbox_rating_only'

export const MANAGED_SANDBOX_FULFILLMENT_SCOPE =
  'sandbox_fulfillment_diagnostic'

export type ManagedCarrierDelegationProfile =
  | 'rating_only'
  | 'sandbox_fulfillment_diagnostic'
  | 'drifted'

type ManagedCarrierConfiguration = {
  managedBy?: unknown
  authorizationScope?: unknown
  credentialRevealAllowed?: unknown
  senderOriginWarehouseGlobalId?: unknown
  allowedCapabilities?: unknown
  delegatedFromOrganizationReferenceCode?: unknown
  sourceIntegrationGlobalId?: unknown
  sourceCarrierAccountGlobalId?: unknown
  migrationSourceAuthorityVerified?: unknown
}

function exactCapabilities(value: unknown, expected: string[]) {
  return (
    Array.isArray(value)
    && value.length === expected.length
    && value.every((capability, index) => capability === expected[index])
  )
}

export function isSourceManagedCarrierConfiguration(
  configuration: ManagedCarrierConfiguration,
) {
  return (
    configuration.managedBy === AG_ALCHEMY_EPISCS_CARRIER_DELEGATION
    || (
      (
        configuration.authorizationScope === MANAGED_SANDBOX_RATING_SCOPE
        || configuration.authorizationScope === MANAGED_SANDBOX_FULFILLMENT_SCOPE
      )
      && configuration.credentialRevealAllowed === false
    )
  )
}

export function managedCarrierDelegationProfile(
  configuration: ManagedCarrierConfiguration,
): ManagedCarrierDelegationProfile | null {
  if (!isSourceManagedCarrierConfiguration(configuration)) return null
  const migratedProductionAuthorityMatches = (
    configuration.migrationSourceAuthorityVerified === true
    && configuration.delegatedFromOrganizationReferenceCode
      === AG_ALCHEMY_PRODUCTION_SOURCE_AUTHORITY_ORGANIZATION
    && AG_ALCHEMY_PRODUCTION_SOURCE_AUTHORITY_PAIRS.has(
      `${String(configuration.sourceIntegrationGlobalId || '')}`
      + `:${String(configuration.sourceCarrierAccountGlobalId || '')}`,
    )
    && /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/u.test(
      String(configuration.senderOriginWarehouseGlobalId || ''),
    )
  )
  const commonPolicyMatches = (
    configuration.managedBy === AG_ALCHEMY_EPISCS_CARRIER_DELEGATION
    && configuration.credentialRevealAllowed === false
    && (
      configuration.senderOriginWarehouseGlobalId
        === AG_ALCHEMY_CARRIER_ORIGIN_WAREHOUSE
      || migratedProductionAuthorityMatches
    )
  )
  if (!commonPolicyMatches) return 'drifted'
  if (
    configuration.authorizationScope === MANAGED_SANDBOX_RATING_SCOPE
    && exactCapabilities(configuration.allowedCapabilities, ['sandbox_rate'])
  ) {
    return 'rating_only'
  }
  if (
    configuration.authorizationScope === MANAGED_SANDBOX_FULFILLMENT_SCOPE
    && exactCapabilities(
      configuration.allowedCapabilities,
      ['sandbox_rate', 'sandbox_label'],
    )
  ) {
    return 'sandbox_fulfillment_diagnostic'
  }
  return 'drifted'
}

export function managedCarrierDelegationAllows(
  configuration: ManagedCarrierConfiguration,
  capability: 'sandbox_rate' | 'sandbox_label' | 'production_rate' | 'production_label',
) {
  const profile = managedCarrierDelegationProfile(configuration)
  if (profile === 'rating_only') return capability === 'sandbox_rate'
  if (profile === 'sandbox_fulfillment_diagnostic') {
    return capability === 'sandbox_rate' || capability === 'sandbox_label'
  }
  return false
}

export function carrierConfigurationAllowsSandboxLabel(
  configuration: ManagedCarrierConfiguration,
) {
  if (isSourceManagedCarrierConfiguration(configuration)) {
    return managedCarrierDelegationAllows(configuration, 'sandbox_label')
  }
  const configured = configuration.allowedCapabilities
  return !Array.isArray(configured) || configured.includes('sandbox_label')
}
