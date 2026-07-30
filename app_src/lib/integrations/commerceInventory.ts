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
  finalizeShopifyInventoryReadFailureInPostgres,
  prepareShopifyInventoryReadInPostgres,
  readShopifyInventoryCaptureFromPostgres,
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

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const REQUIRED_SCOPES = Object.freeze([
  'read_inventory',
  'read_locations',
  'read_products',
] as const satisfies readonly ShopifyAccessScope[])

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

function runtimeLane() {
  return String(
    process.env.CLAWPILOT_ENV
    || process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.VERCEL_ENV
    || process.env.NODE_ENV
    || '',
  ).trim().toLowerCase()
}

export function shopifyInventoryRuntimeAvailable() {
  if (process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED !== '1') return false
  return ['dev', 'development', 'local', 'preview'].includes(runtimeLane())
}

export function assertShopifyInventoryRuntime() {
  if (!shopifyInventoryRuntimeAvailable()) {
    throw new CommerceIntegrationRequestError(
      'Shopify inventory sync is restricted to enabled development environments',
      runtimeLane() === 'production' ? 403 : 404,
      runtimeLane() === 'production'
        ? 'SHOPIFY_INVENTORY_DEVELOPMENT_ONLY'
        : 'SHOPIFY_INVENTORY_DISABLED',
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
  if (
    stored.verificationStatus !== 'verified'
    || stored.status !== 'active'
  ) {
    throw new CommerceIntegrationRequestError(
      'Reconnect and verify Shopify before syncing inventory',
      409,
      'SHOPIFY_INVENTORY_VERIFICATION_REQUIRED',
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
) {
  return createHash('sha256').update(JSON.stringify({
    policyVersion: 'shopify-inventory-atp-v2',
    adapterVersion: SHOPIFY_INVENTORY_ADAPTER_VERSION,
    accountGlobalId: stored.globalId,
    credentialVersion: stored.credentialVersion,
    pipelineId: target.pipelineId,
    warehouseGlobalId: target.warehouse.globalId,
    locationGlobalId: target.location.globalId,
    requiredScopes: REQUIRED_SCOPES,
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

export async function getShopifyInventoryState(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  try {
    assertShopifyInventoryRuntime()
    const stored = await runtime(input)
    return await readShopifyInventoryStateFromPostgres({
      organizationId: stored.organizationId,
      accountGlobalId: stored.globalId,
    })
  } catch (error) {
    throw inventoryError(error)
  }
}

export async function syncShopifyInventory(input: {
  organizationId: unknown
  accountGlobalId: unknown
  idempotencyKey: unknown
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
  let stored: CommerceRuntimeCredentialRecord | null = null
  let attempt: Awaited<
    ReturnType<typeof prepareShopifyInventoryReadInPostgres>
  > | null = null
  try {
    stored = await runtime(input)
    const target = await readShopifyInventoryTargetFromPostgres({
      runtime: stored,
    })
    const hash = requestHash(stored, target)
    attempt = await prepareShopifyInventoryReadInPostgres({
      runtime: stored,
      target,
      idempotencyKey,
      requestHash: hash,
      actorEmail,
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
        inventory: await readShopifyInventoryStateFromPostgres({
          organizationId: stored.organizationId,
          accountGlobalId: stored.globalId,
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
      await progress({ phase: 'credential' })
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
      const providerCredential = {
        shopDomain,
        accessToken: grant.accessToken,
      }
      await progress({ phase: 'authorized' })
      const locations = await listShopifyInventoryLocations(
        providerCredential,
      )
      await progress({ phase: 'locations' })
      const selected = selectLocation(target, locations)
      mappingMethod = selected.method
      const snapshot = await fetchShopifyInventorySnapshot(
        providerCredential,
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
      capture = await captureShopifyInventorySnapshotInPostgres({
        runtime: stored,
        target,
        attempt,
        requestHash: hash,
        snapshot,
        actorEmail,
      })
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
    return {
      replayed: applied.replayed,
      effectiveIdempotencyKey: attempt.idempotencyKey,
      inventoryRunGlobalId: applied.runGlobalId,
      inventory: await readShopifyInventoryStateFromPostgres({
        organizationId: stored.organizationId,
        accountGlobalId: stored.globalId,
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
