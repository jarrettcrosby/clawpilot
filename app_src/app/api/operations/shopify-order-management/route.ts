import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  executeShopifyOrderManagementCommand,
  prepareShopifyOrderManagementCommand,
  readShopifyOrderManagementState,
  reconcileShopifyOrderManagementCommand,
  saveShopifyOrderManagementCommand,
  ShopifyOrderManagementCommandError,
} from '@/lib/operations/shopifyOrderManagementCommands'
import { ShopifyOrderManagementError } from '@/lib/integrations/shopifyOrderManagement'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { ShopifyOrderManagementPersistenceError } from '@/lib/persistence/shopifyOrderManagement'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 128 * 1024
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u
const AUTHORIZATION_GLOBAL_ID = /^gsom(?:[0-9]{7}|[0-9a-v]{12})$/u
const ATTEMPT_GLOBAL_ID = /^gsoa(?:[0-9]{7}|[0-9a-v]{12})$/u
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,20}$/u
const LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]{0,20}$/u
const FULFILLMENT_GID =
  /^gid:\/\/shopify\/Fulfillment\/[1-9][0-9]{0,20}$/u
const SHOPIFY_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u
const SHA256 = /^[a-f0-9]{64}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const COUNTRY_CODE = /^[A-Z]{2}$/u

class ShopifyOrderManagementApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ShopifyOrderManagementApiError'
  }
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new ShopifyOrderManagementApiError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_POSTGRES_REQUIRED',
      'Shopify order management requires Postgres storage',
      503,
    )
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
      'A valid Shopify order management request is required',
    )
  }
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]) {
  const accepted = new Set(allowed)
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
      'Shopify order management request includes an unsupported field',
    )
  }
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 1,
) {
  if (typeof value !== 'string') {
    fail('SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID', `${label} is invalid`)
  }
  const normalized = value.trim()
  if (
    normalized !== value
    || normalized.length < minimum
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail('SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID', `${label} is invalid`)
  }
  return normalized
}

function exactId(value: unknown, label: string, pattern: RegExp) {
  const normalized = boundedText(value, label, 64)
  if (!pattern.test(normalized)) {
    fail('SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID', `${label} is invalid`)
  }
  return normalized
}

function rowVersion(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
      'Expected order version is invalid',
    )
  }
  return Number(value)
}

function reason(value: unknown) {
  return boundedText(value, 'Authorization reason', 500, 10)
}

function isoInstant(value: unknown, label: string) {
  const normalized = boundedText(value, label, 64)
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== normalized) {
    fail('SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID', `${label} is invalid`)
  }
  return normalized
}

function nullableField(
  value: unknown,
  label: string,
  maximum: number,
  options: { allowNewlines?: boolean; allowEmpty?: boolean } = {},
) {
  if (value === null) return null
  if (typeof value !== 'string' || value !== value.trim()) {
    fail('SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID', `${label} is invalid`)
  }
  if (
    value.length > maximum
    || (!options.allowEmpty && value.length < 1)
    || (options.allowNewlines
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
      : /[\u0000-\u001f\u007f]/u.test(value))
  ) {
    fail('SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID', `${label} is invalid`)
  }
  return value
}

function tagList(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 250) {
    fail('SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID', `${label} are invalid`)
  }
  const tags = value.map((tag) => {
    const normalized = nullableField(tag, label, 255)
    if (!normalized || normalized.includes(',')) {
      fail('SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID', `${label} are invalid`)
    }
    return normalized
  })
  if (new Set(tags).size !== tags.length) {
    fail('SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID', `${label} contain duplicates`)
  }
  return tags
}

function shippingAddress(value: unknown) {
  if (value === null) return null
  const input = record(value)
  exactFields(input, [
    'firstName', 'lastName', 'company', 'address1', 'address2', 'city',
    'provinceCode', 'countryCode', 'zip', 'phone',
  ])
  const countryCode = nullableField(
    input.countryCode,
    'Shopify shipping-address country code',
    2,
  )
  if (countryCode !== null && !COUNTRY_CODE.test(countryCode)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
      'Shopify shipping-address country code is invalid',
    )
  }
  return Object.freeze({
    firstName: nullableField(
      input.firstName,
      'Shopify shipping-address first name',
      255,
    ),
    lastName: nullableField(
      input.lastName,
      'Shopify shipping-address last name',
      255,
    ),
    company: nullableField(
      input.company,
      'Shopify shipping-address company',
      255,
    ),
    address1: nullableField(
      input.address1,
      'Shopify shipping-address line 1',
      255,
    ),
    address2: nullableField(
      input.address2,
      'Shopify shipping-address line 2',
      255,
    ),
    city: nullableField(
      input.city,
      'Shopify shipping-address city',
      255,
    ),
    provinceCode: nullableField(
      input.provinceCode,
      'Shopify shipping-address province or state code',
      64,
    ),
    countryCode,
    zip: nullableField(
      input.zip,
      'Shopify shipping-address postal code',
      64,
    ),
    phone: nullableField(
      input.phone,
      'Shopify shipping-address phone',
      64,
    ),
  })
}

