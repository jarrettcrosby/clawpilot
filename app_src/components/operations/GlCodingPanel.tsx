'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import UploadFileRounded from '@mui/icons-material/UploadFileRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type GlCodingCapabilities = {
  canReconcileCarrierBilling?: boolean
  canManageNetworks?: boolean
  canRun?: boolean
  canRunGlCoding?: boolean
  canAssign?: boolean
  canAssignOrphans?: boolean
  canCreateRules?: boolean
  canManageRules?: boolean
  canApproveCarrierSettlement?: boolean
}

type GlCodingBatch = {
  globalId: string
  provider?: string | null
  environment?: string | null
  sourceFilename?: string | null
  filename?: string | null
  status?: string | null
  acceptedRowCount?: number
  importedRowCount?: number
  chargeCount?: number
  rejectedRowCount?: number
  receivedAt?: string | null
  selectable?: boolean
}

type GlCodingRun = {
  globalId: string
  status?: string | null
  selectedBatchCount?: number
  selectedChargeCount?: number
  shipmentMatchedCount?: number
  shipperAssignedCount?: number
  orphanCount?: number
  excludedCount?: number
  errorCount?: number
  requestedAt?: string | null
  completedAt?: string | null
  errorSummary?: string | null
  review?: {
    globalId: string
    decision?: 'approved' | 'rejected' | null
    reason?: string | null
    reviewedBy?: string | null
    reviewedAt?: string | null
  } | null
}

type GlCodingOrphan = {
  chargeGlobalId: string
  externalChargeId?: string | null
  provider?: string | null
  trackingNumber?: string | null
  category?: string | null
  chargeCategory?: string | null
  amountMinor?: string | number | null
  currency?: string | null
  shipmentMatchStatus?: string | null
  shipperAssignmentStatus?: string | null
  explanation?: string | null
}

type GlCodingRule = {
  globalId: string
  name: string
  priority?: number
  matchMode?: string | null
  conditions?: Record<string, unknown>
  outputs?: Record<string, unknown>
  targetShipperPartyGlobalId?: string | null
  targetShipperName?: string | null
  targetShipperDisplayName?: string | null
  shipperName?: string | null
  versionNumber?: number
  status?: string | null
  effectiveFrom?: string | null
}

type GlCodingShipper = {
  globalId: string
  displayName?: string | null
  name?: string | null
}

type GlCodingSettlement = {
  globalId: string
  settlementType?: string | null
  role?: string | null
  amountMinor?: string | number | null
  sourceChargeAmountMinor?: string | number | null
  currency?: string | null
  currentStatus?: string | null
  payerName?: string | null
  payerGlobalId?: string | null
  payeeName?: string | null
  payeeGlobalId?: string | null
  chargeGlobalId?: string | null
  sourceGlobalId?: string | null
  actorEmail?: string | null
  occurredAt?: string | null
  codingOutputs?: Record<string, unknown>
  latestEvent?: {
    globalId: string
    details?: Record<string, unknown>
    actorEmail?: string | null
    occurredAt?: string | null
  } | null
}

type GlCodingMudCalculation = {
  globalId: string
  status: 'not_configured' | 'calculated' | 'blocked'
  blockerCode?: string | null
  statementGlobalId: string
  statementVersion: number
  shipmentGlobalId: string
  orderGlobalId: string
  shipperGlobalId: string
  shipperName: string
  quoteSnapshotGlobalId: string
  contractVersionGlobalId?: string | null
  contractVersionNumber?: number | null
  commerceOrderCandidateGlobalId?: string | null
  currency: string
  checkoutChargeStatus: string
  customerPaidCheckoutShippingMinor?: string | number | null
  carrierBilledActualMinor: string | number
  mudAdjustmentMinor?: string | number | null
  contractBilledShippingMinor?: string | number | null
  checkoutToCarrierActualVarianceMinor?: string | number | null
  checkoutToContractBillVarianceMinor?: string | number | null
  chargeCount: number
  directiveSnapshot?: Array<Record<string, unknown>>
  calculationSnapshot?: Record<string, unknown>
  createdAt?: string | null
}

type GlCodingWorkspace = {
  capabilities: GlCodingCapabilities
  batches: GlCodingBatch[]
  runs: GlCodingRun[]
  orphans: GlCodingOrphan[]
  rules: GlCodingRule[]
  shippers: GlCodingShipper[]
  settlements: GlCodingSettlement[]
  mudCalculations: GlCodingMudCalculation[]
}

type GlCodingPayload = {
  ok?: boolean
  error?: string
  glCoding?: Partial<GlCodingWorkspace>
}

type OrphanDraft = {
  shipperPartyGlobalId: string
  reason: string
}

type SettlementEventType =
  | 'approved'
  | 'billed'
  | 'paid'
  | 'disputed'
  | 'resolved'
  | 'reversed'
  | 'voided'

type SettlementDraft = {
  eventType: SettlementEventType | ''
  reason: string
  reference: string
}

type RuleForm = {
  name: string
  priority: string
  matchMode: 'all' | 'any'
  conditions: string
  outputs: string
  targetShipperPartyGlobalId: string
  effectiveFrom: string
}

const fieldSx = {
  minWidth: 0,
  '& .MuiInputBase-root': {
    borderRadius: '8px',
    backgroundColor: '#15151D',
  },
}

function emptyRuleForm(): RuleForm {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return {
    name: '',
    priority: '100',
    matchMode: 'all',
    conditions: '{\n  "clauses": [\n    { "field": "provider", "operator": "equals", "value": "" }\n  ]\n}',
    outputs: '{}',
    targetShipperPartyGlobalId: '',
    effectiveFrom: local.toISOString().slice(0, 16),
  }
}

function normalizeWorkspace(input: Partial<GlCodingWorkspace>): GlCodingWorkspace {
  return {
    capabilities: input.capabilities || {},
    batches: Array.isArray(input.batches) ? input.batches : [],
    runs: Array.isArray(input.runs) ? input.runs : [],
    orphans: Array.isArray(input.orphans) ? input.orphans : [],
    rules: Array.isArray(input.rules) ? input.rules : [],
    shippers: Array.isArray(input.shippers) ? input.shippers : [],
    settlements: Array.isArray(input.settlements) ? input.settlements : [],
    mudCalculations: Array.isArray(input.mudCalculations)
      ? input.mudCalculations
      : [],
  }
}

