'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import BarcodeRounded from '@mui/icons-material/QrCodeScannerRounded'
import DownloadRounded from '@mui/icons-material/DownloadRounded'
import PrintRounded from '@mui/icons-material/PrintRounded'
import VisibilityRounded from '@mui/icons-material/VisibilityRounded'
import type {
  OperationsBarcodeLabelBatch,
  OperationsBarcodeLabelLocation,
  OperationsBarcodeLabelProduct,
  OperationsBarcodeLabelWorkspace,
} from '@/lib/persistence/operationBarcodeLabels'
import type { WearableLocationScanPolicy } from '@/lib/persistence/wearableLocationScanPolicy'

type Props = { open: boolean; onClose: () => void }
type TargetType = 'product' | 'location'
type Target = OperationsBarcodeLabelProduct | OperationsBarcodeLabelLocation

type ApiPayload = {
  ok?: boolean
  error?: string
  workspace?: OperationsBarcodeLabelWorkspace
  batch?: OperationsBarcodeLabelBatch
  policy?: WearableLocationScanPolicy
}

function productLabel(product: OperationsBarcodeLabelProduct) {
  const identity = product.barcodeValue
    ? `${product.barcodeValue} · ${product.barcodeSource === 'provider'
      ? `${product.sourceIdentity}${product.sourceIdentity === 'GTIN-14' ? ' printed as Code 128' : ''}`
      : 'ClawPilot Code 128'}`
    : 'ClawPilot Code 128 will be assigned when generated'
  return `${product.name}${product.sku ? ` · ${product.sku}` : ''} · ${identity}`
}

function locationLabel(location: OperationsBarcodeLabelLocation) {
  return `${location.code} · ${location.zone} · ${location.locationType}`
}

