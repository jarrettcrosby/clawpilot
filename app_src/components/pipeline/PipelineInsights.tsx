'use client'

import { useMemo } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import type { PipelineSnapshot } from '@/components/pipeline/usePipelineReport'
import { formatPipelineCurrency } from '@/lib/crm/pipelineCurrency'
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
  snapshot: PipelineSnapshot | null
  stages: string[]
  onOpenDeal: (deal: PipelineInsightDeal) => void
}

type PipelineInsightSummary = {
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

const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
})

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
                  {group.count} · {formatPipelineCurrency(value)}
                </Typography>
              </Stack>
              <Box sx={{ mt: 0.65, height: 6, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 1 }}>
                <Tooltip
                  title={`${group.label} · ${weighted ? 'Weighted value' : 'Active value'}: ${formatPipelineCurrency(value)} across ${group.count.toLocaleString('en-US')} opportunities`}
                  arrow
                  describeChild
                  enterTouchDelay={0}
                  leaveTouchDelay={3500}
                >
                  <Box
                    data-chart-mark
                    tabIndex={0}
                    role="img"
                    aria-label={`${group.label}: ${formatPipelineCurrency(value)} across ${group.count.toLocaleString('en-US')} opportunities`}
                    sx={{
                      height: '100%',
                      width: `${Math.max(2, (value / max) * 100)}%`,
                      backgroundColor: weighted ? '#A8C7FA' : '#66BB6A',
                      borderRadius: 1,
                      '&:focus-visible': {
                        outline: '2px solid #E9ECF4',
                        outlineOffset: '2px',
                        filter: 'brightness(1.18)',
                      },
                    }}
                  />
                </Tooltip>
              </Box>
            </Box>
          )
        })}
      </Stack>
    </Box>
  )
}

export default function PipelineInsights({ deals, snapshot, stages, onOpenDeal }: Props) {
  const detailSummary = useMemo(() => summarizePipeline(deals) as unknown as PipelineInsightSummary, [deals])
  const stageRank = useMemo(() => new Map(stages.map((stage, index) => [stage.trim().toLowerCase(), index])), [stages])
  const stageGroups = useMemo(() => [...(snapshot?.activeByStage || [])]
    .sort((left, right) => (stageRank.get(left.label.trim().toLowerCase()) ?? 999) - (stageRank.get(right.label.trim().toLowerCase()) ?? 999)), [snapshot?.activeByStage, stageRank])
  const forecastGroups = snapshot?.activeByCloseQuarter || []
  const topDeals = useMemo(() => [...detailSummary.active]
    .sort((left, right) => Number(right.value || 0) - Number(left.value || 0))
    .slice(0, 5), [detailSummary.active])
  const attentionDeals = useMemo(() => {
    const byId = new Map<string, PipelineInsightDeal>()
    ;[...detailSummary.lifecycleConflicts, ...detailSummary.overdue, ...detailSummary.missingCloseDate, ...detailSummary.invalidProbability]
      .forEach((deal) => byId.set(deal.id, deal))
    return [...byId.values()].slice(0, 8)
  }, [detailSummary])
  const conflictIds = useMemo(() => new Set(detailSummary.lifecycleConflicts.map((deal) => deal.id)), [detailSummary.lifecycleConflicts])
  const overdueIds = useMemo(() => new Set(detailSummary.overdue.map((deal) => deal.id)), [detailSummary.overdue])
  const missingDateIds = useMemo(() => new Set(detailSummary.missingCloseDate.map((deal) => deal.id)), [detailSummary.missingCloseDate])

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
        <Metric label="Active pipeline · current snapshot" value={snapshot ? formatPipelineCurrency(snapshot.activePipelineValue) : '—'} tone="positive" />
        <Metric label="Weighted pipeline · current snapshot" value={snapshot ? formatPipelineCurrency(snapshot.weightedPipelineValue) : '—'} />
        <Metric label="Active · current snapshot" value={snapshot?.activeOpportunities ?? '—'} />
        <Metric label="On hold · current snapshot" value={snapshot?.onHoldOpportunities ?? '—'} tone={snapshot && snapshot.onHoldOpportunities > 0 ? 'warning' : 'default'} />
        <Metric label="Lifetime won" value={snapshot?.wonOpportunities ?? '—'} tone="positive" />
        <Metric label="Lifetime win rate" value={snapshot ? percent.format(snapshot.lifetimeWinRate / 100) : '—'} />
      </Box>

      {snapshot && snapshot.attention.total > 0 ? (
        <Alert
          severity="warning"
          icon={<WarningAmberRounded />}
          sx={{ mb: 3, borderRadius: 1, alignItems: 'flex-start' }}
        >
          <Typography variant="subtitle2" fontWeight={700}>{snapshot.attention.total} opportunities need attention</Typography>
          <Typography variant="caption" color="text.secondary">
            {snapshot.attention.lifecycleConflicts} status/stage conflicts · {snapshot.attention.overdue} past expected close · {snapshot.attention.missingCloseDate} missing expected close · {snapshot.attention.invalidProbability} invalid probability
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            Counts cover the full pipeline. Detail links below come from up to 1,000 recently updated opportunity rows.
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
          <Typography variant="subtitle2" fontWeight={700}>Largest among loaded opportunity details</Typography>
          <Chip size="small" label={`${topDeals.length} shown · ${deals.length} loaded`} sx={{ borderRadius: 1 }} />
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
              <Typography variant="body2" fontWeight={700} color="#66BB6A">{formatPipelineCurrency(Number(deal.value || 0))}</Typography>
              <Typography variant="caption" color="text.secondary">{Number(deal.probability || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}%</Typography>
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
