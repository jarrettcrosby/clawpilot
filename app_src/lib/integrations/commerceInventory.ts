import { createHash, randomUUID } from 'node:crypto'
import {
  decryptCommerceCredential,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  CommerceIntegrationRequestError,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import {
  hasEffectiveShopifyScope,
  type ShopifyAccessScope,
} from '@/lib/integrations/commerceCapabilities'
import {
  commerceReadCredentialEligible,
  commerceReadRuntimeAvailable,
  commerceReadRuntimeMode,
} from '@/lib/integrations/commerceReadRuntime'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  ShopifyCommerceClientError,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  fetchShopifyInventorySnapshot,
  listShopifyInventoryLocations,
  SHOPIFY_INVENTORY_ADAPTER_VERSION,
  type ShopifyInventoryLocation,
} from '@/lib/integrations/shopifyInventory'
import {
  applyShopifyInventorySnapshotInPostgres,
  captureShopifyInventorySnapshotInPostgres,
  CommerceInventoryPersistenceError,
  createShopifyInventoryWarehouseAndMappingInPostgres,
  finalizeShopifyInventoryReadFailureInPostgres,
  mapShopifyInventoryLocationInPostgres,
  prepareShopifyInventoryReadInPostgres,
  readShopifyInventoryCaptureFromPostgres,
  readShopifyInventoryConfigurationFromPostgres,
  readShopifyInventoryStateFromPostgres,
  readShopifyInventoryTargetFromPostgres,
  renewShopifyInventoryReadLeaseInPostgres,
  type ShopifyInventoryRefreshExpectedFence,
  type ShopifyInventoryTarget,
} from '@/lib/persistence/commerceInventory'
import {
  readCommerceRuntimeCredentialFromPostgres,
  type CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'
import {
  acknowledgeManualShopifyInventoryRefreshInPostgres,
  readShopifyInventoryRefreshDirtyVersionInPostgres,
  readShopifyInventoryRefreshRecoveryStateFromPostgres,
} from '@/lib/persistence/shopifyInventoryRefresh'
import {
  withCommerceStoreSyncProviderReadFenceInPostgres,
} from '@/lib/persistence/commerceStoreSync'

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const INVENTORY_MAPPING_GLOBAL_ID = /^gilm(?:[0-9]{7}|[0-9a-v]{12})$/
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/
const LOCATION_GLOBAL_ID = /^gwl(?:[0-9]{7}|[0-9a-v]{12})$/
const SHOPIFY_LOCATION_ID = /^gid:\/\/shopify\/Location\/[1-9][0-9]*$/
const WAREHOUSE_FACILITY_TYPES = new Set([
  'distribution_center',
  'store',
  'dark_store',
  'micro_fulfillment',
  'cross_dock',
  'supplier',
  'drop_ship',
  'third_party',
])
const REQUIRED_SCOPES = Object.freeze([
  'read_inventory',
  'read_locations',
  'read_products',
] as const satisfies readonly ShopifyAccessScope[])
const LOCATION_DISCOVERY_TTL_MS = 30_000
const locationDiscoveryCache = new Map<string, {
  expiresAt: number
  locations: Promise<ShopifyInventoryLocation[]>
}>()

function inventoryError(error: unknown): CommerceIntegrationRequestError {
  if (error instanceof CommerceIntegrationRequestError) return error
  if (error instanceof CommerceInventoryPersistenceError) {
    return new CommerceIntegrationRequestError(
      error.message,
      error.status,
      error.code,
    )
  }
  return sanitizedCommerceIntegrationError(error)
}

export function shopifyInventoryRuntimeAvailable() {
  return commerceReadRuntimeAvailable()
}

export function assertShopifyInventoryRuntime() {
  if (!shopifyInventoryRuntimeAvailable()) {
    throw new CommerceIntegrationRequestError(
      'Shopify inventory reconciliation is disabled in this environment',
      404,
      'SHOPIFY_INVENTORY_DISABLED',
    )
  }
}

function normalizeIdempotencyKey(value: unknown) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new CommerceIntegrationRequestError(
      'A valid Shopify inventory idempotency key is required',
      400,
      'SHOPIFY_INVENTORY_IDEMPOTENCY_KEY_INVALID',
    )
  }
  return key
}

