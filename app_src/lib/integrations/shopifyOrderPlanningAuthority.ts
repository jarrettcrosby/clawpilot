import { createHash } from 'node:crypto'
import {
  decryptCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  hasEffectiveShopifyScope,
} from '@/lib/integrations/commerceCapabilities'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
  ShopifyCommerceClientError,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'
import {
  readShopifyOrderPlanningAssignmentTargetFromPostgres,
  readShopifyOrderPlanningAuthorityTargetFromPostgres,
  ShopifyOrderPlanningAuthorityPersistenceError,
  type ShopifyOrderPlanningAssignmentTarget,
  type ShopifyOrderPlanningAuthorityTarget,
} from '@/lib/persistence/shopifyOrderPlanningAuthority'

const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const SHOPIFY_SHOP_GID = /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/
const SHOPIFY_LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_ORDER_GID =
  /^gid:\/\/shopify\/FulfillmentOrder\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_ORDER_LINE_ITEM_GID =
  /^gid:\/\/shopify\/FulfillmentOrderLineItem\/[1-9][0-9]*$/
const SHOPIFY_LOCATION_GID = /^gid:\/\/shopify\/Location\/[1-9][0-9]*$/
const SHOPIFY_FULFILLMENT_SERVICE_GID =
  /^gid:\/\/shopify\/FulfillmentService\/[1-9][0-9]*$/
const SHA256 = /^[a-f0-9]{64}$/
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/
const CANDIDATE_LINE_GLOBAL_ID = /^(?:gcol|gcal)(?:[0-9]{7}|[0-9a-v]{12})$/
const CANONICAL_LINE_GLOBAL_ID = /^gol(?:[0-9]{7}|[0-9a-v]{12})$/
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/
const LOCATION_MAPPING_GLOBAL_ID = /^gilm(?:[0-9]{7}|[0-9a-v]{12})$/
const REQUIRED_SCOPES = [
  'read_orders',
  'read_locations',
  'read_merchant_managed_fulfillment_orders',
  'read_third_party_fulfillment_orders',
  'read_assigned_fulfillment_orders',
] as const
const MAX_SHOPIFY_ORDER_LINES = 250
const MAX_SHOPIFY_FULFILLMENT_ORDERS = 25
const MAX_SHOPIFY_FULFILLMENT_ORDER_LINES = 250

const SHOPIFY_ORDER_PLANNING_ASSIGNMENT_QUERY = `query ClawPilotShopifyOrderPlanningAssignment($id: ID!) {
  order(id: $id) {
    id
    fulfillmentOrders(first: ${MAX_SHOPIFY_FULFILLMENT_ORDERS}) {
      nodes {
        id
        status
        requestStatus
        assignedLocation {
          location {
            id
            name
            isFulfillmentService
            fulfillmentService { id serviceName type }
          }
        }
        lineItems(first: ${MAX_SHOPIFY_FULFILLMENT_ORDER_LINES}) {
          nodes { remainingQuantity }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}`

const SHOPIFY_ORDER_PLANNING_QUERY = `query ClawPilotShopifyOrderPlanningAuthority($id: ID!) {
  order(id: $id) {
    id
    name
    confirmed
    cancelledAt
    closedAt
    updatedAt
    displayFulfillmentStatus
    fulfillable
    lineItems(first: ${MAX_SHOPIFY_ORDER_LINES}) {
      nodes {
        id
        currentQuantity
        unfulfilledQuantity
        requiresShipping
      }
      pageInfo { hasNextPage }
    }
    fulfillmentOrders(first: ${MAX_SHOPIFY_FULFILLMENT_ORDERS}) {
      nodes {
        id
        status
        requestStatus
        updatedAt
        assignedLocation {
          location {
            id
            name
            isFulfillmentService
            fulfillmentService { id serviceName type }
          }
        }
        lineItems(first: ${MAX_SHOPIFY_FULFILLMENT_ORDER_LINES}) {
          nodes {
            id
            lineItem { id }
            remainingQuantity
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}`

export type ShopifyOrderPlanningAuthoritySnapshot = {
  version: 'shopify-order-planning-authority-v1'
  shopId: string
  credentialVersion: number
  accountGlobalId: string
  candidate: {
    globalId: string
    rowVersion: number
    sourceHash: string
  }
  warehouse: {
    globalId: string
    locationMappingGlobalId: string
    locationMappingRowVersion: number
    shopifyLocationId: string
  }
  order: {
    externalOrderId: string
    name: string
    updatedAt: string
    confirmed: true
    cancelledAt: null
    closedAt: null
    fulfillmentStatus: string
    fulfillable: true
  }
  lines: Array<{
    candidateLineGlobalId: string
    canonicalLineGlobalId: string
    externalLineId: string
    quantity: number
  }>
  fulfillmentOrders: Array<{
    fulfillmentOrderId: string
    status: 'OPEN'
    requestStatus: 'UNSUBMITTED'
    updatedAt: string
    assignedLocationId: string
    lines: Array<{
      fulfillmentOrderLineItemId: string
      externalLineId: string
      quantity: number
    }>
  }>
}

export type ShopifyOrderPlanningAuthorityEvidence = {
  authorityHash: string
  snapshot: ShopifyOrderPlanningAuthoritySnapshot
  providerReads: number
  providerWrites: 0
}

export type ShopifyOrderPlanningAuthorityProviderRead = {
  snapshot: ShopifyOrderPlanningAuthoritySnapshot
  providerReads: number
}

