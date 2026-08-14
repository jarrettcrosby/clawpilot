import { NextRequest, NextResponse } from 'next/server'
import { importCrmWorkbook } from '@/lib/crm/workbookImport'
import { projectCrmWorkbook } from '@/lib/crm/workbookProjection'
import { rebuildPipelineGoogleWorkbook } from '@/lib/pipelineProvisioning'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  requirePipelineSheetContext,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

export async function POST(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json({ ok: false, error: 'CRM workbook rebuild requires Postgres storage' }, { status: 409 })
  }
  try {
    const actor = await requireRequestUser(req)
    const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
    const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: selected })
      .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor }))
    if (pipeline.ownerEmail !== actor.email || pipeline.accessRole !== 'owner') {
      return NextResponse.json({ ok: false, error: 'Only the pipeline owner can rebuild its CRM workbook' }, { status: 403 })
    }

    const previousContext = requirePipelineSheetContext(pipeline)
    const imported = await importCrmWorkbook({ context: previousContext, actorEmail: actor.email })
    const rebuilt = await rebuildPipelineGoogleWorkbook({ pipelineId: pipeline.id, actorEmail: actor.email })
    const projected = await projectCrmWorkbook({
      context: { pipelineId: pipeline.id, sheetId: rebuilt.sheetId },
      actorEmail: actor.email,
    })
    return NextResponse.json({ ok: true, imported, rebuilt, projected })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CRM workbook rebuild failed'
    const status = message === 'Unauthorized' ? 401 : /Only the pipeline owner/.test(message) ? 403 : 400
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
