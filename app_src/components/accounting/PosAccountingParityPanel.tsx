'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import CompareArrowsRounded from '@mui/icons-material/CompareArrowsRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type CheckStatus = 'match' | 'variance' | 'insufficient_evidence'
type EntityType = 'SalesReceipt' | 'JournalEntry'

type EvidenceReference = {
  evidenceId: string
  entityType: EntityType
  providerTransactionId: string | null
  businessDate: string
  documentNumber: string | null
  memo: string | null
}

type HistoricalPair = {
  basis: 'business_date_and_document' | 'business_date_only'
  businessDate: string
  salesReceipt: EvidenceReference
  journalEntry: EvidenceReference
  receiptArithmetic: { status: CheckStatus; deltaCents: number | null }
  journalBalance: { status: CheckStatus; deltaCents: number }
}

type EvidenceGroup = {
  businessDate: string
  documentNumber: string | null
  entityType: EntityType
  evidence: EvidenceReference[]
}

type AmbiguousGroup = {
  basis: 'business_date_and_document' | 'business_date_only'
  businessDate: string
  documentNumber: string | null
  salesReceipts: EvidenceReference[]
  journalEntries: EvidenceReference[]
}

type DraftParityRow = {
  expected: {
    expectedId: string
    entityType: EntityType
    businessDate: string
    documentNumber: string | null
    memo: string | null
    draft: {
      id: string
      restaurantName: string | null
      locationName: string | null
      status: string
      revision: number
    }
  }
  actual: EvidenceReference | null
  match: {
    status: 'matched' | 'ambiguous' | 'missing_quickbooks'
    basis: string | null
    candidateTransactionIds: string[]
  }
  comparison: { status: CheckStatus } | null
}

type ParityReport = {
  historicalBaseline: {
    summary: {
      cachedTransactions: number
      pairCount: number
      exactDocumentPairs: number
      dateFallbackPairs: number
      unmatchedGroups: number
      unmatchedEvidence: number
      ambiguousGroups: number
      ambiguousEvidence: number
      receiptArithmetic: Record<'match' | 'variance' | 'insufficientEvidence', number>
      journalBalance: Record<'match' | 'variance' | 'insufficientEvidence', number>
    }
    pairs: HistoricalPair[]
    unmatchedGroups: EvidenceGroup[]
    ambiguousGroups: AmbiguousGroup[]
  }
  rows: DraftParityRow[]
  summary: {
    drafts: number
    expectedDocuments: number
    cachedTransactions: number
    matched: number
    ambiguous: number
    missingQuickBooks: number
    unmatchedQuickBooks: number
    comparisonsMatched: number
    comparisonsWithVariance: number
    comparisonsWithInsufficientEvidence: number
  }
  pagination: {
    page: number
    pageSize: number
    totalDates: number
    totalPages: number
    dates: string[]
  }
  historicalPagination: {
    page: number
    pageSize: number
    totalPages: number
    pairPages: number
    unmatchedPages: number
    ambiguousPages: number
  }
  cache: {
    configured: boolean
    connectionStatus: string | null
    lastCatalogSyncedAt: string | null
    syncStatus: string | null
    syncCompletedAt: string | null
    salesReceiptCount: number
    journalEntryCount: number
  }
  warnings: string[]
}

type ResponsePayload = {
  ok?: boolean
  error?: string
  report?: ParityReport
}

type ChipColor = 'default' | 'success' | 'warning' | 'error' | 'info'

const sectionSx = {
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: '8px',
  bgcolor: '#15151D',
  overflow: 'hidden',
}

function statusColor(status: string): ChipColor {
  if (status === 'match' || status === 'matched') return 'success'
  if (status === 'variance' || status === 'missing_quickbooks') return 'error'
  if (status === 'ambiguous' || status === 'insufficient_evidence') return 'warning'
  return 'default'
}

function statusLabel(status: string) {
  return status.replaceAll('_', ' ')
}

function evidenceLabel(evidence: EvidenceReference) {
  return evidence.documentNumber || evidence.providerTransactionId || evidence.evidenceId
}