export type ShopifyOrderPlanningAssignment = {
  version: 'shopify-order-planning-assignment-v1'
  status: 'ready' | 'unmapped' | 'provider_managed' | 'split' | 'not_open'
  accountGlobalId: string
  candidateGlobalId: string
  candidateRowVersion: number
  assignments: Array<{
    shopifyLocationId: string
    shopifyLocationName: string
    ownerType: 'merchant_managed' | 'fulfillment_service'
    fulfillmentService: null | {
      id: string
      serviceName: string
      type: string | null
    }
    fulfillmentOrderIds: string[]
    mapping: null | {
      globalId: string
      rowVersion: number
      warehouseGlobalId: string
      warehouseName: string
      locationGlobalId: string
      locationCode: string
    }
  }>
  selectedWarehouse: null | {
    globalId: string
    name: string
    mappingGlobalId: string
    mappingRowVersion: number
    shopifyLocationId: string
    shopifyLocationName: string
  }
  providerReads: 1
  providerWrites: 0
}

export class ShopifyOrderPlanningAuthorityError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = 'SHOPIFY_ORDER_PLANNING_AUTHORITY_INVALID',
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ShopifyOrderPlanningAuthorityError'
  }
}

type Dependencies = {
  readTarget: typeof readShopifyOrderPlanningAuthorityTargetFromPostgres
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  decryptCredential: typeof decryptCommerceCredential
  requestAccessToken: typeof requestShopifyAccessToken
  probeConnection: typeof probeShopifyConnection
  readOrder: typeof readShopifyOrderPlanningAuthority
}

type AssignmentDependencies = {
  readTarget: typeof readShopifyOrderPlanningAssignmentTargetFromPostgres
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  decryptCredential: typeof decryptCommerceCredential
  requestAccessToken: typeof requestShopifyAccessToken
  probeConnection: typeof probeShopifyConnection
  readAssignment: typeof readShopifyOrderPlanningAssignment
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  readTarget: readShopifyOrderPlanningAuthorityTargetFromPostgres,
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
  readOrder: readShopifyOrderPlanningAuthority,
}

const DEFAULT_ASSIGNMENT_DEPENDENCIES: AssignmentDependencies = {
  readTarget: readShopifyOrderPlanningAssignmentTargetFromPostgres,
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
  readAssignment: readShopifyOrderPlanningAssignment,
}

function fail(
  message: string,
  status = 409,
  code = 'SHOPIFY_ORDER_PLANNING_AUTHORITY_INVALID',
  retryable = false,
): never {
  throw new ShopifyOrderPlanningAuthorityError(
    message,
    status,
    code,
    retryable,
  )
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      `Shopify returned malformed ${label}`,
      502,
      'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
      true,
    )
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum = 255) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(
      `Shopify returned malformed ${label}`,
      502,
      'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
      true,
    )
  }
  return value
}

function gid(value: unknown, pattern: RegExp, label: string) {
  const normalized = text(value, label, 128)
  if (!pattern.test(normalized)) {
    fail(
      `Shopify returned malformed ${label}`,
      502,
      'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
      true,
    )
  }
  return normalized
}

function integer(value: unknown, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(
      `Shopify returned malformed ${label}`,
      502,
      'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
      true,
    )
  }
  return Number(value)
}

function boolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    fail(
      `Shopify returned malformed ${label}`,
      502,
      'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
      true,
    )
  }
  return value
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null
  return timestamp(value, label)
}

function timestamp(value: unknown, label: string) {
  const normalized = text(value, label, 64)
  const parsed = new Date(normalized)
  if (!Number.isFinite(parsed.getTime())) {
    fail(
      `Shopify returned malformed ${label}`,
      502,
      'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
      true,
    )
  }
  return parsed.toISOString()
}

function nodes(value: unknown, label: string, maximum: number) {
  const connection = record(value, label)
  const pageInfo = record(connection.pageInfo, `${label}.pageInfo`)
  if (
    !Array.isArray(connection.nodes)
    || connection.nodes.length > maximum
    || typeof pageInfo.hasNextPage !== 'boolean'
  ) {
    fail(
      `Shopify returned malformed ${label}`,
      502,
      'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
      true,
    )
  }
  if (pageInfo.hasNextPage) {
    fail(
      `Shopify ${label} exceeded the bounded planning-authority read`,
      422,
      'SHOPIFY_ORDER_PLANNING_PAGINATION_REQUIRED',
    )
  }
  return connection.nodes.map((entry, index) => (
    record(entry, `${label}.nodes[${index}]`)
  ))
}

function canonicalHash(snapshot: ShopifyOrderPlanningAuthoritySnapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

function snapshotReference(
  value: unknown,
  pattern: RegExp,
  label: string,
) {
  const normalized = text(value, label, 128)
  if (!pattern.test(normalized)) {
    fail(
      `Retained Shopify planning evidence has malformed ${label}`,
      500,
      'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
    )
  }
  return normalized
}

function snapshotArray(value: unknown, label: string, maximum: number) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    fail(
      `Retained Shopify planning evidence has malformed ${label}`,
      500,
      'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
    )
  }
  return value
}

