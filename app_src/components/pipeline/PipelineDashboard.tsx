'use client'

import { type ReactElement, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import type {
  InteractionMonth,
  InteractionTypeCounts,
  PipelineReportingState,
  PipelineSnapshot,
  ReportPreset,
} from '@/components/pipeline/usePipelineReport'
import { formatPipelineCurrency } from '@/lib/crm/pipelineCurrency'

type Props = {
  stages: string[]
  totalContacts: number | null
  lastSyncedLabel: string
  reporting: PipelineReportingState
  syncState: 'unknown' | 'syncing' | 'ok' | 'error'
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

const INTERACTION_TYPES: readonly { key: keyof InteractionTypeCounts; label: string; color: string }[] = [
  { key: 'directMail', label: 'Direct Mail', color: '#5C6BC0' },
  { key: 'linkedIn', label: 'LinkedIn', color: '#356BB3' },
  { key: 'email', label: 'Email', color: '#7CB342' },
  { key: 'call', label: 'Call', color: '#008C95' },
  { key: 'inPerson', label: 'In Person', color: '#8E55A6' },
  { key: 'note', label: 'Note', color: '#C29415' },
  { key: 'campaign', label: 'Campaign', color: '#D66D24' },
  { key: 'other', label: 'Other', color: '#78909C' },
] as const

const REPORT_PRESETS: readonly { value: ReportPreset; label: string }[] = [
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_3_calendar_months', label: 'Last 3 calendar months' },
  { value: 'year_to_date', label: 'Year to date' },
  { value: 'custom', label: 'Custom range' },
]

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function forecastMonthLabel(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (!match) return value
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1, 12)).toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  })
}

