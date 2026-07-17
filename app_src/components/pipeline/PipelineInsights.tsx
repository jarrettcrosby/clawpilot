'use client'

import { useMemo } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import { summarizePipeline } from '@/lib/pipeline/analytics.mjs'

export type PipelineInsightDeal = {
  id: string
  name: string
  org: string
  status: string
  stage: string
  source: string
  priority: string
  value: number
  probability: number
  closeDate: string
}

type Props = {
  deals: PipelineInsightDeal[]
  stages: string[]
  onOpenDeal: (deal: PipelineInsightDeal) => void
}

type PipelineInsightSummary = {
  activeValue: number
  weightedActiveValue: number
  activeCount: number
  onHoldCount: number
  wonCount: number
  winRate: number
  needsAttentionCount: number
  active: PipelineInsightDeal[]
  lifecycleConflicts: PipelineInsightDeal[]
  overdue: PipelineInsightDeal[]
  missingCloseDate: PipelineInsightDeal[]
  invalidProbability: PipelineInsightDeal[]
}

type ValueGroup = {
  label: string
  count: number
  value: number
  weighted: number
}

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
})

function valueGroups(deals: PipelineInsightDeal[], keyFor: (deal: PipelineInsightDeal) => string) {
  const groups = new Map<string, ValueGroup>()
  deals.forEach((deal) => {
    const label = keyFor(deal) || 'Unspecified'
    const group = groups.get(label) || { label, count: 0, value: 0, weighted: 0 }
    group.count += 1
    group.value += Number(deal.value || 0)
    group.weighted += Number(deal.value || 0) * (Number(deal.probability || 0) / 100)
    groups.set(label, group)
  })
  return [...groups.values()]
}

