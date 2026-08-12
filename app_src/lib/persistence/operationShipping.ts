import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  CarrierIntegrationRequestError,
  resolveCarrierSandboxShippingRuntime,
  type CarrierSandboxShippingRuntime,
} from '@/lib/integrations/carrierIntegrations'
import {
  CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
  CarrierSandboxLabelError,
  carrierSandboxLabelRequestEvidence,
  carrierSandboxVoidRequestEvidence,
  createCarrierSandboxLabel,
  type CarrierSandboxLabelShipmentFixture,
  voidCarrierSandboxLabel,
} from '@/lib/integrations/carrierSandboxLabel'
import { CARRIER_SANDBOX_RATE_FIXTURE } from '@/lib/integrations/carrierSandboxRate'
import type { OperationsSandboxLabelCommandResult } from '@/lib/operations/types'
import { enqueueOperationsPrintJobInPostgres } from '@/lib/persistence/operationPrintDelivery'
import { OperationsRequestError } from '@/lib/persistence/operations'
import {
  assertCommerceOrderRevisionExecutionCurrent,
  CommerceOrderRevisionGateError,
} from '@/lib/persistence/commerceOrderRevisions'
import {
  requireActiveSandboxCommerceE2eAuthorization,
} from '@/lib/persistence/sandboxCommerceE2eAuthorization'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type LabelAction = 'create' | 'void'
type DirectCarrierProvider = CarrierSandboxShippingRuntime['provider']

type OrderRow = QueryResultRow & {
  id: string
  global_id: string
  status: string
  row_version: string
  ship_to: Record<string, unknown>
  activation_state: string
  plan_id: string | null
  warehouse_id: string | null
  warehouse_address: Record<string, unknown> | null
}

type PackageRow = QueryResultRow & {
  id: string
  global_id: string
  status: string
  length_mm: number
  width_mm: number
  height_mm: number
  weight_grams: number
}

type RateRow = QueryResultRow & {
  id: string
  global_id: string
  carrier: string
  service_code: string
  selected: boolean
}

type LineRow = QueryResultRow & {
  description: string
  product_name: string
  quantity: string
}

type LabelRow = QueryResultRow & {
  id: string
  global_id: string
  status: 'created' | 'voided' | 'failed'
  carrier: string
  service_code: string
  tracking_number: string
  provider_label_id: string
  environment: string
  package_global_id: string
  carrier_rate_global_id: string
  carrier_account_global_id: string
  create_attempt_global_id: string | null
  void_attempt_global_id: string | null
}

type AttemptRow = QueryResultRow & {
  id: string
  global_id: string
  state: 'prepared' | 'succeeded' | 'failed' | 'unknown'
  request_hash: string
  redacted_request: Record<string, unknown>
  label_id: string | null
  label_global_id: string | null
}

type ShippingContext = {
  order: OrderRow
  package: PackageRow
  rate: RateRow
  lines: LineRow[]
  activeLabel: LabelRow | null
}

type PreparedAttemptResult =
  | {
      context: null
      attempt: AttemptRow
      replay: OperationsSandboxLabelCommandResult
    }
  | {
      context: ShippingContext
      attempt: AttemptRow
      replay: null
    }

async function requireCurrentCommerceRevisionForLabel(
  client: PoolClient,
  organizationId: string,
  orderId: string,
) {
  try {
    await assertCommerceOrderRevisionExecutionCurrent(client, {
      organizationId,
      orderId,
      operation: 'label',
    })
  } catch (error) {
    if (error instanceof CommerceOrderRevisionGateError) {
      throw new OperationsRequestError(error.code, error.message, error.status)
    }
    throw error
  }
}

type CreateSandboxLabelInput = {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  carrierRateGlobalId?: string | null
  carrierAccountGlobalId?: string | null
  preferredPrinterGlobalId?: string | null
  packageGlobalId?: string | null
  sandboxE2eAuthorizationGlobalId?: string | null
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}

type VoidSandboxLabelInput = {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const RATE_GLOBAL_ID = /^grt(?:[0-9]{7}|[0-9a-v]{12})$/
const CARRIER_ACCOUNT_GLOBAL_ID = /^gac(?:[0-9]{7}|[0-9a-v]{12})$/
const PRINTER_GLOBAL_ID = /^gpr(?:[0-9]{7}|[0-9a-v]{12})$/
const PACKAGE_GLOBAL_ID = /^gpa(?:[0-9]{7}|[0-9a-v]{12})$/
const SANDBOX_E2E_AUTHORIZATION_GLOBAL_ID = /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function requiredText(value: unknown, label: string, maximum: number) {
  const normalized = String(value || '').trim()
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new OperationsRequestError('OPERATIONS_LABEL_REQUEST_INVALID', `${label} is invalid`)
  }
  return normalized
}

function requiredOrganizationId(value: unknown) {
  const normalized = requiredText(value, 'Organization', 50)
  if (!UUID.test(normalized)) {
    throw new OperationsRequestError('OPERATIONS_LABEL_REQUEST_INVALID', 'Organization is invalid')
  }
  return normalized
}

function requiredGlobalId(value: unknown, label: string, pattern: RegExp) {
  const normalized = requiredText(value, label, 20)
  if (!pattern.test(normalized)) {
    throw new OperationsRequestError('OPERATIONS_LABEL_REQUEST_INVALID', `${label} is invalid`)
  }
  return normalized
}

function optionalGlobalId(value: unknown, label: string, pattern: RegExp) {
  const normalized = String(value || '').trim()
  if (!normalized) return null
  return requiredGlobalId(normalized, label, pattern)
}

function requiredVersion(value: unknown) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_REQUEST_INVALID',
      'Order version is invalid',
    )
  }
  return parsed
}

function requiredIdempotencyKey(value: unknown) {
  const normalized = String(value || '').trim()
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new OperationsRequestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key is required',
    )
  }
  return normalized
}

function providerForCarrier(value: string): DirectCarrierProvider {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'ups' || normalized === 'ups_rest') return 'ups_rest'
  if (normalized === 'fedex' || normalized === 'fedex_rest') return 'fedex_rest'
  throw new OperationsRequestError(
    'OPERATIONS_LABEL_CARRIER_UNSUPPORTED',
    'Sandbox labels currently support UPS and FedEx carrier rates',
    409,
  )
}

