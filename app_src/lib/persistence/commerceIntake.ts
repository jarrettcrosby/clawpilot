import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  decryptCommerceIntakeReadResult,
  decryptCommerceIntakeContinuation,
  decryptCommerceCandidateSnapshot,
  encryptCommerceCandidateSnapshot,
  encryptCommerceIntakeReadResult,
  encryptCommerceIntakeContinuation,
} from '@/lib/integrations/commerceCredentialCrypto'
import { CommerceIntegrationRequestError } from '@/lib/integrations/commerceIntegrations'
import type { CommerceRuntimeCredentialRecord } from '@/lib/persistence/commerceIntegrations'
import {
  commerceCurrencyMinorUnit,
  type CommerceAddressSnapshot,
  type CommerceDataField,
  type CommerceMoneySet,
  type CommerceNormalizationEnvelope,
  type CommerceNormalizedOrder,
  type CommerceNormalizedOrderLine,
  type CommercePartySnapshot,
} from '@/lib/operations/commerceNormalization'
import { stageCrmRecordWithClient } from '@/lib/persistence/crm'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

const POLICY_VERSION = 'commerce-intake-resolution-v1'
const DEFAULT_SLA_POLICY_VERSION = 'commerce-default-sla-v1'
const DEFAULT_SLA_DAYS = 7
const COMMERCE_INTAKE_READ_LEASE_MS = 2 * 60 * 1_000

type CandidateAddress = {
  name: string
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  country: string
}

type CommandContext = {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
}

export type CommerceIntakeStageAction =
  | 'fetch'
  | 'fetch-next'
  | 'fetch-next-products'
  | 'fetch-products'
  | 'refresh'
  | 'retry-rejection'

export type CommerceIntakeReadIntentAction =
  | 'fetch'
  | 'fetch-next'
  | 'fetch-next-products'
  | 'fetch-products'
  | 'refresh'
  | 'retry-rejection'

export type CommerceIntakeReadIntentTarget =
  | { kind: 'none' }
  | {
      kind: 'candidate' | 'rejection'
      globalId: string
      externalId: string
      sourceHash: string
    }

export type CommerceIntakeReadResult = {
  envelope: CommerceNormalizationEnvelope
  page: CommerceIntakeBatchPageInput
}

export type CommerceIntakeBatchPageInput = {
  mode: 'operational'
  resource: 'orders' | 'products'
  sessionId: string
  batchNumber: number
  previousRunGlobalId: string | null
  windowStart: string | null
  windowEnd: string
  queryHash: string
  nextOrderCursor: string | null
  providerRowsSeen: number
  eligibleOrdersSeen: number
}

type ContinuationRow = {
  id: string
  run_global_id: string
  session_id: string
  batch_number: number
  provider: 'shopify' | 'faire'
  resource: 'orders' | 'products'
  credential_version: number
  window_start: string | Date | null
  window_end: string | Date
  query_hash: string
  cursor_state:
    | 'available'
    | 'consumed'
    | 'exhausted'
    | 'invalid'
    | 'expired'
    | 'superseded'
  cursor_ciphertext: Buffer | null
  cursor_iv: Buffer | null
  cursor_tag: Buffer | null
  cursor_hash: string | null
  row_version: string | number
  expires_at: string | Date
}

type CandidateCommandContext = CommandContext & {
  candidateGlobalId: string
  candidateRowVersion: number
}

type IntakeAccountRow = {
  id: string
  global_id: string
  organization_id: string
  provider: 'shopify' | 'faire'
  credential_version: number
  pipeline_id: string
  activation_state:
    | 'disabled'
    | 'shadow'
    | 'read_only'
    | 'active'
    | 'frozen'
}

type CandidateRow = {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  pipeline_id: string
  run_id: string
  run_global_id: string
  credential_version: number
  provider: 'shopify' | 'faire'
  external_order_id: string
  order_number_snapshot: string
  source_hash: string
  source_revision: string
  provider_created_at: string | Date | null
  provider_updated_at: string | Date | null
  provider_order_status_raw: string
  provider_financial_status_raw: string
  provider_fulfillment_status_raw: string
  provider_return_status_raw: string
  normalized_order_status: string
  normalized_payment_status: string
  normalized_fulfillment_status: string
  normalized_return_status: string
  test_order: boolean
  requires_shipping: boolean
  currency_code: string
  subtotal_minor: string
  discount_minor: string
  brand_discount_minor: string
  shipping_minor: string
  tax_minor: string
  other_adjustment_minor: string
  total_minor: string
  party_snapshot_state: string
  party_snapshot_ciphertext: Buffer | null
  party_snapshot_iv: Buffer | null
  party_snapshot_tag: Buffer | null
  customer_resolution_state: string
  customer_id: string | null
  customer_match_method: string | null
  ship_to_snapshot_state: string
  ship_to_snapshot_source: string
  ship_to_snapshot_ciphertext: Buffer | null
  ship_to_snapshot_iv: Buffer | null
  ship_to_snapshot_tag: Buffer | null
  delivery_resolution_state: string
  provider_requested_delivery_at: string | Date | null
  requested_delivery_at: string | Date | null
  delivery_policy_version: string | null
  workflow_state: string
  blocking_codes: string[]
  unsupported_reason_code: string | null
  unsupported_reason_detail: string | null
  canonical_order_id: string | null
  canonical_order_global_id: string | null
  customer_global_id: string | null
  row_version: string
  observed_at: string | Date
  expires_at: string | Date
}

type CandidateLineRow = {
  id: string
  global_id: string
  order_candidate_id: string
  external_line_id: string
  external_product_id: string | null
  external_variant_id: string | null
  external_inventory_item_id: string | null
  sku_snapshot: string | null
  product_title_snapshot: string
  variant_title_snapshot: string | null
  ordered_quantity: string
  current_quantity: string
  cancelled_quantity: string
  fulfilled_quantity: string
  unfulfilled_quantity: string
  returned_quantity: string
  currency_code: string | null
  unit_price_minor: string | null
  subtotal_minor: string | null
  discount_minor: string | null
  brand_discount_minor: string | null
  tax_minor: string | null
  other_adjustment_minor: string | null
  total_minor: string | null
  price_resolution_state: string
  resolved_currency_code: string | null
  resolved_unit_price_minor: string | null
  resolved_subtotal_minor: string | null
  resolved_discount_minor: string | null
  resolved_brand_discount_minor: string | null
  resolved_tax_minor: string | null
  resolved_other_adjustment_minor: string | null
  resolved_total_minor: string | null
  mapping_state: string
  product_id: string | null
  product_global_id: string | null
  product_mapping_id: string | null
  packaging_state: string
  package_profile_id: string | null
  package_profile_global_id: string | null
  packaging_source: string
  weight_grams: number | null
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  requires_shipping: boolean
  workflow_state: string
  blocking_codes: string[]
  source_revision: string
  source_hash: string
  row_version: string
}

type ProductCandidateRow = {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  pipeline_id: string
  run_id: string
  run_global_id: string
  provider: 'shopify' | 'faire'
  external_product_id: string
  external_variant_id: string
  external_inventory_item_id: string | null
  sku_snapshot: string | null
  barcode_snapshot: string | null
  product_title_snapshot: string
  variant_title_snapshot: string | null
  vendor_snapshot: string | null
  product_type_snapshot: string | null
  normalized_options: Array<{
    name: string
    value: string
  }>
  provider_status_raw: string
  normalized_status: string
  unit_multiplier: string
  currency_code: string | null
  price_minor: string | null
  compare_at_price_minor: string | null
  taxable: boolean | null
  requires_shipping: boolean | null
  inventory_quantity: string | null
  weight_grams: number | null
  provider_created_at: string | Date | null
  provider_updated_at: string | Date | null
  observed_at: string | Date
  source_revision: string
  source_hash: string
  workflow_state: string
  mapping_state: string
  product_id: string | null
  product_global_id: string | null
  product_mapping_id: string | null
  product_mapping_global_id: string | null
  blocking_codes: string[]
  unsupported_reason_code: string | null
  unsupported_reason_detail: string | null
  row_version: string
  expires_at: string | Date
}

type ReceiptRow = {
  id: string
  request_hash: string
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_payload: Record<string, unknown> | null
}

function iso(value: string | Date | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function safeJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  ))
}

function availableValue<T>(field: CommerceDataField<T>): T | null {
  return field.state === 'available' ? field.value : null
}

function primaryMoney(field: CommerceDataField<CommerceMoneySet>) {
  return availableValue(field)?.primary || null
}

function presentmentMoney(field: CommerceDataField<CommerceMoneySet>) {
  const set = availableValue(field)
  if (!set || set.presentment.state !== 'available') return null
  return set.presentment.value
}

function bigintString(value: bigint | null | undefined, fallback = BigInt(0)) {
  return (value ?? fallback).toString()
}

export function commerceCustomerIdentityKey(input: {
  organizationId: string
  integrationAccountId: string
  provider: 'shopify' | 'faire'
  candidateGlobalId: string
  externalCustomerId: string | null
}) {
  const scopedSource = input.externalCustomerId
    ? `external:${input.externalCustomerId}`
    : `candidate:${input.candidateGlobalId}`
  const digest = createHash('sha256')
    .update('clawpilot:commerce:crm-customer-identity:v1')
    .update('\0')
    .update(input.organizationId)
    .update('\0')
    .update(input.integrationAccountId)
    .update('\0')
    .update(input.provider)
    .update('\0')
    .update(scopedSource)
    .digest('hex')
  return `commerce:customer:v1:${digest}`
}

function fieldText(field: CommerceDataField<string>) {
  return field.state === 'available' ? field.value : null
}

function addressValue(
  field: CommerceDataField<CommerceAddressSnapshot>,
): Record<string, unknown> | null {
  if (field.state !== 'available') return null
  const value = field.value
  return {
    name: fieldText(value.name),
    organizationName: fieldText(value.organizationName),
    line1: fieldText(value.line1),
    line2: fieldText(value.line2),
    city: fieldText(value.city),
    region: fieldText(value.region),
    regionCode: fieldText(value.regionCode),
    postalCode: fieldText(value.postalCode),
    country: fieldText(value.country),
    countryCode: fieldText(value.countryCode),
    phone: fieldText(value.phone),
  }
}

function partyValue(
  field: CommerceDataField<CommercePartySnapshot>,
): Record<string, unknown> | null {
  if (field.state !== 'available') return null
  const value = field.value
  return {
    role: value.role,
    partyType: value.partyType,
    externalIdentity: value.externalIdentity.state === 'available'
      ? value.externalIdentity.value
      : null,
    organizationName: fieldText(value.organizationName),
    contactName: fieldText(value.contactName),
    email: fieldText(value.email),
    phone: fieldText(value.phone),
  }
}

function completeAddress(value: Record<string, unknown> | null) {
  if (!value) return false
  return [
    value.name,
    value.line1,
    value.city,
    value.region,
    value.postalCode,
    value.countryCode || value.country,
  ].every((item) => typeof item === 'string' && item.trim())
}

function normalizedAddress(value: Record<string, unknown>): CandidateAddress {
  return {
    name: String(value.name || value.organizationName || '').trim(),
    line1: String(value.line1 || '').trim(),
    line2: String(value.line2 || '').trim() || null,
    city: String(value.city || '').trim(),
    region: String(value.regionCode || value.region || '').trim(),
    postalCode: String(value.postalCode || '').trim(),
    country: String(value.countryCode || value.country || '').trim().toUpperCase(),
  }
}

function providerStatus(value: string | null | undefined) {
  const result = String(value || 'UNKNOWN').trim()
  return result || 'UNKNOWN'
}

function normalizedOrderStatus(order: CommerceNormalizedOrder) {
  if (order.canonicalStates.lifecycle === 'cancelled') return 'cancelled'
  if (order.canonicalStates.fulfillment === 'fulfilled') return 'fulfilled'
  if (order.canonicalStates.lifecycle === 'closed') return 'closed'
  if (order.canonicalStates.lifecycle === 'open') return 'open'
  return 'unknown'
}

function normalizedFulfillmentStatus(order: CommerceNormalizedOrder) {
  switch (order.canonicalStates.fulfillment) {
    case 'fulfilled': return 'fulfilled'
    case 'partial': return 'partial'
    case 'unfulfilled':
    case 'on_hold':
    case 'scheduled': return 'unfulfilled'
    default: return 'unknown'
  }
}

function normalizedReturnStatus(order: CommerceNormalizedOrder) {
  switch (order.canonicalStates.returns) {
    case 'none': return 'none'
    case 'requested': return 'requested'
    case 'in_progress': return 'in_progress'
    case 'returned': return 'returned'
    default: return 'unknown'
  }
}

function sourceRevision(updatedAt: string | null, sourceHash: string) {
  return updatedAt || sourceHash
}

const SHIPPING_ONLY_BLOCKING_CODES = new Set([
  'delivery_decision_required',
  'packaging_required',
  'ship_to_confirmation_required',
  'ship_to_incomplete',
  'ship_to_redacted',
  'ship_to_unavailable',
])

function initialOrderBlockingCodes(
  order: CommerceNormalizedOrder,
  requiresShipping: boolean,
) {
  const codes = new Set<string>(
    order.readinessFacts.filter((fact) => fact.blocking).map((fact) => fact.code),
  )
  codes.add('customer_resolution_required')
  if (requiresShipping) {
    if (order.shipTo.state === 'available') {
      codes.add('ship_to_confirmation_required')
    } else {
      codes.add(order.shipTo.state === 'redacted'
        ? 'ship_to_redacted'
        : 'ship_to_unavailable')
    }
    codes.add('delivery_decision_required')
  } else {
    for (const code of SHIPPING_ONLY_BLOCKING_CODES) codes.delete(code)
  }
  if (!order.lines.length) codes.add('line_items_empty')
  if (
    order.canonicalStates.fulfillment === 'partial'
    && !shopifyPartialFulfillmentIsExact(order)
  ) {
    codes.add('order_partially_fulfilled')
  }
  return [...codes].sort()
}

function lineBlockingCodes(line: CommerceNormalizedOrderLine) {
  if (line.unfulfilledQuantity === 0) return []
  const codes = new Set<string>()
  codes.add('product_mapping_required')
  if (line.unitPrice.state !== 'available') codes.add('line_price_required')
  if (line.requiresShipping && line.packaging.state !== 'available') {
    codes.add('packaging_required')
  }
  return [...codes].sort()
}

function exactNormalizedLineQuantityState(
  line: CommerceNormalizedOrderLine,
) {
  const values = [
    line.currentQuantity,
    line.cancelledQuantity,
    line.fulfilledQuantity,
    line.unfulfilledQuantity,
  ]
  if (
    values.some((value) => (
      value === null
      || !Number.isSafeInteger(value)
      || value < 0
    ))
  ) return null
  const current = line.currentQuantity as number
  const cancelled = line.cancelledQuantity as number
  const fulfilled = line.fulfilledQuantity as number
  const unfulfilled = line.unfulfilledQuantity as number
  const returned = line.returnedQuantity
  if (
    returned !== null
    && (
      !Number.isSafeInteger(returned)
      || returned < 0
      || returned > line.orderedQuantity
    )
  ) return null
  if (
    current > line.orderedQuantity
    || cancelled > line.orderedQuantity
    || current + cancelled !== line.orderedQuantity
    || fulfilled > current
    || unfulfilled > current
    || fulfilled + unfulfilled !== current
  ) return null
  return {
    current,
    cancelled,
    fulfilled,
    unfulfilled,
    returned: returned || 0,
  }
}

function shopifyPartialFulfillmentIsExact(order: CommerceNormalizedOrder) {
  return (
    order.providerFacts.provider === 'shopify'
    && order.lines.length > 0
    && order.lines.every((line) => (
      exactNormalizedLineQuantityState(line) !== null
    ))
    && order.lines.some((line) => (
      (line.unfulfilledQuantity || 0) > 0
    ))
  )
}

async function resolveAccount(
  client: PoolClient,
  input: {
    organizationId: string
    accountGlobalId: string
    forUpdate?: boolean
  },
): Promise<IntakeAccountRow> {
  const result = await client.query<IntakeAccountRow>(
    `SELECT
       account.id::text,
       account.global_id,
       account.organization_id::text,
       account.provider,
       account.commerce_credential_generation AS credential_version,
       pipeline.id::text AS pipeline_id,
       activation.state AS activation_state
     FROM operations_integration_accounts account
     JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     JOIN pipeline_spaces pipeline
       ON pipeline.workspace_organization_id = activation.organization_id
      AND pipeline.id = activation.data_pipeline_id
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
     LIMIT 1
     ${input.forUpdate ? 'FOR UPDATE OF account, activation' : ''}`,
    [input.organizationId, input.accountGlobalId],
  )
  const row = result.rows[0]
  if (!row) throw new Error('Commerce intake account is unavailable')
  return row
}

function blocker(code: string) {
  const definitions: Record<string, {
    label: string
    action: string
    terminal: boolean
  }> = {
    customer_resolution_required: {
      label: 'Choose or create the CRM customer',
      action: 'resolve-customer',
      terminal: false,
    },
    customer_redacted: {
      label: 'Enter or choose the CRM customer',
      action: 'resolve-customer',
      terminal: false,
    },
    customer_unavailable: {
      label: 'Enter or choose the CRM customer',
      action: 'resolve-customer',
      terminal: false,
    },
    delivery_decision_required: {
      label: 'Choose a delivery date or the default SLA',
      action: 'resolve-delivery',
      terminal: false,
    },
    line_items_empty: {
      label: 'Refresh or mark this empty order unsupported',
      action: 'refresh',
      terminal: true,
    },
    line_price_required: {
      label: 'Confirm the order-time unit price',
      action: 'resolve-product',
      terminal: false,
    },
    order_already_fulfilled: {
      label: 'Refresh or mark the completed order unsupported',
      action: 'refresh',
      terminal: true,
    },
    order_cancelled: {
      label: 'Refresh or mark the cancelled order unsupported',
      action: 'refresh',
      terminal: true,
    },
    order_cancellation_state_unknown: {
      label: 'Refresh the unknown cancellation state or mark unsupported',
      action: 'refresh',
      terminal: true,
    },
    order_fulfillment_state_unknown: {
      label: 'Refresh the unknown fulfillment state or mark unsupported',
      action: 'refresh',
      terminal: true,
    },
    order_partially_fulfilled: {
      label: 'Refresh or mark the partially fulfilled order unsupported',
      action: 'refresh',
      terminal: true,
    },
    packaging_required: {
      label: 'Choose a package profile or enter dimensions',
      action: 'resolve-package',
      terminal: false,
    },
    product_identity_missing: {
      label: 'Choose or create a product and confirm the mapping',
      action: 'resolve-product',
      terminal: false,
    },
    product_mapping_required: {
      label: 'Choose or create the mapped product',
      action: 'resolve-product',
      terminal: false,
    },
    product_sku_ambiguous: {
      label: 'Choose the exact product for this variant',
      action: 'resolve-product',
      terminal: false,
    },
    product_sku_missing: {
      label: 'Choose or create the product using the provider variant',
      action: 'resolve-product',
      terminal: false,
    },
    ship_to_confirmation_required: {
      label: 'Confirm the provider ship-to address',
      action: 'confirm-address',
      terminal: false,
    },
    ship_to_incomplete: {
      label: 'Complete the ship-to address',
      action: 'confirm-address',
      terminal: false,
    },
    ship_to_redacted: {
      label: 'Enter the ship-to address',
      action: 'confirm-address',
      terminal: false,
    },
    ship_to_unavailable: {
      label: 'Enter the ship-to address',
      action: 'confirm-address',
      terminal: false,
    },
    source_stale: {
      label: 'Refresh the provider record',
      action: 'refresh',
      terminal: false,
    },
    source_truncated: {
      label: 'Refresh after complete pagination is available or mark unsupported',
      action: 'refresh',
      terminal: true,
    },
  }
  const definition = definitions[code] || {
    label: code.replaceAll('_', ' '),
    action: 'validate',
    terminal: false,
  }
  return { code, ...definition }
}

function intakeError(
  code: string,
  message: string,
  status = 409,
): never {
  throw new CommerceIntegrationRequestError(message, status, code)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(',')}}`
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  return JSON.stringify(value) ?? 'null'
}

function commandHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

async function prepareReceipt(
  client: PoolClient,
  input: {
    organizationId: string
    commandType: string
    idempotencyKey: string
    requestHash: string
    actorEmail: string
  },
): Promise<{ receipt: ReceiptRow; replayed: boolean }> {
  await acquireTransactionAdvisoryLock(
    client,
    `commerce-intake:${input.organizationId}:${input.commandType}:${input.idempotencyKey}`,
  )
  const existing = await client.query<ReceiptRow>(
    `SELECT id::text, request_hash, status, correlation_id::text,
            result_payload
     FROM operations_command_receipts
     WHERE organization_id = $1::uuid
       AND command_type = $2
       AND idempotency_key = $3
     FOR UPDATE`,
    [input.organizationId, input.commandType, input.idempotencyKey],
  )
  const current = existing.rows[0]
  if (current) {
    if (current.request_hash !== input.requestHash) {
      intakeError(
        'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different command',
      )
    }
    if (current.status === 'succeeded' && current.result_payload) {
      return { receipt: current, replayed: true }
    }
    const retried = await client.query<ReceiptRow>(
      `UPDATE operations_command_receipts
       SET status = 'processing',
           actor_email = $2,
           attempts = attempts + 1,
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           started_at = now(),
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id::text, request_hash, status, correlation_id::text,
                 result_payload`,
      [current.id, input.actorEmail],
    )
    return { receipt: retried.rows[0], replayed: false }
  }
  const created = await client.query<ReceiptRow>(
    `INSERT INTO operations_command_receipts (
       organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id
     ) VALUES ($1::uuid, $2, $3, $4, $5, 'processing', $6::uuid)
     RETURNING id::text, request_hash, status, correlation_id::text,
               result_payload`,
    [
      input.organizationId,
      input.commandType,
      input.idempotencyKey,
      input.requestHash,
      input.actorEmail,
      randomUUID(),
    ],
  )
  return { receipt: created.rows[0], replayed: false }
}

async function completeReceipt(
  client: PoolClient,
  receiptId: string,
  resultGlobalId: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    `UPDATE operations_command_receipts
     SET status = 'succeeded',
         result_global_id = $2,
         result_payload = $3::jsonb,
         error_code = NULL,
         error_message = NULL,
         completed_at = now(),
         updated_at = now()
     WHERE id = $1::uuid`,
    [receiptId, resultGlobalId, safeJson(payload)],
  )
}

async function commandStart(
  client: PoolClient,
  context: CandidateCommandContext,
  commandType: string,
  command: Record<string, unknown>,
) {
  const account = await resolveAccount(client, {
    organizationId: context.runtime.organizationId,
    accountGlobalId: context.runtime.globalId,
    forUpdate: true,
  })
  const requestHash = commandHash({
    policyVersion: POLICY_VERSION,
    accountGlobalId: context.runtime.globalId,
    candidateGlobalId: context.candidateGlobalId,
    command,
  })
  const prepared = await prepareReceipt(client, {
    organizationId: context.runtime.organizationId,
    commandType,
    idempotencyKey: context.idempotencyKey,
    requestHash,
    actorEmail: context.actorEmail,
  })
  if (!['shadow', 'active'].includes(account.activation_state)) {
    intakeError(
      'COMMERCE_INTAKE_ACTIVATION_REQUIRED',
      'Open Operations and set Activation to Shadow or Active before resolving or promoting orders',
    )
  }
  return { account, requestHash, ...prepared }
}

const CANDIDATE_SELECT = `SELECT
  candidate.id::text,
  candidate.global_id,
  candidate.organization_id::text,
  candidate.integration_account_id::text,
  candidate.pipeline_id::text,
  candidate.run_id::text,
  run.global_id AS run_global_id,
  run.credential_version,
  candidate.provider,
  candidate.external_order_id,
  candidate.order_number_snapshot,
  candidate.source_hash,
  candidate.source_revision,
  candidate.provider_created_at,
  candidate.provider_updated_at,
  candidate.provider_order_status_raw,
  candidate.provider_financial_status_raw,
  candidate.provider_fulfillment_status_raw,
  candidate.provider_return_status_raw,
  candidate.normalized_order_status,
  candidate.normalized_payment_status,
  candidate.normalized_fulfillment_status,
  candidate.normalized_return_status,
  candidate.test_order,
  candidate.requires_shipping,
  candidate.currency_code,
  candidate.subtotal_minor::text,
  candidate.discount_minor::text,
  candidate.brand_discount_minor::text,
  candidate.shipping_minor::text,
  candidate.tax_minor::text,
  candidate.other_adjustment_minor::text,
  candidate.total_minor::text,
  candidate.party_snapshot_state,
  candidate.party_snapshot_ciphertext,
  candidate.party_snapshot_iv,
  candidate.party_snapshot_tag,
  candidate.customer_resolution_state,
  candidate.customer_id::text,
  candidate.customer_match_method,
  candidate.ship_to_snapshot_state,
  candidate.ship_to_snapshot_source,
  candidate.ship_to_snapshot_ciphertext,
  candidate.ship_to_snapshot_iv,
  candidate.ship_to_snapshot_tag,
  candidate.delivery_resolution_state,
  candidate.provider_requested_delivery_at,
  candidate.requested_delivery_at,
  candidate.delivery_policy_version,
  candidate.workflow_state,
  candidate.blocking_codes,
  candidate.unsupported_reason_code,
  candidate.unsupported_reason_detail,
  candidate.canonical_order_id::text,
  canonical_order.global_id AS canonical_order_global_id,
  customer.reference_code AS customer_global_id,
  candidate.row_version::text,
  candidate.observed_at,
  candidate.expires_at
FROM operations_commerce_order_candidates candidate
JOIN operations_commerce_intake_runs run
  ON run.organization_id = candidate.organization_id
 AND run.integration_account_id = candidate.integration_account_id
 AND run.pipeline_id = candidate.pipeline_id
 AND run.id = candidate.run_id
LEFT JOIN operations_orders canonical_order
  ON canonical_order.organization_id = candidate.organization_id
 AND canonical_order.id = candidate.canonical_order_id
LEFT JOIN crm_organizations customer
  ON customer.pipeline_id = candidate.pipeline_id
 AND customer.id = candidate.customer_id`

const LINE_SELECT = `SELECT
  line.id::text,
  line.global_id,
  line.order_candidate_id::text,
  line.external_line_id,
  line.external_product_id,
  line.external_variant_id,
  line.external_inventory_item_id,
  line.sku_snapshot,
  line.product_title_snapshot,
  line.variant_title_snapshot,
  line.ordered_quantity::text,
  line.current_quantity::text,
  line.cancelled_quantity::text,
  line.fulfilled_quantity::text,
  line.unfulfilled_quantity::text,
  line.returned_quantity::text,
  line.currency_code,
  line.unit_price_minor::text,
  line.subtotal_minor::text,
  line.discount_minor::text,
  line.brand_discount_minor::text,
  line.tax_minor::text,
  line.other_adjustment_minor::text,
  line.total_minor::text,
  line.price_resolution_state,
  line.resolved_currency_code,
  line.resolved_unit_price_minor::text,
  line.resolved_subtotal_minor::text,
  line.resolved_discount_minor::text,
  line.resolved_brand_discount_minor::text,
  line.resolved_tax_minor::text,
  line.resolved_other_adjustment_minor::text,
  line.resolved_total_minor::text,
  line.mapping_state,
  line.product_id::text,
  product.reference_code AS product_global_id,
  line.product_mapping_id::text,
  line.packaging_state,
  line.package_profile_id::text,
  package_profile.global_id AS package_profile_global_id,
  line.packaging_source,
  line.weight_grams,
  line.length_mm,
  line.width_mm,
  line.height_mm,
  line.requires_shipping,
  line.workflow_state,
  line.blocking_codes,
  line.source_revision,
  line.source_hash,
  line.row_version::text
FROM operations_commerce_order_candidate_lines line
LEFT JOIN crm_products product
  ON product.pipeline_id = line.pipeline_id
 AND product.id = line.product_id