function mutation(value: unknown) {
  const input = record(value)
  const kind = boundedText(input.kind, 'Shopify mutation', 40)
  if (kind === 'add_tag') {
    exactFields(input, ['kind', 'tag'])
    const tag = boundedText(input.tag, 'Shopify order tag', 255)
    if (tag.includes(',')) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
        'Enter one exact Shopify order tag without commas',
      )
    }
    return Object.freeze({ kind, tag })
  }
  if (kind === 'cancel_fulfillment') {
    exactFields(input, [
      'kind', 'fulfillmentId', 'expectedFulfillmentUpdatedAt',
    ])
    return Object.freeze({
      kind,
      fulfillmentId: exactId(
        input.fulfillmentId,
        'Shopify fulfillment',
        FULFILLMENT_GID,
      ),
      expectedFulfillmentUpdatedAt: isoInstant(
        input.expectedFulfillmentUpdatedAt,
        'Shopify fulfillment update time',
      ),
    })
  }
  if (kind === 'cancel_order_after_fulfillment_reversal') {
    exactFields(input, ['kind', 'predecessorAuthorizationGlobalId'])
    return Object.freeze({
      kind,
      predecessorAuthorizationGlobalId: exactId(
        input.predecessorAuthorizationGlobalId,
        'Shopify fulfillment-reversal authorization',
        AUTHORIZATION_GLOBAL_ID,
      ),
    })
  }
  if (kind === 'cancel') {
    exactFields(input, ['kind'])
    return Object.freeze({ kind })
  }
  if (kind === 'set_line_quantity') {
    exactFields(input, ['kind', 'lineItemId', 'quantity'])
    const lineItemId = exactId(
      input.lineItemId,
      'Shopify order line',
      LINE_ITEM_GID,
    )
    if (!Number.isSafeInteger(input.quantity) || Number(input.quantity) < 0) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
        'Shopify order line quantity is invalid',
      )
    }
    return Object.freeze({
      kind,
      lineItemId,
      quantity: Number(input.quantity),
    })
  }
  if (kind === 'save_order') {
    exactFields(input, [
      'kind', 'email', 'phone', 'poNumber', 'note',
      'shippingAddress', 'tagAdds', 'tagRemoves', 'lineQuantities',
    ])
    const tagAdds = tagList(input.tagAdds, 'Shopify tags to add')
    const tagRemoves = tagList(input.tagRemoves, 'Shopify tags to remove')
    if (tagAdds.some((tag) => tagRemoves.includes(tag))) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
        'Shopify tag changes are contradictory',
      )
    }
    if (!Array.isArray(input.lineQuantities) || input.lineQuantities.length > 250) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
        'Shopify order line changes are invalid',
      )
    }
    const lineQuantities = input.lineQuantities.map((value) => {
      const line = record(value)
      exactFields(line, ['lineItemId', 'quantity'])
      if (!Number.isSafeInteger(line.quantity) || Number(line.quantity) < 0) {
        fail(
          'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
          'Shopify order line quantity is invalid',
        )
      }
      return Object.freeze({
        lineItemId: exactId(
          line.lineItemId,
          'Shopify order line',
          LINE_ITEM_GID,
        ),
        quantity: Number(line.quantity),
      })
    })
    if (new Set(lineQuantities.map((line) => line.lineItemId)).size
      !== lineQuantities.length) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
        'Shopify order line changes contain duplicates',
      )
    }
    return Object.freeze({
      kind,
      email: nullableField(input.email, 'Shopify order email', 254),
      phone: nullableField(input.phone, 'Shopify order phone', 64),
      poNumber: nullableField(input.poNumber, 'Shopify order PO number', 255),
      note: nullableField(input.note, 'Shopify order note', 5_000, {
        allowNewlines: true,
        allowEmpty: true,
      }),
      shippingAddress: shippingAddress(input.shippingAddress),
      tagAdds,
      tagRemoves,
      lineQuantities,
    })
  }
  fail(
    'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
    'Supported Shopify actions are save order, add tag, reverse fulfillment, cancel after reversal, cancel, and decrease quantity',
  )
}

