'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Collapse from '@mui/material/Collapse'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import HistoryRounded from '@mui/icons-material/HistoryRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import { createCommerceOrderHistoryRequestFence } from '@/lib/integrations/commerceOrderHistoryRequestFence'
import { commerceOrderQuantitySummary } from '@/lib/integrations/commerceOrderHistoryPresentation'

type CommerceProvider = 'shopify' | 'faire'

type HistoryItem = {
  observationGlobalId: string
  externalOrderId: string
  orderNumber: string
  orderGlobalId: string | null
  provider: CommerceProvider
  lifecycleState: string
  paymentState: string
  fulfillmentState: string
  returnState: string
  orderedQuantity: number
  currentQuantity: number | null
  unfulfilledQuantity: number | null
  fulfilledQuantity: number | null
  currency: string | null
  totalMinor: number | null
  lastProviderUpdatedAt: string | null
  lastObservedAt: string
  shipmentCount: number
  trackingCount: number
  latestTrackingCarrier: string | null
  latestTrackingNumber: string | null
  providerWrites: 0
}

type TimelineItem = {
  evidenceSource: 'provider' | 'clawpilot'
  evidenceGlobalId: string
  eventKind: string
  eventStatus: string | null
  occurredAt: string
  attributionSource: string
  actorEmail: string | null
  locationReference: string | null
  payload: Record<string, unknown>
}

type TimelineLine = {
  externalLineId: string
  externalProductId: string | null
  externalVariantId: string | null
  sku: string | null
  originalQuantity: number
  currentQuantity: number | null
  unfulfilledQuantity: number | null
  fulfilledQuantity: number | null
}

type HistoryResponse = {
  ok?: boolean
  error?: string
  code?: string
  state?: {
    provider: CommerceProvider
    authority: 'provider'
    readiness?: {
      blockers?: string[]
      coverageBasis?: string
      continuousTransport?: string
    }
    policy: null | {
      historicalObservationEnabled: boolean
      continuousObservationEnabled: boolean
      continuousTransport: string | null
    }
    latestBackfill: null | {
      globalId: string
      status: string
      completenessState: string | null
      providerRecordsSeen: number
      observationsAppended: number
      observationsPreserved: number
      lastErrorCode: string | null
      completedAt: string | null
      readAllOrdersScopeObserved: boolean | null
      returnHistoryState: string | null
    }
    providerWrites: 0
  } | null
  history?: {
    items: HistoryItem[]
    nextCursorObservationGlobalId: string | null
    snapshotObservationGlobalId: string | null
    providerWrites: 0
  }
  timeline?: {
    items: TimelineItem[]
    truncated: boolean
    limit: number
    providerWrites: 0
  } | null
}

const PICK_ASSIGNMENT_EVENT_KINDS = new Set([
  'operations.pick.assigned',
  'operations.pick.reassigned',
  'operations.pick.manager_unassigned',
])

function label(value: string | null | undefined) {
  if (!value) return 'Unknown'
  return value
    .replace(/_/gu, ' ')
    .replace(/\b\w/gu, (letter) => letter.toUpperCase())
}

function timestamp(value: string | null | undefined) {
  if (!value) return 'Not yet'
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed)
}

