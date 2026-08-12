import { createHash } from 'node:crypto'

const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const SHOPIFY_LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_GID =
  /^gid:\/\/shopify\/Fulfillment\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_ORDER_GID =
  /^gid:\/\/shopify\/FulfillmentOrder\/[1-9][0-9]*$/
const SHOPIFY_LOCATION_GID = /^gid:\/\/shopify\/Location\/[1-9][0-9]*$/

export type ShopifyExternalFulfillmentTarget = {
  externalOrderId: string
  orderName: string
  releasedAt: string
  providerLocationId: string
  lines: Array<{
    externalLineId: string
    quantity: number
  }>
}

export type ShopifyExternalFulfillmentEvidenceSnapshot = {
  version: 'shopify-external-fulfillment-reconciliation-v1'
  observedAt: string
  order: {
    id: string
    name: string
    updatedAt: string
    displayFulfillmentStatus: 'FULFILLED'
    fulfillable: false
    closedAt: string | null
  }
  locationId: string
  fulfillment: {
    id: string
    name: string
    status: 'SUCCESS'
    displayStatus: 'FULFILLED'
    createdAt: string
    updatedAt: string
    hasTracking: boolean
    fulfillmentOrderIds: string[]
    lines: Array<{
      externalLineId: string
      quantity: number
    }>
  }
  fulfillmentOrders: Array<{
    id: string
    status: 'CLOSED'
    requestStatus: 'UNSUBMITTED'
    updatedAt: string
    locationId: string
    lines: Array<{
      externalLineId: string
      totalQuantity: number
      remainingQuantity: 0
    }>
  }>
}

export type ShopifyExternalFulfillmentEvidence = {
  evidenceHash: string
  snapshot: ShopifyExternalFulfillmentEvidenceSnapshot
}

export class ShopifyExternalFulfillmentEvidenceError extends Error {
  readonly code: string
  readonly status: number

  constructor(
    code: string,
    message: string,
    status = 409,
  ) {
    super(message)
    this.name = 'ShopifyExternalFulfillmentEvidenceError'
    this.code = code
    this.status = status
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new ShopifyExternalFulfillmentEvidenceError(code, message, status)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
    )
  }
  return value as Record<string, unknown>
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
    )
  }
  return value.map((item) => record(item, label))
}

function text(value: unknown, label: string, pattern?: RegExp): string {
  const normalized = String(value || '').trim()
  if (
    !normalized
    || normalized.length > 512
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || (pattern && !pattern.test(normalized))
  ) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
    )
  }
  return normalized
}

function iso(value: unknown, label: string): string {
  const parsed = new Date(String(value || ''))
  if (!Number.isFinite(parsed.getTime())) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
    )
  }
  return parsed.toISOString()
}

function wholeQuantity(value: unknown, label: string): number {
  const quantity = Number(value)
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
    )
  }
  return quantity
}

function connection(value: unknown, label: string) {
  const source = record(value, label)
  const pageInfo = record(source.pageInfo, `${label} page information`)
  if (pageInfo.hasNextPage !== false) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_PAGINATION_REQUIRED',
      `Shopify ${label} exceed the bounded reconciliation read`,
    )
  }
  return records(source.nodes, `${label} nodes`)
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

export function shopifyExternalFulfillmentEvidenceHash(
  snapshot: ShopifyExternalFulfillmentEvidenceSnapshot,
) {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex')
}

