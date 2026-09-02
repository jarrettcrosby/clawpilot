'use client'

import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  Link,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import MoveToInboxRounded from '@mui/icons-material/MoveToInboxRounded'
import type {
  OperationsImportedOrderLineRefreshConflict,
  OperationsImportedOrderRefreshConflict,
  OperationsImportedOrderWorkingCopyDraft,
  OperationsImportedOrderWorkingCopy,
} from '@/lib/operations/types'
import {
  normalizeOrderShipToDraft,
  orderShipToReadiness,
  type OrderShipToDraft,
} from '@/lib/operations/orderShipTo'
import {
  formatCommerceMoneyMajor,
  parseCommerceMoneyMajor,
} from '@/lib/integrations/commerceIntakeCsv'

type ImportedOrderWorkingCopyDrawerProps = {
  open: boolean
  order: OperationsImportedOrderWorkingCopy | null
  canManage: boolean
  saving: boolean
  error?: string
  refreshing?: boolean
  onClose: () => void
  onSave: (draft: OperationsImportedOrderWorkingCopyDraft) => Promise<void> | void
  onAccept: () => Promise<void> | void
  onRefresh?: (input?: {
    latestCandidateGlobalId: string
    resolutions: Partial<Record<keyof OrderShipToDraft, 'local' | 'provider'>>
    lineResolutions: Record<string, 'provider'>
  }) => Promise<{
    latestCandidateGlobalId: string
    conflicts: OperationsImportedOrderRefreshConflict[]
    lineConflicts: OperationsImportedOrderLineRefreshConflict[]
  } | null> | {
    latestCandidateGlobalId: string
    conflicts: OperationsImportedOrderRefreshConflict[]
    lineConflicts: OperationsImportedOrderLineRefreshConflict[]
  } | null
}

const EMPTY_SHIP_TO = normalizeOrderShipToDraft(null)

type RefreshResolutionField = keyof OrderShipToDraft | 'requestedDeliveryAt'
type RefreshConflict = OperationsImportedOrderRefreshConflict | {
  field: 'requestedDeliveryAt'
  localValue: string | null
  providerValue: string | null
}

type LineEditorDraft = {
  productGlobalId: string
  unitPriceMajor: string
  currency: string
  packageProfileGlobalId: string
}

function dateTimeInputValue(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 23)
}

function requestedDeliveryIso(value: string) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function initialLineDrafts(order: OperationsImportedOrderWorkingCopy | null) {
  return Object.fromEntries((order?.lines || []).map((line) => [line.globalId, {
    productGlobalId: line.productGlobalId || '',
    unitPriceMajor: line.unitPriceMinor === null
      ? ''
      : formatCommerceMoneyMajor(line.unitPriceMinor, line.currency),
    currency: line.currency,
    packageProfileGlobalId: line.packageProfileGlobalId || '',
  }])) as Record<string, LineEditorDraft>
}

function editorFingerprint(input: {
  shipTo: OrderShipToDraft
  customerGlobalId: string
  requestedDeliveryAt: string
  lines: Record<string, LineEditorDraft>
}) {
  return JSON.stringify({
    shipTo: normalizeOrderShipToDraft(input.shipTo),
    customerGlobalId: input.customerGlobalId,
    requestedDeliveryAt: input.requestedDeliveryAt,
    lines: Object.entries(input.lines).sort(([left], [right]) => (
      left.localeCompare(right)
    )),
  })
}

function blockerLabel(code: string) {
  if (code === 'product_mapping_required') return 'Select product'
  if (code === 'line_price_required') return 'Enter price'
  if (code === 'packaging_required') return 'Approved case pack required'
  if (code === 'customer_resolution_required') return 'Select customer'
  if (code === 'delivery_decision_required') return 'Choose delivery date'
  return code.replaceAll('_', ' ')
}

function providerLabel(provider: OperationsImportedOrderWorkingCopy['provider']) {
  return provider === 'shopify' ? 'Shopify' : 'Faire'
}

function providerEventLabel(kind: string) {
  return kind
    .replaceAll('_', ' ')
    .replace(/\b\w/gu, (letter) => letter.toUpperCase())
}

function providerEventTime(value: string) {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return 'Time unavailable'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed)
}

