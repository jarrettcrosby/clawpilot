import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  decryptCommerceCandidateSnapshot,
  encryptCommerceCandidateSnapshot,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  ORDER_SHIP_TO_FIELDS,
  changedOrderShipToFields,
  mergeOrderShipToDraft,
  normalizeOrderShipToDraft,
  orderShipToIssues,
  orderShipToReadiness,
  orderShipToStorageValue,
  type OrderShipToDraft,
  type OrderShipToField,
  type OrderShipToPatch,
} from '@/lib/operations/orderShipTo'
import {
  OPERATIONS_ORDER_PAGE_CURSOR_MAX_LENGTH,
  OPERATIONS_ORDER_SORT_KEY_MAX_CHARACTERS,
  isOperationsOrderCursorSortValue,
  isOperationsOrderProviderFilter,
  isOperationsOrderSort,
  isOperationsOrderSortDirection,
  isOperationsOrderTrackingFilter,
  isOperationsOrderUpdatedAfter,
  type OperationsOrderSort,
  type OperationsOrderSortDirection,
  type OperationsOrderTrackingFilter,
} from '@/lib/operations/orderListQuery'
import { currentExactProviderOrderMoney } from '@/lib/operations/providerOrderMoney'
import {
  emptyOperationsProviderOrderHistory,
  operationsProviderHistoryFromTimeline,
} from '@/lib/operations/providerOrderHistory'
import type {
  OperationsOrderProviderIdentity,
  OperationsOrderSourceEvidence,
} from '@/lib/operations/unifiedOrderPage'
import type {
  OperationsImportedOrderLineRefreshConflict,
  OperationsImportedOrderPage,
  OperationsImportedOrderRefreshConflict,
  OperationsImportedOrderRefreshResult,
  OperationsImportedOrderShipToUpdateResult,
  OperationsImportedOrderResolutionDraft,
  OperationsImportedOrderWorkingCopy,
  OperationsOrderStatus,
} from '@/lib/operations/types'
import {
  assertCommerceOrderProviderNonterminalWithClient,
  confirmCommerceCandidateAddressInPostgres,
  promoteCommerceCandidateInPostgres,
  resolveCommerceCandidateCustomerInPostgres,
  resolveCommerceCandidateDeliveryInPostgres,
  resolveCommerceCandidatePackageInPostgres,
  resolveCommerceCandidateProductInPostgres,
  validateCommerceCandidateInPostgres,
} from '@/lib/persistence/commerceIntake'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import {
  readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres,
} from '@/lib/persistence/commerceOrderSync'

const COMMAND_TYPE = 'operations.commerce_order_workbench.update_ship_to'
const REFRESH_COMMAND_TYPE = 'operations.commerce_order_workbench.refresh'
const EMPTY_RESULT_SET_REVISION = 'd41d8cd98f00b204e9800998ecf8427e'
const RESULT_SET_REVISION = /^[0-9a-f]{32}$/u
const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/u
const CUSTOMER_GLOBAL_ID = /^ga(?:[0-9]{7}|[0-9a-v]{12})$/u
const LINE_GLOBAL_ID = /^gcol(?:[0-9]{7}|[0-9a-v]{12})$/u
const PRODUCT_GLOBAL_ID = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/u
const PACKAGE_PROFILE_GLOBAL_ID = /^gpp(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const WORKBENCH_CURSOR = new RegExp(
  `^[A-Za-z0-9_-]{1,${OPERATIONS_ORDER_PAGE_CURSOR_MAX_LENGTH}}$`,
  'u',
)
const MAX_WORKBENCH_PAGE_SIZE = 250
const MAX_WORKBENCH_COLLECTION_PAGES = 20

type WorkbenchOrderPageStatus =
  | OperationsOrderStatus
  | 'fulfilled_externally'
  | 'closed_externally'

const WORKBENCH_ORDER_PAGE_STATUSES = new Set<WorkbenchOrderPageStatus>([
  'fulfilled_externally',
  'closed_externally',
  'imported',
  'validated',
  'held',
  'promised',
  'reserved',
  'planned',
  'released',
  'picking',
  'packed',
  'shipped',
  'cancelled',
  'exception',
])

const ADDRESS_BLOCKERS = new Set([
  'ship_to_confirmation_required',
  'ship_to_incomplete',
  'ship_to_redacted',
  'ship_to_unavailable',
])

function workbenchLinePackFactsRequired(input: Readonly<{
  requiresShipping: boolean
  unitMultiplier: number
}>) {
  return input.requiresShipping
    && (
      !Number.isSafeInteger(input.unitMultiplier)
      || input.unitMultiplier !== 1
    )
}

function queryWorkbenchPage<T extends QueryResultRow>(
  client: PoolClient | undefined,
  text: string,
  values: unknown[],
) {
  return client ? client.query<T>(text, values) : query<T>(text, values)
}

type WorkbenchReadRow = {
  candidate_id: string
  display_candidate_id: string
  candidate_global_id: string
  organization_id: string
  integration_account_id: string
  integration_account_global_id: string
  integration_account_name: string
  provider: 'shopify' | 'faire'
  external_order_id: string
  order_number_snapshot: string
  source_hash: string
  provider_updated_at: Date | null
  observed_at: Date
  candidate_row_version: string
  workflow_state: 'held' | 'resolving' | 'ready' | 'promoted' | 'failed' | 'expired'
  action_available: boolean
  blocking_codes: string[]
  pipeline_id: string
  currency_code: string
  total_minor: string | null
  header_money_state: 'complete' | 'operational_incomplete'
  requires_shipping: boolean
  customer_resolution_state:
    | 'unresolved'
    | 'suggested'
    | 'resolved'
    | 'unsupported'
  customer_global_id: string | null
  delivery_resolution_state:
    | 'unresolved'
    | 'provider'
    | 'manual'
    | 'policy'
    | 'not_required'
    | 'not_supplied'
  provider_requested_delivery_at: Date | null
  requested_delivery_at: Date | null
  canonical_order_global_id: string | null
  customer_name: string | null
  warehouse_name: string | null
  line_count: string
  pack_facts_still_required: boolean
  party_snapshot_state: 'missing' | 'redacted' | 'protected'
  party_snapshot_ciphertext: Buffer | null
  party_snapshot_iv: Buffer | null
  party_snapshot_tag: Buffer | null
  ship_to_snapshot_state:
    | 'missing'
    | 'redacted'
    | 'protected'
    | 'confirmed'
  ship_to_snapshot_ciphertext: Buffer | null
  ship_to_snapshot_iv: Buffer | null
  ship_to_snapshot_tag: Buffer | null
  workbench_id: string | null
  accepted_provider_source_hash: string | null
  ship_to_edit_state:
    | 'provider_snapshot'
    | 'local_missing'
    | 'local_incomplete'
    | 'local_carrier_ready'
    | null
  local_ship_to_ciphertext: Buffer | null
  local_ship_to_iv: Buffer | null
  local_ship_to_tag: Buffer | null
  local_ship_to_source_hash: string | null
  customer_global_id_draft: string | null
  requested_delivery_at_draft: Date | null
  line_resolution_drafts: Record<string, WorkbenchLineResolutionDraft>
  sync_state:
    | 'provider_snapshot'
    | 'local_only'
    | 'provider_sync_pending'
    | 'provider_synced'
    | 'provider_sync_failed'
    | null
  workbench_row_version: string | null
  latest_provider_source_hash: string
  provider_lifecycle_status: string
  provider_fulfillment_status: string
  provider_status_observed_at: Date
  provider_status_source: 'operational' | 'history' | 'retained'
  current_provider_observation_kind: string | null
  current_provider_currency: string | null
  current_provider_total_minor: string | null
  latest_exact_history_observed_at: Date | null
  activity_at: Date
  tracking_number: string | null
  cursor_sort_value: Date | string
  matching_total_count: string
  result_set_revision: string
}

type WorkbenchPageCursor = {
  v: 2
  sortValue: string
  candidateId: string
  total: number
  scopeHash: string
}

type LockedCandidateRow = {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  provider: 'shopify' | 'faire'
  account_global_id: string
  external_order_id: string
  source_hash: string
  provider_updated_at: Date | null
  observed_at: Date
  normalized_order_status: string
  normalized_fulfillment_status: string
  canonical_order_id: string | null
  canonical_order_global_id: string | null
  workflow_state: 'held' | 'resolving' | 'ready' | 'promoted' | 'failed' | 'expired'
  blocking_codes: string[]
  row_version: string
  ship_to_snapshot_state:
    | 'missing'
    | 'redacted'
    | 'protected'
    | 'confirmed'
  ship_to_snapshot_ciphertext: Buffer | null
  ship_to_snapshot_iv: Buffer | null
  ship_to_snapshot_tag: Buffer | null
  provider_requested_delivery_at?: Date | null
  requires_carrier_address: boolean
  live_for_new_draft: boolean
}

type WorkbenchLineResolutionDraft = {
  productGlobalId: string
  unitPriceMinor: number | null
  currency: string
  packageProfileGlobalId: string | null
}

type RefreshCandidateLineRow = {
  candidate_id: string
  global_id: string
  external_line_id: string
  product_title_snapshot: string
  sku_snapshot: string | null
}

export type CommerceOrderWorkbenchLineRefreshResolution = Record<
  string,
  'provider'
>

type CommerceOrderWorkbenchLineDraftMerge = {
  drafts: Record<string, WorkbenchLineResolutionDraft>
  preservedLineDrafts: OperationsImportedOrderRefreshResult[
    'preservedLineDrafts'
  ]
  conflicts: OperationsImportedOrderLineRefreshConflict[]
}

type WorkbenchLineReadRow = {
  candidate_id: string
  global_id: string
  external_line_id: string
  product_title_snapshot: string
  sku_snapshot: string | null
  normalized_status: 'open' | 'cancelled' | 'fulfilled' | 'returned' | 'unknown'
  ordered_quantity: string
  current_quantity: string
  cancelled_quantity: string
  fulfilled_quantity: string
  unfulfilled_quantity: string
  returned_quantity: string
  unit_multiplier: string
  requires_shipping: boolean
  mapping_state:
    | 'unresolved'
    | 'suggested'
    | 'resolved'
    | 'not_required'
    | 'unsupported'
  price_resolution_state: 'unresolved' | 'provider' | 'manual' | 'unsupported'
  packaging_state: 'unresolved' | 'resolved' | 'not_required' | 'unsupported'
  product_global_id: string | null
  resolved_unit_price_minor: string | null
  provider_unit_price_minor: string | null
  resolved_currency_code: string | null
  provider_currency_code: string | null
  package_profile_global_id: string | null
  blocking_codes: string[]
}

type CustomerOptionRow = {
  reference_code: string
  name: string
  email: string | null
}

type ProductOptionRow = {
  product_id: string
  reference_code: string
  name: string
  sku: string | null
  package_profile_global_id: string | null
  package_profile_name: string | null
  package_profile_is_default: boolean | null
}

type WorkbenchResolutionDetails = {
  lines: WorkbenchLineReadRow[]
  customers: CustomerOptionRow[]
  products: ProductOptionRow[]
}

type LockedWorkbenchRow = {
  id: string
  candidate_id: string
  accepted_provider_source_hash: string
  accepted_provider_updated_at: Date | null
  ship_to_edit_state:
    | 'provider_snapshot'
    | 'local_missing'
    | 'local_incomplete'
    | 'local_carrier_ready'
  ship_to_ciphertext: Buffer | null
  ship_to_iv: Buffer | null
  ship_to_tag: Buffer | null
  ship_to_source_hash: string | null
  canonical_order_id: string | null
  last_command_receipt_id: string
  last_request_hash: string
  customer_global_id_draft: string | null
  requested_delivery_at_draft: Date | null
  line_resolution_drafts: Record<string, WorkbenchLineResolutionDraft>
  row_version: string
}

type CommandReceiptRow = {
  id: string
  request_hash: string
  target_global_id: string | null
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_payload: Record<string, unknown> | null
  updated_at: Date
}

export class CommerceOrderWorkbenchError extends Error {
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown> | null

  constructor(
    code: string,
    message: string,
    status = 409,
    details: Record<string, unknown> | null = null,
  ) {
    super(message)
    this.name = 'CommerceOrderWorkbenchError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function requestError(
  code: string,
  message: string,
  status = 409,
  details: Record<string, unknown> | null = null,
): never {
  throw new CommerceOrderWorkbenchError(code, message, status, details)
}

function workbenchPageScopeHash(input: Readonly<{
  organizationId: string
  candidateGlobalId: string | null
  search: string
  status: WorkbenchOrderPageStatus | null
  sort: OperationsOrderSort
  direction: OperationsOrderSortDirection
  provider: string | null
  tracking: OperationsOrderTrackingFilter | null
  updatedAfter: string | null
  stableTextCollation: boolean
}>) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function validCursorTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 30) {
    return false
  }
  if (value.startsWith('0000-')) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}

function decodeWorkbenchPageCursor(
  cursor: string | null | undefined,
  expectedScopeHash: string,
  sort: OperationsOrderSort,
): WorkbenchPageCursor | null {
  if (!cursor) return null
  if (!WORKBENCH_CURSOR.test(cursor)) {
    requestError(
      'OPERATIONS_PAGE_CURSOR_INVALID',
      'The imported-order page cursor is invalid',
      400,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    requestError(
      'OPERATIONS_PAGE_CURSOR_INVALID',
      'The imported-order page cursor is invalid',
      400,
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError(
      'OPERATIONS_PAGE_CURSOR_INVALID',
      'The imported-order page cursor is invalid',
      400,
    )
  }
  const parsed = value as Partial<WorkbenchPageCursor>
  const keys = Object.keys(parsed).sort().join(',')
  if (
    keys !== [
      'candidateId',
      'scopeHash',
      'sortValue',
      'total',
      'v',
    ].sort().join(',')
    || parsed.v !== 2
    || !isOperationsOrderCursorSortValue(parsed.sortValue, sort)
    || (sort === 'updated' && !validCursorTimestamp(parsed.sortValue))
    || typeof parsed.candidateId !== 'string'
    || !UUID.test(parsed.candidateId)
    || !Number.isSafeInteger(parsed.total)
    || Number(parsed.total) < 0
    || parsed.scopeHash !== expectedScopeHash
  ) {
    requestError(
      'OPERATIONS_PAGE_CURSOR_INVALID',
      'The imported-order page cursor is invalid',
      400,
    )
  }
  return parsed as WorkbenchPageCursor
}

function encodeWorkbenchPageCursor(
  row: WorkbenchReadRow,
  total: number,
  scopeHash: string,
  sort: OperationsOrderSort,
) {
  const sortValue = sort === 'updated'
    ? (row.cursor_sort_value as Date).toISOString()
    : String(row.cursor_sort_value)
  const encoded = Buffer.from(JSON.stringify({
    v: 2,
    sortValue,
    candidateId: row.candidate_id,
    total,
    scopeHash,
  } satisfies WorkbenchPageCursor), 'utf8').toString('base64url')
  if (encoded.length > OPERATIONS_ORDER_PAGE_CURSOR_MAX_LENGTH) {
    requestError(
      'OPERATIONS_PAGE_EVIDENCE_INVALID',
      'Imported-order pagination produced an oversized cursor',
      500,
    )
  }
  return encoded
}

function workbenchOrderSort(
  value: OperationsOrderSort | null | undefined,
): OperationsOrderSort {
  const sort = value || 'updated'
  if (!isOperationsOrderSort(sort)) {
    requestError(
      'OPERATIONS_ORDER_SORT_INVALID',
      'Order sort is invalid',
      400,
    )
  }
  return sort
}

function workbenchOrderSortDirection(
  value: OperationsOrderSortDirection | null | undefined,
): OperationsOrderSortDirection {
  const direction = value || 'desc'
  if (!isOperationsOrderSortDirection(direction)) {
    requestError(
      'OPERATIONS_ORDER_SORT_DIRECTION_INVALID',
      'Order sort direction is invalid',
      400,
    )
  }
  return direction
}

function workbenchOrderProviderFilter(value: string | null | undefined) {
  const provider = String(value || '').trim()
  if (provider && !isOperationsOrderProviderFilter(provider)) {
    requestError(
      'OPERATIONS_ORDER_PROVIDER_INVALID',
      'Order provider is invalid',
      400,
    )
  }
  return provider || null
}

function workbenchOrderStatusFilter(
  value: WorkbenchOrderPageStatus | null | undefined,
) {
  const status = value || null
  if (status && !WORKBENCH_ORDER_PAGE_STATUSES.has(status)) {
    requestError(
      'OPERATIONS_STATUS_INVALID',
      'Order status is invalid',
      400,
    )
  }
  return status
}

function workbenchOrderTrackingFilter(
  value: OperationsOrderTrackingFilter | null | undefined,
) {
  const tracking = value || null
  if (tracking && !isOperationsOrderTrackingFilter(tracking)) {
    requestError(
      'OPERATIONS_ORDER_TRACKING_FILTER_INVALID',
      'Order tracking filter is invalid',
      400,
    )
  }
  return tracking
}

function workbenchOrderUpdatedAfter(value: string | null | undefined) {
  const updatedAfter = String(value || '').trim()
  if (updatedAfter && !isOperationsOrderUpdatedAfter(updatedAfter)) {
    requestError(
      'OPERATIONS_ORDER_UPDATED_AFTER_INVALID',
      'Order updated-after value is invalid',
      400,
    )
  }
  return updatedAfter || null
}

function stableTextSortExpression(expression: string, enabled: boolean) {
  return enabled ? `(${expression}) COLLATE "C"` : expression
}

function workbenchOrderSortSql(
  sort: OperationsOrderSort,
  stableTextCollation: boolean,
) {
  if (sort === 'updated') {
    return {
      expression: 'candidate_context.activity_at',
      cursorCast: 'timestamptz',
    }
  }
  if (sort === 'order_number') {
    return {
      expression: stableTextSortExpression(
        `lower(left(candidate_context.order_number_snapshot, ${OPERATIONS_ORDER_SORT_KEY_MAX_CHARACTERS}))`,
        stableTextCollation,
      ),
      cursorCast: 'text',
    }
  }
  if (sort === 'customer') {
    return {
      expression: stableTextSortExpression(
        `lower(left(COALESCE(candidate_context.customer_name, ''), ${OPERATIONS_ORDER_SORT_KEY_MAX_CHARACTERS}))`,
        stableTextCollation,
      ),
      cursorCast: 'text',
    }
  }
  if (sort === 'status') {
    return {
      expression: stableTextSortExpression(
        `lower(left(candidate_context.display_status, ${OPERATIONS_ORDER_SORT_KEY_MAX_CHARACTERS}))`,
        stableTextCollation,
      ),
      cursorCast: 'text',
    }
  }
  if (sort === 'provider') {
    return {
      expression: stableTextSortExpression(
        `lower(left(candidate_context.provider, ${OPERATIONS_ORDER_SORT_KEY_MAX_CHARACTERS}))`,
        stableTextCollation,
      ),
      cursorCast: 'text',
    }
  }
  return {
    expression: stableTextSortExpression(
      `lower(left(COALESCE(candidate_context.tracking_number, ''), ${OPERATIONS_ORDER_SORT_KEY_MAX_CHARACTERS}))`,
      stableTextCollation,
    ),
    cursorCast: 'text',
  }
}

function workbenchPageSize(value: number | null | undefined) {
  const pageSize = value ?? MAX_WORKBENCH_PAGE_SIZE
  if (
    !Number.isSafeInteger(pageSize)
    || pageSize < 1
    || pageSize > MAX_WORKBENCH_PAGE_SIZE
  ) {
    requestError(
      'OPERATIONS_PAGE_SIZE_INVALID',
      'Imported-order page size is invalid',
      400,
    )
  }
  return pageSize
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function requestHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function requireOrganizationId(value: string) {
  const organizationId = String(value || '').trim()
  if (!UUID.test(organizationId)) {
    requestError(
      'ACTIVE_ORGANIZATION_REQUIRED',
      'Select an active organization first',
      409,
    )
  }
  return organizationId
}

function requireCandidateGlobalId(value: string) {
  const candidateGlobalId = String(value || '').trim()
  if (!CANDIDATE_GLOBAL_ID.test(candidateGlobalId)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_INVALID',
      'Imported order is invalid',
      400,
    )
  }
  return candidateGlobalId
}

function normalizedResolutionDraft(
  value: OperationsImportedOrderResolutionDraft | undefined,
): OperationsImportedOrderResolutionDraft {
  if (!value) return {
    customerGlobalId: null,
    requestedDeliveryAt: null,
    lines: [],
  }
  const customerGlobalId = value.customerGlobalId
    ? String(value.customerGlobalId).trim()
    : null
  if (customerGlobalId && !CUSTOMER_GLOBAL_ID.test(customerGlobalId)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_CUSTOMER_INVALID',
      'Select an active customer',
      400,
    )
  }
  let requestedDeliveryAt: string | null = null
  if (value.requestedDeliveryAt) {
    const date = new Date(value.requestedDeliveryAt)
    if (Number.isNaN(date.getTime())) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_DELIVERY_INVALID',
        'Requested delivery date is invalid',
        400,
      )
    }
    requestedDeliveryAt = date.toISOString()
  }
  const seen = new Set<string>()
  const lines = value.lines.map((line) => {
    const lineGlobalId = String(line.lineGlobalId || '').trim()
    const productGlobalId = String(line.productGlobalId || '').trim()
    const currency = String(line.currency || '').trim().toUpperCase()
    const packageProfileGlobalId = line.packageProfileGlobalId
      ? String(line.packageProfileGlobalId).trim()
      : null
    if (
      !LINE_GLOBAL_ID.test(lineGlobalId)
      || seen.has(lineGlobalId)
      || !PRODUCT_GLOBAL_ID.test(productGlobalId)
      || (
        line.unitPriceMinor !== null
        && (
          !Number.isSafeInteger(line.unitPriceMinor)
          || line.unitPriceMinor < 0
          || line.unitPriceMinor > 9_000_000_000_000
        )
      )
      || !/^[A-Z]{3}$/u.test(currency)
      || (
        packageProfileGlobalId
        && !PACKAGE_PROFILE_GLOBAL_ID.test(packageProfileGlobalId)
      )
    ) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_LINE_INVALID',
        'Complete each selected line with a real product and valid unit price',
        400,
      )
    }
    seen.add(lineGlobalId)
    return {
      lineGlobalId,
      productGlobalId,
      unitPriceMinor: line.unitPriceMinor,
      currency,
      packageProfileGlobalId,
    }
  })
  return { customerGlobalId, requestedDeliveryAt, lines }
}