function normalizedGlobalId(
  value: unknown,
  pattern: RegExp,
  field: string,
) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!pattern.test(normalized)) {
    throw new CommerceIntegrationRequestError(
      `${field} is invalid`,
      400,
      'SHOPIFY_INVENTORY_MAPPING_INPUT_INVALID',
    )
  }
  return normalized
}

function nullableMappingGlobalId(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  return normalizedGlobalId(
    value,
    INVENTORY_MAPPING_GLOBAL_ID,
    'Shopify inventory mapping',
  )
}

function expectedRowVersion(value: unknown, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) {
    return null
  }
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new CommerceIntegrationRequestError(
      'Shopify inventory mapping row version is invalid',
      400,
      'SHOPIFY_INVENTORY_MAPPING_VERSION_INVALID',
    )
  }
  return normalized
}

function warehouseConfiguration(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommerceIntegrationRequestError(
      'Warehouse configuration is required',
      400,
      'SHOPIFY_INVENTORY_WAREHOUSE_INPUT_INVALID',
    )
  }
  const input = value as Record<string, unknown>
  const allowed = new Set(['code', 'name', 'facilityType', 'timezone'])
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new CommerceIntegrationRequestError(
      'Warehouse configuration contains unsupported fields',
      400,
      'SHOPIFY_INVENTORY_WAREHOUSE_INPUT_INVALID',
    )
  }
  const code = typeof input.code === 'string'
    ? input.code.trim().toUpperCase()
    : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const facilityType = typeof input.facilityType === 'string'
    ? input.facilityType.trim()
    : ''
  const timezone = typeof input.timezone === 'string'
    ? input.timezone.trim()
    : ''
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code)) {
    throw new CommerceIntegrationRequestError(
      'Warehouse code may use letters, numbers, hyphens, and underscores',
      400,
      'SHOPIFY_INVENTORY_WAREHOUSE_CODE_INVALID',
    )
  }
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new CommerceIntegrationRequestError(
      'Warehouse name is invalid',
      400,
      'SHOPIFY_INVENTORY_WAREHOUSE_NAME_INVALID',
    )
  }
  if (!WAREHOUSE_FACILITY_TYPES.has(facilityType)) {
    throw new CommerceIntegrationRequestError(
      'Warehouse facility type is invalid',
      400,
      'SHOPIFY_INVENTORY_WAREHOUSE_FACILITY_INVALID',
    )
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw new CommerceIntegrationRequestError(
      'Warehouse timezone is invalid',
      400,
      'SHOPIFY_INVENTORY_WAREHOUSE_TIMEZONE_INVALID',
    )
  }
  return { code, name, facilityType, timezone }
}

async function runtime(input: {
  organizationId: unknown
  accountGlobalId: unknown
}): Promise<CommerceRuntimeCredentialRecord> {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(
    input.accountGlobalId,
  )
  const stored = await readCommerceRuntimeCredentialFromPostgres({
    organizationId,
    accountGlobalId,
  })
  if (!stored || stored.provider !== 'shopify') {
    throw new CommerceIntegrationRequestError(
      'A configured Shopify sales channel is required',
      404,
      'SHOPIFY_INVENTORY_ACCOUNT_REQUIRED',
    )
  }
  if (!commerceReadCredentialEligible(stored, {
    developmentRequiresActive: true,
  })) {
    throw new CommerceIntegrationRequestError(
      commerceReadRuntimeMode() === 'production'
        ? 'Production inventory reconciliation requires an active verified production Shopify account'
        : 'Reconnect and verify Shopify before syncing inventory',
      409,
      'SHOPIFY_INVENTORY_ACCOUNT_INELIGIBLE',
    )
  }
  return stored
}

function normalizedAddressPart(value: unknown) {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
    : ''
}

function addressMatches(
  target: ShopifyInventoryTarget['warehouse']['address'],
  location: ShopifyInventoryLocation,
) {
  const targetCountry =
    target.countryCode
    ?? target.country
  const targetRegion =
    target.regionCode
    ?? target.region
    ?? target.state
  const exactFields = [
    [target.line1 ?? target.address1, location.address.line1],
    [target.city, location.address.city],
    [targetRegion, location.address.regionCode || location.address.region],
    [target.postalCode ?? target.zip, location.address.postalCode],
    [targetCountry, location.address.countryCode || location.address.country],
  ]
  return exactFields.every(([left, right]) => (
    normalizedAddressPart(left)
    && normalizedAddressPart(left) === normalizedAddressPart(right)
  ))
}