function money(minor: number | null, currency: string | null) {
  if (minor === null || !currency) return null
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(minor / 100)
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`
  }
}

function timelineAttribution(event: TimelineItem) {
  const assignedTo = typeof event.payload.assignedTo === 'string'
    ? event.payload.assignedTo.trim()
    : ''
  if (
    assignedTo
    && PICK_ASSIGNMENT_EVENT_KINDS.has(event.eventKind)
  ) return `Picker assigned: ${assignedTo}`
  if (
    event.eventKind === 'operations.pick.completed'
    && event.actorEmail
  ) {
    return `Picked by ${event.actorEmail}`
  }
  if (event.actorEmail) return `Recorded by ${event.actorEmail}`
  if (
    event.evidenceSource === 'provider'
    && event.attributionSource === 'unavailable'
  ) {
    return 'Provider staff unavailable'
  }
  return ''
}

function timelineLines(event: TimelineItem): TimelineLine[] {
  if (event.eventKind !== 'order_lines_snapshot') return []
  const values = event.payload.lines
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const line = value as Record<string, unknown>
    if (
      typeof line.externalLineId !== 'string'
      || typeof line.originalQuantity !== 'number'
      || !Number.isSafeInteger(line.originalQuantity)
    ) return []
    const optionalText = (field: unknown) => (
      typeof field === 'string' && field.trim() ? field : null
    )
    const optionalQuantity = (field: unknown) => (
      typeof field === 'number' && Number.isSafeInteger(field) ? field : null
    )
    return [{
      externalLineId: line.externalLineId,
      externalProductId: optionalText(line.externalProductId),
      externalVariantId: optionalText(line.externalVariantId),
      sku: optionalText(line.sku),
      originalQuantity: line.originalQuantity,
      currentQuantity: optionalQuantity(line.currentQuantity),
      unfulfilledQuantity: optionalQuantity(line.unfulfilledQuantity),
      fulfilledQuantity: optionalQuantity(line.fulfilledQuantity),
    }]
  })
}

function newIdempotencyKey() {
  return `commerce-history-${crypto.randomUUID()}`
}

function requestUrl(input: {
  accountGlobalId: string
  cursor?: string | null
  snapshot?: string | null
  externalOrderId?: string | null
}) {
  const query = new URLSearchParams({
    accountGlobalId: input.accountGlobalId,
    limit: '25',
  })
  if (input.cursor) query.set('cursorObservationGlobalId', input.cursor)
  if (input.snapshot) {
    query.set('snapshotObservationGlobalId', input.snapshot)
  }
  if (input.externalOrderId) query.set('externalOrderId', input.externalOrderId)
  return `/api/integrations/commerce/order-history?${query.toString()}`
}

export default function CommerceOrderHistoryPanel({
  accountGlobalId,
  provider,
  canManage,
  onOpenOrder,
}: {
  accountGlobalId: string
  provider: CommerceProvider
  canManage: boolean
  onOpenOrder: (orderGlobalId: string) => void
}) {
  const [payload, setPayload] = useState<HistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedExternalOrderId, setSelectedExternalOrderId] = useState('')
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [timelineTruncated, setTimelineTruncated] = useState(false)
  const [timelineLimit, setTimelineLimit] = useState(500)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const startKey = useRef(newIdempotencyKey())
  const viewScope = `${provider}:${accountGlobalId}`
  const renderedScope = useRef(viewScope)
  const historyRequests = useRef(
    createCommerceOrderHistoryRequestFence(viewScope),
  )
  const timelineRequests = useRef(
    createCommerceOrderHistoryRequestFence(viewScope),
  )
  const startRequests = useRef(
    createCommerceOrderHistoryRequestFence(viewScope),
  )

  if (renderedScope.current !== viewScope) {
    renderedScope.current = viewScope
    historyRequests.current.reset(viewScope)
    timelineRequests.current.reset(viewScope)
    startRequests.current.reset(viewScope)
  }

  const read = useCallback(async (options?: {
    cursor?: string | null
    snapshot?: string | null
    append?: boolean
  }) => {
    const append = options?.append === true
    const request = historyRequests.current.issue(viewScope)
    if (append) {
      setLoading(false)
      setLoadingMore(true)
    } else {
      setLoading(true)
      setLoadingMore(false)
    }
    setError('')
    try {
      const response = await fetch(requestUrl({
        accountGlobalId,
        cursor: options?.cursor,
        snapshot: options?.snapshot,
      }), { cache: 'no-store' })
      const next = await response.json() as HistoryResponse
      if (!response.ok || !next.history) {
        throw new Error(next.error || 'Order history is unavailable.')
      }
      if (!historyRequests.current.isCurrent(request)) return
      const nextHistory = next.history
      setPayload((current) => append && current?.history
        ? {
            ...next,
            history: {
              ...nextHistory,
              items: [...current.history.items, ...nextHistory.items],
            },
          }
        : next)
    } catch (caught) {
      if (!historyRequests.current.isCurrent(request)) return
      setError(
        caught instanceof Error
          ? caught.message
          : 'Order history is unavailable.',
      )
    } finally {
      if (historyRequests.current.isCurrent(request)) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [accountGlobalId, viewScope])

  useEffect(() => {
    setPayload(null)
    setSelectedExternalOrderId('')
    setTimeline([])
    setTimelineTruncated(false)
    setTimelineLimit(500)
    setLoadingMore(false)
    setStarting(false)
    setTimelineLoading(false)
    setNotice('')
    startKey.current = newIdempotencyKey()
    void read()
  }, [accountGlobalId, read])

  const start = async () => {
    const request = startRequests.current.issue(viewScope)
    const requestKey = startKey.current
    setStarting(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/integrations/commerce/order-history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': requestKey,
        },
        body: JSON.stringify({
          action: 'start',
          accountGlobalId,
          reason: 'Establish read-only provider order history for Operations',
        }),
      })
      const next = await response.json() as {
        ok?: boolean
        error?: string
        code?: string
        result?: { status?: string; replayed?: boolean }
      }
      if (!response.ok || !next.result) {
        if (
          startRequests.current.isCurrent(request)
          && next.code === 'COMMERCE_ORDER_SYNC_IDEMPOTENCY_CONFLICT'
        ) {
          startKey.current = newIdempotencyKey()
        }
        throw new Error(next.error || 'Order history could not be started.')
      }
      if (!startRequests.current.isCurrent(request)) return
      setNotice(
        next.result.status === 'blocked'
          ? 'Order history is blocked until the connection is ready.'
          : 'Order history is queued. Provider reads run in the background.',
      )
      // The server has durably accepted this request. A later operator retry
      // must be a new command even if this session subsequently becomes dead
      // or blocked; ambiguous/network outcomes retain the original key.
      startKey.current = newIdempotencyKey()
      await read()
    } catch (caught) {
      if (!startRequests.current.isCurrent(request)) return
      setError(
        caught instanceof Error
          ? caught.message
          : 'Order history could not be started.',
      )
    } finally {
      if (startRequests.current.isCurrent(request)) setStarting(false)
    }
  }

  const openTimeline = async (item: HistoryItem) => {
    const timelineScope = `${viewScope}:${item.externalOrderId}`
    const request = timelineRequests.current.issue(timelineScope)
    setSelectedExternalOrderId(item.externalOrderId)
    setTimeline([])
    setTimelineTruncated(false)
    setTimelineLimit(500)
    setTimelineLoading(true)
    setError('')
    try {
      const response = await fetch(requestUrl({
        accountGlobalId,
        externalOrderId: item.externalOrderId,
      }), { cache: 'no-store' })
      const next = await response.json() as HistoryResponse
      if (!response.ok || !Array.isArray(next.timeline?.items)) {
        throw new Error(next.error || 'The order timeline is unavailable.')
      }
      if (!timelineRequests.current.isCurrent(request)) return
      setTimeline(next.timeline.items)
      setTimelineTruncated(next.timeline.truncated === true)
      setTimelineLimit(next.timeline.limit)
    } catch (caught) {
      if (!timelineRequests.current.isCurrent(request)) return
      setError(
        caught instanceof Error
          ? caught.message
          : 'The order timeline is unavailable.',
      )
    } finally {
      if (timelineRequests.current.isCurrent(request)) {
        setTimelineLoading(false)
      }
    }
  }

  const state = payload?.state
  const latest = state?.latestBackfill
  const items = payload?.history?.items || []
  const canStart = (
    !state?.policy?.historicalObservationEnabled
    || latest?.status === 'blocked'
    || latest?.status === 'dead'
    || latest?.status === 'cancelled'
  )
  const statusColor = latest?.status === 'succeeded'
    ? 'success'
    : latest?.status === 'blocked' || latest?.status === 'failed'
      ? 'warning'
      : 'info'

  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
      <Stack spacing={1.5}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          gap={1}
        >
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>
              Order history
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {provider === 'shopify'
                ? 'Shopify · last 60 days · read only'
                : 'Faire · provider-available history · read only'}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            {latest ? (
              <Chip
                size="small"
                color={statusColor}
                variant="outlined"
                label={label(latest.status)}
              />
            ) : null}
            <Button
              size="small"
              variant="text"
              startIcon={loading ? <CircularProgress size={16} /> : <RefreshRounded />}
              disabled={loading || starting}
              onClick={() => void read()}
              sx={{ minHeight: 44 }}
            >
              Reload
            </Button>
            {canStart && canManage ? (
              <Button
                size="small"
                variant="outlined"
                startIcon={starting ? <CircularProgress size={16} /> : <HistoryRounded />}
                disabled={starting}
                onClick={() => void start()}
                sx={{ minHeight: 44 }}
              >
                {latest ? 'Retry history' : 'Start history'}
              </Button>
            ) : null}
          </Stack>
        </Stack>

        {error ? <Alert severity="error">{error}</Alert> : null}
        {notice ? <Alert severity="info">{notice}</Alert> : null}
        {latest?.lastErrorCode ? (
          <Alert severity="warning">
            History needs attention: {label(latest.lastErrorCode)}
          </Alert>
        ) : null}
        {provider === 'shopify' && latest?.returnHistoryState === 'unavailable' ? (
          <Alert severity="info">
            Shopify Return objects are not included because this connection has not granted read_returns. Order, cancellation, refund, fulfillment, and shipment history remain available.
          </Alert>
        ) : null}
        {latest?.completenessState === 'shopify_fixed_window_read_attempt_complete' ? (
          <Alert severity="info">
            The 60-day Shopify read completed with standard recent-order access. Shopify did not attest the oldest rolling-window edge; read_all_orders is required for full-window completeness evidence.
          </Alert>
        ) : null}

        {latest?.completedAt ? (
          <Typography variant="caption" color="text.secondary">
            Last completed {timestamp(latest.completedAt)} · {latest.providerRecordsSeen} provider orders · 0 provider writes
          </Typography>
        ) : null}

        {loading && !payload ? (
          <Box sx={{ minHeight: 96, display: 'grid', placeItems: 'center' }}>
            <CircularProgress size={28} />
          </Box>
        ) : items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {latest
              ? 'No provider orders are available in this history window yet.'
              : 'Start history to retain provider order and shipment activity in ClawPilot.'}
          </Typography>
        ) : (
          <Stack divider={<Divider flexItem />}>
            {items.map((item) => (
              <Box key={item.observationGlobalId} sx={{ py: 1.25 }}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  justifyContent="space-between"
                  alignItems={{ xs: 'stretch', sm: 'center' }}
                  gap={1}
                >
                  <Stack spacing={0.5} minWidth={0}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      <Typography variant="body2" fontWeight={700}>
                        {item.orderNumber}
                      </Typography>
                      <Chip size="small" variant="outlined" label={label(item.lifecycleState)} />
                      <Chip size="small" variant="outlined" label={label(item.fulfillmentState)} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {commerceOrderQuantitySummary(item)}
                      {money(item.totalMinor, item.currency)
                        ? ` · ${money(item.totalMinor, item.currency)}`
                        : ''}
                      {` · Updated ${timestamp(item.lastProviderUpdatedAt || item.lastObservedAt)}`}
                    </Typography>
                    {item.latestTrackingCarrier || item.latestTrackingNumber ? (
                      <Typography variant="caption" color="text.secondary">
                        {[item.latestTrackingCarrier, item.latestTrackingNumber]
                          .filter(Boolean)
                          .join(' · ')}
                      </Typography>
                    ) : null}
                  </Stack>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    {item.orderGlobalId ? (
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => onOpenOrder(item.orderGlobalId!)}
                        sx={{ minHeight: 44 }}
                      >
                        Open order
                      </Button>
                    ) : null}
                    <Button
                      size="small"
                      variant="text"
                      endIcon={
                        <ExpandMoreRounded
                          sx={{
                            transform: selectedExternalOrderId === item.externalOrderId
                              ? 'rotate(180deg)'
                              : 'none',
                            transition: 'transform 160ms ease',
                          }}
                        />
                      }
                      aria-expanded={selectedExternalOrderId === item.externalOrderId}
                      onClick={() => {
                        if (selectedExternalOrderId === item.externalOrderId) {
                          timelineRequests.current.reset(viewScope)
                          setSelectedExternalOrderId('')
                          setTimeline([])
                          setTimelineTruncated(false)
                          setTimelineLimit(500)
                        } else {
                          void openTimeline(item)
                        }
                      }}
                      sx={{ minHeight: 44 }}
                    >
                      Timeline
                    </Button>
                  </Stack>
                </Stack>
                <Collapse in={selectedExternalOrderId === item.externalOrderId}>
                  <Box
                    sx={{
                      mt: 1,
                      pl: { xs: 1.5, sm: 2 },
                      borderLeft: 2,
                      borderColor: 'divider',
                    }}
                  >
                    {timelineLoading ? (
                      <CircularProgress size={20} />
                    ) : timeline.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        No lifecycle events are available.
                      </Typography>
                    ) : (
                      <Stack spacing={1.25}>
                        {timelineTruncated ? (
                          <Alert severity="info">
                            Showing the latest {timelineLimit} events for this order.
                          </Alert>
                        ) : null}
                        {timeline.map((event) => {
                          const lines = timelineLines(event)
                          return (
                          <Box key={`${event.evidenceSource}:${event.evidenceGlobalId}`}>
                            <Typography variant="body2" fontWeight={600}>
                              {label(event.eventKind)}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" display="block">
                              {timestamp(event.occurredAt)} · {event.evidenceSource === 'clawpilot' ? 'ClawPilot' : provider === 'shopify' ? 'Shopify' : 'Faire'}
                            </Typography>
                            {timelineAttribution(event) ? (
                              <Typography variant="caption" color="text.secondary" display="block">
                                {timelineAttribution(event)}
                              </Typography>
                            ) : null}
                            {lines.length > 0 ? (
                              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                                {lines.map((line, index) => (
                                  <Typography
                                    key={line.externalLineId}
                                    variant="caption"
                                    color="text.secondary"
                                    display="block"
                                  >
                                    {line.sku ? `SKU ${line.sku}` : `Provider line ${index + 1}`}
                                    {` · ${line.originalQuantity} ordered`}
                                    {line.currentQuantity !== null
                                      ? ` · ${line.currentQuantity} current`
                                      : ''}
                                    {line.fulfilledQuantity !== null
                                      ? ` · ${line.fulfilledQuantity} fulfilled`
                                      : ''}
                                    {line.unfulfilledQuantity !== null
                                      ? ` · ${line.unfulfilledQuantity} remaining`
                                      : ''}
                                  </Typography>
                                ))}
                                <Typography variant="caption" color="text.secondary">
                                  Order demand—not a historical stock balance.
                                </Typography>
                              </Stack>
                            ) : null}
                          </Box>
                          )
                        })}
                      </Stack>
                    )}
                  </Box>
                </Collapse>
              </Box>
            ))}
          </Stack>
        )}

        {payload?.history?.nextCursorObservationGlobalId ? (
          <Button
            size="small"
            variant="text"
            disabled={loading || loadingMore}
            onClick={() => void read({
              cursor: payload.history?.nextCursorObservationGlobalId,
              snapshot: payload.history?.snapshotObservationGlobalId,
              append: true,
            })}
            sx={{ alignSelf: 'flex-start', minHeight: 44 }}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </Stack>
    </Paper>
  )
}
