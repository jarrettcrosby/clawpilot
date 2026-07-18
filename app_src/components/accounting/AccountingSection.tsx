'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import AttachFileRounded from '@mui/icons-material/AttachFileRounded'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type View = 'overview' | 'invoices' | 'receipts' | 'transactions' | 'products' | 'accounts' | 'customers' | 'vendors' | 'attachments'
type Range = '30d' | '90d' | 'ytd' | '12m' | 'all'
type ExplorerRow = Record<string, unknown> & { id: string }

type Overview = {
  connection: {
    configured: boolean
    companyName?: string
    status?: string
    syncEnabled?: boolean
    lastSyncedAt?: string | null
    lastErrorCode?: string | null
  }
  currencyCode: string | null
  counts: {
    accounts: number
    products: number
    customers: number
    vendors: number
    transactions: number
    attachments: number
  }
  metrics: {
    invoiced: number
    receivedSales: number
    expenses: number
    openInvoices: number
    overdueInvoices: number
    openInvoiceCount: number
    overdueInvoiceCount: number
  }
  trend: Array<{ month: string; sales: number; expenses: number }>
  transactionTypes: Array<{ type: string; count: number; total: number }>
  recent: ExplorerRow[]
}

type Capabilities = { canView: boolean; canManage: boolean }

type ListResult = {
  page: number
  pageSize: number
  total: number
  rows: ExplorerRow[]
}

type Column = {
  key: string
  label: string
  align?: 'left' | 'right'
  render: (row: ExplorerRow) => React.ReactNode
}

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'receipts', label: 'Receipts' },
  { id: 'transactions', label: 'All transactions' },
  { id: 'products', label: 'Products & services' },
  { id: 'accounts', label: 'Chart of accounts' },
  { id: 'customers', label: 'Customers' },
  { id: 'vendors', label: 'Vendors' },
  { id: 'attachments', label: 'Attachments' },
]

const RANGES: Array<{ id: Range; label: string }> = [
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'ytd', label: 'YTD' },
  { id: '12m', label: '12 months' },
  { id: 'all', label: 'All' },
]

const TRANSACTION_TYPES = [
  ['All', ''],
  ['Invoices', 'Invoice'],
  ['Payments', 'Payment'],
  ['Sales receipts', 'SalesReceipt'],
  ['Purchases', 'Purchase'],
  ['Bills', 'Bill'],
  ['Bill payments', 'BillPayment'],
  ['Credits', 'CreditMemo'],
  ['Refunds', 'RefundReceipt'],
] as const

const panelSx = {
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: '8px',
  backgroundColor: '#15151D',
}

function value(row: ExplorerRow, key: string) {
  return row[key]
}

function textValue(row: ExplorerRow, key: string, fallback = '—') {
  const candidate = value(row, key)
  return candidate === null || candidate === undefined || candidate === '' ? fallback : String(candidate)
}

function statusColor(status: string) {
  if (/overdue|error|inactive/i.test(status)) return 'error' as const
  if (/open|queued/i.test(status)) return 'warning' as const
  if (/paid|posted|active|connected/i.test(status)) return 'success' as const
  return 'default' as const
}

function formatBytes(value: unknown) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function recordTitle(view: View, row: ExplorerRow) {
  if (view === 'accounts') return textValue(row, 'fullyQualifiedName')
  if (view === 'products') return textValue(row, 'fullyQualifiedName')
  if (view === 'customers' || view === 'vendors') return textValue(row, 'displayName')
  if (view === 'attachments') return textValue(row, 'fileName', 'Attachment')
  const documentNumber = textValue(row, 'documentNumber', '')
  return `${textValue(row, 'entityType', 'Transaction')}${documentNumber ? ` ${documentNumber}` : ''}`
}