function selectLocation(
  target: ShopifyInventoryTarget,
  locations: ShopifyInventoryLocation[],
): {
  location: ShopifyInventoryLocation
  method: 'automatic_single_location' | 'automatic_exact_address'
} {
  const eligible = locations.filter((location) => (
    location.isActive
    && location.shipsInventory
    && location.fulfillsOnlineOrders
    && !location.isFulfillmentService
  ))
  if (target.existingMapping) {
    const exact = eligible.find(
      (location) => (
        location.id === target.existingMapping?.externalLocationId
      ),
    )
    if (!exact) {
      throw new CommerceIntegrationRequestError(
        'The saved Shopify inventory location is no longer active',
        409,
        'SHOPIFY_INVENTORY_LOCATION_STALE',
      )
    }
    return {
      location: exact,
      method: addressMatches(target.warehouse.address, exact)
        ? 'automatic_exact_address'
        : 'automatic_single_location',
    }
  }
  const addressCandidates = eligible.filter(
    (location) => addressMatches(target.warehouse.address, location),
  )
  if (addressCandidates.length === 1) {
    return {
      location: addressCandidates[0],
      method: 'automatic_exact_address',
    }
  }
  if (eligible.length === 1) {
    return {
      location: eligible[0],
      method: 'automatic_single_location',
    }
  }
  throw new CommerceIntegrationRequestError(
    eligible.length
      ? 'More than one shipping-capable Shopify location exists and none maps uniquely to the selected warehouse address'
      : 'Shopify did not return an active physical location that ships and fulfills online inventory',
    409,
    eligible.length
      ? 'SHOPIFY_INVENTORY_LOCATION_SELECTION_REQUIRED'
      : 'SHOPIFY_INVENTORY_LOCATION_REQUIRED',
  )
}

function requestHash(
  stored: CommerceRuntimeCredentialRecord,
  target: ShopifyInventoryTarget,
  providerReadAuthority: 'automatic' | 'manual_read_only',
) {
  return createHash('sha256').update(JSON.stringify({
    policyVersion: 'shopify-inventory-atp-v2',
    adapterVersion: SHOPIFY_INVENTORY_ADAPTER_VERSION,
    accountGlobalId: stored.globalId,
    credentialVersion: stored.credentialVersion,
    pipelineId: target.pipelineId,
    warehouseGlobalId: target.warehouse.globalId,
    locationGlobalId: target.location.globalId,
    inventoryLocationMappingGlobalId:
      target.existingMapping?.globalId || null,
    inventoryLocationMappingRowVersion:
      target.existingMapping?.rowVersion ?? null,
    providerLocationId:
      target.existingMapping?.externalLocationId || null,
    inventoryPoolId: target.existingMapping?.inventoryPoolId || null,
    requiredScopes: REQUIRED_SCOPES,
    providerReadAuthority,
    quantityStates: [
      'available',
      'incoming',
      'committed',
      'damaged',
      'on_hand',
      'quality_control',
      'reserved',
      'safety_stock',
    ],
    providerWrites: 0,
    orderQuantityAdjustment: 0,
  })).digest('hex')
}

function missingScopes(
  grantedScopes: readonly string[],
): string[] {
  return REQUIRED_SCOPES.filter(
    (scope) => !hasEffectiveShopifyScope(grantedScopes, scope),
  )
}

async function shopifyInventoryProviderContext(
  stored: CommerceRuntimeCredentialRecord,
) {
  const credential = decryptCommerceCredential(
    stored.encrypted,
    stored.organizationId,
    stored.provider,
    stored.environment,
    stored.externalAccountId,
  )
  if (credential.provider !== 'shopify') {
    throw new CommerceIntegrationRequestError(
      'Stored Shopify credentials could not be decrypted',
      409,
      'SHOPIFY_INVENTORY_CREDENTIAL_INVALID',
    )
  }
  const shopDomain = normalizeShopifyShopDomain(
    stored.configuration.shopDomain,
  )
  const grant = await requestShopifyAccessToken({
    shopDomain,
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
  })
  const probe = await probeShopifyConnection({
    shopDomain,
    accessToken: grant.accessToken,
  })
  if (probe.shopId !== stored.externalAccountId) {
    throw new CommerceIntegrationRequestError(
      'Shopify returned a different store identity',
      409,
      'SHOPIFY_STORE_IDENTITY_CHANGED',
    )
  }
  const missing = [
    ...new Set([
      ...missingScopes(grant.grantedScopes),
      ...missingScopes(probe.grantedScopes),
    ]),
  ]
  if (missing.length) {
    throw new CommerceIntegrationRequestError(
      `Shopify inventory sync requires ${missing.join(', ')}`,
      409,
      'SHOPIFY_INVENTORY_SCOPE_REQUIRED',
    )
  }
  return {
    credential: {
      shopDomain,
      accessToken: grant.accessToken,
    },
  }
}

