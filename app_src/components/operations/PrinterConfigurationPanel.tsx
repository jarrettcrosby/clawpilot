'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import PrintRounded from '@mui/icons-material/PrintRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import {
  PRINT_DOCUMENT_TYPES,
  PRINT_FORMATS,
  PRINT_MEDIA,
  PRINTER_CONNECTION_MODES,
  PRINTER_STATUSES,
  PRINTER_STATION_TYPES,
  PRINTER_TYPES,
  type OperationsPrinterInput,
  type OperationsPrinterProfile,
  type OperationsPrinterWorkspace,
  type PrintDocumentType,
  type PrintFormat,
  type PrintMedia,
  type PrinterConnectionMode,
  type PrinterStationType,
  type PrinterStatus,
  type PrinterType,
} from '@/lib/operations/printing'

type PrinterPayload = {
  ok?: boolean
  error?: string
  printers?: OperationsPrinterWorkspace
  printer?: OperationsPrinterProfile
}

type PrinterForm = OperationsPrinterInput

const fieldSx = {
  minWidth: 0,
  '& .MuiInputBase-root': {
    borderRadius: '8px',
    backgroundColor: '#15151D',
  },
}

const LABELS: Record<string, string> = {
  thermal: 'Thermal',
  office: 'Office',
  local_agent: 'Local print agent',
  browser: 'Browser download',
  system_service: 'System service',
  pack: 'Pack station',
  shipping: 'Shipping station',
  receiving: 'Receiving station',
  online: 'Online',
  offline: 'Offline',
  disabled: 'Disabled',
  label_4x6: '4 x 6 label',
  label_4x8: '4 x 8 label',
  letter: 'US Letter',
  a4: 'A4',
  shipping_label: 'Shipping label',
  packing_slip: 'Packing slip',
  pick_ticket: 'Pick ticket',
  carton_label: 'Carton label',
  pallet_label: 'Pallet label',
  bill_of_lading: 'Bill of lading',
  customs_document: 'Customs document',
  return_label: 'Return label',
  customer_insert: 'Customer insert',
}

