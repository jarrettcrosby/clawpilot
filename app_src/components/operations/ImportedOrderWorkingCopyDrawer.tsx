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
import type {
  OperationsImportedOrderWorkingCopy,
} from '@/lib/operations/types'
import {
  normalizeOrderShipToDraft,
  orderShipToReadiness,
  type OrderShipToDraft,
} from '@/lib/operations/orderShipTo'

type ImportedOrderWorkingCopyDrawerProps = {
  open: boolean
  order: OperationsImportedOrderWorkingCopy | null
  canManage: boolean
  saving: boolean
  error?: string
  refreshing?: boolean
  onClose: () => void
  onSave: (shipTo: OrderShipToDraft) => Promise<void> | void
  onRefresh?: () => Promise<void> | void
}

const EMPTY_SHIP_TO = normalizeOrderShipToDraft(null)

function providerLabel(provider: OperationsImportedOrderWorkingCopy['provider']) {
  return provider === 'shopify' ? 'Shopify' : 'Faire'
}

function readinessLabel(readiness: ReturnType<typeof orderShipToReadiness>) {
  if (readiness === 'carrier_ready') return 'Ready for rates'
  if (readiness === 'missing') return 'Ship-to needed for rates'
  return 'Ship-to incomplete for rates'
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
  onRefresh,
}: ImportedOrderWorkingCopyDrawerProps) {
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const [shipTo, setShipTo] = useState<OrderShipToDraft>(() => (
    order ? normalizeOrderShipToDraft(order.shipTo.value) : EMPTY_SHIP_TO
  ))

  const changed = useMemo(() => {
    if (!order) return false
    const original = normalizeOrderShipToDraft(order.shipTo.value)
    return Object.keys(original).some((field) => (
      original[field as keyof OrderShipToDraft]
      !== shipTo[field as keyof OrderShipToDraft]
    ))
  }, [order, shipTo])
  const draftReadiness = useMemo(() => orderShipToReadiness(shipTo), [shipTo])

  const update = (field: keyof OrderShipToDraft, value: string) => {
    setShipTo((current) => ({ ...current, [field]: value || null }))
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
                  color={order.needsInfo ? 'warning' : 'success'}
                  label={order.needsInfo ? 'Needs info' : 'Imported'}
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
          {order?.providerVersionChanged && (
            <Alert severity="warning">
              {providerLabel(order.provider)} changed this order after the local draft was saved.
              Refresh before replacing source information.
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
            {onRefresh && (
              <Button
                size="small"
                variant="outlined"
                startIcon={refreshing ? <CircularProgress size={16} /> : <RefreshRounded />}
                disabled={!order || saving || refreshing}
                onClick={() => void onRefresh()}
              >
                Refresh from {order ? providerLabel(order.provider) : 'provider'}
              </Button>
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
                  ClawPilot shipment address
                </Typography>
              </Box>
              {order && (
                <Chip
                  size="small"
                  variant="outlined"
                  color={draftReadiness === 'carrier_ready' ? 'success' : 'warning'}
                  label={readinessLabel(draftReadiness)}
                />
              )}
            </Stack>

            <Stack spacing={1.5}>
              <TextField
                size="small"
                label="Recipient name"
                value={shipTo.name || ''}
                onChange={(event) => update('name', event.target.value)}
                disabled={!canManage || saving}
                fullWidth
              />
              <TextField
                size="small"
                label="Address"
                value={shipTo.line1 || ''}
                onChange={(event) => update('line1', event.target.value)}
                disabled={!canManage || saving}
                fullWidth
              />
              <TextField
                size="small"
                label="Apartment, suite, etc."
                value={shipTo.line2 || ''}
                onChange={(event) => update('line2', event.target.value)}
                disabled={!canManage || saving}
                fullWidth
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  size="small"
                  label="City"
                  value={shipTo.city || ''}
                  onChange={(event) => update('city', event.target.value)}
                  disabled={!canManage || saving}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="State / province"
                  value={shipTo.region || ''}
                  onChange={(event) => update('region', event.target.value)}
                  disabled={!canManage || saving}
                  fullWidth
                />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  size="small"
                  label="Postal code"
                  value={shipTo.postalCode || ''}
                  onChange={(event) => update('postalCode', event.target.value)}
                  disabled={!canManage || saving}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="Country code"
                  value={shipTo.country || ''}
                  onChange={(event) => update('country', event.target.value.toUpperCase())}
                  disabled={!canManage || saving}
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
              startIcon={saving ? <CircularProgress size={16} /> : <SaveRounded />}
              disabled={!order || !canManage || saving || !changed}
              onClick={() => void onSave(shipTo)}
            >
              Save
            </Button>
          </Stack>
        </Stack>
      </Stack>
    </Drawer>
  )
}
