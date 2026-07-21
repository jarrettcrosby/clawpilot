'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import CompareArrowsRounded from '@mui/icons-material/CompareArrowsRounded'
import DescriptionRounded from '@mui/icons-material/DescriptionRounded'
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type CheckStatus = 'match' | 'variance' | 'insufficient_evidence'
type EntityType = 'SalesReceipt' | 'JournalEntry'
type PostingOrigin = 'shogo' | 'clawpilot'

type ReceiptLineGroup = {
  itemId: string
  itemName: string | null
  amountCents: number
  quantityMillis: number
}

type JournalLineGroup = {
  side: 'debit' | 'credit'
  accountId: string
  accountName: string | null
  amountCents: number
}

type EvidenceReference = {
  evidenceId: string
  entityType: EntityType
  providerTransactionId: string | null
  businessDate: string
  documentNumber: string | null
  memo: string | null
  postingOrigin: PostingOrigin | null
}

type EvidenceBase = EvidenceReference & {
  partyName: string | null
  accountName: string | null
  currencyCode: string | null
  syncedAt: string | null
}

type SalesReceiptEvidence = EvidenceBase & {
  entityType: 'SalesReceipt'
  subtotalCents: number | null
  subtotalSource: 'explicit' | 'line_sum' | null
  totalCents: number | null
  taxCents: number | null
  lineGroups: ReceiptLineGroup[]
  unidentifiedLineCount: number
  unsupportedLineCount: number
}

type JournalEntryEvidence = EvidenceBase & {
  entityType: 'JournalEntry'
  debitCents: number
  creditCents: number
  lineGroups: JournalLineGroup[]
  unidentifiedLineCount: number
  unsupportedLineCount: number
}

type QuickBooksEvidence = SalesReceiptEvidence | JournalEntryEvidence

type AmountComparison = {
  status: CheckStatus
  expectedCents: number | null
  actualCents: number | null
  deltaCents: number | null
}

type ReceiptLineComparison = {
  itemId: string
  itemName: string | null
  expectedAmountCents: number | null
  actualAmountCents: number | null
  deltaAmountCents: number | null
  expectedQuantityMillis: number | null
  actualQuantityMillis: number | null
  deltaQuantityMillis: number | null
  status: CheckStatus | 'missing' | 'extra'
}

type JournalLineComparison = {
  side: 'debit' | 'credit'
  accountId: string
  accountName: string | null
  expectedAmountCents: number | null
  actualAmountCents: number | null
  deltaAmountCents: number | null
  status: CheckStatus | 'missing' | 'extra'
}

type ReceiptComparison = {
  status: CheckStatus
  total: AmountComparison
  tax: AmountComparison
  lines: ReceiptLineComparison[]
  coverageIncomplete: boolean
}

type JournalComparison = {
  status: CheckStatus
  debits: AmountComparison
  credits: AmountComparison
  lines: JournalLineComparison[]
  coverageIncomplete: boolean
}

type ExpectedBase = {
  expectedId: string
  entityType: EntityType
  businessDate: string
  providerTransactionId: string | null
  documentNumber: string | null
  memo: string | null
  draft: {
    id: string
    restaurantName: string | null
    locationName: string | null
    status: string
    reconciliationStatus: string
    revision: number
    sourceRevision: number
    updatedAt: string | null
  }
}

type ExpectedSalesReceipt = ExpectedBase & {
  entityType: 'SalesReceipt'
  totalCents: number | null
  taxCents: number | null
  lineGroups: ReceiptLineGroup[]
  lineEvidenceAvailable: boolean
  unmappedLineCount: number
}

type ExpectedJournalEntry = ExpectedBase & {
  entityType: 'JournalEntry'
  debitCents: number | null
  creditCents: number | null
  lineGroups: JournalLineGroup[]
  lineEvidenceAvailable: boolean
  unmappedLineCount: number
}

type ExpectedEvidence = ExpectedSalesReceipt | ExpectedJournalEntry

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
  expected: ExpectedEvidence
  actual: QuickBooksEvidence | null
  match: {
    status: 'matched' | 'ambiguous' | 'missing_quickbooks'
    basis: string | null
    candidateTransactionIds: string[]
  }
  comparison: ReceiptComparison | JournalComparison | null
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

type ReceiptIntegrity = {
  status: CheckStatus
  subtotalCents: number | null
  taxCents: number | null
  totalCents: number | null
  deltaCents: number | null
}

type JournalIntegrity = {
  status: CheckStatus
  debitCents: number
  creditCents: number
  deltaCents: number
}

type EvidenceDetail = {
  evidence: QuickBooksEvidence
  integrity: ReceiptIntegrity | JournalIntegrity
}

type DrawerSelection =
  | { kind: 'historical'; evidence: EvidenceReference; status: string }
  | { kind: 'current'; row: DraftParityRow }