async function discoverShopifyInventoryLocations(
  stored: CommerceRuntimeCredentialRecord,
  options: {
    fresh?: boolean
    intentKey: string
    acquiredBy: string
  },
) {
  const cacheKey = [
    stored.organizationId,
    stored.integrationAccountId,
    stored.credentialVersion,
  ].join(':')
  const now = Date.now()
  const cached = locationDiscoveryCache.get(cacheKey)
  if (!options.fresh && cached && cached.expiresAt > now) {
    return cached.locations
  }
  const locations = withCommerceStoreSyncProviderReadFenceInPostgres({
    organizationId: stored.organizationId,
    integrationAccountId: stored.integrationAccountId,
    authorityKind: 'manual_read_only',
    readKind: 'shopify_inventory',
    intentKey: `location-discovery:${options.intentKey}`,
    acquiredBy: options.acquiredBy,
    read: async () => {
      const provider = await shopifyInventoryProviderContext(stored)
      return listShopifyInventoryLocations(provider.credential)
    },
  })
  locationDiscoveryCache.set(cacheKey, {
    expiresAt: now + LOCATION_DISCOVERY_TTL_MS,
    locations,
  })
  if (locationDiscoveryCache.size > 100) {
    const oldest = locationDiscoveryCache.keys().next().value
    if (oldest) locationDiscoveryCache.delete(oldest)
  }
  try {
    return await locations
  } catch (error) {
    if (locationDiscoveryCache.get(cacheKey)?.locations === locations) {
      locationDiscoveryCache.delete(cacheKey)
    }
    throw error
  }
}

function locationMappingEligibility(location: ShopifyInventoryLocation) {
  if (location.isFulfillmentService) {
    return {
      mappingEligible: false,
      mappingIneligibleReason:
        'This location is managed by a Shopify fulfillment service. ClawPilot will not claim another app\'s location.',
    }
  }
  if (!location.isActive) {
    return {
      mappingEligible: false,
      mappingIneligibleReason: 'This Shopify location is inactive.',
    }
  }
  if (!location.shipsInventory) {
    return {
      mappingEligible: false,
      mappingIneligibleReason:
        'This Shopify location is not enabled to ship inventory.',
    }
  }
  if (!location.fulfillsOnlineOrders) {
    return {
      mappingEligible: false,
      mappingIneligibleReason:
        'This Shopify location does not fulfill online orders.',
    }
  }
  return {
    mappingEligible: true,
    mappingIneligibleReason: null,
  }
}

function failureState(error: unknown): 'failed' | 'unknown' {
  if (error instanceof ShopifyCommerceClientError) {
    if (
      error.retryable
      || error.code === 'SHOPIFY_TIMEOUT'
      || error.code === 'SHOPIFY_UPSTREAM_FAILED'
    ) return 'unknown'
    return 'failed'
  }
  if (
    error instanceof CommerceIntegrationRequestError
    || error instanceof CommerceInventoryPersistenceError
  ) return 'failed'
  return 'unknown'
}

function inventoryWithRefreshRecovery<
  T extends Record<string, unknown>,
  R,
>(inventory: T, refreshRecovery: R) {
  return { ...inventory, refreshRecovery }
}

export async function getShopifyInventoryState(input: {
  organizationId: unknown
  accountGlobalId: unknown
  mappingGlobalId?: unknown
  idempotencyKey: unknown
  actorEmail: string
}) {
  try {
    assertShopifyInventoryRuntime()
    const stored = await runtime(input)
    const mappingGlobalId = nullableMappingGlobalId(input.mappingGlobalId)
    const providerLocations = await discoverShopifyInventoryLocations(stored, {
      intentKey: normalizeIdempotencyKey(input.idempotencyKey),
      acquiredBy: input.actorEmail,
    })
    return await inventoryState(stored, {
      mappingGlobalId,
      providerLocations,
    })
  } catch (error) {
    throw inventoryError(error)
  }
}

