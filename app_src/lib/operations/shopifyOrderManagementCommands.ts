import {
  decryptCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import { hasEffectiveShopifyScope } from '@/lib/integrations/commerceCapabilities'
import {
  executeShopifyOrderManagementAction,
  inspectShopifyOrderManagementTarget,
  type ShopifyOrderManagementAction,
  type ShopifyOrderManagementPreview,
} from '@/lib/integrations/shopifyOrderManagement'
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
  shopifyOrderManagementEvidenceHash,
  type ShopifyOrderManagementAuthorization,
  type ShopifyOrderManagementTarget,
} from '@/lib/persistence/shopifyOrderManagement'
import { readCommerceRuntimeCredentialFromPostgres } from '@/lib/persistence/commerceIntegrations'

const SHA256 = /^[a-f0-9]{64}$/u
const JOB_GID = /^gid:\/\/shopify\/Job\/[A-Za-z0-9][A-Za-z0-9-]*$/u

export type ShopifyOrderManagementMutation =
  | Readonly<{ kind: 'add_tag'; tag: string }>
  | Readonly<{ kind: 'cancel' }>
  | Readonly<{
      kind: 'set_line_quantity'
      lineItemId: string
      quantity: number
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

function staffNote(reason: string) {
  return `ClawPilot authorized test action: ${reason}`.slice(0, 255)
}

function providerAction(
  mutation: ShopifyOrderManagementMutation,
  reason: string,
): ShopifyOrderManagementAction {
  if (mutation.kind === 'add_tag') {
    return { type: 'add_tag', tag: mutation.tag }
  }
  if (mutation.kind === 'cancel') {
    return {
      type: 'cancel',
      reason: 'STAFF',
      staffNote: staffNote(reason),
    }
  }
  return {
    type: 'set_line_quantity',
    lineItemGid: mutation.lineItemId,
    quantity: mutation.quantity,
    staffNote: staffNote(reason),
  }
}

function confirmationStatement(authorization: ShopifyOrderManagementAuthorization) {
  return [
    'AUTHORIZE SHOPIFY WRITE',
    authorization.authorizationGlobalId,
    authorization.action.toUpperCase(),
    authorization.orderNumber,
  ].join(' ')
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

function targetBlocker(target: ShopifyOrderManagementTarget) {
  if (target.accountEnvironment !== 'sandbox') {
    return 'SHOPIFY_ORDER_MANAGEMENT_SANDBOX_ACCOUNT_REQUIRED'
  }
  if (!target.credentialCurrent) {
    return 'SHOPIFY_ORDER_MANAGEMENT_CREDENTIAL_NOT_CURRENT'
  }
  if (target.activationState !== 'shadow' && target.activationState !== 'active') {
    return 'SHOPIFY_ORDER_MANAGEMENT_ACTIVATION_REQUIRED'
  }
  if (
    target.orderStatus !== 'imported'
    || !target.zeroDownstream
    || !target.sourceHash
  ) {
    return 'SHOPIFY_ORDER_MANAGEMENT_UNSTARTED_ORDER_REQUIRED'
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

function assertRuntimeWriteAuthorized(accountGlobalId: string) {
  const runtime = shopifyOrderManagementRuntime()
  if (
    !runtime.available
    || !shopifyOrderManagementAccountAllowed(accountGlobalId)
  ) {
    fail(
      runtime.blockerCode || 'SHOPIFY_ORDER_MANAGEMENT_ACCOUNT_NOT_ALLOWLISTED',
      'Shopify test-order writes are not enabled for this development account',
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
    || runtime.environment !== 'sandbox'
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== input.target.credentialGeneration
    || runtime.externalAccountId !== input.target.externalAccountId
    || !input.target.shopDomain
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_CREDENTIAL_NOT_CURRENT',
      'The exact Shopify sandbox credential is unavailable',
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
      'The exact Shopify sandbox credential is unavailable',
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
    note: null,
    tags: [],
    lines: [],
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
  const targetReason = targetBlocker(input.target)
  const unresolved = openAttempt(
    input.authorization === undefined
      ? input.target.latestOpenAuthorization
      : input.authorization,
  )
  const baseReason = input.blockerCode || targetReason || (
    unresolved
      ? 'Resolve the existing Shopify provider attempt first'
      : null
  )
  const writeOrders = hasEffectiveShopifyScope(
    input.grantedScopes,
    'write_orders',
  )
  const writeOrderEdits = hasEffectiveShopifyScope(
    input.grantedScopes,
    'write_order_edits',
  )
  const addTagReason = baseReason || (!writeOrders
    ? 'The Shopify connection is missing write_orders'
    : null)
  const destructiveCurrent = exactCurrentSource(input.target)
    && Boolean(input.target.acceptedProviderUpdatedAt)
    && input.target.acceptedProviderUpdatedAt === input.preview.updatedAt
  const cancellationReason = baseReason
    || (!writeOrders ? 'The Shopify connection is missing write_orders' : null)
    || (!destructiveCurrent
      ? 'Refresh and accept the current provider revision before changing order state'
      : null)
    || (!input.preview.test
      ? 'Cancellation is limited to Shopify test orders'
      : null)
    || (input.preview.cancelledAt !== null
      ? 'The Shopify order is already cancelled'
      : null)
    || (input.preview.closed ? 'The Shopify order is closed' : null)
    || (!input.preview.unpaid || input.preview.capturable
      ? 'Cancellation is limited to unpaid orders without a payment authorization'
      : null)
    || (input.preview.returnStatus !== 'NO_RETURN'
      ? 'The Shopify order has return activity'
      : null)
    || (!whollyUnfulfilled(input.preview)
      ? 'Cancellation requires every line to be wholly unfulfilled'
      : null)
  const lineBaseReason = baseReason
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
    }),
    eligibility: Object.freeze({
      addTag: Object.freeze({ allowed: addTagReason === null, reason: addTagReason }),
      cancel: Object.freeze({
        allowed: cancellationReason === null,
        reason: cancellationReason,
      }),
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
    jobGid: input.jobGid,
  })
  return { credential, observedAt, inspected }
}

export async function readShopifyOrderManagementState(input: {
  organizationId: string
  orderGlobalId: string
}) {
  const target = await exactTarget(input)
  const runtime = shopifyOrderManagementRuntime()
  const accountAllowed = shopifyOrderManagementAccountAllowed(
    target.accountGlobalId,
  )
  const blockerCode = !runtime.available
    ? runtime.blockerCode
    : !accountAllowed
      ? 'SHOPIFY_ORDER_MANAGEMENT_ACCOUNT_NOT_ALLOWLISTED'
      : targetBlocker(target)
  if (blockerCode) {
    return publicState({
      target,
      preview: placeholderPreview(target),
      grantedScopes: [],
      runtimeAvailable: false,
      blockerCode,
    })
  }
  const live = await inspect({ organizationId: input.organizationId, target })
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
  assertRuntimeWriteAuthorized(target.accountGlobalId)
  const action = providerAction(input.mutation, input.reason)
  const live = await inspect({
    organizationId: input.organizationId,
    target,
    requiredActions: [action.type],
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
    expectedLineQuantity,
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
      lineItemId: authorization.lineItemGid,
      previousQuantity: authorization.expectedLineQuantity,
      requestedQuantity: authorization.requestedQuantity,
    }),
    replayed: authorization.replayed,
    providerReads: live.inspected.providerReads,
    providerWrites: 0 as const,
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
      && authorization.staffNoteHash === shopifyOrderManagementEvidenceHash({
        schema: 'shopify-order-management-staff-note-v1',
        staffNote: action.staffNote,
      })
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
  const runtime = shopifyOrderManagementRuntime()
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
      runtimeAvailable: runtime.available,
      blockerCode: runtime.available ? null : runtime.blockerCode,
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
  // Preparation is intentionally short-lived, but runtime authority remains
  // revocable. Re-check the development-only flag and exact account allowlist
  // immediately before creating a durable provider attempt. A prepared row
  // must never outlive an operator disabling this proving lane.
  assertRuntimeWriteAuthorized(authorization.accountGlobalId)
  // Resolve and decrypt the exact current credential before committing the
  // provider-attempt row. Once claim succeeds, every adapter return is either
  // a retained terminal result or an explicitly unknown outcome.
  const target = await exactTarget({
    organizationId: input.organizationId,
    orderGlobalId: authorization.orderGlobalId,
  })
  const credential = await credentialFor({
    organizationId: input.organizationId,
    target,
  })
  // Keep revocation effective across the credential-resolution window. A
  // disabled flag or removed exact-account allowlist entry must win before the
  // transaction creates its immutable provider-attempt row.
  assertRuntimeWriteAuthorized(authorization.accountGlobalId)
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
    executed = await executeShopifyOrderManagementAction({
      credential,
      expected: {
        shopId: claimed.externalAccountId,
        shopDomain: claimed.shopDomain,
        orderGid: claimed.externalOrderId,
        orderName: claimed.orderNumber,
        updatedAt: claimed.providerOrderUpdatedAt,
      },
      action: claimed.actionInput,
    })
  } catch (error) {
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
  const jobGid = authorization.action === 'cancel'
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
  } else if (authorization.action === 'cancel') {
    if (live.inspected.preview.cancelledAt) resolution = 'applied'
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
      providerOrderUpdatedAt: live.inspected.preview.updatedAt,
      cancelledAt: live.inspected.preview.cancelledAt,
      requestedQuantity: authorization.requestedQuantity,
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