type ChipColor = 'default' | 'success' | 'warning' | 'error' | 'info'

const sectionSx = {
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: '8px',
  bgcolor: '#15151D',
  overflow: 'hidden',
}

function statusColor(status: string): ChipColor {
  if (status === 'match' || status === 'matched') return 'success'
  if (status === 'variance' || status === 'missing_quickbooks' || status === 'unmatched') return 'error'
  if (status === 'ambiguous' || status === 'insufficient_evidence') return 'warning'
  return 'default'
}

function statusLabel(status: string | null | undefined) {
  return String(status || 'unknown').replaceAll('_', ' ')
}

function evidenceLabel(evidence: EvidenceReference) {
  return evidence.documentNumber || evidence.providerTransactionId || evidence.evidenceId
}

function evidenceProviderId(evidence: EvidenceReference) {
  if (evidence.providerTransactionId) return evidence.providerTransactionId
  const prefix = `${evidence.entityType}:`
  return evidence.evidenceId.startsWith(prefix) ? evidence.evidenceId.slice(prefix.length) : ''
}

function entityLabel(entityType: EntityType) {
  return entityType === 'SalesReceipt' ? 'Sales receipt' : 'Journal entry'
}

function originLabel(origin: PostingOrigin | null | undefined, fallback: PostingOrigin = 'shogo') {
  return (origin || fallback) === 'clawpilot' ? 'ClawPilot' : 'Shogo'
}

function quantityLabel(quantityMillis: number | null | undefined) {
  if (quantityMillis === null || quantityMillis === undefined) return '—'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(quantityMillis / 1000)
}

function DetailField({ label, value, wrap = false }: {
  label: string
  value: string | number | null | undefined
  wrap?: boolean
}) {
  return (
    <Box minWidth={0}>
      <Typography variant="caption" color="text.disabled" display="block" mb={0.35}>{label}</Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere', whiteSpace: wrap ? 'pre-wrap' : 'normal' }}>
        {value === null || value === undefined || value === '' ? '—' : value}
      </Typography>
    </Box>
  )
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <Box minWidth={0}>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography variant="body1" fontWeight={700} mt={0.25}>{value}</Typography>
    </Box>
  )
}

function EvidenceButton({ evidence, status, onOpen }: {
  evidence: EvidenceReference
  status?: string
  onOpen: (evidence: EvidenceReference, status: string) => void
}) {
  const label = entityLabel(evidence.entityType)
  const providerId = evidenceProviderId(evidence)
  return (
    <Tooltip title={`Open ${label.toLowerCase()} details`}>
      <ButtonBase
        onClick={() => onOpen(evidence, status || 'match')}
        aria-label={`Open ${label} ${evidenceLabel(evidence)}`}
        sx={{
          width: '100%', minWidth: 0, justifyContent: 'stretch', textAlign: 'left', px: 1, py: 0.75,
          borderRadius: '6px', color: 'inherit',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
          '&:focus-visible': { outline: '2px solid #A8C7FA', outlineOffset: '-2px' },
        }}
      >
        <Box display="grid" gridTemplateColumns="24px minmax(0, 1fr) auto" gap={1} alignItems="center" width="100%" minWidth={0}>
          {evidence.entityType === 'SalesReceipt'
            ? <ReceiptLongRounded fontSize="small" color="action" />
            : <AccountBalanceRounded fontSize="small" color="action" />}
          <Box minWidth={0}>
            <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
            <Typography variant="body2" noWrap>{evidenceLabel(evidence)}</Typography>
            <Typography variant="caption" color="text.disabled" noWrap display="block">
              {originLabel(evidence.postingOrigin)}{providerId ? ` · ID ${providerId}` : ''}{status ? ` · ${statusLabel(status)}` : ''}
            </Typography>
          </Box>
          <Box display="flex" alignItems="center" gap={0.5}>
            {status ? <Chip size="small" color={statusColor(status)} variant="outlined" label={statusLabel(status)} sx={{ display: { xs: 'none', sm: 'inline-flex' } }} /> : null}
            <ChevronRightRounded fontSize="small" color="action" />
          </Box>
        </Box>
      </ButtonBase>
    </Tooltip>
  )
}