async function inventoryState(
  stored: CommerceRuntimeCredentialRecord,
  options: {
    mappingGlobalId?: string | null
    providerLocations?: ShopifyInventoryLocation[]
  } = {},
) {
  const [inventory, refreshRecovery, configuration] = await Promise.all([
    readShopifyInventoryStateFromPostgres({
      organizationId: stored.organizationId,
      accountGlobalId: stored.globalId,
      mappingGlobalId: options.mappingGlobalId || null,
    }),
    readShopifyInventoryRefreshRecoveryStateFromPostgres({
      organizationId: stored.organizationId,
      accountGlobalId: stored.globalId,
    }),
    readShopifyInventoryConfigurationFromPostgres({
      organizationId: stored.organizationId,
      integrationAccountId: stored.integrationAccountId,
    }),
  ])
  if (
    options.mappingGlobalId
    && !configuration.mappings.some(
      (mapping) => mapping.globalId === options.mappingGlobalId,
    )
  ) {
    throw new CommerceIntegrationRequestError(
      'The selected Shopify inventory location mapping was not found',
      404,
      'SHOPIFY_INVENTORY_LOCATION_MAPPING_REQUIRED',
    )
  }
  const mappingByExternalLocationId = new Map(
    configuration.mappings
      .filter((mapping) => mapping.active)
      .map((mapping) => [mapping.externalLocationId, mapping]),
  )
  const providerLocations = (options.providerLocations || []).map(
    (location) => ({
      ...location,
      ownershipClassification: location.isFulfillmentService
        ? 'fulfillment_service' as const
        : 'merchant_managed' as const,
      ...locationMappingEligibility(location),
      mappingGlobalId:
        mappingByExternalLocationId.get(location.id)?.globalId || null,
    }),
  )
  return {
    ...inventoryWithRefreshRecovery(inventory, refreshRecovery),
    providerLocations,
    warehouses: configuration.warehouses,
    mappings: configuration.mappings,
    providerWrites: 0 as const,
  }
}

export async function mapShopifyInventoryLocation(input: {
  organizationId: unknown
  accountGlobalId: unknown
  externalLocationId: unknown
  warehouseGlobalId: unknown
  locationGlobalId: unknown
  mappingGlobalId?: unknown
  expectedRowVersion?: unknown
  idempotencyKey: unknown
  actorEmail: string
}) {
  try {
    assertShopifyInventoryRuntime()
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
    const externalLocationId = normalizedGlobalId(
      input.externalLocationId,
      SHOPIFY_LOCATION_ID,
      'Shopify location',
    )
    const warehouseGlobalId = normalizedGlobalId(
      input.warehouseGlobalId,
      WAREHOUSE_GLOBAL_ID,
      'ClawPilot warehouse',
    )
    const locationGlobalId = normalizedGlobalId(
      input.locationGlobalId,
      LOCATION_GLOBAL_ID,
      'ClawPilot inventory location',
    )
    const mappingGlobalId = nullableMappingGlobalId(input.mappingGlobalId)
    const rowVersion = expectedRowVersion(
      input.expectedRowVersion,
      !mappingGlobalId,
    )
    if (
      (mappingGlobalId && rowVersion === null)
      || (!mappingGlobalId && rowVersion !== null)
    ) {
      throw new CommerceIntegrationRequestError(
        'Reload Shopify inventory mappings before saving this location',
        409,
        'SHOPIFY_INVENTORY_LOCATION_MAPPING_CHANGED',
      )
    }
    const stored = await runtime(input)
    const providerLocations = await discoverShopifyInventoryLocations(
      stored,
      {
        fresh: true,
        intentKey: idempotencyKey,
        acquiredBy: input.actorEmail,
      },
    )
    const providerLocation = providerLocations.find(
      (location) => location.id === externalLocationId,
    )
    if (!providerLocation) {
      throw new CommerceIntegrationRequestError(
        'The selected Shopify location is no longer available',
        409,
        'SHOPIFY_INVENTORY_LOCATION_STALE',
      )
    }
    const eligibility = locationMappingEligibility(providerLocation)
    if (!eligibility.mappingEligible) {
      throw new CommerceIntegrationRequestError(
        eligibility.mappingIneligibleReason
          || 'The selected Shopify location cannot be mapped',
        409,
        providerLocation.isFulfillmentService
          ? 'SHOPIFY_INVENTORY_FULFILLMENT_SERVICE_LOCATION_FORBIDDEN'
          : 'SHOPIFY_INVENTORY_LOCATION_INELIGIBLE',
      )
    }
    const result = await mapShopifyInventoryLocationInPostgres({
      runtime: stored,
      providerLocation,
      warehouseGlobalId,
      locationGlobalId,
      expectedMappingGlobalId: mappingGlobalId,
      expectedRowVersion: rowVersion,
      idempotencyKey,
      actorEmail: input.actorEmail,
    })
    const inventory = await inventoryState(stored, {
      mappingGlobalId: result.mapping.globalId,
      providerLocations,
    })
    const mapping = inventory.mappings.find(
      (candidate) => candidate.globalId === result.mapping.globalId,
    )
    if (!mapping) {
      throw new CommerceInventoryPersistenceError(
        'SHOPIFY_INVENTORY_MAPPING_EVIDENCE_INCOMPLETE',
        'The saved Shopify inventory location mapping could not be read back',
        500,
      )
    }
    return {
      ...result,
      mapping,
      inventory,
    }
  } catch (error) {
    throw inventoryError(error)
  }
}

