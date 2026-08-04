export const SHOPIFY_ADMIN_API_VERSION = '2026-07' as const
export const SHOPIFY_API_VERSION = SHOPIFY_ADMIN_API_VERSION

// The current control plane retains encrypted payload evidence without a
// retention/purge worker. Keep intake limited to non-customer operational
// topics until that privacy lifecycle and canonical processors exist.
export const SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS = [
  'inventory_items/update',
  'inventory_levels/update',
] as const

export const SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS = [
  'products/create',
  'products/delete',
  'products/update',
] as const

export const SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS = [
  'app/scopes_update',
  ...SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS,
  ...SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS,
] as const

export const COMMERCE_CAPABILITIES = [
  'oauth_authentication',
  'api_authentication',
  'webhook_registration',
  'webhook_verification',
  'webhook_idempotency',
  'product_synchronization',
  'variant_synchronization',
  'catalog_publishing',
  'inventory_import',
  'inventory_export',
  'inventory_transfer_synchronization',
  'inventory_shipment_synchronization',
  'location_synchronization',
  'location_administration',
  'customer_synchronization',
  'customer_export',
  'order_import',
  'historical_order_import',
  'order_creation',
  'order_update',
  'order_edit',
  'draft_order_synchronization',
  'cancellation_import',
  'refund_import',
  'refund_export',
  'fulfillment_export',
  'third_party_fulfillment_orchestration',
  'fulfillment_service',
  'tracking_export',
  'shipping_rate_callbacks',
  'return_import',
  'return_export',
  'market_context',
  'incremental_synchronization',
  'reconciliation',
  'retry',
  'dead_letter',
  'replay',
  'global_id_mapping',
  'integration_health',
  'test_environment',
] as const

export type CommerceCapability = typeof COMMERCE_CAPABILITIES[number]

export type CommerceCapabilityCategory =
  | 'authentication'
  | 'webhooks'
  | 'catalog'
  | 'inventory'
  | 'orders'
  | 'fulfillment'
  | 'returns'
  | 'reliability'

export type CommerceCapabilityDefinition = {
  capability: CommerceCapability
  category: CommerceCapabilityCategory
  direction: 'inbound' | 'outbound' | 'bidirectional' | 'control'
  owner: 'provider' | 'clawpilot' | 'shared'
}