function ReceiptLineList({ lines, formatCents }: {
  lines: ReceiptLineGroup[]
  formatCents: (value: number | null | undefined) => string
}) {
  if (!lines.length) return <Typography variant="body2" color="text.secondary">No normalized item lines are available.</Typography>
  return (
    <Box>
      {lines.map((line) => (
        <Box
          key={line.itemId}
          display="grid"
          gridTemplateColumns={{ xs: 'minmax(0, 1fr) auto', sm: 'minmax(0, 1fr) 90px 120px' }}
          gap={1.25}
          py={1}
          borderTop="1px solid rgba(255,255,255,0.065)"
          alignItems="center"
        >
          <Box minWidth={0}>
            <Typography variant="body2" fontWeight={650}>{line.itemName || 'QuickBooks item'}</Typography>
            <Typography variant="caption" color="text.disabled" sx={{ overflowWrap: 'anywhere' }}>ID {line.itemId}</Typography>
            <Typography variant="caption" color="text.secondary" display={{ xs: 'block', sm: 'none' }}>Quantity {quantityLabel(line.quantityMillis)}</Typography>
          </Box>
          <Typography variant="body2" color="text.secondary" display={{ xs: 'none', sm: 'block' }}>Qty {quantityLabel(line.quantityMillis)}</Typography>
          <Typography variant="body2" fontWeight={700} textAlign="right">{formatCents(line.amountCents)}</Typography>
        </Box>
      ))}
    </Box>
  )
}

function JournalLineList({ lines, formatCents }: {
  lines: JournalLineGroup[]
  formatCents: (value: number | null | undefined) => string
}) {
  if (!lines.length) return <Typography variant="body2" color="text.secondary">No normalized account lines are available.</Typography>
  return (
    <Box>
      {lines.map((line) => (
        <Box
          key={`${line.side}:${line.accountId}`}
          display="grid"
          gridTemplateColumns={{ xs: 'auto minmax(0, 1fr) auto', sm: '80px minmax(0, 1fr) 120px' }}
          gap={1.25}
          py={1}
          borderTop="1px solid rgba(255,255,255,0.065)"
          alignItems="center"
        >
          <Chip size="small" variant="outlined" label={line.side} color={line.side === 'debit' ? 'info' : 'default'} />
          <Box minWidth={0}>
            <Typography variant="body2" fontWeight={650}>{line.accountName || 'QuickBooks account'}</Typography>
            <Typography variant="caption" color="text.disabled" sx={{ overflowWrap: 'anywhere' }}>ID {line.accountId}</Typography>
          </Box>
          <Typography variant="body2" fontWeight={700} textAlign="right">{formatCents(line.amountCents)}</Typography>
        </Box>
      ))}
    </Box>
  )
}

function AmountComparisonRow({ label, comparison, formatCents }: {
  label: string
  comparison: AmountComparison
  formatCents: (value: number | null | undefined) => string
}) {
  return (
    <Box display="grid" gridTemplateColumns={{ xs: 'minmax(0, 1fr) auto', sm: 'minmax(120px, 1fr) repeat(3, 110px) auto' }} gap={1} py={1} borderTop="1px solid rgba(255,255,255,0.065)" alignItems="center">
      <Box minWidth={0}>
        <Typography variant="body2" fontWeight={650}>{label}</Typography>
        <Typography variant="caption" color="text.secondary" display={{ xs: 'block', sm: 'none' }}>
          Expected {formatCents(comparison.expectedCents)} · Actual {formatCents(comparison.actualCents)} · Delta {formatCents(comparison.deltaCents)}
        </Typography>
      </Box>
      <Typography variant="body2" display={{ xs: 'none', sm: 'block' }}>{formatCents(comparison.expectedCents)}</Typography>
      <Typography variant="body2" display={{ xs: 'none', sm: 'block' }}>{formatCents(comparison.actualCents)}</Typography>
      <Typography variant="body2" display={{ xs: 'none', sm: 'block' }} color={comparison.deltaCents ? 'error.main' : 'success.main'}>{formatCents(comparison.deltaCents)}</Typography>
      <Chip size="small" variant="outlined" color={statusColor(comparison.status)} label={statusLabel(comparison.status)} />
    </Box>
  )
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

function ExpectedDocumentDetails({ expected, formatCents }: {
  expected: ExpectedEvidence
  formatCents: (value: number | null | undefined) => string
}) {
  return (
    <Box component="section">
      <Box display="flex" alignItems="center" justifyContent="space-between" gap={1.5} mb={1.5}>
        <Box display="flex" alignItems="center" gap={1} minWidth={0}>
          <DescriptionRounded fontSize="small" color="action" />
          <Typography fontWeight={700}>ClawPilot expected posting</Typography>
        </Box>
        <Chip size="small" variant="outlined" color="info" label="ClawPilot" />
      </Box>
      <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }} gap={1.5}>
        <DetailField label="Document" value={expected.documentNumber} />
        <DetailField label="Business date" value={expected.businessDate} />
        <DetailField label="Provider ID" value={expected.providerTransactionId} />
        <DetailField label="Draft ID" value={expected.draft.id} />
        <DetailField label="Location" value={expected.draft.locationName || expected.draft.restaurantName} />
        <DetailField label="Draft status" value={statusLabel(expected.draft.status)} />
        <Box gridColumn={{ sm: '1 / -1' }}><DetailField label="Memo" value={expected.memo} wrap /></Box>
      </Box>
      {expected.entityType === 'SalesReceipt' ? (
        <>
          <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' }} gap={2} py={2}>
            <DetailMetric
              label="Subtotal"
              value={formatCents(typeof expected.totalCents === 'number' && typeof expected.taxCents === 'number'
                ? expected.totalCents - expected.taxCents
                : null)}
            />
            <DetailMetric label="Tax" value={formatCents(expected.taxCents)} />
            <DetailMetric label="Total" value={formatCents(expected.totalCents)} />
          </Box>
          <Typography variant="subtitle2" fontWeight={700} mb={0.5}>Expected item lines</Typography>
          <ReceiptLineList lines={expected.lineGroups || []} formatCents={formatCents} />
        </>
      ) : (
        <>
          <Box display="grid" gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap={2} py={2}>
            <DetailMetric label="Debits" value={formatCents(expected.debitCents)} />
            <DetailMetric label="Credits" value={formatCents(expected.creditCents)} />
          </Box>
          <Typography variant="subtitle2" fontWeight={700} mb={0.5}>Expected account lines</Typography>
          <JournalLineList lines={expected.lineGroups || []} formatCents={formatCents} />
        </>
      )}
    </Box>
  )
}

