import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { carrierSandboxPartyFingerprint } from '@/lib/integrations/carrierSandboxRate'
import {
  decryptCommerceCandidateSnapshot,
  encryptCommerceCandidateSnapshot,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  changedOrderShipToFields,
  mergeOrderShipToDraft,
  normalizeOrderShipToDraft,
  orderShipToIssues,
  orderShipToReadiness,
  orderShipToStorageValue,
  type OrderShipToDraft,
  type OrderShipToPatch,
} from '@/lib/operations/orderShipTo'
import type {
  OperationsOrderShipmentAddress,
  OperationsOrderShipmentAddressUpdateResult,
} from '@/lib/operations/types'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const COMMAND_TYPE = 'operations.order_shipment_address.update'
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

type ShipmentAddressRow = QueryResultRow & {
  organization_id: string
  order_id: string
  order_global_id: string
  order_status: string
  order_row_version: string
  source_provider: string
  external_order_id: string
  account_global_id: string | null
  source_ship_to: Record<string, unknown>
  label_count: string
  shipment_count: string
  export_count: string
  active_plan_count: string
  plan_destination_fingerprints: string[]
  working_copy_id: string | null
  accepted_source_order_row_version: string | null
  accepted_source_order_hash: string | null
  ship_to_state:
    | 'local_missing'
    | 'local_incomplete'
    | 'local_carrier_ready'
    | null
  ship_to_ciphertext: Buffer | null
  ship_to_iv: Buffer | null
  ship_to_tag: Buffer | null
  working_copy_row_version: string | null
}

type CommandReceiptRow = QueryResultRow & {
  id: string
  request_hash: string
  target_global_id: string | null
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_payload: Record<string, unknown> | null
  updated_at: Date
}

export class OperationsOrderShipmentAddressError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'OperationsOrderShipmentAddressError'
    this.code = code
    this.status = status
  }
}