export function normalizeShopifyOrderPlanningAuthoritySnapshot(
  value: unknown,
): ShopifyOrderPlanningAuthoritySnapshot {
  const snapshot = record(value, 'planning authority snapshot')
  if (snapshot.version !== 'shopify-order-planning-authority-v1') {
    fail(
      'Retained Shopify planning evidence uses an unsupported version',
      500,
      'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
    )
  }
  const candidate = record(snapshot.candidate, 'snapshot.candidate')
  const warehouse = record(snapshot.warehouse, 'snapshot.warehouse')
  const order = record(snapshot.order, 'snapshot.order')
  if (
    order.confirmed !== true
    || order.cancelledAt !== null
    || order.closedAt !== null
    || order.fulfillable !== true
  ) {
    fail(
      'Retained Shopify planning evidence does not describe an open order',
      500,
      'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
    )
  }
  const lines = snapshotArray(snapshot.lines, 'snapshot.lines', 250)
    .map((entry, index) => {
      const line = record(entry, `snapshot.lines[${index}]`)
      return {
        candidateLineGlobalId: snapshotReference(
          line.candidateLineGlobalId,
          CANDIDATE_LINE_GLOBAL_ID,
          'candidate line Global ID',
        ),
        canonicalLineGlobalId: snapshotReference(
          line.canonicalLineGlobalId,
          CANONICAL_LINE_GLOBAL_ID,
          'canonical line Global ID',
        ),
        externalLineId: gid(
          line.externalLineId,
          SHOPIFY_LINE_ITEM_GID,
          'snapshot line Shopify ID',
        ),
        quantity: integer(line.quantity, 'snapshot line quantity', 1),
      }
    }).sort((left, right) => (
      left.externalLineId.localeCompare(right.externalLineId)
      || left.candidateLineGlobalId.localeCompare(right.candidateLineGlobalId)
    ))
  if (new Set(lines.map((line) => line.externalLineId)).size !== lines.length) {
    fail(
      'Retained Shopify planning evidence has duplicate order lines',
      500,
      'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
    )
  }
  const fulfillmentOrders = snapshotArray(
    snapshot.fulfillmentOrders,
    'snapshot.fulfillmentOrders',
    MAX_SHOPIFY_FULFILLMENT_ORDERS,
  ).map((entry, index) => {
    const fulfillmentOrder = record(
      entry,
      `snapshot.fulfillmentOrders[${index}]`,
    )
    if (
      fulfillmentOrder.status !== 'OPEN'
      || fulfillmentOrder.requestStatus !== 'UNSUBMITTED'
    ) {
      fail(
        'Retained Shopify planning evidence has an actioned fulfillment order',
        500,
        'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
      )
    }
    const fulfillmentLines = snapshotArray(
      fulfillmentOrder.lines,
      `snapshot.fulfillmentOrders[${index}].lines`,
      250,
    ).map((lineEntry, lineIndex) => {
      const line = record(
        lineEntry,
        `snapshot.fulfillmentOrders[${index}].lines[${lineIndex}]`,
      )
      return {
        fulfillmentOrderLineItemId: gid(
          line.fulfillmentOrderLineItemId,
          SHOPIFY_FULFILLMENT_ORDER_LINE_ITEM_GID,
          'snapshot fulfillment-order line ID',
        ),
        externalLineId: gid(
          line.externalLineId,
          SHOPIFY_LINE_ITEM_GID,
          'snapshot fulfillment line Shopify ID',
        ),
        quantity: integer(
          line.quantity,
          'snapshot fulfillment line quantity',
          1,
        ),
      }
    }).sort((left, right) => (
      left.externalLineId.localeCompare(right.externalLineId)
      || left.fulfillmentOrderLineItemId.localeCompare(
        right.fulfillmentOrderLineItemId,
      )
    ))
    return {
      fulfillmentOrderId: gid(
        fulfillmentOrder.fulfillmentOrderId,
        SHOPIFY_FULFILLMENT_ORDER_GID,
        'snapshot fulfillment order ID',
      ),
      status: 'OPEN' as const,
      requestStatus: 'UNSUBMITTED' as const,
      updatedAt: timestamp(
        fulfillmentOrder.updatedAt,
        'snapshot fulfillment order update time',
      ),
      assignedLocationId: gid(
        fulfillmentOrder.assignedLocationId,
        SHOPIFY_LOCATION_GID,
        'snapshot assigned location ID',
      ),
      lines: fulfillmentLines,
    }
  }).sort((left, right) => (
    left.fulfillmentOrderId.localeCompare(right.fulfillmentOrderId)
  ))
  if (
    new Set(fulfillmentOrders.map((entry) => entry.fulfillmentOrderId)).size
      !== fulfillmentOrders.length
  ) {
    fail(
      'Retained Shopify planning evidence has duplicate fulfillment orders',
      500,
      'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
    )
  }
  const shopifyLocationId = gid(
    warehouse.shopifyLocationId,
    SHOPIFY_LOCATION_GID,
    'snapshot warehouse Shopify location ID',
  )
  if (fulfillmentOrders.some((entry) => (
    entry.assignedLocationId !== shopifyLocationId
  ))) {
    fail(
      'Retained Shopify planning evidence spans a different warehouse location',
      500,
      'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
    )
  }
  const fulfillmentQuantityByLine = new Map<string, number>()
  for (const fulfillmentOrder of fulfillmentOrders) {
    for (const line of fulfillmentOrder.lines) {
      fulfillmentQuantityByLine.set(
        line.externalLineId,
        (fulfillmentQuantityByLine.get(line.externalLineId) || 0)
          + line.quantity,
      )
    }
  }
  if (
    fulfillmentQuantityByLine.size !== lines.length
    || lines.some((line) => (
      fulfillmentQuantityByLine.get(line.externalLineId) !== line.quantity
    ))
  ) {
    fail(
      'Retained Shopify planning evidence has inconsistent line quantities',
      500,
      'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
    )
  }
  const sourceHash = text(candidate.sourceHash, 'snapshot candidate source hash', 64)
  if (!SHA256.test(sourceHash)) {
    fail(
      'Retained Shopify planning evidence has an invalid candidate source hash',
      500,
      'SHOPIFY_ORDER_PLANNING_SNAPSHOT_INVALID',
    )
  }
  return {
    version: 'shopify-order-planning-authority-v1',
    shopId: gid(snapshot.shopId, SHOPIFY_SHOP_GID, 'snapshot shop ID'),
    credentialVersion: integer(
      snapshot.credentialVersion,
      'snapshot credential version',
      1,
    ),
    accountGlobalId: snapshotReference(
      snapshot.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'account Global ID',
    ),
    candidate: {
      globalId: snapshotReference(
        candidate.globalId,
        CANDIDATE_GLOBAL_ID,
        'candidate Global ID',
      ),
      rowVersion: integer(
        candidate.rowVersion,
        'snapshot candidate row version',
      ),
      sourceHash,
    },
    warehouse: {
      globalId: snapshotReference(
        warehouse.globalId,
        WAREHOUSE_GLOBAL_ID,
        'warehouse Global ID',
      ),
      locationMappingGlobalId: snapshotReference(
        warehouse.locationMappingGlobalId,
        LOCATION_MAPPING_GLOBAL_ID,
        'location mapping Global ID',
      ),
      locationMappingRowVersion: integer(
        warehouse.locationMappingRowVersion,
        'snapshot location mapping row version',
      ),
      shopifyLocationId,
    },
    order: {
      externalOrderId: gid(
        order.externalOrderId,
        SHOPIFY_ORDER_GID,
        'snapshot order ID',
      ),
      name: text(order.name, 'snapshot order name', 255),
      updatedAt: timestamp(order.updatedAt, 'snapshot order update time'),
      confirmed: true,
      cancelledAt: null,
      closedAt: null,
      fulfillmentStatus: text(
        order.fulfillmentStatus,
        'snapshot fulfillment status',
        64,
      ),
      fulfillable: true,
    },
    lines,
    fulfillmentOrders,
  }
}

