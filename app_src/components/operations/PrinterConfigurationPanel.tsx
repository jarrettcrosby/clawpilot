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
import DownloadRounded from '@mui/icons-material/DownloadRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import InfoOutlined from '@mui/icons-material/InfoOutlined'
import PrintRounded from '@mui/icons-material/PrintRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import RestartAltRounded from '@mui/icons-material/RestartAltRounded'
import TokenRounded from '@mui/icons-material/TokenRounded'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import BarcodeLabelsDialog from '@/components/operations/BarcodeLabelsDialog'
import {
  formatDimensionsMm,
  formatGrams,
  type MeasurementSystem,
} from '@/lib/measurements'
import {
  DEFAULT_PRINT_AGENT_CAPABILITIES,
  hasConnectedLocalPrintAgent,
  LEGACY_BUNDLED_PRINT_AGENT_CAPABILITIES,
  PRINT_DOCUMENT_TYPES,
  PRINT_FORMATS,
  PRINT_MEDIA,
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
  pairingGrant?: PrintAgentPairingGrant
}

type PrintAgentPairingGrant = {
  id: string
  pairingCode: string | null
  expiresAt: string
  warehouseId: string
  name: string
  supportedFormats: PrintFormat[]
  supportedMedia: PrintMedia[]
  supportedDocumentTypes: PrintDocumentType[]
}

type PrintAgentDistributionManifest = {
  version: string
  artifactHref: string
  byteLength: number
  sha256: string
  checksumHref: string
  releaseChannel: 'developer-preview'
  distributionAudience: 'developers-only'
  customerReleaseReady: false
  signed: boolean
  notarized: boolean
  requiresDeveloperIdSigning: true
  requiresAppleNotarization: true
  nodeMinimumMajor: number
  deliveryBackend: string
}

type CustomerPrintAgentReleaseArtifact = {
  platform: 'macos' | 'windows'
  architecture: 'universal' | 'x64'
  filename: string
  byteLength: number
  sha256: string
  signed: true
  notarized: boolean
  stapled: boolean
  customerReleaseReady: true
  href: string
}

type CustomerPrintAgentRelease = {
  schemaVersion: 1
  product: 'ClawPilot Print Agent'
  version: string
  customerReleaseReady: true
  artifacts: CustomerPrintAgentReleaseArtifact[]
}

type CustomerPrintAgentReleasePayload = {
  ok?: boolean
  error?: string
  release?: CustomerPrintAgentRelease
}

type PrintJobPayload = {
  ok?: boolean
  error?: string
  jobs?: OperationsPrintJobWorkspace
  job?: OperationsPrintJobListItem
}

type PrinterForm = OperationsPrinterInput
type AgentEnrollmentForm = {
  warehouseId: string
  name: string
  supportedFormats: PrintFormat[]
  supportedMedia: PrintMedia[]
  supportedDocumentTypes: PrintDocumentType[]
}
type View = 'jobs' | 'printers' | 'agents'

const BUNDLED_AGENT_FORMATS = DEFAULT_PRINT_AGENT_CAPABILITIES.supportedFormats
const BUNDLED_AGENT_MEDIA = DEFAULT_PRINT_AGENT_CAPABILITIES.supportedMedia
const BUNDLED_AGENT_DOCUMENT_TYPES = DEFAULT_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes
const LEGACY_BUNDLED_AGENT_FORMATS = LEGACY_BUNDLED_PRINT_AGENT_CAPABILITIES.supportedFormats
const LEGACY_BUNDLED_AGENT_MEDIA = LEGACY_BUNDLED_PRINT_AGENT_CAPABILITIES.supportedMedia
const LEGACY_BUNDLED_AGENT_DOCUMENT_TYPES =
  LEGACY_BUNDLED_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes
const BUNDLED_PRINTER_DEFAULT_FORMATS = LEGACY_BUNDLED_AGENT_FORMATS
const BUNDLED_PRINTER_DEFAULT_MEDIA = LEGACY_BUNDLED_AGENT_MEDIA
const BUNDLED_PRINTER_DEFAULT_DOCUMENT_TYPES = LEGACY_BUNDLED_AGENT_DOCUMENT_TYPES
const MACOS_PRINT_AGENT_DOWNLOAD_PATH = '/downloads/ClawPilot-Print-Agent-macOS.zip'
const MACOS_PRINT_AGENT_DOWNLOAD_NAME = 'ClawPilot-Print-Agent-macOS.zip'
const MACOS_PRINT_AGENT_CHECKSUM_PATH = `${MACOS_PRINT_AGENT_DOWNLOAD_PATH}.sha256`
const MACOS_PRINT_AGENT_CHECKSUM_NAME = `${MACOS_PRINT_AGENT_DOWNLOAD_NAME}.sha256`
const MACOS_PRINT_AGENT_MANIFEST_PATH = '/downloads/ClawPilot-Print-Agent-macOS.json'
const ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW =
  process.env.NEXT_PUBLIC_ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW === 'true'
const PRINT_AGENT_HEARTBEAT_RECENT_MS = 30_000

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
  local_agent: 'Background LAN print agent',
  browser: 'Web app download / manual print',
  system_service: 'System service (not implemented)',
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
  label_2x1: '2 x 1 label',
  label_3x1: '3 x 1 label',
  label_4x2: '4 x 2 label',
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
  product_label: 'Product barcode label',
  location_label: 'Location barcode label',
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