function money(value: number) {
  return formatPipelineCurrency(Number(value || 0))
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

function ChartMarkTooltip({ title, children }: { title: string; children: ReactElement }) {
  return (
    <Tooltip title={title} arrow describeChild enterTouchDelay={0} leaveTouchDelay={3500}>
      {children}
    </Tooltip>
  )
}

const chartMarkFocus = {
  outline: `2px solid ${MATERIAL.ink}`,
  outlineOffset: '2px',
  filter: 'brightness(1.18)',
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

function StageDistribution({ stageCounts, stages }: { stageCounts: PipelineSnapshot['opportunitiesByStage'] | null; stages: string[] }) {
  if (!stageCounts) {
    return <Typography sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 12 }}>Current stage counts are unavailable.</Typography>
  }

  const configuredStages = new Map(stages.map((stage) => [normalized(stage), stage]))
  const counts = new Map<string, number>()
  stageCounts.forEach((row) => {
    const key = normalized(row.stage)
    counts.set(key, (counts.get(key) || 0) + Number(row.count || 0))
  })
  const rows = [
    ...stages.map((stage) => ({ stage, count: counts.get(normalized(stage)) || 0 })),
    ...stageCounts
      .filter((row) => !configuredStages.has(normalized(row.stage)))
      .map((row) => ({ stage: row.stage, count: Number(row.count || 0) })),
  ]
  const max = Math.max(1, ...rows.map((row) => row.count))
  return (
    <Stack spacing={1.05} role="img" aria-label="Horizontal bar chart of opportunities by pipeline stage">
      {rows.map((row) => (
        <Box key={row.stage} sx={{ display: 'grid', gridTemplateColumns: { xs: '104px minmax(80px, 1fr) 28px', sm: '132px minmax(100px, 1fr) 32px' }, alignItems: 'center', gap: 1 }}>
          <Typography noWrap title={row.stage} sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 11.5 }}>{row.stage}</Typography>
          <Box sx={{ height: 17, borderRadius: '4px', backgroundColor: MATERIAL.surfaceHigh, overflow: 'visible' }}>
            <ChartMarkTooltip title={`${row.stage} · ${row.count.toLocaleString('en-US')} opportunities`}>
              <Box
                data-chart-mark
                tabIndex={0}
                role="img"
                aria-label={`${row.stage}: ${row.count.toLocaleString('en-US')} opportunities`}
                sx={{
                  width: row.count ? `${Math.max(6, (row.count / max) * 100)}%` : '2px',
                  height: '100%',
                  borderRadius: '4px',
                  backgroundColor: stageColor(row.stage),
                  opacity: row.count ? 1 : 0.45,
                  '&:focus-visible': chartMarkFocus,
                }}
              />
            </ChartMarkTooltip>
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

function GroupedInteractions({ months, periodLabel }: { months: InteractionMonth[]; periodLabel: string }) {
  const counts = months.map((month) => INTERACTION_TYPES.map((type) => Number(month.types?.[type.key] || 0)))
  const max = Math.max(1, ...counts.flat())
  const chartHeight = 150
  const baseY = 172
  const groupWidth = 116
  const barWidth = 9
  const barGap = 2
  const chartWidth = Math.max(560, 64 + months.length * groupWidth)

  return (
    <>
      <ChartLegend items={INTERACTION_TYPES} />
      <Box sx={{ overflowX: 'auto', pb: 0.5 }}>
        <Box
          component="svg"
          viewBox={`0 0 ${chartWidth} 205`}
          role="img"
          aria-label={`Grouped column chart of interactions by type for ${periodLabel}`}
          sx={{
            width: months.length > 4 ? chartWidth : '100%',
            minWidth: '100%',
            height: 'auto',
            display: 'block',
            '& [data-chart-mark]:focus-visible': chartMarkFocus,
          }}
        >
          <title>{`Interactions by type · ${periodLabel}`}</title>
          {[0, 0.5, 1].map((fraction) => {
            const y = baseY - chartHeight * fraction
            return <line key={fraction} x1="42" y1={y} x2={chartWidth - 12} y2={y} stroke={MATERIAL.grid} strokeWidth="1" />
          })}
          {months.map((month, monthIndex) => {
            const startX = 58 + monthIndex * groupWidth
            return (
              <g key={month.month}>
                {counts[monthIndex].map((count, typeIndex) => {
                  const type = INTERACTION_TYPES[typeIndex]
                  if (!count) return null
                  const height = Math.max(2, (count / max) * chartHeight)
                  const tooltip = `${month.label} · ${type.label}: ${count.toLocaleString('en-US')} interactions`
                  return (
                    <ChartMarkTooltip key={type.key} title={tooltip}>
                      <rect
                        data-chart-mark
                        tabIndex={0}
                        role="img"
                        aria-label={tooltip}
                        x={startX + typeIndex * (barWidth + barGap)}
                        y={baseY - height}
                        width={barWidth}
                        height={height}
                        rx="2"
                        fill={type.color}
                      />
                    </ChartMarkTooltip>
                  )
                })}
                <text x={startX + 43} y="193" textAnchor="middle" fill={MATERIAL.muted} fontFamily={DASHBOARD_FONT} fontSize="10.5">{month.label}</text>
              </g>
            )
          })}
        </Box>
      </Box>
      <Box component="details" sx={{ mt: 1, color: MATERIAL.muted, fontFamily: DASHBOARD_FONT }}>
        <Typography
          component="summary"
          sx={{ cursor: 'pointer', color: MATERIAL.primary, fontFamily: DASHBOARD_FONT, fontSize: 11.5 }}
        >
          View interaction data table
        </Typography>
        <Box sx={{ mt: 1, overflowX: 'auto' }}>
          <Box
            component="table"
            aria-label={`Interaction counts for ${periodLabel}`}
            sx={{
              width: '100%',
              minWidth: 720,
              borderCollapse: 'collapse',
              '& th, & td': {
                px: 1,
                py: 0.75,
                borderBottom: `1px solid ${MATERIAL.grid}`,
                color: MATERIAL.muted,
                fontFamily: DASHBOARD_FONT,
                fontSize: 10.5,
                textAlign: 'right',
              },
              '& th:first-of-type, & td:first-of-type': { textAlign: 'left' },
              '& th': { color: MATERIAL.ink, fontWeight: 600 },
            }}
          >
            <caption style={{ textAlign: 'left', padding: '0 0 8px', color: MATERIAL.muted }}>
              Exact interaction totals by month and type for {periodLabel}
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                {INTERACTION_TYPES.map((type) => <th key={type.key} scope="col">{type.label}</th>)}
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {months.map((month) => (
                <tr key={month.month}>
                  <th scope="row">{month.label}</th>
                  {INTERACTION_TYPES.map((type) => (
                    <td key={type.key}>{Number(month.types?.[type.key] || 0).toLocaleString('en-US')}</td>
                  ))}
                  <td>{Number(month.total || 0).toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </Box>
        </Box>
      </Box>
    </>
  )
}

function RevenueByStage({ forecast }: { forecast: PipelineSnapshot['forecast'] | null }) {
  if (!forecast) {
    return <Typography sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 12 }}>Current forecast is unavailable.</Typography>
  }

  const months = forecast.months
  const stageLabels = new Map<string, string>()
  months.flatMap((month) => month.stages).forEach((stage) => {
    const key = normalized(stage.stage)
    if (!stageLabels.has(key)) stageLabels.set(key, stage.stage)
  })
  const stages = [...stageLabels.values()]
  const values = months.map((month) => stages.map((stage) => (
    month.stages
      .filter((candidate) => normalized(candidate.stage) === normalized(stage))
      .reduce((total, candidate) => total + Number(candidate.value || 0), 0)
  )))
  const totals = values.map((monthValues) => monthValues.reduce((sum, value) => sum + value, 0))
  const max = Math.max(1, ...totals)
  const legend = stages.map((stage) => ({ label: stage, color: stageColor(stage) }))
  const chartHeight = 142
  const baseY = 166

  return (
    <>
      <ChartLegend items={legend} />
      <Box
        component="svg"
        viewBox="0 0 560 205"
        role="img"
        aria-label="Stacked column chart of potential revenue by stage for the next two quarters"
        sx={{ width: '100%', height: 'auto', display: 'block', '& [data-chart-mark]:focus-visible': chartMarkFocus }}
      >
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
            <g key={month.month}>
              {values[monthIndex].map((value, stageIndex) => {
                if (!value) return null
                const height = (value / max) * chartHeight
                const y = baseY - stackedHeight - height
                stackedHeight += height
                const stage = stages[stageIndex]
                const tooltip = `${forecastMonthLabel(month.month)} · ${stage}: ${money(value)}`
                return (
                  <ChartMarkTooltip key={stage} title={tooltip}>
                    <rect
                      data-chart-mark
                      tabIndex={0}
                      role="img"
                      aria-label={tooltip}
                      x={x}
                      y={y}
                      width="34"
                      height={Math.max(1, height)}
                      rx="1"
                      fill={stageColor(stage)}
                    />
                  </ChartMarkTooltip>
                )
              })}
              <text x={x + 17} y="189" textAnchor="middle" fill={MATERIAL.muted} fontFamily={DASHBOARD_FONT} fontSize="9.5">{forecastMonthLabel(month.month)}</text>
            </g>
          )
        })}
      </Box>
    </>
  )
}

function PotentialVsProbable({ snapshot }: { snapshot: PipelineSnapshot | null }) {
  if (!snapshot) {
    return <Typography sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 12 }}>Current forecast is unavailable.</Typography>
  }

  const months = snapshot.forecast.months
  const values = months.map((month) => ({ potential: month.potential, probable: month.weighted }))
  const horizonPotential = values.reduce((total, value) => total + value.potential, 0)
  const horizonWeighted = values.reduce((total, value) => total + value.probable, 0)
  const activePotential = snapshot.activePipelineValue
  const activeWeighted = snapshot.weightedPipelineValue
  const outsidePotential = snapshot.forecast.outsideOrUnscheduledPotential
  const outsideWeighted = snapshot.forecast.outsideOrUnscheduledWeighted
  const max = Math.max(1, ...values.flatMap((value) => [value.potential, value.probable]))
  const chartHeight = 142
  const baseY = 166

  return (
    <>
      <ChartLegend items={[{ label: 'Potential', color: MATERIAL.potential }, { label: 'Probable', color: MATERIAL.probable }]} />
      <Box
        component="svg"
        viewBox="0 0 560 205"
        role="img"
        aria-label="Grouped column chart comparing potential and probable value for the next two quarters"
        sx={{ width: '100%', height: 'auto', display: 'block', '& [data-chart-mark]:focus-visible': chartMarkFocus }}
      >
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
          const potentialTooltip = `${forecastMonthLabel(month.month)} · Potential: ${money(values[index].potential)}`
          const probableTooltip = `${forecastMonthLabel(month.month)} · Probable: ${money(values[index].probable)}`
          return (
            <g key={month.month}>
              {values[index].potential ? (
                <ChartMarkTooltip title={potentialTooltip}>
                  <rect
                    data-chart-mark
                    tabIndex={0}
                    role="img"
                    aria-label={potentialTooltip}
                    x={x}
                    y={baseY - Math.max(1, potentialHeight)}
                    width="25"
                    height={Math.max(1, potentialHeight)}
                    rx="2"
                    fill={MATERIAL.potential}
                  />
                </ChartMarkTooltip>
              ) : null}
              {values[index].probable ? (
                <ChartMarkTooltip title={probableTooltip}>
                  <rect
                    data-chart-mark
                    tabIndex={0}
                    role="img"
                    aria-label={probableTooltip}
                    x={x + 28}
                    y={baseY - Math.max(1, probableHeight)}
                    width="25"
                    height={Math.max(1, probableHeight)}
                    rx="2"
                    fill={MATERIAL.probable}
                  />
                </ChartMarkTooltip>
              ) : null}
              <text x={x + 26} y="189" textAnchor="middle" fill={MATERIAL.muted} fontFamily={DASHBOARD_FONT} fontSize="9.5">{forecastMonthLabel(month.month)}</text>
            </g>
          )
        })}
      </Box>
      <Typography sx={{ mt: 1, fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 11, lineHeight: 1.5 }}>
        Six-month horizon: {money(horizonPotential)} potential / {money(horizonWeighted)} weighted.
        {' '}Outside or unscheduled: {money(outsidePotential)} potential / {money(outsideWeighted)} weighted.
        {' '}Current active totals: {money(activePotential)} / {money(activeWeighted)} weighted.
      </Typography>
    </>
  )
}