function lineDraftRecord(value: OperationsImportedOrderResolutionDraft) {
  return Object.fromEntries(value.lines.map((line) => [line.lineGlobalId, {
    productGlobalId: line.productGlobalId,
    unitPriceMinor: line.unitPriceMinor,
    currency: line.currency,
    packageProfileGlobalId: line.packageProfileGlobalId,
  }]))
}

function protectedDataUnreadable(): never {
  requestError(
    'OPERATIONS_IMPORTED_ORDER_PROTECTED_DATA_UNREADABLE',
    'Protected imported order data could not be read',
    500,
  )
}

function decryptProtectedSnapshot(input: {
  ciphertext: Buffer | null
  iv: Buffer | null
  tag: Buffer | null
  organizationId: string
  accountGlobalId: string
  externalOrderId: string
  sourceHash: string | null
  kind: 'party' | 'ship_to'
  required: boolean
}): Record<string, unknown> | null {
  const protectedParts = [input.ciphertext, input.iv, input.tag]
    .filter((value) => value !== null).length
  if (protectedParts === 0 && !input.required) return null
  if (protectedParts !== 3 || !input.sourceHash) protectedDataUnreadable()
  try {
    return decryptCommerceCandidateSnapshot(
      {
        ciphertext: input.ciphertext!,
        iv: input.iv!,
        tag: input.tag!,
      },
      input.organizationId,
      input.accountGlobalId,
      input.externalOrderId,
      input.sourceHash,
      input.kind,
    )
  } catch {
    protectedDataUnreadable()
  }
}

function decryptAddress(input: {
  ciphertext: Buffer | null
  iv: Buffer | null
  tag: Buffer | null
  organizationId: string
  accountGlobalId: string
  externalOrderId: string
  sourceHash: string | null
  required: boolean
}): OrderShipToDraft {
  const value = decryptProtectedSnapshot({
    ...input,
    kind: 'ship_to',
  })
  if (!value) return normalizeOrderShipToDraft(null)
  return normalizeOrderShipToDraft({
    name: value.name || value.organizationName,
    line1: value.line1,
    line2: value.line2,
    city: value.city,
    region: value.regionCode || value.region,
    postalCode: value.postalCode,
    country: value.countryCode || value.country,
  })
}

export type CommerceOrderWorkbenchRefreshField =
  | OrderShipToField
  | 'requestedDeliveryAt'

export type CommerceOrderWorkbenchRefreshResolution = Partial<
  Record<CommerceOrderWorkbenchRefreshField, 'local' | 'provider'>
>

export function mergeCommerceOrderWorkbenchProviderAddress(input: {
  acceptedProvider: OrderShipToDraft
  local: OrderShipToDraft
  latestProvider: OrderShipToDraft
  resolutions?: CommerceOrderWorkbenchRefreshResolution | null
}) {
  const acceptedProvider = normalizeOrderShipToDraft(input.acceptedProvider)
  const local = normalizeOrderShipToDraft(input.local)
  const latestProvider = normalizeOrderShipToDraft(input.latestProvider)
  const providerChangedFields = changedOrderShipToFields(
    acceptedProvider,
    latestProvider,
  )
  const localChangedFields = changedOrderShipToFields(acceptedProvider, local)
  const conflicts: OperationsImportedOrderRefreshConflict[] = []
  const merged: Record<OrderShipToField, string | null> = {
    ...latestProvider,
  }

  for (const field of ORDER_SHIP_TO_FIELDS) {
    const localChanged = local[field] !== acceptedProvider[field]
    const providerChanged = latestProvider[field] !== acceptedProvider[field]
    if (!localChanged) continue
    if (!providerChanged || local[field] === latestProvider[field]) {
      merged[field] = local[field]
      continue
    }
    const resolution = input.resolutions?.[field]
    if (resolution === 'local') {
      merged[field] = local[field]
      continue
    }
    if (resolution === 'provider') {
      merged[field] = latestProvider[field]
      continue
    }
    conflicts.push({
      field,
      localValue: local[field],
      providerValue: latestProvider[field],
    })
  }

  return {
    merged: normalizeOrderShipToDraft(merged),
    providerChangedFields,
    preservedLocalFields: localChangedFields.filter((field) => (
      merged[field] === local[field]
    )),
    conflicts,
  }
}

function requestedDeliveryIso(value: Date | string | null | undefined) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_DELIVERY_INVALID',
      'Requested delivery date is invalid',
      500,
    )
  }
  return date.toISOString()
}

export function mergeCommerceOrderWorkbenchRequestedDelivery(input: {
  acceptedProvider: Date | string | null | undefined
  local: Date | string | null | undefined
  latestProvider: Date | string | null | undefined
  resolution?: 'local' | 'provider' | null
}) {
  const acceptedProvider = requestedDeliveryIso(input.acceptedProvider)
  const local = requestedDeliveryIso(input.local)
  const latestProvider = requestedDeliveryIso(input.latestProvider)
  const localChanged = local !== acceptedProvider
  const providerChanged = latestProvider !== acceptedProvider
  const requiresResolution = localChanged
    && providerChanged
    && local !== latestProvider
  const conflict = requiresResolution && !input.resolution
    ? {
        field: 'requestedDeliveryAt' as const,
        localValue: local,
        providerValue: latestProvider,
      }
    : null
  const merged = requiresResolution
    ? input.resolution === 'provider' ? latestProvider : local
    : localChanged ? local : latestProvider
  return {
    merged,
    localChanged,
    providerChanged,
    requiresResolution,
    preservedLocal: localChanged && merged === local,
    conflict,
  }
}

export function mergeCommerceOrderWorkbenchLineDrafts(input: {
  acceptedLines: RefreshCandidateLineRow[]
  latestLines: RefreshCandidateLineRow[]
  localDrafts: Record<string, WorkbenchLineResolutionDraft>
  resolutions?: CommerceOrderWorkbenchLineRefreshResolution | null
}): CommerceOrderWorkbenchLineDraftMerge {
  const acceptedByGlobalId = new Map(input.acceptedLines.map((line) => (
    [line.global_id, line]
  )))
  const acceptedByExternalId = new Map<string, RefreshCandidateLineRow[]>()
  const latestByExternalId = new Map<string, RefreshCandidateLineRow[]>()
  for (const line of input.acceptedLines) {
    const matches = acceptedByExternalId.get(line.external_line_id) || []
    matches.push(line)
    acceptedByExternalId.set(line.external_line_id, matches)
  }
  for (const line of input.latestLines) {
    const matches = latestByExternalId.get(line.external_line_id) || []
    matches.push(line)
    latestByExternalId.set(line.external_line_id, matches)
  }

  const drafts: Record<string, WorkbenchLineResolutionDraft> = {}
  const preservedLineDrafts: CommerceOrderWorkbenchLineDraftMerge[
    'preservedLineDrafts'
  ] = []
  const conflicts: OperationsImportedOrderLineRefreshConflict[] = []
  for (const [lineGlobalId, draft] of Object.entries(input.localDrafts)) {
    const accepted = acceptedByGlobalId.get(lineGlobalId)
    if (!accepted) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_LINE_DRAFT_INVALID',
        'A saved item match no longer belongs to the accepted provider order',
        500,
      )
    }
    const acceptedMatches = acceptedByExternalId.get(
      accepted.external_line_id,
    ) || []
    const latestMatches = latestByExternalId.get(
      accepted.external_line_id,
    ) || []
    if (acceptedMatches.length === 1 && latestMatches.length === 1) {
      const latest = latestMatches[0]
      drafts[latest.global_id] = draft
      preservedLineDrafts.push({
        previousLineGlobalId: lineGlobalId,
        lineGlobalId: latest.global_id,
        externalLineId: accepted.external_line_id,
      })
      continue
    }
    if (input.resolutions?.[lineGlobalId] === 'provider') continue
    conflicts.push({
      lineGlobalId,
      externalLineId: accepted.external_line_id,
      title: accepted.product_title_snapshot,
      sku: accepted.sku_snapshot,
      reason: latestMatches.length === 0
        ? 'provider_line_missing'
        : 'provider_line_ambiguous',
      localDraft: { ...draft },
    })
  }
  return { drafts, preservedLineDrafts, conflicts }
}

function customerSnapshotName(row: WorkbenchReadRow) {
  if (row.customer_name) return row.customer_name
  const value = decryptProtectedSnapshot({
    ciphertext: row.party_snapshot_ciphertext,
    iv: row.party_snapshot_iv,
    tag: row.party_snapshot_tag,
    organizationId: row.organization_id,
    accountGlobalId: row.integration_account_global_id,
    externalOrderId: row.external_order_id,
    sourceHash: row.source_hash,
    kind: 'party',
    required: row.party_snapshot_state === 'protected',
  })
  if (!value) return null
  return String(value.organizationName || value.contactName || '').trim()
    || null
}

function providerLifecycleStatus(value: string) {
  return ['open', 'closed', 'cancelled'].includes(value)
    ? value as 'open' | 'closed' | 'cancelled'
    : 'unknown' as const
}

function providerFulfillmentStatus(value: string) {
  return [
    'unfulfilled',
    'partial',
    'fulfilled',
    'on_hold',
    'scheduled',
    'cancelled',
  ].includes(value)
    ? value as
      | 'unfulfilled'
      | 'partial'
      | 'fulfilled'
      | 'on_hold'
      | 'scheduled'
      | 'cancelled'
    : 'unknown' as const
}

