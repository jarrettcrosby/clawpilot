import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { commerceReadAccountSql } from '@/lib/integrations/commerceReadRuntime'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const WORKER_HEARTBEAT_KEY =
  'commerce.shopify_inventory_refresh.worker.heartbeat'
const SHOPIFY_INVENTORY_READ_ACCOUNT_SQL = commerceReadAccountSql(
  'account',
  { developmentRequiresActive: true },
)
const INVENTORY_READABLE_CONNECTION_SQL = `(
  COALESCE(account.configuration->'grantedScopes', '[]'::jsonb)
    ?| ARRAY['read_inventory', 'write_inventory']
  AND COALESCE(account.configuration->'grantedScopes', '[]'::jsonb)
    ?| ARRAY['read_locations', 'write_locations']
  AND COALESCE(account.configuration->'grantedScopes', '[]'::jsonb)
    ?| ARRAY['read_products', 'write_products']
)`

export type ShopifyInventoryRefreshJob = {
  id: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  carrierServiceConfigId: string
  warehouseId: string
  locationMappingId: string | null
  locationMappingRowVersion: number | null
  providerLocationId: string | null
  inventoryLocationId: string | null
  inventoryPoolId: string | null
  credentialGeneration: number
  activationRevision: number
  configRowVersion: number
  policyRevision: number
  policyHash: string
  inventoryMaxAgeSeconds: number
  requestedDirtyVersion: number
  attemptCount: number
  maxAttempts: number
  lockToken: string
  startedAt: string
}

export type ShopifyInventoryRefreshRecoveryState = {
  status:
    | 'idle'
    | 'pending'
    | 'processing'
    | 'failed'
    | 'succeeded'
    | 'cancelled'
    | 'dead'
  automaticSchedulingBlocked: boolean
  managerRecoveryRequired: boolean
  recoveredAfterDead: boolean
  lastErrorCode: string | null
  attemptCount: number
  maxAttempts: number
  availableAt: string | null
  completedAt: string | null
  affectedOrders: Array<{
    globalId: string
    orderNumber: string
  }>
}

const OPERATIONS_ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/

function projectedAffectedOrders(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const record = candidate as Record<string, unknown>
    const globalId = typeof record.globalId === 'string'
      ? record.globalId.trim()
      : ''
    const orderNumber = typeof record.orderNumber === 'string'
      ? record.orderNumber.trim()
      : ''
    if (
      !OPERATIONS_ORDER_GLOBAL_ID.test(globalId)
      || !orderNumber
      || orderNumber.length > 100
      || /[\u0000-\u001f\u007f]/u.test(orderNumber)
    ) return []
    return [{ globalId, orderNumber }]
  })
}

function refreshTimestamp(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function projectedRefreshErrorCode(value: string | null | undefined) {
  if (!value) return null
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(value)
    ? value
    : 'SHOPIFY_INVENTORY_REFRESH_FAILED'
}

export async function readShopifyInventoryRefreshRecoveryStateFromPostgres(
  input: {
    organizationId: string
    accountGlobalId: string
  },
): Promise<ShopifyInventoryRefreshRecoveryState> {
  const result = await query<{
    status: ShopifyInventoryRefreshRecoveryState['status'] | null
    last_error_code: string | null
    attempt_count: number | null
    max_attempts: number | null
    available_at: Date | string | null
    completed_at: Date | string | null
    recovered_after_dead: boolean | null
    affected_orders: unknown
  }>(
    `WITH current_config AS (
       SELECT
         config.organization_id,
         config.integration_account_id,
         config.id AS carrier_service_config_id,
         config.warehouse_id,
         config.credential_generation,
         config.activation_revision,
         config.row_version,
         config.policy_revision,
         config.policy_hash,
         config.inventory_max_age_seconds
       FROM operations_integration_accounts account
       JOIN operations_shopify_carrier_service_configs config
         ON config.organization_id = account.organization_id
        AND config.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       LIMIT 1
     )
     SELECT
       COALESCE(
         CASE job.status
           WHEN 'mapped_pending' THEN 'pending'
           WHEN 'mapped_processing' THEN 'processing'
           WHEN 'mapped_failed' THEN 'failed'
           WHEN 'mapped_succeeded' THEN 'succeeded'
           WHEN 'mapped_cancelled' THEN 'cancelled'
           WHEN 'mapped_dead' THEN 'dead'
           ELSE job.status
         END,
         'idle'
       ) AS status,
       job.last_error_code,
       job.attempt_count,
       job.max_attempts,
       job.available_at,
       job.completed_at,
       COALESCE(affected.orders, '[]'::jsonb) AS affected_orders,
       COALESCE(job.recovered_after_dead, false) AS recovered_after_dead
     FROM current_config current
     LEFT JOIN LATERAL (
       SELECT
         job.*,
         CASE
           WHEN job.status NOT IN ('dead', 'mapped_dead') THEN false
           ELSE EXISTS (
             SELECT 1
             FROM operations_commerce_inventory_sync_runs recovered
             WHERE recovered.organization_id = current.organization_id
               AND recovered.integration_account_id =
                   current.integration_account_id
               AND recovered.status = 'succeeded'
               AND recovered.completed_at > job.completed_at
               AND (
                 (
                   job.location_mapping_id IS NOT NULL
                   AND recovered.location_mapping_id =
                       job.location_mapping_id
                   AND recovered.provider_location_id =
                       job.provider_location_id
                   AND recovered.warehouse_id = job.warehouse_id
                   AND recovered.location_id = job.inventory_location_id
                   AND recovered.inventory_pool_id = job.inventory_pool_id
                 )
                 OR (
                   job.location_mapping_id IS NULL
                   AND recovered.warehouse_id = job.warehouse_id
                 )
               )
           )
         END AS recovered_after_dead
       FROM operations_shopify_inventory_refresh_jobs job
       WHERE job.organization_id = current.organization_id
         AND job.integration_account_id = current.integration_account_id
         AND job.carrier_service_config_id =
             current.carrier_service_config_id
         AND job.credential_generation = current.credential_generation
         AND job.activation_revision = current.activation_revision
         AND job.config_row_version = current.row_version
         AND job.policy_revision = current.policy_revision
         AND job.policy_hash = current.policy_hash
         AND job.inventory_max_age_seconds =
             current.inventory_max_age_seconds
         AND (
           (
             job.location_mapping_id IS NULL
             AND job.warehouse_id = current.warehouse_id
             AND NOT EXISTS (
               SELECT 1
               FROM operations_commerce_inventory_location_mappings
                 existing_mapping
               WHERE existing_mapping.organization_id =
                     job.organization_id
                 AND existing_mapping.integration_account_id =
                     job.integration_account_id
             )
           )
           OR EXISTS (
             SELECT 1
             FROM operations_commerce_inventory_location_mappings mapping
             WHERE mapping.organization_id = job.organization_id
               AND mapping.integration_account_id =
                   job.integration_account_id
               AND mapping.id = job.location_mapping_id
               AND mapping.active = true
               AND mapping.inventory_import_enabled = true
               AND mapping.row_version = job.location_mapping_row_version
               AND mapping.external_location_id = job.provider_location_id
               AND mapping.warehouse_id = job.warehouse_id
               AND mapping.location_id = job.inventory_location_id
               AND mapping.inventory_pool_id = job.inventory_pool_id
           )
         )
       ORDER BY
         (
           job.status IN ('dead', 'mapped_dead')
           AND NOT EXISTS (
             SELECT 1
             FROM operations_commerce_inventory_sync_runs recovered
             WHERE recovered.organization_id = current.organization_id
               AND recovered.integration_account_id =
                   current.integration_account_id
               AND recovered.status = 'succeeded'
               AND recovered.completed_at > job.completed_at
               AND (
                 (
                   job.location_mapping_id IS NOT NULL
                   AND recovered.location_mapping_id =
                       job.location_mapping_id
                   AND recovered.provider_location_id =
                       job.provider_location_id
                   AND recovered.warehouse_id = job.warehouse_id
                   AND recovered.location_id = job.inventory_location_id
                   AND recovered.inventory_pool_id = job.inventory_pool_id
                 )
                 OR (
                   job.location_mapping_id IS NULL
                   AND recovered.warehouse_id = job.warehouse_id
                 )
               )
           )
         ) DESC,
         job.created_at DESC,
         job.id DESC
       LIMIT 1
     ) job ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_build_object(
           'globalId', affected_order.global_id,
           'orderNumber', affected_order.order_number
         )
         ORDER BY affected_order.order_number, affected_order.global_id
       ) AS orders
       FROM (
         SELECT DISTINCT source_order.global_id, source_order.order_number
         FROM operations_reservations reservation
         JOIN operations_orders source_order
           ON source_order.organization_id = reservation.organization_id
          AND source_order.id = reservation.order_id
         JOIN LATERAL (
           SELECT plan.id, plan.status
           FROM operations_fulfillment_plans plan
           WHERE plan.organization_id = source_order.organization_id
             AND plan.order_id = source_order.id
           ORDER BY plan.version_number DESC, plan.id DESC
           LIMIT 1
         ) latest_plan ON true
         JOIN operations_inventory_positions position
           ON position.organization_id = reservation.organization_id
          AND position.id = reservation.position_id
         JOIN operations_commerce_inventory_levels source_level
           ON source_level.organization_id = reservation.organization_id
          AND source_level.id = reservation.provider_inventory_level_id
         WHERE reservation.organization_id = current.organization_id
           AND reservation.status = 'active'
           AND reservation.reservation_authority = 'provider_commitment'
           AND source_order.archived_at IS NULL
           AND source_order.status = 'released'
           AND latest_plan.status = 'released'
           AND position.warehouse_id = job.warehouse_id
           AND (
             job.location_mapping_id IS NULL
             OR (
               position.location_id = job.inventory_location_id
               AND position.pool_id = job.inventory_pool_id
             )
           )
           AND source_level.integration_account_id =
               current.integration_account_id
           AND job.status IN ('dead', 'mapped_dead')
           AND job.last_error_code =
               'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT'
           AND operations_shopify_external_fulfillment_reconciliation_required(
                 current.organization_id,
                 latest_plan.id
               )
         ORDER BY source_order.order_number, source_order.global_id
         LIMIT 10
       ) affected_order
     ) affected ON true`,
    [input.organizationId, input.accountGlobalId],
  )
  const row = result.rows[0]
  const status = row?.status || 'idle'
  const recoveredAfterDead = row?.recovered_after_dead === true
  const managerRecoveryRequired = (
    status === 'dead' && !recoveredAfterDead
  )
  const lastErrorCode = projectedRefreshErrorCode(row?.last_error_code)
  return {
    status,
    automaticSchedulingBlocked: managerRecoveryRequired,
    managerRecoveryRequired,
    recoveredAfterDead,
    lastErrorCode,
    attemptCount: Number(row?.attempt_count || 0),
    maxAttempts: Number(row?.max_attempts || 0),
    availableAt: refreshTimestamp(row?.available_at),
    completedAt: refreshTimestamp(row?.completed_at),
    affectedOrders: managerRecoveryRequired
      && lastErrorCode === 'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT'
      ? projectedAffectedOrders(row?.affected_orders)
      : [],
  }
}

export async function signalShopifyInventoryRefreshWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    credentialGeneration: number
    receiptGlobalId: string
    providerTriggeredAt: string | null
  },
) {
  await acquireTransactionAdvisoryLock(
    client,
    `shopify-inventory-watermark:${input.organizationId}:${input.integrationAccountId}`,
  )
  const signaled = await client.query<{
    dirty_version: string
    reconciled_version: string
  }>(
    `INSERT INTO operations_shopify_inventory_refresh_watermarks (
       organization_id,
       integration_account_id,
       credential_generation,
       dirty_version,
       reconciled_version,
       last_receipt_global_id,
       last_provider_triggered_at,
       last_received_at,
       last_signaled_at
     ) VALUES (
       $1::uuid,
       $2::uuid,
       $3::integer,
       1,
       0,
       $4,
       $5::timestamptz,
       clock_timestamp(),
       clock_timestamp()
     )
     ON CONFLICT (organization_id, integration_account_id)
     DO UPDATE SET
       credential_generation = EXCLUDED.credential_generation,
       dirty_version =
         operations_shopify_inventory_refresh_watermarks.dirty_version + 1,
       last_receipt_global_id = EXCLUDED.last_receipt_global_id,
       last_provider_triggered_at = CASE
         WHEN EXCLUDED.last_provider_triggered_at IS NULL THEN
           operations_shopify_inventory_refresh_watermarks
             .last_provider_triggered_at
         WHEN operations_shopify_inventory_refresh_watermarks
                .last_provider_triggered_at IS NULL THEN
           EXCLUDED.last_provider_triggered_at
         ELSE GREATEST(
           operations_shopify_inventory_refresh_watermarks
             .last_provider_triggered_at,
           EXCLUDED.last_provider_triggered_at
         )
       END,
       last_received_at = EXCLUDED.last_received_at,
       last_signaled_at = EXCLUDED.last_signaled_at,
       updated_at = clock_timestamp()
     RETURNING dirty_version::text, reconciled_version::text`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.credentialGeneration,
      input.receiptGlobalId,
      input.providerTriggeredAt,
    ],
  )
  const row = signaled.rows[0]
  if (!row) {
    throw new Error('Shopify inventory refresh watermark was not recorded')
  }
  return {
    dirtyVersion: Number(row.dirty_version),
    reconciledVersion: Number(row.reconciled_version),
  }
}

