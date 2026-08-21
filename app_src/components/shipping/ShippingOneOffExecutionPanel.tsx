'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'

import type {
  OneOffCarrierGroupCommandResult,
  OneOffPackedRateRefresh,
  OneOffShipmentExecutionState,
} from '@/lib/operations/oneOffShipments'
import { ONE_OFF_LIVE_POSTAGE_CONFIRMATION } from '@/lib/operations/oneOffShipmentConstants'

type ExecutionPayload = {
  ok?: boolean
  error?: string
  code?: string
  state?: OneOffShipmentExecutionState
  result?: OneOffPackedRateRefresh | OneOffCarrierGroupCommandResult
}

type CommandAction = 'packed-rate' | 'purchase' | 'void'
type RetainedCommand = { key: string; body: string }
type RefreshBody = {
  action: 'refresh-packed-rates'
  orderGlobalId: string
  expectedRowVersion: number
}
type PurchaseBody = {
  action: 'purchase-group'
  orderGlobalId: string
  purchaseQuoteGlobalId: string
  selectedOfferGlobalId: string
  expectedRowVersion: number
  reason: string
  confirmation?: string
}
type VoidBody = {
  action: 'void-group'
  orderGlobalId: string
  expectedRowVersion: number
  reason: string
}

function retainedCommandName(action: CommandAction, orderGlobalId: string) {
  return `clawpilot:shipping:${orderGlobalId}:${action}:command`
}

function readRetainedCommand(
  action: CommandAction,
  orderGlobalId: string,
): RetainedCommand | null {
  const storageKey = retainedCommandName(action, orderGlobalId)
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as {
      key?: unknown
      body?: unknown
    } | null
    if (
      parsed
      && typeof parsed.key === 'string'
      && parsed.key.length >= 8
      && typeof parsed.body === 'string'
    ) {
      JSON.parse(parsed.body)
      return { key: parsed.key, body: parsed.body }
    }
  } catch {
    // Invalid browser-local retry evidence must never be sent to a provider.
  }
  sessionStorage.removeItem(storageKey)
  return null
}

function retainCommand(
  action: CommandAction,
  orderGlobalId: string,
  command: RetainedCommand | null,
) {
  const storageKey = retainedCommandName(action, orderGlobalId)
  if (command) sessionStorage.setItem(storageKey, JSON.stringify(command))
  else sessionStorage.removeItem(storageKey)
}

function newCommand(
  action: CommandAction,
  orderGlobalId: string,
  body: RefreshBody | PurchaseBody | VoidBody,
): RetainedCommand {
  return {
    key: `shipping-one-off-${action}:${orderGlobalId}:${crypto.randomUUID()}`,
    body: JSON.stringify(body),
  }
}

function parsedCommandBody<T>(command: RetainedCommand | null): T | null {
  if (!command) return null
  try {
    return JSON.parse(command.body) as T
  } catch {
    return null
  }
}

async function readPayload(response: Response) {
  const raw = await response.text()
  try {
    return {
      malformed: false,
      payload: JSON.parse(raw) as ExecutionPayload,
    }
  } catch {
    return { malformed: true, payload: {} as ExecutionPayload }
  }
}

function definitiveClientRejection(response: Response, malformed: boolean) {
  return !malformed
    && response.status >= 400
    && response.status < 500
    && response.status !== 408
    && response.status !== 429
}

function payloadMessage(payload: ExecutionPayload, fallback: string) {
  return `${payload.error || fallback}${payload.code ? ` [${payload.code}]` : ''}`
}

function money(minor: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  }).format(minor / 100)
}

function refreshIsDurable(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
) {
  const body = parsedCommandBody<RefreshBody>(command)
  return Boolean(
    state
    && command
    && body?.action === 'refresh-packed-rates'
    && body.orderGlobalId === state.orderGlobalId
    && state.packedRate?.requestIdempotencyKey === command.key,
  )
}

function purchaseIsDurable(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
) {
  const body = parsedCommandBody<PurchaseBody>(command)
  const group = state?.carrierGroup
  return Boolean(
    state
    && command
    && body?.action === 'purchase-group'
    && body.orderGlobalId === state.orderGlobalId
    && group?.state === 'succeeded'
    && group.createRequestIdempotencyKey === command.key
    && group.purchaseQuoteGlobalId === body.purchaseQuoteGlobalId
    && group.purchaseOfferGlobalId === body.selectedOfferGlobalId,
  )
}