export function normalizeShopifyExternalFulfillmentEvidence(input: {
  target: ShopifyExternalFulfillmentTarget
  providerOrder: unknown
  observedAt?: string
}): ShopifyExternalFulfillmentEvidence {
  const target = input.target
  if (
    !SHOPIFY_ORDER_GID.test(target.externalOrderId)
    || !SHOPIFY_LOCATION_GID.test(target.providerLocationId)
    || !target.orderName.trim()
    || target.lines.length < 1
    || target.lines.length > 250
    || new Set(target.lines.map((line) => line.externalLineId)).size
      !== target.lines.length
    || target.lines.some((line) => (
      !SHOPIFY_LINE_ITEM_GID.test(line.externalLineId)
      || !Number.isSafeInteger(line.quantity)
      || line.quantity < 1
    ))
  ) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_TARGET_INVALID',
      'The ClawPilot external-fulfillment target is invalid',
      500,
    )
  }
  const releasedAt = iso(target.releasedAt, 'warehouse release time')
  const order = record(input.providerOrder, 'order')
  if (
    text(order.id, 'order ID', SHOPIFY_ORDER_GID) !== target.externalOrderId
    || text(order.name, 'order name') !== target.orderName
  ) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_ORDER_CHANGED',
      'Shopify returned a different order identity',
    )
  }
  if (order.cancelledAt !== null) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_ORDER_CANCELLED',
      'The Shopify order was cancelled, not externally fulfilled',
    )
  }
  if (
    order.displayFulfillmentStatus !== 'FULFILLED'
    || order.fulfillable !== false
  ) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_NOT_FOUND',
      'Shopify does not show this order as fully fulfilled',
    )
  }

  const targetByLine = new Map(target.lines.map((line) => [
    line.externalLineId,
    line.quantity,
  ]))
  const providerLines = connection(order.lineItems, 'order lines')
  if (
    providerLines.length !== targetByLine.size
    || providerLines.some((line) => !targetByLine.has(String(line.id || '')))
  ) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_LINE_CHANGED',
      'Shopify no longer has the exact released order line set',
    )
  }
  for (const [externalLineId, quantity] of targetByLine) {
    const matches = providerLines.filter((line) => line.id === externalLineId)
    if (matches.length !== 1) {
      fail(
        'SHOPIFY_EXTERNAL_FULFILLMENT_LINE_CHANGED',
        'Shopify no longer has the exact released order line',
      )
    }
    const line = matches[0]
    if (
      wholeQuantity(line.currentQuantity, 'current line quantity') !== quantity
      || wholeQuantity(line.unfulfilledQuantity, 'unfulfilled line quantity')
        !== 0
      || line.requiresShipping !== true
    ) {
      fail(
        'SHOPIFY_EXTERNAL_FULFILLMENT_LINE_CHANGED',
        'Shopify line quantities no longer match the released warehouse work',
      )
    }
  }

  const normalizedFulfillmentOrders = connection(
    order.fulfillmentOrders,
    'fulfillment orders',
  ).map((value) => {
    const assignedLocation = record(
      value.assignedLocation,
      'fulfillment-order assigned location',
    )
    const location = record(
      assignedLocation.location,
      'fulfillment-order location',
    )
    const lines = connection(
      value.lineItems,
      'fulfillment-order lines',
    ).map((line) => {
      const orderLine = record(line.lineItem, 'fulfillment-order source line')
      return {
        externalLineId: text(
          orderLine.id,
          'fulfillment-order source line ID',
          SHOPIFY_LINE_ITEM_GID,
        ),
        totalQuantity: wholeQuantity(
          line.totalQuantity,
          'fulfillment-order total quantity',
        ),
        remainingQuantity: wholeQuantity(
          line.remainingQuantity,
          'fulfillment-order remaining quantity',
        ),
      }
    })
    return {
      id: text(
        value.id,
        'fulfillment-order ID',
        SHOPIFY_FULFILLMENT_ORDER_GID,
      ),
      status: text(value.status, 'fulfillment-order status'),
      requestStatus: text(
        value.requestStatus,
        'fulfillment-order request status',
      ),
      updatedAt: iso(value.updatedAt, 'fulfillment-order update time'),
      locationId: text(location.id, 'fulfillment-order location ID', SHOPIFY_LOCATION_GID),
      lines,
    }
  }).filter((fulfillmentOrder) => fulfillmentOrder.lines.some(
    (line) => targetByLine.has(line.externalLineId),
  ))

  const fulfillmentOrderCoverage = new Map<string, number>()
  for (const fulfillmentOrder of normalizedFulfillmentOrders) {
    if (
      fulfillmentOrder.status !== 'CLOSED'
      || fulfillmentOrder.requestStatus !== 'UNSUBMITTED'
      || fulfillmentOrder.locationId !== target.providerLocationId
    ) {
      fail(
        'SHOPIFY_EXTERNAL_FULFILLMENT_LOCATION_MISMATCH',
        'Shopify fulfillment authority does not match the released warehouse location',
      )
    }
    for (const line of fulfillmentOrder.lines) {
      if (!targetByLine.has(line.externalLineId)) continue
      if (line.remainingQuantity !== 0) {
        fail(
          'SHOPIFY_EXTERNAL_FULFILLMENT_COVERAGE_MISMATCH',
          'Shopify still reports remaining fulfillment quantity',
        )
      }
      fulfillmentOrderCoverage.set(
        line.externalLineId,
        (fulfillmentOrderCoverage.get(line.externalLineId) || 0)
          + line.totalQuantity,
      )
    }
  }
  for (const [externalLineId, quantity] of targetByLine) {
    if (fulfillmentOrderCoverage.get(externalLineId) !== quantity) {
      fail(
        'SHOPIFY_EXTERNAL_FULFILLMENT_COVERAGE_MISMATCH',
        'Shopify fulfillment orders do not exactly cover the released work',
      )
    }
  }

  const providerFulfillments = records(
    order.fulfillments,
    'fulfillments',
  )
  if (providerFulfillments.length >= 250) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_PAGINATION_REQUIRED',
      'Shopify fulfillments exceed the bounded reconciliation read',
    )
  }
  const successfulFulfillments = providerFulfillments.filter((value) => (
    value.status === 'SUCCESS'
    && value.displayStatus === 'FULFILLED'
  )).map((value) => ({
    id: text(value.id, 'fulfillment ID', SHOPIFY_FULFILLMENT_GID),
    name: text(value.name, 'fulfillment name'),
    status: 'SUCCESS' as const,
    displayStatus: 'FULFILLED' as const,
    createdAt: iso(value.createdAt, 'fulfillment creation time'),
    updatedAt: iso(value.updatedAt, 'fulfillment update time'),
    hasTracking: Array.isArray(value.trackingInfo)
      && value.trackingInfo.length > 0,
    fulfillmentOrders: connection(
      value.fulfillmentOrders,
      'fulfillment source orders',
    ).map((fulfillmentOrder) => {
      const assignedLocation = record(
        fulfillmentOrder.assignedLocation,
        'fulfillment source-order assigned location',
      )
      const location = record(
        assignedLocation.location,
        'fulfillment source-order location',
      )
      return {
        id: text(
          fulfillmentOrder.id,
          'fulfillment source-order ID',
          SHOPIFY_FULFILLMENT_ORDER_GID,
        ),
        locationId: text(
          location.id,
          'fulfillment source-order location ID',
          SHOPIFY_LOCATION_GID,
        ),
      }
    }).sort((left, right) => left.id.localeCompare(right.id)),
    lines: connection(
      value.fulfillmentLineItems,
      'fulfillment lines',
    ).map((line) => {
      const orderLine = record(line.lineItem, 'fulfillment source line')
      return {
        externalLineId: text(
          orderLine.id,
          'fulfillment source line ID',
          SHOPIFY_LINE_ITEM_GID,
        ),
        quantity: wholeQuantity(line.quantity, 'fulfillment line quantity'),
      }
    }).sort((left, right) => (
      left.externalLineId.localeCompare(right.externalLineId)
    )),
  }))
  const expectedLines = [...target.lines].sort((left, right) => (
    left.externalLineId.localeCompare(right.externalLineId)
  ))
  const exactFulfillments = successfulFulfillments.filter((fulfillment) => (
    canonicalJson(fulfillment.lines) === canonicalJson(expectedLines)
  ))
  if (exactFulfillments.length !== 1) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_COVERAGE_MISMATCH',
      'Shopify does not have one exact successful fulfillment for the released work',
    )
  }
  const exactFulfillment = exactFulfillments[0]
  const expectedFulfillmentOrderIds = normalizedFulfillmentOrders
    .map((item) => item.id)
    .sort((left, right) => left.localeCompare(right))
  if (
    exactFulfillment.fulfillmentOrders.length < 1
    || exactFulfillment.fulfillmentOrders.some(
      (item) => item.locationId !== target.providerLocationId,
    )
    || canonicalJson(exactFulfillment.fulfillmentOrders.map((item) => item.id))
      !== canonicalJson(expectedFulfillmentOrderIds)
  ) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_LOCATION_MISMATCH',
      'The successful Shopify fulfillment is not bound to the exact released location authority',
    )
  }
  if (new Date(exactFulfillment.createdAt).getTime() < new Date(releasedAt).getTime()) {
    fail(
      'SHOPIFY_EXTERNAL_FULFILLMENT_PREDATES_RELEASE',
      'The Shopify fulfillment predates this released warehouse work',
    )
  }
  const observedAt = input.observedAt
    ? iso(input.observedAt, 'provider observation time')
    : new Date().toISOString()
  const fulfillment = {
    id: exactFulfillment.id,
    name: exactFulfillment.name,
    status: exactFulfillment.status,
    displayStatus: exactFulfillment.displayStatus,
    createdAt: exactFulfillment.createdAt,
    updatedAt: exactFulfillment.updatedAt,
    hasTracking: exactFulfillment.hasTracking,
    fulfillmentOrderIds: expectedFulfillmentOrderIds,
    lines: exactFulfillment.lines,
  }
  const snapshot: ShopifyExternalFulfillmentEvidenceSnapshot = {
    version: 'shopify-external-fulfillment-reconciliation-v1',
    observedAt,
    order: {
      id: target.externalOrderId,
      name: target.orderName,
      updatedAt: iso(order.updatedAt, 'order update time'),
      displayFulfillmentStatus: 'FULFILLED',
      fulfillable: false,
      closedAt: order.closedAt === null
        ? null
        : iso(order.closedAt, 'order close time'),
    },
    locationId: target.providerLocationId,
    fulfillment,
    fulfillmentOrders: normalizedFulfillmentOrders.map((value) => ({
      ...value,
      status: 'CLOSED' as const,
      requestStatus: 'UNSUBMITTED' as const,
      lines: value.lines
        .filter((line) => targetByLine.has(line.externalLineId))
        .map((line) => ({
          ...line,
          remainingQuantity: 0 as const,
        }))
        .sort((left, right) => (
          left.externalLineId.localeCompare(right.externalLineId)
        )),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  }
  return {
    evidenceHash: shopifyExternalFulfillmentEvidenceHash(snapshot),
    snapshot,
  }
}