export async function readShopifyInventoryRefreshDirtyVersionInPostgres(
  input: {
    organizationId: string
    integrationAccountId: string
  },
) {
  const result = await query<{ dirty_version: string }>(
    `SELECT dirty_version::text
     FROM operations_shopify_inventory_refresh_watermarks
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
     LIMIT 1`,
    [input.organizationId, input.integrationAccountId],
  )
  return Number(result.rows[0]?.dirty_version || 0)
}

export async function acknowledgeManualShopifyInventoryRefreshInPostgres(
  input: {
    organizationId: string
    integrationAccountId: string
    credentialGeneration: number
    requestedDirtyVersion: number
    inventoryRunGlobalId: string
  },
) {
  if (input.requestedDirtyVersion <= 0) return false
  const result = await query(
    `UPDATE operations_shopify_inventory_refresh_watermarks
     SET reconciled_version = GREATEST(
           reconciled_version,
           $4::bigint
         ),
         credential_generation = GREATEST(
           credential_generation,
           $3::integer
         ),
         last_reconciled_at = clock_timestamp(),
         last_reconciled_run_global_id = $5,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND credential_generation <= $3::integer
       AND dirty_version >= $4::bigint`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.credentialGeneration,
      input.requestedDirtyVersion,
      input.inventoryRunGlobalId,
    ],
  )
  if (result.rowCount !== 1) {
    const incomplete = new Error(
      'Manual Shopify inventory refresh did not acknowledge its dirty watermark',
    ) as Error & { code?: string }
    incomplete.code = 'SHOPIFY_INVENTORY_REFRESH_WATERMARK_REQUIRED'
    throw incomplete
  }
  return true
}

const PERMANENT_ERROR_CODES = new Set([
  'SHOPIFY_INVENTORY_ACCOUNT_REQUIRED',
  'SHOPIFY_INVENTORY_CREDENTIAL_INVALID',
  'SHOPIFY_INVENTORY_DEVELOPMENT_ONLY',
  'SHOPIFY_INVENTORY_DISABLED',
  'SHOPIFY_INVENTORY_LOCATION_MAPPING_AMBIGUOUS',
  'SHOPIFY_INVENTORY_LOCATION_REQUIRED',
  'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT',
  'SHOPIFY_INVENTORY_SCOPE_REQUIRED',
  'SHOPIFY_INVENTORY_VERIFICATION_REQUIRED',
  'SHOPIFY_STORE_IDENTITY_CHANGED',
])

function safeErrorCode(error: unknown) {
  const candidate = (
    error
    && typeof error === 'object'
    && 'code' in error
  )
    ? String((error as { code?: unknown }).code || '')
    : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(candidate)
    ? candidate
    : 'SHOPIFY_INVENTORY_REFRESH_FAILED'
}

