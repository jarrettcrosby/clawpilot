'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import AddCircleOutlineRounded from '@mui/icons-material/AddCircleOutlineRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import EventAvailableRounded from '@mui/icons-material/EventAvailableRounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
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
  InputAdornment,
  MenuItem,
  Pagination,
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
  TextField,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'

import LtlFreightClassAssessmentPanel from '@/components/operations/LtlFreightClassAssessmentPanel'
import OneOffShipmentDialog from '@/components/operations/OneOffShipmentDialog'
import ShippingOneOffExecutionPanel from '@/components/shipping/ShippingOneOffExecutionPanel'
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
const iconActionSx = { minWidth: 44, minHeight: 44 }
const SHIPMENT_PAGE_SIZE = 25

type ShippingRecordSort = 'updated_desc' | 'updated_asc' | 'order_asc'

const SHIPPING_RECORD_SORTS: ReadonlyArray<{
  value: ShippingRecordSort
  label: string
}> = [
  { value: 'updated_desc', label: 'Updated: newest' },
  { value: 'updated_asc', label: 'Updated: oldest' },
  { value: 'order_asc', label: 'Order: A–Z' },
]

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
  if (record.kind === 'shipment_plan' && record.status === 'planned') {
    return record.standaloneOneOffPackEligible ? 'Pack review' : 'Planned'
  }
  if (record.kind === 'shipment_plan' && record.status === 'packed') {
    return 'Postage ready'
  }
  if (record.kind === 'shipment_plan') return display(record.status)
  if (record.kind === 'ltl_tender') return 'Tendered'
  return display(record.status)
}

function recordStageColor(record: ShippingRecord) {
  if (record.kind === 'shipment_plan' && record.status === 'planned') {
    return record.standaloneOneOffPackEligible ? 'warning' as const : 'info' as const
  }
  if (record.kind === 'shipment_plan' && record.status === 'packed') return 'success' as const
  if (record.kind === 'shipment_plan') return 'info' as const
  if (record.status === 'delivered') return 'success' as const
  if (record.status === 'exception') return 'error' as const
  return 'default' as const
}

function ModeSelector({
  mode,
  onChange,
}: {
  mode: ShippingTransportMode
  onChange: (mode: ShippingTransportMode) => void
}) {
  return (
    <ToggleButtonGroup
      data-testid="shipping-mode-selector"
      aria-label="Shipment type"
      value={mode}
      exclusive
      size="small"
      color="primary"
      onChange={(_, nextMode: ShippingTransportMode | null) => {
        if (nextMode) onChange(nextMode)
      }}
      sx={{
        width: { xs: '100%', sm: 'auto' },
        alignSelf: 'flex-start',
        '& .MuiToggleButton-root': {
          minWidth: { xs: 0, sm: 120 },
          minHeight: 44,
          flex: { xs: 1, sm: '0 0 auto' },
          px: 2,
          py: 0.75,
          fontWeight: 750,
          textTransform: 'none',
          borderColor: 'divider',
        },
      }}
    >
      <ToggleButton data-testid="shipping-mode-parcel" value="parcel">
        Parcel
      </ToggleButton>
      <ToggleButton data-testid="shipping-mode-ltl" value="ltl">
        LTL
      </ToggleButton>
    </ToggleButtonGroup>
  )
}

function EmptyRecords({
  mode,
  filtered,
  onClear,
}: {
  mode: ShippingTransportMode
  filtered?: boolean
  onClear?: () => void
}) {
  return (
    <Box sx={{ py: 8, px: 3, textAlign: 'center' }}>
      <LocalShippingRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
      <Typography sx={{ mt: 1 }} fontWeight={700}>
        {filtered
          ? 'No shipments match this search'
          : `No ${mode === 'parcel' ? 'Parcel' : 'LTL'} shipment records`}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {filtered
          ? 'Search by order, customer, carrier, destination, or tracking reference.'
          : mode === 'parcel'
          ? 'Planned one-off shipments and carrier-confirmed parcel shipments will appear here.'
          : 'Only a successful LTL tender will appear here. LTL tendering is not connected yet.'}
      </Typography>
      {filtered && onClear && (
        <Button size="small" onClick={onClear} sx={{ mt: 1.5 }}>
          Clear search
        </Button>
      )}
    </Box>
  )
}

