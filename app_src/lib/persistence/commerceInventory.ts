import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
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

const INVENTORY_POOL_NAME = 'Shopify Available-to-Promise'
const INVENTORY_LOT_CODE = 'SHOPIFY_ATP'
const SYNC_ACTION = 'inventory.levels.read'

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
  } | null
}

export type ShopifyInventoryAttempt = {
  id: string
  globalId: string
  attemptNumber: number
  replayed: boolean
  captured: boolean
  leaseToken: string | null
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
  source_inventory_item_ids: string[]
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

function decimal(value: string | number | null | undefined): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null
}

function persistenceError(
  code: string,
  message: string,
  status = 409,
): never {
  throw new CommerceInventoryPersistenceError(code, message, status)
}

export async function readShopifyInventoryTargetFromPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
}): Promise<ShopifyInventoryTarget> {
  const target = await query<TargetRow>(
    `WITH active_warehouse AS (
       SELECT warehouse.id, warehouse.global_id, warehouse.name,
              warehouse.address
       FROM operations_warehouses warehouse
       WHERE warehouse.organization_id = $1::uuid
         AND warehouse.status = 'active'
     ),
     warehouse_count AS (
       SELECT count(*)::integer AS count FROM active_warehouse
     ),
     selected_location AS (
       SELECT location.id, location.global_id, location.code
       FROM operations_locations location
       JOIN active_warehouse warehouse
         ON warehouse.id = location.warehouse_id
       WHERE location.organization_id = $1::uuid
         AND location.active = true
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
     CROSS JOIN warehouse_count count
     CROSS JOIN active_warehouse warehouse
     CROSS JOIN selected_location location
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND count.count = 1
     LIMIT 1`,
    [input.runtime.organizationId, input.runtime.globalId],
  )
  const row = target.rows[0]
  if (!row) {
    const warehouseCount = await query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM operations_warehouses
       WHERE organization_id = $1::uuid AND status = 'active'`,
      [input.runtime.organizationId],
    )
    if (Number(warehouseCount.rows[0]?.count || 0) !== 1) {
      persistenceError(
        'SHOPIFY_INVENTORY_SINGLE_WAREHOUSE_REQUIRED',
        'Shopify inventory sync requires exactly one active warehouse for this development workspace',
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
    || row.account_status === 'error'
  ) {
    persistenceError(
      'SHOPIFY_INVENTORY_CONNECTION_STALE',
      'Reconnect and verify Shopify before syncing inventory',
    )
  }
  const mapping = await query<{
    id: string
    global_id: string
    external_location_id: string
    external_location_name: string
  }>(
    `SELECT id::text, global_id, external_location_id,
            external_location_name
     FROM operations_commerce_inventory_location_mappings
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND active = true
     LIMIT 2`,
    [input.runtime.organizationId, input.runtime.integrationAccountId],
  )
  if (mapping.rows.length > 1) {
    persistenceError(
      'SHOPIFY_INVENTORY_LOCATION_MAPPING_AMBIGUOUS',
      'More than one active Shopify inventory location mapping requires review',
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
    existingMapping: mapping.rows[0]
      ? {
          id: mapping.rows[0].id,
          globalId: mapping.rows[0].global_id,
          externalLocationId: mapping.rows[0].external_location_id,
          externalLocationName: mapping.rows[0].external_location_name,
        }
      : null,
  }
}

export async function prepareShopifyInventoryReadInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  target: ShopifyInventoryTarget
  idempotencyKey: string
  requestHash: string
  actorEmail: string
}): Promise<ShopifyInventoryAttempt> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      [
        'shopify-inventory-read',
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.idempotencyKey,
      ].join(':'),
    )
    const previous = await client.query<{
      id: string
      global_id: string
      attempt_number: number
      request_hash: string
      state: string
      lease_token: string | null
      lease_expires_at: Date | null
      captured: boolean
    }>(
      `SELECT attempt.id::text, attempt.global_id,
              attempt.attempt_number, attempt.request_hash, attempt.state,
              attempt.lease_token::text, attempt.lease_expires_at,
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
      const run = await client.query(
        `SELECT id
         FROM operations_commerce_inventory_sync_runs
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND provider_attempt_id = $3::uuid
         LIMIT 1`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          latest.id,
        ],
      )
      if (!run.rowCount) {
        persistenceError(
          'SHOPIFY_INVENTORY_EVIDENCE_INCOMPLETE',
          'The prior provider read succeeded without a committed inventory snapshot',
          500,
        )
      }
      return {
        id: latest.id,
        globalId: latest.global_id,
        attemptNumber: latest.attempt_number,
        replayed: true,
        captured: true,
        leaseToken: null,
      }
    }
    if (latest?.state === 'prepared') {
      if (latest.captured) {
        return {
          id: latest.id,
          globalId: latest.global_id,
          attemptNumber: latest.attempt_number,
          replayed: false,
          captured: true,
          leaseToken: latest.lease_token,
        }
      }
      if (
        latest.lease_token
        && latest.lease_expires_at
        && latest.lease_expires_at.getTime() > Date.now()
      ) {
        persistenceError(
          'SHOPIFY_INVENTORY_SYNC_IN_PROGRESS',
          'This Shopify inventory sync is already in progress',
        )
      }
      await client.query(
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
           AND state = 'prepared'`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          latest.id,
          JSON.stringify({
            inventoryApplied: false,
            providerWrites: 0,
            orderQuantityAdjustment: 0,
          }),
        ],
      )
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
        }),
        attemptNumber,
        input.actorEmail,
      ],
    )
    return {
      id: inserted.rows[0].id,
      globalId: inserted.rows[0].global_id,
      attemptNumber,
      replayed: false,
      captured: false,
      leaseToken: inserted.rows[0].lease_token,
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

export async function readShopifyInventoryCaptureFromPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  attempt: ShopifyInventoryAttempt
}): Promise<ShopifyInventoryCapture> {
  const result = await query<{
    id: string
    global_id: string
    captured_snapshot: unknown
  }>(
    `SELECT id::text, global_id, captured_snapshot
     FROM operations_commerce_inventory_captures
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND provider_attempt_id = $3::uuid
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
    snapshot: capturedSnapshot(row.captured_snapshot),
  }
}

export async function captureShopifyInventorySnapshotInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  target: ShopifyInventoryTarget
  attempt: ShopifyInventoryAttempt
  requestHash: string
  snapshot: ShopifyInventorySnapshot
  actorEmail: string
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
  if (snapshotBytes < 2 || snapshotBytes > 16 * 1024 * 1024) {
    persistenceError(
      'SHOPIFY_INVENTORY_CAPTURE_SIZE_INVALID',
      'The Shopify inventory capture exceeds the 16 MB evidence limit',
      413,
    )
  }
  return withTransaction(async (client) => {
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
    }>(
      `SELECT id::text, global_id, request_hash, snapshot_hash,
              captured_snapshot
       FROM operations_commerce_inventory_captures
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND provider_attempt_id = $3::uuid
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
        snapshot: capturedSnapshot(row.captured_snapshot),
      }
    }
    const lease = await client.query(
      `SELECT id
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND action = $4
         AND request_hash = $5
         AND state = 'prepared'
         AND lease_token = $6::uuid
         AND lease_expires_at > now()
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
    const inserted = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO operations_commerce_inventory_captures (
         organization_id, integration_account_id, provider_attempt_id,
         warehouse_id, location_id, provider, adapter_version,
         credential_version, request_hash, snapshot_hash,
         provider_location_id, provider_fetched_at, level_count,
         captured_snapshot, snapshot_bytes, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'shopify',
         $6, $7, $8, $9, $10, $11::timestamptz, $12, $13::jsonb,
         $14, $15
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
        serialized,
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
  actorEmail: string
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
         AND (
           $7::uuid IS NULL
           OR lease_token = $7::uuid
         )
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
    actor: input.actorEmail,
    eventType: 'commerce.inventory.sync_failed',
    aggregateType: 'operations.integration_account',
    aggregateId: input.runtime.globalId,
    organizationId: input.runtime.organizationId,
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
  actorEmail: string
}) {
  const snapshot = input.capture.snapshot
  const committed = await withTransaction(async (client) => {
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
       LIMIT 1`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.idempotencyKey,
      ],
    )
    if (replay.rows[0]) {
      return {
        runGlobalId: replay.rows[0].global_id,
        replayed: true,
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
      state: string
    }>(
      `SELECT capture.request_hash, capture.snapshot_hash,
              capture.provider_location_id, capture.level_count,
              capture.warehouse_id::text, capture.location_id::text,
              capture.credential_version, capture.adapter_version,
              attempt.lease_token::text, attempt.state
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
      || !input.attempt.leaseToken
      || captured.lease_token !== input.attempt.leaseToken
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
      || current.account_status === 'error'
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
    const existingMapping = await client.query<{
      id: string
      global_id: string
      external_location_id: string
      warehouse_id: string
      location_id: string
      inventory_pool_id: string
    }>(
      `SELECT id::text, global_id, external_location_id,
              warehouse_id::text, location_id::text,
              inventory_pool_id::text
       FROM operations_commerce_inventory_location_mappings
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND active = true
       LIMIT 1
       FOR UPDATE`,
      [input.runtime.organizationId, input.runtime.integrationAccountId],
    )
    let locationMapping: { id: string; global_id: string }
    if (existingMapping.rows[0]) {
      const mapping = existingMapping.rows[0]
      if (
        mapping.external_location_id !== input.providerLocation.id
        || mapping.warehouse_id !== input.target.warehouse.id
        || mapping.location_id !== input.target.location.id
        || mapping.inventory_pool_id !== pool.rows[0].id
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
               row_version = row_version + 1,
               updated_by = $5,
               updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid
           RETURNING id::text, global_id`,
          [
            input.runtime.organizationId,
            mapping.id,
            input.providerLocation.name,
            JSON.stringify(input.providerLocation.address),
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
             inventory_pool_id, mapping_method, active,
             created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid, $7::uuid,
             $8::uuid, $9, true, $10, $10
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
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
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
    const existing = await client.query<ExistingPositionRow>(
      `SELECT position.id::text, position.global_id,
              position.product_id::text,
              position.on_hand_quantity::text,
              position.reserved_quantity::text,
              position.source_authority,
              ARRAY(
                SELECT DISTINCT evidence.external_inventory_item_id
                FROM operations_commerce_inventory_levels evidence
                WHERE evidence.organization_id =
                    position.organization_id
                  AND evidence.inventory_position_id = position.id
                  AND evidence.sync_run_id = $6::uuid
                ORDER BY evidence.external_inventory_item_id
              )::text[] AS source_inventory_item_ids
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
        previousRunId,
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
      && position.source_inventory_item_ids.length > 0
      && position.source_inventory_item_ids.every(
        (inventoryItemId) => !snapshotInventoryItemIds.has(inventoryItemId),
      )
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
                   source_authority, '{}'::text[]
                     AS source_inventory_item_ids`,
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
         actor_email, idempotency_key
       ) VALUES (
         $1::uuid, 'operations.commerce_inventory_sync', $2::uuid, $3,
         'operations.inventory.shopify_reconciled', 1, $4::jsonb, $5, $6
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
        `shopify-inventory:${input.idempotencyKey}`,
      ],
    )
    return {
      runGlobalId: run.rows[0].global_id,
      replayed: false,
    }
  })
  await recordAuditEvent({
    actor: input.actorEmail,
    eventType: 'commerce.inventory.synced',
    aggregateType: 'operations.commerce_inventory_sync',
    aggregateId: committed.runGlobalId,
    organizationId: input.runtime.organizationId,
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

export async function readShopifyInventoryStateFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
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
            capture.captured_snapshot -> 'location' AS provider_location,
            capture.captured_snapshot -> 'enrichment' AS enrichment,
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
     WHERE run.organization_id = $1::uuid
       AND run.integration_account_id = $2::uuid
     ORDER BY run.completed_at DESC, run.id DESC
     LIMIT 1`,
    [input.organizationId, account.rows[0].id],
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
