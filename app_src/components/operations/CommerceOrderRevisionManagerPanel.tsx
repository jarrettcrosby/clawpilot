'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import CancelRounded from '@mui/icons-material/CancelRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SyncAltRounded from '@mui/icons-material/SyncAltRounded'

type RevisionProvider = 'shopify' | 'faire'

type RevisionState = Readonly<{
  observationGlobalId: string
  readGlobalId: string
  sourceHash: string
  revisionHash: string
  materialState:
    | 'current'
    | 'review_required'
    | 'provider_cancelled'
    | 'provider_fulfilled'
  capturedAt: string
  fresh: boolean
  changed: boolean
  applyEligible: boolean
  applyBlockedCode: string | null
  cancellationEligible: boolean
  providerReads: number
  providerWrites: 0
  applicationGlobalId: string | null
  exceptionGlobalId: string | null
}>

export type CommerceOrderRevisionManagerFixture = Readonly<{
  eligible: boolean
  provider: RevisionProvider
  orderGlobalId: string
  orderRowVersion: number
  orderStatus: string
  state: RevisionState | null
}>

type RevisionPayload = Readonly<{
  ok?: boolean
  error?: string
  code?: string
  revision?: CommerceOrderRevisionManagerFixture
  result?: {
    replayed?: boolean
    revision?: CommerceOrderRevisionManagerFixture
    orderGlobalId?: string
    observationGlobalId?: string
    readGlobalId?: string
    sourceHash?: string
    revisionHash?: string
    previousRowVersion?: number
    newRowVersion?: number
    providerWrites?: number
    applicationGlobalId?: string
    dispositionGlobalId?: string
    previousStatus?: string
    status?: string
  }
}>

type ExactAction = 'apply-to-clawpilot' | 'accept-provider-cancellation'

const MINIMUM_REASON_LENGTH = 10

function providerLabel(provider: RevisionProvider) {
  return provider === 'faire' ? 'Faire' : 'Shopify'
}

function blockedMessage(code: string | null, provider: RevisionProvider) {
  switch (code) {
    case 'COMMERCE_ORDER_REVISION_APPLY_DISABLED':
      return 'Updating ClawPilot is temporarily disabled. Refresh remains available; use manager recovery for an urgent change.'
    case 'COMMERCE_ORDER_REVISION_ORDER_STARTED':
    case 'COMMERCE_ORDER_REVISION_DOWNSTREAM_EXISTS':
      return 'Warehouse work or another downstream action has started. Keep the sales-channel order and ClawPilot evidence intact, then use manager recovery.'
    case 'COMMERCE_ORDER_REVISION_READ_STALE':
      return `Refresh from ${providerLabel(provider)} again before updating ClawPilot.`
    case 'COMMERCE_ORDER_REVISION_PROTECTED_HEADER_UNAVAILABLE':
      return 'Required customer or delivery details are unavailable. Refresh again or use manager recovery.'
    case 'FAIRE_ORDER_REVISION_LINE_QUANTITY_INCOMPLETE':
      return 'Faire did not return a complete set of line items and quantities. Updating ClawPilot is blocked; use manager recovery.'
    case 'COMMERCE_ORDER_REVISION_PROVIDER_FACTS_INCOMPLETE':
      return 'The sales channel did not return a complete order. Refresh again or use manager recovery.'
    case 'COMMERCE_ORDER_REVISION_NOT_APPLICABLE':
      return 'This sales-channel order does not require a ClawPilot update.'
    default:
      return 'ClawPilot cannot update this order automatically. Refresh again or use manager recovery.'
  }
}

function actionIdempotencyKey(
  action: 'refresh-from-provider' | ExactAction,
  orderGlobalId: string,
  rowVersion: number,
  readGlobalId?: string,
) {
  const nonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  if (action !== 'refresh-from-provider' && readGlobalId) {
    return `operations-order-revision:${action}:${readGlobalId}:${nonce}`
  }
  return `operations-order-revision:refresh:${orderGlobalId}:v${rowVersion}:${nonce}`
}

