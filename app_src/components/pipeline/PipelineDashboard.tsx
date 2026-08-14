'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { CrmInteraction, CrmSummary } from '@/lib/crm/types'
import { isActivePipelineStatus, isWonPipelineStatus, summarizePipeline } from '@/lib/pipeline/analytics.mjs'

type DashboardDeal = {
  id: string
  stage: string
  status: string
  value: number
  probability: number
  closeDate: string
}

type Props = {
  deals: DashboardDeal[]
  stages: string[]
  lastSyncedLabel: string
  syncState: 'unknown' | 'syncing' | 'ok' | 'error'
}

type PipelineDashboardSummary = ReturnType<typeof summarizePipeline> & {
  totalCount: number
  wonCount: number
  winRate: number
  activeValue: number
}

type CrmDashboardPayload = {
  summary: Pick<CrmSummary, 'contacts' | 'interactions'>
  interactions: Pick<CrmInteraction, 'id' | 'interactionType' | 'occurredAt'>[]
}

const DASHBOARD_FONT = 'Roboto, Arial, sans-serif'
const NUMBER_FONT = '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
const MATERIAL = {
  primary: '#8AB4F8',
  primaryStrong: '#4E79A7',
  secondary: '#66CDBD',
  potential: '#FF8A65',
  probable: '#4DB6AC',
  success: '#66BB6A',
  warning: '#F4BE62',
  summary: '#C7D2FE',
  summarySurface: 'rgba(199, 210, 254, 0.06)',
  surface: '#181A22',
  surfaceHigh: '#20232D',
  outline: '#353A48',
  ink: '#E9ECF4',
  muted: '#AEB6C7',
  grid: '#343947',
} as const

const STAGE_COLORS: Record<string, string> = {
  'identified lead': '#4E79A7',
  'qualified lead': '#59A14F',
  'needs analysis': '#A45A9C',
  demo: '#1597C1',
  proposal: '#D66D24',
  negotiation: '#C29415',
  'closed delayed': '#C29415',
  closed: '#2E7D32',
  won: '#2E7D32',
  loss: '#C64545',
}

const INTERACTION_TYPES = [
  { key: 'direct mail', label: 'Direct Mail', color: '#5C6BC0' },
  { key: 'linkedin', label: 'LinkedIn', color: '#356BB3' },
  { key: 'email', label: 'Email', color: '#7CB342' },
  { key: 'call', label: 'Call', color: '#008C95' },
  { key: 'meeting', label: 'In Person', color: '#8E55A6' },
] as const

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function monthStart(offset: number) {
  const date = new Date()
  return new Date(date.getFullYear(), date.getMonth() + offset, 1)
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(date: Date) {
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

function money(value: number) {
  if (!value) return '$0'
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function shortMoney(value: number) {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (absolute >= 1_000) return `$${Math.round(value / 1_000)}K`
  return money(value)
}

function numeric(value: number) {
  return Math.round(Number(value || 0)).toLocaleString('en-US')
}

function stageColor(stage: string) {
  return STAGE_COLORS[normalized(stage)] || MATERIAL.primaryStrong
}

function interactionType(value: string) {
  const key = normalized(value)
  if (key === 'in person') return 'meeting'
  return key
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <Box
      component="section"
      sx={{
        minWidth: 0,
        p: { xs: 2, md: 2.5 },
        borderRadius: '12px',
        border: `1px solid ${MATERIAL.outline}`,
        backgroundColor: MATERIAL.surface,
      }}
    >
      <Typography component="h3" sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.ink, fontSize: 15, fontWeight: 500 }}>
        {title}
      </Typography>
      <Typography sx={{ mt: 0.25, mb: 2, fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 12 }}>
        {subtitle}
      </Typography>
      {children}
    </Box>
  )
}