function hasRecentPrintAgentHeartbeat(lastSeenAt: string | null, referenceAt: string) {
  if (!lastSeenAt) return false
  const lastSeen = new Date(lastSeenAt).getTime()
  const reference = new Date(referenceAt).getTime()
  if (!Number.isFinite(lastSeen) || !Number.isFinite(reference)) return false
  const ageMs = reference - lastSeen
  return ageMs >= 0 && ageMs <= PRINT_AGENT_HEARTBEAT_RECENT_MS
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'Not available'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function PrintAgentDistributionFacts({
  manifest,
}: {
  manifest: PrintAgentDistributionManifest | null
}) {
  if (!ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW) return null
  return (
    <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap>
      <Typography variant="caption" color="text.secondary">
        {manifest
          ? `Developer-only v${manifest.version} · ${formatBytes(manifest.byteLength)} · raw-network ZPL · unsigned/unnotarized · Node.js ${manifest.nodeMinimumMajor}+ · SHA-256 ${manifest.sha256.slice(0, 12)}…`
          : 'Developer-only macOS raw-network ZPL preview · unsigned and not notarized · never distribute to operators'}
      </Typography>
      <Button
        component="a"
        href={MACOS_PRINT_AGENT_CHECKSUM_PATH}
        download={MACOS_PRINT_AGENT_CHECKSUM_NAME}
        size="small"
        variant="text"
        sx={{ minWidth: 0, p: 0.25, fontSize: '0.72rem' }}
      >
        SHA-256
      </Button>
    </Stack>
  )
}

function DeveloperPrintAgentDownloadButton() {
  if (!ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW) return null
  return (
    <Button
      component="a"
      href={MACOS_PRINT_AGENT_DOWNLOAD_PATH}
      download={MACOS_PRINT_AGENT_DOWNLOAD_NAME}
      variant="outlined"
      startIcon={<DownloadRounded />}
    >
      Download developer preview
    </Button>
  )
}

function customerReleaseArtifactIsValid(
  artifact: CustomerPrintAgentReleaseArtifact,
): boolean {
  const expectedArchitecture = artifact.platform === 'macos' ? 'universal' : 'x64'
  const expectedSuffix = artifact.platform === 'macos' ? '.dmg' : '.exe'
  const expectedHref = '/api/operations/print-agent/releases/download'
    + `?platform=${artifact.platform}&architecture=${artifact.architecture}`
  return artifact.architecture === expectedArchitecture
    && artifact.filename.endsWith(expectedSuffix)
    && Number.isSafeInteger(artifact.byteLength)
    && artifact.byteLength > 0
    && /^[a-f0-9]{64}$/.test(artifact.sha256)
    && artifact.signed === true
    && artifact.customerReleaseReady === true
    && artifact.href === expectedHref
    && (artifact.platform !== 'macos' || (
      artifact.notarized === true && artifact.stapled === true
    ))
    && (artifact.platform !== 'windows' || (
      artifact.notarized === false && artifact.stapled === false
    ))
}

function customerReleaseIsValid(release: CustomerPrintAgentRelease): boolean {
  return release.schemaVersion === 1
    && release.product === 'ClawPilot Print Agent'
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version)
    && release.customerReleaseReady === true
    && release.artifacts.length >= 1
    && release.artifacts.length <= 2
    && new Set(release.artifacts.map((artifact) => artifact.platform)).size
      === release.artifacts.length
    && release.artifacts.every(customerReleaseArtifactIsValid)
}

function CustomerPrintAgentDownloadButton({
  artifact,
}: {
  artifact: CustomerPrintAgentReleaseArtifact
}) {
  return (
    <Button
      component="a"
      href={artifact.href}
      variant="outlined"
      startIcon={<DownloadRounded />}
    >
      {artifact.platform === 'macos' ? 'Download for macOS' : 'Download for Windows'}
    </Button>
  )
}

function packageSize(
  job: OperationsPrintJobListItem,
  measurementSystem: MeasurementSystem,
) {
  if (
    job.packageLengthMm === null
    || job.packageWidthMm === null
    || job.packageHeightMm === null
  ) return 'Not available'
  return formatDimensionsMm({
    lengthMm: job.packageLengthMm,
    widthMm: job.packageWidthMm,
    heightMm: job.packageHeightMm,
  }, measurementSystem, { maximumFractionDigits: 3 })
}

function packageWeight(
  job: OperationsPrintJobListItem,
  measurementSystem: MeasurementSystem,
) {
  if (job.packageWeightGrams === null) return 'Not available'
  return formatGrams(job.packageWeightGrams, measurementSystem, {
    maximumFractionDigits: 3,
  })
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

function containsAll<T extends string>(available: readonly T[], required: readonly T[]) {
  return required.every((item) => available.includes(item))
}

function agentSupportsPrinter(
  agent: OperationsPrintAgentProfile,
  printer: Pick<
    PrinterForm,
    'supportedFormats' | 'supportedMedia' | 'supportedDocumentTypes'
  >,
) {
  return containsAll(agent.supportedFormats, printer.supportedFormats)
    && containsAll(agent.supportedMedia, printer.supportedMedia)
    && containsAll(agent.supportedDocumentTypes, printer.supportedDocumentTypes)
}

function isBundledRawZplCapability(agent: OperationsPrintAgentProfile) {
  return agent.supportedFormats.length === BUNDLED_AGENT_FORMATS.length
    && containsAll(agent.supportedFormats, BUNDLED_AGENT_FORMATS)
    && agent.supportedMedia.length === BUNDLED_AGENT_MEDIA.length
    && containsAll(agent.supportedMedia, BUNDLED_AGENT_MEDIA)
    && agent.supportedDocumentTypes.length === BUNDLED_AGENT_DOCUMENT_TYPES.length
    && containsAll(agent.supportedDocumentTypes, BUNDLED_AGENT_DOCUMENT_TYPES)
}

function isLegacyBundledRawZplCapability(agent: OperationsPrintAgentProfile) {
  return agent.supportedFormats.length === LEGACY_BUNDLED_AGENT_FORMATS.length
    && containsAll(agent.supportedFormats, LEGACY_BUNDLED_AGENT_FORMATS)
    && agent.supportedMedia.length === LEGACY_BUNDLED_AGENT_MEDIA.length
    && containsAll(agent.supportedMedia, LEGACY_BUNDLED_AGENT_MEDIA)
    && agent.supportedDocumentTypes.length === LEGACY_BUNDLED_AGENT_DOCUMENT_TYPES.length
    && containsAll(agent.supportedDocumentTypes, LEGACY_BUNDLED_AGENT_DOCUMENT_TYPES)
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
    supportedFormats: [...BUNDLED_PRINTER_DEFAULT_FORMATS],
    supportedMedia: [...BUNDLED_PRINTER_DEFAULT_MEDIA],
    supportedDocumentTypes: [...BUNDLED_PRINTER_DEFAULT_DOCUMENT_TYPES],
    defaultDocumentTypes: [],
    fallbackPrinterGlobalId: null,
    localPrintAgentGlobalId: null,
    priority: 100,
    status: 'offline',
  }
}

