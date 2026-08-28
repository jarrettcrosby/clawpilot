'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import CancelRounded from '@mui/icons-material/CancelRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'

type MutationKind = 'add_tag' | 'cancel_fulfillment' | 'cancel'
  | 'cancel_order_after_fulfillment_reversal'
  | 'set_line_quantity' | 'save_order'
type ShopifyLine = Readonly<{
  lineItemId: string
  title: string
  quantity: number
  unfulfilledQuantity: number
  fulfilledQuantity: number
}>
type LineEligibility = Readonly<{
  lineItemId: string
  allowed: boolean
  reason: string | null
  minQuantity: number
  maxQuantity: number
}>
type ShopifyFulfillment = Readonly<{
  fulfillmentId: string
  name: string
  status: string
  displayStatus: string | null
  updatedAt: string
  deliveredAt: string | null
  quantity: number
  tracking: Array<Readonly<{
    company: string | null
    number: string | null
    url: string | null
  }>>
}>
type FulfillmentEligibility = Readonly<{
  fulfillmentId: string
  expectedUpdatedAt: string
  allowed: boolean
  reason: string | null
}>
type CancellationEligibility = Readonly<{
  allowed: boolean
  reason: string | null
  releasesAuthorization: boolean
}>
type CancellationPaymentOption = Readonly<{
  allowed: boolean
  reason: string | null
  releasesAuthorization: boolean
}>
type ShopifyMoney = Readonly<{
  amount: string
  currencyCode: string
}>
type PostReversalCancellationEligibility = Readonly<{
  allowed: boolean
  reason: string | null
  releasesAuthorization: boolean
  predecessorAuthorizationGlobalId: string | null
}>
type ShopifyShippingAddress = Readonly<{
  firstName: string | null
  lastName: string | null
  company: string | null
  address1: string | null
  address2: string | null
  city: string | null
  provinceCode: string | null
  countryCode: string | null
  zip: string | null
  phone: string | null
}>
type ShippingAddressDraft = {
  firstName: string
  lastName: string
  company: string
  address1: string
  address2: string
  city: string
  provinceCode: string
  countryCode: string
  zip: string
  phone: string
}
type OpenAttempt = Readonly<{
  attemptGlobalId: string
  authorizationGlobalId: string
  intentHash: string
  state: 'processing' | 'unknown'
  actionKind: MutationKind
  providerReference: string | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
  providerWrites: number | null
}>
type ShopifyManagement = Readonly<{
  runtimeAvailable: boolean
  blockerCode: string | null
  accountLabel: string
  shopDomain: string
  payment: Readonly<{
    totalReceived: ShopifyMoney
    totalRefunded: ShopifyMoney
    totalCapturable: ShopifyMoney
    refundOptions: Readonly<{
      none: CancellationPaymentOption
      original_payment_methods: CancellationPaymentOption
    }>
  }>
  order: Readonly<{
    globalId: string
    externalOrderId: string
    name: string
    rowVersion: number
    test: boolean
    closed: boolean
    cancelledAt: string | null
    financialStatus: string | null
    fulfillmentStatus: string | null
    merchantEditable: boolean
    email: string | null
    phone: string | null
    poNumber: string | null
    note: string | null
    shippingAddress: ShopifyShippingAddress | null
    tags: string[]
    lines: ShopifyLine[]
    fulfillments: ShopifyFulfillment[]
  }>
  eligibility: Readonly<{
    addTag: Readonly<{ allowed: boolean; reason: string | null }>
    ordinarySave: Readonly<{ allowed: boolean; reason: string | null }>
    cancel: CancellationEligibility
    cancelAfterFulfillmentReversal: PostReversalCancellationEligibility
    fulfillments: FulfillmentEligibility[]
    lineEdits: LineEligibility[]
  }>
  openAttempt?: OpenAttempt | null
}>
type ShopifyMutation = Readonly<{ kind: 'add_tag'; tag: string }>
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
      reasonCode: 'CUSTOMER' | 'DECLINED' | 'FRAUD'
        | 'INVENTORY' | 'OTHER' | 'STAFF'
      refundMethod: 'none' | 'original_payment_methods'
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
      shippingAddress: ShopifyShippingAddress | null
      tagAdds: string[]
      tagRemoves: string[]
      lineQuantities: Array<{
        lineItemId: string
        quantity: number
      }>
    }>
type ManagementResult = Readonly<{
  authorizationGlobalId: string
  attemptGlobalId: string
  state: 'succeeded' | 'failed' | 'unknown' | 'reconciled'
  providerReference: string | null
  replayed: boolean
  providerReads: number
  providerWrites: number | null
  management: ShopifyManagement
}>
type ManagementPayload = Readonly<{
  ok?: boolean
  error?: string
  code?: string
  management?: ShopifyManagement
  result?: ManagementResult
  authorization?: PreparedAuthorization
}>
type PreparedAuthorization = Readonly<{
  authorizationGlobalId: string
  intentHash: string
  expiresAt: string
  confirmationStatement: string
  replayed: boolean
  providerReads: number
  providerWrites: 0
}>
type IdempotencyAttempt = { fingerprint: string; key: string }

const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const AUTHORIZATION_GLOBAL_ID = /^gsom(?:[0-9]{7}|[0-9a-v]{12})$/
const ATTEMPT_GLOBAL_ID = /^gsoa(?:[0-9]{7}|[0-9a-v]{12})$/
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,20}$/
const SHOPIFY_LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]{0,20}$/
const SHOPIFY_FULFILLMENT_GID =
  /^gid:\/\/shopify\/Fulfillment\/[1-9][0-9]{0,20}$/
const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/
const SHA256 = /^[a-f0-9]{64}$/
const COUNTRY_CODE = /^[A-Z]{2}$/
const CURRENCY_CODE = /^(?:[A-Z]{3}|USDC)$/
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const EMPTY_SHIPPING_ADDRESS: ShippingAddressDraft = {
  firstName: '',
  lastName: '',
  company: '',
  address1: '',
  address2: '',
  city: '',
  provinceCode: '',
  countryCode: '',
  zip: '',
  phone: '',
}

function idempotencyKey(
  action: 'save' | 'prepare' | 'execute' | 'reconcile',
  exactId: string,
) {
  const nonce = typeof crypto !== 'undefined'
    && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `shopify-order-management:${action}:${exactId}:${nonce}`
}