function idempotencyKey(req: NextRequest) {
  const value = req.headers.get('idempotency-key')
  if (value === null || value !== value.trim() || !IDEMPOTENCY_KEY.test(value)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return value
}

function resultInvalid(): never {
  fail(
    'SHOPIFY_ORDER_MANAGEMENT_RESULT_INVALID',
    'Shopify order management returned an invalid result',
    500,
  )
}

function resultRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) resultInvalid()
  return value as Record<string, unknown>
}

function resultText(value: unknown, maximum = 512) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) resultInvalid()
  return value
}

function resultNullableText(value: unknown, maximum = 512) {
  if (value === null) return null
  return resultText(value, maximum)
}

function resultTrackingUrl(value: unknown) {
  const candidate = resultNullableText(value, 2_048)
  if (candidate === null) return null
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    resultInvalid()
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    resultInvalid()
  }
  return candidate
}

function resultIsoInstant(value: unknown) {
  const candidate = resultText(value, 64)
  const parsed = new Date(candidate)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== candidate) {
    resultInvalid()
  }
  return candidate
}

function resultNullableIsoInstant(value: unknown) {
  if (value === null) return null
  return resultIsoInstant(value)
}

function resultNullableField(
  value: unknown,
  maximum: number,
  options: { allowEmpty?: boolean; allowNewlines?: boolean } = {},
) {
  if (value === null) return null
  if (
    typeof value !== 'string'
    || value.length > maximum
    || (!options.allowEmpty && value.length < 1)
    || (options.allowNewlines
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
      : /[\u0000-\u001f\u007f]/u.test(value))
  ) resultInvalid()
  return value
}

function resultInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    resultInvalid()
  }
  return Number(value)
}

function resultShippingAddress(value: unknown) {
  if (value === null) return null
  const address = resultRecord(value)
  const countryCode = resultNullableField(address.countryCode, 2)
  if (countryCode !== null && !COUNTRY_CODE.test(countryCode)) resultInvalid()
  return Object.freeze({
    firstName: resultNullableField(address.firstName, 255),
    lastName: resultNullableField(address.lastName, 255),
    company: resultNullableField(address.company, 255),
    address1: resultNullableField(address.address1, 255),
    address2: resultNullableField(address.address2, 255),
    city: resultNullableField(address.city, 255),
    provinceCode: resultNullableField(address.provinceCode, 64),
    countryCode,
    zip: resultNullableField(address.zip, 64),
    phone: resultNullableField(address.phone, 64),
  })
}

function resultId(value: unknown, pattern: RegExp) {
  const candidate = resultText(value, 128)
  if (!pattern.test(candidate)) resultInvalid()
  return candidate
}

function publicOpenAttempt(value: unknown) {
  if (value === undefined || value === null) return null
  const source = resultRecord(value)
  const state = resultText(source.state, 32)
  const actionKind = resultText(source.actionKind, 40)
  if (!['processing', 'unknown'].includes(state)) resultInvalid()
  if (![
    'add_tag', 'cancel_fulfillment',
    'cancel_order_after_fulfillment_reversal', 'cancel',
    'set_line_quantity', 'save_order',
  ].includes(actionKind)) {
    resultInvalid()
  }
  const intentHash = resultText(source.intentHash, 64)
  if (!SHA256.test(intentHash)) resultInvalid()
  const providerWrites = source.providerWrites === null
    ? null : resultInteger(source.providerWrites, 253)
  return Object.freeze({
    attemptGlobalId: resultId(source.attemptGlobalId, ATTEMPT_GLOBAL_ID),
    authorizationGlobalId: resultId(
      source.authorizationGlobalId,
      AUTHORIZATION_GLOBAL_ID,
    ),
    intentHash,
    state,
    actionKind,
    providerReference: resultNullableText(source.providerReference),
    errorCode: resultNullableText(source.errorCode, 128),
    createdAt: resultText(source.createdAt, 64),
    updatedAt: resultText(source.updatedAt, 64),
    providerWrites,
  })
}

