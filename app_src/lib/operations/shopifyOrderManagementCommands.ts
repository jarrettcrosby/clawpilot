import {
  decryptCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import { hasEffectiveShopifyScope } from '@/lib/integrations/commerceCapabilities'
import {
  executeShopifyOrderManagementAction,
  inspectShopifyOrderManagementTarget,
  requestedShopifyOrderSaveProjectionHash,
  shopifyOrderCancellationPaymentEvidence,
  shopifyOrderCancellationPaymentEligibility,
  shopifyOrderCancellationPaymentReleased,
  shopifyOrderManagementProjectionHash,
  type ShopifyOrderManagementAction,
  type ShopifyOrderCancellationPaymentEvidence,
  type ShopifyOrderCancellationReason,
  type ShopifyOrderCancellationRefundMethod,
  type ShopifyOrderManagementPreview,
  type ShopifyOrderShippingAddress,
} from '@/lib/integrations/shopifyOrderManagement'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  shopifyOrderManagementAccountAllowed,
  shopifyOrderManagementRuntime,
} from '@/lib/integrations/shopifyOrderManagementRuntime'
import {
  claimShopifyOrderManagementInPostgres,
  prepareShopifyOrderManagementInPostgres,
  readShopifyOrderManagementAuthorizationByAttemptInPostgres,
  readShopifyOrderManagementAuthorizationInPostgres,
  readShopifyOrderManagementTargetInPostgres,
  recoverStaleShopifyOrderManagementAttemptInPostgres,
  reconcileShopifyOrderManagementOutcomeInPostgres,
  recordShopifyOrderManagementOutcomeInPostgres,
  shopifyOrderManagementCancellationPaymentEvidenceMatchesSnapshot,
  shopifyOrderManagementEvidenceHash,
  type ShopifyOrderManagementAuthorization,
  type ShopifyOrderManagementTarget,
} from '@/lib/persistence/shopifyOrderManagement'
import { readCommerceRuntimeCredentialFromPostgres } from '@/lib/persistence/commerceIntegrations'

const SHA256 = /^[a-f0-9]{64}$/u
const JOB_GID = /^gid:\/\/shopify\/Job\/[A-Za-z0-9][A-Za-z0-9-]*$/u
const AUTHORIZATION_GLOBAL_ID = /^gsom(?:[0-9]{7}|[0-9a-v]{12})$/u

function boundCancellationPaymentEvidence(
  authorization: ShopifyOrderManagementAuthorization,
  preview: ShopifyOrderManagementPreview,
): ShopifyOrderCancellationPaymentEvidence | null {
  if (authorization.cancellationPaymentEvidence) {
    return authorization.cancellationPaymentEvidence as
      ShopifyOrderCancellationPaymentEvidence
  }
  if (
    !preview.paymentEvidenceComplete
    || preview.transactionsCount === null
  ) {
    return null
  }
  const authorizationCandidates = preview.transactions.filter(
    (transaction) => (
      transaction.kind === 'AUTHORIZATION'
      && transaction.status === 'SUCCESS'
      && transaction.test
    ),
  )
  const candidates: ShopifyOrderCancellationPaymentEvidence[] = []
  for (let transactionsCount = 0;
    transactionsCount <= preview.transactionsCount;
    transactionsCount += 1) {
    candidates.push(Object.freeze({
      schema: 'shopify-order-cancel-payment-evidence-v1' as const,
      transactionsCount,
      authorizationTransactionId: null,
      authorizationAmount: null,
    }))
    if (transactionsCount < 1 || transactionsCount >= 25) continue
    for (const transaction of authorizationCandidates) {
      candidates.push(Object.freeze({
        schema: 'shopify-order-cancel-payment-evidence-v1' as const,
        transactionsCount,
        authorizationTransactionId: transaction.id,
        authorizationAmount: Object.freeze({ ...transaction.amount }),
      }))
    }
  }
  const matches = candidates.filter((candidate) => (
    shopifyOrderManagementCancellationPaymentEvidenceMatchesSnapshot(
      authorization,
      candidate,
    )
  ))
  return matches.length === 1 ? matches[0] : null
}

export type ShopifyOrderManagementMutation =
  | Readonly<{ kind: 'add_tag'; tag: string }>
  | Readonly<{
      kind: 'cancel_fulfillment'
      fulfillmentId: string
      expectedFulfillmentUpdatedAt: string
    }>
  | Readonly<{
      kind: 'cancel_order_after_fulfillment_reversal'
      predecessorAuthorizationGlobalId: string
    }>
  | Readonly<{
      kind: 'cancel'
      reasonCode: ShopifyOrderCancellationReason
      refundMethod: ShopifyOrderCancellationRefundMethod
      restock: boolean
      notifyCustomer: boolean
    }>
  | Readonly<{
      kind: 'set_line_quantity'
      lineItemId: string
      quantity: number
    }>
  | Readonly<{
      kind: 'save_order'
      email: string | null
      phone: string | null
      poNumber: string | null
      note: string | null
      shippingAddress: ShopifyOrderShippingAddress | null
      tagAdds: string[]
      tagRemoves: string[]
      lineQuantities: Array<{
        lineItemId: string
        quantity: number
      }>
    }>

export class ShopifyOrderManagementCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'ShopifyOrderManagementCommandError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new ShopifyOrderManagementCommandError(code, message, status)
}

function cancellationStaffNote(reason: string) {
  return `ClawPilot cancellation: ${reason}`.slice(0, 255)
}

function operatorStaffNote(reason: string) {
  return `ClawPilot operator action: ${reason}`.slice(0, 255)
}

function providerAction(
  mutation: ShopifyOrderManagementMutation,
  reason: string,
): ShopifyOrderManagementAction {
  if (mutation.kind === 'add_tag') {
    return { type: 'add_tag', tag: mutation.tag }
  }
  if (mutation.kind === 'cancel_fulfillment') {
    return {
      type: 'cancel_fulfillment',
      fulfillmentGid: mutation.fulfillmentId,
      expectedFulfillmentUpdatedAt: mutation.expectedFulfillmentUpdatedAt,
    }
  }
  if (mutation.kind === 'cancel_order_after_fulfillment_reversal') {
    return {
      type: 'cancel_order_after_fulfillment_reversal',
      predecessorAuthorizationGlobalId:
        mutation.predecessorAuthorizationGlobalId,
      reason: 'STAFF',
      staffNote: cancellationStaffNote(reason),
    }
  }
  if (mutation.kind === 'cancel') {
    return {
      type: 'cancel',
      reason: mutation.reasonCode,
      staffNote: cancellationStaffNote(reason),
      refundMethod: mutation.refundMethod,
      restock: mutation.restock,
      notifyCustomer: mutation.notifyCustomer,
    }
  }
  if (mutation.kind === 'save_order') {
    return {
      type: 'save_order',
      email: mutation.email,
      phone: mutation.phone,
      poNumber: mutation.poNumber,
      note: mutation.note,
      shippingAddress: mutation.shippingAddress,
      tagAdds: mutation.tagAdds,
      tagRemoves: mutation.tagRemoves,
      lineQuantities: mutation.lineQuantities.map((line) => ({
        lineItemGid: line.lineItemId,
        quantity: line.quantity,
      })),
    }
  }
  return {
    type: 'set_line_quantity',
    lineItemGid: mutation.lineItemId,
    quantity: mutation.quantity,
    staffNote: operatorStaffNote(reason),
  }
}