export function shopifyOrderPlanningAuthorityHash(value: unknown) {
  return canonicalHash(
    normalizeShopifyOrderPlanningAuthoritySnapshot(value),
  )
}

export function assertShopifyOrderPlanningAuthorityHash(value: unknown) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(
      'Shopify order planning authority hash is invalid',
      400,
      'SHOPIFY_ORDER_PLANNING_HASH_INVALID',
    )
  }
  return value
}

function assertProviderOrderPlanningHeader(
  value: unknown,
  target: ShopifyOrderPlanningAuthorityTarget,
) {
  if (value === null || value === undefined) {
    fail(
      'The exact Shopify order no longer exists',
      409,
      'SHOPIFY_ORDER_PLANNING_ORDER_NOT_FOUND',
    )
  }
  const order = record(value, 'order')
  const externalOrderId = gid(order.id, SHOPIFY_ORDER_GID, 'order.id')
  if (externalOrderId !== target.externalOrderId) {
    fail(
      'Shopify returned a different order identity',
      409,
      'SHOPIFY_ORDER_PLANNING_ORDER_IDENTITY_CHANGED',
    )
  }
  const confirmed = boolean(order.confirmed, 'order.confirmed')
  const cancelledAt = nullableTimestamp(order.cancelledAt, 'order.cancelledAt')
  const closedAt = nullableTimestamp(order.closedAt, 'order.closedAt')
  const fulfillmentStatus = text(
    order.displayFulfillmentStatus,
    'order.displayFulfillmentStatus',
    64,
  )
  const fulfillable = boolean(order.fulfillable, 'order.fulfillable')
  if (
    !confirmed
    || cancelledAt !== null
    || closedAt !== null
    || fulfillmentStatus === 'FULFILLED'
    || !fulfillable
  ) {
    fail(
      'Shopify reports that this order is no longer confirmed, open, and unfulfilled',
      409,
      'SHOPIFY_ORDER_PLANNING_ORDER_NOT_OPEN',
    )
  }

  const expectedByLineId = new Map(
    target.lines.map((line) => [line.externalLineId, line]),
  )
  const currentLines = nodes(
    order.lineItems,
    'order.lineItems',
    MAX_SHOPIFY_ORDER_LINES,
  )
    .filter((line) => boolean(line.requiresShipping, 'lineItem.requiresShipping'))
    .filter((line) => integer(
      line.currentQuantity,
      'lineItem.currentQuantity',
    ) > 0 || integer(
      line.unfulfilledQuantity,
      'lineItem.unfulfilledQuantity',
    ) > 0)
    .map((line) => ({
      externalLineId: gid(
        line.id,
        SHOPIFY_LINE_ITEM_GID,
        'lineItem.id',
      ),
      currentQuantity: integer(
        line.currentQuantity,
        'lineItem.currentQuantity',
      ),
      unfulfilledQuantity: integer(
        line.unfulfilledQuantity,
        'lineItem.unfulfilledQuantity',
      ),
    }))
    .sort((left, right) => left.externalLineId.localeCompare(right.externalLineId))
  if (
    currentLines.length !== target.lines.length
    || new Set(currentLines.map((line) => line.externalLineId)).size
      !== currentLines.length
    || currentLines.some((line) => {
      const expected = expectedByLineId.get(line.externalLineId)
      return !expected
        || line.currentQuantity !== expected.quantity
        || line.unfulfilledQuantity !== expected.quantity
    })
  ) {
    fail(
      'Shopify order lines changed after promotion; refresh the order before rating',
      409,
      'SHOPIFY_ORDER_PLANNING_LINES_CHANGED',
    )
  }
  return { order, externalOrderId, fulfillmentStatus }
}