export async function createShopifyInventoryWarehouseAndMap(input: {
  organizationId: unknown
  accountGlobalId: unknown
  externalLocationId: unknown
  warehouse: unknown
  idempotencyKey: unknown
  actorEmail: string
}) {
  try {
    assertShopifyInventoryRuntime()
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
    const externalLocationId = normalizedGlobalId(
      input.externalLocationId,
      SHOPIFY_LOCATION_ID,
      'Shopify location',
    )
    const warehouseInput = warehouseConfiguration(input.warehouse)
    const stored = await runtime(input)
    const providerLocations = await discoverShopifyInventoryLocations(
      stored,
      {
        fresh: true,
        intentKey: idempotencyKey,
        acquiredBy: input.actorEmail,
      },
    )
    const providerLocation = providerLocations.find(
      (location) => location.id === externalLocationId,
    )
    if (!providerLocation) {
      throw new CommerceIntegrationRequestError(
        'The selected Shopify location is no longer available',
        409,
        'SHOPIFY_INVENTORY_LOCATION_STALE',
      )
    }
    const eligibility = locationMappingEligibility(providerLocation)
    if (!eligibility.mappingEligible) {
      throw new CommerceIntegrationRequestError(
        eligibility.mappingIneligibleReason
          || 'The selected Shopify location cannot create a warehouse',
        409,
        providerLocation.isFulfillmentService
          ? 'SHOPIFY_INVENTORY_FULFILLMENT_SERVICE_LOCATION_FORBIDDEN'
          : 'SHOPIFY_INVENTORY_LOCATION_INELIGIBLE',
      )
    }
    const result =
      await createShopifyInventoryWarehouseAndMappingInPostgres({
        runtime: stored,
        providerLocation,
        warehouse: warehouseInput,
        idempotencyKey,
        actorEmail: input.actorEmail,
      })
    const inventory = await inventoryState(stored, {
      mappingGlobalId: result.mapping.globalId,
      providerLocations,
    })
    const mapping = inventory.mappings.find(
      (candidate) => candidate.globalId === result.mapping.globalId,
    )
    const warehouse = inventory.warehouses.find(
      (candidate) => candidate.globalId === result.warehouse.globalId,
    )
    if (!mapping || !warehouse) {
      throw new CommerceInventoryPersistenceError(
        'SHOPIFY_INVENTORY_WAREHOUSE_EVIDENCE_INCOMPLETE',
        'The created warehouse and Shopify inventory mapping could not be read back',
        500,
      )
    }
    return {
      ...result,
      warehouse: {
        globalId: warehouse.globalId,
        code: warehouse.code,
        name: warehouse.name,
      },
      mapping,
      inventory,
    }
  } catch (error) {
    throw inventoryError(error)
  }
}