function normalizedAddress(value: Record<string, unknown> | null) {
  const address = value || {}
  return {
    name: String(address.name || '').trim().toLowerCase(),
    street: String(address.line1 || address.street || '').trim().toLowerCase(),
    city: String(address.city || '').trim().toLowerCase(),
    state: String(address.region || address.state || '').trim().toUpperCase(),
    postalCode: String(address.postalCode || address.postal_code || '')
      .trim()
      .replace(/\s+/g, '')
      .toUpperCase(),
    countryCode: String(address.country || address.countryCode || '')
      .trim()
      .toUpperCase(),
  }
}

function fixtureAddress(
  value: Record<string, unknown> | null,
  fixture: {
    name: string
    street: string
    city: string
    state: string
    postalCode: string
    countryCode: string
  },
  options: { requireName?: boolean } = {},
) {
  const candidate = normalizedAddress(value)
  return (
    (options.requireName === false || candidate.name === fixture.name.toLowerCase())
    && candidate.street === fixture.street.toLowerCase()
    && candidate.city === fixture.city.toLowerCase()
    && candidate.state === fixture.state
    && candidate.postalCode === fixture.postalCode
    && candidate.countryCode === fixture.countryCode
  )
}

async function dbQuery<Row extends QueryResultRow>(
  client: PoolClient | null,
  sql: string,
  values: unknown[],
) {
  return client ? client.query<Row>(sql, values) : query<Row>(sql, values)
}

async function readShippingContext(
  organizationId: string,
  orderGlobalId: string,
  carrierRateGlobalId: string | null,
  packageGlobalId: string | null,
  client: PoolClient | null,
  lock: boolean,
): Promise<ShippingContext> {
  const orderResult = await dbQuery<OrderRow>(
    client,
    `SELECT orders.id::text, orders.global_id, orders.status,
            orders.row_version::text, orders.ship_to,
            activation.state AS activation_state,
            plan.id::text AS plan_id, plan.warehouse_id::text,
            warehouse.address AS warehouse_address
     FROM operations_orders orders
     JOIN operations_activation_scopes activation
       ON activation.organization_id = orders.organization_id
     LEFT JOIN LATERAL (
       SELECT candidate.*
       FROM operations_fulfillment_plans candidate
       WHERE candidate.organization_id = orders.organization_id
         AND candidate.order_id = orders.id
       ORDER BY candidate.version_number DESC
       LIMIT 1
     ) plan ON true
     LEFT JOIN operations_warehouses warehouse
       ON warehouse.organization_id = orders.organization_id
      AND warehouse.id = plan.warehouse_id
     WHERE orders.organization_id = $1::uuid
       AND orders.global_id = $2
       AND orders.archived_at IS NULL
     LIMIT 1
     ${lock ? 'FOR UPDATE OF orders' : ''}`,
    [organizationId, orderGlobalId],
  )
  const order = orderResult.rows[0]
  if (!order) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_NOT_FOUND',
      'Operations order was not found',
      404,
    )
  }
  if (!order.plan_id || !order.warehouse_id) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_PLAN_REQUIRED',
      'The order needs a warehouse fulfillment plan before label creation',
      409,
    )
  }

  const packageResult = await dbQuery<PackageRow>(
    client,
    `SELECT id::text, global_id, status, length_mm, width_mm, height_mm, weight_grams
     FROM operations_packages
     WHERE organization_id = $1::uuid AND plan_id = $2::uuid
       AND ($3::text IS NULL OR global_id = $3)
     ORDER BY package_number
     ${lock ? 'FOR UPDATE' : ''}`,
    [organizationId, order.plan_id, packageGlobalId],
  )
  const rateResult = await dbQuery<RateRow>(
    client,
    `SELECT id::text, global_id, carrier, service_code, selected
     FROM operations_carrier_rates
     WHERE organization_id = $1::uuid
       AND plan_id = $2::uuid
       AND (
         ($3::text IS NOT NULL AND global_id = $3)
         OR ($3::text IS NULL AND selected = true)
       )
     ORDER BY selected DESC, internal_cost_minor, id
     LIMIT 1
     ${lock ? 'FOR SHARE' : ''}`,
    [organizationId, order.plan_id, carrierRateGlobalId],
  )
  const lineResult = await dbQuery<LineRow>(
    client,
    `SELECT line.description, product.name AS product_name, line.quantity::text
     FROM operations_order_lines line
     JOIN crm_products product
       ON product.pipeline_id = line.pipeline_id AND product.id = line.product_id
     WHERE line.organization_id = $1::uuid AND line.order_id = $2::uuid
     ORDER BY line.created_at, line.id`,
    [organizationId, order.id],
  )
  const activeLabelResult = await dbQuery<LabelRow>(
    client,
    `SELECT label.id::text, label.global_id, label.status, label.carrier,
            label.service_code, label.tracking_number, label.provider_label_id,
            label.environment, package.global_id AS package_global_id,
            rate.global_id AS carrier_rate_global_id,
            carrier_account.global_id AS carrier_account_global_id,
            create_attempt.global_id AS create_attempt_global_id,
            void_attempt.global_id AS void_attempt_global_id
     FROM operations_labels label
     JOIN operations_packages package
       ON package.organization_id = label.organization_id
      AND package.id = label.package_id
     JOIN operations_carrier_rates rate
       ON rate.organization_id = label.organization_id
      AND rate.id = label.carrier_rate_id
     JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = label.organization_id
      AND carrier_account.id = label.carrier_account_id
     LEFT JOIN operations_label_attempts create_attempt
       ON create_attempt.organization_id = label.organization_id
      AND create_attempt.id = label.create_attempt_id
     LEFT JOIN operations_label_attempts void_attempt
       ON void_attempt.organization_id = label.organization_id
      AND void_attempt.id = label.void_attempt_id
     WHERE label.organization_id = $1::uuid
       AND package.plan_id = $2::uuid
       AND ($3::text IS NULL OR package.global_id = $3)
       AND label.status = 'created'
     ORDER BY label.created_at DESC, label.id DESC
     LIMIT 1
     ${lock ? 'FOR SHARE OF label, package' : ''}`,
    [organizationId, order.plan_id, packageGlobalId],
  )

  if (packageResult.rows.length !== 1) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_SINGLE_PACKAGE_REQUIRED',
      packageGlobalId
        ? 'The selected sandbox E2E package is unavailable'
        : 'Sandbox label execution requires exactly one package',
      409,
    )
  }
  const rate = rateResult.rows[0]
  if (!rate) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_RATE_REQUIRED',
      carrierRateGlobalId
        ? 'The selected carrier rate is not part of this fulfillment plan'
        : 'Select a carrier rate before creating a label',
      409,
    )
  }
  return {
    order,
    package: packageResult.rows[0],
    rate,
    lines: lineResult.rows,
    activeLabel: activeLabelResult.rows[0] || null,
  }
}