function confirmationStatement(authorization: ShopifyOrderManagementAuthorization) {
  const statement = [
    'AUTHORIZE SHOPIFY WRITE',
    authorization.authorizationGlobalId,
    authorization.action.toUpperCase(),
    authorization.orderNumber,
  ]
  if (
    authorization.action === 'cancel'
    || authorization.action === 'cancel_order_after_fulfillment_reversal'
  ) {
    statement.push(
      'REFUND',
      authorization.cancelRefundMethod === 'original_payment_methods'
        ? 'ORIGINAL_PAYMENT_METHODS'
        : 'NONE',
      'RESTOCK',
      authorization.cancelRestock ? 'YES' : 'NO',
      'NOTIFY',
      authorization.cancelNotifyCustomer ? 'YES' : 'NO',
    )
  }
  return statement.join(' ')
}

function exactCurrentSource(target: ShopifyOrderManagementTarget) {
  return Boolean(
    target.sourceHash
    && target.sourceHash === target.acceptedSourceHash
    && (
      target.latestSourceHash === null
      || target.latestSourceHash === target.sourceHash
    )
    && target.materialState === 'current',
  )
}

function targetReadBlocker(target: ShopifyOrderManagementTarget) {
  if (!['sandbox', 'production'].includes(target.accountEnvironment)) {
    return 'SHOPIFY_ORDER_MANAGEMENT_ACCOUNT_ENVIRONMENT_INVALID'
  }
  const runtime = shopifyOrderManagementRuntime()
  if (!runtime.available) {
    return runtime.blockerCode || 'SHOPIFY_ORDER_MANAGEMENT_RUNTIME_UNAVAILABLE'
  }
  if (!shopifyOrderManagementAccountAllowed(
    target.accountGlobalId,
    target.accountEnvironment,
  )) {
    return 'SHOPIFY_ORDER_MANAGEMENT_ACCOUNT_NOT_ALLOWLISTED'
  }
  if (!target.credentialCurrent) {
    return 'SHOPIFY_ORDER_MANAGEMENT_CREDENTIAL_NOT_CURRENT'
  }
  return null
}

function targetWriteBlocker(target: ShopifyOrderManagementTarget) {
  const readBlocker = targetReadBlocker(target)
  if (readBlocker) return readBlocker
  if (
    target.orderStatus !== 'imported'
    || !target.zeroDownstream
    || !target.sourceHash
  ) {
    return 'SHOPIFY_ORDER_MANAGEMENT_UNSTARTED_ORDER_REQUIRED'
  }
  return null
}

function providerWriteBlocker(target: ShopifyOrderManagementTarget) {
  if (
    target.providerWriteRequestedMode !== 'on'
    || !target.providerWriteBindingCurrent
    || target.providerWriteControlRowVersion < 1
    || !target.providerWriteScopeDigest
  ) {
    return 'SHOPIFY_ORDER_MANAGEMENT_PROVIDER_WRITES_OFF'
  }
  return null
}

function targetBlocker(target: ShopifyOrderManagementTarget) {
  return targetWriteBlocker(target) || providerWriteBlocker(target)
}

function fulfillmentReversalTargetBlocker(
  target: ShopifyOrderManagementTarget,
) {
  const readBlocker = targetReadBlocker(target)
  if (readBlocker) return readBlocker
  const writeBlocker = providerWriteBlocker(target)
  if (writeBlocker) return writeBlocker
  if (
    !target.sourceHash
    || target.acceptedSourceHash !== target.sourceHash
    || target.orderStatus !== 'cancelled'
    || target.materialState !== 'provider_fulfilled'
    || target.fulfillmentReversalSafe !== true
  ) {
    return 'This order is not eligible for Shopify fulfillment reversal'
  }
  return null
}

function postReversalOrderCancellationTargetBlocker(
  target: ShopifyOrderManagementTarget,
) {
  const readBlocker = targetReadBlocker(target)
  if (readBlocker) return readBlocker
  const writeBlocker = providerWriteBlocker(target)
  if (writeBlocker) return writeBlocker
  if (
    !target.sourceHash
    || target.acceptedSourceHash !== target.sourceHash
    || target.orderStatus !== 'cancelled'
    || ![
      'provider_fulfilled', 'review_required',
    ].includes(target.materialState)
    || target.postReversalOrderCancellationSafe !== true
    || !target.postReversalOrderCancellationPredecessorGlobalId
    || !AUTHORIZATION_GLOBAL_ID.test(
      target.postReversalOrderCancellationPredecessorGlobalId,
    )
  ) {
    return 'This order is not eligible for cancellation after fulfillment reversal'
  }
  return null
}

function assertReconciliationTarget(
  target: ShopifyOrderManagementTarget,
  authorization: ShopifyOrderManagementAuthorization,
) {
  if (
    target.accountGlobalId !== authorization.accountGlobalId
    || target.externalAccountId !== authorization.externalAccountId
    || target.shopDomain !== authorization.shopDomain
    || target.externalOrderId !== authorization.externalOrderId
    || target.orderNumber !== authorization.orderNumber
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RECONCILIATION_TARGET_MISMATCH',
      'The current Shopify account or order identity no longer matches the provider attempt',
    )
  }
}

function assertProviderWritesEnabled(target: ShopifyOrderManagementTarget) {
  const runtimeBlocker = targetReadBlocker(target)
  if (runtimeBlocker) {
    fail(
      runtimeBlocker,
      'Shopify order management is not enabled for this runtime and account',
      503,
    )
  }
  if (providerWriteBlocker(target)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_PROVIDER_WRITES_OFF',
      'Turn Provider writes On for this Shopify connection before saving changes',
      409,
    )
  }
}

function assertLegacyRollingWriteAuthorized(
  accountGlobalId: string,
  accountEnvironment: string,
) {
  const runtime = shopifyOrderManagementRuntime()
  if (!runtime.available || !shopifyOrderManagementAccountAllowed(
    accountGlobalId,
    accountEnvironment,
  )) {
    fail(
      runtime.blockerCode || 'SHOPIFY_ORDER_MANAGEMENT_ACCOUNT_NOT_ALLOWLISTED',
      'The rolling-deploy Shopify write lane is unavailable',
      503,
    )
  }
}

async function exactTarget(input: {
  organizationId: string
  orderGlobalId: string
}) {
  const target = await readShopifyOrderManagementTargetInPostgres(input)
  if (!target) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_FOUND',
      'The imported Shopify order was not found',
      404,
    )
  }
  return target
}