function mappedWorkingCopy(
  row: WorkbenchReadRow,
  details: WorkbenchResolutionDetails | null,
  providerHistory: OperationsImportedOrderWorkingCopy['providerHistory'] =
    emptyOperationsProviderOrderHistory(),
): OperationsImportedOrderWorkingCopy {
  const currentProviderHistoryIsExact = [
    'manual_exact_read',
    'webhook_exact_read',
  ].includes(row.current_provider_observation_kind || '')
  const currentExactMoney = currentExactProviderOrderMoney({
    currentProviderObservationKind: row.current_provider_observation_kind,
    currency: row.current_provider_currency,
    providerTotalMinor: row.current_provider_total_minor,
  })
  const currentProviderHistory = currentProviderHistoryIsExact
    ? {
        ...providerHistory,
        currency: currentExactMoney?.currency || null,
        providerTotalMinor: currentExactMoney?.totalMinor || null,
      }
    : emptyOperationsProviderOrderHistory()
  const providerTerminal = (
    ['cancelled', 'closed'].includes(row.provider_lifecycle_status)
    || ['fulfilled', 'cancelled'].includes(row.provider_fulfillment_status)
  )
  const local = !providerTerminal && Boolean(
    row.workbench_id
    && row.ship_to_edit_state
    && row.ship_to_edit_state !== 'provider_snapshot',
  )
  const shipTo = local
    ? decryptAddress({
        ciphertext: row.local_ship_to_ciphertext,
        iv: row.local_ship_to_iv,
        tag: row.local_ship_to_tag,
        organizationId: row.organization_id,
        accountGlobalId: row.integration_account_global_id,
        externalOrderId: row.external_order_id,
        sourceHash: row.local_ship_to_source_hash,
        required: true,
      })
    : decryptAddress({
        ciphertext: row.ship_to_snapshot_ciphertext,
        iv: row.ship_to_snapshot_iv,
        tag: row.ship_to_snapshot_tag,
        organizationId: row.organization_id,
        accountGlobalId: row.integration_account_global_id,
        externalOrderId: row.external_order_id,
        sourceHash: row.source_hash,
        required: row.ship_to_snapshot_state === 'protected'
          || row.ship_to_snapshot_state === 'confirmed',
      })
  const issues = orderShipToIssues(shipTo)
  const packFactsStillRequired = details
    ? details.lines.some((line) => (
        Number(line.unfulfilled_quantity) > 0
        &&
        workbenchLinePackFactsRequired({
          requiresShipping: line.requires_shipping,
          unitMultiplier: Number(line.unit_multiplier),
        }) && line.packaging_state !== 'resolved'
      ))
    : row.pack_facts_still_required
  const effectiveBlockerCodes = row.blocking_codes.filter((code) => (
    code !== 'packaging_required' || packFactsStillRequired
  ))
  const otherMissingFacts = effectiveBlockerCodes.some((code) => (
    !ADDRESS_BLOCKERS.has(code)
  ))
  const productOptions = new Map<string, OperationsImportedOrderWorkingCopy[
    'productOptions'
  ][number]>()
  for (const product of details?.products || []) {
    const option = productOptions.get(product.product_id) || {
      globalId: product.reference_code,
      name: product.name,
      sku: product.sku,
      packageProfiles: [],
    }
    if (product.package_profile_global_id && product.package_profile_name) {
      option.packageProfiles.push({
        globalId: product.package_profile_global_id,
        name: product.package_profile_name,
      })
    }
    productOptions.set(product.product_id, option)
  }
  const lineDrafts = row.line_resolution_drafts || {}
  const candidateLines: OperationsImportedOrderWorkingCopy['lines'] = (
    details?.lines || []
  ).map((line) => {
    const draft = providerTerminal ? undefined : lineDrafts[line.global_id]
    const candidateLine = {
      globalId: line.global_id,
      externalLineId: line.external_line_id,
      title: line.product_title_snapshot,
      sku: line.sku_snapshot,
      quantity: Number(line.unfulfilled_quantity),
      orderedQuantity: Number(line.ordered_quantity),
      currentQuantity: Number(line.current_quantity),
      cancelledOrRemovedQuantity: Number(line.cancelled_quantity),
      fulfilledQuantity: Number(line.fulfilled_quantity),
      unfulfilledQuantity: Number(line.unfulfilled_quantity),
      returnedQuantity: Number(line.returned_quantity),
      providerStatus: line.normalized_status,
      unitMultiplier: Number(line.unit_multiplier),
      requiresShipping: line.requires_shipping,
      mappingStatus: line.mapping_state,
      priceStatus: line.price_resolution_state,
      packageStatus: line.packaging_state,
      productGlobalId: draft?.productGlobalId || line.product_global_id,
      unitPriceMinor: draft
        ? draft.unitPriceMinor
        : Number(
          line.resolved_unit_price_minor
          || line.provider_unit_price_minor
          || Number.NaN,
        ),
      currency: draft?.currency
        || line.resolved_currency_code
        || line.provider_currency_code
        || row.currency_code,
      packageProfileGlobalId: draft
        ? draft.packageProfileGlobalId
        : line.package_profile_global_id,
      blockerCodes: line.blocking_codes.filter((code) => (
        code !== 'packaging_required'
        || (
          Number(line.unfulfilled_quantity) > 0
          && workbenchLinePackFactsRequired({
            requiresShipping: line.requires_shipping,
            unitMultiplier: Number(line.unit_multiplier),
          })
          && line.packaging_state !== 'resolved'
        )
      )),
    }
    return {
      ...candidateLine,
      unitPriceMinor: Number.isSafeInteger(candidateLine.unitPriceMinor)
        ? candidateLine.unitPriceMinor
        : null,
    }
  })
  const candidateLinesByExternalId = new Map(candidateLines.map((line) => (
    [line.externalLineId, line]
  )))
  const displayLines = providerTerminal
    && currentProviderHistoryIsExact
    && currentProviderHistory.currentLines.length
    ? currentProviderHistory.currentLines.map((historyLine) => {
        const candidateLine = candidateLinesByExternalId.get(
          historyLine.externalLineId,
        )
        const currentQuantity = historyLine.currentQuantity
          ?? historyLine.orderedQuantity
        const unfulfilledQuantity = historyLine.unfulfilledQuantity
          ?? Math.max(
            0,
            currentQuantity - (historyLine.fulfilledQuantity ?? 0),
          )
        const fulfilledQuantity = historyLine.fulfilledQuantity
          ?? Math.max(0, currentQuantity - unfulfilledQuantity)
        const returnedQuantity = historyLine.returnedQuantity ?? 0
        const cancelledOrRemovedQuantity = Math.max(
          0,
          historyLine.orderedQuantity - currentQuantity,
        )
        const providerStatus = unfulfilledQuantity > 0
          ? 'open' as const
          : returnedQuantity > 0
            ? 'returned' as const
            : fulfilledQuantity > 0
              ? 'fulfilled' as const
              : currentQuantity === 0
                ? 'cancelled' as const
                : 'unknown' as const
        const providerUnitPriceMinor = historyLine.unitPriceMinor === null
          ? null
          : Number(historyLine.unitPriceMinor)
        const providerUnitPriceAvailable = Boolean(
          historyLine.unitPriceCurrency
          && Number.isSafeInteger(providerUnitPriceMinor),
        )
        return {
          globalId: candidateLine?.globalId
            || `history:${historyLine.externalLineId}`,
          externalLineId: historyLine.externalLineId,
          title: historyLine.titleSnapshot
            || candidateLine?.title
            || historyLine.sku
            || historyLine.externalVariantId
            || historyLine.externalProductId
            || `Provider item ${historyLine.externalLineId}`,
          sku: historyLine.sku || candidateLine?.sku || null,
          quantity: unfulfilledQuantity,
          orderedQuantity: historyLine.orderedQuantity,
          currentQuantity,
          cancelledOrRemovedQuantity,
          fulfilledQuantity,
          unfulfilledQuantity,
          returnedQuantity,
          providerStatus,
          unitMultiplier: candidateLine?.unitMultiplier || 1,
          requiresShipping: historyLine.requiresShipping
            ?? candidateLine?.requiresShipping
            ?? false,
          mappingStatus: candidateLine?.mappingStatus || 'unresolved',
          priceStatus: providerUnitPriceAvailable
            ? 'provider' as const
            : candidateLine?.priceStatus || 'unsupported',
          packageStatus: candidateLine?.packageStatus || 'not_required',
          productGlobalId: candidateLine?.productGlobalId || null,
          unitPriceMinor: providerUnitPriceAvailable
            ? providerUnitPriceMinor
            : candidateLine?.unitPriceMinor ?? null,
          currency: providerUnitPriceAvailable
            ? historyLine.unitPriceCurrency as string
            : candidateLine?.currency || row.currency_code,
          packageProfileGlobalId:
            candidateLine?.packageProfileGlobalId || null,
          blockerCodes: [],
        }
      })
    : candidateLines
  return {
    kind: 'imported_working_copy',
    globalId: row.candidate_global_id,
    candidateGlobalId: row.candidate_global_id,
    canonicalOrderGlobalId: row.canonical_order_global_id,
    integrationAccountGlobalId: row.integration_account_global_id,
    integrationAccountName: row.integration_account_name,
    provider: row.provider,
    externalOrderId: row.external_order_id,
    orderNumber: row.order_number_snapshot,
    status: 'imported',
    providerState: {
      lifecycle: providerLifecycleStatus(row.provider_lifecycle_status),
      fulfillment: providerFulfillmentStatus(
        row.provider_fulfillment_status,
      ),
      observedAt: row.provider_status_observed_at.toISOString(),
      source: row.provider_status_source,
    },
    needsInfo: !providerTerminal && (issues.length > 0 || otherMissingFacts),
    blockerCodes: effectiveBlockerCodes,
    customerName: customerSnapshotName(row),
    warehouseName: row.warehouse_name,
    lineCount: providerTerminal
      && currentProviderHistoryIsExact
      && currentProviderHistory.currentLines.length
      ? displayLines.length
      : Number(row.line_count),
    sourceUpdatedAt: (
      row.provider_updated_at || row.observed_at
    ).toISOString(),
    updatedAt: row.activity_at.toISOString(),
    trackingNumber: row.tracking_number,
    orderValueMinor: currentProviderHistory.providerTotalMinor
      || (row.header_money_state === 'complete' ? row.total_minor : null),
    currency: currentProviderHistory.currency || row.currency_code,
    candidateRowVersion: Number(row.candidate_row_version),
    workflowState: row.workflow_state,
    actionAvailable: row.action_available,
    rowVersion: Number(row.workbench_row_version || 0),
    resolutionDetailsLoaded: details !== null,
    providerVersionChanged: Boolean(
      row.accepted_provider_source_hash
      && row.accepted_provider_source_hash
        !== row.latest_provider_source_hash,
    ),
    customer: {
      status: row.customer_resolution_state,
      resolvedCustomerGlobalId: row.customer_global_id,
      selectedCustomerGlobalId: providerTerminal
        ? row.customer_global_id
        : row.customer_global_id_draft || row.customer_global_id,
      options: (details?.customers || []).map((customer) => ({
        globalId: customer.reference_code,
        name: customer.name,
        email: customer.email,
      })),
    },
    delivery: {
      status: row.delivery_resolution_state,
      providerRequestedDeliveryAt:
        row.provider_requested_delivery_at?.toISOString() || null,
      selectedDeliveryAt: row.requested_delivery_at?.toISOString() || null,
      draftDeliveryAt: providerTerminal
        ? row.requested_delivery_at?.toISOString()
          || row.provider_requested_delivery_at?.toISOString()
          || null
        : row.workbench_id
        ? row.requested_delivery_at_draft?.toISOString() || null
        : row.requested_delivery_at?.toISOString()
          || row.provider_requested_delivery_at?.toISOString()
          || null,
    },
    lines: displayLines,
    providerHistory: currentProviderHistory,
    productOptions: [...productOptions.values()],
    shipTo: {
      value: shipTo,
      readiness: orderShipToReadiness(shipTo),
      provenance: local ? 'local' : 'provider',
      syncStatus: providerTerminal
        ? 'provider_snapshot'
        : row.sync_state || 'provider_snapshot',
      issues,
    },
    providerWrites: 0,
  }
}