function publicManagement(value: unknown) {
  const source = resultRecord(value)
  const order = resultRecord(source.order)
  const eligibility = resultRecord(source.eligibility)
  const addTag = resultRecord(eligibility.addTag)
  const ordinarySave = resultRecord(eligibility.ordinarySave)
  const cancel = resultRecord(eligibility.cancel)
  const cancelAfterFulfillmentReversal = resultRecord(
    eligibility.cancelAfterFulfillmentReversal,
  )
  if (
    typeof source.runtimeAvailable !== 'boolean'
    || typeof order.test !== 'boolean'
    || typeof order.closed !== 'boolean'
    || typeof order.merchantEditable !== 'boolean'
    || typeof addTag.allowed !== 'boolean'
    || typeof ordinarySave.allowed !== 'boolean'
    || typeof cancel.allowed !== 'boolean'
    || typeof cancelAfterFulfillmentReversal.allowed !== 'boolean'
    || !Array.isArray(order.tags)
    || order.tags.length > 250
    || !Array.isArray(order.lines)
    || order.lines.length > 250
    || !Array.isArray(order.fulfillments)
    || order.fulfillments.length > 50
    || !Array.isArray(eligibility.fulfillments)
    || eligibility.fulfillments.length > 50
    || !Array.isArray(eligibility.lineEdits)
    || eligibility.lineEdits.length > 250
  ) resultInvalid()
  const shopDomain = resultText(source.shopDomain, 255)
  if (!SHOPIFY_DOMAIN.test(shopDomain)) resultInvalid()
  const tags = order.tags.map((tag) => resultText(tag, 255))
  const lines = order.lines.map((value) => {
    const line = resultRecord(value)
    return Object.freeze({
      lineItemId: resultId(line.lineItemId, LINE_ITEM_GID),
      title: resultText(line.title, 512),
      quantity: resultInteger(line.quantity, 2_147_483_647),
      unfulfilledQuantity: resultInteger(
        line.unfulfilledQuantity,
        2_147_483_647,
      ),
      fulfilledQuantity: resultInteger(
        line.fulfilledQuantity,
        2_147_483_647,
      ),
    })
  })
  const fulfillments = order.fulfillments.map((value) => {
    const fulfillment = resultRecord(value)
    if (
      !Array.isArray(fulfillment.tracking)
      || fulfillment.tracking.length > 10
    ) resultInvalid()
    return Object.freeze({
      fulfillmentId: resultId(fulfillment.fulfillmentId, FULFILLMENT_GID),
      name: resultText(fulfillment.name, 255),
      status: resultText(fulfillment.status, 64),
      displayStatus: resultNullableText(fulfillment.displayStatus, 64),
      updatedAt: resultIsoInstant(fulfillment.updatedAt),
      deliveredAt: resultNullableIsoInstant(fulfillment.deliveredAt),
      quantity: resultInteger(fulfillment.quantity, 2_147_483_647),
      tracking: Object.freeze(fulfillment.tracking.map((value) => {
        const tracking = resultRecord(value)
        return Object.freeze({
          company: resultNullableText(tracking.company, 255),
          number: resultNullableText(tracking.number, 255),
          url: resultTrackingUrl(tracking.url),
        })
      })),
    })
  })
  const fulfillmentEligibility = eligibility.fulfillments.map((value) => {
    const fulfillment = resultRecord(value)
    if (typeof fulfillment.allowed !== 'boolean') resultInvalid()
    return Object.freeze({
      fulfillmentId: resultId(fulfillment.fulfillmentId, FULFILLMENT_GID),
      expectedUpdatedAt: resultIsoInstant(fulfillment.expectedUpdatedAt),
      allowed: fulfillment.allowed,
      reason: resultNullableText(fulfillment.reason, 512),
    })
  })
  if (
    fulfillments.length !== fulfillmentEligibility.length
    || new Set(fulfillments.map((fulfillment) => fulfillment.fulfillmentId)).size
      !== fulfillments.length
    || new Set(fulfillmentEligibility.map((fulfillment) => (
      fulfillment.fulfillmentId
    ))).size !== fulfillmentEligibility.length
    || fulfillments.some((fulfillment) => !fulfillmentEligibility.some(
      (eligibility) => (
        eligibility.fulfillmentId === fulfillment.fulfillmentId
        && eligibility.expectedUpdatedAt === fulfillment.updatedAt
      ),
    ))
  ) resultInvalid()
  const lineEdits = eligibility.lineEdits.map((value) => {
    const line = resultRecord(value)
    if (typeof line.allowed !== 'boolean') resultInvalid()
    return Object.freeze({
      lineItemId: resultId(line.lineItemId, LINE_ITEM_GID),
      allowed: line.allowed,
      reason: resultNullableText(line.reason, 512),
      minQuantity: resultInteger(line.minQuantity, 2_147_483_647),
      maxQuantity: resultInteger(line.maxQuantity, 2_147_483_647),
    })
  })
  const postReversalPredecessor = cancelAfterFulfillmentReversal
    .predecessorAuthorizationGlobalId === null
    ? null
    : resultId(
        cancelAfterFulfillmentReversal.predecessorAuthorizationGlobalId,
        AUTHORIZATION_GLOBAL_ID,
      )
  if (cancelAfterFulfillmentReversal.allowed && !postReversalPredecessor) {
    resultInvalid()
  }
  return Object.freeze({
    runtimeAvailable: source.runtimeAvailable,
    blockerCode: resultNullableText(source.blockerCode, 512),
    accountLabel: resultText(source.accountLabel, 255),
    shopDomain,
    order: Object.freeze({
      globalId: resultId(order.globalId, ORDER_GLOBAL_ID),
      externalOrderId: resultId(order.externalOrderId, SHOPIFY_ORDER_GID),
      name: resultText(order.name, 255),
      rowVersion: resultInteger(order.rowVersion, 2_147_483_647),
      test: order.test,
      closed: order.closed,
      cancelledAt: resultNullableText(order.cancelledAt, 64),
      financialStatus: resultNullableText(order.financialStatus, 64),
      fulfillmentStatus: resultNullableText(order.fulfillmentStatus, 64),
      merchantEditable: order.merchantEditable,
      email: resultNullableText(order.email, 254),
      phone: resultNullableText(order.phone, 64),
      poNumber: resultNullableText(order.poNumber, 255),
      note: resultNullableField(order.note, 5_000, {
        allowEmpty: true,
        allowNewlines: true,
      }),
      shippingAddress: resultShippingAddress(order.shippingAddress),
      tags: Object.freeze(tags),
      lines: Object.freeze(lines),
      fulfillments: Object.freeze(fulfillments),
    }),
    eligibility: Object.freeze({
      addTag: Object.freeze({
        allowed: addTag.allowed,
        reason: resultNullableText(addTag.reason, 512),
      }),
      ordinarySave: Object.freeze({
        allowed: ordinarySave.allowed,
        reason: resultNullableText(ordinarySave.reason, 512),
      }),
      cancel: Object.freeze({
        allowed: cancel.allowed,
        reason: resultNullableText(cancel.reason, 512),
      }),
      cancelAfterFulfillmentReversal: Object.freeze({
        allowed: cancelAfterFulfillmentReversal.allowed,
        reason: resultNullableText(
          cancelAfterFulfillmentReversal.reason,
          512,
        ),
        predecessorAuthorizationGlobalId: postReversalPredecessor,
      }),
      fulfillments: Object.freeze(fulfillmentEligibility),
      lineEdits: Object.freeze(lineEdits),
    }),
    openAttempt: publicOpenAttempt(source.openAttempt),
  })
}