function currentFenceSql(jobAlias = 'job') {
  return `
    JOIN operations_shopify_carrier_service_configs config
      ON config.organization_id = ${jobAlias}.organization_id
     AND config.id = ${jobAlias}.carrier_service_config_id
     AND config.integration_account_id = ${jobAlias}.integration_account_id
     AND (
       ${jobAlias}.location_mapping_id IS NOT NULL
       OR config.warehouse_id = ${jobAlias}.warehouse_id
     )
     AND config.credential_generation = ${jobAlias}.credential_generation
     AND config.activation_revision = ${jobAlias}.activation_revision
     AND config.row_version = ${jobAlias}.config_row_version
     AND config.policy_revision = ${jobAlias}.policy_revision
     AND config.policy_hash = ${jobAlias}.policy_hash
     AND config.inventory_max_age_seconds =
         ${jobAlias}.inventory_max_age_seconds
    JOIN operations_integration_accounts account
      ON account.organization_id = ${jobAlias}.organization_id
     AND account.id = ${jobAlias}.integration_account_id
     AND account.integration_type = 'commerce'
     AND account.provider = 'shopify'
     AND ${SHOPIFY_INVENTORY_READ_ACCOUNT_SQL}
     AND account.commerce_credential_generation =
         ${jobAlias}.credential_generation
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = ${jobAlias}.organization_id
     AND credential.integration_account_id =
         ${jobAlias}.integration_account_id
     AND credential.credential_version = ${jobAlias}.credential_generation
     AND credential.verification_status = 'verified'
    LEFT JOIN operations_commerce_inventory_location_mappings mapping
      ON mapping.organization_id = ${jobAlias}.organization_id
     AND mapping.integration_account_id =
         ${jobAlias}.integration_account_id
     AND mapping.id = ${jobAlias}.location_mapping_id
     AND mapping.active = true
     AND mapping.inventory_import_enabled = true
     AND mapping.row_version = ${jobAlias}.location_mapping_row_version
     AND mapping.external_location_id = ${jobAlias}.provider_location_id
     AND mapping.warehouse_id = ${jobAlias}.warehouse_id
     AND mapping.location_id = ${jobAlias}.inventory_location_id
     AND mapping.inventory_pool_id = ${jobAlias}.inventory_pool_id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = ${jobAlias}.organization_id
     AND activation.revision = ${jobAlias}.activation_revision
     AND (
       ${jobAlias}.location_mapping_id IS NULL
       OR mapping.id IS NOT NULL
     )
     AND (
       ${jobAlias}.location_mapping_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
         FROM operations_commerce_inventory_location_mappings
           existing_mapping
         WHERE existing_mapping.organization_id =
               ${jobAlias}.organization_id
           AND existing_mapping.integration_account_id =
               ${jobAlias}.integration_account_id
       )
     )
     AND (
       (config.registration_state = 'registered'
         AND activation.state IN ('shadow', 'active'))
       OR
       (config.registration_state = 'shadow_simulated'
         AND activation.state = 'shadow')
     )
  `
}