export async function readCommerceOrderWorkbenchPageFromPostgres(input: {
  organizationId: string
  search?: string | null
  candidateGlobalId?: string | null
  includeResolutionDetails?: boolean
  status?: WorkbenchOrderPageStatus | null
  sort?: OperationsOrderSort | null
  direction?: OperationsOrderSortDirection | null
  provider?: string | null
  tracking?: OperationsOrderTrackingFilter | null
  updatedAfter?: string | null
  cursor?: string | null
  pageSize?: number | null
  /** Server-only merge mode; scopes cursors to deterministic byte ordering. */
  stableTextCollation?: boolean
  /** Server-only: keep a unified multi-source read on one database snapshot. */
  queryClient?: PoolClient
}): Promise<{
  orders: OperationsImportedOrderWorkingCopy[]
  page: OperationsImportedOrderPage
  internal: {
    rowCursors: string[]
    sortValues: string[]
    providerIdentities: OperationsOrderProviderIdentity[]
    sourceEvidence: OperationsOrderSourceEvidence[]
    resultSetRevision: string | null
  }
}> {
  const organizationId = requireOrganizationId(input.organizationId)
  const candidateGlobalId = input.candidateGlobalId
    ? requireCandidateGlobalId(input.candidateGlobalId)
    : null
  const search = String(input.search || '').trim()
  const status = workbenchOrderStatusFilter(input.status)
  const sort = workbenchOrderSort(input.sort)
  const direction = workbenchOrderSortDirection(input.direction)
  const provider = workbenchOrderProviderFilter(input.provider)
  const tracking = workbenchOrderTrackingFilter(input.tracking)
  const updatedAfter = workbenchOrderUpdatedAfter(input.updatedAfter)
  const stableTextCollation = input.stableTextCollation === true
  const searchPattern = search
    ? `%${search.replace(/[!%_]/gu, '!$&')}%`
    : null
  const pageSize = workbenchPageSize(input.pageSize)
  const scopeHash = workbenchPageScopeHash({
    organizationId,
    candidateGlobalId,
    search,
    status,
    sort,
    direction,
    provider,
    tracking,
    updatedAfter,
    stableTextCollation,
  })
  const cursor = decodeWorkbenchPageCursor(input.cursor, scopeHash, sort)
  const sortSql = workbenchOrderSortSql(sort, stableTextCollation)
  const comparison = direction === 'asc' ? '>' : '<'
  const orderDirection = direction === 'asc' ? 'ASC' : 'DESC'
  const result = await queryWorkbenchPage<WorkbenchReadRow>(
    input.queryClient,
    `WITH latest_live_candidates AS (
       SELECT DISTINCT ON (
         candidate.integration_account_id,
         candidate.external_order_id
       )
         candidate.id,
         candidate.organization_id,
         candidate.integration_account_id,
         candidate.external_order_id
       FROM operations_commerce_order_candidates candidate
       JOIN operations_commerce_intake_runs run
         ON run.organization_id = candidate.organization_id
        AND run.integration_account_id = candidate.integration_account_id
        AND run.pipeline_id = candidate.pipeline_id
        AND run.id = candidate.run_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.canonical_order_id IS NULL
         AND candidate.workflow_state IN ('held', 'resolving', 'ready')
         AND candidate.expires_at > now()
         AND run.expires_at > now()
         AND run.workflow_state <> 'expired'
         AND NOT EXISTS (
           SELECT 1
           FROM operations_orders canonical
           WHERE canonical.organization_id = candidate.organization_id
             AND canonical.integration_account_id
               = candidate.integration_account_id
             AND canonical.external_order_id = candidate.external_order_id
         )
       ORDER BY
         candidate.integration_account_id,
         candidate.external_order_id,
         candidate.observed_at DESC,
         candidate.created_at DESC,
         candidate.id DESC
     ), selected_candidate_ids AS (
       SELECT live.id AS candidate_id
       FROM latest_live_candidates live
       WHERE NOT EXISTS (
         SELECT 1
         FROM operations_commerce_order_workbench retained
         WHERE retained.organization_id = live.organization_id
           AND retained.integration_account_id
             = live.integration_account_id
           AND retained.external_order_id = live.external_order_id
       )
       UNION ALL
       SELECT retained.candidate_id
       FROM operations_commerce_order_workbench retained
       JOIN operations_commerce_order_candidates retained_candidate
         ON retained_candidate.organization_id = retained.organization_id
        AND retained_candidate.integration_account_id
          = retained.integration_account_id
        AND retained_candidate.id = retained.candidate_id
       WHERE retained.organization_id = $1::uuid
         AND retained.canonical_order_id IS NULL
         AND retained_candidate.canonical_order_id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM operations_orders canonical
           WHERE canonical.organization_id = retained_candidate.organization_id
             AND canonical.integration_account_id
               = retained_candidate.integration_account_id
             AND canonical.external_order_id
               = retained_candidate.external_order_id
         )
     ), candidate_context AS (
       SELECT candidate.id AS candidate_id,
              candidate.global_id AS candidate_global_id,
              candidate.integration_account_id,
              candidate.external_order_id,
              display_snapshot.order_number_snapshot,
              display_snapshot.provider,
              display_snapshot.provider_updated_at,
              display_snapshot.observed_at,
              account.display_name AS integration_account_name,
              display_customer.name AS customer_name,
              canonical_order.global_id AS canonical_order_global_id,
              latest_provider.id AS latest_provider_candidate_id,
              latest_tracking.tracking_number,
              CASE
                WHEN COALESCE(
                  provider_status.lifecycle_status,
                  candidate.normalized_order_status
                ) IN ('cancelled', 'canceled')
                OR COALESCE(
                  provider_status.fulfillment_status,
                  candidate.normalized_fulfillment_status
                ) IN ('cancelled', 'canceled')
                THEN 'cancelled'
                WHEN COALESCE(
                  provider_status.fulfillment_status,
                  candidate.normalized_fulfillment_status
                ) = 'fulfilled'
                THEN 'fulfilled_externally'
                WHEN COALESCE(
                  provider_status.lifecycle_status,
                  candidate.normalized_order_status
                ) = 'closed'
                THEN 'closed_externally'
                ELSE 'imported'
              END AS display_status,
              date_trunc('milliseconds', GREATEST(
                  COALESCE(
                    latest_provider.provider_updated_at,
                    latest_provider.observed_at
                  ),
                  COALESCE(
                    latest_observation.provider_updated_at,
                    latest_observation.observed_at
                  ),
                  latest_tracking.activity_at,
                  candidate.observed_at,
                  workbench.updated_at
                )) AS activity_at
       FROM selected_candidate_ids selected
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = $1::uuid
        AND candidate.id = selected.candidate_id
       JOIN operations_integration_accounts account
         ON account.organization_id = candidate.organization_id
        AND account.id = candidate.integration_account_id
        AND account.integration_type = 'commerce'
        AND account.provider IN ('shopify', 'faire')
       LEFT JOIN operations_orders canonical_order
         ON canonical_order.organization_id = candidate.organization_id
        AND canonical_order.id = candidate.canonical_order_id
       LEFT JOIN operations_commerce_order_workbench workbench
         ON workbench.organization_id = candidate.organization_id
        AND workbench.integration_account_id = candidate.integration_account_id
        AND workbench.external_order_id = candidate.external_order_id
       LEFT JOIN LATERAL (
         SELECT provider_candidate.id,
                provider_candidate.provider_updated_at,
                provider_candidate.observed_at
         FROM operations_commerce_order_candidates provider_candidate
         WHERE provider_candidate.organization_id = candidate.organization_id
           AND provider_candidate.integration_account_id
             = candidate.integration_account_id
           AND provider_candidate.external_order_id
             = candidate.external_order_id
           AND provider_candidate.workflow_state <> 'failed'
         ORDER BY
           COALESCE(
             provider_candidate.provider_updated_at,
             provider_candidate.observed_at
           ) DESC,
           provider_candidate.observed_at DESC,
           provider_candidate.created_at DESC,
           provider_candidate.id DESC
         LIMIT 1
       ) latest_provider ON true
       LEFT JOIN LATERAL (
         SELECT status_evidence.lifecycle_status,
                status_evidence.fulfillment_status
         FROM (
           SELECT provider_candidate.normalized_order_status
                    AS lifecycle_status,
                  provider_candidate.normalized_fulfillment_status
                    AS fulfillment_status,
                  provider_candidate.provider_updated_at,
                  provider_candidate.observed_at,
                  0::integer AS source_priority,
                  provider_candidate.id AS evidence_id
           FROM operations_commerce_order_candidates provider_candidate
           WHERE provider_candidate.organization_id = candidate.organization_id
             AND provider_candidate.integration_account_id
               = candidate.integration_account_id
             AND provider_candidate.external_order_id
               = candidate.external_order_id
             AND provider_candidate.workflow_state <> 'failed'
           UNION ALL
           SELECT observation.canonical_lifecycle_state,
                  observation.canonical_fulfillment_state,
                  observation.provider_updated_at,
                  observation.observed_at,
                  1::integer AS source_priority,
                  observation.id AS evidence_id
           FROM operations_commerce_order_observations observation
           WHERE observation.organization_id = candidate.organization_id
             AND observation.integration_account_id
               = candidate.integration_account_id
             AND observation.provider = candidate.provider
             AND observation.external_order_id = candidate.external_order_id
         ) status_evidence
         ORDER BY
           COALESCE(
             status_evidence.provider_updated_at,
             status_evidence.observed_at
           ) DESC,
           status_evidence.observed_at DESC,
           status_evidence.source_priority DESC,
           status_evidence.evidence_id DESC
         LIMIT 1
       ) provider_status ON true
       CROSS JOIN LATERAL (
         SELECT CASE
           WHEN COALESCE(
             provider_status.lifecycle_status,
             candidate.normalized_order_status
           ) IN ('cancelled', 'canceled', 'closed')
           OR COALESCE(
             provider_status.fulfillment_status,
             candidate.normalized_fulfillment_status
           ) IN ('fulfilled', 'cancelled', 'canceled')
           THEN COALESCE(latest_provider.id, candidate.id)
           ELSE candidate.id
         END AS id
       ) display_candidate
       JOIN operations_commerce_order_candidates display_snapshot
         ON display_snapshot.organization_id = candidate.organization_id
        AND display_snapshot.id = display_candidate.id
       LEFT JOIN crm_organizations display_customer
         ON display_customer.pipeline_id = display_snapshot.pipeline_id
        AND display_customer.id = display_snapshot.customer_id
       LEFT JOIN LATERAL (
         SELECT observation.provider_updated_at, observation.observed_at
         FROM operations_commerce_order_observations observation
         WHERE observation.organization_id = candidate.organization_id
           AND observation.integration_account_id
             = candidate.integration_account_id
           AND observation.provider = candidate.provider
           AND observation.external_order_id = candidate.external_order_id
         ORDER BY
           COALESCE(
             observation.provider_updated_at,
             observation.observed_at
           ) DESC,
           observation.observed_at DESC,
           observation.id DESC
         LIMIT 1
       ) latest_observation ON true
       LEFT JOIN LATERAL (
         SELECT (
                  array_remove(
                    array_agg(
                      subject_state.tracking_number
                      ORDER BY subject_state.activity_at DESC,
                               subject_state.subject_key,
                               subject_state.event_id DESC
                    ),
                    NULL
                  )
                )[1] AS tracking_number,
                max(subject_state.activity_at) AS activity_at
         FROM (
           SELECT ranked.subject_key,
                  ranked.event_id,
                  ranked.tracking_number,
                  ranked.activity_at
           FROM (
             SELECT COALESCE(
                      NULLIF(btrim(event.external_subject_id), ''),
                      '__order__'
                    ) AS subject_key,
                    event.id AS event_id,
                    CASE
                      WHEN event.sensitive_evidence_redacted_at IS NULL
                           AND event.sensitive_evidence_expires_at > now()
                        THEN NULLIF(btrim(event.tracking_number), '')
                      ELSE NULL
                    END AS tracking_number,
                    date_trunc('milliseconds', GREATEST(
                      event.occurred_at,
                      event.observed_at,
                      event.created_at
                    )) AS activity_at,
                    row_number() OVER (
                      PARTITION BY COALESCE(
                        NULLIF(btrim(event.external_subject_id), ''),
                        '__order__'
                      )
                      ORDER BY GREATEST(
                                 event.occurred_at,
                                 event.observed_at,
                                 event.created_at
                               ) DESC,
                               (
                                 NULLIF(btrim(event.tracking_number), '')
                                   IS NOT NULL
                               ) DESC,
                               event.external_event_id DESC NULLS LAST,
                               event.id DESC
                    ) AS subject_rank
             FROM operations_commerce_order_event_observations event
             WHERE event.organization_id = candidate.organization_id
               AND event.integration_account_id = candidate.integration_account_id
               AND event.provider = candidate.provider
               AND event.external_order_id = candidate.external_order_id
               AND event.event_kind = 'tracking_updated'
           ) ranked
           WHERE ranked.subject_rank = 1
         ) subject_state
       ) latest_tracking ON true
     ), matching_candidate_rows AS MATERIALIZED (
       SELECT candidate_context.candidate_id,
              candidate_context.provider_updated_at,
              candidate_context.observed_at,
              candidate_context.activity_at,
              candidate_context.tracking_number,
              ${sortSql.expression} AS cursor_sort_value
       FROM candidate_context
       WHERE (
           $2::text IS NULL
           OR candidate_context.candidate_global_id = $2
         )
         AND (
           $3::text IS NULL
           OR candidate_context.candidate_global_id ILIKE $3 ESCAPE '!'
           OR candidate_context.order_number_snapshot ILIKE $3 ESCAPE '!'
           OR candidate_context.external_order_id ILIKE $3 ESCAPE '!'
           OR candidate_context.integration_account_name ILIKE $3 ESCAPE '!'
           OR candidate_context.provider ILIKE $3 ESCAPE '!'
           OR COALESCE(candidate_context.customer_name, '') ILIKE $3 ESCAPE '!'
           OR COALESCE(
             candidate_context.canonical_order_global_id,
             ''
           ) ILIKE $3 ESCAPE '!'
           OR candidate_context.tracking_number ILIKE $3 ESCAPE '!'
           OR EXISTS (
             SELECT 1
             FROM operations_commerce_order_candidate_lines line
             LEFT JOIN crm_products product
               ON product.pipeline_id = line.pipeline_id
              AND product.id = line.product_id
             WHERE line.organization_id = $1::uuid
               AND line.integration_account_id
                 = candidate_context.integration_account_id
               AND line.order_candidate_id IN (
                 candidate_context.candidate_id,
                 candidate_context.latest_provider_candidate_id
               )
               AND (
                 COALESCE(line.sku_snapshot, '') ILIKE $3 ESCAPE '!'
                 OR COALESCE(product.sku, '') ILIKE $3 ESCAPE '!'
                 OR product.reference_code ILIKE $3 ESCAPE '!'
               )
           )
           OR EXISTS (
             SELECT 1
             FROM operations_commerce_order_observations observation
             JOIN operations_commerce_order_observation_lines line
               ON line.organization_id = observation.organization_id
              AND line.observation_id = observation.id
             WHERE observation.organization_id = $1::uuid
               AND observation.integration_account_id
                 = candidate_context.integration_account_id
               AND observation.provider = candidate_context.provider
               AND observation.external_order_id
                 = candidate_context.external_order_id
               AND COALESCE(line.sku, '') ILIKE $3 ESCAPE '!'
           )
         )
         AND (
           $4::text IS NULL
           OR candidate_context.provider = $4::text
         )
         AND (
           $5::text IS NULL
           OR (
             $5::text = 'present'
             AND candidate_context.tracking_number IS NOT NULL
           )
           OR (
             $5::text = 'missing'
             AND candidate_context.tracking_number IS NULL
           )
         )
         AND (
           $6::timestamptz IS NULL
           OR candidate_context.activity_at > $6::timestamptz
         )
         AND (
           $11::text IS NULL
           OR candidate_context.display_status = $11::text
         )
     ), matching_candidate_evidence AS (
       SELECT count(*)::text AS matching_total_count,
              md5(string_agg(
                jsonb_build_array(
                  matching.candidate_id::text,
                  matching.cursor_sort_value::text
                )::text,
                E'\n' ORDER BY matching.candidate_id
              )) AS result_set_revision
       FROM matching_candidate_rows matching
     ), page_candidate_ids AS (
       SELECT matching.candidate_id,
              matching.provider_updated_at,
              matching.observed_at,
              matching.activity_at,
              matching.tracking_number,
              matching.cursor_sort_value,
              evidence.matching_total_count,
              evidence.result_set_revision
       FROM matching_candidate_rows matching
       CROSS JOIN matching_candidate_evidence evidence
       WHERE NOT $7::boolean
          OR matching.cursor_sort_value ${comparison} $8::${sortSql.cursorCast}
          OR (
            matching.cursor_sort_value = $8::${sortSql.cursorCast}
            AND matching.candidate_id ${comparison} $9::uuid
          )
       ORDER BY matching.cursor_sort_value ${orderDirection},
                matching.candidate_id ${orderDirection}
       LIMIT $10::integer
     )
     SELECT
       candidate.id::text AS candidate_id,
       display_candidate.id::text AS display_candidate_id,
       candidate.global_id AS candidate_global_id,
       candidate.organization_id::text,
       candidate.integration_account_id::text,
       account.global_id AS integration_account_global_id,
       account.display_name AS integration_account_name,
       candidate.provider,
       candidate.external_order_id,
       display_snapshot.order_number_snapshot,
       display_snapshot.source_hash,
       display_snapshot.provider_updated_at,
       display_snapshot.observed_at,
       candidate.row_version::text AS candidate_row_version,
       candidate.workflow_state,
       (
         candidate.workflow_state IN ('held', 'resolving', 'ready')
         AND candidate.expires_at > now()
         AND EXISTS (
           SELECT 1
           FROM operations_commerce_intake_runs candidate_run
           WHERE candidate_run.organization_id = candidate.organization_id
             AND candidate_run.integration_account_id
               = candidate.integration_account_id
             AND candidate_run.pipeline_id = candidate.pipeline_id
             AND candidate_run.id = candidate.run_id
             AND candidate_run.workflow_state <> 'expired'
             AND candidate_run.expires_at > now()
         )
       ) AS action_available,
       display_snapshot.blocking_codes,
       display_snapshot.pipeline_id::text,
       display_snapshot.currency_code,
       display_snapshot.total_minor::text,
       display_snapshot.header_money_state,
       display_snapshot.requires_shipping,
       display_snapshot.customer_resolution_state,
       display_resolved_customer.reference_code AS customer_global_id,
       display_snapshot.delivery_resolution_state,
       display_snapshot.provider_requested_delivery_at,
       display_snapshot.requested_delivery_at,
       canonical_order.global_id AS canonical_order_global_id,
       display_customer.name AS customer_name,
       provider_warehouse.warehouse_name,
       line_count.line_count,
       line_count.pack_facts_still_required,
       display_snapshot.party_snapshot_state,
       display_snapshot.party_snapshot_ciphertext,
       display_snapshot.party_snapshot_iv,
       display_snapshot.party_snapshot_tag,
       display_snapshot.ship_to_snapshot_state,
       display_snapshot.ship_to_snapshot_ciphertext,
       display_snapshot.ship_to_snapshot_iv,
       display_snapshot.ship_to_snapshot_tag,
       workbench.id::text AS workbench_id,
       workbench.accepted_provider_source_hash,
       workbench.ship_to_edit_state,
       workbench.ship_to_ciphertext AS local_ship_to_ciphertext,
       workbench.ship_to_iv AS local_ship_to_iv,
       workbench.ship_to_tag AS local_ship_to_tag,
       workbench.ship_to_source_hash AS local_ship_to_source_hash,
       workbench.customer_global_id_draft,
       workbench.requested_delivery_at_draft,
       COALESCE(
         workbench.line_resolution_drafts,
         '{}'::jsonb
       ) AS line_resolution_drafts,
       workbench.sync_state,
       workbench.row_version::text AS workbench_row_version,
       COALESCE(
         latest_provider.source_hash,
         candidate.source_hash
       ) AS latest_provider_source_hash,
       COALESCE(
         provider_status.lifecycle_status,
         candidate.normalized_order_status
       ) AS provider_lifecycle_status,
       COALESCE(
         provider_status.fulfillment_status,
         candidate.normalized_fulfillment_status
       ) AS provider_fulfillment_status,
       COALESCE(
         provider_status.observed_at,
         candidate.observed_at
       ) AS provider_status_observed_at,
       COALESCE(
         provider_status.source,
         'retained'::text
       ) AS provider_status_source,
       provider_status.observation_kind
         AS current_provider_observation_kind,
       provider_status.currency AS current_provider_currency,
       provider_status.provider_total_minor::text
         AS current_provider_total_minor,
       exact_history.observed_at AS latest_exact_history_observed_at,
       selected.activity_at,
       selected.tracking_number,
       selected.cursor_sort_value,
       selected.matching_total_count,
       selected.result_set_revision
     FROM page_candidate_ids selected
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = $1::uuid
      AND candidate.id = selected.candidate_id
     JOIN operations_integration_accounts account
       ON account.organization_id = candidate.organization_id
      AND account.id = candidate.integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider IN ('shopify', 'faire')
     LEFT JOIN LATERAL (
       SELECT min(current_subject.provider_location_id)
                AS provider_location_id
       FROM (
         SELECT DISTINCT ON (
                  COALESCE(
                    NULLIF(btrim(event.external_subject_id), ''),
                    NULLIF(btrim(event.external_event_id), ''),
                    '__order__'
                  )
                )
                NULLIF(btrim(event.provider_location_id), '')
                  AS provider_location_id
         FROM operations_commerce_order_event_observations event
         WHERE event.organization_id = candidate.organization_id
           AND event.integration_account_id = candidate.integration_account_id
           AND event.provider = candidate.provider
           AND event.external_order_id = candidate.external_order_id
           AND NULLIF(btrim(event.provider_location_id), '') IS NOT NULL
         ORDER BY COALESCE(
                    NULLIF(btrim(event.external_subject_id), ''),
                    NULLIF(btrim(event.external_event_id), ''),
                    '__order__'
                  ),
                  GREATEST(
                    event.occurred_at,
                    event.observed_at,
                    event.created_at
                  ) DESC,
                  event.id DESC
       ) current_subject
       HAVING count(DISTINCT current_subject.provider_location_id) = 1
     ) latest_provider_location ON true
     LEFT JOIN LATERAL (
       SELECT warehouse.name AS warehouse_name
       FROM operations_commerce_inventory_location_mappings mapping
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = mapping.organization_id
        AND warehouse.id = mapping.warehouse_id
       JOIN operations_locations location
         ON location.organization_id = mapping.organization_id
        AND location.id = mapping.location_id
        AND location.warehouse_id = warehouse.id
        AND location.active = true
       WHERE mapping.organization_id = candidate.organization_id
         AND mapping.integration_account_id = candidate.integration_account_id
         AND mapping.active = true
         AND mapping.external_location_id
               = latest_provider_location.provider_location_id
         AND warehouse.status = 'active'
       ORDER BY mapping.updated_at DESC, mapping.id DESC
       LIMIT 1
     ) provider_warehouse ON true
     LEFT JOIN operations_commerce_order_workbench workbench
       ON workbench.organization_id = candidate.organization_id
      AND workbench.integration_account_id = candidate.integration_account_id
      AND workbench.external_order_id = candidate.external_order_id
     LEFT JOIN operations_orders canonical_order
       ON canonical_order.organization_id = candidate.organization_id
      AND canonical_order.id = candidate.canonical_order_id
     LEFT JOIN LATERAL (
       SELECT provider_candidate.id,
              provider_candidate.source_hash
       FROM operations_commerce_order_candidates provider_candidate
       WHERE provider_candidate.organization_id = candidate.organization_id
         AND provider_candidate.integration_account_id
           = candidate.integration_account_id
         AND provider_candidate.external_order_id
           = candidate.external_order_id
         AND provider_candidate.workflow_state <> 'failed'
       ORDER BY
         COALESCE(
           provider_candidate.provider_updated_at,
           provider_candidate.observed_at
         ) DESC,
         provider_candidate.observed_at DESC,
         provider_candidate.created_at DESC,
         provider_candidate.id DESC
       LIMIT 1
     ) latest_provider ON true
     LEFT JOIN LATERAL (
       SELECT status_evidence.lifecycle_status,
              status_evidence.fulfillment_status,
              status_evidence.observed_at,
              status_evidence.source,
              status_evidence.observation_kind,
              status_evidence.currency,
              status_evidence.provider_total_minor
       FROM (
         SELECT provider_candidate.normalized_order_status
                  AS lifecycle_status,
                provider_candidate.normalized_fulfillment_status
                  AS fulfillment_status,
                provider_candidate.provider_updated_at,
                provider_candidate.observed_at,
                'operational'::text AS source,
                NULL::text AS observation_kind,
                NULL::text AS currency,
                NULL::bigint AS provider_total_minor,
                0::integer AS source_priority,
                provider_candidate.id AS evidence_id
         FROM operations_commerce_order_candidates provider_candidate
         WHERE provider_candidate.organization_id = candidate.organization_id
           AND provider_candidate.integration_account_id
             = candidate.integration_account_id
           AND provider_candidate.external_order_id
             = candidate.external_order_id
           AND provider_candidate.workflow_state <> 'failed'
         UNION ALL
         SELECT observation.canonical_lifecycle_state,
                observation.canonical_fulfillment_state,
                observation.provider_updated_at,
                observation.observed_at,
                'history'::text AS source,
                observation.observation_kind::text,
                observation.currency,
                observation.provider_total_minor,
                1::integer AS source_priority,
                observation.id AS evidence_id
         FROM operations_commerce_order_observations observation
         WHERE observation.organization_id = candidate.organization_id
           AND observation.integration_account_id
             = candidate.integration_account_id
           AND observation.provider = candidate.provider
           AND observation.external_order_id = candidate.external_order_id
       ) status_evidence
       ORDER BY
         COALESCE(
           status_evidence.provider_updated_at,
           status_evidence.observed_at
         ) DESC,
         status_evidence.observed_at DESC,
         status_evidence.source_priority DESC,
         status_evidence.evidence_id DESC
       LIMIT 1
     ) provider_status ON true
     LEFT JOIN LATERAL (
       SELECT observation.observed_at
       FROM operations_commerce_order_observations observation
       WHERE observation.organization_id = candidate.organization_id
         AND observation.integration_account_id
           = candidate.integration_account_id
         AND observation.provider = candidate.provider
         AND observation.external_order_id = candidate.external_order_id
         AND observation.observation_kind IN (
           'manual_exact_read', 'webhook_exact_read'
         )
       ORDER BY COALESCE(
                  observation.provider_updated_at,
                  observation.observed_at
                ) DESC,
                observation.observed_at DESC,
                observation.id DESC
       LIMIT 1
     ) exact_history ON true
     CROSS JOIN LATERAL (
       SELECT CASE
         WHEN COALESCE(
           provider_status.lifecycle_status,
           candidate.normalized_order_status
         ) IN ('cancelled', 'closed')
         OR COALESCE(
           provider_status.fulfillment_status,
           candidate.normalized_fulfillment_status
         ) IN ('fulfilled', 'cancelled')
         THEN COALESCE(latest_provider.id, candidate.id)
         ELSE candidate.id
       END AS id
     ) display_candidate
     JOIN operations_commerce_order_candidates display_snapshot
       ON display_snapshot.organization_id = candidate.organization_id
      AND display_snapshot.id = display_candidate.id
     LEFT JOIN crm_organizations display_customer
       ON display_customer.pipeline_id = display_snapshot.pipeline_id
      AND display_customer.id = display_snapshot.customer_id
     LEFT JOIN crm_organizations display_resolved_customer
       ON display_resolved_customer.pipeline_id = display_snapshot.pipeline_id
      AND display_resolved_customer.id = display_snapshot.customer_id
     CROSS JOIN LATERAL (
       SELECT count(*)::text AS line_count,
              COALESCE(bool_or(
                line.unfulfilled_quantity > 0
                AND line.requires_shipping
                AND line.unit_multiplier <> 1
                AND line.packaging_state <> 'resolved'
              ), false) AS pack_facts_still_required
       FROM operations_commerce_order_candidate_lines line
       WHERE line.organization_id = candidate.organization_id
         AND line.integration_account_id = candidate.integration_account_id
         AND line.order_candidate_id = display_candidate.id
     ) line_count
     ORDER BY selected.cursor_sort_value ${orderDirection},
              selected.candidate_id ${orderDirection}`,
    [
      organizationId,
      candidateGlobalId,
      searchPattern,
      provider,
      tracking,
      updatedAfter,
      Boolean(cursor),
      cursor?.sortValue ?? null,
      cursor?.candidateId ?? null,
      pageSize + 1,
      status,
    ],
  )
  const hasNextPage = result.rows.length > pageSize
  const pageRows = result.rows.slice(0, pageSize)
  const detailsByCandidate = new Map<string, WorkbenchResolutionDetails>()
  if (input.includeResolutionDetails && pageRows.length) {
    const candidateIds = [...new Set(
      pageRows.map((row) => row.display_candidate_id),
    )]
    const [lines, customers, products] = await Promise.all([
      query<WorkbenchLineReadRow>(
        `SELECT line.order_candidate_id::text AS candidate_id,
                line.global_id, line.external_line_id,
                line.product_title_snapshot, line.sku_snapshot,
                line.normalized_status,
                line.ordered_quantity::text,
                line.current_quantity::text,
                line.cancelled_quantity::text,
                line.fulfilled_quantity::text,
                line.unfulfilled_quantity::text,
                line.returned_quantity::text,
                line.unit_multiplier::text,
                line.requires_shipping,
                line.mapping_state, line.price_resolution_state,
                line.packaging_state,
                product.reference_code AS product_global_id,
                line.resolved_unit_price_minor::text,
                line.unit_price_minor::text AS provider_unit_price_minor,
                line.resolved_currency_code, line.currency_code
                  AS provider_currency_code,
                profile.global_id AS package_profile_global_id,
                line.blocking_codes
         FROM operations_commerce_order_candidate_lines line
         LEFT JOIN crm_products product
           ON product.pipeline_id = line.pipeline_id
          AND product.id = line.product_id
         LEFT JOIN operations_product_package_profiles profile
           ON profile.organization_id = line.organization_id
          AND profile.pipeline_id = line.pipeline_id
          AND profile.product_id = line.product_id
          AND profile.id = line.package_profile_id
         WHERE line.organization_id = $1::uuid
           AND line.order_candidate_id = ANY($2::uuid[])
         ORDER BY line.created_at, line.id`,
        [organizationId, candidateIds],
      ),
      query<CustomerOptionRow>(
        `SELECT DISTINCT customer.reference_code, customer.name, customer.email
         FROM operations_commerce_order_candidates candidate
         JOIN crm_organizations customer
           ON customer.pipeline_id = candidate.pipeline_id
          AND customer.relationship_type = 'customer'
          AND COALESCE(lower(customer.source_payload->>'archived'), 'false')
              NOT IN ('true', '1', 'yes')
         WHERE candidate.organization_id = $1::uuid
           AND candidate.id = ANY($2::uuid[])
         ORDER BY customer.name, customer.reference_code
         LIMIT 1000`,
        [organizationId, candidateIds],
      ),
      query<ProductOptionRow>(
        `SELECT DISTINCT product.id::text AS product_id,
                product.reference_code, product.name, product.sku,
                profile.global_id AS package_profile_global_id,
                profile.profile_name AS package_profile_name,
                profile.is_default AS package_profile_is_default
         FROM operations_commerce_order_candidates candidate
         JOIN crm_products product
           ON product.pipeline_id = candidate.pipeline_id
          AND COALESCE(lower(product.source_payload->>'archived'), 'false')
              NOT IN ('true', '1', 'yes')
         LEFT JOIN operations_product_package_profiles profile
           ON profile.organization_id = candidate.organization_id
          AND profile.pipeline_id = product.pipeline_id
          AND profile.product_id = product.id
          AND profile.active = true
         WHERE candidate.organization_id = $1::uuid
           AND candidate.id = ANY($2::uuid[])
         ORDER BY product.name, product.reference_code,
                  profile.is_default DESC NULLS LAST,
                  profile.profile_name
         LIMIT 3000`,
        [organizationId, candidateIds],
      ),
    ])
    for (const row of pageRows) {
      detailsByCandidate.set(row.candidate_id, {
        lines: lines.rows.filter((line) => (
          line.candidate_id === row.display_candidate_id
        )),
        customers: customers.rows,
        products: products.rows,
      })
    }
  }
  const total = pageRows.length
    ? Number(pageRows[0].matching_total_count)
    : cursor?.total || 0
  const resultSetRevision = pageRows[0]?.result_set_revision
    || (total === 0 ? EMPTY_RESULT_SET_REVISION : null)
  if (!Number.isSafeInteger(total) || total < pageRows.length) {
    requestError(
      'OPERATIONS_PAGE_EVIDENCE_INVALID',
      'Imported-order pagination returned invalid evidence',
      500,
    )
  }
  if (resultSetRevision !== null && !RESULT_SET_REVISION.test(resultSetRevision)) {
    requestError(
      'OPERATIONS_PAGE_EVIDENCE_INVALID',
      'Imported-order pagination returned invalid revision evidence',
      500,
    )
  }
  const lastRow = pageRows.at(-1) || null
  const nextCursor = hasNextPage && lastRow
    ? encodeWorkbenchPageCursor(lastRow, total, scopeHash, sort)
    : null
  const sourceEvidence = pageRows.map((row): OperationsOrderSourceEvidence => ({
    rowCursor: encodeWorkbenchPageCursor(row, total, scopeHash, sort),
    sortValue: sort === 'updated'
      ? (row.cursor_sort_value as Date).toISOString()
      : String(row.cursor_sort_value),
    providerIdentity: {
      integrationAccountGlobalId: row.integration_account_global_id,
      externalOrderId: row.external_order_id,
    },
  }))
  const providerHistoryByCandidate = new Map<
    string,
    OperationsImportedOrderWorkingCopy['providerHistory']
  >()
  if (
    input.includeResolutionDetails
    && candidateGlobalId
    && pageRows.length === 1
  ) {
    const row = pageRows[0]
    const timeline =
      await readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
        organizationId,
        accountGlobalId: row.integration_account_global_id,
        externalOrderId: row.external_order_id,
        providerObservationKinds: [
          'manual_exact_read',
          'webhook_exact_read',
        ],
      })
    providerHistoryByCandidate.set(
      row.candidate_id,
      {
        ...operationsProviderHistoryFromTimeline(timeline),
        observedAt:
          row.latest_exact_history_observed_at?.toISOString() || null,
      },
    )
  }
  return {
    orders: pageRows.map((row) => mappedWorkingCopy(
      row,
      detailsByCandidate.get(row.candidate_id) || null,
      providerHistoryByCandidate.get(row.candidate_id)
        || emptyOperationsProviderOrderHistory(
          row.latest_exact_history_observed_at?.toISOString() || null,
        ),
    )),
    page: {
      total,
      returned: pageRows.length,
      pageSize,
      nextCursor,
      complete: nextCursor === null,
      truncated: nextCursor !== null,
    },
    internal: {
      rowCursors: sourceEvidence.map((evidence) => evidence.rowCursor),
      sortValues: sourceEvidence.map((evidence) => evidence.sortValue),
      providerIdentities: sourceEvidence.map((evidence) => (
        evidence.providerIdentity as OperationsOrderProviderIdentity
      )),
      sourceEvidence,
      resultSetRevision,
    },
  }
}