function stableAttemptKey(
  reference: MutableRefObject<IdempotencyAttempt | null>,
  fingerprint: string,
  action: 'save' | 'prepare' | 'execute' | 'reconcile',
  exactId: string,
) {
  if (reference.current?.fingerprint !== fingerprint) {
    reference.current = {
      fingerprint,
      key: idempotencyKey(action, exactId),
    }
  }
  return reference.current.key
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function optionalText(value: unknown): value is string | null {
  return value === null || text(value)
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
function shopifyMoney(value: unknown): value is ShopifyMoney {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ShopifyMoney>
  return typeof item.amount === 'string'
    && NONNEGATIVE_DECIMAL.test(item.amount)
    && typeof item.currencyCode === 'string'
    && CURRENCY_CODE.test(item.currencyCode)
}
function cancellationPaymentOption(
  value: unknown,
): value is CancellationPaymentOption {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<CancellationPaymentOption>
  return typeof item.allowed === 'boolean'
    && optionalText(item.reason)
    && typeof item.releasesAuthorization === 'boolean'
}
function isoInstant(value: unknown): value is string {
  if (!text(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}
function shippingAddress(value: unknown): value is ShopifyShippingAddress | null {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const address = value as Partial<ShopifyShippingAddress>
  return [
    address.firstName,
    address.lastName,
    address.company,
    address.address1,
    address.address2,
    address.city,
    address.provinceCode,
    address.zip,
    address.phone,
  ].every((field) => field === null || typeof field === 'string')
    && (address.countryCode === null || (
      typeof address.countryCode === 'string'
      && COUNTRY_CODE.test(address.countryCode)
    ))
}
function addressDraft(
  value: ShopifyShippingAddress | null,
): ShippingAddressDraft {
  if (!value) return { ...EMPTY_SHIPPING_ADDRESS }
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [
    key,
    field || '',
  ])) as ShippingAddressDraft
}
function addressMutation(
  value: ShippingAddressDraft,
  hadAddress: boolean,
): ShopifyShippingAddress | null {
  const hasValue = Object.values(value).some((field) => field.length > 0)
  if (!hadAddress && !hasValue) return null
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, field || null]),
  )) as ShopifyShippingAddress
}
function line(value: unknown): value is ShopifyLine {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ShopifyLine>
  return typeof item.lineItemId === 'string'
    && SHOPIFY_LINE_ITEM_GID.test(item.lineItemId)
    && text(item.title)
    && integer(item.quantity) && item.quantity >= 0
    && integer(item.unfulfilledQuantity) && item.unfulfilledQuantity >= 0
    && integer(item.fulfilledQuantity) && item.fulfilledQuantity >= 0
}
function lineEligibility(value: unknown): value is LineEligibility {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<LineEligibility>
  return typeof item.lineItemId === 'string'
    && SHOPIFY_LINE_ITEM_GID.test(item.lineItemId)
    && typeof item.allowed === 'boolean'
    && optionalText(item.reason)
    && integer(item.minQuantity) && item.minQuantity >= 0
    && integer(item.maxQuantity) && item.maxQuantity >= item.minQuantity
}
function trackingUrl(value: string | null) {
  if (value === null) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
function fulfillment(value: unknown): value is ShopifyFulfillment {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ShopifyFulfillment>
  return typeof item.fulfillmentId === 'string'
    && SHOPIFY_FULFILLMENT_GID.test(item.fulfillmentId)
    && text(item.name)
    && text(item.status)
    && optionalText(item.displayStatus)
    && isoInstant(item.updatedAt)
    && optionalText(item.deliveredAt)
    && (item.deliveredAt === null || isoInstant(item.deliveredAt))
    && integer(item.quantity) && item.quantity >= 0
    && Array.isArray(item.tracking)
    && item.tracking.length <= 20
    && item.tracking.every((tracking) => (
      optionalText(tracking.company)
      && optionalText(tracking.number)
      && optionalText(tracking.url)
      && trackingUrl(tracking.url)
    ))
}
function fulfillmentEligibility(
  value: unknown,
): value is FulfillmentEligibility {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<FulfillmentEligibility>
  return typeof item.fulfillmentId === 'string'
    && SHOPIFY_FULFILLMENT_GID.test(item.fulfillmentId)
    && isoInstant(item.expectedUpdatedAt)
    && typeof item.allowed === 'boolean'
    && optionalText(item.reason)
}
function openAttempt(value: unknown): value is OpenAttempt {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<OpenAttempt>
  return typeof item.attemptGlobalId === 'string'
    && ATTEMPT_GLOBAL_ID.test(item.attemptGlobalId)
    && typeof item.authorizationGlobalId === 'string'
    && AUTHORIZATION_GLOBAL_ID.test(item.authorizationGlobalId)
    && typeof item.intentHash === 'string' && SHA256.test(item.intentHash)
    && (item.state === 'processing' || item.state === 'unknown')
    && [
      'add_tag', 'cancel_fulfillment',
      'cancel_order_after_fulfillment_reversal', 'cancel',
      'set_line_quantity', 'save_order',
    ].includes(item.actionKind || '')
    && optionalText(item.providerReference)
    && optionalText(item.errorCode)
    && text(item.createdAt) && !Number.isNaN(Date.parse(item.createdAt))
    && text(item.updatedAt) && !Number.isNaN(Date.parse(item.updatedAt))
    && (item.providerWrites === null || (
      integer(item.providerWrites)
      && item.providerWrites >= 0
      && item.providerWrites <= 253
    ))
}
function management(value: unknown, orderGlobalId: string): value is ShopifyManagement {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ShopifyManagement>
  const order = item.order as Partial<ShopifyManagement['order']> | undefined
  const eligibility = item.eligibility as
    Partial<ShopifyManagement['eligibility']> | undefined
  const payment = item.payment as
    Partial<ShopifyManagement['payment']> | undefined
  const lines = Array.isArray(order?.lines) ? order.lines : []
  const edits = Array.isArray(eligibility?.lineEdits)
    ? eligibility.lineEdits
    : []
  const fulfillments = Array.isArray(order?.fulfillments)
    ? order.fulfillments
    : []
  const fulfillmentEligibilityItems = Array.isArray(
    eligibility?.fulfillments,
  ) ? eligibility.fulfillments : []
  return typeof item.runtimeAvailable === 'boolean'
    && optionalText(item.blockerCode)
    && text(item.accountLabel)
    && typeof item.shopDomain === 'string' && SHOPIFY_DOMAIN.test(item.shopDomain)
    && shopifyMoney(payment?.totalReceived)
    && shopifyMoney(payment?.totalRefunded)
    && shopifyMoney(payment?.totalCapturable)
    && cancellationPaymentOption(payment?.refundOptions?.none)
    && cancellationPaymentOption(
      payment?.refundOptions?.original_payment_methods,
    )
    && order?.globalId === orderGlobalId && ORDER_GLOBAL_ID.test(orderGlobalId)
    && typeof order.externalOrderId === 'string'
    && SHOPIFY_ORDER_GID.test(order.externalOrderId)
    && text(order.name)
    && integer(order.rowVersion) && order.rowVersion >= 0
    && typeof order.test === 'boolean'
    && typeof order.closed === 'boolean'
    && optionalText(order.cancelledAt)
    && optionalText(order.financialStatus)
    && optionalText(order.fulfillmentStatus)
    && typeof order.merchantEditable === 'boolean'
    && (order.email === null || typeof order.email === 'string')
    && (order.phone === null || typeof order.phone === 'string')
    && (order.poNumber === null || typeof order.poNumber === 'string')
    && (order.note === null || typeof order.note === 'string')
    && shippingAddress(order.shippingAddress)
    && Array.isArray(order.tags) && order.tags.every(text)
    && lines.every(line)
    && fulfillments.length <= 50
    && fulfillments.every(fulfillment)
    && typeof eligibility?.addTag?.allowed === 'boolean'
    && optionalText(eligibility.addTag.reason)
    && typeof eligibility?.ordinarySave?.allowed === 'boolean'
    && optionalText(eligibility.ordinarySave.reason)
    && typeof eligibility?.cancel?.allowed === 'boolean'
    && optionalText(eligibility.cancel.reason)
    && typeof eligibility.cancel.releasesAuthorization === 'boolean'
    && typeof eligibility?.cancelAfterFulfillmentReversal?.allowed === 'boolean'
    && optionalText(eligibility.cancelAfterFulfillmentReversal.reason)
    && typeof eligibility.cancelAfterFulfillmentReversal
      .releasesAuthorization === 'boolean'
    && (
      eligibility.cancelAfterFulfillmentReversal
        .predecessorAuthorizationGlobalId === null
      || (
        typeof eligibility.cancelAfterFulfillmentReversal
          .predecessorAuthorizationGlobalId === 'string'
        && AUTHORIZATION_GLOBAL_ID.test(
          eligibility.cancelAfterFulfillmentReversal
            .predecessorAuthorizationGlobalId,
        )
      )
    )
    && (
      eligibility.cancelAfterFulfillmentReversal.allowed !== true
      || eligibility.cancelAfterFulfillmentReversal
        .predecessorAuthorizationGlobalId !== null
    )
    && fulfillmentEligibilityItems.length <= 50
    && fulfillmentEligibilityItems.every(fulfillmentEligibility)
    && fulfillmentEligibilityItems.length === fulfillments.length
    && new Set(fulfillments.map((fulfillment) => (
      fulfillment.fulfillmentId
    ))).size === fulfillments.length
    && new Set(fulfillmentEligibilityItems.map((candidate) => (
      candidate.fulfillmentId
    ))).size === fulfillmentEligibilityItems.length
    && fulfillmentEligibilityItems.every((candidate) => fulfillments.some(
      (item) => item.fulfillmentId === candidate.fulfillmentId
        && item.updatedAt === candidate.expectedUpdatedAt,
    ))
    && edits.every(lineEligibility)
    && edits.every((edit) => lines.some(
      (candidate) => candidate.lineItemId === edit.lineItemId,
    ))
    && (item.openAttempt === undefined
      || item.openAttempt === null
      || openAttempt(item.openAttempt))
}
function result(
  value: unknown,
  orderGlobalId: string,
  expectedAttemptGlobalId?: string,
): ManagementResult | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<ManagementResult>
  if (
    typeof item.authorizationGlobalId !== 'string'
    || !AUTHORIZATION_GLOBAL_ID.test(item.authorizationGlobalId)
    || typeof item.attemptGlobalId !== 'string'
    || !ATTEMPT_GLOBAL_ID.test(item.attemptGlobalId)
    || (expectedAttemptGlobalId
      && item.attemptGlobalId !== expectedAttemptGlobalId)
    || !['succeeded', 'failed', 'unknown', 'reconciled'].includes(item.state || '')
    || !optionalText(item.providerReference)
    || typeof item.replayed !== 'boolean'
    || !integer(item.providerReads) || item.providerReads < 0
    || !(item.providerWrites === null || (
      integer(item.providerWrites)
      && item.providerWrites >= 0
      && item.providerWrites <= 253
    ))
    || !management(item.management, orderGlobalId)
  ) return null
  return item as ManagementResult
}

