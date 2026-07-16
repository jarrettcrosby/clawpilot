import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDropdownCatalog, pushDropdownsToSheet } from '@/lib/pipelineDropdownSync'
import {
  isPostgresPipelineStoreEnabled,
  readPipelineDropdownCatalogForSpaceInPostgres,
  upsertAppManagedPipelineDropdownCatalogInPostgres,
  type PipelineSheetContext,
  upsertPipelineDropdownCatalogAndEnqueueInPostgres,
} from '@/lib/persistence/pipeline'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  isLegacyOwnerSheetPipeline,
  requirePipelineSheetContext,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

function idempotencyKey(req: NextRequest) {
  return (String(req.headers.get('idempotency-key') || '').trim() || crypto.randomUUID()).slice(0, 200)
}

const EDITABLE_WORKFLOW_FIELDS = ['stage', 'priority', 'status', 'source', 'loss_reason'] as const

function mergeEditableWorkflowCatalog(currentValue: unknown, submittedValue: unknown) {
  const current = currentValue && typeof currentValue === 'object' ? currentValue as Record<string, unknown> : {}
  const submitted = submittedValue && typeof submittedValue === 'object' ? submittedValue as Record<string, unknown> : {}
  const currentDropdowns = current.dropdowns && typeof current.dropdowns === 'object'
    ? current.dropdowns as Record<string, unknown>
    : {}
  const submittedDropdowns = submitted.dropdowns && typeof submitted.dropdowns === 'object'
    ? submitted.dropdowns as Record<string, unknown>
    : {}
  const dropdowns = { ...currentDropdowns }
  for (const key of EDITABLE_WORKFLOW_FIELDS) {
    if (Array.isArray(submittedDropdowns[key])) dropdowns[key] = submittedDropdowns[key]
  }
  return {
    ...current,
    source: 'app',
    syncedAt: new Date().toISOString(),
    dropdowns,
  }
}

function editableWorkflowPatch(submittedValue: unknown) {
  const submitted = submittedValue && typeof submittedValue === 'object'
    ? submittedValue as Record<string, unknown>
    : {}
  const submittedDropdowns = submitted.dropdowns && typeof submitted.dropdowns === 'object'
    ? submitted.dropdowns as Record<string, unknown>
    : {}
  return {
    source: 'app',
    syncedAt: new Date().toISOString(),
    dropdowns: Object.fromEntries(EDITABLE_WORKFLOW_FIELDS.flatMap((key) => (
      Array.isArray(submittedDropdowns[key]) ? [[key, submittedDropdowns[key]]] : []
    ))),
  }
}

export async function GET(req: NextRequest) {
  try {
    const forceRefresh = req.nextUrl.searchParams.get('refresh') === '1'
    let context: (PipelineSheetContext & { legacyOwnerFallback: boolean }) | undefined
    if (isPostgresPipelineStoreEnabled()) {
      const actor = await requireRequestUser(req)
      const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
      const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
        .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
      if (!pipeline.syncEnabled) {
        const catalog = await readPipelineDropdownCatalogForSpaceInPostgres(pipeline.id)
        return NextResponse.json({ ok: true, catalog: catalog || { syncedAt: null, source: 'app', dropdowns: {} } })
      }
      if (forceRefresh) requireResourceEditor(pipeline)
      context = {
        ...requirePipelineSheetContext(pipeline),
        legacyOwnerFallback: isLegacyOwnerSheetPipeline(pipeline),
      }
    }
    const out = await getDropdownCatalog({ ...context, forceRefresh })
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
      const current = await readPipelineDropdownCatalogForSpaceInPostgres(pipeline.id)
      const catalog = mergeEditableWorkflowCatalog(current, body)
      const catalogPatch = editableWorkflowPatch(body)
      if (!pipeline.syncEnabled) {
        const saved = await upsertAppManagedPipelineDropdownCatalogInPostgres({
          pipelineId: pipeline.id,
          catalog,
          actorEmail: actor.email,
        })
        return NextResponse.json({ ok: true, catalog: saved, syncStatus: 'succeeded', outboxId: null })
      }
      const context = requirePipelineSheetContext(pipeline)
      const queued = await upsertPipelineDropdownCatalogAndEnqueueInPostgres({
        ...context,
        catalog,
        outbox: {
          aggregateType: 'pipeline_dropdowns',
          aggregateId: pipeline.id,
          operation: 'patch_dropdowns',
          payload: { catalogPatch },
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