async function assertNoUnresolvedAttempt(
  client: PoolClient,
  organizationId: string,
  packageId: string,
) {
  const result = await client.query<{ global_id: string; state: string }>(
    `SELECT global_id, state
     FROM operations_label_attempts
     WHERE organization_id = $1::uuid
       AND package_id = $2::uuid
       AND state IN ('prepared', 'unknown')
     ORDER BY requested_at DESC, id DESC
     LIMIT 1
     FOR SHARE`,
    [organizationId, packageId],
  )
  if (result.rows[0]) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_RECONCILIATION_REQUIRED',
      `Carrier label attempt ${result.rows[0].global_id} is ${result.rows[0].state} and must be reconciled before another carrier command`,
      409,
    )
  }
}

function assertCreateContext(
  context: ShippingContext,
  expectedRowVersion: number,
  authorizedSandboxE2e = false,
) {
  if (context.order.activation_state !== 'active') {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_ACTIVE_MODE_REQUIRED',
      'Operations must be active before creating a sandbox carrier label; Shadow mode never calls carrier label APIs',
      409,
    )
  }
  if (context.order.status !== 'packed') {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_ORDER_NOT_PACKED',
      'The order must be packed before creating a label',
      409,
    )
  }
  if (Number(context.order.row_version) !== expectedRowVersion) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_VERSION_CONFLICT',
      'The order changed. Refresh it before creating a label.',
      409,
    )
  }
  if (context.package.status !== 'packed') {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_PACKAGE_NOT_PACKED',
      'The package must be packed and unlabeled before creating a label',
      409,
    )
  }
  if (context.activeLabel) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_ALREADY_CREATED',
      `Package already has active label ${context.activeLabel.global_id}`,
      409,
    )
  }
  if (authorizedSandboxE2e) return
  if (
    context.package.length_mm !== 305
    || context.package.width_mm !== 254
    || context.package.height_mm !== 152
    || context.package.weight_grams !== 2268
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_FIXTURE_REQUIRED',
      'Sandbox labels require the fixed Test Product parcel from the sandbox test workflow',
      409,
    )
  }
  if (
    context.lines.length !== 1
    || Number(context.lines[0].quantity) !== 1
    || ![context.lines[0].product_name, context.lines[0].description]
      .some((value) => String(value || '').trim().toLowerCase() === 'test product')
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_FIXTURE_REQUIRED',
      'Sandbox labels require one unit of the Test Product',
      409,
    )
  }
  if (
    !fixtureAddress(context.order.ship_to, CARRIER_SANDBOX_RATE_FIXTURE.destination)
    || !fixtureAddress(
      context.order.warehouse_address,
      CARRIER_SANDBOX_RATE_FIXTURE.origin,
      { requireName: false },
    )
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_FIXTURE_REQUIRED',
      'Sandbox labels require the approved John Doe Delaware-to-Buzzards Bay addresses',
      409,
    )
  }
}

function assertVoidContext(context: ShippingContext, expectedRowVersion: number) {
  if (context.order.activation_state !== 'active') {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_ACTIVE_MODE_REQUIRED',
      'Operations must be active before voiding a sandbox carrier label; Shadow mode never calls carrier void APIs',
      409,
    )
  }
  if (context.order.status !== 'packed') {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_ORDER_NOT_PACKED',
      'Only a packed, unshipped order label may be voided',
      409,
    )
  }
  if (Number(context.order.row_version) !== expectedRowVersion) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_VERSION_CONFLICT',
      'The order changed. Refresh it before voiding the label.',
      409,
    )
  }
  if (
    context.package.status !== 'labeled'
    || !context.activeLabel
    || context.activeLabel.environment !== 'sandbox'
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_VOID_UNAVAILABLE',
      'The package does not have an active sandbox label to void',
      409,
    )
  }
}

function sandboxE2eShipmentFixture(
  context: ShippingContext,
): CarrierSandboxLabelShipmentFixture {
  const party = (
    value: Record<string, unknown> | null,
    fallbackName: string,
  ) => {
    const source = value || {}
    return {
      name: String(source.name || fallbackName).trim(),
      line1: String(source.line1 || source.street || '').trim(),
      line2: String(source.line2 || '').trim() || null,
      city: String(source.city || '').trim(),
      region: String(source.region || source.state || '').trim().toUpperCase(),
      postalCode: String(source.postalCode || source.postal_code || '').trim(),
      countryCode: String(
        source.countryCode || source.country || '',
      ).trim().toUpperCase() as 'US',
    }
  }
  const inches = (millimeters: number) => (
    Math.round((Number(millimeters) / 25.4) * 1_000) / 1_000
  )
  const pounds = Math.round(
    (Number(context.package.weight_grams) / 453.59237) * 1_000,
  ) / 1_000
  return {
    origin: party(context.order.warehouse_address, 'ClawPilot Warehouse'),
    destination: party(context.order.ship_to, 'Commerce customer'),
    parcel: {
      description: context.lines.map((line) => line.product_name || line.description)
        .filter(Boolean).join(', ').slice(0, 200) || 'Commerce test order',
      length: inches(context.package.length_mm),
      width: inches(context.package.width_mm),
      height: inches(context.package.height_mm),
      dimensionUnit: 'IN',
      weight: pounds,
      weightUnit: 'LB',
    },
  }
}

function commandHash(input: {
  action: LabelAction
  context: ShippingContext
  runtime: CarrierSandboxShippingRuntime
  reason: string
  providerEvidence: { requestHash: string; redactedRequest: Record<string, unknown> }
}) {
  return fingerprint({
    action: input.action,
    organizationId: input.runtime.organizationId,
    orderGlobalId: input.context.order.global_id,
    packageGlobalId: input.context.package.global_id,
    carrierRateGlobalId: input.context.rate.global_id,
    integrationGlobalId: input.runtime.integrationGlobalId,
    credentialVersion: input.runtime.credentialVersion,
    carrierAccountGlobalId: input.runtime.carrierAccountGlobalId,
    billingRelationship: input.runtime.billingRelationship,
    reason: input.reason,
    providerRequestHash: input.providerEvidence.requestHash,
  })
}