async function credentialFor(input: {
  organizationId: string
  target: Pick<
    ShopifyOrderManagementTarget,
    | 'accountGlobalId'
    | 'accountEnvironment'
    | 'credentialGeneration'
    | 'externalAccountId'
    | 'shopDomain'
  >
}) {
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId: input.organizationId,
    accountGlobalId: input.target.accountGlobalId,
  })
  if (
    !runtime
    || runtime.provider !== 'shopify'
    || runtime.environment !== input.target.accountEnvironment
    || !['sandbox', 'production'].includes(runtime.environment)
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== input.target.credentialGeneration
    || runtime.externalAccountId !== input.target.externalAccountId
    || !input.target.shopDomain
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_CREDENTIAL_NOT_CURRENT',
      'The exact Shopify credential is unavailable',
    )
  }
  const decrypted = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (decrypted.provider !== 'shopify') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_CREDENTIAL_NOT_CURRENT',
      'The exact Shopify credential is unavailable',
    )
  }
  return {
    shopDomain: input.target.shopDomain,
    clientId: decrypted.clientId,
    clientSecret: decrypted.clientSecret,
  }
}

function placeholderPreview(target: ShopifyOrderManagementTarget): ShopifyOrderManagementPreview {
  const now = new Date().toISOString()
  return {
    id: target.externalOrderId,
    legacyResourceId: target.externalOrderId.split('/').pop() || '0',
    name: target.orderNumber,
    test: target.latestProviderOrderTest === true,
    createdAt: now,
    updatedAt: target.latestProviderUpdatedAt || now,
    cancelledAt: null,
    closed: false,
    unpaid: false,
    capturable: false,
    displayFinancialStatus: null,
    displayFulfillmentStatus: 'UNAVAILABLE',
    merchantEditable: false,
    merchantEditableErrors: [],
    returnStatus: 'UNAVAILABLE',
    shopCurrencyCode: 'XXX',
    orderCurrencyCode: 'XXX',
    currentTotalPrice: { amount: '0.00', currencyCode: 'XXX' },
    totalOutstanding: { amount: '0.00', currencyCode: 'XXX' },
    totalReceived: { amount: '0.00', currencyCode: 'XXX' },
    totalRefunded: { amount: '0.00', currencyCode: 'XXX' },
    totalCapturable: { amount: '0.00', currencyCode: 'XXX' },
    transactionsCount: null,
    paymentEvidenceComplete: false,
    transactions: [],
    email: null,
    phone: null,
    poNumber: null,
    note: null,
    shippingAddress: null,
    tags: [],
    lines: [],
    fulfillments: [],
  }
}

function openAttempt(authorization: ShopifyOrderManagementAuthorization | null) {
  if (
    !authorization
    || !['processing', 'unknown'].includes(authorization.status)
    || !authorization.providerAttemptGlobalId
  ) return null
  return {
    attemptGlobalId: authorization.providerAttemptGlobalId,
    authorizationGlobalId: authorization.authorizationGlobalId,
    intentHash: authorization.intentHash,
    state: authorization.status,
    actionKind: authorization.action,
    providerReference: authorization.providerReference,
    errorCode: authorization.errorCode,
    createdAt: authorization.preparedAt,
    updatedAt: authorization.completedAt
      || authorization.processingAt
      || authorization.preparedAt,
    providerWrites: authorization.providerWriteCount,
  }
}

function whollyUnfulfilled(preview: ShopifyOrderManagementPreview) {
  return preview.displayFulfillmentStatus === 'UNFULFILLED'
    && preview.lines.length > 0
    && preview.lines.every((line) => (
      line.currentQuantity > 0
      && line.unfulfilledQuantity === line.currentQuantity
      && line.nonFulfillableQuantity === 0
    ))
}