function MetricCard({ label, value, primary = false }: { label: string; value: string; primary?: boolean }) {
  return (
    <Box
      sx={{
        minWidth: 0,
        p: primary ? { xs: 2, md: 2.5 } : { xs: 1.5, md: 1.75 },
        borderRadius: '12px',
        border: `1px solid ${MATERIAL.outline}`,
        borderTop: `3px solid ${MATERIAL.summary}`,
        backgroundColor: MATERIAL.surface,
      }}
    >
      <Typography sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </Typography>
      <Typography
        sx={{
          mt: primary ? 1 : 0.75,
          color: MATERIAL.summary,
          fontFamily: NUMBER_FONT,
          fontSize: primary ? { xs: 25, md: 30 } : { xs: 18, md: 21 },
          fontWeight: 500,
          lineHeight: 1.15,
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </Typography>
    </Box>
  )
}

function StageDistribution({ deals, stages }: { deals: DashboardDeal[]; stages: string[] }) {
  const rows = stages.map((stage) => ({ stage, count: deals.filter((deal) => normalized(deal.stage) === normalized(stage)).length }))
  const max = Math.max(1, ...rows.map((row) => row.count))
  return (
    <Stack spacing={1.05} role="img" aria-label="Horizontal bar chart of opportunities by pipeline stage">
      {rows.map((row) => (
        <Box key={row.stage} sx={{ display: 'grid', gridTemplateColumns: { xs: '104px minmax(80px, 1fr) 28px', sm: '132px minmax(100px, 1fr) 32px' }, alignItems: 'center', gap: 1 }}>
          <Typography noWrap title={row.stage} sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 11.5 }}>{row.stage}</Typography>
          <Box sx={{ height: 17, borderRadius: '4px', backgroundColor: MATERIAL.surfaceHigh, overflow: 'hidden' }}>
            <Box sx={{ width: `${Math.max(row.count ? 6 : 0, (row.count / max) * 100)}%`, height: '100%', borderRadius: '4px', backgroundColor: stageColor(row.stage) }} />
          </Box>
          <Typography sx={{ fontFamily: NUMBER_FONT, color: MATERIAL.ink, fontSize: 11.5, textAlign: 'right' }}>{row.count}</Typography>
        </Box>
      ))}
    </Stack>
  )
}

function ChartLegend({ items }: { items: readonly { label: string; color: string }[] }) {
  return (
    <Stack direction="row" useFlexGap flexWrap="wrap" gap={1.25} sx={{ mb: 1.5 }}>
      {items.map((item) => (
        <Stack key={item.label} direction="row" spacing={0.6} alignItems="center">
          <Box sx={{ width: 9, height: 9, borderRadius: '2px', backgroundColor: item.color }} />
          <Typography sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 10.5 }}>{item.label}</Typography>
        </Stack>
      ))}
    </Stack>
  )
}

function GroupedInteractions({ interactions }: { interactions: CrmDashboardPayload['interactions'] }) {
  const months = [-2, -1, 0].map(monthStart)
  const counts = months.map((month) => INTERACTION_TYPES.map((type) => interactions.filter((interaction) => {
    if (!interaction.occurredAt || interactionType(interaction.interactionType) !== type.key) return false
    const occurred = new Date(interaction.occurredAt)
    return Number.isFinite(occurred.getTime()) && monthKey(occurred) === monthKey(month)
  }).length))
  const max = Math.max(1, ...counts.flat())
  const chartHeight = 150
  const baseY = 172
  const groupWidth = 150
  const barWidth = 18
  const barGap = 4

  return (
    <>
      <ChartLegend items={INTERACTION_TYPES} />
      <Box component="svg" viewBox="0 0 520 205" role="img" aria-label="Grouped column chart of interactions by type for the last three months" sx={{ width: '100%', height: 'auto', display: 'block' }}>
        <title>Interactions by type, last three months</title>
        {[0, 0.5, 1].map((fraction) => {
          const y = baseY - chartHeight * fraction
          return <line key={fraction} x1="42" y1={y} x2="505" y2={y} stroke={MATERIAL.grid} strokeWidth="1" />
        })}
        {months.map((month, monthIndex) => {
          const startX = 65 + monthIndex * groupWidth
          return (
            <g key={monthKey(month)}>
              {counts[monthIndex].map((count, typeIndex) => {
                const height = (count / max) * chartHeight
                return <rect key={INTERACTION_TYPES[typeIndex].key} x={startX + typeIndex * (barWidth + barGap)} y={baseY - height} width={barWidth} height={height} rx="2" fill={INTERACTION_TYPES[typeIndex].color} />
              })}
              <text x={startX + 54} y="193" textAnchor="middle" fill={MATERIAL.muted} fontFamily={DASHBOARD_FONT} fontSize="11">{monthLabel(month)}</text>
            </g>
          )
        })}
      </Box>
    </>
  )
}