function normalizeProviderOrder(
  value: unknown,
  target: ShopifyOrderPlanningAuthorityTarget,
  shopId: string,
  credentialVersion: number,
): ShopifyOrderPlanningAuthoritySnapshot {
  const {
    order,
    externalOrderId,
    fulfillmentStatus,
  } = assertProviderOrderPlanningHeader(value, target)

  const fulfillmentOrders = nodes(
    order.fulfillmentOrders,
    'order.fulfillmentOrders',
    MAX_SHOPIFY_FULFILLMENT_ORDERS,
  ).map((fulfillmentOrder) => {
    const fulfillmentOrderId = gid(
      fulfillmentOrder.id,
      SHOPIFY_FULFILLMENT_ORDER_GID,
      'fulfillmentOrder.id',
    )
    const status = text(
      fulfillmentOrder.status,
      'fulfillmentOrder.status',
      64,
    )
    const requestStatus = text(
      fulfillmentOrder.requestStatus,
      'fulfillmentOrder.requestStatus',
      64,
    )
    const updatedAt = timestamp(
      fulfillmentOrder.updatedAt,
      'fulfillmentOrder.updatedAt',
    )
    const fulfillmentLines = nodes(
      fulfillmentOrder.lineItems,
      'fulfillmentOrder.lineItems',
      MAX_SHOPIFY_FULFILLMENT_ORDER_LINES,
    ).map((line) => ({
      fulfillmentOrderLineItemId: gid(
        line.id,
        SHOPIFY_FULFILLMENT_ORDER_LINE_ITEM_GID,
        'fulfillmentOrder.lineItem.id',
      ),
      externalLineId: gid(
        record(line.lineItem, 'fulfillmentOrder.lineItem.lineItem').id,
        SHOPIFY_LINE_ITEM_GID,
        'fulfillmentOrder.lineItem.lineItem.id',
      ),
      quantity: integer(
        line.remainingQuantity,
        'fulfillmentOrder.lineItem.remainingQuantity',
      ),
    })).filter((line) => line.quantity > 0)
      .sort((left, right) => (
        left.externalLineId.localeCompare(right.externalLineId)
        || left.fulfillmentOrderLineItemId.localeCompare(
          right.fulfillmentOrderLineItemId,
        )
      ))
    if (fulfillmentLines.length === 0) return null
    if (status !== 'OPEN' || requestStatus !== 'UNSUBMITTED') {
      fail(
        'A Shopify fulfillment order was already actioned; refresh before rating',
        409,
        'SHOPIFY_ORDER_PLANNING_FULFILLMENT_ALREADY_ACTIONED',
      )
    }
    const assignedLocation = record(
      fulfillmentOrder.assignedLocation,
      'fulfillmentOrder.assignedLocation',
    )
    const assignedLocationRecord = record(
      assignedLocation.location,
      'fulfillmentOrder.assignedLocation.location',
    )
    const assignedLocationId = gid(
      assignedLocationRecord.id,
      SHOPIFY_LOCATION_GID,
      'fulfillmentOrder.assignedLocation.location.id',
    )
    const assignedLocationIsFulfillmentService = boolean(
      assignedLocationRecord.isFulfillmentService,
      'fulfillmentOrder.assignedLocation.location.isFulfillmentService',
    )
    if (assignedLocationIsFulfillmentService) {
      const service = assignedLocationRecord.fulfillmentService === null
        ? null
        : record(
            assignedLocationRecord.fulfillmentService,
            'fulfillmentOrder.assignedLocation.location.fulfillmentService',
          )
      const serviceName = service && typeof service.serviceName === 'string'
        ? text(
            service.serviceName,
            'fulfillmentOrder.assignedLocation.location.fulfillmentService.serviceName',
          )
        : 'another fulfillment app'
      fail(
        `Shopify assigned this order to ${serviceName}; ClawPilot cannot plan it as a merchant-managed warehouse order`,
        409,
        'SHOPIFY_ORDER_PLANNING_PROVIDER_MANAGED',
      )
    }
    if (assignedLocationRecord.fulfillmentService !== null) {
      fail(
        'Shopify returned inconsistent fulfillment-location ownership',
        502,
        'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
        true,
      )
    }
    if (assignedLocationId !== target.warehouse.shopifyLocationId) {
      const assignedLocationName = typeof assignedLocationRecord.name === 'string'
        ? text(
            assignedLocationRecord.name,
            'fulfillmentOrder.assignedLocation.location.name',
          )
        : 'a different Shopify location'
      fail(
        `Shopify assigned the order to ${assignedLocationName}, not the selected ClawPilot warehouse`,
        409,
        'SHOPIFY_ORDER_PLANNING_LOCATION_MISMATCH',
      )
    }
    return {
      fulfillmentOrderId,
      status: 'OPEN' as const,
      requestStatus: 'UNSUBMITTED' as const,
      updatedAt,
      assignedLocationId,
      lines: fulfillmentLines,
    }
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => (
      left.fulfillmentOrderId.localeCompare(right.fulfillmentOrderId)
    ))
  if (fulfillmentOrders.length < 1) {
    fail(
      'Shopify has no open fulfillment order for the selected warehouse',
      409,
      'SHOPIFY_ORDER_PLANNING_FULFILLMENT_NOT_OPEN',
    )
  }
  const fulfillmentQuantityByLine = new Map<string, number>()
  for (const fulfillmentOrder of fulfillmentOrders) {
    for (const line of fulfillmentOrder.lines) {
      const next = (fulfillmentQuantityByLine.get(line.externalLineId) || 0)
        + line.quantity
      if (!Number.isSafeInteger(next)) {
        fail(
          'Shopify returned unsupported fulfillment-order quantities',
          502,
          'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
          true,
        )
      }
      fulfillmentQuantityByLine.set(line.externalLineId, next)
    }
  }
  if (
    fulfillmentQuantityByLine.size !== target.lines.length
    || target.lines.some((line) => (
      fulfillmentQuantityByLine.get(line.externalLineId) !== line.quantity
    ))
  ) {
    fail(
      'Shopify fulfillment-order lines no longer match the promoted order',
      409,
      'SHOPIFY_ORDER_PLANNING_FULFILLMENT_LINES_CHANGED',
    )
  }

  return {
    version: 'shopify-order-planning-authority-v1',
    shopId,
    credentialVersion,
    accountGlobalId: target.accountGlobalId,
    candidate: target.candidate,
    warehouse: target.warehouse,
    order: {
      externalOrderId,
      name: text(order.name, 'order.name', 255),
      updatedAt: timestamp(order.updatedAt, 'order.updatedAt'),
      confirmed: true,
      cancelledAt: null,
      closedAt: null,
      fulfillmentStatus,
      fulfillable: true,
    },
    lines: [...target.lines].sort((left, right) => (
      left.externalLineId.localeCompare(right.externalLineId)
      || left.candidateLineGlobalId.localeCompare(right.candidateLineGlobalId)
    )),
    fulfillmentOrders,
  }
}

export async function readShopifyOrderPlanningAuthority(
  credential: ShopifyCommerceRuntimeCredential,
  target: ShopifyOrderPlanningAuthorityTarget,
  context: { shopId: string; credentialVersion: number },
): Promise<ShopifyOrderPlanningAuthorityProviderRead> {
  try {
    const data = await shopifyAdminGraphql<{ order?: unknown }>(
      credential,
      {
        query: SHOPIFY_ORDER_PLANNING_QUERY,
        operationName: 'ClawPilotShopifyOrderPlanningAuthority',
        variables: { id: target.externalOrderId },
      },
      { timeoutMs: 12_000 },
    )
    const snapshot = normalizeProviderOrder(
      data.order,
      target,
      context.shopId,
      context.credentialVersion,
    )
    return { snapshot, providerReads: 1 }
  } catch (error) {
    if (error instanceof ShopifyOrderPlanningAuthorityError) throw error
    if (error instanceof ShopifyCommerceClientError) {
      throw new ShopifyOrderPlanningAuthorityError(
        'Shopify order planning authority is temporarily unavailable',
        error.status >= 500 ? error.status : 502,
        'SHOPIFY_ORDER_PLANNING_PROVIDER_READ_FAILED',
        error.retryable,
      )
    }
    throw error
  }
}

type ProviderPlanningAssignment = {
  shopifyLocationId: string
  shopifyLocationName: string
  ownerType: 'merchant_managed' | 'fulfillment_service'
  fulfillmentService: null | {
    id: string
    serviceName: string
    type: string | null
  }
  fulfillmentOrderIds: string[]
  actionable: boolean
}

export async function readShopifyOrderPlanningAssignment(
  credential: ShopifyCommerceRuntimeCredential,
  target: ShopifyOrderPlanningAssignmentTarget,
): Promise<{
  assignments: ProviderPlanningAssignment[]
  providerReads: 1
}> {
  try {
    const data = await shopifyAdminGraphql<{ order?: unknown }>(
      credential,
      {
        query: SHOPIFY_ORDER_PLANNING_ASSIGNMENT_QUERY,
        operationName: 'ClawPilotShopifyOrderPlanningAssignment',
        variables: { id: target.externalOrderId },
      },
      { timeoutMs: 12_000 },
    )
    const order = record(data.order, 'order planning assignment')
    const orderId = gid(order.id, SHOPIFY_ORDER_GID, 'order.id')
    if (orderId !== target.externalOrderId) {
      fail(
        'Shopify returned a different order identity',
        409,
        'SHOPIFY_ORDER_PLANNING_ORDER_CHANGED',
      )
    }
    const grouped = new Map<string, ProviderPlanningAssignment>()
    for (const fulfillmentOrder of nodes(
      order.fulfillmentOrders,
      'order.fulfillmentOrders',
      MAX_SHOPIFY_FULFILLMENT_ORDERS,
    )) {
      const fulfillmentOrderId = gid(
        fulfillmentOrder.id,
        SHOPIFY_FULFILLMENT_ORDER_GID,
        'fulfillmentOrder.id',
      )
      const remainingQuantity = nodes(
        fulfillmentOrder.lineItems,
        'fulfillmentOrder.lineItems',
        MAX_SHOPIFY_FULFILLMENT_ORDER_LINES,
      ).reduce((sum, line, index) => {
        const next = sum + integer(
          line.remainingQuantity,
          `fulfillmentOrder.lineItems[${index}].remainingQuantity`,
        )
        if (!Number.isSafeInteger(next)) {
          fail(
            'Shopify returned unsupported fulfillment-order quantities',
            502,
            'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
            true,
          )
        }
        return next
      }, 0)
      if (remainingQuantity === 0) continue
      const assignedLocation = record(
        fulfillmentOrder.assignedLocation,
        'fulfillmentOrder.assignedLocation',
      )
      const location = record(
        assignedLocation.location,
        'fulfillmentOrder.assignedLocation.location',
      )
      const shopifyLocationId = gid(
        location.id,
        SHOPIFY_LOCATION_GID,
        'fulfillmentOrder.assignedLocation.location.id',
      )
      const shopifyLocationName = text(
        location.name,
        'fulfillmentOrder.assignedLocation.location.name',
      )
      const isFulfillmentService = boolean(
        location.isFulfillmentService,
        'fulfillmentOrder.assignedLocation.location.isFulfillmentService',
      )
      let fulfillmentService: ProviderPlanningAssignment[
        'fulfillmentService'
      ] = null
      if (isFulfillmentService) {
        const service = record(
          location.fulfillmentService,
          'fulfillmentOrder.assignedLocation.location.fulfillmentService',
        )
        fulfillmentService = {
          id: gid(
            service.id,
            SHOPIFY_FULFILLMENT_SERVICE_GID,
            'fulfillmentService.id',
          ),
          serviceName: text(
            service.serviceName,
            'fulfillmentService.serviceName',
          ),
          type: service.type === null || service.type === undefined
            ? null
            : text(service.type, 'fulfillmentService.type', 64),
        }
      } else if (location.fulfillmentService !== null) {
        fail(
          'Shopify returned inconsistent fulfillment-service location evidence',
          502,
          'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
          true,
        )
      }
      const actionable = (
        text(fulfillmentOrder.status, 'fulfillmentOrder.status', 64)
          === 'OPEN'
        && text(
          fulfillmentOrder.requestStatus,
          'fulfillmentOrder.requestStatus',
          64,
        ) === 'UNSUBMITTED'
      )
      const existing = grouped.get(shopifyLocationId)
      const ownerType = isFulfillmentService
        ? 'fulfillment_service' as const
        : 'merchant_managed' as const
      if (existing) {
        if (
          existing.shopifyLocationName !== shopifyLocationName
          || existing.ownerType !== ownerType
          || existing.fulfillmentService?.id !== fulfillmentService?.id
        ) {
          fail(
            'Shopify returned inconsistent assigned-location evidence',
            502,
            'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
            true,
          )
        }
        existing.fulfillmentOrderIds.push(fulfillmentOrderId)
        existing.actionable = existing.actionable && actionable
      } else {
        grouped.set(shopifyLocationId, {
          shopifyLocationId,
          shopifyLocationName,
          ownerType,
          fulfillmentService,
          fulfillmentOrderIds: [fulfillmentOrderId],
          actionable,
        })
      }
    }
    return {
      assignments: [...grouped.values()].map((assignment) => ({
        ...assignment,
        fulfillmentOrderIds: [...assignment.fulfillmentOrderIds].sort(),
      })).sort((left, right) => (
        left.shopifyLocationId.localeCompare(right.shopifyLocationId)
      )),
      providerReads: 1,
    }
  } catch (error) {
    if (error instanceof ShopifyOrderPlanningAuthorityError) throw error
    if (error instanceof ShopifyCommerceClientError) {
      throw new ShopifyOrderPlanningAuthorityError(
        'Shopify order location assignment is temporarily unavailable',
        error.status >= 500 ? error.status : 502,
        'SHOPIFY_ORDER_PLANNING_PROVIDER_READ_FAILED',
        error.retryable,
      )
    }
    throw error
  }
}

const ASSIGNMENT_REQUIRED_SCOPES = [
  'read_orders',
  'read_locations',
  'read_merchant_managed_fulfillment_orders',
  'read_third_party_fulfillment_orders',
  'read_assigned_fulfillment_orders',
] as const

export async function inspectShopifyOrderPlanningAssignment(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
    candidateGlobalId: unknown
    expectedCandidateRowVersion: unknown
  },
  dependencies: AssignmentDependencies = DEFAULT_ASSIGNMENT_DEPENDENCIES,
): Promise<ShopifyOrderPlanningAssignment> {
  let target: ShopifyOrderPlanningAssignmentTarget
  try {
    target = await dependencies.readTarget(input)
  } catch (error) {
    if (error instanceof ShopifyOrderPlanningAuthorityPersistenceError) {
      throw new ShopifyOrderPlanningAuthorityError(
        error.message,
        error.status,
        error.code,
      )
    }
    throw error
  }
  const runtime = await dependencies.readRuntimeCredential({
    organizationId: target.organizationId,
    accountGlobalId: target.accountGlobalId,
  })
  if (
    !runtime
    || runtime.provider !== 'shopify'
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
  ) {
    fail(
      'A verified active Shopify connection is required to inspect order location assignment',
      409,
      'SHOPIFY_ORDER_PLANNING_CONNECTION_INVALID',
    )
  }
  const decrypted = dependencies.decryptCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (decrypted.provider !== 'shopify') {
    fail(
      'Stored Shopify credentials could not be decrypted',
      500,
      'SHOPIFY_ORDER_PLANNING_CREDENTIAL_INVALID',
    )
  }
  const shopDomain = normalizeShopifyShopDomain(
    runtime.configuration.shopDomain,
  )
  const grant = await dependencies.requestAccessToken({
    shopDomain,
    clientId: decrypted.clientId,
    clientSecret: decrypted.clientSecret,
  })
  const probe = await dependencies.probeConnection({
    shopDomain,
    accessToken: grant.accessToken,
  })
  if (probe.shopId !== runtime.externalAccountId) {
    fail(
      'Shopify returned a different store identity',
      409,
      'SHOPIFY_ORDER_PLANNING_STORE_CHANGED',
    )
  }
  const missingScopes = ASSIGNMENT_REQUIRED_SCOPES.filter((scope) => (
    !hasEffectiveShopifyScope(grant.grantedScopes, scope)
    || !hasEffectiveShopifyScope(probe.grantedScopes, scope)
  ))
  if (missingScopes.length > 0) {
    fail(
      `Shopify must grant ${missingScopes.join(', ')} to inspect every fulfillment location`,
      409,
      'SHOPIFY_ORDER_PLANNING_SCOPE_REQUIRED',
    )
  }
  const providerRead = await dependencies.readAssignment(
    { shopDomain, accessToken: grant.accessToken },
    target,
  )
  const mappings = new Map(target.mappings.map((mapping) => [
    mapping.externalLocationId,
    mapping,
  ]))
  const assignments = providerRead.assignments.map((assignment) => {
    const mapping = mappings.get(assignment.shopifyLocationId)
    return {
      shopifyLocationId: assignment.shopifyLocationId,
      shopifyLocationName: assignment.shopifyLocationName,
      ownerType: assignment.ownerType,
      fulfillmentService: assignment.fulfillmentService,
      fulfillmentOrderIds: assignment.fulfillmentOrderIds,
      mapping: mapping ? {
        globalId: mapping.globalId,
        rowVersion: mapping.rowVersion,
        warehouseGlobalId: mapping.warehouseGlobalId,
        warehouseName: mapping.warehouseName,
        locationGlobalId: mapping.locationGlobalId,
        locationCode: mapping.locationCode,
      } : null,
    }
  })
  const actionable = providerRead.assignments.every(
    (assignment) => assignment.actionable,
  )
  const single = assignments.length === 1 ? assignments[0] : null
  const status: ShopifyOrderPlanningAssignment['status'] =
    !actionable || assignments.length === 0
      ? 'not_open'
      : assignments.length > 1
        ? 'split'
        : single?.ownerType === 'fulfillment_service'
          ? 'provider_managed'
          : !single?.mapping
            ? 'unmapped'
            : 'ready'
  return {
    version: 'shopify-order-planning-assignment-v1',
    status,
    accountGlobalId: target.accountGlobalId,
    candidateGlobalId: target.candidateGlobalId,
    candidateRowVersion: target.candidateRowVersion,
    assignments,
    selectedWarehouse: status === 'ready' && single?.mapping ? {
      globalId: single.mapping.warehouseGlobalId,
      name: single.mapping.warehouseName,
      mappingGlobalId: single.mapping.globalId,
      mappingRowVersion: single.mapping.rowVersion,
      shopifyLocationId: single.shopifyLocationId,
      shopifyLocationName: single.shopifyLocationName,
    } : null,
    providerReads: providerRead.providerReads,
    providerWrites: 0,
  }
}

