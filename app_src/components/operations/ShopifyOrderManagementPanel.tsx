'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import CancelRounded from '@mui/icons-material/CancelRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import LocalOfferRounded from '@mui/icons-material/LocalOfferRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'

type MutationKind = 'add_tag' | 'cancel' | 'set_line_quantity'
type AttemptState = 'processing' | 'unknown' | 'failed' | 'succeeded' | 'reconciled'

type ShopifyManagementLine = Readonly<{
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

type ShopifyManagement = Readonly<{
  runtimeAvailable: boolean
  blockerCode: string | null
  accountLabel: string
  shopDomain: string
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
    tags: string[]
    lines: ShopifyManagementLine[]
  }>
  eligibility: Readonly<{
    addTag: Readonly<{ allowed: boolean; reason: string | null }>
    cancel: Readonly<{ allowed: boolean; reason: string | null }>
    lineEdits: LineEligibility[]
  }>
  openAttempt?: ShopifyOpenAttempt | null
}>

type ShopifyOpenAttempt = Readonly<{
  attemptGlobalId: string
  authorizationGlobalId: string
  intentHash: string
  state: AttemptState
  actionKind: MutationKind
  providerReference: string | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
  providerWrites: number | null
}>

type AddTagMutation = Readonly<{
  kind: 'add_tag'
  tag: string
}>

type CancelMutation = Readonly<{
  kind: 'cancel'
}>

type SetLineQuantityMutation = Readonly<{
  kind: 'set_line_quantity'
  lineItemId: string
  quantity: number
}>

type ShopifyMutation = AddTagMutation | CancelMutation | SetLineQuantityMutation

type PreparedAuthorization = Readonly<{
  authorizationGlobalId: string
  intentHash: string
  expiresAt: string
  confirmationStatement: string
  preview: unknown
  replayed: boolean
  providerReads: number
  providerWrites: 0
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
  authorization?: PreparedAuthorization
  result?: ManagementResult
}>

type PendingAuthorization = Readonly<{
  authorization: PreparedAuthorization
  mutation: ShopifyMutation
  reason: string
  requestRowVersion: number
}>

type IdempotencyAttempt = {
  fingerprint: string
  key: string
}

const MINIMUM_REASON_LENGTH = 10
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const AUTHORIZATION_GLOBAL_ID = /^gsom(?:[0-9]{7}|[0-9a-v]{12})$/
const ATTEMPT_GLOBAL_ID = /^gsoa(?:[0-9]{7}|[0-9a-v]{12})$/
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,20}$/
const SHOPIFY_LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]{0,20}$/
const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/
const SHA256 = /^[a-f0-9]{64}$/

function idempotencyKey(action: 'prepare' | 'execute' | 'reconcile', exactId: string) {
  const nonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `shopify-order-management:${action}:${exactId}:${nonce}`
}