function publicAuthorization(value: unknown) {
  const source = resultRecord(value)
  const intentHash = resultText(source.intentHash, 64)
  if (
    !SHA256.test(intentHash)
    || typeof source.replayed !== 'boolean'
    || source.providerWrites !== 0
  ) resultInvalid()
  const preview = resultRecord(source.preview)
  const action = resultText(preview.action, 40)
  if (![
    'add_tag', 'cancel_fulfillment',
    'cancel_order_after_fulfillment_reversal', 'cancel',
    'set_line_quantity', 'save_order',
  ].includes(action)) {
    resultInvalid()
  }
  const predecessorAuthorizationGlobalId =
    preview.predecessorAuthorizationGlobalId === null
      ? null
      : resultId(
          preview.predecessorAuthorizationGlobalId,
          AUTHORIZATION_GLOBAL_ID,
        )
  if (
    action === 'cancel_order_after_fulfillment_reversal'
      ? predecessorAuthorizationGlobalId === null
      : predecessorAuthorizationGlobalId !== null
  ) resultInvalid()
  return Object.freeze({
    authorizationGlobalId: resultId(
      source.authorizationGlobalId,
      AUTHORIZATION_GLOBAL_ID,
    ),
    intentHash,
    expiresAt: resultText(source.expiresAt, 64),
    confirmationStatement: resultText(source.confirmationStatement, 512),
    preview: Object.freeze({
      accountLabel: resultText(preview.accountLabel, 255),
      shopDomain: resultText(preview.shopDomain, 255),
      orderName: resultText(preview.orderName, 255),
      orderTest: preview.orderTest === true,
      orderUpdatedAt: resultText(preview.orderUpdatedAt, 64),
      action,
      fulfillmentId: preview.fulfillmentId === null
        ? null : resultId(preview.fulfillmentId, FULFILLMENT_GID),
      expectedFulfillmentUpdatedAt:
        preview.expectedFulfillmentUpdatedAt === null
          ? null : resultIsoInstant(preview.expectedFulfillmentUpdatedAt),
      predecessorAuthorizationGlobalId:
        predecessorAuthorizationGlobalId,
      lineItemId: preview.lineItemId === null
        ? null : resultId(preview.lineItemId, LINE_ITEM_GID),
      previousQuantity: preview.previousQuantity === null
        || preview.previousQuantity === undefined
        ? null : resultInteger(preview.previousQuantity, 2_147_483_647),
      requestedQuantity: preview.requestedQuantity === null
        ? null : resultInteger(preview.requestedQuantity, 2_147_483_647),
    }),
    replayed: source.replayed,
    providerReads: resultInteger(source.providerReads, 10),
    providerWrites: 0 as const,
  })
}

