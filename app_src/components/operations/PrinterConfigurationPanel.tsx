'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import CancelRounded from '@mui/icons-material/CancelRounded'
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import InfoOutlined from '@mui/icons-material/InfoOutlined'
import KeyRounded from '@mui/icons-material/KeyRounded'
import PrintRounded from '@mui/icons-material/PrintRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import RestartAltRounded from '@mui/icons-material/RestartAltRounded'
import TokenRounded from '@mui/icons-material/TokenRounded'
import {
  PRINT_DOCUMENT_TYPES,
  PRINT_FORMATS,
  PRINTER_CONNECTION_MODES,
  PRINTER_STATUSES,
  PRINTER_STATION_TYPES,
  PRINTER_TYPES,
  type OperationsPrintAgentProfile,
  type OperationsPrintAgentWorkspace,
  type OperationsPrintJobListItem,
  type OperationsPrintJobWorkspace,
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

type PrintAgentPayload = {
  ok?: boolean
  error?: string
  agents?: OperationsPrintAgentWorkspace
  agent?: OperationsPrintAgentProfile
  credential?: string | null
}

type PrintJobPayload = {
  ok?: boolean
  error?: string
  jobs?: OperationsPrintJobWorkspace
  job?: OperationsPrintJobListItem
}

type PrinterForm = OperationsPrinterInput
type View = 'jobs' | 'printers' | 'agents'

const fieldSx = {
  minWidth: 0,
  '& .MuiInputBase-root': {
    borderRadius: '8px',
    backgroundColor: '#15151D',
  },
}

const LABELS: Record<string, string> = {
  thermal: 'Thermal',
  nonthermal: 'Nonthermal',
  local_agent: 'Local print agent',
  browser: 'Browser download',
  system_service: 'System service',
  pack: 'Pack station',
  shipping: 'Shipping station',
  receiving: 'Receiving station',
  office: 'Office',
  online: 'Online',
  offline: 'Offline',
  disabled: 'Disabled',
  active: 'Active',
  revoked: 'Revoked',
  queued: 'Queued',
  claimed: 'Claimed',
  delivered: 'Acknowledged',
  failed: 'Failed',
  cancelled: 'Cancelled',
  printed: 'Legacy printed',
  rerouted: 'Legacy rerouted',
  label_4x6: '4 x 6 label',
  label_4x8: '4 x 8 label',
  letter: 'US Letter',
  a4: 'A4',
  shipping_label: 'Carrier label',
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
  return LABELS[value]
    || value.replace(/[_.-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function values(value: unknown) {
  return typeof value === 'string' ? value.split(',').filter(Boolean) : value as string[]
}

function timestamp(value: string | null) {
  if (!value) return 'Never'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleString()
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'Not available'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function packageSize(job: OperationsPrintJobListItem) {
  if (
    job.packageLengthMm === null
    || job.packageWidthMm === null
    || job.packageHeightMm === null
  ) return 'Not available'
  const inches = [job.packageLengthMm, job.packageWidthMm, job.packageHeightMm]
    .map((value) => (value / 25.4).toFixed(1))
    .join(' x ')
  return `${inches} in (${job.packageLengthMm} x ${job.packageWidthMm} x ${job.packageHeightMm} mm)`
}

function packageWeight(job: OperationsPrintJobListItem) {
  if (job.packageWeightGrams === null) return 'Not available'
  return `${(job.packageWeightGrams / 453.59237).toFixed(2)} lb (${job.packageWeightGrams} g)`
}

function destination(job: OperationsPrintJobListItem) {
  const locality = [
    job.shipToCity,
    job.shipToRegion,
    job.shipToPostalCode,
    job.shipToCountry,
  ].filter(Boolean).join(', ')
  return [job.shipToName, locality].filter(Boolean).join(' · ') || 'Not available'
}

function namedGlobalId(name: string | null, globalId: string | null) {
  return [name, globalId].filter(Boolean).join(' · ') || 'Not available'
}

function DetailField({ term, value }: { term: string; value: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        component="dt"
        variant="caption"
        color="text.secondary"
        sx={{ textTransform: 'uppercase' }}
      >
        {term}
      </Typography>
      <Typography
        component="dd"
        variant="body2"
        sx={{ m: 0, mt: 0.25, overflowWrap: 'anywhere' }}
      >
        {value || 'Not available'}
      </Typography>
    </Box>
  )
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
    localPrintAgentGlobalId: null,
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
    localPrintAgentGlobalId: printer.localPrintAgentGlobalId,
    priority: printer.priority,
    status: printer.status,
  }
}

async function responsePayload<T>(response: Response): Promise<T & { ok?: boolean; error?: string }> {
  try {
    return await response.json() as T & { ok?: boolean; error?: string }
  } catch {
    return {
      ok: false,
      error: `Printing API returned an invalid response (${response.status})`,
    } as T & { ok?: boolean; error?: string }
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

function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (status === 'online' || status === 'active' || status === 'delivered' || status === 'printed') {
    return 'success'
  }
  if (status === 'failed' || status === 'revoked' || status === 'cancelled') return 'error'
  if (status === 'offline' || status === 'claimed') return 'warning'
  if (status === 'queued') return 'info'
  return 'default'
}

export default function PrinterConfigurationPanel() {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('sm'))
  const [view, setView] = useState<View>('jobs')
  const [printers, setPrinters] = useState<OperationsPrinterWorkspace | null>(null)
  const [agents, setAgents] = useState<OperationsPrintAgentWorkspace | null>(null)
  const [jobs, setJobs] = useState<OperationsPrintJobWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedJob, setSelectedJob] = useState<OperationsPrintJobListItem | null>(null)
  const [printerForm, setPrinterForm] = useState<PrinterForm | null>(null)
  const [enrollForm, setEnrollForm] = useState<{ warehouseId: string; name: string } | null>(null)
  const [agentAction, setAgentAction] = useState<{
    agent: OperationsPrintAgentProfile
    action: 'rotate-credential' | 'revoke-agent'
  } | null>(null)
  const [jobAction, setJobAction] = useState<{
    job: OperationsPrintJobListItem
    action: 'retry-job' | 'reprint-job' | 'cancel-job'
    reason: string
  } | null>(null)
  const [credential, setCredential] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const [printerResponse, agentResponse, jobResponse] = await Promise.all([
        fetch('/api/operations/printers', { cache: 'no-store', signal }),
        fetch('/api/operations/print-agents', { cache: 'no-store', signal }),
        fetch('/api/operations/print-jobs', { cache: 'no-store', signal }),
      ])
      const [printerResult, agentResult, jobResult] = await Promise.all([
        responsePayload<PrinterPayload>(printerResponse),
        responsePayload<PrintAgentPayload>(agentResponse),
        responsePayload<PrintJobPayload>(jobResponse),
      ])
      if (!printerResponse.ok || !printerResult.ok || !printerResult.printers) {
        throw new Error(printerResult.error || 'Printer configuration is unavailable')
      }
      if (!agentResponse.ok || !agentResult.ok || !agentResult.agents) {
        throw new Error(agentResult.error || 'Local print agents are unavailable')
      }
      if (!jobResponse.ok || !jobResult.ok || !jobResult.jobs) {
        throw new Error(jobResult.error || 'Print jobs are unavailable')
      }
      setPrinters(printerResult.printers)
      setAgents(agentResult.agents)
      setJobs(jobResult.jobs)
      setSelectedJob((current) => (
        current
          ? jobResult.jobs?.jobs.find((job) => job.globalId === current.globalId) || null
          : null
      ))
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'Printing operations are unavailable')
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
    () => printers?.printers.filter((printer) => (
      printer.warehouseId === printerForm?.warehouseId
      && printer.globalId !== printerForm?.globalId
      && printer.status !== 'disabled'
      && printerForm?.supportedFormats.every((item) => printer.supportedFormats.includes(item))
      && printerForm.supportedMedia.every((item) => printer.supportedMedia.includes(item))
      && printerForm.supportedDocumentTypes.every((item) => (
        printer.supportedDocumentTypes.includes(item)
      ))
    )) || [],
    [printerForm, printers?.printers],
  )

  const agentOptions = useMemo(
    () => agents?.agents.filter((agent) => (
      agent.warehouseId === printerForm?.warehouseId && agent.status === 'active'
    )) || [],
    [agents?.agents, printerForm?.warehouseId],
  )

  function updatePrinter<K extends keyof PrinterForm>(key: K, value: PrinterForm[K]) {
    setPrinterForm((current) => current ? { ...current, [key]: value } : current)
  }

  function choosePrinterType(printerType: PrinterType) {
    setPrinterForm((current) => {
      if (!current) return current
      if (printerType === 'nonthermal') {
        return {
          ...current,
          printerType,
          stationType: 'office',
          supportedFormats: ['PDF', 'PNG'],
          supportedMedia: ['letter', 'a4'],
          supportedDocumentTypes: [
            'packing_slip',
            'pick_ticket',
            'bill_of_lading',
            'customs_document',
            'customer_insert',
          ],
          defaultDocumentTypes: [],
          fallbackPrinterGlobalId: null,
        }
      }
      return {
        ...current,
        printerType,
        stationType: current.stationType === 'office' ? 'shipping' : current.stationType,
        supportedFormats: ['ZPL', 'PDF'],
        supportedMedia: ['label_4x6', 'label_4x8'],
        supportedDocumentTypes: ['shipping_label', 'return_label', 'carton_label'],
        defaultDocumentTypes: [],
        fallbackPrinterGlobalId: null,
      }
    })
  }

  function chooseConnection(connectionMode: PrinterConnectionMode) {
    setPrinterForm((current) => current ? {
      ...current,
      connectionMode,
      localPrintAgentGlobalId: connectionMode === 'local_agent'
        ? current.localPrintAgentGlobalId
        : null,
      status: connectionMode === 'local_agent' && !current.localPrintAgentGlobalId
        ? 'offline'
        : current.status,
    } : current)
  }

  function chooseSupportedDocuments(next: string[]) {
    const supported = next as PrintDocumentType[]
    setPrinterForm((current) => current ? {
      ...current,
      supportedDocumentTypes: supported,
      defaultDocumentTypes: current.defaultDocumentTypes.filter((item) => (
        supported.includes(item)
      )),
      fallbackPrinterGlobalId: null,
    } : current)
  }

  async function savePrinter() {
    if (!printerForm) return
    if (!printerForm.code.trim() || !printerForm.name.trim()) {
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
          ...printerForm,
          code: printerForm.code.trim(),
          name: printerForm.name.trim(),
        }),
      })
      const result = await responsePayload<PrinterPayload>(response)
      if (!response.ok || !result.ok || !result.printer) {
        throw new Error(result.error || 'Printer configuration could not be saved')
      }
      setPrinterForm(null)
      setNotice(`${result.printer.name} was saved`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Printer configuration could not be saved')
    } finally {
      setSaving(false)
    }
  }

  async function enrollAgent() {
    if (!enrollForm) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/print-agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ action: 'enroll-agent', ...enrollForm }),
      })
      const result = await responsePayload<PrintAgentPayload>(response)
      if (!response.ok || !result.ok || !result.agent) {
        throw new Error(result.error || 'Local print agent could not be enrolled')
      }
      setEnrollForm(null)
      if (result.credential) setCredential(result.credential)
      setNotice(result.credential
        ? `${result.agent.name} was enrolled`
        : 'Agent already enrolled; rotate its credential to issue a new one')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Local print agent could not be enrolled')
    } finally {
      setSaving(false)
    }
  }

  async function runAgentAction() {
    if (!agentAction) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/print-agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(agentAction.action === 'rotate-credential'
            ? { 'Idempotency-Key': crypto.randomUUID() }
            : {}),
        },
        body: JSON.stringify({
          action: agentAction.action,
          printAgentGlobalId: agentAction.agent.globalId,
        }),
      })
      const result = await responsePayload<PrintAgentPayload>(response)
      if (!response.ok || !result.ok || !result.agent) {
        throw new Error(result.error || 'Local print-agent action failed')
      }
      setAgentAction(null)
      if (result.credential) setCredential(result.credential)
      setNotice(agentAction.action === 'rotate-credential'
        ? result.credential
          ? `${result.agent.name} credential was rotated`
          : 'Credential was already issued; rotate again with a new request to replace it'
        : `${result.agent.name} was revoked and its printers were set offline`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Local print-agent action failed')
    } finally {
      setSaving(false)
    }
  }

  async function runJobAction() {
    if (!jobAction) return
    if (!jobAction.reason.trim()) {
      const actionName = jobAction.action === 'reprint-job'
        ? 'Reprint'
        : jobAction.action === 'cancel-job'
          ? 'Cancellation'
          : 'Retry'
      setError(`${actionName} reason is required`)
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/print-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          action: jobAction.action,
          jobGlobalId: jobAction.job.globalId,
          reason: jobAction.reason.trim(),
        }),
      })
      const result = await responsePayload<PrintJobPayload>(response)
      if (!response.ok || !result.ok || !result.job) {
        throw new Error(result.error || 'Print-job action failed')
      }
      setJobAction(null)
      setNotice(
        jobAction.action === 'reprint-job'
          ? `Reprint ${result.job.globalId} was queued`
          : jobAction.action === 'cancel-job'
            ? `${result.job.globalId} was cancelled`
            : `${result.job.globalId} was queued for retry`,
      )
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Print-job action failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, py: 2.5 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5}>
        <Box>
          <Typography variant="h6" fontWeight={700}>Printing operations</Typography>
          <Typography variant="body2" color="text.secondary">
            Route durable documents, supervise local agents, and audit every delivery attempt.
          </Typography>
        </Box>
        <Tooltip title="Refresh printing operations">
          <span>
            <IconButton
              aria-label="Refresh printing operations"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshRounded />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Alert severity="info" sx={{ mt: 2 }}>
        Acknowledged means the local agent handed the document to its configured device. It does not prove physical output, and retries or reprints never purchase another carrier label.
      </Alert>
      {error && <Alert severity="error" onClose={() => setError('')} sx={{ mt: 1.5 }}>{error}</Alert>}
      {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mt: 1.5 }}>{notice}</Alert>}

      <Tabs
        value={view}
        onChange={(_event, next: View) => setView(next)}
        variant={mobile ? 'fullWidth' : 'standard'}
        sx={{ mt: 1.5, borderBottom: '1px solid rgba(255,255,255,0.1)' }}
      >
        <Tab value="jobs" label={`Jobs${jobs ? ` (${jobs.jobs.length})` : ''}`} />
        <Tab value="printers" label={`Printers${printers ? ` (${printers.printers.length})` : ''}`} />
        <Tab value="agents" label={`Agents${agents ? ` (${agents.agents.length})` : ''}`} />
      </Tabs>

      {loading && !printers ? (
        <Box sx={{ py: 8, display: 'grid', placeItems: 'center' }}><CircularProgress size={30} /></Box>
      ) : view === 'jobs' ? (
        <Box sx={{ pt: 2 }}>
          {!jobs?.jobs.length ? (
            <Box sx={{ py: 7, textAlign: 'center' }}>
              <PrintRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
              <Typography fontWeight={700} sx={{ mt: 1 }}>No print jobs</Typography>
              <Typography variant="body2" color="text.secondary">
                Carrier-label and packing-slip jobs will appear here when their source workflow queues them.
              </Typography>
            </Box>
          ) : (
            <Stack divider={<Divider flexItem />}>
              {jobs.jobs.map((job) => (
                <Stack
                  key={job.globalId}
                  direction={{ xs: 'column', md: 'row' }}
                  justifyContent="space-between"
                  gap={1.5}
                  sx={{ py: 2 }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography fontWeight={700}>{job.globalId}</Typography>
                      <Chip size="small" label={label(job.status)} color={statusColor(job.status)} />
                      {job.documentType && <Chip size="small" label={label(job.documentType)} variant="outlined" />}
                      {job.media && <Chip size="small" label={label(job.media)} variant="outlined" />}
                      {job.format && <Chip size="small" label={job.format} variant="outlined" />}
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.6 }}>
                      {job.printerName} · Attempt {job.attempts} of {job.maxAttempts} · {timestamp(job.createdAt)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.35 }}>
                      {job.routingReason}
                    </Typography>
                    {job.lastError && (
                      <Typography variant="caption" color="error.light" display="block" sx={{ mt: 0.35 }}>
                        {job.lastError}
                      </Typography>
                    )}
                    {job.reprintOfJobGlobalId && (
                      <Typography variant="caption" color="#A8C7FA" display="block" sx={{ mt: 0.35 }}>
                        Reprint of {job.reprintOfJobGlobalId}: {job.reprintReason}
                      </Typography>
                    )}
                    {job.status === 'claimed' && (
                      <Typography variant="caption" color="warning.light" display="block" sx={{ mt: 0.35 }}>
                        Lease expires {timestamp(job.claimExpiresAt)}
                      </Typography>
                    )}
                  </Box>
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end">
                    <Button
                      size="small"
                      variant="text"
                      startIcon={<InfoOutlined />}
                      onClick={() => setSelectedJob(job)}
                    >
                      Details
                    </Button>
                    {job.status === 'failed' && jobs.capabilities.canExecute && job.attempts < job.maxAttempts && (
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<RestartAltRounded />}
                        onClick={() => setJobAction({ job, action: 'retry-job', reason: '' })}
                      >
                        Retry
                      </Button>
                    )}
                    {job.status === 'delivered' && jobs.capabilities.canReprint && (
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<ReplayRounded />}
                        onClick={() => setJobAction({ job, action: 'reprint-job', reason: '' })}
                      >
                        Reprint
                      </Button>
                    )}
                    {(job.status === 'queued' || job.status === 'claimed')
                      && (jobs.capabilities.canExecute || jobs.capabilities.canManage) && (
                      <Button
                        size="small"
                        variant="outlined"
                        color="error"
                        startIcon={<CancelRounded />}
                        onClick={() => setJobAction({ job, action: 'cancel-job', reason: '' })}
                      >
                        Cancel
                      </Button>
                    )}
                  </Stack>
                </Stack>
              ))}
            </Stack>
          )}
        </Box>
      ) : view === 'printers' ? (
        <Box sx={{ pt: 2 }}>
          <Stack direction="row" justifyContent="flex-end">
            {printers?.capabilities.canManage && (
              <Button
                variant="contained"
                startIcon={<AddRounded />}
                disabled={!printers.warehouses[0]}
                onClick={() => setPrinterForm(defaultForm(printers.warehouses[0]?.id || ''))}
              >
                Add printer
              </Button>
            )}
          </Stack>
          {!printers?.warehouses.length ? (
            <Alert severity="warning" sx={{ mt: 2 }}>Create an active warehouse before configuring printers.</Alert>
          ) : !printers.printers.length ? (
            <Box sx={{ py: 7, textAlign: 'center' }}>
              <PrintRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
              <Typography fontWeight={700} sx={{ mt: 1 }}>No printer profiles</Typography>
            </Box>
          ) : (
            <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
              {printers.printers.map((printer) => (
                <Stack
                  key={printer.globalId}
                  direction={{ xs: 'column', md: 'row' }}
                  justifyContent="space-between"
                  gap={1.5}
                  sx={{ py: 2 }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography fontWeight={700}>{printer.name}</Typography>
                      <Chip size="small" label={label(printer.printerType)} variant="outlined" />
                      <Chip size="small" label={label(printer.status)} color={statusColor(printer.status)} />
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {printer.warehouseName} · {label(printer.stationType)} · {label(printer.connectionMode)}
                    </Typography>
                    <Typography variant="caption" color="#A8C7FA">
                      {printer.globalId} · {printer.code}
                    </Typography>
                    <Stack direction="row" gap={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                      {printer.defaultDocumentTypes.map((item) => (
                        <Chip key={item} size="small" label={`Default: ${label(item)}`} color="info" variant="outlined" />
                      ))}
                      {printer.supportedMedia.map((item) => (
                        <Chip key={item} size="small" label={label(item)} variant="outlined" />
                      ))}
                      {printer.supportedFormats.map((item) => (
                        <Chip key={item} size="small" label={item} variant="outlined" />
                      ))}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
                      Agent: {printer.localPrintAgentName || 'Not assigned'} · Agent heartbeat: {timestamp(printer.localPrintAgentLastSeenAt)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      Last device delivery: {timestamp(printer.lastSeenAt)}
                    </Typography>
                    {printer.fallbackPrinterName && (
                      <Typography variant="caption" color="text.secondary" display="block">
                        Approved fallback: {printer.fallbackPrinterName}
                      </Typography>
                    )}
                  </Box>
                  {printers.capabilities.canManage && (
                    <Tooltip title={`Edit ${printer.name}`}>
                      <IconButton
                        aria-label={`Edit ${printer.name}`}
                        onClick={() => setPrinterForm(editForm(printer))}
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
        </Box>
      ) : (
        <Box sx={{ pt: 2 }}>
          <Stack direction="row" justifyContent="flex-end">
            {agents?.capabilities.canManage && (
              <Button
                variant="contained"
                startIcon={<TokenRounded />}
                disabled={!printers?.warehouses[0]}
                onClick={() => setEnrollForm({
                  warehouseId: printers?.warehouses[0]?.id || '',
                  name: '',
                })}
              >
                Enroll agent
              </Button>
            )}
          </Stack>
          {!agents?.agents.length ? (
            <Box sx={{ py: 7, textAlign: 'center' }}>
              <TokenRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
              <Typography fontWeight={700} sx={{ mt: 1 }}>No local print agents</Typography>
            </Box>
          ) : (
            <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
              {agents.agents.map((agent) => (
                <Stack
                  key={agent.globalId}
                  direction={{ xs: 'column', md: 'row' }}
                  justifyContent="space-between"
                  gap={1.5}
                  sx={{ py: 2 }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography fontWeight={700}>{agent.name}</Typography>
                      <Chip size="small" label={label(agent.status)} color={statusColor(agent.status)} />
                      <Chip size="small" label={`Credential v${agent.credentialVersion}`} variant="outlined" />
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {agent.warehouseName} · Last seen {timestamp(agent.lastSeenAt)}
                    </Typography>
                    <Typography variant="caption" color="#A8C7FA">{agent.globalId}</Typography>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                      Printers: {agent.assignedPrinters.map((printer) => printer.name).join(', ') || 'None'}
                    </Typography>
                  </Box>
                  {agents.capabilities.canManage && agent.status === 'active' && (
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      <Tooltip title={`Rotate ${agent.name} credential`}>
                        <IconButton
                          aria-label={`Rotate ${agent.name} credential`}
                          onClick={() => setAgentAction({ agent, action: 'rotate-credential' })}
                        >
                          <KeyRounded />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={`Revoke ${agent.name}`}>
                        <IconButton
                          aria-label={`Revoke ${agent.name}`}
                          color="error"
                          onClick={() => setAgentAction({ agent, action: 'revoke-agent' })}
                        >
                          <RestartAltRounded />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  )}
                </Stack>
              ))}
            </Stack>
          )}
        </Box>
      )}

      <Dialog
        open={Boolean(selectedJob)}
        onClose={() => setSelectedJob(null)}
        fullScreen={mobile}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            gap={1}
          >
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h6" fontWeight={700}>Print job details</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {selectedJob?.globalId}
              </Typography>
            </Box>
            {selectedJob && (
              <Chip
                size="small"
                label={label(selectedJob.status)}
                color={statusColor(selectedJob.status)}
              />
            )}
          </Stack>
        </DialogTitle>
        {selectedJob && (
          <DialogContent dividers>
            <Stack spacing={3}>
              <Box component="section">
                <Typography fontWeight={700}>Document and source</Typography>
                <Box
                  component="dl"
                  sx={{
                    m: 0,
                    mt: 1.25,
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    gap: 2,
                  }}
                >
                  <DetailField term="Document" value={selectedJob.documentType ? label(selectedJob.documentType) : null} />
                  <DetailField
                    term="Output"
                    value={[
                      selectedJob.media ? label(selectedJob.media) : null,
                      selectedJob.format,
                    ].filter(Boolean).join(' · ')}
                  />
                  <DetailField
                    term="Order"
                    value={selectedJob.sourceOrderNumber
                      ? `${selectedJob.sourceOrderNumber} · ${selectedJob.sourceOrderGlobalId || 'No Global ID'}`
                      : selectedJob.sourceOrderGlobalId}
                  />
                  <DetailField term="Shipment Global ID" value={selectedJob.sourceShipmentGlobalId} />
                  <DetailField
                    term="Carrier label"
                    value={selectedJob.sourceLabelGlobalId
                      ? `${selectedJob.sourceLabelGlobalId} · ${label(selectedJob.sourceLabelStatus || 'unknown')}`
                      : null}
                  />
                  <DetailField
                    term="Carrier service"
                    value={[
                      selectedJob.carrier?.toUpperCase(),
                      selectedJob.carrierServiceCode,
                      selectedJob.carrierEnvironment
                        ? label(selectedJob.carrierEnvironment)
                        : null,
                    ].filter(Boolean).join(' · ')}
                  />
                  <DetailField term="Tracking number" value={selectedJob.trackingNumber} />
                  <DetailField term="Label created" value={timestamp(selectedJob.labelCreatedAt)} />
                  {selectedJob.labelVoidedAt && (
                    <>
                      <DetailField term="Label voided" value={timestamp(selectedJob.labelVoidedAt)} />
                      <DetailField term="Voided by" value={selectedJob.labelVoidedBy} />
                    </>
                  )}
                </Box>
              </Box>

              <Divider />

              <Box component="section">
                <Typography fontWeight={700}>Destination and package</Typography>
                <Box
                  component="dl"
                  sx={{
                    m: 0,
                    mt: 1.25,
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    gap: 2,
                  }}
                >
                  <DetailField term="Ship to" value={destination(selectedJob)} />
                  <DetailField
                    term="Package"
                    value={selectedJob.packageGlobalId
                      ? `Package ${selectedJob.packageNumber || '—'} · ${selectedJob.packageGlobalId}`
                      : null}
                  />
                  <DetailField term="Package dimensions" value={packageSize(selectedJob)} />
                  <DetailField term="Package weight" value={packageWeight(selectedJob)} />
                </Box>
              </Box>

              <Divider />

              <Box component="section">
                <Typography fontWeight={700}>Routing and device</Typography>
                <Box
                  component="dl"
                  sx={{
                    m: 0,
                    mt: 1.25,
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    gap: 2,
                  }}
                >
                  <DetailField
                    term="Warehouse"
                    value={namedGlobalId(
                      selectedJob.warehouseName,
                      selectedJob.warehouseGlobalId,
                    )}
                  />
                  <DetailField term="Station" value={label(selectedJob.stationType)} />
                  <DetailField
                    term="Delivered printer"
                    value={namedGlobalId(
                      selectedJob.printerName,
                      selectedJob.printerGlobalId,
                    )}
                  />
                  <DetailField
                    term="Requested printer"
                    value={namedGlobalId(
                      selectedJob.requestedPrinterName,
                      selectedJob.requestedPrinterGlobalId,
                    )}
                  />
                  <DetailField
                    term="Fallback printer"
                    value={namedGlobalId(
                      selectedJob.fallbackPrinterName,
                      selectedJob.fallbackPrinterGlobalId,
                    )}
                  />
                  <DetailField
                    term="Local print agent"
                    value={namedGlobalId(
                      selectedJob.printAgentName,
                      selectedJob.printAgentGlobalId,
                    )}
                  />
                  <DetailField term="Routing explanation" value={selectedJob.routingReason} />
                  <DetailField term="Enqueued by" value={selectedJob.enqueuedBy} />
                </Box>
              </Box>

              <Divider />

              <Box component="section">
                <Typography fontWeight={700}>Document integrity</Typography>
                <Box
                  component="dl"
                  sx={{
                    m: 0,
                    mt: 1.25,
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    gap: 2,
                  }}
                >
                  <DetailField term="Artifact Global ID" value={selectedJob.artifactGlobalId} />
                  <DetailField term="Payload size" value={formatBytes(selectedJob.artifactByteLength)} />
                  <DetailField term="SHA-256" value={selectedJob.artifactContentSha256} />
                  <DetailField term="Artifact created by" value={selectedJob.artifactCreatedBy} />
                  <DetailField term="Artifact created" value={timestamp(selectedJob.artifactCreatedAt)} />
                </Box>
              </Box>

              <Divider />

              <Box component="section">
                <Typography fontWeight={700}>Lifecycle and lineage</Typography>
                <Box
                  component="dl"
                  sx={{
                    m: 0,
                    mt: 1.25,
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    gap: 2,
                  }}
                >
                  <DetailField term="Attempts" value={`${selectedJob.attempts} of ${selectedJob.maxAttempts}`} />
                  <DetailField term="Available at" value={timestamp(selectedJob.availableAt)} />
                  <DetailField term="Claim lease expires" value={timestamp(selectedJob.claimExpiresAt)} />
                  <DetailField term="Delivered at" value={timestamp(selectedJob.deliveredAt)} />
                  <DetailField term="Created" value={timestamp(selectedJob.createdAt)} />
                  <DetailField term="Last updated" value={timestamp(selectedJob.updatedAt)} />
                  <DetailField term="Last error" value={selectedJob.lastError} />
                  <DetailField
                    term="Reprint lineage"
                    value={selectedJob.reprintOfJobGlobalId
                      ? `${selectedJob.reprintOfJobGlobalId} · ${selectedJob.reprintReason || 'No reason recorded'}`
                      : 'Original print job'}
                  />
                </Box>
              </Box>

              <Divider />

              <Box component="section">
                <Typography fontWeight={700}>Delivery history</Typography>
                {!selectedJob.attemptHistory.length ? (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    No delivery events have been recorded.
                  </Typography>
                ) : (
                  <Stack divider={<Divider flexItem />} sx={{ mt: 0.75 }}>
                    {selectedJob.attemptHistory.map((attempt) => (
                      <Box key={`${attempt.sequenceNumber}-${attempt.occurredAt}`} sx={{ py: 1.5 }}>
                        <Stack
                          direction={{ xs: 'column', sm: 'row' }}
                          alignItems={{ xs: 'flex-start', sm: 'center' }}
                          gap={0.75}
                        >
                          <Chip
                            size="small"
                            label={label(attempt.state)}
                            color={statusColor(attempt.state)}
                          />
                          <Typography variant="body2" fontWeight={700}>
                            Attempt {attempt.attemptNumber} · Event {attempt.sequenceNumber}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {timestamp(attempt.occurredAt)}
                          </Typography>
                        </Stack>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                          {attempt.printerName || 'No printer recorded'}
                          {attempt.printAgentGlobalId ? ` · Agent ${attempt.printAgentGlobalId}` : ''}
                          {attempt.actorEmail
                            ? ` · ${attempt.actorEmail}`
                            : attempt.actorType ? ` · ${label(attempt.actorType)}` : ''}
                        </Typography>
                        {attempt.deviceJobReference && (
                          <Typography variant="caption" color="text.secondary" display="block">
                            Device job: {attempt.deviceJobReference}
                          </Typography>
                        )}
                        {attempt.deliveryEvidence && (
                          <Typography variant="caption" color="text.secondary" display="block">
                            Delivery evidence: {attempt.deliveryEvidence}
                          </Typography>
                        )}
                        <Typography
                          variant="caption"
                          color={attempt.physicalOutputVerified ? 'success.light' : 'text.secondary'}
                          display="block"
                        >
                          Physical output: {attempt.physicalOutputVerified ? 'Verified' : 'Not verified'}
                        </Typography>
                        {(attempt.errorCode || attempt.errorMessage) && (
                          <Typography variant="caption" color="error.light" display="block" sx={{ mt: 0.5 }}>
                            {[attempt.errorCode, attempt.errorMessage].filter(Boolean).join(' · ')}
                          </Typography>
                        )}
                        {attempt.detail && (
                          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                            {attempt.detail}
                          </Typography>
                        )}
                      </Box>
                    ))}
                  </Stack>
                )}
              </Box>
            </Stack>
          </DialogContent>
        )}
        <DialogActions sx={{ flexWrap: 'wrap' }}>
          {selectedJob?.status === 'failed'
            && jobs?.capabilities.canExecute
            && selectedJob.attempts < selectedJob.maxAttempts && (
            <Button
              startIcon={<RestartAltRounded />}
              onClick={() => {
                setSelectedJob(null)
                setJobAction({ job: selectedJob, action: 'retry-job', reason: '' })
              }}
            >
              Retry
            </Button>
          )}
          {selectedJob?.status === 'delivered' && jobs?.capabilities.canReprint && (
            <Button
              startIcon={<ReplayRounded />}
              onClick={() => {
                setSelectedJob(null)
                setJobAction({ job: selectedJob, action: 'reprint-job', reason: '' })
              }}
            >
              Reprint
            </Button>
          )}
          {selectedJob
            && (selectedJob.status === 'queued' || selectedJob.status === 'claimed')
            && (jobs?.capabilities.canExecute || jobs?.capabilities.canManage) && (
            <Button
              color="error"
              startIcon={<CancelRounded />}
              onClick={() => {
                setSelectedJob(null)
                setJobAction({ job: selectedJob, action: 'cancel-job', reason: '' })
              }}
            >
              Cancel job
            </Button>
          )}
          <Button variant="contained" onClick={() => setSelectedJob(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(printerForm)}
        onClose={() => !saving && setPrinterForm(null)}
        fullScreen={mobile}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>{printerForm?.globalId ? 'Edit printer' : 'Add printer'}</DialogTitle>
        {printerForm && (
          <DialogContent dividers>
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Warehouse"
                  value={printerForm.warehouseId}
                  disabled={Boolean(printerForm.globalId)}
                  onChange={(event) => setPrinterForm((current) => current ? {
                    ...current,
                    warehouseId: event.target.value,
                    fallbackPrinterGlobalId: null,
                    localPrintAgentGlobalId: null,
                    status: 'offline',
                  } : current)}
                  helperText={printerForm.globalId
                    ? 'Create a new profile to move a physical printer to another warehouse.'
                    : ''}
                  sx={fieldSx}
                >
                  {printers?.warehouses.map((warehouse) => (
                    <MenuItem key={warehouse.id} value={warehouse.id}>{warehouse.name}</MenuItem>
                  ))}
                </TextField>
                <TextField
                  fullWidth
                  size="small"
                  label="Printer code"
                  value={printerForm.code}
                  onChange={(event) => updatePrinter('code', event.target.value.toUpperCase())}
                  inputProps={{ maxLength: 40 }}
                  sx={fieldSx}
                />
              </Stack>
              <TextField
                fullWidth
                size="small"
                label="Printer name"
                value={printerForm.name}
                onChange={(event) => updatePrinter('name', event.target.value)}
                inputProps={{ maxLength: 120 }}
                sx={fieldSx}
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Printer type"
                  value={printerForm.printerType}
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
                  value={printerForm.stationType}
                  onChange={(event) => updatePrinter('stationType', event.target.value as PrinterStationType)}
                  sx={fieldSx}
                >
                  {PRINTER_STATION_TYPES.map((item) => <MenuItem key={item} value={item}>{label(item)}</MenuItem>)}
                </TextField>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Connection"
                  value={printerForm.connectionMode}
                  onChange={(event) => chooseConnection(event.target.value as PrinterConnectionMode)}
                  sx={fieldSx}
                >
                  {PRINTER_CONNECTION_MODES.map((item) => <MenuItem key={item} value={item}>{label(item)}</MenuItem>)}
                </TextField>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <MultiSelect
                  label="Formats"
                  options={printerForm.printerType === 'thermal' ? PRINT_FORMATS : ['PDF', 'PNG']}
                  selected={printerForm.supportedFormats}
                  onChange={(next) => {
                    updatePrinter('supportedFormats', next as PrintFormat[])
                    updatePrinter('fallbackPrinterGlobalId', null)
                  }}
                />
                <MultiSelect
                  label="Media"
                  options={printerForm.printerType === 'thermal'
                    ? ['label_4x6', 'label_4x8']
                    : ['letter', 'a4']}
                  selected={printerForm.supportedMedia}
                  onChange={(next) => {
                    updatePrinter('supportedMedia', next as PrintMedia[])
                    updatePrinter('fallbackPrinterGlobalId', null)
                  }}
                />
              </Stack>
              <MultiSelect
                label="Supported documents"
                options={PRINT_DOCUMENT_TYPES}
                selected={printerForm.supportedDocumentTypes}
                onChange={chooseSupportedDocuments}
              />
              <MultiSelect
                label="Default routes"
                options={printerForm.supportedDocumentTypes}
                selected={printerForm.defaultDocumentTypes}
                onChange={(next) => {
                  updatePrinter('defaultDocumentTypes', next as PrintDocumentType[])
                  updatePrinter('fallbackPrinterGlobalId', null)
                }}
              />
              {printerForm.connectionMode === 'local_agent' && (
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Local print agent"
                  value={printerForm.localPrintAgentGlobalId || ''}
                  onChange={(event) => setPrinterForm((current) => current ? {
                    ...current,
                    localPrintAgentGlobalId: event.target.value || null,
                    status: event.target.value ? current.status : 'offline',
                  } : current)}
                  sx={fieldSx}
                >
                  <MenuItem value="">Not assigned</MenuItem>
                  {agentOptions.map((agent) => (
                    <MenuItem key={agent.globalId} value={agent.globalId}>{agent.name}</MenuItem>
                  ))}
                </TextField>
              )}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Approved fallback"
                  value={printerForm.fallbackPrinterGlobalId || ''}
                  onChange={(event) => updatePrinter('fallbackPrinterGlobalId', event.target.value || null)}
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
                  value={printerForm.priority}
                  onChange={(event) => updatePrinter('priority', Number(event.target.value))}
                  inputProps={{ min: 1, max: 999, step: 1 }}
                  sx={fieldSx}
                />
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Status"
                  value={printerForm.status}
                  onChange={(event) => updatePrinter('status', event.target.value as PrinterStatus)}
                  sx={fieldSx}
                >
                  {PRINTER_STATUSES.map((item) => (
                    <MenuItem
                      key={item}
                      value={item}
                      disabled={
                        item === 'online'
                        && printerForm.connectionMode === 'local_agent'
                        && !printerForm.localPrintAgentGlobalId
                      }
                    >
                      {label(item)}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setPrinterForm(null)} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={() => void savePrinter()} disabled={saving}>
            {saving ? 'Saving...' : 'Save printer'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(enrollForm)}
        onClose={() => !saving && setEnrollForm(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Enroll local print agent</DialogTitle>
        {enrollForm && (
          <DialogContent dividers>
            <Stack spacing={2}>
              <TextField
                select
                fullWidth
                size="small"
                label="Warehouse"
                value={enrollForm.warehouseId}
                onChange={(event) => setEnrollForm({ ...enrollForm, warehouseId: event.target.value })}
                sx={fieldSx}
              >
                {printers?.warehouses.map((warehouse) => (
                  <MenuItem key={warehouse.id} value={warehouse.id}>{warehouse.name}</MenuItem>
                ))}
              </TextField>
              <TextField
                fullWidth
                size="small"
                label="Agent name"
                value={enrollForm.name}
                onChange={(event) => setEnrollForm({ ...enrollForm, name: event.target.value })}
                inputProps={{ maxLength: 120 }}
                sx={fieldSx}
              />
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setEnrollForm(null)} disabled={saving}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void enrollAgent()}
            disabled={saving || !enrollForm?.name.trim()}
          >
            {saving ? 'Enrolling...' : 'Enroll'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(agentAction)}
        onClose={() => !saving && setAgentAction(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {agentAction?.action === 'rotate-credential' ? 'Rotate agent credential' : 'Revoke local print agent'}
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary">
            {agentAction?.action === 'rotate-credential'
              ? `The current credential for ${agentAction.agent.name} will stop working immediately.`
              : `${agentAction?.agent.name || 'This agent'} will be revoked and every assigned local-agent printer will be set offline.`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAgentAction(null)} disabled={saving}>Cancel</Button>
          <Button
            variant="contained"
            color={agentAction?.action === 'revoke-agent' ? 'error' : 'primary'}
            onClick={() => void runAgentAction()}
            disabled={saving}
          >
            {saving
              ? 'Working...'
              : agentAction?.action === 'rotate-credential' ? 'Rotate' : 'Revoke'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(jobAction)}
        onClose={() => !saving && setJobAction(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {jobAction?.action === 'reprint-job'
            ? 'Authorize reprint'
            : jobAction?.action === 'cancel-job'
              ? 'Cancel print job'
              : 'Retry print job'}
        </DialogTitle>
        {jobAction && (
          <DialogContent dividers>
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                {jobAction.action === 'reprint-job'
                  ? `This creates a new audited job from ${jobAction.job.globalId} without purchasing another carrier label.`
                  : jobAction.action === 'cancel-job'
                    ? `This fences ${jobAction.job.globalId} from further delivery. A claimed device may already have accepted the document.`
                    : `This requeues ${jobAction.job.globalId} within its existing bounded attempt limit.`}
              </Typography>
              <TextField
                fullWidth
                multiline
                minRows={3}
                label={jobAction.action === 'reprint-job'
                  ? 'Reprint reason'
                  : jobAction.action === 'cancel-job'
                    ? 'Cancellation reason'
                    : 'Retry reason'}
                value={jobAction.reason}
                onChange={(event) => setJobAction({ ...jobAction, reason: event.target.value })}
                inputProps={{ maxLength: 500 }}
                sx={fieldSx}
              />
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setJobAction(null)} disabled={saving}>
            {jobAction?.action === 'cancel-job' ? 'Back' : 'Cancel'}
          </Button>
          <Button
            variant="contained"
            color={jobAction?.action === 'cancel-job' ? 'error' : 'primary'}
            onClick={() => void runJobAction()}
            disabled={saving || !jobAction?.reason.trim()}
          >
            {saving
              ? 'Working...'
              : jobAction?.action === 'reprint-job'
                ? 'Queue reprint'
                : jobAction?.action === 'cancel-job'
                  ? 'Cancel job'
                  : 'Queue retry'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(credential)} onClose={() => setCredential('')} fullWidth maxWidth="sm">
        <DialogTitle>One-time agent credential</DialogTitle>
        <DialogContent dividers>
          <Alert severity="warning">
            This credential is shown once. Rotate it if this dialog closes before the local agent is configured.
          </Alert>
          <Box
            component="pre"
            sx={{
              mt: 2,
              mb: 0,
              p: 1.5,
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '6px',
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
              fontSize: '0.8rem',
            }}
          >
            {credential}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            startIcon={<ContentCopyRounded />}
            onClick={() => void navigator.clipboard.writeText(credential)}
          >
            Copy
          </Button>
          <Button variant="contained" onClick={() => setCredential('')}>Done</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