function publicState(input: {
  target: ShopifyOrderManagementTarget
  preview: ShopifyOrderManagementPreview
  grantedScopes: readonly string[]
  runtimeAvailable: boolean
  blockerCode: string | null
  authorization?: ShopifyOrderManagementAuthorization | null
}) {
  const readReason = input.blockerCode || targetReadBlocker(input.target)
  const targetReason = targetBlocker(input.target)
  const unresolved = openAttempt(
    input.authorization === undefined
      ? input.target.latestOpenAuthorization
      : input.authorization,
  )
  const baseReason = readReason || (
    unresolved
      ? 'Resolve the existing Shopify provider attempt first'
      : null
  )
  const writeReason = baseReason || targetReason
  const writeOrders = hasEffectiveShopifyScope(
    input.grantedScopes,
    'write_orders',
  )
  const readOrders = hasEffectiveShopifyScope(
    input.grantedScopes,
    'read_orders',
  )
  const writeOrderEdits = hasEffectiveShopifyScope(
    input.grantedScopes,
    'write_order_edits',
  )
  const writeMerchantManagedFulfillmentOrders = hasEffectiveShopifyScope(
    input.grantedScopes,
    'write_merchant_managed_fulfillment_orders',
  )
  const productionCancellationOnlyReason =
    input.target.accountEnvironment === 'production'
      ? 'Only order cancellation is enabled for this production Shopify account'
      : null
  const addTagReason = writeReason || productionCancellationOnlyReason || (!writeOrders
    ? 'The Shopify connection is missing write_orders'
    : null)
  const ordinarySaveReason = writeReason || productionCancellationOnlyReason || (!writeOrders
    ? 'The Shopify connection is missing write_orders'
    : null)
  const fulfillmentBaseReason = baseReason
    || productionCancellationOnlyReason
    || fulfillmentReversalTargetBlocker(input.target)
    || (!readOrders
      ? 'The Shopify connection is missing read_orders'
      : null)
    || (!writeOrders
      ? 'The Shopify connection is missing write_orders'
      : null)
    || (!writeMerchantManagedFulfillmentOrders
      ? 'The Shopify connection is missing write_merchant_managed_fulfillment_orders'
      : null)
    || (!input.preview.test
      ? 'Fulfillment reversal is limited to Shopify test orders'
      : null)
    || (input.preview.cancelledAt !== null
      ? 'The Shopify order is cancelled'
      : null)
    || (input.preview.closed ? 'The Shopify order is closed' : null)
    || (input.preview.returnStatus !== 'NO_RETURN'
      ? 'The Shopify order has return activity'
      : null)
  const reversedFulfillment = input.target.reversibleExternalFulfillmentGid
    ? input.preview.fulfillments.find((fulfillment) => (
        fulfillment.id === input.target.reversibleExternalFulfillmentGid
      ))
    : undefined
  const cancellationWithoutRefund = shopifyOrderCancellationPaymentEligibility(
    input.preview,
    'none',
  )
  const cancellationWithRefund = shopifyOrderCancellationPaymentEligibility(
    input.preview,
    'original_payment_methods',
  )
  const cancellationPaymentReason = cancellationWithoutRefund.allowed
    || cancellationWithRefund.allowed
    ? null
    : cancellationWithoutRefund.reason === cancellationWithRefund.reason
      ? cancellationWithoutRefund.reason
      : [
          cancellationWithoutRefund.reason,
          cancellationWithRefund.reason,
        ].filter(Boolean).join('; ')
  const postReversalCancellationReason = baseReason
    || productionCancellationOnlyReason
    || postReversalOrderCancellationTargetBlocker(input.target)
    || (!writeOrders
      ? 'The Shopify connection is missing write_orders'
      : null)
    || (reversedFulfillment?.status !== 'CANCELLED'
      ? 'The exact predecessor fulfillment is not cancelled in Shopify'
      : null)
    || (!input.preview.test
      ? 'Order cancellation is limited to Shopify test orders'
      : null)
    || (input.preview.cancelledAt !== null
      ? 'The Shopify order is already cancelled'
      : null)
    || (input.preview.closed ? 'The Shopify order is closed' : null)
    || cancellationWithoutRefund.reason
    || (input.preview.returnStatus !== 'NO_RETURN'
      ? 'The Shopify order has return activity'
      : null)
    || (!whollyUnfulfilled(input.preview)
      ? 'The order must remain wholly unfulfilled after fulfillment reversal'
      : null)
  const destructiveCurrent = exactCurrentSource(input.target)
    && Boolean(input.target.acceptedProviderUpdatedAt)
    && input.target.acceptedProviderUpdatedAt === input.preview.updatedAt
  const cancellationReason = baseReason
    || (!writeOrders ? 'The Shopify connection is missing write_orders' : null)
    || (input.preview.cancelledAt !== null
      ? 'The Shopify order is already cancelled'
      : null)
    || (input.preview.closed ? 'The Shopify order is closed' : null)
    || cancellationPaymentReason
    || (input.preview.returnStatus !== 'NO_RETURN'
      ? 'The Shopify order has return activity'
      : null)
    || (!whollyUnfulfilled(input.preview)
      ? 'This order has fulfillment activity. Cancel or return that fulfillment before cancelling the order'
      : null)
    || (!destructiveCurrent
      ? 'Refresh and accept the current provider revision before changing order state'
      : null)
    || targetReason
  const lineBaseReason = writeReason
    || productionCancellationOnlyReason
    || (!writeOrderEdits
      ? 'The Shopify connection is missing write_order_edits'
      : null)
    || (!destructiveCurrent
      ? 'Refresh and accept the current provider revision before changing order state'
      : null)
    || (!input.preview.test
      ? 'Line changes are limited to Shopify test orders'
      : null)
    || (input.preview.orderCurrencyCode !== input.preview.shopCurrencyCode
      ? 'Shopify line edits require the order and store currencies to match'
      : null)
    || (input.preview.cancelledAt !== null
      ? 'The Shopify order is cancelled'
      : null)
    || (input.preview.closed ? 'The Shopify order is closed' : null)
    || (input.preview.returnStatus !== 'NO_RETURN'
      ? 'The Shopify order has return activity'
      : null)
    || (!input.preview.merchantEditable
      ? 'Shopify does not currently allow this order to be edited'
      : null)
    || (!whollyUnfulfilled(input.preview)
      ? 'Line changes require a wholly unfulfilled order'
      : null)

  return Object.freeze({
    runtimeAvailable: input.runtimeAvailable,
    blockerCode: baseReason,
    accountLabel: input.target.accountDisplayName,
    shopDomain: input.target.shopDomain || 'unavailable.myshopify.com',
    payment: Object.freeze({
      totalReceived: Object.freeze({ ...input.preview.totalReceived }),
      totalRefunded: Object.freeze({ ...input.preview.totalRefunded }),
      totalCapturable: Object.freeze({ ...input.preview.totalCapturable }),
      refundOptions: Object.freeze({
        none: cancellationWithoutRefund,
        original_payment_methods: cancellationWithRefund,
      }),
    }),
    order: Object.freeze({
      globalId: input.target.orderGlobalId,
      externalOrderId: input.target.externalOrderId,
      name: input.preview.name,
      rowVersion: input.target.orderRowVersion,
      test: input.preview.test,
      closed: input.preview.closed,
      cancelledAt: input.preview.cancelledAt,
      financialStatus: input.preview.displayFinancialStatus,
      fulfillmentStatus: input.preview.displayFulfillmentStatus,
      merchantEditable: input.preview.merchantEditable,
      email: input.preview.email,
      phone: input.preview.phone,
      poNumber: input.preview.poNumber,
      note: input.preview.note,
      shippingAddress: input.preview.shippingAddress
        ? Object.freeze({ ...input.preview.shippingAddress })
        : null,
      tags: Object.freeze([...input.preview.tags]),
      lines: Object.freeze(input.preview.lines.map((line) => Object.freeze({
        lineItemId: line.id,
        title: line.name,
        quantity: line.currentQuantity,
        unfulfilledQuantity: line.unfulfilledQuantity,
        fulfilledQuantity: Math.max(
          0,
          line.currentQuantity - line.unfulfilledQuantity,
        ),
      }))),
      fulfillments: Object.freeze(input.preview.fulfillments.map(
        (fulfillment) => Object.freeze({
          fulfillmentId: fulfillment.id,
          name: fulfillment.name,
          status: fulfillment.status,
          displayStatus: fulfillment.displayStatus,
          updatedAt: fulfillment.updatedAt,
          deliveredAt: fulfillment.deliveredAt,
          quantity: fulfillment.totalQuantity,
          tracking: Object.freeze(fulfillment.tracking.map((tracking) =>
            Object.freeze({
              company: tracking.company,
              number: tracking.number,
              url: tracking.url,
            }))),
        }),
      )),
    }),
    eligibility: Object.freeze({
      addTag: Object.freeze({ allowed: addTagReason === null, reason: addTagReason }),
      ordinarySave: Object.freeze({
        allowed: ordinarySaveReason === null,
        reason: ordinarySaveReason,
      }),
      cancel: Object.freeze({
        allowed: cancellationReason === null,
        reason: cancellationReason,
        releasesAuthorization: cancellationReason === null
          && (
            cancellationWithoutRefund.releasesAuthorization
            || cancellationWithRefund.releasesAuthorization
          ),
      }),
      cancelAfterFulfillmentReversal: Object.freeze({
        allowed: postReversalCancellationReason === null,
        reason: postReversalCancellationReason,
        releasesAuthorization: postReversalCancellationReason === null
          && cancellationWithoutRefund.releasesAuthorization,
        predecessorAuthorizationGlobalId:
          input.target.postReversalOrderCancellationPredecessorGlobalId,
      }),
      fulfillments: Object.freeze(input.preview.fulfillments.map(
        (fulfillment) => {
          const reason = fulfillmentBaseReason
            || (
              input.target.reversibleExternalFulfillmentGid
                !== fulfillment.id
              || input.target.reversibleExternalFulfillmentUpdatedAt
                !== fulfillment.updatedAt
              ? 'This fulfillment does not match the exact reconciled external fulfillment'
              : null)
            || (fulfillment.deliveredAt !== null
              ? 'Delivered fulfillments require a return'
              : null)
            || (fulfillment.status === 'CANCELLED'
              ? 'This Shopify fulfillment is already reversed'
              : null)
            || (
              fulfillment.status !== 'SUCCESS'
              || fulfillment.displayStatus !== 'FULFILLED'
              ? 'Only a successful, fulfilled Shopify fulfillment can be reversed'
              : null)
            || (fulfillment.fulfillmentOrders.length < 1
              || fulfillment.fulfillmentOrders.some((order) => (
                order.assignedLocation.location === null
              ))
              ? 'Shopify did not return the assigned fulfillment location'
              : null)
            || (fulfillment.totalQuantity < 1
              ? 'This Shopify fulfillment has no items to reverse'
              : null)
          return Object.freeze({
            fulfillmentId: fulfillment.id,
            expectedUpdatedAt: fulfillment.updatedAt,
            allowed: reason === null,
            reason,
          })
        },
      )),
      lineEdits: Object.freeze(input.preview.lines.map((line) => {
        const reason = lineBaseReason || (!line.merchantEditable
          ? 'Shopify does not allow this line to be edited'
          : line.currentQuantity < 1
            ? 'The line has no quantity remaining'
            : null)
        return Object.freeze({
          lineItemId: line.id,
          allowed: reason === null,
          reason,
          minQuantity: 0,
          maxQuantity: Math.max(0, line.currentQuantity - 1),
        })
      })),
    }),
    openAttempt: unresolved,
  })
}