function publicResult(value: unknown) {
  const source = resultRecord(value)
  const state = resultText(source.state, 32)
  if (!['succeeded', 'failed', 'unknown', 'reconciled'].includes(state)) {
    resultInvalid()
  }
  if (typeof source.replayed !== 'boolean') resultInvalid()
  return Object.freeze({
    authorizationGlobalId: resultId(
      source.authorizationGlobalId,
      AUTHORIZATION_GLOBAL_ID,
    ),
    attemptGlobalId: resultId(source.attemptGlobalId, ATTEMPT_GLOBAL_ID),
    state,
    providerReference: resultNullableText(source.providerReference),
    replayed: source.replayed,
    providerReads: resultInteger(source.providerReads, 20),
    providerWrites: source.providerWrites === null
      ? null : resultInteger(source.providerWrites, 253),
    management: publicManagement(source.management),
  })
}

async function requestBody(req: NextRequest) {
  const contentType = String(req.headers.get('content-type') || '').toLowerCase()
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_CONTENT_TYPE_INVALID',
      'Shopify order management requires JSON',
      415,
    )
  }
  const declared = req.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_CONTENT_LENGTH_INVALID',
        'Shopify order management request length is invalid',
      )
    }
    if (length > MAX_REQUEST_BYTES) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_REQUEST_TOO_LARGE',
        'Shopify order management request exceeded the supported size',
        413,
      )
    }
  }
  const reader = req.body?.getReader()
  const chunks: Buffer[] = []
  let received = 0
  if (reader) {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        received += next.value.byteLength
        if (received > MAX_REQUEST_BYTES) {
          try {
            await reader.cancel('request_too_large')
          } catch {
            // The bounded rejection is already authoritative.
          }
          fail(
            'SHOPIFY_ORDER_MANAGEMENT_REQUEST_TOO_LARGE',
            'Shopify order management request exceeded the supported size',
            413,
          )
        }
        chunks.push(Buffer.from(next.value))
      }
    } finally {
      reader.releaseLock()
    }
  }
  try {
    return record(JSON.parse(Buffer.concat(chunks, received).toString('utf8')))
  } catch (error) {
    if (error instanceof ShopifyOrderManagementApiError) throw error
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
      'A valid Shopify order management request is required',
    )
  }
}