function requestError(code: string, message: string, status = 409): never {
  throw new OperationsOrderShipmentAddressError(code, message, status)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function hash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function requireOrganizationId(value: string) {
  const organizationId = String(value || '').trim().toLowerCase()
  if (!UUID.test(organizationId)) {
    requestError(
      'ACTIVE_ORGANIZATION_REQUIRED',
      'Select an active organization first',
      409,
    )
  }
  return organizationId
}

function requireOrderGlobalId(value: string) {
  const orderGlobalId = String(value || '').trim()
  if (!ORDER_GLOBAL_ID.test(orderGlobalId)) {
    requestError(
      'OPERATIONS_ORDER_INVALID',
      'Operations order is invalid',
      400,
    )
  }
  return orderGlobalId
}

export function operationsOrderShipmentAddressSourceHash(input: {
  orderGlobalId: string
  sourceProvider: string
  externalOrderId: string
  sourceShipTo: OrderShipToDraft
}) {
  return hash({
    schemaVersion: 1,
    orderGlobalId: input.orderGlobalId,
    sourceProvider: input.sourceProvider,
    externalOrderId: input.externalOrderId,
    sourceShipTo: orderShipToStorageValue(input.sourceShipTo),
  })
}

function protectedAddressUnreadable(): never {
  requestError(
    'OPERATIONS_SHIPMENT_ADDRESS_PROTECTED_DATA_UNREADABLE',
    'The saved shipment address could not be read',
    500,
  )
}

function decryptLocalAddress(row: ShipmentAddressRow): OrderShipToDraft {
  const protectedParts = [
    row.ship_to_ciphertext,
    row.ship_to_iv,
    row.ship_to_tag,
  ].filter((value) => value !== null).length
  if (
    !row.working_copy_id
    || protectedParts !== 3
    || !row.accepted_source_order_hash
    || !row.account_global_id
  ) {
    protectedAddressUnreadable()
  }
  try {
    const value = decryptCommerceCandidateSnapshot(
      {
        ciphertext: row.ship_to_ciphertext!,
        iv: row.ship_to_iv!,
        tag: row.ship_to_tag!,
      },
      row.organization_id,
      row.account_global_id,
      row.external_order_id,
      row.accepted_source_order_hash,
      'ship_to',
    )
    return normalizeOrderShipToDraft(value)
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    protectedAddressUnreadable()
  }
}

function editBlockedReason(row: ShipmentAddressRow) {
  if (
    !row.account_global_id
    || !['shopify', 'faire'].includes(row.source_provider)
  ) {
    return 'Shipment address editing is available for imported Shopify and Faire orders.'
  }
  if (
    Number(row.label_count) > 0
    || Number(row.shipment_count) > 0
    || Number(row.export_count) > 0
  ) {
    return 'This order already has label, shipment, or store-export evidence.'
  }
  return null
}

function currentRateDestinationFingerprint(value: OrderShipToDraft) {
  if (orderShipToReadiness(value) !== 'carrier_ready' || value.country !== 'US') {
    return null
  }
  try {
    return carrierSandboxPartyFingerprint({
      name: value.name!,
      line1: value.line1!,
      line2: value.line2,
      city: value.city!,
      region: value.region!,
      postalCode: value.postalCode!,
      countryCode: 'US',
    })
  } catch {
    return null
  }
}

function shipmentAddressRequiresRerate(
  row: ShipmentAddressRow,
  value: OrderShipToDraft,
) {
  const activePlanCount = Number(row.active_plan_count)
  if (activePlanCount === 0) return false
  const currentFingerprint = currentRateDestinationFingerprint(value)
  if (!currentFingerprint) return true
  return (
    row.plan_destination_fingerprints.length !== activePlanCount
    || row.plan_destination_fingerprints.some((fingerprint) => (
      fingerprint !== currentFingerprint
    ))
  )
}

function projectShipmentAddress(
  row: ShipmentAddressRow,
): OperationsOrderShipmentAddress {
  const sourceValue = normalizeOrderShipToDraft(row.source_ship_to)
  const currentSourceHash = operationsOrderShipmentAddressSourceHash({
    orderGlobalId: row.order_global_id,
    sourceProvider: row.source_provider,
    externalOrderId: row.external_order_id,
    sourceShipTo: sourceValue,
  })
  const local = Boolean(row.working_copy_id)
  const value = local ? decryptLocalAddress(row) : sourceValue
  const blockedReason = editBlockedReason(row)
  return {
    orderGlobalId: row.order_global_id,
    orderRowVersion: Number(row.order_row_version),
    rowVersion: Number(row.working_copy_row_version || 0),
    value,
    sourceValue,
    readiness: orderShipToReadiness(value),
    issues: orderShipToIssues(value),
    provenance: local ? 'local' : 'source',
    sourceVersionChanged: Boolean(
      local
      && row.accepted_source_order_hash !== currentSourceHash
    ),
    rerateRequired: shipmentAddressRequiresRerate(row, value),
    editable: blockedReason === null,
    editBlockedReason: blockedReason,
    providerWrites: 0,
  }
}

async function dbQuery<Row extends QueryResultRow>(
  client: PoolClient | null,
  sql: string,
  values: unknown[],
) {
  return client ? client.query<Row>(sql, values) : query<Row>(sql, values)
}

async function readShipmentAddressRow(input: {
  organizationId: string
  orderGlobalId: string
  client?: PoolClient | null
  lock?: boolean
}) {
  const result = await dbQuery<ShipmentAddressRow>(
    input.client || null,
    `SELECT
       source_order.organization_id::text,
       source_order.id::text AS order_id,
       source_order.global_id AS order_global_id,
       source_order.status AS order_status,
       source_order.row_version::text AS order_row_version,
       source_order.source_provider,
       source_order.external_order_id,
       source_account.global_id AS account_global_id,
       source_order.ship_to AS source_ship_to,
       (SELECT (
          count(*) FILTER (
            WHERE label.environment = 'production'
              AND label.status = 'created'
          )
          + (
            SELECT count(*)
            FROM operations_label_attempts attempt
            WHERE attempt.organization_id = source_order.organization_id
              AND attempt.order_id = source_order.id
              AND attempt.action = 'create'
              AND attempt.environment = 'production'
              AND attempt.state IN ('prepared', 'succeeded', 'unknown')
          )
        )::text
        FROM operations_labels label
        JOIN operations_packages package
          ON package.organization_id = label.organization_id
         AND package.id = label.package_id
        JOIN operations_fulfillment_plans label_plan
          ON label_plan.organization_id = package.organization_id
         AND label_plan.id = package.plan_id
        WHERE label.organization_id = source_order.organization_id
          AND label_plan.order_id = source_order.id) AS label_count,
       (SELECT count(*)::text
        FROM operations_shipments shipment
        WHERE shipment.organization_id = source_order.organization_id
          AND shipment.order_id = source_order.id) AS shipment_count,
       (SELECT count(*)::text
        FROM operations_commerce_fulfillment_exports fulfillment_export
        WHERE fulfillment_export.organization_id =
              source_order.organization_id
          AND fulfillment_export.order_id = source_order.id) AS export_count,
       (SELECT count(*)::text
        FROM operations_fulfillment_plans plan
        WHERE plan.organization_id = source_order.organization_id
          AND plan.order_id = source_order.id
          AND plan.status IN ('planned', 'released')) AS active_plan_count,
       ARRAY(
         SELECT evidence.destination_fingerprint
         FROM operations_fulfillment_plans plan
         JOIN operations_cartonization_rate_evidence evidence
           ON evidence.organization_id = plan.organization_id
          AND evidence.id = plan.cartonization_evidence_id
         WHERE plan.organization_id = source_order.organization_id
           AND plan.order_id = source_order.id
           AND plan.status IN ('planned', 'released')
         ORDER BY plan.version_number, plan.id
       ) AS plan_destination_fingerprints,
       working_copy.id::text AS working_copy_id,
       working_copy.source_order_row_version::text
         AS accepted_source_order_row_version,
       working_copy.source_order_hash AS accepted_source_order_hash,
       working_copy.ship_to_state,
       working_copy.ship_to_ciphertext,
       working_copy.ship_to_iv,
       working_copy.ship_to_tag,
       working_copy.row_version::text AS working_copy_row_version
     FROM operations_orders source_order
     LEFT JOIN operations_integration_accounts source_account
       ON source_account.organization_id = source_order.organization_id
      AND source_account.id = source_order.integration_account_id
     LEFT JOIN operations_order_shipment_address_working_copies working_copy
       ON working_copy.organization_id = source_order.organization_id
      AND working_copy.order_id = source_order.id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
       AND source_order.archived_at IS NULL
     LIMIT 1
     ${input.lock ? 'FOR UPDATE OF source_order' : ''}`,
    [input.organizationId, input.orderGlobalId],
  )
  return result.rows[0] || null
}

export async function readOperationsOrderShipmentAddressInPostgres(input: {
  organizationId: string
  orderGlobalId: string
  client?: PoolClient | null
  lock?: boolean
}): Promise<OperationsOrderShipmentAddress> {
  const organizationId = requireOrganizationId(input.organizationId)
  const orderGlobalId = requireOrderGlobalId(input.orderGlobalId)
  const row = await readShipmentAddressRow({
    organizationId,
    orderGlobalId,
    client: input.client,
    lock: input.lock,
  })
  if (!row) {
    requestError(
      'OPERATIONS_ORDER_NOT_FOUND',
      'Operations order was not found',
      404,
    )
  }
  return projectShipmentAddress(row)
}

async function prepareReceipt(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    orderGlobalId: string
    idempotencyKey: string
    requestHash: string
  },
) {
  await acquireTransactionAdvisoryLock(
    client,
    `operations:shipment-address-receipt:${input.organizationId}:${input.idempotencyKey}`,
  )
  const existing = await client.query<CommandReceiptRow>(
    `SELECT id::text, request_hash, target_global_id, status,
            correlation_id::text, result_payload, updated_at
     FROM operations_command_receipts
     WHERE organization_id = $1::uuid
       AND command_type = $2
       AND idempotency_key = $3
     FOR UPDATE`,
    [input.organizationId, COMMAND_TYPE, input.idempotencyKey],
  )
  const receipt = existing.rows[0]
  if (receipt) {
    if (
      receipt.request_hash !== input.requestHash
      || receipt.target_global_id !== input.orderGlobalId
    ) {
      requestError(
        'OPERATIONS_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different order edit',
      )
    }
    if (receipt.status === 'succeeded') {
      return { receipt, replayed: true }
    }
    if (
      receipt.status === 'processing'
      && Date.now() - receipt.updated_at.getTime() < 5 * 60_000
    ) {
      requestError(
        'OPERATIONS_COMMAND_IN_PROGRESS',
        'This shipment edit is already being saved',
      )
    }
    const retried = await client.query<CommandReceiptRow>(
      `UPDATE operations_command_receipts
       SET status = 'processing', actor_email = $2,
           attempts = attempts + 1, error_code = NULL,
           error_message = NULL, completed_at = NULL,
           started_at = now(), updated_at = now()
       WHERE id = $1::uuid
       RETURNING id::text, request_hash, target_global_id, status,
                 correlation_id::text, result_payload, updated_at`,
      [receipt.id, input.actorEmail],
    )
    return { receipt: retried.rows[0], replayed: false }
  }
  const created = await client.query<CommandReceiptRow>(
    `INSERT INTO operations_command_receipts (
       organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id, target_global_id
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, 'processing', $6::uuid, $7
     )
     RETURNING id::text, request_hash, target_global_id, status,
               correlation_id::text, result_payload, updated_at`,
    [
      input.organizationId,
      COMMAND_TYPE,
      input.idempotencyKey,
      input.requestHash,
      input.actorEmail,
      randomUUID(),
      input.orderGlobalId,
    ],
  )
  return { receipt: created.rows[0], replayed: false }
}

