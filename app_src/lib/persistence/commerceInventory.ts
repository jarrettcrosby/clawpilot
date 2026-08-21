import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { commerceReadAccountSql } from '@/lib/integrations/commerceReadRuntime'
import { commerceStoreSyncRunningSql } from '@/lib/operations/commerceStoreSync'
import {
  SHOPIFY_INVENTORY_ADAPTER_VERSION,
  type ShopifyInventoryLocation,
  type ShopifyInventorySnapshot,
} from '@/lib/integrations/shopifyInventory'
import {
  projectShopifyInventoryBalance,
} from '@/lib/operations/shopifyInventoryProjection'
import type {
  CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import {
  assertCommerceStoreSyncProviderReadLeaseCurrentWithClient,
  type CommerceStoreSyncProviderReadLease,
} from '@/lib/persistence/commerceStoreSync'

const INVENTORY_POOL_NAME = 'Shopify Available-to-Promise'
const INVENTORY_LOT_CODE = 'SHOPIFY_ATP'
const SYNC_ACTION = 'inventory.levels.read'
const SHOPIFY_LOCATION_ROUTING_LOCK = 'shopify-inventory-location-routing'
const STORE_SYNC_RUNNING_SQL = commerceStoreSyncRunningSql('account')
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
const SHOPIFY_WAREHOUSE_STARTER_LOCATIONS = Object.freeze([
  { code: 'INBOUND', zone: 'INBOUND', type: 'receiving', level: 'zone', storage: 'work_area', sequence: 1, parent: null },
  { code: 'RECEIVE-01', zone: 'INBOUND', type: 'receiving', level: 'dock', storage: 'work_area', sequence: 10, parent: 'INBOUND' },
  { code: 'STAGE-IN-01', zone: 'INBOUND', type: 'staging', level: 'staging', storage: 'staging', sequence: 20, parent: 'INBOUND' },
  { code: 'STORAGE', zone: 'STORAGE', type: 'storage', level: 'zone', storage: 'reserve', sequence: 90, parent: null },
  { code: 'RESERVE-01', zone: 'STORAGE', type: 'storage', level: 'bin', storage: 'reserve', sequence: 100, parent: 'STORAGE' },
  { code: 'FULFILLMENT', zone: 'FULFILLMENT', type: 'pick', level: 'zone', storage: 'work_area', sequence: 190, parent: null },
  { code: 'PICKFACE-01', zone: 'FULFILLMENT', type: 'pick', level: 'bin', storage: 'forward_pick', sequence: 200, parent: 'FULFILLMENT' },
  { code: 'PACK-01', zone: 'FULFILLMENT', type: 'pack', level: 'station', storage: 'work_area', sequence: 300, parent: 'FULFILLMENT' },
  { code: 'OUTBOUND', zone: 'OUTBOUND', type: 'shipping', level: 'zone', storage: 'work_area', sequence: 390, parent: null },
  { code: 'STAGE-OUT-01', zone: 'OUTBOUND', type: 'staging', level: 'staging', storage: 'staging', sequence: 400, parent: 'OUTBOUND' },
  { code: 'SHIP-01', zone: 'OUTBOUND', type: 'shipping', level: 'dock', storage: 'work_area', sequence: 500, parent: 'OUTBOUND' },
  { code: 'RETURNS', zone: 'RETURNS', type: 'returns', level: 'zone', storage: 'work_area', sequence: 590, parent: null },
  { code: 'RETURNS-01', zone: 'RETURNS', type: 'returns', level: 'station', storage: 'work_area', sequence: 600, parent: 'RETURNS' },
])
const SHOPIFY_INVENTORY_READ_ACCOUNT_SQL = commerceReadAccountSql(
  'account',
  { developmentRequiresActive: true },
)

export class CommerceInventoryPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'CommerceInventoryPersistenceError'
  }
}

type ShopifyInventoryProviderReadAuthority =
  | 'automatic'
  | 'manual_read_only'

async function lockShopifyInventoryProviderReadAuthority(
  client: PoolClient,
  runtime: Pick<
    CommerceRuntimeCredentialRecord,
    'organizationId' | 'integrationAccountId'
  >,
  authority: ShopifyInventoryProviderReadAuthority,
) {
  const result = await client.query<{
    effective_reason: string
    activation_state: string
  }>(
    `SELECT operations_commerce_store_sync_effective_reason(
       account.organization_id,
       account.id
     ) AS effective_reason,
       activation.state AS activation_state
     FROM operations_integration_accounts account
     JOIN operations_commerce_store_sync_controls control
       ON control.organization_id = account.organization_id
      AND control.integration_account_id = account.id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     WHERE account.organization_id = $1::uuid
       AND account.id = $2::uuid
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND activation.state NOT IN ('disabled', 'frozen')
       AND (
         $3 = 'manual_read_only'
         OR operations_commerce_store_sync_is_running(
           account.organization_id,
           account.id
         )
       )
     LIMIT 1
     FOR UPDATE OF account, control, activation`,
    [runtime.organizationId, runtime.integrationAccountId, authority],
  )
  if (!result.rows[0]) {
    persistenceError(
      'SHOPIFY_INVENTORY_STORE_SYNC_PAUSED',
      'Store sync is Paused for this Shopify connection',
      409,
    )
  }
  return result.rows[0]
}

type TargetRow = QueryResultRow & {
  integration_account_id: string
  credential_version: number
  verification_status: string
  account_status: string
  pipeline_id: string
  warehouse_id: string
  warehouse_global_id: string
  warehouse_name: string
  warehouse_address: Record<string, unknown>
  location_id: string
  location_global_id: string
  location_code: string
}

type InventoryLocationMappingRow = QueryResultRow & {
  id: string
  global_id: string
  external_location_id: string
  external_location_name: string
  external_location_address: Record<string, unknown>
  warehouse_id: string
  location_id: string
  inventory_pool_id: string
  mapping_method: 'automatic_single_location' | 'automatic_exact_address' | 'manual'
  ownership_classification: 'unknown' | 'merchant_managed' | 'fulfillment_service'
  provider_snapshot_json: Record<string, unknown>
  provider_snapshot_hash: string | null
  provider_observed_at: Date | null
  inventory_import_enabled: boolean
  active: boolean
  row_version: string | number
}

type WarehouseAuthorityRow = QueryResultRow & {
  warehouse_id: string
}

export type ShopifyInventoryTarget = {
  integrationAccountId: string
  credentialVersion: number
  pipelineId: string
  warehouse: {
    id: string
    globalId: string
    name: string
    address: Record<string, unknown>
  }
  location: {
    id: string
    globalId: string
    code: string
  }
  existingMapping: {
    id: string
    globalId: string
    externalLocationId: string
    externalLocationName: string
    rowVersion: number
    inventoryPoolId: string
    ownershipClassification: 'unknown' | 'merchant_managed' | 'fulfillment_service'
  } | null
}

export type ShopifyInventoryAttempt = {
  id: string
  globalId: string
  idempotencyKey: string
  runGlobalId: string | null
  attemptNumber: number
  replayed: boolean
  captured: boolean
  leaseToken: string | null
  providerReadAuthority: ShopifyInventoryProviderReadAuthority
}

export type ShopifyInventoryRefreshExpectedFence = {
  jobId: string
  carrierServiceConfigId: string
  warehouseId: string
  credentialGeneration: number
  activationRevision: number
  configRowVersion: number
  policyRevision: number
  policyHash: string
  inventoryMaxAgeSeconds: number
  requestedDirtyVersion: number
  lockToken: string
  locationMappingId?: string | null
  locationMappingRowVersion?: number | null
  providerLocationId?: string | null
  inventoryLocationId?: string | null
  inventoryPoolId?: string | null
}

export type ShopifyInventoryMappingCommandResult = {
  mapping: {
    globalId: string
    externalLocationId: string
    externalLocationName: string
    ownershipClassification: 'merchant_managed'
    inventoryImportEnabled: true
    rowVersion: number
    warehouseGlobalId: string
    locationGlobalId: string
  }
  providerWrites: 0
  replayed: boolean
}

export type ShopifyInventoryWarehouseMappingCommandResult =
  ShopifyInventoryMappingCommandResult & {
    warehouse: {
      globalId: string
      code: string
      name: string
      facilityType: string
      timezone: string
      inventoryLocationGlobalId: string
      inventoryLocationCode: string
    }
  }

export type ShopifyInventoryCapture = {
  id: string
  globalId: string
  snapshot: ShopifyInventorySnapshot
}

type LevelMappingRow = QueryResultRow & {
  external_inventory_item_id: string
  pipeline_id: string
  product_id: string
  product_global_id: string
  product_name: string
  product_sku: string | null
  mapping_count: string
}

type ExistingPositionRow = QueryResultRow & {
  id: string
  global_id: string
  product_id: string
  on_hand_quantity: string
  reserved_quantity: string
  source_authority: string
}

type LatestRunRow = QueryResultRow & {
  global_id: string
  provider_fetched_at: Date
  completed_at: Date
  provider_location_id: string
  provider_location_name: string
  provider_location: Record<string, unknown> | null
  enrichment: Record<string, unknown> | null
  warehouse_global_id: string
  warehouse_name: string
  location_global_id: string
  location_code: string
  levels_seen: number
  levels_mapped: number
  levels_projected: number
  levels_unmapped: number
  levels_untracked: number
  negative_available_levels: number
  equation_mismatch_levels: number
  provider_available_quantity: string
  provider_committed_quantity: string
  provider_on_hand_quantity: string
  operational_available_quantity: string
  positions_created: number
  positions_updated: number
  positions_zeroed: number
  provider_writes: number
  order_quantity_adjustment: string
  snapshot_hash: string
}

type LatestLevelRow = QueryResultRow & {
  global_id: string
  external_inventory_item_id: string
  sku: string | null
  tracked: boolean
  mapping_state: 'mapped' | 'unmapped'
  projection_state:
    | 'projected'
    | 'unmapped'
    | 'untracked'
    | 'inconsistent'
    | 'negative_available'
  product_global_id: string | null
  product_name: string | null
  provider_available_quantity: string
  provider_incoming_quantity: string
  provider_committed_quantity: string
  provider_damaged_quantity: string
  provider_on_hand_quantity: string
  provider_quality_control_quantity: string
  provider_reserved_quantity: string
  provider_safety_stock_quantity: string
  provider_quantity_evidence: Record<string, unknown>
  operational_available_quantity: string
  equation_matches: boolean
  provider_updated_at: Date | null
  provider_weight_grams: number | null
  provider_dimensions_mm: Record<string, unknown> | null
  product_snapshot: Record<string, unknown>
  inventory_position_global_id: string | null
  operational_on_hand_quantity: string | null
  operational_reserved_quantity: string | null
}

type InventoryWarehouseRow = QueryResultRow & {
  global_id: string
  code: string
  name: string
  address: Record<string, unknown>
  status: 'active'
  location_global_id: string
  location_code: string
  location_zone: string
  location_type: string
  location_active: boolean
}

type InventoryMappingStateRow = QueryResultRow & {
  global_id: string
  external_location_id: string
  external_location_name: string
  external_location_address: Record<string, unknown>
  mapping_method: string
  ownership_classification: 'unknown' | 'merchant_managed' | 'fulfillment_service'
  provider_observed_at: Date | null
  inventory_import_enabled: boolean
  active: boolean
  row_version: string
  warehouse_global_id: string
  warehouse_code: string
  warehouse_name: string
  location_global_id: string
  location_code: string
  location_zone: string
  location_type: string
  run_global_id: string | null
  provider_fetched_at: Date | null
  completed_at: Date | null
  provider_location_id: string | null
  provider_location_name: string | null
  levels_seen: number | null
  levels_mapped: number | null
  levels_projected: number | null
  levels_unmapped: number | null
  levels_untracked: number | null
  operational_available_quantity: string | null
  positions_created: number | null
  positions_updated: number | null
  positions_zeroed: number | null
  provider_writes: number | null
  order_quantity_adjustment: string | null
}

function decimal(value: string | number | null | undefined): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null
}

function nonNegativeInteger(
  value: string | number | null | undefined,
  code = 'SHOPIFY_INVENTORY_MAPPING_VERSION_INVALID',
): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    persistenceError(
      code,
      'The Shopify inventory mapping row version is invalid',
      409,
    )
  }
  return parsed
}

function persistenceError(
  code: string,
  message: string,
  status = 409,
): never {
  throw new CommerceInventoryPersistenceError(code, message, status)
}

function isProjectionTargetUniqueViolation(error: unknown): boolean {
  const postgresError = error as { code?: unknown; constraint?: unknown }
  return postgresError?.code === '23505'
    && postgresError?.constraint
      === 'idx_operations_commerce_inventory_active_projection_target'
}

export async function readShopifyInventoryTargetFromPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  expectedWarehouseId?: string | null
  mappingGlobalId?: string | null
  expectedMappingRowVersion?: number | null
  expectedLocationMappingId?: string | null
}): Promise<ShopifyInventoryTarget> {
  const mapping = await query<InventoryLocationMappingRow>(
    `SELECT mapping.id::text, mapping.global_id,
            mapping.external_location_id,
            mapping.external_location_name,
            mapping.external_location_address,
            mapping.warehouse_id::text,
            mapping.location_id::text,
            mapping.inventory_pool_id::text,
            mapping.mapping_method,
            mapping.ownership_classification,
            mapping.provider_snapshot_json,
            mapping.provider_snapshot_hash,
            mapping.provider_observed_at,
            mapping.inventory_import_enabled,
            mapping.active,
            mapping.row_version::text
     FROM operations_commerce_inventory_location_mappings mapping
     WHERE mapping.organization_id = $1::uuid
       AND mapping.integration_account_id = $2::uuid
       AND mapping.active = true
       AND mapping.inventory_import_enabled = true
       AND ($3::text IS NULL OR mapping.global_id = $3)
       AND ($4::uuid IS NULL OR mapping.id = $4::uuid)
       AND ($5::uuid IS NULL OR mapping.warehouse_id = $5::uuid)
     ORDER BY mapping.id
     LIMIT 2`,
    [
      input.runtime.organizationId,
      input.runtime.integrationAccountId,
      input.mappingGlobalId || null,
      input.expectedLocationMappingId || null,
      input.expectedWarehouseId || null,
    ],
  )
  if (mapping.rows.length > 1) {
    persistenceError(
      'SHOPIFY_INVENTORY_LOCATION_MAPPING_AMBIGUOUS',
      'Choose the Shopify inventory location to synchronize',
    )
  }
  const existingMapping = mapping.rows[0] || null
  const exactMappingRequested = Boolean(
    input.mappingGlobalId || input.expectedLocationMappingId,
  )
  if (exactMappingRequested && !existingMapping) {
    persistenceError(
      'SHOPIFY_INVENTORY_LOCATION_MAPPING_CHANGED',
      'The selected Shopify inventory location mapping is no longer active',
    )
  }
  if (
    existingMapping
    && input.expectedMappingRowVersion !== undefined
    && input.expectedMappingRowVersion !== null
    && nonNegativeInteger(existingMapping.row_version ?? 0)
      !== input.expectedMappingRowVersion
  ) {
    persistenceError(
      'SHOPIFY_INVENTORY_LOCATION_MAPPING_CHANGED',
      'The selected Shopify inventory location mapping changed. Reload before synchronizing.',
    )
  }
  if (existingMapping?.ownership_classification === 'fulfillment_service') {
    persistenceError(
      'SHOPIFY_INVENTORY_FULFILLMENT_SERVICE_LOCATION_FORBIDDEN',
      'Inventory owned by another Shopify fulfillment service cannot be mapped as a ClawPilot warehouse',
      409,
    )
  }
  const configuredWarehouses = await query<WarehouseAuthorityRow>(
    `SELECT DISTINCT config.warehouse_id::text AS warehouse_id
     FROM operations_shopify_carrier_service_configs config
     WHERE config.organization_id = $1::uuid
       AND config.integration_account_id = $2::uuid
       AND config.registration_state IN ('shadow_simulated', 'registered')
     ORDER BY config.warehouse_id::text
     LIMIT 2`,
    [input.runtime.organizationId, input.runtime.integrationAccountId],
  )
  if (configuredWarehouses.rows.length > 1 && !exactMappingRequested) {
    persistenceError(
      'SHOPIFY_INVENTORY_CARRIER_CONFIG_AMBIGUOUS',
      'More than one active Shopify carrier-service warehouse requires review',
    )
  }
  const configuredWarehouseId =
    configuredWarehouses.rows[0]?.warehouse_id || null
  const expectedWarehouseId = input.expectedWarehouseId || null
  if (expectedWarehouseId) {
    if (
      (existingMapping
        && existingMapping.warehouse_id !== expectedWarehouseId)
      || (configuredWarehouseId
        && !input.expectedLocationMappingId
        && configuredWarehouseId !== expectedWarehouseId)
    ) {
      persistenceError(
        'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
        'The inventory refresh warehouse no longer matches current Shopify inventory authority',
      )
    }
  } else if (
    !exactMappingRequested
    &&
    existingMapping
    && configuredWarehouseId
    && existingMapping.warehouse_id !== configuredWarehouseId
  ) {
    persistenceError(
      'SHOPIFY_INVENTORY_WAREHOUSE_AUTHORITY_CONFLICT',
      'The saved Shopify inventory mapping and carrier-service configuration target different warehouses',
    )
  }

  let warehouseId = expectedWarehouseId
    || existingMapping?.warehouse_id
    || configuredWarehouseId
    || null
  if (!warehouseId) {
    const activeWarehouses = await query<WarehouseAuthorityRow>(
      `SELECT warehouse.id::text AS warehouse_id
       FROM operations_warehouses warehouse
       WHERE warehouse.organization_id = $1::uuid
         AND warehouse.status = 'active'
       ORDER BY warehouse.id
       LIMIT 2`,
      [input.runtime.organizationId],
    )
    if (activeWarehouses.rows.length > 1) {
      persistenceError(
        'SHOPIFY_INVENTORY_SINGLE_WAREHOUSE_REQUIRED',
        'Choose a Shopify inventory warehouse before syncing inventory in a multi-warehouse workspace',
      )
    }
    warehouseId = activeWarehouses.rows[0]?.warehouse_id || null
  }
  if (!warehouseId) {
    persistenceError(
      'SHOPIFY_INVENTORY_TARGET_REQUIRED',
      'Configure an active Operations warehouse and reserve or storage location before syncing Shopify inventory',
    )
  }

  const target = await query<TargetRow>(
    `WITH selected_location AS (
       SELECT location.id, location.global_id, location.code
       FROM operations_locations location
       WHERE location.organization_id = $1::uuid
         AND location.warehouse_id = $3::uuid
         AND location.active = true
         AND ($4::uuid IS NULL OR location.id = $4::uuid)
       ORDER BY
         CASE
           WHEN location.code = 'RESERVE-01' THEN 0
           WHEN location.location_type = 'storage' THEN 1
           WHEN location.location_type = 'pick' THEN 2
           ELSE 3
         END,
         location.pick_sequence,
         location.id
       LIMIT 1
     )
     SELECT
       account.id::text AS integration_account_id,
       credential.credential_version,
       credential.verification_status,
       account.status AS account_status,
       activation.data_pipeline_id::text AS pipeline_id,
       warehouse.id::text AS warehouse_id,
       warehouse.global_id AS warehouse_global_id,
       warehouse.name AS warehouse_name,
       warehouse.address AS warehouse_address,
       location.id::text AS location_id,
       location.global_id AS location_global_id,
       location.code AS location_code
     FROM operations_integration_accounts account
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
      AND credential.credential_version =
          account.commerce_credential_generation
     JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = account.organization_id
      AND warehouse.id = $3::uuid
      AND warehouse.status = 'active'
     CROSS JOIN selected_location location
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
     LIMIT 1`,
    [
      input.runtime.organizationId,
      input.runtime.globalId,
      warehouseId,
      existingMapping?.location_id || null,
    ],
  )
  const row = target.rows[0]
  if (!row) {
    if (expectedWarehouseId) {
      persistenceError(
        'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
        'The inventory refresh warehouse or mapped location is no longer active',
      )
    }
    persistenceError(
      'SHOPIFY_INVENTORY_TARGET_REQUIRED',
      'Configure Operations activation and an active reserve or storage location before syncing Shopify inventory',
    )
  }
  if (
    row.credential_version !== input.runtime.credentialVersion
    || row.verification_status !== 'verified'
    || row.account_status !== 'active'
  ) {
    persistenceError(
      'SHOPIFY_INVENTORY_CONNECTION_STALE',
      'Reconnect and verify Shopify before syncing inventory',
    )
  }
  return {
    integrationAccountId: row.integration_account_id,
    credentialVersion: row.credential_version,
    pipelineId: row.pipeline_id,
    warehouse: {
      id: row.warehouse_id,
      globalId: row.warehouse_global_id,
      name: row.warehouse_name,
      address: row.warehouse_address || {},
    },
    location: {
      id: row.location_id,
      globalId: row.location_global_id,
      code: row.location_code,
    },
    existingMapping: existingMapping
      ? {
          id: existingMapping.id,
          globalId: existingMapping.global_id,
          externalLocationId: existingMapping.external_location_id,
          externalLocationName: existingMapping.external_location_name,
          rowVersion: nonNegativeInteger(existingMapping.row_version ?? 0),
          inventoryPoolId: existingMapping.inventory_pool_id,
          ownershipClassification:
            existingMapping.ownership_classification || 'unknown',
        }
      : null,
  }
}

export async function prepareShopifyInventoryReadInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  target: ShopifyInventoryTarget
  idempotencyKey: string
  requestHash: string
  actorEmail: string | null
  providerReadAuthority: ShopifyInventoryProviderReadAuthority
}): Promise<ShopifyInventoryAttempt> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      [
        'shopify-inventory-read',
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
      ].join(':'),
    )
    const capturedAttemptLease = async (attempt: {
      id: string
      request_hash: string
      lease_token: string | null
      lease_expires_at: Date | null
      lease_is_live: boolean
    }) => {
      if (attempt.lease_is_live && attempt.lease_token) {
        return attempt.lease_token
      }
      const reacquired = await client.query<{ lease_token: string }>(
        `UPDATE operations_commerce_provider_attempts attempt
         SET lease_token = gen_random_uuid(),
             lease_expires_at =
               clock_timestamp() + interval '15 minutes'
         WHERE attempt.organization_id = $1::uuid
           AND attempt.integration_account_id = $2::uuid
           AND attempt.id = $3::uuid
           AND attempt.action = $4
           AND attempt.request_hash = $5
           AND attempt.state = 'prepared'
           AND attempt.lease_token IS NOT NULL
           AND attempt.lease_expires_at IS NOT NULL
           AND attempt.lease_expires_at <= clock_timestamp()
           AND EXISTS (
             SELECT 1
             FROM operations_commerce_inventory_captures capture
             WHERE capture.organization_id = attempt.organization_id
               AND capture.integration_account_id =
                   attempt.integration_account_id
               AND capture.provider_attempt_id = attempt.id
               AND capture.request_hash = attempt.request_hash
           )
         RETURNING attempt.lease_token::text`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          attempt.id,
          SYNC_ACTION,
          attempt.request_hash,
        ],
      )
      if (!reacquired.rows[0]?.lease_token) {
        persistenceError(
          'SHOPIFY_INVENTORY_CAPTURE_LEASE_REACQUIRE_FAILED',
          'The captured Shopify inventory response could not reacquire its projection lease',
          409,
        )
      }
      return reacquired.rows[0].lease_token
    }
    const previous = await client.query<{
      id: string
      global_id: string
      idempotency_key: string
      attempt_number: number
      request_hash: string
      state: string
      lease_token: string | null
      lease_expires_at: Date | null
      lease_is_live: boolean
      captured: boolean
    }>(
      `SELECT attempt.id::text, attempt.global_id, attempt.idempotency_key,
              attempt.attempt_number, attempt.request_hash, attempt.state,
              attempt.lease_token::text, attempt.lease_expires_at,
              (
                attempt.lease_token IS NOT NULL
                AND attempt.lease_expires_at IS NOT NULL
                AND attempt.lease_expires_at > clock_timestamp()
              ) AS lease_is_live,
              EXISTS (
                SELECT 1
                FROM operations_commerce_inventory_captures capture
                WHERE capture.organization_id = attempt.organization_id
                  AND capture.integration_account_id =
                      attempt.integration_account_id
                  AND capture.provider_attempt_id = attempt.id
              ) AS captured
       FROM operations_commerce_provider_attempts attempt
       WHERE attempt.organization_id = $1::uuid
         AND attempt.integration_account_id = $2::uuid
         AND attempt.action = $3
         AND attempt.idempotency_key = $4
       ORDER BY attempt.attempt_number DESC
       LIMIT 1
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        SYNC_ACTION,
        input.idempotencyKey,
      ],
    )
    const latest = previous.rows[0]
    if (latest && latest.request_hash !== input.requestHash) {
      persistenceError(
        'SHOPIFY_INVENTORY_IDEMPOTENCY_CONFLICT',
        'Inventory sync idempotency key was reused for different inputs',
      )
    }
    if (latest?.state === 'succeeded') {
      const run = await client.query<{
        global_id: string
        idempotency_key: string
      }>(
        `SELECT global_id, idempotency_key
         FROM operations_commerce_inventory_sync_runs
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND provider_attempt_id = $3::uuid
           AND warehouse_id = $4::uuid
           AND status = 'succeeded'
         LIMIT 1`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          latest.id,
          input.target.warehouse.id,
        ],
      )
      if (!run.rows[0]) {
        persistenceError(
          'SHOPIFY_INVENTORY_EVIDENCE_INCOMPLETE',
          'The prior provider read succeeded without a committed inventory snapshot',
          500,
        )
      }
      return {
        id: latest.id,
        globalId: latest.global_id,
        idempotencyKey: run.rows[0].idempotency_key,
        runGlobalId: run.rows[0].global_id,
        attemptNumber: latest.attempt_number,
        replayed: true,
        captured: true,
        leaseToken: null,
        providerReadAuthority: input.providerReadAuthority,
      }
    }
    await lockShopifyInventoryProviderReadAuthority(
      client,
      input.runtime,
      input.providerReadAuthority,
    )
    if (latest?.state === 'prepared') {
      if (latest.captured) {
        const leaseToken = await capturedAttemptLease(latest)
        return {
          id: latest.id,
          globalId: latest.global_id,
          idempotencyKey: latest.idempotency_key,
          runGlobalId: null,
          attemptNumber: latest.attempt_number,
          replayed: false,
          captured: true,
          leaseToken,
          providerReadAuthority: input.providerReadAuthority,
        }
      }
      if (latest.lease_is_live) {
        persistenceError(
          'SHOPIFY_INVENTORY_SYNC_IN_PROGRESS',
          'This Shopify inventory sync is already in progress',
        )
      }
      const expired = await client.query(
        `UPDATE operations_commerce_provider_attempts
         SET state = 'unknown',
             redacted_response = $4::jsonb,
             error_code = 'SHOPIFY_INVENTORY_READ_LEASE_EXPIRED',
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND id = $3::uuid
           AND state = 'prepared'
           AND lease_token = $5::uuid
           AND lease_expires_at <= clock_timestamp()
         RETURNING id`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          latest.id,
          JSON.stringify({
            inventoryApplied: false,
            providerWrites: 0,
            orderQuantityAdjustment: 0,
          }),
          latest.lease_token,
        ],
      )
      if (!expired.rowCount) {
        persistenceError(
          'SHOPIFY_INVENTORY_SYNC_IN_PROGRESS',
          'This Shopify inventory sync is already in progress',
        )
      }
    }
    const concurrent = await client.query<{
      id: string
      global_id: string
      idempotency_key: string
      attempt_number: number
      request_hash: string
      lease_token: string | null
      lease_expires_at: Date | null
      lease_is_live: boolean
      captured: boolean
    }>(
      `SELECT attempt.id::text, attempt.global_id,
              attempt.idempotency_key, attempt.attempt_number,
              attempt.request_hash, attempt.lease_token::text,
              attempt.lease_expires_at,
              (
                attempt.lease_token IS NOT NULL
                AND attempt.lease_expires_at IS NOT NULL
                AND attempt.lease_expires_at > clock_timestamp()
              ) AS lease_is_live,
              EXISTS (
                SELECT 1
                FROM operations_commerce_inventory_captures capture
                WHERE capture.organization_id = attempt.organization_id
                  AND capture.integration_account_id =
                      attempt.integration_account_id
                  AND capture.provider_attempt_id = attempt.id
              ) AS captured
       FROM operations_commerce_provider_attempts attempt
       WHERE attempt.organization_id = $1::uuid
         AND attempt.integration_account_id = $2::uuid
         AND attempt.action = $3
         AND attempt.state = 'prepared'
       ORDER BY attempt.requested_at DESC, attempt.id DESC
       LIMIT 1
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        SYNC_ACTION,
      ],
    )
    const active = concurrent.rows[0]
    if (active) {
      if (active.captured && active.request_hash === input.requestHash) {
        const leaseToken = await capturedAttemptLease(active)
        return {
          id: active.id,
          globalId: active.global_id,
          idempotencyKey: active.idempotency_key,
          runGlobalId: null,
          attemptNumber: active.attempt_number,
          replayed: false,
          captured: true,
          leaseToken,
          providerReadAuthority: input.providerReadAuthority,
        }
      }
      if (active.lease_is_live) {
        persistenceError(
          'SHOPIFY_INVENTORY_SYNC_IN_PROGRESS',
          'Another Shopify inventory sync is already in progress',
        )
      }
      const expired = await client.query(
        `UPDATE operations_commerce_provider_attempts
         SET state = 'unknown',
             redacted_response = $4::jsonb,
             error_code = $5,
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND id = $3::uuid
           AND state = 'prepared'
           AND lease_token = $6::uuid
           AND lease_expires_at <= clock_timestamp()
         RETURNING id`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          active.id,
          JSON.stringify({
            inventoryApplied: false,
            providerWrites: 0,
            orderQuantityAdjustment: 0,
          }),
          active.captured
            ? 'SHOPIFY_INVENTORY_CAPTURE_FENCE_CHANGED'
            : 'SHOPIFY_INVENTORY_READ_LEASE_EXPIRED',
          active.lease_token,
        ],
      )
      if (!expired.rowCount) {
        persistenceError(
          'SHOPIFY_INVENTORY_SYNC_IN_PROGRESS',
          'Another Shopify inventory sync is already in progress',
        )
      }
    }
    const attemptNumber = (latest?.attempt_number || 0) + 1
    const inserted = await client.query<{
      id: string
      global_id: string
      lease_token: string
    }>(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         lease_token, lease_expires_at, requested_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
         $8::jsonb, '{}'::jsonb, 'prepared', $9, gen_random_uuid(),
         now() + interval '15 minutes', now(), $10
       )
       RETURNING id::text, global_id, lease_token::text`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        SYNC_ACTION,
        SHOPIFY_INVENTORY_ADAPTER_VERSION,
        input.target.existingMapping?.externalLocationId || null,
        input.idempotencyKey,
        input.requestHash,
        JSON.stringify({
          credentialVersion: input.runtime.credentialVersion,
          warehouseGlobalId: input.target.warehouse.globalId,
          locationGlobalId: input.target.location.globalId,
          providerWrites: 0,
          orderQuantityAdjustment: 0,
          readOnly: true,
          providerReadAuthority: input.providerReadAuthority,
        }),
        attemptNumber,
        input.actorEmail,
      ],
    )
    return {
      id: inserted.rows[0].id,
      globalId: inserted.rows[0].global_id,
      idempotencyKey: input.idempotencyKey,
      runGlobalId: null,
      attemptNumber,
      replayed: false,
      captured: false,
      leaseToken: inserted.rows[0].lease_token,
      providerReadAuthority: input.providerReadAuthority,
    }
  })
}

function capturedSnapshot(value: unknown): ShopifyInventorySnapshot {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof (value as { snapshotHash?: unknown }).snapshotHash !== 'string'
    || !Array.isArray((value as { levels?: unknown }).levels)
  ) {
    persistenceError(
      'SHOPIFY_INVENTORY_CAPTURE_INVALID',
      'The durable Shopify inventory capture is invalid',
      500,
    )
  }
  return value as ShopifyInventorySnapshot
}

export function inventorySnapshotContent(
  snapshot: ShopifyInventorySnapshot,
): Omit<ShopifyInventorySnapshot, 'fetchedAt' | 'pageCount'> {
  return {
    location: snapshot.location,
    levels: [...snapshot.levels].sort((left, right) => (
      left.inventoryItemId.localeCompare(right.inventoryItemId)
    )),
    enrichment: snapshot.enrichment,
    snapshotHash: snapshot.snapshotHash,
  }
}

export function capturedSnapshotFromStorage(input: {
  capturedSnapshot: unknown
  snapshotContent: unknown
  providerFetchedAt: Date | string
  providerPageCount: number | null
}) {
  if (input.capturedSnapshot) return capturedSnapshot(input.capturedSnapshot)
  if (
    !input.snapshotContent
    || typeof input.snapshotContent !== 'object'
    || Array.isArray(input.snapshotContent)
  ) {
    return capturedSnapshot(input.snapshotContent)
  }
  return capturedSnapshot({
    ...input.snapshotContent,
    fetchedAt: new Date(input.providerFetchedAt).toISOString(),
    pageCount: input.providerPageCount,
  })
}

export async function readShopifyInventoryCaptureFromPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  attempt: ShopifyInventoryAttempt
}): Promise<ShopifyInventoryCapture> {
  const result = await query<{
    id: string
    global_id: string
    captured_snapshot: unknown
    snapshot_content: unknown
    provider_fetched_at: Date | string
    provider_page_count: number | null
  }>(
    `SELECT capture.id::text, capture.global_id,
            capture.captured_snapshot, content.snapshot_content,
            capture.provider_fetched_at, capture.provider_page_count
     FROM operations_commerce_inventory_captures capture
     LEFT JOIN operations_commerce_inventory_snapshot_contents content
       ON content.organization_id = capture.organization_id
      AND content.integration_account_id = capture.integration_account_id
      AND content.id = capture.snapshot_content_id
     WHERE capture.organization_id = $1::uuid
       AND capture.integration_account_id = $2::uuid
       AND capture.provider_attempt_id = $3::uuid
     LIMIT 1`,
    [
      input.runtime.organizationId,
      input.runtime.integrationAccountId,
      input.attempt.id,
    ],
  )
  const row = result.rows[0]
  if (!row) {
    persistenceError(
      'SHOPIFY_INVENTORY_CAPTURE_REQUIRED',
      'The durable Shopify inventory capture is missing',
      409,
    )
  }
  return {
    id: row.id,
    globalId: row.global_id,
    snapshot: capturedSnapshotFromStorage({
      capturedSnapshot: row.captured_snapshot,
      snapshotContent: row.snapshot_content,
      providerFetchedAt: row.provider_fetched_at,
      providerPageCount: row.provider_page_count,
    }),
  }
}

export async function captureShopifyInventorySnapshotInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  target: ShopifyInventoryTarget
  attempt: ShopifyInventoryAttempt
  requestHash: string
  snapshot: ShopifyInventorySnapshot
  actorEmail: string | null
  providerReadLease: CommerceStoreSyncProviderReadLease
}): Promise<ShopifyInventoryCapture> {
  if (!input.attempt.leaseToken) {
    persistenceError(
      'SHOPIFY_INVENTORY_READ_LEASE_REQUIRED',
      'The Shopify inventory provider read no longer owns its durable lease',
      409,
    )
  }
  const serialized = JSON.stringify(input.snapshot)
  const snapshotBytes = Buffer.byteLength(serialized, 'utf8')
  const content = inventorySnapshotContent(input.snapshot)
  const serializedContent = JSON.stringify(content)
  const contentBytes = Buffer.byteLength(serializedContent, 'utf8')
  if (snapshotBytes < 2 || snapshotBytes > 16 * 1024 * 1024) {
    persistenceError(
      'SHOPIFY_INVENTORY_CAPTURE_SIZE_INVALID',
      'The Shopify inventory capture exceeds the 16 MB evidence limit',
      413,
    )
  }
  return withTransaction(async (client) => {
    await assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(client, {
      organizationId: input.runtime.organizationId,
      integrationAccountId: input.runtime.integrationAccountId,
      lease: input.providerReadLease,
      authorityKind: input.attempt.providerReadAuthority,
      readKind: 'shopify_inventory',
    })
    await acquireTransactionAdvisoryLock(
      client,
      [
        'shopify-inventory-capture',
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.attempt.id,
      ].join(':'),
    )
    const existing = await client.query<{
      id: string
      global_id: string
      request_hash: string
      snapshot_hash: string
      captured_snapshot: unknown
      snapshot_content: unknown
      provider_fetched_at: Date | string
      provider_page_count: number | null
    }>(
      `SELECT capture.id::text, capture.global_id,
              capture.request_hash, capture.snapshot_hash,
              capture.captured_snapshot, content.snapshot_content,
              capture.provider_fetched_at, capture.provider_page_count
       FROM operations_commerce_inventory_captures capture
       LEFT JOIN operations_commerce_inventory_snapshot_contents content
         ON content.organization_id = capture.organization_id
        AND content.integration_account_id = capture.integration_account_id
        AND content.id = capture.snapshot_content_id
       WHERE capture.organization_id = $1::uuid
         AND capture.integration_account_id = $2::uuid
         AND capture.provider_attempt_id = $3::uuid
       LIMIT 1`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.attempt.id,
      ],
    )
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (
        row.request_hash !== input.requestHash
        || row.snapshot_hash !== input.snapshot.snapshotHash
      ) {
        persistenceError(
          'SHOPIFY_INVENTORY_CAPTURE_CONFLICT',
          'The provider attempt already captured different Shopify inventory evidence',
          409,
        )
      }
      return {
        id: row.id,
        globalId: row.global_id,
        snapshot: capturedSnapshotFromStorage({
          capturedSnapshot: row.captured_snapshot,
          snapshotContent: row.snapshot_content,
          providerFetchedAt: row.provider_fetched_at,
          providerPageCount: row.provider_page_count,
        }),
      }
    }
    await lockShopifyInventoryProviderReadAuthority(
      client,
      input.runtime,
      input.attempt.providerReadAuthority,
    )
    const lease = await client.query<{ provider_read_authority: string }>(
      `SELECT id,
              redacted_request->>'providerReadAuthority'
                AS provider_read_authority
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND action = $4
         AND request_hash = $5
         AND state = 'prepared'
         AND lease_token = $6::uuid
         AND lease_expires_at > clock_timestamp()
       LIMIT 1
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.attempt.id,
        SYNC_ACTION,
        input.requestHash,
        input.attempt.leaseToken,
      ],
    )
    if (!lease.rowCount) {
      persistenceError(
        'SHOPIFY_INVENTORY_READ_LEASE_LOST',
        'The Shopify inventory response arrived after its durable lease ended',
        409,
      )
    }
    if (lease.rows[0]?.provider_read_authority
        !== input.attempt.providerReadAuthority) {
      persistenceError(
        'SHOPIFY_INVENTORY_READ_AUTHORITY_INVALID',
        'The durable Shopify inventory read authority does not match this capture',
        409,
      )
    }
    await client.query(
      `INSERT INTO operations_commerce_inventory_snapshot_contents (
         organization_id, integration_account_id, provider, adapter_version,
         provider_location_id, snapshot_hash, level_count,
         snapshot_content, content_bytes, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', $3, $4, $5, $6,
         $7::jsonb, $8, $9
       )
       ON CONFLICT (
         organization_id, integration_account_id, provider_location_id,
         adapter_version, snapshot_hash
       ) DO NOTHING`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        SHOPIFY_INVENTORY_ADAPTER_VERSION,
        input.snapshot.location.id,
        input.snapshot.snapshotHash,
        input.snapshot.levels.length,
        serializedContent,
        contentBytes,
        input.actorEmail,
      ],
    )
    const storedContent = await client.query<{ id: string }>(
      `SELECT id::text
       FROM operations_commerce_inventory_snapshot_contents
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND provider = 'shopify'
         AND adapter_version = $3
         AND provider_location_id = $4
         AND snapshot_hash = $5
         AND level_count = $6
         AND snapshot_content = $7::jsonb
         AND content_bytes = $8
       LIMIT 1`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        SHOPIFY_INVENTORY_ADAPTER_VERSION,
        input.snapshot.location.id,
        input.snapshot.snapshotHash,
        input.snapshot.levels.length,
        serializedContent,
        contentBytes,
      ],
    )
    if (!storedContent.rows[0]) {
      persistenceError(
        'SHOPIFY_INVENTORY_SNAPSHOT_HASH_CONFLICT',
        'The Shopify inventory snapshot hash matched different durable content',
        409,
      )
    }
    const inserted = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO operations_commerce_inventory_captures (
         organization_id, integration_account_id, provider_attempt_id,
         warehouse_id, location_id, provider, adapter_version,
         credential_version, request_hash, snapshot_hash,
         provider_location_id, provider_fetched_at, level_count,
         captured_snapshot, snapshot_content_id, provider_page_count,
         snapshot_bytes, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'shopify',
         $6, $7, $8, $9, $10, $11::timestamptz, $12, $13::jsonb,
         $14::uuid, $15, $16, $17
       )
       RETURNING id::text, global_id`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.attempt.id,
        input.target.warehouse.id,
        input.target.location.id,
        SHOPIFY_INVENTORY_ADAPTER_VERSION,
        input.runtime.credentialVersion,
        input.requestHash,
        input.snapshot.snapshotHash,
        input.snapshot.location.id,
        input.snapshot.fetchedAt,
        input.snapshot.levels.length,
        null,
        storedContent.rows[0].id,
        input.snapshot.pageCount,
        snapshotBytes,
        input.actorEmail,
      ],
    )
    return {
      id: inserted.rows[0].id,
      globalId: inserted.rows[0].global_id,
      snapshot: input.snapshot,
    }
  })
}

export async function finalizeShopifyInventoryReadFailureInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  attempt: ShopifyInventoryAttempt
  state: 'failed' | 'unknown'
  errorCode: string
  actorEmail: string | null
}) {
  const finalized = await withTransaction(async (client) => {
    const finalized = await client.query(
      `UPDATE operations_commerce_provider_attempts
       SET state = $4,
           redacted_response = $5::jsonb,
           error_code = $6,
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND state = 'prepared'
         AND lease_token = $7::uuid
         AND lease_expires_at > clock_timestamp()
       RETURNING id`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.attempt.id,
        input.state,
        JSON.stringify({
          inventoryApplied: false,
          providerWrites: 0,
          orderQuantityAdjustment: 0,
        }),
        input.errorCode,
        input.attempt.leaseToken,
      ],
    )
    return Boolean(finalized.rowCount)
  })
  if (!finalized) return false
  await recordAuditEvent({
    actor: input.actorEmail || 'system',
    eventType: 'commerce.inventory.sync_failed',
    aggregateType: 'operations.integration_account',
    aggregateId: input.runtime.globalId,
    organizationId: input.runtime.organizationId,
    isSystem: !input.actorEmail,
    eventKey:
      `commerce-inventory:${input.attempt.globalId}:${input.state}`,
    payload: {
      attemptGlobalId: input.attempt.globalId,
      errorCode: input.errorCode,
      providerWrites: 0,
      orderQuantityAdjustment: 0,
    },
  })
  return true
}

export async function renewShopifyInventoryReadLeaseInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  attempt: ShopifyInventoryAttempt
}) {
  if (!input.attempt.leaseToken) return false
  const renewed = await query(
    `UPDATE operations_commerce_provider_attempts
     SET lease_expires_at =
           clock_timestamp() + interval '15 minutes'
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND id = $3::uuid
       AND action = $4
       AND state = 'prepared'
       AND lease_token = $5::uuid
       AND lease_expires_at > clock_timestamp()
       AND redacted_request->>'providerReadAuthority' = $6
       AND EXISTS (
         SELECT 1
         FROM operations_integration_accounts account
         JOIN operations_commerce_store_sync_controls control
           ON control.organization_id = account.organization_id
          AND control.integration_account_id = account.id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
         WHERE account.organization_id =
                 operations_commerce_provider_attempts.organization_id
           AND account.id =
                 operations_commerce_provider_attempts.integration_account_id
           AND activation.state NOT IN ('disabled', 'frozen')
           AND (
             $6 = 'manual_read_only'
             OR operations_commerce_store_sync_is_running(
               account.organization_id,
               account.id
             )
           )
       )
     RETURNING id`,
    [
      input.runtime.organizationId,
      input.runtime.integrationAccountId,
      input.attempt.id,
      SYNC_ACTION,
      input.attempt.leaseToken,
      input.attempt.providerReadAuthority,
    ],
  )
  return renewed.rowCount === 1
}

function safeSum(
  snapshot: ShopifyInventorySnapshot,
  selector: (level: ShopifyInventorySnapshot['levels'][number]) => number,
) {
  let total = 0
  for (const level of snapshot.levels) {
    total += selector(level)
    if (!Number.isSafeInteger(total)) {
      persistenceError(
        'SHOPIFY_INVENTORY_QUANTITY_OVERFLOW',
        'Shopify inventory totals exceed the supported exact quantity range',
        422,
      )
    }
  }
  return total
}

async function activeMappings(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    pipelineId: string
    inventoryItemIds: string[]
  },
) {
  if (!input.inventoryItemIds.length) return new Map<string, LevelMappingRow>()
  const result = await client.query<LevelMappingRow>(
    `SELECT mapping.external_inventory_item_id,
            min(mapping.pipeline_id::text) AS pipeline_id,
            min(mapping.product_id::text) AS product_id,
            min(product.reference_code) AS product_global_id,
            min(product.name) AS product_name,
            min(product.sku) AS product_sku,
            count(*)::text AS mapping_count
     FROM operations_product_mappings mapping
     JOIN crm_products product
       ON product.pipeline_id = mapping.pipeline_id
      AND product.id = mapping.product_id
     WHERE mapping.organization_id = $1::uuid
       AND mapping.integration_account_id = $2::uuid
       AND mapping.pipeline_id = $3::uuid
       AND mapping.active = true
       AND mapping.external_inventory_item_id = ANY($4::text[])
     GROUP BY mapping.external_inventory_item_id`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.pipelineId,
      input.inventoryItemIds,
    ],
  )
  const duplicate = result.rows.find((row) => Number(row.mapping_count) !== 1)
  if (duplicate) {
    persistenceError(
      'SHOPIFY_INVENTORY_ITEM_MAPPING_AMBIGUOUS',
      'A Shopify inventory item is mapped to more than one ClawPilot product',
    )
  }
  return new Map(result.rows.map((row) => [
    row.external_inventory_item_id,
    row,
  ]))
}

export async function applyShopifyInventorySnapshotInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  target: ShopifyInventoryTarget
  attempt: ShopifyInventoryAttempt
  capture: ShopifyInventoryCapture
  providerLocation: ShopifyInventoryLocation
  mappingMethod: 'automatic_single_location' | 'automatic_exact_address'
  idempotencyKey: string
  requestHash: string
  actorEmail: string | null
  expectedRefreshFence?: ShopifyInventoryRefreshExpectedFence | null
}) {
  const snapshot = input.capture.snapshot
  const committed = await (async () => {
    try {
      return await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      [
        'shopify-inventory-apply',
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
      ].join(':'),
    )
    await client.query(
      `SELECT set_config(
         'clawpilot.shopify_inventory_sync', 'on', true
       )`,
    )
    const replay = await client.query<{ global_id: string }>(
      `SELECT global_id
       FROM operations_commerce_inventory_sync_runs
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND idempotency_key = $3
         AND provider_attempt_id = $4::uuid
         AND warehouse_id = $5::uuid
         AND status = 'succeeded'
       LIMIT 1`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.idempotencyKey,
        input.attempt.id,
        input.target.warehouse.id,
      ],
    )
    if (replay.rows[0]) {
      return {
        runGlobalId: replay.rows[0].global_id,
        replayed: true,
      }
    }
    await lockShopifyInventoryProviderReadAuthority(
      client,
      input.runtime,
      input.attempt.providerReadAuthority,
    )
    if (input.expectedRefreshFence) {
      const expected = input.expectedRefreshFence
      const refreshFence = await client.query(
        `SELECT job.id
         FROM operations_shopify_inventory_refresh_jobs job
         JOIN operations_shopify_carrier_service_configs config
           ON config.organization_id = job.organization_id
          AND config.id = job.carrier_service_config_id
          AND config.integration_account_id =
              job.integration_account_id
          AND (
            job.location_mapping_id IS NOT NULL
            OR config.warehouse_id = job.warehouse_id
          )
          AND config.credential_generation = job.credential_generation
          AND config.activation_revision = job.activation_revision
          AND config.row_version = job.config_row_version
          AND config.policy_revision = job.policy_revision
          AND config.policy_hash = job.policy_hash
          AND config.inventory_max_age_seconds =
              job.inventory_max_age_seconds
         LEFT JOIN operations_commerce_inventory_location_mappings mapping
           ON mapping.organization_id = job.organization_id
          AND mapping.integration_account_id = job.integration_account_id
          AND mapping.id = job.location_mapping_id
          AND mapping.warehouse_id = job.warehouse_id
          AND mapping.location_id = job.inventory_location_id
          AND mapping.inventory_pool_id = job.inventory_pool_id
          AND mapping.external_location_id = job.provider_location_id
          AND mapping.row_version = job.location_mapping_row_version
         JOIN operations_integration_accounts account
           ON account.organization_id = job.organization_id
          AND account.id = job.integration_account_id
          AND account.integration_type = 'commerce'
          AND account.provider = 'shopify'
          AND ${SHOPIFY_INVENTORY_READ_ACCOUNT_SQL}
          AND account.commerce_credential_generation =
              job.credential_generation
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = job.organization_id
          AND credential.integration_account_id =
              job.integration_account_id
          AND credential.credential_version = job.credential_generation
          AND credential.verification_status = 'verified'
         JOIN operations_activation_scopes activation
           ON activation.organization_id = job.organization_id
         WHERE job.organization_id = $1::uuid
           AND job.integration_account_id = $2::uuid
           AND job.id = $3::uuid
           AND job.carrier_service_config_id = $4::uuid
           AND job.warehouse_id = $5::uuid
           AND job.credential_generation = $6::integer
           AND job.activation_revision = $7::integer
           AND job.config_row_version = $8::bigint
           AND job.policy_revision = $9::bigint
           AND job.policy_hash = $10
           AND job.inventory_max_age_seconds = $11::integer
           AND job.status = CASE
             WHEN $14::uuid IS NULL THEN 'processing'
             ELSE 'mapped_processing'
           END
           AND job.cancel_requested = false
           AND job.lock_token = $12::uuid
           AND job.requested_dirty_version = $13::bigint
           AND job.lease_expires_at > clock_timestamp()
           AND (
             $14::uuid IS NULL
             OR (
               job.location_mapping_id = $14::uuid
               AND job.location_mapping_row_version = $15::bigint
               AND job.provider_location_id = $16
               AND job.inventory_location_id = $17::uuid
               AND job.inventory_pool_id = $18::uuid
               AND mapping.active = true
               AND mapping.inventory_import_enabled = true
             )
           )
           AND ${STORE_SYNC_RUNNING_SQL}
           AND config.registration_state IN (
             'registered', 'shadow_simulated'
           )
           AND operations_shopify_inventory_read_config_is_ready(
             config.organization_id,
             config.id
           )
         LIMIT 1
         FOR UPDATE OF job, config, account, credential, activation`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          expected.jobId,
          expected.carrierServiceConfigId,
          expected.warehouseId,
          expected.credentialGeneration,
          expected.activationRevision,
          expected.configRowVersion,
          expected.policyRevision,
          expected.policyHash,
          expected.inventoryMaxAgeSeconds,
          expected.lockToken,
          expected.requestedDirtyVersion,
          expected.locationMappingId || null,
          expected.locationMappingRowVersion ?? null,
          expected.providerLocationId || null,
          expected.inventoryLocationId || null,
          expected.inventoryPoolId || null,
        ],
      )
      if (!refreshFence.rowCount) {
        persistenceError(
          'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
          'The automatic Shopify inventory refresh authority changed before projection',
          409,
        )
      }
    }
    const captureFence = await client.query<{
      request_hash: string
      snapshot_hash: string
      provider_location_id: string
      level_count: number
      warehouse_id: string
      location_id: string
      credential_version: number
      adapter_version: string
      lease_token: string | null
      lease_expires_at: Date | null
      lease_is_live: boolean
      state: string
      provider_read_authority: string | null
    }>(
      `SELECT capture.request_hash, capture.snapshot_hash,
              capture.provider_location_id, capture.level_count,
              capture.warehouse_id::text, capture.location_id::text,
              capture.credential_version, capture.adapter_version,
              attempt.lease_token::text, attempt.lease_expires_at,
              (
                attempt.lease_token IS NOT NULL
                AND attempt.lease_expires_at IS NOT NULL
                AND attempt.lease_expires_at > clock_timestamp()
              ) AS lease_is_live,
              attempt.state,
              attempt.redacted_request->>'providerReadAuthority'
                AS provider_read_authority
       FROM operations_commerce_inventory_captures capture
       JOIN operations_commerce_provider_attempts attempt
         ON attempt.organization_id = capture.organization_id
        AND attempt.integration_account_id =
            capture.integration_account_id
        AND attempt.id = capture.provider_attempt_id
       WHERE capture.organization_id = $1::uuid
         AND capture.integration_account_id = $2::uuid
         AND capture.provider_attempt_id = $3::uuid
         AND capture.id = $4::uuid
       LIMIT 1
       FOR UPDATE OF attempt`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.attempt.id,
        input.capture.id,
      ],
    )
    const captured = captureFence.rows[0]
    if (
      !captured
      || captured.state !== 'prepared'
      || captured.request_hash !== input.requestHash
      || captured.snapshot_hash !== snapshot.snapshotHash
      || captured.provider_location_id !== input.providerLocation.id
      || captured.provider_location_id !== snapshot.location.id
      || captured.level_count !== snapshot.levels.length
      || captured.warehouse_id !== input.target.warehouse.id
      || captured.location_id !== input.target.location.id
      || captured.credential_version !== input.runtime.credentialVersion
      || captured.adapter_version !== SHOPIFY_INVENTORY_ADAPTER_VERSION
      || captured.provider_read_authority
        !== input.attempt.providerReadAuthority
      || !input.attempt.leaseToken
      || captured.lease_token !== input.attempt.leaseToken
      || !captured.lease_is_live
    ) {
      persistenceError(
        'SHOPIFY_INVENTORY_CAPTURE_STALE',
        'The durable Shopify inventory capture no longer matches this projection',
        409,
      )
    }
    const fence = await client.query<{
      credential_version: number
      verification_status: string
      account_status: string
      data_pipeline_id: string
    }>(
      `SELECT credential.credential_version,
              credential.verification_status,
              account.status AS account_status,
              activation.data_pipeline_id::text
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version =
            account.commerce_credential_generation
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.provider = 'shopify'
         AND account.integration_type = 'commerce'
       FOR UPDATE OF account, credential`,
      [input.runtime.organizationId, input.runtime.integrationAccountId],
    )
    const current = fence.rows[0]
    if (
      !current
      || current.credential_version !== input.runtime.credentialVersion
      || current.verification_status !== 'verified'
      || current.account_status !== 'active'
      || current.data_pipeline_id !== input.target.pipelineId
    ) {
      persistenceError(
        'SHOPIFY_INVENTORY_CONNECTION_STALE',
        'Shopify or the Operations product target changed during inventory sync',
      )
    }
    const targetFence = await client.query(
      `SELECT warehouse.id
       FROM operations_warehouses warehouse
       JOIN operations_locations location
         ON location.organization_id = warehouse.organization_id
        AND location.warehouse_id = warehouse.id
       WHERE warehouse.organization_id = $1::uuid
         AND warehouse.id = $2::uuid
         AND warehouse.global_id = $3
         AND warehouse.status = 'active'
         AND location.id = $4::uuid
         AND location.global_id = $5
         AND location.active = true
       FOR SHARE OF warehouse, location`,
      [
        input.runtime.organizationId,
        input.target.warehouse.id,
        input.target.warehouse.globalId,
        input.target.location.id,
        input.target.location.globalId,
      ],
    )
    if (!targetFence.rowCount) {
      persistenceError(
        'SHOPIFY_INVENTORY_TARGET_STALE',
        'The inventory warehouse or reserve location changed during sync',
      )
    }
    const pool = await client.query<{
      id: string
      global_id: string
      pipeline_id: string
    }>(
      `INSERT INTO operations_inventory_pools (
         organization_id, pipeline_id, owner_customer_id, name,
         pool_type, allocation_policy, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, NULL, $3, 'shared', 'fifo', true, $4
       )
       ON CONFLICT (organization_id, name) DO UPDATE
       SET active = true, updated_at = now()
       RETURNING id::text, global_id, pipeline_id::text`,
      [
        input.runtime.organizationId,
        input.target.pipelineId,
        INVENTORY_POOL_NAME,
        input.actorEmail,
      ],
    )
    if (pool.rows[0].pipeline_id !== input.target.pipelineId) {
      persistenceError(
        'SHOPIFY_INVENTORY_POOL_PIPELINE_CONFLICT',
        'The Shopify inventory pool is bound to a different product catalog',
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      [
        SHOPIFY_LOCATION_ROUTING_LOCK,
        input.runtime.organizationId,
        input.target.warehouse.id,
        input.target.location.id,
        pool.rows[0].id,
      ].join(':'),
    )
    const projectionAuthorities = await client.query<{
      id: string
      integration_account_id: string
    }>(
      `SELECT id::text, integration_account_id::text
       FROM operations_commerce_inventory_location_mappings
       WHERE organization_id = $1::uuid
         AND warehouse_id = $2::uuid
         AND location_id = $3::uuid
         AND inventory_pool_id = $4::uuid
         AND active = true
         AND inventory_import_enabled = true
       ORDER BY id
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.target.warehouse.id,
        input.target.location.id,
        pool.rows[0].id,
      ],
    )
    const expectedMappingId = input.target.existingMapping?.id || null
    if (
      projectionAuthorities.rows.length > 1
      || projectionAuthorities.rows.some((authority) => (
        authority.integration_account_id
          !== input.runtime.integrationAccountId
        || (expectedMappingId !== null && authority.id !== expectedMappingId)
        || expectedMappingId === null
      ))
      || (
        expectedMappingId !== null
        && projectionAuthorities.rows.length !== 1
      )
    ) {
      persistenceError(
        'SHOPIFY_INVENTORY_PROJECTION_AUTHORITY_CONFLICT',
        'Another connected store owns this ClawPilot inventory projection target',
        409,
      )
    }
    const existingMapping = await client.query<{
      id: string
      global_id: string
      external_location_id: string
      warehouse_id: string
      location_id: string
      inventory_pool_id: string
      ownership_classification: string
      inventory_import_enabled: boolean
      active: boolean
      row_version: string
    }>(
      `SELECT id::text, global_id, external_location_id,
              warehouse_id::text, location_id::text,
              inventory_pool_id::text, ownership_classification,
              inventory_import_enabled, active, row_version::text
       FROM operations_commerce_inventory_location_mappings
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_location_id = $3
       LIMIT 1
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.providerLocation.id,
      ],
    )
    let locationMapping: { id: string; global_id: string }
    if (existingMapping.rows[0]) {
      const mapping = existingMapping.rows[0]
      if (
        mapping.external_location_id !== input.providerLocation.id
        || mapping.warehouse_id !== input.target.warehouse.id
        || mapping.location_id !== input.target.location.id
        || mapping.inventory_pool_id !== pool.rows[0].id
        || !mapping.active
        || !mapping.inventory_import_enabled
        || mapping.ownership_classification === 'fulfillment_service'
        || (
          input.target.existingMapping
          && mapping.id !== input.target.existingMapping.id
        )
        || (
          input.target.existingMapping
          && nonNegativeInteger(mapping.row_version)
            !== input.target.existingMapping.rowVersion
        )
      ) {
        persistenceError(
          'SHOPIFY_INVENTORY_LOCATION_MAPPING_CHANGED',
          'The saved Shopify location mapping no longer matches this inventory target',
        )
      }
      locationMapping = (
        await client.query<{ id: string; global_id: string }>(
          `UPDATE operations_commerce_inventory_location_mappings
           SET external_location_name = $3,
               external_location_address = $4::jsonb,
               ownership_classification = 'merchant_managed',
               provider_snapshot_json = $5::jsonb,
               provider_snapshot_hash = $6,
               provider_observed_at = now(),
               updated_by = $7,
               updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid
           RETURNING id::text, global_id`,
          [
            input.runtime.organizationId,
            mapping.id,
            input.providerLocation.name,
            JSON.stringify(input.providerLocation.address),
            JSON.stringify(input.providerLocation),
            createHash('sha256')
              .update(JSON.stringify(input.providerLocation))
              .digest('hex'),
            input.actorEmail,
          ],
        )
      ).rows[0]
    } else {
      locationMapping = (
        await client.query<{ id: string; global_id: string }>(
          `INSERT INTO operations_commerce_inventory_location_mappings (
             organization_id, integration_account_id,
             external_location_id, external_location_name,
             external_location_address, warehouse_id, location_id,
             inventory_pool_id, mapping_method, ownership_classification,
             provider_snapshot_json, provider_snapshot_hash,
             provider_observed_at, inventory_import_enabled, active,
             created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid, $7::uuid,
             $8::uuid, $9, 'merchant_managed', $10::jsonb, $11, now(),
             true, true, $12, $12
           )
           RETURNING id::text, global_id`,
          [
            input.runtime.organizationId,
            input.runtime.integrationAccountId,
            input.providerLocation.id,
            input.providerLocation.name,
            JSON.stringify(input.providerLocation.address),
            input.target.warehouse.id,
            input.target.location.id,
            pool.rows[0].id,
            input.mappingMethod,
            JSON.stringify(input.providerLocation),
            createHash('sha256')
              .update(JSON.stringify(input.providerLocation))
              .digest('hex'),
            input.actorEmail,
          ],
        )
      ).rows[0]
    }

    const mappings = await activeMappings(client, {
      organizationId: input.runtime.organizationId,
      integrationAccountId: input.runtime.integrationAccountId,
      pipelineId: input.target.pipelineId,
      inventoryItemIds: snapshot.levels.map(
        (level) => level.inventoryItemId,
      ),
    })
    const snapshotInventoryItemIds = new Set(
      snapshot.levels.map((level) => level.inventoryItemId),
    )
    const previousRun = await client.query<{ id: string }>(
      `SELECT id::text
       FROM operations_commerce_inventory_sync_runs
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND location_mapping_id = $3::uuid
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        locationMapping.id,
      ],
    )
    const previousRunId = previousRun.rows[0]?.id || null
    if (previousRunId) {
      const priorBindings = await client.query<{
        external_inventory_item_id: string
        product_id: string
      }>(
        `SELECT external_inventory_item_id, product_id::text
         FROM operations_commerce_inventory_levels
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND sync_run_id = $3::uuid
           AND inventory_position_id IS NOT NULL
         ORDER BY external_inventory_item_id`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          previousRunId,
        ],
      )
      const changedBinding = priorBindings.rows.find((binding) => (
        snapshotInventoryItemIds.has(binding.external_inventory_item_id)
        && (
          mappings.get(binding.external_inventory_item_id)?.product_id
          !== binding.product_id
        )
      ))
      if (changedBinding) {
        persistenceError(
          'SHOPIFY_INVENTORY_PRODUCT_REMAP_REVIEW_REQUIRED',
          'A projected Shopify inventory item changed product mapping. Review and explicitly transition the prior balance before syncing.',
          409,
        )
      }
    }
    const preparedLevels = snapshot.levels.map((level) => {
      const mapping = mappings.get(level.inventoryItemId)
      const projection = projectShopifyInventoryBalance({
        mapped: Boolean(mapping),
        tracked: level.tracked,
        quantities: level.quantities,
      })
      return {
        level,
        mapping,
        projectionState: projection.state,
        operationalAvailable: projection.operationalAvailable,
        operationalCommitted: projection.operationalReserved,
        operationalOnHand: projection.operationalOnHand,
      }
    })
    const projected = preparedLevels.filter(
      (level) => level.projectionState === 'projected' && level.mapping,
    )
    const projectedByProduct = new Map<string, {
      productId: string
      operationalAvailable: number
      operationalCommitted: number
      operationalOnHand: number
    }>()
    for (const level of projected) {
      const productId = level.mapping?.product_id as string
      const current = projectedByProduct.get(productId) || {
        productId,
        operationalAvailable: 0,
        operationalCommitted: 0,
        operationalOnHand: 0,
      }
      current.operationalAvailable += level.operationalAvailable
      current.operationalCommitted += level.operationalCommitted
      current.operationalOnHand += level.operationalOnHand
      projectedByProduct.set(productId, current)
    }
    const projectedProducts = [...projectedByProduct.values()]
    const projectedProductIds = projectedProducts.map(
      (level) => level.productId,
    )
    const positionLockCandidates = await client.query<{ id: string }>(
      `SELECT position.id::text
       FROM operations_inventory_positions position
       WHERE position.organization_id = $1::uuid
         AND position.warehouse_id = $2::uuid
         AND position.location_id = $3::uuid
         AND position.pool_id = $4::uuid
         AND position.lot_code = $5
       ORDER BY position.id`,
      [
        input.runtime.organizationId,
        input.target.warehouse.id,
        input.target.location.id,
        pool.rows[0].id,
        INVENTORY_LOT_CODE,
      ],
    )
    for (const position of positionLockCandidates.rows) {
      await acquireTransactionAdvisoryLock(
        client,
        [
          'operations:inventory-reservation',
          input.runtime.organizationId,
          position.id,
        ].join(':'),
      )
    }
    const existing = await client.query<ExistingPositionRow>(
      `SELECT position.id::text, position.global_id,
              position.product_id::text,
              position.on_hand_quantity::text,
              position.reserved_quantity::text,
              position.source_authority
       FROM operations_inventory_positions position
       WHERE position.organization_id = $1::uuid
         AND position.warehouse_id = $2::uuid
         AND position.location_id = $3::uuid
         AND position.pool_id = $4::uuid
         AND position.lot_code = $5
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.target.warehouse.id,
        input.target.location.id,
        pool.rows[0].id,
        INVENTORY_LOT_CODE,
      ],
    )
    const authorityConflict = existing.rows.find(
      (position) => position.source_authority !== 'shopify',
    )
    if (authorityConflict) {
      persistenceError(
        'SHOPIFY_INVENTORY_POSITION_AUTHORITY_CONFLICT',
        'The Shopify projection target overlaps a ClawPilot-owned inventory position',
        409,
      )
    }
    if (existing.rows.length) {
      const foreignLedger = await client.query(
        `SELECT ledger.id
         FROM operations_inventory_ledger ledger
         WHERE ledger.organization_id = $1::uuid
           AND ledger.position_id = ANY($2::uuid[])
           AND ledger.source_authority <> 'shopify'
         LIMIT 1`,
        [
          input.runtime.organizationId,
          existing.rows.map((position) => position.id),
        ],
      )
      if (foreignLedger.rowCount) {
        persistenceError(
          'SHOPIFY_INVENTORY_LEDGER_AUTHORITY_CONFLICT',
          'A Shopify-authoritative position contains local inventory ledger activity',
          409,
        )
      }
    }
    const reservedLocally = await client.query(
      `SELECT reservation.id
       FROM operations_reservations reservation
       JOIN operations_inventory_positions position
         ON position.organization_id = reservation.organization_id
        AND position.id = reservation.position_id
       WHERE reservation.organization_id = $1::uuid
         AND reservation.status = 'active'
         AND reservation.reservation_authority = 'local_balance'
         AND position.warehouse_id = $2::uuid
         AND position.location_id = $3::uuid
         AND position.pool_id = $4::uuid
         AND position.lot_code = $5
       LIMIT 1`,
      [
        input.runtime.organizationId,
        input.target.warehouse.id,
        input.target.location.id,
        pool.rows[0].id,
        INVENTORY_LOT_CODE,
      ],
    )
    if (reservedLocally.rowCount) {
      persistenceError(
        'SHOPIFY_INVENTORY_LOCAL_RESERVATION_CONFLICT',
        'Shopify inventory cannot be reconciled while a ClawPilot reservation is active against the provider-owned balance',
      )
    }
    const activeProviderCommitments = await client.query<{
      position_id: string
      product_id: string
      active_claimed_quantity: string
    }>(
      `SELECT reservation.position_id::text,
              position.product_id::text,
              sum(reservation.quantity)::text AS active_claimed_quantity
       FROM operations_reservations reservation
       JOIN operations_inventory_positions position
         ON position.organization_id = reservation.organization_id
        AND position.id = reservation.position_id
       WHERE reservation.organization_id = $1::uuid
         AND reservation.status = 'active'
         AND reservation.reservation_authority = 'provider_commitment'
         AND position.warehouse_id = $2::uuid
         AND position.location_id = $3::uuid
         AND position.pool_id = $4::uuid
         AND position.lot_code = $5
       GROUP BY reservation.position_id, position.product_id
       ORDER BY reservation.position_id`,
      [
        input.runtime.organizationId,
        input.target.warehouse.id,
        input.target.location.id,
        pool.rows[0].id,
        INVENTORY_LOT_CODE,
      ],
    )
    const unsupportedProviderCommitment =
      activeProviderCommitments.rows.find((claim) => (
        decimal(claim.active_claimed_quantity)
          > (
            projectedByProduct.get(claim.product_id)
              ?.operationalCommitted || 0
          )
      ))
    if (unsupportedProviderCommitment) {
      persistenceError(
        'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT',
        'The latest Shopify committed quantity does not cover active fulfillment commitments. Reconcile the affected order plans before retrying inventory sync.',
        409,
      )
    }
    const existingByProduct = new Map(
      existing.rows.map((position) => [position.product_id, position]),
    )
    const createdCount = projectedProducts.filter(
      (level) => !existingByProduct.has(level.productId),
    ).length
    const changedProjected = projectedProducts.filter((level) => {
      const position = existingByProduct.get(level.productId)
      return !position
        || decimal(position.on_hand_quantity) !== level.operationalOnHand
        || decimal(position.reserved_quantity) !==
          level.operationalCommitted
    })
    const currentProductIdSet = new Set(projectedProductIds)
    const positionsToZero = existing.rows.filter((position) => (
      !currentProductIdSet.has(position.product_id)
      && (
        decimal(position.on_hand_quantity) !== 0
        || decimal(position.reserved_quantity) !== 0
      )
    ))
    const levelsMapped = preparedLevels.filter(
      (level) => Boolean(level.mapping),
    ).length
    const levelsUnmapped = preparedLevels.length - levelsMapped
    const levelsUntracked = preparedLevels.filter(
      (level) => !level.level.tracked,
    ).length
    const negativeAvailable = preparedLevels.filter(
      (level) => level.level.quantities.available < 0,
    ).length
    const equationMismatch = preparedLevels.filter(
      (level) => !level.level.equationMatches,
    ).length
    const totals = {
      available: safeSum(
        snapshot,
        (level) => level.quantities.available,
      ),
      committed: safeSum(
        snapshot,
        (level) => level.quantities.committed,
      ),
      onHand: safeSum(
        snapshot,
        (level) => level.quantities.on_hand,
      ),
      operationalAvailable: projected.reduce((total, level) => {
        const next = total + level.operationalAvailable
        if (!Number.isSafeInteger(next)) {
          persistenceError(
            'SHOPIFY_INVENTORY_QUANTITY_OVERFLOW',
            'Projected Shopify availability exceeds the supported exact quantity range',
            422,
          )
        }
        return next
      }, 0),
    }
    const finalizedAttempt = await client.query(
      `UPDATE operations_commerce_provider_attempts
       SET state = 'succeeded',
           redacted_response = $4::jsonb,
           provider_reference = $5,
           error_code = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND state = 'prepared'
         AND lease_token = $6::uuid
         AND lease_expires_at > clock_timestamp()
       RETURNING id`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.attempt.id,
        JSON.stringify({
          providerLocationIdHash: createHash('sha256')
            .update(input.providerLocation.id)
            .digest('hex'),
          levelsSeen: preparedLevels.length,
          levelsMapped,
          levelsUnmapped,
          levelsUntracked,
          negativeAvailableLevels: negativeAvailable,
          equationMismatchLevels: equationMismatch,
          providerWrites: 0,
          orderQuantityAdjustment: 0,
          inventoryApplied: true,
        }),
        input.providerLocation.id,
        input.attempt.leaseToken,
      ],
    )
    if (!finalizedAttempt.rowCount) {
      persistenceError(
        'SHOPIFY_INVENTORY_ATTEMPT_STALE',
        'The Shopify inventory provider attempt is no longer pending',
      )
    }
    const run = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_commerce_inventory_sync_runs (
         organization_id, integration_account_id, provider_attempt_id,
         capture_id, location_mapping_id, warehouse_id, location_id,
         inventory_pool_id, provider, adapter_version, credential_version,
         idempotency_key, request_hash, snapshot_hash, status,
         provider_location_id, provider_location_name, provider_fetched_at,
         levels_seen, levels_mapped, levels_projected, levels_unmapped,
         levels_untracked,
         negative_available_levels, equation_mismatch_levels,
         provider_available_quantity, provider_committed_quantity,
         provider_on_hand_quantity, operational_available_quantity,
         positions_created, positions_updated, positions_zeroed,
         provider_writes, order_quantity_adjustment, created_by, completed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::uuid, $8::uuid, 'shopify', $9, $10, $11, $12, $13,
         'succeeded', $14, $15, $16::timestamptz, $17, $18, $19, $20,
         $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, 0, 0,
         $31, now()
       )
       RETURNING id::text, global_id`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.attempt.id,
        input.capture.id,
        locationMapping.id,
        input.target.warehouse.id,
        input.target.location.id,
        pool.rows[0].id,
        SHOPIFY_INVENTORY_ADAPTER_VERSION,
        input.runtime.credentialVersion,
        input.idempotencyKey,
        input.requestHash,
        snapshot.snapshotHash,
        input.providerLocation.id,
        input.providerLocation.name,
        snapshot.fetchedAt,
        preparedLevels.length,
        levelsMapped,
        projected.length,
        levelsUnmapped,
        levelsUntracked,
        negativeAvailable,
        equationMismatch,
        totals.available,
        totals.committed,
        totals.onHand,
        totals.operationalAvailable,
        createdCount,
        changedProjected.length - createdCount,
        positionsToZero.length,
        input.actorEmail,
      ],
    )

    const positionByProduct = new Map(existingByProduct)
    const ledgerRows: Array<Record<string, unknown>> = []
    for (const level of changedProjected) {
      const productId = level.productId
      const before = existingByProduct.get(productId)
      const saved = await client.query<ExistingPositionRow>(
        `INSERT INTO operations_inventory_positions (
           organization_id, pipeline_id, warehouse_id, location_id, pool_id,
           product_id, lot_code, on_hand_quantity, reserved_quantity,
           damaged_quantity, source_authority
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7, $8, $9, 0, 'shopify'
         )
         ON CONFLICT (
           organization_id, warehouse_id, location_id, pool_id,
           product_id, lot_code
         ) DO UPDATE SET
           on_hand_quantity = EXCLUDED.on_hand_quantity,
           reserved_quantity = EXCLUDED.reserved_quantity,
           damaged_quantity = 0,
           version = operations_inventory_positions.version + 1,
           updated_at = now()
         WHERE operations_inventory_positions.source_authority = 'shopify'
         RETURNING id::text, global_id, product_id::text,
                   on_hand_quantity::text, reserved_quantity::text,
                   source_authority`,
        [
          input.runtime.organizationId,
          input.target.pipelineId,
          input.target.warehouse.id,
          input.target.location.id,
          pool.rows[0].id,
          productId,
          INVENTORY_LOT_CODE,
          level.operationalOnHand,
          level.operationalCommitted,
        ],
      )
      const position = saved.rows[0]
      if (!position) {
        persistenceError(
          'SHOPIFY_INVENTORY_POSITION_AUTHORITY_CONFLICT',
          'The Shopify projection target overlaps a ClawPilot-owned inventory position',
          409,
        )
      }
      positionByProduct.set(productId, position)
      ledgerRows.push({
        positionId: position.id,
        eventType: before ? 'adjustment' : 'opening_balance',
        onHandDelta:
          level.operationalOnHand - decimal(before?.on_hand_quantity),
        reservedDelta:
          level.operationalCommitted - decimal(before?.reserved_quantity),
        onHandAfter: level.operationalOnHand,
        reservedAfter: level.operationalCommitted,
        idempotencyKey:
          `${run.rows[0].global_id}:${position.global_id}:project`,
        reason:
          'Shopify available plus committed projected without reapplying order demand',
      })
    }
    for (const before of positionsToZero) {
      await client.query(
        `UPDATE operations_inventory_positions
         SET on_hand_quantity = 0,
             reserved_quantity = 0,
             damaged_quantity = 0,
             version = version + 1,
             updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [input.runtime.organizationId, before.id],
      )
      positionByProduct.set(before.product_id, {
        ...before,
        on_hand_quantity: '0',
        reserved_quantity: '0',
      })
      ledgerRows.push({
        positionId: before.id,
        eventType: 'adjustment',
        onHandDelta: -decimal(before.on_hand_quantity),
        reservedDelta: -decimal(before.reserved_quantity),
        onHandAfter: 0,
        reservedAfter: 0,
        idempotencyKey:
          `${run.rows[0].global_id}:${before.global_id}:zero`,
        reason:
          'Complete Shopify snapshot no longer reports an eligible inventory level',
      })
    }
    if (ledgerRows.length) {
      await client.query(
        `INSERT INTO operations_inventory_ledger (
           organization_id, position_id, event_type, on_hand_delta,
           reserved_delta, on_hand_after, reserved_after, source_global_id,
           reason, idempotency_key, actor_email, source_authority
         )
         SELECT
           $1::uuid, row.position_id::uuid, row.event_type,
           row.on_hand_delta, row.reserved_delta, row.on_hand_after,
           row.reserved_after, $2, row.reason, row.idempotency_key, $3,
           'shopify'
         FROM jsonb_to_recordset($4::jsonb) AS row(
           position_id text, event_type text, on_hand_delta numeric,
           reserved_delta numeric, on_hand_after numeric,
           reserved_after numeric, reason text, idempotency_key text
         )`,
        [
          input.runtime.organizationId,
          run.rows[0].global_id,
          input.actorEmail,
          JSON.stringify(ledgerRows.map((row) => ({
            position_id: row.positionId,
            event_type: row.eventType,
            on_hand_delta: row.onHandDelta,
            reserved_delta: row.reservedDelta,
            on_hand_after: row.onHandAfter,
            reserved_after: row.reservedAfter,
            reason: row.reason,
            idempotency_key: row.idempotencyKey,
          }))),
        ],
      )
    }
    const evidenceRows = preparedLevels.map((prepared) => {
      const mapping = prepared.mapping
      const position = mapping
        ? positionByProduct.get(mapping.product_id)
        : null
      const projectedPosition = prepared.projectionState === 'projected'
        ? position
        : null
      return {
        external_inventory_item_id: prepared.level.inventoryItemId,
        sku: prepared.level.sku,
        tracked: prepared.level.tracked,
        mapping_state: mapping ? 'mapped' : 'unmapped',
        projection_state: prepared.projectionState,
        pipeline_id: mapping?.pipeline_id || null,
        product_id: mapping?.product_id || null,
        inventory_position_id: projectedPosition?.id || null,
        provider_available_quantity:
          prepared.level.quantities.available,
        provider_incoming_quantity: prepared.level.quantities.incoming,
        provider_committed_quantity:
          prepared.level.quantities.committed,
        provider_damaged_quantity: prepared.level.quantities.damaged,
        provider_on_hand_quantity: prepared.level.quantities.on_hand,
        provider_quality_control_quantity:
          prepared.level.quantities.quality_control,
        provider_reserved_quantity: prepared.level.quantities.reserved,
        provider_safety_stock_quantity:
          prepared.level.quantities.safety_stock,
        provider_quantity_evidence:
          prepared.level.quantityEvidence,
        operational_available_quantity: prepared.operationalAvailable,
        equation_matches: prepared.level.equationMatches,
        provider_updated_at: prepared.level.updatedAt,
        provider_weight_grams: prepared.level.providerWeightGrams,
        provider_dimensions_mm:
          prepared.level.providerDimensionsMm,
        product_snapshot: {
          ...prepared.level.productSnapshot,
          mappedProduct: {
            globalId: mapping?.product_global_id || null,
            name: mapping?.product_name || null,
            sku: mapping?.product_sku || null,
          },
        },
        source_hash: prepared.level.sourceHash,
      }
    })
    if (evidenceRows.length) {
      await client.query(
        `INSERT INTO operations_commerce_inventory_levels (
           organization_id, sync_run_id, integration_account_id,
           location_mapping_id, warehouse_id, location_id,
           inventory_pool_id, pipeline_id, product_id,
           inventory_position_id, provider_location_id,
           external_inventory_item_id, sku, tracked, mapping_state,
           projection_state, provider_available_quantity,
           provider_incoming_quantity, provider_committed_quantity,
           provider_damaged_quantity, provider_on_hand_quantity,
           provider_quality_control_quantity, provider_reserved_quantity,
           provider_safety_stock_quantity, provider_quantity_evidence,
           operational_available_quantity, equation_matches,
           provider_updated_at, provider_weight_grams,
           provider_dimensions_mm, product_snapshot, source_hash
         )
         SELECT
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, row.pipeline_id::uuid, row.product_id::uuid,
           row.inventory_position_id::uuid, $8,
           row.external_inventory_item_id, row.sku, row.tracked,
           row.mapping_state, row.projection_state,
           row.provider_available_quantity,
           row.provider_incoming_quantity,
           row.provider_committed_quantity,
           row.provider_damaged_quantity,
           row.provider_on_hand_quantity,
           row.provider_quality_control_quantity,
           row.provider_reserved_quantity,
           row.provider_safety_stock_quantity,
           row.provider_quantity_evidence,
           row.operational_available_quantity, row.equation_matches,
           row.provider_updated_at::timestamptz,
           row.provider_weight_grams, row.provider_dimensions_mm,
           row.product_snapshot, row.source_hash
         FROM jsonb_to_recordset($9::jsonb) AS row(
           pipeline_id text, product_id text, inventory_position_id text,
           external_inventory_item_id text, sku text, tracked boolean,
           mapping_state text, projection_state text,
           provider_available_quantity numeric,
           provider_incoming_quantity numeric,
           provider_committed_quantity numeric,
           provider_damaged_quantity numeric,
           provider_on_hand_quantity numeric,
           provider_quality_control_quantity numeric,
           provider_reserved_quantity numeric,
           provider_safety_stock_quantity numeric,
           provider_quantity_evidence jsonb,
           operational_available_quantity numeric,
           equation_matches boolean, provider_updated_at text,
           provider_weight_grams integer, provider_dimensions_mm jsonb,
           product_snapshot jsonb, source_hash text
         )`,
        [
          input.runtime.organizationId,
          run.rows[0].id,
          input.runtime.integrationAccountId,
          locationMapping.id,
          input.target.warehouse.id,
          input.target.location.id,
          pool.rows[0].id,
          input.providerLocation.id,
          JSON.stringify(evidenceRows),
        ],
      )
    }
    await client.query(
      `INSERT INTO operations_domain_events (
         organization_id, aggregate_type, aggregate_id,
         aggregate_global_id, event_type, event_version, payload,
         actor_email, correlation_id, idempotency_key
       ) VALUES (
         $1::uuid, 'operations.commerce_inventory_sync', $2::uuid, $3,
         'operations.inventory.shopify_reconciled', 1, $4::jsonb,
         $5, $6::uuid, $7
       )`,
      [
        input.runtime.organizationId,
        run.rows[0].id,
        run.rows[0].global_id,
        JSON.stringify({
          integrationAccountGlobalId: input.runtime.globalId,
          providerLocationIdHash: createHash('sha256')
            .update(input.providerLocation.id)
            .digest('hex'),
          warehouseGlobalId: input.target.warehouse.globalId,
          locationGlobalId: input.target.location.globalId,
          levelsSeen: preparedLevels.length,
          levelsMapped,
          positionsCreated: createdCount,
          positionsUpdated: changedProjected.length - createdCount,
          positionsZeroed: positionsToZero.length,
          providerWrites: 0,
          orderQuantityAdjustment: 0,
        }),
        input.actorEmail,
        randomUUID(),
        `shopify-inventory:${input.idempotencyKey}`,
      ],
    )
        return {
          runGlobalId: run.rows[0].global_id,
          replayed: false,
        }
      })
    } catch (error) {
      if (isProjectionTargetUniqueViolation(error)) {
        persistenceError(
          'SHOPIFY_INVENTORY_PROJECTION_AUTHORITY_CONFLICT',
          'Another connected store owns this ClawPilot inventory projection target',
          409,
        )
      }
      throw error
    }
  })()
  await recordAuditEvent({
    actor: input.actorEmail || 'system',
    eventType: 'commerce.inventory.synced',
    aggregateType: 'operations.commerce_inventory_sync',
    aggregateId: committed.runGlobalId,
    organizationId: input.runtime.organizationId,
    isSystem: !input.actorEmail,
    eventKey: `commerce-inventory:${committed.runGlobalId}:synced`,
    payload: {
      integrationAccountGlobalId: input.runtime.globalId,
      warehouseGlobalId: input.target.warehouse.globalId,
      providerWrites: 0,
      orderQuantityAdjustment: 0,
      replayed: committed.replayed,
    },
  })
  return committed
}

export async function readShopifyInventoryConfigurationFromPostgres(input: {
  organizationId: string
  integrationAccountId: string
}) {
  const warehouseRows = await query<InventoryWarehouseRow>(
    `SELECT warehouse.global_id, warehouse.code, warehouse.name,
            warehouse.address, warehouse.status,
            location.global_id AS location_global_id,
            location.code AS location_code,
            location.zone AS location_zone,
            location.location_type,
            location.active AS location_active
     FROM operations_warehouses warehouse
     JOIN operations_locations location
       ON location.organization_id = warehouse.organization_id
      AND location.warehouse_id = warehouse.id
      AND location.active = true
     WHERE warehouse.organization_id = $1::uuid
       AND warehouse.status = 'active'
       AND NOT EXISTS (
         SELECT 1
         FROM operations_commerce_inventory_location_mappings foreign_mapping
         WHERE foreign_mapping.organization_id = warehouse.organization_id
           AND foreign_mapping.integration_account_id <> $2::uuid
           AND foreign_mapping.warehouse_id = warehouse.id
           AND foreign_mapping.location_id = location.id
           AND foreign_mapping.active = true
           AND foreign_mapping.inventory_import_enabled = true
       )
     ORDER BY lower(warehouse.name), warehouse.global_id,
              location.pick_sequence, lower(location.code),
              location.global_id`,
    [input.organizationId, input.integrationAccountId],
  )
  const warehouseByGlobalId = new Map<string, {
    globalId: string
    code: string
    name: string
    address: Record<string, unknown>
    status: 'active'
    locations: Array<{
      globalId: string
      code: string
      zone: string
      locationType: string
      active: boolean
    }>
  }>()
  for (const row of warehouseRows.rows) {
    let warehouse = warehouseByGlobalId.get(row.global_id)
    if (!warehouse) {
      warehouse = {
        globalId: row.global_id,
        code: row.code,
        name: row.name,
        address: row.address || {},
        status: row.status,
        locations: [],
      }
      warehouseByGlobalId.set(row.global_id, warehouse)
    }
    warehouse.locations.push({
      globalId: row.location_global_id,
      code: row.location_code,
      zone: row.location_zone,
      locationType: row.location_type,
      active: row.location_active,
    })
  }

  const mappingRows = await query<InventoryMappingStateRow>(
    `SELECT mapping.global_id, mapping.external_location_id,
            mapping.external_location_name,
            mapping.external_location_address, mapping.mapping_method,
            mapping.ownership_classification,
            mapping.provider_observed_at,
            mapping.inventory_import_enabled, mapping.active,
            mapping.row_version::text,
            warehouse.global_id AS warehouse_global_id,
            warehouse.code AS warehouse_code,
            warehouse.name AS warehouse_name,
            location.global_id AS location_global_id,
            location.code AS location_code,
            location.zone AS location_zone,
            location.location_type,
            latest.global_id AS run_global_id,
            latest.provider_fetched_at, latest.completed_at,
            latest.provider_location_id, latest.provider_location_name,
            latest.levels_seen, latest.levels_mapped,
            latest.levels_projected, latest.levels_unmapped,
            latest.levels_untracked,
            latest.operational_available_quantity::text,
            latest.positions_created, latest.positions_updated,
            latest.positions_zeroed, latest.provider_writes,
            latest.order_quantity_adjustment::text
     FROM operations_commerce_inventory_location_mappings mapping
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = mapping.organization_id
      AND warehouse.id = mapping.warehouse_id
     JOIN operations_locations location
       ON location.organization_id = mapping.organization_id
      AND location.id = mapping.location_id
     LEFT JOIN LATERAL (
       SELECT run.global_id, run.provider_fetched_at, run.completed_at,
              run.provider_location_id, run.provider_location_name,
              run.levels_seen, run.levels_mapped,
              run.levels_projected, run.levels_unmapped,
              run.levels_untracked,
              run.operational_available_quantity,
              run.positions_created, run.positions_updated,
              run.positions_zeroed, run.provider_writes,
              run.order_quantity_adjustment
       FROM operations_commerce_inventory_sync_runs run
       WHERE run.organization_id = mapping.organization_id
         AND run.integration_account_id = mapping.integration_account_id
         AND run.location_mapping_id = mapping.id
         AND run.status = 'succeeded'
       ORDER BY run.completed_at DESC, run.id DESC
       LIMIT 1
     ) latest ON true
     WHERE mapping.organization_id = $1::uuid
       AND mapping.integration_account_id = $2::uuid
     ORDER BY mapping.active DESC, mapping.inventory_import_enabled DESC,
              lower(mapping.external_location_name), mapping.global_id`,
    [input.organizationId, input.integrationAccountId],
  )
  return {
    warehouses: [...warehouseByGlobalId.values()],
    mappings: mappingRows.rows.map((row) => ({
      globalId: row.global_id,
      externalLocationId: row.external_location_id,
      externalLocationName: row.external_location_name,
      externalLocationAddress: row.external_location_address || {},
      mappingMethod: row.mapping_method,
      ownershipClassification: row.ownership_classification,
      providerObservedAt: iso(row.provider_observed_at),
      inventoryImportEnabled: row.inventory_import_enabled,
      active: row.active,
      rowVersion: nonNegativeInteger(row.row_version),
      warehouse: {
        globalId: row.warehouse_global_id,
        code: row.warehouse_code,
        name: row.warehouse_name,
      },
      location: {
        globalId: row.location_global_id,
        code: row.location_code,
        zone: row.location_zone,
        locationType: row.location_type,
      },
      latestRun: row.run_global_id
        ? {
            globalId: row.run_global_id,
            providerFetchedAt: iso(row.provider_fetched_at),
            completedAt: iso(row.completed_at),
            providerLocationId: row.provider_location_id,
            providerLocationName: row.provider_location_name,
            levelsSeen: row.levels_seen || 0,
            levelsMapped: row.levels_mapped || 0,
            levelsProjected: row.levels_projected || 0,
            levelsUnmapped: row.levels_unmapped || 0,
            levelsUntracked: row.levels_untracked || 0,
            operationalAvailableQuantity: decimal(
              row.operational_available_quantity,
            ),
            positionsCreated: row.positions_created || 0,
            positionsUpdated: row.positions_updated || 0,
            positionsZeroed: row.positions_zeroed || 0,
            providerWrites: row.provider_writes || 0,
            orderQuantityAdjustment: decimal(
              row.order_quantity_adjustment,
            ),
          }
        : null,
    })),
  }
}

function mappingCommandResult(
  value: unknown,
): ShopifyInventoryMappingCommandResult {
  const result = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  const mapping = result.mapping && typeof result.mapping === 'object'
    ? result.mapping as Record<string, unknown>
    : {}
  const rowVersion = nonNegativeInteger(
    typeof mapping.rowVersion === 'number' ? mapping.rowVersion : undefined,
  )
  return {
    mapping: {
      globalId: String(mapping.globalId || ''),
      externalLocationId: String(mapping.externalLocationId || ''),
      externalLocationName: String(mapping.externalLocationName || ''),
      ownershipClassification: 'merchant_managed',
      inventoryImportEnabled: true,
      rowVersion,
      warehouseGlobalId: String(mapping.warehouseGlobalId || ''),
      locationGlobalId: String(mapping.locationGlobalId || ''),
    },
    providerWrites: 0,
    replayed: result.replayed === true,
  }
}

export async function mapShopifyInventoryLocationInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  providerLocation: ShopifyInventoryLocation
  warehouseGlobalId: string
  locationGlobalId: string
  expectedMappingGlobalId: string | null
  expectedRowVersion: number | null
  idempotencyKey: string
  actorEmail: string
}): Promise<ShopifyInventoryMappingCommandResult> {
  if (
    input.providerLocation.isFulfillmentService
    || !input.providerLocation.isActive
    || !input.providerLocation.shipsInventory
    || !input.providerLocation.fulfillsOnlineOrders
  ) {
    persistenceError(
      input.providerLocation.isFulfillmentService
        ? 'SHOPIFY_INVENTORY_FULFILLMENT_SERVICE_LOCATION_FORBIDDEN'
        : 'SHOPIFY_INVENTORY_LOCATION_INELIGIBLE',
      input.providerLocation.isFulfillmentService
        ? 'Inventory owned by another Shopify fulfillment service cannot be mapped as a ClawPilot warehouse'
        : 'Choose an active Shopify location that ships inventory and fulfills online orders',
      409,
    )
  }
  const requestHash = createHash('sha256').update(JSON.stringify({
    version: 1,
    command: 'shopify_inventory_location_map',
    accountGlobalId: input.runtime.globalId,
    credentialVersion: input.runtime.credentialVersion,
    externalLocationId: input.providerLocation.id,
    warehouseGlobalId: input.warehouseGlobalId,
    locationGlobalId: input.locationGlobalId,
    expectedMappingGlobalId: input.expectedMappingGlobalId,
    expectedRowVersion: input.expectedRowVersion,
    providerWrites: 0,
  })).digest('hex')
  const providerSnapshot = JSON.stringify(input.providerLocation)
  const providerSnapshotHash = createHash('sha256')
    .update(providerSnapshot)
    .digest('hex')
  const commandType = 'shopify_inventory_location_map'
  try {
    return await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      [
        SHOPIFY_LOCATION_ROUTING_LOCK,
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
      ].join(':'),
    )
    const prior = await client.query<{
      request_hash: string
      status: string
      result_payload: unknown
    }>(
      `SELECT request_hash, status, result_payload
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [input.runtime.organizationId, commandType, input.idempotencyKey],
    )
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) {
        persistenceError(
          'SHOPIFY_INVENTORY_MAPPING_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different Shopify inventory mapping',
        )
      }
      if (
        prior.rows[0].status === 'succeeded'
        && prior.rows[0].result_payload
      ) {
        const replay = mappingCommandResult(prior.rows[0].result_payload)
        return { ...replay, replayed: true }
      }
      persistenceError(
        'SHOPIFY_INVENTORY_MAPPING_IN_PROGRESS',
        'This Shopify inventory mapping change is already in progress',
      )
    }
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id
       ) VALUES ($1::uuid, $2, $3, $4, $5, 'processing', gen_random_uuid())
       RETURNING id::text`,
      [
        input.runtime.organizationId,
        commandType,
        input.idempotencyKey,
        requestHash,
        input.actorEmail,
      ],
    )
    const authority = await client.query<{
      credential_version: number
      verification_status: string
      account_status: string
      pipeline_id: string
      warehouse_id: string
      warehouse_global_id: string
      location_id: string
      location_global_id: string
    }>(
      `SELECT credential.credential_version,
              credential.verification_status,
              account.status AS account_status,
              activation.data_pipeline_id::text AS pipeline_id,
              warehouse.id::text AS warehouse_id,
              warehouse.global_id AS warehouse_global_id,
              location.id::text AS location_id,
              location.global_id AS location_global_id
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version =
            account.commerce_credential_generation
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = account.organization_id
        AND warehouse.global_id = $3
        AND warehouse.status = 'active'
       JOIN operations_locations location
         ON location.organization_id = warehouse.organization_id
        AND location.warehouse_id = warehouse.id
        AND location.global_id = $4
        AND location.active = true
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       LIMIT 1
       FOR UPDATE OF account, credential, warehouse, location`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.warehouseGlobalId,
        input.locationGlobalId,
      ],
    )
    const currentAuthority = authority.rows[0]
    if (!currentAuthority) {
      persistenceError(
        'SHOPIFY_INVENTORY_MAPPING_TARGET_REQUIRED',
        'Choose an active ClawPilot warehouse and inventory location',
        404,
      )
    }
    if (
      currentAuthority.credential_version !== input.runtime.credentialVersion
      || currentAuthority.verification_status !== 'verified'
      || currentAuthority.account_status !== 'active'
    ) {
      persistenceError(
        'SHOPIFY_INVENTORY_CONNECTION_STALE',
        'Shopify changed while the inventory mapping was being saved',
      )
    }
    const pool = await client.query<{
      id: string
      pipeline_id: string
    }>(
      `INSERT INTO operations_inventory_pools (
         organization_id, pipeline_id, owner_customer_id, name,
         pool_type, allocation_policy, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, NULL, $3, 'shared', 'fifo', true, $4
       )
       ON CONFLICT (organization_id, name) DO UPDATE
       SET active = true, updated_at = now()
       RETURNING id::text, pipeline_id::text`,
      [
        input.runtime.organizationId,
        currentAuthority.pipeline_id,
        INVENTORY_POOL_NAME,
        input.actorEmail,
      ],
    )
    if (pool.rows[0].pipeline_id !== currentAuthority.pipeline_id) {
      persistenceError(
        'SHOPIFY_INVENTORY_POOL_PIPELINE_CONFLICT',
        'The Shopify inventory pool is bound to a different product catalog',
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      [
        SHOPIFY_LOCATION_ROUTING_LOCK,
        input.runtime.organizationId,
        currentAuthority.warehouse_id,
        currentAuthority.location_id,
        pool.rows[0].id,
      ].join(':'),
    )
    const conflicts = await client.query<InventoryLocationMappingRow>(
      `SELECT id::text, global_id, external_location_id,
              external_location_name, external_location_address,
              warehouse_id::text, location_id::text,
              inventory_pool_id::text, mapping_method,
              ownership_classification, provider_snapshot_json,
              provider_snapshot_hash, provider_observed_at,
              inventory_import_enabled, active, row_version::text
       FROM operations_commerce_inventory_location_mappings
       WHERE organization_id = $1::uuid
         AND (
           (
             integration_account_id = $2::uuid
             AND (
               global_id = $3
               OR external_location_id = $4
               OR warehouse_id = $5::uuid
             )
           )
           OR (
             warehouse_id = $5::uuid
             AND location_id = $6::uuid
             AND inventory_pool_id = $7::uuid
             AND active = true
             AND inventory_import_enabled = true
           )
         )
       ORDER BY id
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.expectedMappingGlobalId || '',
        input.providerLocation.id,
        currentAuthority.warehouse_id,
        currentAuthority.location_id,
        pool.rows[0].id,
      ],
    )
    let saved: { global_id: string; row_version: string }
    if (input.expectedMappingGlobalId) {
      const current = conflicts.rows.find(
        (row) => row.global_id === input.expectedMappingGlobalId,
      )
      if (!current || current.external_location_id !== input.providerLocation.id) {
        persistenceError(
          'SHOPIFY_INVENTORY_LOCATION_MAPPING_CHANGED',
          'The selected Shopify inventory location mapping changed. Reload before saving.',
        )
      }
      if (
        input.expectedRowVersion === null
        || nonNegativeInteger(current.row_version)
          !== input.expectedRowVersion
      ) {
        persistenceError(
          'SHOPIFY_INVENTORY_LOCATION_MAPPING_CHANGED',
          'The selected Shopify inventory location mapping changed. Reload before saving.',
        )
      }
      const collision = conflicts.rows.find(
        (row) => row.id !== current.id,
      )
      if (collision) {
        persistenceError(
          'SHOPIFY_INVENTORY_LOCATION_MAPPING_CONFLICT',
          'That Shopify location or ClawPilot inventory target is already mapped to a connected store',
        )
      }
      if (
        current.warehouse_id !== currentAuthority.warehouse_id
        || current.location_id !== currentAuthority.location_id
        || current.inventory_pool_id !== pool.rows[0].id
      ) {
        const projected = await client.query(
          `SELECT run.id
           FROM operations_commerce_inventory_sync_runs run
           WHERE run.organization_id = $1::uuid
             AND run.integration_account_id = $2::uuid
             AND run.location_mapping_id = $3::uuid
             AND run.status = 'succeeded'
           LIMIT 1`,
          [
            input.runtime.organizationId,
            input.runtime.integrationAccountId,
            current.id,
          ],
        )
        if (projected.rowCount) {
          persistenceError(
            'SHOPIFY_INVENTORY_MAPPING_ROUTE_TRANSITION_REQUIRED',
            'This Shopify location already projected inventory. Reconcile the prior warehouse balance before changing its route.',
          )
        }
      }
      const updated = await client.query<{
        global_id: string
        row_version: string
      }>(
        `UPDATE operations_commerce_inventory_location_mappings
         SET external_location_name = $4,
             external_location_address = $5::jsonb,
             warehouse_id = $6::uuid,
             location_id = $7::uuid,
             inventory_pool_id = $8::uuid,
             mapping_method = 'manual',
             ownership_classification = 'merchant_managed',
             provider_snapshot_json = $9::jsonb,
             provider_snapshot_hash = $10,
             provider_observed_at = now(),
             inventory_import_enabled = true,
             active = true,
             row_version = row_version + 1,
             updated_by = $11,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND id = $3::uuid
           AND row_version = $12::bigint
         RETURNING global_id, row_version::text`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          current.id,
          input.providerLocation.name,
          JSON.stringify(input.providerLocation.address),
          currentAuthority.warehouse_id,
          currentAuthority.location_id,
          pool.rows[0].id,
          providerSnapshot,
          providerSnapshotHash,
          input.actorEmail,
          input.expectedRowVersion,
        ],
      )
      if (!updated.rows[0]) {
        persistenceError(
          'SHOPIFY_INVENTORY_LOCATION_MAPPING_CHANGED',
          'The selected Shopify inventory location mapping changed. Reload before saving.',
        )
      }
      saved = updated.rows[0]
    } else {
      if (input.expectedRowVersion !== null || conflicts.rows.length) {
        persistenceError(
          conflicts.rows.length
            ? 'SHOPIFY_INVENTORY_LOCATION_MAPPING_CONFLICT'
            : 'SHOPIFY_INVENTORY_LOCATION_MAPPING_CHANGED',
          conflicts.rows.length
            ? 'That Shopify location or ClawPilot inventory target is already mapped to a connected store'
            : 'Reload Shopify inventory locations before saving this mapping',
        )
      }
      const inserted = await client.query<{
        global_id: string
        row_version: string
      }>(
        `INSERT INTO operations_commerce_inventory_location_mappings (
           organization_id, integration_account_id,
           external_location_id, external_location_name,
           external_location_address, warehouse_id, location_id,
           inventory_pool_id, mapping_method, ownership_classification,
           provider_snapshot_json, provider_snapshot_hash,
           provider_observed_at, inventory_import_enabled, active,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid, $7::uuid,
           $8::uuid, 'manual', 'merchant_managed', $9::jsonb, $10, now(),
           true, true, $11, $11
         )
         RETURNING global_id, row_version::text`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          input.providerLocation.id,
          input.providerLocation.name,
          JSON.stringify(input.providerLocation.address),
          currentAuthority.warehouse_id,
          currentAuthority.location_id,
          pool.rows[0].id,
          providerSnapshot,
          providerSnapshotHash,
          input.actorEmail,
        ],
      )
      saved = inserted.rows[0]
    }
    const result: ShopifyInventoryMappingCommandResult = {
      mapping: {
        globalId: saved.global_id,
        externalLocationId: input.providerLocation.id,
        externalLocationName: input.providerLocation.name,
        ownershipClassification: 'merchant_managed',
        inventoryImportEnabled: true,
        rowVersion: nonNegativeInteger(saved.row_version),
        warehouseGlobalId: currentAuthority.warehouse_global_id,
        locationGlobalId: currentAuthority.location_global_id,
      },
      providerWrites: 0,
      replayed: false,
    }
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_global_id = $2,
           result_payload = $3::jsonb, completed_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      [receipt.rows[0].id, saved.global_id, JSON.stringify(result)],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.inventory.location_mapped',
      aggregateType: 'operations.commerce_inventory_location_mapping',
      aggregateId: saved.global_id,
      organizationId: input.runtime.organizationId,
      eventKey: `commerce-inventory-location-map:${input.idempotencyKey}`,
      payload: {
        integrationAccountGlobalId: input.runtime.globalId,
        externalLocationIdHash: createHash('sha256')
          .update(input.providerLocation.id)
          .digest('hex'),
        warehouseGlobalId: currentAuthority.warehouse_global_id,
        locationGlobalId: currentAuthority.location_global_id,
        rowVersion: result.mapping.rowVersion,
        ownershipClassification: 'merchant_managed',
        providerWrites: 0,
      },
    }, client)
      return result
    })
  } catch (error) {
    if (isProjectionTargetUniqueViolation(error)) {
      persistenceError(
        'SHOPIFY_INVENTORY_PROJECTION_AUTHORITY_CONFLICT',
        'Another connected store owns this ClawPilot inventory projection target',
        409,
      )
    }
    throw error
  }
}