export default function BarcodeLabelsDialog({ open, onClose }: Props) {
  const [workspace, setWorkspace] = useState<OperationsBarcodeLabelWorkspace | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [targetType, setTargetType] = useState<TargetType>('product')
  const [warehouseGlobalId, setWarehouseGlobalId] = useState('')
  const [selected, setSelected] = useState<Target[]>([])
  const [copies, setCopies] = useState(1)
  const [media, setMedia] = useState<'label_2x1' | 'label_3x1' | 'label_4x2' | 'label_4x6' | 'label_4x8'>('label_3x1')
  const [preferredPrinters, setPreferredPrinters] = useState<Record<string, string>>({})

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/operations/barcode-labels', {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const payload = await response.json() as ApiPayload
      if (!response.ok || !payload.workspace) throw new Error(payload.error || 'Barcode labels could not be loaded')
      setWorkspace(payload.workspace)
      setWarehouseGlobalId((current) => current || payload.workspace?.warehouses[0]?.globalId || '')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Barcode labels could not be loaded')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
  }, [open])

  useEffect(() => {
    setSelected([])
  }, [targetType, warehouseGlobalId])

  const options = useMemo<Target[]>(() => {
    if (!workspace) return []
    if (targetType === 'product') return workspace.products
    return workspace.locations.filter((location) => location.warehouseGlobalId === warehouseGlobalId)
  }, [targetType, warehouseGlobalId, workspace])

  const selectedWarehouse = useMemo(() => (
    workspace?.warehouses.find((warehouse) => warehouse.globalId === warehouseGlobalId) || null
  ), [warehouseGlobalId, workspace])

  const compatiblePrintersForBatch = (labelBatch: OperationsBarcodeLabelBatch) => (
    (workspace?.printers || []).filter((printer) => (
      printer.warehouseGlobalId === labelBatch.warehouseGlobalId
      && printer.status === 'online'
      && printer.durableConfigured
      && printer.supportedMedia.includes(labelBatch.media)
      && (labelBatch.targetType === 'product'
        ? printer.supportsProductLabels
        : printer.supportsLocationLabels)
    ))
  )

  const generate = async () => {
    if (!workspace || !warehouseGlobalId || selected.length === 0) return
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/barcode-labels', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `barcode-label-generate-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          action: 'generate-batch',
          warehouseGlobalId,
          targetType,
          media,
          selections: selected.map((target) => ({ globalId: target.globalId, copies })),
        }),
      })
      const payload = await response.json() as ApiPayload
      if (!response.ok || !payload.batch) throw new Error(payload.error || 'Barcode labels could not be generated')
      setNotice(`${payload.batch.labelCount} ${targetType} labels generated. Preview or download them before explicitly queuing a printer.`)
      setSelected([])
      await load()
      window.open(
        `/api/operations/barcode-labels/${encodeURIComponent(payload.batch.globalId)}/preview`,
        '_blank',
        'noopener,noreferrer',
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Barcode labels could not be generated')
    } finally {
      setSubmitting(false)
    }
  }

  const updateLocationScanPolicy = async (locationScanRequired: boolean) => {
    if (!workspace || !selectedWarehouse) return
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/barcode-labels', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `wearable-location-scan-policy-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          action: 'update-location-scan-policy',
          warehouseGlobalId: selectedWarehouse.globalId,
          locationScanRequired,
          expectedRowVersion: selectedWarehouse.locationScanPolicy.rowVersion,
        }),
      })
      const payload = await response.json() as ApiPayload
      if (!response.ok || !payload.policy) {
        throw new Error(payload.error || 'Location scan policy could not be updated')
      }
      const updatedPolicy = payload.policy
      setWorkspace((current) => current === null ? null : ({
        ...current,
        warehouses: current.warehouses.map((warehouse) => (
          warehouse.globalId === updatedPolicy.warehouseGlobalId
            ? { ...warehouse, locationScanPolicy: updatedPolicy }
            : warehouse
        )),
      }))
      setNotice(locationScanRequired
        ? `${selectedWarehouse.name} pickers must now scan the exact location label before each product.`
        : `${selectedWarehouse.name} location-first verification is off. Product scans remain required.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Location scan policy could not be updated')
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  const enqueue = async (labelBatch: OperationsBarcodeLabelBatch) => {
    if (!workspace) return
    const warehouse = workspace.warehouses.find((candidate) => (
      candidate.globalId === labelBatch.warehouseGlobalId
    ))
    if (!warehouse) return
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/barcode-labels', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `barcode-label-print-${labelBatch.globalId}-v1`,
        },
        body: JSON.stringify({
          action: 'enqueue-batch',
          warehouseId: warehouse.id,
          sourceArtifactGlobalId: labelBatch.artifactGlobalId,
          preferredPrinterGlobalId: preferredPrinters[labelBatch.globalId] || null,
        }),
      })
      const payload = await response.json() as { ok?: boolean; error?: string; job?: { globalId: string } }
      if (!response.ok || !payload.job) throw new Error(payload.error || 'Barcode labels could not be queued')
      setNotice(`Print job ${payload.job.globalId} was queued. Local-agent acknowledgement is delivery evidence, not physical-output proof.`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Barcode labels could not be queued')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} fullWidth maxWidth="lg">
      <DialogTitle>
        <Stack direction="row" spacing={1.25} alignItems="center">
          <BarcodeRounded color="primary" />
          <Box>
            <Typography variant="h6">Product and location barcodes</Typography>
            <Typography variant="body2" color="text.secondary">
              Generate auditable label batches, verify them in a browser, then explicitly queue a configured printer.
            </Typography>
          </Box>
        </Stack>
      </DialogTitle>
      {loading && <LinearProgress />}
      <DialogContent dividers>
        <Stack spacing={2.5}>
          {error && <Alert severity="error">{error}</Alert>}
          {notice && <Alert severity="success">{notice}</Alert>}
          <Alert severity="info">
            Valid provider UPC, EAN, and GTIN values remain scan-authoritative. A product without one receives a stable ClawPilot Code 128 value. Location labels use a separate versioned payload so a scanner cannot confuse a bin with a product.
          </Alert>

          {selectedWarehouse && (
            <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
              <Stack spacing={0.75}>
                <FormControlLabel
                  control={(
                    <Switch
                      checked={selectedWarehouse.locationScanPolicy.locationScanRequired}
                      disabled={submitting || !workspace?.capabilities.canManage}
                      onChange={(_, checked) => void updateLocationScanPolicy(checked)}
                    />
                  )}
                  label="Require location label before product scan"
                />
                <Typography variant="body2" color="text.secondary">
                  Warehouse-specific and off by default. When enabled, ClawPilot requires the exact CP1L location label for each assigned pick before accepting its product barcode. This setting never confirms a pick from Apple Watch.
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {selectedWarehouse.name} · policy version {selectedWarehouse.locationScanPolicy.rowVersion}
                  {selectedWarehouse.locationScanPolicy.updatedBy
                    ? ` · last changed by ${selectedWarehouse.locationScanPolicy.updatedBy}`
                    : ' · explicit policy has not been changed'}
                </Typography>
              </Stack>
            </Box>
          )}

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <ToggleButtonGroup
              exclusive
              value={targetType}
              onChange={(_, value: TargetType | null) => value && setTargetType(value)}
              color="primary"
            >
              <ToggleButton value="product">Product labels</ToggleButton>
              <ToggleButton value="location">Location labels</ToggleButton>
            </ToggleButtonGroup>
            <TextField
              select
              label="Warehouse"
              value={warehouseGlobalId}
              onChange={(event) => setWarehouseGlobalId(event.target.value)}
              sx={{ minWidth: 260 }}
            >
              {(workspace?.warehouses || []).map((warehouse) => (
                <MenuItem key={warehouse.globalId} value={warehouse.globalId}>{warehouse.name}</MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Label size"
              value={media}
              onChange={(event) => setMedia(event.target.value as typeof media)}
              helperText={media === 'label_2x1' || media === 'label_3x1'
                ? 'Compact stock prints the primary linear barcode only.'
                : 'Prints the primary linear barcode plus a QR copy for phone and glasses cameras.'}
              sx={{ minWidth: 280 }}
            >
              <MenuItem value="label_2x1">2 × 1</MenuItem>
              <MenuItem value="label_3x1">3 × 1</MenuItem>
              <MenuItem value="label_4x2">4 × 2</MenuItem>
              <MenuItem value="label_4x6">4 × 6</MenuItem>
              <MenuItem value="label_4x8">4 × 8</MenuItem>
            </TextField>
            <TextField
              label="Copies each"
              type="number"
              value={copies}
              onChange={(event) => setCopies(Math.max(1, Math.min(100, Number(event.target.value) || 1)))}
              slotProps={{ htmlInput: { min: 1, max: 100 } }}
              sx={{ width: 130 }}
            />
          </Stack>

          <Autocomplete
            multiple
            options={options}
            value={selected}
            onChange={(_, value) => setSelected(value)}
            getOptionKey={(option) => option.globalId}
            getOptionLabel={(option) => (
              targetType === 'product'
                ? productLabel(option as OperationsBarcodeLabelProduct)
                : locationLabel(option as OperationsBarcodeLabelLocation)
            )}
            isOptionEqualToValue={(option, value) => option.globalId === value.globalId}
            renderInput={(params) => (
              <TextField
                {...params}
                label={targetType === 'product' ? 'Select products' : 'Select locations'}
                helperText={`${selected.length} selected · ${selected.length * copies} labels`}
              />
            )}
          />

          <Button
            variant="contained"
            size="large"
            startIcon={<VisibilityRounded />}
            disabled={submitting || !workspace?.capabilities.canManage || selected.length === 0 || selected.length * copies > 500}
            onClick={() => void generate()}
          >
            Generate and preview labels
          </Button>

          <Divider />
          <Box>
            <Typography variant="h6">Generated batches</Typography>
            <Typography variant="body2" color="text.secondary">
              Browser preview and ZPL download work without a local print agent. Printer delivery is always a separate operator action.
            </Typography>
          </Box>
          {(workspace?.batches || []).length === 0 && (
            <Typography color="text.secondary">No barcode label batches have been generated.</Typography>
          )}
          {(workspace?.batches || []).map((labelBatch) => {
            const compatiblePrinters = compatiblePrintersForBatch(labelBatch)
            return (
            <Box key={labelBatch.globalId} sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
              <Stack spacing={1.5}>
                <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" spacing={1}>
                  <Box>
                    <Typography fontWeight={700}>
                      {labelBatch.targetType === 'product' ? 'Product' : 'Location'} labels · {labelBatch.labelCount}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {labelBatch.globalId} · {labelBatch.warehouseName} · {labelBatch.media.replace('label_', '').replace('x', ' × ')} · {new Date(labelBatch.createdAt).toLocaleString()}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Chip size="small" label={labelBatch.printJobStatus || 'Not queued'} color={labelBatch.printJobStatus === 'delivered' ? 'success' : 'default'} />
                    <Button
                      size="small"
                      startIcon={<VisibilityRounded />}
                      href={`/api/operations/barcode-labels/${encodeURIComponent(labelBatch.globalId)}/preview`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >Preview</Button>
                    <Button
                      size="small"
                      startIcon={<DownloadRounded />}
                      href={`/api/operations/artifacts/${encodeURIComponent(labelBatch.artifactGlobalId)}`}
                    >Download ZPL</Button>
                  </Stack>
                </Stack>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
                  <TextField
                    select
                    size="small"
                    label="Printer (optional)"
                    value={preferredPrinters[labelBatch.globalId] || ''}
                    onChange={(event) => setPreferredPrinters((current) => ({
                      ...current,
                      [labelBatch.globalId]: event.target.value,
                    }))}
                    sx={{ minWidth: 240 }}
                  >
                    <MenuItem value="">Automatic route</MenuItem>
                    {compatiblePrinters.map((printer) => (
                      <MenuItem key={printer.globalId} value={printer.globalId}>{printer.name}</MenuItem>
                    ))}
                  </TextField>
                  <Button
                    variant="outlined"
                    startIcon={<PrintRounded />}
                    disabled={
                      submitting
                      || !workspace?.capabilities.canExecute
                      || compatiblePrinters.length === 0
                      || labelBatch.warehouseGlobalId !== warehouseGlobalId
                    }
                    onClick={() => void enqueue(labelBatch)}
                  >Queue printer delivery</Button>
                  {compatiblePrinters.length === 0 && labelBatch.warehouseGlobalId === warehouseGlobalId && (
                    <Typography variant="caption" color="text.secondary">
                      No online local-agent ZPL printer supports this label type. Use browser preview or download instead.
                    </Typography>
                  )}
                </Stack>
              </Stack>
            </Box>
            )
          })}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