function displayStatus(value: string | null | undefined) {
  return (value || 'unknown')
    .replace(/[_.-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function statusColor(status: string | null | undefined): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (
    status === 'completed'
    || status === 'assigned'
    || status === 'ready'
    || status === 'approved'
    || status === 'paid'
    || status === 'resolved'
    || status === 'calculated'
  ) return 'success'
  if (status === 'failed' || status === 'rejected' || status === 'voided') return 'error'
  if (
    status === 'needs_review'
    || status === 'ambiguous'
    || status === 'disputed'
    || status === 'blocked'
  ) return 'warning'
  if (status === 'queued' || status === 'running' || status === 'billed') return 'info'
  return 'default'
}

function settlementActions(status: string | null | undefined): SettlementEventType[] {
  if (status === 'approved') return ['billed', 'paid', 'disputed', 'reversed', 'voided']
  if (status === 'billed') return ['paid', 'disputed', 'reversed', 'voided']
  if (status === 'disputed') return ['resolved', 'voided']
  if (status === 'resolved') return ['billed', 'paid', 'reversed', 'voided']
  if (status === 'accrued') return ['approved', 'voided']
  return []
}

function money(minor: string | number | null | undefined, currency = 'USD') {
  const code = /^[A-Z]{3}$/.test(currency.toUpperCase()) ? currency.toUpperCase() : 'USD'
  const exponent = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])
    .has(code)
    ? 0
    : new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']).has(code) ? 3 : 2
  const raw = String(minor ?? '0').trim()
  if (!/^-?\d+$/.test(raw)) return '—'
  try {
    const value = BigInt(raw)
    const negative = value < BigInt(0)
    const absolute = negative ? -value : value
    const scale = BigInt(10) ** BigInt(exponent)
    const major = absolute / scale
    const remainder = absolute % scale
    const formattedMajor = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(major)
    const fraction = exponent > 0
      ? `.${remainder.toString().padStart(exponent, '0')}`
      : ''
    return `${negative ? '-' : ''}${formattedMajor}${fraction}`
  } catch {
    return '—'
  }
}

function count(value: number | undefined) {
  return Number.isFinite(value) ? value : 0
}

function varianceMeaning(value: string | number | null | undefined) {
  const raw = String(value ?? '').trim()
  if (!/^-?\d+$/.test(raw)) return ''
  const minor = BigInt(raw)
  if (minor > BigInt(0)) return 'Customer paid more'
  if (minor < BigInt(0)) return 'Customer paid less'
  return 'No variance'
}

function capabilityAllows(
  capabilities: GlCodingCapabilities,
  names: Array<keyof GlCodingCapabilities>,
) {
  if (capabilities.canReconcileCarrierBilling === false) return false
  for (const name of names) {
    if (typeof capabilities[name] === 'boolean') return capabilities[name] === true
  }
  return true
}

