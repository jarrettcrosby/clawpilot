'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import TaskAltRounded from '@mui/icons-material/TaskAltRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import WarehouseRounded from '@mui/icons-material/WarehouseRounded'
import type {
  OperationsActivationState,
  OperationsActivationUpdateResult,
  OperationsExceptionListItem,
  OperationsExceptionStatus,
  OperationsExceptionUpdateResult,
  OperationsOrderCommandResult,
  OperationsOrderDetail,
  OperationsOrderListItem,
  OperationsOrderStatus,
  OperationsWorkspace,
} from '@/lib/operations/types'
import GlCodingPanel from '@/components/operations/GlCodingPanel'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type OperationsPayload = {
  ok?: boolean
  error?: string
  code?: string
  operations?: OperationsWorkspace
  result?: OperationsExceptionUpdateResult | OperationsActivationUpdateResult | OperationsOrderCommandResult
}

const ORDER_STATUSES: Array<{ value: '' | OperationsOrderStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'imported', label: 'Imported' },
  { value: 'validated', label: 'Validated' },
  { value: 'held', label: 'Held' },
  { value: 'promised', label: 'Promised' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'planned', label: 'Planned' },
  { value: 'released', label: 'Released' },
  { value: 'picking', label: 'Picking' },
  { value: 'packed', label: 'Packed' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'exception', label: 'Exception' },
]

