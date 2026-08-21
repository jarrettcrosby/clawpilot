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
  CircularProgress,
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

type MutationKind = 'add_tag' | 'cancel' | 'set_line_quantity'
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
    lines: ShopifyLine[]
  }>
  eligibility: Readonly<{
    addTag: Readonly<{ allowed: boolean; reason: string | null }>
    cancel: Readonly<{ allowed: boolean; reason: string | null }>
    lineEdits: LineEligibility[]
  }>
  openAttempt?: OpenAttempt | null
}>
type ShopifyMutation = Readonly<{ kind: 'add_tag'; tag: string }>
  | Readonly<{ kind: 'cancel' }>
  | Readonly<{
      kind: 'set_line_quantity'
      lineItemId: string
      quantity: number
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
}>
type IdempotencyAttempt = { fingerprint: string; key: string }

const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const AUTHORIZATION_GLOBAL_ID = /^gsom(?:[0-9]{7}|[0-9a-v]{12})$/
const ATTEMPT_GLOBAL_ID = /^gsoa(?:[0-9]{7}|[0-9a-v]{12})$/
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,20}$/
const SHOPIFY_LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]{0,20}$/
const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/
const SHA256 = /^[a-f0-9]{64}$/

function idempotencyKey(action: 'save' | 'reconcile', exactId: string) {
  const nonce = typeof crypto !== 'undefined'
    && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `shopify-order-management:${action}:${exactId}:${nonce}`
}