export const COMMERCE_CAPABILITY_DEFINITIONS: readonly CommerceCapabilityDefinition[] = [
  { capability: 'oauth_authentication', category: 'authentication', direction: 'control', owner: 'provider' },
  { capability: 'api_authentication', category: 'authentication', direction: 'control', owner: 'provider' },
  { capability: 'webhook_registration', category: 'webhooks', direction: 'outbound', owner: 'provider' },
  { capability: 'webhook_verification', category: 'webhooks', direction: 'inbound', owner: 'shared' },
  { capability: 'webhook_idempotency', category: 'webhooks', direction: 'inbound', owner: 'clawpilot' },
  { capability: 'product_synchronization', category: 'catalog', direction: 'inbound', owner: 'provider' },
  { capability: 'variant_synchronization', category: 'catalog', direction: 'inbound', owner: 'provider' },
  { capability: 'catalog_publishing', category: 'catalog', direction: 'outbound', owner: 'provider' },
  { capability: 'inventory_import', category: 'inventory', direction: 'inbound', owner: 'provider' },
  { capability: 'inventory_export', category: 'inventory', direction: 'outbound', owner: 'provider' },
  { capability: 'inventory_transfer_synchronization', category: 'inventory', direction: 'bidirectional', owner: 'provider' },
  { capability: 'inventory_shipment_synchronization', category: 'inventory', direction: 'bidirectional', owner: 'provider' },
  { capability: 'location_synchronization', category: 'inventory', direction: 'inbound', owner: 'provider' },
  { capability: 'location_administration', category: 'inventory', direction: 'outbound', owner: 'provider' },
  { capability: 'customer_synchronization', category: 'orders', direction: 'inbound', owner: 'provider' },
  { capability: 'customer_export', category: 'orders', direction: 'outbound', owner: 'provider' },
  { capability: 'order_import', category: 'orders', direction: 'inbound', owner: 'provider' },
  { capability: 'historical_order_import', category: 'orders', direction: 'inbound', owner: 'provider' },
  { capability: 'order_creation', category: 'orders', direction: 'outbound', owner: 'provider' },
  { capability: 'order_update', category: 'orders', direction: 'outbound', owner: 'provider' },
  { capability: 'order_edit', category: 'orders', direction: 'outbound', owner: 'provider' },
  { capability: 'draft_order_synchronization', category: 'orders', direction: 'bidirectional', owner: 'provider' },
  { capability: 'cancellation_import', category: 'orders', direction: 'inbound', owner: 'provider' },
  { capability: 'refund_import', category: 'returns', direction: 'inbound', owner: 'provider' },
  { capability: 'refund_export', category: 'returns', direction: 'outbound', owner: 'provider' },
  { capability: 'fulfillment_export', category: 'fulfillment', direction: 'outbound', owner: 'provider' },
  { capability: 'third_party_fulfillment_orchestration', category: 'fulfillment', direction: 'outbound', owner: 'provider' },
  { capability: 'fulfillment_service', category: 'fulfillment', direction: 'bidirectional', owner: 'provider' },
  { capability: 'tracking_export', category: 'fulfillment', direction: 'outbound', owner: 'provider' },
  { capability: 'shipping_rate_callbacks', category: 'fulfillment', direction: 'bidirectional', owner: 'provider' },
  { capability: 'return_import', category: 'returns', direction: 'inbound', owner: 'provider' },
  { capability: 'return_export', category: 'returns', direction: 'outbound', owner: 'provider' },
  { capability: 'market_context', category: 'orders', direction: 'inbound', owner: 'provider' },
  { capability: 'incremental_synchronization', category: 'reliability', direction: 'inbound', owner: 'shared' },
  { capability: 'reconciliation', category: 'reliability', direction: 'bidirectional', owner: 'clawpilot' },
  { capability: 'retry', category: 'reliability', direction: 'control', owner: 'clawpilot' },
  { capability: 'dead_letter', category: 'reliability', direction: 'control', owner: 'clawpilot' },
  { capability: 'replay', category: 'reliability', direction: 'control', owner: 'clawpilot' },
  { capability: 'global_id_mapping', category: 'reliability', direction: 'control', owner: 'clawpilot' },
  { capability: 'integration_health', category: 'reliability', direction: 'control', owner: 'clawpilot' },
  { capability: 'test_environment', category: 'reliability', direction: 'control', owner: 'provider' },
] as const

export const SHOPIFY_ACCESS_SCOPES = [
  'read_products',
  'write_products',
  'write_publications',
  'read_inventory',
  'write_inventory',
  'read_inventory_transfers',
  'write_inventory_transfers',
  'read_inventory_shipments',
  'write_inventory_shipments',
  'read_inventory_shipments_received_items',
  'write_inventory_shipments_received_items',
  'read_locations',
  'write_locations',
  'read_customers',
  'write_customers',
  'read_orders',
  'read_all_orders',
  'write_orders',
  'read_order_edits',
  'write_order_edits',
  'read_draft_orders',
  'write_draft_orders',
  'read_merchant_managed_fulfillment_orders',
  'write_merchant_managed_fulfillment_orders',
  'read_third_party_fulfillment_orders',
  'write_third_party_fulfillment_orders',
  'read_assigned_fulfillment_orders',
  'write_assigned_fulfillment_orders',
  'read_fulfillments',
  'write_fulfillments',
  'read_shipping',
  'write_shipping',
  'read_app_proxy',
  'write_app_proxy',
  'read_returns',
  'write_returns',
  'read_markets',
] as const

export type ShopifyAccessScope = typeof SHOPIFY_ACCESS_SCOPES[number]