function preparedAuthorization(value: unknown): PreparedAuthorization | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<PreparedAuthorization>
  if (
    typeof item.authorizationGlobalId !== 'string'
    || !AUTHORIZATION_GLOBAL_ID.test(item.authorizationGlobalId)
    || typeof item.intentHash !== 'string'
    || !SHA256.test(item.intentHash)
    || !isoInstant(item.expiresAt)
    || !text(item.confirmationStatement)
    || typeof item.replayed !== 'boolean'
    || !integer(item.providerReads)
    || item.providerReads < 1
    || item.providerWrites !== 0
  ) return null
  return item as PreparedAuthorization
}

function DisabledReason({ value }: { value: string | null | undefined }) {
  return value ? (
    <Typography variant="caption" color="text.secondary" display="block">
      {value}
    </Typography>
  ) : null
}

export default function ShopifyOrderManagementPanel({
  orderGlobalId,
  orderRowVersion,
  canManage,
  canCancel,
  disabled = false,
  onBusyChange,
  onOrderChanged,
}: {
  orderGlobalId: string
  orderRowVersion: number
  canManage: boolean
  canCancel: boolean
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onOrderChanged: () => void | Promise<void>
}) {
  const [state, setState] = useState<ShopifyManagement | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<
    'save' | 'prepare_cancel' | 'execute_cancel' | 'reconcile' | null
  >(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [poNumber, setPoNumber] = useState('')
  const [note, setNote] = useState('')
  const [shippingAddressDraft, setShippingAddressDraft] =
    useState<ShippingAddressDraft>({ ...EMPTY_SHIPPING_ADDRESS })
  const [tags, setTags] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [lastResult, setLastResult] = useState<ManagementResult | null>(null)
  const [ambiguousSave, setAmbiguousSave] = useState(false)
  const [reversingFulfillmentId, setReversingFulfillmentId] =
    useState<string | null>(null)
  const [cancellingAfterReversal, setCancellingAfterReversal] =
    useState(false)
  const [cancelReasonCode, setCancelReasonCode] = useState<
    'CUSTOMER' | 'DECLINED' | 'FRAUD' | 'INVENTORY' | 'OTHER' | 'STAFF'
  >('CUSTOMER')
  const [cancelRefundMethod, setCancelRefundMethod] = useState<
    '' | 'none' | 'original_payment_methods'
  >('')
  const [cancelRestock, setCancelRestock] = useState(true)
  const [cancelNotifyCustomer, setCancelNotifyCustomer] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [preparedCancel, setPreparedCancel] =
    useState<PreparedAuthorization | null>(null)
  const [cancelConfirmation, setCancelConfirmation] = useState('')
  const saveAttempt = useRef<IdempotencyAttempt | null>(null)
  const prepareCancelAttempt = useRef<IdempotencyAttempt | null>(null)
  const executeCancelAttempt = useRef<IdempotencyAttempt | null>(null)
  const reconcileAttempt = useRef<IdempotencyAttempt | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!canManage) return
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({ orderGlobalId })
      const response = await fetch(
        `/api/operations/shopify-order-management?${query.toString()}`,
        { cache: 'no-store', signal },
      )
      const payload = await response.json().catch(() => ({})) as ManagementPayload
      if (!response.ok || !payload.ok || !management(payload.management, orderGlobalId)) {
        throw new Error(
          `${payload.error || 'Shopify order details are unavailable'}`
          + `${payload.code ? ` [${payload.code}]` : ''}`,
        )
      }
      setState(payload.management)
      setAmbiguousSave(false)
      setEmail(payload.management.order.email || '')
      setPhone(payload.management.order.phone || '')
      setPoNumber(payload.management.order.poNumber || '')
      setNote(payload.management.order.note || '')
      setShippingAddressDraft(addressDraft(
        payload.management.order.shippingAddress,
      ))
      setTags(payload.management.order.tags.join(', '))
      setQuantities(Object.fromEntries(
        payload.management!.order.lines.map((item) => [
          item.lineItemId,
          String(item.quantity),
        ]),
      ))
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error
        ? caught.message
        : 'Shopify order details are unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [canManage, orderGlobalId])

  useEffect(() => {
    setState(null)
    setNotice('')
    setError('')
    setLastResult(null)
    setAmbiguousSave(false)
    setReversingFulfillmentId(null)
    setCancellingAfterReversal(false)
    setCancelRefundMethod('')
    setPreparedCancel(null)
    setCancelConfirmation('')
    saveAttempt.current = null
    prepareCancelAttempt.current = null
    executeCancelAttempt.current = null
    reconcileAttempt.current = null
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, orderRowVersion])

  useEffect(() => {
    onBusyChange?.(action !== null)
    return () => onBusyChange?.(false)
  }, [action, onBusyChange])

  useEffect(() => {
    setPreparedCancel(null)
    setCancelConfirmation('')
    prepareCancelAttempt.current = null
    executeCancelAttempt.current = null
  }, [
    cancelReasonCode,
    cancelRefundMethod,
    cancelRestock,
    cancelNotifyCustomer,
    cancelReason,
  ])

  const retainedAttempt = state?.openAttempt || null
  const stale = Boolean(state && state.order.rowVersion !== orderRowVersion)
  const blocker = !canManage
    ? 'Operations-management permission is required.'
    : !state?.runtimeAvailable
      ? `Shopify order details are unavailable${state?.blockerCode
        ? ` [${state.blockerCode}]`
        : ''}.`
      : stale
        ? 'This order changed. Refresh before saving.'
        : ambiguousSave
          ? 'The last response was interrupted. Refresh to inspect the retained attempt; do not submit the change again.'
          : retainedAttempt
            ? `Attempt ${retainedAttempt.attemptGlobalId} is ${retainedAttempt.state}. Resolve it before saving another change.`
            : null
  const busy = disabled || loading || action !== null
  const desiredTags = [...new Set(tags.split(',')
    .map((value) => value.trim())
    .filter(Boolean))]
  const tagsValid = desiredTags.length <= 250
    && desiredTags.every((value) => value.length <= 255 && !value.includes(','))
  const existingTags = state?.order.tags || []
  const tagAdds = desiredTags.filter((value) => !existingTags.includes(value))
  const tagRemoves = existingTags.filter((value) => !desiredTags.includes(value))
  const changedLineQuantities = state?.order.lines.flatMap((item) => {
    const value = quantities[item.lineItemId] ?? ''
    const entered = Number(value)
    return /^[0-9]+$/.test(value)
      && Number.isSafeInteger(entered)
      && entered !== item.quantity
      ? [{ lineItemId: item.lineItemId, quantity: entered }]
      : []
  }) || []
  const desiredShippingAddress = addressMutation(
    shippingAddressDraft,
    state?.order.shippingAddress !== null,
  )
  const shippingAddressDirty = Boolean(state) && JSON.stringify(
    desiredShippingAddress,
  ) !== JSON.stringify(state?.order.shippingAddress)
  const ordinaryDirty = Boolean(state) && (
    email !== (state?.order.email || '')
    || phone !== (state?.order.phone || '')
    || poNumber !== (state?.order.poNumber || '')
    || note !== (state?.order.note || '')
    || shippingAddressDirty
    || tagAdds.length > 0
    || tagRemoves.length > 0
    || changedLineQuantities.length > 0
  )
  const changedLinesValid = changedLineQuantities.every((change) => {
    const eligibility = state?.eligibility.lineEdits.find(
      (candidate) => candidate.lineItemId === change.lineItemId,
    )
    return Boolean(
      eligibility?.allowed
      && change.quantity >= eligibility.minQuantity
      && change.quantity <= eligibility.maxQuantity,
    )
  })
  const allLineDraftsValid = state?.order.lines.every((item) => {
    const value = quantities[item.lineItemId] ?? ''
    const entered = Number(value)
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(entered)) return false
    if (entered === item.quantity) return true
    const eligibility = state.eligibility.lineEdits.find(
      (candidate) => candidate.lineItemId === item.lineItemId,
    )
    return Boolean(
      eligibility?.allowed
      && entered >= eligibility.minQuantity
      && entered <= eligibility.maxQuantity,
    )
  }) ?? false
  const ordinaryDraftValid = email.length <= 254
    && phone.length <= 64
    && poNumber.length <= 255
    && note.length <= 5_000
    && shippingAddressDraft.firstName.length <= 255
    && shippingAddressDraft.lastName.length <= 255
    && shippingAddressDraft.company.length <= 255
    && shippingAddressDraft.address1.length <= 255
    && shippingAddressDraft.address2.length <= 255
    && shippingAddressDraft.city.length <= 255
    && shippingAddressDraft.provinceCode.length <= 64
    && (
      shippingAddressDraft.countryCode.length === 0
      || COUNTRY_CODE.test(shippingAddressDraft.countryCode)
    )
    && shippingAddressDraft.zip.length <= 64
    && shippingAddressDraft.phone.length <= 64
    && tagsValid
    && changedLinesValid
    && allLineDraftsValid
  const cancellationMutation:
    Extract<ShopifyMutation, { kind: 'cancel' }> | null = cancelRefundMethod
      ? {
          kind: 'cancel',
          reasonCode: cancelReasonCode,
          refundMethod: cancelRefundMethod,
          restock: cancelRestock,
          notifyCustomer: cancelNotifyCustomer,
        }
      : null
  const selectedCancellationPayment = cancelRefundMethod
    ? state?.payment.refundOptions[cancelRefundMethod]
    : null
  const normalizedCancelReason = cancelReason.trim()
  const cancelDraftValid = normalizedCancelReason.length >= 10
    && normalizedCancelReason.length <= 500
    && !/[\u0000-\u001f\u007f]/.test(normalizedCancelReason)
    && cancellationMutation !== null
    && selectedCancellationPayment?.allowed === true

  const save = async (mutation: ShopifyMutation) => {
    if (!state || blocker || busy) return
    const body = {
      action: 'save' as const,
      orderGlobalId,
      expectedRowVersion: state.order.rowVersion,
      mutation,
    }
    const key = stableAttemptKey(
      saveAttempt,
      JSON.stringify(body),
      'save',
      `${orderGlobalId}:v${state.order.rowVersion}`,
    )
    setAction('save')
    setError('')
    setNotice('')
    setLastResult(null)
    try {
      const response = await fetch('/api/operations/shopify-order-management', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({})) as ManagementPayload
      const saved = result(payload.result, orderGlobalId)
      if (!response.ok || !payload.ok || !saved) {
        saveAttempt.current = null
        throw new Error(
          `${payload.error || 'Shopify change could not be saved'}`
          + `${payload.code ? ` [${payload.code}]` : ''}`,
        )
      }
      setState(saved.management)
      setLastResult(saved)
      if (saved.state === 'unknown') {
        setNotice(
          `Shopify outcome is unknown for attempt ${saved.attemptGlobalId}. Reconcile that attempt; do not save it again.`,
        )
      } else if (saved.state === 'failed') {
        saveAttempt.current = null
        setError('Shopify rejected the change. Review the current order and try a new save.')
      } else {
        saveAttempt.current = null
        setEmail(saved.management.order.email || '')
        setPhone(saved.management.order.phone || '')
        setPoNumber(saved.management.order.poNumber || '')
        setNote(saved.management.order.note || '')
        setShippingAddressDraft(addressDraft(
          saved.management.order.shippingAddress,
        ))
        setTags(saved.management.order.tags.join(', '))
        setQuantities(Object.fromEntries(
          saved.management.order.lines.map((item) => [
            item.lineItemId,
            String(item.quantity),
          ]),
        ))
        setNotice(saved.replayed
          ? 'The already-completed Shopify save was loaded.'
          : mutation.kind === 'cancel_fulfillment'
            ? 'Shopify fulfillment reversed.'
            : mutation.kind === 'cancel_order_after_fulfillment_reversal'
              ? 'Shopify order cancelled.'
            : 'Saved to Shopify.')
        if (
          mutation.kind === 'cancel_fulfillment'
          || mutation.kind === 'cancel_order_after_fulfillment_reversal'
        ) await load()
        await Promise.resolve(onOrderChanged())
      }
    } catch (caught) {
      if (caught instanceof TypeError) {
        setAmbiguousSave(true)
        setNotice('The response was interrupted. Refresh to inspect the retained attempt; do not submit the change again.')
      } else {
        setError(caught instanceof Error
          ? caught.message
          : 'Shopify change could not be saved')
      }
    } finally {
      setAction(null)
    }
  }

  const reverseFulfillment = async (
    fulfillment: ShopifyFulfillment,
    eligibility: FulfillmentEligibility,
  ) => {
    if (!eligibility.allowed || blocker || busy) return
    const confirmed = window.confirm(
      `Reverse ${fulfillment.name} in Shopify?\n\n`
      + 'This does not cancel or refund the order. It does not void the '
      + 'carrier label or remove saved label and reprint history.',
    )
    if (!confirmed) return
    setReversingFulfillmentId(fulfillment.fulfillmentId)
    try {
      await save({
        kind: 'cancel_fulfillment',
        fulfillmentId: fulfillment.fulfillmentId,
        expectedFulfillmentUpdatedAt: eligibility.expectedUpdatedAt,
      })
    } finally {
      setReversingFulfillmentId(null)
    }
  }

  const prepareCancellation = async () => {
    if (
      !state
      || blocker
      || busy
      || !canCancel
      || !state.eligibility.cancel.allowed
      || !cancelDraftValid
      || !cancellationMutation
    ) return
    const body = {
      action: 'prepare' as const,
      orderGlobalId,
      expectedRowVersion: state.order.rowVersion,
      mutation: cancellationMutation,
      reason: normalizedCancelReason,
    }
    const key = stableAttemptKey(
      prepareCancelAttempt,
      JSON.stringify(body),
      'prepare',
      `${orderGlobalId}:v${state.order.rowVersion}:cancel`,
    )
    setAction('prepare_cancel')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/shopify-order-management', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({})) as ManagementPayload
      const prepared = preparedAuthorization(payload.authorization)
      if (!response.ok || !payload.ok || !prepared) {
        prepareCancelAttempt.current = null
        throw new Error(
          `${payload.error || 'Shopify cancellation could not be prepared'}`
          + `${payload.code ? ` [${payload.code}]` : ''}`,
        )
      }
      setPreparedCancel(prepared)
      setCancelConfirmation('')
      setNotice('Review the choices and enter the confirmation shown below.')
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Shopify cancellation could not be prepared')
    } finally {
      setAction(null)
    }
  }

  const executeCancellation = async () => {
    if (
      !state
      || !preparedCancel
      || blocker
      || busy
      || !canCancel
      || !cancellationMutation
      || cancelConfirmation !== preparedCancel.confirmationStatement
    ) return
    const body = {
      action: 'execute' as const,
      authorizationGlobalId: preparedCancel.authorizationGlobalId,
      intentHash: preparedCancel.intentHash,
      confirmationStatement: cancelConfirmation,
      mutation: cancellationMutation,
      reason: normalizedCancelReason,
    }
    const key = stableAttemptKey(
      executeCancelAttempt,
      JSON.stringify(body),
      'execute',
      preparedCancel.authorizationGlobalId,
    )
    setAction('execute_cancel')
    setError('')
    setNotice('')
    setLastResult(null)
    try {
      const response = await fetch('/api/operations/shopify-order-management', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({})) as ManagementPayload
      const executed = result(payload.result, orderGlobalId)
      if (!response.ok || !payload.ok || !executed) {
        throw new Error(
          `${payload.error || 'Shopify cancellation could not be sent'}`
          + `${payload.code ? ` [${payload.code}]` : ''}`,
        )
      }
      setState(executed.management)
      setLastResult(executed)
      setPreparedCancel(null)
      setCancelConfirmation('')
      if (executed.state === 'unknown') {
        setNotice(
          `Shopify has not confirmed the result for attempt ${executed.attemptGlobalId}. Use Reconcile; do not send another cancellation.`,
        )
      } else if (executed.state === 'failed') {
        setError('Shopify rejected the cancellation. Refresh before preparing another request.')
      } else {
        setNotice('Shopify order cancelled.')
        await load()
        await Promise.resolve(onOrderChanged())
      }
    } catch (caught) {
      if (caught instanceof TypeError) {
        setAmbiguousSave(true)
        setNotice('The response was interrupted. Refresh and reconcile the retained attempt; do not send another cancellation.')
      } else {
        setError(caught instanceof Error
          ? caught.message
          : 'Shopify cancellation could not be sent')
      }
    } finally {
      setAction(null)
    }
  }

  const cancelAfterFulfillmentReversal = async () => {
    const currentState = state
    const eligibility = currentState?.eligibility.cancelAfterFulfillmentReversal
    const predecessor = eligibility?.predecessorAuthorizationGlobalId
    if (
      !currentState
      || !eligibility?.allowed
      || !predecessor
      || blocker
      || busy
      || !canCancel
    ) return
    const confirmed = window.confirm(
      `Cancel ${currentState.order.name} in Shopify?\n\n`
      + 'This is a separate Shopify order cancellation after the fulfillment '
      + 'reversal. It does not issue a refund, restock inventory, or notify '
      + 'the customer.'
      + (eligibility.releasesAuthorization
        ? ' Shopify will release the successful test payment authorization.'
        : ''),
    )
    if (!confirmed) return
    setCancellingAfterReversal(true)
    try {
      await save({
        kind: 'cancel_order_after_fulfillment_reversal',
        predecessorAuthorizationGlobalId: predecessor,
      })
    } finally {
      setCancellingAfterReversal(false)
    }
  }

  const reconcile = async () => {
    const attempt = state?.openAttempt
    if (!attempt || busy) return
    const body = {
      action: 'reconcile' as const,
      attemptGlobalId: attempt.attemptGlobalId,
    }
    const key = stableAttemptKey(
      reconcileAttempt,
      JSON.stringify(body),
      'reconcile',
      attempt.attemptGlobalId,
    )
    setAction('reconcile')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/shopify-order-management', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({})) as ManagementPayload
      const checked = result(payload.result, orderGlobalId, attempt.attemptGlobalId)
      if (!response.ok || !payload.ok || !checked) {
        throw new Error(
          `${payload.error || 'Shopify outcome could not be checked'}`
          + `${payload.code ? ` [${payload.code}]` : ''}`,
        )
      }
      setState(checked.management)
      setLastResult(checked)
      if (checked.state === 'unknown') {
        setNotice('Shopify still does not prove whether the retained attempt applied. No second write was sent.')
      } else {
        reconcileAttempt.current = null
        saveAttempt.current = null
        setNotice('Shopify outcome reconciled from a read-only check.')
        await load()
        await Promise.resolve(onOrderChanged())
      }
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Shopify outcome could not be checked')
    } finally {
      setAction(null)
    }
  }

  return (
    <Stack spacing={2} data-testid="shopify-order-management-panel">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        alignItems={{ sm: 'center' }}
        justifyContent="space-between"
      >
        <Box>
          <Typography variant="h6">Shopify order</Typography>
          <Typography variant="body2" color="text.secondary">
            Edit this order here. Changes save to Shopify when Provider writes is On.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          startIcon={loading ? <CircularProgress size={16} /> : <RefreshRounded />}
          disabled={busy || !canManage}
          onClick={() => void load()}
          sx={{ minHeight: 44 }}
        >
          Refresh
        </Button>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="info">{notice}</Alert>}
      {!canManage && (
        <Alert severity="info">Operations-management permission is required.</Alert>
      )}
      {loading && !state && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={26} />
        </Box>
      )}

      {state && (
        <>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: 'minmax(0, 1fr)',
                sm: 'repeat(2, minmax(0, 1fr))',
              },
              gap: 0.75,
            }}
          >
            <Typography variant="body2" fontWeight={700}>
              {state.order.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {state.accountLabel} · {state.shopDomain}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {state.order.externalOrderId}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {state.order.financialStatus || 'No financial status'} ·{' '}
              {state.order.fulfillmentStatus || 'No fulfillment status'}
            </Typography>
          </Box>

          {blocker && <Alert severity="info">{blocker}</Alert>}

          {retainedAttempt && (
            <Alert
              severity={retainedAttempt.state === 'unknown' ? 'error' : 'warning'}
              data-testid="shopify-order-management-attempt"
            >
              <Stack spacing={1}>
                <Typography fontWeight={700}>
                  Shopify save {retainedAttempt.state}
                </Typography>
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {retainedAttempt.attemptGlobalId}
                  {retainedAttempt.errorCode ? ` · ${retainedAttempt.errorCode}` : ''}
                </Typography>
                <Typography variant="body2">
                  Reconciliation reads Shopify and never sends a second write.
                </Typography>
                <Button
                  variant="outlined"
                  color="warning"
                  startIcon={action === 'reconcile'
                    ? <CircularProgress size={16} />
                    : <ReplayRounded />}
                  disabled={busy}
                  onClick={() => void reconcile()}
                  sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
                  data-testid="reconcile-shopify-order-write"
                >
                  {retainedAttempt.state === 'processing'
                    ? 'Check outcome'
                    : 'Reconcile outcome'}
                </Button>
              </Stack>
            </Alert>
          )}

          {state.order.fulfillments.length > 0 && (
            <Box
              sx={{
                p: 1.5,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1.5,
              }}
              data-testid="shopify-fulfillments"
            >
              <Stack spacing={1.25}>
                <Typography fontWeight={700}>Shopify fulfillments</Typography>
                {state.order.fulfillments.map((fulfillment) => {
                  const eligibility = state.eligibility.fulfillments.find(
                    (candidate) => (
                      candidate.fulfillmentId === fulfillment.fulfillmentId
                    ),
                  )
                  const disabledReason = eligibility?.allowed
                    ? null
                    : eligibility?.reason
                      || 'Shopify fulfillment reversal is unavailable.'
                  return (
                    <Box
                      key={fulfillment.fulfillmentId}
                      sx={{
                        p: 1.25,
                        border: 1,
                        borderColor: 'divider',
                        borderRadius: 1,
                      }}
                    >
                      <Stack spacing={0.75}>
                        <Stack
                          direction={{ xs: 'column', sm: 'row' }}
                          spacing={0.5}
                          justifyContent="space-between"
                        >
                          <Typography fontWeight={600}>
                            {fulfillment.name}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {fulfillment.displayStatus || fulfillment.status}
                            {' · '}{fulfillment.quantity} items
                          </Typography>
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          Updated {new Date(fulfillment.updatedAt).toLocaleString()}
                        </Typography>
                        {fulfillment.tracking.map((tracking, index) => (
                          <Stack
                            key={`${tracking.number || 'tracking'}:${index}`}
                            direction="row"
                            spacing={1}
                            alignItems="center"
                          >
                            <Typography
                              variant="body2"
                              color="text.secondary"
                              sx={{ overflowWrap: 'anywhere' }}
                            >
                              {[tracking.company, tracking.number]
                                .filter(Boolean).join(' · ') || 'Tracking available'}
                            </Typography>
                            {tracking.url && (
                              <Button
                                component="a"
                                href={tracking.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                size="small"
                              >
                                Track
                              </Button>
                            )}
                          </Stack>
                        ))}
                        {eligibility && (
                          <Tooltip title={blocker || disabledReason || ''}>
                            <Box component="span" sx={{ display: 'block' }}>
                              <Button
                                fullWidth
                                variant="outlined"
                                color="error"
                                startIcon={reversingFulfillmentId
                                  === fulfillment.fulfillmentId
                                  ? <CircularProgress size={16} />
                                  : <CancelRounded />}
                                disabled={busy
                                  || Boolean(blocker)
                                  || !eligibility.allowed}
                                onClick={() => void reverseFulfillment(
                                  fulfillment,
                                  eligibility,
                                )}
                                sx={{ minHeight: 44 }}
                                data-testid="reverse-shopify-fulfillment"
                              >
                                Reverse fulfillment
                              </Button>
                            </Box>
                          </Tooltip>
                        )}
                        <DisabledReason value={disabledReason} />
                      </Stack>
                    </Box>
                  )
                })}
              </Stack>
            </Box>
          )}

          <Divider />

          <Box sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1.5 }}>
            <Stack spacing={1.25}>
              <Typography fontWeight={700}>Order details</Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: {
                    xs: 'minmax(0, 1fr)',
                    sm: 'repeat(2, minmax(0, 1fr))',
                  },
                  gap: 1.25,
                }}
              >
                <TextField
                  label="Email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    saveAttempt.current = null
                  }}
                  inputProps={{ maxLength: 254 }}
                  disabled={busy || Boolean(retainedAttempt)}
                />
                <TextField
                  label="Phone"
                  value={phone}
                  onChange={(event) => {
                    setPhone(event.target.value)
                    saveAttempt.current = null
                  }}
                  inputProps={{ maxLength: 64 }}
                  disabled={busy || Boolean(retainedAttempt)}
                />
                <TextField
                  label="PO number"
                  value={poNumber}
                  onChange={(event) => {
                    setPoNumber(event.target.value)
                    saveAttempt.current = null
                  }}
                  inputProps={{ maxLength: 255 }}
                  disabled={busy || Boolean(retainedAttempt)}
                />
                <TextField
                  label="Tags"
                  value={tags}
                  onChange={(event) => {
                    setTags(event.target.value)
                    saveAttempt.current = null
                  }}
                  inputProps={{ maxLength: 4_096 }}
                  error={!tagsValid}
                  helperText="Separate tags with commas. Remove a tag here to remove it in Shopify."
                  disabled={busy || Boolean(retainedAttempt)}
                />
              </Box>
              <TextField
                fullWidth
                multiline
                minRows={3}
                label="Order note"
                value={note}
                onChange={(event) => {
                  setNote(event.target.value)
                  saveAttempt.current = null
                }}
                inputProps={{ maxLength: 5_000 }}
                helperText={`${note.length}/5000`}
                disabled={busy || Boolean(retainedAttempt)}
              />
            </Stack>
          </Box>

          <Box
            sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1.5 }}
            data-testid="shopify-source-shipping-address"
          >
            <Stack spacing={1.25}>
              <Box>
                <Typography fontWeight={700}>
                  Shopify source shipping address
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  This changes the address stored on the Shopify order. It does
                  not change ClawPilot&apos;s local shipment-address override.
                </Typography>
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: {
                    xs: 'minmax(0, 1fr)',
                    sm: 'repeat(2, minmax(0, 1fr))',
                  },
                  gap: 1.25,
                }}
              >
                {([
                  ['firstName', 'First name', 255],
                  ['lastName', 'Last name', 255],
                  ['company', 'Company', 255],
                  ['address1', 'Address line 1', 255],
                  ['address2', 'Address line 2', 255],
                  ['city', 'City', 255],
                  ['provinceCode', 'State / province code', 64],
                  ['zip', 'ZIP / postal code', 64],
                  ['phone', 'Address phone', 64],
                ] as const).map(([field, label, maxLength]) => (
                  <TextField
                    key={field}
                    label={label}
                    value={shippingAddressDraft[field]}
                    onChange={(event) => {
                      setShippingAddressDraft((current) => ({
                        ...current,
                        [field]: event.target.value,
                      }))
                      saveAttempt.current = null
                    }}
                    inputProps={{ maxLength }}
                    disabled={busy || Boolean(retainedAttempt)}
                  />
                ))}
                <TextField
                  label="Country code"
                  value={shippingAddressDraft.countryCode}
                  onChange={(event) => {
                    setShippingAddressDraft((current) => ({
                      ...current,
                      countryCode: event.target.value.toUpperCase(),
                    }))
                    saveAttempt.current = null
                  }}
                  inputProps={{ maxLength: 2 }}
                  error={shippingAddressDraft.countryCode.length > 0
                    && !COUNTRY_CODE.test(shippingAddressDraft.countryCode)}
                  helperText="Two-letter code, such as US or CA."
                  disabled={busy || Boolean(retainedAttempt)}
                />
              </Box>
            </Stack>
          </Box>

          <Box sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1.5 }}>
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} alignItems="center">
                <EditRounded fontSize="small" />
                <Typography fontWeight={700}>Line quantities</Typography>
              </Stack>
              {state.order.lines.map((item) => {
                const eligibility = state.eligibility.lineEdits.find(
                  (candidate) => candidate.lineItemId === item.lineItemId,
                )
                const quantityText = quantities[item.lineItemId] ?? ''
                const entered = Number(quantityText)
                const quantityValid = /^[0-9]+$/.test(quantityText)
                  && Number.isSafeInteger(entered)
                  && (
                    entered === item.quantity
                    || (
                      entered >= (eligibility?.minQuantity ?? 0)
                      && entered <= (eligibility?.maxQuantity ?? -1)
                    )
                  )
                const disabledReason = !eligibility
                  ? 'Shopify did not return edit eligibility for this line.'
                  : eligibility.allowed
                    ? null
                    : eligibility.reason || 'Shopify does not allow this line edit.'
                return (
                  <Box
                    key={item.lineItemId}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: {
                        xs: 'minmax(0, 1fr)',
                        sm: 'minmax(0, 1fr) minmax(150px, 0.45fr)',
                      },
                      gap: 1.25,
                      p: 1.25,
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography fontWeight={600}>{item.title}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        Quantity {item.quantity} · unfulfilled {item.unfulfilledQuantity}
                      </Typography>
                      <DisabledReason value={disabledReason} />
                    </Box>
                    <Stack spacing={1}>
                      <TextField
                        type="number"
                        size="small"
                        label="Quantity"
                        value={quantityText}
                        onChange={(event) => {
                          setQuantities((current) => ({
                            ...current,
                            [item.lineItemId]: event.target.value,
                          }))
                          saveAttempt.current = null
                        }}
                        inputProps={{
                          min: eligibility?.minQuantity ?? 0,
                          max: item.quantity,
                          step: 1,
                        }}
                        error={quantityText.length > 0 && !quantityValid}
                        disabled={busy
                          || Boolean(retainedAttempt)}
                      />
                    </Stack>
                  </Box>
                )
              })}
            </Stack>
          </Box>

          <Box
            sx={{
              position: 'sticky',
              bottom: 8,
              zIndex: 2,
              p: 1.25,
              bgcolor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              borderRadius: 1.5,
              boxShadow: 3,
            }}
          >
            <Tooltip title={blocker || state.eligibility.ordinarySave.reason || ''}>
              <Box component="span" sx={{ display: 'block' }}>
                <Button
                  fullWidth
                  variant="contained"
                  startIcon={action === 'save'
                    ? <CircularProgress size={16} />
                    : <SaveRounded />}
                  disabled={busy
                    || Boolean(blocker)
                    || !state.eligibility.ordinarySave.allowed
                    || !ordinaryDirty
                    || !ordinaryDraftValid}
                  onClick={() => void save({
                    kind: 'save_order',
                    email: email || null,
                    phone: phone || null,
                    poNumber: poNumber || null,
                    note: note || null,
                    shippingAddress: desiredShippingAddress,
                    tagAdds,
                    tagRemoves,
                    lineQuantities: changedLineQuantities,
                  })}
                  sx={{ minHeight: 48 }}
                  data-testid="save-shopify-order"
                >
                  Save order
                </Button>
              </Box>
            </Tooltip>
            <DisabledReason value={state.eligibility.ordinarySave.allowed
              ? null
              : state.eligibility.ordinarySave.reason} />
          </Box>

          {state.eligibility.cancelAfterFulfillmentReversal
            .predecessorAuthorizationGlobalId && (
            <Box
              sx={{
                p: 1.5,
                border: 1,
                borderColor: 'error.dark',
                borderRadius: 1.5,
              }}
              data-testid="cancel-shopify-after-fulfillment-reversal"
            >
              <Stack spacing={1.25}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <CancelRounded color="error" fontSize="small" />
                  <Typography fontWeight={700}>
                    Cancel order after reversal
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  The fulfillment reversal is complete. Order cancellation is
                  a separate Shopify action. No refund, restock, or customer
                  notification is requested.
                  {state.eligibility.cancelAfterFulfillmentReversal
                    .releasesAuthorization
                    ? ' Shopify will release the successful test payment authorization.'
                    : ''}
                </Typography>
                <Tooltip title={blocker
                  || (!canCancel
                    ? 'Owner or operations administrator execution permission is required.'
                    : null)
                  || state.eligibility.cancelAfterFulfillmentReversal.reason
                  || ''}
                >
                  <Box component="span" sx={{ display: 'block' }}>
                    <Button
                      fullWidth
                      variant="outlined"
                      color="error"
                      startIcon={cancellingAfterReversal
                        ? <CircularProgress size={16} />
                        : <CancelRounded />}
                      disabled={busy
                        || Boolean(blocker)
                        || !canCancel
                        || !state.eligibility
                          .cancelAfterFulfillmentReversal.allowed}
                      onClick={() => void cancelAfterFulfillmentReversal()}
                      sx={{ minHeight: 44 }}
                      data-testid="save-shopify-cancel-after-reversal"
                    >
                      Cancel Shopify order
                    </Button>
                  </Box>
                </Tooltip>
                <DisabledReason
                  value={state.eligibility.cancelAfterFulfillmentReversal
                    .allowed
                    ? (!canCancel
                        ? 'Owner or operations administrator execution permission is required.'
                        : null)
                    : state.eligibility.cancelAfterFulfillmentReversal.reason}
                />
              </Stack>
            </Box>
          )}

          {!state.eligibility.cancelAfterFulfillmentReversal
            .predecessorAuthorizationGlobalId && (
            <Box sx={{ p: 1.5, border: 1, borderColor: 'error.dark', borderRadius: 1.5 }}>
              <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} alignItems="center">
                <CancelRounded color="error" fontSize="small" />
                <Typography fontWeight={700}>Cancel order</Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Cancel {state.order.name} in Shopify. Choose how payment,
                inventory, and the customer should be handled.
                {selectedCancellationPayment?.releasesAuthorization
                  ? ' Shopify will void the open payment authorization.'
                  : ''}
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: 1,
                }}
                data-testid="shopify-cancel-payment-facts"
              >
                {([
                  ['Received', state.payment.totalReceived],
                  ['Refunded', state.payment.totalRefunded],
                  ['Capturable', state.payment.totalCapturable],
                ] satisfies ReadonlyArray<readonly [string, ShopifyMoney]>)
                  .map(([label, money]) => (
                    <Box key={label}>
                      <Typography variant="caption" color="text.secondary">
                        {label}
                      </Typography>
                      <Typography variant="body2" fontWeight={600}>
                        {money.amount} {money.currencyCode}
                      </Typography>
                    </Box>
                  ))}
              </Box>
              <TextField
                select
                fullWidth
                size="small"
                label="Reason"
                value={cancelReasonCode}
                disabled={busy || Boolean(preparedCancel)}
                onChange={(event) => setCancelReasonCode(event.target.value as
                  typeof cancelReasonCode)}
                inputProps={{ 'data-testid': 'shopify-cancel-reason-code' }}
              >
                <MenuItem value="CUSTOMER">Customer requested</MenuItem>
                <MenuItem value="DECLINED">Payment declined</MenuItem>
                <MenuItem value="FRAUD">Fraud</MenuItem>
                <MenuItem value="INVENTORY">Inventory unavailable</MenuItem>
                <MenuItem value="STAFF">Staff decision</MenuItem>
                <MenuItem value="OTHER">Other</MenuItem>
              </TextField>
              <TextField
                select
                fullWidth
                size="small"
                label="Payment"
                value={cancelRefundMethod}
                disabled={busy || Boolean(preparedCancel)}
                onChange={(event) => setCancelRefundMethod(event.target.value as
                  typeof cancelRefundMethod)}
                inputProps={{ 'data-testid': 'shopify-cancel-refund-method' }}
              >
                <MenuItem value="" disabled>
                  Select payment handling
                </MenuItem>
                <MenuItem
                  value="none"
                  disabled={!state.payment.refundOptions.none.allowed}
                >
                  Do not refund
                </MenuItem>
                <MenuItem
                  value="original_payment_methods"
                  disabled={!state.payment.refundOptions
                    .original_payment_methods.allowed}
                >
                  Full refund to original payment methods
                </MenuItem>
              </TextField>
              <DisabledReason value={cancelRefundMethod
                ? selectedCancellationPayment?.reason
                : 'Choose how Shopify should handle payment.'} />
              <Stack spacing={0}>
                <FormControlLabel
                  control={<Checkbox
                    data-testid="shopify-cancel-restock"
                    checked={cancelRestock}
                    disabled={busy || Boolean(preparedCancel)}
                    onChange={(event) => setCancelRestock(event.target.checked)}
                  />}
                  label="Restock inventory"
                />
                <FormControlLabel
                  control={<Checkbox
                    data-testid="shopify-cancel-notify-customer"
                    checked={cancelNotifyCustomer}
                    disabled={busy || Boolean(preparedCancel)}
                    onChange={(event) => setCancelNotifyCustomer(
                      event.target.checked,
                    )}
                  />}
                  label="Notify customer"
                />
              </Stack>
              <TextField
                fullWidth
                size="small"
                label="Operator reason"
                value={cancelReason}
                disabled={busy || Boolean(preparedCancel)}
                onChange={(event) => setCancelReason(event.target.value)}
                helperText={`${normalizedCancelReason.length}/500 · minimum 10 characters`}
                inputProps={{
                  maxLength: 500,
                  'data-testid': 'shopify-cancel-operator-reason',
                }}
              />
              {preparedCancel && (
                <Stack spacing={1}>
                  <Typography variant="caption" color="text.secondary">
                    Enter this confirmation exactly:
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}
                    data-testid="shopify-cancel-confirmation-statement"
                  >
                    {preparedCancel.confirmationStatement}
                  </Typography>
                  <TextField
                    fullWidth
                    size="small"
                    label="Confirmation"
                    value={cancelConfirmation}
                    disabled={busy}
                    onChange={(event) => setCancelConfirmation(
                      event.target.value,
                    )}
                    inputProps={{
                      'data-testid': 'shopify-cancel-confirmation-input',
                    }}
                  />
                </Stack>
              )}
              <Tooltip title={blocker
                || (!canCancel
                  ? 'Owner or operations administrator execution permission is required.'
                  : state.eligibility.cancel.reason || '')}
              >
                <Box component="span" sx={{ display: 'block' }}>
                  {preparedCancel ? (
                    <Button
                      fullWidth
                      variant="contained"
                      color="error"
                      startIcon={action === 'execute_cancel'
                        ? <CircularProgress size={16} />
                        : <CancelRounded />}
                      disabled={busy
                        || Boolean(blocker)
                        || !canCancel
                        || !cancellationMutation
                        || cancelConfirmation
                          !== preparedCancel.confirmationStatement}
                      onClick={() => void executeCancellation()}
                      sx={{ minHeight: 44 }}
                      data-testid="save-shopify-cancel"
                    >
                      Send cancellation to Shopify
                    </Button>
                  ) : (
                    <Button
                      fullWidth
                      variant="outlined"
                      color="error"
                      startIcon={action === 'prepare_cancel'
                        ? <CircularProgress size={16} />
                        : <CancelRounded />}
                      disabled={busy
                        || Boolean(blocker)
                        || !canCancel
                        || !cancelDraftValid
                        || !cancellationMutation
                        || !state.eligibility.cancel.allowed}
                      onClick={() => void prepareCancellation()}
                      sx={{ minHeight: 44 }}
                      data-testid="prepare-shopify-cancel"
                    >
                      Review cancellation
                    </Button>
                  )}
                </Box>
              </Tooltip>
              <DisabledReason value={state.eligibility.cancel.allowed
                ? (!canCancel
                    ? 'Owner or operations administrator execution permission is required.'
                    : null)
                : state.eligibility.cancel.reason} />
              </Stack>
            </Box>
          )}

          {lastResult && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ overflowWrap: 'anywhere' }}
              data-testid="shopify-order-management-result"
            >
              Attempt {lastResult.attemptGlobalId} · {lastResult.state} · provider writes{' '}
              {lastResult.providerWrites === null
                ? 'unknown'
                : lastResult.providerWrites}
            </Typography>
          )}
        </>
      )}
    </Stack>
  )
}