function stableAttemptKey(
  reference: MutableRefObject<IdempotencyAttempt | null>,
  fingerprint: string,
  action: 'save' | 'reconcile',
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
function openAttempt(value: unknown): value is OpenAttempt {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<OpenAttempt>
  return typeof item.attemptGlobalId === 'string'
    && ATTEMPT_GLOBAL_ID.test(item.attemptGlobalId)
    && typeof item.authorizationGlobalId === 'string'
    && AUTHORIZATION_GLOBAL_ID.test(item.authorizationGlobalId)
    && typeof item.intentHash === 'string' && SHA256.test(item.intentHash)
    && (item.state === 'processing' || item.state === 'unknown')
    && ['add_tag', 'cancel', 'set_line_quantity'].includes(item.actionKind || '')
    && optionalText(item.providerReference)
    && optionalText(item.errorCode)
    && text(item.createdAt) && !Number.isNaN(Date.parse(item.createdAt))
    && text(item.updatedAt) && !Number.isNaN(Date.parse(item.updatedAt))
    && (item.providerWrites === null || (
      integer(item.providerWrites)
      && item.providerWrites >= 0
      && item.providerWrites <= 3
    ))
}
function management(value: unknown, orderGlobalId: string): value is ShopifyManagement {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ShopifyManagement>
  const order = item.order as Partial<ShopifyManagement['order']> | undefined
  const eligibility = item.eligibility as
    Partial<ShopifyManagement['eligibility']> | undefined
  const lines = Array.isArray(order?.lines) ? order.lines : []
  const edits = Array.isArray(eligibility?.lineEdits)
    ? eligibility.lineEdits
    : []
  return typeof item.runtimeAvailable === 'boolean'
    && optionalText(item.blockerCode)
    && text(item.accountLabel)
    && typeof item.shopDomain === 'string' && SHOPIFY_DOMAIN.test(item.shopDomain)
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
    && Array.isArray(order.tags) && order.tags.every(text)
    && lines.every(line)
    && typeof eligibility?.addTag?.allowed === 'boolean'
    && optionalText(eligibility.addTag.reason)
    && typeof eligibility?.cancel?.allowed === 'boolean'
    && optionalText(eligibility.cancel.reason)
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
      && item.providerWrites <= 3
    ))
    || !management(item.management, orderGlobalId)
  ) return null
  return item as ManagementResult
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
  disabled = false,
  onBusyChange,
  onOrderChanged,
}: {
  orderGlobalId: string
  orderRowVersion: number
  canManage: boolean
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onOrderChanged: () => void | Promise<void>
}) {
  const [state, setState] = useState<ShopifyManagement | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<'save' | 'reconcile' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tag, setTag] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [lastResult, setLastResult] = useState<ManagementResult | null>(null)
  const [ambiguousSave, setAmbiguousSave] = useState(false)
  const saveAttempt = useRef<IdempotencyAttempt | null>(null)
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
      setQuantities((current) => Object.fromEntries(
        payload.management!.order.lines.map((item) => [
          item.lineItemId,
          current[item.lineItemId] ?? String(Math.max(0, item.quantity - 1)),
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
    saveAttempt.current = null
    reconcileAttempt.current = null
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, orderRowVersion])

  useEffect(() => {
    onBusyChange?.(action !== null)
    return () => onBusyChange?.(false)
  }, [action, onBusyChange])

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
  const normalizedTag = tag.trim()
  const tagValid = normalizedTag.length > 0 && !normalizedTag.includes(',')

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
        setTag('')
        setNotice(saved.replayed
          ? 'The already-completed Shopify save was loaded.'
          : 'Saved to Shopify.')
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

          <Divider />

          <Box sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1.5 }}>
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} alignItems="center">
                <LocalOfferRounded fontSize="small" />
                <Typography fontWeight={700}>Tags</Typography>
              </Stack>
              {state.order.tags.length > 0 && (
                <Typography variant="body2" color="text.secondary">
                  {state.order.tags.join(', ')}
                </Typography>
              )}
              <TextField
                fullWidth
                label="Add a tag"
                value={tag}
                onChange={(event) => {
                  setTag(event.target.value)
                  saveAttempt.current = null
                }}
                inputProps={{ maxLength: 255 }}
                error={tag.length > 0 && !tagValid}
                helperText={tag.length > 0 && !tagValid
                  ? 'Enter one tag without commas.'
                  : 'Existing tags stay in place.'}
                disabled={busy || Boolean(retainedAttempt)}
              />
              <Tooltip title={blocker || state.eligibility.addTag.reason || ''}>
                <Box component="span" sx={{ display: 'block' }}>
                  <Button
                    fullWidth
                    variant="contained"
                    startIcon={action === 'save'
                      ? <CircularProgress size={16} />
                      : <LocalOfferRounded />}
                    disabled={busy
                      || Boolean(blocker)
                      || !state.eligibility.addTag.allowed
                      || !tagValid}
                    onClick={() => void save({ kind: 'add_tag', tag: normalizedTag })}
                    sx={{ minHeight: 44 }}
                    data-testid="save-shopify-add-tag"
                  >
                    Save tag
                  </Button>
                </Box>
              </Tooltip>
              <DisabledReason value={state.eligibility.addTag.allowed
                ? null
                : state.eligibility.addTag.reason} />
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
                  && entered >= (eligibility?.minQuantity ?? 0)
                  && entered <= (eligibility?.maxQuantity ?? -1)
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
                          max: eligibility?.maxQuantity ?? 0,
                          step: 1,
                        }}
                        error={quantityText.length > 0 && !quantityValid}
                        disabled={busy
                          || Boolean(retainedAttempt)
                          || Boolean(disabledReason)}
                      />
                      <Tooltip title={blocker || disabledReason || ''}>
                        <Box component="span" sx={{ display: 'block' }}>
                          <Button
                            fullWidth
                            variant="contained"
                            startIcon={action === 'save'
                              ? <CircularProgress size={16} />
                              : <EditRounded />}
                            disabled={busy
                              || Boolean(blocker)
                              || Boolean(disabledReason)
                              || !quantityValid}
                            onClick={() => void save({
                              kind: 'set_line_quantity',
                              lineItemId: item.lineItemId,
                              quantity: entered,
                            })}
                            sx={{ minHeight: 44 }}
                            data-testid={`save-shopify-line-${item.lineItemId}`}
                          >
                            Save quantity
                          </Button>
                        </Box>
                      </Tooltip>
                    </Stack>
                  </Box>
                )
              })}
            </Stack>
          </Box>

          <Box sx={{ p: 1.5, border: 1, borderColor: 'error.dark', borderRadius: 1.5 }}>
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} alignItems="center">
                <CancelRounded color="error" fontSize="small" />
                <Typography fontWeight={700}>Cancel order</Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Cancels {state.order.name} in Shopify. Refunds, restocking, and customer notifications remain separate.
              </Typography>
              <Tooltip title={blocker || state.eligibility.cancel.reason || ''}>
                <Box component="span" sx={{ display: 'block' }}>
                  <Button
                    fullWidth
                    variant="outlined"
                    color="error"
                    startIcon={action === 'save'
                      ? <CircularProgress size={16} />
                      : <CancelRounded />}
                    disabled={busy
                      || Boolean(blocker)
                      || !state.eligibility.cancel.allowed}
                    onClick={() => void save({ kind: 'cancel' })}
                    sx={{ minHeight: 44 }}
                    data-testid="save-shopify-cancel"
                  >
                    Cancel Shopify order
                  </Button>
                </Box>
              </Tooltip>
              <DisabledReason value={state.eligibility.cancel.allowed
                ? null
                : state.eligibility.cancel.reason} />
            </Stack>
          </Box>

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
