import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import {
  ActiveFulfillmentExecutionError,
  hashActiveExecutionEvidence,
  prepareActiveFulfillmentExecution,
  type ActiveCarrierProvider,
} from '@/lib/operations/activeFulfillmentExecution'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

const COMMAND_TYPE = 'prepare-active-fulfillment-execution'
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const SHADOW_EXECUTION_GLOBAL_ID = /^gofe(?:[0-9]{7}|[0-9a-v]{12})$/u
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

export class ActiveFulfillmentExecutionPreparationError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'ActiveFulfillmentExecutionPreparationError'
    this.code = code
    this.status = status
  }
}

export type PrepareActiveFulfillmentExecutionFromShadowInput = {
  organizationId: unknown
  shadowExecutionGlobalId: unknown
  expectedActivationRevision: unknown
  expectedOrderRowVersion: unknown
  reason: unknown
  idempotencyKey: unknown
  actorEmail: unknown
}

export type ActiveFulfillmentPreparationPackage = {
  packageGlobalId: string
  packageKey: string
  packageNumber: number
}

export type ActiveFulfillmentExecutionPreparation = {
  activeExecutionGlobalId: string
  activeShipmentGroupGlobalId: string
  shadowExecutionGlobalId: string
  orderGlobalId: string
  planGlobalId: string
  warehouseGlobalId: string
  authorityMode: 'active'
  state: 'prepared'
  activationRevision: number
  expectedOrderRowVersion: number
  reason: string
  planningEstimate: {
    provider: ActiveCarrierProvider
    serviceCode: string
    serviceName: string
    carrierCostMinor: number
    currency: string
  }
  packages: readonly ActiveFulfillmentPreparationPackage[]
  packageCount: number
  requestHash: string
  preparedAt: string
  replayed: boolean
}

type CommandReceiptRow = QueryResultRow & {
  id: string
  request_hash: string
  status: string
  result_global_id: string | null
}

type ShadowContextRow = QueryResultRow & {
  shadow_execution_id: string
  shadow_execution_global_id: string
  shadow_authority_mode: string
  shadow_state: string
  provider_write_count: number
  postage_purchase_count: number
  label_write_count: number
  commerce_write_count: number
  order_id: string
  order_global_id: string
  order_status: string
  order_source_provider: string
  order_currency: string
  order_row_version: string | number
  plan_id: string
  plan_global_id: string
  plan_status: string
  plan_order_id: string
  plan_warehouse_id: string
  warehouse_id: string
  warehouse_global_id: string
  warehouse_status: string
  shadow_group_id: string
  shadow_group_global_id: string
  group_order_id: string
  group_plan_id: string
  group_warehouse_id: string
  selected_provider: string
  selected_service_code: string
  selected_service_name: string
  selected_carrier_cost_minor: string | number
  group_currency: string
  group_state: string
  source_package_count: number
  source_run_id: string
  current_activation_state: string
  current_activation_revision: number
  blocking_exception_count: string | number
  linked_label_attempt_count: string | number
  linked_label_count: string | number
  linked_shipment_count: string | number
}

type ShadowPackageRow = QueryResultRow & {
  package_id: string
  package_global_id: string
  package_key: string
  package_number: number
  package_plan_id: string
  package_status: string
  package_length_mm: number
  package_width_mm: number
  package_height_mm: number
  package_weight_grams: number
  source_package_sequence: number
  source_length_mm: number
  source_width_mm: number
  source_height_mm: number
  source_gross_weight_grams: number
}

type LoadedPreparationRow = QueryResultRow & {
  active_execution_global_id: string
  active_shipment_group_global_id: string
  shadow_execution_global_id: string
  order_global_id: string
  plan_global_id: string
  warehouse_global_id: string
  authority_mode: 'active'
  state: 'prepared'
  activation_revision: number
  expected_order_row_version: string | number
  reason: string
  selected_provider: ActiveCarrierProvider
  selected_service_code: string
  selected_service_name: string
  selected_carrier_cost_minor: string | number
  currency: string
  package_count: number
  request_hash: string
  prepared_at: Date | string
}

function fail(code: string, message: string, status = 409): never {
  throw new ActiveFulfillmentExecutionPreparationError(code, message, status)
}