function voidIsDurable(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
) {
  const body = parsedCommandBody<VoidBody>(command)
  const group = state?.carrierGroup
  return Boolean(
    state
    && command
    && body?.action === 'void-group'
    && body.orderGlobalId === state.orderGlobalId
    && group?.voidState === 'succeeded'
    && group.voidRequestIdempotencyKey === command.key,
  )
}

export default function ShippingOneOffExecutionPanel({
  orderGlobalId,
  canPurchaseLivePostage,
  onUpdated,
}: {
  orderGlobalId: string
  canPurchaseLivePostage: boolean
  onUpdated: () => void | Promise<void>
}) {
  const [state, setState] = useState<OneOffShipmentExecutionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'refresh' | 'purchase' | 'void' | ''>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedOfferGlobalId, setSelectedOfferGlobalId] = useState('')
  const [purchaseReason, setPurchaseReason] = useState(
    'Create labels for the reviewed current rate and exact packed one-off parcels',
  )
  const [voidReason, setVoidReason] = useState(
    'Cancel the exact complete one-off carrier shipment before shipment confirmation',
  )
  const [liveConfirmed, setLiveConfirmed] = useState(false)
  const [refreshCommand, setRefreshCommand] = useState<RetainedCommand | null>(null)
  const [purchaseCommand, setPurchaseCommand] = useState<RetainedCommand | null>(null)
  const [voidCommand, setVoidCommand] = useState<RetainedCommand | null>(null)
  const [clock, setClock] = useState(() => Date.now())

  const clearRefreshCommand = useCallback(() => {
    setRefreshCommand(null)
    retainCommand('packed-rate', orderGlobalId, null)
  }, [orderGlobalId])
  const clearPurchaseCommand = useCallback(() => {
    setPurchaseCommand(null)
    retainCommand('purchase', orderGlobalId, null)
  }, [orderGlobalId])
  const clearVoidCommand = useCallback(() => {
    setVoidCommand(null)
    retainCommand('void', orderGlobalId, null)
  }, [orderGlobalId])

  const loadState = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/operations/one-off-shipments?orderGlobalId=${encodeURIComponent(orderGlobalId)}`,
        { cache: 'no-store' },
      )
      const { malformed, payload } = await readPayload(response)
      if (malformed || !response.ok || !payload.ok || !payload.state) {
        throw new Error(payloadMessage(payload, 'One-off postage status is unavailable'))
      }
      setState(payload.state)
      setClock(Date.now())
      return payload.state
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'One-off postage status is unavailable')
      return null
    } finally {
      setLoading(false)
    }
  }, [orderGlobalId])

  useEffect(() => {
    setState(null)
    setError('')
    setNotice('')
    setSelectedOfferGlobalId('')
    setLiveConfirmed(false)
    setRefreshCommand(readRetainedCommand('packed-rate', orderGlobalId))
    setPurchaseCommand(readRetainedCommand('purchase', orderGlobalId))
    setVoidCommand(readRetainedCommand('void', orderGlobalId))
    void loadState()
  }, [loadState, orderGlobalId])

  useEffect(() => {
    if (refreshIsDurable(state, refreshCommand)) clearRefreshCommand()
    if (purchaseIsDurable(state, purchaseCommand)) clearPurchaseCommand()
    if (voidIsDurable(state, voidCommand)) clearVoidCommand()
  }, [
    clearPurchaseCommand,
    clearRefreshCommand,
    clearVoidCommand,
    purchaseCommand,
    refreshCommand,
    state,
    voidCommand,
  ])

  const sortedOffers = useMemo(() => (
    [...(state?.packedRate?.offers || [])].sort((left, right) => (
      left.amountMinor - right.amountMinor
    ))
  ), [state?.packedRate?.offers])

  useEffect(() => {
    if (!sortedOffers.length) {
      setSelectedOfferGlobalId('')
      return
    }
    if (!sortedOffers.some((offer) => offer.globalId === selectedOfferGlobalId)) {
      const executable = sortedOffers.find((offer) => (
        offer.executionCapability === 'direct_purchase_later'
      ))
      setSelectedOfferGlobalId(executable?.globalId || '')
    }
  }, [selectedOfferGlobalId, sortedOffers])

  const expiresAt = state?.packedRate
    ? new Date(state.packedRate.expiresAt).getTime()
    : 0
  useEffect(() => {
    if (!expiresAt || expiresAt <= clock) return
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.min(expiresAt - clock + 25, 2_147_483_647),
    )
    return () => window.clearTimeout(timer)
  }, [clock, expiresAt])

  const group = state?.carrierGroup || null
  const live = state?.executionMode === 'live'
  const liveAllowed = !live || canPurchaseLivePostage
  const unresolved = group?.unresolved === true
  const retryingUnresolvedPurchase = Boolean(
    purchaseCommand
    && group
    && (group.state === 'prepared' || group.state === 'unknown'),
  )
  const retryingUnresolvedVoid = Boolean(
    voidCommand
    && group
    && (group.voidState === 'prepared' || group.voidState === 'unknown'),
  )
  const packedRateCurrent = Boolean(
    state?.packedRate
    && !state.packedRate.consumed
    && state.packedRate.status !== 'failed'
    && expiresAt > clock,
  )

  const refreshRates = async () => {
    if (
      !state
      || busy
      || !liveAllowed
      || unresolved
      || purchaseCommand
      || voidCommand
    ) return
    const command = refreshCommand || newCommand('packed-rate', orderGlobalId, {
      action: 'refresh-packed-rates',
      orderGlobalId,
      expectedRowVersion: state.rowVersion,
    })
    setRefreshCommand(command)
    retainCommand('packed-rate', orderGlobalId, command)
    setBusy('refresh')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.key,
        },
        body: command.body,
      })
      const { malformed, payload } = await readPayload(response)
      const validResult = Boolean(
        response.ok
        && payload.ok
        && payload.result
        && 'quote' in payload.result
        && payload.result.orderGlobalId === orderGlobalId,
      )
      if (!validResult) {
        if (definitiveClientRejection(response, malformed)) {
          clearRefreshCommand()
          await loadState()
          setError(
            `${payloadMessage(payload, 'Current packed rates were rejected')} `
            + 'The rejected request was not retained; review the current status before trying again.',
          )
          return
        }
        throw new Error(payloadMessage(payload, 'Current packed rates did not return a complete response'))
      }
      const result = payload.result as OneOffPackedRateRefresh
      const durable = await loadState()
      if (
        !refreshIsDurable(durable, command)
        || durable?.packedRate?.quoteGlobalId !== result.quote.globalId
      ) {
        throw new Error('The packed-rate response is not yet bound to the exact durable request')
      }
      clearRefreshCommand()
      setNotice(
        `${result.quote.offers.length} current ${result.executionMode.toUpperCase()} `
        + `${result.quote.offers.length === 1 ? 'rate is' : 'rates are'} ready.`,
      )
    } catch (caught) {
      const durable = await loadState()
      if (refreshIsDurable(durable, command)) {
        clearRefreshCommand()
        setNotice('The prior exact packed-rate request succeeded; durable rates are current.')
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'Current packed rates did not complete'}. `
          + 'The byte-identical request and key are retained; check status or retry this exact request.',
        )
      }
    } finally {
      setBusy('')
    }
  }

  const purchaseLabels = async () => {
    if (
      !state
      || busy
      || !liveAllowed
      || Boolean(refreshCommand || voidCommand)
      || (!purchaseCommand && !packedRateCurrent)
      || (!purchaseCommand && !state.packedRate)
      || (!purchaseCommand && !selectedOfferGlobalId)
      || (!purchaseCommand && purchaseReason.trim().length < 10)
      || (live && !liveConfirmed)
    ) return
    const command = purchaseCommand || newCommand('purchase', orderGlobalId, {
      action: 'purchase-group',
      orderGlobalId,
      purchaseQuoteGlobalId: state.packedRate!.quoteGlobalId,
      selectedOfferGlobalId,
      expectedRowVersion: state.rowVersion,
      reason: purchaseReason.trim(),
      ...(live ? { confirmation: ONE_OFF_LIVE_POSTAGE_CONFIRMATION } : {}),
    })
    setPurchaseCommand(command)
    retainCommand('purchase', orderGlobalId, command)
    setBusy('purchase')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.key,
        },
        body: command.body,
      })
      const { malformed, payload } = await readPayload(response)
      const validResult = Boolean(
        response.ok
        && payload.ok
        && payload.result
        && 'groupAttemptGlobalId' in payload.result
        && payload.result.action === 'create'
        && payload.result.orderGlobalId === orderGlobalId,
      )
      if (!validResult) {
        if (definitiveClientRejection(response, malformed)) {
          clearPurchaseCommand()
          await loadState()
          setError(
            `${payloadMessage(payload, 'The carrier label request was rejected')} `
            + 'The rejected request was not retained; review the current quote and status before trying again.',
          )
          return
        }
        throw new Error(payloadMessage(payload, 'The exact carrier label request did not complete'))
      }
      const result = payload.result as OneOffCarrierGroupCommandResult
      const durable = await loadState()
      if (
        !purchaseIsDurable(durable, command)
        || durable?.carrierGroup?.createAttemptGlobalId !== result.groupAttemptGlobalId
      ) {
        throw new Error('The label response is not yet bound to the exact order, quote, offer, and request key')
      }
      clearPurchaseCommand()
      setLiveConfirmed(false)
      setNotice(
        `${result.executionMode.toUpperCase()} carrier group `
        + `${result.groupAttemptGlobalId} returned ${result.labels.length} `
        + `${result.labels.length === 1 ? 'label' : 'labels'}.`,
      )
      await onUpdated()
    } catch (caught) {
      const durable = await loadState()
      if (purchaseIsDurable(durable, command)) {
        clearPurchaseCommand()
        setLiveConfirmed(false)
        setNotice('The prior exact label request succeeded; its durable labels are shown below.')
        await onUpdated()
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'The exact carrier label request did not complete'}. `
          + 'Do not start a new request. Check durable status or retry the retained byte-identical request.',
        )
      }
    } finally {
      setBusy('')
    }
  }

  const voidLabels = async () => {
    if (
      !state
      || (!group?.active && !retryingUnresolvedVoid)
      || busy
      || !liveAllowed
      || Boolean(refreshCommand || purchaseCommand)
      || (!voidCommand && voidReason.trim().length < 10)
    ) return
    const command = voidCommand || newCommand('void', orderGlobalId, {
      action: 'void-group',
      orderGlobalId,
      expectedRowVersion: state.rowVersion,
      reason: voidReason.trim(),
    })
    setVoidCommand(command)
    retainCommand('void', orderGlobalId, command)
    setBusy('void')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.key,
        },
        body: command.body,
      })
      const { malformed, payload } = await readPayload(response)
      const validResult = Boolean(
        response.ok
        && payload.ok
        && payload.result
        && 'groupAttemptGlobalId' in payload.result
        && payload.result.action !== 'create'
        && payload.result.orderGlobalId === orderGlobalId,
      )
      if (!validResult) {
        if (definitiveClientRejection(response, malformed)) {
          clearVoidCommand()
          await loadState()
          setError(
            `${payloadMessage(payload, 'The carrier cancellation was rejected')} `
            + 'The rejected request was not retained; review the current group before trying again.',
          )
          return
        }
        throw new Error(payloadMessage(payload, 'The exact carrier cancellation did not complete'))
      }
      const result = payload.result as OneOffCarrierGroupCommandResult
      const durable = await loadState()
      if (
        !voidIsDurable(durable, command)
        || durable?.carrierGroup?.voidAttemptGlobalId !== result.groupAttemptGlobalId
      ) {
        throw new Error('The cancellation response is not yet bound to the exact carrier group and request key')
      }
      clearVoidCommand()
      setNotice(
        result.action === 'close_sample'
          ? 'The complete TEST sample label group was closed locally with zero provider writes.'
          : 'The complete carrier label group was voided.',
      )
      await onUpdated()
    } catch (caught) {
      const durable = await loadState()
      if (voidIsDurable(durable, command)) {
        clearVoidCommand()
        setNotice('The prior exact cancellation succeeded; durable status is current.')
        await onUpdated()
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'The exact carrier cancellation did not complete'}. `
          + 'Do not create a new cancellation. Check status or retry the retained byte-identical request.',
        )
      }
    } finally {
      setBusy('')
    }
  }

  if (loading && !state) {
    return <Typography color="text.secondary">Loading exact postage status…</Typography>
  }

  return (
    <Stack spacing={1.5} data-testid="shipping-one-off-execution-panel">
      <Stack direction="row" gap={1} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip
          size="small"
          color={live ? 'warning' : 'success'}
          label={live ? 'LIVE production' : 'TEST sandbox'}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`${state?.packageCount || 0} packed parcel${state?.packageCount === 1 ? '' : 's'}`}
        />
        <Button
          size="small"
          startIcon={<RefreshRounded />}
          disabled={Boolean(busy)}
          onClick={() => { setError(''); void loadState() }}
        >
          Check status
        </Button>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}
      {!liveAllowed && (
        <Alert severity="warning">
          Live-postage permission is required for production rates, labels, and cancellation.
        </Alert>
      )}
      {unresolved && (
        <Alert severity="warning">
          Carrier outcome is unresolved. Check status and use only the retained exact request; a new provider request is fenced.
        </Alert>
      )}
      {(refreshCommand || purchaseCommand || voidCommand) && (
        <Alert severity="info" data-testid="shipping-retained-exact-request">
          An ambiguous request retains its byte-identical body and Idempotency-Key. Editing fields does not change that retry; a definitive 4xx rejection clears it and requires fresh review.
        </Alert>
      )}

      {group && (group.active || retryingUnresolvedVoid) ? (
        <Stack spacing={1.25}>
          <Alert severity={group.active ? 'success' : 'warning'}>
            {group.active
              ? `${group.labels.length} active ${group.labels.length === 1 ? 'label' : 'labels'} · master tracking ${group.masterTrackingNumber}`
              : 'The exact cancellation has an unresolved durable outcome.'}
          </Alert>
          <Box>
            {group.labels.map((label) => (
              <Typography key={label.labelGlobalId} variant="body2">
                Parcel {label.packageNumber}: {label.trackingNumber}
                {label.printWarning ? ` · ${label.printWarning}` : ''}
              </Typography>
            ))}
          </Box>
          <TextField
            size="small"
            label="Cancellation reason"
            value={voidReason}
            disabled={Boolean(voidCommand)}
            onChange={(event) => setVoidReason(event.target.value)}
            inputProps={{ maxLength: 500 }}
          />
          <Button
            color="warning"
            variant="outlined"
            disabled={
              Boolean(busy)
              || !liveAllowed
              || Boolean(refreshCommand || purchaseCommand)
              || (!voidCommand && voidReason.trim().length < 10)
            }
            onClick={() => { void voidLabels() }}
          >
            {busy === 'void'
              ? 'Checking exact cancellation…'
              : voidCommand
                ? 'Retry exact cancellation'
                : group.lifecycleMode === 'local_sample_close'
                  ? 'Close complete TEST sample group'
                  : 'Void complete carrier label group'}
          </Button>
        </Stack>
      ) : (
        <Stack spacing={1.25}>
          <Button
            variant="outlined"
            disabled={
              Boolean(busy)
              || !state
              || !liveAllowed
              || Boolean(purchaseCommand || voidCommand)
              || unresolved
            }
            onClick={() => { void refreshRates() }}
          >
            {busy === 'refresh'
              ? 'Requesting current packed rates…'
              : refreshCommand
                ? 'Retry exact packed-rate request'
                : 'Get current packed rates'}
          </Button>
          {state?.packedRate && (
            <Typography variant="caption" color="text.secondary">
              Rates expire {new Date(state.packedRate.expiresAt).toLocaleString()}.
            </Typography>
          )}
          {sortedOffers.length > 0 && (
            <TextField
              select
              size="small"
              label="Carrier service"
              value={selectedOfferGlobalId}
              disabled={Boolean(purchaseCommand)}
              onChange={(event) => setSelectedOfferGlobalId(event.target.value)}
            >
              {sortedOffers.map((offer) => (
                <MenuItem
                  key={offer.globalId}
                  value={offer.globalId}
                  disabled={offer.executionCapability !== 'direct_purchase_later'}
                >
                  {offer.providerLabel} · {offer.serviceName} · {money(offer.amountMinor, offer.currency)}
                </MenuItem>
              ))}
            </TextField>
          )}
          <TextField
            size="small"
            label="Label request reason"
            value={purchaseReason}
            disabled={Boolean(purchaseCommand)}
            onChange={(event) => setPurchaseReason(event.target.value)}
            inputProps={{ maxLength: 500 }}
          />
          {live && liveAllowed && (
            <FormControlLabel
              control={<Checkbox checked={liveConfirmed} onChange={(event) => setLiveConfirmed(event.target.checked)} />}
              label="I confirm this LIVE request may purchase production postage for every exact packed parcel."
            />
          )}
          <Button
            variant="contained"
            disabled={
              Boolean(busy)
              || !liveAllowed
              || Boolean(refreshCommand || voidCommand)
              || (!purchaseCommand && !packedRateCurrent)
              || (unresolved && !retryingUnresolvedPurchase)
              || (!purchaseCommand && !selectedOfferGlobalId)
              || (!purchaseCommand && purchaseReason.trim().length < 10)
              || (live && !liveConfirmed)
            }
            onClick={() => { void purchaseLabels() }}
          >
            {busy === 'purchase'
              ? 'Checking exact carrier result…'
              : purchaseCommand
                ? 'Retry exact label request'
                : live
                  ? 'Purchase LIVE postage'
                  : 'Create TEST labels'}
          </Button>
        </Stack>
      )}
    </Stack>
  )
}