function providerEventMoney(amountMinor: number | null, currency: string | null) {
  if (amountMinor === null || !currency) return null
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(amountMinor / 100)
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`
  }
}

function providerOrderStatus(order: OperationsImportedOrderWorkingCopy) {
  if (
    order.providerState.lifecycle === 'cancelled'
    || order.providerState.fulfillment === 'cancelled'
  ) return { label: 'Cancelled', color: 'error' as const, terminal: true }
  if (order.providerState.fulfillment === 'fulfilled') {
    return {
      label: 'Fulfilled externally',
      color: 'success' as const,
      terminal: true,
    }
  }
  if (order.providerState.lifecycle === 'closed') {
    return {
      label: 'Closed externally',
      color: 'success' as const,
      terminal: true,
    }
  }
  if (order.providerState.fulfillment === 'partial') {
    return {
      label: 'Partially fulfilled',
      color: 'warning' as const,
      terminal: false,
    }
  }
  if (['on_hold', 'scheduled'].includes(order.providerState.fulfillment)) {
    return { label: 'On hold', color: 'warning' as const, terminal: false }
  }
  if (!order.actionAvailable) {
    return {
      label: 'Refresh needed',
      color: 'warning' as const,
      terminal: false,
    }
  }
  return {
    label: order.needsInfo ? 'Needs info' : 'Imported',
    color: order.needsInfo ? 'warning' as const : 'success' as const,
    terminal: false,
  }
}

function readinessLabel(readiness: ReturnType<typeof orderShipToReadiness>) {
  if (readiness === 'carrier_ready') return 'Ready for rates'
  if (readiness === 'missing') return 'Ship-to needed for rates'
  return 'Ship-to incomplete for rates'
}

function refreshConflictLabel(field: RefreshResolutionField) {
  if (field === 'requestedDeliveryAt') return 'Requested delivery'
  if (field === 'postalCode') return 'Postal code'
  if (field === 'line1') return 'Address'
  if (field === 'line2') return 'Address line 2'
  return field[0].toUpperCase() + field.slice(1)
}

function refreshConflictValue(field: RefreshResolutionField, value: string | null) {
  if (!value) return 'blank'
  if (field !== 'requestedDeliveryAt') return value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

export default function ImportedOrderWorkingCopyDrawer({
  open,
  order,
  canManage,
  saving,
  error = '',
  refreshing = false,
  onClose,
  onSave,
  onAccept,
  onRefresh,
}: ImportedOrderWorkingCopyDrawerProps) {
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const [shipTo, setShipTo] = useState<OrderShipToDraft>(() => (
    order ? normalizeOrderShipToDraft(order.shipTo.value) : EMPTY_SHIP_TO
  ))
  const [customerGlobalId, setCustomerGlobalId] = useState(
    order?.customer.selectedCustomerGlobalId || '',
  )
  const [requestedDeliveryAt, setRequestedDeliveryAt] = useState(
    dateTimeInputValue(order?.delivery.draftDeliveryAt || null),
  )
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineEditorDraft>>(
    () => initialLineDrafts(order),
  )
  const [refreshConflict, setRefreshConflict] = useState<{
    latestCandidateGlobalId: string
    conflicts: RefreshConflict[]
    lineConflicts: OperationsImportedOrderLineRefreshConflict[]
  } | null>(null)
  const [refreshChoices, setRefreshChoices] = useState<Partial<
    Record<RefreshResolutionField, 'local' | 'provider'>
  >>({})
  const [lineRefreshChoices, setLineRefreshChoices] = useState<
    Record<string, 'provider'>
  >({})

  const changed = useMemo(() => order ? editorFingerprint({
    shipTo,
    customerGlobalId,
    requestedDeliveryAt,
    lines: lineDrafts,
  }) !== editorFingerprint({
    shipTo: normalizeOrderShipToDraft(order.shipTo.value),
    customerGlobalId: order.customer.selectedCustomerGlobalId || '',
    requestedDeliveryAt: dateTimeInputValue(order.delivery.draftDeliveryAt),
    lines: initialLineDrafts(order),
  }) : false, [
    customerGlobalId,
    lineDrafts,
    order,
    requestedDeliveryAt,
    shipTo,
  ])
  const draftReadiness = useMemo(() => orderShipToReadiness(shipTo), [shipTo])
  const currentProviderStatus = order ? providerOrderStatus(order) : null
  const providerTerminal = currentProviderStatus?.terminal === true
  const editorUnavailable = providerTerminal || order?.actionAvailable === false
  const shipToFieldsDisabled = !order?.resolutionDetailsLoaded
    || editorUnavailable
    || !canManage
    || saving
  const trackingHistory = (order?.providerHistory.events || []).filter((event) => (
    event.kind === 'tracking_updated'
  ))
  const trackingDetails = trackingHistory.filter((event) => (
    event.trackingNumber || event.trackingUrl || event.trackingRedacted
  ))
  const trackingEvents = trackingDetails.length
    ? trackingDetails
    : trackingHistory.slice(-1)
  const fulfillmentEvents = (order?.providerHistory.events || []).filter((event) => (
    ['fulfillment_created', 'fulfillment_updated', 'shipment_created']
      .includes(event.kind)
  ))
  const adjustmentEvents = (order?.providerHistory.events || []).filter((event) => (
    event.kind.startsWith('refund_') || event.kind.startsWith('return_')
  ))
  const invalidLinePrices = useMemo(() => new Set((order?.lines || [])
    .filter((line) => {
      const draft = lineDrafts[line.globalId]
      if (!draft?.unitPriceMajor.trim()) return false
      try {
        parseCommerceMoneyMajor(draft.unitPriceMajor, draft.currency)
        return false
      } catch {
        return true
      }
    })
    .map((line) => line.globalId)), [lineDrafts, order?.lines])
  const savedDraftComplete = useMemo(() => {
    if (!order?.resolutionDetailsLoaded) return false
    const shippingRequired = order.lines.some((line) => line.requiresShipping)
    if (!customerGlobalId) return false
    if (shippingRequired && draftReadiness !== 'carrier_ready') return false
    if (
      shippingRequired
      && !requestedDeliveryAt
      && !['not_required', 'not_supplied'].includes(order.delivery.status)
    ) return false
    return order.lines.length > 0 && order.lines.every((line) => {
      const draft = lineDrafts[line.globalId]
      return Boolean(
        draft?.productGlobalId
        && draft.unitPriceMajor.trim(),
      )
    })
  }, [
    customerGlobalId,
    draftReadiness,
    lineDrafts,
    order,
    requestedDeliveryAt,
  ])

  const update = (field: keyof OrderShipToDraft, value: string) => {
    setShipTo((current) => ({ ...current, [field]: value || null }))
  }

  const updateLine = (
    lineGlobalId: string,
    changes: Partial<LineEditorDraft>,
  ) => {
    setLineDrafts((current) => ({
      ...current,
      [lineGlobalId]: { ...current[lineGlobalId], ...changes },
    }))
  }

  const save = () => {
    if (!order || invalidLinePrices.size) return
    void onSave({
      shipTo,
      resolution: {
        customerGlobalId: customerGlobalId || null,
        requestedDeliveryAt: requestedDeliveryIso(requestedDeliveryAt),
        lines: order.lines.flatMap((line) => {
          const draft = lineDrafts[line.globalId]
          if (!draft?.productGlobalId) return []
          return [{
            lineGlobalId: line.globalId,
            productGlobalId: draft.productGlobalId,
            unitPriceMinor: draft.unitPriceMajor.trim()
              ? parseCommerceMoneyMajor(
                  draft.unitPriceMajor,
                  draft.currency,
                )
              : null,
            currency: draft.currency,
            packageProfileGlobalId:
              draft.packageProfileGlobalId || null,
          }]
        }),
      },
    })
  }

  const refresh = async (resolveConflict = false) => {
    if (!onRefresh) return
    if (!resolveConflict) {
      setRefreshChoices({})
      setLineRefreshChoices({})
    }
    const conflict = await onRefresh(resolveConflict && refreshConflict
      ? {
          latestCandidateGlobalId: refreshConflict.latestCandidateGlobalId,
          resolutions: refreshChoices as Partial<
            Record<keyof OrderShipToDraft, 'local' | 'provider'>
          >,
          lineResolutions: lineRefreshChoices,
        }
      : undefined)
    setRefreshConflict(conflict)
    if (!conflict) {
      setRefreshChoices({})
      setLineRefreshChoices({})
    }
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : onClose}
      PaperProps={{
        sx: {
          width: fullScreen ? '100%' : 'min(680px, 100vw)',
          backgroundImage: 'none',
        },
      }}
    >
      <Stack sx={{ height: '100%' }}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="flex-start"
          gap={2}
          sx={{ px: { xs: 2, sm: 3 }, py: 2.25 }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
              <Typography variant="h6" fontWeight={700}>
                {order ? `Order ${order.orderNumber}` : 'Imported order'}
              </Typography>
              {order && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={providerLabel(order.provider)}
                />
              )}
              {order && (
                <Chip
                  size="small"
                  color={currentProviderStatus?.color}
                  label={currentProviderStatus?.label}
                />
              )}
            </Stack>
            {order && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {order.customerName || 'Customer not provided'} · {order.lineCount}{' '}
                {order.lineCount === 1 ? 'line' : 'lines'}
              </Typography>
            )}
          </Box>
          <Tooltip title="Close order">
            <span>
              <IconButton
                aria-label="Close imported order"
                onClick={onClose}
                disabled={saving}
              >
                <CloseRounded />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        <Divider />

        <Stack spacing={2.5} sx={{ flex: 1, overflowY: 'auto', px: { xs: 2, sm: 3 }, py: 2.5 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {providerTerminal && order && (
            <Alert severity="info">
              {providerLabel(order.provider)} reports this order as{' '}
              {currentProviderStatus?.label.toLowerCase()}. It remains visible
              for provider history and is not eligible for a new ClawPilot
              fulfillment.
            </Alert>
          )}
          {order && !providerTerminal && !order.actionAvailable && (
            <Alert severity="info">
              This retained provider copy is no longer eligible for edits or
              import. Refresh it to fetch a current provider revision.
            </Alert>
          )}
          {order && !order.resolutionDetailsLoaded && (
            <Alert severity="info" icon={<CircularProgress size={18} />}>
              Loading editable order details…
            </Alert>
          )}
          {order?.providerVersionChanged && (
            <Alert severity="warning">
              {providerLabel(order.provider)} changed this order after the local draft was saved.
              Refresh to merge the provider changes with your local edits.
            </Alert>
          )}
          {refreshConflict && (
            <Alert severity="warning">
              <Stack spacing={1.25}>
                <Typography variant="body2" fontWeight={700}>
                  Review each local value changed by the provider refresh.
                </Typography>
                {refreshConflict.conflicts.map((conflict) => (
                  <Stack key={conflict.field} spacing={0.5}>
                    <Typography variant="caption" fontWeight={700}>
                      {refreshConflictLabel(conflict.field)}
                    </Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} gap={0.75}>
                      <Button
                        size="small"
                        variant={refreshChoices[conflict.field] === 'local'
                          ? 'contained'
                          : 'outlined'}
                        onClick={() => setRefreshChoices((current) => ({
                          ...current,
                          [conflict.field]: 'local',
                        }))}
                      >
                        Keep mine: {refreshConflictValue(
                          conflict.field,
                          conflict.localValue,
                        )}
                      </Button>
                      <Button
                        size="small"
                        variant={refreshChoices[conflict.field] === 'provider'
                          ? 'contained'
                          : 'outlined'}
                        onClick={() => setRefreshChoices((current) => ({
                          ...current,
                          [conflict.field]: 'provider',
                        }))}
                      >
                        Use {providerLabel(order!.provider)}: {refreshConflictValue(
                          conflict.field,
                          conflict.providerValue,
                        )}
                      </Button>
                    </Stack>
                  </Stack>
                ))}
                {refreshConflict.lineConflicts.map((conflict) => {
                  const productName = order?.productOptions.find((option) => (
                    option.globalId === conflict.localDraft.productGlobalId
                  ))?.name || conflict.localDraft.productGlobalId
                  return (
                    <Box
                      key={conflict.lineGlobalId}
                      sx={{ border: 1, borderColor: 'warning.main', borderRadius: 1.5, p: 1 }}
                    >
                      <Typography variant="body2" fontWeight={700}>
                        {conflict.title}{conflict.sku ? ` · ${conflict.sku}` : ''}
                      </Typography>
                      <Typography variant="caption" display="block" sx={{ mb: 0.75 }}>
                        Your saved match to {productName} could not be tied to one exact
                        refreshed provider item. It has not been discarded.
                      </Typography>
                      <Button
                        size="small"
                        variant={lineRefreshChoices[conflict.lineGlobalId]
                          ? 'contained'
                          : 'outlined'}
                        onClick={() => setLineRefreshChoices((current) => ({
                          ...current,
                          [conflict.lineGlobalId]: 'provider',
                        }))}
                      >
                        Use refreshed provider item
                      </Button>
                    </Box>
                  )
                })}
                <Button
                  size="small"
                  variant="contained"
                  disabled={
                    refreshing
                    || refreshConflict.conflicts.some((conflict) => (
                      !refreshChoices[conflict.field]
                    ))
                    || refreshConflict.lineConflicts.some((conflict) => (
                      !lineRefreshChoices[conflict.lineGlobalId]
                    ))
                  }
                  onClick={() => void refresh(true)}
                >
                  Apply choices
                </Button>
              </Stack>
            </Alert>
          )}

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', sm: 'center' }}
            gap={1.25}
          >
            <Box>
              <Typography fontWeight={700}>Source order</Typography>
              <Typography variant="body2" color="text.secondary">
                {order?.integrationAccountName || '—'}
              </Typography>
            </Box>
            {onRefresh && canManage && (
              <Button
                size="small"
                variant="outlined"
                startIcon={refreshing ? <CircularProgress size={16} /> : <RefreshRounded />}
                disabled={!order || saving || refreshing}
                onClick={() => void refresh(false)}
              >
                Refresh from {order ? providerLabel(order.provider) : 'provider'}
              </Button>
            )}
          </Stack>

          {order?.resolutionDetailsLoaded
            && (providerTerminal || order.providerHistory.events.length) && (
            <>
              <Divider />
              <Stack spacing={1.5}>
                <Box>
                  <Typography fontWeight={700}>External fulfillment</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Fulfillment, tracking, refunds, and returns reported by {order
                      ? providerLabel(order.provider)
                      : 'the provider'}.
                  </Typography>
                </Box>

                {order?.providerHistory.observedAt ? (
                  <Typography variant="caption" color="text.secondary">
                    Latest exact provider snapshot {providerEventTime(
                      order.providerHistory.observedAt,
                    )}
                  </Typography>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Tracking history has not been captured for this order. Refresh
                    from {order ? providerLabel(order.provider) : 'the provider'}
                    {' '}to load the latest provider record.
                  </Typography>
                )}

                <Box>
                  <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                    Tracking
                  </Typography>
                  {trackingEvents.length ? (
                    <Stack spacing={0.75}>
                      {trackingEvents.map((event) => (
                        <Box key={event.globalId}>
                          <Typography variant="body2">
                            {[event.trackingCarrier, event.trackingNumber]
                              .filter(Boolean).join(' · ')
                              || (event.trackingRedacted
                                ? 'Tracking number expired from retained evidence'
                                : 'Tracking number not supplied')}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {[event.status, providerEventTime(event.occurredAt)]
                              .filter(Boolean).join(' · ')}
                          </Typography>
                          {event.trackingUrl ? (
                            <Typography variant="body2">
                              <Link
                                href={event.trackingUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Track shipment
                              </Link>
                            </Typography>
                          ) : null}
                        </Box>
                      ))}
                    </Stack>
                  ) : order?.providerHistory.observedAt ? (
                    <Typography variant="body2" color="text.secondary">
                      No tracking number was supplied in the latest provider record.
                    </Typography>
                  ) : null}
                </Box>

                {fulfillmentEvents.length ? (
                  <Box>
                    <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                      Fulfillment activity
                    </Typography>
                    <Stack spacing={0.75}>
                      {fulfillmentEvents.map((event) => (
                        <Box key={event.globalId}>
                          <Typography variant="body2">
                            {providerEventLabel(event.kind)}
                            {event.status ? ` · ${event.status}` : ''}
                            {event.quantity !== null ? ` · ${event.quantity} units` : ''}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {providerEventTime(event.occurredAt)}
                          </Typography>
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                ) : null}

                {adjustmentEvents.length ? (
                  <Box>
                    <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                      Adjustments
                    </Typography>
                    <Stack spacing={0.75}>
                      {adjustmentEvents.map((event) => {
                        const amount = providerEventMoney(
                          event.amountMinor,
                          event.currency,
                        )
                        return (
                          <Box key={event.globalId}>
                            <Typography variant="body2">
                              {providerEventLabel(event.kind)}
                              {event.status ? ` · ${event.status}` : ''}
                              {event.quantity !== null
                                ? ` · ${event.quantity} units`
                                : ''}
                              {amount ? ` · ${amount}` : ''}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {providerEventTime(event.occurredAt)}
                            </Typography>
                          </Box>
                        )
                      })}
                    </Stack>
                  </Box>
                ) : null}
              </Stack>
            </>
          )}

          <Divider />

          <Stack spacing={1.5}>
            <Box>
              <Typography fontWeight={700}>Customer and delivery</Typography>
              <Typography variant="caption" color="text.secondary">
                Choose the existing ClawPilot customer for this order.
              </Typography>
            </Box>
            <TextField
              select
              size="small"
              label="Customer"
              value={customerGlobalId}
              onChange={(event) => setCustomerGlobalId(event.target.value)}
              disabled={
                !order?.resolutionDetailsLoaded
                || editorUnavailable
                || !canManage
                || saving
                || !order.customer.options.length
              }
              helperText={order?.customer.options.length
                ? order.customer.status === 'resolved'
                  ? 'Existing customer linked to this order'
                  : 'Required before this order can be imported'
                : order?.resolutionDetailsLoaded
                  ? 'No active customer is available in this workspace'
                  : 'Loading customers…'}
              fullWidth
            >
              <MenuItem value=""><em>Select customer</em></MenuItem>
              {(order?.customer.options || []).map((customer) => (
                <MenuItem key={customer.globalId} value={customer.globalId}>
                  {customer.name}{customer.email ? ` · ${customer.email}` : ''}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              type="datetime-local"
              label="Requested delivery"
              value={requestedDeliveryAt}
              onChange={(event) => setRequestedDeliveryAt(event.target.value)}
              disabled={
                !order?.resolutionDetailsLoaded
                || editorUnavailable
                || !canManage
                || saving
              }
              InputLabelProps={{ shrink: true }}
              inputProps={{ step: 0.001 }}
              helperText={order?.delivery.status === 'not_required'
                ? 'Optional for this order'
                : order?.delivery.status === 'not_supplied'
                  ? `${providerLabel(order.provider)} did not supply a requested date; this field is optional`
                  : order?.delivery.status === 'unresolved'
                  ? 'Choose the delivery date requested for this order'
                  : order?.delivery.status === 'provider'
                    ? `Imported from ${providerLabel(order.provider)}`
                    : 'Saved in ClawPilot'}
              fullWidth
            />
          </Stack>

          <Divider />

          <Stack spacing={1.5}>
            <Box>
              <Typography fontWeight={700}>Items</Typography>
              <Typography variant="caption" color="text.secondary">
                {providerTerminal
                  ? `Latest line quantities reported by ${order
                    ? providerLabel(order.provider)
                    : 'the provider'}.`
                  : 'Provider SKU and quantity stay visible while you match each item.'}
              </Typography>
            </Box>
            {(order?.lines || []).map((line) => {
              const draft = lineDrafts[line.globalId]
              const product = order?.productOptions.find((option) => (
                option.globalId === draft?.productGlobalId
              ))
              const packageProfiles = product?.packageProfiles || []
              const packFactsRequired = line.unfulfilledQuantity > 0
                && line.requiresShipping
                && (
                  !Number.isSafeInteger(line.unitMultiplier)
                  || line.unitMultiplier !== 1
                )
              return (
                <Box
                  key={line.globalId}
                  sx={{
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 2,
                    p: 1.5,
                  }}
                >
                  <Stack spacing={1.25}>
                    <Box>
                      <Typography fontWeight={700}>{line.title}</Typography>
                      <Stack direction="row" gap={0.75} flexWrap="wrap" sx={{ mt: 0.5 }}>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={`SKU ${line.sku || 'not supplied'}`}
                        />
                        <Chip size="small" variant="outlined" label={`Ordered ${line.orderedQuantity}`} />
                        <Chip size="small" variant="outlined" label={`Current ${line.currentQuantity}`} />
                        <Chip size="small" variant="outlined" label={`Fulfilled ${line.fulfilledQuantity}`} />
                        <Chip size="small" variant="outlined" label={`Remaining ${line.unfulfilledQuantity}`} />
                        {line.cancelledOrRemovedQuantity > 0 && (
                          <Chip
                            size="small"
                            color="warning"
                            variant="outlined"
                            label={`Removed or refunded ${line.cancelledOrRemovedQuantity}`}
                          />
                        )}
                        {line.returnedQuantity > 0 && (
                          <Chip
                            size="small"
                            color="warning"
                            variant="outlined"
                            label={`Returned ${line.returnedQuantity}`}
                          />
                        )}
                        {packFactsRequired && (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`Case pick · ${line.unitMultiplier} each`}
                          />
                        )}
                        {!providerTerminal && line.blockerCodes.map((code) => (
                          <Chip
                            key={code}
                            size="small"
                            color="warning"
                            variant="outlined"
                            label={blockerLabel(code)}
                          />
                        ))}
                      </Stack>
                    </Box>
                    {!editorUnavailable && (
                      <>
                        <TextField
                          select
                          size="small"
                          label="ClawPilot product"
                          value={draft?.productGlobalId || ''}
                          onChange={(event) => updateLine(line.globalId, {
                            productGlobalId: event.target.value,
                            packageProfileGlobalId: '',
                          })}
                          disabled={
                            !order?.resolutionDetailsLoaded
                            || editorUnavailable
                            || !canManage
                            || saving
                            || !order.productOptions.length
                          }
                          helperText={order?.productOptions.length
                            ? 'Match this provider item to an existing product'
                            : 'No active product is available in this workspace'}
                          fullWidth
                        >
                          <MenuItem value=""><em>Select product</em></MenuItem>
                          {(order?.productOptions || []).map((option) => (
                            <MenuItem key={option.globalId} value={option.globalId}>
                              {option.name}{option.sku ? ` · ${option.sku}` : ''}
                            </MenuItem>
                          ))}
                        </TextField>
                        <TextField
                          size="small"
                          label={`Unit price (${draft?.currency || line.currency})`}
                          value={draft?.unitPriceMajor || ''}
                          onChange={(event) => updateLine(line.globalId, {
                            unitPriceMajor: event.target.value,
                          })}
                          disabled={
                            !order?.resolutionDetailsLoaded
                            || editorUnavailable
                            || !canManage
                            || saving
                            || !draft?.productGlobalId
                          }
                          error={invalidLinePrices.has(line.globalId)}
                          helperText={invalidLinePrices.has(line.globalId)
                            ? 'Enter a valid non-negative amount'
                            : draft?.productGlobalId && !draft.unitPriceMajor.trim()
                              ? 'Enter a price to finish matching this item'
                              : 'Exact per-unit order price'}
                          inputProps={{ inputMode: 'decimal' }}
                          fullWidth
                        />
                        {line.requiresShipping && packageProfiles.length > 0 && (
                          <TextField
                            select
                            size="small"
                            label={packFactsRequired
                              ? 'Approved case-pick pack'
                              : 'Approved pack constraint (optional)'}
                            value={draft?.packageProfileGlobalId || ''}
                            SelectProps={{ displayEmpty: true }}
                            InputLabelProps={{ shrink: true }}
                            onChange={(event) => updateLine(line.globalId, {
                              packageProfileGlobalId: event.target.value,
                            })}
                            disabled={
                              !order?.resolutionDetailsLoaded
                              || editorUnavailable
                              || !canManage
                              || saving
                              || !draft?.productGlobalId
                            }
                            helperText={draft?.productGlobalId
                              ? packFactsRequired
                                ? 'Use the approved pack that represents this provider case pick.'
                                : 'Cartonization chooses outbound packaging. Select only when this product must use an approved pack.'
                              : 'Select a product first'}
                            fullWidth
                          >
                            <MenuItem value=""><em>{packFactsRequired
                              ? 'Use current mapped case pack'
                              : 'No pack constraint — use cartonization'}</em></MenuItem>
                            {packageProfiles.map((profile) => (
                              <MenuItem key={profile.globalId} value={profile.globalId}>
                                {profile.name}
                              </MenuItem>
                            ))}
                          </TextField>
                        )}
                        {line.requiresShipping && packageProfiles.length === 0 && (
                          <Alert severity={packFactsRequired ? 'warning' : 'info'}>
                            {packFactsRequired
                              ? 'This case pick needs an approved Product pack before import.'
                              : 'Unit item — cartonization chooses outbound packaging. No Product package assignment is required.'}
                          </Alert>
                        )}
                      </>
                    )}
                  </Stack>
                </Box>
              )
            })}
            {order?.resolutionDetailsLoaded && !order.lines.length && (
              <Typography variant="body2" color="text.secondary">
                No line-item snapshot was supplied by {providerLabel(order.provider)}.
              </Typography>
            )}
          </Stack>

          <Divider />

          <Box>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              gap={1}
              sx={{ mb: 1.5 }}
            >
              <Box>
                <Typography fontWeight={700}>Ship to</Typography>
                <Typography variant="caption" color="text.secondary">
                  {providerTerminal
                    ? 'Latest provider shipping address'
                    : 'ClawPilot shipment address'}
                </Typography>
              </Box>
              {order && (
                <Chip
                  size="small"
                  variant="outlined"
                  color={providerTerminal
                    ? 'default'
                    : draftReadiness === 'carrier_ready'
                      ? 'success'
                      : 'warning'}
                  label={providerTerminal
                    ? 'Provider snapshot'
                    : readinessLabel(draftReadiness)}
                />
              )}
            </Stack>

            <Stack spacing={1.5}>
              <TextField
                size="small"
                label="Recipient name"
                value={shipTo.name || ''}
                onChange={(event) => update('name', event.target.value)}
                disabled={shipToFieldsDisabled}
                fullWidth
              />
              <TextField
                size="small"
                label="Address"
                value={shipTo.line1 || ''}
                onChange={(event) => update('line1', event.target.value)}
                disabled={shipToFieldsDisabled}
                fullWidth
              />
              <TextField
                size="small"
                label="Apartment, suite, etc."
                value={shipTo.line2 || ''}
                onChange={(event) => update('line2', event.target.value)}
                disabled={shipToFieldsDisabled}
                fullWidth
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  size="small"
                  label="City"
                  value={shipTo.city || ''}
                  onChange={(event) => update('city', event.target.value)}
                  disabled={shipToFieldsDisabled}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="State / province"
                  value={shipTo.region || ''}
                  onChange={(event) => update('region', event.target.value)}
                  disabled={shipToFieldsDisabled}
                  fullWidth
                />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  size="small"
                  label="Postal code"
                  value={shipTo.postalCode || ''}
                  onChange={(event) => update('postalCode', event.target.value)}
                  disabled={shipToFieldsDisabled}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="Country code"
                  value={shipTo.country || ''}
                  onChange={(event) => update('country', event.target.value.toUpperCase())}
                  disabled={shipToFieldsDisabled}
                  inputProps={{ maxLength: 2 }}
                  fullWidth
                />
              </Stack>
            </Stack>
          </Box>
        </Stack>

        <Divider />

        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          gap={1.5}
          sx={{ px: { xs: 2, sm: 3 }, py: 2 }}
        >
          <Typography variant="caption" color="text.secondary">
            {order?.shipTo.syncStatus === 'local_only' ? 'Saved locally' : 'Imported from provider'}
          </Typography>
          <Stack direction="row" gap={1}>
            <Button onClick={onClose} disabled={saving}>Close</Button>
            <Button
              variant="contained"
              startIcon={saving
                ? <CircularProgress size={16} />
                : <MoveToInboxRounded />}
              disabled={
                !order
                || !order.resolutionDetailsLoaded
                || !canManage
                || editorUnavailable
                || saving
                || changed
                || !savedDraftComplete
                || order.providerVersionChanged
                || invalidLinePrices.size > 0
              }
              onClick={() => void onAccept()}
            >
              Accept &amp; import
            </Button>
            <Button
              variant="contained"
              startIcon={saving ? <CircularProgress size={16} /> : <SaveRounded />}
              disabled={
                !order
                || !order.resolutionDetailsLoaded
                || !canManage
                || editorUnavailable
                || saving
                || !changed
                || invalidLinePrices.size > 0
              }
              onClick={save}
            >
              Save
            </Button>
          </Stack>
        </Stack>
      </Stack>
    </Drawer>
  )
}