// This is Shopify's provider surface, not a claim that ClawPilot has shipped
// every corresponding import, export, callback, or reconciliation worker.
export const SHOPIFY_PROVIDER_AVAILABLE_CAPABILITIES = [
  'oauth_authentication',
  'api_authentication',
  'webhook_registration',
  'webhook_verification',
  'product_synchronization',
  'variant_synchronization',
  'catalog_publishing',
  'inventory_import',
  'inventory_export',
  'inventory_transfer_synchronization',
  'inventory_shipment_synchronization',
  'location_synchronization',
  'location_administration',
  'customer_synchronization',
  'customer_export',
  'order_import',
  'historical_order_import',
  'order_creation',
  'order_update',
  'order_edit',
  'draft_order_synchronization',
  'cancellation_import',
  'refund_import',
  'refund_export',
  'fulfillment_export',
  'third_party_fulfillment_orchestration',
  'fulfillment_service',
  'tracking_export',
  'shipping_rate_callbacks',
  'return_import',
  'return_export',
  'market_context',
  'incremental_synchronization',
  'test_environment',
] as const satisfies readonly CommerceCapability[]

export type ShopifyProviderCapability = typeof SHOPIFY_PROVIDER_AVAILABLE_CAPABILITIES[number]

// Shopify write scopes include the corresponding read access. The map therefore
// omits redundant read scopes and keeps optional or restricted features isolated.
// ClawPilot reliability capabilities never appear here because they are local
// control-plane responsibilities, not Shopify OAuth access scopes.
export const SHOPIFY_CAPABILITY_SCOPES = {
  product_synchronization: ['read_products'],
  variant_synchronization: ['read_products'],
  catalog_publishing: ['write_products', 'write_publications'],
  inventory_import: ['read_inventory', 'read_locations', 'read_products'],
  inventory_export: ['write_inventory', 'read_locations'],
  inventory_transfer_synchronization: ['write_inventory_transfers'],
  inventory_shipment_synchronization: [
    'write_inventory_shipments',
    'read_inventory_shipments_received_items',
    'write_inventory_shipments_received_items',
  ],
  location_synchronization: ['read_locations'],
  location_administration: ['write_locations'],
  customer_synchronization: ['read_customers'],
  customer_export: ['write_customers'],
  order_import: ['read_orders'],
  historical_order_import: ['read_orders', 'read_all_orders'],
  order_creation: ['write_orders'],
  order_update: ['write_orders'],
  order_edit: ['write_order_edits'],
  draft_order_synchronization: ['write_draft_orders'],
  cancellation_import: ['read_orders'],
  refund_import: ['read_orders'],
  refund_export: ['write_orders'],
  fulfillment_export: ['write_merchant_managed_fulfillment_orders'],
  third_party_fulfillment_orchestration: ['write_third_party_fulfillment_orders'],
  fulfillment_service: ['write_assigned_fulfillment_orders', 'write_fulfillments'],
  tracking_export: ['write_merchant_managed_fulfillment_orders'],
  shipping_rate_callbacks: ['write_shipping'],
  return_import: ['read_returns'],
  return_export: ['write_returns'],
  market_context: ['read_markets'],
} as const satisfies Partial<Record<CommerceCapability, readonly ShopifyAccessScope[]>>

export type ShopifyScopedCapability = keyof typeof SHOPIFY_CAPABILITY_SCOPES

export const SHOPIFY_RESTRICTED_ACCESS_SCOPES = [
  'read_all_orders',
] as const satisfies readonly ShopifyAccessScope[]

// This is the least-privilege scope profile for the bounded product and
// inventory receipt evidence accepted by the current control plane. It is not
// an order-import, inventory-write, or fulfillment-activation profile.
export const SHOPIFY_RECEIPT_PROOF_SCOPES = [
  'read_products',
  'read_inventory',
] as const satisfies readonly ShopifyAccessScope[]

// Merchant-owned Dev Dashboard apps configure this profile in Shopify and
// release it as one app version. ClawPilot never grants these scopes itself;
// it reads the installed store grant and fails each capability closed when
// its required scope is absent. Matching write scopes include their paired
// read access under Shopify's managed-install rules.
export const SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES = [
  'read_all_orders',
  'read_customers',
  'write_inventory',
  'read_locations',
  'read_markets',
  'write_merchant_managed_fulfillment_orders',
  'read_orders',
  'write_products',
  'write_publications',
  'write_shipping',
  'write_app_proxy',
] as const satisfies readonly ShopifyAccessScope[]