function quarterLabel(value: string) {
  const date = new Date(value)
  if (!value || !Number.isFinite(date.getTime())) return 'No close date'
  const quarter = Math.floor(date.getMonth() / 3) + 1
  return `Q${quarter} ${date.getFullYear()}`
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'positive' | 'warning' }) {
  return (
    <Box sx={{ minWidth: 0, py: 1.25, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography
        variant="h6"
        fontWeight={700}
        sx={{
          mt: 0.25,
          color: tone === 'positive' ? '#66BB6A' : tone === 'warning' ? '#FFA726' : 'text.primary',
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </Typography>
    </Box>
  )
}

function Distribution({ title, groups, weighted = false }: { title: string; groups: ValueGroup[]; weighted?: boolean }) {
  const max = Math.max(1, ...groups.map((group) => weighted ? group.weighted : group.value))
  return (
    <Box component="section" sx={{ minWidth: 0 }}>
      <Typography variant="subtitle2" fontWeight={700} mb={1.25}>{title}</Typography>
      <Stack spacing={1.25}>
        {groups.length === 0 ? (
          <Typography variant="body2" color="text.disabled">No active opportunities.</Typography>
        ) : groups.map((group) => {
          const value = weighted ? group.weighted : group.value
          return (
            <Box key={group.label}>
              <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={1}>
                <Typography variant="body2" fontWeight={600} noWrap>{group.label}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                  {group.count} · {currency.format(value)}
                </Typography>
              </Stack>
              <Box sx={{ mt: 0.65, height: 6, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 1, overflow: 'hidden' }}>
                <Box sx={{ height: '100%', width: `${Math.max(2, (value / max) * 100)}%`, backgroundColor: weighted ? '#A8C7FA' : '#66BB6A', borderRadius: 1 }} />
              </Box>
            </Box>
          )
        })}
      </Stack>
    </Box>
  )
}

export default function PipelineInsights({ deals, stages, onOpenDeal }: Props) {
  const summary = useMemo(() => summarizePipeline(deals) as unknown as PipelineInsightSummary, [deals])
  const stageRank = useMemo(() => new Map(stages.map((stage, index) => [stage, index])), [stages])
  const stageGroups = useMemo(() => valueGroups(summary.active, (deal) => deal.stage)
    .sort((left, right) => (stageRank.get(left.label) ?? 999) - (stageRank.get(right.label) ?? 999)), [stageRank, summary.active])
  const forecastGroups = useMemo(() => valueGroups(summary.active, (deal) => quarterLabel(deal.closeDate))
    .sort((left, right) => {
      if (left.label === 'No close date') return 1
      if (right.label === 'No close date') return -1
      const [, leftQuarter, leftYear] = /Q(\d) (\d{4})/.exec(left.label) || []
      const [, rightQuarter, rightYear] = /Q(\d) (\d{4})/.exec(right.label) || []
      return (Number(leftYear) * 4 + Number(leftQuarter)) - (Number(rightYear) * 4 + Number(rightQuarter))
    }), [summary.active])
  const topDeals = useMemo(() => [...summary.active]
    .sort((left, right) => Number(right.value || 0) - Number(left.value || 0))
    .slice(0, 5), [summary.active])
  const attentionDeals = useMemo(() => {
    const byId = new Map<string, PipelineInsightDeal>()
    ;[...summary.lifecycleConflicts, ...summary.overdue, ...summary.missingCloseDate, ...summary.invalidProbability]
      .forEach((deal) => byId.set(deal.id, deal))
    return [...byId.values()].slice(0, 8)
  }, [summary])
  const conflictIds = useMemo(() => new Set(summary.lifecycleConflicts.map((deal) => deal.id)), [summary.lifecycleConflicts])
  const overdueIds = useMemo(() => new Set(summary.overdue.map((deal) => deal.id)), [summary.overdue])
  const missingDateIds = useMemo(() => new Set(summary.missingCloseDate.map((deal) => deal.id)), [summary.missingCloseDate])

  return (
    <Box sx={{ width: '100%', maxWidth: 1400, mx: 'auto' }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', lg: 'repeat(6, minmax(0, 1fr))' },
          columnGap: { xs: 2, md: 3 },
          borderTop: '1px solid rgba(255,255,255,0.06)',
          mb: 3,
        }}
      >
        <Metric label="Active pipeline" value={currency.format(summary.activeValue)} tone="positive" />
        <Metric label="Weighted pipeline" value={currency.format(summary.weightedActiveValue)} />
        <Metric label="Active" value={summary.activeCount} />
        <Metric label="On hold" value={summary.onHoldCount} tone={summary.onHoldCount > 0 ? 'warning' : 'default'} />
        <Metric label="Won" value={summary.wonCount} tone="positive" />
        <Metric label="Win rate" value={percent.format(summary.winRate / 100)} />
      </Box>

      {summary.needsAttentionCount > 0 ? (
        <Alert
          severity="warning"
          icon={<WarningAmberRounded />}
          sx={{ mb: 3, borderRadius: 1, alignItems: 'flex-start' }}
        >
          <Typography variant="subtitle2" fontWeight={700}>{summary.needsAttentionCount} opportunities need attention</Typography>
          <Typography variant="caption" color="text.secondary">
            {summary.lifecycleConflicts.length} status/stage conflicts · {summary.overdue.length} past expected close · {summary.missingCloseDate.length} missing expected close
          </Typography>
          <Box sx={{ mt: 1.25, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            {attentionDeals.map((deal) => {
              const reasons = [
                conflictIds.has(deal.id) ? `${deal.status || 'Unspecified'} status conflicts with ${deal.stage || 'unspecified'} stage` : '',
                overdueIds.has(deal.id) ? 'Expected close is past due' : '',
                missingDateIds.has(deal.id) ? 'Expected close is missing' : '',
              ].filter(Boolean)
              return (
                <ButtonBase
                  key={deal.id}
                  onClick={() => onOpenDeal(deal)}
                  sx={{ width: '100%', minHeight: 48, py: 1, textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.06)', justifyContent: 'flex-start' }}
                >
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" fontWeight={600} noWrap>{deal.org || 'Unknown organization'}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{reasons.join(' · ')}</Typography>
                  </Box>
                </ButtonBase>
              )
            })}
          </Box>
        </Alert>
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }, gap: { xs: 3, lg: 5 } }}>
        <Distribution title="Active value by stage" groups={stageGroups} />
        <Distribution title="Weighted forecast by close quarter" groups={forecastGroups} weighted />
      </Box>

      <Box component="section" sx={{ mt: 4, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 1.5 }}>
          <Typography variant="subtitle2" fontWeight={700}>Largest active opportunities</Typography>
          <Chip size="small" label={`${topDeals.length} shown`} sx={{ borderRadius: 1 }} />
        </Stack>
        {topDeals.map((deal) => (
          <ButtonBase
            key={deal.id}
            onClick={() => onOpenDeal(deal)}
            sx={{ width: '100%', minHeight: 56, py: 1, borderTop: '1px solid rgba(255,255,255,0.06)', textAlign: 'left', justifyContent: 'flex-start' }}
          >
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" fontWeight={600} noWrap>{deal.org || 'Unknown organization'}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{deal.name || 'Unspecified product'} · {deal.stage || 'Unspecified stage'}</Typography>
            </Box>
            <Box sx={{ textAlign: 'right', flexShrink: 0, pl: 2 }}>
              <Typography variant="body2" fontWeight={700} color="#66BB6A">{currency.format(Number(deal.value || 0))}</Typography>
              <Typography variant="caption" color="text.secondary">{Number(deal.probability || 0).toFixed(0)}%</Typography>
            </Box>
          </ButtonBase>
        ))}
        {topDeals.length === 0 ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2, color: 'text.disabled' }}>
            <EventBusyRounded fontSize="small" />
            <Typography variant="body2">No active opportunities.</Typography>
          </Stack>
        ) : null}
      </Box>
    </Box>
  )
}