export async function readCommerceOrderWorkbenchFromPostgres(input: {
  organizationId: string
  search?: string | null
  candidateGlobalId?: string | null
  includeResolutionDetails?: boolean
}): Promise<OperationsImportedOrderWorkingCopy[]> {
  const orders: OperationsImportedOrderWorkingCopy[] = []
  let cursor: string | null = null
  for (
    let pageNumber = 0;
    pageNumber < MAX_WORKBENCH_COLLECTION_PAGES;
    pageNumber += 1
  ) {
    const result = await readCommerceOrderWorkbenchPageFromPostgres({
      ...input,
      cursor,
      pageSize: input.candidateGlobalId ? 1 : MAX_WORKBENCH_PAGE_SIZE,
    })
    orders.push(...result.orders)
    cursor = result.page.nextCursor
    if (!cursor) return orders
  }
  requestError(
    'OPERATIONS_IMPORTED_ORDER_RESULT_LIMIT',
    `More than ${orders.length} imported orders matched; use paged reads or refine the search`,
    413,
    { loaded: orders.length },
  )
}

async function prepareReceipt(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    candidateGlobalId: string
    idempotencyKey: string
    requestHash: string
  },
) {
  await acquireTransactionAdvisoryLock(
    client,
    `commerce-order-workbench-receipt:${input.organizationId}:${input.idempotencyKey}`,
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
      || (
        receipt.target_global_id
        && receipt.target_global_id !== input.candidateGlobalId
      )
    ) {
      requestError(
        'OPERATIONS_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different order edit',
      )
    }
    if (receipt.status === 'succeeded') {
      return { receipt, replayed: true }
    }
    // The local edit and the candidate handoff intentionally cross transaction
    // boundaries. The receipt advisory lock serializes the checkpoint update;
    // exact retries may then resume immediately instead of waiting for a stale
    // processing timeout. Every downstream candidate command has its own
    // deterministic idempotency key, so a concurrent exact retry cannot create
    // a second confirmation, validation, or canonical order.
    const retried = await client.query<CommandReceiptRow>(
      `UPDATE operations_command_receipts
       SET status = 'processing',
           actor_email = $2,
           target_global_id = $3,
           attempts = attempts + 1,
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           started_at = now(),
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id::text, request_hash, target_global_id, status,
                 correlation_id::text, result_payload, updated_at`,
      [receipt.id, input.actorEmail, input.candidateGlobalId],
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
      input.candidateGlobalId,
    ],
  )
  return { receipt: created.rows[0], replayed: false }
}

function replayedResult(
  receipt: CommandReceiptRow,
): OperationsImportedOrderShipToUpdateResult {
  const payload = receipt.result_payload
  if (
    !payload
    || typeof payload.candidateGlobalId !== 'string'
    || !Number.isSafeInteger(payload.rowVersion)
    || !Array.isArray(payload.issues)
    || !Array.isArray(payload.changedFields)
    || (
      payload.canonicalOrderGlobalId !== null
      && typeof payload.canonicalOrderGlobalId !== 'string'
    )
    || !['not_ready', 'needs_info', 'promoted'].includes(
      String(payload.promotionStatus || ''),
    )
    || !Array.isArray(payload.remainingBlockerCodes)
  ) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_RESULT_INVALID',
      'The saved order edit could not be reloaded',
      500,
    )
  }
  return {
    ...(payload as Omit<
      OperationsImportedOrderShipToUpdateResult,
      'replayed'
    >),
    replayed: true,
  }
}

type SavedDraft = {
  receipt: CommandReceiptRow
  result: OperationsImportedOrderShipToUpdateResult
  address: OrderShipToDraft
  resolution: OperationsImportedOrderResolutionDraft
  candidate: LockedCandidateRow
}

type CandidateCommandResult = {
  rowVersion?: number
  ready?: boolean
  blockers?: unknown[]
  canonicalOrderGlobalId?: string
}

function checkpointResult(
  receipt: CommandReceiptRow,
): OperationsImportedOrderShipToUpdateResult {
  return { ...replayedResult(receipt), replayed: false }
}

function carrierAddress(address: OrderShipToDraft) {
  if (orderShipToReadiness(address) !== 'carrier_ready') {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_ADDRESS_INCOMPLETE',
      'Complete the ship-to address before handing off the imported order',
      422,
    )
  }
  return {
    name: address.name!,
    line1: address.line1!,
    line2: address.line2,
    city: address.city!,
    region: address.region!,
    postalCode: address.postalCode!,
    country: address.country!,
  }
}

function blockerCodes(values: unknown[] | undefined) {
  return [...new Set((values || []).map((value) => {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
    return String((value as Record<string, unknown>).code || '').trim()
  }).filter(Boolean))].sort()
}

type HandoffResolutionState = {
  row_version: string
  customer_resolution_state: string
  customer_global_id: string | null
  delivery_resolution_state: string
  provider_requested_delivery_at: Date | null
  requested_delivery_at: Date | null
  lines: Array<{
    globalId: string
    mappingState: string
    priceResolutionState: string
    packagingState: string
    productGlobalId: string | null
    unitPriceMinor: string | null
    currency: string | null
    packageProfileGlobalId: string | null
  }>
}

async function readHandoffResolutionState(input: {
  organizationId: string
  candidateGlobalId: string
}): Promise<HandoffResolutionState> {
  const selected = await query<{
    row_version: string
    customer_resolution_state: string
    customer_global_id: string | null
    delivery_resolution_state: string
    provider_requested_delivery_at: Date | null
    requested_delivery_at: Date | null
  }>(
    `SELECT candidate.row_version::text,
            candidate.customer_resolution_state,
            customer.reference_code AS customer_global_id,
            candidate.delivery_resolution_state,
            candidate.provider_requested_delivery_at,
            candidate.requested_delivery_at
     FROM operations_commerce_order_candidates candidate
     LEFT JOIN crm_organizations customer
       ON customer.pipeline_id = candidate.pipeline_id
      AND customer.id = candidate.customer_id
     WHERE candidate.organization_id = $1::uuid
       AND candidate.global_id = $2`,
    [input.organizationId, input.candidateGlobalId],
  )
  const candidate = selected.rows[0]
  if (!candidate) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_NOT_FOUND',
      'Imported order is no longer available',
      404,
    )
  }
  const lines = await query<{
    global_id: string
    mapping_state: string
    price_resolution_state: string
    packaging_state: string
    product_global_id: string | null
    unit_price_minor: string | null
    currency: string | null
    package_profile_global_id: string | null
  }>(
    `SELECT line.global_id, line.mapping_state,
            line.price_resolution_state, line.packaging_state,
            product.reference_code AS product_global_id,
            line.resolved_unit_price_minor::text AS unit_price_minor,
            line.resolved_currency_code AS currency,
            profile.global_id AS package_profile_global_id
     FROM operations_commerce_order_candidate_lines line
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = line.organization_id
      AND candidate.integration_account_id = line.integration_account_id
      AND candidate.id = line.order_candidate_id
     LEFT JOIN crm_products product
       ON product.pipeline_id = line.pipeline_id
      AND product.id = line.product_id
     LEFT JOIN operations_product_package_profiles profile
       ON profile.organization_id = line.organization_id
      AND profile.pipeline_id = line.pipeline_id
      AND profile.product_id = line.product_id
      AND profile.id = line.package_profile_id
     WHERE candidate.organization_id = $1::uuid
       AND candidate.global_id = $2
       AND line.unfulfilled_quantity > 0
     ORDER BY line.created_at, line.id`,
    [input.organizationId, input.candidateGlobalId],
  )
  return {
    ...candidate,
    lines: lines.rows.map((line) => ({
      globalId: line.global_id,
      mappingState: line.mapping_state,
      priceResolutionState: line.price_resolution_state,
      packagingState: line.packaging_state,
      productGlobalId: line.product_global_id,
      unitPriceMinor: line.unit_price_minor,
      currency: line.currency,
      packageProfileGlobalId: line.package_profile_global_id,
    })),
  }
}

function sameTimestamp(left: Date | null, right: string | null) {
  if (!left || !right) return false
  return left.toISOString() === new Date(right).toISOString()
}