function stableAttemptKey(
  reference: MutableRefObject<IdempotencyAttempt | null>,
  fingerprint: string,
  action: 'prepare' | 'execute' | 'reconcile',
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

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isOptionalText(value: unknown): value is string | null {
  return value === null || isNonEmptyText(value)
}

function isManagementLine(input: unknown): input is ShopifyManagementLine {
  if (!input || typeof input !== 'object') return false
  const candidate = input as Partial<ShopifyManagementLine>
  return (
    typeof candidate.lineItemId === 'string'
    && SHOPIFY_LINE_ITEM_GID.test(candidate.lineItemId)
    && isNonEmptyText(candidate.title)
    && isInteger(candidate.quantity)
    && candidate.quantity >= 0
    && isInteger(candidate.unfulfilledQuantity)
    && candidate.unfulfilledQuantity >= 0
    && isInteger(candidate.fulfilledQuantity)
    && candidate.fulfilledQuantity >= 0
  )
}

function isLineEligibility(input: unknown): input is LineEligibility {
  if (!input || typeof input !== 'object') return false
  const candidate = input as Partial<LineEligibility>
  return (
    typeof candidate.lineItemId === 'string'
    && SHOPIFY_LINE_ITEM_GID.test(candidate.lineItemId)
    && typeof candidate.allowed === 'boolean'
    && isOptionalText(candidate.reason)
    && isInteger(candidate.minQuantity)
    && candidate.minQuantity >= 0
    && isInteger(candidate.maxQuantity)
    && candidate.maxQuantity >= candidate.minQuantity
  )
}

function isOpenAttempt(input: unknown): input is ShopifyOpenAttempt {
  if (!input || typeof input !== 'object') return false
  const candidate = input as Partial<ShopifyOpenAttempt>
  return (
    typeof candidate.attemptGlobalId === 'string'
    && ATTEMPT_GLOBAL_ID.test(candidate.attemptGlobalId)
    && typeof candidate.authorizationGlobalId === 'string'
    && AUTHORIZATION_GLOBAL_ID.test(candidate.authorizationGlobalId)
    && typeof candidate.intentHash === 'string'
    && SHA256.test(candidate.intentHash)
    && ['processing', 'unknown', 'failed', 'succeeded', 'reconciled'].includes(
      candidate.state || '',
    )
    && ['add_tag', 'cancel', 'set_line_quantity'].includes(candidate.actionKind || '')
    && (candidate.providerReference === null || isNonEmptyText(candidate.providerReference))
    && (candidate.errorCode === null || isNonEmptyText(candidate.errorCode))
    && isNonEmptyText(candidate.createdAt)
    && !Number.isNaN(Date.parse(candidate.createdAt))
    && isNonEmptyText(candidate.updatedAt)
    && !Number.isNaN(Date.parse(candidate.updatedAt))
    && (candidate.providerWrites === null || (
      isInteger(candidate.providerWrites)
      && candidate.providerWrites >= 0
      && candidate.providerWrites <= 3
    ))
  )
}

function isManagement(input: unknown, orderGlobalId: string): input is ShopifyManagement {
  if (!input || typeof input !== 'object') return false
  const candidate = input as Partial<ShopifyManagement>
  const order = candidate.order as Partial<ShopifyManagement['order']> | undefined
  const eligibility = candidate.eligibility as Partial<ShopifyManagement['eligibility']> | undefined
  const lines = Array.isArray(order?.lines) ? order.lines : []
  const lineEdits = Array.isArray(eligibility?.lineEdits) ? eligibility.lineEdits : []
  return (
    typeof candidate.runtimeAvailable === 'boolean'
    && (candidate.blockerCode === null || isNonEmptyText(candidate.blockerCode))
    && isNonEmptyText(candidate.accountLabel)
    && typeof candidate.shopDomain === 'string'
    && SHOPIFY_DOMAIN.test(candidate.shopDomain)
    && order?.globalId === orderGlobalId
    && ORDER_GLOBAL_ID.test(orderGlobalId)
    && typeof order.externalOrderId === 'string'
    && SHOPIFY_ORDER_GID.test(order.externalOrderId)
    && isNonEmptyText(order.name)
    && isInteger(order.rowVersion)
    && order.rowVersion >= 0
    && typeof order.test === 'boolean'
    && typeof order.closed === 'boolean'
    && isOptionalText(order.cancelledAt)
    && isOptionalText(order.financialStatus)
    && isOptionalText(order.fulfillmentStatus)
    && typeof order.merchantEditable === 'boolean'
    && Array.isArray(order.tags)
    && order.tags.every(isNonEmptyText)
    && Array.isArray(order.lines)
    && order.lines.every(isManagementLine)
    && typeof eligibility?.addTag?.allowed === 'boolean'
    && isOptionalText(eligibility.addTag.reason)
    && typeof eligibility?.cancel?.allowed === 'boolean'
    && isOptionalText(eligibility.cancel.reason)
    && Array.isArray(eligibility?.lineEdits)
    && eligibility.lineEdits.every(isLineEligibility)
    && lineEdits.every((item) => lines.some((line) => line.lineItemId === item.lineItemId))
    && (candidate.openAttempt === undefined
      || candidate.openAttempt === null
      || isOpenAttempt(candidate.openAttempt))
  )
}

function exactAuthorization(input: unknown): PreparedAuthorization | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<PreparedAuthorization>
  if (
    typeof candidate.authorizationGlobalId !== 'string'
    || !AUTHORIZATION_GLOBAL_ID.test(candidate.authorizationGlobalId)
    || typeof candidate.intentHash !== 'string'
    || !SHA256.test(candidate.intentHash)
    || !isNonEmptyText(candidate.expiresAt)
    || Number.isNaN(Date.parse(candidate.expiresAt))
    || !isNonEmptyText(candidate.confirmationStatement)
    || !Object.prototype.hasOwnProperty.call(candidate, 'preview')
    || typeof candidate.replayed !== 'boolean'
    || !isInteger(candidate.providerReads)
    || candidate.providerReads < 0
    || candidate.providerWrites !== 0
  ) return null
  return candidate as PreparedAuthorization
}

function exactResult(
  input: unknown,
  orderGlobalId: string,
  expectedAuthorizationGlobalId?: string,
): ManagementResult | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<ManagementResult>
  if (
    typeof candidate.authorizationGlobalId !== 'string'
    || !AUTHORIZATION_GLOBAL_ID.test(candidate.authorizationGlobalId)
    || (expectedAuthorizationGlobalId
      && candidate.authorizationGlobalId !== expectedAuthorizationGlobalId)
    || typeof candidate.attemptGlobalId !== 'string'
    || !ATTEMPT_GLOBAL_ID.test(candidate.attemptGlobalId)
    || !['succeeded', 'failed', 'unknown', 'reconciled'].includes(candidate.state || '')
    || (candidate.providerReference !== null && !isNonEmptyText(candidate.providerReference))
    || typeof candidate.replayed !== 'boolean'
    || !isInteger(candidate.providerReads)
    || candidate.providerReads < 0
    || !(candidate.providerWrites === null || (
      isInteger(candidate.providerWrites)
      && candidate.providerWrites >= 0
      && candidate.providerWrites <= 3
    ))
    || !isManagement(candidate.management, orderGlobalId)
  ) return null
  return candidate as ManagementResult
}