export default function CommerceOrderRevisionManagerPanel({
  orderGlobalId,
  provider,
  orderRowVersion,
  orderStatus,
  canManage,
  canExecute,
  disabled = false,
  developmentFixture,
  onBusyChange,
  onOrderChanged,
  onReviewRecovery,
}: {
  orderGlobalId: string
  provider: RevisionProvider
  orderRowVersion: number
  orderStatus: string
  canManage: boolean
  canExecute: boolean
  disabled?: boolean
  developmentFixture?: CommerceOrderRevisionManagerFixture
  onBusyChange?: (busy: boolean) => void
  onOrderChanged: () => void | Promise<void>
  onReviewRecovery: (exceptionGlobalId: string) => void | Promise<void>
}) {
  const [revision, setRevision] = useState<CommerceOrderRevisionManagerFixture | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<'refresh' | 'apply' | 'cancel' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<ExactAction | null>(null)
  const [reason, setReason] = useState('')
  const refreshIdempotencyAttempt = useRef<{
    fingerprint: string
    key: string
  } | null>(null)
  const exactIdempotencyAttempt = useRef<{
    fingerprint: string
    key: string
  } | null>(null)
  const label = providerLabel(provider)
  const fixtureRevision = process.env.NEXT_PUBLIC_LOCAL_UI_FIXTURES === '1'
    ? developmentFixture
    : undefined

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!canManage) return
    setLoading(true)
    setError('')
    try {
      if (fixtureRevision) {
        if (
          fixtureRevision.orderGlobalId !== orderGlobalId
          || fixtureRevision.provider !== provider
        ) throw new Error('Development fixture did not match this order')
        setRevision(fixtureRevision)
        return
      }
      const query = new URLSearchParams({ orderGlobalId })
      const response = await fetch(
        `/api/operations/order-revisions?${query.toString()}`,
        { cache: 'no-store', signal },
      )
      const payload = await response.json().catch(() => ({})) as RevisionPayload
      if (!response.ok || !payload.ok || !payload.revision) {
        throw new Error(`${payload.error || 'Sales-channel order state is unavailable'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      if (
        payload.revision.orderGlobalId !== orderGlobalId
        || payload.revision.provider !== provider
      ) {
        throw new Error('Sales-channel order state did not match this order')
      }
      setRevision(payload.revision)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error
        ? caught.message
        : 'Sales-channel order state is unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [canManage, fixtureRevision, orderGlobalId, provider])

  useEffect(() => {
    setRevision(null)
    setNotice('')
    setError('')
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, orderRowVersion])

  useEffect(() => {
    onBusyChange?.(action !== null)
    return () => onBusyChange?.(false)
  }, [action, onBusyChange])

  const exactState = revision?.state || null
  const effectiveRowVersion = revision?.orderRowVersion ?? orderRowVersion
  const busy = disabled || loading || action !== null
  const changedAtProvider = exactState?.changed === true
  const exactBindingCurrent = revision?.orderRowVersion === orderRowVersion
  const recoveryOnly = orderStatus !== 'imported'
    || revision?.orderStatus !== 'imported'
    || exactState?.applyBlockedCode === 'COMMERCE_ORDER_REVISION_DOWNSTREAM_EXISTS'
    || exactState?.materialState === 'provider_fulfilled'
  const canApply = Boolean(
    canExecute
    && !recoveryOnly
    && exactBindingCurrent
    && exactState?.fresh
    && exactState.changed
    && exactState.applyEligible
    && exactState.materialState === 'review_required',
  )
  const canAcceptCancellation = Boolean(
    canExecute
    && !recoveryOnly
    && exactBindingCurrent
    && exactState?.fresh
    && exactState.cancellationEligible
    && exactState.materialState === 'provider_cancelled',
  )
  const reviewRecoveryExceptionGlobalId = exactBindingCurrent
    && exactState?.changed
    && exactState.exceptionGlobalId
    && (
      (
        recoveryOnly
        && exactState.materialState !== 'provider_fulfilled'
      )
      || (
        exactState.materialState === 'review_required'
        && !exactState.applyEligible
        && exactState.applyBlockedCode !== 'COMMERCE_ORDER_REVISION_READ_STALE'
        && exactState.applyBlockedCode !== 'COMMERCE_ORDER_REVISION_NOT_APPLICABLE'
      )
      || (
        exactState.materialState === 'provider_cancelled'
        && !exactState.cancellationEligible
      )
    )
      ? exactState.exceptionGlobalId
      : null

  const capturedLabel = useMemo(() => {
    if (!exactState?.capturedAt) return null
    const captured = new Date(exactState.capturedAt)
    return Number.isFinite(captured.getTime()) ? captured.toLocaleString() : null
  }, [exactState?.capturedAt])

  async function post(
    nextAction: 'refresh-from-provider' | ExactAction,
    actionReason?: string,
  ) {
    const actionName = nextAction === 'refresh-from-provider'
      ? 'refresh'
      : nextAction === 'apply-to-clawpilot'
        ? 'apply'
        : 'cancel'
    setAction(actionName)
    setError('')
    setNotice('')
    try {
      if (fixtureRevision) {
        setNotice(nextAction === 'refresh-from-provider'
          ? fixtureRevision.state?.changed
            ? `${label} changed. Review the available ClawPilot action.`
            : ''
          : nextAction === 'apply-to-clawpilot'
            ? 'Simulated locally; no sales-channel write.'
            : 'Cancellation simulated locally; no sales-channel write.')
        setConfirmation(null)
        setReason('')
        return
      }
      const requestRowVersion = nextAction === 'refresh-from-provider'
        ? orderRowVersion
        : effectiveRowVersion
      const body = nextAction === 'refresh-from-provider'
        ? {
            action: nextAction,
            orderGlobalId,
            expectedRowVersion: requestRowVersion,
          }
        : exactState && {
            action: nextAction,
            orderGlobalId,
            observationGlobalId: exactState.observationGlobalId,
            readGlobalId: exactState.readGlobalId,
            expectedSourceHash: exactState.sourceHash,
            expectedRevisionHash: exactState.revisionHash,
            expectedRowVersion: requestRowVersion,
            reason: actionReason,
          }
      if (!body) throw new Error(`Refresh from ${label} before continuing`)

      const response = await fetch('/api/operations/order-revisions', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': (() => {
            if (nextAction !== 'refresh-from-provider') {
              const fingerprint = JSON.stringify(body)
              if (exactIdempotencyAttempt.current?.fingerprint !== fingerprint) {
                exactIdempotencyAttempt.current = {
                  fingerprint,
                  key: actionIdempotencyKey(
                    nextAction,
                    orderGlobalId,
                    requestRowVersion,
                    exactState?.readGlobalId,
                  ),
                }
              }
              return exactIdempotencyAttempt.current.key
            }
            const fingerprint = JSON.stringify(body)
            if (refreshIdempotencyAttempt.current?.fingerprint !== fingerprint) {
              refreshIdempotencyAttempt.current = {
                fingerprint,
                key: actionIdempotencyKey(
                  nextAction,
                  orderGlobalId,
                  requestRowVersion,
                ),
              }
            }
            return refreshIdempotencyAttempt.current.key
          })(),
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({})) as RevisionPayload
      if (!response.ok || !payload.ok || !payload.result) {
        if (
          nextAction === 'refresh-from-provider'
          && payload.code === 'SHOPIFY_ORDER_REVISION_PROVIDER_READ_FAILED'
        ) {
          // The server has durably failed this read receipt and explicitly
          // requires a new Idempotency-Key. Keep the same key for ambiguous
          // network failures, but do not trap the operator on a terminal
          // provider-read receipt that can only replay its failure.
          refreshIdempotencyAttempt.current = null
        }
        throw new Error(`${payload.error || `${label} order action failed`}${payload.code ? ` [${payload.code}]` : ''}`)
      }

      if (nextAction === 'refresh-from-provider') {
        const refreshed = payload.result.revision
        if (
          !refreshed
          || refreshed.orderGlobalId !== orderGlobalId
          || refreshed.provider !== provider
          || refreshed.orderRowVersion !== requestRowVersion
        ) throw new Error('Provider refresh result did not match this order')
        refreshIdempotencyAttempt.current = null
        setRevision(refreshed)
        setNotice(refreshed.state?.changed
          ? `${label} changed. Review the available ClawPilot action.`
          : '')
        return
      }

      if (
        payload.result.orderGlobalId !== orderGlobalId
        || payload.result.observationGlobalId !== exactState?.observationGlobalId
        || payload.result.readGlobalId !== exactState?.readGlobalId
        || payload.result.sourceHash !== exactState?.sourceHash
        || payload.result.revisionHash !== exactState?.revisionHash
        || payload.result.previousRowVersion !== requestRowVersion
        || payload.result.newRowVersion !== requestRowVersion + 1
        || payload.result.providerWrites !== 0
      ) {
        throw new Error('The sales-channel result did not match this order version')
      }
      if (
        nextAction === 'apply-to-clawpilot'
          ? !payload.result.applicationGlobalId
          : !payload.result.dispositionGlobalId
            || payload.result.previousStatus !== 'imported'
            || payload.result.status !== 'cancelled'
      ) {
        throw new Error('The sales-channel result did not match this ClawPilot action')
      }
      exactIdempotencyAttempt.current = null
      setConfirmation(null)
      setReason('')
      setNotice(nextAction === 'apply-to-clawpilot'
        ? `ClawPilot now matches the checked ${label} order. ${label} was not changed.`
        : `The ClawPilot order was cancelled. ${label} was not changed.`)
      await onOrderChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${label} order action failed`)
    } finally {
      setAction(null)
    }
  }

  if (!canManage) return null

  return (
    <Box data-testid="commerce-order-revision-manager">
      <Stack spacing={1.25}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          alignItems={{ xs: 'stretch', sm: 'center' }}
          justifyContent="space-between"
          gap={1}
        >
          <Typography fontWeight={700}>{label} order</Typography>
          <Button
            variant="outlined"
            startIcon={action === 'refresh'
              ? <CircularProgress size={16} />
              : <RefreshRounded />}
            disabled={busy}
            onClick={() => void post('refresh-from-provider')}
            sx={{ minHeight: 44, flexShrink: 0 }}
          >
            {action === 'refresh' ? `Refreshing ${label}` : `Refresh from ${label}`}
          </Button>
        </Stack>

        {loading && !revision ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              Loading {label} order state…
            </Typography>
          </Stack>
        ) : null}

        {error ? <Alert severity="error">{error}</Alert> : null}
        {notice ? <Alert severity="success">{notice}</Alert> : null}

        {revision && !revision.eligible ? (
          <Alert severity="warning">
            This order cannot be checked against {label} yet. Verify the active integration account and credential, then retry.
          </Alert>
        ) : null}

      {exactState ? (
          <Stack spacing={1}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={{ xs: 0.25, sm: 1 }}
              alignItems={{ xs: 'flex-start', sm: 'baseline' }}
            >
              <Typography variant="caption" color="text.secondary">
                {capturedLabel ? `Checked ${capturedLabel}` : 'Checked'}
              </Typography>
              <Box component="details" sx={{ color: 'text.secondary' }}>
                <Typography
                  component="summary"
                  variant="caption"
                  sx={{ cursor: 'pointer', width: 'fit-content' }}
                >
                  Audit details
                </Typography>
                <Typography variant="caption" component="div" sx={{ pt: 0.5 }}>
                  Check {exactState.readGlobalId} · {exactState.providerReads} sales-channel read{exactState.providerReads === 1 ? '' : 's'} · 0 sales-channel writes
                </Typography>
              </Box>
            </Stack>

            {exactState.materialState === 'current' && !changedAtProvider ? (
              <Alert severity="success">{label} matches this ClawPilot order.</Alert>
            ) : null}

            {!exactBindingCurrent ? (
              <Alert severity="warning">
                The ClawPilot order changed after this check. Reload it before continuing.
              </Alert>
            ) : null}

            {recoveryOnly ? (
              <Alert severity="warning">
                {exactState.materialState === 'provider_fulfilled'
                  ? `${label} reports external fulfillment. Use Reconcile external fulfillment instead of updating this order.`
                  : exactState.materialState === 'provider_cancelled'
                    ? `${label} reports cancellation, but this order is started, partial, or has downstream evidence. Automatic cancellation is blocked; use manager recovery.`
                  : 'This order is started, partial, or has downstream evidence. Automatic update is blocked; use manager recovery.'}
              </Alert>
            ) : null}

            {exactState.changed && !canApply && !recoveryOnly
              && exactState.materialState === 'review_required' ? (
              <Alert severity="warning">
                {blockedMessage(exactState.applyBlockedCode, provider)}
              </Alert>
            ) : null}

            {exactState.materialState === 'provider_cancelled'
              && !canAcceptCancellation
              && !recoveryOnly ? (
              <Alert severity="warning">
                The provider reports cancellation, but this order is not proven fresh and wholly unstarted. Use manager recovery.
              </Alert>
            ) : null}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              {canApply ? (
                <Button
                  variant="contained"
                  startIcon={<SyncAltRounded />}
                  disabled={busy}
                  onClick={() => {
                    setReason(`Update this unstarted ClawPilot order to match ${label}`)
                    setConfirmation('apply-to-clawpilot')
                  }}
                  sx={{ minHeight: 44 }}
                >
                  Update ClawPilot
                </Button>
              ) : null}
              {canAcceptCancellation ? (
                <Button
                  color="error"
                  variant="outlined"
                  startIcon={<CancelRounded />}
                  disabled={busy}
                  onClick={() => {
                    setReason(`Accept exact ${label} cancellation for this unstarted ClawPilot order`)
                    setConfirmation('accept-provider-cancellation')
                  }}
                  sx={{ minHeight: 44 }}
                >
                  Accept provider cancellation
                </Button>
              ) : null}
              {reviewRecoveryExceptionGlobalId ? (
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  onClick={() => void onReviewRecovery(reviewRecoveryExceptionGlobalId)}
                  sx={{ minHeight: 44 }}
                >
                  Review recovery
                </Button>
              ) : null}
            </Stack>
          </Stack>
        ) : revision?.eligible ? (
          <Alert severity="info">
            This order has not been checked against {label}. Refresh to compare it.
          </Alert>
        ) : null}

      </Stack>

      <Dialog
        open={confirmation !== null}
        onClose={() => {
          if (busy) return
          setConfirmation(null)
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {confirmation === 'apply-to-clawpilot'
            ? 'Update ClawPilot order?'
            : 'Cancel ClawPilot order?'}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Alert severity="warning">
              {confirmation === 'apply-to-clawpilot'
                ? `This unstarted ClawPilot order will match ${label}. ${label} will not be changed.`
                : `This unstarted ClawPilot order will be cancelled to match ${label}. ${label} will not be changed.`}
            </Alert>
            <TextField
              label="Manager reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              multiline
              minRows={3}
              inputProps={{ maxLength: 500 }}
              helperText="Saved with the checked sales-channel order."
              fullWidth
              required
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 1, p: 2 }}>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirmation(null)
            }}
            sx={{ minHeight: 44 }}
          >
            Keep current order
          </Button>
          <Button
            variant="contained"
            color={confirmation === 'accept-provider-cancellation' ? 'error' : 'primary'}
            disabled={busy || reason.trim().length < MINIMUM_REASON_LENGTH}
            onClick={() => {
              if (!confirmation) return
              void post(confirmation, reason.trim())
            }}
            sx={{ minHeight: 44 }}
          >
            {action === 'apply'
              ? 'Updating ClawPilot…'
              : action === 'cancel'
                ? 'Cancelling locally…'
                : confirmation === 'apply-to-clawpilot'
                  ? 'Update ClawPilot'
                  : 'Cancel ClawPilot order'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