LEFT JOIN operations_product_package_profiles package_profile
  ON package_profile.organization_id = line.organization_id
 AND package_profile.id = line.package_profile_id`

const PRODUCT_CANDIDATE_SELECT = `SELECT
  candidate.id::text,
  candidate.global_id,
  candidate.organization_id::text,
  candidate.integration_account_id::text,
  candidate.pipeline_id::text,
  candidate.run_id::text,
  run.global_id AS run_global_id,
  candidate.provider,
  candidate.external_product_id,
  candidate.external_variant_id,
  candidate.external_inventory_item_id,
  candidate.sku_snapshot,
  candidate.barcode_snapshot,
  candidate.product_title_snapshot,
  candidate.variant_title_snapshot,
  candidate.vendor_snapshot,
  candidate.product_type_snapshot,
  candidate.normalized_options,
  candidate.provider_status_raw,
  candidate.normalized_status,
  candidate.unit_multiplier::text,
  candidate.currency_code,
  candidate.price_minor::text,
  candidate.compare_at_price_minor::text,
  candidate.taxable,
  candidate.requires_shipping,
  candidate.inventory_quantity::text,
  candidate.weight_grams,
  candidate.provider_created_at,
  candidate.provider_updated_at,
  candidate.observed_at,
  candidate.source_revision,
  candidate.source_hash,
  candidate.workflow_state,
  candidate.mapping_state,
  candidate.product_id::text,
  product.reference_code AS product_global_id,
  candidate.product_mapping_id::text,
  mapping.global_id AS product_mapping_global_id,
  candidate.blocking_codes,
  candidate.unsupported_reason_code,
  candidate.unsupported_reason_detail,
  candidate.row_version::text,
  candidate.expires_at
FROM operations_commerce_product_candidates candidate
JOIN operations_commerce_intake_runs run
  ON run.organization_id = candidate.organization_id
 AND run.integration_account_id = candidate.integration_account_id
 AND run.pipeline_id = candidate.pipeline_id
 AND run.id = candidate.run_id
LEFT JOIN crm_products product
  ON product.pipeline_id = candidate.pipeline_id
 AND product.id = candidate.product_id
LEFT JOIN operations_product_mappings mapping
  ON mapping.organization_id = candidate.organization_id
 AND mapping.integration_account_id = candidate.integration_account_id
 AND mapping.pipeline_id = candidate.pipeline_id
 AND mapping.id = candidate.product_mapping_id
 AND mapping.product_id = candidate.product_id`

async function lockCandidate(
  client: PoolClient,
  context: CandidateCommandContext,
): Promise<CandidateRow> {
  const result = await client.query<CandidateRow>(
    `${CANDIDATE_SELECT}
     WHERE candidate.organization_id = $1::uuid
       AND candidate.integration_account_id = $2::uuid
       AND candidate.global_id = $3
     FOR UPDATE OF candidate`,
    [
      context.runtime.organizationId,
      context.runtime.integrationAccountId,
      context.candidateGlobalId,
    ],
  )
  const candidate = result.rows[0]
  if (!candidate) {
    intakeError(
      'COMMERCE_INTAKE_CANDIDATE_NOT_FOUND',
      'The held order is no longer available',
      404,
    )
  }
  if (Number(candidate.row_version) !== context.candidateRowVersion) {
    intakeError(
      'COMMERCE_INTAKE_ROW_VERSION_CONFLICT',
      'This held order changed. Reload it before applying another decision',
    )
  }
  if (new Date(candidate.expires_at).getTime() <= Date.now()) {
    intakeError(
      'COMMERCE_INTAKE_CANDIDATE_EXPIRED',
      'This held order expired. Fetch it again before resolving it',
    )
  }
  if (candidate.workflow_state === 'promoted') {
    intakeError(
      'COMMERCE_INTAKE_ALREADY_PROMOTED',
      'This held order was already promoted',
    )
  }
  if (
    candidate.workflow_state === 'failed'
    || candidate.customer_resolution_state === 'unsupported'
  ) {
    intakeError(
      'COMMERCE_INTAKE_CANDIDATE_TERMINAL',
      'This held order is terminal. Refresh it to create a new candidate before applying another decision',
      422,
    )
  }
  return candidate
}

async function lockProductCandidate(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    candidateGlobalId: string
    candidateRowVersion: number
  },
) {
  const result = await client.query<ProductCandidateRow>(
    `${PRODUCT_CANDIDATE_SELECT}
     WHERE candidate.organization_id = $1::uuid
       AND candidate.integration_account_id = $2::uuid
       AND candidate.global_id = $3
     FOR UPDATE OF candidate`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.candidateGlobalId,
    ],
  )
  const candidate = result.rows[0]
  if (!candidate) {
    intakeError(
      'COMMERCE_INTAKE_PRODUCT_CANDIDATE_NOT_FOUND',
      'The catalog product candidate is no longer available',
      404,
    )
  }
  if (Number(candidate.row_version) !== input.candidateRowVersion) {
    intakeError(
      'COMMERCE_INTAKE_ROW_VERSION_CONFLICT',
      'This catalog product changed. Reload it before applying another decision',
    )
  }
  if (new Date(candidate.expires_at).getTime() <= Date.now()) {
    intakeError(
      'COMMERCE_INTAKE_PRODUCT_CANDIDATE_EXPIRED',
      'This catalog product expired. Fetch the catalog again before resolving it',
    )
  }
  if (
    candidate.workflow_state === 'failed'
    || candidate.workflow_state === 'expired'
    || candidate.workflow_state === 'promoted'
    || candidate.mapping_state === 'unsupported'
  ) {
    intakeError(
      'COMMERCE_INTAKE_PRODUCT_CANDIDATE_TERMINAL',
      'This catalog product already has a terminal disposition',
      422,
    )
  }
  return candidate
}

async function candidateLines(
  client: PoolClient,
  candidate: CandidateRow,
  forUpdate = false,
) {
  const result = await client.query<CandidateLineRow>(
    `${LINE_SELECT}
     WHERE line.organization_id = $1::uuid
       AND line.integration_account_id = $2::uuid
       AND line.order_candidate_id = $3::uuid
     ORDER BY line.created_at, line.id
     ${forUpdate ? 'FOR UPDATE OF line' : ''}`,
    [
      candidate.organization_id,
      candidate.integration_account_id,
      candidate.id,
    ],
  )
  return result.rows
}

function encryptedSnapshot(
  candidate: CandidateRow,
  accountGlobalId: string,
  kind: 'party' | 'ship_to',
) {
  const ciphertext = kind === 'party'
    ? candidate.party_snapshot_ciphertext
    : candidate.ship_to_snapshot_ciphertext
  const iv = kind === 'party'
    ? candidate.party_snapshot_iv
    : candidate.ship_to_snapshot_iv
  const tag = kind === 'party'
    ? candidate.party_snapshot_tag
    : candidate.ship_to_snapshot_tag
  if (!ciphertext || !iv || !tag) return null
  return decryptCommerceCandidateSnapshot(
    { ciphertext, iv, tag },
    candidate.organization_id,
    accountGlobalId,
    candidate.external_order_id,
    candidate.source_hash,
    kind,
  )
}

async function recordDecision(
  client: PoolClient,
  input: {
    candidate: Pick<
      CandidateRow | ProductCandidateRow,
      | 'organization_id'
      | 'integration_account_id'
      | 'pipeline_id'
      | 'run_global_id'
    >
    targetType: 'product_candidate' | 'order_candidate' | 'order_candidate_line'
    targetGlobalId: string
    targetSourceRevision: string
    targetSourceHash: string
    decisionType:
      | 'product_binding'
      | 'product_creation'
      | 'customer_binding'
      | 'customer_creation'
      | 'address_confirmation'
      | 'delivery_policy'
      | 'package_resolution'
      | 'refresh'
      | 'validation'
      | 'unsupported_acknowledgement'
      | 'promotion'
    outcome?: 'applied' | 'rejected' | 'failed' | 'replayed'
    resultingWorkflowState: string
    reasonCode: string
    snapshotHash?: string | null
    policyVersion?: string | null
    productId?: string | null
    customerId?: string | null
    productMappingId?: string | null
    packageProfileId?: string | null
    canonicalOrderId?: string | null
    canonicalOrderLineId?: string | null
    receipt: ReceiptRow
    idempotencyKey: string
    requestHash: string
    actorEmail: string
  },
) {
  await client.query(
    `INSERT INTO operations_commerce_resolution_decisions (
       organization_id, integration_account_id, pipeline_id,
       intake_run_global_id, target_type, target_global_id,
       target_source_revision, target_source_hash, decision_type, outcome,
       resulting_workflow_state, reason_code, snapshot_hash, policy_version,
       product_id, customer_id, product_mapping_id, package_profile_id,
       canonical_order_id, canonical_order_line_id, command_receipt_id,
       idempotency_key, request_hash, actor_email, correlation_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15::uuid, $16::uuid, $17::uuid, $18::uuid,
       $19::uuid, $20::uuid, $21::uuid, $22, $23, $24, $25::uuid
     )
     ON CONFLICT (
       organization_id, target_global_id, decision_type, idempotency_key
     ) DO NOTHING`,
    [
      input.candidate.organization_id,
      input.candidate.integration_account_id,
      input.candidate.pipeline_id,
      input.candidate.run_global_id,
      input.targetType,
      input.targetGlobalId,
      input.targetSourceRevision,
      input.targetSourceHash,
      input.decisionType,
      input.outcome || 'applied',
      input.resultingWorkflowState,
      input.reasonCode,
      input.snapshotHash || null,
      input.policyVersion || POLICY_VERSION,
      input.productId || null,
      input.customerId || null,
      input.productMappingId || null,
      input.packageProfileId || null,
      input.canonicalOrderId || null,
      input.canonicalOrderLineId || null,
      input.receipt.id,
      input.idempotencyKey,
      input.requestHash,
      input.actorEmail,
      input.receipt.correlation_id,
    ],
  )
}

function dynamicLineBlockingCodes(line: CandidateLineRow) {
  if (Number(line.unfulfilled_quantity) === 0) return []
  const codes = new Set<string>()
  if (line.mapping_state !== 'resolved' && line.mapping_state !== 'not_required') {
    codes.add('product_mapping_required')
  }
  if (line.price_resolution_state !== 'provider'
      && line.price_resolution_state !== 'manual') {
    codes.add('line_price_required')
  }
  if (line.requires_shipping && line.packaging_state !== 'resolved') {
    codes.add('packaging_required')
  }
  return [...codes].sort()
}

function dynamicCandidateBlockingCodes(
  candidate: CandidateRow,
  lines: CandidateLineRow[],
) {
  const operationalLines = lines.filter((line) => (
    Number(line.unfulfilled_quantity) > 0
  ))
  const hasShippableLines = operationalLines.some(
    (line) => line.requires_shipping,
  )
  const preserved = candidate.blocking_codes.filter((code) => [
    'order_cancellation_state_unknown',
    'order_fulfillment_state_unknown',
    'source_stale',
    'source_truncated',
  ].includes(code))
  const codes = new Set(preserved)
  if (candidate.normalized_order_status === 'cancelled') {
    codes.add('order_cancelled')
  }
  if (candidate.normalized_fulfillment_status === 'fulfilled') {
    codes.add('order_already_fulfilled')
  }
  if (
    candidate.normalized_fulfillment_status === 'partial'
    && (
      candidate.provider !== 'shopify'
      || !shopifyCandidateQuantitiesAreExact(lines)
    )
  ) {
    codes.add('order_partially_fulfilled')
  }
  if (candidate.customer_resolution_state !== 'resolved') {
    codes.add('customer_resolution_required')
  }
  if (candidate.requires_shipping && hasShippableLines) {
    if (candidate.ship_to_snapshot_state === 'protected') {
      codes.add('ship_to_confirmation_required')
    } else if (candidate.ship_to_snapshot_state !== 'confirmed') {
      codes.add(candidate.ship_to_snapshot_state === 'redacted'
        ? 'ship_to_redacted'
        : 'ship_to_unavailable')
    }
    if (candidate.delivery_resolution_state === 'unresolved') {
      codes.add('delivery_decision_required')
    }
  }
  if (!operationalLines.length) codes.add('line_items_empty')
  for (const line of operationalLines) {
    for (const code of dynamicLineBlockingCodes(line)) codes.add(code)
  }
  return [...codes].sort()
}

function shopifyCandidateQuantitiesAreExact(lines: CandidateLineRow[]) {
  return lines.length > 0 && lines.every((line) => {
    const ordered = Number(line.ordered_quantity)
    const current = Number(line.current_quantity)
    const cancelled = Number(line.cancelled_quantity)
    const fulfilled = Number(line.fulfilled_quantity)
    const unfulfilled = Number(line.unfulfilled_quantity)
    return (
      [ordered, current, cancelled, fulfilled, unfulfilled].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
      && ordered > 0
      && current <= ordered
      && cancelled <= ordered
      && current + cancelled === ordered
      && fulfilled + unfulfilled === current
    )
  })
}

function canonicalMerchandiseTotalMinor(
  candidate: CandidateRow,
  operationalLines: CandidateLineRow[],
) {
  let total = BigInt(0)
  for (const line of operationalLines) {
    if (
      !/^[1-9][0-9]*$/.test(line.unfulfilled_quantity)
      || line.resolved_unit_price_minor === null
      || !/^[0-9]+$/.test(line.resolved_unit_price_minor)
      || line.resolved_currency_code !== candidate.currency_code
    ) {
      intakeError(
        'COMMERCE_INTAKE_MONEY_RECONCILIATION_REQUIRED',
        'Resolve every remaining line quantity, currency, and unit price before promotion',
        422,
      )
    }
    total += BigInt(line.unfulfilled_quantity)
      * BigInt(line.resolved_unit_price_minor)
  }
  if (!operationalLines.length) {
    intakeError(
      'COMMERCE_INTAKE_MONEY_RECONCILIATION_REQUIRED',
      'No remaining line demand is available for monetary reconciliation',
      422,
    )
  }
  return total.toString()
}

function visibleCandidateBlockingCodes(
  candidate: CandidateRow,
  lines: CandidateLineRow[],
) {
  if (['failed', 'promoted', 'expired'].includes(candidate.workflow_state)) {
    return []
  }
  const codes = new Set(candidate.blocking_codes)
  if (!lines.some((line) => line.requires_shipping)) {
    for (const code of SHIPPING_ONLY_BLOCKING_CODES) codes.delete(code)
  }
  return [...codes].sort()
}

async function refreshRunCounts(
  client: PoolClient,
  candidate: Pick<
    CandidateRow | ProductCandidateRow,
    'run_id'
  >,
  actorEmail: string,
) {
  await client.query(
    `WITH candidate_states AS (
       SELECT workflow_state
       FROM operations_commerce_product_candidates
       WHERE run_id = $1::uuid
       UNION ALL
       SELECT workflow_state
       FROM operations_commerce_order_candidates
       WHERE run_id = $1::uuid
     ),
     counts AS (
       SELECT
         count(*)::integer AS total_count,
         count(*) FILTER (
           WHERE workflow_state IN ('held', 'resolving')
         )::integer AS active_count,
         count(*) FILTER (WHERE workflow_state = 'ready')::integer
           AS ready_count,
         count(*) FILTER (WHERE workflow_state = 'promoted')::integer
           AS promoted_count,
         count(*) FILTER (WHERE workflow_state = 'failed')::integer
           AS failed_count
       FROM candidate_states
     ),
     canonical_counts AS (
       SELECT
         (
           SELECT count(*)::integer
           FROM operations_commerce_order_candidates
           WHERE run_id = $1::uuid
             AND workflow_state = 'promoted'
         ) AS canonical_orders_created,
         (
           SELECT count(DISTINCT product_candidate.id)::integer
           FROM operations_commerce_product_candidates product_candidate
           JOIN operations_commerce_resolution_decisions decision
             ON decision.organization_id
                  = product_candidate.organization_id
            AND decision.integration_account_id
                  = product_candidate.integration_account_id
            AND decision.pipeline_id = product_candidate.pipeline_id
            AND decision.target_type = 'product_candidate'
            AND decision.target_global_id = product_candidate.global_id
            AND decision.target_source_revision
                  = product_candidate.source_revision
            AND decision.target_source_hash = product_candidate.source_hash
            AND decision.decision_type = 'product_creation'
            AND decision.outcome = 'applied'
           WHERE product_candidate.run_id = $1::uuid
         ) AS canonical_products_created
     ),
     next_state AS (
       SELECT CASE
         WHEN promoted_count = total_count AND total_count > 0
           THEN 'promoted'
         WHEN promoted_count + failed_count = total_count
              AND failed_count > 0
           THEN 'failed'
         WHEN active_count > 0
           THEN 'resolving'
         WHEN ready_count > 0
           THEN 'ready'
         ELSE 'resolving'
       END AS workflow_state
       FROM counts
     )
     UPDATE operations_commerce_intake_runs run
     SET workflow_state = next_state.workflow_state,
         records_ready = counts.ready_count,
         records_promoted = counts.promoted_count,
         records_failed = counts.failed_count,
         canonical_orders_created =
           canonical_counts.canonical_orders_created,
         canonical_products_created =
           canonical_counts.canonical_products_created,
         last_error_code = CASE
           WHEN next_state.workflow_state = 'failed'
             THEN 'commerce_candidates_failed'
           ELSE NULL
         END,
         completed_at = CASE
           WHEN next_state.workflow_state IN ('promoted', 'failed') THEN now()
           ELSE run.completed_at
         END,
         row_version = run.row_version + 1,
         updated_by = $2,
         updated_at = now()
     FROM counts, canonical_counts, next_state
     WHERE run.id = $1::uuid`,
    [candidate.run_id, actorEmail],
  )
}

async function advanceCandidate(
  client: PoolClient,
  candidate: CandidateRow,
  actorEmail: string,
  target: 'resolving' | 'ready',
) {
  const lines = await candidateLines(client, candidate, true)
  const lineBlockers = new Map(
    lines.map((line) => [line.id, dynamicLineBlockingCodes(line)]),
  )
  for (const line of lines) {
    const codes = lineBlockers.get(line.id) || []
    const hasOperationalQuantity = Number(line.unfulfilled_quantity) > 0
    const lineState = (
      hasOperationalQuantity
      && target === 'ready'
      && codes.length === 0
    )
      ? 'ready'
      : 'resolving'
    await client.query(
      `UPDATE operations_commerce_order_candidate_lines
       SET blocking_codes = $2::text[],
           workflow_state = $3,
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE id = $1::uuid`,
      [line.id, codes, lineState, actorEmail],
    )
    line.blocking_codes = codes
    line.workflow_state = lineState
  }
  const codes = dynamicCandidateBlockingCodes(candidate, lines)
  const candidateState = target === 'ready' && codes.length === 0
    ? 'ready'
    : 'resolving'
  const updated = await client.query<{ row_version: string }>(
    `UPDATE operations_commerce_order_candidates
     SET blocking_codes = $2::text[],
         workflow_state = $3,
         row_version = row_version + 1,
         updated_by = $4,
         updated_at = now()
     WHERE id = $1::uuid
     RETURNING row_version::text`,
    [candidate.id, codes, candidateState, actorEmail],
  )
  candidate.blocking_codes = codes
  candidate.workflow_state = candidateState
  candidate.row_version = updated.rows[0].row_version
  await refreshRunCounts(
    client,
    candidate,
    actorEmail,
  )
  return { candidate, lines, blockers: codes.map(blocker) }
}

function commandResult(
  candidate: CandidateRow,
  action: string,
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    candidateGlobalId: candidate.global_id,
    workflowState: candidate.workflow_state,
    rowVersion: Number(candidate.row_version),
    providerWrites: 0,
    syncCursorAdvanced: false,
    ...extra,
  }
}

function requiredOrderMoney(
  order: CommerceNormalizedOrder,
  field: CommerceDataField<CommerceMoneySet>,
  label: string,
) {
  const value = primaryMoney(field)
  if (!value || value.currency !== order.currency) {
    intakeError(
      'COMMERCE_NORMALIZATION_MONEY_INCOMPLETE',
      `${order.orderNumber} has no exact ${label} in ${order.currency}`,
      422,
    )
  }
  return value.amountMinor
}

function optionalMoney(field: CommerceDataField<CommerceMoneySet>) {
  return primaryMoney(field)
}

function providerProductStatus(product: {
  active: boolean | null
  lifecycleState: string | null
}) {
  const raw = providerStatus(product.lifecycleState)
  if (product.active === true) return { raw, normalized: 'active' }
  if (product.active === false) {
    const value = raw.toLowerCase()
    if (value.includes('draft')) return { raw, normalized: 'draft' }
    if (value.includes('archiv')) return { raw, normalized: 'archived' }
    return { raw, normalized: 'unavailable' }
  }
  return { raw, normalized: 'unknown' }
}

function exactMappingIdentity(line: CommerceNormalizedOrderLine) {
  const variant = availableValue(line.variantIdentity)
  return variant?.value || null
}

function lineQuantityState(
  order: CommerceNormalizedOrder,
  line: CommerceNormalizedOrderLine,
) {
  const ordered = line.orderedQuantity
  const exact = exactNormalizedLineQuantityState(line)
  if (exact) return exact
  if (order.canonicalStates.lifecycle === 'cancelled') {
    return {
      current: 0,
      cancelled: ordered,
      fulfilled: 0,
      unfulfilled: 0,
    }
  }
  if (order.canonicalStates.fulfillment === 'fulfilled') {
    return {
      current: ordered,
      cancelled: 0,
      fulfilled: ordered,
      unfulfilled: 0,
    }
  }
  return {
    current: ordered,
    cancelled: 0,
    fulfilled: 0,
    unfulfilled: ordered,
  }
}

export async function readCommerceIntakeRefreshTargetFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
  candidateGlobalId: string
}) {
  return withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    })
    const result = await client.query<{
      external_order_id: string
      source_hash: string
      provider: 'shopify' | 'faire'
    }>(
      `SELECT candidate.external_order_id, candidate.source_hash,
              candidate.provider
       FROM operations_commerce_order_candidates candidate
       WHERE candidate.organization_id = $1::uuid
         AND candidate.integration_account_id = $2::uuid
         AND candidate.global_id = $3
         AND candidate.workflow_state <> 'promoted'
         AND candidate.expires_at > now()
       LIMIT 1`,
      [account.organization_id, account.id, input.candidateGlobalId],
    )
    if (!result.rows[0]) {
      intakeError(
        'COMMERCE_INTAKE_REFRESH_TARGET_NOT_FOUND',
        'The held order cannot be refreshed',
        404,
      )
    }
    return result.rows[0]
  })
}

export async function readCommerceIntakeRejectionTargetFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
  rejectionGlobalId: string
}) {
  return withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    })
    const result = await client.query<{
      external_id: string
      source_hash: string
      provider: 'shopify' | 'faire'
      resource_type: 'order' | 'product'
      row_version: string
    }>(
      `SELECT external_id, source_hash, provider, resource_type,
              row_version::text
       FROM operations_commerce_intake_rejections
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND global_id = $3
         AND disposition = 'open'
         AND expires_at > now()
       LIMIT 1`,
      [
        account.organization_id,
        account.id,
        input.rejectionGlobalId,
      ],
    )
    if (!result.rows[0]) {
      intakeError(
        'COMMERCE_INTAKE_REJECTION_NOT_OPEN',
        'This rejected record is no longer open. Reload the workflow.',
        409,
      )
    }
    return {
      ...result.rows[0],
      row_version: Number(result.rows[0].row_version),
    }
  })
}

export async function readCommerceIntakeContinuationFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
  continuationRunGlobalId: string
}) {
  const result = await withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    })
    const result = await client.query<ContinuationRow>(
      `SELECT continuation.id::text, run.global_id AS run_global_id,
              continuation.session_id::text, continuation.batch_number,
              continuation.provider, continuation.resource,
              continuation.credential_version,
              continuation.window_start, continuation.window_end,
              continuation.query_hash, continuation.cursor_state,
              continuation.cursor_ciphertext, continuation.cursor_iv,
              continuation.cursor_tag, continuation.cursor_hash,
              continuation.expires_at
       FROM operations_commerce_intake_continuations continuation
       JOIN operations_commerce_intake_runs run
         ON run.organization_id = continuation.organization_id
        AND run.integration_account_id = continuation.integration_account_id
        AND run.pipeline_id = continuation.pipeline_id
        AND run.id = continuation.run_id
       WHERE continuation.organization_id = $1::uuid
         AND continuation.integration_account_id = $2::uuid
         AND run.global_id = $3
       LIMIT 1
       FOR UPDATE OF continuation`,
      [
        account.organization_id,
        account.id,
        input.continuationRunGlobalId,
      ],
    )
    const row = result.rows[0]
    if (!row) {
      intakeError(
        'COMMERCE_INTAKE_CONTINUATION_NOT_FOUND',
        'This intake batch cannot be continued. Start a new operational fetch.',
        404,
      )
    }
    if (
      row.cursor_state === 'available'
      && (
        new Date(row.expires_at).getTime() <= Date.now()
        || row.credential_version !== account.credential_version
      )
    ) {
      await client.query(
        `UPDATE operations_commerce_intake_continuations
         SET cursor_state = 'expired',
             cursor_ciphertext = NULL,
             cursor_iv = NULL,
             cursor_tag = NULL,
             cursor_hash = NULL,
             encryption_version = NULL,
             row_version = row_version + 1,
             updated_by = 'system:commerce-intake',
             updated_at = now()
         WHERE id = $1::uuid`,
        [row.id],
      )
      return {
        error: {
          code: 'COMMERCE_INTAKE_CONTINUATION_EXPIRED',
          message:
            'This intake batch expired. Start a new operational fetch.',
        },
      } as const
    }
    if (row.cursor_state === 'exhausted') {
      intakeError(
        'COMMERCE_INTAKE_CONTINUATION_COMPLETE',
        'This operational intake session is complete. Start a new fetch to check for newer orders.',
      )
    }
    if (row.cursor_state === 'invalid' || row.cursor_state === 'expired') {
      intakeError(
        'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED',
        'This intake batch cannot be resumed. Start a new operational fetch.',
      )
    }
    if (row.cursor_state !== 'available') {
      intakeError(
        'COMMERCE_INTAKE_CONTINUATION_CONSUMED',
        'This intake batch was already continued. Refresh the workflow to use the current batch.',
      )
    }
    if (
      !row.cursor_ciphertext
      || !row.cursor_iv
      || !row.cursor_tag
      || !row.cursor_hash
    ) {
      intakeError(
        'COMMERCE_INTAKE_CONTINUATION_INVALID',
        'This intake batch cannot be resumed. Start a new operational fetch.',
        500,
      )
    }
    const payload = decryptCommerceIntakeContinuation(
      {
        ciphertext: row.cursor_ciphertext,
        iv: row.cursor_iv,
        tag: row.cursor_tag,
      },
      account.organization_id,
      account.global_id,
      row.provider,
      row.session_id,
      row.batch_number,
      row.query_hash,
    )
    return {
      page: {
        mode: 'operational' as const,
        resource: row.resource,
        sessionId: row.session_id,
        batchNumber: row.batch_number + 1,
        previousRunGlobalId: row.run_global_id,
        windowStart: iso(row.window_start),
        windowEnd: new Date(row.window_end).toISOString(),
        queryHash: row.query_hash,
        orderCursor: payload.orderCursor,
        cursorHash: row.cursor_hash,
      },
    } as const
  })
  if (result.error) {
    intakeError(result.error.code, result.error.message)
  }
  return result.page
}

export async function markCommerceIntakeContinuationInvalidInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  continuationRunGlobalId: string
  actorEmail: string
}) {
  return withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    })
    await client.query(
      `UPDATE operations_commerce_intake_continuations continuation
       SET cursor_state = 'invalid',
           cursor_ciphertext = NULL,
           cursor_iv = NULL,
           cursor_tag = NULL,
           cursor_hash = NULL,
           encryption_version = NULL,
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       FROM operations_commerce_intake_runs run
       WHERE continuation.organization_id = $1::uuid
         AND continuation.integration_account_id = $2::uuid
         AND continuation.cursor_state = 'available'
         AND run.organization_id = continuation.organization_id
         AND run.integration_account_id = continuation.integration_account_id
         AND run.pipeline_id = continuation.pipeline_id
         AND run.id = continuation.run_id
         AND run.global_id = $3`,
      [
        account.organization_id,
        account.id,
        input.continuationRunGlobalId,
        input.actorEmail,
      ],
    )
  })
}

export async function readCommerceIntakeStageReplayFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
  idempotencyKey: string
  action: CommerceIntakeStageAction
  target: {
    kind: 'none' | 'candidate' | 'rejection' | 'continuation'
    globalId: string | null
  }
}) {
  return withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    })
    const result = await client.query<{
      global_id: string
      workflow_state: string
      records_staged: number
      staged_action: string | null
      stage_result: Record<string, unknown> | null
      intent_action: CommerceIntakeReadIntentAction
      target_kind: 'none' | 'candidate' | 'rejection' | 'continuation'
      target_global_id: string | null
    }>(
      `SELECT
         run.global_id,
         run.workflow_state,
         run.records_staged,
         audit.payload->>'action' AS staged_action,
         audit.payload->'stageResult' AS stage_result,
         intent.intake_action AS intent_action,
         intent.target_kind,
         intent.target_global_id
       FROM operations_commerce_intake_runs run
       JOIN operations_commerce_intake_read_intents intent
         ON intent.organization_id = run.organization_id
        AND intent.integration_account_id = run.integration_account_id
        AND intent.provider_attempt_id = run.provider_attempt_id
        AND intent.staged_run_id = run.id
        AND intent.intent_state = 'staged'
       LEFT JOIN LATERAL (
         SELECT event.payload
         FROM audit_events event
         WHERE event.organization_id = run.organization_id
           AND event.event_type = 'commerce.intake.staged'
           AND event.aggregate_type = 'operations.commerce_intake_run'
           AND event.aggregate_id = run.global_id
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
       ) audit ON true
       WHERE run.organization_id = $1::uuid
         AND run.integration_account_id = $2::uuid
         AND run.resource = $3
         AND run.idempotency_key = $4
         AND run.provider_attempt_id IS NOT NULL
       LIMIT 1`,
      [
        account.organization_id,
        account.id,
        ['fetch-products', 'fetch-next-products'].includes(input.action)
          ? 'products'
          : 'products_and_orders',
        input.idempotencyKey,
      ],
    )
    const row = result.rows[0]
    if (!row) return null
    if (
      row.intent_action !== input.action
      || (row.staged_action && row.staged_action !== input.action)
      || row.target_kind !== input.target.kind
      || row.target_global_id !== input.target.globalId
    ) {
      intakeError(
        'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
        'This idempotency key already completed a different intake action or target',
      )
    }
    return {
      ...(row.stage_result || {}),
      action: row.staged_action || input.action,
      replayed: true,
      runGlobalId: row.global_id,
      workflowState:
        row.stage_result?.workflowState || row.workflow_state,
      recordsStaged:
        row.stage_result?.recordsStaged ?? row.records_staged,
      providerWrites: 0,
      syncCursorAdvanced: false,
    }
  })
}

export async function prepareCommerceIntakeReadIntentInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  action: CommerceIntakeReadIntentAction
  resource: 'orders' | 'products'
  target: CommerceIntakeReadIntentTarget
  continuationRunGlobalId: string | null
  pageSize: number
}) {
  const prepared = await withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.runtime.organizationId,
      accountGlobalId: input.runtime.globalId,
      forUpdate: true,
    })
    if (!['shadow', 'active'].includes(account.activation_state)) {
      intakeError(
        'COMMERCE_INTAKE_ACTIVATION_REQUIRED',
        'Open Operations and set Activation to Shadow or Active before reading commerce data',
      )
    }
    const continuationAction = (
      input.action === 'fetch-next'
      || input.action === 'fetch-next-products'
    )
    if (
      (input.resource === 'products')
        !== ['fetch-products', 'fetch-next-products'].includes(input.action)
      || Boolean(input.continuationRunGlobalId) !== continuationAction
      || (
        !continuationAction
        && (input.target.kind === 'none')
          !== ['fetch', 'fetch-products'].includes(input.action)
      )
      || (input.target.kind === 'candidate') !== (input.action === 'refresh')
      || (
        input.target.kind === 'rejection'
        && input.action !== 'retry-rejection'
      )
    ) {
      intakeError(
        'COMMERCE_INTAKE_INTENT_INVALID',
        'The provider-read intent does not match the requested workflow action',
        422,
      )
    }
    let continuation: (ContinuationRow & {
      order_cursor: string
    }) | null = null
    if (continuationAction) {
      const continuationResult = await client.query<ContinuationRow>(
        `SELECT continuation.id::text, run.global_id AS run_global_id,
                continuation.session_id::text, continuation.batch_number,
                continuation.provider, continuation.resource,
                continuation.credential_version,
                continuation.window_start, continuation.window_end,
                continuation.query_hash, continuation.cursor_state,
                continuation.cursor_ciphertext, continuation.cursor_iv,
                continuation.cursor_tag, continuation.cursor_hash,
                continuation.row_version::text,
                continuation.expires_at
         FROM operations_commerce_intake_continuations continuation
         JOIN operations_commerce_intake_runs run
           ON run.organization_id = continuation.organization_id
          AND run.integration_account_id = continuation.integration_account_id
          AND run.pipeline_id = continuation.pipeline_id
          AND run.id = continuation.run_id
         WHERE continuation.organization_id = $1::uuid
           AND continuation.integration_account_id = $2::uuid
           AND run.global_id = $3
         LIMIT 1
         FOR UPDATE OF continuation`,
        [
          account.organization_id,
          account.id,
          input.continuationRunGlobalId,
        ],
      )
      const row = continuationResult.rows[0]
      if (!row) {
        intakeError(
          'COMMERCE_INTAKE_CONTINUATION_NOT_FOUND',
          'This intake batch cannot be continued. Start a new operational fetch.',
          404,
        )
      }
      if (
        row.cursor_state === 'available'
        && (
          new Date(row.expires_at).getTime() <= Date.now()
          || row.credential_version !== account.credential_version
        )
      ) {
        await client.query(
          `UPDATE operations_commerce_intake_continuations
           SET cursor_state = 'expired',
               cursor_ciphertext = NULL,
               cursor_iv = NULL,
               cursor_tag = NULL,
               cursor_hash = NULL,
               encryption_version = NULL,
               row_version = row_version + 1,
               updated_by = $2,
               updated_at = now()
           WHERE id = $1::uuid`,
          [row.id, input.actorEmail],
        )
        return {
          restart: {
            code: 'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED',
            message:
              'This intake batch expired. Use Restart session to begin a new bounded read.',
          },
        } as const
      }
      if (row.cursor_state !== 'available') {
        intakeError(
          row.cursor_state === 'consumed'
            ? 'COMMERCE_INTAKE_CONTINUATION_CONSUMED'
            : 'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED',
          row.cursor_state === 'consumed'
            ? 'This intake batch was already continued. Reload the workflow to use the current batch.'
            : 'This intake batch cannot resume. Use Restart session to begin a new bounded read.',
        )
      }
      if (
        row.provider !== account.provider
        || row.resource !== input.resource
        || !row.cursor_ciphertext
        || !row.cursor_iv
        || !row.cursor_tag
        || !row.cursor_hash
      ) {
        intakeError(
          'COMMERCE_INTAKE_CONTINUATION_INVALID',
          'This intake batch does not match the selected provider workflow. Use Restart session.',
          409,
        )
      }
      const cursorPayload = decryptCommerceIntakeContinuation(
        {
          ciphertext: row.cursor_ciphertext,
          iv: row.cursor_iv,
          tag: row.cursor_tag,
        },
        account.organization_id,
        account.global_id,
        row.provider,
        row.session_id,
        row.batch_number,
        row.query_hash,
      )
      const cursorHash = createHash('sha256')
        .update(JSON.stringify(cursorPayload))
        .digest('hex')
      if (cursorHash !== row.cursor_hash) {
        intakeError(
          'COMMERCE_INTAKE_CONTINUATION_INVALID',
          'This saved provider cursor failed its identity check. Use Restart session.',
          409,
        )
      }
      continuation = {
        ...row,
        order_cursor: cursorPayload.orderCursor,
      }
      const competingIntent = await client.query(
        `SELECT id
         FROM operations_commerce_intake_read_intents
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND continuation_id = $3::uuid
           AND idempotency_key <> $4
           AND intent_state IN ('prepared', 'reading', 'captured')
         LIMIT 1
         FOR UPDATE`,
        [
          account.organization_id,
          account.id,
          row.id,
          input.idempotencyKey,
        ],
      )
      if (competingIntent.rows[0]) {
        intakeError(
          'COMMERCE_INTAKE_READ_IN_PROGRESS',
          'This saved batch already has a reserved provider read. Retry that action or use Restart session after it becomes recoverable.',
          409,
        )
      }
    }
    const target = continuation
      ? {
          kind: 'continuation' as const,
          globalId: continuation.run_global_id,
          sourceHash: null,
          externalIdHash: null,
          continuationId: continuation.id,
          continuationCursorHash: continuation.cursor_hash,
          continuationRowVersion: Number(continuation.row_version),
        }
      : input.target.kind === 'none'
        ? {
            kind: 'none' as const,
            globalId: null,
            sourceHash: null,
            externalIdHash: null,
            continuationId: null,
            continuationCursorHash: null,
            continuationRowVersion: null,
          }
        : {
            kind: input.target.kind,
            globalId: input.target.globalId,
            sourceHash: input.target.sourceHash,
            externalIdHash: commandHash(input.target.externalId),
            continuationId: null,
            continuationCursorHash: null,
            continuationRowVersion: null,
          }
    const requestHash = commandHash({
      policyVersion: POLICY_VERSION,
      accountGlobalId: input.runtime.globalId,
      credentialVersion: account.credential_version,
      action: input.action,
      resource: input.resource,
      target,
      pageSize: input.pageSize,
      readOnly: true,
      providerWrites: 0,
      syncCursorAdvance: false,
    })
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-intake-read-intent:${account.organization_id}:${account.id}:${input.action}:${input.idempotencyKey}`,
    )
    const existing = await client.query<{
      id: string
      request_hash: string
      intent_state:
        | 'prepared'
        | 'reading'
        | 'captured'
        | 'staged'
        | 'uncertain'
        | 'expired'
      session_id: string
      batch_number: number
      window_start: Date | null
      window_end: Date
      query_hash: string
      provider_attempt_id: string | null
      expires_at: Date
    }>(
      `SELECT id::text, request_hash, intent_state, session_id::text,
              batch_number, window_start, window_end, query_hash,
              provider_attempt_id::text, expires_at
       FROM operations_commerce_intake_read_intents
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND intake_action = $3
         AND idempotency_key = $4
       FOR UPDATE`,
      [
        account.organization_id,
        account.id,
        input.action,
        input.idempotencyKey,
      ],
    )
    const prior = existing.rows[0]
    if (prior) {
      if (prior.request_hash !== requestHash) {
        intakeError(
          'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
          'This retry key belongs to a different provider-read target. Reload the workflow and retry the intended action.',
        )
      }
      if (prior.intent_state === 'staged') {
        intakeError(
          'COMMERCE_INTAKE_INTENT_ALREADY_STAGED',
          'This provider read already staged successfully. Reload the workflow to see its result.',
        )
      }
      if (prior.intent_state === 'uncertain') {
        intakeError(
          'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
          'The prior provider read ended without a durable response. Retry with the newly enabled restart action.',
          409,
        )
      }
      if (prior.intent_state === 'expired') {
        return {
          restart: {
            code: 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
            message:
              'This saved provider read expired. Retry the action to start a newly reserved bounded read.',
          },
        } as const
      }
      if (prior.expires_at.getTime() <= Date.now()) {
        if (
          prior.intent_state === 'reading'
          && prior.provider_attempt_id
        ) {
          await client.query(
            `UPDATE operations_commerce_provider_attempts
             SET state = 'unknown',
                 error_code = 'COMMERCE_INTAKE_READ_INTENT_EXPIRED',
                 lease_token = NULL,
                 lease_expires_at = NULL,
                 completed_at = now()
             WHERE organization_id = $1::uuid
               AND integration_account_id = $2::uuid
               AND id = $3::uuid
               AND state = 'prepared'`,
            [
              account.organization_id,
              account.id,
              prior.provider_attempt_id,
            ],
          )
        }
        await client.query(
          `UPDATE operations_commerce_intake_read_intents
           SET intent_state = CASE
                 WHEN intent_state = 'reading' THEN 'uncertain'
                 ELSE 'expired'
               END,
               lease_token = NULL,
               lease_expires_at = NULL,
               last_error_code = 'COMMERCE_INTAKE_READ_INTENT_EXPIRED',
               row_version = row_version + 1,
               updated_by = $2,
               updated_at = now()
           WHERE id = $1::uuid
             AND intent_state IN ('prepared', 'reading', 'captured')`,
          [prior.id, input.actorEmail],
        )
        if (continuation) {
          await client.query(
            `UPDATE operations_commerce_intake_continuations
             SET cursor_state = 'expired',
                 cursor_ciphertext = NULL,
                 cursor_iv = NULL,
                 cursor_tag = NULL,
                 cursor_hash = NULL,
                 encryption_version = NULL,
                 row_version = row_version + 1,
                 updated_by = $2,
                 updated_at = now()
             WHERE id = $1::uuid
               AND cursor_state = 'available'
               AND row_version = $3::bigint`,
            [
              continuation.id,
              input.actorEmail,
              continuation.row_version,
            ],
          )
        }
        return {
          restart: {
            code: 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
            message: continuation
              ? 'This saved provider read expired. Use Restart session to begin a new bounded read.'
              : 'This saved provider read expired. Retry the action to start a newly reserved bounded read.',
          },
        } as const
      }
      return {
        id: prior.id,
        mode: 'operational' as const,
        resource: input.resource,
        sessionId: prior.session_id,
        batchNumber: prior.batch_number,
        previousRunGlobalId: continuation?.run_global_id || null,
        windowStart: iso(prior.window_start),
        windowEnd: prior.window_end.toISOString(),
        queryHash: prior.query_hash,
        orderCursor: continuation?.order_cursor || null,
        cursorHash: continuation?.cursor_hash || null,
      }
    }
    const now = new Date()
    const sessionId = continuation?.session_id || randomUUID()
    const batchNumber = continuation
      ? continuation.batch_number + 1
      : 1
    const windowStart = continuation
      ? iso(continuation.window_start)
      : null
    const windowEnd = continuation
      ? new Date(continuation.window_end).toISOString()
      : now.toISOString()
    const queryHash = continuation?.query_hash || commandHash({
        policyVersion: POLICY_VERSION,
        provider: account.provider,
        resource: input.resource,
        mode: 'operational',
        windowStart,
        windowEnd,
        pageSize: input.pageSize,
        productsFetched: input.resource === 'products',
        oneRootPage: true,
      })
    const expiresAt = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1_000,
    ).toISOString()
    const created = await client.query<{ id: string }>(
      `INSERT INTO operations_commerce_intake_read_intents (
         organization_id, integration_account_id, pipeline_id, provider,
         resource, intake_action, idempotency_key, request_hash,
         credential_version, target_kind, target_global_id,
         target_source_hash, target_external_id_hash, continuation_id,
         continuation_cursor_hash, continuation_row_version, session_id,
         batch_number, window_start, window_end, query_hash, created_by,
         updated_by, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14::uuid, $15, $16, $17::uuid, $18,
         $19::timestamptz, $20::timestamptz, $21, $22, $22,
         $23::timestamptz
       )
       RETURNING id::text`,
      [
        account.organization_id,
        account.id,
        account.pipeline_id,
        account.provider,
        input.resource,
        input.action,
        input.idempotencyKey,
        requestHash,
        account.credential_version,
        target.kind,
        target.globalId,
        target.sourceHash,
        target.externalIdHash,
        target.continuationId,
        target.continuationCursorHash,
        target.continuationRowVersion,
        sessionId,
        batchNumber,
        windowStart,
        windowEnd,
        queryHash,
        input.actorEmail,
        expiresAt,
      ],
    )
    return {
      id: created.rows[0].id,
      mode: 'operational' as const,
      resource: input.resource,
      sessionId,
      batchNumber,
      previousRunGlobalId: continuation?.run_global_id || null,
      windowStart,
      windowEnd,
      queryHash,
      orderCursor: continuation?.order_cursor || null,
      cursorHash: continuation?.cursor_hash || null,
    }
  })
  if ('restart' in prepared && prepared.restart) {
    intakeError(prepared.restart.code, prepared.restart.message, 409)
  }
  return prepared
}