function displayAction(kind: MutationKind) {
  switch (kind) {
    case 'add_tag': return 'Add tag'
    case 'cancel': return 'Cancel Shopify order'
    case 'set_line_quantity': return 'Decrease line quantity'
  }
}

function mutationSummary(mutation: ShopifyMutation, management: ShopifyManagement) {
  if (mutation.kind === 'add_tag') return `Add tag “${mutation.tag}”`
  if (mutation.kind === 'cancel') return `Cancel ${management.order.name}`
  const line = management.order.lines.find((item) => item.lineItemId === mutation.lineItemId)
  return `Set ${line?.title || mutation.lineItemId} quantity to ${mutation.quantity}`
}

function actionDisclosure(kind: MutationKind) {
  if (kind === 'cancel') {
    return 'Cancellation sends no customer notification, issues no refund, and does not restock inventory. Any payment or inventory follow-up remains a separate reviewed action.'
  }
  if (kind === 'set_line_quantity') {
    return 'The line edit sends no customer notification, issues no refund, and does not restock inventory. Any payment or inventory adjustment remains a separate reviewed action.'
  }
  return 'Adding a tag sends no customer notification, issues no refund, and does not restock inventory.'
}

function Reason({ value }: { value: string | null | undefined }) {
  if (!value) return null
  return (
    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
      Disabled: {value}
    </Typography>
  )
}

function AuditValue({ label, value }: { label: string; value: string | number | null }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{value ?? 'None'}</Typography>
    </Box>
  )
}