function defaultEnrollmentForm(warehouseId: string): AgentEnrollmentForm {
  return {
    warehouseId,
    name: '',
    supportedFormats: [...BUNDLED_AGENT_FORMATS],
    supportedMedia: [...BUNDLED_AGENT_MEDIA],
    supportedDocumentTypes: [...BUNDLED_AGENT_DOCUMENT_TYPES],
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
  helperText,
}: {
  label: string
  options: readonly string[]
  selected: string[]
  onChange: (value: string[]) => void
  helperText?: string
}) {
  return (
    <TextField
      select
      fullWidth
      size="small"
      label={fieldLabel}
      value={selected}
      helperText={helperText}
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

function hasUncertainPrintOutcome(job: OperationsPrintJobListItem): boolean {
  const latest = job.attemptHistory[job.attemptHistory.length - 1]
  return job.status === 'failed'
    && latest?.state === 'failed'
    && ['local_print_agent', 'system'].includes(latest.actorType)
    && latest.errorCode === 'PRINT_OUTCOME_UNCERTAIN'
    && latest.physicalOutputVerified === false
}

export default function PrinterConfigurationPanel() {
  const { measurementSystem } = useMeasurementSystem()
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
  const [enrollForm, setEnrollForm] = useState<AgentEnrollmentForm | null>(null)
  const [agentAction, setAgentAction] = useState<{
    agent: OperationsPrintAgentProfile
    action: 'upgrade-bundled-capabilities' | 'revoke-agent'
  } | null>(null)
  const [jobAction, setJobAction] = useState<{
    job: OperationsPrintJobListItem
    action: 'retry-job' | 'reprint-job' | 'cancel-job'
    reason: string
  } | null>(null)
  const [pairingGrant, setPairingGrant] = useState<PrintAgentPairingGrant | null>(null)
  const [barcodeLabelsOpen, setBarcodeLabelsOpen] = useState(false)
  const [pairingBaseUrl, setPairingBaseUrl] = useState('https://dev.aiapp.eigenracing.com')
  const [printAgentDistribution, setPrintAgentDistribution] =
    useState<PrintAgentDistributionManifest | null>(null)
  const [customerPrintAgentRelease, setCustomerPrintAgentRelease] =
    useState<CustomerPrintAgentRelease | null>(null)
  const [customerPrintAgentReleaseLoading, setCustomerPrintAgentReleaseLoading] = useState(true)
  const pairingCommand = `npm run print-agent:pair:macos -- --base-url '${pairingBaseUrl}'`

  useEffect(() => {
    setPairingBaseUrl(window.location.origin)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/operations/print-agent/releases', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) {
          setCustomerPrintAgentRelease(null)
          return
        }
        const payload = await responsePayload<CustomerPrintAgentReleasePayload>(response)
        if (
          payload.ok
          && payload.release
          && customerReleaseIsValid(payload.release)
        ) {
          setCustomerPrintAgentRelease(payload.release)
        } else {
          setCustomerPrintAgentRelease(null)
        }
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setCustomerPrintAgentRelease(null)
        }
      } finally {
        if (!controller.signal.aborted) setCustomerPrintAgentReleaseLoading(false)
      }
    })()
    return () => controller.abort()
  }, [])

  const printAgentSetupReady = Boolean(customerPrintAgentRelease)
    || ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW
  const customerMacPrintAgent = customerPrintAgentRelease?.artifacts.find(
    (artifact) => artifact.platform === 'macos',
  ) || null
  const customerWindowsPrintAgent = customerPrintAgentRelease?.artifacts.find(
    (artifact) => artifact.platform === 'windows',
  ) || null

  useEffect(() => {
    if (!ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW) return undefined
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(MACOS_PRINT_AGENT_MANIFEST_PATH, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) return
        const manifest = await response.json() as Partial<PrintAgentDistributionManifest>
        if (
          manifest.artifactHref === MACOS_PRINT_AGENT_DOWNLOAD_PATH
          && manifest.checksumHref === MACOS_PRINT_AGENT_CHECKSUM_PATH
          && typeof manifest.version === 'string'
          && /^\d+\.\d+\.\d+-preview\.\d+$/.test(manifest.version)
          && typeof manifest.byteLength === 'number'
          && Number.isSafeInteger(manifest.byteLength)
          && manifest.byteLength > 0
          && typeof manifest.sha256 === 'string'
          && /^[a-f0-9]{64}$/.test(manifest.sha256)
          && manifest.releaseChannel === 'developer-preview'
          && manifest.distributionAudience === 'developers-only'
          && manifest.customerReleaseReady === false
          && manifest.signed === false
          && manifest.notarized === false
          && manifest.requiresDeveloperIdSigning === true
          && manifest.requiresAppleNotarization === true
          && manifest.nodeMinimumMajor === 20
          && manifest.deliveryBackend === 'raw-network-zpl'
        ) {
          setPrintAgentDistribution(manifest as PrintAgentDistributionManifest)
        }
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setPrintAgentDistribution(null)
        }
      }
    })()
    return () => controller.abort()
  }, [])

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

  const selectedAgent = useMemo(
    () => agents?.agents.find((agent) => (
      agent.globalId === printerForm?.localPrintAgentGlobalId
    )) || null,
    [agents?.agents, printerForm?.localPrintAgentGlobalId],
  )
  const activeAgentCount = useMemo(
    () => agents?.agents.filter((agent) => agent.status === 'active').length || 0,
    [agents?.agents],
  )
  const activeAgents = useMemo(
    () => agents?.agents.filter((agent) => agent.status === 'active') || [],
    [agents?.agents],
  )

  const selectedAgentCompatible = Boolean(
    printerForm
    && selectedAgent
    && selectedAgent.status === 'active'
    && selectedAgent.warehouseId === printerForm.warehouseId
    && agentSupportsPrinter(selectedAgent, printerForm),
  )

  const agentOptions = useMemo(
    () => agents?.agents.filter((agent) => (
      agent.warehouseId === printerForm?.warehouseId
      && agent.status === 'active'
      && Boolean(printerForm && agentSupportsPrinter(agent, printerForm))
    )) || [],
    [agents?.agents, printerForm],
  )

  const printerFormatOptions = useMemo(() => {
    const typeOptions: PrintFormat[] = printerForm?.printerType === 'thermal'
      ? [...PRINT_FORMATS]
      : ['PDF', 'PNG']
    return selectedAgent && selectedAgentCompatible
      ? typeOptions.filter((item) => selectedAgent.supportedFormats.includes(item))
      : typeOptions
  }, [printerForm?.printerType, selectedAgent, selectedAgentCompatible])

  const printerMediaOptions = useMemo(() => {
    const typeOptions: PrintMedia[] = printerForm?.printerType === 'thermal'
      ? ['label_2x1', 'label_3x1', 'label_4x2', 'label_4x6', 'label_4x8']
      : ['letter', 'a4']
    return selectedAgent && selectedAgentCompatible
      ? typeOptions.filter((item) => selectedAgent.supportedMedia.includes(item))
      : typeOptions
  }, [printerForm?.printerType, selectedAgent, selectedAgentCompatible])

  const printerDocumentOptions = useMemo(
    () => selectedAgent && selectedAgentCompatible
      ? PRINT_DOCUMENT_TYPES.filter((item) => (
        selectedAgent.supportedDocumentTypes.includes(item)
      ))
      : PRINT_DOCUMENT_TYPES,
    [selectedAgent, selectedAgentCompatible],
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
          localPrintAgentGlobalId: null,
          status: current.connectionMode === 'local_agent' ? 'offline' : current.status,
        }
      }
      return {
        ...current,
        printerType,
        stationType: current.stationType === 'office' ? 'shipping' : current.stationType,
        supportedFormats: [...BUNDLED_PRINTER_DEFAULT_FORMATS],
        supportedMedia: [...BUNDLED_PRINTER_DEFAULT_MEDIA],
        supportedDocumentTypes: [...BUNDLED_PRINTER_DEFAULT_DOCUMENT_TYPES],
        defaultDocumentTypes: [],
        fallbackPrinterGlobalId: null,
        localPrintAgentGlobalId: null,
        status: current.connectionMode === 'local_agent' ? 'offline' : current.status,
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

  function chooseSupportedCapability<
    K extends 'supportedFormats' | 'supportedMedia' | 'supportedDocumentTypes',
  >(key: K, next: PrinterForm[K]) {
    setPrinterForm((current) => {
      if (!current) return current
      const nextForm: PrinterForm = {
        ...current,
        [key]: next,
        defaultDocumentTypes: key === 'supportedDocumentTypes'
          ? current.defaultDocumentTypes.filter((item) => (
            (next as PrintDocumentType[]).includes(item)
          ))
          : current.defaultDocumentTypes,
        fallbackPrinterGlobalId: null,
      }
      const agent = agents?.agents.find((item) => (
        item.globalId === current.localPrintAgentGlobalId
      ))
      const keepAgent = Boolean(
        agent
        && agent.status === 'active'
        && agent.warehouseId === current.warehouseId
        && agentSupportsPrinter(agent, nextForm),
      )
      return {
        ...nextForm,
        localPrintAgentGlobalId: keepAgent ? current.localPrintAgentGlobalId : null,
        status: current.connectionMode === 'local_agent' && !keepAgent
          ? 'offline'
          : current.status,
      }
    })
  }

  function chooseSupportedDocuments(next: string[]) {
    chooseSupportedCapability('supportedDocumentTypes', next as PrintDocumentType[])
  }

  function chooseSupportedFormats(next: string[]) {
    chooseSupportedCapability('supportedFormats', next as PrintFormat[])
  }

  function chooseSupportedMedia(next: string[]) {
    chooseSupportedCapability('supportedMedia', next as PrintMedia[])
  }

  async function savePrinter() {
    if (!printerForm) return
    if (printerForm.connectionMode === 'system_service') {
      setError('System service printing is not implemented. Choose Web app download/manual print or Background LAN print agent.')
      return
    }
    if (!printerForm.code.trim() || !printerForm.name.trim()) {
      setError('Printer code and name are required')
      return
    }
    if (
      !printerForm.supportedFormats.length
      || !printerForm.supportedMedia.length
      || !printerForm.supportedDocumentTypes.length
    ) {
      setError('Select at least one supported format, media size, and document type')
      return
    }
    if (
      printerForm.connectionMode === 'local_agent'
      && printerForm.localPrintAgentGlobalId
      && !selectedAgentCompatible
    ) {
      setError(
        'Choose an active local print agent that supports every selected format, media size, and document type',
      )
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

  async function createPairingGrant() {
    if (!enrollForm) return
    if (
      !enrollForm.supportedFormats.length
      || !enrollForm.supportedMedia.length
      || !enrollForm.supportedDocumentTypes.length
    ) {
      setError('Select at least one agent format, media size, and document type')
      return
    }
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
        body: JSON.stringify({
          action: 'create-pairing-grant',
          warehouseId: enrollForm.warehouseId,
          name: enrollForm.name.trim(),
          supportedFormats: enrollForm.supportedFormats,
          supportedMedia: enrollForm.supportedMedia,
          supportedDocumentTypes: enrollForm.supportedDocumentTypes,
        }),
      })
      const result = await responsePayload<PrintAgentPayload>(response)
      if (!response.ok || !result.ok || !result.pairingGrant) {
        throw new Error(result.error || 'Print Agent pairing code could not be created')
      }
      setEnrollForm(null)
      if (!result.pairingGrant.pairingCode) {
        setError(
          'This pairing request was already completed. Create a new pairing code; the prior code cannot be shown again.',
        )
        return
      }
      setPairingGrant(result.pairingGrant)
      setNotice(
        `Pairing code created for ${result.pairingGrant.name}; it expires ${timestamp(result.pairingGrant.expiresAt)}`,
      )
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Print Agent pairing code could not be created')
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
          ...(agentAction.action === 'upgrade-bundled-capabilities'
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
      setNotice(
        agentAction.action === 'upgrade-bundled-capabilities'
          ? `${result.agent.name} now supports bundled carrier, product-barcode, and location-barcode ZPL printing`
          : `${result.agent.name} was revoked and its printers were set offline`,
      )
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Local print-agent action failed')
    } finally {
      setSaving(false)
    }
  }

  async function runJobAction() {
    if (!jobAction) return
    const uncertainOutcomeRecovery = jobAction.action === 'reprint-job'
      && hasUncertainPrintOutcome(jobAction.job)
    if (!jobAction.reason.trim()) {
      const actionName = jobAction.action === 'reprint-job'
        ? uncertainOutcomeRecovery ? 'New-print authorization' : 'Reprint'
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
          ? uncertainOutcomeRecovery
            ? `New print ${result.job.globalId} was authorized and queued; ${jobAction.job.globalId} remains preserved as an uncertain outcome`
            : `Reprint ${result.job.globalId} was queued`
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
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
          <Button
            variant="outlined"
            startIcon={<TokenRounded />}
            onClick={() => setView('agents')}
          >
            {printAgentSetupReady ? 'Print Agent setup' : 'Local print service'}
          </Button>
          {printers?.capabilities.canView && (
            <Button
              variant="outlined"
              startIcon={<PrintRounded />}
              onClick={() => setBarcodeLabelsOpen(true)}
            >
              Barcode labels
            </Button>
          )}
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
        <Tab value="agents" label={`Agents${agents ? ` (${activeAgentCount})` : ''}`} />
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
                    {job.status === 'failed'
                      && !hasUncertainPrintOutcome(job)
                      && jobs.capabilities.canExecute
                      && job.attempts < job.maxAttempts && (
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<RestartAltRounded />}
                        onClick={() => setJobAction({ job, action: 'retry-job', reason: '' })}
                      >
                        Retry
                      </Button>
                    )}
                    {hasUncertainPrintOutcome(job) && jobs.capabilities.canReprint && (
                      <Button
                        size="small"
                        variant="outlined"
                        color="warning"
                        startIcon={<ReplayRounded />}
                        onClick={() => setJobAction({ job, action: 'reprint-job', reason: '' })}
                      >
                        Authorize new print
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
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="flex-end"
            spacing={1}
          >
            {customerMacPrintAgent && (
              <CustomerPrintAgentDownloadButton artifact={customerMacPrintAgent} />
            )}
            {customerWindowsPrintAgent && (
              <CustomerPrintAgentDownloadButton artifact={customerWindowsPrintAgent} />
            )}
            {!customerPrintAgentRelease && <DeveloperPrintAgentDownloadButton />}
            <Button
              variant="outlined"
              startIcon={<TokenRounded />}
              onClick={() => setView('agents')}
            >
              {printAgentSetupReady
                ? 'Configure network printer'
                : 'View local agent status'}
            </Button>
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
          {customerPrintAgentRelease ? (
            <Alert severity="info" sx={{ mt: 2 }}>
              Install the signed ClawPilot Print Agent for macOS or Windows, then enter the
              Zebra&apos;s private network IP and raw port 9100 in that local app. ClawPilot stores
              only the logical printer-to-agent assignment; the IP stays on the computer. The
              computer must remain on, connected to the printer network, and signed in for
              background printing.
            </Alert>
          ) : ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW ? (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Developer preview only: enter the printer hostname/IP and raw port (normally 9100)
              in the local helper on the controlled development Mac. ClawPilot stores the logical
              printer and agent assignment, but never receives or displays that endpoint.
            </Alert>
          ) : (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {customerPrintAgentReleaseLoading
                ? 'Checking for a verified ClawPilot Print Agent release...'
                : 'A verified signed Print Agent release is not currently available. Existing paired background agents remain available; do not distribute the unsigned developer helper to operators.'}
            </Alert>
          )}
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
                      {printer.connectionMode === 'local_agent' && (
                        <Chip
                          size="small"
                          label={
                            hasConnectedLocalPrintAgent(printer)
                            && hasRecentPrintAgentHeartbeat(
                              printer.localPrintAgentLastSeenAt,
                              printers.generatedAt,
                            )
                              ? 'Agent connected'
                              : printer.localPrintAgentLastSeenAt ? 'Agent offline' : 'Configured'
                          }
                          color={
                            hasConnectedLocalPrintAgent(printer)
                            && hasRecentPrintAgentHeartbeat(
                              printer.localPrintAgentLastSeenAt,
                              printers.generatedAt,
                            )
                              ? 'success'
                              : 'warning'
                          }
                          variant="outlined"
                        />
                      )}
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
                      Agent: {printer.localPrintAgentName || 'Not assigned'} · Agent heartbeat:{' '}
                      {printer.localPrintAgentLastSeenAt
                        ? timestamp(printer.localPrintAgentLastSeenAt)
                        : 'Agent never connected'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      Last device delivery: {printer.lastSeenAt
                        ? timestamp(printer.lastSeenAt)
                        : printer.localPrintAgentLastSeenAt
                          ? 'No device delivery yet'
                          : 'Agent never connected'}
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
          <Box
            component="section"
            sx={{
              p: { xs: 2, md: 2.5 },
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '10px',
              backgroundColor: 'rgba(255,255,255,0.025)',
            }}
          >
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              justifyContent="space-between"
              alignItems={{ xs: 'stretch', md: 'center' }}
              gap={2}
            >
              <Box sx={{ minWidth: 0 }}>
                {customerPrintAgentRelease ? (
                  <>
                    <Typography fontWeight={700}>
                      ClawPilot Print Agent v{customerPrintAgentRelease.version}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      Download the verified signed installer for this computer, then create a
                      one-time workspace pairing code. The app collects and tests the Zebra&apos;s
                      private network IP and port 9100 locally without printing, keeps that
                      endpoint out of ClawPilot, and runs in the signed-in user&apos;s background tray.
                      The computer must stay on, signed in, and connected to the printer network
                      whenever ClawPilot should print. Web app download/manual print remains a
                      separate delivery choice.
                    </Typography>
                  </>
                ) : ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW ? (
                  <>
                    <Typography fontWeight={700}>Developer-only local printing preview</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      Use only on a controlled development Mac. Enter the Zebra&apos;s local
                      hostname/IP and raw port 9100 in the helper before creating the one-time
                      workspace code. The endpoint stays on the Mac and is never sent to ClawPilot.
                    </Typography>
                    <Box sx={{ mt: 0.75 }}>
                      <PrintAgentDistributionFacts manifest={printAgentDistribution} />
                    </Box>
                  </>
                ) : (
                  <>
                    <Typography fontWeight={700}>Verified Print Agent release unavailable</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {customerPrintAgentReleaseLoading
                        ? 'ClawPilot is checking the verified signed installer release.'
                        : 'New operator pairing stays disabled until a signed installer passes release verification. Existing paired background agents remain available, and web app download/manual print remains a separate option.'}
                    </Typography>
                  </>
                )}
              </Box>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexShrink={0}>
                {customerMacPrintAgent && (
                  <CustomerPrintAgentDownloadButton artifact={customerMacPrintAgent} />
                )}
                {customerWindowsPrintAgent && (
                  <CustomerPrintAgentDownloadButton artifact={customerWindowsPrintAgent} />
                )}
                {!customerPrintAgentRelease && <DeveloperPrintAgentDownloadButton />}
                {printAgentSetupReady && agents?.capabilities.canManage && (
                  <Button
                    variant="contained"
                    startIcon={<TokenRounded />}
                    disabled={!printers?.warehouses[0]}
                    onClick={() => setEnrollForm(defaultEnrollmentForm(
                      printers?.warehouses[0]?.id || '',
                    ))}
                  >
                    Create pairing code
                  </Button>
                )}
                <Button
                  variant="text"
                  startIcon={<PrintRounded />}
                  onClick={() => setView('printers')}
                >
                  Configure printers
                </Button>
              </Stack>
            </Stack>
          </Box>
          {!printers?.warehouses.length && (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              Create an active warehouse before creating a workspace pairing code.
            </Alert>
          )}
          {!agents || !activeAgents.length ? (
            <Box sx={{ py: 5, textAlign: 'center' }}>
              <TokenRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
              <Typography fontWeight={700} sx={{ mt: 1 }}>No local print agents</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {customerPrintAgentRelease
                  ? 'Download and open the signed Print Agent, then create a one-time code for this workspace. The app prompts locally for the private Zebra IP and port 9100.'
                  : ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW
                  ? 'Open the developer helper first, then create a one-time code for this workspace. The helper prompts locally for the Zebra IP and port 9100.'
                  : 'A verified signed Print Agent installer is required before a new operator can pair this workspace.'}
              </Typography>
            </Box>
          ) : (
            <Stack sx={{ mt: 1 }}>
              <Stack direction="row" justifyContent="flex-end" sx={{ mb: 0.5 }}>
                {printAgentSetupReady && agents?.capabilities.canManage && (
                  <Button
                    size="small"
                    variant="text"
                    startIcon={<AddRounded />}
                    disabled={!printers?.warehouses[0]}
                    onClick={() => setEnrollForm(defaultEnrollmentForm(
                      printers?.warehouses[0]?.id || '',
                    ))}
                  >
                    Add another agent
                  </Button>
                )}
              </Stack>
              <Stack divider={<Divider flexItem />}>
              {activeAgents.map((agent) => (
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
                      {agent.status === 'active' && (
                        <Chip
                          size="small"
                          label={hasRecentPrintAgentHeartbeat(agent.lastSeenAt, agents.generatedAt)
                            ? 'Connected'
                            : agent.lastSeenAt ? 'Seen before' : 'Waiting for connection'}
                          color={hasRecentPrintAgentHeartbeat(agent.lastSeenAt, agents.generatedAt)
                            ? 'success'
                            : agent.lastSeenAt ? 'default' : 'warning'}
                          variant="outlined"
                        />
                      )}
                      <Chip size="small" label={`Credential v${agent.credentialVersion}`} variant="outlined" />
                      <Chip
                        size="small"
                        color={isBundledRawZplCapability(agent)
                          ? 'info'
                          : isLegacyBundledRawZplCapability(agent) ? 'warning' : 'secondary'}
                        label={isBundledRawZplCapability(agent)
                          ? 'Bundled Zebra raw ZPL'
                          : isLegacyBundledRawZplCapability(agent)
                            ? 'Legacy bundled shipping only'
                            : 'Custom capability agent'}
                        variant="outlined"
                      />
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {agent.warehouseName} · Last seen{' '}
                      {agent.lastSeenAt ? timestamp(agent.lastSeenAt) : 'Agent never connected'}
                    </Typography>
                    <Typography variant="caption" color="#A8C7FA">{agent.globalId}</Typography>
                    <Stack direction="row" gap={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                      {agent.supportedFormats.map((item) => (
                        <Chip
                          key={`format-${item}`}
                          size="small"
                          label={item === 'ZPL' ? 'Raw ZPL' : item}
                          variant="outlined"
                        />
                      ))}
                      {agent.supportedMedia.map((item) => (
                        <Chip key={`media-${item}`} size="small" label={label(item)} variant="outlined" />
                      ))}
                      {agent.supportedDocumentTypes.map((item) => (
                        <Chip key={`document-${item}`} size="small" label={label(item)} variant="outlined" />
                      ))}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                      Printers: {agent.assignedPrinters.map((printer) => printer.name).join(', ') || 'None'}
                    </Typography>
                  </Box>
                  {agents.capabilities.canManage && agent.status === 'active' && (
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      {isLegacyBundledRawZplCapability(agent) && (
                        <Tooltip title={`Enable bundled barcode printing for ${agent.name}`}>
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<TokenRounded />}
                            aria-label={`Enable bundled barcode printing for ${agent.name}`}
                            onClick={() => setAgentAction({
                              agent,
                              action: 'upgrade-bundled-capabilities',
                            })}
                          >
                            Enable barcode printing
                          </Button>
                        </Tooltip>
                      )}
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
                  <DetailField term="Package dimensions" value={packageSize(selectedJob, measurementSystem)} />
                  <DetailField term="Package weight" value={packageWeight(selectedJob, measurementSystem)} />
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
                            Local device reference: {attempt.deviceJobReference}
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
          {selectedJob?.artifactGlobalId && (
            <Button
              component="a"
              href={`/api/operations/artifacts/${encodeURIComponent(selectedJob.artifactGlobalId)}`}
              download
              startIcon={<DownloadRounded />}
            >
              Download {selectedJob.format || 'artifact'}
            </Button>
          )}
          {selectedJob?.status === 'failed'
            && !hasUncertainPrintOutcome(selectedJob)
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
          {selectedJob
            && hasUncertainPrintOutcome(selectedJob)
            && jobs?.capabilities.canReprint && (
            <Button
              color="warning"
              startIcon={<ReplayRounded />}
              onClick={() => {
                setSelectedJob(null)
                setJobAction({ job: selectedJob, action: 'reprint-job', reason: '' })
              }}
            >
              Authorize new print
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
                  label="Print delivery method"
                  value={printerForm.connectionMode}
                  onChange={(event) => chooseConnection(event.target.value as PrinterConnectionMode)}
                  helperText="Choose one: web app download/manual print or a durable background LAN agent."
                  sx={fieldSx}
                >
                  {PRINTER_CONNECTION_MODES.map((item) => (
                    <MenuItem key={item} value={item} disabled={item === 'system_service'}>
                      {item === 'system_service' ? 'System service (not implemented)' : label(item)}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
              {printerForm.connectionMode === 'browser' && (
                <Alert severity="info">
                  Browser download/manual print opens or downloads the document for an operator.
                  It is best-effort, creates no durable device acknowledgement, and cannot send
                  raw TCP to a Zebra hostname/IP.
                </Alert>
              )}
              {printerForm.connectionMode === 'system_service' && (
                <Alert severity="warning">
                  System service is a reserved schema value only; ClawPilot has no certified
                  delivery backend for it. Choose Web app download/manual print or Background LAN
                  print agent.
                </Alert>
              )}
              {printerForm.printerType === 'thermal'
                && printerForm.connectionMode === 'local_agent' && (
                <Alert severity="info">
                  <Stack spacing={1} alignItems="flex-start">
                    <Typography variant="body2">
                      {customerPrintAgentRelease
                        ? 'Enter the Zebra private network IP and raw port 9100 in the signed ClawPilot Print Agent for macOS or Windows, not in this hosted form.'
                        : 'A verified signed Print Agent release is required before entering the Zebra private network IP and raw port 9100; this hosted form never collects it.'}
                      {' '}This form defines routing and capabilities only. New Zebra profiles
                      retain the 4 x 6 carrier-label preset; select only the label sizes physically
                      loaded and calibrated.
                    </Typography>
                    <Button
                      size="small"
                      variant="text"
                      startIcon={<TokenRounded />}
                      onClick={() => {
                        setPrinterForm(null)
                        setView('agents')
                      }}
                    >
                      View Print Agent status
                    </Button>
                  </Stack>
                </Alert>
              )}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <MultiSelect
                  label="Printer formats"
                  options={printerFormatOptions}
                  selected={printerForm.supportedFormats}
                  onChange={chooseSupportedFormats}
                  helperText={selectedAgentCompatible
                    ? `Limited to ${selectedAgent?.name}'s declared runtime capabilities.`
                    : 'Raw ZPL is the safe choice for the bundled Zebra local agent.'}
                />
                <MultiSelect
                  label="Printer media"
                  options={printerMediaOptions}
                  selected={printerForm.supportedMedia}
                  onChange={chooseSupportedMedia}
                  helperText={selectedAgentCompatible
                    ? `Limited to ${selectedAgent?.name}'s declared runtime capabilities.`
                    : undefined}
                />
              </Stack>
              <MultiSelect
                label="Supported documents"
                options={printerDocumentOptions}
                selected={printerForm.supportedDocumentTypes}
                onChange={chooseSupportedDocuments}
                helperText={selectedAgentCompatible
                  ? `Limited to ${selectedAgent?.name}'s declared runtime capabilities.`
                  : undefined}
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
                  helperText={!agentOptions.length
                    ? 'No active agent in this warehouse declares every selected format, media size, and document type.'
                    : 'Only agents whose declared capabilities cover this printer are available.'}
                  sx={fieldSx}
                >
                  <MenuItem value="">Not assigned</MenuItem>
                  {selectedAgent && !selectedAgentCompatible && (
                    <MenuItem value={selectedAgent.globalId} disabled>
                      {selectedAgent.name} — incompatible existing assignment
                    </MenuItem>
                  )}
                  {agentOptions.map((agent) => (
                    <MenuItem key={agent.globalId} value={agent.globalId}>
                      {agent.name} — {isBundledRawZplCapability(agent)
                        ? 'bundled Zebra raw ZPL'
                        : isLegacyBundledRawZplCapability(agent)
                          ? 'legacy bundled shipping only'
                          : 'custom capabilities'}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              {printerForm.connectionMode === 'local_agent'
                && printerForm.localPrintAgentGlobalId
                && !selectedAgentCompatible && (
                <Alert severity="error">
                  This assignment is incompatible. Choose an active agent that supports every
                  selected printer capability before saving.
                </Alert>
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
          <Button
            variant="contained"
            onClick={() => void savePrinter()}
            disabled={
              saving
              || !printerForm
              || !printerForm.supportedFormats.length
              || !printerForm.supportedMedia.length
              || !printerForm.supportedDocumentTypes.length
              || (
                printerForm.connectionMode === 'local_agent'
                && Boolean(printerForm.localPrintAgentGlobalId)
                && !selectedAgentCompatible
              )
            }
          >
            {saving ? 'Saving...' : 'Save printer'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={printAgentSetupReady && Boolean(enrollForm)}
        onClose={() => !saving && setEnrollForm(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Create workspace pairing code</DialogTitle>
        {enrollForm && (
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="info">
                <Typography variant="body2" fontWeight={700}>
                  Bundled Zebra runtime: raw UTF-8 ZPL only
                </Typography>
                <Typography variant="body2">
                  The safe preset accepts raw ZPL carrier labels on 4 x 6 or 4 x 8 media and
                  product or location barcode labels on 2 x 1, 3 x 1, 4 x 2, 4 x 6, or 4 x 8
                  media. Declare PDF, PNG, return labels, or office documents only for a
                  separately maintained custom agent that you have tested.
                </Typography>
              </Alert>
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
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <MultiSelect
                  label="Agent formats"
                  options={PRINT_FORMATS}
                  selected={enrollForm.supportedFormats}
                  onChange={(next) => setEnrollForm({
                    ...enrollForm,
                    supportedFormats: next as PrintFormat[],
                  })}
                  helperText="Raw ZPL is the bundled runtime default."
                />
                <MultiSelect
                  label="Agent media"
                  options={PRINT_MEDIA}
                  selected={enrollForm.supportedMedia}
                  onChange={(next) => setEnrollForm({
                    ...enrollForm,
                    supportedMedia: next as PrintMedia[],
                  })}
                  helperText="All five Zebra barcode-label sizes are included in the bundled runtime."
                />
              </Stack>
              <MultiSelect
                label="Agent document types"
                options={PRINT_DOCUMENT_TYPES}
                selected={enrollForm.supportedDocumentTypes}
                onChange={(next) => setEnrollForm({
                  ...enrollForm,
                  supportedDocumentTypes: next as PrintDocumentType[],
                })}
                helperText="Carrier, product barcode, and location barcode labels are bundled."
              />
              <Box>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => setEnrollForm({
                    ...enrollForm,
                    supportedFormats: [...BUNDLED_AGENT_FORMATS],
                    supportedMedia: [...BUNDLED_AGENT_MEDIA],
                    supportedDocumentTypes: [...BUNDLED_AGENT_DOCUMENT_TYPES],
                  })}
                >
                  Use bundled Zebra defaults
                </Button>
              </Box>
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setEnrollForm(null)} disabled={saving}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void createPairingGrant()}
            disabled={
              saving
              || !enrollForm
              || !enrollForm.name.trim()
              || !enrollForm.supportedFormats.length
              || !enrollForm.supportedMedia.length
              || !enrollForm.supportedDocumentTypes.length
            }
          >
            {saving ? 'Creating...' : 'Create pairing code'}
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
          {agentAction?.action === 'upgrade-bundled-capabilities'
            ? 'Enable bundled barcode printing'
            : 'Revoke local print agent'}
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary">
            {agentAction?.action === 'upgrade-bundled-capabilities'
              ? `${agentAction.agent.name} will retain its credential and shipping support while adding the exact bundled product-label, location-label, and Zebra media capabilities. Reinstall the macOS LaunchAgent, or restart a repo-run bundled agent, before queueing barcode jobs.`
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
              : agentAction?.action === 'upgrade-bundled-capabilities'
                ? 'Enable barcode printing'
                : 'Revoke'}
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
            ? hasUncertainPrintOutcome(jobAction.job)
              ? 'Authorize new print after uncertain outcome'
              : 'Authorize reprint'
            : jobAction?.action === 'cancel-job'
              ? 'Cancel print job'
              : 'Retry print job'}
        </DialogTitle>
        {jobAction && (
          <DialogContent dividers>
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                {jobAction.action === 'reprint-job'
                  ? hasUncertainPrintOutcome(jobAction.job)
                    ? `The printer may already have produced ${jobAction.job.globalId}. Inspect the physical printer first. This preserves that uncertain job and creates a new audited job with the same immutable document; a duplicate physical print is possible, but no additional carrier label or postage is purchased.`
                    : `This creates a new audited job from ${jobAction.job.globalId} without purchasing another carrier label.`
                  : jobAction.action === 'cancel-job'
                    ? `This fences ${jobAction.job.globalId} from further delivery. A claimed device may already have accepted the document.`
                    : `This requeues ${jobAction.job.globalId} within its existing bounded attempt limit.`}
              </Typography>
              <TextField
                fullWidth
                multiline
                minRows={3}
                label={jobAction.action === 'reprint-job'
                  ? hasUncertainPrintOutcome(jobAction.job)
                    ? 'Required duplicate-risk authorization reason'
                    : 'Reprint reason'
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
                ? hasUncertainPrintOutcome(jobAction.job)
                  ? 'Queue new print'
                  : 'Queue reprint'
                : jobAction?.action === 'cancel-job'
                  ? 'Cancel job'
                  : 'Queue retry'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={printAgentSetupReady && Boolean(pairingGrant?.pairingCode)}
        onClose={() => setPairingGrant(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Connect Print Agent</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Box>
              <Typography fontWeight={700}>
                {customerPrintAgentRelease
                  ? '1. Download and open the signed Print Agent'
                  : '1. Open the developer-only macOS helper'}
              </Typography>
              {customerPrintAgentRelease ? (
                <>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    Choose the installer for this computer. Only use the verified installer linked
                    here. The app is credential-free and never contains this workspace&apos;s pairing
                    code, printer IP, or ClawPilot session.
                  </Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }}>
                    {customerMacPrintAgent && (
                      <CustomerPrintAgentDownloadButton artifact={customerMacPrintAgent} />
                    )}
                    {customerWindowsPrintAgent && (
                      <CustomerPrintAgentDownloadButton artifact={customerWindowsPrintAgent} />
                    )}
                  </Stack>
                </>
              ) : (
                <>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    This unsigned preview is for a controlled development Mac only and is not a
                    customer installer. Do not bypass or disable Gatekeeper on an operator Mac.
                  </Typography>
                  <Box sx={{ mt: 1 }}><DeveloperPrintAgentDownloadButton /></Box>
                  <Box sx={{ mt: 0.75 }}>
                    <PrintAgentDistributionFacts manifest={printAgentDistribution} />
                  </Box>
                </>
              )}
            </Box>
            <Divider />
            <Box>
              <Typography fontWeight={700}>2. Enter the local Zebra connection</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                In the Print Agent choose Pair workspace. Confirm the trusted ClawPilot site, then
                enter the printer&apos;s private network IPv4 address and raw port 9100. The app probes
                reachability without sending printer bytes or claiming a job. The endpoint remains
                only in this computer&apos;s protected per-user app data and is never sent to ClawPilot.
              </Typography>
            </Box>
            <Divider />
            <Box>
              <Typography fontWeight={700}>3. Copy the one-time pairing code</Typography>
              <Alert severity="warning" sx={{ mt: 1 }}>
                One-time pairing code: this short-lived code is shown once and expires{' '}
                {timestamp(pairingGrant?.expiresAt || null)}. If it is lost or expires, create a
                new pairing code; the prior code cannot be recovered.
              </Alert>
              <Box
                component="pre"
                sx={{
                  mt: 1,
                  mb: 1,
                  p: 1.5,
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: '6px',
                  overflowWrap: 'anywhere',
                  whiteSpace: 'pre-wrap',
                  fontSize: '0.8rem',
                }}
              >
                {pairingGrant?.pairingCode}
              </Box>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ContentCopyRounded />}
                onClick={() => {
                  if (pairingGrant?.pairingCode) {
                    void navigator.clipboard.writeText(pairingGrant.pairingCode)
                  }
                }}
              >
                Copy pairing code
              </Button>
            </Box>
            <Divider />
            <Box>
              <Typography fontWeight={700}>4. Finish pairing in the Print Agent</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {customerPrintAgentRelease
                  ? 'Paste the one-time cppair code only into the signed app. It redeems the code and stores the long-lived credential using macOS Keychain or Windows protected storage, never in the installer or a command line.'
                  : 'Paste the one-time cppair code only into the developer helper on this controlled Mac. It redeems the code and stores the long-lived credential in macOS Keychain, never in the download or a command line.'}
              </Typography>
            </Box>
            <Box>
              <Typography fontWeight={700}>5. Verify and finish setup in ClawPilot</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Return to Agents to confirm Connected, then use Printers to create the logical
                printer profile, assign this agent, and choose its document routing. Use Test
                connection in the local app any time to probe the same IP/9100 endpoint without
                printing or claiming a job. Leave the computer on and signed in for background
                printing.
              </Typography>
              <Button
                size="small"
                variant="text"
                startIcon={<PrintRounded />}
                onClick={() => {
                  setPairingGrant(null)
                  setView('printers')
                }}
                sx={{ mt: 0.5 }}
              >
                Configure printers
              </Button>
            </Box>
            <Divider />
            {ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW && (
              <Box component="details">
                <Box component="summary" sx={{ cursor: 'pointer', fontWeight: 700 }}>
                  Advanced terminal pairing
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Repository checkouts can run the guided pairing command. It prompts locally for
                  the code and printer endpoint; neither value is placed in the command.
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    mt: 1,
                    mb: 1,
                    p: 1.5,
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: '6px',
                    overflowWrap: 'anywhere',
                    whiteSpace: 'pre-wrap',
                    fontSize: '0.8rem',
                  }}
                >
                  {pairingCommand}
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ContentCopyRounded />}
                  onClick={() => void navigator.clipboard.writeText(pairingCommand)}
                >
                  Copy Mac pairing command
                </Button>
              </Box>
            )}
            <Box>
              <Typography fontWeight={700}>Pair another workspace</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Keep the installed app. Switch workspaces in ClawPilot, create a new pairing code,
                then add another workspace in the Print Agent. The same physical printer may be
                used while each workspace retains its own authoritative agent identity, protected
                credential, delivery ledger, and logical printer profile.
              </Typography>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            startIcon={<RefreshRounded />}
            onClick={() => {
              setPairingGrant(null)
              void load()
            }}
          >
            Refresh connection status
          </Button>
          <Button variant="contained" onClick={() => setPairingGrant(null)}>Done</Button>
        </DialogActions>
      </Dialog>
      <BarcodeLabelsDialog
        open={barcodeLabelsOpen}
        onClose={() => setBarcodeLabelsOpen(false)}
      />
    </Box>
  )
}