export async function queueAutomaticShopifyInventoryRefreshesInPostgres() {
  return withTransaction(async (client) => {
    const stale = await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs job
       SET status = CASE
             WHEN job.status IN ('processing', 'mapped_processing')
               THEN job.status
             WHEN job.location_mapping_id IS NULL THEN 'cancelled'
             ELSE 'mapped_cancelled'
           END,
           cancel_requested = true,
           completed_at = CASE
             WHEN job.status IN ('processing', 'mapped_processing')
               THEN job.completed_at
             ELSE now()
           END,
           last_error_code = 'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
           updated_at = now()
       WHERE job.status IN (
           'pending', 'processing', 'failed',
           'mapped_pending', 'mapped_processing', 'mapped_failed'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM operations_shopify_carrier_service_configs config
           JOIN operations_integration_accounts account
             ON account.organization_id = config.organization_id
            AND account.id = config.integration_account_id
           JOIN operations_commerce_credentials credential
             ON credential.organization_id = account.organization_id
            AND credential.integration_account_id = account.id
           JOIN operations_activation_scopes activation
             ON activation.organization_id = config.organization_id
           LEFT JOIN operations_commerce_inventory_location_mappings mapping
             ON mapping.organization_id = job.organization_id
            AND mapping.integration_account_id = job.integration_account_id
            AND mapping.id = job.location_mapping_id
            AND mapping.active = true
            AND mapping.inventory_import_enabled = true
            AND mapping.row_version = job.location_mapping_row_version
            AND mapping.external_location_id = job.provider_location_id
            AND mapping.warehouse_id = job.warehouse_id
            AND mapping.location_id = job.inventory_location_id
            AND mapping.inventory_pool_id = job.inventory_pool_id
           WHERE config.organization_id = job.organization_id
             AND config.id = job.carrier_service_config_id
             AND config.integration_account_id =
                 job.integration_account_id
             AND (
               job.location_mapping_id IS NOT NULL
               OR config.warehouse_id = job.warehouse_id
             )
             AND config.credential_generation =
                 job.credential_generation
             AND config.activation_revision = job.activation_revision
             AND config.row_version = job.config_row_version
             AND config.policy_revision = job.policy_revision
             AND config.policy_hash = job.policy_hash
             AND config.inventory_max_age_seconds =
                 job.inventory_max_age_seconds
             AND account.integration_type = 'commerce'
             AND account.provider = 'shopify'
             AND ${SHOPIFY_INVENTORY_READ_ACCOUNT_SQL}
             AND account.commerce_credential_generation =
                 job.credential_generation
             AND credential.credential_version =
                 job.credential_generation
             AND credential.verification_status = 'verified'
             AND activation.revision = job.activation_revision
             AND (
               (config.registration_state = 'registered'
                 AND activation.state IN ('shadow', 'active'))
               OR
               (config.registration_state = 'shadow_simulated'
                 AND activation.state = 'shadow')
             )
             AND ${INVENTORY_READABLE_CONNECTION_SQL}
             AND operations_shopify_carrier_service_config_is_ready(
               config.organization_id, config.id
             )
             AND (
               job.location_mapping_id IS NULL
               OR mapping.id IS NOT NULL
             )
             AND (
               job.location_mapping_id IS NOT NULL
               OR NOT EXISTS (
                 SELECT 1
                 FROM operations_commerce_inventory_location_mappings
                   existing_mapping
                 WHERE existing_mapping.organization_id =
                       job.organization_id
                   AND existing_mapping.integration_account_id =
                       job.integration_account_id
               )
             )
         )`,
    )
    const mapped = await client.query(
      `WITH eligible AS (
         SELECT
           config.organization_id,
           config.integration_account_id,
           config.id AS carrier_service_config_id,
           config.credential_generation,
           config.activation_revision,
           config.row_version AS config_row_version,
           config.policy_revision,
           config.policy_hash,
           config.inventory_max_age_seconds,
           COALESCE(watermark.dirty_version, 0) AS dirty_version,
           COALESCE(watermark.reconciled_version, 0) AS reconciled_version
         FROM operations_shopify_carrier_service_configs config
         JOIN operations_integration_accounts account
           ON account.organization_id = config.organization_id
          AND account.id = config.integration_account_id
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = config.organization_id
         LEFT JOIN operations_shopify_inventory_refresh_watermarks watermark
           ON watermark.organization_id = config.organization_id
          AND watermark.integration_account_id =
              config.integration_account_id
         WHERE config.registration_state IN (
             'shadow_simulated', 'registered'
           )
           AND account.integration_type = 'commerce'
           AND account.provider = 'shopify'
           AND ${SHOPIFY_INVENTORY_READ_ACCOUNT_SQL}
           AND account.commerce_credential_generation =
               config.credential_generation
           AND credential.credential_version = config.credential_generation
           AND credential.verification_status = 'verified'
           AND activation.revision = config.activation_revision
           AND (
             (config.registration_state = 'registered'
               AND activation.state IN ('shadow', 'active'))
             OR
             (config.registration_state = 'shadow_simulated'
               AND activation.state = 'shadow')
           )
           AND ${INVENTORY_READABLE_CONNECTION_SQL}
           AND operations_shopify_carrier_service_config_is_ready(
             config.organization_id, config.id
           )
       )
       INSERT INTO operations_shopify_inventory_refresh_jobs (
         organization_id, integration_account_id,
         carrier_service_config_id, warehouse_id,
         location_mapping_id, location_mapping_row_version,
         provider_location_id, inventory_location_id, inventory_pool_id,
         credential_generation, activation_revision,
         config_row_version, policy_revision, policy_hash,
         inventory_max_age_seconds, requested_dirty_version, status
       )
       SELECT
         eligible.organization_id,
         eligible.integration_account_id,
         eligible.carrier_service_config_id,
         mapping.warehouse_id,
         mapping.id,
         mapping.row_version,
         mapping.external_location_id,
         mapping.location_id,
         mapping.inventory_pool_id,
         eligible.credential_generation,
         eligible.activation_revision,
         eligible.config_row_version,
         eligible.policy_revision,
         eligible.policy_hash,
         eligible.inventory_max_age_seconds,
         eligible.dirty_version,
         'mapped_pending'
       FROM eligible
       JOIN operations_commerce_inventory_location_mappings mapping
         ON mapping.organization_id = eligible.organization_id
        AND mapping.integration_account_id =
            eligible.integration_account_id
        AND mapping.active = true
        AND mapping.inventory_import_enabled = true
       WHERE NOT EXISTS (
           SELECT 1
           FROM operations_shopify_inventory_refresh_jobs dead
           WHERE dead.organization_id = eligible.organization_id
             AND dead.integration_account_id =
                 eligible.integration_account_id
             AND dead.carrier_service_config_id =
                 eligible.carrier_service_config_id
             AND dead.location_mapping_id = mapping.id
             AND dead.location_mapping_row_version = mapping.row_version
             AND dead.provider_location_id = mapping.external_location_id
             AND dead.warehouse_id = mapping.warehouse_id
             AND dead.inventory_location_id = mapping.location_id
             AND dead.inventory_pool_id = mapping.inventory_pool_id
             AND dead.credential_generation =
                 eligible.credential_generation
             AND dead.activation_revision = eligible.activation_revision
             AND dead.config_row_version = eligible.config_row_version
             AND dead.policy_revision = eligible.policy_revision
             AND dead.policy_hash = eligible.policy_hash
             AND dead.status = 'mapped_dead'
             AND NOT EXISTS (
               SELECT 1
               FROM operations_commerce_inventory_sync_runs recovered
               WHERE recovered.organization_id = eligible.organization_id
                 AND recovered.integration_account_id =
                     eligible.integration_account_id
                 AND recovered.location_mapping_id = mapping.id
                 AND recovered.provider_location_id =
                     mapping.external_location_id
                 AND recovered.warehouse_id = mapping.warehouse_id
                 AND recovered.location_id = mapping.location_id
                 AND recovered.inventory_pool_id =
                     mapping.inventory_pool_id
                 AND recovered.status = 'succeeded'
                 AND recovered.completed_at > dead.completed_at
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM operations_shopify_inventory_refresh_jobs succeeded
           WHERE succeeded.organization_id = eligible.organization_id
             AND succeeded.integration_account_id =
                 eligible.integration_account_id
             AND succeeded.carrier_service_config_id =
                 eligible.carrier_service_config_id
             AND succeeded.location_mapping_id = mapping.id
             AND succeeded.location_mapping_row_version = mapping.row_version
             AND succeeded.provider_location_id = mapping.external_location_id
             AND succeeded.warehouse_id = mapping.warehouse_id
             AND succeeded.inventory_location_id = mapping.location_id
             AND succeeded.inventory_pool_id = mapping.inventory_pool_id
             AND succeeded.credential_generation =
                 eligible.credential_generation
             AND succeeded.activation_revision =
                 eligible.activation_revision
             AND succeeded.config_row_version =
                 eligible.config_row_version
             AND succeeded.policy_revision = eligible.policy_revision
             AND succeeded.policy_hash = eligible.policy_hash
             AND succeeded.inventory_max_age_seconds =
                 eligible.inventory_max_age_seconds
             AND succeeded.requested_dirty_version = eligible.dirty_version
             AND succeeded.status = 'mapped_succeeded'
         )
         AND (
           eligible.dirty_version > eligible.reconciled_version
           OR NOT EXISTS (
             SELECT 1
             FROM operations_commerce_inventory_sync_runs recent
             WHERE recent.organization_id = eligible.organization_id
               AND recent.integration_account_id =
                   eligible.integration_account_id
               AND recent.location_mapping_id = mapping.id
               AND recent.provider_location_id =
                   mapping.external_location_id
               AND recent.warehouse_id = mapping.warehouse_id
               AND recent.location_id = mapping.location_id
               AND recent.inventory_pool_id = mapping.inventory_pool_id
               AND recent.status = 'succeeded'
               AND recent.provider_fetched_at > now() - make_interval(
                 secs => GREATEST(
                   15,
                   floor(
                     eligible.inventory_max_age_seconds / 2.0
                   )::integer
                 )
               )
           )
         )
       ON CONFLICT (
         organization_id, integration_account_id, location_mapping_id
       ) WHERE location_mapping_id IS NOT NULL
         AND status IN (
           'mapped_pending', 'mapped_processing', 'mapped_failed'
         )
       DO UPDATE SET
         requested_dirty_version = EXCLUDED.requested_dirty_version,
         status = 'mapped_pending',
         available_at = now(),
         last_error_code = NULL,
         updated_at = now()
       WHERE operations_shopify_inventory_refresh_jobs.status IN (
         'mapped_pending', 'mapped_failed'
       )
         -- Only a genuinely newer webhook signal may supersede a failed
         -- job's exponential retry delay.
         AND EXCLUDED.requested_dirty_version >
           operations_shopify_inventory_refresh_jobs
             .requested_dirty_version`,
    )
    const legacy = await client.query(
      `WITH eligible AS (
         SELECT
           config.organization_id,
           config.integration_account_id,
           config.id AS carrier_service_config_id,
           config.warehouse_id,
           config.credential_generation,
           config.activation_revision,
           config.row_version AS config_row_version,
           config.policy_revision,
           config.policy_hash,
           config.inventory_max_age_seconds,
           COALESCE(watermark.dirty_version, 0) AS dirty_version,
           COALESCE(watermark.reconciled_version, 0) AS reconciled_version
         FROM operations_shopify_carrier_service_configs config
         JOIN operations_integration_accounts account
           ON account.organization_id = config.organization_id
          AND account.id = config.integration_account_id
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = config.organization_id
         LEFT JOIN operations_shopify_inventory_refresh_watermarks watermark
           ON watermark.organization_id = config.organization_id
          AND watermark.integration_account_id =
              config.integration_account_id
         WHERE config.registration_state IN (
             'shadow_simulated', 'registered'
           )
           AND account.integration_type = 'commerce'
           AND account.provider = 'shopify'
           AND ${SHOPIFY_INVENTORY_READ_ACCOUNT_SQL}
           AND account.commerce_credential_generation =
               config.credential_generation
           AND credential.credential_version = config.credential_generation
           AND credential.verification_status = 'verified'
           AND activation.revision = config.activation_revision
           AND (
             (config.registration_state = 'registered'
               AND activation.state IN ('shadow', 'active'))
             OR
             (config.registration_state = 'shadow_simulated'
               AND activation.state = 'shadow')
           )
           AND ${INVENTORY_READABLE_CONNECTION_SQL}
           AND operations_shopify_carrier_service_config_is_ready(
             config.organization_id, config.id
           )
       )
       INSERT INTO operations_shopify_inventory_refresh_jobs (
         organization_id, integration_account_id,
         carrier_service_config_id, warehouse_id,
         credential_generation, activation_revision,
         config_row_version, policy_revision, policy_hash,
         inventory_max_age_seconds, requested_dirty_version
       )
       SELECT
         eligible.organization_id,
         eligible.integration_account_id,
         eligible.carrier_service_config_id,
         eligible.warehouse_id,
         eligible.credential_generation,
         eligible.activation_revision,
         eligible.config_row_version,
         eligible.policy_revision,
         eligible.policy_hash,
         eligible.inventory_max_age_seconds,
         eligible.dirty_version
       FROM eligible
       WHERE NOT EXISTS (
         SELECT 1
         FROM operations_commerce_inventory_location_mappings mapping
         WHERE mapping.organization_id = eligible.organization_id
           AND mapping.integration_account_id =
               eligible.integration_account_id
       )
         AND NOT EXISTS (
           SELECT 1
           FROM operations_shopify_inventory_refresh_jobs dead
           WHERE dead.organization_id = eligible.organization_id
             AND dead.integration_account_id =
                 eligible.integration_account_id
             AND dead.carrier_service_config_id =
                 eligible.carrier_service_config_id
             AND dead.location_mapping_id IS NULL
             AND dead.credential_generation =
                 eligible.credential_generation
             AND dead.activation_revision = eligible.activation_revision
             AND dead.config_row_version = eligible.config_row_version
             AND dead.policy_revision = eligible.policy_revision
             AND dead.policy_hash = eligible.policy_hash
             AND dead.status = 'dead'
             AND NOT EXISTS (
               SELECT 1
               FROM operations_commerce_inventory_sync_runs recovered
               WHERE recovered.organization_id = eligible.organization_id
                 AND recovered.integration_account_id =
                     eligible.integration_account_id
                 AND recovered.warehouse_id = eligible.warehouse_id
                 AND recovered.status = 'succeeded'
                 AND recovered.completed_at > dead.completed_at
             )
         )
         AND (
           eligible.dirty_version > eligible.reconciled_version
           OR NOT EXISTS (
             SELECT 1
             FROM operations_commerce_inventory_sync_runs recent
             WHERE recent.organization_id = eligible.organization_id
               AND recent.integration_account_id =
                   eligible.integration_account_id
               AND recent.warehouse_id = eligible.warehouse_id
               AND recent.status = 'succeeded'
               AND recent.provider_fetched_at > now() - make_interval(
                 secs => GREATEST(
                   15,
                   floor(
                     eligible.inventory_max_age_seconds / 2.0
                   )::integer
                 )
               )
           )
         )
       ON CONFLICT (
         organization_id, integration_account_id
       ) WHERE location_mapping_id IS NULL
         AND status IN ('pending', 'processing', 'failed')
       DO UPDATE SET
         requested_dirty_version = EXCLUDED.requested_dirty_version,
         status = 'pending',
         available_at = now(),
         last_error_code = NULL,
         updated_at = now()
       WHERE operations_shopify_inventory_refresh_jobs.status IN (
         'pending', 'failed'
       )
         AND EXCLUDED.requested_dirty_version >
           operations_shopify_inventory_refresh_jobs
             .requested_dirty_version`,
    )
    return {
      queued: (mapped.rowCount || 0) + (legacy.rowCount || 0),
      cancelled: stale.rowCount || 0,
    }
  })
}

export async function claimShopifyInventoryRefreshJobsInPostgres(input: {
  limit: number
  workerId: string
}) {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET status = CASE
             WHEN cancel_requested AND location_mapping_id IS NULL
               THEN 'cancelled'
             WHEN cancel_requested THEN 'mapped_cancelled'
             WHEN attempt_count >= max_attempts
                  AND location_mapping_id IS NULL THEN 'dead'
             WHEN attempt_count >= max_attempts THEN 'mapped_dead'
             WHEN location_mapping_id IS NULL THEN 'failed'
             ELSE 'mapped_failed'
           END,
           completed_at = CASE
             WHEN cancel_requested OR attempt_count >= max_attempts
               THEN now()
             ELSE NULL
           END,
           available_at = now(),
           last_error_code = CASE
             WHEN cancel_requested
               THEN 'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED'
             ELSE 'SHOPIFY_INVENTORY_REFRESH_LEASE_EXPIRED'
           END,
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE status IN ('processing', 'mapped_processing')
         AND lease_expires_at <= now()`,
    )
    const claimed = await client.query<{
      id: string
      organization_id: string
      integration_account_id: string
      account_global_id: string
      carrier_service_config_id: string
      warehouse_id: string
      location_mapping_id: string | null
      location_mapping_row_version: string | null
      provider_location_id: string | null
      inventory_location_id: string | null
      inventory_pool_id: string | null
      credential_generation: number
      activation_revision: number
      config_row_version: string
      policy_revision: string
      policy_hash: string
      inventory_max_age_seconds: number
      requested_dirty_version: string
      attempt_count: number
      max_attempts: number
      lock_token: string
      started_at: Date | string
    }>(
      `WITH candidate_accounts AS (
         SELECT account.organization_id, account.id
         FROM operations_integration_accounts account
         WHERE account.integration_type = 'commerce'
           AND account.provider = 'shopify'
           AND EXISTS (
             SELECT 1
             FROM operations_shopify_inventory_refresh_jobs waiting
             WHERE waiting.organization_id = account.organization_id
               AND waiting.integration_account_id = account.id
               AND waiting.status IN (
                 'pending', 'failed', 'mapped_pending', 'mapped_failed'
               )
               AND waiting.available_at <= now()
               AND waiting.cancel_requested = false
           )
           AND NOT EXISTS (
             SELECT 1
             FROM operations_shopify_inventory_refresh_jobs processing
             WHERE processing.organization_id = account.organization_id
               AND processing.integration_account_id = account.id
               AND processing.status IN ('processing', 'mapped_processing')
           )
         ORDER BY account.organization_id, account.id
         FOR UPDATE OF account SKIP LOCKED
         LIMIT $1
       ),
       candidates AS (
         SELECT selected.id
         FROM candidate_accounts candidate_account
         CROSS JOIN LATERAL (
           SELECT job.id
           FROM operations_shopify_inventory_refresh_jobs job
           ${currentFenceSql()}
           WHERE job.organization_id = candidate_account.organization_id
             AND job.integration_account_id = candidate_account.id
             AND job.status IN (
               'pending', 'failed', 'mapped_pending', 'mapped_failed'
             )
             AND job.available_at <= now()
             AND job.cancel_requested = false
             AND ${INVENTORY_READABLE_CONNECTION_SQL}
             AND operations_shopify_carrier_service_config_is_ready(
               config.organization_id, config.id
             )
             AND NOT EXISTS (
               SELECT 1
               FROM operations_shopify_inventory_refresh_jobs processing
               WHERE processing.organization_id = job.organization_id
                 AND processing.integration_account_id =
                     job.integration_account_id
                 AND processing.status IN (
                   'processing', 'mapped_processing'
                 )
             )
           ORDER BY job.available_at, job.created_at, job.id
           FOR UPDATE OF job SKIP LOCKED
           LIMIT 1
         ) selected
       )
       UPDATE operations_shopify_inventory_refresh_jobs job
       SET status = CASE
             WHEN job.location_mapping_id IS NULL THEN 'processing'
             ELSE 'mapped_processing'
           END,
           attempt_count = job.attempt_count + 1,
           locked_at = now(),
           locked_by = $2,
           lock_token = gen_random_uuid(),
           lease_expires_at = now() + interval '20 minutes',
           started_at = now(),
           last_error_code = NULL,
           updated_at = now()
       FROM candidates, operations_integration_accounts account
       WHERE job.id = candidates.id
         AND account.organization_id = job.organization_id
         AND account.id = job.integration_account_id
       RETURNING
         job.id::text,
         job.organization_id::text,
         job.integration_account_id::text,
         account.global_id AS account_global_id,
         job.carrier_service_config_id::text,
         job.warehouse_id::text,
         job.location_mapping_id::text,
         job.location_mapping_row_version::text,
         job.provider_location_id,
         job.inventory_location_id::text,
         job.inventory_pool_id::text,
         job.credential_generation,
         job.activation_revision,
         job.config_row_version::text,
         job.policy_revision::text,
         job.policy_hash,
         job.inventory_max_age_seconds,
         job.requested_dirty_version::text,
         job.attempt_count,
         job.max_attempts,
         job.lock_token::text,
         job.started_at`,
      [
        Math.max(1, Math.min(Number(input.limit || 2), 10)),
        input.workerId.slice(0, 200),
      ],
    )
    return claimed.rows.map((row): ShopifyInventoryRefreshJob => ({
      id: row.id,
      organizationId: row.organization_id,
      integrationAccountId: row.integration_account_id,
      accountGlobalId: row.account_global_id,
      carrierServiceConfigId: row.carrier_service_config_id,
      warehouseId: row.warehouse_id,
      locationMappingId: row.location_mapping_id,
      locationMappingRowVersion: row.location_mapping_row_version === null
        ? null
        : Number(row.location_mapping_row_version),
      providerLocationId: row.provider_location_id,
      inventoryLocationId: row.inventory_location_id,
      inventoryPoolId: row.inventory_pool_id,
      credentialGeneration: row.credential_generation,
      activationRevision: row.activation_revision,
      configRowVersion: Number(row.config_row_version),
      policyRevision: Number(row.policy_revision),
      policyHash: row.policy_hash,
      inventoryMaxAgeSeconds: row.inventory_max_age_seconds,
      requestedDirtyVersion: Number(row.requested_dirty_version),
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      lockToken: row.lock_token,
      startedAt: new Date(row.started_at).toISOString(),
    }))
  })
}

