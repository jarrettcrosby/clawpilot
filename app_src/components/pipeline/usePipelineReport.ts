'use client'

import { useEffect, useRef, useState } from 'react'

export type ReportPreset = 'last_30_days' | 'last_3_calendar_months' | 'year_to_date' | 'custom'

export type InteractionTypeCounts = {
  directMail: number
  linkedIn: number
  email: number
  call: number
  inPerson: number
  note: number
  campaign: number
  other: number
}

export type InteractionMonth = {
  month: string
  label: string
  total: number
  types: InteractionTypeCounts
}

export type PipelineSnapshotValueGroup = {
  label: string
  count: number
  value: number
  weighted: number
}

export type PipelineSnapshot = {
  totalContacts: number
  totalOpportunities: number
  activeOpportunities: number
  openOpportunities: number
  onHoldOpportunities: number
  highPriorityActiveOpportunities: number
  wonOpportunities: number
  lostOpportunities: number
  activePipelineValue: number
  weightedPipelineValue: number
  lifetimeWinRate: number
  opportunitiesByStage: Array<{ stage: string; count: number }>
  activeByStage: PipelineSnapshotValueGroup[]
  activeByCloseQuarter: PipelineSnapshotValueGroup[]
  attention: {
    total: number
    lifecycleConflicts: number
    overdue: number
    missingCloseDate: number
    invalidProbability: number
  }
  forecast: {
    months: Array<{
      month: string
      potential: number
      weighted: number
      stages: Array<{ stage: string; value: number }>
    }>
    outsideOrUnscheduledPotential: number
    outsideOrUnscheduledWeighted: number
  }
}

export type PipelineReportPayload = {
  ok: boolean
  period: {
    preset: ReportPreset
    label: string
    startDate: string
    endDate: string
    snapshotDate: string
    timeZone: string
  }
  snapshot: PipelineSnapshot
  activity: {
    contactsAdded: number
    interactions: number
    opportunitiesCreated: number
    interactionsByMonth: InteractionMonth[]
  }
}

type Input = {
  enabled: boolean
  reportRevision: string
  syncRevision: string
  syncState: 'unknown' | 'syncing' | 'ok' | 'error'
}

const PRESET_LABELS: Record<Exclude<ReportPreset, 'custom'>, string> = {
  last_30_days: 'Last 30 days',
  last_3_calendar_months: 'Last 3 calendar months',
  year_to_date: 'Year to date',
}

function validDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function currentDayKey(timeZone: string) {
  const parts = new Map(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]))
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`
}

export function usePipelineReport({ enabled, reportRevision, syncRevision, syncState }: Input) {
  const [preset, setPreset] = useState<ReportPreset>('last_3_calendar_months')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [report, setReport] = useState<PipelineReportPayload | null>(null)
  const [loadedReportRevision, setLoadedReportRevision] = useState('')
  const [loadedRequestKey, setLoadedRequestKey] = useState('')
  const [loadingRequestKey, setLoadingRequestKey] = useState('')
  const [requestError, setRequestError] = useState<{ key: string; message: string } | null>(null)
  const [retryRevision, setRetryRevision] = useState(0)
  const [dayRefreshRevision, setDayRefreshRevision] = useState('')
  const observedDayRef = useRef('')

  const customPeriodIncomplete = preset === 'custom' && (!validDateOnly(customStart) || !validDateOnly(customEnd))
  const requestKey = `${reportRevision}:${preset}:${preset === 'custom' ? `${customStart}:${customEnd}` : ''}`
  const reportError = requestError?.key === requestKey ? requestError.message : ''
  const reportMatchesSelection = Boolean(report && loadedRequestKey === requestKey)
  const snapshot = loadedReportRevision === reportRevision ? report?.snapshot || null : null
  const activity = reportMatchesSelection ? report?.activity || null : null
  const selectedLabel = preset === 'custom'
    ? customStart && customEnd ? `${customStart} – ${customEnd}` : 'Custom range'
    : PRESET_LABELS[preset]
  const periodLabel = reportMatchesSelection ? report?.period.label || selectedLabel : selectedLabel
  const isReportPending = enabled && (
    syncState === 'syncing'
    || loadingRequestKey === requestKey
    || (!reportMatchesSelection && !customPeriodIncomplete && !reportError)
  )
  const retryReport = () => {
    setRequestError((current) => current?.key === requestKey ? null : current)
    setRetryRevision((current) => current + 1)
  }

  useEffect(() => {
    const timeZone = report?.period.timeZone
    if (!timeZone) return
    observedDayRef.current = currentDayKey(timeZone)
    const interval = window.setInterval(() => {
      const nextDay = currentDayKey(timeZone)
      if (nextDay === observedDayRef.current) return
      observedDayRef.current = nextDay
      setDayRefreshRevision(nextDay)
    }, 60_000)
    return () => window.clearInterval(interval)
  }, [report?.period.timeZone])

  useEffect(() => {
    if (!enabled || customPeriodIncomplete || syncState === 'syncing') return

    const controller = new AbortController()
    const loadingTimer = window.setTimeout(() => {
      if (!controller.signal.aborted) setLoadingRequestKey(requestKey)
    }, 0)
    const params = new URLSearchParams({ preset })
    if (preset === 'custom') {
      params.set('startDate', customStart)
      params.set('endDate', customEnd)
    }

    fetch(`/api/pipeline/report?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || 'Unable to load pipeline reporting')
        setReport(payload as PipelineReportPayload)
        setLoadedReportRevision(reportRevision)
        setLoadedRequestKey(requestKey)
        setRequestError(null)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setRequestError({
          key: requestKey,
          message: error instanceof Error ? error.message : 'Unable to load pipeline reporting',
        })
      })
      .finally(() => {
        if (controller.signal.aborted) return
        window.clearTimeout(loadingTimer)
        setLoadingRequestKey((current) => current === requestKey ? '' : current)
      })

    return () => {
      window.clearTimeout(loadingTimer)
      controller.abort()
    }
  }, [customEnd, customPeriodIncomplete, customStart, dayRefreshRevision, enabled, preset, reportRevision, requestKey, retryRevision, syncRevision, syncState])

  return {
    preset,
    setPreset,
    customStart,
    setCustomStart,
    customEnd,
    setCustomEnd,
    report,
    snapshot,
    activity,
    periodLabel,
    customPeriodIncomplete,
    customPeriodGuidance: customPeriodIncomplete ? 'Choose both dates to apply the custom reporting period.' : '',
    reportError,
    isReportPending,
    retryReport,
  }
}

export type PipelineReportingState = ReturnType<typeof usePipelineReport>
