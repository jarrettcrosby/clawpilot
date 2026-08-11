import crypto from 'crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { OperationsRequestError } from '@/lib/persistence/operations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/

export type WearableLocationScanPolicy = {
  warehouseId: string
  warehouseGlobalId: string
  warehouseName: string
  locationScanRequired: boolean
  rowVersion: number
  updatedBy: string | null
  updatedAt: string | null
}
type PolicyRow = QueryResultRow & {
  warehouse_id: string
  warehouse_global_id: string
  warehouse_name: string
  location_scan_required: boolean | null
  row_version: string | null
  updated_by: string | null
  updated_at: string | Date | null
}

type CommandRow = QueryResultRow & {
  request_hash: string
  result: unknown
}

function invalid(message: string, status = 400): never {
  throw new OperationsRequestError(
    'OPERATIONS_WEARABLE_LOCATION_SCAN_POLICY_INVALID',
    message,
    status,
  )
}

function organizationId(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!ORGANIZATION_ID.test(normalized)) invalid('Organization is invalid')
  return normalized
}

function warehouseGlobalId(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!WAREHOUSE_GLOBAL_ID.test(normalized)) invalid('Warehouse is invalid')
  return normalized
}

function requiredText(value: unknown, label: string, maximum = 200) {
  const normalized = String(value ?? '').trim()
  if (
    normalized.length < 1
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) invalid(`${label} is invalid`)
  return normalized
}

function rowVersion(value: unknown, label = 'Expected row version') {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid(`${label} is invalid`)
  return parsed
}

function policy(row: PolicyRow): WearableLocationScanPolicy {
  return {
    warehouseId: row.warehouse_id,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseName: row.warehouse_name,
    locationScanRequired: row.location_scan_required === true,
    rowVersion: row.row_version === null ? 0 : rowVersion(row.row_version, 'Policy row version'),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
  }
}

function receiptResult(value: unknown): WearableLocationScanPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_LOCATION_SCAN_POLICY_EVIDENCE_INVALID',
      'Location scan policy command evidence is invalid',
      500,
    )
  }
  const result = value as Record<string, unknown>
  return {
    warehouseId: requiredText(result.warehouseId, 'Policy warehouse ID', 40),
    warehouseGlobalId: warehouseGlobalId(result.warehouseGlobalId),
    warehouseName: requiredText(result.warehouseName, 'Policy warehouse name'),
    locationScanRequired: result.locationScanRequired === true,
    rowVersion: rowVersion(result.rowVersion, 'Policy row version'),
    updatedBy: result.updatedBy === null ? null : requiredText(result.updatedBy, 'Policy actor', 254),
    updatedAt: result.updatedAt === null
      ? null
      : new Date(requiredText(result.updatedAt, 'Policy update time', 40)).toISOString(),
  }
}

function requestHash(input: {
  warehouseGlobalId: string
  locationScanRequired: boolean
  expectedRowVersion: number
}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    warehouseGlobalId: input.warehouseGlobalId,
    locationScanRequired: input.locationScanRequired,
    expectedRowVersion: input.expectedRowVersion,
  })).digest('hex')
}

async function readPolicyRows(
  organization: string,
  client?: PoolClient,
  selectedWarehouseGlobalId?: string,
) {
  const runner = client ? client.query.bind(client) : query
  return runner<PolicyRow>(
    `SELECT warehouse.id::text AS warehouse_id,
            warehouse.global_id AS warehouse_global_id,
            warehouse.name AS warehouse_name,
            scan_policy.location_scan_required,
            scan_policy.row_version::text,
            scan_policy.updated_by,
            scan_policy.updated_at
     FROM operations_warehouses warehouse
     LEFT JOIN operations_wearable_location_scan_policies scan_policy
       ON scan_policy.organization_id = warehouse.organization_id
      AND scan_policy.warehouse_id = warehouse.id
     WHERE warehouse.organization_id = $1::uuid
       AND warehouse.status = 'active'
       AND ($2::text IS NULL OR warehouse.global_id = $2)
     ORDER BY lower(warehouse.name), warehouse.id`,
    [organization, selectedWarehouseGlobalId || null],
  )
}

export async function readWearableLocationScanPoliciesFromPostgres(input: {
  organizationId: string
}): Promise<WearableLocationScanPolicy[]> {
  const organization = organizationId(input.organizationId)
  const result = await readPolicyRows(organization)
  return result.rows.map(policy)
}

export async function updateWearableLocationScanPolicyInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  warehouseGlobalId: string
  locationScanRequired: boolean
  expectedRowVersion: number
}): Promise<WearableLocationScanPolicy> {
  const organization = organizationId(input.organizationId)
  const actorEmail = requiredText(input.actorEmail, 'Signed-in user', 254).toLowerCase()
  const idempotencyKey = requiredText(input.idempotencyKey, 'Idempotency-Key')
  if (idempotencyKey.length < 8) invalid('Idempotency-Key is invalid')
  const selectedWarehouseGlobalId = warehouseGlobalId(input.warehouseGlobalId)
  if (typeof input.locationScanRequired !== 'boolean') {
    invalid('Location scan setting must be true or false')
  }
  const expectedRowVersion = rowVersion(input.expectedRowVersion)
  const hash = requestHash({
    warehouseGlobalId: selectedWarehouseGlobalId,
    locationScanRequired: input.locationScanRequired,
    expectedRowVersion,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:wearable-location-scan-policy-command:${organization}:${idempotencyKey}`,
    )
    const prior = await client.query<CommandRow>(
      `SELECT request_hash, result
       FROM operations_wearable_location_scan_policy_commands
       WHERE organization_id = $1::uuid AND idempotency_key = $2
       LIMIT 1`,
      [organization, idempotencyKey],
    )
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) {
        throw new OperationsRequestError(
          'OPERATIONS_WEARABLE_LOCATION_SCAN_POLICY_IDEMPOTENCY_REUSED',
          'Idempotency-Key was already used for a different location scan policy command',
          409,
        )
      }
      return receiptResult(prior.rows[0].result)
    }

    await acquireTransactionAdvisoryLock(
      client,
      `operations:wearable-location-scan-policy:${organization}:${selectedWarehouseGlobalId}`,
    )
    const warehouse = await readPolicyRows(organization, client, selectedWarehouseGlobalId)
    const currentRow = warehouse.rows[0]
    if (!currentRow) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_LOCATION_SCAN_POLICY_WAREHOUSE_NOT_FOUND',
        'Active warehouse was not found',
        404,
      )
    }
    const current = policy(currentRow)
    if (current.rowVersion !== expectedRowVersion) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_LOCATION_SCAN_POLICY_STALE',
        'Location scan policy changed. Refresh and try again.',
        409,
      )
    }

    let result = current
    const changed = current.locationScanRequired !== input.locationScanRequired
    if (changed) {
      const updated = await client.query<PolicyRow>(
        `INSERT INTO operations_wearable_location_scan_policies (
           organization_id, warehouse_id, location_scan_required, row_version,
           created_by, updated_by
         ) VALUES ($1::uuid, $2::uuid, $3, 1, $4, $4)
         ON CONFLICT (organization_id, warehouse_id) DO UPDATE
         SET location_scan_required = EXCLUDED.location_scan_required,
             row_version = operations_wearable_location_scan_policies.row_version + 1,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
         WHERE operations_wearable_location_scan_policies.row_version = $5
         RETURNING warehouse_id::text,
                   $6::text AS warehouse_global_id,
                   $7::text AS warehouse_name,
                   location_scan_required,
                   row_version::text,
                   updated_by,
                   updated_at`,
        [
          organization,
          current.warehouseId,
          input.locationScanRequired,
          actorEmail,
          expectedRowVersion,
          current.warehouseGlobalId,
          current.warehouseName,
        ],
      )
      if (!updated.rows[0]) {
        throw new OperationsRequestError(
          'OPERATIONS_WEARABLE_LOCATION_SCAN_POLICY_STALE',
          'Location scan policy changed. Refresh and try again.',
          409,
        )
      }
      result = policy(updated.rows[0])
    }

    await client.query(
      `INSERT INTO operations_wearable_location_scan_policy_commands (
         organization_id, idempotency_key, warehouse_id, actor_email,
         request_hash, expected_row_version,
         requested_location_scan_required, result
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8::jsonb
       )`,
      [
        organization,
        idempotencyKey,
        current.warehouseId,
        actorEmail,
        hash,
        expectedRowVersion,
        input.locationScanRequired,
        JSON.stringify(result),
      ],
    )
    const eventKeyHash = crypto.createHash('sha256').update(idempotencyKey).digest('hex')
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.wearable_location_scan_policy.updated',
      aggregateType: 'operations.warehouse',
      aggregateId: current.warehouseGlobalId,
      eventKey: `operations:wearable-location-scan-policy:${organization}:${eventKeyHash}`,
      organizationId: organization,
      payload: {
        warehouseGlobalId: current.warehouseGlobalId,
        previousLocationScanRequired: current.locationScanRequired,
        locationScanRequired: result.locationScanRequired,
        expectedRowVersion,
        resultingRowVersion: result.rowVersion,
        changed,
        requestHash: hash,
      },
    }, client)
    return result
  })
}