async function applyWorkbenchResolutionDraft(input: {
  organizationId: string
  actorEmail: string
  receiptId: string
  candidateGlobalId: string
  runtime: NonNullable<Awaited<ReturnType<
    typeof readCommerceRuntimeCredentialFromPostgres
  >>>
  resolution: OperationsImportedOrderResolutionDraft
}) {
  let state = await readHandoffResolutionState(input)
  let rowVersion = Number(state.row_version)
  if (
    input.resolution.customerGlobalId
    && (
      state.customer_resolution_state !== 'resolved'
      || state.customer_global_id !== input.resolution.customerGlobalId
    )
  ) {
    const result = await resolveCommerceCandidateCustomerInPostgres({
      runtime: input.runtime,
      actorEmail: input.actorEmail,
      idempotencyKey: `workbench:${input.receiptId}:resolve-customer`,
      candidateGlobalId: input.candidateGlobalId,
      candidateRowVersion: rowVersion,
      customer: {
        mode: 'existing',
        customerGlobalId: input.resolution.customerGlobalId,
      },
    }) as CandidateCommandResult
    rowVersion = Number(result.rowVersion)
  }
  if (input.resolution.requestedDeliveryAt) {
    state = await readHandoffResolutionState(input)
    rowVersion = Number(state.row_version)
    if (!sameTimestamp(
      state.requested_delivery_at,
      input.resolution.requestedDeliveryAt,
    )) {
      const providerSelected = sameTimestamp(
        state.provider_requested_delivery_at,
        input.resolution.requestedDeliveryAt,
      )
      const result = await resolveCommerceCandidateDeliveryInPostgres({
        runtime: input.runtime,
        actorEmail: input.actorEmail,
        idempotencyKey: `workbench:${input.receiptId}:resolve-delivery`,
        candidateGlobalId: input.candidateGlobalId,
        candidateRowVersion: rowVersion,
        decision: {
          mode: providerSelected ? 'provider' : 'manual',
          requestedDeliveryAt: providerSelected
            ? null
            : input.resolution.requestedDeliveryAt,
        },
      }) as CandidateCommandResult
      rowVersion = Number(result.rowVersion)
    }
  }
  for (const draft of input.resolution.lines) {
    if (draft.unitPriceMinor === null) continue
    state = await readHandoffResolutionState(input)
    rowVersion = Number(state.row_version)
    let line = state.lines.find((candidate) => (
      candidate.globalId === draft.lineGlobalId
    ))
    if (!line) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_LINE_CHANGED',
        'An order line changed. Refresh the order before saving',
        409,
      )
    }
    if (
      line.mappingState !== 'resolved'
      || line.productGlobalId !== draft.productGlobalId
      || line.priceResolutionState === 'unresolved'
      || line.unitPriceMinor !== String(draft.unitPriceMinor)
      || line.currency !== draft.currency
    ) {
      const result = await resolveCommerceCandidateProductInPostgres({
        runtime: input.runtime,
        actorEmail: input.actorEmail,
        idempotencyKey:
          `workbench:${input.receiptId}:resolve-product:${draft.lineGlobalId}`,
        candidateGlobalId: input.candidateGlobalId,
        candidateRowVersion: rowVersion,
        lineGlobalId: draft.lineGlobalId,
        product: {
          mode: 'existing',
          productGlobalId: draft.productGlobalId,
          unitPriceMinor: draft.unitPriceMinor,
          currency: draft.currency,
        },
      }) as CandidateCommandResult
      rowVersion = Number(result.rowVersion)
      state = await readHandoffResolutionState(input)
      line = state.lines.find((candidate) => (
        candidate.globalId === draft.lineGlobalId
      ))!
    }
    if (
      draft.packageProfileGlobalId
      && (
        line.packagingState !== 'resolved'
        || line.packageProfileGlobalId !== draft.packageProfileGlobalId
      )
    ) {
      const result = await resolveCommerceCandidatePackageInPostgres({
        runtime: input.runtime,
        actorEmail: input.actorEmail,
        idempotencyKey:
          `workbench:${input.receiptId}:resolve-package:${draft.lineGlobalId}`,
        candidateGlobalId: input.candidateGlobalId,
        candidateRowVersion: Number(state.row_version),
        lineGlobalId: draft.lineGlobalId,
        package: {
          mode: 'profile',
          packageProfileGlobalId: draft.packageProfileGlobalId,
        },
      }) as CandidateCommandResult
      rowVersion = Number(result.rowVersion)
    }
  }
  return rowVersion
}