function RevenueByStage({ deals }: { deals: DashboardDeal[] }) {
  const months = Array.from({ length: 6 }, (_, index) => monthStart(index))
  const stages = ['Closed', 'Closed Delayed', 'Proposal', 'Demo', 'Needs Analysis', 'Qualified Lead', 'Identified Lead']
  const values = months.map((month) => stages.map((stage) => deals.filter((deal) => {
    const closeDate = new Date(deal.closeDate)
    return Number.isFinite(closeDate.getTime()) && monthKey(closeDate) === monthKey(month) && normalized(deal.stage) === normalized(stage)
  }).reduce((total, deal) => total + Number(deal.value || 0), 0)))
  const totals = values.map((monthValues) => monthValues.reduce((sum, value) => sum + value, 0))
  const max = Math.max(1, ...totals)
  const legend = stages.map((stage) => ({ label: stage, color: stageColor(stage) }))
  const chartHeight = 142
  const baseY = 166

  return (
    <>
      <ChartLegend items={legend} />
      <Box component="svg" viewBox="0 0 560 205" role="img" aria-label="Stacked column chart of potential revenue by stage for the next two quarters" sx={{ width: '100%', height: 'auto', display: 'block' }}>
        <title>Potential revenue by stage, next two quarters</title>
        {[0, 0.5, 1].map((fraction) => {
          const y = baseY - chartHeight * fraction
          return (
            <g key={fraction}>
              <line x1="54" y1={y} x2="548" y2={y} stroke={MATERIAL.grid} strokeWidth="1" />
              <text x="48" y={y + 4} textAnchor="end" fill={MATERIAL.muted} fontFamily={DASHBOARD_FONT} fontSize="9">{shortMoney(max * fraction)}</text>
            </g>
          )
        })}
        {months.map((month, monthIndex) => {
          const x = 76 + monthIndex * 79
          let stackedHeight = 0
          return (
            <g key={monthKey(month)}>
              {values[monthIndex].map((value, stageIndex) => {
                const height = (value / max) * chartHeight
                const y = baseY - stackedHeight - height
                stackedHeight += height
                return <rect key={stages[stageIndex]} x={x} y={y} width="34" height={height} rx="1" fill={stageColor(stages[stageIndex])} />
              })}
              <text x={x + 17} y="189" textAnchor="middle" fill={MATERIAL.muted} fontFamily={DASHBOARD_FONT} fontSize="9.5">{monthLabel(month)}</text>
            </g>
          )
        })}
      </Box>
    </>
  )
}

function PotentialVsProbable({ deals }: { deals: DashboardDeal[] }) {
  const months = Array.from({ length: 6 }, (_, index) => monthStart(index))
  const values = months.map((month) => {
    const matching = deals.filter((deal) => {
      if (!isActivePipelineStatus(deal.status)) return false
      const closeDate = new Date(deal.closeDate)
      return Number.isFinite(closeDate.getTime()) && monthKey(closeDate) === monthKey(month)
    })
    return {
      potential: matching.reduce((total, deal) => total + Number(deal.value || 0), 0),
      probable: matching.reduce((total, deal) => total + Number(deal.value || 0) * (Number(deal.probability || 0) / 100), 0),
    }
  })
  const max = Math.max(1, ...values.flatMap((value) => [value.potential, value.probable]))
  const chartHeight = 142
  const baseY = 166

  return (
    <>
      <ChartLegend items={[{ label: 'Potential', color: MATERIAL.potential }, { label: 'Probable', color: MATERIAL.probable }]} />
      <Box component="svg" viewBox="0 0 560 205" role="img" aria-label="Grouped column chart comparing potential and probable value for the next two quarters" sx={{ width: '100%', height: 'auto', display: 'block' }}>
        <title>Potential versus probable value, next two quarters</title>
        {[0, 0.5, 1].map((fraction) => {
          const y = baseY - chartHeight * fraction
          return (
            <g key={fraction}>
              <line x1="54" y1={y} x2="548" y2={y} stroke={MATERIAL.grid} strokeWidth="1" />
              <text x="48" y={y + 4} textAnchor="end" fill={MATERIAL.muted} fontFamily={DASHBOARD_FONT} fontSize="9">{shortMoney(max * fraction)}</text>
            </g>
          )
        })}
        {months.map((month, index) => {
          const x = 70 + index * 79
          const potentialHeight = values[index].potential / max * chartHeight
          const probableHeight = values[index].probable / max * chartHeight
          return (
            <g key={monthKey(month)}>
              <rect x={x} y={baseY - potentialHeight} width="25" height={potentialHeight} rx="2" fill={MATERIAL.potential} />
              <rect x={x + 28} y={baseY - probableHeight} width="25" height={probableHeight} rx="2" fill={MATERIAL.probable} />
              <text x={x + 26} y="189" textAnchor="middle" fill={MATERIAL.muted} fontFamily={DASHBOARD_FONT} fontSize="9.5">{monthLabel(month)}</text>
            </g>
          )
        })}
      </Box>
    </>
  )
}

