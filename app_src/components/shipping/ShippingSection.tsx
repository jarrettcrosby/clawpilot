'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import AddCircleOutlineRounded from '@mui/icons-material/AddCircleOutlineRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import EventAvailableRounded from '@mui/icons-material/EventAvailableRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'

import LtlFreightClassAssessmentPanel from '@/components/operations/LtlFreightClassAssessmentPanel'
import OneOffShipmentDialog from '@/components/operations/OneOffShipmentDialog'
import type { OneOffShipmentCreateResult } from '@/lib/operations/oneOffShipments'
import type {
  ShippingRecord,
  ShippingTransportMode,
  ShippingWorkspace,
} from '@/lib/operations/shipping'

export type ShippingView = 'create' | 'shipments' | 'pickups'

type ShippingPayload = {
  ok?: boolean
  error?: string
  code?: string
  shipping?: ShippingWorkspace
}

const SHIPPING_TARGETS: Record<ShippingView, string> = {
  create: 'shipping',
  shipments: 'shipping/shipments',
  pickups: 'shipping/pickups',
}

function display(value: string) {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function formatDate(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return '—'
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function recordStage(record: ShippingRecord) {
  if (record.kind === 'shipment_plan') return 'Planned'
  if (record.kind === 'ltl_tender') return 'Tendered'
  return display(record.status)
}

function recordStageColor(record: ShippingRecord) {
  if (record.kind === 'shipment_plan') return 'info' as const
  if (record.status === 'delivered') return 'success' as const
  if (record.status === 'exception') return 'error' as const
  return 'default' as const
}

function ModeButton({
  mode,
  selected,
  onSelect,
  icon,
  title,
  description,
  badge,
}: {
  mode: ShippingTransportMode
  selected: boolean
  onSelect: (mode: ShippingTransportMode) => void
  icon: ReactNode
  title: string
  description: string
  badge: string
}) {
  return (
    <Button
      data-testid={`shipping-mode-${mode}`}
      aria-pressed={selected}
      variant={selected ? 'contained' : 'outlined'}
      color={selected ? 'primary' : 'inherit'}
      onClick={() => onSelect(mode)}
      sx={{
        minHeight: 104,
        justifyContent: 'flex-start',
        alignItems: 'stretch',
        p: 2,
        textAlign: 'left',
        textTransform: 'none',
        borderColor: selected ? undefined : 'rgba(255,255,255,0.14)',
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="flex-start" width="100%">
        <Box sx={{ mt: 0.25, display: 'grid', placeItems: 'center' }}>{icon}</Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography fontWeight={800}>{title}</Typography>
            <Chip
              size="small"
              label={badge}
              color={selected ? 'default' : 'info'}
              variant={selected ? 'filled' : 'outlined'}
            />
          </Stack>
          <Typography
            variant="body2"
            sx={{ mt: 0.5, color: selected ? 'inherit' : 'text.secondary' }}
          >
            {description}
          </Typography>
        </Box>
      </Stack>
    </Button>
  )
}

function ModeSelector({
  mode,
  onChange,
}: {
  mode: ShippingTransportMode
  onChange: (mode: ShippingTransportMode) => void
}) {
  return (
    <Box
      data-testid="shipping-mode-selector"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
        gap: 1.25,
      }}
    >
      <ModeButton
        mode="parcel"
        selected={mode === 'parcel'}
        onSelect={onChange}
        icon={<Inventory2Rounded />}
        title="Parcel"
        badge="Loose packages"
        description="Cartons and poly bags remain loose. Direct UPS and FedEx execution is available through the existing one-off workflow."
      />
      <ModeButton
        mode="ltl"
        selected={mode === 'ltl'}
        onSelect={onChange}
        icon={<LocalShippingRounded />}
        title="LTL"
        badge="Preparation only"
        description="Cartons are palletized into outbound handling units. Classification can be prepared now; rating and tender are still gated."
      />
    </Box>
  )
}

function EmptyRecords({ mode }: { mode: ShippingTransportMode }) {
  return (
    <Box sx={{ py: 8, px: 3, textAlign: 'center' }}>
      <LocalShippingRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
      <Typography sx={{ mt: 1 }} fontWeight={700}>
        No {mode === 'parcel' ? 'Parcel' : 'LTL'} shipment records
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {mode === 'parcel'
          ? 'Planned one-off shipments and carrier-confirmed parcel shipments will appear here.'
          : 'Only a successful LTL tender will appear here. LTL tendering is not connected yet.'}
      </Typography>
    </Box>
  )
}

function ShipmentRecords({
  records,
  mode,
  mobile,
  onOpen,
}: {
  records: ShippingRecord[]
  mode: ShippingTransportMode
  mobile: boolean
  onOpen: (record: ShippingRecord) => void
}) {
  if (!records.length) return <EmptyRecords mode={mode} />

  if (mobile) {
    return (
      <Stack divider={<Divider flexItem />}>
        {records.map((record) => (
          <Button
            key={`${record.transportMode}:${record.recordId}`}
            color="inherit"
            onClick={() => onOpen(record)}
            sx={{ p: 2, justifyContent: 'flex-start', textAlign: 'left', textTransform: 'none' }}
          >
            <Stack width="100%" spacing={1}>
              <Stack direction="row" justifyContent="space-between" gap={1} alignItems="flex-start">
                <Box sx={{ minWidth: 0 }}>
                  <Typography fontWeight={750} noWrap>{record.orderNumber}</Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {record.customerName} · {record.destination || 'Destination unavailable'}
                  </Typography>
                </Box>
                <Chip size="small" label={recordStage(record)} color={recordStageColor(record)} />
              </Stack>
              <Stack direction="row" justifyContent="space-between" gap={1}>
                <Typography variant="caption" color="#A8C7FA">{record.orderGlobalId}</Typography>
                <Typography variant="caption" color="text.secondary">{formatDate(record.occurredAt)}</Typography>
              </Stack>
            </Stack>
          </Button>
        ))}
      </Stack>
    )
  }

  return (
    <TableContainer>
      <Table stickyHeader size="small" aria-label={`${mode} shipment records`}>
        <TableHead>
          <TableRow>
            <TableCell>Shipment / order</TableCell>
            <TableCell>Customer</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Carrier / service</TableCell>
            <TableCell>Tracking / PRO</TableCell>
            <TableCell align="right">Handling units</TableCell>
            <TableCell>Updated</TableCell>
            <TableCell padding="checkbox" />
          </TableRow>
        </TableHead>
        <TableBody>
          {records.map((record) => (
            <TableRow
              key={`${record.transportMode}:${record.recordId}`}
              hover
              onClick={() => onOpen(record)}
              sx={{ cursor: 'pointer' }}
            >
              <TableCell>
                <Typography fontWeight={650}>{record.orderNumber}</Typography>
                <Typography variant="caption" color="#A8C7FA">{record.orderGlobalId}</Typography>
              </TableCell>
              <TableCell>
                <Typography>{record.customerName}</Typography>
                <Typography variant="caption" color="text.secondary">{record.destination || '—'}</Typography>
              </TableCell>
              <TableCell><Chip size="small" label={recordStage(record)} color={recordStageColor(record)} /></TableCell>
              <TableCell>{record.carrierName ? `${record.carrierName}${record.serviceCode ? ` · ${record.serviceCode}` : ''}` : 'Not tendered'}</TableCell>
              <TableCell>{record.trackingNumber || (record.trackingNumbers.length > 1 ? `${record.trackingNumbers.length} tracking numbers` : '—')}</TableCell>
              <TableCell align="right">{record.handlingUnitCount}</TableCell>
              <TableCell>{formatDate(record.occurredAt)}</TableCell>
              <TableCell padding="checkbox">
                <Tooltip title="View shipment record">
                  <IconButton size="small" aria-label={`View shipment ${record.orderNumber}`}>
                    <OpenInNewRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

function RecordDialog({
  record,
  onClose,
}: {
  record: ShippingRecord | null
  onClose: () => void
}) {
  return (
    <Dialog open={Boolean(record)} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ flex: 1 }}>
          <Typography component="span" variant="h6" fontWeight={750}>
            {record?.orderNumber || 'Shipment record'}
          </Typography>
          {record && (
            <Typography display="block" variant="body2" color="text.secondary">
              {record.kind === 'shipment_plan'
                ? 'Shipment plan — no carrier tender yet'
                : record.transportMode === 'ltl'
                  ? 'Successful LTL tender evidence'
                  : 'Carrier-confirmed parcel shipment'}
            </Typography>
          )}
        </Box>
        <IconButton aria-label="Close shipment record" onClick={onClose}><CloseRounded /></IconButton>
      </DialogTitle>
      {record && (
        <DialogContent dividers>
          <Stack spacing={2}>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
              <Box><Typography variant="caption" color="text.secondary">Mode</Typography><Typography>{record.transportMode === 'parcel' ? 'Parcel' : 'LTL'}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Status</Typography><Typography>{recordStage(record)}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Order Global ID</Typography><Typography color="#A8C7FA">{record.orderGlobalId}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Reference</Typography><Typography>{record.referenceNumber}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Customer</Typography><Typography>{record.customerName}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Destination</Typography><Typography>{record.destination || '—'}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Carrier</Typography><Typography>{record.carrierName || 'Not tendered'}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Service</Typography><Typography>{record.serviceCode || '—'}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Handling units</Typography><Typography>{record.handlingUnitCount}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Environment</Typography><Typography>{record.executionMode ? record.executionMode.toUpperCase() : '—'}</Typography></Box>
            </Box>
            <Divider />
            <Box>
              <Typography variant="caption" color="text.secondary">Tracking / PRO references</Typography>
              {record.trackingNumbers.length ? record.trackingNumbers.map((tracking) => (
                <Typography key={tracking}>{tracking}</Typography>
              )) : <Typography>None — this is a plan, not a carrier-confirmed shipment.</Typography>}
            </Box>
          </Stack>
        </DialogContent>
      )}
    </Dialog>
  )
}

export default function ShippingSection({
  view,
  onNavigate,
}: {
  view: ShippingView
  onNavigate: (target: string) => void
}) {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('sm'))
  const [mode, setMode] = useState<ShippingTransportMode>('parcel')
  const [workspace, setWorkspace] = useState<ShippingWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [parcelDialogOpen, setParcelDialogOpen] = useState(false)
  const [selectedRecord, setSelectedRecord] = useState<ShippingRecord | null>(null)

  const loadWorkspace = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/operations/shipping', {
        cache: 'no-store',
        signal,
      })
      const payload = await response.json().catch(() => ({})) as ShippingPayload
      if (!response.ok || !payload.ok || !payload.shipping) {
        throw new Error(`${payload.error || 'Shipping data is unavailable'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      setWorkspace(payload.shipping)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'Shipping data is unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadWorkspace(controller.signal)
    return () => controller.abort()
  }, [loadWorkspace])

  const records = useMemo(
    () => workspace?.records.filter((record) => record.transportMode === mode) || [],
    [mode, workspace],
  )

  const onCreated = (result: OneOffShipmentCreateResult) => {
    setNotice(
      `Parcel shipment ${result.orderGlobalId} was planned with ${result.packageCount} ${result.packageCount === 1 ? 'package' : 'packages'}. No postage, label, or tracking number was created during planning.`,
    )
    setMode('parcel')
    void loadWorkspace()
  }

  const title = view === 'create'
    ? 'Create Shipment'
    : view === 'shipments'
      ? 'Shipments'
      : 'Schedule Pickups'
  const subtitle = view === 'create'
    ? 'Choose Parcel or LTL before entering shipment facts'
    : view === 'shipments'
      ? 'View planned and carrier-confirmed shipping records by transport mode'
      : 'Pickup workflows remain separated by transport mode and carrier authority'

  return (
    <Box data-testid="shipping-section" sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, pt: { xs: 2, md: 2.5 }, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <Stack direction="row" justifyContent="space-between" gap={2} alignItems="flex-start">
          <Box>
            <Typography variant="h5" fontWeight={750}>{title}</Typography>
            <Typography variant="body2" color="text.secondary">{subtitle}</Typography>
          </Box>
          <Tooltip title="Refresh Shipping">
            <span>
              <IconButton aria-label="Refresh shipping" disabled={loading} onClick={() => { void loadWorkspace() }}>
                <RefreshRounded />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
        <Tabs
          value={view}
          onChange={(_, next: ShippingView) => onNavigate(SHIPPING_TARGETS[next])}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Shipping modules"
          sx={{ mt: 1.25, minHeight: 44 }}
        >
          <Tab value="create" label="Create Shipment" icon={<AddCircleOutlineRounded fontSize="small" />} iconPosition="start" />
          <Tab value="shipments" label="Shipments" icon={<LocalShippingRounded fontSize="small" />} iconPosition="start" />
          <Tab value="pickups" label="Schedule Pickups" icon={<EventAvailableRounded fontSize="small" />} iconPosition="start" />
        </Tabs>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <Stack spacing={2} sx={{ p: { xs: 2, md: 3 }, maxWidth: view === 'shipments' ? 'none' : 1120, mx: view === 'shipments' ? 0 : 'auto' }}>
          {error && <Alert severity="error">{error}</Alert>}
          {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
          <ModeSelector mode={mode} onChange={setMode} />

          {loading && !workspace ? (
            <Box sx={{ py: 8, display: 'grid', placeItems: 'center' }}><CircularProgress size={28} /></Box>
          ) : view === 'create' ? (
            mode === 'parcel' ? (
              <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
                <Stack spacing={2} alignItems="flex-start">
                  <Chip label="Parcel workflow" color="info" variant="outlined" />
                  <Box>
                    <Typography variant="h6" fontWeight={750}>Create parcel shipment</Typography>
                    <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                      Enter loose cartons or poly bags, compare direct UPS and FedEx rates,
                      and create a planned Operations order. Postage is purchased only in the
                      later whole-shipment execution step.
                    </Typography>
                  </Box>
                  {!workspace?.capabilities.canCreate && (
                    <Alert severity="warning">
                      Operations management and warehouse execution permission are required.
                    </Alert>
                  )}
                  <Button
                    data-testid="create-parcel-shipment"
                    variant="contained"
                    startIcon={<AddCircleOutlineRounded />}
                    disabled={!workspace?.capabilities.canCreate}
                    onClick={() => setParcelDialogOpen(true)}
                  >
                    Create parcel shipment
                  </Button>
                </Stack>
              </Paper>
            ) : (
              <Stack spacing={2}>
                <Alert severity="warning">
                  <Typography fontWeight={750}>LTL preparation only</Typography>
                  Cartons must be assigned to pallet handling units. You can calculate and attest
                  density-class evidence now, but LTL carrier rates, bill of lading/tender, and
                  pickup scheduling are not connected to Create Shipment yet.
                </Alert>
                {workspace?.capabilities.canCreate ? (
                  <LtlFreightClassAssessmentPanel />
                ) : (
                  <Alert severity="warning">
                    Operations management and warehouse execution permission are required to prepare LTL class evidence.
                  </Alert>
                )}
              </Stack>
            )
          ) : view === 'shipments' ? (
            <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
              <Box sx={{ px: 2, py: 1.5, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <Stack direction="row" justifyContent="space-between" gap={1} alignItems="center">
                  <Box>
                    <Typography fontWeight={750}>{mode === 'parcel' ? 'Parcel' : 'LTL'} shipments</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {mode === 'parcel'
                        ? 'Planned one-off records are labeled separately from carrier-confirmed shipments.'
                        : 'Only successful freight tenders are treated as LTL shipments.'}
                    </Typography>
                  </Box>
                  <Chip label={`${records.length} records`} variant="outlined" />
                </Stack>
              </Box>
              <ShipmentRecords records={records} mode={mode} mobile={mobile} onOpen={setSelectedRecord} />
            </Paper>
          ) : (
            <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
              <Stack spacing={2} alignItems="flex-start">
                <Chip label={mode === 'parcel' ? 'Parcel pickup' : 'LTL pickup'} color="warning" variant="outlined" />
                <Box>
                  <Typography variant="h6" fontWeight={750}>Pickup scheduling is not yet available</Typography>
                  <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                    {workspace?.pickupAvailability[mode].blocker
                      || (mode === 'parcel'
                        ? 'Parcel pickup will become available only from an eligible packed shipment.'
                        : 'LTL pickup will be scheduled only with the exact rated pallet plan and tender.')}
                  </Typography>
                </Box>
                <Alert severity="info">
                  {mode === 'parcel'
                    ? 'Worldwide Express parcel pickup must be scheduled against the exact packed shipment and selected offer before integrated tender.'
                    : 'LTL pickup belongs with the selected provider and exact freight tender; it is not a free-standing calendar action.'}
                </Alert>
                <Button disabled variant="contained" startIcon={<EventAvailableRounded />}>
                  Schedule {mode === 'parcel' ? 'Parcel' : 'LTL'} pickup
                </Button>
              </Stack>
            </Paper>
          )}
        </Stack>
      </Box>

      <OneOffShipmentDialog
        open={parcelDialogOpen}
        onClose={() => setParcelDialogOpen(false)}
        onCreated={onCreated}
        canActivate={Boolean(workspace?.capabilities.canActivate)}
      />
      <RecordDialog record={selectedRecord} onClose={() => setSelectedRecord(null)} />
    </Box>
  )
}