function label(value: string) {
  return LABELS[value] || value.replace(/[_.-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function values(value: unknown) {
  return typeof value === 'string' ? value.split(',').filter(Boolean) : value as string[]
}

function defaultForm(warehouseId: string): PrinterForm {
  return {
    warehouseId,
    code: '',
    name: '',
    stationType: 'shipping',
    printerType: 'thermal',
    connectionMode: 'local_agent',
    supportedFormats: ['ZPL', 'PDF'],
    supportedMedia: ['label_4x6'],
    supportedDocumentTypes: ['shipping_label', 'return_label'],
    defaultDocumentTypes: [],
    fallbackPrinterGlobalId: null,
    priority: 100,
    status: 'offline',
  }
}

function editForm(printer: OperationsPrinterProfile): PrinterForm {
  return {
    globalId: printer.globalId,
    expectedRowVersion: printer.rowVersion,
    warehouseId: printer.warehouseId,
    code: printer.code,
    name: printer.name,
    stationType: printer.stationType,
    printerType: printer.printerType,
    connectionMode: printer.connectionMode,
    supportedFormats: printer.supportedFormats,
    supportedMedia: printer.supportedMedia,
    supportedDocumentTypes: printer.supportedDocumentTypes,
    defaultDocumentTypes: printer.defaultDocumentTypes,
    fallbackPrinterGlobalId: printer.fallbackPrinterGlobalId,
    priority: printer.priority,
    status: printer.status,
  }
}

async function payload(response: Response): Promise<PrinterPayload> {
  try {
    return await response.json() as PrinterPayload
  } catch {
    return { ok: false, error: `Printer configuration returned an invalid response (${response.status})` }
  }
}

function MultiSelect({
  label: fieldLabel,
  options,
  selected,
  onChange,
}: {
  label: string
  options: readonly string[]
  selected: string[]
  onChange: (value: string[]) => void
}) {
  return (
    <TextField
      select
      fullWidth
      size="small"
      label={fieldLabel}
      value={selected}
      onChange={(event) => onChange(values(event.target.value))}
      SelectProps={{
        multiple: true,
        renderValue: (items) => (items as string[]).map(label).join(', '),
      }}
      sx={fieldSx}
    >
      {options.map((option) => (
        <MenuItem key={option} value={option}>
          <Checkbox size="small" checked={selected.includes(option)} />
          <ListItemText primary={label(option)} />
        </MenuItem>
      ))}
    </TextField>
  )
}

export default function PrinterConfigurationPanel() {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('sm'))
  const [workspace, setWorkspace] = useState<OperationsPrinterWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState<PrinterForm | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/operations/printers', {
        cache: 'no-store',
        signal,
      })
      const result = await payload(response)
      if (!response.ok || !result.ok || !result.printers) {
        throw new Error(result.error || 'Printer configuration is unavailable')
      }
      setWorkspace(result.printers)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'Printer configuration is unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const fallbackOptions = useMemo(
    () => workspace?.printers.filter((printer) => (
      printer.warehouseId === form?.warehouseId
      && printer.globalId !== form?.globalId
      && printer.status !== 'disabled'
    )) || [],
    [form?.globalId, form?.warehouseId, workspace?.printers],
  )

  function update<K extends keyof PrinterForm>(key: K, value: PrinterForm[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current)
  }

  function choosePrinterType(printerType: PrinterType) {
    setForm((current) => {
      if (!current) return current
      if (printerType === 'office') {
        return {
          ...current,
          printerType,
          supportedFormats: ['PDF'],
          supportedMedia: ['letter', 'a4'],
          supportedDocumentTypes: ['packing_slip', 'pick_ticket', 'bill_of_lading', 'customs_document', 'customer_insert'],
          defaultDocumentTypes: [],
        }
      }
      return {
        ...current,
        printerType,
        supportedFormats: ['ZPL', 'PDF'],
        supportedMedia: ['label_4x6'],
        supportedDocumentTypes: ['shipping_label', 'return_label', 'carton_label'],
        defaultDocumentTypes: [],
      }
    })
  }

  function chooseSupportedDocuments(next: string[]) {
    const supported = next as PrintDocumentType[]
    setForm((current) => current ? {
      ...current,
      supportedDocumentTypes: supported,
      defaultDocumentTypes: current.defaultDocumentTypes.filter((item) => supported.includes(item)),
    } : current)
  }

  async function save() {
    if (!form) return
    if (!form.code.trim() || !form.name.trim()) {
      setError('Printer code and name are required')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/printers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save-printer',
          ...form,
          code: form.code.trim(),
          name: form.name.trim(),
        }),
      })
      const result = await payload(response)
      if (!response.ok || !result.ok || !result.printer) {
        throw new Error(result.error || 'Printer configuration could not be saved')
      }
      setForm(null)
      setNotice(`${result.printer.name} was saved`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Printer configuration could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, py: 2.5 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5}>
        <Box>
          <Typography variant="h6" fontWeight={700}>Printer routing</Typography>
          <Typography variant="body2" color="text.secondary">
            Match documents and media to warehouse printers without repurchasing carrier labels.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Tooltip title="Refresh printers">
            <span>
              <IconButton aria-label="Refresh printer configuration" disabled={loading} onClick={() => void load()}>
                <RefreshRounded />
              </IconButton>
            </span>
          </Tooltip>
          {workspace?.capabilities.canManage && (
            <Button
              variant="contained"
              startIcon={<AddRounded />}
              disabled={!workspace.warehouses[0]}
              onClick={() => setForm(defaultForm(workspace.warehouses[0]?.id || ''))}
            >
              Add printer
            </Button>
          )}
        </Stack>
      </Stack>

      <Alert severity="info" sx={{ mt: 2 }}>
        Configuration and routing are durable. Browser delivery is best effort; reliable printing requires an enrolled local agent and a printer acknowledgment before a job is marked printed.
      </Alert>
      {error && <Alert severity="error" onClose={() => setError('')} sx={{ mt: 1.5 }}>{error}</Alert>}
      {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mt: 1.5 }}>{notice}</Alert>}

      {loading && !workspace ? (
        <Box sx={{ py: 8, display: 'grid', placeItems: 'center' }}><CircularProgress size={30} /></Box>
      ) : workspace?.warehouses.length === 0 ? (
        <Alert severity="warning" sx={{ mt: 2 }}>Create an active warehouse before configuring printers.</Alert>
      ) : workspace?.printers.length === 0 ? (
        <Box sx={{ py: 8, textAlign: 'center' }}>
          <PrintRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
          <Typography fontWeight={700} sx={{ mt: 1 }}>No printer profiles</Typography>
          <Typography variant="body2" color="text.secondary">Add the thermal and office printers used by this organization.</Typography>
        </Box>
      ) : (
        <Stack divider={<Divider flexItem />} sx={{ mt: 2 }}>
          {workspace?.printers.map((printer) => (
            <Stack
              key={printer.globalId}
              direction={{ xs: 'column', md: 'row' }}
              justifyContent="space-between"
              gap={1.5}
              sx={{ py: 2 }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography fontWeight={700}>{printer.name}</Typography>
                  <Chip size="small" label={label(printer.printerType)} variant="outlined" />
                  <Chip
                    size="small"
                    label={label(printer.status)}
                    color={printer.status === 'online' ? 'success' : printer.status === 'offline' ? 'warning' : 'default'}
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {printer.warehouseName} · {label(printer.stationType)} · {label(printer.connectionMode)}
                </Typography>
                <Typography variant="caption" color="#A8C7FA">{printer.globalId} · {printer.code}</Typography>
                <Stack direction="row" gap={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                  {printer.defaultDocumentTypes.map((item) => (
                    <Chip key={item} size="small" label={`Default: ${label(item)}`} color="info" variant="outlined" />
                  ))}
                  {printer.supportedMedia.map((item) => <Chip key={item} size="small" label={label(item)} variant="outlined" />)}
                  {printer.supportedFormats.map((item) => <Chip key={item} size="small" label={item} variant="outlined" />)}
                </Stack>
                {printer.fallbackPrinterName && (
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
                    Fallback: {printer.fallbackPrinterName}
                  </Typography>
                )}
              </Box>
              {workspace?.capabilities.canManage && (
                <Tooltip title={`Edit ${printer.name}`}>
                  <IconButton
                    aria-label={`Edit ${printer.name}`}
                    onClick={() => setForm(editForm(printer))}
                    sx={{ alignSelf: { xs: 'flex-end', md: 'center' } }}
                  >
                    <EditRounded />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
          ))}
        </Stack>
      )}

      <Dialog
        open={Boolean(form)}
        onClose={() => !saving && setForm(null)}
        fullScreen={mobile}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>{form?.globalId ? 'Edit printer' : 'Add printer'}</DialogTitle>
        {form && (
          <DialogContent dividers>
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Warehouse"
                  value={form.warehouseId}
                  disabled={Boolean(form.globalId)}
                  onChange={(event) => {
                    update('warehouseId', event.target.value)
                    update('fallbackPrinterGlobalId', null)
                  }}
                  helperText={form.globalId ? 'Create a new profile to move a physical printer to another warehouse.' : ''}
                  sx={fieldSx}
                >
                  {workspace?.warehouses.map((warehouse) => (
                    <MenuItem key={warehouse.id} value={warehouse.id}>{warehouse.name}</MenuItem>
                  ))}
                </TextField>
                <TextField
                  fullWidth
                  size="small"
                  label="Printer code"
                  value={form.code}
                  onChange={(event) => update('code', event.target.value.toUpperCase())}
                  inputProps={{ maxLength: 40 }}
                  sx={fieldSx}
                />
              </Stack>
              <TextField
                fullWidth
                size="small"
                label="Printer name"
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                inputProps={{ maxLength: 120 }}
                sx={fieldSx}
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Printer type"
                  value={form.printerType}
                  onChange={(event) => choosePrinterType(event.target.value as PrinterType)}
                  sx={fieldSx}
                >
                  {PRINTER_TYPES.map((item) => <MenuItem key={item} value={item}>{label(item)}</MenuItem>)}
                </TextField>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Station"
                  value={form.stationType}
                  onChange={(event) => update('stationType', event.target.value as PrinterStationType)}
                  sx={fieldSx}
                >
                  {PRINTER_STATION_TYPES.map((item) => <MenuItem key={item} value={item}>{label(item)}</MenuItem>)}
                </TextField>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Connection"
                  value={form.connectionMode}
                  onChange={(event) => update('connectionMode', event.target.value as PrinterConnectionMode)}
                  sx={fieldSx}
                >
                  {PRINTER_CONNECTION_MODES.map((item) => <MenuItem key={item} value={item}>{label(item)}</MenuItem>)}
                </TextField>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <MultiSelect
                  label="Formats"
                  options={PRINT_FORMATS}
                  selected={form.supportedFormats}
                  onChange={(next) => update('supportedFormats', next as PrintFormat[])}
                />
                <MultiSelect
                  label="Media"
                  options={PRINT_MEDIA}
                  selected={form.supportedMedia}
                  onChange={(next) => update('supportedMedia', next as PrintMedia[])}
                />
              </Stack>
              <MultiSelect
                label="Supported documents"
                options={PRINT_DOCUMENT_TYPES}
                selected={form.supportedDocumentTypes}
                onChange={chooseSupportedDocuments}
              />
              <MultiSelect
                label="Default routes"
                options={form.supportedDocumentTypes}
                selected={form.defaultDocumentTypes}
                onChange={(next) => update('defaultDocumentTypes', next as PrintDocumentType[])}
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Fallback printer"
                  value={form.fallbackPrinterGlobalId || ''}
                  onChange={(event) => update('fallbackPrinterGlobalId', event.target.value || null)}
                  sx={fieldSx}
                >
                  <MenuItem value="">No fallback</MenuItem>
                  {fallbackOptions.map((printer) => (
                    <MenuItem key={printer.globalId} value={printer.globalId}>{printer.name}</MenuItem>
                  ))}
                </TextField>
                <TextField
                  fullWidth
                  size="small"
                  type="number"
                  label="Priority"
                  value={form.priority}
                  onChange={(event) => update('priority', Number(event.target.value))}
                  inputProps={{ min: 1, max: 999, step: 1 }}
                  sx={fieldSx}
                />
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Status"
                  value={form.status}
                  onChange={(event) => update('status', event.target.value as PrinterStatus)}
                  sx={fieldSx}
                >
                  {PRINTER_STATUSES.map((item) => <MenuItem key={item} value={item}>{label(item)}</MenuItem>)}
                </TextField>
              </Stack>
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setForm(null)} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving...' : 'Save printer'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