type CommerceReadIntentPersistenceRow = {
  id: string
  provider: 'shopify' | 'faire'
  resource: 'orders' | 'products'
  intake_action: CommerceIntakeReadIntentAction
  idempotency_key: string
  request_hash: string
  credential_version: number
  intent_state:
    | 'prepared'
    | 'reading'
    | 'captured'
    | 'staged'
    | 'uncertain'
    | 'expired'
  provider_attempt_id: string | null
  lease_token: string | null
  lease_expires_at: Date | null
  response_ciphertext: Buffer | null
  response_iv: Buffer | null
  response_tag: Buffer | null
  response_hash: string | null
  response_bytes: number | null
  continuation_id: string | null
  continuation_row_version: string | number | null
  expires_at: Date
}

async function invalidateCommerceReadIntentContinuation(
  client: PoolClient,
  input: {
    intent: CommerceReadIntentPersistenceRow
    organizationId: string
    integrationAccountId: string
    actorEmail: string
  },
) {
  if (!input.intent.continuation_id) return
  await client.query(
    `UPDATE operations_commerce_intake_continuations
     SET cursor_state = 'invalid',
         cursor_ciphertext = NULL,
         cursor_iv = NULL,
         cursor_tag = NULL,
         cursor_hash = NULL,
         encryption_version = NULL,
         row_version = row_version + 1,
         updated_by = $4,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND id = $3::uuid
       AND cursor_state = 'available'
       AND row_version = $5::bigint`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.intent.continuation_id,
      input.actorEmail,
      input.intent.continuation_row_version,
    ],
  )
}

function decryptCapturedCommerceRead(
  intent: CommerceReadIntentPersistenceRow,
  account: IntakeAccountRow,
): CommerceIntakeReadResult {
  if (
    !intent.provider_attempt_id
    || !intent.response_ciphertext
    || !intent.response_iv
    || !intent.response_tag
    || !intent.response_hash
    || !intent.response_bytes
  ) {
    intakeError(
      'COMMERCE_INTAKE_READ_EVIDENCE_INVALID',
      'The captured provider response is incomplete. Reload and use the restart workflow.',
      500,
    )
  }
  const decrypted = decryptCommerceIntakeReadResult(
    {
      ciphertext: intent.response_ciphertext,
      iv: intent.response_iv,
      tag: intent.response_tag,
    },
    account.organization_id,
    account.global_id,
    account.provider,
    intent.id,
    intent.provider_attempt_id,
    intent.request_hash,
    intent.response_hash,
  )
  return decrypted as unknown as CommerceIntakeReadResult
}

export async function reserveCommerceIntakeProviderReadInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  readIntentId: string
  adapterVersion: string
  redactedRequest: Record<string, unknown>
}) {
  const reservation = await withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.runtime.organizationId,
      accountGlobalId: input.runtime.globalId,
      forUpdate: true,
    })
    const intentResult = await client.query<CommerceReadIntentPersistenceRow>(
      `SELECT id::text, provider, resource, intake_action, idempotency_key,
              request_hash, credential_version, intent_state,
              provider_attempt_id::text, lease_token::text, lease_expires_at,
              response_ciphertext, response_iv, response_tag, response_hash,
              response_bytes, continuation_id::text,
              continuation_row_version::text, expires_at
       FROM operations_commerce_intake_read_intents
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND idempotency_key = $4
       LIMIT 1
       FOR UPDATE`,
      [
        account.organization_id,
        account.id,
        input.readIntentId,
        input.idempotencyKey,
      ],
    )
    const intent = intentResult.rows[0]
    if (
      !intent
      || intent.provider !== account.provider
      || intent.credential_version !== account.credential_version
    ) {
      intakeError(
        'COMMERCE_INTAKE_INTENT_INVALID',
        'The provider-read reservation no longer matches this connection. Reload the workflow.',
        409,
      )
    }
    if (intent.intent_state === 'captured') {
      return {
        kind: 'captured' as const,
        readIntentId: intent.id,
        providerAttemptId: intent.provider_attempt_id as string,
        responseHash: intent.response_hash as string,
        result: decryptCapturedCommerceRead(intent, account),
      }
    }
    if (intent.intent_state === 'staged') {
      intakeError(
        'COMMERCE_INTAKE_INTENT_ALREADY_STAGED',
        'This provider read already staged successfully. Reload the workflow.',
        409,
      )
    }
    if (
      intent.intent_state === 'uncertain'
      || intent.intent_state === 'expired'
    ) {
      return {
        kind: 'restart' as const,
        continuationInvalidated: Boolean(intent.continuation_id),
      }
    }
    if (
      intent.intent_state === 'prepared'
      && intent.expires_at.getTime() <= Date.now()
    ) {
      await client.query(
        `UPDATE operations_commerce_intake_read_intents
         SET intent_state = 'expired',
             last_error_code = 'COMMERCE_INTAKE_READ_INTENT_EXPIRED',
             row_version = row_version + 1,
             updated_by = $2,
             updated_at = now()
         WHERE id = $1::uuid
           AND intent_state = 'prepared'`,
        [intent.id, input.actorEmail],
      )
      await invalidateCommerceReadIntentContinuation(client, {
        intent,
        organizationId: account.organization_id,
        integrationAccountId: account.id,
        actorEmail: input.actorEmail,
      })
      return {
        kind: 'restart' as const,
        continuationInvalidated: Boolean(intent.continuation_id),
      }
    }
    if (intent.intent_state === 'reading') {
      if (
        intent.lease_expires_at
        && intent.lease_expires_at.getTime() > Date.now()
      ) {
        return { kind: 'in_progress' as const }
      }
      if (intent.provider_attempt_id) {
        await client.query(
          `UPDATE operations_commerce_provider_attempts
           SET state = 'unknown',
               error_code = 'COMMERCE_INTAKE_READ_LEASE_EXPIRED',
               lease_token = NULL,
               lease_expires_at = NULL,
               completed_at = now()
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND id = $3::uuid
             AND state = 'prepared'`,
          [
            account.organization_id,
            account.id,
            intent.provider_attempt_id,
          ],
        )
      }
      await client.query(
        `UPDATE operations_commerce_intake_read_intents
         SET intent_state = 'uncertain',
             lease_token = NULL,
             lease_expires_at = NULL,
             last_error_code = 'COMMERCE_INTAKE_READ_LEASE_EXPIRED',
             row_version = row_version + 1,
             updated_by = $2,
             updated_at = now()
         WHERE id = $1::uuid
           AND intent_state = 'reading'`,
        [intent.id, input.actorEmail],
      )
      await invalidateCommerceReadIntentContinuation(client, {
        intent,
        organizationId: account.organization_id,
        integrationAccountId: account.id,
        actorEmail: input.actorEmail,
      })
      return {
        kind: 'restart' as const,
        continuationInvalidated: Boolean(intent.continuation_id),
      }
    }
    const previousAttempt = await client.query<{
      request_hash: string
      state: string
    }>(
      `SELECT request_hash, state
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND action = 'commerce.intake.read'
         AND idempotency_key = $3
       ORDER BY attempt_number DESC
       LIMIT 1
       FOR UPDATE`,
      [
        account.organization_id,
        account.id,
        input.idempotencyKey,
      ],
    )
    if (previousAttempt.rows[0]) {
      if (previousAttempt.rows[0].request_hash !== intent.request_hash) {
        intakeError(
          'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
          'This provider-read key already identifies a different request.',
          409,
        )
      }
      await client.query(
        `UPDATE operations_commerce_intake_read_intents
         SET intent_state = 'expired',
             last_error_code = 'COMMERCE_INTAKE_READ_CAPTURE_MISSING',
             row_version = row_version + 1,
             updated_by = $2,
             updated_at = now()
         WHERE id = $1::uuid
           AND intent_state = 'prepared'`,
        [intent.id, input.actorEmail],
      )
      await invalidateCommerceReadIntentContinuation(client, {
        intent,
        organizationId: account.organization_id,
        integrationAccountId: account.id,
        actorEmail: input.actorEmail,
      })
      return {
        kind: 'restart' as const,
        continuationInvalidated: Boolean(intent.continuation_id),
      }
    }
    const leaseToken = randomUUID()
    const leaseExpiresAt = new Date(
      Date.now() + COMMERCE_INTAKE_READ_LEASE_MS,
    ).toISOString()
    const attemptResult = await client.query<{ id: string }>(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         idempotency_key, request_hash, redacted_request, redacted_response,
         state, attempt_number, provider_reference, lease_token,
         lease_expires_at, requested_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'commerce.intake.read', $3, $4, $5,
         $6::jsonb, '{}'::jsonb, 'prepared', 1, $7, $8::uuid,
         $9::timestamptz, now(), $10
       )
       RETURNING id::text`,
      [
        account.organization_id,
        account.id,
        input.adapterVersion,
        input.idempotencyKey,
        intent.request_hash,
        JSON.stringify(input.redactedRequest),
        input.runtime.externalAccountId,
        leaseToken,
        leaseExpiresAt,
        input.actorEmail,
      ],
    )
    const providerAttemptId = attemptResult.rows[0].id
    const updated = await client.query(
      `UPDATE operations_commerce_intake_read_intents
       SET intent_state = 'reading',
           provider_attempt_id = $2::uuid,
           lease_token = $3::uuid,
           lease_expires_at = $4::timestamptz,
           row_version = row_version + 1,
           updated_by = $5,
           updated_at = now()
       WHERE id = $1::uuid
         AND intent_state = 'prepared'
       RETURNING id`,
      [
        intent.id,
        providerAttemptId,
        leaseToken,
        leaseExpiresAt,
        input.actorEmail,
      ],
    )
    if (updated.rowCount !== 1) {
      intakeError(
        'COMMERCE_INTAKE_READ_IN_PROGRESS',
        'This provider read was reserved by another request. Retry the same action.',
        409,
      )
    }
    return {
      kind: 'lease' as const,
      readIntentId: intent.id,
      providerAttemptId,
      requestHash: intent.request_hash,
      leaseToken,
    }
  })
  if (reservation.kind === 'in_progress') {
    intakeError(
      'COMMERCE_INTAKE_READ_IN_PROGRESS',
      'The reserved provider read is still running. Retry this same action shortly.',
      409,
    )
  }
  if (reservation.kind === 'restart') {
    intakeError(
      'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
      reservation.continuationInvalidated
        ? 'The provider read outcome is uncertain. Reload, then use Restart session to begin a new bounded read.'
        : 'The provider read outcome is uncertain. Retry the action to start a newly reserved bounded read.',
      409,
    )
  }
  return reservation
}

export async function captureCommerceIntakeProviderReadInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  readIntentId: string
  providerAttemptId: string
  leaseToken: string
  requestHash: string
  result: CommerceIntakeReadResult
  redactedResponse: Record<string, unknown>
}) {
  const protectedResult = encryptCommerceIntakeReadResult(
    input.result as unknown as {
      envelope: Record<string, unknown>
      page: Record<string, unknown>
    },
    input.runtime.organizationId,
    input.runtime.globalId,
    input.runtime.provider,
    input.readIntentId,
    input.providerAttemptId,
    input.requestHash,
  )
  return withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.runtime.organizationId,
      accountGlobalId: input.runtime.globalId,
      forUpdate: true,
    })
    const intent = await client.query<{
      id: string
      request_hash: string
    }>(
      `SELECT id::text, request_hash
       FROM operations_commerce_intake_read_intents
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND idempotency_key = $4
         AND provider_attempt_id = $5::uuid
         AND intent_state = 'reading'
         AND lease_token = $6::uuid
         AND lease_expires_at > now()
       LIMIT 1
       FOR UPDATE`,
      [
        account.organization_id,
        account.id,
        input.readIntentId,
        input.idempotencyKey,
        input.providerAttemptId,
        input.leaseToken,
      ],
    )
    if (
      !intent.rows[0]
      || intent.rows[0].request_hash !== input.requestHash
    ) {
      intakeError(
        'COMMERCE_INTAKE_READ_LEASE_LOST',
        'The provider response arrived after its durable lease ended. Reload and use the restart workflow.',
        409,
      )
    }
    const attempt = await client.query(
      `UPDATE operations_commerce_provider_attempts
       SET redacted_response = $7::jsonb,
           state = 'succeeded',
           error_code = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND action = 'commerce.intake.read'
         AND idempotency_key = $4
         AND request_hash = $5
         AND state = 'prepared'
         AND lease_token = $6::uuid
       RETURNING id`,
      [
        account.organization_id,
        account.id,
        input.providerAttemptId,
        input.idempotencyKey,
        input.requestHash,
        input.leaseToken,
        JSON.stringify(input.redactedResponse),
      ],
    )
    if (attempt.rowCount !== 1) {
      intakeError(
        'COMMERCE_INTAKE_READ_LEASE_LOST',
        'The provider response could not claim its prepared attempt. Reload and use the restart workflow.',
        409,
      )
    }
    const captured = await client.query(
      `UPDATE operations_commerce_intake_read_intents
       SET intent_state = 'captured',
           lease_token = NULL,
           lease_expires_at = NULL,
           response_ciphertext = $2,
           response_iv = $3,
           response_tag = $4,
           response_hash = $5,
           response_bytes = $6,
           response_encryption_version = $7,
           row_version = row_version + 1,
           updated_by = $8,
           updated_at = now()
       WHERE id = $1::uuid
         AND intent_state = 'reading'
       RETURNING id`,
      [
        input.readIntentId,
        protectedResult.ciphertext,
        protectedResult.iv,
        protectedResult.tag,
        protectedResult.hash,
        protectedResult.bytes,
        protectedResult.encryptionVersion,
        input.actorEmail,
      ],
    )
    if (captured.rowCount !== 1) {
      intakeError(
        'COMMERCE_INTAKE_READ_CAPTURE_FAILED',
        'The provider response could not be durably captured.',
        500,
      )
    }
    return {
      result: input.result,
      responseHash: protectedResult.hash,
      providerAttemptId: input.providerAttemptId,
    }
  })
}

export async function markCommerceIntakeProviderReadUncertainInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  readIntentId: string
  providerAttemptId: string
  leaseToken: string
  errorCode: string
}) {
  const errorCode = /^[A-Z][A-Z0-9_]{1,127}$/.test(input.errorCode)
    ? input.errorCode
    : 'COMMERCE_INTAKE_READ_UNCERTAIN'
  return withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.runtime.organizationId,
      accountGlobalId: input.runtime.globalId,
      forUpdate: true,
    })
    const intentResult = await client.query<CommerceReadIntentPersistenceRow>(
      `SELECT id::text, provider, resource, intake_action, idempotency_key,
              request_hash, credential_version, intent_state,
              provider_attempt_id::text, lease_token::text, lease_expires_at,
              response_ciphertext, response_iv, response_tag, response_hash,
              response_bytes, continuation_id::text,
              continuation_row_version::text, expires_at
       FROM operations_commerce_intake_read_intents
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND idempotency_key = $4
       LIMIT 1
       FOR UPDATE`,
      [
        account.organization_id,
        account.id,
        input.readIntentId,
        input.idempotencyKey,
      ],
    )
    const intent = intentResult.rows[0]
    if (
      !intent
      || intent.intent_state !== 'reading'
      || intent.provider_attempt_id !== input.providerAttemptId
      || intent.lease_token !== input.leaseToken
    ) return
    await client.query(
      `UPDATE operations_commerce_provider_attempts
       SET state = 'unknown',
           error_code = $4,
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND state = 'prepared'`,
      [
        account.organization_id,
        account.id,
        input.providerAttemptId,
        errorCode,
      ],
    )
    await client.query(
      `UPDATE operations_commerce_intake_read_intents
       SET intent_state = 'uncertain',
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error_code = $2,
           row_version = row_version + 1,
           updated_by = $3,
           updated_at = now()
       WHERE id = $1::uuid
         AND intent_state = 'reading'`,
      [intent.id, errorCode, input.actorEmail],
    )
    await invalidateCommerceReadIntentContinuation(client, {
      intent,
      organizationId: account.organization_id,
      integrationAccountId: account.id,
      actorEmail: input.actorEmail,
    })
  })
}

export async function stageCommerceNormalizationEnvelopeInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  envelope: CommerceNormalizationEnvelope
  stageAction: CommerceIntakeStageAction
  page: CommerceIntakeBatchPageInput | null
  refreshCandidateGlobalId: string | null
  retryRejectionGlobalId: string | null
  readIntentId: string
  capturedResponseHash: string
}) {
  return withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.runtime.organizationId,
      accountGlobalId: input.runtime.globalId,
      forUpdate: true,
    })
    if (
      input.envelope.organizationId !== account.organization_id
      || input.envelope.integrationAccountId !== account.id
      || input.envelope.provider !== account.provider
      || input.envelope.credentialGeneration !== account.credential_version
    ) {
      intakeError(
        'COMMERCE_NORMALIZATION_SCOPE_MISMATCH',
        'Normalized data does not match the selected commerce connection',
        422,
      )
    }
    if (!['shadow', 'active'].includes(account.activation_state)) {
      intakeError(
        'COMMERCE_INTAKE_ACTIVATION_REQUIRED',
        'Open Operations and set Activation to Shadow or Active before staging commerce data',
      )
    }
    const exactAction = (
      input.stageAction === 'refresh'
      || input.stageAction === 'retry-rejection'
    )
    const firstPageAction = (
      input.stageAction === 'fetch'
      || input.stageAction === 'fetch-products'
    )
    const resource: 'orders' | 'products' = (
      input.stageAction === 'fetch-products'
      || input.stageAction === 'fetch-next-products'
      || input.page?.resource === 'products'
    )
      ? 'products'
      : 'orders'
    if (
      (exactAction && input.page !== null)
      || (!exactAction && input.page === null)
      || !input.readIntentId
      || !/^[a-f0-9]{64}$/.test(input.capturedResponseHash)
      || (
        firstPageAction
        && (
          input.page?.batchNumber !== 1
          || input.page.previousRunGlobalId !== null
        )
      )
      || (
        (
          input.stageAction === 'fetch-next'
          || input.stageAction === 'fetch-next-products'
        )
        && (
          !input.page?.previousRunGlobalId
          || input.page.batchNumber < 2
        )
      )
      || (
        input.stageAction === 'fetch-products'
        && input.page?.resource !== 'products'
      )
      || (
        input.stageAction === 'fetch-next-products'
        && input.page?.resource !== 'products'
      )
      || (
        input.stageAction === 'fetch-next'
        && input.page?.resource !== 'orders'
      )
      || (
        ['fetch', 'refresh', 'retry-rejection'].includes(input.stageAction)
        && resource !== 'orders'
      )
      || (
        (input.stageAction === 'retry-rejection')
        !== Boolean(input.retryRejectionGlobalId)
      )
      || (
        (input.stageAction === 'refresh')
        !== Boolean(input.refreshCandidateGlobalId)
      )
    ) {
      intakeError(
        'COMMERCE_INTAKE_CONTINUATION_INVALID',
        'The operational intake batch lineage is invalid',
        422,
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-intake-stage:${account.organization_id}:${account.id}:${input.idempotencyKey}`,
    )
    const stageRequestHash = commandHash({
      policyVersion: POLICY_VERSION,
      sourceHash: input.envelope.sourceHash,
      rejectionEvidence: input.envelope.rejections.map((rejection) => ({
        externalId: rejection.externalId,
        sourceHash: rejection.sourceHash,
        errorCode: rejection.errorCode,
      })),
      stageAction: input.stageAction,
      page: input.page
        ? {
            mode: input.page.mode,
            resource: input.page.resource,
            sessionId: input.page.sessionId,
            batchNumber: input.page.batchNumber,
            previousRunGlobalId: input.page.previousRunGlobalId,
            windowStart: input.page.windowStart,
            windowEnd: input.page.windowEnd,
            queryHash: input.page.queryHash,
            hasNextBatch: Boolean(input.page.nextOrderCursor),
            providerRowsSeen: input.page.providerRowsSeen,
            eligibleOrdersSeen: input.page.eligibleOrdersSeen,
          }
        : null,
      refreshCandidateGlobalId: input.refreshCandidateGlobalId,
      retryRejectionGlobalId: input.retryRejectionGlobalId,
      readIntentId: input.readIntentId,
      capturedResponseHash: input.capturedResponseHash,
    })
    const runResource = resource === 'products'
      ? 'products'
      : 'products_and_orders'
    const existing = await client.query<{
      global_id: string
      workflow_state: string
      records_staged: number
      request_hash: string
    }>(
      `SELECT global_id, workflow_state, records_staged, request_hash
       FROM operations_commerce_intake_runs
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = $3
         AND idempotency_key = $4
       LIMIT 1`,
      [
        account.organization_id,
        account.id,
        runResource,
        input.idempotencyKey,
      ],
    )
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== stageRequestHash) {
        intakeError(
          'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
          'This fetch idempotency key was already used for different provider data',
        )
      }
      return {
        action: input.stageAction,
        replayed: true,
        runGlobalId: existing.rows[0].global_id,
        workflowState: existing.rows[0].workflow_state,
        recordsStaged: existing.rows[0].records_staged,
        providerWrites: 0,
        syncCursorAdvanced: false,
      }
    }
    const readIntent = (
      await client.query<{
            id: string
            resource: 'orders' | 'products'
            intake_action: CommerceIntakeReadIntentAction
            credential_version: number
            target_kind:
              | 'none'
              | 'candidate'
              | 'rejection'
              | 'continuation'
            target_global_id: string | null
            target_source_hash: string | null
            target_external_id_hash: string | null
            session_id: string
            window_start: Date | null
            window_end: Date
            query_hash: string
            intent_state:
              | 'prepared'
              | 'reading'
              | 'captured'
              | 'staged'
              | 'uncertain'
              | 'expired'
            provider_attempt_id: string | null
            response_hash: string | null
            continuation_id: string | null
            continuation_cursor_hash: string | null
            continuation_row_version: string | null
            expires_at: Date
          }>(
            `SELECT id::text, resource, intake_action, credential_version,
                    target_kind, target_global_id, target_source_hash,
                    target_external_id_hash, session_id::text,
                    window_start, window_end, query_hash, intent_state,
                    provider_attempt_id::text, response_hash,
                    continuation_id::text, continuation_cursor_hash,
                    continuation_row_version::text,
                    expires_at
             FROM operations_commerce_intake_read_intents
             WHERE organization_id = $1::uuid
               AND integration_account_id = $2::uuid
               AND id = $3::uuid
               AND idempotency_key = $4
             FOR UPDATE`,
            [
              account.organization_id,
              account.id,
              input.readIntentId,
              input.idempotencyKey,
            ],
          )
    ).rows[0]
    if (
        !readIntent
        || readIntent.intent_state !== 'captured'
        || readIntent.expires_at.getTime() <= Date.now()
        || readIntent.resource !== resource
        || readIntent.intake_action !== input.stageAction
        || readIntent.credential_version !== account.credential_version
        || readIntent.response_hash !== input.capturedResponseHash
        || !readIntent.provider_attempt_id
        || (
          input.page
          && (
            readIntent.session_id !== input.page.sessionId
            || iso(readIntent.window_start) !== input.page.windowStart
            || readIntent.window_end.toISOString() !== input.page.windowEnd
            || readIntent.query_hash !== input.page.queryHash
          )
        )
        || (
          input.refreshCandidateGlobalId
          && (
            readIntent.target_kind !== 'candidate'
            || readIntent.target_global_id
              !== input.refreshCandidateGlobalId
          )
        )
        || (
          input.retryRejectionGlobalId
          && (
            readIntent.target_kind !== 'rejection'
            || readIntent.target_global_id
              !== input.retryRejectionGlobalId
          )
        )
        || (
          (
            input.stageAction === 'fetch-next'
            || input.stageAction === 'fetch-next-products'
          )
          && (
            readIntent.target_kind !== 'continuation'
            || readIntent.target_global_id
              !== input.page?.previousRunGlobalId
            || !readIntent.continuation_id
            || !readIntent.continuation_cursor_hash
            || readIntent.continuation_row_version === null
          )
        )
    ) {
      intakeError(
        'COMMERCE_INTAKE_INTENT_INVALID',
        'The provider-read evidence no longer matches this staging command. Reload and retry the workflow action.',
        409,
      )
    }
    if (input.refreshCandidateGlobalId) {
      const refreshTarget = await client.query<{
        id: string
        external_order_id: string
        source_hash: string
      }>(
        `SELECT id::text, external_order_id, source_hash
         FROM operations_commerce_order_candidates
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND global_id = $3
           AND workflow_state <> 'promoted'
         LIMIT 1`,
        [
          account.organization_id,
          account.id,
          input.refreshCandidateGlobalId,
        ],
      )
      if (!refreshTarget.rows[0]) {
        intakeError(
          'COMMERCE_INTAKE_REFRESH_TARGET_NOT_FOUND',
          'The held order cannot be refreshed',
          404,
        )
      }
      if (
        !readIntent
        || readIntent.target_source_hash
          !== refreshTarget.rows[0].source_hash
        || readIntent.target_external_id_hash
          !== commandHash(refreshTarget.rows[0].external_order_id)
      ) {
        intakeError(
          'COMMERCE_INTAKE_INTENT_TARGET_CHANGED',
          'This held order changed after the exact-read intent was prepared. Reload and retry the current revision.',
          409,
        )
      }
      if (!input.envelope.orders.some(
        (order) => (
          order.identity.value === refreshTarget.rows[0].external_order_id
        ),
      )) {
        intakeError(
          'COMMERCE_INTAKE_REFRESH_TARGET_MISSING',
          'The provider no longer returned this order. Mark the prior candidate unsupported or run a fresh eligible-order fetch',
          409,
        )
      }
    }
    let retryRejection: {
      id: string
      external_id: string
      source_hash: string
    } | null = null
    if (input.retryRejectionGlobalId) {
      const rejectionResult = await client.query<{
        id: string
        external_id: string
        source_hash: string
      }>(
        `SELECT id::text, external_id, source_hash
         FROM operations_commerce_intake_rejections
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND global_id = $3
           AND resource_type = 'order'
           AND disposition = 'open'
         LIMIT 1
         FOR UPDATE`,
        [
          account.organization_id,
          account.id,
          input.retryRejectionGlobalId,
        ],
      )
      retryRejection = rejectionResult.rows[0] || null
      if (!retryRejection) {
        intakeError(
          'COMMERCE_INTAKE_REJECTION_NOT_OPEN',
          'This rejected record is no longer open. Reload the workflow to see its current disposition.',
          409,
        )
      }
      if (
        !readIntent
        || readIntent.target_source_hash !== retryRejection.source_hash
        || readIntent.target_external_id_hash
          !== commandHash(retryRejection.external_id)
      ) {
        intakeError(
          'COMMERCE_INTAKE_INTENT_TARGET_CHANGED',
          'This rejected record changed after the exact-read intent was prepared. Reload and retry the current rejection.',
          409,
        )
      }
      const targetWasReturned = input.envelope.orders.some(
        (order) => order.identity.value === retryRejection?.external_id,
      ) || input.envelope.rejections.some(
        (rejection) => rejection.externalId === retryRejection?.external_id,
      )
      if (!targetWasReturned) {
        intakeError(
          'COMMERCE_INTAKE_REJECTION_TARGET_MISSING',
          'The provider no longer returns this rejected order. Use Exclude safely to record the disposition.',
          409,
        )
      }
    }
    const providerAttempt = await client.query<{ id: string }>(
      `SELECT id::text
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND action = 'commerce.intake.read'
         AND id = $3::uuid
         AND idempotency_key = $4
         AND state = 'succeeded'
       LIMIT 1`,
      [
        account.organization_id,
        account.id,
        readIntent.provider_attempt_id,
        input.idempotencyKey,
      ],
    )
    if (!providerAttempt.rows[0]) {
      intakeError(
        'COMMERCE_INTAKE_READ_EVIDENCE_MISSING',
        'The provider read completed without durable read-only evidence',
        500,
      )
    }
    const variantCount = input.envelope.products.reduce(
      (sum, product) => sum + product.variants.length,
      0,
    )
    const normalizationRejections = input.envelope.rejections.map(
      (rejection) => ({
        resourceType: rejection.resourceType,
        externalId: rejection.externalId,
        sourceHash: rejection.sourceHash,
        errorCode: rejection.errorCode,
        safeMessage: rejection.safeMessage,
      }),
    )
    const recordsRejected = normalizationRejections.length
    const recordsSeen = (
      variantCount
      + input.envelope.orders.length
      + recordsRejected
    )
    const externalOrderIds = [
      ...new Set(input.envelope.orders.map((order) => order.identity.value)),
    ]
    const canonicalExternalOrderIds = new Set<string>()
    const latestCandidateByExternalOrder = new Map<string, {
      sourceRevision: string
      sourceHash: string
      workflowState: string
      customerResolutionState: string
      credentialVersion: number
    }>()
    if (externalOrderIds.length) {
      const canonicalOrders = await client.query<{
        external_order_id: string
      }>(
        `SELECT canonical.external_order_id
         FROM operations_orders canonical
         WHERE canonical.organization_id = $1::uuid
           AND canonical.integration_account_id = $2::uuid
           AND canonical.external_order_id = ANY($3::text[])
         UNION
         SELECT external.external_id AS external_order_id
         FROM operations_external_identifiers external
         WHERE external.organization_id = $1::uuid
           AND external.integration_account_id = $2::uuid
           AND external.entity_type = 'operations.order'
           AND external.status = 'active'
           AND external.external_id = ANY($3::text[])
         UNION
         SELECT candidate.external_order_id
         FROM operations_commerce_order_candidates candidate
         WHERE candidate.organization_id = $1::uuid
           AND candidate.integration_account_id = $2::uuid
           AND candidate.external_order_id = ANY($3::text[])
           AND (
             candidate.workflow_state = 'promoted'
             OR candidate.canonical_order_id IS NOT NULL
           )`,
        [account.organization_id, account.id, externalOrderIds],
      )
      for (const row of canonicalOrders.rows) {
        canonicalExternalOrderIds.add(row.external_order_id)
      }

      const latestCandidates = await client.query<{
        external_order_id: string
        source_revision: string
        source_hash: string
        workflow_state: string
        customer_resolution_state: string
        credential_version: number
      }>(
        `SELECT DISTINCT ON (candidate.external_order_id)
           candidate.external_order_id,
           candidate.source_revision,
           candidate.source_hash,
           candidate.workflow_state,
           candidate.customer_resolution_state,
           run.credential_version
         FROM operations_commerce_order_candidates candidate
         JOIN operations_commerce_intake_runs run
           ON run.organization_id = candidate.organization_id
          AND run.integration_account_id = candidate.integration_account_id
          AND run.pipeline_id = candidate.pipeline_id
          AND run.id = candidate.run_id
         WHERE candidate.organization_id = $1::uuid
           AND candidate.integration_account_id = $2::uuid
           AND candidate.external_order_id = ANY($3::text[])
           AND candidate.expires_at > now()
           AND candidate.workflow_state <> 'expired'
           AND run.expires_at > now()
           AND run.workflow_state <> 'expired'
         ORDER BY candidate.external_order_id,
                  candidate.observed_at DESC,
                  candidate.created_at DESC,
                  candidate.id DESC`,
        [account.organization_id, account.id, externalOrderIds],
      )
      for (const row of latestCandidates.rows) {
        latestCandidateByExternalOrder.set(row.external_order_id, {
          sourceRevision: row.source_revision,
          sourceHash: row.source_hash,
          workflowState: row.workflow_state,
          customerResolutionState: row.customer_resolution_state,
          credentialVersion: row.credential_version,
        })
      }
    }
    const runResult = await client.query<{
      id: string
      global_id: string
      resource: 'products' | 'products_and_orders'
    }>(
      `INSERT INTO operations_commerce_intake_runs (
         organization_id, integration_account_id, pipeline_id, provider,
         resource, credential_version, provider_api_version,
         normalizer_version, idempotency_key, request_hash,
         provider_attempt_id, window_start, window_end, workflow_state,
         records_seen, records_staged, records_failed, created_by, updated_by,
         expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
         $8, $9, $10, $11::uuid, $12::timestamptz, $13::timestamptz,
         'held', $14, $15, 0, $16, $16, $17::timestamptz
       )
       RETURNING id::text, global_id`,
      [
        account.organization_id,
        account.id,
        account.pipeline_id,
        account.provider,
        runResource,
        account.credential_version,
        input.envelope.apiVersion,
        input.envelope.normalizerVersion,
        input.idempotencyKey,
        stageRequestHash,
        providerAttempt.rows[0].id,
        input.page?.windowStart
          ?? iso(readIntent?.window_start)
          ?? null,
        input.page?.windowEnd
          || readIntent?.window_end.toISOString()
          || input.envelope.observedAt,
        recordsSeen,
        variantCount,
        input.actorEmail,
        input.envelope.retentionExpiresAt,
      ],
    )
    const run = runResult.rows[0]

    const mappings = await client.query<{
      id: string
      external_variant_id: string
      product_id: string
    }>(
      `SELECT id::text, external_variant_id, product_id::text
       FROM operations_product_mappings
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND active = true
         AND external_variant_id IS NOT NULL`,
      [account.organization_id, account.id],
    )
    const mappingByVariant = new Map(
      mappings.rows.map((mapping) => [mapping.external_variant_id, mapping]),
    )
    const productCandidateByVariant = new Map<string, string>()
    for (const product of input.envelope.products) {
      const status = providerProductStatus(product)
      for (const variant of product.variants) {
        const wholesalePrice = optionalMoney(variant.wholesalePrice)
        const retailPrice = optionalMoney(variant.retailPrice)
        const price = wholesalePrice ?? retailPrice
        const compareAtPrice = (
          wholesalePrice
          && retailPrice
          && retailPrice.currency === wholesalePrice.currency
        )
          ? retailPrice
          : null
        const packaging = availableValue(variant.packaging)
        const inventoryItem = availableValue(variant.inventoryItemIdentity)
        const mapping = mappingByVariant.get(variant.identity.value)
        const productCandidate = await client.query<{ id: string }>(
          `INSERT INTO operations_commerce_product_candidates (
             organization_id, integration_account_id, pipeline_id, run_id,
             provider, external_product_id, external_variant_id,
             external_inventory_item_id, sku_snapshot, barcode_snapshot,
             product_title_snapshot, variant_title_snapshot,
             vendor_snapshot, product_type_snapshot, normalized_options,
             provider_status_raw, normalized_status, unit_multiplier,
             currency_code, price_minor, compare_at_price_minor, taxable,
             requires_shipping, inventory_quantity, weight_grams,
             provider_created_at, provider_updated_at, observed_at,
             source_revision, source_hash, provider_api_version,
             normalizer_version, workflow_state, mapping_state, product_id,
             product_mapping_id, blocking_codes, created_by, updated_by,
             expires_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18,
             $19, $20, $21, $22, $23, $24, $25,
             $26::timestamptz, $27::timestamptz, $28::timestamptz,
             $29, $30, $31, $32, 'held', $33, $34::uuid, $35::uuid,
             $36::text[], $37, $37, $38::timestamptz
           )
           RETURNING id::text`,
          [
            account.organization_id,
            account.id,
            account.pipeline_id,
            run.id,
            account.provider,
            product.identity.value,
            variant.identity.value,
            inventoryItem?.value ?? null,
            variant.sku,
            variant.barcode,
            product.title,
            variant.title,
            product.vendor,
            product.productType,
            safeJson(variant.selectedOptions),
            status.raw,
            status.normalized,
            variant.unitMultiplier || 1,
            price?.currency || null,
            price ? bigintString(price.amountMinor) : null,
            compareAtPrice ? bigintString(compareAtPrice.amountMinor) : null,
            variant.taxable,
            variant.requiresShipping,
            variant.inventory.state === 'available'
              ? variant.inventory.value.quantity
              : null,
            variant.weightGrams ?? packaging?.weightGrams ?? null,
            variant.providerCreatedAt,
            variant.providerUpdatedAt,
            input.envelope.observedAt,
            sourceRevision(variant.providerUpdatedAt, variant.sourceHash),
            variant.sourceHash,
            input.envelope.apiVersion,
            input.envelope.normalizerVersion,
            mapping ? 'resolved' : 'unresolved',
            mapping?.product_id || null,
            mapping?.id || null,
            mapping ? [] : ['product_mapping_required'],
            input.actorEmail,
            input.envelope.retentionExpiresAt,
          ],
        )
        productCandidateByVariant.set(
          variant.identity.value,
          productCandidate.rows[0].id,
        )
      }
    }

    let ordersStaged = 0
    let ordersPreserved = 0
    let ordersSkippedCanonical = 0
    for (const order of input.envelope.orders) {
      const externalOrderId = order.identity.value
      if (canonicalExternalOrderIds.has(externalOrderId)) {
        ordersSkippedCanonical += 1
        continue
      }
      const incomingSourceRevision = sourceRevision(
        order.providerUpdatedAt,
        order.sourceHash,
      )
      const latestCandidate = latestCandidateByExternalOrder.get(
        externalOrderId,
      )
      if (
        latestCandidate
        && !input.refreshCandidateGlobalId
        && !input.retryRejectionGlobalId
        && ['held', 'resolving', 'ready'].includes(
          latestCandidate.workflowState,
        )
        && latestCandidate.customerResolutionState !== 'unsupported'
        && latestCandidate.credentialVersion === account.credential_version
        && latestCandidate.sourceRevision === incomingSourceRevision
        && latestCandidate.sourceHash === order.sourceHash
      ) {
        ordersPreserved += 1
        continue
      }
      const subtotal = requiredOrderMoney(order, order.subtotal, 'subtotal')
      const shipping = requiredOrderMoney(order, order.shipping, 'shipping')
      const tax = requiredOrderMoney(order, order.tax, 'tax')
      const totalDiscount = requiredOrderMoney(order, order.discount, 'discount')
      const total = requiredOrderMoney(order, order.total, 'total')
      let discount = totalDiscount
      let brandDiscount = BigInt(0)
      if (order.providerFacts.provider === 'faire') {
        const lineDiscount = optionalMoney(order.providerFacts.lineDiscountTotal)
        const providerBrandDiscount = optionalMoney(
          order.providerFacts.brandDiscount,
        )
        if (
          lineDiscount?.currency === order.currency
          && providerBrandDiscount?.currency === order.currency
          && lineDiscount.amountMinor + providerBrandDiscount.amountMinor
            === totalDiscount
        ) {
          discount = lineDiscount.amountMinor
          brandDiscount = providerBrandDiscount.amountMinor
        }
      }
      const otherAdjustment = total
        - subtotal
        + discount
        + brandDiscount
        - shipping
        - tax
      const presentment = [
        presentmentMoney(order.subtotal),
        presentmentMoney(order.discount),
        presentmentMoney(order.shipping),
        presentmentMoney(order.tax),
        presentmentMoney(order.total),
      ]
      const presentmentCurrency = presentment.every(Boolean)
        && new Set(presentment.map((money) => money?.currency)).size === 1
        ? presentment[0]?.currency || null
        : null
      const presentmentOther = presentmentCurrency
        ? (presentment[4]?.amountMinor || BigInt(0))
          - (presentment[0]?.amountMinor || BigInt(0))
          + (presentment[1]?.amountMinor || BigInt(0))
          - (presentment[2]?.amountMinor || BigInt(0))
          - (presentment[3]?.amountMinor || BigInt(0))
        : null
      const party = partyValue(order.party)
      const address = addressValue(order.shipTo)
      const partyProtected = party
        ? encryptCommerceCandidateSnapshot(
            party,
            account.organization_id,
            input.runtime.globalId,
            order.identity.value,
            order.sourceHash,
            'party',
          )
        : null
      const addressProtected = address
        ? encryptCommerceCandidateSnapshot(
            address,
            account.organization_id,
            input.runtime.globalId,
            order.identity.value,
            order.sourceHash,
            'ship_to',
          )
        : null
      const requestedDelivery = fieldText(order.requestedDeliveryAt)
      const payout = order.providerFacts.provider === 'faire'
        ? optionalMoney(order.providerFacts.payoutAmount)
        : null
      const requiresShipping = order.lines.some((line) => {
        const quantity = lineQuantityState(order, line)
        return line.requiresShipping && quantity.unfulfilled > 0
      })
      const initialCodes = initialOrderBlockingCodes(order, requiresShipping)
      const candidateResult = await client.query<{ id: string }>(
        `INSERT INTO operations_commerce_order_candidates (
           organization_id, integration_account_id, pipeline_id, run_id,
           provider, external_order_id, order_number_snapshot, source_channel,
           provider_order_status_raw, provider_financial_status_raw,
           provider_fulfillment_status_raw, provider_return_status_raw,
           normalized_order_status, normalized_payment_status,
           normalized_fulfillment_status, normalized_return_status,
           test_order, requires_shipping, currency_code, subtotal_minor,
           discount_minor, brand_discount_minor, shipping_minor, tax_minor,
           other_adjustment_minor, total_minor, presentment_currency_code,
           presentment_subtotal_minor, presentment_discount_minor,
           presentment_brand_discount_minor, presentment_shipping_minor,
           presentment_tax_minor, presentment_other_adjustment_minor,
           presentment_total_minor, merchant_payout_currency_code,
           merchant_payout_minor, party_kind, party_snapshot_state,
           party_snapshot_ciphertext, party_snapshot_iv, party_snapshot_tag,
           party_snapshot_hash, party_snapshot_encryption_version,
           ship_to_snapshot_state, ship_to_snapshot_source,
           ship_to_snapshot_ciphertext, ship_to_snapshot_iv,
           ship_to_snapshot_tag, ship_to_snapshot_hash,
           ship_to_snapshot_encryption_version, delivery_resolution_state,
           provider_requested_delivery_at, provider_created_at,
           provider_processed_at, provider_updated_at, provider_cancelled_at,
           provider_closed_at, observed_at, source_revision, source_hash,
           provider_api_version, normalizer_version, workflow_state,
           blocking_codes, created_by, updated_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
           $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
           CASE WHEN $27 IS NULL THEN NULL ELSE 0 END,
           $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
           $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51,
           $52::timestamptz, $53::timestamptz, $54::timestamptz,
           $55::timestamptz, $56::timestamptz, $57::timestamptz,
           $58, $59, $60, $61, 'held', $62::text[],
           $63, $63, $64::timestamptz
         )
         RETURNING id::text`,
        [
          account.organization_id,
          account.id,
          account.pipeline_id,
          run.id,
          account.provider,
          order.identity.value,
          order.orderNumber,
          order.providerFacts.provider === 'shopify'
            ? order.providerFacts.sourceName
            : 'faire',
          providerStatus(order.rawStates.lifecycle),
          providerStatus(order.rawStates.payment),
          providerStatus(order.rawStates.fulfillment),
          providerStatus(order.rawStates.returns),
          normalizedOrderStatus(order),
          order.canonicalStates.payment,
          normalizedFulfillmentStatus(order),
          normalizedReturnStatus(order),
          order.providerFacts.provider === 'shopify'
            ? order.providerFacts.testOrder
            : false,
          requiresShipping,
          order.currency,
          bigintString(subtotal),
          bigintString(discount),
          bigintString(brandDiscount),
          bigintString(shipping),
          bigintString(tax),
          bigintString(otherAdjustment),
          bigintString(total),
          presentmentCurrency,
          presentmentCurrency ? bigintString(presentment[0]?.amountMinor) : null,
          presentmentCurrency ? bigintString(presentment[1]?.amountMinor) : null,
          presentmentCurrency ? bigintString(presentment[2]?.amountMinor) : null,
          presentmentCurrency ? bigintString(presentment[3]?.amountMinor) : null,
          presentmentOther === null ? null : bigintString(presentmentOther),
          presentmentCurrency ? bigintString(presentment[4]?.amountMinor) : null,
          payout?.currency || null,
          payout ? bigintString(payout.amountMinor) : null,
          order.providerFacts.provider === 'faire'
            ? 'retailer'
            : 'consumer',
          partyProtected ? 'protected' : (
            order.party.state === 'redacted' ? 'redacted' : 'missing'
          ),
          partyProtected?.ciphertext || null,
          partyProtected?.iv || null,
          partyProtected?.tag || null,
          partyProtected?.hash || null,
          partyProtected?.encryptionVersion || null,
          addressProtected ? 'protected' : (
            order.shipTo.state === 'redacted' ? 'redacted' : 'missing'
          ),
          addressProtected || order.shipTo.state === 'redacted'
            ? 'provider'
            : 'none',
          addressProtected?.ciphertext || null,
          addressProtected?.iv || null,
          addressProtected?.tag || null,
          addressProtected?.hash || null,
          addressProtected?.encryptionVersion || null,
          requiresShipping ? 'unresolved' : 'not_required',
          requestedDelivery,
          order.providerCreatedAt,
          order.providerProcessedAt,
          order.providerUpdatedAt,
          order.providerCancelledAt,
          order.providerClosedAt,
          input.envelope.observedAt,
          incomingSourceRevision,
          order.sourceHash,
          input.envelope.apiVersion,
          input.envelope.normalizerVersion,
          initialCodes,
          input.actorEmail,
          input.envelope.retentionExpiresAt,
        ],
      )
      const candidateId = candidateResult.rows[0].id
      for (const line of order.lines) {
        const identity = exactMappingIdentity(line)
        const mapping = identity ? mappingByVariant.get(identity) : null
        const productCandidateId = identity
          ? productCandidateByVariant.get(identity) || null
          : null
        const quantity = lineQuantityState(order, line)
        const unitPrice = optionalMoney(line.unitPrice)
        const lineSubtotal = optionalMoney(line.lineSubtotal)
        const lineDiscount = optionalMoney(line.lineDiscount)
        const lineTax = optionalMoney(line.lineTax)
        const packaging = availableValue(line.packaging)
        const mappingState = mapping ? 'resolved' : 'unresolved'
        const packagingState = line.requiresShipping
          ? (packaging ? 'resolved' : 'unresolved')
          : 'not_required'
        const codes = lineBlockingCodes(line).filter((code) => {
          if (code === 'product_mapping_required' && mapping) return false
          if (code === 'packaging_required' && packaging) return false
          return true
        })
        if (
          quantity.unfulfilled > 0
          && !codes.includes('line_price_required')
        ) {
          codes.push('line_price_required')
          codes.sort()
        }
        await client.query(
          `INSERT INTO operations_commerce_order_candidate_lines (
             organization_id, integration_account_id, pipeline_id, run_id,
             order_candidate_id, product_candidate_id, provider,
             external_line_id, external_product_id, external_variant_id,
             external_inventory_item_id, sku_snapshot, product_title_snapshot,
             variant_title_snapshot, provider_status_raw, normalized_status,
             ordered_quantity, current_quantity, cancelled_quantity,
             fulfilled_quantity, unfulfilled_quantity, returned_quantity,
             unit_multiplier, physical_quantity, currency_code,
             unit_price_minor, subtotal_minor, discount_minor,
             brand_discount_minor, tax_minor, other_adjustment_minor,
             total_minor, price_resolution_state, requires_shipping,
             mapping_state, product_id, product_mapping_id, packaging_state,
             packaging_source, weight_grams, length_mm, width_mm, height_mm,
             observed_at, source_revision, source_hash, provider_api_version,
             normalizer_version, workflow_state, blocking_codes, created_by,
             updated_by, expires_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
             $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             $17, $18, $19, $20, $21, 0, $22, $23, $24, $25, $26,
             $27, NULL, $28, NULL, NULL, 'unresolved', $29, $30,
             $31::uuid, $32::uuid, $33, $34, $35, $36, $37, $38,
             $39::timestamptz, $40, $41, $42, $43, 'held', $44::text[],
             $45, $45, $46::timestamptz
           )`,
          [
            account.organization_id,
            account.id,
            account.pipeline_id,
            run.id,
            candidateId,
            productCandidateId,
            account.provider,
            line.identity.value,
            availableValue(line.productIdentity)?.value || null,
            availableValue(line.variantIdentity)?.value || null,
            null,
            line.sku,
            line.titleSnapshot,
            line.variantTitleSnapshot,
            providerStatus(order.rawStates.fulfillment),
            quantity.unfulfilled > 0
              ? 'open'
              : quantity.fulfilled > 0
                ? 'fulfilled'
                : 'cancelled',
            line.orderedQuantity,
            quantity.current,
            quantity.cancelled,
            quantity.fulfilled,
            quantity.unfulfilled,
            line.unitMultiplier || 1,
            line.physicalUnitQuantity,
            unitPrice?.currency || null,
            unitPrice ? bigintString(unitPrice.amountMinor) : null,
            lineSubtotal ? bigintString(lineSubtotal.amountMinor) : null,
            lineDiscount ? bigintString(lineDiscount.amountMinor) : null,
            lineTax ? bigintString(lineTax.amountMinor) : null,
            line.requiresShipping,
            mappingState,
            mapping?.product_id || null,
            mapping?.id || null,
            packagingState,
            packaging ? 'provider' : 'none',
            packaging?.weightGrams || null,
            packaging?.lengthMillimeters || null,
            packaging?.widthMillimeters || null,
            packaging?.heightMillimeters || null,
            input.envelope.observedAt,
            sourceRevision(order.providerUpdatedAt, line.sourceHash),
            line.sourceHash,
            input.envelope.apiVersion,
            input.envelope.normalizerVersion,
            codes,
            input.actorEmail,
            input.envelope.retentionExpiresAt,
          ],
        )
      }
      ordersStaged += 1
    }

    for (const rejection of normalizationRejections) {
      await client.query(
        `UPDATE operations_commerce_intake_rejections
         SET disposition = 'superseded',
             row_version = row_version + 1,
             updated_by = $7,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND resource_type = $3
           AND external_id = $4
           AND source_hash = $5
           AND ($6::uuid IS NULL OR id <> $6::uuid)
           AND disposition = 'open'`,
        [
          account.organization_id,
          account.id,
          rejection.resourceType,
          rejection.externalId,
          rejection.sourceHash,
          retryRejection?.id || null,
          input.actorEmail,
        ],
      )
      await client.query(
        `INSERT INTO operations_commerce_intake_rejections (
           organization_id, integration_account_id, pipeline_id, run_id,
           provider, resource_type, external_id, source_hash, error_code,
           safe_message, created_by, updated_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
           $9, $10, $11, $11, $12::timestamptz
         )`,
        [
          account.organization_id,
          account.id,
          account.pipeline_id,
          run.id,
          account.provider,
          rejection.resourceType,
          rejection.externalId,
          rejection.sourceHash,
          rejection.errorCode,
          rejection.safeMessage,
          input.actorEmail,
          input.envelope.retentionExpiresAt,
        ],
      )
    }
    if (retryRejection) {
      const retried = await client.query(
        `UPDATE operations_commerce_intake_rejections
         SET disposition = 'retried',
             retry_run_id = $2::uuid,
             row_version = row_version + 1,
             updated_by = $3,
             updated_at = now()
         WHERE id = $1::uuid
           AND disposition = 'open'
         RETURNING id`,
        [retryRejection.id, run.id, input.actorEmail],
      )
      if (retried.rowCount !== 1) {
        intakeError(
          'COMMERCE_INTAKE_REJECTION_NOT_OPEN',
          'This rejected record changed during retry. Reload the workflow.',
          409,
        )
      }
    }

    const recordsStaged = variantCount + ordersStaged
    let pagination: {
      mode: 'operational'
      resource: 'orders' | 'products'
      consistencyMode: 'provider_time_fenced' | 'provider_cursor_live'
      batchNumber: number
      runGlobalId: string
      continuationRunGlobalId: string | null
      hasNextBatch: boolean
      sessionComplete: boolean
      restartRequired: boolean
      state: 'available' | 'exhausted'
      providerRowsSeen: number
      eligibleOrdersSeen: number
    } | null = null
    if (input.page) {
      let previousRunId: string | null = null
      if (firstPageAction) {
        await client.query(
          `UPDATE operations_commerce_intake_continuations
           SET cursor_state = 'superseded',
               cursor_ciphertext = NULL,
               cursor_iv = NULL,
               cursor_tag = NULL,
               cursor_hash = NULL,
               encryption_version = NULL,
               row_version = row_version + 1,
               updated_by = $3,
               updated_at = now()
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND resource = $4
             AND cursor_state = 'available'`,
          [
            account.organization_id,
            account.id,
            input.actorEmail,
            resource,
          ],
        )
      } else {
        const previous = await client.query<{
          id: string
          run_id: string
          cursor_state: string
          session_id: string
          batch_number: number
          provider: string
          resource: 'orders' | 'products'
          credential_version: number
          window_start: Date | null
          window_end: Date
          query_hash: string
          cursor_hash: string | null
          row_version: string
        }>(
          `SELECT continuation.id::text, continuation.run_id::text,
                  continuation.cursor_state,
                  continuation.session_id::text,
                  continuation.batch_number,
                  continuation.provider,
                  continuation.resource,
                  continuation.credential_version,
                  continuation.window_start,
                  continuation.window_end,
                  continuation.query_hash,
                  continuation.cursor_hash,
                  continuation.row_version::text
           FROM operations_commerce_intake_continuations continuation
           JOIN operations_commerce_intake_runs previous_run
             ON previous_run.organization_id = continuation.organization_id
            AND previous_run.integration_account_id
                = continuation.integration_account_id
            AND previous_run.pipeline_id = continuation.pipeline_id
            AND previous_run.id = continuation.run_id
           WHERE continuation.organization_id = $1::uuid
             AND continuation.integration_account_id = $2::uuid
             AND previous_run.global_id = $3
           LIMIT 1
           FOR UPDATE OF continuation`,
          [
            account.organization_id,
            account.id,
            input.page.previousRunGlobalId,
          ],
        )
        const prior = previous.rows[0]
        if (!prior || prior.cursor_state !== 'available') {
          intakeError(
            'COMMERCE_INTAKE_CONTINUATION_CONSUMED',
            'This intake batch was already continued. Refresh the workflow to use the current batch.',
          )
        }
        if (
          prior.session_id !== input.page.sessionId
          || prior.batch_number + 1 !== input.page.batchNumber
          || prior.provider !== account.provider
          || prior.resource !== resource
          || prior.credential_version !== account.credential_version
          || prior.query_hash !== input.page.queryHash
          || iso(prior.window_start) !== input.page.windowStart
          || prior.window_end.toISOString() !== input.page.windowEnd
          || prior.id !== readIntent.continuation_id
          || prior.cursor_hash !== readIntent.continuation_cursor_hash
          || prior.row_version !== readIntent.continuation_row_version
        ) {
          intakeError(
            'COMMERCE_INTAKE_CONTINUATION_INVALID',
            'The operational intake batch lineage is invalid',
            422,
          )
        }
        previousRunId = prior.run_id
        await client.query(
          `UPDATE operations_commerce_intake_continuations
           SET cursor_state = 'consumed',
               cursor_ciphertext = NULL,
               cursor_iv = NULL,
               cursor_tag = NULL,
               cursor_hash = NULL,
               encryption_version = NULL,
               consumed_by_run_id = $2::uuid,
               consumed_idempotency_key = $3,
               row_version = row_version + 1,
               updated_by = $4,
               updated_at = now()
           WHERE id = $1::uuid
             AND row_version = $5::bigint`,
          [
            prior.id,
            run.id,
            input.idempotencyKey,
            input.actorEmail,
            readIntent.continuation_row_version,
          ],
        )
      }

      const protectedCursor = input.page.nextOrderCursor
        ? encryptCommerceIntakeContinuation(
            { orderCursor: input.page.nextOrderCursor },
            account.organization_id,
            input.runtime.globalId,
            account.provider,
            input.page.sessionId,
            input.page.batchNumber,
            input.page.queryHash,
          )
        : null
      const continuationState = protectedCursor ? 'available' : 'exhausted'
      await client.query(
         `INSERT INTO operations_commerce_intake_continuations (
           organization_id, integration_account_id, pipeline_id, run_id,
           previous_run_id, session_id, batch_number, provider, resource,
           intake_mode, credential_version, window_start, window_end,
           query_hash, cursor_state, cursor_ciphertext, cursor_iv, cursor_tag,
           cursor_hash, encryption_version, provider_rows_seen,
           eligible_orders_seen, created_by, updated_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7,
           $8, $9, 'operational', $10, $11::timestamptz, $12::timestamptz,
           $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22,
           $23::timestamptz
         )`,
        [
          account.organization_id,
          account.id,
          account.pipeline_id,
          run.id,
          previousRunId,
          input.page.sessionId,
          input.page.batchNumber,
          account.provider,
          resource,
          account.credential_version,
          input.page.windowStart,
          input.page.windowEnd,
          input.page.queryHash,
          continuationState,
          protectedCursor?.ciphertext || null,
          protectedCursor?.iv || null,
          protectedCursor?.tag || null,
          protectedCursor?.hash || null,
          protectedCursor?.encryptionVersion || null,
          input.page.providerRowsSeen,
          input.page.eligibleOrdersSeen,
          input.actorEmail,
          input.envelope.retentionExpiresAt,
        ],
      )
      pagination = {
        mode: 'operational',
        resource,
        consistencyMode: account.provider === 'shopify'
          ? 'provider_time_fenced'
          : 'provider_cursor_live',
        batchNumber: input.page.batchNumber,
        runGlobalId: run.global_id,
        continuationRunGlobalId: protectedCursor ? run.global_id : null,
        hasNextBatch: Boolean(protectedCursor),
        sessionComplete: !protectedCursor,
        restartRequired: false,
        state: continuationState,
        providerRowsSeen: input.page.providerRowsSeen,
        eligibleOrdersSeen: input.page.eligibleOrdersSeen,
      }
    }
    const stagedIntent = await client.query(
      `UPDATE operations_commerce_intake_read_intents
       SET intent_state = 'staged',
           staged_run_id = $2::uuid,
           row_version = row_version + 1,
           updated_by = $3,
           updated_at = now()
       WHERE id = $1::uuid
         AND intent_state = 'captured'
         AND response_hash = $4
       RETURNING id`,
      [
        readIntent.id,
        run.id,
        input.actorEmail,
        input.capturedResponseHash,
      ],
    )
    if (stagedIntent.rowCount !== 1) {
      intakeError(
        'COMMERCE_INTAKE_INTENT_INVALID',
        'The provider-read intent was already consumed. Reload the workflow.',
      )
    }
    await client.query(
      `UPDATE operations_commerce_intake_runs
       SET records_staged = $2,
           row_version = row_version + 1,
           updated_by = $3,
           updated_at = now()
       WHERE organization_id = $4::uuid
         AND integration_account_id = $5::uuid
         AND id = $1::uuid`,
      [
        run.id,
        recordsStaged,
        input.actorEmail,
        account.organization_id,
        account.id,
      ],
    )
    const stageResult = {
      action: input.stageAction,
      replayed: false,
      runGlobalId: run.global_id,
      workflowState: 'held',
      ordersStaged,
      ordersPreserved,
      ordersSkippedCanonical,
      productVariantsStaged: variantCount,
      recordsRejected,
      recordsStaged,
      pagination,
      providerWrites: 0,
      syncCursorAdvanced: false,
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.intake.staged',
      aggregateType: 'operations.commerce_intake_run',
      aggregateId: run.global_id,
      organizationId: account.organization_id,
      eventKey: `commerce-intake:${run.global_id}:staged`,
      payload: {
        provider: account.provider,
        orders: input.envelope.orders.length,
        ordersSeen: input.envelope.orders.length,
        ordersStaged,
        ordersPreserved,
        ordersSkippedCanonical,
        productVariants: variantCount,
        recordsRejected,
        normalizationRejections,
        action: stageResult.action,
        pagination,
        stageResult,
        providerWrites: 0,
        syncCursorAdvanced: false,
      },
    }, client)
    return stageResult
  })
}

