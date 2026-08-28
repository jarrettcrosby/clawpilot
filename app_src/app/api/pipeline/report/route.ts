import { NextRequest, NextResponse } from 'next/server'
import {
  normalizePipelineReportingPeriod,
  PipelineReportingPeriodError,
} from '@/lib/pipeline/reportingPeriod.mjs'
import { readCrmPipelineActivityReportFromPostgres } from '@/lib/persistence/crm'
import { isPostgresPipelineStoreEnabled } from '@/lib/persistence/pipeline'
import { requireRequestUser } from '@/lib/requestUser'
import { PIPELINE_SELECTION_COOKIE, resolvePipelineSpaceAccess } from '@/lib/tenancy'

function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof PipelineReportingPeriodError) {
    return NextResponse.json(
      { ok: false, error: message, code: error.code },
      { status: error.status },
    )
  }
  if (message === 'Unauthorized') {
    return NextResponse.json({ ok: false, error: message }, { status: 401 })
  }
  if (/access denied|view-only/i.test(message)) {
    return NextResponse.json({ ok: false, error: message }, { status: 403 })
  }
  if (/not found|No pipeline is available/i.test(message)) {
    return NextResponse.json({ ok: false, error: message }, { status: 404 })
  }
  console.error('[pipeline-report] unexpected reporting failure', error)
  return NextResponse.json({
    ok: false,
    error: 'Unable to load pipeline reporting',
    code: 'PIPELINE_REPORTING_FAILED',
  }, { status: 500 })
}

export async function GET(req: NextRequest) {
  try {
    if (!isPostgresPipelineStoreEnabled()) {
      return NextResponse.json(
        { ok: false, error: 'Pipeline reporting requires Postgres storage' },
        { status: 503 },
      )
    }

    const actor = await requireRequestUser(req)
    const selectedPipelineId = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
    let pipeline
    try {
      pipeline = await resolvePipelineSpaceAccess({
        actorEmail: actor,
        pipelineId: selectedPipelineId,
      })
    } catch (error: unknown) {
      const staleSelection = selectedPipelineId
        && error instanceof Error
        && error.message === 'Pipeline access denied'
      if (!staleSelection) throw error
      pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor })
    }
    if (!pipeline.workspaceOrganizationId) {
      return NextResponse.json(
        { ok: false, error: 'Pipeline workspace organization is not configured' },
        { status: 409 },
      )
    }

    const period = normalizePipelineReportingPeriod({
      preset: req.nextUrl.searchParams.get('preset'),
      startDate: req.nextUrl.searchParams.get('startDate'),
      endDate: req.nextUrl.searchParams.get('endDate'),
      timeZone: actor.timezone,
    })
    const report = await readCrmPipelineActivityReportFromPostgres({
      pipelineId: pipeline.id,
      organizationId: pipeline.workspaceOrganizationId,
      startAt: period.startAt,
      endAtExclusive: period.endAtExclusive,
      timeZone: period.timeZone,
      snapshotDate: period.snapshotDate,
    })
    const { snapshot, ...activity } = report

    return NextResponse.json({
      ok: true,
      period: {
        preset: period.preset,
        label: period.label,
        startDate: period.startDate,
        endDate: period.endDate,
        snapshotDate: period.snapshotDate,
        timeZone: period.timeZone,
      },
      snapshot,
      activity,
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (error: unknown) {
    return reportError(error)
  }
}
