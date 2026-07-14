import { NextRequest, NextResponse } from 'next/server'
import { importCrmWorkbook, inspectCrmWorkbook } from '@/lib/crm/workbookImport'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  requirePipelineSheetContext,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

async function context(req: NextRequest) {
  const actor = await requireRequestUser(req)
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
  const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
    .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
  if (pipeline.ownerEmail !== actor.email || pipeline.accessRole !== 'owner') {
    throw new Error('Only the pipeline owner can import its CRM workbook')
  }
  return { actor, pipeline, sheetContext: requirePipelineSheetContext(pipeline) }
}

function responseError(error: unknown) {
  const message = error instanceof Error ? error.message : 'CRM import failed'
  const status = message === 'Unauthorized' ? 401 : /Only the pipeline owner/.test(message) ? 403 : 400
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function GET(req: NextRequest) {
  if (!isPostgresStorageEnabled()) return NextResponse.json({ ok: false, error: 'CRM import requires Postgres storage' }, { status: 409 })
  try {
    const { sheetContext } = await context(req)
    const inspected = await inspectCrmWorkbook(sheetContext)
    return NextResponse.json({ ok: true, counts: inspected.counts })
  } catch (error) {
    return responseError(error)
  }
}

export async function POST(req: NextRequest) {
  if (!isPostgresStorageEnabled()) return NextResponse.json({ ok: false, error: 'CRM import requires Postgres storage' }, { status: 409 })
  try {
    const { actor, sheetContext } = await context(req)
    const result = await importCrmWorkbook({ context: sheetContext, actorEmail: actor.email })
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    return responseError(error)
  }
}