function safeProviderResponse(error: CarrierSandboxLabelError) {
  return {
    outcome: error.uncertain ? 'unknown' : 'failed',
    code: error.code,
    retryAllowed: false,
    ...(error.redactedResponse || {}),
  }
}

function mapCarrierError(error: unknown): OperationsRequestError {
  if (error instanceof OperationsRequestError) return error
  if (error instanceof CarrierIntegrationRequestError) {
    return new OperationsRequestError(error.code, error.message, error.status)
  }
  if (error instanceof CarrierSandboxLabelError) {
    return new OperationsRequestError(error.code, error.message, error.status)
  }
  return new OperationsRequestError(
    'OPERATIONS_LABEL_REQUEST_FAILED',
    'Carrier label request failed',
    500,
  )
}

async function replayResult(
  client: PoolClient,
  organizationId: string,
  action: LabelAction,
  attempt: AttemptRow,
): Promise<OperationsSandboxLabelCommandResult> {
  if (attempt.state !== 'succeeded' || !attempt.label_id) {
    const code = attempt.state === 'unknown' || attempt.state === 'prepared'
      ? 'OPERATIONS_LABEL_RECONCILIATION_REQUIRED'
      : 'OPERATIONS_LABEL_IDEMPOTENCY_REUSED'
    throw new OperationsRequestError(
      code,
      attempt.state === 'failed'
        ? 'This Idempotency-Key belongs to a failed carrier command; inspect the attempt before issuing a new command'
        : `Carrier label attempt ${attempt.global_id} is ${attempt.state} and must be reconciled`,
      409,
    )
  }
  const result = await client.query<LabelRow & {
    order_global_id: string
    order_status: string
    row_version: string
  }>(
    `SELECT label.id::text, label.global_id, label.status, label.carrier,
            label.service_code, label.tracking_number, label.provider_label_id,
            label.environment, package.global_id AS package_global_id,
            rate.global_id AS carrier_rate_global_id,
            carrier_account.global_id AS carrier_account_global_id,
            create_attempt.global_id AS create_attempt_global_id,
            void_attempt.global_id AS void_attempt_global_id,
            orders.global_id AS order_global_id, orders.status AS order_status,
            orders.row_version::text
     FROM operations_labels label
     JOIN operations_packages package
       ON package.organization_id = label.organization_id
      AND package.id = label.package_id
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = package.organization_id
      AND plan.id = package.plan_id
     JOIN operations_carrier_rates rate
       ON rate.organization_id = label.organization_id
      AND rate.id = label.carrier_rate_id
     JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = label.organization_id
      AND carrier_account.id = label.carrier_account_id
     JOIN operations_orders orders
       ON orders.organization_id = plan.organization_id
      AND orders.id = plan.order_id
     LEFT JOIN operations_label_attempts create_attempt
       ON create_attempt.organization_id = label.organization_id
      AND create_attempt.id = label.create_attempt_id
     LEFT JOIN operations_label_attempts void_attempt
       ON void_attempt.organization_id = label.organization_id
      AND void_attempt.id = label.void_attempt_id
     WHERE label.organization_id = $1::uuid AND label.id = $2::uuid
     LIMIT 1`,
    [organizationId, attempt.label_id],
  )
  const label = result.rows[0]
  if (!label || label.order_status !== 'packed') {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_REPLAY_UNAVAILABLE',
      'The prior carrier command result is no longer available',
      409,
    )
  }
  return {
    orderGlobalId: label.order_global_id,
    orderStatus: 'packed',
    rowVersion: Number(label.row_version),
    packageGlobalId: label.package_global_id,
    labelGlobalId: label.global_id,
    attemptGlobalId: attempt.global_id,
    trackingNumber: label.tracking_number,
    labelStatus: label.status === 'voided' || action === 'void' ? 'voided' : 'created',
    replayed: true,
    printJobGlobalId: null,
    printWarning: null,
  }
}

function assertAttemptInputMatches(
  attempt: AttemptRow,
  input: {
    orderGlobalId: string
    reason: string
    carrierRateGlobalId?: string | null
    carrierAccountGlobalId?: string | null
    packageGlobalId?: string | null
    sandboxE2eAuthorizationGlobalId?: string | null
    provider?: DirectCarrierProvider | null
  },
) {
  const evidence = attempt.redacted_request || {}
  const mismatched = (
    evidence.orderGlobalId !== input.orderGlobalId
    || evidence.reason !== input.reason
    || (
      input.carrierRateGlobalId
      && evidence.carrierRateGlobalId !== input.carrierRateGlobalId
    )
    || (
      input.carrierAccountGlobalId
      && evidence.carrierAccountGlobalId !== input.carrierAccountGlobalId
    )
    || (
      input.packageGlobalId
      && evidence.packageGlobalId !== input.packageGlobalId
    )
    || (
      input.sandboxE2eAuthorizationGlobalId
      && evidence.sandboxE2eAuthorizationGlobalId
        !== input.sandboxE2eAuthorizationGlobalId
    )
    || (input.provider && evidence.provider !== input.provider)
  )
  if (mismatched) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_IDEMPOTENCY_REUSED',
      'Idempotency-Key was already used for a different carrier command',
      409,
    )
  }
}

async function findExistingAttempt(
  client: PoolClient,
  input: {
    organizationId: string
    action: LabelAction
    idempotencyKey: string
  },
) {
  const result = await client.query<AttemptRow>(
    `SELECT attempt.id::text, attempt.global_id, attempt.state,
            attempt.request_hash, attempt.redacted_request,
            attempt.label_id::text, label.global_id AS label_global_id
     FROM operations_label_attempts attempt
     LEFT JOIN operations_labels label
       ON label.organization_id = attempt.organization_id
      AND label.id = attempt.label_id
     WHERE attempt.organization_id = $1::uuid
       AND attempt.action = $2
       AND attempt.idempotency_key = $3
     LIMIT 1
     FOR SHARE OF attempt`,
    [input.organizationId, input.action, input.idempotencyKey],
  )
  return result.rows[0] || null
}

async function replayExistingAttempt(input: {
  organizationId: string
  action: LabelAction
  idempotencyKey: string
  orderGlobalId: string
  reason: string
  carrierRateGlobalId?: string | null
  carrierAccountGlobalId?: string | null
  packageGlobalId?: string | null
  sandboxE2eAuthorizationGlobalId?: string | null
}) {
  return withTransaction(async (client) => {
    const attempt = await findExistingAttempt(client, input)
    if (!attempt) return null
    assertAttemptInputMatches(attempt, input)
    return replayResult(client, input.organizationId, input.action, attempt)
  })
}

