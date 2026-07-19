'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import LinearProgress from '@mui/material/LinearProgress'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Tabs from '@mui/material/Tabs'
import Typography from '@mui/material/Typography'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import BarChartRounded from '@mui/icons-material/BarChartRounded'
import CreditCardRounded from '@mui/icons-material/CreditCardRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded'
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded'

type DataRecord = Record<string, unknown>
type ReportView = 'sales' | 'products' | 'payments' | 'trends'

type PosReportsPanelProps = {
  from: string
  to: string
  location: string
  revision: number
  money: (amount: number, compact?: boolean) => string
  number: (value: number, maximumFractionDigits?: number) => string
  dateLabel: (value: unknown, short?: boolean) => string
}

const panelSx = {
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: '8px',
  backgroundColor: '#15151D',
}

function record(value: unknown): DataRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DataRecord : {}
}

function rows(value: unknown): DataRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : []
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() || fallback : fallback
}

function amount(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function availableMetric(value: unknown) {
  const source = record(value)
  return {
    available: source.available === true,
    value: amount(source.value),
    reason: text(source.reason),
  }
}

function MetricCard({ label, value, detail, color = '#F3F4F6' }: {
  label: string
  value: string
  detail: string
  color?: string
}) {
  return (
    <Box sx={{ ...panelSx, p: 1.5, minHeight: 90, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" display="block" noWrap>{label}</Typography>
      <Typography fontSize="1.3rem" fontWeight={700} color={color} mt={0.35} noWrap>{value}</Typography>
      <Typography variant="caption" color="text.disabled" display="block" noWrap>{detail}</Typography>
    </Box>
  )
}

function SectionHeader({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <Box display="flex" alignItems="center" gap={1} px={{ xs: 1.5, sm: 2 }} py={1.5}>
      <Box color="#A8C7FA" display="flex" alignItems="center">{icon}</Box>
      <Box minWidth={0}>
        <Typography fontWeight={700}>{title}</Typography>
        <Typography variant="caption" color="text.secondary" display="block" noWrap>{detail}</Typography>
      </Box>
    </Box>
  )
}

function RankedRows({ items, money, number }: {
  items: DataRecord[]
  money: PosReportsPanelProps['money']
  number: PosReportsPanelProps['number']
}) {
  const maximum = Math.max(1, ...items.map((item) => amount(item.netSales)))
  return (
    <Box>
      {items.map((item, index) => {
        const netSales = amount(item.netSales)
        return (
          <Box key={`${text(item.productId || item.categoryId || item.name)}-${index}`} px={{ xs: 1.5, sm: 2 }} py={1.2} borderTop="1px solid rgba(255,255,255,0.065)">
            <Box display="grid" gridTemplateColumns="minmax(0, 1fr) auto" gap={1.5} alignItems="center">
              <Box minWidth={0}>
                <Typography variant="body2" fontWeight={650} noWrap>{text(item.name, 'Uncategorized')}</Typography>
                <Typography variant="caption" color="text.secondary" display="block" noWrap>
                  {number(amount(item.quantity), 2)} sold | {number(amount(item.selectionCount || item.receiptCount))} selections
                </Typography>
              </Box>
              <Typography variant="body2" fontWeight={700} whiteSpace="nowrap">{money(netSales)}</Typography>
            </Box>
            <Box mt={0.85} height={4} borderRadius="2px" bgcolor="rgba(255,255,255,0.06)" overflow="hidden">
              <Box width={`${Math.max(2, (netSales / maximum) * 100)}%`} height="100%" bgcolor="#70D6A7" />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function DailySalesRows({ items, money, number, dateLabel }: {
  items: DataRecord[]
  money: PosReportsPanelProps['money']
  number: PosReportsPanelProps['number']
  dateLabel: PosReportsPanelProps['dateLabel']
}) {
  return (
    <Box sx={{ ...panelSx, overflow: 'hidden' }}>
      <SectionHeader icon={<ReceiptLongRounded fontSize="small" />} title="Business days" detail="Toast sales summarized by business date" />
      <TableContainer sx={{ display: { xs: 'none', md: 'block' } }}>
        <Table size="small" aria-label="POS daily sales">
          <TableHead>
            <TableRow>
              {['Date', 'Orders', 'Checks', 'Guests', 'Net sales', 'Tax', 'Tips', 'Total'].map((label, index) => (
                <TableCell
                  key={label}
                  align={index > 0 ? 'right' : 'left'}
                  sx={{ bgcolor: '#171821', color: 'text.secondary', fontWeight: 700, whiteSpace: 'nowrap' }}
                >
                  {label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((item, index) => (
              <TableRow key={`${text(item.businessDate)}-${index}`} sx={{ '& td': { borderColor: 'rgba(255,255,255,0.065)' } }}>
                <TableCell><Typography variant="body2" fontWeight={650}>{dateLabel(item.businessDate)}</Typography></TableCell>
                <TableCell align="right">{number(amount(item.orderCount))}</TableCell>
                <TableCell align="right">{number(amount(item.checkCount))}</TableCell>
                <TableCell align="right">{number(amount(item.guestCount))}</TableCell>
                <TableCell align="right"><Typography variant="body2" fontWeight={700}>{money(amount(item.netSales))}</Typography></TableCell>
                <TableCell align="right">{money(amount(item.tax))}</TableCell>
                <TableCell align="right">{money(amount(item.tips))}</TableCell>
                <TableCell align="right">{money(amount(item.total))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ display: { xs: 'block', md: 'none' } }}>
        {items.map((item, index) => (
          <Box key={`${text(item.businessDate)}-${index}`} px={1.5} py={1.25} borderTop="1px solid rgba(255,255,255,0.065)">
            <Box display="flex" alignItems="baseline" justifyContent="space-between" gap={1.5}>
              <Typography variant="body2" fontWeight={700}>{dateLabel(item.businessDate)}</Typography>
              <Typography variant="body2" fontWeight={750} color="#70D6A7">{money(amount(item.netSales))}</Typography>
            </Box>
            <Box display="grid" gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap={1} mt={1}>
              <Box><Typography variant="caption" color="text.disabled" display="block">Orders</Typography><Typography variant="body2">{number(amount(item.orderCount))}</Typography></Box>
              <Box><Typography variant="caption" color="text.disabled" display="block">Checks</Typography><Typography variant="body2">{number(amount(item.checkCount))}</Typography></Box>
              <Box><Typography variant="caption" color="text.disabled" display="block">Guests</Typography><Typography variant="body2">{number(amount(item.guestCount))}</Typography></Box>
            </Box>
            <Typography variant="caption" color="text.secondary" display="block" mt={0.75}>
              Tax {money(amount(item.tax))} | Tips {money(amount(item.tips))} | Total {money(amount(item.total))}
            </Typography>
          </Box>
        ))}
      </Box>
      {!items.length ? <Typography variant="body2" color="text.secondary" px={2} pb={2}>No business-day sales are available.</Typography> : null}
    </Box>
  )
}

function ProductTable({ items, totalNetSales, money, number }: {
  items: DataRecord[]
  totalNetSales: number
  money: PosReportsPanelProps['money']
  number: PosReportsPanelProps['number']
}) {
  return (
    <Box sx={{ ...panelSx, overflow: 'hidden' }}>
      <SectionHeader icon={<Inventory2Rounded fontSize="small" />} title="Product performance" detail="Stable Toast item identity with category context" />
      <TableContainer sx={{ display: { xs: 'none', md: 'block' } }}>
        <Table size="small" aria-label="POS product performance">
          <TableHead>
            <TableRow>
              {['Product', 'Category', 'Quantity', 'Checks', 'Net sales', 'Sales share'].map((label, index) => (
                <TableCell key={label} align={index > 1 ? 'right' : 'left'} sx={{ bgcolor: '#171821', color: 'text.secondary', fontWeight: 700, whiteSpace: 'nowrap' }}>{label}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((item, index) => (
              <TableRow key={`${text(item.productId || item.name)}-${index}`} sx={{ '& td': { borderColor: 'rgba(255,255,255,0.065)' } }}>
                <TableCell><Typography variant="body2" fontWeight={650}>{text(item.name, 'Unnamed item')}</Typography><Typography variant="caption" color="text.disabled">{text(item.plu, 'No PLU')}</Typography></TableCell>
                <TableCell>{text(item.categoryName, 'Uncategorized')}</TableCell>
                <TableCell align="right">{number(amount(item.quantity), 2)}</TableCell>
                <TableCell align="right">{number(amount(item.checkCount))}</TableCell>
                <TableCell align="right"><Typography variant="body2" fontWeight={700}>{money(amount(item.netSales))}</Typography></TableCell>
                <TableCell align="right">{number(totalNetSales ? (amount(item.netSales) / totalNetSales) * 100 : 0, 1)}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ display: { xs: 'block', md: 'none' } }}>
        <RankedRows items={items} money={money} number={number} />
      </Box>
      {!items.length ? <Typography variant="body2" color="text.secondary" px={2} pb={2}>No product detail is available.</Typography> : null}
    </Box>
  )
}

function ComparisonCard({ label, comparison, money, number, dateLabel }: {
  label: string
  comparison: DataRecord
  money: PosReportsPanelProps['money']
  number: PosReportsPanelProps['number']
  dateLabel: PosReportsPanelProps['dateLabel']
}) {
  const range = record(comparison.range)
  const totals = record(comparison.totals)
  const changes = record(comparison.change)
  const netSalesChange = record(changes.netSales)
  const percent = netSalesChange.percent === null || netSalesChange.percent === undefined ? null : amount(netSalesChange.percent)
  return (
    <Box sx={{ ...panelSx, p: 1.5, minWidth: 0 }}>
      <Box display="flex" justifyContent="space-between" alignItems="flex-start" gap={1.5}>
        <Box minWidth={0}>
          <Typography variant="body2" fontWeight={700}>{label}</Typography>
          <Typography variant="caption" color="text.secondary" display="block" noWrap>
            {dateLabel(range.from, true)} - {dateLabel(range.to, true)}
          </Typography>
        </Box>
        {comparison.available === true && percent !== null ? (
          <Chip
            size="small"
            variant="outlined"
            color={percent >= 0 ? 'success' : 'error'}
            label={`${percent >= 0 ? '+' : ''}${number(percent, 1)}%`}
          />
        ) : <Chip size="small" variant="outlined" label="No baseline" />}
      </Box>
      {comparison.available === true ? (
        <Box display="grid" gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap={1.25} mt={1.5}>
          <Box><Typography variant="caption" color="text.disabled">Net sales</Typography><Typography fontWeight={700}>{money(amount(totals.netSales))}</Typography></Box>
          <Box><Typography variant="caption" color="text.disabled">Orders</Typography><Typography fontWeight={700}>{number(amount(totals.orderCount))}</Typography></Box>
        </Box>
      ) : <Typography variant="body2" color="text.secondary" mt={1.5}>No comparable orders were found.</Typography>}
    </Box>
  )
}

export default function PosReportsPanel({ from, to, location, revision, money, number, dateLabel }: PosReportsPanelProps) {
  const [view, setView] = useState<ReportView>('sales')
  const [report, setReport] = useState<DataRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ from, to })
    if (location) params.set('location', location)
    setLoading(true)
    setError(null)

    async function load() {
      try {
        const response = await fetch(`/api/pos/reports?${params}`, { cache: 'no-store', signal: controller.signal })
        const payload = await response.json().catch(() => ({})) as DataRecord
        if (!response.ok || payload.ok !== true || !payload.report) {
          throw new Error(text(payload.error, 'POS reports are unavailable'))
        }
        setReport(record(payload.report))
      } catch (loadError) {
        if ((loadError as Error).name !== 'AbortError') setError((loadError as Error).message)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    void load()
    return () => controller.abort()
  }, [from, location, revision, to])

  const receiptTotals = record(report?.receiptTotals)
  const categories = useMemo(() => rows(report?.categoryTotals), [report])
  const products = useMemo(() => rows(report?.productPerformance), [report])
  const tenders = record(report?.tenderTotals)
  const tenderTypes = rows(tenders.byType)
  const cardTypes = rows(tenders.byCardType)
  const settlement = availableMetric(tenders.calculatedCardSettlement)
  const processingFees = availableMetric(tenders.processingFees)
  const payout = availableMetric(tenders.actualPayout)
  const cash = record(report?.cashOperations)
  const comparisons = record(report?.comparisons)
  const coverage = record(report?.coverage)
  const dailySummaries = rows(report?.dailySummaries)
  const checkSummaries = record(report?.checkSummaries)
  const checkStatuses = rows(checkSummaries.byPaymentStatus)
  const businessDays = Math.max(0, amount(receiptTotals.businessDays))
  const dailyRunRate = businessDays ? amount(receiptTotals.netSales) / businessDays : 0
  const projectedSevenDays = dailyRunRate * 7

  if (loading && !report) {
    return <Box minHeight={240} display="grid" sx={{ placeItems: 'center' }}><CircularProgress size={28} /></Box>
  }

  return (
    <Stack spacing={2}>
      {loading ? <LinearProgress sx={{ height: 2 }} /> : null}
      {error ? <Alert severity="error" sx={{ borderRadius: '8px' }}>{error}</Alert> : null}
      {report ? (
        <>
          <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', xl: 'repeat(6, minmax(0, 1fr))' }} gap={1.25}>
            <MetricCard label="Net sales" value={money(amount(receiptTotals.netSales), true)} detail={`Gross ${money(amount(receiptTotals.grossSales), true)}`} color="#70D6A7" />
            <MetricCard label="Checks" value={number(amount(receiptTotals.checkCount))} detail={`${number(amount(receiptTotals.orderCount))} orders`} color="#A8C7FA" />
            <MetricCard label="Average check" value={money(amount(receiptTotals.averageCheckNetSales))} detail="Net sales per check" />
            <MetricCard label="Tips" value={money(amount(receiptTotals.tips), true)} detail="Recorded service tips" color="#CFC6EA" />
            <MetricCard label="Tax" value={money(amount(receiptTotals.tax), true)} detail="Recorded sales tax" />
            <MetricCard label="Discounts" value={money(amount(receiptTotals.discounts), true)} detail="Applied discounts" color="#F2B76D" />
          </Box>

          <Tabs
            value={view}
            onChange={(_, next: ReportView) => setView(next)}
            variant="scrollable"
            scrollButtons={false}
            aria-label="POS report views"
            sx={{
              minHeight: 42,
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              '& .MuiTab-root': { minHeight: 42, minWidth: 96, textTransform: 'none', letterSpacing: 0 },
            }}
          >
            <Tab value="sales" label="Daily sales" />
            <Tab value="products" label="Products" />
            <Tab value="payments" label="Payments" />
            <Tab value="trends" label="Trends" />
          </Tabs>

          {view === 'sales' ? (
            <Stack spacing={2}>
              <DailySalesRows items={dailySummaries} money={money} number={number} dateLabel={dateLabel} />
              <Box display="grid" gridTemplateColumns={{ xs: '1fr', md: 'minmax(0, 1fr) minmax(240px, 0.38fr)' }} gap={2}>
                <Box sx={{ ...panelSx, overflow: 'hidden' }}>
                  <SectionHeader icon={<ReceiptLongRounded fontSize="small" />} title="Check status" detail={`${number(amount(checkSummaries.totals && record(checkSummaries.totals).checkCount))} checks with detail`} />
                  {checkStatuses.map((item, index) => (
                    <Box key={`${text(item.paymentStatus)}-${index}`} display="grid" gridTemplateColumns="minmax(0, 1fr) auto auto" gap={1.5} px={{ xs: 1.5, sm: 2 }} py={1.1} borderTop="1px solid rgba(255,255,255,0.065)" alignItems="center">
                      <Typography variant="body2" fontWeight={650}>{text(item.paymentStatus, 'Unknown')}</Typography>
                      <Typography variant="caption" color="text.secondary">{number(amount(item.checkCount))} checks</Typography>
                      <Typography variant="body2" fontWeight={700}>{money(amount(item.total))}</Typography>
                    </Box>
                  ))}
                  {!checkStatuses.length ? <Typography variant="body2" color="text.secondary" px={2} pb={2}>No check status detail is available.</Typography> : null}
                </Box>
                <Box sx={{ ...panelSx, p: 1.5 }}>
                  <Typography fontWeight={700}>Sales receipt</Typography>
                  <Typography variant="caption" color="text.secondary">Range totals</Typography>
                  <Divider sx={{ my: 1.25 }} />
                  {[
                    ['Gross sales', receiptTotals.grossSales],
                    ['Discounts', -amount(receiptTotals.discounts)],
                    ['Net sales', receiptTotals.netSales],
                    ['Service charges', receiptTotals.serviceCharges],
                    ['Tax', receiptTotals.tax],
                    ['Tips', receiptTotals.tips],
                    ['Grand total', receiptTotals.total],
                  ].map(([label, value], index) => (
                    <Box key={String(label)} display="flex" justifyContent="space-between" gap={1.5} py={0.6} borderTop={index === 6 ? '1px solid rgba(255,255,255,0.08)' : 0} mt={index === 6 ? 0.5 : 0}>
                      <Typography variant="body2" color={index === 6 ? 'text.primary' : 'text.secondary'} fontWeight={index === 6 ? 700 : 400}>{String(label)}</Typography>
                      <Typography variant="body2" fontWeight={index === 6 ? 750 : 650}>{money(amount(value))}</Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Stack>
          ) : null}

          {view === 'products' ? (
            <Stack spacing={2}>
              <ProductTable items={products} totalNetSales={amount(receiptTotals.netSales)} money={money} number={number} />
            <Box sx={{ ...panelSx, overflow: 'hidden' }}>
              <SectionHeader icon={<BarChartRounded fontSize="small" />} title="Sales categories" detail="Grouped using stable Toast catalog identifiers" />
              <RankedRows items={categories} money={money} number={number} />
              {!categories.length ? <Typography variant="body2" color="text.secondary" px={2} pb={2}>No category detail is available.</Typography> : null}
            </Box>
            </Stack>
          ) : null}

          {view === 'payments' ? <Stack spacing={2}><Box display="grid" gridTemplateColumns={{ xs: '1fr', lg: 'minmax(0, 1.15fr) minmax(280px, 0.85fr)' }} gap={2}>
            <Box sx={{ ...panelSx, overflow: 'hidden' }}>
              <SectionHeader icon={<CreditCardRounded fontSize="small" />} title="Payments" detail="Tender and card summaries without card identifiers" />
              <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }}>
                <Box px={{ xs: 1.5, sm: 2 }} pb={1.5}>
                  <Typography variant="caption" color="text.disabled" fontWeight={700}>TENDER</Typography>
                  {tenderTypes.map((item, index) => (
                    <Box key={`${text(item.type)}-${index}`} display="flex" justifyContent="space-between" gap={1.5} py={0.65}>
                      <Typography variant="body2">{text(item.type, 'Other')}</Typography>
                      <Typography variant="body2" fontWeight={650}>{money(amount(item.amount))}</Typography>
                    </Box>
                  ))}
                </Box>
                <Box px={{ xs: 1.5, sm: 2 }} pb={1.5} borderLeft={{ sm: '1px solid rgba(255,255,255,0.065)' }}>
                  <Typography variant="caption" color="text.disabled" fontWeight={700}>CARD TYPE</Typography>
                  {cardTypes.map((item, index) => (
                    <Box key={`${text(item.cardType)}-${index}`} display="flex" justifyContent="space-between" gap={1.5} py={0.65}>
                      <Typography variant="body2">{text(item.cardType, 'Card')}</Typography>
                      <Typography variant="body2" fontWeight={650}>{money(amount(item.amount))}</Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Box>

            <Box sx={{ ...panelSx, overflow: 'hidden' }}>
              <SectionHeader icon={<AccountBalanceRounded fontSize="small" />} title="Settlement evidence" detail="Calculated and verified values remain distinct" />
              <Box px={{ xs: 1.5, sm: 2 }} pb={2}>
                <Box display="flex" justifyContent="space-between" gap={1.5} py={0.75}>
                  <Typography variant="body2">Processing fees</Typography>
                  <Typography variant="body2" fontWeight={650}>{processingFees.available ? money(processingFees.value) : 'Unavailable'}</Typography>
                </Box>
                <Box display="flex" justifyContent="space-between" gap={1.5} py={0.75}>
                  <Typography variant="body2">Calculated card settlement</Typography>
                  <Typography variant="body2" fontWeight={700} color={settlement.available ? '#70D6A7' : 'text.secondary'}>{settlement.available ? money(settlement.value) : 'Unavailable'}</Typography>
                </Box>
                <Typography variant="caption" color="text.secondary" display="block">
                  {settlement.available ? 'Card payments + tips - processing fees. This is not a verified bank deposit.' : settlement.reason}
                </Typography>
                <Divider sx={{ my: 1.25 }} />
                <Box display="flex" justifyContent="space-between" gap={1.5} py={0.75}>
                  <Typography variant="body2">Actual payout</Typography>
                  <Chip size="small" variant="outlined" color={payout.available ? 'success' : 'default'} label={payout.available ? money(payout.value) : 'Not verified'} />
                </Box>
              </Box>
            </Box>
          </Box>

          <Box display="grid" gridTemplateColumns={{ xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }} gap={2}>
            <Box sx={{ ...panelSx, p: 1.5 }}>
              <Box display="flex" alignItems="center" gap={0.75} mb={1}><PaymentsRounded fontSize="small" sx={{ color: '#A8C7FA' }} /><Typography fontWeight={700}>Cash operations</Typography></Box>
              <Box display="flex" justifyContent="space-between" gap={1.5}><Typography variant="body2" color="text.secondary">Cash tender</Typography><Typography variant="body2" fontWeight={700}>{money(amount(cash.tendered))}</Typography></Box>
              <Typography variant="caption" color="text.disabled" display="block" mt={0.75}>Deposits and cash over/short require accounting evidence.</Typography>
            </Box>
            <Box sx={{ ...panelSx, p: 1.5 }}>
              <Typography fontWeight={700}>Payment coverage</Typography>
              <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                {number(amount(coverage.detailedPayments))} detailed payments across {number(amount(coverage.detailedChecks))} checks.
              </Typography>
              <Typography variant="caption" color="text.disabled" display="block" mt={0.75}>
                {number(amount(coverage.paymentsWithProcessingFee))} payments include processing-fee evidence.
              </Typography>
            </Box>
          </Box>
          </Stack> : null}

          {view === 'trends' ? <Stack spacing={2}>
          <Box display="grid" gridTemplateColumns={{ xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }} gap={2}>
            <ComparisonCard label="Prior period" comparison={record(comparisons.priorPeriod)} money={money} number={number} dateLabel={dateLabel} />
            <ComparisonCard label="Prior year" comparison={record(comparisons.priorYear)} money={money} number={number} dateLabel={dateLabel} />
          </Box>
          <Box sx={{ ...panelSx, overflow: 'hidden' }}>
            <SectionHeader icon={<TrendingUpRounded fontSize="small" />} title="Sales run rate" detail="Transparent baseline forecast; no weather or event assumptions" />
            <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' }} gap={1.25} px={{ xs: 1.5, sm: 2 }} pb={1.5}>
              <Box minWidth={0}><Typography variant="caption" color="text.disabled">Observed days</Typography><Typography fontWeight={700}>{number(businessDays)}</Typography></Box>
              <Box minWidth={0}><Typography variant="caption" color="text.disabled">Daily run rate</Typography><Typography fontWeight={700}>{money(dailyRunRate)}</Typography></Box>
              <Box minWidth={0} gridColumn={{ xs: '1 / -1', sm: 'auto' }}><Typography variant="caption" color="text.disabled">Next 7 days</Typography><Typography fontWeight={700} color="#A8C7FA">{money(projectedSevenDays)}</Typography></Box>
            </Box>
            <Divider />
            <Typography variant="caption" color="text.secondary" display="block" px={{ xs: 1.5, sm: 2 }} py={1.25}>
              Net sales divided by {number(businessDays)} observed business days, then multiplied by 7. {number(dailySummaries.length)} daily summaries support this range.
            </Typography>
          </Box>

          <Alert severity="info" variant="outlined" sx={{ borderRadius: '8px' }}>
            Weather and event adjustments are not included until a verified external data source is connected. Forecasts shown here use observed POS sales only.
          </Alert>
          </Stack> : null}

          <Box sx={{ ...panelSx, p: 1.5, display: 'flex', alignItems: 'flex-start', gap: 1 }}>
            <ReceiptLongRounded fontSize="small" sx={{ color: '#A8C7FA', mt: 0.15 }} />
            <Box>
              <Typography variant="body2" fontWeight={700}>Evidence coverage</Typography>
              <Typography variant="caption" color="text.secondary">
                {number(amount(coverage.ordersWithCheckDetails))} of {number(amount(coverage.orders))} orders include check detail; {number(amount(coverage.detailedPayments))} payments were summarized.
              </Typography>
            </Box>
          </Box>
        </>
      ) : null}
    </Stack>
  )
}
