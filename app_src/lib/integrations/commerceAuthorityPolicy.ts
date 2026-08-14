export const COMMERCE_AUTHORITY_RESOURCES = Object.freeze([
  'orders',
  'inventory',
] as const)

export type CommerceAuthorityResource =
  (typeof COMMERCE_AUTHORITY_RESOURCES)[number]

export type CommerceAuthorityProvider = 'shopify' | 'faire'
export type CommerceAuthorityMode = 'provider' | 'observation_only'
export type CommerceDesiredIngestMode =
  | 'windowed_history_and_core_order_signals_plus_poll'
  | 'provider_available_history_and_continuous_poll'
  | 'current_snapshot_and_realtime'
  | 'observation_only'
export type CommerceProviderWriteMode = 'disabled'

export type CommerceInboundCapability =
  | 'provider_order_sync'
  | 'provider_inventory_projection'
  | 'provider_inventory_observation'

export type CommerceAuthorityDefaults = {
  authorityMode: CommerceAuthorityMode
  desiredIngestMode: CommerceDesiredIngestMode
  providerWriteMode: CommerceProviderWriteMode
}

export type CommerceAuthorityCapability = {
  inbound: CommerceInboundCapability
  clawPilotAuthorityAvailable: false
  providerWriteAvailable: false
  providerWriteBlockerCode:
    | 'COMMERCE_PROVIDER_WRITE_ADAPTER_UNAVAILABLE'
    | 'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE'
    | 'COMMERCE_FAIRE_INVENTORY_OBSERVATION_ONLY'
}

export const DEFAULT_COMMERCE_PROVIDER_WRITE_MODE:
CommerceProviderWriteMode = 'disabled'

export function commerceAuthorityHistoricalCoverageReady(input: {
  provider: CommerceAuthorityProvider
  enabled: boolean
  status: string | null
  completenessState: string | null
}) {
  const expectedCompleteness = input.provider === 'shopify'
    ? 'shopify_fixed_window_orders_complete'
    : 'faire_provider_available_orders_complete'
  return input.enabled
    && input.status === 'succeeded'
    && input.completenessState === expectedCompleteness
}

export function isCommerceAuthorityResource(
  value: unknown,
): value is CommerceAuthorityResource {
  return COMMERCE_AUTHORITY_RESOURCES.includes(
    value as CommerceAuthorityResource,
  )
}

export function isCommerceAuthorityProvider(
  value: unknown,
): value is CommerceAuthorityProvider {
  return value === 'shopify' || value === 'faire'
}

export function commerceAuthorityDefaults(
  provider: CommerceAuthorityProvider,
  resource: CommerceAuthorityResource,
): CommerceAuthorityDefaults {
  if (resource === 'orders') {
    return {
      authorityMode: 'provider',
      desiredIngestMode: provider === 'shopify'
        ? 'windowed_history_and_core_order_signals_plus_poll'
        : 'provider_available_history_and_continuous_poll',
      providerWriteMode: DEFAULT_COMMERCE_PROVIDER_WRITE_MODE,
    }
  }
  if (provider === 'shopify') {
    return {
      authorityMode: 'provider',
      desiredIngestMode: 'current_snapshot_and_realtime',
      providerWriteMode: DEFAULT_COMMERCE_PROVIDER_WRITE_MODE,
    }
  }
  return {
    authorityMode: 'observation_only',
    desiredIngestMode: 'observation_only',
    providerWriteMode: DEFAULT_COMMERCE_PROVIDER_WRITE_MODE,
  }
}

export function commerceAuthorityCapability(
  provider: CommerceAuthorityProvider,
  resource: CommerceAuthorityResource,
): CommerceAuthorityCapability {
  if (provider === 'faire' && resource === 'inventory') {
    return {
      inbound: 'provider_inventory_observation',
      clawPilotAuthorityAvailable: false,
      providerWriteAvailable: false,
      providerWriteBlockerCode:
        'COMMERCE_FAIRE_INVENTORY_OBSERVATION_ONLY',
    }
  }
  if (resource === 'inventory') {
    return {
      inbound: 'provider_inventory_projection',
      clawPilotAuthorityAvailable: false,
      providerWriteAvailable: false,
      providerWriteBlockerCode:
        'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE',
    }
  }
  return {
    inbound: 'provider_order_sync',
    clawPilotAuthorityAvailable: false,
    providerWriteAvailable: false,
    providerWriteBlockerCode:
      'COMMERCE_PROVIDER_WRITE_ADAPTER_UNAVAILABLE',
  }
}