export default function PipelineDashboard({ deals, stages, lastSyncedLabel, syncState }: Props) {
  const [crm, setCrm] = useState<CrmDashboardPayload>({ summary: { contacts: 0, interactions: 0 }, interactions: [] })
  const [crmLoading, setCrmLoading] = useState(true)
  const [crmError, setCrmError] = useState('')
  const summary = useMemo(() => summarizePipeline(deals) as PipelineDashboardSummary, [deals])
  const openValue = useMemo(() => deals.filter((deal) => normalized(deal.status) === 'open').reduce((total, deal) => total + Number(deal.value || 0), 0), [deals])
  const wonCount = useMemo(() => deals.filter((deal) => isWonPipelineStatus(deal.status)).length, [deals])

  useEffect(() => {
    let active = true
    fetch('/api/crm?entity=interactions&limit=500', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload?.ok === false) throw new Error(payload?.error || 'Unable to load CRM activity')
        if (!active) return
        setCrm({
          summary: {
            contacts: Number(payload?.summary?.contacts || 0),
            interactions: Number(payload?.summary?.interactions || 0),
          },
          interactions: Array.isArray(payload?.records) ? payload.records : [],
        })
        setCrmError('')
      })
      .catch((error: unknown) => {
        if (active) setCrmError(error instanceof Error ? error.message : 'Unable to load CRM activity')
      })
      .finally(() => { if (active) setCrmLoading(false) })
    return () => { active = false }
  }, [])

  return (
    <Box data-testid="pipeline-dashboard" sx={{ maxWidth: 1440, mx: 'auto', fontFamily: DASHBOARD_FONT }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5} sx={{ mb: 2 }}>
        <Box>
          <Typography component="h2" sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.ink, fontSize: { xs: 21, md: 24 }, fontWeight: 500 }}>
            Pipeline dashboard
          </Typography>
          <Typography sx={{ mt: 0.25, fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 12 }}>
            Sales health, customer activity, and the next two quarters in one view.
          </Typography>
        </Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          {crmLoading ? <CircularProgress size={14} /> : null}
          <Chip
            size="small"
            label={syncState === 'error' || crmError ? 'Data needs attention' : syncState === 'syncing' ? 'Refreshing data' : 'Current data'}
            sx={{
              height: 26,
              fontFamily: DASHBOARD_FONT,
              fontSize: 11,
              color: syncState === 'error' || crmError ? '#FFB4AB' : syncState === 'syncing' ? MATERIAL.primary : MATERIAL.success,
              backgroundColor: syncState === 'error' || crmError ? 'rgba(255,180,171,0.12)' : syncState === 'syncing' ? 'rgba(138,180,248,0.12)' : 'rgba(102,187,106,0.12)',
            }}
          />
          <Typography sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 11 }}>Updated {lastSyncedLabel}</Typography>
        </Stack>
      </Stack>

      <Box
        component="section"
        aria-label="Pipeline summary"
        sx={{
          p: 1.5,
          borderRadius: '14px',
          border: `1px solid rgba(199, 210, 254, 0.18)`,
          backgroundColor: MATERIAL.summarySurface,
        }}
      >
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
          <MetricCard primary label="Open opportunities value" value={money(openValue)} />
          <MetricCard primary label="Potential value" value={money(summary.activeValue)} />
        </Box>

        <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(5, minmax(0, 1fr))' }, gap: 1.5 }}>
          <MetricCard label="Contacts" value={numeric(crm.summary.contacts)} />
          <MetricCard label="Interactions" value={numeric(crm.summary.interactions)} />
          <MetricCard label="Opps pursued" value={numeric(summary.totalCount)} />
          <MetricCard label="Opps closed" value={numeric(wonCount)} />
          <MetricCard label="Win rate" value={`${summary.winRate.toFixed(1)}%`} />
        </Box>
      </Box>

      {crmError ? (
        <Typography sx={{ mt: 1.5, fontFamily: DASHBOARD_FONT, color: '#FFB4AB', fontSize: 12 }}>
          Interaction detail is temporarily unavailable. Pipeline values remain visible.
        </Typography>
      ) : null}

      <Box sx={{ mt: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
        <Panel title="Opportunities by stage" subtitle="Stage on the y-axis · current opportunity count">
          <StageDistribution deals={deals} stages={stages} />
        </Panel>
        <Panel title="Interactions, last quarter" subtitle="Grouped by CRM interaction type">
          <GroupedInteractions interactions={crm.interactions} />
        </Panel>
        <Panel title="Potential revenue by stage" subtitle="Next two quarters · expected close month">
          <RevenueByStage deals={deals} />
        </Panel>
        <Panel title="Potential vs probable value" subtitle="Next two quarters · probability-weighted comparison">
          <PotentialVsProbable deals={deals} />
        </Panel>
      </Box>
    </Box>
  )
}