export default function ShopifyOrderManagementPanel({
  orderGlobalId,
  orderRowVersion,
  canManage,
  canExecute,
  canActivate,
  disabled = false,
  onBusyChange,
  onOrderChanged,
}: {
  orderGlobalId: string
  orderRowVersion: number
  canManage: boolean
  canExecute: boolean
  canActivate: boolean
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onOrderChanged: () => void | Promise<void>
}) {
  const [management, setManagement] = useState<ShopifyManagement | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<'prepare' | 'execute' | 'reconcile' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reason, setReason] = useState('Testing this exact warehouse order through ClawPilot')
  const [tag, setTag] = useState('')
  const [lineQuantities, setLineQuantities] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<PendingAuthorization | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [lastResult, setLastResult] = useState<ManagementResult | null>(null)
  const [ambiguousExecution, setAmbiguousExecution] = useState(false)
  const prepareAttempt = useRef<IdempotencyAttempt | null>(null)
  const executeAttempt = useRef<IdempotencyAttempt | null>(null)
  const reconcileAttempt = useRef<IdempotencyAttempt | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!canManage || !canExecute || !canActivate) return
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({ orderGlobalId })
      const response = await fetch(
        `/api/operations/shopify-order-management?${query.toString()}`,
        { cache: 'no-store', signal },
      )
      const payload = await response.json().catch(() => ({})) as ManagementPayload
      if (!response.ok || !payload.ok || !isManagement(payload.management, orderGlobalId)) {
        throw new Error(`${payload.error || 'Shopify order management is unavailable'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      setManagement(payload.management)
      setAmbiguousExecution(false)
      setLineQuantities((current) => Object.fromEntries(
        payload.management!.order.lines.map((line) => [
          line.lineItemId,
          current[line.lineItemId] ?? String(Math.max(0, line.quantity - 1)),
        ]),
      ))
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error
        ? caught.message
        : 'Shopify order management is unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [canActivate, canExecute, canManage, orderGlobalId])

  useEffect(() => {
    setManagement(null)
    setPending(null)
    setConfirmation('')
    setNotice('')
    setError('')
    setLastResult(null)
    setAmbiguousExecution(false)
    prepareAttempt.current = null
    executeAttempt.current = null
    reconcileAttempt.current = null
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, orderRowVersion])

  useEffect(() => {
    onBusyChange?.(action !== null)
    return () => onBusyChange?.(false)
  }, [action, onBusyChange])

  const openAttempt = management?.openAttempt || null
  const unresolvedAttempt = openAttempt?.state === 'processing' || openAttempt?.state === 'unknown'
    ? openAttempt
    : null
  const unresolvedResult = lastResult?.state === 'unknown' ? lastResult : null
  const staleBinding = Boolean(management && management.order.rowVersion !== orderRowVersion)
  const globalBlockedReason = !canActivate
    ? 'Only an organization owner or administrator with activation authority may authorize Shopify writes.'
    : !canExecute
    ? 'You do not have permission to write to Shopify.'
    : !management?.runtimeAvailable
      ? `Shopify order writes are unavailable${management?.blockerCode ? ` [${management.blockerCode}]` : ''}.`
      : staleBinding
        ? `This panel loaded order version ${management.order.rowVersion}, but the drawer is on version ${orderRowVersion}. Reload before preparing a write.`
        : ambiguousExecution
          ? 'The last execution response was ambiguous. Reload authority and reconcile the exact attempt if Shopify still reports an unknown outcome.'
          : unresolvedResult && !unresolvedAttempt
            ? `Attempt ${unresolvedResult.attemptGlobalId} has an unknown Shopify outcome. Reload authority to obtain the exact reconciliation state.`
        : unresolvedAttempt
          ? `Attempt ${unresolvedAttempt.attemptGlobalId} is ${unresolvedAttempt.state}. Resolve that exact attempt before preparing another Shopify write.`
          : null
  const reasonValid = reason.trim().length >= MINIMUM_REASON_LENGTH
  const normalizedTag = tag.trim()
  const tagValid = normalizedTag.length > 0 && !normalizedTag.includes(',')
  const busy = disabled || loading || action !== null

  const clearPreparedAuthorization = useCallback(() => {
    setPending(null)
    setConfirmation('')
    prepareAttempt.current = null
    executeAttempt.current = null
  }, [])

  const prepare = async (mutation: ShopifyMutation) => {
    if (!management || globalBlockedReason || !reasonValid || busy) return
    const requestRowVersion = management.order.rowVersion
    const body = {
      action: 'prepare' as const,
      orderGlobalId,
      expectedRowVersion: requestRowVersion,
      mutation,
      reason: reason.trim(),
    }
    const fingerprint = JSON.stringify(body)
    const key = stableAttemptKey(
      prepareAttempt,
      fingerprint,
      'prepare',
      `${orderGlobalId}:v${requestRowVersion}`,
    )
    setAction('prepare')
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
      const authorization = exactAuthorization(payload.authorization)
      if (!response.ok || !payload.ok || !authorization) {
        throw new Error(`${payload.error || 'Shopify write authorization could not be prepared'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      setPending({ authorization, mutation, reason: body.reason, requestRowVersion })
      setConfirmation('')
      prepareAttempt.current = null
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Shopify write authorization could not be prepared')
    } finally {
      setAction(null)
    }
  }

  const execute = async () => {
    if (!pending || !management || busy) return
    if (confirmation !== pending.authorization.confirmationStatement) return
    if (pending.requestRowVersion !== management.order.rowVersion || staleBinding) {
      setError('The exact ClawPilot order version changed. Close this confirmation and prepare the write again.')
      return
    }
    const body = {
      action: 'execute' as const,
      authorizationGlobalId: pending.authorization.authorizationGlobalId,
      intentHash: pending.authorization.intentHash,
      confirmationStatement: confirmation,
      mutation: pending.mutation,
      reason: pending.reason,
    }
    const fingerprint = JSON.stringify(body)
    const key = stableAttemptKey(
      executeAttempt,
      fingerprint,
      'execute',
      pending.authorization.authorizationGlobalId,
    )
    setAction('execute')
    setError('')
    setNotice('')
    let definitiveFailure = false
    let refreshOrderAfterWrite = false
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
      const result = exactResult(
        payload.result,
        orderGlobalId,
        pending.authorization.authorizationGlobalId,
      )
      if (!response.ok || !payload.ok || !result) {
        definitiveFailure = response.status === 409
        if (!definitiveFailure) setAmbiguousExecution(true)
        throw new Error(`${payload.error || 'Shopify write did not return a definitive result'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      setManagement(result.management)
      setLastResult(result)
      setPending(null)
      setConfirmation('')
      executeAttempt.current = null
      if (result.state === 'unknown') {
        setNotice(`Shopify outcome is unknown for attempt ${result.attemptGlobalId}. Do not execute again; reconcile that exact attempt.`)
      } else if (result.state === 'succeeded' || result.state === 'reconciled') {
        setNotice(`${displayAction(pending.mutation.kind)} completed in Shopify.`)
        refreshOrderAfterWrite = true
      } else {
        setError(`Shopify rejected or failed attempt ${result.attemptGlobalId}. No retry is implied; review the recorded result.`)
      }
    } catch (caught) {
      if (!definitiveFailure) setAmbiguousExecution(true)
      setPending(null)
      setConfirmation('')
      if (definitiveFailure) executeAttempt.current = null
      setError(caught instanceof Error
        ? caught.message
        : 'Shopify write did not return a definitive result')
      if (!definitiveFailure) {
        setNotice('The request may have reached Shopify. Do not execute it again. Reload management state to obtain the exact attempt, then reconcile only if it is unknown.')
      }
    } finally {
      setAction(null)
    }
    if (refreshOrderAfterWrite) {
      try {
        await onOrderChanged()
      } catch {
        setError('The Shopify write completed, but the ClawPilot order drawer did not refresh. Reload the order before taking another action.')
      }
    }
  }

  const reconcile = async () => {
    const attempt = management?.openAttempt
    if (
      !attempt
      || (attempt.state !== 'processing' && attempt.state !== 'unknown')
      || busy
    ) return
    const body = {
      action: 'reconcile' as const,
      attemptGlobalId: attempt.attemptGlobalId,
    }
    const fingerprint = JSON.stringify(body)
    const key = stableAttemptKey(
      reconcileAttempt,
      fingerprint,
      'reconcile',
      attempt.attemptGlobalId,
    )
    setAction('reconcile')
    setError('')
    setNotice('')
    let refreshOrderAfterReconciliation = false
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
      const result = exactResult(payload.result, orderGlobalId, attempt.authorizationGlobalId)
      if (!response.ok || !payload.ok || !result || result.attemptGlobalId !== attempt.attemptGlobalId) {
        throw new Error(`${payload.error || 'Shopify attempt could not be reconciled'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      setManagement(result.management)
      setLastResult(result)
      reconcileAttempt.current = null
      if (result.state === 'unknown') {
        setNotice(`Attempt ${result.attemptGlobalId} remains unknown. No new write is allowed.`)
      } else if (result.state === 'succeeded' || result.state === 'reconciled') {
        setNotice(`Attempt ${result.attemptGlobalId} was reconciled without issuing a second Shopify write.`)
        refreshOrderAfterReconciliation = true
      } else {
        setError(`Attempt ${result.attemptGlobalId} reconciled as failed. Review its recorded error before preparing another action.`)
      }
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Shopify attempt could not be reconciled')
    } finally {
      setAction(null)
    }
    if (refreshOrderAfterReconciliation) {
      try {
        await onOrderChanged()
      } catch {
        setError('The Shopify attempt was reconciled, but the ClawPilot order drawer did not refresh. Reload the order before taking another action.')
      }
    }
  }

  const authorizationExpired = useMemo(
    () => pending ? Date.parse(pending.authorization.expiresAt) <= Date.now() : false,
    [pending],
  )

  if (!canManage || !canExecute || !canActivate) {
    const permissionReason = !canManage
      ? 'You do not have permission to view Shopify order management.'
      : !canActivate
        ? 'Only an organization owner or administrator with activation authority may authorize Shopify writes.'
        : 'You do not have permission to execute Shopify provider writes.'
    return (
      <Stack spacing={1.5} data-testid="shopify-order-management-panel">
        <Typography variant="h6" fontWeight={700}>Manage in Shopify</Typography>
        <Alert severity="info">{permissionReason}</Alert>
      </Stack>
    )
  }

  return (
    <Stack spacing={2} data-testid="shopify-order-management-panel" sx={{ minWidth: 0 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" fontWeight={700}>Manage in Shopify</Typography>
          <Typography variant="body2" color="text.secondary">
            Explicit, audited writes to the exact connected Shopify store.
          </Typography>
        </Box>
        <Button
          size="small"
          variant="outlined"
          startIcon={loading ? <CircularProgress size={16} /> : <RefreshRounded />}
          disabled={busy}
          onClick={() => void load()}
          sx={{ minHeight: 44, flexShrink: 0 }}
        >
          Reload Shopify authority
        </Button>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="info">{notice}</Alert>}
      {ambiguousExecution && (
        <Alert severity="error" icon={<WarningAmberRounded />}>
          The execution response was ambiguous. Do not execute again. Reload Shopify authority, then use reconciliation only if the exact attempt is recorded as unknown.
        </Alert>
      )}

      {!management ? (
        <Box sx={{ py: 2, display: 'flex', justifyContent: 'center' }}>
          {loading ? <CircularProgress size={28} /> : (
            <Typography variant="body2" color="text.secondary">
              Shopify management authority has not loaded.
            </Typography>
          )}
        </Box>
      ) : (
        <>
          <Alert severity="warning" icon={<WarningAmberRounded />}>
            <Typography fontWeight={700}>This panel performs real Shopify provider writes.</Typography>
            Prepare is read-only. Execute changes only order {management.order.name} ({management.order.externalOrderId}) in {management.shopDomain} through {management.accountLabel}.
          </Alert>

          {management.order.test === false ? (
            <Alert severity="error" data-testid="shopify-order-test-false-warning">
              <Typography fontWeight={700}>Shopify test flag: FALSE</Typography>
              Shopify does not classify {management.order.name} as a test order. Treat every execution here as a live-store change even when the order was created for ClawPilot testing.
            </Alert>
          ) : (
            <Alert severity="success">Shopify marks this exact order as a test order.</Alert>
          )}

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
              gap: 1.25,
              p: 1.5,
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '8px',
            }}
          >
            <AuditValue label="Connected store" value={`${management.accountLabel} · ${management.shopDomain}`} />
            <AuditValue label="Exact Shopify order" value={`${management.order.name} · ${management.order.externalOrderId}`} />
            <AuditValue label="ClawPilot order" value={management.order.globalId} />
            <AuditValue label="Exact row version" value={management.order.rowVersion} />
            <AuditValue label="Financial status" value={management.order.financialStatus} />
            <AuditValue label="Fulfillment status" value={management.order.fulfillmentStatus} />
            <AuditValue label="Merchant editable" value={String(management.order.merchantEditable)} />
          </Box>

          {management.order.tags.length > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              Current tags: {management.order.tags.join(', ')}
            </Typography>
          )}

          {globalBlockedReason && <Alert severity="info">{globalBlockedReason}</Alert>}

          {openAttempt && (
            <Alert
              severity={openAttempt.state === 'unknown'
                ? 'error'
                : openAttempt.state === 'processing'
                  ? 'warning'
                  : openAttempt.state === 'failed'
                    ? 'error'
                    : 'success'}
              data-testid="shopify-order-management-attempt"
            >
              <Typography fontWeight={700}>
                {displayAction(openAttempt.actionKind)} attempt: {openAttempt.state}
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {openAttempt.attemptGlobalId} · authorization {openAttempt.authorizationGlobalId}
                {openAttempt.providerReference ? ` · Shopify ${openAttempt.providerReference}` : ''}
                {openAttempt.errorCode ? ` · ${openAttempt.errorCode}` : ''}
                {' · '}provider writes {openAttempt.providerWrites === null
                  ? 'Unknown'
                  : openAttempt.providerWrites}
              </Typography>
              {(openAttempt.state === 'processing' || openAttempt.state === 'unknown') && (
                <Stack spacing={1} sx={{ mt: 1 }}>
                  <Typography variant="body2">
                    {openAttempt.state === 'processing'
                      ? 'The provider call may still be active. Check outcome without issuing another write; after the bounded processing lease, ClawPilot will recover the attempt to read-only reconciliation.'
                      : 'Shopify outcome is unknown. Reconciliation is the only available action and does not authorize a second provider write.'}
                  </Typography>
                  <Button
                    variant="outlined"
                    color="warning"
                    startIcon={action === 'reconcile' ? <CircularProgress size={16} /> : <ReplayRounded />}
                    disabled={busy}
                    onClick={() => void reconcile()}
                    sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
                    data-testid="reconcile-shopify-order-write"
                  >
                    {openAttempt.state === 'processing'
                      ? 'Check provider outcome'
                      : 'Reconcile unknown outcome'}
                  </Button>
                </Stack>
              )}
            </Alert>
          )}

          <TextField
            fullWidth
            label="Reason for this exact Shopify change"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value)
              clearPreparedAuthorization()
            }}
            error={reason.length > 0 && !reasonValid}
            helperText={reasonValid
              ? 'Stored with the prepared authorization and provider-write attempt.'
              : `Enter at least ${MINIMUM_REASON_LENGTH} characters.`}
            disabled={busy || Boolean(unresolvedAttempt)}
          />

          <Divider />

          <Box
            sx={{
              p: 1.5,
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '8px',
            }}
          >
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} alignItems="center">
                <LocalOfferRounded fontSize="small" />
                <Typography fontWeight={700}>Add Shopify tag</Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Add a traceable tag to an order such as #6600 without changing its lines or fulfillment.
              </Typography>
              <TextField
                fullWidth
                label="Tag to add"
                value={tag}
                onChange={(event) => {
                  setTag(event.target.value)
                  clearPreparedAuthorization()
                }}
                placeholder="ClawPilot test #6600"
                inputProps={{ maxLength: 255 }}
                error={tag.length > 0 && !tagValid}
                helperText={tag.length > 0 && !tagValid
                  ? 'Enter one Shopify tag without commas.'
                  : 'One exact tag will be added; existing tags remain unchanged.'}
                disabled={busy || Boolean(unresolvedAttempt)}
              />
              <Typography variant="caption" color="text.secondary">
                {actionDisclosure('add_tag')}
              </Typography>
              <Tooltip title={globalBlockedReason || management.eligibility.addTag.reason || ''}>
                <Box component="span" sx={{ display: 'block' }}>
                  <Button
                    fullWidth
                    variant="outlined"
                    startIcon={<LocalOfferRounded />}
                    disabled={busy
                      || Boolean(globalBlockedReason)
                      || !management.eligibility.addTag.allowed
                      || !reasonValid
                      || !tagValid}
                    onClick={() => void prepare({ kind: 'add_tag', tag: normalizedTag })}
                    sx={{ minHeight: 44 }}
                    data-testid="prepare-shopify-add-tag"
                  >
                    Review tag write
                  </Button>
                </Box>
              </Tooltip>
              <Reason value={management.eligibility.addTag.allowed
                ? null
                : management.eligibility.addTag.reason} />
            </Stack>
          </Box>

          <Box
            sx={{
              p: 1.5,
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '8px',
            }}
          >
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} alignItems="center">
                <EditRounded fontSize="small" />
                <Typography fontWeight={700}>Decrease Shopify line quantity</Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Each change is prepared and confirmed separately. Quantities can only decrease within Shopify&apos;s exact eligibility range.
              </Typography>
              <Alert severity="info">
                A line decrease is one reviewed action implemented by up to three Shopify writes: begin edit, set quantity, and commit edit. The result records the exact write count.
              </Alert>
              {management.order.lines.map((line) => {
                const eligibility = management.eligibility.lineEdits.find(
                  (item) => item.lineItemId === line.lineItemId,
                )
                const quantityText = lineQuantities[line.lineItemId] ?? ''
                const entered = Number(quantityText)
                const maximumDecrease = Math.min(
                  eligibility?.maxQuantity ?? line.quantity,
                  line.quantity - 1,
                )
                const quantityValid = /^[0-9]+$/.test(quantityText)
                  && Number.isSafeInteger(entered)
                  && entered >= (eligibility?.minQuantity ?? 0)
                  && entered <= maximumDecrease
                const disabledReason = !eligibility
                  ? 'No exact Shopify line-edit authority was returned.'
                  : !eligibility.allowed
                    ? eligibility.reason || 'Shopify did not allow this line edit.'
                    : maximumDecrease < eligibility.minQuantity
                      ? 'This line has no eligible lower quantity.'
                      : null
                return (
                  <Box
                    key={line.lineItemId}
                    sx={{
                      p: 1.25,
                      display: 'grid',
                      gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(128px, 0.45fr)' },
                      gap: 1.25,
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '6px',
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography fontWeight={600}>{line.title}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                        {line.lineItemId} · ordered {line.quantity} · unfulfilled {line.unfulfilledQuantity} · fulfilled {line.fulfilledQuantity}
                      </Typography>
                      <Reason value={disabledReason} />
                    </Box>
                    <Stack spacing={1}>
                      <TextField
                        type="number"
                        size="small"
                        label="New total quantity"
                        value={quantityText}
                        onChange={(event) => {
                          setLineQuantities((current) => ({
                            ...current,
                            [line.lineItemId]: event.target.value,
                          }))
                          clearPreparedAuthorization()
                        }}
                        inputProps={{
                          min: eligibility?.minQuantity ?? 0,
                          max: Math.max(eligibility?.minQuantity ?? 0, maximumDecrease),
                          step: 1,
                        }}
                        error={quantityText.length > 0 && !quantityValid}
                        disabled={busy || Boolean(unresolvedAttempt) || Boolean(disabledReason)}
                      />
                      <Tooltip title={globalBlockedReason || disabledReason || ''}>
                        <Box component="span" sx={{ display: 'block' }}>
                          <Button
                            fullWidth
                            variant="outlined"
                            startIcon={<EditRounded />}
                            disabled={busy
                              || Boolean(globalBlockedReason)
                              || Boolean(disabledReason)
                              || !reasonValid
                              || !quantityValid}
                            onClick={() => void prepare({
                              kind: 'set_line_quantity',
                              lineItemId: line.lineItemId,
                              quantity: entered,
                            })}
                            sx={{ minHeight: 44 }}
                            data-testid={`prepare-shopify-line-${line.lineItemId}`}
                          >
                            Review line decrease
                          </Button>
                        </Box>
                      </Tooltip>
                    </Stack>
                  </Box>
                )
              })}
              <Typography variant="caption" color="text.secondary">
                {actionDisclosure('set_line_quantity')}
              </Typography>
            </Stack>
          </Box>

          <Box
            sx={{
              p: 1.5,
              border: '1px solid rgba(239,154,154,0.32)',
              borderRadius: '8px',
            }}
          >
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} alignItems="center">
                <CancelRounded color="error" fontSize="small" />
                <Typography fontWeight={700}>Cancel Shopify order</Typography>
              </Stack>
              <Alert severity="error">
                This cancels {management.order.name} in Shopify. It is not the local inbound cancellation workflow.
              </Alert>
              <Typography variant="caption" color="text.secondary">
                {actionDisclosure('cancel')}
              </Typography>
              <Tooltip title={globalBlockedReason || management.eligibility.cancel.reason || ''}>
                <Box component="span" sx={{ display: 'block' }}>
                  <Button
                    fullWidth
                    variant="outlined"
                    color="error"
                    startIcon={<CancelRounded />}
                    disabled={busy
                      || Boolean(globalBlockedReason)
                      || !management.eligibility.cancel.allowed
                      || !reasonValid}
                    onClick={() => void prepare({ kind: 'cancel' })}
                    sx={{ minHeight: 44 }}
                    data-testid="prepare-shopify-cancel"
                  >
                    Review Shopify cancellation
                  </Button>
                </Box>
              </Tooltip>
              <Reason value={management.eligibility.cancel.allowed
                ? null
                : management.eligibility.cancel.reason} />
            </Stack>
          </Box>

          {lastResult && (
            <Box
              component="details"
              open
              sx={{
                p: 1.5,
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '8px',
              }}
              data-testid="shopify-order-management-result"
            >
              <Typography component="summary" fontWeight={700} sx={{ cursor: 'pointer' }}>
                Latest Shopify result · {lastResult.state}
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
                  gap: 1.25,
                  mt: 1.25,
                }}
              >
                <AuditValue label="Authorization ID" value={lastResult.authorizationGlobalId} />
                <AuditValue label="Attempt ID" value={lastResult.attemptGlobalId} />
                <AuditValue label="Shopify reference" value={lastResult.providerReference} />
                <AuditValue
                  label="Provider writes"
                  value={lastResult.providerWrites === null
                    ? 'Unknown'
                    : lastResult.providerWrites}
                />
                <AuditValue label="Provider reads" value={lastResult.providerReads} />
                <AuditValue label="Idempotent replay" value={String(lastResult.replayed)} />
              </Box>
            </Box>
          )}
        </>
      )}

      <Dialog
        open={Boolean(pending)}
        onClose={action ? undefined : clearPreparedAuthorization}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Confirm real Shopify write</DialogTitle>
        <DialogContent>
          {pending && management && (
            <Stack spacing={2} sx={{ pt: 0.5, minWidth: 0 }}>
              <Alert severity="error" icon={<WarningAmberRounded />}>
                Execute will write to {management.shopDomain}, exact order {management.order.name} ({management.order.externalOrderId}). Shopify test flag is {String(management.order.test).toUpperCase()}.
              </Alert>
              {error && <Alert severity="error">{error}</Alert>}
              <Box>
                <Typography variant="caption" color="text.secondary">Prepared change</Typography>
                <Typography fontWeight={700}>{mutationSummary(pending.mutation, management)}</Typography>
              </Box>
              <Typography variant="body2">{actionDisclosure(pending.mutation.kind)}</Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
                  gap: 1.25,
                }}
              >
                <AuditValue label="Authorization ID" value={pending.authorization.authorizationGlobalId} />
                <AuditValue label="Intent hash" value={pending.authorization.intentHash} />
                <AuditValue label="Expires at" value={pending.authorization.expiresAt} />
                <AuditValue label="ClawPilot row version" value={pending.requestRowVersion} />
                <AuditValue label="Prepare provider reads" value={pending.authorization.providerReads} />
                <AuditValue label="Prepare provider writes" value={pending.authorization.providerWrites} />
              </Box>
              <Box component="details">
                <Typography component="summary" variant="body2" fontWeight={700} sx={{ cursor: 'pointer' }}>
                  Prepared preview
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    mt: 1,
                    p: 1,
                    maxHeight: 180,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    fontSize: '0.75rem',
                    bgcolor: 'rgba(255,255,255,0.04)',
                    borderRadius: '6px',
                  }}
                >
                  {JSON.stringify(pending.authorization.preview, null, 2)}
                </Box>
              </Box>
              {authorizationExpired && (
                <Alert severity="error">This authorization expired. Close it and prepare the exact action again.</Alert>
              )}
              <TextField
                fullWidth
                label="Type the exact confirmation statement"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                helperText={pending.authorization.confirmationStatement}
                error={confirmation.length > 0
                  && confirmation !== pending.authorization.confirmationStatement}
                disabled={action === 'execute' || authorizationExpired}
                autoComplete="off"
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button
            onClick={clearPreparedAuthorization}
            disabled={action === 'execute'}
            sx={{ minHeight: 44, ml: '0 !important' }}
          >
            Close without writing
          </Button>
          <Button
            variant="contained"
            color="error"
            startIcon={action === 'execute' ? <CircularProgress size={16} /> : <WarningAmberRounded />}
            disabled={!pending
              || action === 'execute'
              || authorizationExpired
              || confirmation !== pending.authorization.confirmationStatement}
            onClick={() => void execute()}
            sx={{ minHeight: 44, ml: '0 !important' }}
            data-testid="execute-shopify-order-write"
          >
            Execute exact Shopify write
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