export const COMMERCE_CUSTOM_INTEGRATION_ONBOARDING = {
  shopify: {
    ownership: 'merchant_owned_same_shopify_organization',
    authMode: 'shopify_client_credentials',
    developerPortalUrl: 'https://dev.shopify.com/dashboard',
    setupGuideUrl:
      'https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard',
    tokenGuideUrl:
      'https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens',
    defaultAppUrl: 'https://shopify.dev/apps/default-app-home',
    apiVersion: SHOPIFY_ADMIN_API_VERSION,
    requiredBeforeConnect: [
      'Create a merchant-owned app in Shopify Dev Dashboard.',
      'Configure the exact ClawPilot app scopes shown below, then create and release the app version.',
      'Install the app on a store in the same Shopify organization.',
      'Copy the canonical myshopify.com domain, client ID, and client secret.',
    ],
    receiptProofScopes: SHOPIFY_RECEIPT_PROOF_SCOPES,
    distributedOperationsScopes: SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
    acceptedReceiptTopics: SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS,
    webhookSetupGroups: [
      {
        key: 'inventory',
        label: 'Inventory freshness',
        topics: SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS,
        requiredScopes: ['read_inventory'],
        state: 'available',
        behavior: 'Signals an immediate read-only inventory reconciliation; scheduled reconciliation remains the backstop.',
      },
      {
        key: 'catalog',
        label: 'Product catalog',
        topics: SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS,
        requiredScopes: ['read_products'],
        state: 'available',
        behavior: 'Signals an immediate read-only full catalog reconciliation through a lossless monotonic watermark; scheduled reconciliation remains the backstop.',
      },
      {
        key: 'customers',
        label: 'Customer lifecycle',
        topics: ['customers/create', 'customers/update', 'customers/enable', 'customers/disable', 'customers/merge', 'customers/delete'],
        requiredScopes: ['read_customers'],
        state: 'privacy_lifecycle_pending',
        behavior: 'Create and update will upsert the channel identity into CRM; disable, merge, and delete will preserve history and deactivate or redirect that identity.',
      },
      {
        key: 'orders',
        label: 'Order lifecycle',
        topics: ['orders/create', 'orders/update', 'orders/edited', 'orders/cancelled', 'orders/paid'],
        requiredScopes: ['read_orders'],
        state: 'processor_pending',
        behavior: 'Order events will trigger exact normalized-order refresh while polling remains the missed-event backstop.',
      },
      {
        key: 'fulfillment_returns',
        label: 'Fulfillment, refunds, and returns',
        topics: ['fulfillment_orders/moved', 'fulfillment_orders/placed_on_hold', 'fulfillment_orders/split', 'fulfillments/create', 'fulfillments/update', 'refunds/create', 'returns/update'],
        requiredScopes: ['read_merchant_managed_fulfillment_orders', 'read_returns'],
        state: 'processor_pending',
        behavior: 'Shipment and post-purchase events will refresh package, fulfillment, refund, and return state without creating an unapproved provider write.',
      },
      {
        key: 'configuration',
        label: 'Connection and locations',
        topics: ['app/scopes_update', 'app/uninstalled', 'locations/create', 'locations/update', 'locations/delete'],
        requiredScopes: ['read_locations'],
        state: 'processor_pending',
        behavior: 'Configuration events will re-evaluate scopes, connection health, locations, and warehouse routing.',
      },
    ],
    unsupportedCredentialMode: 'legacy_admin_access_token',
  },
  faire: {
    ownership: 'brand_owned_custom_application',
    authMode: 'faire_brand_token',
    supportedAuthModes: ['faire_brand_token', 'faire_oauth'],
    developerPortalUrl: 'https://developers.faire.com/signup',
    setupGuideUrl:
      'https://developers.faire.com/docs#/#authentication',
    directTokenGuideUrl:
      'https://www.faire.com/support/articles/37632363832091',
    requiredBeforeConnect: [
      'Create a Faire Developer account and a Custom App.',
      'For one brand, use the unpublished integration in Faire Brand Portal to generate a final API key.',
      'Paste only that generated API key into ClawPilot; the APA application token and Secret ID are not the final brand API key.',
      'Alternatively, use Application ID and Secret ID only when Faire accepts the Custom App OAuth authorization flow.',
      'ClawPilot makes one read-only brand-profile request before encrypted persistence.',
    ],
    supportContact: 'developers@faire.com',
    minimumProbeScope: 'READ_BRAND',
    scopeProfiles: {
      connection_test: ['READ_BRAND'],
      distributed_operations: [
        'READ_PRODUCTS',
        'WRITE_PRODUCTS',
        'READ_ORDERS',
        'WRITE_ORDERS',
        'READ_BRAND',
        'READ_RETAILER',
        'READ_INVENTORIES',
        'WRITE_INVENTORIES',
        'READ_SHIPMENTS',
        'READ_REVIEWS',
      ],
    },
    sandboxAvailable: false,
    webhooksAvailable: false,
  },
} as const