function Metric({ label, value, tone = 'text.primary' }: { label: string; value: string | number; tone?: string }) {
  return (
    <Box minWidth={0}>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography variant="h6" fontWeight={700} color={tone} sx={{ letterSpacing: 0 }}>{value}</Typography>
    </Box>
  )
}

function SectionHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <Box px={{ xs: 1.5, sm: 2 }} py={1.5} display="flex" alignItems="baseline" justifyContent="space-between" gap={2} flexWrap="wrap">
      <Typography fontWeight={700}>{title}</Typography>
      <Typography variant="caption" color="text.secondary">{detail}</Typography>
    </Box>
  )
}

export default function PosAccountingParityPanel() {
  const dateTimeSettings = useUserDateTime()
  const [report, setReport] = useState<ParityReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [historyPage, setHistoryPage] = useState(1)
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({
      view: 'pos-parity',
      page: String(page),
      pageSize: '60',
      historyPage: String(historyPage),
      historyPageSize: '20',
    })
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    fetch(`/api/accounting/quickbooks?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as ResponsePayload
        if (!response.ok || !payload.ok || !payload.report) {
          throw new Error(payload.error || 'POS posting parity is unavailable')
        }
        setReport(payload.report)
      })
      .catch((fetchError) => {
        if ((fetchError as Error).name !== 'AbortError') setError((fetchError as Error).message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [from, historyPage, page, refreshToken, to])

  const money = useMemo(() => new Intl.NumberFormat(dateTimeSettings.locale, {
    style: 'currency',
    currency: 'USD',
  }), [dateTimeSettings.locale])

  const formatDelta = (cents: number | null | undefined) => cents == null ? '—' : money.format(cents / 100)
  const baseline = report?.historicalBaseline
  const visiblePairs = baseline?.pairs || []
  const visibleUnmatched = baseline?.unmatchedGroups || []
  const visibleAmbiguous = baseline?.ambiguousGroups || []
  const dateRangeInvalid = Boolean(fromInput && toInput && fromInput > toInput)

  const applyRange = () => {
    if (dateRangeInvalid) return
    setLoading(true)
    setError(null)
    setPage(1)
    setHistoryPage(1)
    setFrom(fromInput)
    setTo(toInput)
  }

  const clearRange = () => {
    setLoading(true)
    setError(null)
    setFromInput('')
    setToInput('')
    setFrom('')
    setTo('')
    setPage(1)
    setHistoryPage(1)
  }

  return (
    <Stack spacing={2}>
      <Box display="flex" alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between" gap={2} flexWrap="wrap">
        <Box minWidth={0}>
          <Box display="flex" alignItems="center" gap={1}>
            <CompareArrowsRounded sx={{ color: '#A8C7FA' }} />
            <Typography variant="h6" fontWeight={700}>POS posting parity</Typography>
            <Chip size="small" label="Read only" variant="outlined" />
          </Box>
          <Typography variant="body2" color="text.secondary" mt={0.25}>
            Shogo history and current ClawPilot accounting drafts
          </Typography>
        </Box>
        <Tooltip title="Refresh parity evidence">
          <span>
            <IconButton
              aria-label="Refresh parity evidence"
              disabled={loading}
              onClick={() => {
                setLoading(true)
                setError(null)
                setRefreshToken((value) => value + 1)
              }}
              sx={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px' }}
            >
              {loading ? <CircularProgress size={20} /> : <RefreshRounded />}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Box display="flex" alignItems={{ xs: 'stretch', md: 'center' }} flexDirection={{ xs: 'column', md: 'row' }} gap={1}>
        <TextField
          size="small"
          type="date"
          label="From"
          value={fromInput}
          onChange={(event) => setFromInput(event.target.value)}
          InputLabelProps={{ shrink: true }}
          sx={{ minWidth: { md: 170 }, '& .MuiOutlinedInput-root': { borderRadius: '8px' } }}
        />
        <TextField
          size="small"
          type="date"
          label="To"
          value={toInput}
          onChange={(event) => setToInput(event.target.value)}
          error={dateRangeInvalid}
          helperText={dateRangeInvalid ? 'End date must follow start date' : undefined}
          InputLabelProps={{ shrink: true }}
          sx={{ minWidth: { md: 170 }, '& .MuiOutlinedInput-root': { borderRadius: '8px' } }}
        />
        <Button variant="contained" disabled={dateRangeInvalid || loading} onClick={applyRange}>Apply</Button>
        {(from || to) ? <Button variant="text" onClick={clearRange}>Clear</Button> : null}
      </Box>

      {error ? <Alert severity="error">{error}</Alert> : null}
      {report?.warnings.map((warning) => <Alert key={warning} severity="warning" variant="outlined">{warning}</Alert>)}

      {!report && loading ? (
        <Box display="grid" sx={{ placeItems: 'center' }} minHeight={280}><CircularProgress /></Box>
      ) : report && baseline ? (
        <>
          <Box sx={sectionSx}>
            <SectionHeader
              title="Historical Shogo baseline"
              detail={`${report.cache.salesReceiptCount} receipts · ${report.cache.journalEntryCount} journals in cache`}
            />
            <Divider />
            <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))', lg: 'repeat(7, minmax(0, 1fr))' }} gap={2} px={{ xs: 1.5, sm: 2 }} py={2}>
              <Metric label="Records" value={baseline.summary.cachedTransactions} />
              <Metric label="Paired dates" value={baseline.summary.pairCount} tone="#A8C7FA" />
              <Metric label="Exact pairs" value={baseline.summary.exactDocumentPairs} tone="#70D6A7" />
              <Metric label="Date fallback" value={baseline.summary.dateFallbackPairs} />
              <Metric label="Unmatched" value={baseline.summary.unmatchedEvidence} tone={baseline.summary.unmatchedEvidence ? '#F2B76D' : '#70D6A7'} />
              <Metric label="Ambiguous" value={baseline.summary.ambiguousEvidence} tone={baseline.summary.ambiguousEvidence ? '#FF8A80' : '#70D6A7'} />
              <Metric label="Receipt variances" value={baseline.summary.receiptArithmetic.variance} tone={baseline.summary.receiptArithmetic.variance ? '#FF8A80' : '#70D6A7'} />
            </Box>
            <Divider />
            <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }} gap={1.5} px={{ xs: 1.5, sm: 2 }} py={1.5}>
              <Typography variant="body2" color="text.secondary">
                Receipt arithmetic: <Box component="span" color="#70D6A7">{baseline.summary.receiptArithmetic.match} balanced</Box>
                {' · '}{baseline.summary.receiptArithmetic.insufficientEvidence} incomplete
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Journal balance: <Box component="span" color="#70D6A7">{baseline.summary.journalBalance.match} balanced</Box>
                {' · '}<Box component="span" color={baseline.summary.journalBalance.variance ? '#FF8A80' : 'inherit'}>{baseline.summary.journalBalance.variance} variances</Box>
              </Typography>
            </Box>
          </Box>

          <Box sx={sectionSx}>
            <SectionHeader title="Historical pairs" detail={`${baseline.summary.pairCount} receipt and journal pairs`} />
            <Divider />
            {visiblePairs.length ? visiblePairs.map((pair) => (
              <Box
                key={`${pair.businessDate}-${pair.salesReceipt.evidenceId}-${pair.journalEntry.evidenceId}`}
                display="grid"
                gridTemplateColumns={{ xs: '1fr auto', md: '130px minmax(180px, 1fr) minmax(180px, 1fr) 150px 150px' }}
                gap={1.25}
                px={{ xs: 1.5, sm: 2 }}
                py={1.5}
                alignItems="center"
                borderBottom="1px solid rgba(255,255,255,0.06)"
              >
                <Box>
                  <Typography variant="body2" fontWeight={700}>{pair.businessDate}</Typography>
                  <Typography variant="caption" color="text.disabled">{pair.basis === 'business_date_and_document' ? 'Exact document' : 'Date fallback'}</Typography>
                </Box>
                <Box sx={{ display: { xs: 'block', md: 'none' } }}>
                  <Chip size="small" color={statusColor(pair.receiptArithmetic.status)} variant="outlined" label={statusLabel(pair.receiptArithmetic.status)} />
                </Box>
                <Box minWidth={0}>
                  <Typography variant="caption" color="text.secondary">Sales receipt</Typography>
                  <Typography variant="body2" noWrap>{evidenceLabel(pair.salesReceipt)}</Typography>
                </Box>
                <Box minWidth={0}>
                  <Typography variant="caption" color="text.secondary">Journal entry</Typography>
                  <Typography variant="body2" noWrap>{evidenceLabel(pair.journalEntry)}</Typography>
                </Box>
                <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                  <Typography variant="caption" color="text.secondary">Receipt check</Typography>
                  <Box mt={0.5}><Chip size="small" color={statusColor(pair.receiptArithmetic.status)} variant="outlined" label={`${statusLabel(pair.receiptArithmetic.status)} · ${formatDelta(pair.receiptArithmetic.deltaCents)}`} /></Box>
                </Box>
                <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                  <Typography variant="caption" color="text.secondary">Journal check</Typography>
                  <Box mt={0.5}><Chip size="small" color={statusColor(pair.journalBalance.status)} variant="outlined" label={`${statusLabel(pair.journalBalance.status)} · ${formatDelta(pair.journalBalance.deltaCents)}`} /></Box>
                </Box>
              </Box>
            )) : <Typography color="text.secondary" p={2}>No historical pairs in this period.</Typography>}
          </Box>

          {(baseline.unmatchedGroups.length || baseline.ambiguousGroups.length) ? (
            <Box sx={sectionSx}>
              <SectionHeader title="Historical exceptions" detail={`${baseline.summary.unmatchedEvidence + baseline.summary.ambiguousEvidence} records require review`} />
              <Divider />
              {visibleAmbiguous.map((group, index) => (
                <Box key={`ambiguous-${group.businessDate}-${group.documentNumber}-${index}`} px={{ xs: 1.5, sm: 2 }} py={1.5} borderBottom="1px solid rgba(255,255,255,0.06)" display="flex" alignItems="center" justifyContent="space-between" gap={2}>
                  <Box minWidth={0}>
                    <Typography variant="body2" fontWeight={700}>{group.businessDate} · {group.documentNumber || 'No document number'}</Typography>
                    <Typography variant="caption" color="text.secondary">{group.salesReceipts.length} receipts · {group.journalEntries.length} journals</Typography>
                  </Box>
                  <Chip size="small" color="warning" variant="outlined" label="Ambiguous" />
                </Box>
              ))}
              {visibleUnmatched.map((group, index) => (
                <Box key={`unmatched-${group.businessDate}-${group.documentNumber}-${group.entityType}-${index}`} px={{ xs: 1.5, sm: 2 }} py={1.5} borderBottom="1px solid rgba(255,255,255,0.06)" display="flex" alignItems="center" justifyContent="space-between" gap={2}>
                  <Box minWidth={0}>
                    <Typography variant="body2" fontWeight={700}>{group.businessDate} · {group.documentNumber || 'No document number'}</Typography>
                    <Typography variant="caption" color="text.secondary">{group.evidence.length} {group.entityType} record{group.evidence.length === 1 ? '' : 's'}</Typography>
                  </Box>
                  <Chip size="small" color="error" variant="outlined" label="Unmatched" />
                </Box>
              ))}
            </Box>
          ) : null}

          {report.historicalPagination.totalPages > 1 ? (
            <Box sx={sectionSx} px={{ xs: 1.5, sm: 2 }} py={1.25} display="flex" alignItems="center" justifyContent="space-between" gap={2}>
              <Typography variant="caption" color="text.secondary">
                Historical detail page {report.historicalPagination.page} of {report.historicalPagination.totalPages}
              </Typography>
              <Box display="flex" gap={0.5}>
                <IconButton
                  aria-label="Previous historical parity page"
                  disabled={loading || historyPage <= 1}
                  onClick={() => {
                    setLoading(true)
                    setError(null)
                    setHistoryPage((value) => Math.max(1, value - 1))
                  }}
                >
                  <ChevronLeftRounded />
                </IconButton>
                <IconButton
                  aria-label="Next historical parity page"
                  disabled={loading || historyPage >= report.historicalPagination.totalPages}
                  onClick={() => {
                    setLoading(true)
                    setError(null)
                    setHistoryPage((value) => value + 1)
                  }}
                >
                  <ChevronRightRounded />
                </IconButton>
              </Box>
            </Box>
          ) : null}

          <Box sx={sectionSx}>
            <SectionHeader title="Current ClawPilot drafts" detail={`${report.pagination.totalDates} business dates`} />
            <Divider />
            <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }} gap={2} px={{ xs: 1.5, sm: 2 }} py={2}>
              <Metric label="Drafts" value={report.summary.drafts} />
              <Metric label="Matched" value={report.summary.matched} tone="#70D6A7" />
              <Metric label="Missing" value={report.summary.missingQuickBooks} tone={report.summary.missingQuickBooks ? '#F2B76D' : '#70D6A7'} />
              <Metric label="Variances" value={report.summary.comparisonsWithVariance} tone={report.summary.comparisonsWithVariance ? '#FF8A80' : '#70D6A7'} />
            </Box>
            <Divider />
            {report.rows.length ? report.rows.map((row) => (
              <Box
                key={row.expected.expectedId}
                display="grid"
                gridTemplateColumns={{ xs: '1fr auto', sm: '130px minmax(0, 1fr) 150px 150px' }}
                gap={1.25}
                px={{ xs: 1.5, sm: 2 }}
                py={1.5}
                alignItems="center"
                borderBottom="1px solid rgba(255,255,255,0.06)"
              >
                <Box>
                  <Typography variant="body2" fontWeight={700}>{row.expected.businessDate}</Typography>
                  <Typography variant="caption" color="text.disabled">Revision {row.expected.draft.revision}</Typography>
                </Box>
                <Chip size="small" color={statusColor(row.match.status)} variant="outlined" label={statusLabel(row.match.status)} sx={{ display: { sm: 'none' } }} />
                <Box minWidth={0}>
                  <Typography variant="body2" noWrap>{row.expected.entityType}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap display="block">{row.expected.draft.locationName || row.expected.draft.restaurantName || 'POS location'}</Typography>
                </Box>
                <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
                  <Typography variant="caption" color="text.secondary">Evidence match</Typography>
                  <Box mt={0.5}><Chip size="small" color={statusColor(row.match.status)} variant="outlined" label={statusLabel(row.match.status)} /></Box>
                </Box>
                <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
                  <Typography variant="caption" color="text.secondary">Amount comparison</Typography>
                  <Box mt={0.5}><Chip size="small" color={statusColor(row.comparison?.status || 'insufficient_evidence')} variant="outlined" label={statusLabel(row.comparison?.status || 'insufficient_evidence')} /></Box>
                </Box>
              </Box>
            )) : <Typography color="text.secondary" p={2}>No current drafts in this period.</Typography>}
            {report.pagination.totalPages > 1 ? (
              <Box px={{ xs: 1.5, sm: 2 }} py={1.25} display="flex" alignItems="center" justifyContent="space-between" gap={2}>
                <Typography variant="caption" color="text.secondary">Page {report.pagination.page} of {report.pagination.totalPages}</Typography>
                <Box display="flex" gap={0.5}>
                  <IconButton aria-label="Previous parity page" disabled={loading || page <= 1} onClick={() => { setLoading(true); setError(null); setPage((value) => Math.max(1, value - 1)) }}><ChevronLeftRounded /></IconButton>
                  <IconButton aria-label="Next parity page" disabled={loading || page >= report.pagination.totalPages} onClick={() => { setLoading(true); setError(null); setPage((value) => value + 1) }}><ChevronRightRounded /></IconButton>
                </Box>
              </Box>
            ) : null}
          </Box>

          {report.cache.syncCompletedAt ? (
            <Typography variant="caption" color="text.disabled">
              QuickBooks cache completed {formatUserDateTime(report.cache.syncCompletedAt, dateTimeSettings, { dateStyle: 'medium', timeStyle: 'short' })}
            </Typography>
          ) : null}
        </>
      ) : null}
    </Stack>
  )
}