async function prepareAttempt(input: {
  action: LabelAction
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  carrierRateGlobalId: string | null
  packageGlobalId: string | null
  sandboxE2eAuthorizationGlobalId: string | null
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
  runtime: CarrierSandboxShippingRuntime
}): Promise<PreparedAttemptResult> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:label:${input.organizationId}:${input.orderGlobalId}:${input.action}`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `operations:label-attempt:${input.organizationId}:${input.action}:${input.idempotencyKey}`,
    )
    const existing = await findExistingAttempt(client, input)
    if (existing) {
      assertAttemptInputMatches(existing, {
        ...input,
        carrierAccountGlobalId: input.runtime.carrierAccountGlobalId,
        provider: input.runtime.provider,
      })
      return {
        context: null,
        attempt: existing,
        replay: await replayResult(
          client,
          input.organizationId,
          input.action,
          existing,
        ),
      }
    }
    const context = await readShippingContext(
      input.organizationId,
      input.orderGlobalId,
      input.carrierRateGlobalId,
      input.packageGlobalId,
      client,
      true,
    )
    if (input.action === 'create') {
      await requireCurrentCommerceRevisionForLabel(
        client,
        input.organizationId,
        context.order.id,
      )
      if (input.sandboxE2eAuthorizationGlobalId) {
        await requireActiveSandboxCommerceE2eAuthorization(client, {
          organizationId: input.organizationId,
          authorizationGlobalId: input.sandboxE2eAuthorizationGlobalId,
          orderGlobalId: input.orderGlobalId,
          actorEmail: input.actorEmail,
          packageGlobalId: input.packageGlobalId,
        })
      }
      assertCreateContext(
        context,
        input.expectedRowVersion,
        Boolean(input.sandboxE2eAuthorizationGlobalId),
      )
    } else {
      assertVoidContext(context, input.expectedRowVersion)
    }
    const contextProvider = providerForCarrier(context.rate.carrier)
    if (contextProvider !== input.runtime.provider) {
      throw new OperationsRequestError(
        'OPERATIONS_LABEL_CARRIER_MISMATCH',
        'The selected carrier account does not match the selected carrier rate',
        409,
      )
    }
    const providerEvidence = input.action === 'create'
      ? carrierSandboxLabelRequestEvidence(
        input.runtime.provider,
        context.rate.service_code,
        input.runtime.billingRelationship,
        undefined,
        input.sandboxE2eAuthorizationGlobalId
          ? sandboxE2eShipmentFixture(context)
          : undefined,
      )
      : carrierSandboxVoidRequestEvidence(
        input.runtime.provider,
        context.activeLabel!.tracking_number,
        context.activeLabel!.provider_label_id,
      )
    const requestHash = commandHash({
      action: input.action,
      context,
      runtime: input.runtime,
      reason: input.reason,
      providerEvidence,
    })
    await assertNoUnresolvedAttempt(client, input.organizationId, context.package.id)
    const inserted = await client.query<AttemptRow>(
      `INSERT INTO operations_label_attempts (
         organization_id, order_id, package_id, carrier_rate_id,
         integration_account_id, carrier_account_id,
         action, environment, provider, adapter_version,
         idempotency_key, request_hash, redacted_request, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid,
         $7, 'sandbox', $8, $9,
         $10, $11, $12::jsonb, $13
       )
       RETURNING id::text, global_id, state, request_hash,
                 redacted_request, label_id::text,
                 NULL::text AS label_global_id`,
      [
        input.organizationId,
        context.order.id,
        context.package.id,
        context.rate.id,
        input.runtime.integrationAccountId,
        input.runtime.carrierAccountId,
        input.action,
        input.runtime.provider,
        CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
        input.idempotencyKey,
        requestHash,
        JSON.stringify({
          ...providerEvidence.redactedRequest,
          orderGlobalId: context.order.global_id,
          packageGlobalId: context.package.global_id,
          carrierRateGlobalId: context.rate.global_id,
          integrationGlobalId: input.runtime.integrationGlobalId,
          credentialVersion: input.runtime.credentialVersion,
          carrierAccountGlobalId: input.runtime.carrierAccountGlobalId,
          carrierAccountDisplayName: input.runtime.carrierAccountDisplayName,
          accountNumberLastFour: input.runtime.accountNumberLastFour,
          billingRelationship: input.runtime.billingRelationship,
          billingSelection: input.runtime.billingSelectionSnapshot,
          reason: input.reason,
          sandboxE2eAuthorizationGlobalId:
            input.sandboxE2eAuthorizationGlobalId,
        }),
        input.actorEmail,
      ],
    )
    return { context, attempt: inserted.rows[0], replay: null }
  })
}

async function finalizeProviderFailure(input: {
  organizationId: string
  attemptId: string
  error: CarrierSandboxLabelError
}) {
  await query(
    `UPDATE operations_label_attempts
     SET state = $3,
         redacted_response = $4::jsonb,
         error_code = $5,
         completed_at = now()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND state = 'prepared'`,
    [
      input.organizationId,
      input.attemptId,
      input.error.uncertain ? 'unknown' : 'failed',
      JSON.stringify(safeProviderResponse(input.error)),
      input.error.code,
    ],
  )
}

async function markFinalizeUnknown(input: {
  organizationId: string
  attemptId: string
  providerReference: string | null
  redactedResponse: Record<string, unknown>
}) {
  try {
    await query(
      `UPDATE operations_label_attempts
       SET state = 'unknown',
           redacted_response = $3::jsonb,
           provider_reference = $4,
           error_code = 'OPERATIONS_LABEL_PERSISTENCE_UNKNOWN',
           completed_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND state = 'prepared'`,
      [
        input.organizationId,
        input.attemptId,
        JSON.stringify(input.redactedResponse),
        input.providerReference,
      ],
    )
  } catch {
    // A prepared attempt still blocks a duplicate purchase if Postgres is unavailable.
  }
}

async function appendLabelEvent(client: PoolClient, input: {
  organizationId: string
  orderId: string
  orderGlobalId: string
  eventType: 'label.created' | 'label.voided'
  actorEmail: string
  idempotencyKey: string
  payload: Record<string, unknown>
}) {
  await client.query(
    `INSERT INTO operations_domain_events (
       organization_id, aggregate_type, aggregate_id, aggregate_global_id,
       event_type, payload, actor_email, correlation_id, idempotency_key
     ) VALUES (
       $1::uuid, 'operations.order', $2::uuid, $3,
       $4, $5::jsonb, $6, $7::uuid, $8
     )
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [
      input.organizationId,
      input.orderId,
      input.orderGlobalId,
      input.eventType,
      JSON.stringify(input.payload),
      input.actorEmail,
      randomUUID(),
      input.idempotencyKey,
    ],
  )
}