export type ClawPilotCapabilityImplementationState = 'control_plane_implemented' | 'not_implemented'

// Current-state evidence only. "control_plane_implemented" means a safe
// operator command or connection/receipt boundary exists; it does not imply an
// No implementation state below is production-activation evidence. Product
// and variant synchronization are bounded read-only development workers;
// inventory and location synchronization remain manager-triggered controls;
// checkout rating is a customer-neutral CarrierService control plane whose
// live provider acceptance is tracked separately.
export const CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION = {
  oauth_authentication: 'not_implemented',
  api_authentication: 'control_plane_implemented',
  webhook_registration: 'control_plane_implemented',
  webhook_verification: 'control_plane_implemented',
  webhook_idempotency: 'control_plane_implemented',
  product_synchronization: 'control_plane_implemented',
  variant_synchronization: 'control_plane_implemented',
  catalog_publishing: 'not_implemented',
  inventory_import: 'control_plane_implemented',
  inventory_export: 'not_implemented',
  inventory_transfer_synchronization: 'not_implemented',
  inventory_shipment_synchronization: 'not_implemented',
  location_synchronization: 'control_plane_implemented',
  location_administration: 'not_implemented',
  customer_synchronization: 'not_implemented',
  customer_export: 'not_implemented',
  order_import: 'control_plane_implemented',
  historical_order_import: 'not_implemented',
  order_creation: 'not_implemented',
  order_update: 'not_implemented',
  order_edit: 'not_implemented',
  draft_order_synchronization: 'not_implemented',
  cancellation_import: 'not_implemented',
  refund_import: 'not_implemented',
  refund_export: 'not_implemented',
  fulfillment_export: 'control_plane_implemented',
  third_party_fulfillment_orchestration: 'not_implemented',
  fulfillment_service: 'not_implemented',
  tracking_export: 'control_plane_implemented',
  shipping_rate_callbacks: 'control_plane_implemented',
  return_import: 'not_implemented',
  return_export: 'not_implemented',
  market_context: 'not_implemented',
  incremental_synchronization: 'control_plane_implemented',
  reconciliation: 'not_implemented',
  retry: 'control_plane_implemented',
  dead_letter: 'control_plane_implemented',
  replay: 'not_implemented',
  global_id_mapping: 'control_plane_implemented',
  integration_health: 'control_plane_implemented',
  test_environment: 'not_implemented',
} as const satisfies Record<CommerceCapability, ClawPilotCapabilityImplementationState>

export type ShopifyScopeAudit = {
  requestedScopes: ShopifyAccessScope[]
  grantedScopes: string[]
  missingScopes: ShopifyAccessScope[]
  restrictedScopes: ShopifyAccessScope[]
}

export const FAIRE_PROVIDER_AVAILABLE_CAPABILITIES = [
  'oauth_authentication',
  'api_authentication',
  'product_synchronization',
  'variant_synchronization',
  'catalog_publishing',
  'inventory_import',
  'inventory_export',
  'customer_synchronization',
  'order_import',
  'order_update',
  'cancellation_import',
  'fulfillment_export',
  'tracking_export',
  'incremental_synchronization',
] as const satisfies readonly CommerceCapability[]