function safeMinor(value: string | null | undefined) {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function safeNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function readCommerceIntakeStateFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
}) {
  return withTransaction(async (client) => {
    const account = await resolveAccount(client, {
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    })
    const runResult = await client.query<{
      id: string
      global_id: string
      resource: 'products' | 'products_and_orders'
      workflow_state: string
      records_seen: number
      records_staged: number
      records_ready: number
      records_promoted: number
      canonical_orders_created: number
      canonical_products_created: number
      provider_write_count: number
      sync_cursor_advanced: boolean
      started_at: Date
      completed_at: Date | null
      expires_at: Date
      records_rejected: number
      normalization_rejections: Array<{
        resourceType: 'order' | 'product'
        externalId: string
        sourceHash: string
        errorCode: string
        safeMessage: string
      }>
    }>(
      `SELECT id::text, global_id, resource, workflow_state, records_seen,
              records_staged, records_ready, records_promoted, records_failed,
              canonical_orders_created, canonical_products_created,
              provider_write_count,
              sync_cursor_advanced, started_at, completed_at, expires_at,
              CASE
                WHEN stage.payload->>'recordsRejected' ~ '^[0-9]{1,9}$'
                  THEN (stage.payload->>'recordsRejected')::integer
                ELSE 0
              END AS records_rejected,
              COALESCE(
                stage.payload->'normalizationRejections',
                '[]'::jsonb
              ) AS normalization_rejections
       FROM operations_commerce_intake_runs run
       LEFT JOIN LATERAL (
         SELECT event.payload
         FROM audit_events event
         WHERE event.organization_id = run.organization_id
           AND event.event_type = 'commerce.intake.staged'
           AND event.aggregate_type = 'operations.commerce_intake_run'
           AND event.aggregate_id = run.global_id
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
       ) stage ON true
       WHERE run.organization_id = $1::uuid
         AND run.integration_account_id = $2::uuid
       ORDER BY run.created_at DESC, run.id DESC
       LIMIT 1`,
      [account.organization_id, account.id],
    )
    const run = runResult.rows[0] || null
    await client.query(
      `UPDATE operations_commerce_intake_continuations
       SET cursor_state = 'expired',
           cursor_ciphertext = NULL,
           cursor_iv = NULL,
           cursor_tag = NULL,
           cursor_hash = NULL,
           encryption_version = NULL,
           row_version = row_version + 1,
           updated_by = 'system:commerce-intake',
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND cursor_state = 'available'
         AND (
           expires_at <= now()
           OR credential_version <> $3::integer
         )`,
      [
        account.organization_id,
        account.id,
        account.credential_version,
      ],
    )
    await client.query(
      `UPDATE operations_commerce_intake_read_intents
       SET intent_state = 'expired',
           row_version = row_version + 1,
           updated_by = 'system:commerce-intake',
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND intent_state = 'prepared'
         AND (
           expires_at <= now()
           OR credential_version <> $3::integer
         )`,
      [
        account.organization_id,
        account.id,
        account.credential_version,
      ],
    )
    const continuationResult = await client.query<{
      run_global_id: string
      intake_mode: 'operational'
      resource: 'orders' | 'products'
      batch_number: number
      cursor_state:
        | 'available'
        | 'exhausted'
        | 'invalid'
        | 'expired'
      provider_rows_seen: number
      eligible_orders_seen: number
    }>(
      `SELECT continuation_run.global_id AS run_global_id,
              continuation.intake_mode,
              continuation.resource,
              continuation.batch_number,
              CASE
                WHEN continuation.cursor_state = 'available'
                     AND (
                       continuation.expires_at <= now()
                       OR continuation.credential_version
                          <> $3::integer
                     )
                  THEN 'expired'
                ELSE continuation.cursor_state
              END AS cursor_state,
              continuation.provider_rows_seen,
              continuation.eligible_orders_seen
       FROM operations_commerce_intake_continuations continuation
       JOIN operations_commerce_intake_runs continuation_run
         ON continuation_run.organization_id = continuation.organization_id
        AND continuation_run.integration_account_id
            = continuation.integration_account_id
        AND continuation_run.pipeline_id = continuation.pipeline_id
        AND continuation_run.id = continuation.run_id
       WHERE continuation.organization_id = $1::uuid
         AND continuation.integration_account_id = $2::uuid
         AND continuation.cursor_state NOT IN ('consumed', 'superseded')
       ORDER BY continuation.created_at DESC, continuation.id DESC`,
      [
        account.organization_id,
        account.id,
        account.credential_version,
      ],
    )
    const continuation = continuationResult.rows[0] || null
    const continuations = {
      orders: continuationResult.rows.find(
        (row) => row.resource === 'orders',
      ) || null,
      products: continuationResult.rows.find(
        (row) => row.resource === 'products',
      ) || null,
    }
    const candidates = (
      await client.query<CandidateRow>(
        `${CANDIDATE_SELECT}
         WHERE candidate.organization_id = $1::uuid
           AND candidate.integration_account_id = $2::uuid
           AND candidate.expires_at > now()
           AND candidate.workflow_state <> 'expired'
           AND run.expires_at > now()
           AND run.workflow_state <> 'expired'
           AND candidate.id IN (
             SELECT DISTINCT ON (selected.external_order_id) selected.id
             FROM operations_commerce_order_candidates selected
             JOIN operations_commerce_intake_runs selected_run
               ON selected_run.organization_id = selected.organization_id
              AND selected_run.integration_account_id
                  = selected.integration_account_id
              AND selected_run.pipeline_id = selected.pipeline_id
              AND selected_run.id = selected.run_id
             WHERE selected.organization_id = $1::uuid
               AND selected.integration_account_id = $2::uuid
               AND selected.expires_at > now()
               AND selected.workflow_state <> 'expired'
               AND selected_run.expires_at > now()
               AND selected_run.workflow_state <> 'expired'
             ORDER BY
               selected.external_order_id,
               CASE
                 WHEN selected.workflow_state = 'promoted'
                      OR selected.canonical_order_id IS NOT NULL
                   THEN 0
                 ELSE 1
               END,
               selected.observed_at DESC,
               selected.created_at DESC,
               selected.id DESC
           )
         ORDER BY candidate.provider_created_at DESC NULLS LAST,
                  candidate.created_at DESC,
                  candidate.id DESC`,
        [account.organization_id, account.id],
      )
    ).rows
    const candidateIds = candidates.map((candidate) => candidate.id)
    const allLines = candidateIds.length
      ? (
          await client.query<CandidateLineRow>(
            `${LINE_SELECT}
             WHERE line.organization_id = $1::uuid
               AND line.integration_account_id = $2::uuid
               AND line.order_candidate_id = ANY($3::uuid[])
             ORDER BY line.order_candidate_id, line.created_at, line.id`,
            [account.organization_id, account.id, candidateIds],
          )
        ).rows
      : []
    const linesByCandidate = new Map<string, CandidateLineRow[]>()
    for (const line of allLines) {
      const values = linesByCandidate.get(line.order_candidate_id) || []
      values.push(line)
      linesByCandidate.set(line.order_candidate_id, values)
    }

    const productCandidates = (
      await client.query<ProductCandidateRow>(
        `${PRODUCT_CANDIDATE_SELECT}
         WHERE candidate.organization_id = $1::uuid
           AND candidate.integration_account_id = $2::uuid
           AND candidate.expires_at > now()
           AND candidate.workflow_state <> 'expired'
           AND run.expires_at > now()
           AND run.workflow_state <> 'expired'
           AND candidate.id IN (
             SELECT DISTINCT ON (selected.external_variant_id) selected.id
             FROM operations_commerce_product_candidates selected
             JOIN operations_commerce_intake_runs selected_run
               ON selected_run.organization_id = selected.organization_id
              AND selected_run.integration_account_id
                    = selected.integration_account_id
              AND selected_run.pipeline_id = selected.pipeline_id
              AND selected_run.id = selected.run_id
             WHERE selected.organization_id = $1::uuid
               AND selected.integration_account_id = $2::uuid
               AND selected.expires_at > now()
               AND selected.workflow_state <> 'expired'
               AND selected_run.expires_at > now()
               AND selected_run.workflow_state <> 'expired'
             ORDER BY selected.external_variant_id,
                      selected.observed_at DESC,
                      selected.created_at DESC,
                      selected.id DESC
           )
         ORDER BY candidate.provider_updated_at DESC NULLS LAST,
                  candidate.observed_at DESC,
                  candidate.created_at DESC,
                  candidate.id DESC`,
        [account.organization_id, account.id],
      )
    ).rows

    const productRows = await client.query<{
      id: string
      reference_code: string
      name: string
      sku: string | null
      profile_global_id: string | null
      profile_name: string | null
      weight_grams: number | null
      length_mm: number | null
      width_mm: number | null
      height_mm: number | null
    }>(
      `SELECT product.id::text, product.reference_code, product.name,
              product.sku, profile.global_id AS profile_global_id,
              profile.profile_name, profile.weight_grams, profile.length_mm,
              profile.width_mm, profile.height_mm
       FROM crm_products product
       LEFT JOIN operations_product_package_profiles profile
         ON profile.organization_id = $1::uuid
        AND profile.pipeline_id = product.pipeline_id
        AND profile.product_id = product.id
        AND profile.active = true
       WHERE product.pipeline_id = $2::uuid
         AND COALESCE(lower(product.source_payload->>'archived'), 'false')
             NOT IN ('true', '1', 'yes')
       ORDER BY lower(product.name), product.id,
                profile.is_default DESC NULLS LAST,
                lower(profile.profile_name)
       LIMIT 2000`,
      [account.organization_id, account.pipeline_id],
    )
    const productCatalogMap = new Map<string, {
      globalId: string
      name: string
      sku: string | null
      packageProfiles: Array<{
        globalId: string
        label: string
        weightGrams: number
        dimensionsMm: { length: number; width: number; height: number }
      }>
    }>()
    for (const row of productRows.rows) {
      const product = productCatalogMap.get(row.id) || {
        globalId: row.reference_code,
        name: row.name,
        sku: row.sku,
        packageProfiles: [],
      }
      if (
        row.profile_global_id
        && row.profile_name
        && row.weight_grams
        && row.length_mm
        && row.width_mm
        && row.height_mm
      ) {
        product.packageProfiles.push({
          globalId: row.profile_global_id,
          label: row.profile_name,
          weightGrams: row.weight_grams,
          dimensionsMm: {
            length: row.length_mm,
            width: row.width_mm,
            height: row.height_mm,
          },
        })
      }
      productCatalogMap.set(row.id, product)
    }
    const customers = await client.query<{
      reference_code: string
      name: string
      email: string | null
    }>(
      `SELECT reference_code, name, email
       FROM crm_organizations
       WHERE pipeline_id = $1::uuid
         AND relationship_type = 'customer'
         AND COALESCE(lower(source_payload->>'archived'), 'false')
             NOT IN ('true', '1', 'yes')
       ORDER BY lower(name), id
       LIMIT 1000`,
      [account.pipeline_id],
    )
    const openRejections = await client.query<{
      global_id: string
      row_version: string
      resource_type: 'order' | 'product'
      external_id: string
      source_hash: string
      error_code: string
      safe_message: string
    }>(
      `SELECT global_id, row_version::text, resource_type, external_id,
              source_hash, error_code, safe_message
       FROM operations_commerce_intake_rejections
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND disposition = 'open'
         AND expires_at > now()
       ORDER BY created_at DESC, id DESC
       LIMIT 500`,
      [account.organization_id, account.id],
    )
    const evidence = await client.query<{
      provider_reads: string
      failed_provider_reads: string
      canonical_orders_created: string
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM operations_commerce_provider_attempts
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND action = 'commerce.intake.read'
             AND state = 'succeeded'
         ) AS provider_reads,
         (
           SELECT count(*)::text
           FROM operations_commerce_provider_attempts
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND action = 'commerce.intake.read'
             AND state <> 'succeeded'
         ) AS failed_provider_reads,
         (
           SELECT count(*)::text
           FROM operations_commerce_order_candidates
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND workflow_state = 'promoted'
         ) AS canonical_orders_created`,
      [account.organization_id, account.id],
    )
    const mappedCandidates = candidates.map((candidate) => {
      let party: Record<string, unknown> | null = null
      let address: Record<string, unknown> | null = null
      try {
        party = encryptedSnapshot(candidate, input.accountGlobalId, 'party')
      } catch {
        party = null
      }
      try {
        address = encryptedSnapshot(candidate, input.accountGlobalId, 'ship_to')
      } catch {
        address = null
      }
      const lines = linesByCandidate.get(candidate.id) || []
      const blockerCodes = visibleCandidateBlockingCodes(candidate, lines)
      return {
        globalId: candidate.global_id,
        rowVersion: Number(candidate.row_version),
        externalOrderId: candidate.external_order_id,
        orderNumber: candidate.order_number_snapshot,
        state: candidate.workflow_state,
        providerStatus: candidate.provider_order_status_raw,
        financialStatus: candidate.provider_financial_status_raw,
        fulfillmentStatus: candidate.provider_fulfillment_status_raw,
        returnStatus: candidate.provider_return_status_raw,
        normalizedOrderStatus: candidate.normalized_order_status,
        normalizedPaymentStatus: candidate.normalized_payment_status,
        normalizedFulfillmentStatus:
          candidate.normalized_fulfillment_status,
        normalizedReturnStatus: candidate.normalized_return_status,
        currency: candidate.currency_code,
        subtotalMinor: safeMinor(candidate.subtotal_minor),
        totalMinor: safeMinor(candidate.total_minor),
        requiresShipping: candidate.requires_shipping,
        sourceUpdatedAt: iso(candidate.provider_updated_at)
          || iso(candidate.observed_at),
        blockers: blockerCodes.map(blocker),
        customer: {
          snapshotName: party
            ? String(
                party.organizationName
                || party.contactName
                || '',
              ) || null
            : null,
          snapshotEmail: party
            ? String(party.email || '') || null
            : null,
          resolvedCustomerGlobalId: candidate.customer_global_id,
          status: candidate.customer_resolution_state,
        },
        shipTo: {
          address: address
            ? {
                name: String(address.name || '') || null,
                line1: String(address.line1 || '') || null,
                line2: String(address.line2 || '') || null,
                city: String(address.city || '') || null,
                region: String(address.region || '') || null,
                postalCode: String(address.postalCode || '') || null,
                country: String(
                  address.countryCode || address.country || '',
                ) || null,
              }
            : null,
          status: candidate.ship_to_snapshot_state,
          source: candidate.ship_to_snapshot_source,
        },
        delivery: {
          requestedDeliveryAt:
            iso(candidate.provider_requested_delivery_at)
            || iso(candidate.requested_delivery_at),
          selectedDeliveryAt: iso(candidate.requested_delivery_at),
          source: candidate.delivery_resolution_state,
          status: candidate.delivery_resolution_state,
        },
        lines: lines.map((line) => ({
          globalId: line.global_id,
          externalLineId: line.external_line_id,
          externalProductId: line.external_product_id,
          externalVariantId: line.external_variant_id,
          sku: line.sku_snapshot,
          title: line.product_title_snapshot,
          variantTitle: line.variant_title_snapshot,
          // `quantity` is the canonical work quantity. Preserve the provider
          // lifecycle breakdown beside it so the operator can see why a
          // partially fulfilled Shopify line will not be fulfilled twice.
          quantity: safeNumber(line.unfulfilled_quantity),
          orderedQuantity: safeNumber(line.ordered_quantity),
          currentQuantity: safeNumber(line.current_quantity),
          cancelledQuantity: safeNumber(line.cancelled_quantity),
          removedOrRefundedQuantity: candidate.provider === 'shopify'
            ? safeNumber(line.cancelled_quantity)
            : null,
          fulfilledQuantity: safeNumber(line.fulfilled_quantity),
          unfulfilledQuantity: safeNumber(line.unfulfilled_quantity),
          // Shopify order/line fields do not distinguish an exact returned
          // quantity. Keep the schema's compatibility zero internal and
          // expose unknown instead of asserting that no unit was returned.
          returnedQuantity: candidate.provider === 'shopify'
            ? null
            : safeNumber(line.returned_quantity),
          requiresShipping: line.requires_shipping,
          unitPriceMinor: safeMinor(
            line.resolved_unit_price_minor || line.unit_price_minor,
          ),
          currency: line.resolved_currency_code || line.currency_code,
          priceStatus: line.price_resolution_state,
          mappingStatus: line.mapping_state,
          productGlobalId: line.product_global_id,
          packageStatus: line.packaging_state,
          packageProfileGlobalId: line.package_profile_global_id,
          weightGrams: line.weight_grams,
          dimensionsMm: line.length_mm && line.width_mm && line.height_mm
            ? {
                length: line.length_mm,
                width: line.width_mm,
                height: line.height_mm,
              }
            : null,
          blockers: dynamicLineBlockingCodes(line).map(blocker),
        })),
        canonicalOrderGlobalId: candidate.canonical_order_global_id,
        unsupportedReason: candidate.unsupported_reason_detail
          || candidate.unsupported_reason_code,
      }
    })
    const mappedProductCandidates = productCandidates.map((candidate) => ({
      globalId: candidate.global_id,
      rowVersion: Number(candidate.row_version),
      externalProductId: candidate.external_product_id,
      externalVariantId: candidate.external_variant_id,
      externalInventoryItemId: candidate.external_inventory_item_id,
      sku: candidate.sku_snapshot,
      barcode: candidate.barcode_snapshot,
      productTitle: candidate.product_title_snapshot,
      variantTitle: candidate.variant_title_snapshot,
      vendor: candidate.vendor_snapshot,
      productType: candidate.product_type_snapshot,
      selectedOptions: candidate.normalized_options,
      providerStatus: candidate.provider_status_raw,
      normalizedStatus: candidate.normalized_status,
      state: candidate.workflow_state,
      mappingStatus: candidate.mapping_state,
      productGlobalId: candidate.product_global_id,
      productMappingGlobalId: candidate.product_mapping_global_id,
      unitMultiplier: safeNumber(candidate.unit_multiplier),
      currency: candidate.currency_code,
      priceMinor: safeMinor(candidate.price_minor),
      compareAtPriceMinor: safeMinor(candidate.compare_at_price_minor),
      taxable: candidate.taxable,
      requiresShipping: candidate.requires_shipping,
      inventoryQuantity: safeNumber(candidate.inventory_quantity),
      weightGrams: candidate.weight_grams,
      sourceUpdatedAt: iso(candidate.provider_updated_at)
        || iso(candidate.observed_at),
      blockers: ['failed', 'expired'].includes(candidate.workflow_state)
        ? []
        : candidate.blocking_codes.map(blocker),
      unsupportedReason: candidate.unsupported_reason_detail
        || candidate.unsupported_reason_code,
    }))
    const evidenceRow = evidence.rows[0]
    type ContinuationStateRow = (typeof continuationResult.rows)[number]
    const paginationState = (
      value: ContinuationStateRow | null,
    ) => value
      ? {
          mode: value.intake_mode,
          resource: value.resource,
          consistencyMode: account.provider === 'shopify'
            ? 'provider_time_fenced' as const
            : 'provider_cursor_live' as const,
          batchNumber: value.batch_number,
          runGlobalId: value.run_global_id,
          continuationRunGlobalId:
            value.cursor_state === 'available'
              ? value.run_global_id
              : null,
          hasNextBatch: value.cursor_state === 'available',
          sessionComplete: value.cursor_state === 'exhausted',
          restartRequired:
            value.cursor_state === 'invalid'
            || value.cursor_state === 'expired',
          state: value.cursor_state,
          providerRowsSeen: value.provider_rows_seen,
          eligibleOrdersSeen: value.eligible_orders_seen,
        }
      : null
    return {
      accountGlobalId: input.accountGlobalId,
      provider: account.provider,
      policy: {
        version: POLICY_VERSION,
        defaultSlaPolicyVersion: DEFAULT_SLA_POLICY_VERSION,
        retentionDays: 30,
        activationState: account.activation_state,
        operatorCommandsAllowed: ['shadow', 'active'].includes(
          account.activation_state,
        ),
        providerWritesAllowed: false,
        syncCursorAdvanceAllowed: false,
      },
      run: run
        ? {
            globalId: run.global_id,
            resource: run.resource === 'products'
              ? 'products'
              : 'orders',
            state: run.workflow_state,
            startedAt: iso(run.started_at),
            completedAt: iso(run.completed_at),
            expiresAt: iso(run.expires_at),
            recordsSeen: run.records_seen,
            recordsStaged: run.records_staged,
            recordsRejected: run.records_rejected,
            candidateScope:
              'latest_relevant_unexpired_per_external_order',
            productCandidateScope:
              'latest_unexpired_per_account_provider_variant',
            recordsHeld: mappedCandidates.filter((candidate) => (
              candidate.state === 'held' || candidate.state === 'resolving'
            )).length,
            recordsReady: mappedCandidates.filter(
              (candidate) => candidate.state === 'ready',
            ).length,
            recordsPromoted: mappedCandidates.filter(
              (candidate) => candidate.state === 'promoted',
            ).length,
            latestRunRecordsReady: run.records_ready,
            latestRunRecordsPromoted: run.records_promoted,
            latestRunCanonicalProductsCreated:
              run.canonical_products_created,
            productRecordsHeld: mappedProductCandidates.filter(
              (candidate) => (
                candidate.state === 'held'
                || candidate.state === 'resolving'
              ),
            ).length,
            productRecordsReady: mappedProductCandidates.filter(
              (candidate) => candidate.state === 'ready',
            ).length,
            productRecordsExcluded: mappedProductCandidates.filter(
              (candidate) => candidate.state === 'failed',
            ).length,
            providerReads: 1,
            providerWrites: run.provider_write_count,
            syncCursorAdvanced: run.sync_cursor_advanced,
          }
        : null,
      pagination: paginationState(continuation),
      paginations: {
        orders: paginationState(continuations.orders),
        products: paginationState(continuations.products),
      },
      candidates: mappedCandidates,
      productCandidates: mappedProductCandidates,
      rejections: openRejections.rows.map((rejection) => ({
        globalId: rejection.global_id,
        rowVersion: Number(rejection.row_version),
        resourceType: rejection.resource_type,
        externalId: rejection.external_id,
        sourceHash: rejection.source_hash,
        errorCode: rejection.error_code,
        safeMessage: rejection.safe_message,
      })),
      productCatalog: [...productCatalogMap.values()],
      customerCatalog: customers.rows.map((customer) => ({
        globalId: customer.reference_code,
        name: customer.name,
        email: customer.email,
      })),
      evidence: {
        providerReads: Number(evidenceRow?.provider_reads || 0),
        failedProviderReads: Number(evidenceRow?.failed_provider_reads || 0),
        providerWrites: 0,
        canonicalOrdersCreated: Number(
          evidenceRow?.canonical_orders_created || 0,
        ),
        syncCursorAdvanced: false,
        inventoryWrites: 0,
        reservationWrites: 0,
        fulfillmentWrites: 0,
        shipmentWrites: 0,
      },
    }
  })
}

function replayPayload(receipt: ReceiptRow) {
  return {
    ...(receipt.result_payload || {}),
    replayed: true,
  }
}

export async function resolveCommerceProductCandidateInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  candidateRowVersion: number
  resolution:
    | {
        mode: 'existing'
        productGlobalId: string
      }
    | {
        mode: 'create'
        name: string
        sku: string | null
        unitPriceMinor: number
        currency: string
      }
    | {
        mode: 'exclude'
        reasonCode: string
        reason: string
      }
}) {
  return withTransaction(async (client) => {
    const safeReasonCode = input.resolution.mode === 'exclude'
      ? input.resolution.reasonCode
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.:-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 128)
      : null
    const safeReason = input.resolution.mode === 'exclude'
      ? input.resolution.reason.trim()
      : null
    if (
      safeReasonCode !== null
      && !/^[a-z][a-z0-9_.:-]{0,127}$/.test(safeReasonCode)
    ) {
      intakeError(
        'COMMERCE_INTAKE_UNSUPPORTED_REASON_INVALID',
        'Use a short reason code beginning with a letter',
        422,
      )
    }
    if (
      safeReason !== null
      && (
        safeReason.length < 1
        || safeReason.length > 1000
        || /[\p{C}]/u.test(safeReason)
      )
    ) {
      intakeError(
        'COMMERCE_INTAKE_UNSUPPORTED_REASON_INVALID',
        'Enter a reason between 1 and 1000 readable characters',
        422,
      )
    }
    if (input.resolution.mode === 'create') {
      const name = input.resolution.name.trim()
      const sku = input.resolution.sku?.trim() || null
      const currency = input.resolution.currency.trim().toUpperCase()
      if (
        name.length < 1
        || name.length > 255
        || /[\p{C}]/u.test(name)
      ) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_NAME_INVALID',
          'Enter a product name between 1 and 255 readable characters',
          422,
        )
      }
      if (sku && (sku.length > 25 || /[\p{C}]/u.test(sku))) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_SKU_INVALID',
          'Product SKU must be 25 readable characters or fewer',
          422,
        )
      }
      if (!/^[A-Z]{3}$/.test(currency)) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_CURRENCY_INVALID',
          'Choose a three-letter product currency',
          422,
        )
      }
      if (
        !Number.isSafeInteger(input.resolution.unitPriceMinor)
        || input.resolution.unitPriceMinor < 0
      ) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_PRICE_INVALID',
          'Enter a non-negative product price in minor units',
          422,
        )
      }
    }
    const started = await commandStart(
      client,
      input,
      'commerce.intake.resolve_product_candidate',
      {
        resolution: input.resolution.mode === 'exclude'
          ? {
              mode: 'exclude',
              reasonCode: safeReasonCode,
              reason: safeReason,
            }
          : input.resolution,
      },
    )
    if (started.replayed) return replayPayload(started.receipt)
    const candidate = await lockProductCandidate(client, {
      organizationId: started.account.organization_id,
      integrationAccountId: started.account.id,
      candidateGlobalId: input.candidateGlobalId,
      candidateRowVersion: input.candidateRowVersion,
    })

    if (input.resolution.mode === 'exclude') {
      await client.query(
        `UPDATE operations_commerce_product_candidates
         SET mapping_state = 'unsupported',
             product_id = NULL,
             product_mapping_id = NULL,
             unsupported_reason_code = $2,
             unsupported_reason_detail = $3,
             workflow_state = 'failed',
             last_error_code = $2,
             blocking_codes = ARRAY[$2]::text[],
             row_version = row_version + 1,
             updated_by = $4,
             updated_at = now()
         WHERE id = $1::uuid`,
        [
          candidate.id,
          safeReasonCode,
          safeReason,
          input.actorEmail,
        ],
      )
      candidate.mapping_state = 'unsupported'
      candidate.product_id = null
      candidate.product_global_id = null
      candidate.product_mapping_id = null
      candidate.product_mapping_global_id = null
      candidate.unsupported_reason_code = safeReasonCode
      candidate.unsupported_reason_detail = safeReason
      candidate.workflow_state = 'failed'
      candidate.blocking_codes = [safeReasonCode as string]
      candidate.row_version = String(Number(candidate.row_version) + 1)
      await recordDecision(client, {
        candidate,
        targetType: 'product_candidate',
        targetGlobalId: candidate.global_id,
        targetSourceRevision: candidate.source_revision,
        targetSourceHash: candidate.source_hash,
        decisionType: 'unsupported_acknowledgement',
        resultingWorkflowState: 'failed',
        reasonCode: safeReasonCode as string,
        receipt: started.receipt,
        idempotencyKey: input.idempotencyKey,
        requestHash: started.requestHash,
        actorEmail: input.actorEmail,
      })
      await refreshRunCounts(client, candidate, input.actorEmail)
      const result = {
        action: 'exclude-product-candidate',
        candidateGlobalId: candidate.global_id,
        workflowState: candidate.workflow_state,
        mappingStatus: candidate.mapping_state,
        rowVersion: Number(candidate.row_version),
        reasonCode: safeReasonCode,
        reason: safeReason,
        providerWrites: 0,
        syncCursorAdvanced: false,
        replayed: false,
      }
      await completeReceipt(
        client,
        started.receipt.id,
        candidate.global_id,
        result,
      )
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'commerce.intake.product_candidate.excluded',
        aggregateType: 'operations.commerce_product_candidate',
        aggregateId: candidate.global_id,
        organizationId: candidate.organization_id,
        eventKey:
          `commerce-product-candidate:${candidate.global_id}:excluded:${input.idempotencyKey}`,
        payload: {
          provider: candidate.provider,
          externalProductIdHash: commandHash(
            candidate.external_product_id,
          ),
          externalVariantIdHash: commandHash(
            candidate.external_variant_id,
          ),
          sourceHash: candidate.source_hash,
          reasonCode: safeReasonCode,
          reason: safeReason,
          providerWrites: 0,
          syncCursorAdvanced: false,
        },
      }, client)
      return result
    }

    let product: {
      id: string
      globalId: string
      sku: string | null
    }
    let productWasCreated = false
    if (input.resolution.mode === 'existing') {
      const productResult = await client.query<{
        id: string
        reference_code: string
        sku: string | null
      }>(
        `SELECT id::text, reference_code, sku
         FROM crm_products
         WHERE pipeline_id = $1::uuid
           AND reference_code = $2
           AND COALESCE(lower(source_payload->>'archived'), 'false')
               NOT IN ('true', '1', 'yes')
         LIMIT 1
         FOR UPDATE`,
        [candidate.pipeline_id, input.resolution.productGlobalId],
      )
      const selected = productResult.rows[0]
      if (!selected) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_NOT_FOUND',
          'Select an active product from this company catalog',
          404,
        )
      }
      product = {
        id: selected.id,
        globalId: selected.reference_code,
        sku: selected.sku,
      }
    } else {
      const currency = input.resolution.currency.trim().toUpperCase()
      const decimals = commerceCurrencyMinorUnit(currency)
      const sourceKey = [
        'commerce-catalog',
        input.runtime.globalId,
        candidate.provider,
        'variant',
        candidate.external_variant_id,
      ].join(':')
      const existingSourceProduct = await client.query<{
        id: string
        reference_code: string
        sku: string | null
        archived: boolean
      }>(
        `SELECT id::text, reference_code, sku,
                COALESCE(lower(source_payload->>'archived'), 'false')
                  IN ('true', '1', 'yes') AS archived
         FROM crm_products
         WHERE pipeline_id = $1::uuid
           AND source_key = $2
         LIMIT 1
         FOR UPDATE`,
        [candidate.pipeline_id, sourceKey],
      )
      const existing = existingSourceProduct.rows[0]
      if (existing?.archived) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_SOURCE_CONFLICT',
          'This provider variant already owns an archived CRM product. Restore or select that product before mapping.',
          409,
        )
      }
      if (existing) {
        product = {
          id: existing.id,
          globalId: existing.reference_code,
          sku: existing.sku,
        }
      } else {
        const staged = await stageCrmRecordWithClient(client, {
          entity: 'products',
          pipelineId: candidate.pipeline_id,
          sourceKey,
          sourcePayload: {
            source: 'commerce_catalog_explicit_creation',
            integrationAccountGlobalId: input.runtime.globalId,
            provider: candidate.provider,
            externalProductId: candidate.external_product_id,
            externalVariantId: candidate.external_variant_id,
            externalInventoryItemId:
              candidate.external_inventory_item_id,
            candidateGlobalId: candidate.global_id,
            sourceRevision: candidate.source_revision,
            sourceHash: candidate.source_hash,
          },
          actorEmail: input.actorEmail,
          fields: {
            name: input.resolution.name.trim(),
            sku: input.resolution.sku?.trim() || undefined,
            price:
              input.resolution.unitPriceMinor / (10 ** decimals),
            currency,
            status: 'Active',
            active: true,
            description:
              `Explicitly created from ${candidate.provider} catalog variant ${candidate.global_id}.`,
          },
        })
        product = {
          id: staged.id,
          globalId: staged.referenceCode,
          sku: input.resolution.sku?.trim() || null,
        }
        productWasCreated = true
      }
    }

    const mappingMethod = productWasCreated
      ? 'product_created'
      : 'exact_variant'
    const mappingResult = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO operations_product_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
         channel_sku, external_product_id, external_variant_id,
         external_inventory_item_id, mapping_method,
         mapping_source_revision, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
         $9, $10, true, $11
       )
       ON CONFLICT (
         organization_id, integration_account_id, external_variant_id
       ) WHERE external_variant_id IS NOT NULL
       DO UPDATE SET
         pipeline_id = EXCLUDED.pipeline_id,
         product_id = EXCLUDED.product_id,
         channel_sku = EXCLUDED.channel_sku,
         external_product_id = EXCLUDED.external_product_id,
         external_inventory_item_id = EXCLUDED.external_inventory_item_id,
         mapping_method = EXCLUDED.mapping_method,
         mapping_source_revision = EXCLUDED.mapping_source_revision,
         active = true,
         updated_at = now()
       RETURNING id::text, global_id`,
      [
        candidate.organization_id,
        candidate.integration_account_id,
        candidate.pipeline_id,
        product.id,
        candidate.sku_snapshot || product.sku,
        candidate.external_product_id,
        candidate.external_variant_id,
        candidate.external_inventory_item_id,
        mappingMethod,
        candidate.source_revision,
        input.actorEmail,
      ],
    )
    const mapping = mappingResult.rows[0]
    const updated = await client.query<{
      workflow_state: string
      blocking_codes: string[]
      row_version: string
    }>(
      `UPDATE operations_commerce_product_candidates
       SET mapping_state = 'resolved',
           product_id = $2::uuid,
           product_mapping_id = $3::uuid,
           unsupported_reason_code = NULL,
           unsupported_reason_detail = NULL,
           last_error_code = NULL,
           blocking_codes = array_remove(
             blocking_codes, 'product_mapping_required'
           ),
           workflow_state = CASE
             WHEN cardinality(array_remove(
               blocking_codes, 'product_mapping_required'
             )) = 0
               THEN 'ready'
             ELSE 'resolving'
           END,
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING workflow_state, blocking_codes, row_version::text`,
      [
        candidate.id,
        product.id,
        mapping.id,
        input.actorEmail,
      ],
    )
    candidate.mapping_state = 'resolved'
    candidate.product_id = product.id
    candidate.product_global_id = product.globalId
    candidate.product_mapping_id = mapping.id
    candidate.product_mapping_global_id = mapping.global_id
    candidate.unsupported_reason_code = null
    candidate.unsupported_reason_detail = null
    candidate.workflow_state = updated.rows[0].workflow_state
    candidate.blocking_codes = updated.rows[0].blocking_codes
    candidate.row_version = updated.rows[0].row_version
    await recordDecision(client, {
      candidate,
      targetType: 'product_candidate',
      targetGlobalId: candidate.global_id,
      targetSourceRevision: candidate.source_revision,
      targetSourceHash: candidate.source_hash,
      decisionType: productWasCreated
        ? 'product_creation'
        : 'product_binding',
      resultingWorkflowState: candidate.workflow_state,
      reasonCode: productWasCreated
        ? 'catalog_product_created_and_mapped'
        : 'catalog_product_mapped',
      productId: product.id,
      productMappingId: mapping.id,
      receipt: started.receipt,
      idempotencyKey: input.idempotencyKey,
      requestHash: started.requestHash,
      actorEmail: input.actorEmail,
    })
    await refreshRunCounts(client, candidate, input.actorEmail)
    const result = {
      action: productWasCreated
        ? 'create-and-map-product-candidate'
        : 'map-product-candidate',
      candidateGlobalId: candidate.global_id,
      workflowState: candidate.workflow_state,
      mappingStatus: candidate.mapping_state,
      rowVersion: Number(candidate.row_version),
      productGlobalId: product.globalId,
      productMappingGlobalId: mapping.global_id,
      providerWrites: 0,
      syncCursorAdvanced: false,
      replayed: false,
    }
    await completeReceipt(
      client,
      started.receipt.id,
      candidate.global_id,
      result,
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.intake.product_candidate.resolved',
      aggregateType: 'operations.commerce_product_candidate',
      aggregateId: candidate.global_id,
      organizationId: candidate.organization_id,
      eventKey:
        `commerce-product-candidate:${candidate.global_id}:resolved:${input.idempotencyKey}`,
      payload: {
        provider: candidate.provider,
        externalProductIdHash: commandHash(candidate.external_product_id),
        externalVariantIdHash: commandHash(candidate.external_variant_id),
        sourceHash: candidate.source_hash,
        resolutionMode: input.resolution.mode,
        productCreated: productWasCreated,
        productGlobalId: product.globalId,
        productMappingGlobalId: mapping.global_id,
        providerWrites: 0,
        syncCursorAdvanced: false,
      },
    }, client)
    return result
  })
}

export async function excludeCommerceIntakeRejectionInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  rejectionGlobalId: string
  rejectionRowVersion: number
  reason: string
}) {
  return withTransaction(async (client) => {
    const reason = input.reason.trim()
    if (
      reason.length < 1
      || reason.length > 500
      || /[\p{C}]/u.test(reason)
    ) {
      intakeError(
        'COMMERCE_INTAKE_EXCLUSION_REASON_INVALID',
        'Enter an exclusion reason between 1 and 500 readable characters',
        422,
      )
    }
    const account = await resolveAccount(client, {
      organizationId: input.runtime.organizationId,
      accountGlobalId: input.runtime.globalId,
      forUpdate: true,
    })
    if (!['shadow', 'active'].includes(account.activation_state)) {
      intakeError(
        'COMMERCE_INTAKE_ACTIVATION_REQUIRED',
        'Open Operations and set Activation to Shadow or Active before excluding a rejected record',
      )
    }
    const requestHash = commandHash({
      policyVersion: POLICY_VERSION,
      accountGlobalId: input.runtime.globalId,
      rejectionGlobalId: input.rejectionGlobalId,
      rejectionRowVersion: input.rejectionRowVersion,
      reason,
    })
    const prepared = await prepareReceipt(client, {
      organizationId: account.organization_id,
      commandType: 'commerce.intake.exclude_rejection',
      idempotencyKey: input.idempotencyKey,
      requestHash,
      actorEmail: input.actorEmail,
    })
    if (prepared.replayed) return replayPayload(prepared.receipt)
    const result = await client.query<{
      id: string
      global_id: string
      row_version: string
      disposition: string
      resource_type: string
      external_id: string
      source_hash: string
    }>(
      `SELECT id::text, global_id, row_version::text, disposition,
              resource_type, external_id, source_hash
       FROM operations_commerce_intake_rejections
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND global_id = $3
       LIMIT 1
       FOR UPDATE`,
      [
        account.organization_id,
        account.id,
        input.rejectionGlobalId,
      ],
    )
    const rejection = result.rows[0]
    if (!rejection || rejection.disposition !== 'open') {
      intakeError(
        'COMMERCE_INTAKE_REJECTION_NOT_OPEN',
        'This rejected record is no longer open. Reload the workflow.',
        409,
      )
    }
    if (Number(rejection.row_version) !== input.rejectionRowVersion) {
      intakeError(
        'COMMERCE_INTAKE_STALE_VERSION',
        'This rejected record changed. Reload before excluding it.',
        409,
      )
    }
    await client.query(
      `UPDATE operations_commerce_intake_rejections
       SET disposition = 'excluded',
           exclusion_reason = $2,
           disposition_receipt_id = $3::uuid,
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        rejection.id,
        reason,
        prepared.receipt.id,
        input.actorEmail,
      ],
    )
    const payload = {
      action: 'exclude-rejection',
      rejectionGlobalId: rejection.global_id,
      workflowState: 'excluded',
      rowVersion: input.rejectionRowVersion + 1,
      providerWrites: 0,
      syncCursorAdvanced: false,
      replayed: false,
    }
    await completeReceipt(
      client,
      prepared.receipt.id,
      rejection.global_id,
      payload,
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.intake.rejection.excluded',
      aggregateType: 'operations.commerce_intake_rejection',
      aggregateId: rejection.global_id,
      organizationId: account.organization_id,
      eventKey:
        `commerce-intake-rejection:${rejection.global_id}:excluded:${input.idempotencyKey}`,
      payload: {
        resourceType: rejection.resource_type,
        externalIdHash: commandHash(rejection.external_id),
        sourceHash: rejection.source_hash,
        reason,
        providerWrites: 0,
        syncCursorAdvanced: false,
      },
    }, client)
    return payload
  })
}

export async function resolveCommerceCandidateProductInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  candidateRowVersion: number
  lineGlobalId: string
  product:
    | {
        mode: 'existing'
        productGlobalId: string
        unitPriceMinor: number
        currency: string
      }
    | {
        mode: 'create'
        name: string
        sku: string | null
        unitPriceMinor: number
        currency: string
      }
}) {
  return withTransaction(async (client) => {
    const started = await commandStart(
      client,
      input,
      'commerce.intake.resolve_product',
      {
        lineGlobalId: input.lineGlobalId,
        product: input.product,
      },
    )
    if (started.replayed) return replayPayload(started.receipt)
    const candidate = await lockCandidate(client, input)
    const lineResult = await client.query<CandidateLineRow>(
      `${LINE_SELECT}
       WHERE line.organization_id = $1::uuid
         AND line.integration_account_id = $2::uuid
         AND line.order_candidate_id = $3::uuid
         AND line.global_id = $4
       FOR UPDATE OF line`,
      [
        candidate.organization_id,
        candidate.integration_account_id,
        candidate.id,
        input.lineGlobalId,
      ],
    )
    const line = lineResult.rows[0]
    if (!line) {
      intakeError(
        'COMMERCE_INTAKE_LINE_NOT_FOUND',
        'The selected provider line is no longer available',
        404,
      )
    }
    let product: {
      id: string
      globalId: string
      sku: string | null
    }
    if (input.product.mode === 'existing') {
      const result = await client.query<{
        id: string
        reference_code: string
        sku: string | null
      }>(
        `SELECT id::text, reference_code, sku
         FROM crm_products
         WHERE pipeline_id = $1::uuid
           AND reference_code = $2
           AND COALESCE(lower(source_payload->>'archived'), 'false')
               NOT IN ('true', '1', 'yes')
         LIMIT 1
         FOR UPDATE`,
        [candidate.pipeline_id, input.product.productGlobalId],
      )
      const selected = result.rows[0]
      if (!selected) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_NOT_FOUND',
          'Select an active ClawPilot product',
          404,
        )
      }
      product = {
        id: selected.id,
        globalId: selected.reference_code,
        sku: selected.sku,
      }
    } else {
      const decimals = commerceCurrencyMinorUnit(input.product.currency)
      const price = input.product.unitPriceMinor / (10 ** decimals)
      const providerProductIdentity = (
        line.external_variant_id
        || line.external_product_id
        || line.external_line_id
      )
      const staged = await stageCrmRecordWithClient(client, {
        entity: 'products',
        pipelineId: candidate.pipeline_id,
        sourceKey:
          `commerce-intake:${input.runtime.globalId}:${candidate.provider}:${providerProductIdentity}`,
        sourcePayload: {
          source: 'commerce_intake_explicit_creation',
          integrationAccountGlobalId: input.runtime.globalId,
          provider: candidate.provider,
          providerProductIdentity,
          candidateGlobalId: candidate.global_id,
          lineGlobalId: line.global_id,
          sourceHash: line.source_hash,
        },
        actorEmail: input.actorEmail,
        fields: {
          name: input.product.name,
          sku: input.product.sku || undefined,
          price,
          currency: input.product.currency,
          status: 'Active',
          active: true,
          description: `Explicitly created while resolving ${candidate.provider} order ${candidate.order_number_snapshot}.`,
        },
      })
      product = {
        id: staged.id,
        globalId: staged.referenceCode,
        sku: input.product.sku,
      }
    }
    const mappingIdentity = line.external_variant_id
    let mapping: {
      id: string
      global_id: string
    } | null = null
    if (mappingIdentity) {
      const mappingMethod = input.product.mode === 'create'
        ? 'product_created'
        : 'exact_variant'
      const mappingResult = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_product_mappings (
           organization_id, integration_account_id, pipeline_id, product_id,
           channel_sku, external_product_id, external_variant_id,
           external_inventory_item_id, mapping_method,
           mapping_source_revision, active, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
           $9, $10, true, $11
         )
         ON CONFLICT (
           organization_id, integration_account_id, external_variant_id
         ) WHERE external_variant_id IS NOT NULL
         DO UPDATE SET
           pipeline_id = EXCLUDED.pipeline_id,
           product_id = EXCLUDED.product_id,
           channel_sku = EXCLUDED.channel_sku,
           external_product_id = EXCLUDED.external_product_id,
           external_inventory_item_id = EXCLUDED.external_inventory_item_id,
           mapping_method = EXCLUDED.mapping_method,
           mapping_source_revision = EXCLUDED.mapping_source_revision,
           active = true,
           updated_at = now()
         RETURNING id::text, global_id`,
        [
          candidate.organization_id,
          candidate.integration_account_id,
          candidate.pipeline_id,
          product.id,
          line.sku_snapshot || product.sku,
          line.external_product_id,
          mappingIdentity,
          line.external_inventory_item_id,
          mappingMethod,
          line.source_revision,
          input.actorEmail,
        ],
      )
      mapping = mappingResult.rows[0]
    }
    const providerPriceSelected = (
      line.unit_price_minor !== null
      && line.currency_code === input.product.currency
      && BigInt(line.unit_price_minor) === BigInt(input.product.unitPriceMinor)
    )
    const priceResolution = providerPriceSelected ? 'provider' : 'manual'
    await client.query(
      `UPDATE operations_commerce_order_candidate_lines
       SET mapping_state = 'resolved',
           product_id = $2::uuid,
           product_mapping_id = $3::uuid,
           price_resolution_state = $4,
           resolved_currency_code = $5,
           resolved_unit_price_minor = $6,
           resolved_subtotal_minor = NULL,
           resolved_discount_minor = NULL,
           resolved_brand_discount_minor = NULL,
           resolved_tax_minor = NULL,
           resolved_other_adjustment_minor = NULL,
           resolved_total_minor = NULL,
           workflow_state = 'resolving',
           blocking_codes = array_remove(
             array_remove(blocking_codes, 'product_mapping_required'),
             'line_price_required'
           ),
           row_version = row_version + 1,
           updated_by = $7,
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        line.id,
        product.id,
        mapping?.id || null,
        priceResolution,
        input.product.currency,
        input.product.unitPriceMinor,
        input.actorEmail,
      ],
    )
    if (mapping) await client.query(
      `UPDATE operations_commerce_product_candidates
       SET mapping_state = 'resolved',
           product_id = $2::uuid,
           product_mapping_id = $3::uuid,
           workflow_state = 'resolving',
           blocking_codes = array_remove(
             blocking_codes, 'product_mapping_required'
           ),
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $5::uuid
         AND run_id = $6::uuid
         AND external_variant_id = $7`,
      [
        candidate.organization_id,
        product.id,
        mapping.id,
        input.actorEmail,
        candidate.integration_account_id,
        candidate.run_id,
        mappingIdentity,
      ],
    )
    const advanced = await advanceCandidate(
      client,
      candidate,
      input.actorEmail,
      'resolving',
    )
    await recordDecision(client, {
      candidate,
      targetType: 'order_candidate_line',
      targetGlobalId: line.global_id,
      targetSourceRevision: line.source_revision,
      targetSourceHash: line.source_hash,
      decisionType: input.product.mode === 'create'
        ? 'product_creation'
        : 'product_binding',
      resultingWorkflowState: advanced.candidate.workflow_state,
      reasonCode: input.product.mode === 'create'
        ? 'product_created_and_bound'
        : 'existing_product_bound',
      productId: product.id,
      productMappingId: mapping?.id || null,
      receipt: started.receipt,
      idempotencyKey: input.idempotencyKey,
      requestHash: started.requestHash,
      actorEmail: input.actorEmail,
    })
    const result = commandResult(
      advanced.candidate,
      'resolve-product',
      {
        replayed: false,
        lineGlobalId: line.global_id,
        productGlobalId: product.globalId,
        productMappingGlobalId: mapping?.global_id || null,
        priceResolution,
      },
    )
    await completeReceipt(
      client,
      started.receipt.id,
      candidate.global_id,
      result,
    )
    return result
  })
}

export async function resolveCommerceCandidateCustomerInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  candidateRowVersion: number
  customer:
    | { mode: 'existing'; customerGlobalId: string }
    | {
        mode: 'create'
        name: string
        email: string | null
        phone: string | null
      }
}) {
  return withTransaction(async (client) => {
    const started = await commandStart(
      client,
      input,
      'commerce.intake.resolve_customer',
      { customer: input.customer },
    )
    if (started.replayed) return replayPayload(started.receipt)
    const candidate = await lockCandidate(client, input)
    let party: Record<string, unknown> | null = null
    try {
      party = encryptedSnapshot(candidate, input.runtime.globalId, 'party')
    } catch {
      party = null
    }
    const externalIdentity = party?.externalIdentity
    const externalCustomerId = externalIdentity
      && typeof externalIdentity === 'object'
      && !Array.isArray(externalIdentity)
      && typeof (externalIdentity as Record<string, unknown>).value === 'string'
      ? String((externalIdentity as Record<string, unknown>).value).trim()
        || null
      : null
    let customer: {
      id: string
      globalId: string
      name: string
    } | null = null
    let customerResolutionMethod:
      | 'created'
      | 'external_id'
      | 'provider_identity'
      | 'manual'
      = input.customer.mode === 'create' ? 'created' : 'manual'
    if (input.customer.mode === 'existing') {
      const selected = await client.query<{
        id: string
        reference_code: string
        name: string
      }>(
        `SELECT id::text, reference_code, name
         FROM crm_organizations
         WHERE pipeline_id = $1::uuid
           AND reference_code = $2
           AND relationship_type = 'customer'
           AND COALESCE(lower(source_payload->>'archived'), 'false')
               NOT IN ('true', '1', 'yes')
         LIMIT 1
         FOR UPDATE`,
        [candidate.pipeline_id, input.customer.customerGlobalId],
      )
      if (!selected.rows[0]) {
        intakeError(
          'COMMERCE_INTAKE_CUSTOMER_NOT_FOUND',
          'Select an active CRM customer organization',
          404,
        )
      }
      customer = {
        id: selected.rows[0].id,
        globalId: selected.rows[0].reference_code,
        name: selected.rows[0].name,
      }
    } else {
      if (externalCustomerId) {
        await acquireTransactionAdvisoryLock(
          client,
          [
            'commerce-customer-identity',
            candidate.organization_id,
            candidate.integration_account_id,
            externalCustomerId,
          ].join(':'),
        )
        const identity = await client.query<{
          entity_global_id: string
          status: string
        }>(
          `SELECT entity_global_id, status
           FROM operations_external_identifiers
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND entity_type = 'crm.organization'
             AND external_id = $3
           LIMIT 1
           FOR UPDATE`,
          [
            candidate.organization_id,
            candidate.integration_account_id,
            externalCustomerId,
          ],
        )
        const existingIdentity = identity.rows[0]
        if (existingIdentity) {
          if (existingIdentity.status !== 'active') {
            intakeError(
              'COMMERCE_INTAKE_CUSTOMER_IDENTITY_STALE',
              'The provider customer identity is stale. Repair the existing identity before creating another CRM customer',
              422,
            )
          }
          const selected = await client.query<{
            id: string
            reference_code: string
            name: string
          }>(
            `SELECT id::text, reference_code, name
             FROM crm_organizations
             WHERE pipeline_id = $1::uuid
               AND reference_code = $2
               AND relationship_type = 'customer'
               AND COALESCE(lower(source_payload->>'archived'), 'false')
                   NOT IN ('true', '1', 'yes')
             LIMIT 1
             FOR UPDATE`,
            [candidate.pipeline_id, existingIdentity.entity_global_id],
          )
          if (!selected.rows[0]) {
            intakeError(
              'COMMERCE_INTAKE_CUSTOMER_IDENTITY_STALE',
              'The provider customer identity no longer targets an active CRM customer. Repair it before continuing',
              422,
            )
          }
          customer = {
            id: selected.rows[0].id,
            globalId: selected.rows[0].reference_code,
            name: selected.rows[0].name,
          }
          customerResolutionMethod = 'external_id'
        }
      }
      if (!customer) {
        const customerIdentityKey = commerceCustomerIdentityKey(
          {
            organizationId: candidate.organization_id,
            integrationAccountId: candidate.integration_account_id,
            provider: candidate.provider,
            candidateGlobalId: candidate.global_id,
            externalCustomerId,
          },
        )
        await acquireTransactionAdvisoryLock(
          client,
          [
            'commerce-customer-crm-identity',
            candidate.pipeline_id,
            customerIdentityKey,
          ].join(':'),
        )
        const existingScopedCustomer = await client.query<{
          id: string
          reference_code: string
          name: string
          relationship_type: string
          source_payload: Record<string, unknown>
        }>(
          `SELECT id::text, reference_code, name, relationship_type,
                  source_payload
           FROM crm_organizations
           WHERE pipeline_id = $1::uuid
             AND identity_key = $2
           LIMIT 1
           FOR UPDATE`,
          [candidate.pipeline_id, customerIdentityKey],
        )
        const scopedCustomer = existingScopedCustomer.rows[0]
        if (scopedCustomer) {
          const sameCommerceScope = (
            scopedCustomer.relationship_type === 'customer'
            && scopedCustomer.source_payload?.source
              === 'commerce_intake_explicit_creation'
            && scopedCustomer.source_payload
              ?.commerceCustomerIdentityVersion === 1
            && scopedCustomer.source_payload
              ?.integrationAccountGlobalId === input.runtime.globalId
            && (
              Boolean(externalCustomerId)
              || scopedCustomer.source_payload?.candidateGlobalId
                === candidate.global_id
            )
          )
          const archived = ['true', '1', 'yes'].includes(
            String(scopedCustomer.source_payload?.archived || '')
              .trim()
              .toLowerCase(),
          )
          if (!sameCommerceScope || archived) {
            intakeError(
              'COMMERCE_INTAKE_CUSTOMER_IDENTITY_CONFLICT',
              'This provider customer identity conflicts with an unavailable CRM organization. Select an active existing customer instead',
              409,
            )
          }
          customer = {
            id: scopedCustomer.id,
            globalId: scopedCustomer.reference_code,
            name: scopedCustomer.name,
          }
          customerResolutionMethod = 'provider_identity'
        }
        if (!customer) {
          const root = await client.query<{
            id: string
            suitecrm_id: string | null
          }>(
            `SELECT id::text, suitecrm_id
             FROM crm_organizations
             WHERE pipeline_id = $1::uuid
               AND workspace_organization_id = $2::uuid
             ORDER BY
               CASE relationship_type WHEN 'workspace_root' THEN 0 ELSE 1 END,
               created_at,
               id
             LIMIT 1`,
            [candidate.pipeline_id, candidate.organization_id],
          )
          const staged = await stageCrmRecordWithClient(client, {
            entity: 'organizations',
            pipelineId: candidate.pipeline_id,
            sourceKey: customerIdentityKey,
            identityKeyOverride: customerIdentityKey,
            createOnly: true,
            sourcePayload: {
              source: 'commerce_intake_explicit_creation',
              provider: candidate.provider,
              commerceCustomerIdentityVersion: 1,
              integrationAccountGlobalId: input.runtime.globalId,
              candidateGlobalId: candidate.global_id,
              sourceHash: candidate.source_hash,
            },
            actorEmail: input.actorEmail,
            fields: {
              parentOrganizationId: root.rows[0]?.id || null,
              parentOrganizationSuiteCrmId: root.rows[0]?.suitecrm_id
                || null,
              relationshipType: 'customer',
              accountType: 'Customer',
              name: input.customer.name,
              email: input.customer.email || undefined,
              phone: input.customer.phone || undefined,
              description: `Explicitly created while resolving ${candidate.provider} order ${candidate.order_number_snapshot}.`,
            },
          })
          customer = {
            id: staged.id,
            globalId: staged.referenceCode,
            name: input.customer.name,
          }
          customerResolutionMethod = 'created'
        }
      }
    }
    if (!customer) {
      intakeError(
        'COMMERCE_INTAKE_CUSTOMER_RESOLUTION_FAILED',
        'The CRM customer could not be resolved',
        500,
      )
    }
    if (externalCustomerId) {
      const boundIdentity = await client.query<{ entity_global_id: string }>(
        `INSERT INTO operations_external_identifiers (
           organization_id, integration_account_id, entity_type,
           entity_global_id, external_id, status, match_method,
           match_evidence, last_verified_at
         ) VALUES (
           $1::uuid, $2::uuid, 'crm.organization', $3, $4, 'active', $5,
           $6::jsonb, now()
         )
         ON CONFLICT (
           organization_id, integration_account_id, entity_type, external_id
         ) DO UPDATE SET
           entity_global_id = CASE
             WHEN $7::boolean
               THEN operations_external_identifiers.entity_global_id
             ELSE EXCLUDED.entity_global_id
           END,
           status = 'active',
           match_method = EXCLUDED.match_method,
           match_evidence = EXCLUDED.match_evidence,
           last_verified_at = now()
         RETURNING entity_global_id`,
        [
          candidate.organization_id,
          candidate.integration_account_id,
          customer.globalId,
          externalCustomerId,
          customerResolutionMethod,
          JSON.stringify({
            candidateGlobalId: candidate.global_id,
            sourceHash: candidate.source_hash,
          }),
          input.customer.mode === 'create',
        ],
      )
      if (boundIdentity.rows[0]?.entity_global_id !== customer.globalId) {
        intakeError(
          'COMMERCE_INTAKE_CUSTOMER_IDENTITY_CONFLICT',
          'The provider customer identity was bound concurrently. Reload and use its existing CRM customer',
          409,
        )
      }
    }
    await client.query(
      `UPDATE operations_commerce_order_candidates
       SET customer_resolution_state = 'resolved',
           customer_match_method = $2,
           customer_id = $3::uuid,
           workflow_state = 'resolving',
           blocking_codes = array_remove(
             array_remove(
               array_remove(blocking_codes, 'customer_resolution_required'),
               'customer_redacted'
             ),
             'customer_unavailable'
           ),
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        candidate.id,
        customerResolutionMethod,
        customer.id,
        input.actorEmail,
      ],
    )
    candidate.customer_resolution_state = 'resolved'
    candidate.customer_match_method = customerResolutionMethod
    candidate.customer_id = customer.id
    candidate.workflow_state = 'resolving'
    const advanced = await advanceCandidate(
      client,
      candidate,
      input.actorEmail,
      'resolving',
    )
    await recordDecision(client, {
      candidate,
      targetType: 'order_candidate',
      targetGlobalId: candidate.global_id,
      targetSourceRevision: candidate.source_revision,
      targetSourceHash: candidate.source_hash,
      decisionType: customerResolutionMethod === 'created'
        ? 'customer_creation'
        : 'customer_binding',
      resultingWorkflowState: advanced.candidate.workflow_state,
      reasonCode: customerResolutionMethod === 'created'
        ? 'customer_created_and_bound'
        : customerResolutionMethod === 'external_id'
          ? 'external_customer_identity_reused'
          : customerResolutionMethod === 'provider_identity'
            ? 'provider_account_customer_identity_reused'
          : 'existing_customer_bound',
      customerId: customer.id,
      receipt: started.receipt,
      idempotencyKey: input.idempotencyKey,
      requestHash: started.requestHash,
      actorEmail: input.actorEmail,
    })
    const result = commandResult(
      advanced.candidate,
      'resolve-customer',
      {
        replayed: false,
        customerGlobalId: customer.globalId,
        customerName: customer.name,
        customerResolutionMethod,
      },
    )
    await completeReceipt(
      client,
      started.receipt.id,
      candidate.global_id,
      result,
    )
    return result
  })
}

export async function confirmCommerceCandidateAddressInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  candidateRowVersion: number
  address: CandidateAddress
}) {
  return withTransaction(async (client) => {
    const started = await commandStart(
      client,
      input,
      'commerce.intake.confirm_address',
      { address: input.address },
    )
    if (started.replayed) return replayPayload(started.receipt)
    const candidate = await lockCandidate(client, input)
    if (!candidate.requires_shipping) {
      intakeError(
        'COMMERCE_INTAKE_ADDRESS_NOT_REQUIRED',
        'This order does not require a shipping address',
        422,
      )
    }
    const supplied = {
      ...input.address,
      country: input.address.country.toUpperCase(),
    }
    if (!completeAddress(supplied)) {
      intakeError(
        'COMMERCE_INTAKE_ADDRESS_INCOMPLETE',
        'Complete every required ship-to field before confirming it',
        422,
      )
    }
    let providerAddress: CandidateAddress | null = null
    try {
      const snapshot = encryptedSnapshot(
        candidate,
        input.runtime.globalId,
        'ship_to',
      )
      providerAddress = snapshot ? normalizedAddress(snapshot) : null
    } catch {
      providerAddress = null
    }
    const source = providerAddress
      && canonicalJson(providerAddress) === canonicalJson(supplied)
      ? 'provider'
      : 'manual'
    const encrypted = encryptCommerceCandidateSnapshot(
      supplied,
      candidate.organization_id,
      input.runtime.globalId,
      candidate.external_order_id,
      candidate.source_hash,
      'ship_to',
    )
    await client.query(
      `UPDATE operations_commerce_order_candidates
       SET ship_to_snapshot_state = 'confirmed',
           ship_to_snapshot_source = $2,
           ship_to_snapshot_ciphertext = $3,
           ship_to_snapshot_iv = $4,
           ship_to_snapshot_tag = $5,
           ship_to_snapshot_hash = $6,
           ship_to_snapshot_encryption_version = $7,
           workflow_state = 'resolving',
           blocking_codes = array_remove(
             array_remove(
               array_remove(
                 array_remove(blocking_codes, 'ship_to_confirmation_required'),
                 'ship_to_incomplete'
               ),
               'ship_to_redacted'
             ),
             'ship_to_unavailable'
           ),
           row_version = row_version + 1,
           updated_by = $8,
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        candidate.id,
        source,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        encrypted.hash,
        encrypted.encryptionVersion,
        input.actorEmail,
      ],
    )
    candidate.ship_to_snapshot_state = 'confirmed'
    candidate.ship_to_snapshot_source = source
    candidate.ship_to_snapshot_ciphertext = encrypted.ciphertext
    candidate.ship_to_snapshot_iv = encrypted.iv
    candidate.ship_to_snapshot_tag = encrypted.tag
    candidate.workflow_state = 'resolving'
    const advanced = await advanceCandidate(
      client,
      candidate,
      input.actorEmail,
      'resolving',
    )
    await recordDecision(client, {
      candidate,
      targetType: 'order_candidate',
      targetGlobalId: candidate.global_id,
      targetSourceRevision: candidate.source_revision,
      targetSourceHash: candidate.source_hash,
      decisionType: 'address_confirmation',
      resultingWorkflowState: advanced.candidate.workflow_state,
      reasonCode: source === 'provider'
        ? 'provider_address_confirmed'
        : 'manual_address_confirmed',
      snapshotHash: encrypted.hash,
      receipt: started.receipt,
      idempotencyKey: input.idempotencyKey,
      requestHash: started.requestHash,
      actorEmail: input.actorEmail,
    })
    const result = commandResult(
      advanced.candidate,
      'confirm-address',
      {
        replayed: false,
        addressSource: source,
      },
    )
    await completeReceipt(
      client,
      started.receipt.id,
      candidate.global_id,
      result,
    )
    return result
  })
}

export async function resolveCommerceCandidateDeliveryInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  candidateRowVersion: number
  decision: {
    mode: 'provider' | 'manual' | 'default_sla'
    requestedDeliveryAt: string | null
  }
}) {
  return withTransaction(async (client) => {
    const started = await commandStart(
      client,
      input,
      'commerce.intake.resolve_delivery',
      { decision: input.decision },
    )
    if (started.replayed) return replayPayload(started.receipt)
    const candidate = await lockCandidate(client, input)
    if (!candidate.requires_shipping) {
      intakeError(
        'COMMERCE_INTAKE_DELIVERY_NOT_REQUIRED',
        'This order does not require a delivery decision',
        422,
      )
    }
    let state: 'provider' | 'manual' | 'policy'
    let requestedDeliveryAt: string
    let policyVersion: string
    if (input.decision.mode === 'provider') {
      if (!candidate.provider_requested_delivery_at) {
        intakeError(
          'COMMERCE_INTAKE_PROVIDER_DELIVERY_UNAVAILABLE',
          'The provider did not supply a requested delivery date. Enter one or use the default SLA',
          422,
        )
      }
      state = 'provider'
      requestedDeliveryAt = new Date(
        candidate.provider_requested_delivery_at,
      ).toISOString()
      policyVersion = 'provider-requested-delivery-v1'
    } else if (input.decision.mode === 'manual') {
      if (!input.decision.requestedDeliveryAt) {
        intakeError(
          'COMMERCE_INTAKE_MANUAL_DELIVERY_REQUIRED',
          'Enter the requested delivery date',
          422,
        )
      }
      state = 'manual'
      requestedDeliveryAt = new Date(
        input.decision.requestedDeliveryAt,
      ).toISOString()
      policyVersion = 'manual-delivery-v1'
    } else {
      if (!candidate.provider_created_at) {
        intakeError(
          'COMMERCE_INTAKE_DEFAULT_SLA_UNAVAILABLE',
          'The provider did not supply an order creation time. Enter the delivery date manually',
          422,
        )
      }
      state = 'policy'
      requestedDeliveryAt = new Date(
        new Date(candidate.provider_created_at).getTime()
          + DEFAULT_SLA_DAYS * 24 * 60 * 60 * 1_000,
      ).toISOString()
      policyVersion = DEFAULT_SLA_POLICY_VERSION
    }
    await client.query(
      `UPDATE operations_commerce_order_candidates
       SET delivery_resolution_state = $2,
           requested_delivery_at = $3::timestamptz,
           delivery_policy_version = $4,
           workflow_state = 'resolving',
           blocking_codes = array_remove(
             blocking_codes, 'delivery_decision_required'
           ),
           row_version = row_version + 1,
           updated_by = $5,
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        candidate.id,
        state,
        requestedDeliveryAt,
        policyVersion,
        input.actorEmail,
      ],
    )
    candidate.delivery_resolution_state = state
    candidate.requested_delivery_at = requestedDeliveryAt
    candidate.delivery_policy_version = policyVersion
    candidate.workflow_state = 'resolving'
    const advanced = await advanceCandidate(
      client,
      candidate,
      input.actorEmail,
      'resolving',
    )
    await recordDecision(client, {
      candidate,
      targetType: 'order_candidate',
      targetGlobalId: candidate.global_id,
      targetSourceRevision: candidate.source_revision,
      targetSourceHash: candidate.source_hash,
      decisionType: 'delivery_policy',
      resultingWorkflowState: advanced.candidate.workflow_state,
      reasonCode: input.decision.mode === 'default_sla'
        ? 'default_sla_applied'
        : `${input.decision.mode}_delivery_selected`,
      policyVersion,
      receipt: started.receipt,
      idempotencyKey: input.idempotencyKey,
      requestHash: started.requestHash,
      actorEmail: input.actorEmail,
    })
    const result = commandResult(
      advanced.candidate,
      'resolve-delivery',
      {
        replayed: false,
        deliverySource: state,
        requestedDeliveryAt,
        policyVersion,
      },
    )
    await completeReceipt(
      client,
      started.receipt.id,
      candidate.global_id,
      result,
    )
    return result
  })
}

export async function resolveCommerceCandidatePackageInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  candidateRowVersion: number
  lineGlobalId: string
  package:
    | { mode: 'profile'; packageProfileGlobalId: string }
    | {
        mode: 'manual'
        weightGrams: number
        dimensionsMm: { length: number; width: number; height: number }
      }
}) {
  return withTransaction(async (client) => {
    const started = await commandStart(
      client,
      input,
      'commerce.intake.resolve_package',
      {
        lineGlobalId: input.lineGlobalId,
        package: input.package,
      },
    )
    if (started.replayed) return replayPayload(started.receipt)
    const candidate = await lockCandidate(client, input)
    const selectedLine = await client.query<CandidateLineRow>(
      `${LINE_SELECT}
       WHERE line.organization_id = $1::uuid
         AND line.integration_account_id = $2::uuid
         AND line.order_candidate_id = $3::uuid
         AND line.global_id = $4
       FOR UPDATE OF line`,
      [
        candidate.organization_id,
        candidate.integration_account_id,
        candidate.id,
        input.lineGlobalId,
      ],
    )
    const line = selectedLine.rows[0]
    if (!line) {
      intakeError(
        'COMMERCE_INTAKE_LINE_NOT_FOUND',
        'The selected provider line is no longer available',
        404,
      )
    }
    if (!line.requires_shipping) {
      intakeError(
        'COMMERCE_INTAKE_PACKAGE_NOT_REQUIRED',
        'This line does not require a package',
        422,
      )
    }
    let packageProfileId: string | null = null
    let packageProfileGlobalId: string | null = null
    let source: 'profile' | 'manual'
    let values: {
      weightGrams: number
      length: number
      width: number
      height: number
    }
    if (input.package.mode === 'profile') {
      if (!line.product_id) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_REQUIRED_FOR_PACKAGE',
          'Map the product before selecting one of its package profiles',
          422,
        )
      }
      const profile = await client.query<{
        id: string
        global_id: string
        weight_grams: number
        length_mm: number
        width_mm: number
        height_mm: number
      }>(
        `SELECT id::text, global_id, weight_grams, length_mm, width_mm,
                height_mm
         FROM operations_product_package_profiles
         WHERE organization_id = $1::uuid
           AND pipeline_id = $2::uuid
           AND product_id = $3::uuid
           AND global_id = $4
           AND active = true
         LIMIT 1
         FOR UPDATE`,
        [
          candidate.organization_id,
          candidate.pipeline_id,
          line.product_id,
          input.package.packageProfileGlobalId,
        ],
      )
      if (!profile.rows[0]) {
        intakeError(
          'COMMERCE_INTAKE_PACKAGE_PROFILE_NOT_FOUND',
          'Select an active package profile for the mapped product',
          404,
        )
      }
      packageProfileId = profile.rows[0].id
      packageProfileGlobalId = profile.rows[0].global_id
      source = 'profile'
      values = {
        weightGrams: profile.rows[0].weight_grams,
        length: profile.rows[0].length_mm,
        width: profile.rows[0].width_mm,
        height: profile.rows[0].height_mm,
      }
    } else {
      source = 'manual'
      values = {
        weightGrams: input.package.weightGrams,
        length: input.package.dimensionsMm.length,
        width: input.package.dimensionsMm.width,
        height: input.package.dimensionsMm.height,
      }
    }
    await client.query(
      `UPDATE operations_commerce_order_candidate_lines
       SET packaging_state = 'resolved',
           package_profile_id = $2::uuid,
           packaging_source = $3,
           weight_grams = $4,
           length_mm = $5,
           width_mm = $6,
           height_mm = $7,
           workflow_state = 'resolving',
           blocking_codes = array_remove(
             blocking_codes, 'packaging_required'
           ),
           row_version = row_version + 1,
           updated_by = $8,
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        line.id,
        packageProfileId,
        source,
        values.weightGrams,
        values.length,
        values.width,
        values.height,
        input.actorEmail,
      ],
    )
    const advanced = await advanceCandidate(
      client,
      candidate,
      input.actorEmail,
      'resolving',
    )
    await recordDecision(client, {
      candidate,
      targetType: 'order_candidate_line',
      targetGlobalId: line.global_id,
      targetSourceRevision: line.source_revision,
      targetSourceHash: line.source_hash,
      decisionType: 'package_resolution',
      resultingWorkflowState: advanced.candidate.workflow_state,
      reasonCode: source === 'profile'
        ? 'package_profile_selected'
        : 'manual_package_recorded',
      packageProfileId,
      receipt: started.receipt,
      idempotencyKey: input.idempotencyKey,
      requestHash: started.requestHash,
      actorEmail: input.actorEmail,
    })
    const result = commandResult(
      advanced.candidate,
      'resolve-package',
      {
        replayed: false,
        lineGlobalId: line.global_id,
        packageSource: source,
        packageProfileGlobalId,
        weightGrams: values.weightGrams,
        dimensionsMm: {
          length: values.length,
          width: values.width,
          height: values.height,
        },
      },
    )
    await completeReceipt(
      client,
      started.receipt.id,
      candidate.global_id,
      result,
    )
    return result
  })
}

export async function validateCommerceCandidateInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  candidateRowVersion: number
}) {
  return withTransaction(async (client) => {
    const started = await commandStart(
      client,
      input,
      'commerce.intake.validate',
      { policyVersion: POLICY_VERSION },
    )
    if (started.replayed) return replayPayload(started.receipt)
    const candidate = await lockCandidate(client, input)
    const advanced = await advanceCandidate(
      client,
      candidate,
      input.actorEmail,
      'ready',
    )
    const ready = advanced.candidate.workflow_state === 'ready'
    await recordDecision(client, {
      candidate,
      targetType: 'order_candidate',
      targetGlobalId: candidate.global_id,
      targetSourceRevision: candidate.source_revision,
      targetSourceHash: candidate.source_hash,
      decisionType: 'validation',
      resultingWorkflowState: advanced.candidate.workflow_state,
      reasonCode: ready ? 'validation_passed' : 'validation_blocked',
      receipt: started.receipt,
      idempotencyKey: input.idempotencyKey,
      requestHash: started.requestHash,
      actorEmail: input.actorEmail,
    })
    const result = commandResult(
      advanced.candidate,
      'validate',
      {
        replayed: false,
        ready,
        blockers: advanced.blockers,
      },
    )
    await completeReceipt(
      client,
      started.receipt.id,
      candidate.global_id,
      result,
    )
    return result
  })
}

export async function markCommerceCandidateUnsupportedInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  candidateRowVersion: number
  reasonCode: string
  reason: string
}) {
  return withTransaction(async (client) => {
    const safeReasonCode = input.reasonCode
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 128)
    if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(safeReasonCode)) {
      intakeError(
        'COMMERCE_INTAKE_UNSUPPORTED_REASON_INVALID',
        'Use a short reason code beginning with a letter',
        422,
      )
    }
    const started = await commandStart(
      client,
      input,
      'commerce.intake.mark_unsupported',
      {
        reasonCode: safeReasonCode,
        reason: input.reason,
      },
    )
    if (started.replayed) return replayPayload(started.receipt)
    const candidate = await lockCandidate(client, input)
    await client.query(
      `UPDATE operations_commerce_order_candidates
       SET customer_resolution_state = 'unsupported',
           customer_id = NULL,
           customer_match_method = NULL,
           unsupported_reason_code = $2,
           unsupported_reason_detail = $3,
           workflow_state = 'failed',
           last_error_code = $2,
           blocking_codes = ARRAY[$2]::text[],
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        candidate.id,
        safeReasonCode,
        input.reason,
        input.actorEmail,
      ],
    )
    candidate.customer_resolution_state = 'unsupported'
    candidate.customer_id = null
    candidate.customer_match_method = null
    candidate.unsupported_reason_code = safeReasonCode
    candidate.unsupported_reason_detail = input.reason
    candidate.workflow_state = 'failed'
    candidate.blocking_codes = [safeReasonCode]
    candidate.row_version = String(Number(candidate.row_version) + 1)
    await refreshRunCounts(
      client,
      candidate,
      input.actorEmail,
    )
    await recordDecision(client, {
      candidate,
      targetType: 'order_candidate',
      targetGlobalId: candidate.global_id,
      targetSourceRevision: candidate.source_revision,
      targetSourceHash: candidate.source_hash,
      decisionType: 'unsupported_acknowledgement',
      resultingWorkflowState: 'failed',
      reasonCode: safeReasonCode,
      receipt: started.receipt,
      idempotencyKey: input.idempotencyKey,
      requestHash: started.requestHash,
      actorEmail: input.actorEmail,
    })
    const result = commandResult(
      candidate,
      'mark-unsupported',
      {
        replayed: false,
        reasonCode: safeReasonCode,
        reason: input.reason,
      },
    )
    await completeReceipt(
      client,
      started.receipt.id,
      candidate.global_id,
      result,
    )
    return result
  })
}

export async function promoteCommerceCandidateInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  candidateRowVersion: number
  requestHash: string
}) {
  return withTransaction(async (client) => {
    const started = await commandStart(
      client,
      input,
      'commerce.intake.promote',
      {
        promotionRequestHash: input.requestHash,
        providerWrites: 0,
        syncCursorAdvanced: false,
      },
    )
    if (started.replayed) return replayPayload(started.receipt)
    const candidate = await lockCandidate(client, input)
    const lines = await candidateLines(client, candidate, true)
    const operationalLines = lines.filter((line) => (
      Number(line.unfulfilled_quantity) > 0
    ))
    if (candidate.credential_version !== started.account.credential_version) {
      intakeError(
        'COMMERCE_INTAKE_CREDENTIAL_GENERATION_STALE',
        'The provider credential changed after this fetch. Fetch and resolve the order again',
        422,
      )
    }
    const newerSource = await client.query<{ global_id: string }>(
      `SELECT newer.global_id
       FROM operations_commerce_order_candidates newer
       WHERE newer.organization_id = $1::uuid
         AND newer.integration_account_id = $2::uuid
         AND newer.external_order_id = $3
         AND newer.id <> $4::uuid
         AND newer.observed_at > $5::timestamptz
         AND (
           newer.source_hash <> $6
           OR newer.source_revision <> $7
         )
       ORDER BY newer.observed_at DESC
       LIMIT 1`,
      [
        candidate.organization_id,
        candidate.integration_account_id,
        candidate.external_order_id,
        candidate.id,
        iso(candidate.observed_at),
        candidate.source_hash,
        candidate.source_revision,
      ],
    )
    if (newerSource.rows[0]) {
      intakeError(
        'COMMERCE_INTAKE_SOURCE_REVISION_STALE',
        `A newer provider revision is held as ${newerSource.rows[0].global_id}. Resolve and promote that revision instead`,
        422,
      )
    }
    const blockers = dynamicCandidateBlockingCodes(candidate, lines)
    if (candidate.workflow_state !== 'ready' || blockers.length) {
      intakeError(
        'COMMERCE_INTAKE_NOT_READY',
        'Resolve every blocker and run validation before promotion',
        422,
      )
    }
    if (!candidate.customer_id) {
      intakeError(
        'COMMERCE_INTAKE_CUSTOMER_REQUIRED',
        'Resolve the CRM customer before promotion',
        422,
      )
    }
    const activeCustomer = await client.query<{ id: string }>(
      `SELECT id::text
       FROM crm_organizations
       WHERE pipeline_id = $1::uuid
         AND id = $2::uuid
         AND relationship_type = 'customer'
       AND COALESCE(lower(source_payload->>'archived'), 'false')
             NOT IN ('true', '1', 'yes')
       LIMIT 1
       FOR UPDATE`,
      [candidate.pipeline_id, candidate.customer_id],
    )
    if (!activeCustomer.rows[0]) {
      intakeError(
        'COMMERCE_INTAKE_CUSTOMER_STALE',
        'The selected CRM customer is no longer active. Resolve the customer again',
        422,
      )
    }
    for (const line of operationalLines) {
      if (!line.product_id) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_STALE',
          `${line.product_title_snapshot} no longer has a bound CRM product. Resolve it again`,
          422,
        )
      }
      const activeProduct = await client.query<{ id: string }>(
        `SELECT id::text
         FROM crm_products
         WHERE pipeline_id = $1::uuid
           AND id = $2::uuid
           AND COALESCE(lower(source_payload->>'archived'), 'false')
               NOT IN ('true', '1', 'yes')
         LIMIT 1
         FOR UPDATE`,
        [candidate.pipeline_id, line.product_id],
      )
      if (!activeProduct.rows[0]) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_STALE',
          `${line.product_title_snapshot} is no longer an active CRM product. Resolve it again`,
          422,
        )
      }

      if (line.product_mapping_id) {
        if (!line.external_variant_id) {
          intakeError(
            'COMMERCE_INTAKE_PRODUCT_MAPPING_STALE',
            `${line.product_title_snapshot} has no provider variant identity, so its saved mapping cannot be used`,
            422,
          )
        }
        const activeMapping = await client.query<{ id: string }>(
          `SELECT id::text
           FROM operations_product_mappings
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND pipeline_id = $3::uuid
             AND id = $4::uuid
             AND product_id = $5::uuid
             AND active = true
             AND external_variant_id = $6
           LIMIT 1
           FOR UPDATE`,
          [
            candidate.organization_id,
            candidate.integration_account_id,
            candidate.pipeline_id,
            line.product_mapping_id,
            line.product_id,
            line.external_variant_id,
          ],
        )
        if (!activeMapping.rows[0]) {
          intakeError(
            'COMMERCE_INTAKE_PRODUCT_MAPPING_STALE',
            `${line.product_title_snapshot} no longer has the confirmed provider variant mapping. Resolve it again`,
            422,
          )
        }
      } else if (line.external_variant_id) {
        intakeError(
          'COMMERCE_INTAKE_PRODUCT_MAPPING_STALE',
          `${line.product_title_snapshot} has a provider variant identity but no confirmed mapping. Resolve it again`,
          422,
        )
      }

      if (line.packaging_source === 'profile') {
        if (!line.package_profile_id) {
          intakeError(
            'COMMERCE_INTAKE_PACKAGE_PROFILE_STALE',
            `${line.product_title_snapshot} no longer has its selected package profile. Resolve its package again`,
            422,
          )
        }
        const activePackage = await client.query<{ id: string }>(
          `SELECT id::text
           FROM operations_product_package_profiles
           WHERE organization_id = $1::uuid
             AND pipeline_id = $2::uuid
             AND product_id = $3::uuid
             AND id = $4::uuid
             AND active = true
             AND weight_grams = $5
             AND length_mm = $6
             AND width_mm = $7
             AND height_mm = $8
           LIMIT 1
           FOR UPDATE`,
          [
            candidate.organization_id,
            candidate.pipeline_id,
            line.product_id,
            line.package_profile_id,
            line.weight_grams,
            line.length_mm,
            line.width_mm,
            line.height_mm,
          ],
        )
        if (!activePackage.rows[0]) {
          intakeError(
            'COMMERCE_INTAKE_PACKAGE_PROFILE_STALE',
            `${line.product_title_snapshot} uses a package profile that changed or was disabled. Resolve its package again`,
            422,
          )
        }
      }
    }
    const requiresShipping = candidate.requires_shipping
      && operationalLines.some((line) => line.requires_shipping)
    let shipTo: Record<string, unknown>
    if (requiresShipping) {
      if (candidate.ship_to_snapshot_state !== 'confirmed') {
        intakeError(
          'COMMERCE_INTAKE_ADDRESS_CONFIRMATION_REQUIRED',
          'Confirm the ship-to address before promotion',
          422,
        )
      }
      const snapshot = encryptedSnapshot(
        candidate,
        input.runtime.globalId,
        'ship_to',
      )
      if (!snapshot || !completeAddress(snapshot)) {
        intakeError(
          'COMMERCE_INTAKE_ADDRESS_INCOMPLETE',
          'Complete the ship-to address before promotion',
          422,
        )
      }
      shipTo = normalizedAddress(snapshot)
    } else {
      shipTo = {
        name: candidate.order_number_snapshot,
        line1: 'Not required',
        city: 'Not required',
        region: 'NA',
        postalCode: 'NA',
        country: 'NA',
        requiresShipping: false,
      }
    }
    const duplicate = await client.query<{ global_id: string }>(
      `SELECT global_id
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = $3
       LIMIT 1
       FOR UPDATE`,
      [
        candidate.organization_id,
        candidate.integration_account_id,
        candidate.external_order_id,
      ],
    )
    if (duplicate.rows[0]) {
      intakeError(
        'COMMERCE_INTAKE_CANONICAL_ORDER_EXISTS',
        `This provider order is already canonical as ${duplicate.rows[0].global_id}`,
      )
    }
    const merchandiseTotalMinor = canonicalMerchandiseTotalMinor(
      candidate,
      operationalLines,
    )
    const orderResult = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO operations_orders (
         organization_id, pipeline_id, customer_id, integration_account_id,
         source_provider, external_order_id, order_number, status, currency,
         merchandise_total_minor, requested_delivery_at, ship_to,
         source_payload, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, 'imported',
         $8, $9, $10::timestamptz, $11::jsonb, $12::jsonb, $13, $13
       )
       RETURNING id::text, global_id`,
      [
        candidate.organization_id,
        candidate.pipeline_id,
        candidate.customer_id,
        candidate.integration_account_id,
        candidate.provider,
        candidate.external_order_id,
        candidate.order_number_snapshot,
        candidate.currency_code,
        merchandiseTotalMinor,
        iso(candidate.requested_delivery_at),
        JSON.stringify(shipTo),
        JSON.stringify({
          source: 'commerce_intake_promotion',
          candidateGlobalId: candidate.global_id,
          intakeRunGlobalId: candidate.run_global_id,
          sourceRevision: candidate.source_revision,
          sourceHash: candidate.source_hash,
          providerStatuses: {
            order: candidate.normalized_order_status,
            payment: candidate.normalized_payment_status,
            fulfillment: candidate.normalized_fulfillment_status,
            returns: candidate.normalized_return_status,
          },
          amountsMinor: {
            subtotal: candidate.subtotal_minor,
            discount: candidate.discount_minor,
            brandDiscount: candidate.brand_discount_minor,
            shipping: candidate.shipping_minor,
            tax: candidate.tax_minor,
            otherAdjustment: candidate.other_adjustment_minor,
            total: candidate.total_minor,
          },
          monetaryReconciliation: {
            policyVersion: 'commerce-money-reconciliation-v1',
            basis:
              'remaining_unfulfilled_quantity_x_resolved_unit_price',
            providerSubtotalMinor: candidate.subtotal_minor,
            canonicalMerchandiseTotalMinor: merchandiseTotalMinor,
            varianceMinor: (
              BigInt(merchandiseTotalMinor)
              - BigInt(candidate.subtotal_minor)
            ).toString(),
          },
          lineQuantityEvidence: lines.map((line) => ({
            candidateLineGlobalId: line.global_id,
            externalLineId: line.external_line_id,
            ordered: line.ordered_quantity,
            current: line.current_quantity,
            cancelledOrRemoved: line.cancelled_quantity,
            removedOrRefunded: candidate.provider === 'shopify'
              ? line.cancelled_quantity
              : null,
            fulfilled: line.fulfilled_quantity,
            unfulfilled: line.unfulfilled_quantity,
            returned: candidate.provider === 'shopify'
              ? null
              : line.returned_quantity,
            canonicalQuantity: Number(line.unfulfilled_quantity) > 0
              ? line.unfulfilled_quantity
              : '0',
            disposition: Number(line.unfulfilled_quantity) > 0
              ? 'promoted_remaining_quantity'
              : 'excluded_no_unfulfilled_quantity',
            sourceRevision: line.source_revision,
            sourceHash: line.source_hash,
          })),
          providerWrites: 0,
          syncCursorAdvanced: false,
          inventoryWrites: 0,
          reservationWrites: 0,
          fulfillmentWrites: 0,
          shipmentWrites: 0,
        }),
        input.actorEmail,
      ],
    )
    const order = orderResult.rows[0]
    await client.query(
      `INSERT INTO operations_external_identifiers (
         organization_id, integration_account_id, entity_type,
         entity_global_id, external_id, status, match_method,
         match_evidence, last_verified_at
       ) VALUES (
         $1::uuid, $2::uuid, 'operations.order', $3, $4, 'active',
         'commerce_intake_promotion', $5::jsonb, now()
       )`,
      [
        candidate.organization_id,
        candidate.integration_account_id,
        order.global_id,
        candidate.external_order_id,
        JSON.stringify({
          candidateGlobalId: candidate.global_id,
          sourceRevision: candidate.source_revision,
          sourceHash: candidate.source_hash,
        }),
      ],
    )
    const promotedLines: Array<{
      candidateLineGlobalId: string
      canonicalLineId: string
      canonicalLineGlobalId: string
    }> = []
    for (const line of operationalLines) {
      if (
        !line.product_id
        || !line.resolved_currency_code
        || line.resolved_unit_price_minor === null
      ) {
        intakeError(
          'COMMERCE_INTAKE_LINE_NOT_READY',
          `${line.product_title_snapshot} still needs product and price resolution`,
          422,
        )
      }
      if (line.resolved_currency_code !== candidate.currency_code) {
        intakeError(
          'COMMERCE_INTAKE_LINE_CURRENCY_MISMATCH',
          `${line.product_title_snapshot} must use ${candidate.currency_code}`,
          422,
        )
      }
      const canonicalLine = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_order_lines (
           organization_id, order_id, pipeline_id, product_id,
           external_line_id, channel_sku, description, quantity,
           unit_price_minor, weight_grams, dimensions_mm
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
           $9, $10, $11::jsonb
         )
         RETURNING id::text, global_id`,
        [
          candidate.organization_id,
          order.id,
          candidate.pipeline_id,
          line.product_id,
          line.external_line_id,
          line.sku_snapshot
            || line.external_variant_id
            || line.external_product_id
            || line.global_id,
          line.variant_title_snapshot
            ? `${line.product_title_snapshot} — ${line.variant_title_snapshot}`
            : line.product_title_snapshot,
          line.unfulfilled_quantity,
          line.resolved_unit_price_minor,
          line.requires_shipping ? line.weight_grams : 0,
          JSON.stringify(line.requires_shipping
            ? {
                length: line.length_mm,
                width: line.width_mm,
                height: line.height_mm,
              }
            : { length: 1, width: 1, height: 1 }),
        ],
      )
      const canonical = canonicalLine.rows[0]
      await client.query(
        `INSERT INTO operations_external_identifiers (
           organization_id, integration_account_id, entity_type,
           entity_global_id, external_id, status, match_method,
           match_evidence, last_verified_at
         ) VALUES (
           $1::uuid, $2::uuid, 'operations.order_line', $3, $4, 'active',
           'commerce_intake_promotion', $5::jsonb, now()
         )`,
        [
          candidate.organization_id,
          candidate.integration_account_id,
          canonical.global_id,
          line.external_line_id,
          JSON.stringify({
            candidateLineGlobalId: line.global_id,
            sourceRevision: line.source_revision,
            sourceHash: line.source_hash,
          }),
        ],
      )
      await client.query(
        `UPDATE operations_commerce_order_candidate_lines
         SET workflow_state = 'promoted',
             canonical_order_line_id = $2::uuid,
             promoted_at = now(),
             row_version = row_version + 1,
             updated_by = $3,
             updated_at = now()
         WHERE id = $1::uuid`,
        [line.id, canonical.id, input.actorEmail],
      )
      promotedLines.push({
        candidateLineGlobalId: line.global_id,
        canonicalLineId: canonical.id,
        canonicalLineGlobalId: canonical.global_id,
      })
    }
    const completedLines = lines.filter((line) => (
      Number(line.unfulfilled_quantity) === 0
    ))
    for (const line of completedLines) {
      await client.query(
        `UPDATE operations_commerce_order_candidate_lines
         SET mapping_state = 'unsupported',
             price_resolution_state = 'unsupported',
             resolved_currency_code = NULL,
             resolved_unit_price_minor = NULL,
             resolved_subtotal_minor = NULL,
             resolved_discount_minor = NULL,
             resolved_brand_discount_minor = NULL,
             resolved_tax_minor = NULL,
             resolved_other_adjustment_minor = NULL,
             resolved_total_minor = NULL,
             packaging_state = 'unsupported',
             workflow_state = 'failed',
             unsupported_reason_code = 'no_unfulfilled_quantity',
             unsupported_reason_detail =
               'Excluded from canonical fulfillment because Shopify reports no remaining quantity.',
             last_error_code = NULL,
             blocking_codes = '{}'::text[],
             row_version = row_version + 1,
             updated_by = $2,
             updated_at = now()
         WHERE id = $1::uuid`,
        [line.id, input.actorEmail],
      )
    }
    await client.query(
      `INSERT INTO operations_domain_events (
         organization_id, aggregate_type, aggregate_id, aggregate_global_id,
         event_type, event_version, payload, actor_email, correlation_id,
         idempotency_key
       ) VALUES (
         $1::uuid, 'operations.order', $2::uuid, $3,
         'operations.order.imported', 1, $4::jsonb, $5, $6::uuid, $7
       )`,
      [
        candidate.organization_id,
        order.id,
        order.global_id,
        JSON.stringify({
          provider: candidate.provider,
          externalOrderId: candidate.external_order_id,
          candidateGlobalId: candidate.global_id,
          lineCount: promotedLines.length,
          sourceLineCount: lines.length,
          excludedCompletedLineCount: completedLines.length,
          providerWrites: 0,
          syncCursorAdvanced: false,
        }),
        input.actorEmail,
        started.receipt.correlation_id,
        `${candidate.global_id}:promotion:${input.idempotencyKey}`,
      ],
    )
    const updatedCandidate = await client.query<{ row_version: string }>(
      `UPDATE operations_commerce_order_candidates
       SET workflow_state = 'promoted',
           canonical_order_id = $2::uuid,
           promotion_command_receipt_id = $3::uuid,
           promotion_idempotency_key = $4,
           promotion_request_hash = $5,
           promoted_at = now(),
           row_version = row_version + 1,
           updated_by = $6,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING row_version::text`,
      [
        candidate.id,
        order.id,
        started.receipt.id,
        input.idempotencyKey,
        started.requestHash,
        input.actorEmail,
      ],
    )
    candidate.workflow_state = 'promoted'
    candidate.canonical_order_id = order.id
    candidate.canonical_order_global_id = order.global_id
    candidate.row_version = updatedCandidate.rows[0].row_version
    await refreshRunCounts(client, candidate, input.actorEmail)
    await recordDecision(client, {
      candidate,
      targetType: 'order_candidate',
      targetGlobalId: candidate.global_id,
      targetSourceRevision: candidate.source_revision,
      targetSourceHash: candidate.source_hash,
      decisionType: 'promotion',
      resultingWorkflowState: 'promoted',
      reasonCode: 'canonical_order_promoted',
      canonicalOrderId: order.id,
      receipt: started.receipt,
      idempotencyKey: input.idempotencyKey,
      requestHash: started.requestHash,
      actorEmail: input.actorEmail,
    })
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.intake.promoted',
      aggregateType: 'operations.order',
      aggregateId: order.global_id,
      organizationId: candidate.organization_id,
      eventKey: `commerce-intake:${candidate.global_id}:promoted`,
      payload: {
        candidateGlobalId: candidate.global_id,
        provider: candidate.provider,
        externalOrderId: candidate.external_order_id,
        canonicalOrderGlobalId: order.global_id,
        lineCount: promotedLines.length,
        providerWrites: 0,
        syncCursorAdvanced: false,
      },
    }, client)
    const result = commandResult(
      candidate,
      'promote',
      {
        replayed: false,
        canonicalOrderGlobalId: order.global_id,
        canonicalLineGlobalIds: promotedLines.map(
          (line) => line.canonicalLineGlobalId,
        ),
        inventoryWrites: 0,
        reservationWrites: 0,
        fulfillmentWrites: 0,
        shipmentWrites: 0,
      },
    )
    await completeReceipt(
      client,
      started.receipt.id,
      order.global_id,
      result,
    )
    return result
  })
}
