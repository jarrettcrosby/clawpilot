'use client'

import { useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import SaveRounded from '@mui/icons-material/SaveRounded'
import {
  normalizeOrderShipToDraft,
  orderShipToReadiness,
  type OrderShipToDraft,
} from '@/lib/operations/orderShipTo'
import type {
  OperationsOrderDetail,
  OperationsOrderShipmentAddressUpdateResult,
} from '@/lib/operations/types'

type SavePayload = {
  ok?: boolean
  error?: string
  code?: string
  result?: OperationsOrderShipmentAddressUpdateResult
}

type PendingSave = {
  fingerprint: string
  orderRowVersion: number
  addressRowVersion: number
  idempotencyKey: string
}

function fingerprint(value: OrderShipToDraft) {
  return JSON.stringify([
    value.name,
    value.line1,
    value.line2,
    value.city,
    value.region,
    value.postalCode,
    value.country,
  ])
}

function readinessLabel(
  readiness: ReturnType<typeof orderShipToReadiness>,
) {
  if (readiness === 'carrier_ready') return 'Ready for rates'
  if (readiness === 'missing') return 'Ship-to needed for rates'
  return 'Add details for rates'
}

function addressLine(value: OrderShipToDraft) {
  const locality = [value.city, value.region, value.postalCode]
    .filter(Boolean).join(', ')
  return [value.name, value.line1, value.line2, locality, value.country]
    .filter(Boolean).join(' · ') || 'No address supplied'
}

export default function OrderShipmentAddressEditor({
  order,
  canManage,
  disabled,
  onSaved,
}: {
  order: OperationsOrderDetail
  canManage: boolean
  disabled: boolean
  onSaved: () => void | Promise<void>
}) {
  const shipmentAddress = order.shipmentShipTo
  const [shipTo, setShipTo] = useState<OrderShipToDraft>(() => (
    normalizeOrderShipToDraft(shipmentAddress.value)
  ))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pendingSave = useRef<PendingSave | null>(null)

  const changed = useMemo(() => (
    fingerprint(shipTo)
      !== fingerprint(normalizeOrderShipToDraft(shipmentAddress.value))
  ), [shipTo, shipmentAddress.value])
  const readiness = useMemo(() => orderShipToReadiness(shipTo), [shipTo])
  const editable = canManage && shipmentAddress.editable && !disabled

  const update = (field: keyof OrderShipToDraft, value: string) => {
    setShipTo((current) => ({
      ...current,
      [field]: value || null,
    }))
  }

  const save = async () => {
    if (!editable || !changed || saving) return
    const saveFingerprint = fingerprint(shipTo)
    const retained = pendingSave.current
    const pending = retained
      && retained.fingerprint === saveFingerprint
      && retained.orderRowVersion === order.rowVersion
      && retained.addressRowVersion === shipmentAddress.rowVersion
      ? retained
      : {
          fingerprint: saveFingerprint,
          orderRowVersion: order.rowVersion,
          addressRowVersion: shipmentAddress.rowVersion,
          idempotencyKey: crypto.randomUUID(),
        }
    pendingSave.current = pending
    setSaving(true)
    setError('')
    try {
      const response = await fetch('/api/operations/shipment-address', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': pending.idempotencyKey,
        },
        body: JSON.stringify({
          orderGlobalId: order.globalId,
          expectedOrderRowVersion: pending.orderRowVersion,
          expectedAddressRowVersion: pending.addressRowVersion,
          shipTo,
        }),
      })
      const payload = await response.json().catch(() => ({})) as SavePayload
      if (!response.ok || !payload.ok || !payload.result) {
        if (response.status >= 400 && response.status < 500) {
          pendingSave.current = null
        }
        throw new Error(
          `${payload.error || 'Shipment address could not be saved'}${
            payload.code ? ` [${payload.code}]` : ''
          }`,
        )
      }
      pendingSave.current = null
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Shipment address could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack spacing={1.5} data-testid="canonical-order-shipment-address-editor">
      {error && <Alert severity="error">{error}</Alert>}
      {shipmentAddress.sourceVersionChanged && (
        <Alert severity="warning">
          The store address changed after this local shipment address was saved.
        </Alert>
      )}
      {shipmentAddress.rerateRequired && (
        <Alert severity="warning">
          This shipment address changed after planning. Compare rates again before creating a label.
        </Alert>
      )}
      {!shipmentAddress.editable && shipmentAddress.editBlockedReason && (
        <Alert severity="info">{shipmentAddress.editBlockedReason}</Alert>
      )}

      <Stack direction="row" justifyContent="space-between" gap={1} alignItems="center">
        <Box>
          <Typography fontWeight={700}>Ship to</Typography>
          <Typography variant="caption" color="text.secondary">
            Used for this ClawPilot shipment
          </Typography>
        </Box>
        <Chip
          size="small"
          variant="outlined"
          color={readiness === 'carrier_ready' ? 'success' : 'warning'}
          label={readinessLabel(readiness)}
        />
      </Stack>

      <Stack spacing={1.25}>
        <TextField
          size="small"
          label="Recipient name"
          value={shipTo.name || ''}
          onChange={(event) => update('name', event.target.value)}
          disabled={!editable || saving}
          fullWidth
        />
        <TextField
          size="small"
          label="Address"
          value={shipTo.line1 || ''}
          onChange={(event) => update('line1', event.target.value)}
          disabled={!editable || saving}
          fullWidth
        />
        <TextField
          size="small"
          label="Apartment, suite, etc."
          value={shipTo.line2 || ''}
          onChange={(event) => update('line2', event.target.value)}
          disabled={!editable || saving}
          fullWidth
        />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.25 }}>
          <TextField
            size="small"
            label="City"
            value={shipTo.city || ''}
            onChange={(event) => update('city', event.target.value)}
            disabled={!editable || saving}
            fullWidth
          />
          <TextField
            size="small"
            label="State / province"
            value={shipTo.region || ''}
            onChange={(event) => update('region', event.target.value)}
            disabled={!editable || saving}
            fullWidth
          />
          <TextField
            size="small"
            label="Postal code"
            value={shipTo.postalCode || ''}
            onChange={(event) => update('postalCode', event.target.value)}
            disabled={!editable || saving}
            fullWidth
          />
          <TextField
            size="small"
            label="Country code"
            value={shipTo.country || ''}
            onChange={(event) => update(
              'country',
              event.target.value.toUpperCase(),
            )}
            disabled={!editable || saving}
            inputProps={{ maxLength: 2 }}
            fullWidth
          />
        </Box>
      </Stack>

      {shipmentAddress.provenance === 'local' && (
        <Box sx={{ px: 1.25, py: 1, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.04)' }}>
          <Typography variant="caption" color="text.secondary">Store address</Typography>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {addressLine(shipmentAddress.sourceValue)}
          </Typography>
        </Box>
      )}

      <Stack direction="row" justifyContent="flex-end">
        <Button
          variant="contained"
          startIcon={saving ? <CircularProgress size={16} /> : <SaveRounded />}
          disabled={!editable || saving || !changed}
          onClick={() => void save()}
        >
          Save
        </Button>
      </Stack>
    </Stack>
  )
}
