import { NextRequest, NextResponse } from 'next/server'
import {
  buildCrmDataTransferCsv,
  CRM_DATA_TRANSFER_MAX_BYTES,
  CrmDataTransferCsvError,
  isCrmTransferEntity,
  isCrmWritableTransferEntity,
} from '@/lib/crm/dataTransferCsv'
import { reconcileCrmBoardProjectionsForPipeline } from '@/lib/crm/boardProjection'
import {
  ensurePipelineCrmHierarchy,
} from '@/lib/persistence/crm'
import {
  applyCrmDataTransferPreview,
  createCrmDataTransferPreview,
  exportCrmDataTransferCsvSegments,
} from '@/lib/persistence/crmDataTransfers'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { recordAuditEvent } from '@/lib/auditWriter'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'
import {
  PIPELINE_SELECTION_COOKIE,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

const CRM_DATA_TRANSFER_MULTIPART_OVERHEAD_BYTES = 65_536
const CRM_DATA_TRANSFER_MAX_REQUEST_BYTES = CRM_DATA_TRANSFER_MAX_BYTES
  + CRM_DATA_TRANSFER_MULTIPART_OVERHEAD_BYTES

async function selectedPipeline(req: NextRequest, actor: AppUser) {
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
  return resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: selected })
    .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor }))
}

function stringValue(value: unknown, max = 500) {
  const normalized = String(value ?? '').trim()
  if (normalized.length > max) throw new Error('CRM data-transfer value is too long')
  return normalized
}

function errorResponse(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : 'CRM data transfer failed'
  const code = error instanceof CrmDataTransferCsvError
    ? error.code
    : 'CRM_DATA_TRANSFER_FAILED'
  const status = message === 'Unauthorized'
    ? 401
    : code === 'CRM_CSV_BYTE_LIMIT_EXCEEDED'
      || code === 'CRM_CSV_REQUEST_TOO_LARGE'
      ? 413
    : /view-only|denied/i.test(message)
      ? 403
      : /expired|changed after|no longer available|idempotency|were imported, but/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 400
  return NextResponse.json({ ok: false, error: message, code }, { status })
}

function exportPart(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('part') || '1'
  const part = Number(raw)
  if (!Number.isSafeInteger(part) || part < 1 || part > 100_000) {
    throw new Error('CRM CSV export part is invalid')
  }
  return part
}

export async function GET(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'CRM data transfer requires Postgres storage' },
      { status: 409 },
    )
  }
  try {
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor)
    requireResourceEditor(pipeline)
    const entityValue = req.nextUrl.searchParams.get('entity')
    if (!isCrmTransferEntity(entityValue)) throw new Error('CRM entity is invalid')
    const template = req.nextUrl.searchParams.get('template') === 'true'
    if (template && !isCrmWritableTransferEntity(entityValue)) {
      throw new Error('This CRM entity is export-only')
    }
    const part = exportPart(req)
    const segments = template
      ? [buildCrmDataTransferCsv({ entity: entityValue, rows: [] })]
      : await exportCrmDataTransferCsvSegments({
          pipelineId: pipeline.id,
          entity: entityValue,
        })
    if (part > segments.length) {
      throw new Error('CRM CSV export part is no longer available')
    }
    const csv = segments[part - 1]
    await recordAuditEvent({
      actor: actor.email,
      eventType: 'crm.data_transfer.exported',
      aggregateType: `crm_${entityValue}`,
      aggregateId: pipeline.id,
      eventKey: null,
      payload: {
        pipelineId: pipeline.id,
        entity: entityValue,
        template,
        part,
        parts: segments.length,
      },
    })
    const date = new Date().toISOString().slice(0, 10)
    const partSuffix = segments.length > 1
      ? `-part-${String(part).padStart(String(segments.length).length, '0')}-of-${segments.length}`
      : ''
    const fileKind = template ? 'template' : `${date}${partSuffix}`
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="clawpilot-${entityValue}-${fileKind}.csv"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-ClawPilot-Export-Part': String(part),
        'X-ClawPilot-Export-Parts': String(segments.length),
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'CRM data transfer requires Postgres storage' },
      { status: 409 },
    )
  }
  try {
    const contentType = req.headers.get('content-type') || ''
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      throw new Error('CRM data transfer requires a multipart CSV upload')
    }
    const contentLength = Number(req.headers.get('content-length'))
    if (
      Number.isFinite(contentLength)
      && contentLength > CRM_DATA_TRANSFER_MAX_REQUEST_BYTES
    ) {
      throw new CrmDataTransferCsvError(
        'CRM_CSV_REQUEST_TOO_LARGE',
        'CRM CSV uploads are limited to 1 MB',
      )
    }
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor)
    requireResourceEditor(pipeline)
    const form = await req.formData()
    const entityValue = form.get('entity')
    if (!isCrmWritableTransferEntity(entityValue)) {
      throw new Error(
        'Meetings, interactions, and campaigns are export-only in CRM CSV transfer',
      )
    }
    const file = form.get('file')
    if (!(file instanceof File)) throw new Error('Choose a CRM CSV file')
    if (!file.name.toLowerCase().endsWith('.csv')) {
      throw new Error('CRM data transfer accepts CSV files only')
    }
    if (file.size > CRM_DATA_TRANSFER_MAX_BYTES) {
      throw new CrmDataTransferCsvError(
        'CRM_CSV_BYTE_LIMIT_EXCEEDED',
        'CRM CSV uploads are limited to 1 MB',
      )
    }
    const preview = await createCrmDataTransferPreview({
      pipelineId: pipeline.id,
      actorEmail: actor.email,
      entity: entityValue,
      fileName: file.name,
      csv: await file.text(),
    })
    return NextResponse.json({ ok: true, preview }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'CRM data transfer requires Postgres storage' },
      { status: 409 },
    )
  }
  try {
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor)
    requireResourceEditor(pipeline)
    const body = await req.json()
    const runId = stringValue(body?.runId, 50)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      throw new Error('CRM import preview is invalid')
    }
    if (!Array.isArray(body?.rowNumbers)) {
      throw new Error('Select CRM rows to import')
    }
    const idempotencyKey = stringValue(
      req.headers.get('Idempotency-Key') || body?.idempotencyKey,
      200,
    )
    const hierarchy = await ensurePipelineCrmHierarchy({
      pipelineId: pipeline.id,
      actorEmail: actor.email,
    })
    const result = await applyCrmDataTransferPreview({
      pipelineId: pipeline.id,
      actorEmail: actor.email,
      runId,
      rowNumbers: body.rowNumbers.map(Number),
      confirmUpdates: body.confirmUpdates === true,
      idempotencyKey,
      customerParent: {
        id: hierarchy.customerParent.id,
        suiteCrmId: hierarchy.customerParent.suiteCrmId,
      },
    })
    try {
      await reconcileCrmBoardProjectionsForPipeline({
        pipelineId: pipeline.id,
      })
    } catch (error) {
      console.error('[crm-data-transfer] board refresh failed', {
        pipelineId: pipeline.id,
        runId,
        error: error instanceof Error ? error.message : 'unknown error',
      })
      throw new Error(
        'CRM records were imported, but the CRM Board refresh failed. Retry Apply to finish safely.',
      )
    }
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    return errorResponse(error)
  }
}