const EXCEPTION_STATUSES: Array<{ value: '' | OperationsExceptionStatus; label: string }> = [
  { value: '', label: 'All exception statuses' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
]

const ACTIVATION_OPTIONS: Array<{ value: OperationsActivationState; label: string }> = [
  { value: 'disabled', label: 'Disabled' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'read_only', label: 'Read only' },
  { value: 'active', label: 'Active' },
  { value: 'frozen', label: 'Frozen' },
]

const controlSx = {
  minWidth: 0,
  '& .MuiInputBase-root': {
    minHeight: 40,
    borderRadius: '8px',
    backgroundColor: '#15151D',
  },
}

function displayStatus(status: string) {
  return status.replace(/[_.-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (status === 'shipped') return 'success'
  if (status === 'exception' || status === 'cancelled') return 'error'
  if (status === 'held') return 'warning'
  if (['released', 'picking', 'packed'].includes(status)) return 'info'
  return 'default'
}

function exceptionStatusColor(status: OperationsExceptionStatus): 'default' | 'success' | 'warning' | 'info' {
  if (status === 'resolved') return 'success'
  if (status === 'open') return 'warning'
  if (status === 'acknowledged') return 'info'
  return 'default'
}

function severityColor(severity: OperationsExceptionListItem['severity']): 'default' | 'warning' | 'error' {
  if (severity === 'critical' || severity === 'high') return 'error'
  if (severity === 'medium') return 'warning'
  return 'default'
}

function money(minor: string | null | undefined, currency = 'USD') {
  const value = Number(minor || 0) / 100
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)
}

function metric(label: string, value: string | number, tone = 'text.primary') {
  return (
    <Box sx={{ minWidth: { xs: 'calc(50% - 8px)', sm: 112 }, py: 0.5 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography fontSize="1.2rem" fontWeight={700} color={tone}>{value}</Typography>
    </Box>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box component="section">
      <Typography variant="overline" color="text.secondary">{title}</Typography>
      <Box sx={{ mt: 0.5 }}>{children}</Box>
    </Box>
  )
}

function OrderDetailDrawer({
  order,
  open,
  busy,
  onClose,
  onRelease,
  onConfirmPicks,
  onVerifyPack,
}: {
  order: OperationsOrderDetail | null
  open: boolean
  busy: boolean
  onClose: () => void
  onRelease: () => void
  onConfirmPicks: () => void
  onVerifyPack: () => void
}) {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('md'))
  const dateTime = useUserDateTime()
  const releaseAction = order?.availableActions?.find((item) => item.action === 'release_to_warehouse')
  const confirmPicksAction = order?.availableActions?.find((item) => item.action === 'confirm_picks')
  const verifyPackAction = order?.availableActions?.find((item) => item.action === 'verify_pack')
  const primaryAction = order?.status === 'released'
    ? confirmPicksAction
    : order?.status === 'picking' || order?.status === 'packed' || order?.status === 'shipped'
      ? verifyPackAction
      : releaseAction
  const confirmingPicks = primaryAction?.action === 'confirm_picks'
  const verifyingPack = primaryAction?.action === 'verify_pack'

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: mobile ? '100%' : 'min(540px, 46vw)',
          maxWidth: '100vw',
          backgroundColor: '#17171F',
          backgroundImage: 'none',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: { xs: 2, sm: 3 }, py: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" fontWeight={700} noWrap>{order ? `Order ${order.orderNumber}` : 'Order details'}</Typography>
          {order && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.75 }}>
              <Chip size="small" label={order.globalId} variant="outlined" />
              <Chip size="small" label={displayStatus(order.status)} color={statusColor(order.status)} />
            </Stack>
          )}
        </Box>
        <Tooltip title="Close order">
          <IconButton aria-label="Close order details" onClick={onClose}><CloseRounded /></IconButton>
        </Tooltip>
      </Box>
      <Divider />
      {!order ? (
        <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}><CircularProgress size={28} /></Box>
      ) : (
        <Box sx={{ px: { xs: 2, sm: 3 }, py: 2.5, pb: 5, overflowY: 'auto' }}>
          <Stack spacing={3}>
            <DetailSection title="Overview">
              <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 1.5 }}>
                <Box><Typography variant="caption" color="text.secondary">Customer</Typography><Typography>{order.customerName}</Typography><Typography variant="caption" color="#A8C7FA">{order.customerGlobalId}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Warehouse</Typography><Typography>{order.warehouseName || 'Unassigned'}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Promise</Typography><Typography>{formatUserDateTime(order.promisedDeliveryAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', fallback: 'Not promised' })}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Tracking</Typography><Typography sx={{ overflowWrap: 'anywhere' }}>{order.trackingNumber || 'Not shipped'}</Typography></Box>
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                {order.shipTo.name} · {order.shipTo.line1}{order.shipTo.line2 ? `, ${order.shipTo.line2}` : ''}, {order.shipTo.city}, {order.shipTo.region} {order.shipTo.postalCode}
              </Typography>
            </DetailSection>

            <DetailSection title="Financial plan">
              <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5 }}>
                {metric('Expected cost', money(order.expectedCostMinor, order.currency))}
                {metric('Expected revenue', money(order.expectedRevenueMinor, order.currency))}
                {metric('Expected margin', money(order.expectedMarginMinor, order.currency), Number(order.expectedMarginMinor || 0) >= 0 ? '#81C784' : '#EF9A9A')}
              </Box>
            </DetailSection>

            <DetailSection title="Order control">
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1, mb: 1.5 }}>
                <Box><Typography variant="caption" color="text.secondary">Plan</Typography><Typography>{displayStatus(order.planStatus || 'not planned')}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Wave</Typography><Typography>{displayStatus(order.waveStatus || 'not released')}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Picks ready</Typography><Typography>{order.readyPickTaskCount} / {order.pickTaskCount}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Picks complete</Typography><Typography>{order.pickedPickTaskCount} / {order.pickTaskCount}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Packages packed</Typography><Typography>{order.packedPackageCount} / {order.packageCount}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Version</Typography><Typography>{order.rowVersion}</Typography></Box>
              </Box>
              {primaryAction?.blockedReason && <Alert severity="info" sx={{ mb: 1.5 }}>{primaryAction.blockedReason}</Alert>}
              {primaryAction && (
                <Tooltip title={primaryAction.blockedReason || (confirmingPicks
                  ? 'Confirm every ready pick task and complete the released wave'
                  : verifyingPack
                    ? 'Verify the carton plan and record package-level billing evidence'
                    : 'Create a released warehouse wave and ready pick tasks')}>
                  <span>
                    <Button
                      fullWidth
                      variant="contained"
                      startIcon={busy ? <CircularProgress size={16} /> : confirmingPicks ? <TaskAltRounded /> : verifyingPack ? <Inventory2Rounded /> : <WarehouseRounded />}
                      disabled={!primaryAction.enabled || busy}
                      onClick={confirmingPicks ? onConfirmPicks : verifyingPack ? onVerifyPack : onRelease}
                    >
                      {busy ? (confirmingPicks ? 'Confirming picks' : verifyingPack ? 'Verifying packages' : 'Releasing') : primaryAction.label}
                    </Button>
                  </span>
                </Tooltip>
              )}
            </DetailSection>

            <DetailSection title={`Lines (${order.lines.length})`}>
              <Stack divider={<Divider flexItem />}>
                {order.lines.map((line) => (
                  <Box key={line.globalId} sx={{ py: 1.25, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 1 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography fontWeight={600}>{line.productName}</Typography>
                      <Typography variant="caption" color="text.secondary">{line.productGlobalId} · {line.channelSku}</Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right' }}>
                      <Typography>{line.quantity} units</Typography>
                      <Typography variant="caption" color="text.secondary">{line.reservedQuantity} reserved · {displayStatus(line.pickStatus || 'not started')}</Typography>
                    </Box>
                  </Box>
                ))}
              </Stack>
            </DetailSection>

            <DetailSection title={`Packages (${order.packages.length})`}>
              {order.packages.length ? <Stack divider={<Divider flexItem />}>
                {order.packages.map((item) => (
                  <Box key={item.globalId} sx={{ py: 1.25, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography fontWeight={600}>Package {item.packageNumber}</Typography>
                        <Chip size="small" label={displayStatus(item.status)} color={item.status === 'planned' ? 'default' : 'success'} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary">{item.globalId}</Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right' }}><Typography>{item.weightGrams} g</Typography><Typography variant="caption" color="text.secondary">{item.dimensionsMm.length} × {item.dimensionsMm.width} × {item.dimensionsMm.height} mm</Typography></Box>
                  </Box>
                ))}
              </Stack> : <Typography variant="body2" color="text.secondary">No package plan has been created.</Typography>}
            </DetailSection>

            <DetailSection title="Carrier rates">
              {order.rates.length ? <Stack divider={<Divider flexItem />}>
                {order.rates.map((rate) => (
                  <Box key={rate.globalId} sx={{ py: 1.25, display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    {rate.selected ? <CheckCircleRounded color="success" fontSize="small" /> : <Box sx={{ width: 20 }} />}
                    <Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={rate.selected ? 700 : 500}>{rate.carrier} · {rate.serviceName}</Typography><Typography variant="caption" color="text.secondary">Arrives {formatUserDateTime(rate.estimatedDeliveryAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', fallback: 'Unknown' })}</Typography></Box>
                    <Box sx={{ textAlign: 'right' }}><Typography>{money(rate.customerChargeMinor, order.currency)}</Typography><Typography variant="caption" color="text.secondary">Cost {money(rate.internalCostMinor, order.currency)}</Typography></Box>
                  </Box>
                ))}
              </Stack> : <Typography variant="body2" color="text.secondary">No carrier rates have been recorded.</Typography>}
            </DetailSection>

            <DetailSection title="Billable events">
              {order.billableEvents.length ? <Stack divider={<Divider flexItem />}>
                {order.billableEvents.map((event) => (
                  <Box key={event.globalId} sx={{ py: 1.25, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                    <Box><Typography>{displayStatus(event.type)}</Typography><Typography variant="caption" color="text.secondary">{event.globalId} · {displayStatus(event.status)}</Typography></Box>
                    <Typography fontWeight={700}>{money(event.amountMinor, order.currency)}</Typography>
                  </Box>
                ))}
              </Stack> : <Typography variant="body2" color="text.secondary">No billable events have accrued.</Typography>}
            </DetailSection>

            <DetailSection title="Event history">
              {order.events.length ? <Stack divider={<Divider flexItem />}>
                {order.events.map((event) => (
                  <Box key={event.globalId} sx={{ py: 1.25 }}>
                    <Stack direction="row" justifyContent="space-between" gap={2}>
                      <Typography fontWeight={600}>{displayStatus(event.type)}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{formatUserDateTime(event.occurredAt, dateTime, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown' })}</Typography>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">{event.globalId}</Typography>
                  </Box>
                ))}
              </Stack> : <Typography variant="body2" color="text.secondary">No domain events have been recorded.</Typography>}
            </DetailSection>
          </Stack>
        </Box>
      )}
    </Drawer>
  )
}

function ExceptionDetailDrawer({
  exception,
  open,
  canManage,
  busy,
  onClose,
  onTransition,
  onOpenOrder,
}: {
  exception: OperationsExceptionListItem | null
  open: boolean
  canManage: boolean
  busy: boolean
  onClose: () => void
  onTransition: (status: OperationsExceptionStatus) => void
  onOpenOrder: (orderGlobalId: string) => void
}) {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('md'))
  const dateTime = useUserDateTime()
  const recommendedAction = typeof exception?.details.recommendedAction === 'string'
    ? exception.details.recommendedAction
    : ''
  const evidence = exception?.details.evidence ?? exception?.details
  const evidenceText = evidence && typeof evidence === 'object' && Object.keys(evidence).length > 0
    ? JSON.stringify(evidence, null, 2)
    : ''
  const transitions: Array<{ status: OperationsExceptionStatus; label: string }> = exception?.status === 'open'
    ? [{ status: 'acknowledged', label: 'Acknowledge' }, { status: 'resolved', label: 'Resolve' }, { status: 'dismissed', label: 'Dismiss' }]
    : exception?.status === 'acknowledged'
      ? [{ status: 'resolved', label: 'Resolve' }, { status: 'open', label: 'Reopen' }, { status: 'dismissed', label: 'Dismiss' }]
      : [{ status: 'open', label: 'Reopen' }]

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: mobile ? '100%' : 'min(520px, 44vw)',
          maxWidth: '100vw',
          backgroundColor: '#17171F',
          backgroundImage: 'none',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: { xs: 2, sm: 3 }, py: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" fontWeight={700}>{exception?.title || 'Exception details'}</Typography>
          {exception && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.75 }}>
              <Chip size="small" label={exception.globalId} variant="outlined" />
              <Chip size="small" label={displayStatus(exception.severity)} color={severityColor(exception.severity)} />
              <Chip size="small" label={displayStatus(exception.status)} color={exceptionStatusColor(exception.status)} />
            </Stack>
          )}
        </Box>
        <Tooltip title="Close exception">
          <IconButton aria-label="Close exception details" onClick={onClose}><CloseRounded /></IconButton>
        </Tooltip>
      </Box>
      <Divider />
      {!exception ? (
        <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}><CircularProgress size={28} /></Box>
      ) : (
        <Box sx={{ px: { xs: 2, sm: 3 }, py: 2.5, pb: 5, overflowY: 'auto' }}>
          <Stack spacing={3}>
            <DetailSection title="Context">
              <Stack spacing={1.25}>
                <Box><Typography variant="caption" color="text.secondary">Type</Typography><Typography>{displayStatus(exception.exceptionType)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Customer</Typography><Typography>{exception.customerName || 'Not linked'}</Typography>{exception.customerGlobalId && <Typography variant="caption" color="#A8C7FA">{exception.customerGlobalId}</Typography>}</Box>
                <Box><Typography variant="caption" color="text.secondary">Assigned to</Typography><Typography>{exception.assignedTo || 'Unassigned'}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Opened</Typography><Typography>{formatUserDateTime(exception.createdAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown' })}</Typography></Box>
              </Stack>
              {exception.orderGlobalId && (
                <Button
                  variant="outlined"
                  startIcon={<OpenInNewRounded />}
                  sx={{ mt: 2 }}
                  onClick={() => onOpenOrder(exception.orderGlobalId || '')}
                >
                  Open order {exception.orderNumber || exception.orderGlobalId}
                </Button>
              )}
            </DetailSection>
            <DetailSection title="Recommended action">
              <Typography color={recommendedAction ? 'text.primary' : 'text.secondary'}>{recommendedAction || 'No recommended action has been recorded.'}</Typography>
            </DetailSection>
            <DetailSection title="Evidence">
              {evidenceText ? (
                <Box component="pre" sx={{ m: 0, p: 1.5, borderRadius: '6px', backgroundColor: '#111118', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.78rem', color: 'text.secondary' }}>{evidenceText}</Box>
              ) : <Typography color="text.secondary">No supporting evidence has been recorded.</Typography>}
            </DetailSection>
            {canManage && (
              <DetailSection title="Disposition">
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  {transitions.map((transition) => (
                    <Button
                      key={transition.status}
                      variant={transition.status === 'resolved' ? 'contained' : 'outlined'}
                      color={transition.status === 'dismissed' ? 'inherit' : 'primary'}
                      disabled={busy}
                      startIcon={transition.status === 'resolved' ? <TaskAltRounded /> : transition.status === 'open' ? <ReplayRounded /> : undefined}
                      onClick={() => onTransition(transition.status)}
                    >
                      {transition.label}
                    </Button>
                  ))}
                </Stack>
              </DetailSection>
            )}
          </Stack>
        </Box>
      )}
    </Drawer>
  )
}

function OperationsGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Operations guide</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Box><Typography fontWeight={700}>1. Import and validate</Typography><Typography color="text.secondary">Orders enter through a commerce adapter. ClawPilot reuses provider mappings or a unique CRM identity match, creates a customer only when no match exists, and sends ambiguous matches to review.</Typography></Box>
          <Box><Typography fontWeight={700}>2. Promise and reserve</Typography><Typography color="text.secondary">ClawPilot selects a feasible warehouse, reserves customer-owned inventory, cartonizes the order, compares rates, and records the promise.</Typography></Box>
          <Box><Typography fontWeight={700}>3. Release and execute</Typography><Typography color="text.secondary">Review the plan, reservations, packages, rates, cost, revenue, and margin before release. Release creates a wave and ready pick tasks. Pick confirmation completes the wave; package verification then records who packed each carton and accrues contract pack fees without purchasing a label or creating a shipment.</Typography></Box>
          <Box><Typography fontWeight={700}>4. Reconcile revenue</Typography><Typography color="text.secondary">Contract directives create immutable billable events for order handling, picks, packing, freight, storage, and special services.</Typography></Box>
          <Alert severity="info">Hosted orders enter through approved commerce integrations. Carrier sandbox rating is available to authorized managers under Settings, Integrations, Shipping. Deterministic mock adapters remain isolated to automated tests and never create hosted workspace records.</Alert>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Done</Button></DialogActions>
    </Dialog>
  )
}

export default function OperationsSection() {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('md'))
  const dateTime = useUserDateTime()
  const [workspace, setWorkspace] = useState<OperationsWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<'orders' | 'exceptions' | 'gl-coding'>('orders')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | OperationsOrderStatus>('')
  const [exceptionStatus, setExceptionStatus] = useState<'' | OperationsExceptionStatus>('')
  const [selectedGlobalId, setSelectedGlobalId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedExceptionGlobalId, setSelectedExceptionGlobalId] = useState<string | null>(null)
  const [exceptionDrawerOpen, setExceptionDrawerOpen] = useState(false)
  const [updatingException, setUpdatingException] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [updatingActivation, setUpdatingActivation] = useState(false)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseReason, setReleaseReason] = useState('Release the reviewed plan to warehouse execution')
  const [releaseIdempotencyKey, setReleaseIdempotencyKey] = useState('')
  const [releasingOrder, setReleasingOrder] = useState(false)
  const [confirmPicksOpen, setConfirmPicksOpen] = useState(false)
  const [confirmPicksReason, setConfirmPicksReason] = useState('Confirm all ready pick tasks for the released wave')
  const [confirmPicksIdempotencyKey, setConfirmPicksIdempotencyKey] = useState('')
  const [confirmingPicks, setConfirmingPicks] = useState(false)
  const [verifyPackOpen, setVerifyPackOpen] = useState(false)
  const [verifyPackReason, setVerifyPackReason] = useState('Verify the carton plan after all warehouse picks are complete')
  const [verifyPackIdempotencyKey, setVerifyPackIdempotencyKey] = useState('')
  const [verifyingPack, setVerifyingPack] = useState(false)

  const loadWorkspace = useCallback(async (orderGlobalId?: string | null, signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    if (view === 'orders' && status) params.set('status', status)
    if (view === 'exceptions' && exceptionStatus) params.set('exceptionStatus', exceptionStatus)
    if (orderGlobalId) params.set('order', orderGlobalId)
    try {
      const response = await fetch(`/api/operations?${params.toString()}`, { cache: 'no-store', signal })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.operations) throw new Error(payload.error || 'Operations data is unavailable')
      setWorkspace(payload.operations)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'Operations data is unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [exceptionStatus, search, status, view])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void loadWorkspace(selectedGlobalId, controller.signal)
    }, search ? 250 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadWorkspace, search, selectedGlobalId])

  const chooseOrder = (order: OperationsOrderListItem) => {
    setSelectedGlobalId(order.globalId)
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    setSelectedGlobalId(null)
  }

  const chooseException = (exception: OperationsExceptionListItem) => {
    setSelectedExceptionGlobalId(exception.globalId)
    setExceptionDrawerOpen(true)
  }

  const closeExceptionDrawer = () => {
    setExceptionDrawerOpen(false)
    setSelectedExceptionGlobalId(null)
  }

  const openExceptionOrder = (orderGlobalId: string) => {
    closeExceptionDrawer()
    setView('orders')
    setSelectedGlobalId(orderGlobalId)
    setDrawerOpen(true)
  }

  const openRelease = () => {
    setReleaseReason('Release the reviewed plan to warehouse execution')
    setReleaseIdempotencyKey(`operations-release:${detail?.globalId || 'order'}:${crypto.randomUUID()}`)
    setReleaseOpen(true)
  }

  const closeRelease = () => {
    if (releasingOrder) return
    setReleaseOpen(false)
    setReleaseIdempotencyKey('')
  }

  const releaseOrder = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !releaseReason.trim() || !releaseIdempotencyKey) return
    setReleasingOrder(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': releaseIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'release-order',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: releaseReason.trim(),
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('orderGlobalId' in payload.result) || !('rowVersion' in payload.result)) {
        throw new Error(payload.error || 'Order could not be released')
      }
      setReleaseOpen(false)
      setReleaseIdempotencyKey('')
      setNotice(`Order ${payload.result.orderGlobalId} was released to warehouse execution.`)
      await loadWorkspace(payload.result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Order could not be released')
    } finally {
      setReleasingOrder(false)
    }
  }

  const openConfirmPicks = () => {
    setConfirmPicksReason('Confirm all ready pick tasks for the released wave')
    setConfirmPicksIdempotencyKey(`operations-picks:${detail?.globalId || 'order'}:${crypto.randomUUID()}`)
    setConfirmPicksOpen(true)
  }

  const closeConfirmPicks = () => {
    if (confirmingPicks) return
    setConfirmPicksOpen(false)
    setConfirmPicksIdempotencyKey('')
  }

  const confirmPicks = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !confirmPicksReason.trim() || !confirmPicksIdempotencyKey) return
    setConfirmingPicks(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': confirmPicksIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'confirm-picks',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: confirmPicksReason.trim(),
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('orderGlobalId' in payload.result) || !('rowVersion' in payload.result)) {
        throw new Error(payload.error || 'Warehouse picks could not be confirmed')
      }
      setConfirmPicksOpen(false)
      setConfirmPicksIdempotencyKey('')
      setNotice(`All picks for order ${payload.result.orderGlobalId} were confirmed.`)
      await loadWorkspace(payload.result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Warehouse picks could not be confirmed')
    } finally {
      setConfirmingPicks(false)
    }
  }

  const openVerifyPack = () => {
    setVerifyPackReason('Verify the carton plan after all warehouse picks are complete')
    setVerifyPackIdempotencyKey(`operations-pack:${detail?.globalId || 'order'}:${crypto.randomUUID()}`)
    setVerifyPackOpen(true)
  }

  const closeVerifyPack = () => {
    if (verifyingPack) return
    setVerifyPackOpen(false)
    setVerifyPackIdempotencyKey('')
  }

  const verifyPack = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !verifyPackReason.trim() || !verifyPackIdempotencyKey) return
    setVerifyingPack(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': verifyPackIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'verify-pack',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: verifyPackReason.trim(),
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('orderGlobalId' in payload.result) || !('rowVersion' in payload.result)) {
        throw new Error(payload.error || 'Packages could not be verified')
      }
      setVerifyPackOpen(false)
      setVerifyPackIdempotencyKey('')
      setNotice(`Packages for order ${payload.result.orderGlobalId} were verified. No label or shipment was created.`)
      await loadWorkspace(payload.result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Packages could not be verified')
    } finally {
      setVerifyingPack(false)
    }
  }

  const transitionException = async (nextStatus: OperationsExceptionStatus) => {
    if (!selectedExceptionGlobalId) return
    setUpdatingException(true)
    setError('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-exception',
          exceptionGlobalId: selectedExceptionGlobalId,
          status: nextStatus,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('exception' in payload.result)) {
        throw new Error(payload.error || 'Exception could not be updated')
      }
      const result = payload.result
      setWorkspace((current) => current ? {
        ...current,
        exceptions: current.exceptions.map((item) => (
          item.globalId === result.exception.globalId ? result.exception : item
        )),
      } : current)
      closeExceptionDrawer()
      await loadWorkspace()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Exception could not be updated')
    } finally {
      setUpdatingException(false)
    }
  }

  const updateActivation = async (state: OperationsActivationState) => {
    if (!workspace || state === workspace.activation.state) return
    setUpdatingActivation(true)
    setError('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-activation',
          state,
          reason: `Changed from ${workspace.activation.state} in the Operations workbench`,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('dataPipeline' in payload.result)) {
        throw new Error(payload.error || 'Operations activation could not be updated')
      }
      await loadWorkspace(selectedGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Operations activation could not be updated')
    } finally {
      setUpdatingActivation(false)
    }
  }

  const capabilities = workspace?.capabilities
  const detail = workspace?.selectedOrder?.globalId === selectedGlobalId ? workspace.selectedOrder : null
  const selectedException = workspace?.exceptions.find((item) => item.globalId === selectedExceptionGlobalId) || null
  const summary = workspace?.summary
  const empty = !loading && (
    view === 'orders'
      ? workspace?.orders.length === 0
      : view === 'exceptions'
        ? workspace?.exceptions.length === 0
        : false
  )

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, pt: { xs: 2, md: 2.5 }, pb: 1.5, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} gap={1.5}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={700}>Order Workbench</Typography>
              {workspace && (
                <Chip
                  size="small"
                  label={displayStatus(workspace.activation.state)}
                  color={workspace.activation.state === 'active' ? 'success' : workspace.activation.state === 'shadow' ? 'info' : 'default'}
                  variant="outlined"
                />
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Distributed fulfillment{workspace ? ` · CRM: ${workspace.dataPipeline.name}` : ''}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            {workspace?.capabilities.canActivate && (
              <Tooltip title="Controls whether Operations is disabled, validating mock flows, read only, live, or frozen">
                <TextField
                  select
                  size="small"
                  value={workspace.activation.state}
                  onChange={(event) => void updateActivation(event.target.value as OperationsActivationState)}
                  disabled={updatingActivation}
                  inputProps={{ 'aria-label': 'Operations activation mode' }}
                  sx={{ ...controlSx, minWidth: 118 }}
                >
                  {ACTIVATION_OPTIONS.map((option) => (
                    <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                  ))}
                </TextField>
              </Tooltip>
            )}
            <Tooltip title="Operations guide"><IconButton aria-label="Open operations guide" onClick={() => setGuideOpen(true)}><HelpOutlineRounded /></IconButton></Tooltip>
            {view !== 'gl-coding' && (
              <Tooltip title="Refresh orders"><span><IconButton aria-label="Refresh operations" disabled={loading} onClick={() => void loadWorkspace(selectedGlobalId)}><RefreshRounded /></IconButton></span></Tooltip>
            )}
          </Stack>
        </Stack>

        {summary && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: { xs: 2, sm: 3.5 }, rowGap: 0.25, mt: 2 }}>
            {metric('Open orders', summary.openOrders)}
            {metric('Exceptions', summary.exceptions, summary.exceptions ? '#EF9A9A' : 'text.primary')}
            {metric('Due soon', summary.dueSoon, summary.dueSoon ? '#FFB74D' : 'text.primary')}
            {metric('Shipped today', summary.shippedToday, '#81C784')}
            {metric('Available units', summary.availableUnits)}
            {metric('Reserved units', summary.reservedUnits)}
            {metric('Unbilled', money(summary.unbilledMinor))}
          </Box>
        )}
        <Tabs
          value={view}
          onChange={(_, next: 'orders' | 'exceptions' | 'gl-coding') => {
            setView(next)
            setSearch('')
            closeDrawer()
            closeExceptionDrawer()
          }}
          aria-label="Operations workbench view"
          sx={{ mt: 1.25, minHeight: 42, '& .MuiTab-root': { minHeight: 42, px: 2 } }}
        >
          <Tab value="orders" label={`Orders${workspace ? ` (${workspace.orders.length})` : ''}`} />
          <Tab value="exceptions" label={`Exceptions${workspace ? ` (${workspace.summary.exceptions})` : ''}`} />
          <Tab value="gl-coding" label="GL Coding" />
        </Tabs>
      </Box>

      {view !== 'gl-coding' && (
        <Box sx={{ px: { xs: 2, md: 3 }, py: 1.5, display: 'flex', flexWrap: 'wrap', gap: 1.25, flexShrink: 0 }}>
          <TextField
            size="small"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={view === 'orders' ? 'Search order, Global ID, or customer' : 'Search exception, order, or customer'}
            inputProps={{ 'aria-label': view === 'orders' ? 'Search operations orders' : 'Search operations exceptions' }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }}
            sx={{ ...controlSx, flex: '1 1 280px', maxWidth: 440 }}
          />
          {view === 'orders' ? (
            <TextField
              select
              size="small"
              value={status}
              onChange={(event) => setStatus(event.target.value as '' | OperationsOrderStatus)}
              inputProps={{ 'aria-label': 'Filter orders by status' }}
              sx={{ ...controlSx, flex: '0 1 180px', minWidth: 150 }}
            >
              {ORDER_STATUSES.map((option) => <MenuItem key={option.value || 'all'} value={option.value}>{option.label}</MenuItem>)}
            </TextField>
          ) : (
            <TextField
              select
              size="small"
              value={exceptionStatus}
              onChange={(event) => setExceptionStatus(event.target.value as '' | OperationsExceptionStatus)}
              inputProps={{ 'aria-label': 'Filter exceptions by status' }}
              sx={{ ...controlSx, flex: '0 1 210px', minWidth: 180 }}
            >
              {EXCEPTION_STATUSES.map((option) => <MenuItem key={option.value || 'all'} value={option.value}>{option.label}</MenuItem>)}
            </TextField>
          )}
        </Box>
      )}

      {view !== 'gl-coding' && error && <Alert severity="error" onClose={() => setError('')} sx={{ mx: { xs: 2, md: 3 }, mb: 1.5 }}>{error}</Alert>}
      {view !== 'gl-coding' && notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mx: { xs: 2, md: 3 }, mb: 1.5 }}>{notice}</Alert>}
      {view !== 'gl-coding' && !loading && workspace && !workspace.configured && (
        <Alert severity="info" sx={{ mx: { xs: 2, md: 3 }, mb: 1.5 }}>Connect an approved commerce provider and configure an active warehouse to begin importing orders.</Alert>
      )}

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {view === 'gl-coding' ? (
          <GlCodingPanel />
        ) : loading && !workspace ? (
          <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}><CircularProgress size={30} /></Box>
        ) : empty ? (
          <Box sx={{ py: 10, px: 3, textAlign: 'center' }}>
            {view === 'orders'
              ? <Inventory2Rounded sx={{ fontSize: 36, color: 'text.disabled' }} />
              : <WarningAmberRounded sx={{ fontSize: 36, color: 'text.disabled' }} />}
            <Typography sx={{ mt: 1 }} fontWeight={600}>No matching {view}</Typography>
          </Box>
        ) : view === 'exceptions' && mobile ? (
          <Stack divider={<Divider flexItem />}>
            {workspace?.exceptions.map((exception) => (
              <Box
                key={exception.globalId}
                component="button"
                type="button"
                onClick={() => chooseException(exception)}
                sx={{
                  appearance: 'none', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left',
                  px: 2, py: 1.75, width: '100%', cursor: 'pointer',
                  '&:active': { backgroundColor: 'rgba(168,199,250,0.08)' },
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1.5}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography fontWeight={700}>{exception.title}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>{exception.customerName || exception.orderNumber || displayStatus(exception.exceptionType)}</Typography>
                  </Box>
                  <Chip size="small" label={displayStatus(exception.severity)} color={severityColor(exception.severity)} />
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-end" gap={1.5} sx={{ mt: 1.25 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="caption" color="#A8C7FA">{exception.globalId}</Typography>
                    <Typography variant="caption" color="text.secondary" display="block" noWrap>{exception.orderNumber ? `Order ${exception.orderNumber}` : 'No order linked'}</Typography>
                  </Box>
                  <Chip size="small" label={displayStatus(exception.status)} color={exceptionStatusColor(exception.status)} />
                </Stack>
              </Box>
            ))}
          </Stack>
        ) : view === 'exceptions' ? (
          <TableContainer sx={{ height: '100%' }}>
            <Table stickyHeader size="small" aria-label="Operations exceptions">
              <TableHead>
                <TableRow>
                  <TableCell>Severity</TableCell><TableCell>Exception</TableCell><TableCell>Order</TableCell><TableCell>Customer</TableCell><TableCell>Status</TableCell><TableCell>Updated</TableCell><TableCell padding="checkbox" />
                </TableRow>
              </TableHead>
              <TableBody>
                {workspace?.exceptions.map((exception) => (
                  <TableRow key={exception.globalId} hover onClick={() => chooseException(exception)} sx={{ cursor: 'pointer' }}>
                    <TableCell><Chip size="small" label={displayStatus(exception.severity)} color={severityColor(exception.severity)} /></TableCell>
                    <TableCell><Typography fontWeight={600}>{exception.title}</Typography><Typography variant="caption" color="#A8C7FA">{exception.globalId} · {displayStatus(exception.exceptionType)}</Typography></TableCell>
                    <TableCell>{exception.orderNumber || '—'}</TableCell>
                    <TableCell><Typography>{exception.customerName || '—'}</Typography>{exception.customerGlobalId && <Typography variant="caption" color="text.secondary">{exception.customerGlobalId}</Typography>}</TableCell>
                    <TableCell><Chip size="small" label={displayStatus(exception.status)} color={exceptionStatusColor(exception.status)} /></TableCell>
                    <TableCell>{formatUserDateTime(exception.updatedAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: '—' })}</TableCell>
                    <TableCell padding="checkbox"><Tooltip title="Open exception"><IconButton size="small" aria-label={`Open exception ${exception.globalId}`}><OpenInNewRounded fontSize="small" /></IconButton></Tooltip></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : mobile ? (
          <Stack divider={<Divider flexItem />}>
            {workspace?.orders.map((order) => (
              <Box
                key={order.globalId}
                component="button"
                type="button"
                onClick={() => chooseOrder(order)}
                sx={{
                  appearance: 'none', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left',
                  px: 2, py: 1.75, width: '100%', cursor: 'pointer',
                  '&:active': { backgroundColor: 'rgba(168,199,250,0.08)' },
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1.5}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography fontWeight={700} noWrap>Order {order.orderNumber}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>{order.customerName}</Typography>
                  </Box>
                  <Chip size="small" label={displayStatus(order.status)} color={statusColor(order.status)} />
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-end" gap={1.5} sx={{ mt: 1.25 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="caption" color="#A8C7FA">{order.globalId}</Typography>
                    <Typography variant="caption" color="text.secondary" display="block" noWrap>{order.warehouseName || 'Unassigned'} · {order.lineCount} {order.lineCount === 1 ? 'line' : 'lines'}</Typography>
                  </Box>
                  <Typography fontWeight={700}>{money(order.expectedRevenueMinor)}</Typography>
                </Stack>
              </Box>
            ))}
          </Stack>
        ) : (
          <TableContainer sx={{ height: '100%' }}>
            <Table stickyHeader size="small" aria-label="Operations orders">
              <TableHead>
                <TableRow>
                  <TableCell>Order</TableCell><TableCell>Customer</TableCell><TableCell>Status</TableCell><TableCell>Warehouse</TableCell><TableCell>Promise</TableCell><TableCell align="right">Lines</TableCell><TableCell align="right">Revenue</TableCell><TableCell>Tracking</TableCell><TableCell padding="checkbox" />
                </TableRow>
              </TableHead>
              <TableBody>
                {workspace?.orders.map((order) => (
                  <TableRow key={order.globalId} hover onClick={() => chooseOrder(order)} sx={{ cursor: 'pointer' }}>
                    <TableCell><Typography fontWeight={600}>{order.orderNumber}</Typography><Typography variant="caption" color="#A8C7FA">{order.globalId}</Typography></TableCell>
                    <TableCell><Typography>{order.customerName}</Typography><Typography variant="caption" color="text.secondary">{order.customerGlobalId}</Typography></TableCell>
                    <TableCell><Chip size="small" label={displayStatus(order.status)} color={statusColor(order.status)} /></TableCell>
                    <TableCell>{order.warehouseName || '—'}</TableCell>
                    <TableCell>{formatUserDateTime(order.promisedDeliveryAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', fallback: '—' })}</TableCell>
                    <TableCell align="right">{order.lineCount}</TableCell>
                    <TableCell align="right">{money(order.expectedRevenueMinor)}</TableCell>
                    <TableCell sx={{ maxWidth: 150 }}><Typography variant="body2" noWrap>{order.trackingNumber || '—'}</Typography></TableCell>
                    <TableCell padding="checkbox"><Tooltip title="Open order"><IconButton size="small" aria-label={`Open order ${order.orderNumber}`}><OpenInNewRounded fontSize="small" /></IconButton></Tooltip></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      <OrderDetailDrawer
        order={detail}
        open={drawerOpen}
        busy={releasingOrder || confirmingPicks || verifyingPack}
        onClose={closeDrawer}
        onRelease={openRelease}
        onConfirmPicks={openConfirmPicks}
        onVerifyPack={openVerifyPack}
      />
      <ExceptionDetailDrawer
        exception={selectedException}
        open={exceptionDrawerOpen}
        canManage={Boolean(capabilities?.canManage)}
        busy={updatingException}
        onClose={closeExceptionDrawer}
        onTransition={(nextStatus) => void transitionException(nextStatus)}
        onOpenOrder={openExceptionOrder}
      />
      <OperationsGuide open={guideOpen} onClose={() => setGuideOpen(false)} />

      <Dialog open={releaseOpen} onClose={closeRelease} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={releaseOrder}>
          <DialogTitle>Release order to warehouse</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                This creates a released warehouse wave and ready pick tasks for {detail?.orderNumber || 'this order'}. The order version and readiness checks are repeated when you confirm.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Release reason"
                value={releaseReason}
                onChange={(event) => setReleaseReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${releaseReason.trim().length}/500 · Recorded in the audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeRelease} disabled={releasingOrder}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={releasingOrder || !releaseReason.trim()}
              startIcon={releasingOrder ? <CircularProgress size={16} /> : <WarehouseRounded />}
            >
              {releasingOrder ? 'Releasing' : 'Confirm release'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={confirmPicksOpen} onClose={closeConfirmPicks} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={confirmPicks}>
          <DialogTitle>Confirm warehouse picks</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                This confirms all {detail?.readyPickTaskCount || 0} ready pick tasks and completes the released wave for {detail?.orderNumber || 'this order'}. Inventory reservations remain in place until shipment.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Pick confirmation reason"
                value={confirmPicksReason}
                onChange={(event) => setConfirmPicksReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${confirmPicksReason.trim().length}/500 · Recorded in the audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeConfirmPicks} disabled={confirmingPicks}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={confirmingPicks || !confirmPicksReason.trim()}
              startIcon={confirmingPicks ? <CircularProgress size={16} /> : <TaskAltRounded />}
            >
              {confirmingPicks ? 'Confirming picks' : 'Confirm picks'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={verifyPackOpen} onClose={closeVerifyPack} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={verifyPack}>
          <DialogTitle>Verify warehouse packages</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                This marks all {detail?.plannedPackageCount || 0} planned packages as packed for {detail?.orderNumber || 'this order'} and accrues versioned contract pack fees. Inventory reservations remain active. No label is purchased and no shipment is created.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Package verification reason"
                value={verifyPackReason}
                onChange={(event) => setVerifyPackReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${verifyPackReason.trim().length}/500 · Recorded in the audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeVerifyPack} disabled={verifyingPack}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={verifyingPack || !verifyPackReason.trim()}
              startIcon={verifyingPack ? <CircularProgress size={16} /> : <Inventory2Rounded />}
            >
              {verifyingPack ? 'Verifying packages' : 'Confirm package verification'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

    </Box>
  )
}