function QuickBooksEvidenceDetails({ evidence, integrity, contextStatus, formatCents }: {
  evidence: QuickBooksEvidence
  integrity?: ReceiptIntegrity | JournalIntegrity | null
  contextStatus?: string
  formatCents: (value: number | null | undefined) => string
}) {
  const evidenceStatus = contextStatus || integrity?.status || 'insufficient_evidence'
  return (
    <Box component="section">
      <Box display="flex" alignItems="center" justifyContent="space-between" gap={1.5} mb={1.5}>
        <Box display="flex" alignItems="center" gap={1} minWidth={0}>
          {evidence.entityType === 'SalesReceipt'
            ? <ReceiptLongRounded fontSize="small" color="action" />
            : <AccountBalanceRounded fontSize="small" color="action" />}
          <Typography fontWeight={700}>QuickBooks evidence</Typography>
        </Box>
        <Box display="flex" alignItems="center" justifyContent="flex-end" gap={0.75} flexWrap="wrap">
          <Chip size="small" variant="outlined" color="info" label={originLabel(evidence.postingOrigin)} />
          <Chip size="small" variant="outlined" color={statusColor(evidenceStatus)} label={statusLabel(evidenceStatus)} />
          {integrity && integrity.status !== evidenceStatus ? (
            <Chip size="small" variant="outlined" color={statusColor(integrity.status)} label={`integrity: ${statusLabel(integrity.status)}`} />
          ) : null}
        </Box>
      </Box>
      <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }} gap={1.5}>
        <DetailField label="Document" value={evidence.documentNumber} />
        <DetailField label="Business date" value={evidence.businessDate} />
        <DetailField label="Provider ID" value={evidence.providerTransactionId} />
        <DetailField label="Source origin" value={originLabel(evidence.postingOrigin)} />
        <DetailField label="Customer or party" value={evidence.partyName} />
        <DetailField label="Account" value={evidence.accountName} />
        <Box gridColumn={{ sm: '1 / -1' }}><DetailField label="Memo" value={evidence.memo} wrap /></Box>
      </Box>
      {evidence.entityType === 'SalesReceipt' ? (
        <>
          <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' }} gap={2} py={2}>
            <DetailMetric label="Subtotal" value={formatCents(evidence.subtotalCents)} />
            <DetailMetric label="Tax" value={formatCents(evidence.taxCents)} />
            <DetailMetric label="Total" value={formatCents(evidence.totalCents)} />
          </Box>
          {integrity && 'deltaCents' in integrity ? (
            <Typography variant="body2" color={integrity.deltaCents ? 'error.main' : 'text.secondary'} mb={1.5}>
              Receipt arithmetic delta {formatCents(integrity.deltaCents)}
            </Typography>
          ) : null}
          <Typography variant="subtitle2" fontWeight={700} mb={0.5}>Item lines</Typography>
          <ReceiptLineList lines={evidence.lineGroups || []} formatCents={formatCents} />
        </>
      ) : (
        <>
          <Box display="grid" gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap={2} py={2}>
            <DetailMetric label="Debits" value={formatCents(evidence.debitCents)} />
            <DetailMetric label="Credits" value={formatCents(evidence.creditCents)} />
          </Box>
          {integrity && 'deltaCents' in integrity ? (
            <Typography variant="body2" color={integrity.deltaCents ? 'error.main' : 'text.secondary'} mb={1.5}>
              Journal balance delta {formatCents(integrity.deltaCents)}
            </Typography>
          ) : null}
          <Typography variant="subtitle2" fontWeight={700} mb={0.5}>Account lines</Typography>
          <JournalLineList lines={evidence.lineGroups || []} formatCents={formatCents} />
        </>
      )}
    </Box>
  )
}