async function completeWorkbenchReceipt(input: {
  organizationId: string
  actorEmail: string
  receiptId: string
  result: OperationsImportedOrderShipToUpdateResult
  canonicalOrderGlobalId?: string | null
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-workbench-receipt:${input.organizationId}:${input.receiptId}`,
    )
    const receiptResult = await client.query<CommandReceiptRow>(
      `SELECT id::text, request_hash, target_global_id, status,
              correlation_id::text, result_payload, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND command_type = $3
       FOR UPDATE`,
      [input.organizationId, input.receiptId, COMMAND_TYPE],
    )
    const receipt = receiptResult.rows[0]
    if (!receipt) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_RECEIPT_MISSING',
        'The saved order edit receipt is unavailable',
        500,
      )
    }
    if (receipt.status === 'succeeded') return replayedResult(receipt)

    let result = input.result
    const canonicalOrderGlobalId = input.canonicalOrderGlobalId || null
    if (canonicalOrderGlobalId) {
      const linked = await client.query<{
        row_version: string
        canonical_order_id: string
        canonical_order_global_id: string
      }>(
        `WITH canonical AS (
           SELECT candidate.canonical_order_id,
                  canonical_order.global_id AS canonical_order_global_id
           FROM operations_commerce_order_candidates candidate
           JOIN operations_orders canonical_order
             ON canonical_order.organization_id = candidate.organization_id
            AND canonical_order.id = candidate.canonical_order_id
           WHERE candidate.organization_id = $1::uuid
             AND candidate.global_id = $2
             AND canonical_order.global_id = $3
         ), updated AS (
           UPDATE operations_commerce_order_workbench workbench
           SET canonical_order_id = canonical.canonical_order_id,
               row_version = CASE
                 WHEN workbench.canonical_order_id IS DISTINCT FROM
                      canonical.canonical_order_id
                   THEN workbench.row_version + 1
                 ELSE workbench.row_version
               END,
               updated_by = $4,
               updated_at = now()
           FROM canonical
           WHERE workbench.organization_id = $1::uuid
             AND workbench.candidate_id = (
               SELECT id FROM operations_commerce_order_candidates
               WHERE organization_id = $1::uuid AND global_id = $2
             )
             AND (
               workbench.canonical_order_id IS NULL
               OR workbench.canonical_order_id = canonical.canonical_order_id
             )
           RETURNING workbench.row_version::text,
                     workbench.canonical_order_id::text
         )
         SELECT updated.row_version, updated.canonical_order_id,
                canonical.canonical_order_global_id
         FROM updated CROSS JOIN canonical`,
        [
          input.organizationId,
          result.candidateGlobalId,
          canonicalOrderGlobalId,
          input.actorEmail,
        ],
      )
      if (!linked.rows[0]) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_CANONICAL_LINK_INVALID',
          'The promoted order could not be linked to its working copy',
          500,
        )
      }
      result = {
        ...result,
        canonicalOrderGlobalId: linked.rows[0].canonical_order_global_id,
        rowVersion: Number(linked.rows[0].row_version),
        promotionStatus: 'promoted',
        remainingBlockerCodes: [],
      }
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'operations.commerce_order_workbench.canonical_linked',
        aggregateType: 'operations.order',
        aggregateId: linked.rows[0].canonical_order_global_id,
        subject: linked.rows[0].canonical_order_global_id,
        organizationId: input.organizationId,
        eventKey: `operations:commerce-order-workbench:${input.receiptId}:canonical`,
        payload: {
          candidateGlobalId: result.candidateGlobalId,
          canonicalOrderGlobalId: linked.rows[0].canonical_order_global_id,
          commandReceiptId: input.receiptId,
          providerWrites: 0,
          providerWriteIntentCreated: false,
        },
      }, client)
    }
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
      [
        receipt.id,
        result.canonicalOrderGlobalId || result.candidateGlobalId,
        JSON.stringify(result),
      ],
    )
    return result
  })
}

async function handoffCompleteDraft(input: {
  organizationId: string
  actorEmail: string
  exactRequestHash: string
  saved: SavedDraft
}) {
  const { saved } = input
  if (saved.candidate.canonical_order_global_id) {
    return completeWorkbenchReceipt({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      receiptId: saved.receipt.id,
      result: saved.result,
      canonicalOrderGlobalId: saved.candidate.canonical_order_global_id,
    })
  }
  if (saved.result.providerVersionChanged) {
    // A refresh/rebase is an explicit future command: never replace the local
    // draft with the newer provider snapshot as a side effect of Save.
    return completeWorkbenchReceipt({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      receiptId: saved.receipt.id,
      result: {
        ...saved.result,
        promotionStatus: 'needs_info',
        remainingBlockerCodes: ['provider_refresh_rebase_required'],
      },
    })
  }
  if (
    !saved.candidate.live_for_new_draft
    || ['failed', 'expired'].includes(saved.candidate.workflow_state)
  ) {
    return completeWorkbenchReceipt({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      receiptId: saved.receipt.id,
      result: {
        ...saved.result,
        promotionStatus: 'needs_info',
        remainingBlockerCodes: ['candidate_refresh_required'],
      },
    })
  }
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId: input.organizationId,
    accountGlobalId: saved.candidate.account_global_id,
  })
  if (!runtime || runtime.verificationStatus !== 'verified') {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_CONNECTION_REVALIDATION_REQUIRED',
      'Revalidate the commerce connection before importing this completed order',
      409,
    )
  }
  const resolvedRowVersion = await applyWorkbenchResolutionDraft({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    receiptId: saved.receipt.id,
    candidateGlobalId: saved.result.candidateGlobalId,
    runtime,
    resolution: saved.resolution,
  })
  const preflightValidation = await validateCommerceCandidateInPostgres({
    runtime,
    actorEmail: input.actorEmail,
    idempotencyKey: `workbench:${saved.receipt.id}:preflight-validate`,
    candidateGlobalId: saved.result.candidateGlobalId,
    candidateRowVersion: resolvedRowVersion,
  }) as CandidateCommandResult
  const preflightRowVersion = Number(preflightValidation.rowVersion)
  if (!Number.isSafeInteger(preflightRowVersion)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_HANDOFF_INVALID',
      'The imported-order preflight result was invalid',
      500,
    )
  }
  const remainingBlockerCodes = blockerCodes(
    preflightValidation.blockers,
  ).filter((code) => !ADDRESS_BLOCKERS.has(code))
  if (remainingBlockerCodes.length) {
    // Keep a completed local address in the workbench until every unrelated
    // intake fact is ready. Confirming it on the provider candidate early
    // would destroy the three-way refresh base and make a later provider
    // rebase unable to distinguish source data from the user's local edits.
    return completeWorkbenchReceipt({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      receiptId: saved.receipt.id,
      result: {
        ...saved.result,
        promotionStatus: 'needs_info',
        remainingBlockerCodes,
      },
    })
  }
  let confirmedRowVersion = preflightRowVersion
  if (saved.candidate.requires_carrier_address) {
    const addressResult = await confirmCommerceCandidateAddressInPostgres({
      runtime,
      actorEmail: input.actorEmail,
      idempotencyKey: `workbench:${saved.receipt.id}:confirm-address`,
      candidateGlobalId: saved.result.candidateGlobalId,
      candidateRowVersion: preflightRowVersion,
      address: carrierAddress(saved.address),
    }) as CandidateCommandResult
    confirmedRowVersion = Number(addressResult.rowVersion)
    if (!Number.isSafeInteger(confirmedRowVersion)) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_HANDOFF_INVALID',
        'The address confirmation result was invalid',
        500,
      )
    }
  }
  const validationResult = await validateCommerceCandidateInPostgres({
    runtime,
    actorEmail: input.actorEmail,
    idempotencyKey: `workbench:${saved.receipt.id}:validate`,
    candidateGlobalId: saved.result.candidateGlobalId,
    candidateRowVersion: confirmedRowVersion,
  }) as CandidateCommandResult
  const validatedRowVersion = Number(validationResult.rowVersion)
  if (!Number.isSafeInteger(validatedRowVersion)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_HANDOFF_INVALID',
      'The imported-order validation result was invalid',
      500,
    )
  }
  if (validationResult.ready !== true) {
    return completeWorkbenchReceipt({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      receiptId: saved.receipt.id,
      result: {
        ...saved.result,
        promotionStatus: 'needs_info',
        remainingBlockerCodes: blockerCodes(validationResult.blockers),
      },
    })
  }
  const promotion = await promoteCommerceCandidateInPostgres({
    runtime,
    actorEmail: input.actorEmail,
    idempotencyKey: `workbench:${saved.receipt.id}:promote`,
    candidateGlobalId: saved.result.candidateGlobalId,
    candidateRowVersion: validatedRowVersion,
    requestHash: requestHash({
      candidateGlobalId: saved.result.candidateGlobalId,
      workbenchRequestHash: input.exactRequestHash,
      commandReceiptId: saved.receipt.id,
      providerWrites: 0,
    }),
  }) as CandidateCommandResult
  if (!promotion.canonicalOrderGlobalId) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_PROMOTION_INVALID',
      'The canonical order result was invalid',
      500,
    )
  }
  return completeWorkbenchReceipt({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    receiptId: saved.receipt.id,
    result: saved.result,
    canonicalOrderGlobalId: promotion.canonicalOrderGlobalId,
  })
}

async function saveOrAcceptCommerceOrderWorkbenchInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  expectedRowVersion: number
  changes: OrderShipToPatch
  resolutionDraft?: OperationsImportedOrderResolutionDraft
  action: 'save' | 'accept'
  /** Test-only crash seam after the durable local checkpoint commits. */
  afterLocalSaveBeforeHandoff?: () => void | Promise<void>
}): Promise<OperationsImportedOrderShipToUpdateResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const candidateGlobalId = requireCandidateGlobalId(input.candidateGlobalId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (!actorEmail) {
    requestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    requestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
      400,
    )
  }
  if (
    !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
  ) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_VERSION_INVALID',
      'Imported order version is invalid',
      400,
    )
  }
  const requestedResolution = normalizedResolutionDraft(input.resolutionDraft)
  if (
    input.action === 'save'
    && !Object.keys(input.changes).length
    && !requestedResolution.customerGlobalId
    && !requestedResolution.requestedDeliveryAt
    && !requestedResolution.lines.length
  ) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_EDIT_EMPTY',
      'Choose at least one order field to update',
      400,
    )
  }
  const exactRequestHash = requestHash({
    action: input.action,
    candidateGlobalId,
    expectedRowVersion: input.expectedRowVersion,
    changes: input.changes,
    resolution: requestedResolution,
  })
  const saved = await withTransaction<
    SavedDraft | OperationsImportedOrderShipToUpdateResult
  >(async (client) => {
    const prepared = await prepareReceipt(client, {
      organizationId,
      actorEmail,
      candidateGlobalId,
      idempotencyKey: input.idempotencyKey,
      requestHash: exactRequestHash,
    })
    if (prepared.replayed) return replayedResult(prepared.receipt)

    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-workbench-candidate:${organizationId}:${candidateGlobalId}`,
    )
    const candidateResult = await client.query<LockedCandidateRow>(
      `SELECT
         candidate.id::text,
         candidate.global_id,
         candidate.organization_id::text,
         candidate.integration_account_id::text,
         candidate.provider,
         account.global_id AS account_global_id,
         candidate.external_order_id,
         candidate.source_hash,
         candidate.provider_updated_at,
         candidate.observed_at,
         candidate.canonical_order_id::text,
         canonical_order.global_id AS canonical_order_global_id,
         candidate.workflow_state,
         candidate.blocking_codes,
         candidate.row_version::text,
         candidate.ship_to_snapshot_state,
         candidate.ship_to_snapshot_ciphertext,
         candidate.ship_to_snapshot_iv,
         candidate.ship_to_snapshot_tag,
         (
           candidate.requires_shipping
           AND EXISTS (
             SELECT 1
             FROM operations_commerce_order_candidate_lines shipping_line
             WHERE shipping_line.organization_id = candidate.organization_id
               AND shipping_line.integration_account_id
                 = candidate.integration_account_id
               AND shipping_line.order_candidate_id = candidate.id
               AND shipping_line.unfulfilled_quantity > 0
               AND shipping_line.requires_shipping
           )
         ) AS requires_carrier_address,
         (
           candidate.canonical_order_id IS NULL
           AND candidate.workflow_state IN ('held', 'resolving', 'ready')
           AND candidate.expires_at > now()
           AND run.expires_at > now()
           AND run.workflow_state <> 'expired'
         ) AS live_for_new_draft
       FROM operations_commerce_order_candidates candidate
       JOIN operations_commerce_intake_runs run
         ON run.organization_id = candidate.organization_id
        AND run.integration_account_id = candidate.integration_account_id
        AND run.pipeline_id = candidate.pipeline_id
        AND run.id = candidate.run_id
       JOIN operations_integration_accounts account
         ON account.organization_id = candidate.organization_id
        AND account.id = candidate.integration_account_id
        AND account.integration_type = 'commerce'
        AND account.provider IN ('shopify', 'faire')
       LEFT JOIN operations_orders canonical_order
         ON canonical_order.organization_id = candidate.organization_id
        AND canonical_order.id = candidate.canonical_order_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.global_id = $2
       FOR UPDATE OF candidate`,
      [organizationId, candidateGlobalId],
    )
    const candidate = candidateResult.rows[0]
    if (!candidate) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_NOT_FOUND',
        'Imported order is no longer available',
        404,
      )
    }
    // Promotion locks the candidate row before it takes the provider-order
    // identity and observation locks. Keep the same global lock order here so
    // a manager Save/Accept cannot deadlock with automatic promotion.
    await assertCommerceOrderProviderNonterminalWithClient(client, {
      organizationId,
      integrationAccountId: candidate.integration_account_id,
      provider: candidate.provider,
      externalOrderId: candidate.external_order_id,
    })
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-workbench:${organizationId}:${candidate.integration_account_id}:${candidate.external_order_id}`,
    )
    const workbenchResult = await client.query<LockedWorkbenchRow>(
      `SELECT id::text, candidate_id::text,
              accepted_provider_source_hash,
              accepted_provider_updated_at, ship_to_edit_state,
              ship_to_ciphertext, ship_to_iv, ship_to_tag,
              ship_to_source_hash, canonical_order_id::text,
              customer_global_id_draft, requested_delivery_at_draft,
              line_resolution_drafts,
              last_command_receipt_id::text, last_request_hash,
              row_version::text
       FROM operations_commerce_order_workbench
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = $3
       FOR UPDATE`,
      [organizationId, candidate.integration_account_id, candidate.external_order_id],
    )
    const current = workbenchResult.rows[0] || null
    const resolution = input.action === 'accept' && current
      ? {
          customerGlobalId: current.customer_global_id_draft,
          requestedDeliveryAt:
            current.requested_delivery_at_draft?.toISOString() || null,
          lines: Object.entries(current.line_resolution_drafts).map(([
            lineGlobalId,
            draft,
          ]) => ({ lineGlobalId, ...draft })),
        }
      : requestedResolution
    if (current && current.candidate_id !== candidate.id) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_CHANGED',
        'This order changed. Reload it before saving your edit',
      )
    }
    const resumingCheckpoint = Boolean(
      current
      && current.last_command_receipt_id === prepared.receipt.id
      && current.last_request_hash === exactRequestHash,
    )
    if (resumingCheckpoint) {
      const address = decryptAddress({
        ciphertext: current!.ship_to_ciphertext,
        iv: current!.ship_to_iv,
        tag: current!.ship_to_tag,
        organizationId,
        accountGlobalId: candidate.account_global_id,
        externalOrderId: candidate.external_order_id,
        sourceHash: current!.ship_to_source_hash,
        required: true,
      })
      return {
        receipt: prepared.receipt,
        result: checkpointResult(prepared.receipt),
        address,
        resolution: {
          customerGlobalId: current!.customer_global_id_draft,
          requestedDeliveryAt:
            current!.requested_delivery_at_draft?.toISOString() || null,
          lines: Object.entries(current!.line_resolution_drafts).map(([
            lineGlobalId,
            draft,
          ]) => ({ lineGlobalId, ...draft })),
        },
        candidate,
      }
    }
    if (candidate.canonical_order_id) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_ALREADY_CANONICAL',
        'This imported order is already available in Orders',
        409,
      )
    }
    if (!current) {
      if (!candidate.live_for_new_draft) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_NOT_FOUND',
          'Imported order is no longer available',
          404,
        )
      }
      const latestLive = await client.query<{ global_id: string }>(
        `SELECT selected.global_id
         FROM operations_commerce_order_candidates selected
         JOIN operations_commerce_intake_runs selected_run
           ON selected_run.organization_id = selected.organization_id
          AND selected_run.integration_account_id
            = selected.integration_account_id
          AND selected_run.pipeline_id = selected.pipeline_id
          AND selected_run.id = selected.run_id
         WHERE selected.organization_id = $1::uuid
           AND selected.integration_account_id = $2::uuid
           AND selected.external_order_id = $3
           AND selected.canonical_order_id IS NULL
           AND selected.workflow_state IN ('held', 'resolving', 'ready')
           AND selected.expires_at > now()
           AND selected_run.expires_at > now()
           AND selected_run.workflow_state <> 'expired'
         ORDER BY selected.observed_at DESC, selected.created_at DESC,
                  selected.id DESC
         LIMIT 1`,
        [
          organizationId,
          candidate.integration_account_id,
          candidate.external_order_id,
        ],
      )
      if (latestLive.rows[0]?.global_id !== candidateGlobalId) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_CHANGED',
          'This order changed. Reload it before saving your edit',
        )
      }
    }
    const latestProvider = await client.query<{ source_hash: string }>(
      `SELECT selected.source_hash
       FROM operations_commerce_order_candidates selected
       WHERE selected.organization_id = $1::uuid
         AND selected.integration_account_id = $2::uuid
         AND selected.external_order_id = $3
         AND selected.workflow_state <> 'failed'
       ORDER BY selected.observed_at DESC, selected.created_at DESC,
                selected.id DESC
       LIMIT 1`,
      [
        organizationId,
        candidate.integration_account_id,
        candidate.external_order_id,
      ],
    )
    const latestProviderSourceHash = latestProvider.rows[0]?.source_hash
      || candidate.source_hash
    const currentRowVersion = Number(current?.row_version || 0)
    if (currentRowVersion !== input.expectedRowVersion) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
        'This order changed. Reload it before saving your edit',
      )
    }
    const before = current && current.ship_to_edit_state !== 'provider_snapshot'
      ? decryptAddress({
          ciphertext: current.ship_to_ciphertext,
          iv: current.ship_to_iv,
          tag: current.ship_to_tag,
          organizationId,
          accountGlobalId: candidate.account_global_id,
          externalOrderId: candidate.external_order_id,
          sourceHash: current.ship_to_source_hash,
          required: true,
        })
      : decryptAddress({
          ciphertext: candidate.ship_to_snapshot_ciphertext,
          iv: candidate.ship_to_snapshot_iv,
          tag: candidate.ship_to_snapshot_tag,
          organizationId,
          accountGlobalId: candidate.account_global_id,
          externalOrderId: candidate.external_order_id,
          sourceHash: candidate.source_hash,
          required: candidate.ship_to_snapshot_state === 'protected'
            || candidate.ship_to_snapshot_state === 'confirmed',
        })
    const after = mergeOrderShipToDraft(before, input.changes)
    const readiness = orderShipToReadiness(after)
    const issues = orderShipToIssues(after)
    const changedFields = changedOrderShipToFields(before, after)
    const encrypted = encryptCommerceCandidateSnapshot(
      orderShipToStorageValue(after),
      organizationId,
      candidate.account_global_id,
      candidate.external_order_id,
      candidate.source_hash,
      'ship_to',
    )
    const shipToEditState = `local_${readiness}` as const
    const acceptedProviderSourceHash = current
      ?.accepted_provider_source_hash || candidate.source_hash
    const acceptedProviderUpdatedAt = current
      ? current.accepted_provider_updated_at
      : candidate.provider_updated_at || candidate.observed_at
    let rowVersion: number
    if (current) {
      const updated = await client.query<{ row_version: string }>(
        `UPDATE operations_commerce_order_workbench
         SET ship_to_edit_state = $4,
             ship_to_ciphertext = $5,
             ship_to_iv = $6,
             ship_to_tag = $7,
             ship_to_hash = $8,
             ship_to_source_hash = $9,
             ship_to_encryption_version = $10,
             customer_global_id_draft = $11,
             requested_delivery_at_draft = $12::timestamptz,
             line_resolution_drafts = $13::jsonb,
             sync_state = 'local_only',
             last_command_receipt_id = $14::uuid,
             last_idempotency_key = $15,
             last_request_hash = $16,
             row_version = row_version + 1,
             updated_by = $17,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND external_order_id = $3
           AND canonical_order_id IS NULL
           AND row_version = $18::bigint
         RETURNING row_version::text`,
        [
          organizationId,
          candidate.integration_account_id,
          candidate.external_order_id,
          shipToEditState,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.hash,
          candidate.source_hash,
          encrypted.encryptionVersion,
          resolution.customerGlobalId,
          resolution.requestedDeliveryAt,
          JSON.stringify(lineDraftRecord(resolution)),
          prepared.receipt.id,
          input.idempotencyKey,
          exactRequestHash,
          actorEmail,
          input.expectedRowVersion,
        ],
      )
      if (!updated.rows[0]) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
          'This order changed. Reload it before saving your edit',
        )
      }
      rowVersion = Number(updated.rows[0].row_version)
    } else {
      const created = await client.query<{ row_version: string }>(
        `INSERT INTO operations_commerce_order_workbench (
           organization_id, integration_account_id, candidate_id,
           external_order_id, canonical_order_id,
           accepted_provider_source_hash, accepted_provider_updated_at,
           ship_to_edit_state, ship_to_ciphertext, ship_to_iv, ship_to_tag,
           ship_to_hash, ship_to_source_hash, ship_to_encryption_version,
           customer_global_id_draft, requested_delivery_at_draft,
           line_resolution_drafts,
           sync_state, last_command_receipt_id, last_idempotency_key,
           last_request_hash, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, NULL, $5, $6,
           $7, $8, $9, $10, $11, $12, $13,
           $14, $15::timestamptz, $16::jsonb,
           'local_only', $17::uuid, $18, $19, $20, $20
         )
         RETURNING row_version::text`,
        [
          organizationId,
          candidate.integration_account_id,
          candidate.id,
          candidate.external_order_id,
          acceptedProviderSourceHash,
          acceptedProviderUpdatedAt,
          shipToEditState,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.hash,
          candidate.source_hash,
          encrypted.encryptionVersion,
          resolution.customerGlobalId,
          resolution.requestedDeliveryAt,
          JSON.stringify(lineDraftRecord(resolution)),
          prepared.receipt.id,
          input.idempotencyKey,
          exactRequestHash,
          actorEmail,
        ],
      )
      rowVersion = Number(created.rows[0].row_version)
    }
    const providerVersionChanged =
      acceptedProviderSourceHash !== latestProviderSourceHash
    const result: OperationsImportedOrderShipToUpdateResult = {
      candidateGlobalId,
      canonicalOrderGlobalId: null,
      rowVersion,
      readiness,
      issues,
      changedFields,
      syncStatus: 'local_only',
      promotionStatus: readiness === 'carrier_ready'
        ? 'needs_info'
        : 'not_ready',
      remainingBlockerCodes: readiness === 'carrier_ready'
        ? candidate.blocking_codes.filter((code) => !ADDRESS_BLOCKERS.has(code))
        : [],
      providerVersionChanged,
      providerWrites: 0,
      providerWriteIntentCreated: false,
      replayed: false,
    }
    await client.query(
      `UPDATE operations_command_receipts
       SET result_payload = $2::jsonb,
           result_global_id = $3,
           updated_at = now()
       WHERE id = $1::uuid
         AND status = 'processing'`,
      [prepared.receipt.id, JSON.stringify(result), candidateGlobalId],
    )
    prepared.receipt.result_payload = result as unknown as Record<string, unknown>
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.commerce_order_workbench.ship_to_updated',
      aggregateType: 'operations.commerce_order_workbench',
      aggregateId: candidateGlobalId,
      subject: candidateGlobalId,
      organizationId,
      eventKey: `operations:commerce-order-workbench:${prepared.receipt.id}`,
      payload: {
        candidateGlobalId,
        rowVersion,
        readiness,
        issueFields: issues.map((issue) => issue.field),
        changedFields,
        resolutionDraftFields: [
          ...(resolution.customerGlobalId ? ['customer'] : []),
          ...(resolution.requestedDeliveryAt ? ['requested_delivery'] : []),
          ...(resolution.lines.length ? ['line_product'] : []),
          ...(resolution.lines.some((line) => line.unitPriceMinor !== null)
            ? ['line_price']
            : []),
          ...(resolution.lines.some((line) => line.packageProfileGlobalId)
            ? ['line_package_profile']
            : []),
        ],
        resolutionLineCount: resolution.lines.length,
        syncStatus: 'local_only',
        providerVersionChanged,
        providerWrites: 0,
        providerWriteIntentCreated: false,
        commandReceiptId: prepared.receipt.id,
        correlationId: prepared.receipt.correlation_id,
        commandAction: input.action,
      },
    }, client)
    return {
      receipt: prepared.receipt,
      result,
      address: after,
      resolution,
      candidate,
    }
  })
  if (!('receipt' in saved)) return saved
  if (
    input.action === 'save'
    || (
      saved.candidate.requires_carrier_address
      && saved.result.readiness !== 'carrier_ready'
    )
  ) {
    return completeWorkbenchReceipt({
      organizationId,
      actorEmail,
      receiptId: saved.receipt.id,
      result: saved.result,
    })
  }
  await input.afterLocalSaveBeforeHandoff?.()
  return handoffCompleteDraft({
    organizationId,
    actorEmail,
    exactRequestHash,
    saved,
  })
}

export async function updateCommerceOrderWorkbenchShipToInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  expectedRowVersion: number
  changes: OrderShipToPatch
  resolutionDraft?: OperationsImportedOrderResolutionDraft
}): Promise<OperationsImportedOrderShipToUpdateResult> {
  return saveOrAcceptCommerceOrderWorkbenchInPostgres({
    ...input,
    action: 'save',
  })
}

export async function acceptCommerceOrderWorkbenchInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  expectedRowVersion: number
  /** Test-only crash seam after the durable local checkpoint commits. */
  afterLocalSaveBeforeHandoff?: () => void | Promise<void>
}): Promise<OperationsImportedOrderShipToUpdateResult> {
  return saveOrAcceptCommerceOrderWorkbenchInPostgres({
    ...input,
    changes: {},
    action: 'accept',
  })
}

function replayedRefreshResult(
  receipt: CommandReceiptRow,
): OperationsImportedOrderRefreshResult {
  const payload = receipt.result_payload
  if (
    !payload
    || typeof payload.previousCandidateGlobalId !== 'string'
    || typeof payload.candidateGlobalId !== 'string'
    || !Number.isSafeInteger(payload.rowVersion)
    || !['unchanged', 'rebased'].includes(String(payload.status || ''))
    || !Array.isArray(payload.providerChangedFields)
    || !Array.isArray(payload.preservedLocalFields)
    || (
      payload.preservedLineDrafts !== undefined
      && !Array.isArray(payload.preservedLineDrafts)
    )
  ) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_REFRESH_RESULT_INVALID',
      'The refreshed order could not be reloaded',
      500,
    )
  }
  return {
    ...(payload as Omit<OperationsImportedOrderRefreshResult, 'replayed'>),
    preservedLineDrafts: Array.isArray(payload.preservedLineDrafts)
      ? payload.preservedLineDrafts as OperationsImportedOrderRefreshResult[
          'preservedLineDrafts'
        ]
      : [],
    replayed: true,
  }
}

async function prepareRefreshReceipt(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    candidateGlobalId: string
    idempotencyKey: string
    requestHash: string
  },
) {
  await acquireTransactionAdvisoryLock(
    client,
    `commerce-order-workbench-refresh-receipt:${input.organizationId}:${input.idempotencyKey}`,
  )
  const existing = await client.query<CommandReceiptRow>(
    `SELECT id::text, request_hash, target_global_id, status,
            correlation_id::text, result_payload, updated_at
     FROM operations_command_receipts
     WHERE organization_id = $1::uuid
       AND command_type = $2
       AND idempotency_key = $3
     FOR UPDATE`,
    [input.organizationId, REFRESH_COMMAND_TYPE, input.idempotencyKey],
  )
  const receipt = existing.rows[0]
  if (receipt) {
    if (
      receipt.request_hash !== input.requestHash
      || receipt.target_global_id !== input.candidateGlobalId
    ) {
      requestError(
        'OPERATIONS_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different order refresh',
      )
    }
    if (receipt.status === 'succeeded') {
      return { receipt, replayed: true }
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
      REFRESH_COMMAND_TYPE,
      input.idempotencyKey,
      input.requestHash,
      input.actorEmail,
      randomUUID(),
      input.candidateGlobalId,
    ],
  )
  return { receipt: created.rows[0], replayed: false }
}

export async function readCommerceOrderWorkbenchRefreshTargetFromPostgres(
  input: {
    organizationId: string
    candidateGlobalId: string
  },
) {
  const organizationId = requireOrganizationId(input.organizationId)
  const candidateGlobalId = requireCandidateGlobalId(input.candidateGlobalId)
  const result = await query<{
    account_global_id: string
    integration_account_id: string
    provider: 'shopify' | 'faire'
    external_order_id: string
    credential_generation: string | number
    candidate_global_id: string
    candidate_row_version: string
  }>(
    `SELECT account.global_id AS account_global_id,
            account.id::text AS integration_account_id,
            account.provider,
            accepted.external_order_id,
            account.commerce_credential_generation AS credential_generation,
            COALESCE(latest.global_id, accepted.global_id)
              AS candidate_global_id,
            COALESCE(latest.row_version, accepted.row_version)::text
              AS candidate_row_version
     FROM operations_commerce_order_candidates accepted
     JOIN operations_integration_accounts account
       ON account.organization_id = accepted.organization_id
      AND account.id = accepted.integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider IN ('shopify', 'faire')
     LEFT JOIN LATERAL (
       SELECT candidate.global_id, candidate.row_version
       FROM operations_commerce_order_candidates candidate
       JOIN operations_commerce_intake_runs run
         ON run.organization_id = candidate.organization_id
        AND run.integration_account_id = candidate.integration_account_id
        AND run.pipeline_id = candidate.pipeline_id
        AND run.id = candidate.run_id
       WHERE candidate.organization_id = accepted.organization_id
         AND candidate.integration_account_id = accepted.integration_account_id
         AND candidate.external_order_id = accepted.external_order_id
         AND candidate.canonical_order_id IS NULL
         AND candidate.workflow_state IN ('held', 'resolving', 'ready')
         AND candidate.expires_at > now()
         AND run.expires_at > now()
         AND run.workflow_state <> 'expired'
       ORDER BY candidate.observed_at DESC, candidate.created_at DESC,
                candidate.id DESC
       LIMIT 1
     ) latest ON true
     WHERE accepted.organization_id = $1::uuid
       AND accepted.global_id = $2
       AND accepted.canonical_order_id IS NULL
     LIMIT 1`,
    [organizationId, candidateGlobalId],
  )
  if (!result.rows[0]) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_NOT_FOUND',
      'Imported order is no longer available',
      404,
    )
  }
  return {
    accountGlobalId: result.rows[0].account_global_id,
    integrationAccountId: result.rows[0].integration_account_id,
    provider: result.rows[0].provider,
    externalOrderId: result.rows[0].external_order_id,
    credentialGeneration: Number(result.rows[0].credential_generation),
    candidateGlobalId: result.rows[0].candidate_global_id,
    candidateRowVersion: Number(result.rows[0].candidate_row_version),
  }
}

export async function rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres(
  input: {
    organizationId: string
    actorEmail: string
    idempotencyKey: string
    candidateGlobalId: string
    expectedRowVersion: number
    expectedLatestCandidateGlobalId?: string | null
    resolutions?: CommerceOrderWorkbenchRefreshResolution | null
    lineResolutions?: CommerceOrderWorkbenchLineRefreshResolution | null
  },
): Promise<OperationsImportedOrderRefreshResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const candidateGlobalId = requireCandidateGlobalId(input.candidateGlobalId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (!actorEmail) {
    requestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    requestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
      400,
    )
  }
  if (
    !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
  ) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_VERSION_INVALID',
      'Imported order version is invalid',
      400,
    )
  }
  const expectedLatestCandidateGlobalId = input.expectedLatestCandidateGlobalId
    ? requireCandidateGlobalId(input.expectedLatestCandidateGlobalId)
    : null
  const resolutions = input.resolutions || {}
  for (const [field, resolution] of Object.entries(resolutions)) {
    if (
      ![
        ...ORDER_SHIP_TO_FIELDS,
        'requestedDeliveryAt',
      ].includes(field as CommerceOrderWorkbenchRefreshField)
      || !['local', 'provider'].includes(String(resolution || ''))
    ) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_RESOLUTION_INVALID',
        'Choose whether to keep the local or provider value for each conflicting field',
        400,
      )
    }
  }
  const lineResolutions = input.lineResolutions || {}
  for (const [lineGlobalId, resolution] of Object.entries(lineResolutions)) {
    if (!LINE_GLOBAL_ID.test(lineGlobalId) || resolution !== 'provider') {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_RESOLUTION_INVALID',
        'Choose the refreshed provider item for each changed saved item match',
        400,
      )
    }
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-workbench-candidate:${organizationId}:${candidateGlobalId}`,
    )
    const acceptedResult = await client.query<LockedCandidateRow>(
      `SELECT candidate.id::text, candidate.global_id,
              candidate.organization_id::text,
              candidate.integration_account_id::text,
              account.global_id AS account_global_id,
              candidate.external_order_id, candidate.source_hash,
              candidate.provider_updated_at, candidate.observed_at,
              candidate.normalized_order_status,
              candidate.normalized_fulfillment_status,
              candidate.canonical_order_id::text,
              canonical_order.global_id AS canonical_order_global_id,
              candidate.workflow_state, candidate.blocking_codes,
              candidate.row_version::text,
              candidate.ship_to_snapshot_state,
              candidate.ship_to_snapshot_ciphertext,
              candidate.ship_to_snapshot_iv,
              candidate.ship_to_snapshot_tag,
              candidate.provider_requested_delivery_at,
              false AS requires_carrier_address,
              false AS live_for_new_draft
       FROM operations_commerce_order_candidates candidate
       JOIN operations_integration_accounts account
         ON account.organization_id = candidate.organization_id
        AND account.id = candidate.integration_account_id
        AND account.integration_type = 'commerce'
        AND account.provider IN ('shopify', 'faire')
       LEFT JOIN operations_orders canonical_order
         ON canonical_order.organization_id = candidate.organization_id
        AND canonical_order.id = candidate.canonical_order_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.global_id = $2
       FOR UPDATE OF candidate`,
      [organizationId, candidateGlobalId],
    )
    const accepted = acceptedResult.rows[0]
    if (!accepted || accepted.canonical_order_id) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_NOT_FOUND',
        'Imported order is no longer available',
        404,
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-workbench:${organizationId}:${accepted.integration_account_id}:${accepted.external_order_id}`,
    )
    const currentResult = await client.query<LockedWorkbenchRow>(
      `SELECT id::text, candidate_id::text,
              accepted_provider_source_hash,
              accepted_provider_updated_at, ship_to_edit_state,
              ship_to_ciphertext, ship_to_iv, ship_to_tag,
              ship_to_source_hash, canonical_order_id::text,
              requested_delivery_at_draft,
              line_resolution_drafts,
              last_command_receipt_id::text, last_request_hash,
              row_version::text
       FROM operations_commerce_order_workbench
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = $3
       FOR UPDATE`,
      [organizationId, accepted.integration_account_id, accepted.external_order_id],
    )
    const current = currentResult.rows[0] || null
    const latestResult = await client.query<LockedCandidateRow>(
      `SELECT candidate.id::text, candidate.global_id,
              candidate.organization_id::text,
              candidate.integration_account_id::text,
              account.global_id AS account_global_id,
              candidate.external_order_id, candidate.source_hash,
              candidate.provider_updated_at, candidate.observed_at,
              candidate.normalized_order_status,
              candidate.normalized_fulfillment_status,
              candidate.canonical_order_id::text,
              canonical_order.global_id AS canonical_order_global_id,
              candidate.workflow_state, candidate.blocking_codes,
              candidate.row_version::text,
              candidate.ship_to_snapshot_state,
              candidate.ship_to_snapshot_ciphertext,
              candidate.ship_to_snapshot_iv,
              candidate.ship_to_snapshot_tag,
              candidate.provider_requested_delivery_at,
              false AS requires_carrier_address,
              true AS live_for_new_draft
       FROM operations_commerce_order_candidates candidate
       JOIN operations_commerce_intake_runs run
         ON run.organization_id = candidate.organization_id
        AND run.integration_account_id = candidate.integration_account_id
        AND run.pipeline_id = candidate.pipeline_id
        AND run.id = candidate.run_id
       JOIN operations_integration_accounts account
         ON account.organization_id = candidate.organization_id
        AND account.id = candidate.integration_account_id
       LEFT JOIN operations_orders canonical_order
         ON canonical_order.organization_id = candidate.organization_id
        AND canonical_order.id = candidate.canonical_order_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.integration_account_id = $2::uuid
         AND candidate.external_order_id = $3
         AND candidate.canonical_order_id IS NULL
         AND candidate.workflow_state IN ('held', 'resolving', 'ready')
         AND candidate.expires_at > now()
         AND run.expires_at > now()
         AND run.workflow_state <> 'expired'
       ORDER BY candidate.observed_at DESC, candidate.created_at DESC,
                candidate.id DESC
       LIMIT 1
       FOR UPDATE OF candidate`,
      [organizationId, accepted.integration_account_id, accepted.external_order_id],
    )
    const latest = latestResult.rows[0]
    if (!latest) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_REQUIRED',
        'Refresh the store connection, then try this order again',
      )
    }
    if (
      expectedLatestCandidateGlobalId
      && latest.global_id !== expectedLatestCandidateGlobalId
    ) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_CHANGED',
        'The provider changed this order again. Refresh before choosing values',
      )
    }
    if (!current) {
      if (input.expectedRowVersion !== 0) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
          'This order changed. Reload it before refreshing',
        )
      }
      return {
        previousCandidateGlobalId: candidateGlobalId,
        candidateGlobalId: latest.global_id,
        rowVersion: 0,
        status: latest.id === accepted.id ? 'unchanged' : 'rebased',
        providerChangedFields: [],
        preservedLocalFields: [],
        preservedLineDrafts: [],
        providerWrites: 0,
        providerWriteIntentCreated: false,
        replayed: false,
      }
    }
    if (
      latest.id === accepted.id
      && latest.source_hash === current.accepted_provider_source_hash
    ) {
      if (
        current.candidate_id !== accepted.id
        || Number(current.row_version) !== input.expectedRowVersion
      ) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
          'This order changed. Reload it before refreshing',
        )
      }
      return {
        previousCandidateGlobalId: candidateGlobalId,
        candidateGlobalId,
        rowVersion: Number(current.row_version),
        status: 'unchanged',
        providerChangedFields: [],
        preservedLocalFields: [],
        preservedLineDrafts: [],
        providerWrites: 0,
        providerWriteIntentCreated: false,
        replayed: false,
      }
    }

    const exactRequestHash = requestHash({
      candidateGlobalId,
      latestCandidateGlobalId: latest.global_id,
      expectedRowVersion: input.expectedRowVersion,
      resolutions,
      lineResolutions,
      providerWrites: 0,
    })
    const prepared = await prepareRefreshReceipt(client, {
      organizationId,
      actorEmail,
      candidateGlobalId,
      idempotencyKey: input.idempotencyKey,
      requestHash: exactRequestHash,
    })
    if (prepared.replayed) return replayedRefreshResult(prepared.receipt)
    if (current.candidate_id !== accepted.id) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_CHANGED',
        'This order was already refreshed. Reload it before refreshing again',
      )
    }
    if (Number(current.row_version) !== input.expectedRowVersion) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
        'This order changed. Reload it before refreshing',
      )
    }

    const latestProviderTerminal = (
      ['cancelled', 'closed'].includes(latest.normalized_order_status)
      || ['fulfilled', 'cancelled'].includes(
        latest.normalized_fulfillment_status,
      )
    )
    if (latestProviderTerminal) {
      if (
        Object.keys(resolutions).length
        || Object.keys(lineResolutions).length
      ) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_REFRESH_RESOLUTION_STALE',
          'This provider order is final and no longer needs local resolutions',
        )
      }
      const updated = await client.query<{ row_version: string }>(
        `UPDATE operations_commerce_order_workbench
         SET candidate_id = $4::uuid,
             accepted_provider_source_hash = $5,
             accepted_provider_updated_at = $6,
             ship_to_edit_state = 'provider_snapshot',
             ship_to_ciphertext = NULL,
             ship_to_iv = NULL,
             ship_to_tag = NULL,
             ship_to_hash = NULL,
             ship_to_source_hash = NULL,
             ship_to_encryption_version = NULL,
             customer_global_id_draft = NULL,
             line_resolution_drafts = '{}'::jsonb,
             requested_delivery_at_draft = $7::timestamptz,
             sync_state = 'provider_snapshot',
             last_command_receipt_id = $8::uuid,
             last_idempotency_key = $9,
             last_request_hash = $10,
             row_version = row_version + 1,
             updated_by = $11,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND external_order_id = $3
           AND candidate_id = $12::uuid
           AND row_version = $13::bigint
         RETURNING row_version::text`,
        [
          organizationId,
          accepted.integration_account_id,
          accepted.external_order_id,
          latest.id,
          latest.source_hash,
          latest.provider_updated_at || latest.observed_at,
          latest.provider_requested_delivery_at,
          prepared.receipt.id,
          input.idempotencyKey,
          exactRequestHash,
          actorEmail,
          accepted.id,
          input.expectedRowVersion,
        ],
      )
      if (!updated.rows[0]) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
          'This order changed. Reload it before refreshing',
        )
      }
      const result: OperationsImportedOrderRefreshResult = {
        previousCandidateGlobalId: candidateGlobalId,
        candidateGlobalId: latest.global_id,
        rowVersion: Number(updated.rows[0].row_version),
        status: 'rebased',
        providerChangedFields: [],
        preservedLocalFields: [],
        preservedLineDrafts: [],
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
        [prepared.receipt.id, latest.global_id, JSON.stringify(result)],
      )
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.commerce_order_workbench.provider_rebased',
        aggregateType: 'operations.commerce_order_workbench',
        aggregateId: latest.global_id,
        subject: latest.global_id,
        organizationId,
        eventKey:
          `operations:commerce-order-workbench-refresh:${prepared.receipt.id}`,
        payload: {
          previousCandidateGlobalId: candidateGlobalId,
          candidateGlobalId: latest.global_id,
          rowVersion: result.rowVersion,
          providerTerminal: true,
          discardedLocalDrafts: true,
          providerWrites: 0,
          providerWriteIntentCreated: false,
          commandReceiptId: prepared.receipt.id,
          correlationId: prepared.receipt.correlation_id,
        },
      }, client)
      return result
    }

    const acceptedProvider = decryptAddress({
      ciphertext: accepted.ship_to_snapshot_ciphertext,
      iv: accepted.ship_to_snapshot_iv,
      tag: accepted.ship_to_snapshot_tag,
      organizationId,
      accountGlobalId: accepted.account_global_id,
      externalOrderId: accepted.external_order_id,
      sourceHash: accepted.source_hash,
      required: accepted.ship_to_snapshot_state === 'protected'
        || accepted.ship_to_snapshot_state === 'confirmed',
    })
    const local = current.ship_to_edit_state === 'provider_snapshot'
      ? acceptedProvider
      : decryptAddress({
          ciphertext: current.ship_to_ciphertext,
          iv: current.ship_to_iv,
          tag: current.ship_to_tag,
          organizationId,
          accountGlobalId: accepted.account_global_id,
          externalOrderId: accepted.external_order_id,
          sourceHash: current.ship_to_source_hash,
          required: true,
        })
    const latestProvider = decryptAddress({
      ciphertext: latest.ship_to_snapshot_ciphertext,
      iv: latest.ship_to_snapshot_iv,
      tag: latest.ship_to_snapshot_tag,
      organizationId,
      accountGlobalId: latest.account_global_id,
      externalOrderId: latest.external_order_id,
      sourceHash: latest.source_hash,
      required: latest.ship_to_snapshot_state === 'protected'
        || latest.ship_to_snapshot_state === 'confirmed',
    })
    const merge = mergeCommerceOrderWorkbenchProviderAddress({
      acceptedProvider,
      local,
      latestProvider,
      resolutions,
    })
    const deliveryMerge = mergeCommerceOrderWorkbenchRequestedDelivery({
      acceptedProvider: accepted.provider_requested_delivery_at,
      local: current.requested_delivery_at_draft,
      latestProvider: latest.provider_requested_delivery_at,
      resolution: resolutions.requestedDeliveryAt,
    })
    const lineResult = await client.query<RefreshCandidateLineRow>(
      `SELECT line.order_candidate_id::text AS candidate_id,
              line.global_id, line.external_line_id,
              line.product_title_snapshot, line.sku_snapshot
       FROM operations_commerce_order_candidate_lines line
       WHERE line.organization_id = $1::uuid
         AND line.integration_account_id = $2::uuid
         AND line.order_candidate_id = ANY($3::uuid[])
         AND line.unfulfilled_quantity > 0
       ORDER BY line.order_candidate_id, line.created_at, line.id`,
      [
        organizationId,
        accepted.integration_account_id,
        [accepted.id, latest.id],
      ],
    )
    const lineMerge = mergeCommerceOrderWorkbenchLineDrafts({
      acceptedLines: lineResult.rows.filter((line) => (
        line.candidate_id === accepted.id
      )),
      latestLines: lineResult.rows.filter((line) => (
        line.candidate_id === latest.id
      )),
      localDrafts: current.line_resolution_drafts,
      resolutions: lineResolutions,
    })
    const conflicts = [
      ...merge.conflicts,
      ...(deliveryMerge.conflict ? [deliveryMerge.conflict] : []),
    ]
    if (conflicts.length || lineMerge.conflicts.length) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_CONFLICT',
        'Review each local value that changed in the refreshed provider order',
        409,
        {
          latestCandidateGlobalId: latest.global_id,
          conflicts,
          lineConflicts: lineMerge.conflicts,
          providerWrites: 0,
        },
      )
    }
    const unexpectedResolutions = Object.keys(resolutions).filter((field) => (
      field === 'requestedDeliveryAt'
        ? !deliveryMerge.requiresResolution
        : !merge.providerChangedFields.includes(field as OrderShipToField)
    ))
    if (unexpectedResolutions.length) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_RESOLUTION_STALE',
        'The selected refresh fields are stale. Refresh the order again',
      )
    }
    const expectedLineResolutionIds = new Set(
      mergeCommerceOrderWorkbenchLineDrafts({
        acceptedLines: lineResult.rows.filter((line) => (
          line.candidate_id === accepted.id
        )),
        latestLines: lineResult.rows.filter((line) => (
          line.candidate_id === latest.id
        )),
        localDrafts: current.line_resolution_drafts,
      }).conflicts.map((conflict) => conflict.lineGlobalId),
    )
    if (Object.keys(lineResolutions).some((lineGlobalId) => (
      !expectedLineResolutionIds.has(lineGlobalId)
    ))) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_RESOLUTION_STALE',
        'The selected refreshed items are stale. Refresh the order again',
      )
    }
    const readiness = orderShipToReadiness(merge.merged)
    const retainsLocalAddress = changedOrderShipToFields(
      latestProvider,
      merge.merged,
    ).length > 0
    const retainsLocalDraft = retainsLocalAddress
      || deliveryMerge.merged !== requestedDeliveryIso(
        latest.provider_requested_delivery_at,
      )
    const encrypted = retainsLocalAddress
      ? encryptCommerceCandidateSnapshot(
          orderShipToStorageValue(merge.merged),
          organizationId,
          latest.account_global_id,
          latest.external_order_id,
          latest.source_hash,
          'ship_to',
        )
      : null
    const updated = await client.query<{ row_version: string }>(
      `UPDATE operations_commerce_order_workbench
       SET candidate_id = $4::uuid,
           accepted_provider_source_hash = $5,
           accepted_provider_updated_at = $6,
           ship_to_edit_state = $7,
           ship_to_ciphertext = $8,
           ship_to_iv = $9,
           ship_to_tag = $10,
           ship_to_hash = $11,
           ship_to_source_hash = $12,
           ship_to_encryption_version = $13,
           line_resolution_drafts = $14::jsonb,
           requested_delivery_at_draft = $15::timestamptz,
           sync_state = $16,
           last_command_receipt_id = $17::uuid,
           last_idempotency_key = $18,
           last_request_hash = $19,
           row_version = row_version + 1,
           updated_by = $20,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = $3
         AND candidate_id = $21::uuid
         AND row_version = $22::bigint
       RETURNING row_version::text`,
      [
        organizationId,
        accepted.integration_account_id,
        accepted.external_order_id,
        latest.id,
        latest.source_hash,
        latest.provider_updated_at || latest.observed_at,
        retainsLocalAddress ? `local_${readiness}` : 'provider_snapshot',
        encrypted?.ciphertext || null,
        encrypted?.iv || null,
        encrypted?.tag || null,
        encrypted?.hash || null,
        retainsLocalAddress ? latest.source_hash : null,
        encrypted?.encryptionVersion || null,
        JSON.stringify(lineMerge.drafts),
        deliveryMerge.merged,
        retainsLocalDraft ? 'local_only' : 'provider_snapshot',
        prepared.receipt.id,
        input.idempotencyKey,
        exactRequestHash,
        actorEmail,
        accepted.id,
        input.expectedRowVersion,
      ],
    )
    if (!updated.rows[0]) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
        'This order changed. Reload it before refreshing',
      )
    }
    const result: OperationsImportedOrderRefreshResult = {
      previousCandidateGlobalId: candidateGlobalId,
      candidateGlobalId: latest.global_id,
      rowVersion: Number(updated.rows[0].row_version),
      status: 'rebased',
      providerChangedFields: merge.providerChangedFields,
      preservedLocalFields: merge.preservedLocalFields,
      preservedLineDrafts: lineMerge.preservedLineDrafts,
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
      [prepared.receipt.id, latest.global_id, JSON.stringify(result)],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.commerce_order_workbench.provider_rebased',
      aggregateType: 'operations.commerce_order_workbench',
      aggregateId: latest.global_id,
      subject: latest.global_id,
      organizationId,
      eventKey: `operations:commerce-order-workbench-refresh:${prepared.receipt.id}`,
      payload: {
        previousCandidateGlobalId: candidateGlobalId,
        candidateGlobalId: latest.global_id,
        rowVersion: result.rowVersion,
        providerChangedFields: result.providerChangedFields,
        preservedLocalFields: result.preservedLocalFields,
        preservedLineDrafts: result.preservedLineDrafts,
        providerRequestedDeliveryChanged: deliveryMerge.providerChanged,
        preservedLocalRequestedDelivery: deliveryMerge.preservedLocal,
        providerWrites: 0,
        providerWriteIntentCreated: false,
        commandReceiptId: prepared.receipt.id,
        correlationId: prepared.receipt.correlation_id,
      },
    }, client)
    return result
  })
}