export async function syncShopifyInventory(input: {
  organizationId: unknown
  accountGlobalId: unknown
  idempotencyKey: unknown
  mappingGlobalId?: unknown
  expectedMappingRowVersion?: unknown
  actorEmail?: string | null
  expectedRefreshFence?: ShopifyInventoryRefreshExpectedFence | null
  onProgress?: (progress: {
    phase: string
    pageCount?: number
  }) => Promise<void>
}) {
  assertShopifyInventoryRuntime()
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
  const actorEmail = input.actorEmail || null
  const mappingGlobalId = nullableMappingGlobalId(input.mappingGlobalId)
  const mappingRowVersion = mappingGlobalId
    ? expectedRowVersion(input.expectedMappingRowVersion)
    : null
  let stored: CommerceRuntimeCredentialRecord | null = null
  let attempt: Awaited<
    ReturnType<typeof prepareShopifyInventoryReadInPostgres>
  > | null = null
  let requestedDirtyVersion = 0
  try {
    stored = await runtime(input)
    if (!input.expectedRefreshFence) {
      requestedDirtyVersion =
        await readShopifyInventoryRefreshDirtyVersionInPostgres({
          organizationId: stored.organizationId,
          integrationAccountId: stored.integrationAccountId,
        })
    }
    const target = await readShopifyInventoryTargetFromPostgres({
      runtime: stored,
      expectedWarehouseId: input.expectedRefreshFence?.warehouseId || null,
      mappingGlobalId,
      expectedMappingRowVersion:
        input.expectedRefreshFence?.locationMappingRowVersion
        ?? mappingRowVersion,
      expectedLocationMappingId:
        input.expectedRefreshFence?.locationMappingId || null,
    })
    if (
      input.expectedRefreshFence?.providerLocationId
      && target.existingMapping?.externalLocationId
        !== input.expectedRefreshFence.providerLocationId
    ) {
      throw new CommerceInventoryPersistenceError(
        'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
        'The automatic Shopify inventory location changed before refresh',
      )
    }
    if (
      input.expectedRefreshFence?.inventoryLocationId
      && target.location.id
        !== input.expectedRefreshFence.inventoryLocationId
    ) {
      throw new CommerceInventoryPersistenceError(
        'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
        'The automatic ClawPilot inventory location changed before refresh',
      )
    }
    if (
      input.expectedRefreshFence?.inventoryPoolId
      && target.existingMapping?.inventoryPoolId
        !== input.expectedRefreshFence.inventoryPoolId
    ) {
      throw new CommerceInventoryPersistenceError(
        'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
        'The automatic inventory pool changed before refresh',
      )
    }
    const providerReadAuthority = input.expectedRefreshFence
      ? 'automatic' as const
      : 'manual_read_only' as const
    const hash = requestHash(stored, target, providerReadAuthority)
    attempt = await prepareShopifyInventoryReadInPostgres({
      runtime: stored,
      target,
      idempotencyKey,
      requestHash: hash,
      actorEmail,
      providerReadAuthority,
    })
    if (attempt.replayed) {
      if (!attempt.runGlobalId) {
        throw new CommerceInventoryPersistenceError(
          'SHOPIFY_INVENTORY_EVIDENCE_INCOMPLETE',
          'The replayed Shopify inventory read has no committed run evidence',
        )
      }
      return {
        replayed: true,
        effectiveIdempotencyKey: attempt.idempotencyKey,
        inventoryRunGlobalId: attempt.runGlobalId,
        inventory: await inventoryState(stored, {
          mappingGlobalId: target.existingMapping?.globalId || null,
        }),
      }
    }
    const progress = async (details: {
      phase: string
      pageCount?: number
    }) => {
      const providerLeaseCurrent =
        await renewShopifyInventoryReadLeaseInPostgres({
          runtime: stored as CommerceRuntimeCredentialRecord,
          attempt: attempt as NonNullable<typeof attempt>,
        })
      if (!providerLeaseCurrent) {
        throw new CommerceInventoryPersistenceError(
          'SHOPIFY_INVENTORY_READ_LEASE_LOST',
          'The Shopify inventory provider-read lease ended during refresh',
        )
      }
      await input.onProgress?.(details)
    }
    await progress({ phase: 'prepared' })
    let capture
    let mappingMethod:
      | 'automatic_single_location'
      | 'automatic_exact_address'
    if (attempt.captured) {
      await progress({ phase: 'captured' })
      capture = await readShopifyInventoryCaptureFromPostgres({
        runtime: stored,
        attempt,
      })
      mappingMethod = addressMatches(
        target.warehouse.address,
        capture.snapshot.location,
      )
        ? 'automatic_exact_address'
        : 'automatic_single_location'
    } else {
      const providerRuntime = stored
      if (!providerRuntime) {
        throw new CommerceInventoryPersistenceError(
          'SHOPIFY_INVENTORY_CONNECTION_REQUIRED',
          'Shopify inventory connection changed before provider read',
        )
      }
      const readAttempt = attempt
      if (!readAttempt) {
        throw new CommerceInventoryPersistenceError(
          'SHOPIFY_INVENTORY_READ_ATTEMPT_REQUIRED',
          'Shopify inventory read attempt evidence is unavailable',
        )
      }
      const providerRead =
        await withCommerceStoreSyncProviderReadFenceInPostgres({
          organizationId: providerRuntime.organizationId,
          integrationAccountId: providerRuntime.integrationAccountId,
          authorityKind: providerReadAuthority,
          readKind: 'shopify_inventory',
          intentKey: `${readAttempt.id}:${readAttempt.leaseToken || 'captured'}`,
          acquiredBy: actorEmail || 'system:shopify-inventory-refresh',
          read: async (providerReadLease) => {
            await progress({ phase: 'credential' })
            const provider = await shopifyInventoryProviderContext(
              providerRuntime,
            )
            await progress({ phase: 'authorized' })
            const locations = await listShopifyInventoryLocations(
              provider.credential,
            )
            await progress({ phase: 'locations' })
            const selected = selectLocation(target, locations)
            const snapshot = await fetchShopifyInventorySnapshot(
              provider.credential,
              selected.location,
              {
                onProgress: async (current) => progress({
                  phase: current.phase,
                  pageCount: current.pageCount,
                }),
              },
            )
            await progress({
              phase: 'snapshot',
              pageCount: snapshot.pageCount,
            })
            const capture = await captureShopifyInventorySnapshotInPostgres({
              runtime: providerRuntime,
              target,
              attempt: readAttempt,
              providerReadLease,
              requestHash: hash,
              snapshot,
              actorEmail,
            })
            return { mappingMethod: selected.method, capture }
          },
        })
      mappingMethod = providerRead.mappingMethod
      capture = providerRead.capture
    }
    const applied = await applyShopifyInventorySnapshotInPostgres({
      runtime: stored,
      target,
      attempt,
      capture,
      providerLocation: capture.snapshot.location,
      mappingMethod,
      idempotencyKey: attempt.idempotencyKey,
      requestHash: hash,
      actorEmail,
      expectedRefreshFence: input.expectedRefreshFence,
    })
    if (
      !input.expectedRefreshFence
      && requestedDirtyVersion > 0
      && !attempt.captured
      && !applied.replayed
    ) {
      const configuration =
        await readShopifyInventoryConfigurationFromPostgres({
          organizationId: stored.organizationId,
          integrationAccountId: stored.integrationAccountId,
        })
      const enabledMappings = configuration.mappings.filter(
        (mapping) => mapping.active && mapping.inventoryImportEnabled,
      )
      if (enabledMappings.length <= 1) {
        await acknowledgeManualShopifyInventoryRefreshInPostgres({
          organizationId: stored.organizationId,
          integrationAccountId: stored.integrationAccountId,
          credentialGeneration: stored.credentialVersion,
          requestedDirtyVersion,
          inventoryRunGlobalId: applied.runGlobalId,
        })
      }
    }
    return {
      replayed: applied.replayed,
      effectiveIdempotencyKey: attempt.idempotencyKey,
      inventoryRunGlobalId: applied.runGlobalId,
      inventory: await inventoryState(stored, {
        mappingGlobalId: target.existingMapping?.globalId || null,
      }),
    }
  } catch (error) {
    const sanitized = inventoryError(error)
    if (stored && attempt && !attempt.replayed) {
      await finalizeShopifyInventoryReadFailureInPostgres({
        runtime: stored,
        attempt,
        state: failureState(error),
        errorCode: sanitized.code,
        actorEmail,
      }).catch(() => undefined)
    }
    throw sanitized
  }
}

export function newShopifyInventoryIdempotencyKey() {
  return `shopify-inventory:${randomUUID()}`
}