export const FAIRE_CAPABILITY_SCOPES = {
  product_synchronization: ['READ_PRODUCTS'],
  variant_synchronization: ['READ_PRODUCTS'],
  catalog_publishing: ['WRITE_PRODUCTS'],
  inventory_import: ['READ_INVENTORIES'],
  inventory_export: ['WRITE_INVENTORIES'],
  customer_synchronization: ['READ_RETAILER'],
  order_import: ['READ_ORDERS'],
  order_update: [
    'READ_BRAND',
    'READ_ORDERS',
    'READ_SHIPMENTS',
    'WRITE_ORDERS',
  ],
  cancellation_import: ['READ_ORDERS'],
  fulfillment_export: [
    'READ_BRAND',
    'READ_ORDERS',
    'READ_SHIPMENTS',
    'WRITE_ORDERS',
  ],
  tracking_export: [
    'READ_BRAND',
    'READ_ORDERS',
    'READ_SHIPMENTS',
    'WRITE_ORDERS',
  ],
} as const satisfies Partial<Record<CommerceCapability, readonly string[]>>

// Faire product and variant synchronization use the bounded read-only
// development catalog worker and reviewed mapping workflow. Other typed client
// methods remain provider-surface evidence only until their own executable
// worker and reconciliation boundary exists.
export const CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION = {
  oauth_authentication: 'control_plane_implemented',
  api_authentication: 'control_plane_implemented',
  webhook_registration: 'not_implemented',
  webhook_verification: 'not_implemented',
  webhook_idempotency: 'not_implemented',
  product_synchronization: 'control_plane_implemented',
  variant_synchronization: 'control_plane_implemented',
  catalog_publishing: 'not_implemented',
  inventory_import: 'not_implemented',
  inventory_export: 'not_implemented',
  inventory_transfer_synchronization: 'not_implemented',
  inventory_shipment_synchronization: 'not_implemented',
  location_synchronization: 'not_implemented',
  location_administration: 'not_implemented',
  customer_synchronization: 'not_implemented',
  customer_export: 'not_implemented',
  order_import: 'control_plane_implemented',
  historical_order_import: 'not_implemented',
  order_creation: 'not_implemented',
  order_update: 'control_plane_implemented',
  order_edit: 'not_implemented',
  draft_order_synchronization: 'not_implemented',
  cancellation_import: 'not_implemented',
  refund_import: 'not_implemented',
  refund_export: 'not_implemented',
  fulfillment_export: 'control_plane_implemented',
  third_party_fulfillment_orchestration: 'not_implemented',
  fulfillment_service: 'not_implemented',
  tracking_export: 'control_plane_implemented',
  shipping_rate_callbacks: 'not_implemented',
  return_import: 'not_implemented',
  return_export: 'not_implemented',
  market_context: 'not_implemented',
  incremental_synchronization: 'control_plane_implemented',
  reconciliation: 'not_implemented',
  retry: 'control_plane_implemented',
  dead_letter: 'control_plane_implemented',
  replay: 'not_implemented',
  global_id_mapping: 'control_plane_implemented',
  integration_health: 'control_plane_implemented',
  test_environment: 'not_implemented',
} as const satisfies Record<CommerceCapability, ClawPilotCapabilityImplementationState>

export type CommerceCapabilityProvider = 'shopify' | 'faire'

export function commerceCapabilityImplementationState(
  provider: CommerceCapabilityProvider,
  capability: CommerceCapability,
): ClawPilotCapabilityImplementationState {
  return provider === 'shopify'
    ? CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION[capability]
    : CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION[capability]
}

export function isClawPilotCommerceCapabilityImplemented(
  provider: CommerceCapabilityProvider,
  capability: CommerceCapability,
) {
  return commerceCapabilityImplementationState(provider, capability)
    === 'control_plane_implemented'
}