function parseObject(value: string, label: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function objectSummary(value: Record<string, unknown> | undefined) {
  if (!value || Object.keys(value).length === 0) return 'None'
  return Object.entries(value)
    .slice(0, 3)
    .map(([key, item]) => `${displayStatus(key)}: ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`)
    .join(' · ')
}

function batchFilename(batch: GlCodingBatch) {
  return batch.sourceFilename || batch.filename || batch.globalId
}

function shipperName(shipper: GlCodingShipper) {
  return shipper.displayName || shipper.name || shipper.globalId
}

async function readPayload(response: Response): Promise<GlCodingPayload> {
  try {
    return await response.json() as GlCodingPayload
  } catch {
    return {
      ok: false,
      error: response.status === 404
        ? 'GL Coding is not available in this environment'
        : `GL Coding returned an invalid response (${response.status})`,
    }
  }
}

export default function GlCodingPanel({
  mode,
}: {
  mode: 'carrier-invoices' | 'shipment-pricing'
}) {
  const dateTime = useUserDateTime()
  const isShipmentPricing = mode === 'shipment-pricing'
  const [workspace, setWorkspace] = useState<GlCodingWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [assigningChargeId, setAssigningChargeId] = useState<string | null>(null)
  const [orphanDrafts, setOrphanDrafts] = useState<Record<string, OrphanDraft>>({})
  const [ruleForm, setRuleForm] = useState<RuleForm>(emptyRuleForm)
  const [creatingRule, setCreatingRule] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importProvider, setImportProvider] = useState<'ups' | 'fedex' | 'usps'>('ups')
  const [importEnvironment, setImportEnvironment] = useState<'production' | 'sandbox'>('production')
  const [importing, setImporting] = useState(false)
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({})
  const [reviewingRunId, setReviewingRunId] = useState<string | null>(null)
  const [settlementDrafts, setSettlementDrafts] = useState<Record<string, SettlementDraft>>({})
  const [updatingSettlementId, setUpdatingSettlementId] = useState<string | null>(null)
  const surfaceError = mode === 'carrier-invoices'
    ? error.replace(/^GL Coding/, 'Carrier invoicing')
    : error

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/operations/gl-coding', {
        cache: 'no-store',
        signal,
      })
      const payload = await readPayload(response)
      if (!response.ok || !payload.ok || !payload.glCoding) {
        throw new Error(payload.error || 'GL Coding data is unavailable')
      }
      const next = normalizeWorkspace(payload.glCoding)
      setWorkspace(next)
      setSelectedBatchIds((current) => {
        const available = new Set(next.batches.map((batch) => batch.globalId))
        return current.filter((globalId) => available.has(globalId))
      })
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'GL Coding data is unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const selectedProvider = useMemo(() => {
    const firstSelected = workspace?.batches.find((batch) => selectedBatchIds.includes(batch.globalId))
    return firstSelected?.provider || null
  }, [selectedBatchIds, workspace?.batches])
  const selectedEnvironment = useMemo(() => {
    const firstSelected = workspace?.batches.find((batch) => selectedBatchIds.includes(batch.globalId))
    return firstSelected?.environment || null
  }, [selectedBatchIds, workspace?.batches])

  const canRun = capabilityAllows(workspace?.capabilities || {}, ['canRunGlCoding', 'canRun'])
  const canAssign = capabilityAllows(workspace?.capabilities || {}, ['canAssignOrphans', 'canAssign'])
  const canCreateRules = workspace?.capabilities.canManageNetworks === true
    && capabilityAllows(workspace.capabilities, ['canCreateRules', 'canManageRules'])
  const canApproveCarrierSettlement =
    workspace?.capabilities.canApproveCarrierSettlement === true

  const toggleBatch = (batch: GlCodingBatch) => {
    setSelectedBatchIds((current) => (
      current.includes(batch.globalId)
        ? current.filter((globalId) => globalId !== batch.globalId)
        : [...current, batch.globalId]
    ))
  }

  const postAction = async (
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    const response = await fetch('/api/operations/gl-coding', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const payload = await readPayload(response)
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'The GL Coding action could not be completed')
    }
    return payload
  }

  const runSelected = async () => {
    if (!selectedBatchIds.length) return
    setRunning(true)
    setError('')
    setNotice('')
    try {
      const sortedIds = [...selectedBatchIds].sort()
      await postAction(
        { action: 'run-selected-files', batchGlobalIds: sortedIds },
        `operations-gl-run:${crypto.randomUUID()}`,
      )
      setSelectedBatchIds([])
      setNotice(`GL Coding completed for ${sortedIds.length} selected ${sortedIds.length === 1 ? 'file' : 'files'}.`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'GL Coding could not be run')
    } finally {
      setRunning(false)
    }
  }

  const updateOrphanDraft = (chargeGlobalId: string, update: Partial<OrphanDraft>) => {
    setOrphanDrafts((current) => {
      const previous = current[chargeGlobalId] || {
        shipperPartyGlobalId: '',
        reason: '',
      }
      return {
        ...current,
        [chargeGlobalId]: {
          ...previous,
          ...update,
        },
      }
    })
  }

  const assignOrphan = async (orphan: GlCodingOrphan) => {
    const draft = orphanDrafts[orphan.chargeGlobalId]
    if (!draft?.shipperPartyGlobalId || !draft.reason.trim()) return
    setAssigningChargeId(orphan.chargeGlobalId)
    setError('')
    setNotice('')
    try {
      await postAction(
        {
          action: 'assign-orphan',
          chargeGlobalId: orphan.chargeGlobalId,
          shipperPartyGlobalId: draft.shipperPartyGlobalId,
          reason: draft.reason.trim(),
        },
        `operations-gl-orphan:${orphan.chargeGlobalId}:${crypto.randomUUID()}`,
      )
      setOrphanDrafts((current) => {
        const next = { ...current }
        delete next[orphan.chargeGlobalId]
        return next
      })
      setNotice(`Charge ${orphan.chargeGlobalId} was assigned.`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The orphan charge could not be assigned')
    } finally {
      setAssigningChargeId(null)
    }
  }

  const createRule = async (event: FormEvent) => {
    event.preventDefault()
    setCreatingRule(true)
    setError('')
    setNotice('')
    try {
      const priority = Number(ruleForm.priority)
      if (!Number.isInteger(priority)) throw new Error('Priority must be a whole number')
      const conditions = parseObject(ruleForm.conditions, 'Conditions')
      const outputs = parseObject(ruleForm.outputs, 'Outputs')
      await postAction(
        {
          action: 'create-rule',
          name: ruleForm.name.trim(),
          priority,
          matchMode: ruleForm.matchMode,
          conditions,
          outputs,
          targetShipperPartyGlobalId: ruleForm.targetShipperPartyGlobalId,
          effectiveFrom: new Date(ruleForm.effectiveFrom).toISOString(),
        },
        `operations-gl-rule:${crypto.randomUUID()}`,
      )
      setRuleForm(emptyRuleForm())
      setNotice('The GL Coding rule was created.')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The GL Coding rule could not be created')
    } finally {
      setCreatingRule(false)
    }
  }

  const importBillingFile = async () => {
    if (!importFile) return
    setImporting(true)
    setError('')
    setNotice('')
    try {
      const form = new FormData()
      form.append('file', importFile)
      form.append('provider', importProvider)
      form.append('environment', importEnvironment)
      const response = await fetch('/api/operations/carrier-billing/import', {
        method: 'POST',
        body: form,
      })
      const payload = await readPayload(response)
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'The carrier billing file could not be imported')
      }
      const importedFilename = importFile.name
      setImportFile(null)
      setNotice(`${importedFilename} was imported and is ready for GL Coding.`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The carrier billing file could not be imported')
    } finally {
      setImporting(false)
    }
  }

  const reviewRun = async (
    run: GlCodingRun,
    decision: 'approved' | 'rejected',
  ) => {
    const reason = String(reviewReasons[run.globalId] || '').trim()
    if (!reason) return
    setReviewingRunId(run.globalId)
    setError('')
    setNotice('')
    try {
      await postAction(
        {
          action: 'review-run',
          runGlobalId: run.globalId,
          decision,
          reason,
        },
        `operations-gl-review:${run.globalId}:${crypto.randomUUID()}`,
      )
      setReviewReasons((current) => {
        const next = { ...current }
        delete next[run.globalId]
        return next
      })
      setNotice(
        decision === 'approved'
          ? `${run.globalId} was approved and its billed-actual settlements were accrued.`
          : `${run.globalId} was rejected with a recorded reason.`,
      )
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The GL Coding run could not be reviewed')
    } finally {
      setReviewingRunId(null)
    }
  }

  const updateSettlementDraft = (
    settlementGlobalId: string,
    update: Partial<SettlementDraft>,
  ) => {
    setSettlementDrafts((current) => {
      const previous = current[settlementGlobalId] || {
        eventType: '',
        reason: '',
        reference: '',
      }
      return {
        ...current,
        [settlementGlobalId]: {
          ...previous,
          ...update,
        },
      }
    })
  }

  const recordSettlementEvent = async (settlement: GlCodingSettlement) => {
    const draft = settlementDrafts[settlement.globalId]
    if (!draft?.eventType || !draft.reason.trim()) return
    if (
      (draft.eventType === 'billed' || draft.eventType === 'paid')
      && !draft.reference.trim()
    ) return
    setUpdatingSettlementId(settlement.globalId)
    setError('')
    setNotice('')
    try {
      await postAction(
        {
          action: 'record-settlement-event',
          settlementGlobalId: settlement.globalId,
          eventType: draft.eventType,
          reason: draft.reason.trim(),
          reference: draft.reference.trim(),
        },
        `operations-settlement-event:${settlement.globalId}:${crypto.randomUUID()}`,
      )
      setSettlementDrafts((current) => {
        const next = { ...current }
        delete next[settlement.globalId]
        return next
      })
      setNotice(
        `${settlement.globalId} is now ${displayStatus(draft.eventType).toLowerCase()}.`,
      )
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The settlement could not be updated')
    } finally {
      setUpdatingSettlementId(null)
    }
  }

  const runReviewPanel = (run: GlCodingRun) => {
    if (run.review) {
      return (
        <Alert
          severity={run.review.decision === 'approved' ? 'success' : 'warning'}
          sx={{ mt: 1.25 }}
        >
          <Typography variant="body2" fontWeight={700}>
            {displayStatus(run.review.decision)} by {run.review.reviewedBy || 'an authorized reviewer'}
          </Typography>
          <Typography variant="body2">{run.review.reason || 'No review reason was recorded.'}</Typography>
          {run.review.reviewedAt && (
            <Typography variant="caption" color="text.secondary">
              {formatUserDateTime(run.review.reviewedAt, dateTime, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                fallback: '',
              })}
            </Typography>
          )}
        </Alert>
      )
    }
    if (!['completed', 'needs_review'].includes(String(run.status || ''))) return null
    if (!canApproveCarrierSettlement) {
      return (
        <Alert severity="info" sx={{ mt: 1.25 }}>
          Settlement approval permission is required to review this run.
        </Alert>
      )
    }
    const reason = reviewReasons[run.globalId] || ''
    const busy = reviewingRunId === run.globalId
    const approvable =
      run.status === 'completed'
      && count(run.orphanCount) === 0
      && count(run.errorCount) === 0
    return (
      <Box sx={{ mt: 1.25 }}>
        <TextField
          fullWidth
          size="small"
          label="Review reason"
          value={reason}
          onChange={(event) => setReviewReasons((current) => ({
            ...current,
            [run.globalId]: event.target.value,
          }))}
          disabled={busy}
          inputProps={{ maxLength: 1_000 }}
          sx={fieldSx}
        />
        {!approvable && (
          <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.75 }}>
            Approval is available only after the run completes with no orphan or error items. Rejection remains
            available so the file can be corrected and rerun.
          </Typography>
        )}
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Button
            variant="contained"
            color="success"
            disabled={busy || !approvable || !reason.trim()}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
            onClick={() => void reviewRun(run, 'approved')}
          >
            Approve actuals
          </Button>
          <Button
            variant="outlined"
            color="warning"
            disabled={busy || !reason.trim()}
            onClick={() => void reviewRun(run, 'rejected')}
          >
            Reject run
          </Button>
        </Stack>
      </Box>
    )
  }

  if (loading && !workspace) {
    return <Box sx={{ minHeight: 280, display: 'grid', placeItems: 'center' }}><CircularProgress size={30} /></Box>
  }

  if (!workspace) {
    return (
      <Box sx={{ px: { xs: 2, md: 3 }, py: 3 }}>
        <Alert
          severity="error"
          action={(
            <Button color="inherit" size="small" onClick={() => void load()} disabled={loading}>
              Retry
            </Button>
          )}
        >
          {surfaceError || (
            mode === 'carrier-invoices'
              ? 'Carrier invoicing data is unavailable'
              : 'Shipment pricing and GL data is unavailable'
          )}
        </Alert>
      </Box>
    )
  }

  const latestRun = workspace?.runs[0]

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, py: 2.5, minWidth: 0 }}>
      <Stack spacing={3} divider={<Divider flexItem />}>
        <Alert severity="info">
          {isShipmentPricing
            ? 'MUD means Markup Directive. Checkout shipping is a customer-facing pro forma charge, not MUD; ClawPilot classifies it as customer-paid only when the commerce order has complete paid evidence. An approved actual-cost MUD is calculated only after an uploaded carrier bill is matched to the exact shipment, then billed actual, MUD, contract bill, and checkout variance remain separate immutable evidence.'
            : 'Carrier files may include several account numbers. ClawPilot preserves each source file, matches actual charges by provider, account, and tracking evidence, and leaves unsupported rows in review instead of inventing a shipment match.'}
        </Alert>
        <Box component="section">
          <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2} sx={{ mb: 1.5 }}>
            <Box>
              <Typography variant="h6" fontWeight={700}>
                {isShipmentPricing ? 'Billing files ready for pricing review' : 'Carrier billing files'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {workspace?.batches.length || 0} available
                {isShipmentPricing ? ' · select compatible files to begin GL Coding' : ' · immutable imported evidence'}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1}>
              <Tooltip title={isShipmentPricing ? 'Refresh shipment pricing and GL' : 'Refresh carrier invoices'}>
                <span>
                  <IconButton
                    aria-label={isShipmentPricing ? 'Refresh shipment pricing and GL' : 'Refresh carrier invoices'}
                    onClick={() => void load()}
                    disabled={loading}
                  >
                    {loading ? <CircularProgress size={20} /> : <RefreshRounded />}
                  </IconButton>
                </span>
              </Tooltip>
              {isShipmentPricing && (
                <Button
                  variant="contained"
                  startIcon={running ? <CircularProgress size={16} color="inherit" /> : <PlayArrowRounded />}
                  disabled={!canRun || running || selectedBatchIds.length === 0}
                  onClick={() => void runSelected()}
                >
                  {running ? 'Running' : 'Run Shipment GL Coding'}
                </Button>
              )}
            </Stack>
          </Stack>

          {surfaceError && (
            <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1.5 }}>
              {surfaceError}
            </Alert>
          )}
          {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 1.5 }}>{notice}</Alert>}
          {!canRun && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              You do not have permission to import carrier invoices or run shipment pricing reconciliation.
            </Alert>
          )}

          {!isShipmentPricing && (
            <Box
              sx={{
                mb: 2,
                p: 1.5,
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '8px',
              }}
            >
              <Typography fontWeight={700}>Import carrier billing CSV</Typography>
              <Typography variant="caption" color="text.secondary">
                One file may include one or many account numbers. Account values are fingerprinted and masked before
                evidence is stored.
              </Typography>
              <Box
                sx={{
                  mt: 1.25,
                  display: 'grid',
                  gridTemplateColumns: {
                    xs: 'minmax(0, 1fr)',
                    sm: 'minmax(130px, 0.6fr) minmax(150px, 0.7fr) minmax(0, 1.5fr) auto',
                  },
                  gap: 1,
                  alignItems: 'center',
                }}
              >
                <TextField
                  select
                  size="small"
                  label="Carrier"
                  value={importProvider}
                  onChange={(event) => setImportProvider(event.target.value as 'ups' | 'fedex' | 'usps')}
                  disabled={!canRun || importing}
                  sx={fieldSx}
                >
                  <MenuItem value="ups">UPS</MenuItem>
                  <MenuItem value="fedex">FedEx</MenuItem>
                  <MenuItem value="usps">USPS</MenuItem>
                </TextField>
                <TextField
                  select
                  size="small"
                  label="Environment"
                  value={importEnvironment}
                  onChange={(event) => setImportEnvironment(event.target.value as 'production' | 'sandbox')}
                  disabled={!canRun || importing}
                  sx={fieldSx}
                >
                  <MenuItem value="production">Production</MenuItem>
                  <MenuItem value="sandbox">Sandbox</MenuItem>
                </TextField>
                <Button
                  component="label"
                  variant="outlined"
                  startIcon={<UploadFileRounded />}
                  disabled={!canRun || importing}
                  sx={{ minWidth: 0, justifyContent: 'flex-start', overflow: 'hidden' }}
                >
                  <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {importFile?.name || 'Choose CSV'}
                  </Box>
                  <input
                    hidden
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => setImportFile(event.target.files?.[0] || null)}
                  />
                </Button>
                <Button
                  variant="contained"
                  disabled={!canRun || importing || !importFile}
                  startIcon={importing ? <CircularProgress size={16} color="inherit" /> : <UploadFileRounded />}
                  onClick={() => void importBillingFile()}
                >
                  {importing ? 'Importing' : 'Import'}
                </Button>
              </Box>
            </Box>
          )}

          {workspace?.batches.length ? (
            <Stack divider={<Divider flexItem />}>
              {workspace.batches.map((batch) => {
                const providerConflict = Boolean(
                  selectedProvider
                  && batch.provider
                  && batch.provider !== selectedProvider
                  && !selectedBatchIds.includes(batch.globalId),
                )
                const environmentConflict = Boolean(
                  selectedEnvironment
                  && batch.environment
                  && batch.environment !== selectedEnvironment
                  && !selectedBatchIds.includes(batch.globalId),
                )
                const disabled = batch.selectable === false
                  || providerConflict
                  || environmentConflict
                  || running
                  || !canRun
                return (
                  <Box
                    key={batch.globalId}
                    sx={{
                      py: 1.25,
                      display: 'grid',
                      gridTemplateColumns: isShipmentPricing
                        ? 'auto minmax(0, 1fr) auto'
                        : 'minmax(0, 1fr) auto',
                      gap: 1.25,
                      alignItems: 'center',
                      cursor: isShipmentPricing && !disabled ? 'pointer' : 'default',
                    }}
                  >
                    {isShipmentPricing && (
                      <Checkbox
                        checked={selectedBatchIds.includes(batch.globalId)}
                        onChange={() => toggleBatch(batch)}
                        disabled={disabled}
                        inputProps={{ 'aria-label': `Select billing file ${batchFilename(batch)}` }}
                      />
                    )}
                    <Box sx={{ minWidth: 0 }}>
                      <Typography fontWeight={650} sx={{ overflowWrap: 'anywhere' }}>{batchFilename(batch)}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                        {[batch.provider, batch.environment, batch.globalId, batch.receivedAt
                          ? formatUserDateTime(batch.receivedAt, dateTime, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            fallback: '',
                          })
                          : ''].filter(Boolean).join(' · ')}
                      </Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right' }}>
                      <Chip size="small" label={displayStatus(batch.status)} color={statusColor(batch.status)} />
                      <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
                        {count(batch.chargeCount ?? batch.acceptedRowCount ?? batch.importedRowCount)} charges
                        {count(batch.rejectedRowCount) ? ` · ${count(batch.rejectedRowCount)} rejected` : ''}
                      </Typography>
                    </Box>
                  </Box>
                )
              })}
            </Stack>
          ) : (
            <Typography color="text.secondary">No billing files are available.</Typography>
          )}
        </Box>

        {isShipmentPricing && (
          <>
        <Box component="section">
          <Typography variant="h6" fontWeight={700} sx={{ mb: 1.5 }}>Run summary</Typography>
          {latestRun ? (
            <>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Chip size="small" label={displayStatus(latestRun.status)} color={statusColor(latestRun.status)} />
                <Typography fontWeight={650}>{latestRun.globalId}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatUserDateTime(latestRun.completedAt || latestRun.requestedAt, dateTime, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    fallback: '',
                  })}
                </Typography>
              </Stack>
              <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5 }}>
                <Box><Typography variant="caption" color="text.secondary">Files</Typography><Typography fontWeight={700}>{count(latestRun.selectedBatchCount)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Charges</Typography><Typography fontWeight={700}>{count(latestRun.selectedChargeCount)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Matched</Typography><Typography fontWeight={700}>{count(latestRun.shipmentMatchedCount)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Assigned</Typography><Typography fontWeight={700}>{count(latestRun.shipperAssignedCount)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Orphans</Typography><Typography fontWeight={700} color={count(latestRun.orphanCount) ? 'warning.main' : 'text.primary'}>{count(latestRun.orphanCount)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Excluded</Typography><Typography fontWeight={700}>{count(latestRun.excludedCount)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Errors</Typography><Typography fontWeight={700} color={count(latestRun.errorCount) ? 'error.main' : 'text.primary'}>{count(latestRun.errorCount)}</Typography></Box>
              </Box>
              {latestRun.errorSummary && <Alert severity="error" sx={{ mt: 1.5 }}>{latestRun.errorSummary}</Alert>}
              {runReviewPanel(latestRun)}
              {workspace.runs.length > 1 && (
                <Stack divider={<Divider flexItem />} sx={{ mt: 1.5 }}>
                  {workspace.runs.slice(1, 6).map((run) => (
                    <Box key={run.globalId} sx={{ py: 1 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={650}>{run.globalId}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {count(run.selectedChargeCount)} charges · {count(run.orphanCount)} orphans
                          </Typography>
                        </Box>
                        <Chip size="small" label={displayStatus(run.status)} color={statusColor(run.status)} />
                      </Stack>
                      {runReviewPanel(run)}
                    </Box>
                  ))}
                </Stack>
              )}
            </>
          ) : (
            <Typography color="text.secondary">No GL Coding runs have been recorded.</Typography>
          )}
        </Box>

        {isShipmentPricing && (
          <Box component="section">
            <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={2} sx={{ mb: 1.5 }}>
              <Box>
                <Typography variant="h6" fontWeight={700}>Billing-time MUD</Typography>
                <Typography variant="caption" color="text.secondary">
                  Uploaded carrier bill → exact shipment match → approved actual-cost directive → immutable contract bill.
                </Typography>
              </Box>
              <Typography variant="caption" color="text.secondary">
                {workspace.mudCalculations.length} results
              </Typography>
            </Stack>
            {workspace.mudCalculations.length ? (
              <Stack spacing={1.5}>
                {workspace.mudCalculations.map((calculation) => {
                  const configured = calculation.status === 'calculated'
                  const configurationReason = String(
                    calculation.calculationSnapshot?.configurationReason || '',
                  )
                  const checkoutAvailable =
                    calculation.checkoutChargeStatus === 'customer_paid'
                  const directives = calculation.directiveSnapshot || []
                  return (
                    <Box
                      key={calculation.globalId}
                      sx={{
                        p: 1.5,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 2,
                      }}
                    >
                      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
                        <Box sx={{ minWidth: 0 }}>
                          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                            <Typography fontWeight={700}>{calculation.shipmentGlobalId}</Typography>
                            <Chip
                              size="small"
                              label={displayStatus(calculation.status)}
                              color={statusColor(calculation.status)}
                            />
                            <Chip
                              size="small"
                              variant="outlined"
                              label={`${calculation.chargeCount} billed ${calculation.chargeCount === 1 ? 'line' : 'lines'}`}
                            />
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                            {calculation.orderGlobalId}
                            {' · '}
                            {calculation.statementGlobalId} v{calculation.statementVersion}
                            {' · '}
                            {calculation.shipperName}
                          </Typography>
                        </Box>
                        {calculation.createdAt && (
                          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                            {formatUserDateTime(calculation.createdAt, dateTime, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}
                          </Typography>
                        )}
                      </Stack>

                      <Alert
                        severity={configured ? 'success' : calculation.status === 'blocked' ? 'warning' : 'info'}
                        sx={{ mt: 1.25 }}
                      >
                        {configured
                          ? 'MUD was calculated from billed actual using the exact approved contract directive version shown below.'
                          : calculation.status === 'blocked'
                            ? `MUD was not calculated because the evidence failed closed: ${displayStatus(calculation.blockerCode || configurationReason)}.`
                            : 'No approved actual-cost MUD directive matched this billed shipment. The carrier actual is preserved, but no MUD or contract bill was created.'}
                      </Alert>

                      <Box
                        sx={{
                          mt: 1.25,
                          display: 'grid',
                          gridTemplateColumns: {
                            xs: 'minmax(0, 1fr)',
                            sm: 'repeat(2, minmax(0, 1fr))',
                            lg: 'repeat(3, minmax(0, 1fr))',
                          },
                          gap: 1,
                        }}
                      >
                        <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
                          <Typography variant="caption" color="text.secondary">Customer-paid checkout shipping</Typography>
                          <Typography fontWeight={750}>
                            {checkoutAvailable
                              ? money(calculation.customerPaidCheckoutShippingMinor, calculation.currency)
                              : 'Unavailable'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {checkoutAvailable
                              ? 'Captured commerce-order evidence'
                              : displayStatus(calculation.checkoutChargeStatus)}
                          </Typography>
                        </Box>
                        <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
                          <Typography variant="caption" color="text.secondary">Carrier billed actual</Typography>
                          <Typography fontWeight={750}>
                            {money(calculation.carrierBilledActualMinor, calculation.currency)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">From uploaded billing CSV</Typography>
                        </Box>
                        <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
                          <Typography variant="caption" color="text.secondary">MUD adjustment</Typography>
                          <Typography fontWeight={750}>
                            {configured
                              ? money(calculation.mudAdjustmentMinor, calculation.currency)
                              : 'Not calculated'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">Applied only at billing time</Typography>
                        </Box>
                        <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
                          <Typography variant="caption" color="text.secondary">Contract-billed shipping</Typography>
                          <Typography fontWeight={750}>
                            {configured
                              ? money(calculation.contractBilledShippingMinor, calculation.currency)
                              : 'Not created'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">Carrier actual + MUD</Typography>
                        </Box>
                        <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
                          <Typography variant="caption" color="text.secondary">Checkout vs carrier actual</Typography>
                          <Typography fontWeight={750}>
                            {checkoutAvailable
                              ? money(calculation.checkoutToCarrierActualVarianceMinor, calculation.currency)
                              : 'Unavailable'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {varianceMeaning(calculation.checkoutToCarrierActualVarianceMinor)}
                          </Typography>
                        </Box>
                        <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
                          <Typography variant="caption" color="text.secondary">Checkout vs contract bill</Typography>
                          <Typography fontWeight={750}>
                            {checkoutAvailable && configured
                              ? money(calculation.checkoutToContractBillVarianceMinor, calculation.currency)
                              : 'Unavailable'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {varianceMeaning(calculation.checkoutToContractBillVarianceMinor)}
                          </Typography>
                        </Box>
                      </Box>

                      {calculation.checkoutChargeStatus === 'unallocated_multi_shipment' && (
                        <Alert severity="info" sx={{ mt: 1.25 }}>
                          Checkout shipping is order-level and this order has multiple shipments. ClawPilot did not invent a per-shipment allocation.
                        </Alert>
                      )}
                      {directives.length > 0 && (
                        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1.25 }}>
                          {directives.map((directive, index) => (
                            <Chip
                              key={`${String(directive.directiveGlobalId || 'directive')}-${index}`}
                              size="small"
                              variant="outlined"
                              label={[
                                String(directive.directiveGlobalId || 'Directive'),
                                directive.versionNumber ? `v${String(directive.versionNumber)}` : '',
                                displayStatus(String(directive.type || '')),
                              ].filter(Boolean).join(' · ')}
                            />
                          ))}
                        </Stack>
                      )}
                    </Box>
                  )
                })}
              </Stack>
            ) : (
              <Alert severity="info">
                No billing-time MUD results yet. Import a carrier billing CSV, run GL Coding, resolve every shipment match and shipper assignment, then approve the run. Unmatched rows never produce a MUD calculation.
              </Alert>
            )}
          </Box>
        )}

        <Box component="section">
          <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={2} sx={{ mb: 1.5 }}>
            <Box>
              <Typography variant="h6" fontWeight={700}>Settlement ledger</Typography>
              <Typography variant="caption" color="text.secondary">
                Approved billed actuals and contract charges, with append-only lifecycle evidence.
              </Typography>
            </Box>
            <Typography variant="caption" color="text.secondary">
              {workspace.settlements.length} entries
            </Typography>
          </Stack>
          {workspace.settlements.length ? (
            <Stack divider={<Divider flexItem />}>
              {workspace.settlements.map((settlement) => {
                const actions = settlementActions(settlement.currentStatus)
                const draft = settlementDrafts[settlement.globalId] || {
                  eventType: '',
                  reason: '',
                  reference: '',
                }
                const busy = updatingSettlementId === settlement.globalId
                const referenceRequired =
                  draft.eventType === 'billed'
                  || draft.eventType === 'paid'
                const canSubmit =
                  canApproveCarrierSettlement
                  && !busy
                  && Boolean(draft.eventType)
                  && Boolean(draft.reason.trim())
                  && (!referenceRequired || Boolean(draft.reference.trim()))
                const latestReason = String(settlement.latestEvent?.details?.reason || '').trim()
                const latestReference = String(settlement.latestEvent?.details?.reference || '').trim()
                const codingOutputs = Object.entries(settlement.codingOutputs || {})
                  .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
                return (
                  <Box key={settlement.globalId} sx={{ py: 1.5 }}>
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1.5fr) auto' },
                        gap: 1,
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography fontWeight={700}>{settlement.globalId}</Typography>
                          <Chip
                            size="small"
                            label={displayStatus(settlement.currentStatus)}
                            color={statusColor(settlement.currentStatus)}
                          />
                          <Chip
                            size="small"
                            variant="outlined"
                            label={displayStatus(settlement.role || settlement.settlementType)}
                          />
                        </Stack>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          {settlement.payerName || settlement.payerGlobalId || 'Unknown payer'}
                          {' → '}
                          {settlement.payeeName || settlement.payeeGlobalId || 'Unknown payee'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                          {[settlement.chargeGlobalId, settlement.sourceGlobalId].filter(Boolean).join(' · ')}
                        </Typography>
                        {(latestReason || latestReference) && (
                          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                            {[latestReason, latestReference ? `Reference ${latestReference}` : ''].filter(Boolean).join(' · ')}
                          </Typography>
                        )}
                        {codingOutputs.length > 0 && (
                          <Stack
                            direction="row"
                            spacing={0.75}
                            flexWrap="wrap"
                            useFlexGap
                            sx={{ mt: 0.75 }}
                          >
                            {codingOutputs.map(([key, value]) => (
                              <Chip
                                key={key}
                                size="small"
                                variant="outlined"
                                label={`${displayStatus(key)}: ${String(value)}`}
                              />
                            ))}
                          </Stack>
                        )}
                      </Box>
                      <Box sx={{ textAlign: { xs: 'left', md: 'right' } }}>
                        <Typography fontWeight={750}>
                          {money(settlement.amountMinor, settlement.currency || 'USD')}
                        </Typography>
                        {settlement.sourceChargeAmountMinor !== null
                          && settlement.sourceChargeAmountMinor !== undefined && (
                          <Typography variant="caption" color="text.secondary">
                            Source charge {money(
                              settlement.sourceChargeAmountMinor,
                              settlement.currency || 'USD',
                            )}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                    {actions.length > 0 && (
                      <Box
                        sx={{
                          mt: 1.25,
                          display: 'grid',
                          gridTemplateColumns: {
                            xs: 'minmax(0, 1fr)',
                            md: 'minmax(150px, 0.6fr) minmax(220px, 1.2fr) minmax(180px, 0.8fr) auto',
                          },
                          gap: 1,
                        }}
                      >
                        <TextField
                          select
                          size="small"
                          label="Next status"
                          value={draft.eventType}
                          onChange={(event) => updateSettlementDraft(settlement.globalId, {
                            eventType: event.target.value as SettlementEventType,
                          })}
                          disabled={!canApproveCarrierSettlement || busy}
                          sx={fieldSx}
                        >
                          {actions.map((action) => (
                            <MenuItem key={action} value={action}>{displayStatus(action)}</MenuItem>
                          ))}
                        </TextField>
                        <TextField
                          size="small"
                          label="Reason"
                          value={draft.reason}
                          onChange={(event) => updateSettlementDraft(settlement.globalId, {
                            reason: event.target.value,
                          })}
                          disabled={!canApproveCarrierSettlement || busy}
                          inputProps={{ maxLength: 1_000 }}
                          sx={fieldSx}
                        />
                        <TextField
                          size="small"
                          required={referenceRequired}
                          label={referenceRequired ? 'Invoice or payment reference' : 'External reference'}
                          value={draft.reference}
                          onChange={(event) => updateSettlementDraft(settlement.globalId, {
                            reference: event.target.value,
                          })}
                          disabled={!canApproveCarrierSettlement || busy}
                          inputProps={{ maxLength: 200 }}
                          sx={fieldSx}
                        />
                        <Button
                          variant="outlined"
                          disabled={!canSubmit}
                          startIcon={busy ? <CircularProgress size={16} /> : undefined}
                          onClick={() => void recordSettlementEvent(settlement)}
                        >
                          {busy ? 'Recording' : 'Record'}
                        </Button>
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Stack>
          ) : (
            <Typography color="text.secondary">
              No settlement entries have been generated. Approve a completed GL Coding run to accrue billed actuals.
            </Typography>
          )}
        </Box>

        <Box component="section">
          <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={2} sx={{ mb: 1.5 }}>
            <Typography variant="h6" fontWeight={700}>Orphan queue</Typography>
            <Typography variant="caption" color="text.secondary">{workspace?.orphans.length || 0} unresolved</Typography>
          </Stack>
          {workspace?.orphans.length ? (
            <Stack divider={<Divider flexItem />}>
              {workspace.orphans.map((orphan) => {
                const draft = orphanDrafts[orphan.chargeGlobalId] || { shipperPartyGlobalId: '', reason: '' }
                const busy = assigningChargeId === orphan.chargeGlobalId
                return (
                  <Box key={orphan.chargeGlobalId} sx={{ py: 1.5 }}>
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' }, gap: 1 }}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography fontWeight={650}>{orphan.externalChargeId || orphan.chargeGlobalId}</Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                          {[orphan.provider, orphan.chargeGlobalId, orphan.trackingNumber ? `Tracking ${orphan.trackingNumber}` : 'No tracking number'].filter(Boolean).join(' · ')}
                        </Typography>
                      </Box>
                      <Box sx={{ textAlign: { xs: 'left', sm: 'right' } }}>
                        <Typography fontWeight={700}>{money(orphan.amountMinor, orphan.currency || 'USD')}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {displayStatus(orphan.chargeCategory || orphan.category)}
                          {' · '}
                          Shipment {displayStatus(orphan.shipmentMatchStatus)}
                          {' · '}
                          Shipper {displayStatus(orphan.shipperAssignmentStatus)}
                        </Typography>
                      </Box>
                    </Box>
                    {orphan.explanation && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{orphan.explanation}</Typography>}
                    <Box sx={{ mt: 1.25, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(180px, 0.8fr) minmax(240px, 1.4fr) auto' }, gap: 1 }}>
                      <TextField
                        select
                        size="small"
                        label="Shipper"
                        value={draft.shipperPartyGlobalId}
                        onChange={(event) => updateOrphanDraft(orphan.chargeGlobalId, { shipperPartyGlobalId: event.target.value })}
                        disabled={!canAssign || busy}
                        sx={fieldSx}
                      >
                        {workspace.shippers.map((shipper) => (
                          <MenuItem key={shipper.globalId} value={shipper.globalId}>{shipperName(shipper)}</MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        size="small"
                        label="Assignment reason"
                        value={draft.reason}
                        onChange={(event) => updateOrphanDraft(orphan.chargeGlobalId, { reason: event.target.value })}
                        disabled={!canAssign || busy}
                        inputProps={{ maxLength: 500 }}
                        sx={fieldSx}
                      />
                      <Button
                        variant="outlined"
                        disabled={!canAssign || busy || !draft.shipperPartyGlobalId || !draft.reason.trim()}
                        startIcon={busy ? <CircularProgress size={16} /> : undefined}
                        onClick={() => void assignOrphan(orphan)}
                      >
                        {busy ? 'Assigning' : 'Assign'}
                      </Button>
                    </Box>
                  </Box>
                )
              })}
            </Stack>
          ) : (
            <Typography color="text.secondary">No orphan charges require assignment.</Typography>
          )}
        </Box>

        <Box component="section">
          <Typography variant="h6" fontWeight={700}>Shipper assignment rules</Typography>
          <Typography variant="caption" color="text.secondary">
            These rules route imported charges to a responsible shipper and produce GL dimensions. MUD pricing
            remains an independently versioned contract directive.
          </Typography>
          {workspace?.rules.length ? (
            <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
              {workspace.rules.map((rule) => (
                <Box key={rule.globalId} sx={{ py: 1.25, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' }, gap: 1 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography fontWeight={650}>{rule.name}</Typography>
                      {rule.status && <Chip size="small" label={displayStatus(rule.status)} color={statusColor(rule.status)} />}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {rule.globalId}{rule.versionNumber ? ` v${rule.versionNumber}` : ''} · {displayStatus(rule.matchMode)} match · {objectSummary(rule.conditions)}
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: { xs: 'left', sm: 'right' } }}>
                    <Typography variant="body2">Priority {count(rule.priority)}</Typography>
                    <Typography variant="caption" color="text.secondary">{rule.targetShipperName || rule.targetShipperDisplayName || rule.shipperName || rule.targetShipperPartyGlobalId || 'No shipper'}</Typography>
                  </Box>
                </Box>
              ))}
            </Stack>
          ) : (
            <Typography color="text.secondary" sx={{ mt: 1 }}>No routing rules have been created.</Typography>
          )}

          <Box component="form" onSubmit={createRule} sx={{ mt: 2 }}>
            <Typography fontWeight={700} sx={{ mb: 1.25 }}>New rule</Typography>
            {!canCreateRules && (
              <Alert severity="info" sx={{ mb: 1.25 }}>
                Network management permission is required to create routing rules.
              </Alert>
            )}
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 2fr) minmax(110px, 0.6fr) minmax(130px, 0.8fr)' }, gap: 1 }}>
              <TextField
                required
                size="small"
                label="Rule name"
                value={ruleForm.name}
                onChange={(event) => setRuleForm((current) => ({ ...current, name: event.target.value }))}
                disabled={!canCreateRules || creatingRule}
                inputProps={{ maxLength: 200 }}
                sx={fieldSx}
              />
              <TextField
                required
                size="small"
                type="number"
                label="Priority"
                value={ruleForm.priority}
                onChange={(event) => setRuleForm((current) => ({ ...current, priority: event.target.value }))}
                disabled={!canCreateRules || creatingRule}
                inputProps={{ step: 1 }}
                sx={fieldSx}
              />
              <TextField
                select
                size="small"
                label="Match mode"
                value={ruleForm.matchMode}
                onChange={(event) => setRuleForm((current) => ({ ...current, matchMode: event.target.value as 'all' | 'any' }))}
                disabled={!canCreateRules || creatingRule}
                sx={fieldSx}
              >
                <MenuItem value="all">All conditions</MenuItem>
                <MenuItem value="any">Any condition</MenuItem>
              </TextField>
            </Box>
            <Box sx={{ mt: 1, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(0, 1fr)' }, gap: 1 }}>
              <TextField
                required
                multiline
                minRows={3}
                label="Conditions (JSON)"
                value={ruleForm.conditions}
                onChange={(event) => setRuleForm((current) => ({ ...current, conditions: event.target.value }))}
                disabled={!canCreateRules || creatingRule}
                sx={fieldSx}
              />
              <TextField
                required
                multiline
                minRows={3}
                label="Outputs (JSON)"
                value={ruleForm.outputs}
                onChange={(event) => setRuleForm((current) => ({ ...current, outputs: event.target.value }))}
                disabled={!canCreateRules || creatingRule}
                sx={fieldSx}
              />
            </Box>
            <Box sx={{ mt: 1, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(180px, 1fr) minmax(190px, 0.8fr) auto' }, gap: 1 }}>
              <TextField
                required
                select
                size="small"
                label="Target shipper"
                value={ruleForm.targetShipperPartyGlobalId}
                onChange={(event) => setRuleForm((current) => ({ ...current, targetShipperPartyGlobalId: event.target.value }))}
                disabled={!canCreateRules || creatingRule}
                sx={fieldSx}
              >
                {workspace?.shippers.map((shipper) => (
                  <MenuItem key={shipper.globalId} value={shipper.globalId}>{shipperName(shipper)}</MenuItem>
                ))}
              </TextField>
              <TextField
                required
                size="small"
                type="datetime-local"
                label="Effective from"
                value={ruleForm.effectiveFrom}
                onChange={(event) => setRuleForm((current) => ({ ...current, effectiveFrom: event.target.value }))}
                disabled={!canCreateRules || creatingRule}
                InputLabelProps={{ shrink: true }}
                sx={fieldSx}
              />
              <Button
                type="submit"
                variant="outlined"
                startIcon={creatingRule ? <CircularProgress size={16} /> : <AddRounded />}
                disabled={
                  !canCreateRules
                  || creatingRule
                  || !ruleForm.name.trim()
                  || !ruleForm.targetShipperPartyGlobalId
                  || !ruleForm.effectiveFrom
                }
              >
                {creatingRule ? 'Creating' : 'Create rule'}
              </Button>
            </Box>
          </Box>
        </Box>
          </>
        )}
      </Stack>
    </Box>
  )
}