async function enqueueLabelPrint(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  warehouseId: string
  labelGlobalId: string
  preferredPrinterGlobalId: string | null
}) {
  try {
    const job = await enqueueOperationsPrintJobInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      idempotencyKey: `${input.idempotencyKey}:print`,
      warehouseId: input.warehouseId,
      preferredPrinterGlobalId: input.preferredPrinterGlobalId,
      document: {
        type: 'shipping_label',
        sourceLabelGlobalId: input.labelGlobalId,
        media: 'label_4x6',
      },
    })
    return { printJobGlobalId: job.globalId, printWarning: null }
  } catch (error) {
    const warning = error instanceof OperationsRequestError
      ? error.message
      : 'Label was created, but printer routing failed'
    return { printJobGlobalId: null, printWarning: warning }
  }
}

async function readLabelWarehouseId(
  organizationId: string,
  labelGlobalId: string,
): Promise<string> {
  const result = await query<{ warehouse_id: string | null }>(
    `SELECT plan.warehouse_id::text
     FROM operations_labels label
     JOIN operations_packages package
       ON package.organization_id = label.organization_id
      AND package.id = label.package_id
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = package.organization_id
      AND plan.id = package.plan_id
     WHERE label.organization_id = $1::uuid
       AND label.global_id = $2
     LIMIT 1`,
    [organizationId, labelGlobalId],
  )
  const warehouseId = result.rows[0]?.warehouse_id
  if (!warehouseId) {
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_PRINT_CONTEXT_MISSING',
      'The label warehouse is unavailable for print recovery',
      409,
    )
  }
  return warehouseId
}

async function recoverCreateReplayPrint(input: {
  replay: OperationsSandboxLabelCommandResult
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  preferredPrinterGlobalId: string | null
}) {
  if (input.replay.labelStatus !== 'created') return input.replay
  const print = await enqueueLabelPrint({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    idempotencyKey: input.idempotencyKey,
    warehouseId: await readLabelWarehouseId(
      input.organizationId,
      input.replay.labelGlobalId,
    ),
    labelGlobalId: input.replay.labelGlobalId,
    preferredPrinterGlobalId: input.preferredPrinterGlobalId,
  })
  return { ...input.replay, ...print }
}