const SHOPIFY_PROVIDER_CAPABILITY_SET = new Set<CommerceCapability>(SHOPIFY_PROVIDER_AVAILABLE_CAPABILITIES)
const SHOPIFY_SCOPED_CAPABILITY_SET = new Set<CommerceCapability>(
  Object.keys(SHOPIFY_CAPABILITY_SCOPES) as ShopifyScopedCapability[],
)
const SHOPIFY_RESTRICTED_SCOPE_SET = new Set<ShopifyAccessScope>(SHOPIFY_RESTRICTED_ACCESS_SCOPES)
const SHOPIFY_ACCESS_SCOPE_SET = new Set<string>(SHOPIFY_ACCESS_SCOPES)

export function isCommerceCapability(value: unknown): value is CommerceCapability {
  return typeof value === 'string'
    && (COMMERCE_CAPABILITIES as readonly string[]).includes(value)
}

export function isShopifyProviderCapability(value: unknown): value is ShopifyProviderCapability {
  return isCommerceCapability(value) && SHOPIFY_PROVIDER_CAPABILITY_SET.has(value)
}

export function isShopifyScopedCapability(value: unknown): value is ShopifyScopedCapability {
  return isCommerceCapability(value) && SHOPIFY_SCOPED_CAPABILITY_SET.has(value)
}

export function shopifyScopesForCapabilities(
  capabilities: readonly CommerceCapability[],
): ShopifyAccessScope[] {
  const scopes = new Set<ShopifyAccessScope>()
  for (const capability of capabilities) {
    if (!isShopifyScopedCapability(capability)) continue
    for (const scope of SHOPIFY_CAPABILITY_SCOPES[capability]) scopes.add(scope)
  }
  return [...scopes].sort()
}

function normalizedGrantedScopes(grantedScopes: readonly string[]): string[] {
  const normalized = new Set<string>()
  for (const scope of grantedScopes) {
    if (typeof scope !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(scope)) {
      throw new TypeError('Granted Shopify access scopes were invalid')
    }
    normalized.add(scope)
  }
  return [...normalized].sort()
}

function effectiveGrantedScopeSet(grantedScopes: readonly string[]) {
  const effective = new Set(normalizedGrantedScopes(grantedScopes))
  for (const scope of [...effective]) {
    if (!scope.startsWith('write_')) continue
    const impliedReadScope = `read_${scope.slice('write_'.length)}`
    if (SHOPIFY_ACCESS_SCOPE_SET.has(impliedReadScope)) {
      effective.add(impliedReadScope)
    }
  }
  return effective
}

export function hasEffectiveShopifyScope(
  grantedScopes: readonly string[],
  scope: ShopifyAccessScope,
) {
  return effectiveGrantedScopeSet(grantedScopes).has(scope)
}

export function auditShopifyScopeRequirements(
  requestedScopes: readonly ShopifyAccessScope[],
  grantedScopes: readonly string[],
): ShopifyScopeAudit {
  const requested = [...new Set(requestedScopes)].sort()
  const granted = normalizedGrantedScopes(grantedScopes)
  const effectiveGranted = effectiveGrantedScopeSet(granted)
  return {
    requestedScopes: requested,
    grantedScopes: granted,
    missingScopes: requested.filter((scope) => !effectiveGranted.has(scope)),
    restrictedScopes: requested.filter((scope) => SHOPIFY_RESTRICTED_SCOPE_SET.has(scope)),
  }
}

export function auditShopifyScopeUpdatePayload(
  payload: unknown,
): ShopifyScopeAudit {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Shopify scope-update payload was invalid')
  }
  const current = (payload as Record<string, unknown>).current
  if (
    !Array.isArray(current)
    || !current.every((scope): scope is string => typeof scope === 'string')
  ) {
    throw new TypeError('Shopify scope-update payload was invalid')
  }
  return auditShopifyScopeRequirements(
    SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
    current,
  )
}

export function auditShopifyScopes(
  capabilities: readonly CommerceCapability[],
  grantedScopes: readonly string[],
): ShopifyScopeAudit {
  return auditShopifyScopeRequirements(
    shopifyScopesForCapabilities(capabilities),
    grantedScopes,
  )
}

export function missingShopifyScopes(
  capabilities: readonly CommerceCapability[],
  grantedScopes: readonly string[],
): ShopifyAccessScope[] {
  return auditShopifyScopes(capabilities, grantedScopes).missingScopes
}