function requireWriteAuthority(actor: Awaited<ReturnType<typeof requireRequestUser>>) {
  const capabilities = operationsCapabilities(actor)
  if (!capabilities.canManage) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_AUTHORITY_REQUIRED',
      'Operations-management permission is required',
      403,
    )
  }
  return capabilities
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({
      ok: false,
      error: 'Select an active organization first',
      code: error.message,
    }, 409)
  }
  if (
    error instanceof ShopifyOrderManagementApiError
    || error instanceof ShopifyOrderManagementCommandError
    || error instanceof ShopifyOrderManagementPersistenceError
    || error instanceof ShopifyOrderManagementError
  ) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  console.error('[shopify-order-management] request failed', {
    kind: error instanceof Error ? 'unexpected_error' : 'unexpected_value',
    code: 'SHOPIFY_ORDER_MANAGEMENT_INTERNAL_ERROR',
  })
  return json({
    ok: false,
    error: 'Shopify order management is temporarily unavailable',
    code: 'SHOPIFY_ORDER_MANAGEMENT_INTERNAL_ERROR',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requireWriteAuthority(actor)
    requirePostgres()
    const fields = Array.from(new Set(req.nextUrl.searchParams.keys()))
    if (
      fields.length !== 1
      || fields[0] !== 'orderGlobalId'
      || req.nextUrl.searchParams.getAll('orderGlobalId').length !== 1
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_QUERY_INVALID',
        'Exactly one Operations order is required',
      )
    }
    const organizationId = activeOperationsOrganizationId(actor)
    const orderGlobalId = exactId(
      req.nextUrl.searchParams.get('orderGlobalId'),
      'Operations order',
      ORDER_GLOBAL_ID,
    )
    const management = await readShopifyOrderManagementState({
      organizationId,
      orderGlobalId,
    })
    return json({ ok: true, management: publicManagement(management) })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requireWriteAuthority(actor)
    requirePostgres()
    const organizationId = activeOperationsOrganizationId(actor)
    const body = await requestBody(req)
    const action = boundedText(body.action, 'Shopify order action', 24)
    const exactKey = idempotencyKey(req)

    if (action === 'save') {
      exactFields(body, [
        'action', 'orderGlobalId', 'expectedRowVersion', 'mutation',
      ])
      const result = await saveShopifyOrderManagementCommand({
        organizationId,
        actorEmail: actor.email,
        orderGlobalId: exactId(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        expectedRowVersion: rowVersion(body.expectedRowVersion),
        mutation: mutation(body.mutation),
        idempotencyKey: exactKey,
      })
      return json({ ok: true, result: publicResult(result) })
    }

    if (action === 'prepare') {
      exactFields(body, [
        'action', 'orderGlobalId', 'expectedRowVersion', 'mutation', 'reason',
      ])
      const result = await prepareShopifyOrderManagementCommand({
        organizationId,
        actorEmail: actor.email,
        orderGlobalId: exactId(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        expectedRowVersion: rowVersion(body.expectedRowVersion),
        mutation: mutation(body.mutation),
        reason: reason(body.reason),
        idempotencyKey: exactKey,
      })
      return json({ ok: true, authorization: publicAuthorization(result) })
    }

    if (action === 'execute') {
      exactFields(body, [
        'action', 'authorizationGlobalId', 'intentHash',
        'confirmationStatement', 'mutation', 'reason',
      ])
      const intentHash = boundedText(body.intentHash, 'Shopify intent hash', 64, 64)
      if (!SHA256.test(intentHash)) {
        fail(
          'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
          'Shopify intent hash is invalid',
        )
      }
      const result = await executeShopifyOrderManagementCommand({
        organizationId,
        actorEmail: actor.email,
        authorizationGlobalId: exactId(
          body.authorizationGlobalId,
          'Shopify order authorization',
          AUTHORIZATION_GLOBAL_ID,
        ),
        intentHash,
        confirmationStatement: boundedText(
          body.confirmationStatement,
          'Shopify confirmation statement',
          512,
        ),
        mutation: mutation(body.mutation),
        reason: reason(body.reason),
        idempotencyKey: exactKey,
      })
      return json({ ok: true, result: publicResult(result) })
    }

    if (action === 'reconcile') {
      exactFields(body, ['action', 'attemptGlobalId'])
      const result = await reconcileShopifyOrderManagementCommand({
        organizationId,
        actorEmail: actor.email,
        attemptGlobalId: exactId(
          body.attemptGlobalId,
          'Shopify provider attempt',
          ATTEMPT_GLOBAL_ID,
        ),
        idempotencyKey: exactKey,
      })
      return json({ ok: true, result: publicResult(result) })
    }

    fail(
      'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID',
      'Supported actions are save, prepare, execute, and reconcile',
    )
  } catch (error) {
    return errorResponse(error)
  }
}