function ComparisonDetails({ expected, comparison, formatCents }: {
  expected: ExpectedEvidence
  comparison: ReceiptComparison | JournalComparison
  formatCents: (value: number | null | undefined) => string
}) {
  const receiptComparison = expected.entityType === 'SalesReceipt' && 'total' in comparison
    ? comparison
    : null
  const journalComparison = expected.entityType === 'JournalEntry' && 'debits' in comparison
    ? comparison
    : null
  return (
    <Box component="section">
      <Box display="flex" alignItems="center" justifyContent="space-between" gap={1.5} mb={1}>
        <Typography fontWeight={700}>Expected versus QuickBooks</Typography>
        <Chip size="small" variant="outlined" color={statusColor(comparison.status)} label={statusLabel(comparison.status)} />
      </Box>
      {receiptComparison ? (
        <>
          <AmountComparisonRow label="Total" comparison={receiptComparison.total} formatCents={formatCents} />
          <AmountComparisonRow label="Tax" comparison={receiptComparison.tax} formatCents={formatCents} />
          <Typography variant="subtitle2" fontWeight={700} mt={2} mb={0.5}>Item line deltas</Typography>
          {receiptComparison.lines.length ? receiptComparison.lines.map((line) => (
            <Box key={line.itemId} display="grid" gridTemplateColumns="minmax(0, 1fr) auto" gap={1} py={1} borderTop="1px solid rgba(255,255,255,0.065)" alignItems="center">
              <Box minWidth={0}>
                <Typography variant="body2" fontWeight={650}>{line.itemName || 'QuickBooks item'}</Typography>
                <Typography variant="caption" color="text.secondary" display="block">
                  Expected {formatCents(line.expectedAmountCents)} · Actual {formatCents(line.actualAmountCents)} · Delta {formatCents(line.deltaAmountCents)}
                </Typography>
                <Typography variant="caption" color="text.disabled" display="block">
                  Quantity {quantityLabel(line.expectedQuantityMillis)} → {quantityLabel(line.actualQuantityMillis)} · Delta {quantityLabel(line.deltaQuantityMillis)}
                </Typography>
              </Box>
              <Chip size="small" variant="outlined" color={statusColor(line.status)} label={statusLabel(line.status)} />
            </Box>
          )) : <Typography variant="body2" color="text.secondary">No normalized item-line comparison is available.</Typography>}
        </>
      ) : journalComparison ? (
        <>
          <AmountComparisonRow label="Debits" comparison={journalComparison.debits} formatCents={formatCents} />
          <AmountComparisonRow label="Credits" comparison={journalComparison.credits} formatCents={formatCents} />
          <Typography variant="subtitle2" fontWeight={700} mt={2} mb={0.5}>Account line deltas</Typography>
          {journalComparison.lines.length ? journalComparison.lines.map((line) => (
            <Box key={`${line.side}:${line.accountId}`} display="grid" gridTemplateColumns="auto minmax(0, 1fr) auto" gap={1} py={1} borderTop="1px solid rgba(255,255,255,0.065)" alignItems="center">
              <Chip size="small" variant="outlined" label={line.side} color={line.side === 'debit' ? 'info' : 'default'} />
              <Box minWidth={0}>
                <Typography variant="body2" fontWeight={650}>{line.accountName || 'QuickBooks account'}</Typography>
                <Typography variant="caption" color="text.secondary" display="block">
                  Expected {formatCents(line.expectedAmountCents)} · Actual {formatCents(line.actualAmountCents)} · Delta {formatCents(line.deltaAmountCents)}
                </Typography>
              </Box>
              <Chip size="small" variant="outlined" color={statusColor(line.status)} label={statusLabel(line.status)} />
            </Box>
          )) : <Typography variant="body2" color="text.secondary">No normalized account-line comparison is available.</Typography>}
        </>
      ) : (
        <Alert severity="warning">The comparison type does not match this expected document.</Alert>
      )}
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
  const [selection, setSelection] = useState<DrawerSelection | null>(null)
  const [historicalDetail, setHistoricalDetail] = useState<EvidenceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

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

  useEffect(() => {
    if (!selection || selection.kind !== 'historical') return
    const providerId = evidenceProviderId(selection.evidence)
    if (!providerId) return
    const controller = new AbortController()
    const params = new URLSearchParams({
      view: 'pos-parity-evidence',
      id: providerId,
      entityType: selection.evidence.entityType,
    })
    fetch(`/api/accounting/quickbooks?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { ok?: boolean; error?: string; detail?: EvidenceDetail }
        if (!response.ok || !payload.ok || !payload.detail) {
          throw new Error(payload.error || 'Toast posting evidence is unavailable')
        }
        setHistoricalDetail(payload.detail)
      })
      .catch((fetchError) => {
        if ((fetchError as Error).name !== 'AbortError') setDetailError((fetchError as Error).message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false)
      })
    return () => controller.abort()
  }, [selection])

  const money = useMemo(() => new Intl.NumberFormat(dateTimeSettings.locale, {
    style: 'currency',
    currency: 'USD',
  }), [dateTimeSettings.locale])

  const formatDelta = (cents: number | null | undefined) => cents == null ? '—' : money.format(cents / 100)
  const openHistoricalEvidence = (evidence: EvidenceReference, status: string) => {
    const providerId = evidenceProviderId(evidence)
    setHistoricalDetail(null)
    setDetailError(providerId ? null : 'This QuickBooks record does not have a provider transaction ID.')
    setDetailLoading(Boolean(providerId))
    setSelection({ kind: 'historical', evidence, status })
  }
  const openCurrentRow = (row: DraftParityRow) => {
    setHistoricalDetail(null)
    setDetailError(null)
    setDetailLoading(false)
    setSelection({ kind: 'current', row })
  }
  const closeDrawer = () => {
    setSelection(null)
    setHistoricalDetail(null)
    setDetailError(null)
    setDetailLoading(false)
  }
  const baseline = report?.historicalBaseline
  const visiblePairs = baseline?.pairs || []
  const visibleUnmatched = baseline?.unmatchedGroups || []
  const visibleAmbiguous = baseline?.ambiguousGroups || []
  const dateRangeInvalid = Boolean(fromInput && toInput && fromInput > toInput)
  const selectedHistoricalEvidence = selection?.kind === 'historical'
    ? historicalDetail?.evidence || selection.evidence
    : null
  const drawerEntityType = selection?.kind === 'historical'
    ? selection.evidence.entityType
    : selection?.kind === 'current' ? selection.row.expected.entityType : null
  const drawerTitle = selection?.kind === 'historical'
    ? evidenceLabel(selection.evidence)
    : selection?.kind === 'current'
      ? `${selection.row.expected.businessDate} · ${entityLabel(selection.row.expected.entityType)}`
      : ''
  const drawerOrigin = selection?.kind === 'current'
    ? 'ClawPilot'
    : originLabel(selectedHistoricalEvidence?.postingOrigin)

  const applyRange = () => {
    if (dateRangeInvalid) return
    setLoading(true)
    setError(null)
    closeDrawer()
    setPage(1)
    setHistoryPage(1)
    setFrom(fromInput)
    setTo(toInput)
  }

  const clearRange = () => {
    setLoading(true)
    setError(null)
    closeDrawer()
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
            Toast posting history and current ClawPilot accounting drafts
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
              title="Toast posting history"
              detail={`${report.cache.salesReceiptCount} receipts · ${report.cache.journalEntryCount} journals in cache`}
            />
            <Divider />
            <Typography variant="body2" color="text.secondary" px={{ xs: 1.5, sm: 2 }} pt={1.5}>
              Includes only QuickBooks records identified by an exact, date-matched Toast marker or a durable ClawPilot accounting-draft link. QuickBooks document numbers are shown for reference and never establish posting origin.
            </Typography>
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
            <Typography variant="caption" color="text.disabled" display="block" px={{ xs: 1.5, sm: 2 }} pb={1.5}>
              Sales receipts and settlement journals serve different accounting purposes, so their totals are not compared to each other. Receipt arithmetic and journal debits and credits are validated independently.
            </Typography>
          </Box>

          <Box sx={sectionSx}>
            <SectionHeader title="Posting history pairs" detail={`${baseline.summary.pairCount} receipt and journal pairs`} />
            <Divider />
            {visiblePairs.length ? visiblePairs.map((pair) => (
              <Box
                key={`${pair.businessDate}-${pair.salesReceipt.evidenceId}-${pair.journalEntry.evidenceId}`}
                display="grid"
                gridTemplateColumns={{ xs: '1fr', md: '130px minmax(180px, 1fr) minmax(180px, 1fr) 150px 150px' }}
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
                <EvidenceButton evidence={pair.salesReceipt} status={pair.receiptArithmetic.status} onOpen={openHistoricalEvidence} />
                <EvidenceButton evidence={pair.journalEntry} status={pair.journalBalance.status} onOpen={openHistoricalEvidence} />
                <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                  <Typography variant="caption" color="text.secondary">Receipt check</Typography>
                  <Box mt={0.5}><Chip size="small" color={statusColor(pair.receiptArithmetic.status)} variant="outlined" label={`${statusLabel(pair.receiptArithmetic.status)} · ${formatDelta(pair.receiptArithmetic.deltaCents)}`} /></Box>
                </Box>
                <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                  <Typography variant="caption" color="text.secondary">Journal check</Typography>
                  <Box mt={0.5}><Chip size="small" color={statusColor(pair.journalBalance.status)} variant="outlined" label={`${statusLabel(pair.journalBalance.status)} · ${formatDelta(pair.journalBalance.deltaCents)}`} /></Box>
                </Box>
              </Box>
            )) : <Typography color="text.secondary" p={2}>No Toast posting pairs in this period.</Typography>}
          </Box>

          {(baseline.unmatchedGroups.length || baseline.ambiguousGroups.length) ? (
            <Box sx={sectionSx}>
              <SectionHeader title="Posting history exceptions" detail={`${baseline.summary.unmatchedEvidence + baseline.summary.ambiguousEvidence} records require review`} />
              <Divider />
              {visibleAmbiguous.map((group, index) => (
                <Box key={`ambiguous-${group.businessDate}-${group.documentNumber}-${index}`} px={{ xs: 0.5, sm: 1 }} py={1} borderBottom="1px solid rgba(255,255,255,0.06)">
                  <Box px={1} pb={0.5} display="flex" alignItems="center" justifyContent="space-between" gap={2}>
                    <Box minWidth={0}>
                      <Typography variant="body2" fontWeight={700}>{group.businessDate} · {group.documentNumber || 'No document number'}</Typography>
                      <Typography variant="caption" color="text.secondary">{group.salesReceipts.length} receipts · {group.journalEntries.length} journals</Typography>
                    </Box>
                    <Chip size="small" color="warning" variant="outlined" label="Ambiguous" />
                  </Box>
                  <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }} gap={0.5}>
                    {[...group.salesReceipts, ...group.journalEntries].map((evidence) => (
                      <EvidenceButton key={evidence.evidenceId} evidence={evidence} status="ambiguous" onOpen={openHistoricalEvidence} />
                    ))}
                  </Box>
                </Box>
              ))}
              {visibleUnmatched.map((group, index) => (
                <Box key={`unmatched-${group.businessDate}-${group.documentNumber}-${group.entityType}-${index}`} px={{ xs: 0.5, sm: 1 }} py={1} borderBottom="1px solid rgba(255,255,255,0.06)">
                  <Box px={1} pb={0.5} display="flex" alignItems="center" justifyContent="space-between" gap={2}>
                    <Box minWidth={0}>
                      <Typography variant="body2" fontWeight={700}>{group.businessDate} · {group.documentNumber || 'No document number'}</Typography>
                      <Typography variant="caption" color="text.secondary">{group.evidence.length} {entityLabel(group.entityType).toLowerCase()} record{group.evidence.length === 1 ? '' : 's'}</Typography>
                    </Box>
                    <Chip size="small" color="error" variant="outlined" label="Unmatched" />
                  </Box>
                  <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }} gap={0.5}>
                    {group.evidence.map((evidence) => (
                      <EvidenceButton key={evidence.evidenceId} evidence={evidence} status="unmatched" onOpen={openHistoricalEvidence} />
                    ))}
                  </Box>
                </Box>
              ))}
            </Box>
          ) : null}

          {report.historicalPagination.totalPages > 1 ? (
            <Box sx={sectionSx} px={{ xs: 1.5, sm: 2 }} py={1.25} display="flex" alignItems="center" justifyContent="space-between" gap={2}>
              <Typography variant="caption" color="text.secondary">
                Posting history detail page {report.historicalPagination.page} of {report.historicalPagination.totalPages}
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
                component="button"
                type="button"
                onClick={() => openCurrentRow(row)}
                aria-label={`Open ${entityLabel(row.expected.entityType)} parity details for ${row.expected.businessDate}`}
                display="grid"
                gridTemplateColumns={{ xs: 'minmax(0, 1fr) auto', sm: '130px minmax(0, 1fr) 150px 150px 24px' }}
                gap={1.25}
                px={{ xs: 1.5, sm: 2 }}
                py={1.5}
                alignItems="center"
                width="100%"
                color="inherit"
                bgcolor="transparent"
                textAlign="left"
                border={0}
                borderBottom="1px solid rgba(255,255,255,0.06)"
                sx={{
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'rgba(255,255,255,0.025)' },
                  '&:focus-visible': { outline: '2px solid #A8C7FA', outlineOffset: '-2px' },
                }}
              >
                <Box>
                  <Typography variant="body2" fontWeight={700}>{row.expected.businessDate}</Typography>
                  <Typography variant="caption" color="text.disabled">Revision {row.expected.draft.revision}</Typography>
                </Box>
                <ChevronRightRounded fontSize="small" color="action" sx={{ display: { sm: 'none' } }} />
                <Box minWidth={0} sx={{ gridColumn: { xs: '1 / -1', sm: 'auto' } }}>
                  <Typography variant="body2" noWrap>{entityLabel(row.expected.entityType)}</Typography>
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
                <ChevronRightRounded fontSize="small" color="action" sx={{ display: { xs: 'none', sm: 'block' } }} />
                <Box display={{ xs: 'flex', sm: 'none' }} alignItems="center" gap={0.75} gridColumn="1 / -1" flexWrap="wrap">
                  <Chip size="small" color={statusColor(row.match.status)} variant="outlined" label={statusLabel(row.match.status)} />
                  <Chip size="small" color={statusColor(row.comparison?.status || 'insufficient_evidence')} variant="outlined" label={statusLabel(row.comparison?.status || 'insufficient_evidence')} />
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

      <Drawer
        anchor="right"
        open={Boolean(selection)}
        onClose={closeDrawer}
        PaperProps={{
          sx: {
            width: { xs: '100%', sm: 680, md: 760 },
            maxWidth: '100vw',
            bgcolor: '#171821',
            backgroundImage: 'none',
          },
        }}
      >
        {selection ? (
          <Box height="100%" display="flex" flexDirection="column" minWidth={0}>
            <Box px={{ xs: 2, sm: 2.5 }} py={2} display="flex" alignItems="flex-start" justifyContent="space-between" gap={2}>
              <Box minWidth={0}>
                <Box display="flex" alignItems="center" gap={0.75} flexWrap="wrap">
                  <Typography variant="caption" color="text.secondary" textTransform="uppercase">
                    {drawerEntityType ? entityLabel(drawerEntityType) : 'Posting evidence'}
                  </Typography>
                  <Chip size="small" variant="outlined" color="info" label={drawerOrigin} />
                </Box>
                <Typography variant="h6" fontWeight={700} mt={0.35} sx={{ overflowWrap: 'anywhere' }}>{drawerTitle}</Typography>
              </Box>
              <Tooltip title="Close posting details">
                <IconButton aria-label="Close posting details" onClick={closeDrawer}>
                  <CloseRounded />
                </IconButton>
              </Tooltip>
            </Box>
            <Divider />
            <Box flex={1} overflow="auto" px={{ xs: 2, sm: 2.5 }} py={2.5}>
              {selection.kind === 'historical' ? (
                detailLoading ? (
                  <Box minHeight={280} display="grid" sx={{ placeItems: 'center' }}><CircularProgress /></Box>
                ) : detailError ? (
                  <Alert severity="error">{detailError}</Alert>
                ) : historicalDetail ? (
                  <QuickBooksEvidenceDetails
                    evidence={historicalDetail.evidence}
                    integrity={historicalDetail.integrity}
                    contextStatus={selection.status}
                    formatCents={formatDelta}
                  />
                ) : null
              ) : (
                <Stack spacing={2.5} divider={<Divider flexItem />}>
                  <Box component="section">
                    <Box display="flex" alignItems="center" justifyContent="space-between" gap={1.5} mb={1.5}>
                      <Typography fontWeight={700}>Parity status</Typography>
                      <Chip size="small" variant="outlined" color={statusColor(selection.row.match.status)} label={statusLabel(selection.row.match.status)} />
                    </Box>
                    <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }} gap={1.5}>
                      <DetailField label="Evidence match" value={statusLabel(selection.row.match.status)} />
                      <DetailField label="Match basis" value={selection.row.match.basis ? statusLabel(selection.row.match.basis) : null} />
                      <DetailField label="Amount comparison" value={selection.row.comparison ? statusLabel(selection.row.comparison.status) : 'insufficient evidence'} />
                      <DetailField label="Reconciliation" value={statusLabel(selection.row.expected.draft.reconciliationStatus)} />
                      {selection.row.match.candidateTransactionIds.length ? (
                        <Box gridColumn={{ sm: '1 / -1' }}>
                          <DetailField label="Candidate QuickBooks IDs" value={selection.row.match.candidateTransactionIds.join(', ')} wrap />
                        </Box>
                      ) : null}
                    </Box>
                  </Box>
                  <ExpectedDocumentDetails expected={selection.row.expected} formatCents={formatDelta} />
                  {selection.row.actual ? (
                    <QuickBooksEvidenceDetails
                      evidence={selection.row.actual}
                      contextStatus={selection.row.match.status}
                      formatCents={formatDelta}
                    />
                  ) : (
                    <Alert severity={selection.row.match.status === 'missing_quickbooks' ? 'warning' : 'info'}>
                      No single normalized QuickBooks record is attached to this draft comparison.
                    </Alert>
                  )}
                  {selection.row.comparison ? (
                    <ComparisonDetails
                      expected={selection.row.expected}
                      comparison={selection.row.comparison}
                      formatCents={formatDelta}
                    />
                  ) : (
                    <Alert severity="warning">A line-level amount comparison is not available for this draft.</Alert>
                  )}
                </Stack>
              )}
            </Box>
          </Box>
        ) : null}
      </Drawer>
    </Stack>
  )
}