function assertProductionCancellationOnly(
  target: ShopifyOrderManagementTarget,
  mutationKind: ShopifyOrderManagementMutation['kind'],
) {
  if (target.accountEnvironment === 'production' && mutationKind !== 'cancel') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_PRODUCTION_CANCEL_ONLY',
      'Only order cancellation is enabled for this production Shopify account',
      403,
    )
  }
}

async function inspect(input: {
  organizationId: string
  target: ShopifyOrderManagementTarget
  requiredActions?: readonly ShopifyOrderManagementAction['type'][]
  jobGid?: string
}) {
  const credential = await credentialFor(input)
  const observedAt = new Date().toISOString()
  const inspected = await inspectShopifyOrderManagementTarget({
    credential,
    expected: {
      shopId: input.target.externalAccountId || '',
      shopDomain: input.target.shopDomain || '',
      orderGid: input.target.externalOrderId,
      orderName: input.target.orderNumber,
    },
    requiredActions: input.requiredActions,
    fulfillmentGid:
      input.target.reversibleExternalFulfillmentGid || undefined,
    jobGid: input.jobGid,
  })
  return { credential, observedAt, inspected }
}

export async function readShopifyOrderManagementState(input: {
  organizationId: string
  orderGlobalId: string
}) {
  const target = await exactTarget(input)
  const blockerCode = targetReadBlocker(target)
  if (blockerCode) {
    return publicState({
      target,
      preview: placeholderPreview(target),
      grantedScopes: [],
      runtimeAvailable: false,
      blockerCode,
    })
  }
  const requiredActions: ShopifyOrderManagementAction['type'][] =
    target.postReversalOrderCancellationPredecessorGlobalId
      ? ['cancel_order_after_fulfillment_reversal']
      : target.reversibleExternalFulfillmentGid
        ? ['cancel_fulfillment']
        : []
  const live = await inspect({
    organizationId: input.organizationId,
    target,
    requiredActions,
  })
  return publicState({
    target,
    preview: live.inspected.preview,
    grantedScopes: live.inspected.grantedScopes,
    runtimeAvailable: true,
    blockerCode: null,
  })
}

function assertPreparedMutation(input: {
  mutation: ShopifyOrderManagementMutation
  management: ReturnType<typeof publicState>
  preview: ShopifyOrderManagementPreview
}) {
  if (input.mutation.kind === 'add_tag') {
    if (!input.management.eligibility.addTag.allowed) {
      fail(
        'SHOPIFY_ORDER_TAG_NOT_ELIGIBLE',
        input.management.eligibility.addTag.reason || 'Shopify tag change is unavailable',
      )
    }
    if (input.preview.tags.includes(input.mutation.tag)) {
      fail(
        'SHOPIFY_ORDER_TAG_ALREADY_PRESENT',
        'The exact Shopify order tag is already present',
      )
    }
    return
  }
  if (input.mutation.kind === 'cancel') {
    if (!input.management.eligibility.cancel.allowed) {
      fail(
        'SHOPIFY_ORDER_CANCEL_NOT_ELIGIBLE',
        input.management.eligibility.cancel.reason || 'Shopify cancellation is unavailable',
      )
    }
    const payment = shopifyOrderCancellationPaymentEligibility(
      input.preview,
      input.mutation.refundMethod,
    )
    if (!payment.allowed) {
      fail(
        'SHOPIFY_ORDER_CANCEL_NOT_ELIGIBLE',
        payment.reason || 'Shopify payment state cannot be cancelled with these choices',
      )
    }
    return
  }
  if (input.mutation.kind === 'cancel_order_after_fulfillment_reversal') {
    const eligibility =
      input.management.eligibility.cancelAfterFulfillmentReversal
    if (
      !eligibility.allowed
      || eligibility.predecessorAuthorizationGlobalId
        !== input.mutation.predecessorAuthorizationGlobalId
    ) {
      fail(
        'SHOPIFY_ORDER_POST_REVERSAL_CANCEL_NOT_ELIGIBLE',
        eligibility.reason
          || 'The exact fulfillment-reversal predecessor changed',
      )
    }
    return
  }
  if (input.mutation.kind === 'cancel_fulfillment') {
    const mutation = input.mutation
    const eligibility = input.management.eligibility.fulfillments.find(
      (fulfillment) => (
        fulfillment.fulfillmentId === mutation.fulfillmentId
      ),
    )
    if (
      !eligibility?.allowed
      || eligibility.expectedUpdatedAt
        !== mutation.expectedFulfillmentUpdatedAt
    ) {
      fail(
        'SHOPIFY_FULFILLMENT_CANCEL_NOT_ELIGIBLE',
        eligibility?.reason
          || 'The exact Shopify fulfillment is unavailable or changed',
      )
    }
    return
  }
  if (input.mutation.kind === 'save_order') {
    if (!input.management.eligibility.ordinarySave.allowed) {
      fail(
        'SHOPIFY_ORDER_SAVE_NOT_ELIGIBLE',
        input.management.eligibility.ordinarySave.reason
          || 'Shopify order save is unavailable',
      )
    }
    if (
      input.mutation.tagAdds.some((tag) => input.preview.tags.includes(tag))
      || input.mutation.tagRemoves.some((tag) => !input.preview.tags.includes(tag))
    ) {
      fail(
        'SHOPIFY_ORDER_TAG_STALE',
        'Shopify tags changed before this order save',
      )
    }
    for (const lineMutation of input.mutation.lineQuantities) {
      const eligibility = input.management.eligibility.lineEdits.find(
        (line) => line.lineItemId === lineMutation.lineItemId,
      )
      if (
        !eligibility?.allowed
        || lineMutation.quantity < eligibility.minQuantity
        || lineMutation.quantity > eligibility.maxQuantity
      ) {
        fail(
          'SHOPIFY_ORDER_EDIT_NOT_ELIGIBLE',
          eligibility?.reason || 'A Shopify line quantity is unavailable',
        )
      }
    }
    return
  }
  const lineMutation = input.mutation
  const eligibility = input.management.eligibility.lineEdits.find(
    (line) => line.lineItemId === lineMutation.lineItemId,
  )
  if (
    !eligibility?.allowed
    || lineMutation.quantity < eligibility.minQuantity
    || lineMutation.quantity > eligibility.maxQuantity
  ) {
    fail(
      'SHOPIFY_ORDER_EDIT_NOT_ELIGIBLE',
      eligibility?.reason || 'The exact Shopify line quantity is unavailable',
    )
  }
}

