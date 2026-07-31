import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import type {
  Address,
  MockOperationsProofInput,
  MockOperationsProofLineInput,
  OperationsActivationState,
  OperationsExceptionStatus,
  OperationsInboundReceiptCompletionInput,
  OperationsInboundReceiptInput,
  OperationsOrderStatus,
  OperationsWorkspace,
} from '@/lib/operations/types'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  authorizeCommerceActiveTransitionInPostgres,
  CommerceActiveTransitionPersistenceError,
  consumeCommerceActiveTransitionAuthorizationInPostgres,
  prepareCommerceActiveTransitionInPostgres,
} from '@/lib/persistence/commerceActiveTransitionAuthorization'
import {
  confirmOperationsOrderShipmentFromPostgres,
  confirmOperationsOrderPicksFromPostgres,
  completeOperationsInboundReceiptInPostgres,
  createOperationsInboundReceiptInPostgres,
  createOperationsLocationInPostgres,
  createOperationsWarehouseInPostgres,
  deleteOperationsLocationInPostgres,
  executeOperationsReplenishmentInPostgres,
  generateOperationsPackagePackingSlipInPostgres,
  OperationsRequestError,
  planOperationsOrderFromPostgres,
  readOperationsWorkspaceFromPostgres,
  releaseOperationsOrderFromPostgres,
  runMockOperationsProofFromPostgres,
  updateOperationsActivationInPostgres,
  updateOperationsExceptionInPostgres,
  updateOperationsLocationInPostgres,
  updateOperationsWarehouseInPostgres,
  verifyOperationsOrderPackFromPostgres,
} from '@/lib/persistence/operations'
import {
  createOperationsSandboxLabelInPostgres,
  voidOperationsSandboxLabelInPostgres,
} from '@/lib/persistence/operationShipping'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 64 * 1024
const CUSTOMER_GLOBAL_ID = /^ga\d{7}$/
const PRODUCT_GLOBAL_ID = /^gp\d{7}$/
const ORDER_GLOBAL_ID = /^gor\d{7}$/
const CARTONIZATION_EVIDENCE_GLOBAL_ID = /^gcte\d{7}$/
const PACKAGE_GLOBAL_ID = /^gpa\d{7}$/
const EXCEPTION_GLOBAL_ID = /^gex\d{7}$/
const RATE_GLOBAL_ID = /^grt\d{7}$/
const CARRIER_ACCOUNT_GLOBAL_ID = /^gac\d{7}$/
const PRINTER_GLOBAL_ID = /^gpr\d{7}$/
const WAREHOUSE_GLOBAL_ID = /^gwh\d{7}$/
const LOCATION_GLOBAL_ID = /^gwl\d{7}$/
const INVENTORY_POOL_GLOBAL_ID = /^gip\d{7}$/
const RECEIPT_GLOBAL_ID = /^grc\d{7}$/
const RECEIPT_LINE_GLOBAL_ID = /^grcl\d{7}$/
const INTEGRATION_ACCOUNT_GLOBAL_ID = /^gia\d{7}$/
const COMMERCE_ACTIVE_PREPARATION_GLOBAL_ID = /^gcap\d{7}$/
const SHA256 = /^[a-f0-9]{64}$/
const ORDER_STATUSES = new Set<OperationsOrderStatus>([
  'imported', 'validated', 'held', 'promised', 'reserved', 'planned',
  'released', 'picking', 'packed', 'shipped', 'cancelled', 'exception',
])
const EXCEPTION_STATUSES = new Set<OperationsExceptionStatus>([
  'open', 'acknowledged', 'resolved', 'dismissed',
])
const ACTIVATION_STATES = new Set<OperationsActivationState>([
  'disabled', 'shadow', 'read_only', 'active', 'frozen',
])
const PROOF_FIELDS = new Set([
  'customerGlobalId', 'lines', 'productGlobalId', 'externalOrderId', 'orderNumber',
  'quantity', 'openingQuantity', 'requestedDeliveryAt', 'shipTo', 'executionMode',
])
const PROOF_LINE_FIELDS = new Set(['productGlobalId', 'quantity', 'openingQuantity'])
const ADDRESS_FIELDS = new Set(['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError('OPERATIONS_POSTGRES_REQUIRED', 'Operations requires Postgres storage', 503)
  }
}

function requireOperationsProofFixture() {
  if (process.env.CLAWPILOT_OPERATIONS_PROOF_ENABLED !== 'true') {
    requestError(
      'OPERATIONS_PROOF_DISABLED',
      'The hosted proof-order fixture is disabled',
      404,
    )
  }
}

function record(value: unknown, code: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) requestError(code, `${label} is invalid`)
  return value as Record<string, unknown>
}

function assertFields(value: Record<string, unknown>, allowed: Set<string>, code: string, label: string) {
  const unsupported = Object.keys(value).find((field) => !allowed.has(field))
  if (unsupported) requestError(code, `${label} includes an unsupported field`)
}

function textValue(value: unknown, label: string, max: number, required = true): string {
  const text = String(value ?? '').trim()
  if ((!text && required) || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  }
  return text
}