export default function PipelineDashboard({ stages, totalContacts, lastSyncedLabel, reporting, syncState }: Props) {
  const {
    preset,
    setPreset,
    customStart,
    setCustomStart,
    customEnd,
    setCustomEnd,
    snapshot,
    activity,
    periodLabel,
    customPeriodIncomplete,
    customPeriodGuidance,
    reportError,
    isReportPending,
    retryReport,
  } = reporting
  const currentContacts = snapshot?.totalContacts ?? totalContacts

  const dataNeedsAttention = syncState === 'error' || Boolean(reportError)

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
        <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ xs: 'stretch', md: 'center' }} spacing={1}>
          <TextField
            select
            size="small"
            label="Reporting period"
            value={preset}
            onChange={(event) => setPreset(event.target.value as ReportPreset)}
            sx={{ minWidth: 205 }}
          >
            {REPORT_PRESETS.map((option) => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
          </TextField>
          {preset === 'custom' ? (
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ width: { xs: '100%', sm: 'auto' }, minWidth: 0 }}
            >
              <TextField
                size="small"
                label="Start"
                type="date"
                value={customStart}
                onChange={(event) => setCustomStart(event.target.value)}
                sx={{ width: { xs: '100%', sm: 165 }, minWidth: 0 }}
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: customEnd || undefined } }}
              />
              <TextField
                size="small"
                label="End"
                type="date"
                value={customEnd}
                onChange={(event) => setCustomEnd(event.target.value)}
                sx={{ width: { xs: '100%', sm: 165 }, minWidth: 0 }}
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: customStart || undefined } }}
              />
            </Stack>
          ) : null}
          {isReportPending ? <CircularProgress size={14} /> : null}
          <Chip
            size="small"
            label={customPeriodIncomplete ? 'Choose dates' : dataNeedsAttention ? 'Data needs attention' : syncState === 'syncing' || isReportPending ? 'Refreshing data' : 'Current data'}
            sx={{
              height: 26,
              fontFamily: DASHBOARD_FONT,
              fontSize: 11,
              color: customPeriodIncomplete ? MATERIAL.muted : dataNeedsAttention ? '#FFB4AB' : syncState === 'syncing' || isReportPending ? MATERIAL.primary : MATERIAL.success,
              backgroundColor: customPeriodIncomplete ? MATERIAL.surfaceHigh : dataNeedsAttention ? 'rgba(255,180,171,0.12)' : syncState === 'syncing' || isReportPending ? 'rgba(138,180,248,0.12)' : 'rgba(102,187,106,0.12)',
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
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={0.5} sx={{ mb: 1.25 }}>
          <Typography sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.ink, fontSize: 12, fontWeight: 600 }}>
            Current pipeline snapshot
          </Typography>
          <Typography sx={{ fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 11 }}>
            Activity period: {periodLabel}
          </Typography>
        </Stack>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
          <MetricCard primary label="Active pipeline value · current snapshot" value={snapshot ? money(snapshot.activePipelineValue) : '—'} />
          <MetricCard primary label="Weighted pipeline value · current snapshot" value={snapshot ? money(snapshot.weightedPipelineValue) : '—'} />
        </Box>

        <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', lg: 'repeat(6, minmax(0, 1fr))' }, gap: 1.5 }}>
          <MetricCard label="Active opportunities · current" value={snapshot ? numeric(snapshot.activeOpportunities) : '—'} />
          <MetricCard label="Total contacts · current" value={currentContacts === null ? '—' : numeric(currentContacts)} />
          <MetricCard label="Contacts added · selected period" value={activity ? numeric(activity.contactsAdded) : '—'} />
          <MetricCard label="Interactions · selected period" value={activity ? numeric(activity.interactions) : '—'} />
          <MetricCard label="Opportunities created · selected period" value={activity ? numeric(activity.opportunitiesCreated) : '—'} />
          <MetricCard label="Lifetime win rate" value={snapshot ? `${snapshot.lifetimeWinRate.toFixed(1)}%` : '—'} />
        </Box>
      </Box>

      {customPeriodGuidance ? (
        <Typography sx={{ mt: 1.5, fontFamily: DASHBOARD_FONT, color: MATERIAL.muted, fontSize: 12 }}>
          {customPeriodGuidance}
        </Typography>
      ) : null}

      {reportError ? (
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1} sx={{ mt: 1.5 }}>
          <Typography sx={{ fontFamily: DASHBOARD_FONT, color: '#FFB4AB', fontSize: 12 }}>
            {reportError}
          </Typography>
          <Button size="small" variant="outlined" onClick={retryReport}>Retry</Button>
        </Stack>
      ) : null}

      <Box sx={{ mt: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
        <Panel title="Opportunities by stage" subtitle="Current snapshot · stage on the y-axis">
          <StageDistribution stageCounts={snapshot?.opportunitiesByStage || null} stages={stages} />
        </Panel>
        <Panel title={`Interactions · ${periodLabel}`} subtitle="Selected period · grouped by CRM interaction type">
          <GroupedInteractions months={activity?.interactionsByMonth || []} periodLabel={periodLabel} />
        </Panel>
        <Panel title="Potential revenue by stage" subtitle="Current snapshot · next two quarters by expected close month">
          <RevenueByStage forecast={snapshot?.forecast || null} />
        </Panel>
        <Panel title="Potential vs probable value" subtitle="Current snapshot · next two quarters probability-weighted">
          <PotentialVsProbable snapshot={snapshot} />
        </Panel>
      </Box>
    </Box>
  )
}