export async function prepareShopifyOrderManagementCommand(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  mutation: ShopifyOrderManagementMutation
  reason: string
  idempotencyKey: string
}) {
  const target = await exactTarget(input)
  if (target.orderRowVersion !== input.expectedRowVersion) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_STALE',
      'The ClawPilot order changed before this action was prepared',
    )
  }
  assertProductionCancellationOnly(target, input.mutation.kind)
  assertProviderWritesEnabled(target)
  const action = providerAction(input.mutation, input.reason)
  const live = await inspect({
    organizationId: input.organizationId,
    target,
    requiredActions: action.type === 'save_order'
      ? [
          'save_order',
          ...(action.lineQuantities.length > 0
            ? ['set_line_quantity' as const]
            : []),
        ]
      : [action.type],
  })
  const management = publicState({
    target,
    preview: live.inspected.preview,
    grantedScopes: live.inspected.grantedScopes,
    runtimeAvailable: true,
    blockerCode: null,
  })
  assertPreparedMutation({
    mutation: input.mutation,
    management,
    preview: live.inspected.preview,
  })
  let expectedLineQuantity: number | undefined
  if (input.mutation.kind === 'set_line_quantity') {
    const lineItemId = input.mutation.lineItemId
    expectedLineQuantity = live.inspected.preview.lines.find(
      (line) => line.id === lineItemId,
    )?.currentQuantity
  }
  const requestedProjectionHash = action.type === 'save_order'
    ? requestedShopifyOrderSaveProjectionHash(
        live.inspected.preview,
        action,
      )
    : undefined
  const cancellation = action.type === 'cancel'
    || action.type === 'cancel_order_after_fulfillment_reversal'
  const cancellationPaymentEvidence = cancellation
    ? shopifyOrderCancellationPaymentEvidence(
        live.inspected.preview,
        action.refundMethod || 'none',
      )
    : undefined
  if (cancellation && !cancellationPaymentEvidence) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_CANCELLATION_PAYMENT_EVIDENCE_INVALID',
      'Exact bounded Shopify cancellation payment evidence is required',
    )
  }
  const authorization = await prepareShopifyOrderManagementInPostgres({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    accountGlobalId: target.accountGlobalId,
    orderGlobalId: target.orderGlobalId,
    expectedOrderRowVersion: target.orderRowVersion,
    expectedSourceHash: target.sourceHash,
    providerOrderUpdatedAt: live.inspected.preview.updatedAt,
    providerOrderObservedAt: live.observedAt,
    providerOrderTest: live.inspected.preview.test,
    cancellationPaymentEvidence,
    expectedLineQuantity,
    requestedProjectionHash,
    action,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  })
  return Object.freeze({
    authorizationGlobalId: authorization.authorizationGlobalId,
    intentHash: authorization.intentHash,
    expiresAt: authorization.expiresAt,
    confirmationStatement: confirmationStatement(authorization),
    preview: Object.freeze({
      accountLabel: target.accountDisplayName,
      shopDomain: target.shopDomain,
      orderName: live.inspected.preview.name,
      orderTest: live.inspected.preview.test,
      orderUpdatedAt: live.inspected.preview.updatedAt,
      action: authorization.action,
      fulfillmentId: authorization.fulfillmentGid,
      expectedFulfillmentUpdatedAt:
        authorization.expectedFulfillmentUpdatedAt,
      predecessorAuthorizationGlobalId:
        authorization.predecessorAuthorizationGlobalId,
      lineItemId: authorization.lineItemGid,
      previousQuantity: authorization.expectedLineQuantity,
      requestedQuantity: authorization.requestedQuantity,
    }),
    replayed: authorization.replayed,
    providerReads: live.inspected.providerReads,
    providerWrites: 0 as const,
  })
}

function automaticSaveReason(mutation: ShopifyOrderManagementMutation) {
  if (mutation.kind === 'add_tag') return 'Saved Shopify order tag in ClawPilot'
  if (mutation.kind === 'cancel_fulfillment') {
    return 'Reversed Shopify fulfillment in ClawPilot'
  }
  if (mutation.kind === 'cancel_order_after_fulfillment_reversal') {
    return 'Cancelled Shopify order after fulfillment reversal in ClawPilot'
  }
  if (mutation.kind === 'cancel') {
    fail(
      'SHOPIFY_ORDER_CANCEL_CONFIRMATION_REQUIRED',
      'Prepare and confirm the Shopify cancellation before sending it',
    )
  }
  if (mutation.kind === 'save_order') return 'Saved Shopify order changes in ClawPilot'
  return 'Saved Shopify order line quantity in ClawPilot'
}

export async function saveShopifyOrderManagementCommand(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  mutation: ShopifyOrderManagementMutation
  idempotencyKey: string
}) {
  const reason = automaticSaveReason(input.mutation)
  const prepared = await prepareShopifyOrderManagementCommand({
    ...input,
    reason,
  })
  return executeShopifyOrderManagementCommand({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    authorizationGlobalId: prepared.authorizationGlobalId,
    intentHash: prepared.intentHash,
    confirmationStatement: prepared.confirmationStatement,
    mutation: input.mutation,
    reason,
    idempotencyKey: input.idempotencyKey,
  })
}

function actionMatchesMutation(
  authorization: ShopifyOrderManagementAuthorization,
  action: ShopifyOrderManagementAction,
) {
  if (authorization.action !== action.type) return false
  if (action.type === 'add_tag') {
    return authorization.tagHash === shopifyOrderManagementEvidenceHash({
      schema: 'shopify-order-management-tag-v1',
      tag: action.tag,
    })
  }
  if (action.type === 'cancel') {
    return authorization.cancelReason === action.reason
      && authorization.cancelRefundMethod === (action.refundMethod || 'none')
      && authorization.cancelRestock === (action.restock ?? false)
      && authorization.cancelNotifyCustomer
        === (action.notifyCustomer ?? false)
      && authorization.staffNoteHash === shopifyOrderManagementEvidenceHash({
        schema: 'shopify-order-management-staff-note-v1',
        staffNote: action.staffNote,
      })
  }
  if (action.type === 'cancel_fulfillment') {
    return authorization.fulfillmentGid === action.fulfillmentGid
      && authorization.expectedFulfillmentUpdatedAt
        === action.expectedFulfillmentUpdatedAt
  }
  if (action.type === 'cancel_order_after_fulfillment_reversal') {
    return authorization.predecessorAuthorizationGlobalId
        === action.predecessorAuthorizationGlobalId
      && authorization.cancelReason === action.reason
      && authorization.cancelRefundMethod === (action.refundMethod || 'none')
      && authorization.cancelRestock === (action.restock ?? false)
      && authorization.cancelNotifyCustomer
        === (action.notifyCustomer ?? false)
      && authorization.staffNoteHash === shopifyOrderManagementEvidenceHash({
        schema: 'shopify-order-management-staff-note-v1',
        staffNote: action.staffNote,
      })
  }
  if (action.type === 'save_order') {
    return authorization.requestedProjectionHash !== null
      && authorization.requestedProjectionHash.length === 64
  }
  return authorization.lineItemGid === action.lineItemGid
    && authorization.requestedQuantity === action.quantity
    && authorization.staffNoteHash === shopifyOrderManagementEvidenceHash({
      schema: 'shopify-order-management-staff-note-v1',
      staffNote: action.staffNote,
    })
}