function integerValue(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

function optionalNumberValue(value: unknown, label: string, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be from ${minimum} to ${maximum}`)
  }
  return parsed
}

function positiveNumberValue(value: unknown, label: string, maximum = 1_000_000_000): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be greater than zero`)
  }
  return parsed
}

function nonNegativeNumberValue(value: unknown, label: string, maximum = 1_000_000_000): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be zero or greater`)
  }
  return parsed
}

function optionalDateTimeValue(value: unknown, label: string): string | null {
  const raw = textValue(value, label, 50, false)
  if (!raw) return null
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  }
  return parsed.toISOString()
}

function inboundReceiptLinesValue(value: unknown): OperationsInboundReceiptInput['lines'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Receipt must include from 1 to 100 lines')
  }
  return value.map((entry, index) => {
    const line = record(entry, 'OPERATIONS_REQUEST_INVALID', `Receipt line ${index + 1}`)
    assertFields(
      line,
      new Set([
        'productGlobalId',
        'targetLocationGlobalId',
        'expectedQuantity',
        'lotCode',
        'unitOfMeasure',
      ]),
      'OPERATIONS_REQUEST_INVALID',
      `Receipt line ${index + 1}`,
    )
    return {
      productGlobalId: globalIdValue(
        line.productGlobalId,
        `Product on line ${index + 1}`,
        PRODUCT_GLOBAL_ID,
      ),
      targetLocationGlobalId: optionalGlobalIdValue(
        line.targetLocationGlobalId,
        `Putaway location on line ${index + 1}`,
        LOCATION_GLOBAL_ID,
      ),
      expectedQuantity: positiveNumberValue(
        line.expectedQuantity,
        `Expected quantity on line ${index + 1}`,
      ),
      lotCode: textValue(line.lotCode, `Lot on line ${index + 1}`, 120, false),
      unitOfMeasure: textValue(
        line.unitOfMeasure || 'each',
        `Unit of measure on line ${index + 1}`,
        50,
      ),
    }
  })
}

function inboundReceiptCompletionLinesValue(
  value: unknown,
): OperationsInboundReceiptCompletionInput['lines'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    requestError(
      'OPERATIONS_REQUEST_INVALID',
      'Receiving confirmation must include every receipt line',
    )
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const line = record(entry, 'OPERATIONS_REQUEST_INVALID', `Receiving line ${index + 1}`)
    assertFields(
      line,
      new Set(['lineGlobalId', 'acceptedQuantity', 'damagedQuantity']),
      'OPERATIONS_REQUEST_INVALID',
      `Receiving line ${index + 1}`,
    )
    const lineGlobalId = globalIdValue(
      line.lineGlobalId,
      `Receipt line ${index + 1}`,
      RECEIPT_LINE_GLOBAL_ID,
    )
    if (seen.has(lineGlobalId)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'Receipt line confirmations must be unique')
    }
    seen.add(lineGlobalId)
    return {
      lineGlobalId,
      acceptedQuantity: nonNegativeNumberValue(
        line.acceptedQuantity,
        `Accepted quantity on line ${index + 1}`,
      ),
      damagedQuantity: nonNegativeNumberValue(
        line.damagedQuantity,
        `Damaged quantity on line ${index + 1}`,
      ),
    }
  })
}

function operatingDaysValue(value: unknown): number[] {
  if (value === undefined) return [1, 2, 3, 4, 5]
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Select at least one operating day')
  }
  const days = value.map((day) => integerValue(day, 'Operating day', 0, 6))
  if (new Set(days).size !== days.length) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Operating days must be unique')
  }
  return [...days].sort((a, b) => a - b)
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function carrierCutoffsValue(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  const input = record(value, 'OPERATIONS_REQUEST_INVALID', 'Carrier cutoffs')
  if (Object.keys(input).length > 25) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Carrier cutoffs are invalid')
  }
  const result: Record<string, string> = {}
  for (const [providerValue, cutoffValue] of Object.entries(input)) {
    const provider = textValue(providerValue, 'Carrier code', 40).toUpperCase()
    const cutoff = textValue(cutoffValue, `${provider} cutoff`, 8)
    if (!/^[A-Z0-9_-]+$/.test(provider) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) {
      requestError(
        'OPERATIONS_REQUEST_INVALID',
        'Carrier cutoffs require a carrier code and local 24-hour HH:MM time',
      )
    }
    result[provider] = cutoff
  }
  return result
}

function commerceActiveSelectedAccountsValue(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    requestError(
      'COMMERCE_ACTIVE_COHORT_INVALID',
      'Select between one and eight commerce accounts',
    )
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const selected = record(
      entry,
      'COMMERCE_ACTIVE_COHORT_INVALID',
      `Commerce account ${index + 1}`,
    )
    assertFields(
      selected,
      new Set(['accountGlobalId', 'capabilities']),
      'COMMERCE_ACTIVE_COHORT_INVALID',
      `Commerce account ${index + 1}`,
    )
    const accountGlobalId = globalIdValue(
      selected.accountGlobalId,
      `Commerce account ${index + 1}`,
      INTEGRATION_ACCOUNT_GLOBAL_ID,
    )
    if (seen.has(accountGlobalId)) {
      requestError(
        'COMMERCE_ACTIVE_ACCOUNT_DUPLICATE',
        'A commerce account can appear only once in an Active cohort',
      )
    }
    seen.add(accountGlobalId)
    if (
      !Array.isArray(selected.capabilities)
      || selected.capabilities.length < 1
      || selected.capabilities.length > 32
    ) {
      requestError(
        'COMMERCE_ACTIVE_CAPABILITIES_INVALID',
        `Select at least one write capability for ${accountGlobalId}`,
      )
    }
    const capabilities = selected.capabilities.map((capability) => {
      const normalized = String(capability || '').trim()
      if (!/^[a-z][a-z0-9_]{0,127}$/.test(normalized)) {
        requestError(
          'COMMERCE_ACTIVE_CAPABILITIES_INVALID',
          `Selected write capabilities for ${accountGlobalId} are invalid`,
        )
      }
      return normalized
    })
    return {
      accountGlobalId,
      capabilities: [...new Set(capabilities)].sort(),
    }
  })
}

function sha256Value(value: unknown, label: string) {
  const normalized = String(value || '').trim()
  if (!SHA256.test(normalized)) {
    requestError('COMMERCE_ACTIVE_COHORT_INVALID', `${label} is invalid`)
  }
  return normalized
}

function locationStorageFunctionValue(
  value: unknown,
  locationType: OperationsWorkspace['warehouses'][number]['locations'][number]['locationType'],
): OperationsWorkspace['warehouses'][number]['locations'][number]['storageFunction'] {
  if (value === null || value === undefined || value === '') {
    if (locationType === 'pick') return 'forward_pick'
    if (locationType === 'storage') return 'reserve'
    if (locationType === 'staging') return 'staging'
    return 'work_area'
  }
  return textValue(value, 'Storage function', 30) as OperationsWorkspace['warehouses'][number]['locations'][number]['storageFunction']
}

function locationProductRulesValue(value: unknown): Array<{
  productGlobalId: string
  ruleType: 'allowed' | 'preferred' | 'restricted'
  maxQuantity: number | null
  replenishmentMode: 'disabled' | 'min_max' | 'order_demand'
  replenishmentSourceLocationGlobalId: string | null
  minQuantity: number | null
  targetQuantity: number | null
}> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 250) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Location product rules are invalid')
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const rule = record(entry, 'OPERATIONS_REQUEST_INVALID', `Location product rule ${index + 1}`)
    assertFields(
      rule,
      new Set([
        'productGlobalId',
        'ruleType',
        'maxQuantity',
        'replenishmentMode',
        'replenishmentSourceLocationGlobalId',
        'minQuantity',
        'targetQuantity',
      ]),
      'OPERATIONS_REQUEST_INVALID',
      `Location product rule ${index + 1}`,
    )
    const productGlobalId = globalIdValue(rule.productGlobalId, 'Location product', PRODUCT_GLOBAL_ID)
    if (seen.has(productGlobalId)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'A product may only have one rule per location')
    }
    seen.add(productGlobalId)
    const ruleType = textValue(rule.ruleType, 'Product rule type', 20)
    if (!['allowed', 'preferred', 'restricted'].includes(ruleType)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'Product rule type is invalid')
    }
    const replenishmentMode = textValue(
      rule.replenishmentMode,
      'Replenishment mode',
      20,
      false,
    ) || 'disabled'
    if (!['disabled', 'min_max', 'order_demand'].includes(replenishmentMode)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'Replenishment mode is invalid')
    }
    return {
      productGlobalId,
      ruleType: ruleType as 'allowed' | 'preferred' | 'restricted',
      maxQuantity: optionalNumberValue(rule.maxQuantity, 'Product quantity limit', 0.000001, 1_000_000_000),
      replenishmentMode: replenishmentMode as 'disabled' | 'min_max' | 'order_demand',
      replenishmentSourceLocationGlobalId: optionalGlobalIdValue(
        rule.replenishmentSourceLocationGlobalId,
        'Replenishment source',
        LOCATION_GLOBAL_ID,
      ),
      minQuantity: optionalNumberValue(rule.minQuantity, 'Replenishment minimum', 0, 1_000_000_000),
      targetQuantity: optionalNumberValue(rule.targetQuantity, 'Replenishment target', 0.000001, 1_000_000_000),
    }
  })
}

function globalIdValue(value: unknown, label: string, pattern: RegExp): string {
  const globalId = textValue(value, label, 16)
  if (!pattern.test(globalId)) requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  return globalId
}

function optionalGlobalIdValue(value: unknown, label: string, pattern: RegExp): string | null {
  const globalId = textValue(value, label, 16, false)
  if (!globalId) return null
  if (!pattern.test(globalId)) requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  return globalId
}

function requestedDeliveryValue(value: unknown): string {
  const raw = textValue(value, 'Requested delivery date', 50)
  const date = new Date(raw)
  const now = Date.now()
  if (Number.isNaN(date.getTime()) || date.getTime() < now - 60_000 || date.getTime() > now + 366 * 24 * 60 * 60 * 1000) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Requested delivery date must be within the next year')
  }
  return date.toISOString()
}

function addressValue(value: unknown): Address {
  const input = record(value, 'OPERATIONS_REQUEST_INVALID', 'Ship-to address')
  assertFields(input, ADDRESS_FIELDS, 'OPERATIONS_REQUEST_INVALID', 'Ship-to address')
  const country = textValue(input.country, 'Ship-to country', 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) requestError('OPERATIONS_REQUEST_INVALID', 'Ship-to country is invalid')
  return {
    name: textValue(input.name, 'Ship-to name', 120),
    line1: textValue(input.line1, 'Ship-to address', 160),
    line2: textValue(input.line2, 'Ship-to address line 2', 160, false) || undefined,
    city: textValue(input.city, 'Ship-to city', 100),
    region: textValue(input.region, 'Ship-to region', 100),
    postalCode: textValue(input.postalCode, 'Ship-to postal code', 30),
    country,
  }
}

function proofLinesValue(input: Record<string, unknown>): MockOperationsProofLineInput[] {
  const hasLines = input.lines !== undefined
  const hasLegacyLine = input.productGlobalId !== undefined
    || input.quantity !== undefined
    || input.openingQuantity !== undefined
  if (hasLines && hasLegacyLine) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Use either proof order lines or the legacy single product fields')
  }

  const rawLines = hasLines
    ? input.lines
    : [{
        productGlobalId: input.productGlobalId,
        quantity: input.quantity,
        openingQuantity: input.openingQuantity,
      }]
  if (!Array.isArray(rawLines) || rawLines.length < 1 || rawLines.length > 25) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Proof order must include from 1 to 25 product lines')
  }

  const seen = new Set<string>()
  return rawLines.map((value, index) => {
    const line = record(value, 'OPERATIONS_REQUEST_INVALID', `Proof order line ${index + 1}`)
    assertFields(line, PROOF_LINE_FIELDS, 'OPERATIONS_REQUEST_INVALID', `Proof order line ${index + 1}`)
    const productGlobalId = globalIdValue(line.productGlobalId, `Product on line ${index + 1}`, PRODUCT_GLOBAL_ID)
    if (seen.has(productGlobalId)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'Each product may appear only once on a proof order')
    }
    seen.add(productGlobalId)
    return {
      productGlobalId,
      quantity: integerValue(line.quantity, `Quantity on line ${index + 1}`, 1, 1_000),
      openingQuantity: integerValue(line.openingQuantity, `Opening inventory on line ${index + 1}`, 1, 100_000),
    }
  })
}

function proofValue(value: unknown): MockOperationsProofInput {
  const input = record(value, 'OPERATIONS_REQUEST_INVALID', 'Proof order')
  assertFields(input, PROOF_FIELDS, 'OPERATIONS_REQUEST_INVALID', 'Proof order')
  const executionMode = textValue(input.executionMode, 'Proof execution mode', 20, false) || 'planned'
  if (!['planned', 'shipped'].includes(executionMode)) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Proof execution mode is invalid')
  }
  return {
    customerGlobalId: globalIdValue(input.customerGlobalId, 'CRM customer', CUSTOMER_GLOBAL_ID),
    lines: proofLinesValue(input),
    externalOrderId: textValue(input.externalOrderId, 'External order ID', 120),
    orderNumber: textValue(input.orderNumber, 'Order number', 100),
    requestedDeliveryAt: requestedDeliveryValue(input.requestedDeliveryAt),
    shipTo: addressValue(input.shipTo),
    executionMode: executionMode as MockOperationsProofInput['executionMode'],
  }
}

function idempotencyKeyValue(req: NextRequest): string {
  const key = String(req.headers.get('idempotency-key') || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    requestError('OPERATIONS_IDEMPOTENCY_KEY_INVALID', 'A valid Idempotency-Key header is required')
  }
  return key
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    requestError('OPERATIONS_CONTENT_TYPE_INVALID', 'Operations commands require JSON', 415)
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    requestError('OPERATIONS_REQUEST_TOO_LARGE', 'Operations command exceeded the supported size', 413)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError('OPERATIONS_REQUEST_TOO_LARGE', 'Operations command exceeded the supported size', 413)
  }
  try {
    return record(JSON.parse(raw) as unknown, 'OPERATIONS_REQUEST_INVALID', 'Operations command')
  } catch (error) {
    if (error instanceof OperationsRequestError) throw error
    requestError('OPERATIONS_REQUEST_INVALID', 'A valid operations command is required')
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
  }
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CommerceActiveTransitionPersistenceError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  const code = error instanceof Error && /^OPERATIONS_[A-Z_]+$/.test(error.message)
    ? error.message
    : 'OPERATIONS_REQUEST_FAILED'
  const status = code === 'OPERATIONS_REQUEST_FAILED' ? 500 : 400
  return json({ ok: false, error: status === 500 ? 'Operations request failed' : code, code }, status)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'Your organization administrator has not granted access to operations data',
        code: 'OPERATIONS_VIEW_REQUIRED',
      }, 403)
    }
    const statusValue = String(req.nextUrl.searchParams.get('status') || '').trim()
    if (statusValue && !ORDER_STATUSES.has(statusValue as OperationsOrderStatus)) {
      requestError('OPERATIONS_STATUS_INVALID', 'Order status is invalid')
    }
    const exceptionStatusValue = String(req.nextUrl.searchParams.get('exceptionStatus') || '').trim()
    if (exceptionStatusValue && !EXCEPTION_STATUSES.has(exceptionStatusValue as OperationsExceptionStatus)) {
      requestError('OPERATIONS_EXCEPTION_STATUS_INVALID', 'Exception status is invalid')
    }
    const selectedValue = String(req.nextUrl.searchParams.get('order') || '').trim()
    if (selectedValue && !ORDER_GLOBAL_ID.test(selectedValue)) {
      requestError('OPERATIONS_ORDER_INVALID', 'Order is invalid')
    }
    const search = String(req.nextUrl.searchParams.get('search') || '').trim()
    if (search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)) {
      requestError('OPERATIONS_SEARCH_INVALID', 'Order search is invalid')
    }
    const operations = await readOperationsWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      capabilities,
      search,
      status: statusValue || null,
      exceptionStatus: (exceptionStatusValue as OperationsExceptionStatus) || null,
      selectedOrderGlobalId: selectedValue || null,
    })
    return json({ ok: true, operations })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const body = await requestBody(req)
    const action = textValue(body.action, 'Operations action', 50)
    if (action === 'create-warehouse') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to configure warehouses', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(body, new Set([
        'action', 'code', 'name', 'facilityType', 'timezone', 'address', 'cutoffTime',
        'operatingDays', 'opensAt', 'closesAt', 'standardProcessingMinutes',
        'dailyOrderCapacity', 'carrierCutoffs', 'createStarterLocations',
      ]), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const result = await createOperationsWarehouseInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        code: textValue(body.code, 'Warehouse code', 32),
        name: textValue(body.name, 'Warehouse name', 160),
        facilityType: (textValue(body.facilityType, 'Facility type', 40, false) || 'distribution_center') as OperationsWorkspace['warehouses'][number]['facilityType'],
        timezone: textValue(body.timezone, 'Warehouse timezone', 80),
        address: addressValue(body.address),
        cutoffTime: textValue(body.cutoffTime, 'Warehouse cutoff', 8, false) || null,
        operatingDays: operatingDaysValue(body.operatingDays),
        opensAt: textValue(body.opensAt ?? '08:00', 'Warehouse opening time', 8),
        closesAt: textValue(body.closesAt ?? '17:00', 'Warehouse closing time', 8),
        standardProcessingMinutes: integerValue(
          body.standardProcessingMinutes ?? 120,
          'Standard processing time',
          0,
          10_080,
        ),
        dailyOrderCapacity: body.dailyOrderCapacity === null
          || body.dailyOrderCapacity === undefined
          || body.dailyOrderCapacity === ''
          ? null
          : integerValue(body.dailyOrderCapacity, 'Daily order capacity', 1, 1_000_000_000),
        carrierCutoffs: carrierCutoffsValue(body.carrierCutoffs),
        createStarterLocations: body.createStarterLocations !== false,
      })
      return json({ ok: true, capabilities, result }, 201)
    }
    if (action === 'update-warehouse') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to configure warehouses', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(body, new Set([
        'action', 'warehouseGlobalId', 'expectedRowVersion', 'name', 'facilityType',
        'timezone', 'address', 'cutoffTime', 'operatingDays', 'opensAt', 'closesAt',
        'standardProcessingMinutes', 'dailyOrderCapacity', 'carrierCutoffs', 'status',
      ]), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const result = await updateOperationsWarehouseInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        warehouseGlobalId: globalIdValue(body.warehouseGlobalId, 'Warehouse', WAREHOUSE_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Warehouse version', 0, 2_147_483_647),
        name: textValue(body.name, 'Warehouse name', 160),
        facilityType: textValue(body.facilityType, 'Facility type', 40) as OperationsWorkspace['warehouses'][number]['facilityType'],
        timezone: textValue(body.timezone, 'Warehouse timezone', 80),
        address: addressValue(body.address),
        cutoffTime: textValue(body.cutoffTime, 'Warehouse cutoff', 8, false) || null,
        operatingDays: operatingDaysValue(body.operatingDays),
        opensAt: textValue(body.opensAt ?? '08:00', 'Warehouse opening time', 8),
        closesAt: textValue(body.closesAt ?? '17:00', 'Warehouse closing time', 8),
        standardProcessingMinutes: integerValue(
          body.standardProcessingMinutes ?? 120,
          'Standard processing time',
          0,
          10_080,
        ),
        dailyOrderCapacity: body.dailyOrderCapacity === null
          || body.dailyOrderCapacity === undefined
          || body.dailyOrderCapacity === ''
          ? null
          : integerValue(body.dailyOrderCapacity, 'Daily order capacity', 1, 1_000_000_000),
        carrierCutoffs: carrierCutoffsValue(body.carrierCutoffs),
        status: textValue(body.status, 'Warehouse status', 20) as 'active' | 'inactive',
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'create-location') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to configure warehouse locations', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(body, new Set([
        'action', 'warehouseGlobalId', 'code', 'zone', 'locationType', 'topologyLevel',
        'parentLocationGlobalId', 'pickSequence', 'active', 'maxVolumeCubicMeters',
        'maxWeightKg', 'allowMixedProducts', 'storageFunction', 'notes', 'productRules',
      ]), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const locationType = textValue(body.locationType, 'Location type', 20) as OperationsWorkspace['warehouses'][number]['locations'][number]['locationType']
      const result = await createOperationsLocationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        warehouseGlobalId: globalIdValue(body.warehouseGlobalId, 'Warehouse', WAREHOUSE_GLOBAL_ID),
        code: textValue(body.code, 'Location code', 40),
        zone: textValue(body.zone, 'Location zone', 80),
        locationType,
        topologyLevel: textValue(body.topologyLevel, 'Topology level', 20) as OperationsWorkspace['warehouses'][number]['locations'][number]['topologyLevel'],
        parentLocationGlobalId: optionalGlobalIdValue(body.parentLocationGlobalId, 'Parent location', LOCATION_GLOBAL_ID),
        pickSequence: integerValue(body.pickSequence, 'Pick sequence', 0, 1_000_000),
        active: booleanValue(body.active, true),
        storageFunction: locationStorageFunctionValue(body.storageFunction, locationType),
        maxVolumeCubicMeters: optionalNumberValue(body.maxVolumeCubicMeters, 'Maximum cubic storage', 0.000001, 1_000_000_000),
        maxWeightKg: optionalNumberValue(body.maxWeightKg, 'Maximum weight', 0.000001, 1_000_000_000),
        allowMixedProducts: booleanValue(body.allowMixedProducts, true),
        notes: textValue(body.notes, 'Location notes', 2_000, false) || null,
        productRules: locationProductRulesValue(body.productRules),
      })
      return json({ ok: true, capabilities, result }, 201)
    }
    if (action === 'update-location') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to configure warehouse locations', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(body, new Set([
        'action', 'warehouseGlobalId', 'locationGlobalId', 'expectedRowVersion',
        'code', 'zone', 'locationType', 'topologyLevel', 'parentLocationGlobalId',
        'pickSequence', 'active', 'maxVolumeCubicMeters', 'maxWeightKg',
        'allowMixedProducts', 'storageFunction', 'notes', 'productRules',
      ]), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const locationType = textValue(body.locationType, 'Location type', 20) as OperationsWorkspace['warehouses'][number]['locations'][number]['locationType']
      const result = await updateOperationsLocationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        warehouseGlobalId: globalIdValue(body.warehouseGlobalId, 'Warehouse', WAREHOUSE_GLOBAL_ID),
        locationGlobalId: globalIdValue(body.locationGlobalId, 'Location', LOCATION_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Location version', 0, 2_147_483_647),
        code: textValue(body.code, 'Location code', 40),
        zone: textValue(body.zone, 'Location zone', 80),
        locationType,
        topologyLevel: textValue(body.topologyLevel, 'Topology level', 20) as OperationsWorkspace['warehouses'][number]['locations'][number]['topologyLevel'],
        parentLocationGlobalId: optionalGlobalIdValue(body.parentLocationGlobalId, 'Parent location', LOCATION_GLOBAL_ID),
        pickSequence: integerValue(body.pickSequence, 'Pick sequence', 0, 1_000_000),
        active: booleanValue(body.active, true),
        storageFunction: locationStorageFunctionValue(body.storageFunction, locationType),
        maxVolumeCubicMeters: optionalNumberValue(body.maxVolumeCubicMeters, 'Maximum cubic storage', 0.000001, 1_000_000_000),
        maxWeightKg: optionalNumberValue(body.maxWeightKg, 'Maximum weight', 0.000001, 1_000_000_000),
        allowMixedProducts: booleanValue(body.allowMixedProducts, true),
        notes: textValue(body.notes, 'Location notes', 2_000, false) || null,
        productRules: locationProductRulesValue(body.productRules),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'delete-location') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to remove warehouse locations', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(
        body,
        new Set(['action', 'locationGlobalId', 'expectedRowVersion']),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await deleteOperationsLocationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        locationGlobalId: globalIdValue(body.locationGlobalId, 'Location', LOCATION_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Location version', 0, 2_147_483_647),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'create-inbound-receipt') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to create inbound receipts',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'warehouseGlobalId',
          'inventoryPoolGlobalId',
          'referenceNumber',
          'expectedAt',
          'lines',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await createOperationsInboundReceiptInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        receipt: {
          warehouseGlobalId: globalIdValue(
            body.warehouseGlobalId,
            'Warehouse',
            WAREHOUSE_GLOBAL_ID,
          ),
          inventoryPoolGlobalId: globalIdValue(
            body.inventoryPoolGlobalId,
            'Inventory pool',
            INVENTORY_POOL_GLOBAL_ID,
          ),
          referenceNumber: textValue(body.referenceNumber, 'Receipt reference', 120),
          expectedAt: optionalDateTimeValue(body.expectedAt, 'Expected date'),
          lines: inboundReceiptLinesValue(body.lines),
        },
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'complete-inbound-receipt') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to complete inbound receipts',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'receiptGlobalId',
          'expectedRowVersion',
          'reason',
          'lines',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await completeOperationsInboundReceiptInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        completion: {
          receiptGlobalId: globalIdValue(
            body.receiptGlobalId,
            'Inbound receipt',
            RECEIPT_GLOBAL_ID,
          ),
          expectedRowVersion: integerValue(
            body.expectedRowVersion,
            'Receipt version',
            0,
            2_147_483_647,
          ),
          reason: textValue(body.reason, 'Receiving reason', 500),
          lines: inboundReceiptCompletionLinesValue(body.lines),
        },
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'execute-replenishment') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to execute warehouse replenishment',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'sourceLocationGlobalId',
          'destinationLocationGlobalId',
          'inventoryPoolGlobalId',
          'productGlobalId',
          'quantity',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await executeOperationsReplenishmentInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        replenishment: {
          sourceLocationGlobalId: globalIdValue(
            body.sourceLocationGlobalId,
            'Source location',
            LOCATION_GLOBAL_ID,
          ),
          destinationLocationGlobalId: globalIdValue(
            body.destinationLocationGlobalId,
            'Destination location',
            LOCATION_GLOBAL_ID,
          ),
          inventoryPoolGlobalId: globalIdValue(
            body.inventoryPoolGlobalId,
            'Inventory pool',
            INVENTORY_POOL_GLOBAL_ID,
          ),
          productGlobalId: globalIdValue(
            body.productGlobalId,
            'Product',
            PRODUCT_GLOBAL_ID,
          ),
          quantity: positiveNumberValue(body.quantity, 'Replenishment quantity'),
        },
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'run-proof-order') {
      requireOperationsProofFixture()
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to prepare warehouse operations',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(body, new Set(['action', 'proof']), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const result = await runMockOperationsProofFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        proof: proofValue(body.proof),
      })
      return json({ ok: true, capabilities, result }, result.duplicate ? 200 : 201)
    }
    if (action === 'plan-order') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to plan warehouse work',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'cartonizationEvidenceGlobalId',
          'expectedRowVersion',
          'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await planOperationsOrderFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        cartonizationEvidenceGlobalId: globalIdValue(
          body.cartonizationEvidenceGlobalId,
          'Cartonization evidence',
          CARTONIZATION_EVIDENCE_GLOBAL_ID,
        ),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        reason: textValue(body.reason, 'Planning reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'release-order') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to release warehouse work',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set(['action', 'orderGlobalId', 'expectedRowVersion', 'reason']),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await releaseOperationsOrderFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Release reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'confirm-picks') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to confirm warehouse picks',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set(['action', 'orderGlobalId', 'expectedRowVersion', 'reason']),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await confirmOperationsOrderPicksFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Pick confirmation reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'verify-pack') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to verify warehouse packages',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set(['action', 'orderGlobalId', 'expectedRowVersion', 'reason']),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await verifyOperationsOrderPackFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Package verification reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'generate-packing-slip') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to generate warehouse packing lists',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'packageGlobalId',
          'expectedRowVersion',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await generateOperationsPackagePackingSlipInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        packageGlobalId: globalIdValue(
          body.packageGlobalId,
          'Operations package',
          PACKAGE_GLOBAL_ID,
        ),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'confirm-shipment') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to confirm warehouse shipments',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'reason',
          'preferredPrinterGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await confirmOperationsOrderShipmentFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Shipment confirmation reason', 500),
        preferredPrinterGlobalId: optionalGlobalIdValue(
          body.preferredPrinterGlobalId,
          'Preferred printer',
          PRINTER_GLOBAL_ID,
        ),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'create-sandbox-label') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to purchase carrier labels',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'reason',
          'carrierRateGlobalId',
          'carrierAccountGlobalId',
          'preferredPrinterGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await createOperationsSandboxLabelInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Label creation reason', 500),
        carrierRateGlobalId: optionalGlobalIdValue(body.carrierRateGlobalId, 'Carrier rate', RATE_GLOBAL_ID),
        carrierAccountGlobalId: optionalGlobalIdValue(
          body.carrierAccountGlobalId,
          'Carrier account',
          CARRIER_ACCOUNT_GLOBAL_ID,
        ),
        preferredPrinterGlobalId: optionalGlobalIdValue(
          body.preferredPrinterGlobalId,
          'Preferred printer',
          PRINTER_GLOBAL_ID,
        ),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'void-sandbox-label') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to void carrier labels',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set(['action', 'orderGlobalId', 'expectedRowVersion', 'reason']),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await voidOperationsSandboxLabelInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Label void reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'update-exception') {
      if (!capabilities.canManage) {
        return json({
          ok: false,
          error: 'You do not have permission to manage operations exceptions',
          code: 'OPERATIONS_MANAGE_REQUIRED',
        }, 403)
      }
      assertFields(body, new Set(['action', 'exceptionGlobalId', 'status']), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const status = textValue(body.status, 'Exception status', 20) as OperationsExceptionStatus
      if (!EXCEPTION_STATUSES.has(status)) {
        requestError('OPERATIONS_EXCEPTION_STATUS_INVALID', 'Exception status is invalid')
      }
      const result = await updateOperationsExceptionInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        exceptionGlobalId: globalIdValue(body.exceptionGlobalId, 'Operations exception', EXCEPTION_GLOBAL_ID),
        status,
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'prepare-commerce-active-authorization') {
      if (!capabilities.canActivate) {
        return json({
          ok: false,
          error: 'Only an organization owner or authorized administrator may prepare Operations Active mode',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'expectedActivationState',
          'expectedActivationRevision',
          'selectedAccounts',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      if (textValue(body.expectedActivationState, 'Expected activation state', 20) !== 'shadow') {
        requestError(
          'COMMERCE_ACTIVE_SHADOW_REQUIRED',
          'Return Operations to Shadow before preparing Active provider writes',
          409,
        )
      }
      const prepared = await prepareCommerceActiveTransitionInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        expectedActivationState: 'shadow',
        expectedActivationRevision: integerValue(
          body.expectedActivationRevision,
          'Expected activation revision',
          1,
          2_147_483_647,
        ),
        selectedAccounts: commerceActiveSelectedAccountsValue(
          body.selectedAccounts,
        ),
        idempotencyKey: idempotencyKeyValue(req),
      })
      const result = {
        ...prepared,
        accounts: prepared.accounts.map((account) => ({
          accountGlobalId: account.accountGlobalId,
          provider: account.provider,
          environment: account.environment,
          externalAccountId: account.externalAccountId,
          credentialGeneration: account.credentialGeneration,
          authMode: account.authMode,
          priorAccountStatus: account.priorAccountStatus,
          targetAccountStatus: account.targetAccountStatus,
          grantedScopes: account.grantedScopes,
          grantedScopeDigest: account.grantedScopeDigest,
          writeCapabilities: account.writeCapabilities,
          capabilityDigest: account.capabilityDigest,
        })),
      }
      return json(
        { ok: true, capabilities, result },
        prepared.replayed ? 200 : 201,
      )
    }
    if (action === 'activate-commerce-with-authorization') {
      if (!capabilities.canActivate) {
        return json({
          ok: false,
          error: 'Only an organization owner or authorized administrator may activate Operations provider writes',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'preparationGlobalId',
          'expectedCohortHash',
          'confirmActiveProviderWrites',
          'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      if (body.confirmActiveProviderWrites !== true) {
        requestError(
          'COMMERCE_ACTIVE_CONFIRMATION_REQUIRED',
          'Confirm the exact reviewed commerce accounts and provider-write capabilities before activating',
        )
      }
      const preparationGlobalId = globalIdValue(
        body.preparationGlobalId,
        'Commerce Active preparation',
        COMMERCE_ACTIVE_PREPARATION_GLOBAL_ID,
      )
      const expectedCohortHash = sha256Value(
        body.expectedCohortHash,
        'Expected commerce cohort hash',
      )
      const idempotencyKey = idempotencyKeyValue(req)
      const authorization =
        await authorizeCommerceActiveTransitionInPostgres({
          organizationId: activeOperationsOrganizationId(actor),
          actorEmail: actor.email,
          preparationGlobalId,
          expectedCohortHash,
          idempotencyKey,
        })
      const transition =
        await consumeCommerceActiveTransitionAuthorizationInPostgres({
          organizationId: activeOperationsOrganizationId(actor),
          actorEmail: actor.email,
          authorizationGlobalId: authorization.authorizationGlobalId,
          expectedCohortHash,
          idempotencyKey,
          reason: textValue(
            body.reason,
            'Activation reason',
            500,
            false,
          ) || null,
        })
      return json({
        ok: true,
        capabilities,
        result: { authorization, transition },
      })
    }
    if (action === 'update-activation') {
      if (!capabilities.canActivate) {
        return json({
          ok: false,
          error: 'Only an organization owner or authorized administrator may change Operations activation',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'state',
          'reason',
          'expectedCurrentState',
          'expectedCurrentRevision',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const state = textValue(body.state, 'Activation state', 20) as OperationsActivationState
      if (!ACTIVATION_STATES.has(state)) {
        requestError('OPERATIONS_ACTIVATION_STATE_INVALID', 'Operations activation state is invalid')
      }
      if (state === 'active') {
        requestError(
          'COMMERCE_ACTIVE_AUTHORIZATION_REQUIRED',
          'Prepare and explicitly authorize the exact commerce provider-write cohort before activating Operations',
          409,
        )
      }
      const expectedCurrentState = textValue(
        body.expectedCurrentState,
        'Expected current activation state',
        20,
      ) as OperationsActivationState
      if (!ACTIVATION_STATES.has(expectedCurrentState)) {
        requestError(
          'OPERATIONS_ACTIVATION_STATE_INVALID',
          'Expected current activation state is invalid',
        )
      }
      const result = await updateOperationsActivationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        state,
        reason: textValue(body.reason, 'Activation reason', 500, false) || null,
        expectedCurrentState,
        expectedCurrentRevision: integerValue(
          body.expectedCurrentRevision,
          'Expected current activation revision',
          1,
          2_147_483_647,
        ),
      })
      return json({ ok: true, capabilities, result })
    }
    requestError('OPERATIONS_ACTION_INVALID', 'Operations action is invalid')
  } catch (error) {
    return errorResponse(error)
  }
}