function replayedResult(
  receipt: CommandReceiptRow,
): OperationsOrderShipmentAddressUpdateResult {
  const payload = receipt.result_payload
  if (
    !payload
    || typeof payload.orderGlobalId !== 'string'
    || !Number.isSafeInteger(payload.orderRowVersion)
    || !Number.isSafeInteger(payload.rowVersion)
    || !Array.isArray(payload.issues)
    || !Array.isArray(payload.changedFields)
  ) {
    requestError(
      'OPERATIONS_SHIPMENT_ADDRESS_RESULT_INVALID',
      'The saved shipment edit could not be reloaded',
      500,
    )
  }
  return {
    ...(payload as Omit<
      OperationsOrderShipmentAddressUpdateResult,
      'replayed'
    >),
    replayed: true,
  }
}

export async function updateOperationsOrderShipmentAddressInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  orderGlobalId: string
  expectedOrderRowVersion: number
  expectedAddressRowVersion: number
  changes: OrderShipToPatch
}): Promise<OperationsOrderShipmentAddressUpdateResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const orderGlobalId = requireOrderGlobalId(input.orderGlobalId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (!actorEmail) {
    requestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  }
  if (
    !input.idempotencyKey
    || input.idempotencyKey !== input.idempotencyKey.trim()
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) {
    requestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
      400,
    )
  }
  if (
    !Number.isSafeInteger(input.expectedOrderRowVersion)
    || input.expectedOrderRowVersion < 0
    || !Number.isSafeInteger(input.expectedAddressRowVersion)
    || input.expectedAddressRowVersion < 0
  ) {
    requestError(
      'OPERATIONS_SHIPMENT_ADDRESS_VERSION_INVALID',
      'Shipment address version is invalid',
      400,
    )
  }
  if (!Object.keys(input.changes).length) {
    requestError(
      'OPERATIONS_SHIPMENT_ADDRESS_EDIT_EMPTY',
      'Choose at least one ship-to field to update',
      400,
    )
  }

  const exactRequestHash = hash({
    orderGlobalId,
    expectedOrderRowVersion: input.expectedOrderRowVersion,
    expectedAddressRowVersion: input.expectedAddressRowVersion,
    changes: input.changes,
  })

  return withTransaction(async (client) => {
    const prepared = await prepareReceipt(client, {
      organizationId,
      actorEmail,
      orderGlobalId,
      idempotencyKey: input.idempotencyKey,
      requestHash: exactRequestHash,
    })
    if (prepared.replayed) return replayedResult(prepared.receipt)

    await acquireTransactionAdvisoryLock(
      client,
      `operations:order:${organizationId}:${orderGlobalId}`,
    )
    const row = await readShipmentAddressRow({
      organizationId,
      orderGlobalId,
      client,
      lock: true,
    })
    if (!row) {
      requestError(
        'OPERATIONS_ORDER_NOT_FOUND',
        'Operations order was not found',
        404,
      )
    }
    if (Number(row.order_row_version) !== input.expectedOrderRowVersion) {
      requestError(
        'OPERATIONS_ORDER_VERSION_CONFLICT',
        'This order changed. Reload it before saving the shipment address.',
      )
    }
    if (
      Number(row.working_copy_row_version || 0)
      !== input.expectedAddressRowVersion
    ) {
      requestError(
        'OPERATIONS_SHIPMENT_ADDRESS_VERSION_CONFLICT',
        'The shipment address changed. Reload it before saving.',
      )
    }
    // Native one-off orders deliberately have no commerce integration account.
    // They continue to project their canonical destination, but this provider-
    // import working-copy editor must not invent encryption identity for them.
    if (!row.account_global_id) {
      requestError(
        'OPERATIONS_SHIPMENT_ADDRESS_PROVIDER_ACCOUNT_REQUIRED',
        'Shipment address editing is available for imported Shopify and Faire orders.',
      )
    }
    const blockedReason = editBlockedReason(row)
    if (blockedReason) {
      requestError(
        Number(row.label_count) > 0
          || Number(row.shipment_count) > 0
          || Number(row.export_count) > 0
          ? 'OPERATIONS_SHIPMENT_ADDRESS_DOWNSTREAM_EVIDENCE_EXISTS'
          : 'OPERATIONS_SHIPMENT_ADDRESS_STAGE_INVALID',
        blockedReason,
      )
    }

    const sourceValue = normalizeOrderShipToDraft(row.source_ship_to)
    const before = row.working_copy_id
      ? decryptLocalAddress(row)
      : sourceValue
    const after = mergeOrderShipToDraft(before, input.changes)
    const readiness = orderShipToReadiness(after)
    const issues = orderShipToIssues(after)
    const changedFields = changedOrderShipToFields(before, after)
    const sourceOrderHash = operationsOrderShipmentAddressSourceHash({
      orderGlobalId,
      sourceProvider: row.source_provider,
      externalOrderId: row.external_order_id,
      sourceShipTo: sourceValue,
    })
    const encrypted = encryptCommerceCandidateSnapshot(
      orderShipToStorageValue(after),
      organizationId,
      row.account_global_id,
      row.external_order_id,
      sourceOrderHash,
      'ship_to',
    )
    // Production Active validators run in PostgreSQL, so derive their
    // equality evidence with the exact same database function in this
    // transaction. This avoids JavaScript/PostgreSQL normalization drift
    // (notably around Unicode whitespace and case conversion).
    const dispatchCoreFingerprintResult = await client.query<{
      fingerprint: string
    }>(
      `SELECT public.operations_dispatch_address_core_fingerprint(
         $1::jsonb
       ) AS fingerprint`,
      [JSON.stringify(orderShipToStorageValue(after))],
    )
    const dispatchCoreFingerprint =
      dispatchCoreFingerprintResult.rows[0]?.fingerprint
    if (!dispatchCoreFingerprint) {
      requestError(
        'OPERATIONS_SHIPMENT_ADDRESS_DISPATCH_BINDING_FAILED',
        'The shipment address could not be bound for dispatch',
        500,
      )
    }
    // The provider-mirrored canonical order and its rowVersion are immutable
    // under this local-only shipment edit. The independent working-copy
    // rowVersion below provides optimistic concurrency without invalidating
    // accepted commerce revision evidence.
    const orderRowVersion = Number(row.order_row_version)
    const shipToState = `local_${readiness}` as const
    let rowVersion: number
    if (row.working_copy_id) {
      const updated = await client.query<{ row_version: string }>(
        `UPDATE operations_order_shipment_address_working_copies
         SET source_order_row_version = $4::bigint,
             source_order_hash = $5,
             ship_to_state = $6,
             ship_to_ciphertext = $7,
             ship_to_iv = $8,
             ship_to_tag = $9,
             ship_to_hash = $10,
             dispatch_core_fingerprint = $11,
             ship_to_encryption_version = $12,
             last_command_receipt_id = $13::uuid,
             last_idempotency_key = $14,
             last_request_hash = $15,
             row_version = row_version + 1,
             updated_by = $16,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND order_id = $2::uuid
           AND id = $3::uuid
           AND row_version = $17::bigint
         RETURNING row_version::text`,
        [
          organizationId,
          row.order_id,
          row.working_copy_id,
          orderRowVersion,
          sourceOrderHash,
          shipToState,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.hash,
          dispatchCoreFingerprint,
          encrypted.encryptionVersion,
          prepared.receipt.id,
          input.idempotencyKey,
          exactRequestHash,
          actorEmail,
          input.expectedAddressRowVersion,
        ],
      )
      if (!updated.rows[0]) {
        requestError(
          'OPERATIONS_SHIPMENT_ADDRESS_VERSION_CONFLICT',
          'The shipment address changed. Reload it before saving.',
        )
      }
      rowVersion = Number(updated.rows[0].row_version)
    } else {
      const created = await client.query<{ row_version: string }>(
        `INSERT INTO operations_order_shipment_address_working_copies (
           organization_id, order_id,
           source_order_row_version, source_order_hash,
           ship_to_state, ship_to_ciphertext, ship_to_iv, ship_to_tag,
           ship_to_hash, dispatch_core_fingerprint,
           ship_to_encryption_version,
           last_command_receipt_id, last_idempotency_key,
           last_request_hash, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::bigint, $4,
           $5, $6, $7, $8, $9, $10, $11,
           $12::uuid, $13, $14, $15, $15
         )
         RETURNING row_version::text`,
        [
          organizationId,
          row.order_id,
          orderRowVersion,
          sourceOrderHash,
          shipToState,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.hash,
          dispatchCoreFingerprint,
          encrypted.encryptionVersion,
          prepared.receipt.id,
          input.idempotencyKey,
          exactRequestHash,
          actorEmail,
        ],
      )
      rowVersion = Number(created.rows[0].row_version)
    }

    const result: OperationsOrderShipmentAddressUpdateResult = {
      orderGlobalId,
      orderRowVersion,
      rowVersion,
      readiness,
      issues,
      changedFields,
      sourceVersionChanged: false,
      rerateRequired: shipmentAddressRequiresRerate(row, after),
      providerWrites: 0,
      providerWriteIntentCreated: false,
      replayed: false,
    }
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_global_id = $2,
           result_payload = $3::jsonb, error_code = NULL,
           error_message = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [prepared.receipt.id, orderGlobalId, JSON.stringify(result)],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.order_shipment_address.updated',
      aggregateType: 'operations.order',
      aggregateId: orderGlobalId,
      subject: orderGlobalId,
      organizationId,
      eventKey: `operations:order-shipment-address:${prepared.receipt.id}`,
      payload: {
        orderGlobalId,
        orderRowVersion,
        rowVersion,
        readiness,
        issueFields: issues.map((issue) => issue.field),
        changedFields,
        rerateRequired: result.rerateRequired,
        providerWrites: 0,
        providerWriteIntentCreated: false,
        commandReceiptId: prepared.receipt.id,
        correlationId: prepared.receipt.correlation_id,
      },
    }, client)
    return result
  })
}