async function localResult(input: {
  organizationId: string
  authorization: ShopifyOrderManagementAuthorization
  state: 'succeeded' | 'failed' | 'unknown' | 'reconciled'
  replayed: boolean
  providerReads: number
}) {
  const target = await exactTarget({
    organizationId: input.organizationId,
    orderGlobalId: input.authorization.orderGlobalId,
  })
  return Object.freeze({
    authorizationGlobalId: input.authorization.authorizationGlobalId,
    attemptGlobalId: input.authorization.providerAttemptGlobalId || '',
    state: input.state,
    providerReference: input.authorization.providerReference,
    replayed: input.replayed,
    providerReads: input.providerReads,
    providerWrites: input.authorization.providerWriteCount,
    management: publicState({
      target,
      preview: placeholderPreview(target),
      grantedScopes: [],
      runtimeAvailable: targetReadBlocker(target) === null,
      blockerCode: targetReadBlocker(target),
      authorization: input.authorization,
    }),
  })
}

export async function executeShopifyOrderManagementCommand(input: {
  organizationId: string
  actorEmail: string
  authorizationGlobalId: string
  intentHash: string
  confirmationStatement: string
  mutation: ShopifyOrderManagementMutation
  reason: string
  idempotencyKey: string
}) {
  let authorization = await readShopifyOrderManagementAuthorizationInPostgres({
    organizationId: input.organizationId,
    authorizationGlobalId: input.authorizationGlobalId,
  })
  if (!authorization) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_NOT_FOUND',
      'The Shopify order authorization was not found',
      404,
    )
  }
  const action = providerAction(input.mutation, input.reason)
  if (
    !SHA256.test(input.intentHash)
    || authorization.intentHash !== input.intentHash
    || authorization.authorizationReason !== input.reason
    || !actionMatchesMutation(authorization, action)
    || confirmationStatement(authorization) !== input.confirmationStatement
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_MISMATCH',
      'The exact mutation, reason, or typed confirmation changed after preparation',
    )
  }
  if (
    authorization.status === 'processing'
    && authorization.providerAttemptGlobalId
  ) {
    const recovery = await recoverStaleShopifyOrderManagementAttemptInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      authorizationGlobalId: authorization.authorizationGlobalId,
      providerAttemptGlobalId: authorization.providerAttemptGlobalId,
    })
    if (!recovery.recovered) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_PROCESSING',
        'The Shopify provider attempt is still processing',
        409,
      )
    }
    authorization = recovery.authorization
  }
  if (authorization.status === 'processing') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_PROCESSING',
      'The Shopify provider attempt is still processing',
      409,
    )
  }
  if (authorization.status !== 'prepared') {
    const state = authorization.status === 'expired'
        ? null
        : authorization.status
    if (!state) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_EXPIRED',
        'The Shopify order authorization expired',
        410,
      )
    }
    return localResult({
      organizationId: input.organizationId,
      authorization,
      state,
      replayed: true,
      providerReads: 0,
    })
  }
  // Resolve and decrypt the exact current credential before committing the
  // provider-attempt row. Once claim succeeds, every adapter return is either
  // a retained terminal result or an explicitly unknown outcome.
  const target = await exactTarget({
    organizationId: input.organizationId,
    orderGlobalId: authorization.orderGlobalId,
  })
  assertProductionCancellationOnly(target, input.mutation.kind)
  const legacyRollingAuthorization =
    authorization.providerWriteControlRowVersion === null
    && authorization.providerWriteScopeDigest === null
    && authorization.legacyActivationState !== null
    && authorization.legacyActivationRevision !== null
  if (legacyRollingAuthorization) {
    assertLegacyRollingWriteAuthorized(
      authorization.accountGlobalId,
      authorization.accountEnvironment,
    )
  } else {
    assertProviderWritesEnabled(target)
  }
  const credential = await credentialFor({
    organizationId: input.organizationId,
    target,
  })
  const claimed = await claimShopifyOrderManagementInPostgres({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    authorizationGlobalId: authorization.authorizationGlobalId,
    action,
    reason: input.reason,
    expectedLineQuantity: authorization.expectedLineQuantity,
  })
  let executed: Awaited<ReturnType<typeof executeShopifyOrderManagementAction>>
  try {
    const actionInput = claimed.actionInput.type
      === 'cancel_order_after_fulfillment_reversal'
      ? (() => {
          if (!claimed.predecessorFulfillmentGid) {
            fail(
              'SHOPIFY_ORDER_POST_REVERSAL_PREDECESSOR_MISSING',
              'The exact predecessor fulfillment is unavailable',
            )
          }
          return {
            ...claimed.actionInput,
            reversedFulfillmentGid: claimed.predecessorFulfillmentGid,
          }
        })()
      : claimed.actionInput
    executed = await executeShopifyOrderManagementAction({
      credential,
      expected: {
        shopId: claimed.externalAccountId,
        shopDomain: claimed.shopDomain,
        orderGid: claimed.externalOrderId,
        orderName: claimed.orderNumber,
        updatedAt: claimed.providerOrderUpdatedAt,
      },
      action: actionInput,
      cancellationPaymentEvidenceMatches: [
        'cancel', 'cancel_order_after_fulfillment_reversal',
      ].includes(claimed.action)
        ? (evidence) => (
            shopifyOrderManagementCancellationPaymentEvidenceMatchesSnapshot(
              claimed,
              evidence,
            )
          )
        : undefined,
    })
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    const errorCode = error instanceof Error && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : 'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_UNKNOWN'
    // The adapter throws only before its first mutation. Once it dispatches a
    // mutation it returns succeeded/rejected/outcomeUnknown instead, so this
    // failure is provably a zero-write terminal outcome.
    const retained = await recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      authorizationGlobalId: claimed.authorizationGlobalId,
      providerAttemptGlobalId: claimed.providerAttemptGlobalId,
      outcome: 'failed',
      evidence: {
        stage: 'adapter_rejected_before_dispatch',
        errorCode,
        attemptHash: claimed.attemptHash,
      },
      errorCode: /^[A-Z][A-Z0-9_]{1,127}$/u.test(errorCode)
        ? errorCode : 'SHOPIFY_ORDER_MANAGEMENT_PRE_DISPATCH_FAILED',
      providerWriteCount: 0,
    })
    return localResult({
      organizationId: input.organizationId,
      authorization: retained,
      state: 'failed',
      replayed: false,
      providerReads: 0,
    })
  }
  const outcome = executed.outcome === 'succeeded'
    ? 'succeeded' as const
    : executed.outcome === 'rejected'
      ? 'failed' as const
      : 'unknown' as const
  const retained = await recordShopifyOrderManagementOutcomeInPostgres({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    authorizationGlobalId: claimed.authorizationGlobalId,
    providerAttemptGlobalId: claimed.providerAttemptGlobalId,
    outcome,
    evidence: {
      schema: 'shopify-order-management-execution-v1',
      action: executed.action,
      predecessorAuthorizationGlobalId:
        claimed.predecessorAuthorizationGlobalId,
      attemptHash: claimed.attemptHash,
      beforeUpdatedAt: executed.before.updatedAt,
      afterUpdatedAt: executed.after?.updatedAt || null,
      providerMutationAttempted: executed.providerMutationAttempted,
      providerWritesKnown: executed.providerWritesKnown,
      providerReference: executed.providerReference,
      errorCode: executed.errorCode,
    },
    providerReference: executed.providerReference,
    errorCode: executed.errorCode,
    providerWriteCount: executed.providerWrites,
  })
  return Object.freeze({
    authorizationGlobalId: retained.authorizationGlobalId,
    attemptGlobalId: retained.providerAttemptGlobalId || '',
    state: outcome,
    providerReference: retained.providerReference,
    replayed: false,
    providerReads: executed.providerReads,
    providerWrites: retained.providerWriteCount,
    management: publicState({
      target,
      preview: executed.after || executed.before,
      grantedScopes: executed.probe.grantedScopes,
      runtimeAvailable: true,
      blockerCode: null,
      authorization: retained,
    }),
  })
}