function ShipmentRecords({
  records,
  mode,
  mobile,
  onOpen,
  filtered,
  onClear,
}: {
  records: ShippingRecord[]
  mode: ShippingTransportMode
  mobile: boolean
  onOpen: (record: ShippingRecord) => void
  filtered?: boolean
  onClear?: () => void
}) {
  if (!records.length) {
    return <EmptyRecords mode={mode} filtered={filtered} onClear={onClear} />
  }

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
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {record.carrierName
                  ? `${record.carrierName}${record.serviceCode ? ` · ${record.serviceCode}` : ''}`
                  : 'Carrier not tendered'}
                {' · Tracking '}
                {record.trackingNumber
                  || (record.trackingNumbers.length > 1
                    ? `${record.trackingNumbers.length} references`
                    : 'not available')}
              </Typography>
              <Stack direction="row" justifyContent="space-between" gap={1}>
                <Typography variant="caption" color="primary.main" sx={{ overflowWrap: 'anywhere' }}>{record.orderGlobalId}</Typography>
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
                <Typography variant="caption" color="primary.main">{record.orderGlobalId}</Typography>
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
                  <IconButton
                    sx={iconActionSx}
                    size="small"
                    aria-label={`View shipment ${record.orderNumber}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpen(record)
                    }}
                  >
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
  canCreateShipments,
  canPurchaseLivePostage,
  onUpdated,
}: {
  record: ShippingRecord | null
  onClose: () => void
  canCreateShipments: boolean
  canPurchaseLivePostage: boolean
  onUpdated: () => void | Promise<void>
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
        <IconButton sx={iconActionSx} aria-label="Close shipment record" onClick={onClose}><CloseRounded /></IconButton>
      </DialogTitle>
      {record && (
        <DialogContent dividers>
          <Stack spacing={2}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
              <Box><Typography variant="caption" color="text.secondary">Mode</Typography><Typography>{record.transportMode === 'parcel' ? 'Parcel' : 'LTL'}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Status</Typography><Typography>{recordStage(record)}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Order Global ID</Typography><Typography color="primary.main" sx={{ overflowWrap: 'anywhere' }}>{record.orderGlobalId}</Typography></Box>
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
            {(record.standaloneOneOffPackEligible
              || record.standaloneOneOffExecutionEligible)
              && canCreateShipments ? (
              <>
                <Divider />
                <Box>
                  <Typography fontWeight={750} sx={{ mb: 1 }}>
                    One-off pack and postage
                  </Typography>
                  <ShippingOneOffExecutionPanel
                    orderGlobalId={record.orderGlobalId}
                    canPurchaseLivePostage={canPurchaseLivePostage}
                    onUpdated={onUpdated}
                  />
                </Box>
              </>
            ) : (record.standaloneOneOffPackEligible
              || record.standaloneOneOffExecutionEligible) ? (
              <Alert severity="info">
                Create shipments permission is required to confirm physical pack, refresh rates, create labels, or cancel this standalone shipment.
              </Alert>
            ) : record.kind === 'shipment_plan' && record.executionMode ? (
              <Alert severity="info">
                This plan is not currently eligible for the exact Shipping pack or postage transition. Refresh after resolving its displayed status.
              </Alert>
            ) : null}
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
  const [recordSearch, setRecordSearch] = useState('')
  const [recordSort, setRecordSort] = useState<ShippingRecordSort>('updated_desc')
  const [recordPage, setRecordPage] = useState(1)

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
  const filteredRecords = useMemo(() => {
    const query = recordSearch.trim().toLocaleLowerCase()
    return records
      .filter((record) => !query || [
        record.orderNumber,
        record.orderGlobalId,
        record.referenceNumber,
        record.customerName,
        record.destination,
        record.carrierName,
        record.serviceCode,
        record.trackingNumber,
        ...record.trackingNumbers,
      ].some((value) => String(value || '').toLocaleLowerCase().includes(query)))
      .sort((left, right) => {
        if (recordSort === 'order_asc') {
          return left.orderNumber.localeCompare(
            right.orderNumber,
            undefined,
            { numeric: true, sensitivity: 'base' },
          )
        }
        const difference = Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
        return recordSort === 'updated_asc' ? difference : -difference
      })
  }, [recordSearch, recordSort, records])
  const recordPageCount = Math.max(
    1,
    Math.ceil(filteredRecords.length / SHIPMENT_PAGE_SIZE),
  )
  const currentRecordPage = Math.min(recordPage, recordPageCount)
  const visibleRecords = useMemo(() => {
    const start = (currentRecordPage - 1) * SHIPMENT_PAGE_SIZE
    return filteredRecords.slice(start, start + SHIPMENT_PAGE_SIZE)
  }, [currentRecordPage, filteredRecords])

  useEffect(() => {
    setRecordPage((current) => Math.min(current, recordPageCount))
  }, [recordPageCount])

  useEffect(() => {
    setSelectedRecord((current) => {
      if (!current || !workspace) return current
      return workspace.records.find((record) => (
        record.recordId === current.recordId
        && record.transportMode === current.transportMode
      )) || null
    })
  }, [workspace])

  const onCreated = (result: OneOffShipmentCreateResult) => {
    setNotice(result.orderStatus === 'packed'
      ? `Parcel shipment ${result.orderGlobalId} is packed and ready for a current postage quote. No postage, label, or tracking number was created yet.`
      : `Parcel shipment ${result.orderGlobalId} was planned with ${result.packageCount} ${result.packageCount === 1 ? 'package' : 'packages'}. Open it in Shipments to physically review and confirm pack; no postage, label, or tracking number was created during planning.`)
    setMode('parcel')
    void loadWorkspace()
  }

  const title = view === 'create'
    ? 'Create Shipment'
    : view === 'shipments'
      ? 'Shipments'
      : 'Schedule Pickups'
  return (
    <Box data-testid="shipping-section" sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, pt: { xs: 2, md: 2.5 }, borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
        <Stack direction="row" justifyContent="space-between" gap={2} alignItems="flex-start">
          <Box>
            <Typography variant="h5" fontWeight={750}>{title}</Typography>
          </Box>
          <Tooltip title="Refresh Shipping">
            <span>
              <IconButton sx={iconActionSx} aria-label="Refresh shipping" disabled={loading} onClick={() => { void loadWorkspace() }}>
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
          {error && (
            <Alert
              severity="error"
              action={!workspace ? (
                <Button color="inherit" size="small" onClick={() => void loadWorkspace()}>
                  Retry
                </Button>
              ) : undefined}
            >
              {error}
            </Alert>
          )}
          {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
          <ModeSelector mode={mode} onChange={(nextMode) => {
            setMode(nextMode)
            setRecordPage(1)
          }} />
          {loading && workspace && (
            <Alert severity="info" icon={<CircularProgress size={18} />}>
              Refreshing shipping records…
            </Alert>
          )}

          {loading && !workspace ? (
            <Box sx={{ py: 8, display: 'grid', placeItems: 'center' }}><CircularProgress size={28} /></Box>
          ) : !workspace ? (
            <Box sx={{ py: 8, px: 3, textAlign: 'center' }}>
              <Typography fontWeight={700}>Shipping data could not be loaded</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Retry after checking your connection. No shipping action was attempted.
              </Typography>
            </Box>
          ) : view === 'create' ? (
            mode === 'parcel' ? (
              <Stack spacing={1.25} alignItems="flex-start">
                {!workspace?.capabilities.canCreate && (
                  <Alert severity="warning">
                    Create shipments permission is required.
                  </Alert>
                )}
                <Button
                  data-testid="create-parcel-shipment"
                  variant="contained"
                  size="small"
                  startIcon={<AddCircleOutlineRounded />}
                  disabled={!workspace?.capabilities.canCreate}
                  onClick={() => setParcelDialogOpen(true)}
                  sx={{ minHeight: { xs: 44, sm: 40 } }}
                >
                  Create parcel shipment
                </Button>
                <Alert severity="info">
                  A one-time ad-hoc item can be rated, labeled, and cancelled here without CRM product or inventory setup. Existing inventory and deliberately created products retain exact reservations, then can be physically reviewed, packed, rerated, labeled, and cancelled entirely in Shipping without Operations activation.
                </Alert>
              </Stack>
            ) : (
              <Stack spacing={2}>
                <Alert severity="warning">
                  <Typography fontWeight={750}>LTL preparation only</Typography>
                  Rating, tender, and pickup are not connected yet.
                </Alert>
                {workspace?.capabilities.canCreate ? (
                  <LtlFreightClassAssessmentPanel />
                ) : (
                  <Alert severity="warning">
                    Create shipments permission is required to prepare LTL class evidence.
                  </Alert>
                )}
              </Stack>
            )
          ) : view === 'shipments' ? (
            <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
              <Box sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.25} alignItems={{ xs: 'stretch', md: 'center' }}>
                  <Box>
                    <Typography fontWeight={750}>{mode === 'parcel' ? 'Parcel' : 'LTL'} shipments</Typography>
                  </Box>
                  <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
                    <TextField
                      size="small"
                      value={recordSearch}
                      onChange={(event) => {
                        setRecordSearch(event.target.value)
                        setRecordPage(1)
                      }}
                      placeholder="Order, customer, carrier, or tracking"
                      inputProps={{ 'aria-label': 'Search shipment records' }}
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <SearchRounded fontSize="small" />
                          </InputAdornment>
                        ),
                      }}
                      sx={{ minWidth: { sm: 280 } }}
                    />
                    <TextField
                      select
                      size="small"
                      value={recordSort}
                      onChange={(event) => {
                        setRecordSort(event.target.value as ShippingRecordSort)
                        setRecordPage(1)
                      }}
                      inputProps={{ 'aria-label': 'Sort shipment records' }}
                      sx={{ minWidth: 165 }}
                    >
                      {SHIPPING_RECORD_SORTS.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Chip
                      label={recordSearch.trim()
                        ? `${filteredRecords.length} of ${records.length}`
                        : `${records.length} records`}
                      variant="outlined"
                    />
                  </Stack>
                </Stack>
              </Box>
              <ShipmentRecords
                records={visibleRecords}
                mode={mode}
                mobile={mobile}
                onOpen={setSelectedRecord}
                filtered={Boolean(recordSearch.trim())}
                onClear={() => {
                  setRecordSearch('')
                  setRecordPage(1)
                }}
              />
              {filteredRecords.length > SHIPMENT_PAGE_SIZE && (
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  alignItems={{ xs: 'stretch', sm: 'center' }}
                  justifyContent="space-between"
                  gap={1}
                  sx={{ px: 2, py: 1.5, borderTop: '1px solid', borderColor: 'divider' }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {(currentRecordPage - 1) * SHIPMENT_PAGE_SIZE + 1}–{Math.min(currentRecordPage * SHIPMENT_PAGE_SIZE, filteredRecords.length)} of {filteredRecords.length}
                  </Typography>
                  <Pagination
                    count={recordPageCount}
                    page={currentRecordPage}
                    onChange={(_event, page) => setRecordPage(page)}
                    size="small"
                    siblingCount={mobile ? 0 : 1}
                    boundaryCount={mobile ? 0 : 1}
                    aria-label="Shipment record pages"
                  />
                </Stack>
              )}
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
      />
      <RecordDialog
        record={selectedRecord}
        onClose={() => setSelectedRecord(null)}
        canCreateShipments={Boolean(workspace?.capabilities.canCreate)}
        canPurchaseLivePostage={Boolean(workspace?.capabilities.canPurchaseLivePostage)}
        onUpdated={loadWorkspace}
      />
    </Box>
  )
}