function warehouseMappingCommandResult(
  value: unknown,
): ShopifyInventoryWarehouseMappingCommandResult {
  const mappingResult = mappingCommandResult(value)
  const result = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  const warehouse = result.warehouse && typeof result.warehouse === 'object'
    ? result.warehouse as Record<string, unknown>
    : {}
  return {
    ...mappingResult,
    warehouse: {
      globalId: String(warehouse.globalId || ''),
      code: String(warehouse.code || ''),
      name: String(warehouse.name || ''),
      facilityType: String(warehouse.facilityType || ''),
      timezone: String(warehouse.timezone || ''),
      inventoryLocationGlobalId: String(
        warehouse.inventoryLocationGlobalId || '',
      ),
      inventoryLocationCode: String(
        warehouse.inventoryLocationCode || '',
      ),
    },
  }
}

export async function createShopifyInventoryWarehouseAndMappingInPostgres(
  input: {
    runtime: CommerceRuntimeCredentialRecord
    providerLocation: ShopifyInventoryLocation
    warehouse: {
      code: string
      name: string
      facilityType: string
      timezone: string
    }
    idempotencyKey: string
    actorEmail: string
  },
): Promise<ShopifyInventoryWarehouseMappingCommandResult> {
  if (
    input.providerLocation.isFulfillmentService
    || !input.providerLocation.isActive
    || !input.providerLocation.shipsInventory
    || !input.providerLocation.fulfillsOnlineOrders
  ) {
    persistenceError(
      input.providerLocation.isFulfillmentService
        ? 'SHOPIFY_INVENTORY_FULFILLMENT_SERVICE_LOCATION_FORBIDDEN'
        : 'SHOPIFY_INVENTORY_LOCATION_INELIGIBLE',
      input.providerLocation.isFulfillmentService
        ? 'Inventory owned by another Shopify fulfillment service cannot be mapped as a ClawPilot warehouse'
        : 'Choose an active Shopify location that ships inventory and fulfills online orders',
      409,
    )
  }
  const code = input.warehouse.code.trim().toUpperCase()
  const name = input.warehouse.name.trim()
  const facilityType = input.warehouse.facilityType.trim()
  const timezone = input.warehouse.timezone.trim()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code)) {
    persistenceError(
      'SHOPIFY_INVENTORY_WAREHOUSE_CODE_INVALID',
      'Warehouse code may use letters, numbers, hyphens, and underscores',
      400,
    )
  }
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) {
    persistenceError(
      'SHOPIFY_INVENTORY_WAREHOUSE_NAME_INVALID',
      'Warehouse name is invalid',
      400,
    )
  }
  if (!WAREHOUSE_FACILITY_TYPES.has(facilityType)) {
    persistenceError(
      'SHOPIFY_INVENTORY_WAREHOUSE_FACILITY_INVALID',
      'Warehouse facility type is invalid',
      400,
    )
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    persistenceError(
      'SHOPIFY_INVENTORY_WAREHOUSE_TIMEZONE_INVALID',
      'Warehouse timezone is invalid',
      400,
    )
  }
  const providerAddress = input.providerLocation.address
  const address = {
    name,
    line1: providerAddress.line1.trim(),
    ...(providerAddress.line2.trim()
      ? { line2: providerAddress.line2.trim() }
      : {}),
    city: providerAddress.city.trim(),
    region: (providerAddress.regionCode || providerAddress.region).trim(),
    postalCode: providerAddress.postalCode.trim(),
    country: (
      providerAddress.countryCode || providerAddress.country
    ).trim().toUpperCase(),
  }
  if (
    !address.line1
    || !address.city
    || !address.region
    || !address.postalCode
    || !/^[A-Z]{2}$/.test(address.country)
  ) {
    persistenceError(
      'SHOPIFY_INVENTORY_LOCATION_ADDRESS_INCOMPLETE',
      'Complete the Shopify location shipping address before creating a ClawPilot warehouse from it',
      409,
    )
  }
  const commandType = 'shopify_inventory_warehouse_create_and_map'
  const requestHash = createHash('sha256').update(JSON.stringify({
    version: 1,
    command: commandType,
    accountGlobalId: input.runtime.globalId,
    credentialVersion: input.runtime.credentialVersion,
    externalLocationId: input.providerLocation.id,
    warehouse: { code, name, facilityType, timezone },
    inventoryLocationCode: 'RESERVE-01',
    providerWrites: 0,
  })).digest('hex')
  const providerSnapshot = JSON.stringify(input.providerLocation)
  const providerSnapshotHash = createHash('sha256')
    .update(providerSnapshot)
    .digest('hex')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      [
        SHOPIFY_LOCATION_ROUTING_LOCK,
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
      ].join(':'),
    )
    const prior = await client.query<{
      request_hash: string
      status: string
      result_payload: unknown
    }>(
      `SELECT request_hash, status, result_payload
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [input.runtime.organizationId, commandType, input.idempotencyKey],
    )
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) {
        persistenceError(
          'SHOPIFY_INVENTORY_WAREHOUSE_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for another Shopify warehouse creation',
        )
      }
      if (
        prior.rows[0].status === 'succeeded'
        && prior.rows[0].result_payload
      ) {
        const replay = warehouseMappingCommandResult(
          prior.rows[0].result_payload,
        )
        return { ...replay, replayed: true }
      }
      persistenceError(
        'SHOPIFY_INVENTORY_WAREHOUSE_CREATE_IN_PROGRESS',
        'This Shopify warehouse creation is already in progress',
      )
    }
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id
       ) VALUES ($1::uuid, $2, $3, $4, $5, 'processing', gen_random_uuid())
       RETURNING id::text`,
      [
        input.runtime.organizationId,
        commandType,
        input.idempotencyKey,
        requestHash,
        input.actorEmail,
      ],
    )
    const authority = await client.query<{
      credential_version: number
      verification_status: string
      account_status: string
      pipeline_id: string
    }>(
      `SELECT credential.credential_version,
              credential.verification_status,
              account.status AS account_status,
              activation.data_pipeline_id::text AS pipeline_id
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version =
            account.commerce_credential_generation
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       LIMIT 1
       FOR UPDATE OF account, credential`,
      [input.runtime.organizationId, input.runtime.integrationAccountId],
    )
    const currentAuthority = authority.rows[0]
    if (
      !currentAuthority
      || currentAuthority.credential_version !== input.runtime.credentialVersion
      || currentAuthority.verification_status !== 'verified'
      || currentAuthority.account_status !== 'active'
    ) {
      persistenceError(
        'SHOPIFY_INVENTORY_CONNECTION_STALE',
        'Shopify changed while the warehouse was being created',
      )
    }
    const existingMapping = await client.query(
      `SELECT id
       FROM operations_commerce_inventory_location_mappings
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_location_id = $3
       LIMIT 1
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.providerLocation.id,
      ],
    )
    if (existingMapping.rowCount) {
      persistenceError(
        'SHOPIFY_INVENTORY_LOCATION_MAPPING_CONFLICT',
        'This Shopify location is already mapped to a ClawPilot warehouse',
      )
    }
    let warehouse: { id: string; global_id: string }
    try {
      const created = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_warehouses (
           organization_id, code, name, facility_type, timezone, address,
           status, cutoff_time, carrier_cutoffs, operating_days,
           opens_at, closes_at, standard_processing_minutes,
           daily_order_capacity, created_by, updated_by
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6::jsonb, 'active', NULL,
           '{}'::jsonb, ARRAY[1,2,3,4,5]::smallint[], '08:00'::time,
           '17:00'::time, 120, NULL, $7, $7
         )
         RETURNING id::text, global_id`,
        [
          input.runtime.organizationId,
          code,
          name,
          facilityType,
          timezone,
          JSON.stringify(address),
          input.actorEmail,
        ],
      )
      warehouse = created.rows[0]
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        persistenceError(
          'SHOPIFY_INVENTORY_WAREHOUSE_CODE_EXISTS',
          'A ClawPilot warehouse already uses this code',
        )
      }
      throw error
    }
    const locationIdsByCode = new Map<string, string>()
    const locationGlobalIdsByCode = new Map<string, string>()
    for (const starter of SHOPIFY_WAREHOUSE_STARTER_LOCATIONS) {
      const created = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_locations (
           organization_id, warehouse_id, code, zone, location_type,
           topology_level, parent_location_id, pick_sequence, active,
           storage_function, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, true,
           $9, $10, $10
         )
         RETURNING id::text, global_id`,
        [
          input.runtime.organizationId,
          warehouse.id,
          starter.code,
          starter.zone,
          starter.type,
          starter.level,
          starter.parent
            ? locationIdsByCode.get(starter.parent) || null
            : null,
          starter.sequence,
          starter.storage,
          input.actorEmail,
        ],
      )
      locationIdsByCode.set(starter.code, created.rows[0].id)
      locationGlobalIdsByCode.set(starter.code, created.rows[0].global_id)
    }
    const inventoryLocationId = locationIdsByCode.get('RESERVE-01')
    const inventoryLocationGlobalId = locationGlobalIdsByCode.get(
      'RESERVE-01',
    )
    if (!inventoryLocationId || !inventoryLocationGlobalId) {
      persistenceError(
        'SHOPIFY_INVENTORY_WAREHOUSE_TOPOLOGY_INCOMPLETE',
        'The warehouse starter inventory location was not created',
        500,
      )
    }
    const pool = await client.query<{
      id: string
      pipeline_id: string
    }>(
      `INSERT INTO operations_inventory_pools (
         organization_id, pipeline_id, owner_customer_id, name,
         pool_type, allocation_policy, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, NULL, $3, 'shared', 'fifo', true, $4
       )
       ON CONFLICT (organization_id, name) DO UPDATE
       SET active = true, updated_at = now()
       RETURNING id::text, pipeline_id::text`,
      [
        input.runtime.organizationId,
        currentAuthority.pipeline_id,
        INVENTORY_POOL_NAME,
        input.actorEmail,
      ],
    )
    if (pool.rows[0].pipeline_id !== currentAuthority.pipeline_id) {
      persistenceError(
        'SHOPIFY_INVENTORY_POOL_PIPELINE_CONFLICT',
        'The Shopify inventory pool is bound to a different product catalog',
      )
    }
    const mapping = await client.query<{
      global_id: string
      row_version: string
    }>(
      `INSERT INTO operations_commerce_inventory_location_mappings (
         organization_id, integration_account_id,
         external_location_id, external_location_name,
         external_location_address, warehouse_id, location_id,
         inventory_pool_id, mapping_method, ownership_classification,
         provider_snapshot_json, provider_snapshot_hash,
         provider_observed_at, inventory_import_enabled, active,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid, $7::uuid,
         $8::uuid, 'manual', 'merchant_managed', $9::jsonb, $10, now(),
         true, true, $11, $11
       )
       RETURNING global_id, row_version::text`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.providerLocation.id,
        input.providerLocation.name,
        JSON.stringify(input.providerLocation.address),
        warehouse.id,
        inventoryLocationId,
        pool.rows[0].id,
        providerSnapshot,
        providerSnapshotHash,
        input.actorEmail,
      ],
    )
    const result: ShopifyInventoryWarehouseMappingCommandResult = {
      warehouse: {
        globalId: warehouse.global_id,
        code,
        name,
        facilityType,
        timezone,
        inventoryLocationGlobalId,
        inventoryLocationCode: 'RESERVE-01',
      },
      mapping: {
        globalId: mapping.rows[0].global_id,
        externalLocationId: input.providerLocation.id,
        externalLocationName: input.providerLocation.name,
        ownershipClassification: 'merchant_managed',
        inventoryImportEnabled: true,
        rowVersion: nonNegativeInteger(mapping.rows[0].row_version),
        warehouseGlobalId: warehouse.global_id,
        locationGlobalId: inventoryLocationGlobalId,
      },
      providerWrites: 0,
      replayed: false,
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.warehouse.created',
      aggregateType: 'operations.warehouse',
      aggregateId: warehouse.global_id,
      subject: name,
      organizationId: input.runtime.organizationId,
      eventKey: `operations:warehouse:${warehouse.global_id}:created`,
      payload: {
        code,
        facilityType,
        timezone,
        starterLocationCount: SHOPIFY_WAREHOUSE_STARTER_LOCATIONS.length,
        source: 'shopify_inventory_location',
        providerWrites: 0,
      },
    }, client)
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.inventory.location_mapped',
      aggregateType: 'operations.commerce_inventory_location_mapping',
      aggregateId: mapping.rows[0].global_id,
      organizationId: input.runtime.organizationId,
      eventKey:
        `commerce-inventory-warehouse-create-map:${input.idempotencyKey}`,
      payload: {
        integrationAccountGlobalId: input.runtime.globalId,
        externalLocationIdHash: createHash('sha256')
          .update(input.providerLocation.id)
          .digest('hex'),
        warehouseGlobalId: warehouse.global_id,
        locationGlobalId: inventoryLocationGlobalId,
        rowVersion: result.mapping.rowVersion,
        ownershipClassification: 'merchant_managed',
        providerWrites: 0,
      },
    }, client)
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_global_id = $2,
           result_payload = $3::jsonb, completed_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        receipt.rows[0].id,
        mapping.rows[0].global_id,
        JSON.stringify(result),
      ],
    )
    return result
  })
}

export async function readShopifyInventoryStateFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
  mappingGlobalId?: string | null
}) {
  const account = await query<{
    id: string
    provider: string
  }>(
    `SELECT id::text, provider
     FROM operations_integration_accounts
     WHERE organization_id = $1::uuid
       AND global_id = $2
       AND integration_type = 'commerce'
     LIMIT 1`,
    [input.organizationId, input.accountGlobalId],
  )
  if (!account.rows[0] || account.rows[0].provider !== 'shopify') {
    persistenceError(
      'SHOPIFY_INVENTORY_ACCOUNT_REQUIRED',
      'A Shopify sales channel is required',
      404,
    )
  }
  const latest = await query<LatestRunRow>(
    `SELECT run.global_id, run.provider_fetched_at, run.completed_at,
            run.provider_location_id, run.provider_location_name,
            warehouse.global_id AS warehouse_global_id,
            warehouse.name AS warehouse_name,
            location.global_id AS location_global_id,
            location.code AS location_code,
            COALESCE(
              capture.captured_snapshot,
              content.snapshot_content
            ) -> 'location' AS provider_location,
            COALESCE(
              capture.captured_snapshot,
              content.snapshot_content
            ) -> 'enrichment' AS enrichment,
            run.levels_seen, run.levels_mapped, run.levels_projected,
            run.levels_unmapped,
            run.levels_untracked, run.negative_available_levels,
            run.equation_mismatch_levels,
            run.provider_available_quantity::text,
            run.provider_committed_quantity::text,
            run.provider_on_hand_quantity::text,
            run.operational_available_quantity::text,
            run.positions_created, run.positions_updated,
            run.positions_zeroed, run.provider_writes,
            run.order_quantity_adjustment::text, run.snapshot_hash
     FROM operations_commerce_inventory_sync_runs run
     JOIN operations_commerce_inventory_location_mappings mapping
       ON mapping.organization_id = run.organization_id
      AND mapping.integration_account_id = run.integration_account_id
      AND mapping.id = run.location_mapping_id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = run.organization_id
      AND warehouse.id = run.warehouse_id
     JOIN operations_locations location
       ON location.organization_id = run.organization_id
      AND location.id = run.location_id
     JOIN operations_commerce_inventory_captures capture
       ON capture.organization_id = run.organization_id
      AND capture.integration_account_id = run.integration_account_id
      AND capture.provider_attempt_id = run.provider_attempt_id
      AND capture.id = run.capture_id
     LEFT JOIN operations_commerce_inventory_snapshot_contents content
       ON content.organization_id = capture.organization_id
      AND content.integration_account_id = capture.integration_account_id
      AND content.id = capture.snapshot_content_id
     WHERE run.organization_id = $1::uuid
       AND run.integration_account_id = $2::uuid
       AND ($3::text IS NULL OR mapping.global_id = $3)
     ORDER BY run.completed_at DESC, run.id DESC
     LIMIT 1`,
    [
      input.organizationId,
      account.rows[0].id,
      input.mappingGlobalId || null,
    ],
  )
  const run = latest.rows[0]
  if (!run) {
    return {
      accountGlobalId: input.accountGlobalId,
      status: 'never_synced' as const,
      latestRun: null,
      levels: [],
    }
  }
  const levels = await query<LatestLevelRow>(
    `SELECT level.global_id, level.external_inventory_item_id, level.sku,
            level.tracked, level.mapping_state, level.projection_state,
            product.reference_code AS product_global_id,
            product.name AS product_name,
            level.provider_available_quantity::text,
            level.provider_incoming_quantity::text,
            level.provider_committed_quantity::text,
            level.provider_damaged_quantity::text,
            level.provider_on_hand_quantity::text,
            level.provider_quality_control_quantity::text,
            level.provider_reserved_quantity::text,
            level.provider_safety_stock_quantity::text,
            level.provider_quantity_evidence,
            level.operational_available_quantity::text,
            level.equation_matches, level.provider_updated_at,
            level.provider_weight_grams, level.provider_dimensions_mm,
            level.product_snapshot,
            position.global_id AS inventory_position_global_id,
            position.on_hand_quantity::text AS operational_on_hand_quantity,
            position.reserved_quantity::text
              AS operational_reserved_quantity
     FROM operations_commerce_inventory_levels level
     LEFT JOIN crm_products product
       ON product.pipeline_id = level.pipeline_id
      AND product.id = level.product_id
     LEFT JOIN operations_inventory_positions position
       ON position.organization_id = level.organization_id
      AND position.id = level.inventory_position_id
     WHERE level.organization_id = $1::uuid
       AND level.sync_run_id = (
         SELECT id
         FROM operations_commerce_inventory_sync_runs
         WHERE organization_id = $1::uuid
           AND global_id = $2
         LIMIT 1
       )
     ORDER BY
       CASE level.projection_state WHEN 'projected' THEN 0 ELSE 1 END,
       level.operational_available_quantity DESC,
       lower(COALESCE(product.name, level.sku, '')),
       level.external_inventory_item_id`,
    [input.organizationId, run.global_id],
  )
  return {
    accountGlobalId: input.accountGlobalId,
    status: 'synced' as const,
    latestRun: {
      globalId: run.global_id,
      providerFetchedAt: iso(run.provider_fetched_at),
      completedAt: iso(run.completed_at),
      providerLocationId: run.provider_location_id,
      providerLocationName: run.provider_location_name,
      providerLocation: run.provider_location || null,
      enrichment: run.enrichment || null,
      warehouseGlobalId: run.warehouse_global_id,
      warehouseName: run.warehouse_name,
      locationGlobalId: run.location_global_id,
      locationCode: run.location_code,
      levelsSeen: run.levels_seen,
      levelsMapped: run.levels_mapped,
      levelsProjected: run.levels_projected,
      levelsUnmapped: run.levels_unmapped,
      levelsUntracked: run.levels_untracked,
      negativeAvailableLevels: run.negative_available_levels,
      equationMismatchLevels: run.equation_mismatch_levels,
      providerAvailableQuantity: decimal(
        run.provider_available_quantity,
      ),
      providerCommittedQuantity: decimal(
        run.provider_committed_quantity,
      ),
      providerOnHandQuantity: decimal(run.provider_on_hand_quantity),
      operationalAvailableQuantity: decimal(
        run.operational_available_quantity,
      ),
      positionsCreated: run.positions_created,
      positionsUpdated: run.positions_updated,
      positionsZeroed: run.positions_zeroed,
      providerWrites: run.provider_writes,
      orderQuantityAdjustment: decimal(run.order_quantity_adjustment),
      snapshotHashPrefix: run.snapshot_hash.slice(0, 12),
    },
    levels: levels.rows.map((level) => ({
      globalId: level.global_id,
      externalInventoryItemId: level.external_inventory_item_id,
      sku: level.sku,
      tracked: level.tracked,
      mappingState: level.mapping_state,
      projectionState: level.projection_state,
      productGlobalId: level.product_global_id,
      productName: level.product_name,
      providerQuantities: {
        available: decimal(level.provider_available_quantity),
        incoming: decimal(level.provider_incoming_quantity),
        committed: decimal(level.provider_committed_quantity),
        damaged: decimal(level.provider_damaged_quantity),
        onHand: decimal(level.provider_on_hand_quantity),
        qualityControl: decimal(
          level.provider_quality_control_quantity,
        ),
        reserved: decimal(level.provider_reserved_quantity),
        safetyStock: decimal(level.provider_safety_stock_quantity),
      },
      providerQuantityEvidence: {
        available: level.provider_quantity_evidence?.available || null,
        incoming: level.provider_quantity_evidence?.incoming || null,
        committed: level.provider_quantity_evidence?.committed || null,
        damaged: level.provider_quantity_evidence?.damaged || null,
        onHand: level.provider_quantity_evidence?.on_hand || null,
        qualityControl:
          level.provider_quantity_evidence?.quality_control || null,
        reserved: level.provider_quantity_evidence?.reserved || null,
        safetyStock:
          level.provider_quantity_evidence?.safety_stock || null,
      },
      operationalAvailableQuantity: decimal(
        level.operational_available_quantity,
      ),
      equationMatches: level.equation_matches,
      providerUpdatedAt: iso(level.provider_updated_at),
      providerWeightGrams: level.provider_weight_grams,
      providerDimensionsMm: level.provider_dimensions_mm,
      product: level.product_snapshot || {},
      inventoryPositionGlobalId:
        level.inventory_position_global_id,
      operationalOnHandQuantity:
        level.operational_on_hand_quantity === null
          ? null
          : decimal(level.operational_on_hand_quantity),
      operationalReservedQuantity:
        level.operational_reserved_quantity === null
          ? null
          : decimal(level.operational_reserved_quantity),
    })),
  }
}