function Metric({ label, value, detail, color = '#F3F4F6', onClick }: {
  label: string
  value: string
  detail?: string
  color?: string
  onClick?: () => void
}) {
  return (
    <Box
      component={onClick ? 'button' : 'div'}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      sx={{
        minWidth: 164,
        minHeight: 92,
        p: 1.75,
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
        cursor: onClick ? 'pointer' : 'default',
        ...panelSx,
        '&:hover': onClick ? { borderColor: 'rgba(168,199,250,0.42)', backgroundColor: '#181923' } : undefined,
      }}
    >
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography fontSize="1.45rem" fontWeight={700} color={color} mt={0.4} noWrap>{value}</Typography>
      {detail ? <Typography variant="caption" color="text.disabled">{detail}</Typography> : null}
    </Box>
  )
}

function TrendChart({ rows, money }: {
  rows: Overview['trend']
  money: (amount: number, currencyCode?: string | null, compact?: boolean) => string
}) {
  const max = Math.max(1, ...rows.flatMap((row) => [row.sales, row.expenses]))
  return (
    <Box sx={{ ...panelSx, p: { xs: 1.5, sm: 2 }, minHeight: 238 }}>
      <Box display="flex" justifyContent="space-between" alignItems="flex-start" gap={2} mb={2}>
        <Box>
          <Typography fontWeight={700}>Sales and expense activity</Typography>
          <Typography variant="caption" color="text.secondary">Six-month transaction-form trend</Typography>
        </Box>
        <Stack direction="row" spacing={1.5} flexShrink={0}>
          <Typography variant="caption" color="#70D6A7">Sales</Typography>
          <Typography variant="caption" color="#F2B76D">Expenses</Typography>
        </Stack>
      </Box>
      <Box display="grid" gridTemplateColumns={`repeat(${Math.max(rows.length, 1)}, minmax(44px, 1fr))`} gap={1} height={158}>
        {rows.map((row) => (
          <Tooltip key={row.month} title={`${money(row.sales)} sales · ${money(row.expenses)} expenses`}>
            <Box display="grid" gridTemplateRows="1fr auto" minWidth={0}>
              <Box display="flex" alignItems="flex-end" justifyContent="center" gap="4px" minHeight={0}>
                <Box aria-label={`${row.month} sales ${money(row.sales)}`} sx={{ width: '34%', maxWidth: 24, height: `${Math.max(2, (row.sales / max) * 100)}%`, bgcolor: '#70D6A7', borderRadius: '3px 3px 0 0' }} />
                <Box aria-label={`${row.month} expenses ${money(row.expenses)}`} sx={{ width: '34%', maxWidth: 24, height: `${Math.max(2, (row.expenses / max) * 100)}%`, bgcolor: '#F2B76D', borderRadius: '3px 3px 0 0' }} />
              </Box>
              <Typography variant="caption" color="text.disabled" textAlign="center" mt={0.75} noWrap>
                {new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(`${row.month}-15T12:00:00Z`))}
              </Typography>
            </Box>
          </Tooltip>
        ))}
      </Box>
    </Box>
  )
}

