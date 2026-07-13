import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDropdownCatalog, pushDropdownsToSheet } from '@/lib/pipelineDropdownSync'
import {
  isPostgresPipelineStoreEnabled,
  upsertPipelineDropdownCatalogAndEnqueueInPostgres,
} from '@/lib/persistence/pipeline'
import { requireRequestUser } from '@/lib/requestUser'
import { PIPELINE_SELECTION_COOKIE, requireResourceEditor, resolvePipelineSpaceAccess } from '@/lib/tenancy'

function idempotencyKey(req: NextRequest) {
  return (String(req.headers.get('idempotency-key') || '').trim() || crypto.randomUUID()).slice(0, 200)
}

export async function GET(req: NextRequest) {
  try {
    const forceRefresh = req.nextUrl.searchParams.get('refresh') === '1'
    if (isPostgresPipelineStoreEnabled()) {
      const actor = await requireRequestUser(req)
      const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
      const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
        .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
      if (!pipeline.syncEnabled) {
        return NextResponse.json({ ok: true, catalog: { syncedAt: null, source: 'app', dropdowns: {} } })
      }
      if (forceRefresh) requireResourceEditor(pipeline)
    }
    const out = await getDropdownCatalog({ forceRefresh })
    return NextResponse.json({ ok: true, ...out })
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    if (isPostgresPipelineStoreEnabled()) {
      const actor = await requireRequestUser(req)
      const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
      const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
        .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
      requireResourceEditor(pipeline)
      if (!pipeline.syncEnabled) {
        return NextResponse.json({ ok: false, error: 'Custom dropdown editing is not available for app-managed pipelines yet' }, { status: 400 })
      }
      const catalog = {
        ...body,
        source: 'app',
        syncedAt: new Date().toISOString(),
      }
      const queued = await upsertPipelineDropdownCatalogAndEnqueueInPostgres({
        catalog,
        outbox: {
          aggregateType: 'pipeline_dropdowns',
          aggregateId: 'default',
          operation: 'replace_dropdowns',
          payload: {},
          actor: actor.email,
          idempotencyKey: idempotencyKey(req),
        },
      })
      const syncStatus = queued.outboxStatus === 'succeeded' ? 'succeeded' : 'queued'
      return NextResponse.json(
        { ok: true, catalog: queued.catalog, syncStatus, outboxId: queued.outboxId },
        { status: syncStatus === 'queued' ? 202 : 200 },
      )
    }

    const out = await pushDropdownsToSheet(body)
    return NextResponse.json({ ok: true, ...out, syncStatus: 'succeeded' })
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