async function currentJobFence(
  client: PoolClient,
  job: ShopifyInventoryRefreshJob,
) {
  const current = await client.query(
    `SELECT 1
     FROM operations_shopify_inventory_refresh_jobs job
     ${currentFenceSql()}
     WHERE job.id = $1::uuid
       AND job.organization_id = $2::uuid
       AND job.integration_account_id = $3::uuid
       AND (
         (job.location_mapping_id IS NULL AND job.status = 'processing')
         OR (
           job.location_mapping_id IS NOT NULL
           AND job.status = 'mapped_processing'
         )
       )
       AND job.lock_token = $4::uuid
       AND job.requested_dirty_version = $5::bigint
       AND job.location_mapping_id IS NOT DISTINCT FROM $6::uuid
       AND job.location_mapping_row_version
             IS NOT DISTINCT FROM $7::bigint
       AND job.provider_location_id IS NOT DISTINCT FROM $8::text
       AND job.inventory_location_id IS NOT DISTINCT FROM $9::uuid
       AND job.inventory_pool_id IS NOT DISTINCT FROM $10::uuid
       AND job.lease_expires_at > now()
       AND job.cancel_requested = false
       AND ${INVENTORY_READABLE_CONNECTION_SQL}
       AND operations_shopify_carrier_service_config_is_ready(
         config.organization_id, config.id
       )
     FOR UPDATE OF job`,
    [
      job.id,
      job.organizationId,
      job.integrationAccountId,
      job.lockToken,
      job.requestedDirtyVersion,
      job.locationMappingId,
      job.locationMappingRowVersion,
      job.providerLocationId,
      job.inventoryLocationId,
      job.inventoryPoolId,
    ],
  )
  return current.rowCount === 1
}