export async function reconcileShopifyOrderManagementCommand(input: {
  organizationId: string
  actorEmail: string
  attemptGlobalId: string
  idempotencyKey: string
}) {
  let authorization = await readShopifyOrderManagementAuthorizationByAttemptInPostgres({
    organizationId: input.organizationId,
    attemptGlobalId: input.attemptGlobalId,
  })
  if (!authorization || !authorization.providerAttemptGlobalId) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_NOT_FOUND',
      'The Shopify provider attempt was not found',
      404,
    )
  }
  if (authorization.status === 'processing') {
    const recovery = await recoverStaleShopifyOrderManagementAttemptInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      authorizationGlobalId: authorization.authorizationGlobalId,
      providerAttemptGlobalId: authorization.providerAttemptGlobalId,
    })
    if (!recovery.recovered) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_PROCESSING',
        'The Shopify provider attempt is still processing',
        409,
      )
    }
    authorization = recovery.authorization
  }
  if (authorization.status === 'processing') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_PROCESSING',
      'The Shopify provider attempt is still processing',
      409,
    )
  }
  if (authorization.status !== 'unknown') {
    const state = authorization.status === 'expired' || authorization.status === 'prepared'
        ? null
        : authorization.status
    if (!state) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_RECONCILIATION_INVALID',
        'This Shopify attempt has no reconcilable provider outcome',
      )
    }
    return localResult({
      organizationId: input.organizationId,
      authorization,
      state,
      replayed: true,
      providerReads: 0,
    })
  }
  const target = await exactTarget({
    organizationId: input.organizationId,
    orderGlobalId: authorization.orderGlobalId,
  })
  assertReconciliationTarget(target, authorization)
  const jobGid = [
    'cancel', 'cancel_order_after_fulfillment_reversal',
  ].includes(authorization.action)
    && authorization.providerReference
    && JOB_GID.test(authorization.providerReference)
      ? authorization.providerReference
      : undefined
  const live = await inspect({
    organizationId: input.organizationId,
    target,
    jobGid,
  })
  let resolution: 'applied' | 'not_applied' | null = null
  if (authorization.action === 'add_tag' && authorization.tagHash) {
    const present = live.inspected.preview.tags.some((tag) => (
      shopifyOrderManagementEvidenceHash({
        schema: 'shopify-order-management-tag-v1',
        tag,
      }) === authorization.tagHash
    ))
    if (present) resolution = 'applied'
  } else if (
    authorization.action === 'save_order'
    && authorization.requestedProjectionHash
    && shopifyOrderManagementProjectionHash(live.inspected.preview)
      === authorization.requestedProjectionHash
  ) {
    resolution = 'applied'
  } else if ([
    'cancel', 'cancel_order_after_fulfillment_reversal',
  ].includes(authorization.action)) {
    const paymentEvidence = boundCancellationPaymentEvidence(
      authorization,
      live.inspected.preview,
    )
    if (
      paymentEvidence
      && live.inspected.preview.cancelledAt
      && shopifyOrderCancellationPaymentReleased(
        live.inspected.preview,
        paymentEvidence,
      )
    ) {
      resolution = 'applied'
    }
  } else if (
    authorization.action === 'cancel_fulfillment'
    && authorization.fulfillmentGid
  ) {
    const fulfillment = live.inspected.preview.fulfillments.find(
      (candidate) => candidate.id === authorization.fulfillmentGid,
    )
    if (fulfillment?.status === 'CANCELLED') resolution = 'applied'
  } else if (
    authorization.action === 'set_line_quantity'
    && authorization.lineItemGid
    && authorization.requestedQuantity !== null
  ) {
    const line = live.inspected.preview.lines.find(
      (candidate) => candidate.id === authorization.lineItemGid,
    )
    if (line?.currentQuantity === authorization.requestedQuantity) {
      resolution = 'applied'
    }
  }
  if (!resolution) {
    return Object.freeze({
      authorizationGlobalId: authorization.authorizationGlobalId,
      attemptGlobalId: authorization.providerAttemptGlobalId,
      state: 'unknown' as const,
      providerReference: authorization.providerReference,
      replayed: false,
      providerReads: live.inspected.providerReads,
      providerWrites: authorization.providerWriteCount,
      management: publicState({
        target,
        preview: live.inspected.preview,
        grantedScopes: live.inspected.grantedScopes,
        runtimeAvailable: true,
        blockerCode: null,
        authorization,
      }),
    })
  }
  const retained = await reconcileShopifyOrderManagementOutcomeInPostgres({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    authorizationGlobalId: authorization.authorizationGlobalId,
    providerAttemptGlobalId: authorization.providerAttemptGlobalId,
    resolution,
    evidence: {
      schema: 'shopify-order-management-read-reconciliation-v1',
      action: authorization.action,
      predecessorAuthorizationGlobalId:
        authorization.predecessorAuthorizationGlobalId,
      providerOrderUpdatedAt: live.inspected.preview.updatedAt,
      cancelledAt: live.inspected.preview.cancelledAt,
      fulfillmentId: authorization.fulfillmentGid,
      observedFulfillmentStatus: authorization.fulfillmentGid
        ? live.inspected.preview.fulfillments.find(
            (fulfillment) => (
              fulfillment.id === authorization.fulfillmentGid
            ),
          )?.status ?? null
        : null,
      requestedQuantity: authorization.requestedQuantity,
      requestedProjectionHash: authorization.requestedProjectionHash,
      observedProjectionHash: authorization.action === 'save_order'
        ? shopifyOrderManagementProjectionHash(live.inspected.preview)
        : null,
      observedQuantity: authorization.lineItemGid
        ? live.inspected.preview.lines.find(
            (line) => line.id === authorization.lineItemGid,
          )?.currentQuantity ?? null
        : null,
      job: live.inspected.job,
    },
    providerReference: authorization.providerReference,
    providerWriteCount: authorization.providerWriteCount,
  })
  return Object.freeze({
    authorizationGlobalId: retained.authorizationGlobalId,
    attemptGlobalId: retained.providerAttemptGlobalId || '',
    state: 'reconciled' as const,
    providerReference: retained.providerReference,
    replayed: false,
    providerReads: live.inspected.providerReads,
    providerWrites: retained.providerWriteCount,
    management: publicState({
      target,
      preview: live.inspected.preview,
      grantedScopes: live.inspected.grantedScopes,
      runtimeAvailable: true,
      blockerCode: null,
      authorization: retained,
    }),
  })
}