export default function AccountingSection() {
  const dateTimeSettings = useUserDateTime()
  const [view, setView] = useState<View>('overview')
  const [range, setRange] = useState<Range>('ytd')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [result, setResult] = useState<ListResult>({ page: 1, pageSize: 25, total: 0, rows: [] })
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [entityType, setEntityType] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ view: View; row: ExplorerRow } | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ range })
    if (view !== 'overview') {
      params.set('view', view)
      params.set('page', String(page))
      params.set('pageSize', '25')
      if (search) params.set('search', search)
      if (status) params.set('status', status)
      if (view === 'transactions' && entityType) params.set('entityType', entityType)
    }
    fetch(`/api/accounting/quickbooks?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as {
          ok?: boolean
          error?: string
          capabilities?: Capabilities
          overview?: Overview
          result?: ListResult
        }
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'Accounting data is unavailable')
        if (payload.capabilities) setCapabilities(payload.capabilities)
        if (payload.overview) setOverview(payload.overview)
        if (payload.result) setResult(payload.result)
      })
      .catch((fetchError) => {
        if ((fetchError as Error).name !== 'AbortError') setError((fetchError as Error).message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [entityType, page, range, search, status, view])

  const money = useMemo(() => (amount: number, currencyCode?: string | null, compact = false) => {
    const currency = currencyCode || overview?.currencyCode
    try {
      if (currency) {
        return new Intl.NumberFormat(dateTimeSettings.locale, {
          style: 'currency',
          currency,
          notation: compact ? 'compact' : 'standard',
          maximumFractionDigits: compact ? 1 : 2,
        }).format(Number(amount || 0))
      }
    } catch {}
    return new Intl.NumberFormat(dateTimeSettings.locale, {
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: 2,
    }).format(Number(amount || 0))
  }, [dateTimeSettings.locale, overview?.currencyCode])

  const dateOnly = useMemo(() => (candidate: unknown) => {
    const value = String(candidate || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '—'
    return new Intl.DateTimeFormat(dateTimeSettings.locale, { dateStyle: 'medium', timeZone: 'UTC' })
      .format(new Date(`${value}T12:00:00Z`))
  }, [dateTimeSettings.locale])

  async function queueRefresh() {
    setRefreshing(true)
    setNotice(null)
    setError(null)
    try {
      const response = await fetch('/api/integrations/quickbooks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-catalog' }),
      })
      const payload = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to queue QuickBooks refresh')
      setNotice('QuickBooks refresh queued')
    } catch (refreshError) {
      setError((refreshError as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  const columns = useMemo<Column[]>(() => {
    const state = (row: ExplorerRow) => (
      <Chip size="small" variant="outlined" color={statusColor(textValue(row, 'status', textValue(row, 'active') === 'true' ? 'Active' : 'Inactive'))} label={textValue(row, 'status', textValue(row, 'active') === 'true' ? 'Active' : 'Inactive')} />
    )
    if (view === 'accounts') return [
      { key: 'name', label: 'Account', render: (row) => <Box><Typography variant="body2" fontWeight={600}>{textValue(row, 'name')}</Typography><Typography variant="caption" color="text.disabled">{textValue(row, 'fullyQualifiedName')}</Typography></Box> },
      { key: 'classification', label: 'Classification', render: (row) => textValue(row, 'classification') },
      { key: 'accountType', label: 'Type', render: (row) => <Box><Typography variant="body2">{textValue(row, 'accountType')}</Typography><Typography variant="caption" color="text.disabled">{textValue(row, 'accountSubType')}</Typography></Box> },
      { key: 'currentBalance', label: 'Balance', align: 'right', render: (row) => money(Number(value(row, 'currentBalance') || 0), textValue(row, 'currencyCode', '')) },
      { key: 'active', label: 'Status', render: state },
    ]
    if (view === 'products') return [
      { key: 'name', label: 'Product or service', render: (row) => <Box><Typography variant="body2" fontWeight={600}>{textValue(row, 'name')}</Typography><Typography variant="caption" color="text.disabled">{textValue(row, 'sku', textValue(row, 'fullyQualifiedName'))}</Typography></Box> },
      { key: 'itemType', label: 'Type', render: (row) => textValue(row, 'itemType') },
      { key: 'unitPrice', label: 'Sales price', align: 'right', render: (row) => money(Number(value(row, 'unitPrice') || 0)) },
      { key: 'purchaseCost', label: 'Cost', align: 'right', render: (row) => money(Number(value(row, 'purchaseCost') || 0)) },
      { key: 'quantityOnHand', label: 'On hand', align: 'right', render: (row) => value(row, 'trackQuantity') ? textValue(row, 'quantityOnHand', '0') : '—' },
      { key: 'active', label: 'Status', render: state },
    ]
    if (view === 'customers' || view === 'vendors') return [
      { key: 'displayName', label: view === 'customers' ? 'Customer' : 'Vendor', render: (row) => <Box><Typography variant="body2" fontWeight={600}>{textValue(row, 'displayName')}</Typography><Typography variant="caption" color="text.disabled">{textValue(row, 'companyName')}</Typography></Box> },
      { key: 'email', label: 'Email', render: (row) => textValue(row, 'email') },
      { key: 'phone', label: 'Phone', render: (row) => textValue(row, 'phone') },
      { key: 'balance', label: 'Balance', align: 'right', render: (row) => money(Number(value(row, 'balance') || 0), textValue(row, 'currencyCode', '')) },
      { key: 'active', label: 'Status', render: state },
    ]
    if (view === 'attachments') return [
      { key: 'fileName', label: 'File', render: (row) => <Box display="flex" alignItems="center" gap={1}><AttachFileRounded sx={{ fontSize: 18, color: 'text.disabled' }} /><Typography variant="body2" fontWeight={600}>{textValue(row, 'fileName', 'Attachment')}</Typography></Box> },
      { key: 'contentType', label: 'Type', render: (row) => textValue(row, 'contentType') },
      { key: 'sizeBytes', label: 'Size', align: 'right', render: (row) => formatBytes(value(row, 'sizeBytes')) },
      { key: 'entityReferences', label: 'Linked record', render: (row) => {
        const refs = Array.isArray(value(row, 'entityReferences')) ? value(row, 'entityReferences') as Array<Record<string, unknown>> : []
        return refs.length ? refs.map((ref) => [ref.type, ref.name || ref.id].filter(Boolean).join(' ')).join(', ') : '—'
      } },
      { key: 'note', label: 'Note', render: (row) => <Typography variant="body2" noWrap maxWidth={320}>{textValue(row, 'note')}</Typography> },
    ]
    return [
      { key: 'entityType', label: 'Type', render: (row) => textValue(row, 'entityType') },
      { key: 'transactionDate', label: 'Date', render: (row) => dateOnly(value(row, 'transactionDate')) },
      { key: 'documentNumber', label: 'Number', render: (row) => textValue(row, 'documentNumber') },
      { key: 'partyName', label: view === 'receipts' ? 'Customer or vendor' : 'Customer', render: (row) => textValue(row, 'partyName') },
      { key: 'totalAmount', label: 'Total', align: 'right', render: (row) => money(Number(value(row, 'totalAmount') || 0), textValue(row, 'currencyCode', '')) },
      { key: 'openBalance', label: 'Open', align: 'right', render: (row) => Number(value(row, 'openBalance') || 0) ? money(Number(value(row, 'openBalance')), textValue(row, 'currencyCode', '')) : '—' },
      { key: 'status', label: 'Status', render: state },
    ]
  }, [dateOnly, money, view])

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))
  const connection = overview?.connection
  const rangeLabel = RANGES.find((candidate) => candidate.id === range)?.label || 'YTD'

  return (
    <Box height="100%" display="flex" flexDirection="column" minWidth={0} bgcolor="#0F0F13">
      <Box sx={{ px: { xs: 2, md: 3 }, pt: { xs: 2, md: 2.5 }, pb: 1.5, flexShrink: 0 }}>
        <Box display="flex" alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between" gap={2} flexWrap="wrap">
          <Box minWidth={0}>
            <Box display="flex" alignItems="center" gap={1.25}>
              <AccountBalanceRounded sx={{ color: '#A8C7FA' }} />
              <Typography variant="h5" fontWeight={700}>Accounting</Typography>
              <Chip size="small" label="Read only" variant="outlined" />
            </Box>
            <Typography variant="body2" color="text.secondary" mt={0.25} noWrap>
              {connection?.configured ? connection.companyName : 'QuickBooks company not connected'}
            </Typography>
          </Box>
          <Box display="flex" alignItems="center" gap={1}>
            {connection?.configured ? (
              <Chip
                size="small"
                color={connection.status === 'active' ? 'success' : 'error'}
                variant="outlined"
                label={connection.status === 'active' ? 'Connected' : 'Needs attention'}
              />
            ) : null}
            {capabilities?.canManage && connection?.configured ? (
              <Tooltip title="Refresh QuickBooks data">
                <span>
                  <IconButton aria-label="Refresh QuickBooks data" onClick={() => { void queueRefresh() }} disabled={refreshing} sx={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px' }}>
                    {refreshing ? <CircularProgress size={20} /> : <RefreshRounded />}
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
          </Box>
        </Box>
        {connection?.lastSyncedAt ? (
          <Typography variant="caption" color="text.disabled" display="block" mt={0.75}>
            Last synced {formatUserDateTime(connection.lastSyncedAt, dateTimeSettings, { dateStyle: 'medium', timeStyle: 'short' })}
          </Typography>
        ) : null}
      </Box>

      <Tabs
        value={view}
        onChange={(_, next: View) => { setView(next); setPage(1); setSearchInput(''); setSearch(''); setStatus(''); setEntityType(''); setSelected(null) }}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ px: { xs: 1, md: 2 }, borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, '& .MuiTab-root': { minHeight: 48, textTransform: 'none', letterSpacing: 0, whiteSpace: 'nowrap' } }}
      >
        {VIEWS.map((candidate) => <Tab key={candidate.id} value={candidate.id} label={candidate.label} />)}
      </Tabs>

      <Box flex={1} minHeight={0} overflow="auto" sx={{ WebkitOverflowScrolling: 'touch' }}>
        <Box sx={{ px: { xs: 2, md: 3 }, py: 2.5, maxWidth: 1500, mx: 'auto' }}>
          {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
          {notice ? <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 2 }}>{notice}</Alert> : null}

          {!connection?.configured && !loading && !error ? (
            <Alert severity="info">QuickBooks is not connected for this organization. An organization administrator can connect it in Settings.</Alert>
          ) : null}

          {view === 'overview' ? (
            loading && !overview ? (
              <Box display="grid" sx={{ placeItems: 'center' }} minHeight={300}><CircularProgress /></Box>
            ) : overview ? (
              <Stack spacing={2.5}>
                <Box display="flex" gap={1.5} overflow="auto" pb={0.5} sx={{ scrollbarWidth: 'thin' }}>
                  <Metric label={`Invoices · ${rangeLabel}`} value={money(overview.metrics.invoiced, null, true)} detail="Issued invoice value" onClick={() => setView('invoices')} />
                  <Metric label="Open receivables" value={money(overview.metrics.openInvoices, null, true)} detail={`${overview.metrics.openInvoiceCount} invoices`} color="#A8C7FA" onClick={() => { setView('invoices'); setStatus('Open') }} />
                  <Metric label="Overdue" value={money(overview.metrics.overdueInvoices, null, true)} detail={`${overview.metrics.overdueInvoiceCount} invoices`} color={overview.metrics.overdueInvoiceCount ? '#FF8A80' : '#70D6A7'} onClick={() => { setView('invoices'); setStatus('Overdue') }} />
                  <Metric label={`Sales receipts · ${rangeLabel}`} value={money(overview.metrics.receivedSales, null, true)} detail="Paid at sale" onClick={() => setView('receipts')} />
                  <Metric label={`Expenses · ${rangeLabel}`} value={money(overview.metrics.expenses, null, true)} detail="Purchases and bills" color="#F2B76D" onClick={() => setView('receipts')} />
                  <Metric label="Products & services" value={overview.counts.products.toLocaleString(dateTimeSettings.locale)} detail={`${overview.counts.accounts} accounts`} onClick={() => setView('products')} />
                </Box>

                <Box display="flex" gap={1} flexWrap="wrap" alignItems="center">
                  {RANGES.map((candidate) => (
                    <Button key={candidate.id} size="small" variant={range === candidate.id ? 'contained' : 'outlined'} onClick={() => setRange(candidate.id)} sx={{ borderRadius: '8px', minWidth: 0 }}>
                      {candidate.label}
                    </Button>
                  ))}
                </Box>

                <Box display="grid" gridTemplateColumns={{ xs: '1fr', lg: 'minmax(0, 1.35fr) minmax(320px, 0.65fr)' }} gap={2}>
                  <TrendChart rows={overview.trend} money={money} />
                  <Box sx={{ ...panelSx, p: 2, minHeight: 238 }}>
                    <Typography fontWeight={700}>QuickBooks records</Typography>
                    <Typography variant="caption" color="text.secondary">Current organization snapshot</Typography>
                    <Box display="grid" gridTemplateColumns="1fr auto" gap={1.25} mt={2}>
                      {[
                        ['Transactions', overview.counts.transactions, 'transactions'],
                        ['Customers', overview.counts.customers, 'customers'],
                        ['Vendors', overview.counts.vendors, 'vendors'],
                        ['Accounts', overview.counts.accounts, 'accounts'],
                        ['Products & services', overview.counts.products, 'products'],
                        ['Attachments', overview.counts.attachments, 'attachments'],
                      ].map(([label, count, target]) => (
                        <Box key={String(label)} display="contents">
                          <Button onClick={() => setView(target as View)} sx={{ justifyContent: 'flex-start', color: 'text.secondary', minWidth: 0, p: 0, textTransform: 'none' }}>{String(label)}</Button>
                          <Typography fontWeight={700} textAlign="right">{Number(count).toLocaleString(dateTimeSettings.locale)}</Typography>
                        </Box>
                      ))}
                    </Box>
                  </Box>
                </Box>

                <Box sx={{ ...panelSx, overflow: 'hidden' }}>
                  <Box px={2} py={1.75} display="flex" alignItems="center" justifyContent="space-between">
                    <Box>
                      <Typography fontWeight={700}>Recent transactions</Typography>
                      <Typography variant="caption" color="text.secondary">Latest synced activity</Typography>
                    </Box>
                    <Button size="small" endIcon={<ChevronRightRounded />} onClick={() => setView('transactions')}>View all</Button>
                  </Box>
                  <Divider />
                  {overview.recent.length ? overview.recent.map((row) => (
                    <Box key={`${row.entityType}-${row.id}`} component="button" type="button" onClick={() => setSelected({ view: 'transactions', row })} sx={{ width: '100%', border: 0, borderBottom: '1px solid rgba(255,255,255,0.06)', bgcolor: 'transparent', color: 'inherit', p: 1.75, display: 'grid', gridTemplateColumns: { xs: '1fr auto', sm: '150px minmax(160px, 1fr) 140px 110px' }, gap: 1.5, alignItems: 'center', textAlign: 'left', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(255,255,255,0.025)' } }}>
                      <Box><Typography variant="body2" fontWeight={600}>{textValue(row, 'entityType')}</Typography><Typography variant="caption" color="text.disabled">{textValue(row, 'documentNumber')}</Typography></Box>
                      <Typography variant="body2" noWrap sx={{ display: { xs: 'none', sm: 'block' } }}>{textValue(row, 'partyName')}</Typography>
                      <Typography variant="body2" textAlign={{ xs: 'right', sm: 'left' }}>{money(Number(value(row, 'totalAmount') || 0), textValue(row, 'currencyCode', ''))}</Typography>
                      <Box sx={{ display: { xs: 'none', sm: 'block' } }}><Chip size="small" variant="outlined" color={statusColor(textValue(row, 'status'))} label={textValue(row, 'status')} /></Box>
                    </Box>
                  )) : <Typography color="text.secondary" p={2}>No synced transactions.</Typography>}
                </Box>
                <Alert severity="info" variant="outlined">Activity totals are operational views of synced transaction forms, not formal financial statements.</Alert>
              </Stack>
            ) : null
          ) : (
            <Stack spacing={2}>
              <Box display="flex" alignItems={{ xs: 'stretch', sm: 'center' }} gap={1.25} flexDirection={{ xs: 'column', sm: 'row' }}>
                <TextField
                  size="small"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder={`Search ${VIEWS.find((candidate) => candidate.id === view)?.label.toLowerCase()}`}
                  inputProps={{ 'aria-label': `Search ${view}` }}
                  InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }}
                  sx={{ flex: 1, minWidth: 0, '& .MuiOutlinedInput-root': { borderRadius: '8px', bgcolor: '#15151D' } }}
                />
                {view === 'invoices' || view === 'transactions' ? (
                  <TextField select size="small" label="Status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }} sx={{ minWidth: { sm: 140 }, '& .MuiOutlinedInput-root': { borderRadius: '8px' } }}>
                    <MenuItem value="">All statuses</MenuItem>
                    <MenuItem value="Open">Open</MenuItem>
                    <MenuItem value="Overdue">Overdue</MenuItem>
                    <MenuItem value="Paid">Paid</MenuItem>
                    <MenuItem value="Posted">Posted</MenuItem>
                  </TextField>
                ) : null}
                {view === 'transactions' ? (
                  <TextField select size="small" label="Type" value={entityType} onChange={(event) => { setEntityType(event.target.value); setPage(1) }} sx={{ minWidth: { sm: 170 }, '& .MuiOutlinedInput-root': { borderRadius: '8px' } }}>
                    {TRANSACTION_TYPES.map(([label, id]) => <MenuItem key={label} value={id}>{label}</MenuItem>)}
                  </TextField>
                ) : null}
                {['invoices', 'receipts', 'transactions'].includes(view) ? (
                  <TextField select size="small" label="Period" value={range} onChange={(event) => { setRange(event.target.value as Range); setPage(1) }} sx={{ minWidth: { sm: 145 }, '& .MuiOutlinedInput-root': { borderRadius: '8px' } }}>
                    {RANGES.map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.label}</MenuItem>)}
                  </TextField>
                ) : null}
              </Box>

              <Box sx={{ ...panelSx, overflow: 'hidden', minHeight: 260, position: 'relative' }}>
                {loading ? <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', bgcolor: 'rgba(15,15,19,0.62)', zIndex: 2 }}><CircularProgress size={28} /></Box> : null}
                <TableContainer sx={{ display: { xs: 'none', md: 'block' }, maxHeight: 'calc(100dvh - 310px)' }}>
                  <Table stickyHeader size="small" aria-label={`${view} table`}>
                    <TableHead><TableRow>{columns.map((column) => <TableCell key={column.key} align={column.align || 'left'} sx={{ bgcolor: '#171821', color: 'text.secondary', fontWeight: 700, whiteSpace: 'nowrap' }}>{column.label}</TableCell>)}</TableRow></TableHead>
                    <TableBody>
                      {result.rows.map((row) => (
                        <TableRow key={row.id} hover tabIndex={0} onClick={() => setSelected({ view, row })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelected({ view, row }) }} sx={{ cursor: 'pointer', '& td': { borderColor: 'rgba(255,255,255,0.065)' } }}>
                          {columns.map((column) => <TableCell key={column.key} align={column.align || 'left'}>{column.render(row)}</TableCell>)}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>

                <Box sx={{ display: { xs: 'block', md: 'none' } }}>
                  {result.rows.map((row) => (
                    <Box key={row.id} component="button" type="button" onClick={() => setSelected({ view, row })} sx={{ width: '100%', border: 0, borderBottom: '1px solid rgba(255,255,255,0.07)', bgcolor: 'transparent', color: 'inherit', p: 1.75, textAlign: 'left', cursor: 'pointer' }}>
                      <Box display="flex" alignItems="flex-start" justifyContent="space-between" gap={1.5}>
                        <Typography fontWeight={650} lineHeight={1.35}>{recordTitle(view, row)}</Typography>
                        {'status' in row ? <Chip size="small" variant="outlined" color={statusColor(textValue(row, 'status'))} label={textValue(row, 'status')} /> : null}
                      </Box>
                      <Typography variant="body2" color="text.secondary" mt={0.75}>
                        {view === 'accounts' ? [textValue(row, 'classification', ''), textValue(row, 'accountType', '')].filter(Boolean).join(' · ')
                          : view === 'products' ? [textValue(row, 'itemType', ''), textValue(row, 'sku', '')].filter(Boolean).join(' · ')
                            : view === 'customers' || view === 'vendors' ? [textValue(row, 'companyName', ''), textValue(row, 'email', '')].filter(Boolean).join(' · ')
                              : view === 'attachments' ? [textValue(row, 'contentType', ''), formatBytes(value(row, 'sizeBytes'))].filter(Boolean).join(' · ')
                                : [dateOnly(value(row, 'transactionDate')), textValue(row, 'partyName', '')].filter(Boolean).join(' · ')}
                      </Typography>
                      <Typography variant="body2" mt={0.75} color={view === 'accounts' || view === 'products' || view === 'customers' || view === 'vendors' ? 'text.primary' : '#70D6A7'}>
                        {view === 'accounts' ? money(Number(value(row, 'currentBalance') || 0), textValue(row, 'currencyCode', ''))
                          : view === 'products' ? money(Number(value(row, 'unitPrice') || 0))
                            : view === 'customers' || view === 'vendors' ? money(Number(value(row, 'balance') || 0), textValue(row, 'currencyCode', ''))
                              : view === 'attachments' ? textValue(row, 'note', '')
                                : money(Number(value(row, 'totalAmount') || 0), textValue(row, 'currencyCode', ''))}
                      </Typography>
                    </Box>
                  ))}
                </Box>

                {!loading && result.rows.length === 0 ? <Box display="grid" sx={{ placeItems: 'center' }} minHeight={250} px={2}><Typography color="text.secondary">No matching QuickBooks records.</Typography></Box> : null}
                <Divider />
                <Box px={1.5} py={1} display="flex" alignItems="center" justifyContent="space-between" gap={1}>
                  <Typography variant="caption" color="text.secondary">
                    {result.total ? `${((result.page - 1) * result.pageSize + 1).toLocaleString()}–${Math.min(result.page * result.pageSize, result.total).toLocaleString()} of ${result.total.toLocaleString()}` : '0 records'}
                  </Typography>
                  <Box display="flex" gap={0.5}>
                    <IconButton aria-label="Previous page" size="small" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeftRounded /></IconButton>
                    <Typography variant="caption" minWidth={62} textAlign="center" alignSelf="center">{page} / {totalPages}</Typography>
                    <IconButton aria-label="Next page" size="small" disabled={page >= totalPages || loading} onClick={() => setPage((current) => current + 1)}><ChevronRightRounded /></IconButton>
                  </Box>
                </Box>
              </Box>
            </Stack>
          )}
        </Box>
      </Box>

      <Drawer
        anchor="right"
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        PaperProps={{ sx: { width: { xs: '100%', sm: 440 }, maxWidth: '100vw', bgcolor: '#171821', backgroundImage: 'none' } }}
      >
        {selected ? (
          <Box height="100%" display="flex" flexDirection="column">
            <Box px={2.5} py={2} display="flex" alignItems="flex-start" justifyContent="space-between" gap={2}>
              <Box minWidth={0}>
                <Typography variant="caption" color="text.secondary" textTransform="uppercase">QuickBooks {selected.view === 'transactions' ? textValue(selected.row, 'entityType', 'record') : selected.view.replace(/s$/, '')}</Typography>
                <Typography variant="h6" fontWeight={700} mt={0.25}>{recordTitle(selected.view, selected.row)}</Typography>
              </Box>
              <IconButton aria-label="Close record details" onClick={() => setSelected(null)}><CloseRounded /></IconButton>
            </Box>
            <Divider />
            <Box flex={1} overflow="auto" p={2.5}>
              <Stack spacing={2}>
                {columns.map((column) => (
                  <Box key={column.key}>
                    <Typography variant="caption" color="text.disabled" display="block" mb={0.5}>{column.label}</Typography>
                    <Box sx={{ '& .MuiTypography-root': { whiteSpace: 'normal' } }}>{column.render(selected.row)}</Box>
                  </Box>
                ))}
                {selected.view !== 'accounts' && selected.view !== 'products' && selected.view !== 'customers' && selected.view !== 'vendors' && selected.view !== 'attachments' ? (
                  <>
                    <Box><Typography variant="caption" color="text.disabled" display="block" mb={0.5}>Due date</Typography><Typography variant="body2">{dateOnly(value(selected.row, 'dueDate'))}</Typography></Box>
                    <Box><Typography variant="caption" color="text.disabled" display="block" mb={0.5}>Account</Typography><Typography variant="body2">{textValue(selected.row, 'accountName')}</Typography></Box>
                    <Box><Typography variant="caption" color="text.disabled" display="block" mb={0.5}>Payment method</Typography><Typography variant="body2">{textValue(selected.row, 'paymentMethod')}</Typography></Box>
                    <Box><Typography variant="caption" color="text.disabled" display="block" mb={0.5}>Memo</Typography><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{textValue(selected.row, 'memo')}</Typography></Box>
                  </>
                ) : null}
              </Stack>
            </Box>
          </Box>
        ) : null}
      </Drawer>
    </Box>
  )
}