function requiredText(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string') {
    fail('OPERATIONS_ACTIVE_PREPARATION_INPUT_INVALID', `${label} is required`, 400)
  }
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail('OPERATIONS_ACTIVE_PREPARATION_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function requiredUuid(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 36).toLowerCase()
  if (!UUID.test(normalized)) {
    fail('OPERATIONS_ACTIVE_PREPARATION_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function shadowExecutionGlobalId(value: unknown): string {
  const normalized = requiredText(value, 'Shadow execution Global ID', 20)
    .toLowerCase()
  if (!SHADOW_EXECUTION_GLOBAL_ID.test(normalized)) {
    fail(
      'OPERATIONS_ACTIVE_PREPARATION_INPUT_INVALID',
      'Shadow execution Global ID is invalid',
      400,
    )
  }
  return normalized
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    fail('OPERATIONS_ACTIVE_PREPARATION_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function nonNegativeInteger(value: unknown, label: string): number {
  const normalized = Number(value)
  if (
    !Number.isSafeInteger(normalized)
    || normalized < 0
    || normalized > 2_147_483_647
  ) {
    fail('OPERATIONS_ACTIVE_PREPARATION_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function idempotencyKey(value: unknown): string {
  const normalized = requiredText(value, 'Idempotency key', 200)
  if (normalized.length < 8 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
    fail(
      'OPERATIONS_ACTIVE_PREPARATION_IDEMPOTENCY_INVALID',
      'Idempotency key is invalid',
      400,
    )
  }
  return normalized
}

function actorEmail(value: unknown): string {
  const normalized = requiredText(value, 'Actor email', 320).toLowerCase()
  if (!EMAIL.test(normalized)) {
    fail('OPERATIONS_ACTIVE_PREPARATION_INPUT_INVALID', 'Actor email is invalid', 400)
  }
  return normalized
}

function safeNonNegativeInteger(value: unknown, label: string): number {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail('OPERATIONS_ACTIVE_PREPARATION_SOURCE_INVALID', `${label} is invalid`)
  }
  return normalized
}

async function runInTransaction<T>(
  suppliedClient: PoolClient | undefined,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return suppliedClient ? callback(suppliedClient) : withTransaction(callback)
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof ActiveFulfillmentExecutionPreparationError) throw error
  if (error instanceof ActiveFulfillmentExecutionError) {
    fail(error.code, error.message, 409)
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error
    ? String((error as { code?: unknown }).code || '')
    : ''
  if (
    ['23503', '23505', '23514', '40001', '40P01'].includes(code)
    || /duplicate key|constraint|immutable|requires|mismatch/iu.test(message)
  ) {
    fail(
      'OPERATIONS_ACTIVE_PREPARATION_CONFLICT',
      'Active fulfillment preparation conflicted with current immutable Operations evidence',
    )
  }
  throw error
}

function commandRequestHash(input: {
  organizationId: string
  shadowExecutionGlobalId: string
  expectedActivationRevision: number
  expectedOrderRowVersion: number
  reason: string
}): string {
  return hashActiveExecutionEvidence({
    contract: 'active-fulfillment-execution-preparation-v2',
    ...input,
  })
}

async function loadPreparation(
  client: PoolClient,
  organizationId: string,
  activeExecutionGlobalId: string,
  replayed: boolean,
): Promise<ActiveFulfillmentExecutionPreparation> {
  const executionResult = await client.query<LoadedPreparationRow>(
    `SELECT execution.global_id AS active_execution_global_id,
            shipment_group.global_id AS active_shipment_group_global_id,
            shadow.global_id AS shadow_execution_global_id,
            orders.global_id AS order_global_id,
            plan.global_id AS plan_global_id,
            warehouse.global_id AS warehouse_global_id,
            execution.authority_mode, execution.state,
            execution.activation_revision,
            execution.expected_order_row_version::text,
            execution.reason,
            shipment_group.selected_provider,
            shipment_group.selected_service_code,
            shipment_group.selected_service_name,
            shipment_group.selected_carrier_cost_minor::text,
            shipment_group.currency, shipment_group.package_count,
            execution.request_hash, execution.prepared_at
     FROM operations_active_fulfillment_executions execution
     JOIN operations_active_shipment_groups shipment_group
       ON shipment_group.organization_id = execution.organization_id
      AND shipment_group.active_fulfillment_execution_id = execution.id
     JOIN operations_fulfillment_executions shadow
       ON shadow.organization_id = execution.organization_id
      AND shadow.id = execution.shadow_fulfillment_execution_id
     JOIN operations_orders orders
       ON orders.organization_id = execution.organization_id
      AND orders.id = execution.order_id
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = execution.organization_id
      AND plan.id = execution.plan_id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = execution.organization_id
      AND warehouse.id = execution.warehouse_id
     WHERE execution.organization_id = $1::uuid
       AND execution.global_id = $2
     LIMIT 1`,
    [organizationId, activeExecutionGlobalId],
  )
  const execution = executionResult.rows[0]
  if (!execution) {
    fail(
      'OPERATIONS_ACTIVE_PREPARATION_INTEGRITY_INVALID',
      'Prepared Active fulfillment execution could not be reloaded',
      500,
    )
  }
  const packageResult = await client.query<ShadowPackageRow>(
    `SELECT active_package.package_id::text,
            package.global_id AS package_global_id,
            active_package.package_key,
            active_package.package_number,
            package.plan_id::text AS package_plan_id,
            package.status AS package_status
     FROM operations_active_execution_packages active_package
     JOIN operations_packages package
       ON package.organization_id = active_package.organization_id
      AND package.id = active_package.package_id
     JOIN operations_active_fulfillment_executions execution
       ON execution.organization_id = active_package.organization_id
      AND execution.id = active_package.active_fulfillment_execution_id
     WHERE active_package.organization_id = $1::uuid
       AND execution.global_id = $2
     ORDER BY active_package.package_number, package.global_id`,
    [organizationId, activeExecutionGlobalId],
  )
  const packages = packageResult.rows.map((row) => ({
    packageGlobalId: row.package_global_id,
    packageKey: row.package_key,
    packageNumber: Number(row.package_number),
  }))
  if (packages.length !== Number(execution.package_count)) {
    fail(
      'OPERATIONS_ACTIVE_PREPARATION_INTEGRITY_INVALID',
      'Prepared Active package set could not be reloaded exactly',
      500,
    )
  }
  return Object.freeze({
    activeExecutionGlobalId: execution.active_execution_global_id,
    activeShipmentGroupGlobalId: execution.active_shipment_group_global_id,
    shadowExecutionGlobalId: execution.shadow_execution_global_id,
    orderGlobalId: execution.order_global_id,
    planGlobalId: execution.plan_global_id,
    warehouseGlobalId: execution.warehouse_global_id,
    authorityMode: execution.authority_mode,
    state: execution.state,
    activationRevision: Number(execution.activation_revision),
    expectedOrderRowVersion: nonNegativeInteger(
      execution.expected_order_row_version,
      'Expected order row version',
    ),
    reason: execution.reason,
    planningEstimate: Object.freeze({
      provider: execution.selected_provider,
      serviceCode: execution.selected_service_code,
      serviceName: execution.selected_service_name,
      carrierCostMinor: safeNonNegativeInteger(
        execution.selected_carrier_cost_minor,
        'Planning carrier cost',
      ),
      currency: execution.currency,
    }),
    packages: Object.freeze(packages),
    packageCount: packages.length,
    requestHash: execution.request_hash,
    preparedAt: new Date(execution.prepared_at).toISOString(),
    replayed,
  })
}

export async function prepareActiveFulfillmentExecutionFromShadowInPostgres(
  input: PrepareActiveFulfillmentExecutionFromShadowInput,
  suppliedClient?: PoolClient,
): Promise<ActiveFulfillmentExecutionPreparation> {
  const organizationId = requiredUuid(input.organizationId, 'Organization ID')
  const sourceGlobalId = shadowExecutionGlobalId(input.shadowExecutionGlobalId)
  const expectedRevision = positiveInteger(
    input.expectedActivationRevision,
    'Expected activation revision',
  )
  const expectedOrderRowVersion = nonNegativeInteger(
    input.expectedOrderRowVersion,
    'Expected order row version',
  )
  const reason = requiredText(input.reason, 'Active preparation reason', 500)
  const requestIdempotencyKey = idempotencyKey(input.idempotencyKey)
  const email = actorEmail(input.actorEmail)
  const receiptRequestHash = commandRequestHash({
    organizationId,
    shadowExecutionGlobalId: sourceGlobalId,
    expectedActivationRevision: expectedRevision,
    expectedOrderRowVersion,
    reason,
  })

  try {
    return await runInTransaction(suppliedClient, async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:command-receipt:${organizationId}:${COMMAND_TYPE}:${requestIdempotencyKey}`,
      )
      await acquireTransactionAdvisoryLock(
        client,
        `operations:active-preparation:${organizationId}:${sourceGlobalId}`,
      )

      const existingReceipt = await client.query<CommandReceiptRow>(
        `SELECT id::text, request_hash, status, result_global_id
         FROM operations_command_receipts
         WHERE organization_id = $1::uuid
           AND command_type = $2
           AND idempotency_key = $3
         LIMIT 1
         FOR UPDATE`,
        [organizationId, COMMAND_TYPE, requestIdempotencyKey],
      )
      const receipt = existingReceipt.rows[0]
      if (receipt) {
        if (receipt.request_hash !== receiptRequestHash) {
          fail(
            'OPERATIONS_ACTIVE_PREPARATION_IDEMPOTENCY_CONFLICT',
            'Idempotency key is already bound to different Active preparation evidence',
          )
        }
        if (receipt.status !== 'succeeded' || !receipt.result_global_id) {
          fail(
            'OPERATIONS_ACTIVE_PREPARATION_IN_PROGRESS',
            'Active fulfillment preparation is already being processed',
          )
        }
        return loadPreparation(
          client,
          organizationId,
          receipt.result_global_id,
          true,
        )
      }

      const createdReceipt = await client.query<{ id: string }>(
        `INSERT INTO operations_command_receipts (
           organization_id, command_type, idempotency_key, request_hash,
           actor_email, status, correlation_id
         ) VALUES ($1::uuid, $2, $3, $4, $5, 'processing', $6::uuid)
         RETURNING id::text`,
        [
          organizationId,
          COMMAND_TYPE,
          requestIdempotencyKey,
          receiptRequestHash,
          email,
          randomUUID(),
        ],
      )
      const receiptId = createdReceipt.rows[0].id

      const existingActive = await client.query<{ global_id: string }>(
        `SELECT active.global_id
         FROM operations_active_fulfillment_executions active
         JOIN operations_fulfillment_executions shadow
           ON shadow.organization_id = active.organization_id
          AND shadow.id = active.shadow_fulfillment_execution_id
         WHERE active.organization_id = $1::uuid
           AND shadow.global_id = $2
         LIMIT 1
         FOR SHARE OF active, shadow`,
        [organizationId, sourceGlobalId],
      )
      if (existingActive.rows[0]) {
        fail(
          'OPERATIONS_ACTIVE_PREPARATION_SHADOW_ALREADY_BOUND',
          'Shadow fulfillment execution is already bound to a different immutable Active command',
        )
      }

      const contextResult = await client.query<ShadowContextRow>(
        `SELECT shadow.id::text AS shadow_execution_id,
                shadow.global_id AS shadow_execution_global_id,
                shadow.authority_mode AS shadow_authority_mode,
                shadow.state AS shadow_state,
                shadow.provider_write_count, shadow.postage_purchase_count,
                shadow.label_write_count, shadow.commerce_write_count,
                orders.id::text AS order_id,
                orders.global_id AS order_global_id,
                orders.status AS order_status,
                orders.source_provider AS order_source_provider,
                orders.currency AS order_currency,
                orders.row_version::text AS order_row_version,
                plan.id::text AS plan_id, plan.global_id AS plan_global_id,
                plan.status AS plan_status,
                plan.order_id::text AS plan_order_id,
                plan.warehouse_id::text AS plan_warehouse_id,
                warehouse.id::text AS warehouse_id,
                warehouse.global_id AS warehouse_global_id,
                warehouse.status AS warehouse_status,
                shipment_group.id::text AS shadow_group_id,
                shipment_group.global_id AS shadow_group_global_id,
                shipment_group.order_id::text AS group_order_id,
                shipment_group.plan_id::text AS group_plan_id,
                shipment_group.warehouse_id::text AS group_warehouse_id,
                shipment_group.selected_provider,
                shipment_group.selected_service_code,
                shipment_group.selected_service_name,
                shipment_group.selected_carrier_cost_minor::text,
                shipment_group.currency AS group_currency,
                shipment_group.state AS group_state,
                source_run.package_count AS source_package_count,
                source_run.id::text AS source_run_id,
                activation.state AS current_activation_state,
                activation.revision AS current_activation_revision,
                (
                  SELECT count(*)
                  FROM operations_exceptions exception
                  WHERE exception.organization_id = shadow.organization_id
                    AND exception.order_id = orders.id
                    AND exception.status = 'open'
                    AND exception.severity IN ('high', 'critical')
                ) AS blocking_exception_count,
                (
                  SELECT count(*)
                  FROM operations_label_attempts attempt
                  WHERE attempt.organization_id = shadow.organization_id
                    AND attempt.fulfillment_execution_id = shadow.id
                ) AS linked_label_attempt_count,
                (
                  SELECT count(*)
                  FROM operations_labels label
                  WHERE label.organization_id = shadow.organization_id
                    AND label.fulfillment_execution_id = shadow.id
                ) AS linked_label_count,
                (
                  SELECT count(*)
                  FROM operations_shipments shipment
                  WHERE shipment.organization_id = shadow.organization_id
                    AND shipment.fulfillment_execution_id = shadow.id
                ) AS linked_shipment_count
         FROM operations_fulfillment_executions shadow
         JOIN operations_orders orders
           ON orders.organization_id = shadow.organization_id
          AND orders.id = shadow.order_id
         JOIN operations_fulfillment_plans plan
           ON plan.organization_id = shadow.organization_id
          AND plan.id = shadow.plan_id
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = shadow.organization_id
          AND warehouse.id = plan.warehouse_id
         JOIN operations_shipment_groups shipment_group
           ON shipment_group.organization_id = shadow.organization_id
          AND shipment_group.fulfillment_execution_id = shadow.id
         JOIN operations_pack_rate_runs source_run
           ON source_run.organization_id = shipment_group.organization_id
          AND source_run.id = shipment_group.fulfillment_pack_rate_run_id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = shadow.organization_id
         WHERE shadow.organization_id = $1::uuid
           AND shadow.global_id = $2
         LIMIT 2
         FOR UPDATE OF orders
         FOR SHARE OF shadow, plan, warehouse, shipment_group,
           source_run, activation`,
        [organizationId, sourceGlobalId],
      )
      if (contextResult.rows.length !== 1) {
        fail(
          'OPERATIONS_ACTIVE_PREPARATION_SHADOW_NOT_FOUND',
          'One immutable Shadow fulfillment execution and shipment group were not found',
          404,
        )
      }
      const context = contextResult.rows[0]
      if (
        nonNegativeInteger(context.order_row_version, 'Current order row version')
          !== expectedOrderRowVersion
      ) {
        fail(
          'OPERATIONS_ACTIVE_PREPARATION_ORDER_VERSION_CHANGED',
          'Active preparation requires the exact current order row version',
        )
      }
      const orderExceptions = await client.query<{
        severity: string
        status: string
      }>(
        `SELECT exception.severity, exception.status
         FROM operations_exceptions exception
         WHERE exception.organization_id = $1::uuid
           AND exception.order_id = $2::uuid
         FOR SHARE`,
        [organizationId, context.order_id],
      )
      if (
        Number(context.blocking_exception_count) !== 0
        || orderExceptions.rows.some((exception) => (
          exception.status === 'open'
          && ['high', 'critical'].includes(exception.severity)
        ))
      ) {
        fail(
          'OPERATIONS_ACTIVE_PREPARATION_ORDER_BLOCKED',
          'Active preparation is blocked by an open high or critical order exception',
        )
      }
      if (
        context.current_activation_state !== 'active'
        || Number(context.current_activation_revision) !== expectedRevision
      ) {
        fail(
          'OPERATIONS_ACTIVE_PREPARATION_REVISION_CHANGED',
          'Active preparation requires the current Operations Active revision',
        )
      }
      if (
        context.shadow_authority_mode !== 'shadow'
        || context.shadow_state !== 'shadow_prepared'
        || Number(context.provider_write_count) !== 0
        || Number(context.postage_purchase_count) !== 0
        || Number(context.label_write_count) !== 0
        || Number(context.commerce_write_count) !== 0
        || Number(context.linked_label_attempt_count) !== 0
        || Number(context.linked_label_count) !== 0
        || Number(context.linked_shipment_count) !== 0
      ) {
        fail(
          'OPERATIONS_ACTIVE_PREPARATION_SHADOW_NOT_READ_ONLY',
          'Active preparation requires immutable zero-write Shadow evidence',
        )
      }
      if (
        String(context.order_source_provider).toLowerCase() !== 'shopify'
        || context.order_status !== 'packed'
        || context.plan_status !== 'released'
        || context.warehouse_status !== 'active'
        || context.group_state !== 'shadow_prepared'
        || context.plan_order_id !== context.order_id
        || context.group_order_id !== context.order_id
        || context.group_plan_id !== context.plan_id
        || context.plan_warehouse_id !== context.warehouse_id
        || context.group_warehouse_id !== context.warehouse_id
        || context.group_currency !== context.order_currency
      ) {
        fail(
          'OPERATIONS_ACTIVE_PREPARATION_SOURCE_INVALID',
          'Active preparation requires one packed Shopify order, released single-warehouse plan, active warehouse, and matching currency',
        )
      }

      const packageResult = await client.query<ShadowPackageRow>(
        `SELECT edge.package_id::text,
                package.global_id AS package_global_id,
                edge.package_key, package.package_number,
                package.plan_id::text AS package_plan_id,
                package.status AS package_status,
                package.length_mm AS package_length_mm,
                package.width_mm AS package_width_mm,
                package.height_mm AS package_height_mm,
                package.weight_grams AS package_weight_grams,
                source_package.package_sequence AS source_package_sequence,
                source_package.length_mm AS source_length_mm,
                source_package.width_mm AS source_width_mm,
                source_package.height_mm AS source_height_mm,
                source_package.gross_weight_grams AS source_gross_weight_grams
         FROM operations_fulfillment_execution_packages edge
         JOIN operations_packages package
           ON package.organization_id = edge.organization_id
          AND package.id = edge.package_id
         JOIN operations_pack_rate_run_packages source_package
           ON source_package.organization_id = edge.organization_id
          AND source_package.run_id = edge.fulfillment_pack_rate_run_id
          AND source_package.package_key = edge.package_key
         WHERE edge.organization_id = $1::uuid
           AND edge.execution_id = $2::uuid
           AND edge.shipment_group_id = $3::uuid
           AND edge.fulfillment_pack_rate_run_id = $4::uuid
         ORDER BY package.package_number, package.global_id
         FOR SHARE OF edge, package, source_package`,
        [
          organizationId,
          context.shadow_execution_id,
          context.shadow_group_id,
          context.source_run_id,
        ],
      )
      if (
        packageResult.rows.length < 1
        || packageResult.rows.length > 50
        || packageResult.rows.length !== Number(context.source_package_count)
      ) {
        fail(
          'OPERATIONS_ACTIVE_PREPARATION_PACKAGE_SET_INVALID',
          'Active preparation requires the exact 1-50 Shadow rate-run packages',
        )
      }
      for (const [index, packageRow] of packageResult.rows.entries()) {
        if (
          Number(packageRow.package_number) !== index + 1
          || Number(packageRow.source_package_sequence) !== index + 1
          || packageRow.package_plan_id !== context.plan_id
          || packageRow.package_status !== 'packed'
        ) {
          fail(
            'OPERATIONS_ACTIVE_PREPARATION_PACKAGE_SET_INVALID',
            'Active preparation requires one contiguous packed physical package set',
          )
        }
        if (
          Number(packageRow.package_length_mm) !== Number(packageRow.source_length_mm)
          || Number(packageRow.package_width_mm) !== Number(packageRow.source_width_mm)
          || Number(packageRow.package_height_mm) !== Number(packageRow.source_height_mm)
          || Number(packageRow.package_weight_grams)
            !== Number(packageRow.source_gross_weight_grams)
        ) {
          fail(
            'OPERATIONS_ACTIVE_PREPARATION_PACKAGE_EVIDENCE_DRIFT',
            'Active preparation requires package dimensions and weight to match immutable Shadow rate evidence',
          )
        }
      }

      const prepared = prepareActiveFulfillmentExecution({
        activationState: context.current_activation_state,
        activationRevision: expectedRevision,
        shadowExecutionId: context.shadow_execution_id,
        orderId: context.order_id,
        planId: context.plan_id,
        warehouseId: context.warehouse_id,
        idempotencyKey: requestIdempotencyKey,
        selection: {
          provider: context.selected_provider as ActiveCarrierProvider,
          serviceCode: context.selected_service_code,
          serviceName: context.selected_service_name,
          carrierCostMinor: safeNonNegativeInteger(
            context.selected_carrier_cost_minor,
            'Planning carrier cost',
          ),
          currency: context.group_currency,
        },
        packages: packageResult.rows.map((row) => ({
          packageId: row.package_id,
          packageKey: row.package_key,
          packageNumber: Number(row.package_number),
        })),
      })
      const activeRequestHash = hashActiveExecutionEvidence({
        contract: 'active-fulfillment-execution-preparation-persisted-v2',
        preparedRequestHash: prepared.requestHash,
        expectedOrderRowVersion,
        reason,
      })

      const activeExecutionResult = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_active_fulfillment_executions (
           organization_id, shadow_fulfillment_execution_id,
           order_id, plan_id, warehouse_id, authority_mode, state,
           activation_revision, expected_order_row_version, reason,
           idempotency_key, request_hash, prepared_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           'active', 'prepared', $6, $7, $8, $9, $10, $11
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          context.shadow_execution_id,
          context.order_id,
          context.plan_id,
          context.warehouse_id,
          expectedRevision,
          expectedOrderRowVersion,
          reason,
          requestIdempotencyKey,
          activeRequestHash,
          email,
        ],
      )
      const activeExecution = activeExecutionResult.rows[0]
      const activeGroupResult = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_active_shipment_groups (
           organization_id, active_fulfillment_execution_id,
           shadow_shipment_group_id, selected_provider,
           selected_service_code, selected_service_name,
           selected_carrier_cost_minor, currency, package_count, state
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9,
           'prepared'
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          activeExecution.id,
          context.shadow_group_id,
          prepared.selection.provider,
          prepared.selection.serviceCode,
          prepared.selection.serviceName,
          prepared.selection.carrierCostMinor,
          prepared.selection.currency,
          prepared.packageCount,
        ],
      )
      const activeGroup = activeGroupResult.rows[0]
      const insertedPackages = await client.query(
        `INSERT INTO operations_active_execution_packages (
           organization_id, active_fulfillment_execution_id,
           active_shipment_group_id, shadow_fulfillment_execution_id,
           package_id, package_key, package_number
         )
         SELECT edge.organization_id, $4::uuid, $5::uuid, edge.execution_id,
                edge.package_id, edge.package_key, package.package_number
         FROM operations_fulfillment_execution_packages edge
         JOIN operations_packages package
           ON package.organization_id = edge.organization_id
          AND package.id = edge.package_id
         WHERE edge.organization_id = $1::uuid
           AND edge.execution_id = $2::uuid
           AND edge.shipment_group_id = $3::uuid
         ORDER BY package.package_number`,
        [
          organizationId,
          context.shadow_execution_id,
          context.shadow_group_id,
          activeExecution.id,
          activeGroup.id,
        ],
      )
      if (insertedPackages.rowCount !== prepared.packageCount) {
        fail(
          'OPERATIONS_ACTIVE_PREPARATION_PACKAGE_SET_INVALID',
          'Active package insert did not preserve the exact Shadow package set',
          500,
        )
      }

      const result = await loadPreparation(
        client,
        organizationId,
        activeExecution.global_id,
        false,
      )
      await client.query(
        `UPDATE operations_command_receipts
         SET status = 'succeeded', result_global_id = $2,
             result_payload = $3::jsonb, error_code = NULL,
             error_message = NULL, completed_at = now(), updated_at = now()
         WHERE id = $1::uuid AND status = 'processing'`,
        [
          receiptId,
          activeExecution.global_id,
          JSON.stringify({ ...result, replayed: false }),
        ],
      )
      return result
    })
  } catch (error) {
    mapPersistenceError(error)
  }
}