export async function inspectShopifyOrderPlanningAuthority(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
    candidateGlobalId: unknown
    expectedCandidateRowVersion: unknown
    warehouseGlobalId: unknown
  },
  dependencies: Dependencies = DEFAULT_DEPENDENCIES,
): Promise<ShopifyOrderPlanningAuthorityEvidence> {
  let target: ShopifyOrderPlanningAuthorityTarget
  try {
    target = await dependencies.readTarget(input)
  } catch (error) {
    if (error instanceof ShopifyOrderPlanningAuthorityPersistenceError) {
      throw new ShopifyOrderPlanningAuthorityError(
        error.message,
        error.status,
        error.code,
      )
    }
    throw error
  }
  const runtime = await dependencies.readRuntimeCredential({
    organizationId: target.organizationId,
    accountGlobalId: target.accountGlobalId,
  })
  if (
    !runtime
    || runtime.provider !== 'shopify'
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
  ) {
    fail(
      'A verified active Shopify connection is required for operational rating',
      409,
      'SHOPIFY_ORDER_PLANNING_CONNECTION_INVALID',
    )
  }
  const decrypted = dependencies.decryptCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (decrypted.provider !== 'shopify') {
    fail(
      'Stored Shopify credentials could not be decrypted',
      500,
      'SHOPIFY_ORDER_PLANNING_CREDENTIAL_INVALID',
    )
  }
  const shopDomain = normalizeShopifyShopDomain(
    runtime.configuration.shopDomain,
  )
  const grant = await dependencies.requestAccessToken({
    shopDomain,
    clientId: decrypted.clientId,
    clientSecret: decrypted.clientSecret,
  })
  const probe = await dependencies.probeConnection({
    shopDomain,
    accessToken: grant.accessToken,
  })
  if (probe.shopId !== runtime.externalAccountId) {
    fail(
      'Shopify returned a different store identity',
      409,
      'SHOPIFY_ORDER_PLANNING_STORE_CHANGED',
    )
  }
  const missingScopes = REQUIRED_SCOPES.filter((scope) => (
    !hasEffectiveShopifyScope(grant.grantedScopes, scope)
    || !hasEffectiveShopifyScope(probe.grantedScopes, scope)
  ))
  if (missingScopes.length > 0) {
    fail(
      `Shopify must grant ${missingScopes.join(' and ')} for operational rating`,
      409,
      'SHOPIFY_ORDER_PLANNING_SCOPE_REQUIRED',
    )
  }
  const providerRead = await dependencies.readOrder(
    { shopDomain, accessToken: grant.accessToken },
    target,
    {
      shopId: probe.shopId,
      credentialVersion: runtime.credentialVersion,
    },
  )
  return {
    authorityHash: shopifyOrderPlanningAuthorityHash(
      providerRead.snapshot,
    ),
    snapshot: providerRead.snapshot,
    providerReads: providerRead.providerReads,
    providerWrites: 0,
  }
}