export async function createOperationsSandboxLabelInPostgres(
  rawInput: CreateSandboxLabelInput,
): Promise<OperationsSandboxLabelCommandResult> {
  const organizationId = requiredOrganizationId(rawInput.organizationId)
  const actorEmail = requiredText(rawInput.actorEmail, 'Actor', 320).toLowerCase()
  const orderGlobalId = requiredGlobalId(rawInput.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID)
  const carrierRateGlobalId = optionalGlobalId(
    rawInput.carrierRateGlobalId,
    'Carrier rate',
    RATE_GLOBAL_ID,
  )
  const carrierAccountGlobalId = optionalGlobalId(
    rawInput.carrierAccountGlobalId,
    'Carrier account',
    CARRIER_ACCOUNT_GLOBAL_ID,
  )
  const preferredPrinterGlobalId = optionalGlobalId(
    rawInput.preferredPrinterGlobalId,
    'Preferred printer',
    PRINTER_GLOBAL_ID,
  )
  const packageGlobalId = optionalGlobalId(
    rawInput.packageGlobalId,
    'Package',
    PACKAGE_GLOBAL_ID,
  )
  const sandboxE2eAuthorizationGlobalId = optionalGlobalId(
    rawInput.sandboxE2eAuthorizationGlobalId,
    'Sandbox E2E authorization',
    SANDBOX_E2E_AUTHORIZATION_GLOBAL_ID,
  )
  if (Boolean(packageGlobalId) !== Boolean(sandboxE2eAuthorizationGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_SANDBOX_E2E_AUTHORIZATION_REQUIRED',
      'Package-specific sandbox labels require the exact sandbox E2E authorization',
      403,
    )
  }
  const expectedRowVersion = requiredVersion(rawInput.expectedRowVersion)
  const reason = requiredText(rawInput.reason, 'Label creation reason', 500)
  const idempotencyKey = requiredIdempotencyKey(rawInput.idempotencyKey)

  const replay = await replayExistingAttempt({
    organizationId,
    action: 'create',
    idempotencyKey,
    orderGlobalId,
    reason,
    carrierRateGlobalId,
    carrierAccountGlobalId,
    packageGlobalId,
    sandboxE2eAuthorizationGlobalId,
  })
  if (replay) {
    return recoverCreateReplayPrint({
      replay,
      organizationId,
      actorEmail,
      idempotencyKey,
      preferredPrinterGlobalId,
    })
  }

  let initial: ShippingContext
  let runtime: CarrierSandboxShippingRuntime
  try {
    initial = await readShippingContext(
      organizationId,
      orderGlobalId,
      carrierRateGlobalId,
      packageGlobalId,
      null,
      false,
    )
    const provider = providerForCarrier(initial.rate.carrier)
    runtime = await resolveCarrierSandboxShippingRuntime({
      organizationId,
      provider,
      carrierAccountGlobalId,
      senderBillingOnly: Boolean(sandboxE2eAuthorizationGlobalId),
    })
  } catch (error) {
    throw mapCarrierError(error)
  }

  const prepared = await prepareAttempt({
    action: 'create',
    organizationId,
    actorEmail,
    orderGlobalId,
    carrierRateGlobalId,
    packageGlobalId,
    sandboxE2eAuthorizationGlobalId,
    expectedRowVersion,
    reason,
    idempotencyKey,
    runtime,
  })
  if (prepared.replay) {
    return recoverCreateReplayPrint({
      replay: prepared.replay,
      organizationId,
      actorEmail,
      idempotencyKey,
      preferredPrinterGlobalId,
    })
  }

  let providerResult: Awaited<ReturnType<typeof createCarrierSandboxLabel>>
  try {
    providerResult = await createCarrierSandboxLabel({
      ...runtime,
      serviceCode: prepared.context.rate.service_code,
      ...(sandboxE2eAuthorizationGlobalId
        ? { shipmentFixture: sandboxE2eShipmentFixture(prepared.context) }
        : {}),
    })
  } catch (error) {
    const carrierError = error instanceof CarrierSandboxLabelError
      ? error
      : new CarrierSandboxLabelError(
        'The carrier sandbox label result is unknown',
        503,
        'CARRIER_PROVIDER_RESULT_UNKNOWN',
        true,
      )
    await finalizeProviderFailure({
      organizationId,
      attemptId: prepared.attempt.id,
      error: carrierError,
    })
    throw mapCarrierError(carrierError)
  }

  let result: OperationsSandboxLabelCommandResult
  try {
    result = await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:label:${organizationId}:${orderGlobalId}:create`,
      )
      const attemptResult = await client.query<AttemptRow>(
        `SELECT id::text, global_id, state, request_hash, label_id::text,
                NULL::text AS label_global_id
         FROM operations_label_attempts
         WHERE organization_id = $1::uuid AND id = $2::uuid
         LIMIT 1
         FOR UPDATE`,
        [organizationId, prepared.attempt.id],
      )
      const attempt = attemptResult.rows[0]
      if (!attempt || attempt.state !== 'prepared') {
        throw new OperationsRequestError(
          'OPERATIONS_LABEL_RECONCILIATION_REQUIRED',
          'Carrier label attempt is no longer prepared for finalization',
          409,
        )
      }
      const inserted = await client.query<{ id: string; global_id: string }>(
        `INSERT INTO operations_labels (
           organization_id, package_id, carrier_rate_id,
           integration_account_id, carrier_account_id,
           carrier, service_code, tracking_number, format, label_payload,
           provider_label_id, idempotency_key, status, environment,
           request_hash, redacted_provider_evidence, create_attempt_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           $4::uuid, $5::uuid,
           $6, $7, $8, $9, $10,
           $11, $12, 'created', 'sandbox',
           $13, $14::jsonb, $15::uuid
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          prepared.context.package.id,
          prepared.context.rate.id,
          runtime.integrationAccountId,
          runtime.carrierAccountId,
          prepared.context.rate.carrier,
          prepared.context.rate.service_code,
          providerResult.trackingNumber,
          providerResult.format,
          providerResult.labelPayload,
          providerResult.providerLabelId,
          idempotencyKey,
          attempt.request_hash,
          JSON.stringify({
            adapterVersion: CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
            provider: runtime.provider,
            request: providerResult.evidence.redactedRequest,
            response: providerResult.evidence.redactedResponse,
            providerReference: providerResult.evidence.providerReference,
            billingRelationship: runtime.billingRelationship,
            carrierAccountGlobalId: runtime.carrierAccountGlobalId,
            accountNumberLastFour: runtime.accountNumberLastFour,
          }),
          attempt.id,
        ],
      )
      await client.query(
        `UPDATE operations_label_attempts
         SET state = 'succeeded',
             label_id = $3::uuid,
             redacted_response = $4::jsonb,
             provider_reference = $5,
             completed_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND state = 'prepared'`,
        [
          organizationId,
          attempt.id,
          inserted.rows[0].id,
          JSON.stringify(providerResult.evidence.redactedResponse),
          providerResult.evidence.providerReference,
        ],
      )
      await client.query(
        `UPDATE operations_packages
         SET status = 'labeled'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, prepared.context.package.id],
      )
      const orderResult = await client.query<{ row_version: string }>(
        `UPDATE operations_orders
         SET row_version = row_version + 1, updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid
         RETURNING row_version::text`,
        [organizationId, prepared.context.order.id, actorEmail],
      )
      const eventPayload = {
        labelGlobalId: inserted.rows[0].global_id,
        attemptGlobalId: attempt.global_id,
        packageGlobalId: prepared.context.package.global_id,
        carrierRateGlobalId: prepared.context.rate.global_id,
        carrier: prepared.context.rate.carrier,
        serviceCode: prepared.context.rate.service_code,
        trackingNumber: providerResult.trackingNumber,
        environment: 'sandbox',
        reason,
      }
      await appendLabelEvent(client, {
        organizationId,
        orderId: prepared.context.order.id,
        orderGlobalId,
        eventType: 'label.created',
        actorEmail,
        idempotencyKey: `${idempotencyKey}:event`,
        payload: eventPayload,
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.label.created',
        aggregateType: 'operations.order',
        aggregateId: orderGlobalId,
        eventKey: `operations:label:create:${organizationId}:${idempotencyKey}`,
        subject: orderGlobalId,
        organizationId,
        payload: eventPayload,
      }, client)
      return {
        orderGlobalId,
        orderStatus: 'packed',
        rowVersion: Number(orderResult.rows[0].row_version),
        packageGlobalId: prepared.context.package.global_id,
        labelGlobalId: inserted.rows[0].global_id,
        attemptGlobalId: attempt.global_id,
        trackingNumber: providerResult.trackingNumber,
        labelStatus: 'created',
        replayed: false,
        printJobGlobalId: null,
        printWarning: null,
      }
    })
  } catch {
    await markFinalizeUnknown({
      organizationId,
      attemptId: prepared.attempt.id,
      providerReference: providerResult.evidence.providerReference,
      redactedResponse: providerResult.evidence.redactedResponse,
    })
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_RECONCILIATION_REQUIRED',
      'The carrier created a label, but ClawPilot could not finalize it; reconcile the attempt before retrying',
      503,
    )
  }

  const print = await enqueueLabelPrint({
    organizationId,
    actorEmail,
    idempotencyKey,
    warehouseId: prepared.context.order.warehouse_id!,
    labelGlobalId: result.labelGlobalId,
    preferredPrinterGlobalId,
  })
  return { ...result, ...print }
}

export async function voidOperationsSandboxLabelInPostgres(
  rawInput: VoidSandboxLabelInput,
): Promise<OperationsSandboxLabelCommandResult> {
  const organizationId = requiredOrganizationId(rawInput.organizationId)
  const actorEmail = requiredText(rawInput.actorEmail, 'Actor', 320).toLowerCase()
  const orderGlobalId = requiredGlobalId(rawInput.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID)
  const expectedRowVersion = requiredVersion(rawInput.expectedRowVersion)
  const reason = requiredText(rawInput.reason, 'Label void reason', 500)
  const idempotencyKey = requiredIdempotencyKey(rawInput.idempotencyKey)

  const replay = await replayExistingAttempt({
    organizationId,
    action: 'void',
    idempotencyKey,
    orderGlobalId,
    reason,
  })
  if (replay) return replay

  let initial: ShippingContext
  let runtime: CarrierSandboxShippingRuntime
  try {
    initial = await readShippingContext(
      organizationId,
      orderGlobalId,
      null,
      null,
      null,
      false,
    )
    if (!initial.activeLabel) {
      throw new OperationsRequestError(
        'OPERATIONS_LABEL_VOID_UNAVAILABLE',
        'The order does not have an active sandbox label to void',
        409,
      )
    }
    runtime = await resolveCarrierSandboxShippingRuntime({
      organizationId,
      provider: providerForCarrier(initial.activeLabel.carrier),
      carrierAccountGlobalId: initial.activeLabel.carrier_account_global_id,
    })
  } catch (error) {
    throw mapCarrierError(error)
  }

  const prepared = await prepareAttempt({
    action: 'void',
    organizationId,
    actorEmail,
    orderGlobalId,
    carrierRateGlobalId: initial.activeLabel.carrier_rate_global_id,
    packageGlobalId: null,
    sandboxE2eAuthorizationGlobalId: null,
    expectedRowVersion,
    reason,
    idempotencyKey,
    runtime,
  })
  if (prepared.replay) return prepared.replay

  const activeLabel = prepared.context.activeLabel!
  let providerResult: Awaited<ReturnType<typeof voidCarrierSandboxLabel>>
  try {
    providerResult = await voidCarrierSandboxLabel({
      ...runtime,
      trackingNumber: activeLabel.tracking_number,
      providerReference: activeLabel.provider_label_id,
    })
  } catch (error) {
    const carrierError = error instanceof CarrierSandboxLabelError
      ? error
      : new CarrierSandboxLabelError(
        'The carrier sandbox void result is unknown',
        503,
        'CARRIER_PROVIDER_RESULT_UNKNOWN',
        true,
      )
    await finalizeProviderFailure({
      organizationId,
      attemptId: prepared.attempt.id,
      error: carrierError,
    })
    throw mapCarrierError(carrierError)
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:label:${organizationId}:${orderGlobalId}:void`,
      )
      const attemptResult = await client.query<AttemptRow>(
        `SELECT id::text, global_id, state, request_hash, label_id::text,
                NULL::text AS label_global_id
         FROM operations_label_attempts
         WHERE organization_id = $1::uuid AND id = $2::uuid
         LIMIT 1
         FOR UPDATE`,
        [organizationId, prepared.attempt.id],
      )
      const attempt = attemptResult.rows[0]
      if (!attempt || attempt.state !== 'prepared') {
        throw new OperationsRequestError(
          'OPERATIONS_LABEL_RECONCILIATION_REQUIRED',
          'Carrier label attempt is no longer prepared for finalization',
          409,
        )
      }
      const updatedLabel = await client.query<{ global_id: string }>(
        `UPDATE operations_labels
         SET status = 'voided',
             void_attempt_id = $3::uuid,
             voided_at = now(),
             voided_by = $4,
             redacted_provider_evidence =
               redacted_provider_evidence || $5::jsonb
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'created'
         RETURNING global_id`,
        [
          organizationId,
          activeLabel.id,
          attempt.id,
          actorEmail,
          JSON.stringify({
            void: {
              request: providerResult.evidence.redactedRequest,
              response: providerResult.evidence.redactedResponse,
              providerReference: providerResult.evidence.providerReference,
            },
          }),
        ],
      )
      if (!updatedLabel.rows[0]) {
        throw new OperationsRequestError(
          'OPERATIONS_LABEL_VOID_CONFLICT',
          'The label was already changed before the void could be finalized',
          409,
        )
      }
      await client.query(
        `UPDATE operations_label_attempts
         SET state = 'succeeded',
             label_id = $3::uuid,
             redacted_response = $4::jsonb,
             provider_reference = $5,
             completed_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND state = 'prepared'`,
        [
          organizationId,
          attempt.id,
          activeLabel.id,
          JSON.stringify(providerResult.evidence.redactedResponse),
          providerResult.evidence.providerReference,
        ],
      )
      await client.query(
        `UPDATE operations_packages
         SET status = 'packed'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, prepared.context.package.id],
      )
      const orderResult = await client.query<{ row_version: string }>(
        `UPDATE operations_orders
         SET row_version = row_version + 1, updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid
         RETURNING row_version::text`,
        [organizationId, prepared.context.order.id, actorEmail],
      )
      const eventPayload = {
        labelGlobalId: activeLabel.global_id,
        attemptGlobalId: attempt.global_id,
        packageGlobalId: prepared.context.package.global_id,
        trackingNumber: activeLabel.tracking_number,
        environment: 'sandbox',
        reason,
      }
      await appendLabelEvent(client, {
        organizationId,
        orderId: prepared.context.order.id,
        orderGlobalId,
        eventType: 'label.voided',
        actorEmail,
        idempotencyKey: `${idempotencyKey}:event`,
        payload: eventPayload,
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.label.voided',
        aggregateType: 'operations.order',
        aggregateId: orderGlobalId,
        eventKey: `operations:label:void:${organizationId}:${idempotencyKey}`,
        subject: orderGlobalId,
        organizationId,
        payload: eventPayload,
      }, client)
      return {
        orderGlobalId,
        orderStatus: 'packed',
        rowVersion: Number(orderResult.rows[0].row_version),
        packageGlobalId: prepared.context.package.global_id,
        labelGlobalId: activeLabel.global_id,
        attemptGlobalId: attempt.global_id,
        trackingNumber: activeLabel.tracking_number,
        labelStatus: 'voided',
        replayed: false,
        printJobGlobalId: null,
        printWarning: null,
      }
    })
  } catch {
    await markFinalizeUnknown({
      organizationId,
      attemptId: prepared.attempt.id,
      providerReference: providerResult.evidence.providerReference,
      redactedResponse: providerResult.evidence.redactedResponse,
    })
    throw new OperationsRequestError(
      'OPERATIONS_LABEL_RECONCILIATION_REQUIRED',
      'The carrier voided the label, but ClawPilot could not finalize it; reconcile the attempt before retrying',
      503,
    )
  }
}
