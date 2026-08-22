'use client'

import { useEffect, useState } from 'react'

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import CancelRounded from '@mui/icons-material/CancelRounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import type {
  OperationsActivationState,
  OperationsOrderDetail,
} from '@/lib/operations/types'
import type { OneOffShipmentExecutionState } from '@/lib/operations/oneOffShipments'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

function carrierName(provider: OneOffShipmentExecutionState['planning']['provider']) {
  return provider === 'ups_rest' ? 'UPS' : 'FedEx'
}

function formatMoney(minor: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(minor / 100)
}

function signedMoney(minor: number, currency: string) {
  if (minor === 0) return `${formatMoney(0, currency)} (no change)`
  return `${minor > 0 ? '+' : '−'}${formatMoney(Math.abs(minor), currency)}`
}

function displayStatus(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export default function OneOffShippingExecutionPanel({
  order,
  state,
  loading,
  error,
  activationState,
  canManage,
  canExecute,
  canPurchaseLivePostage,
  busy,
  onRefreshPackedRates,
  onReviewPurchase,
  onVoidGroup,
}: {
  order: OperationsOrderDetail
  state: OneOffShipmentExecutionState | null
  loading: boolean
  error: string
  activationState: OperationsActivationState
  canManage: boolean
  canExecute: boolean
  canPurchaseLivePostage: boolean
  busy: boolean
  onRefreshPackedRates: () => void
  onReviewPurchase: () => void
  onVoidGroup: () => void
}) {
  const dateTime = useUserDateTime()
  const [clock, setClock] = useState(() => Date.now())
  const live = order.oneOffShippingMode === 'live'
  const basePermissionBlocker = !canManage
    ? 'Operations management permission is required.'
    : !canExecute
      ? 'Warehouse execution permission is required.'
      : null
  const purchasePermissionBlocker = basePermissionBlocker
    || (live && !canPurchaseLivePostage
      ? 'Live-postage permission is required for LIVE rating and postage purchase.'
      : null)
  const activationBlocker = live && activationState !== 'active'
    ? 'LIVE one-off execution requires Operations Active mode.'
    : null
  const group = state?.carrierGroup || null
  const unresolved = Boolean(group?.unresolved)
  const activeGroup = Boolean(group?.active)
  const packageMismatch = Boolean(
    state && (
      state.packageCount !== order.packages.length
      || state.packageCount !== order.packedPackageCount
    ),
  )
  const expiresAtMs = state?.packedRate
    ? new Date(state.packedRate.expiresAt).getTime()
    : 0
  const packedRateExpired = Boolean(state?.packedRate && expiresAtMs <= clock)
  const packedRateConsumed = Boolean(state?.packedRate?.consumed)

  useEffect(() => {
    if (!expiresAtMs || expiresAtMs <= clock) return
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.min(expiresAtMs - clock + 25, 2_147_483_647),
    )
    return () => window.clearTimeout(timer)
  }, [clock, expiresAtMs])
  const eligibleOffers = state?.packedRate?.offers || []
  const purchaseBlocker = purchasePermissionBlocker
    || activationBlocker
    || (order.status !== 'packed' ? 'Verify every package before rerating or buying postage.' : null)
    || (packageMismatch ? 'The order detail does not match the complete packed package group. Refresh before continuing.' : null)
    || (unresolved ? 'The carrier group has an unresolved provider outcome and must be reconciled before retrying.' : null)
    || (activeGroup ? 'This one-off shipment already has an active carrier group.' : null)
    || (!state?.packedRate ? 'Refresh packed rates before purchasing the shipment.' : null)
    || (packedRateConsumed ? 'This packed rate was already consumed. Refresh the complete group before another purchase.' : null)
    || (packedRateExpired ? 'The packed rate has expired. Refresh it before purchasing.' : null)
    || (!eligibleOffers.length ? 'The planned carrier service did not return a matching packed rate.' : null)
  const refreshBlocker = purchasePermissionBlocker
    || activationBlocker
    || (order.status !== 'packed' ? 'Verify every package before refreshing packed rates.' : null)
    || (packageMismatch ? 'The order detail does not match the complete packed package group.' : null)
    || (unresolved ? 'The carrier group has an unresolved provider outcome and must be reconciled first.' : null)
    || (activeGroup ? 'Void the active carrier group before requesting replacement rates.' : null)
  const voidBlocker = basePermissionBlocker
    || (unresolved ? 'The carrier group has an unresolved provider outcome and must be reconciled first.' : null)
    || (!activeGroup ? 'There is no active whole-shipment carrier group to void.' : null)

  return (
    <Stack spacing={1.5} data-testid="one-off-group-shipping-execution">
      <Alert severity={live ? 'warning' : 'info'}>
        <Typography fontWeight={800}>
          {live
            ? 'LIVE · production multi-package postage'
            : 'TEST · sandbox multi-package shipment'}
        </Typography>
        <Typography variant="body2">
          ClawPilot rerates all {order.packages.length} packed parcels together, then submits one
          whole-shipment command. The carrier must return the complete label set before the group
          succeeds. Purchase and cancellation are never offered per package.
        </Typography>
      </Alert>

      {(purchasePermissionBlocker || activationBlocker) && (
        <Alert severity="info" data-testid="one-off-group-permission-blocker">
          {purchasePermissionBlocker || activationBlocker} An already purchased complete
          shipment can still be voided with Operations management and warehouse execution
          permission when its original carrier account remains available.
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {loading && !state && (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={18} />
          <Typography variant="body2">Loading audited shipment-group state…</Typography>
        </Stack>
      )}

      {state && (
        <>
          <Box sx={{ p: 1.5, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 2 }}>
            <Stack direction="row" justifyContent="space-between" gap={1} alignItems="flex-start">
              <Box>
                <Typography fontWeight={700}>Planning selection</Typography>
                <Typography variant="body2">
                  {carrierName(state.planning.provider)} · {state.planning.serviceName}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {state.planning.serviceCode} · {state.planning.offerGlobalId}
                </Typography>
              </Box>
              <Stack alignItems="flex-end">
                <Typography fontWeight={700}>
                  {formatMoney(state.planning.amountMinor, state.planning.currency)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {state.packageCount} {state.packageCount === 1 ? 'parcel' : 'parcels'}
                </Typography>
              </Stack>
            </Stack>
          </Box>

          {packageMismatch && (
            <Alert severity="error">
              Audited execution expects {state.packageCount} parcels, while this order shows{' '}
              {order.packages.length} planned and {order.packedPackageCount} packed. No carrier
              command is available until the exact package set agrees.
            </Alert>
          )}

          {group?.unresolved && (
            <Alert severity="error">
              Carrier group {group.createAttemptGlobalId} is {group.state}. Do not retry, refresh,
              or void until the provider outcome has been reconciled.
            </Alert>
          )}

          {state.packedRate && (
            <Box
              sx={{ p: 1.5, border: '1px solid rgba(168,199,250,0.32)', borderRadius: 2 }}
              data-testid="one-off-packed-rate"
            >
              <Stack direction="row" justifyContent="space-between" gap={1} alignItems="flex-start">
                <Box>
                  <Typography fontWeight={700}>Fresh packed-group rate</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Only offers matching the planned carrier and service are shown.
                  </Typography>
                </Box>
                <Chip
                  size="small"
                  color={packedRateConsumed || packedRateExpired ? 'warning' : 'success'}
                  label={packedRateConsumed ? 'Consumed' : packedRateExpired ? 'Expired' : 'Current'}
                />
              </Stack>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                Expires {formatUserDateTime(state.packedRate.expiresAt, dateTime, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  fallback: 'Unknown',
                })}
              </Typography>
              <Stack spacing={1} sx={{ mt: 1.25 }}>
                {eligibleOffers.map((offer) => {
                  const variance = offer.amountMinor - state.planning.amountMinor
                  return (
                    <Box
                      key={offer.globalId}
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) auto',
                        gap: 1,
                        p: 1,
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 1.5,
                      }}
                    >
                      <Box>
                        <Typography variant="body2" fontWeight={700}>
                          {offer.providerLabel} · {offer.serviceName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Packed quote {offer.globalId}
                        </Typography>
                      </Box>
                      <Box sx={{ textAlign: 'right' }}>
                        <Typography variant="body2" fontWeight={700}>
                          {formatMoney(offer.amountMinor, offer.currency)}
                        </Typography>
                        <Typography
                          variant="caption"
                          color={variance > 0 ? 'warning.main' : variance < 0 ? 'success.main' : 'text.secondary'}
                        >
                          {signedMoney(variance, offer.currency)} vs planning
                        </Typography>
                      </Box>
                    </Box>
                  )
                })}
                {!eligibleOffers.length && (
                  <Alert severity="warning">
                    The planned carrier service has no matching offer for the exact packed group.
                  </Alert>
                )}
              </Stack>
            </Box>
          )}

          {group && (
            <Box
              sx={{
                p: 1.5,
                border: group.active
                  ? '1px solid rgba(129,199,132,0.4)'
                  : '1px solid rgba(255,255,255,0.12)',
                borderRadius: 2,
              }}
              data-testid="one-off-carrier-group-result"
            >
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                <Box>
                  <Typography fontWeight={700}>
                    {carrierName(group.provider)} whole-shipment group
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {group.createAttemptGlobalId}
                  </Typography>
                </Box>
                <Chip
                  size="small"
                  color={group.unresolved ? 'warning' : group.active ? 'success' : 'default'}
                  label={group.unresolved
                    ? 'Reconciliation required'
                    : group.active
                      ? 'Active'
                      : group.voidState === 'succeeded'
                        ? group.voidAction === 'close_sample' ? 'Test sample closed' : 'Voided'
                        : displayStatus(group.state)}
                />
              </Stack>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
                  gap: 1,
                  mt: 1.25,
                }}
              >
                <Box>
                  <Typography variant="caption" color="text.secondary">Master tracking</Typography>
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {group.masterTrackingNumber || 'Unavailable'}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">Confirmed packed rate</Typography>
                  <Typography variant="body2">
                    {formatMoney(group.selectedAmountMinor, group.currency)}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">Provider returned charge</Typography>
                  <Typography variant="body2">
                    {group.providerChargeMinor === null
                      ? 'Not returned'
                      : formatMoney(
                        group.providerChargeMinor,
                        group.providerChargeCurrency || group.currency,
                      )}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">Provider charge variance</Typography>
                  <Typography variant="body2">
                    {group.chargeVarianceMinor === null
                      ? 'Not returned'
                      : signedMoney(
                        group.chargeVarianceMinor,
                        group.providerChargeCurrency || group.currency,
                      )}
                  </Typography>
                </Box>
              </Box>
              <Divider sx={{ my: 1.5 }} />
              <Typography variant="subtitle2">
                Complete package label set ({group.labels.length} of {group.packageCount})
              </Typography>
              <Stack divider={<Divider flexItem />} sx={{ mt: 0.5 }}>
                {[...group.labels].sort((left, right) => left.packageNumber - right.packageNumber)
                  .map((label) => (
                    <Box
                      key={label.packageGlobalId}
                      sx={{ py: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 1 }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={700}>
                          Parcel {label.packageNumber} · {label.trackingNumber}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                          {label.labelGlobalId}
                          {label.printJobGlobalId ? ` · Print job ${label.printJobGlobalId}` : ' · Print not queued'}
                        </Typography>
                        {label.printWarning && (
                          <Typography variant="caption" color="warning.main" display="block">
                            {label.printWarning}
                          </Typography>
                        )}
                      </Box>
                      <Stack alignItems="flex-end" spacing={0.5}>
                        <Chip
                          size="small"
                          color={label.status === 'created' ? 'success' : 'default'}
                          label={label.status === 'created' ? 'Active' : 'Voided'}
                        />
                        {label.printStatus && (
                          <Chip size="small" variant="outlined" label={`Print ${displayStatus(label.printStatus)}`} />
                        )}
                      </Stack>
                    </Box>
                  ))}
              </Stack>
            </Box>
          )}

          <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
            <Tooltip title={refreshBlocker || 'Rerate the exact complete packed package group'}>
              <span style={{ flex: 1 }}>
                <Button
                  fullWidth
                  variant="outlined"
                  startIcon={<RefreshRounded />}
                  disabled={busy || Boolean(refreshBlocker)}
                  onClick={onRefreshPackedRates}
                  data-testid="refresh-one-off-packed-rates"
                >
                  Refresh packed-group rate
                </Button>
              </span>
            </Tooltip>
            {!activeGroup && (
              <Tooltip title={purchaseBlocker || 'Review and authorize one whole-shipment purchase'}>
                <span style={{ flex: 1 }}>
                  <Button
                    fullWidth
                    variant="contained"
                    startIcon={<LocalShippingRounded />}
                    disabled={busy || Boolean(purchaseBlocker)}
                    onClick={onReviewPurchase}
                    data-testid="review-one-off-group-purchase"
                  >
                    Review whole-shipment purchase
                  </Button>
                </span>
              </Tooltip>
            )}
            {activeGroup && (
              <Tooltip title={voidBlocker || 'Cancel the complete carrier shipment group'}>
                <span style={{ flex: 1 }}>
                  <Button
                    fullWidth
                    color="error"
                    variant="outlined"
                    startIcon={<CancelRounded />}
                    disabled={busy || Boolean(voidBlocker)}
                    onClick={onVoidGroup}
                    data-testid="void-one-off-carrier-group"
                  >
                    {group?.lifecycleMode === 'local_sample_close'
                      ? 'Close complete TEST sample'
                      : 'Void complete shipment group'}
                  </Button>
                </span>
              </Tooltip>
            )}
          </Stack>
        </>
      )}
    </Stack>
  )
}