async function cancelProcessingJob(
  client: PoolClient,
  job: ShopifyInventoryRefreshJob,
) {
  await client.query(
    `UPDATE operations_shopify_inventory_refresh_jobs
     SET status = CASE
           WHEN location_mapping_id IS NULL THEN 'cancelled'
           ELSE 'mapped_cancelled'
         END,
         cancel_requested = true,
         completed_at = now(),
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         last_error_code = 'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
         updated_at = now()
     WHERE id = $1::uuid
       AND status IN ('processing', 'mapped_processing')
       AND lock_token = $2::uuid
       AND lease_expires_at > now()`,
    [job.id, job.lockToken],
  )
}

export async function renewShopifyInventoryRefreshJobLeaseInPostgres(
  job: ShopifyInventoryRefreshJob,
) {
  return withTransaction(async (client) => {
    if (!await currentJobFence(client, job)) {
      await cancelProcessingJob(client, job)
      return false
    }
    const renewed = await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET lease_expires_at = now() + interval '20 minutes',
           updated_at = now()
       WHERE id = $1::uuid
         AND organization_id = $2::uuid
         AND integration_account_id = $3::uuid
         AND status IN ('processing', 'mapped_processing')
         AND lock_token = $4::uuid
         AND cancel_requested = false
         AND lease_expires_at > now()`,
      [
        job.id,
        job.organizationId,
        job.integrationAccountId,
        job.lockToken,
      ],
    )
    return renewed.rowCount === 1
  })
}

export async function completeShopifyInventoryRefreshJobInPostgres(input: {
  job: ShopifyInventoryRefreshJob
  effectiveIdempotencyKey: string
  inventoryRunGlobalId: string
}) {
  return withTransaction(async (client) => {
    if (!await currentJobFence(client, input.job)) {
      await cancelProcessingJob(client, input.job)
      return { status: 'cancelled' as const }
    }
    const evidence = await client.query<{
      id: string
      global_id: string
      provider_fetched_at: Date | string
      provider_attempt_created_at: Date | string
      provider_capture_created_at: Date | string
      completed_at: Date | string
      levels_seen: number
      levels_projected: number
      provider_writes: number
      order_quantity_adjustment: string
    }>(
      `SELECT run.id::text, run.global_id, run.provider_fetched_at,
              run.completed_at,
              attempt.requested_at AS provider_attempt_created_at,
              capture.created_at AS provider_capture_created_at,
              run.levels_seen, run.levels_projected, run.provider_writes,
              run.order_quantity_adjustment::text
       FROM operations_commerce_inventory_sync_runs run
       JOIN operations_commerce_provider_attempts attempt
        ON attempt.organization_id = run.organization_id
       AND attempt.integration_account_id = run.integration_account_id
       AND attempt.id = run.provider_attempt_id
       JOIN operations_commerce_inventory_captures capture
         ON capture.organization_id = run.organization_id
        AND capture.integration_account_id = run.integration_account_id
        AND capture.provider_attempt_id = run.provider_attempt_id
        AND capture.id = run.capture_id
       WHERE run.organization_id = $1::uuid
         AND run.integration_account_id = $2::uuid
         AND run.warehouse_id = $3::uuid
         AND run.global_id = $4
         AND run.idempotency_key = $5
         AND run.status = 'succeeded'
         AND (
           $6::uuid IS NULL
           OR (
             run.location_mapping_id = $6::uuid
             AND run.location_id = $7::uuid
             AND run.inventory_pool_id = $8::uuid
             AND run.provider_location_id = $9::text
           )
         )
       LIMIT 1`,
      [
        input.job.organizationId,
        input.job.integrationAccountId,
        input.job.warehouseId,
        input.inventoryRunGlobalId,
        input.effectiveIdempotencyKey,
        input.job.locationMappingId,
        input.job.inventoryLocationId,
        input.job.inventoryPoolId,
        input.job.providerLocationId,
      ],
    )
    const run = evidence.rows[0]
    if (!run) {
      const incomplete = new Error(
        'Shopify inventory refresh completed without durable run evidence',
      ) as Error & { code?: string }
      incomplete.code = 'SHOPIFY_INVENTORY_REFRESH_EVIDENCE_REQUIRED'
      throw incomplete
    }
    const completed = await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET status = CASE
             WHEN location_mapping_id IS NULL THEN 'succeeded'
             ELSE 'mapped_succeeded'
           END,
           result_summary = jsonb_build_object(
             'resource', 'inventory',
             'readOnly', true,
             'providerWrites', $3::integer,
             'orderQuantityAdjustment', $4::numeric,
             'inventoryRunGlobalId', $5::text,
             'providerFetchedAt', $6::text,
             'levelsSeen', $7::integer,
             'levelsProjected', $8::integer,
             'requestedDirtyVersion', $9::bigint
           ),
           completed_at = now(),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = NULL,
           updated_at = now()
       WHERE id = $1::uuid
         AND status IN ('processing', 'mapped_processing')
         AND lock_token = $2::uuid
         AND lease_expires_at > now()`,
      [
        input.job.id,
        input.job.lockToken,
        run.provider_writes,
        run.order_quantity_adjustment,
        run.global_id,
        new Date(run.provider_fetched_at).toISOString(),
        run.levels_seen,
        run.levels_projected,
        input.job.requestedDirtyVersion,
      ],
    )
    if (completed.rowCount !== 1) {
      return { status: 'lease_lost' as const }
    }
    let currentDirtyVersion = input.job.requestedDirtyVersion
    let reconciledDirtyVersion = input.job.requestedDirtyVersion
    if (input.job.requestedDirtyVersion > 0) {
      const providerAttemptBeganAfterClaim = (
        Date.parse(new Date(run.provider_attempt_created_at).toISOString())
          >= Date.parse(input.job.startedAt)
      )
      const providerEvidenceCapturedAfterClaim = (
        Date.parse(new Date(run.provider_capture_created_at).toISOString())
          >= Date.parse(input.job.startedAt)
      )
      const acknowledgementEligible = (
        providerAttemptBeganAfterClaim
        && providerEvidenceCapturedAfterClaim
      )
      const acknowledgementSql = acknowledgementEligible
        ? `UPDATE operations_shopify_inventory_refresh_watermarks
           SET reconciled_version = GREATEST(
                 reconciled_version,
                 $4::bigint
               ),
               credential_generation = GREATEST(
                 credential_generation,
                 $3::integer
               ),
               last_reconciled_at = clock_timestamp(),
               last_reconciled_run_global_id = $5,
               updated_at = clock_timestamp()
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND credential_generation <= $3::integer
             AND dirty_version = $4::bigint
             AND last_signaled_at IS NOT NULL
             AND $6::timestamptz >= last_signaled_at
             AND (
               $7::uuid IS NULL
               OR NOT EXISTS (
                 SELECT 1
                 FROM operations_commerce_inventory_location_mappings
                   current_mapping
                 WHERE current_mapping.organization_id = $1::uuid
                   AND current_mapping.integration_account_id = $2::uuid
                   AND current_mapping.active = true
                   AND current_mapping.inventory_import_enabled = true
                   AND NOT EXISTS (
                     SELECT 1
                     FROM operations_shopify_inventory_refresh_jobs
                       succeeded
                     WHERE succeeded.organization_id = $1::uuid
                       AND succeeded.integration_account_id = $2::uuid
                       AND succeeded.location_mapping_id =
                           current_mapping.id
                       AND succeeded.location_mapping_row_version =
                           current_mapping.row_version
                       AND succeeded.provider_location_id =
                           current_mapping.external_location_id
                       AND succeeded.warehouse_id =
                           current_mapping.warehouse_id
                       AND succeeded.inventory_location_id =
                           current_mapping.location_id
                       AND succeeded.inventory_pool_id =
                           current_mapping.inventory_pool_id
                       AND succeeded.carrier_service_config_id = $8::uuid
                       AND succeeded.credential_generation = $3::integer
                       AND succeeded.activation_revision = $9::integer
                       AND succeeded.config_row_version = $10::bigint
                       AND succeeded.policy_revision = $11::bigint
                       AND succeeded.policy_hash = $12::text
                       AND succeeded.inventory_max_age_seconds = $13::integer
                       AND succeeded.requested_dirty_version = $4::bigint
                       AND succeeded.status = 'mapped_succeeded'
                   )
               )
             )
           RETURNING dirty_version::text, reconciled_version::text`
        : `SELECT dirty_version::text, reconciled_version::text
           FROM operations_shopify_inventory_refresh_watermarks
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
           LIMIT 1`
      const acknowledgementValues = acknowledgementEligible
        ? [
            input.job.organizationId,
            input.job.integrationAccountId,
            input.job.credentialGeneration,
            input.job.requestedDirtyVersion,
            run.global_id,
            new Date(run.provider_fetched_at).toISOString(),
            input.job.locationMappingId,
            input.job.carrierServiceConfigId,
            input.job.activationRevision,
            input.job.configRowVersion,
            input.job.policyRevision,
            input.job.policyHash,
            input.job.inventoryMaxAgeSeconds,
          ]
        : [
            input.job.organizationId,
            input.job.integrationAccountId,
          ]
      let acknowledged = await client.query<{
        dirty_version: string
        reconciled_version: string
      }>(acknowledgementSql, acknowledgementValues)
      if (acknowledgementEligible && !acknowledged.rows[0]) {
        acknowledged = await client.query<{
          dirty_version: string
          reconciled_version: string
        }>(
          `SELECT dirty_version::text, reconciled_version::text
           FROM operations_shopify_inventory_refresh_watermarks
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
           LIMIT 1`,
          [input.job.organizationId, input.job.integrationAccountId],
        )
      }
      const watermark = acknowledged.rows[0]
      if (!watermark) {
        const incomplete = new Error(
          'Shopify inventory refresh completed without its dirty watermark',
        ) as Error & { code?: string }
        incomplete.code = 'SHOPIFY_INVENTORY_REFRESH_WATERMARK_REQUIRED'
        throw incomplete
      }
      currentDirtyVersion = Number(watermark.dirty_version)
      reconciledDirtyVersion = Number(watermark.reconciled_version)
    }
    return {
      status: 'succeeded' as const,
      inventoryRunGlobalId: run.global_id,
      providerFetchedAt:
        new Date(run.provider_fetched_at).toISOString(),
      requestedDirtyVersion: input.job.requestedDirtyVersion,
      currentDirtyVersion,
      reconciledDirtyVersion,
      followUpRequired: currentDirtyVersion > reconciledDirtyVersion,
    }
  })
}

export async function failShopifyInventoryRefreshJobInPostgres(input: {
  job: ShopifyInventoryRefreshJob
  error: unknown
}) {
  const code = safeErrorCode(input.error)
  const outcome = await withTransaction(async (client) => {
    if (!await currentJobFence(client, input.job)) {
      await cancelProcessingJob(client, input.job)
      return {
        code,
        dead: false,
        leaseLost: true,
        retryAt: null as string | null,
      }
    }
    const dead = (
      PERMANENT_ERROR_CODES.has(code)
      || input.job.attemptCount >= input.job.maxAttempts
    )
    const delaySeconds = Math.min(
      3_600,
      15 * (2 ** Math.max(0, input.job.attemptCount - 1)),
    )
    const failed = await client.query<{ available_at: Date | string }>(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET status = CASE
             WHEN location_mapping_id IS NULL AND $3::boolean THEN 'dead'
             WHEN location_mapping_id IS NULL THEN 'failed'
             WHEN $3::boolean THEN 'mapped_dead'
             ELSE 'mapped_failed'
           END,
           available_at = CASE
             WHEN $3::boolean THEN available_at
             ELSE now() + make_interval(secs => $4::integer)
           END,
           completed_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = $5,
           result_summary = jsonb_build_object(
             'resource', 'inventory',
             'readOnly', true,
             'providerWrites', 0,
             'orderQuantityAdjustment', 0
           ),
           updated_at = now()
       WHERE id = $1::uuid
         AND status IN ('processing', 'mapped_processing')
         AND lock_token = $2::uuid
         AND lease_expires_at > now()
       RETURNING available_at`,
      [
        input.job.id,
        input.job.lockToken,
        dead,
        delaySeconds,
        code,
      ],
    )
    if (!failed.rows[0]) {
      return {
        code,
        dead: false,
        leaseLost: true,
        retryAt: null as string | null,
      }
    }
    return {
      code,
      dead,
      leaseLost: false,
      retryAt: dead
        ? null
        : new Date(failed.rows[0].available_at).toISOString(),
    }
  })
  if (outcome.dead && !outcome.leaseLost) {
    await recordAuditEvent({
      actor: 'system',
      isSystem: true,
      eventType: 'commerce.inventory.refresh_dead',
      aggregateType: 'operations.integration_account',
      aggregateId: input.job.accountGlobalId,
      organizationId: input.job.organizationId,
      eventKey: `commerce-inventory-refresh:${input.job.id}:dead`,
      payload: {
        errorCode: outcome.code,
        attemptCount: input.job.attemptCount,
        providerWrites: 0,
        orderQuantityAdjustment: 0,
        readOnly: true,
      },
    })
  }
  return outcome
}

export async function recordShopifyInventoryRefreshWorkerHeartbeatInPostgres(
  details: Record<string, unknown>,
) {
  const payload = {
    checkedAt: new Date().toISOString(),
    workerId: String(
      process.env.RAILWAY_REPLICA_ID
      || process.env.HOSTNAME
      || randomUUID(),
    ).slice(0, 200),
    ...details,
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WORKER_HEARTBEAT_KEY, JSON.stringify(payload)],
  )
  return payload
}

export async function readShopifyInventoryRefreshWorkerHeartbeatFromPostgres() {
  const result = await query<{ value: Record<string, unknown> }>(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [WORKER_HEARTBEAT_KEY],
  )
  return result.rows[0]?.value || null
}

export async function readShopifyInventoryRefreshHealthFromPostgres() {
  const result = await query<{
    eligible_accounts: string
    stale_accounts: string
    dirty_accounts: string
    queued: string
    processing: string
    retrying: string
    current_dead: string
    stale_processing: string
    overdue: string
    last_success_at: Date | string | null
  }>(
    `WITH eligible AS (
       SELECT
         config.organization_id,
         config.integration_account_id,
         config.id AS config_id,
         config.warehouse_id,
         config.credential_generation,
         config.activation_revision,
         config.row_version,
         config.policy_revision,
         config.policy_hash,
         config.inventory_max_age_seconds
       FROM operations_shopify_carrier_service_configs config
       JOIN operations_integration_accounts account
         ON account.organization_id = config.organization_id
        AND account.id = config.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = config.organization_id
       WHERE operations_shopify_carrier_service_config_is_ready(
           config.organization_id, config.id
         )
         AND config.registration_state IN (
           'shadow_simulated', 'registered'
         )
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
         AND ${SHOPIFY_INVENTORY_READ_ACCOUNT_SQL}
         AND account.commerce_credential_generation =
             config.credential_generation
         AND credential.credential_version =
             config.credential_generation
         AND credential.verification_status = 'verified'
         AND activation.revision = config.activation_revision
         AND (
           (config.registration_state = 'registered'
             AND activation.state IN ('shadow', 'active'))
           OR
           (config.registration_state = 'shadow_simulated'
             AND activation.state = 'shadow')
         )
         AND ${INVENTORY_READABLE_CONNECTION_SQL}
     ),
     eligible_routes AS (
       SELECT
         ready.organization_id,
         ready.integration_account_id,
         ready.config_id,
         mapping.warehouse_id,
         mapping.id AS location_mapping_id,
         mapping.row_version AS location_mapping_row_version,
         mapping.external_location_id AS provider_location_id,
         mapping.location_id AS inventory_location_id,
         mapping.inventory_pool_id,
         ready.credential_generation,
         ready.activation_revision,
         ready.row_version,
         ready.policy_revision,
         ready.policy_hash,
         ready.inventory_max_age_seconds
       FROM eligible ready
       JOIN operations_commerce_inventory_location_mappings mapping
         ON mapping.organization_id = ready.organization_id
        AND mapping.integration_account_id = ready.integration_account_id
        AND mapping.active = true
        AND mapping.inventory_import_enabled = true
       UNION ALL
       SELECT
         ready.organization_id,
         ready.integration_account_id,
         ready.config_id,
         ready.warehouse_id,
         NULL::uuid AS location_mapping_id,
         NULL::bigint AS location_mapping_row_version,
         NULL::text AS provider_location_id,
         NULL::uuid AS inventory_location_id,
         NULL::uuid AS inventory_pool_id,
         ready.credential_generation,
         ready.activation_revision,
         ready.row_version,
         ready.policy_revision,
         ready.policy_hash,
         ready.inventory_max_age_seconds
       FROM eligible ready
       WHERE NOT EXISTS (
         SELECT 1
         FROM operations_commerce_inventory_location_mappings mapping
         WHERE mapping.organization_id = ready.organization_id
           AND mapping.integration_account_id =
               ready.integration_account_id
       )
     ),
     latest_inventory AS (
       SELECT DISTINCT ON (
         run.organization_id,
         run.integration_account_id,
         run.location_mapping_id
       )
         run.organization_id,
         run.integration_account_id,
         run.location_mapping_id,
         run.warehouse_id,
         run.location_id,
         run.inventory_pool_id,
         run.provider_location_id,
         run.provider_fetched_at
       FROM operations_commerce_inventory_sync_runs run
       WHERE run.status = 'succeeded'
       ORDER BY run.organization_id, run.integration_account_id,
                run.location_mapping_id, run.provider_fetched_at DESC,
                run.completed_at DESC, run.id DESC
     )
     SELECT
       (
         SELECT count(DISTINCT (
           ready.organization_id, ready.integration_account_id
         ))
         FROM eligible_routes ready
       )::text AS eligible_accounts,
       (
         SELECT count(DISTINCT (
           ready.organization_id, ready.integration_account_id
         ))
         FROM eligible_routes ready
         LEFT JOIN latest_inventory inventory
           ON inventory.organization_id = ready.organization_id
          AND inventory.integration_account_id =
              ready.integration_account_id
          AND (
            (
              ready.location_mapping_id IS NOT NULL
              AND inventory.location_mapping_id =
                  ready.location_mapping_id
              AND inventory.provider_location_id =
                  ready.provider_location_id
              AND inventory.warehouse_id = ready.warehouse_id
              AND inventory.location_id = ready.inventory_location_id
              AND inventory.inventory_pool_id = ready.inventory_pool_id
            )
            OR (
              ready.location_mapping_id IS NULL
              AND inventory.warehouse_id = ready.warehouse_id
            )
          )
         WHERE inventory.provider_fetched_at IS NULL
            OR inventory.provider_fetched_at <= now() - make_interval(
              secs => ready.inventory_max_age_seconds
            )
       )::text AS stale_accounts,
       (
         SELECT count(DISTINCT (
           ready.organization_id, ready.integration_account_id
         ))
         FROM eligible ready
         JOIN operations_shopify_inventory_refresh_watermarks watermark
           ON watermark.organization_id = ready.organization_id
          AND watermark.integration_account_id =
              ready.integration_account_id
         WHERE watermark.dirty_version > watermark.reconciled_version
       )::text AS dirty_accounts,
       count(*) FILTER (
         WHERE job.status IN ('pending', 'mapped_pending')
       )::text AS queued,
       count(*) FILTER (
         WHERE job.status IN ('processing', 'mapped_processing')
       )::text AS processing,
       count(*) FILTER (
         WHERE job.status IN ('failed', 'mapped_failed')
       )::text AS retrying,
       (
         SELECT count(DISTINCT (
           ready.organization_id, ready.integration_account_id
         ))
         FROM eligible_routes ready
         JOIN LATERAL (
           SELECT job.*
           FROM operations_shopify_inventory_refresh_jobs job
           WHERE job.organization_id = ready.organization_id
             AND job.integration_account_id =
                 ready.integration_account_id
             AND job.carrier_service_config_id = ready.config_id
             AND job.credential_generation =
                 ready.credential_generation
             AND job.activation_revision = ready.activation_revision
             AND job.config_row_version = ready.row_version
             AND job.policy_revision = ready.policy_revision
             AND job.policy_hash = ready.policy_hash
             AND job.inventory_max_age_seconds =
                 ready.inventory_max_age_seconds
             AND (
               (
                 ready.location_mapping_id IS NULL
                 AND job.location_mapping_id IS NULL
                 AND job.warehouse_id = ready.warehouse_id
               )
               OR (
                 ready.location_mapping_id IS NOT NULL
                 AND job.location_mapping_id = ready.location_mapping_id
                 AND job.location_mapping_row_version =
                     ready.location_mapping_row_version
                 AND job.provider_location_id =
                     ready.provider_location_id
                 AND job.warehouse_id = ready.warehouse_id
                 AND job.inventory_location_id =
                     ready.inventory_location_id
                 AND job.inventory_pool_id = ready.inventory_pool_id
               )
             )
           ORDER BY job.created_at DESC, job.id DESC
           LIMIT 1
         ) latest ON true
         WHERE latest.status IN ('dead', 'mapped_dead')
           AND NOT EXISTS (
             SELECT 1
             FROM operations_commerce_inventory_sync_runs recovered
             WHERE recovered.organization_id = latest.organization_id
               AND recovered.integration_account_id =
                   latest.integration_account_id
               AND recovered.status = 'succeeded'
               AND recovered.completed_at > latest.completed_at
               AND (
                 (
                   latest.location_mapping_id IS NOT NULL
                   AND recovered.location_mapping_id =
                       latest.location_mapping_id
                   AND recovered.provider_location_id =
                       latest.provider_location_id
                   AND recovered.warehouse_id = latest.warehouse_id
                   AND recovered.location_id =
                       latest.inventory_location_id
                   AND recovered.inventory_pool_id =
                       latest.inventory_pool_id
                 )
                 OR (
                   latest.location_mapping_id IS NULL
                   AND recovered.warehouse_id = latest.warehouse_id
                 )
               )
           )
       )::text AS current_dead,
       count(*) FILTER (
         WHERE job.status IN ('processing', 'mapped_processing')
           AND job.lease_expires_at <= now()
       )::text AS stale_processing,
       count(*) FILTER (
         WHERE job.status IN (
           'pending', 'failed', 'mapped_pending', 'mapped_failed'
         )
           AND job.available_at <= now() - interval '2 minutes'
       )::text AS overdue,
       max(job.completed_at) FILTER (
         WHERE job.status IN ('succeeded', 'mapped_succeeded')
       ) AS last_success_at
     FROM operations_shopify_inventory_refresh_jobs job`,
  )
  const row = result.rows[0]
  return {
    eligibleAccounts: Number(row?.eligible_accounts || 0),
    staleAccounts: Number(row?.stale_accounts || 0),
    dirtyAccounts: Number(row?.dirty_accounts || 0),
    queued: Number(row?.queued || 0),
    processing: Number(row?.processing || 0),
    retrying: Number(row?.retrying || 0),
    currentDead: Number(row?.current_dead || 0),
    staleProcessing: Number(row?.stale_processing || 0),
    overdue: Number(row?.overdue || 0),
    lastSuccessAt: row?.last_success_at
      ? new Date(row.last_success_at).toISOString()
      : null,
    resource: 'inventory',
    readOnly: true,
    providerWrites: 0,
    orderQuantityAdjustment: 0,
  }
}
