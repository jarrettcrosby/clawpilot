import { NextRequest, NextResponse } from 'next/server'
import { updateWorkspaceOrganizationParent } from '@/lib/organizations'
import { ensurePipelineCrmHierarchy } from '@/lib/persistence/crm'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query } from '@/lib/persistence/postgres'
import { requireRequestUser } from '@/lib/requestUser'

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unable to update organization hierarchy'
  const status = message === 'Unauthorized' ? 401 : /permission/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 400
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function PATCH(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json({ ok: false, error: 'CRM requires Postgres storage' }, { status: 409 })
  }
  try {
    const actor = await requireRequestUser(req)
    const body = await req.json()
    const hierarchy = await updateWorkspaceOrganizationParent({
      actorEmail: actor,
      organizationId: body?.organizationId,
      parentId: body?.parentId,
    })
    const affected = await query<{ id: string }>(
      `WITH RECURSIVE affected AS (
         SELECT id FROM workspace_organizations WHERE id = $1::uuid
         UNION ALL
         SELECT child.id
         FROM workspace_organizations child
         JOIN affected parent ON child.parent_id = parent.id
       )
       SELECT pipeline.id::text
       FROM pipeline_spaces pipeline
       JOIN affected organization ON organization.id = pipeline.workspace_organization_id`,
      [String(body?.organizationId || '')],
    )
    for (const pipeline of affected.rows) {
      await ensurePipelineCrmHierarchy({ pipelineId: pipeline.id, actorEmail: actor.email })
    }
    return NextResponse.json({ ok: true, hierarchy })
  } catch (error) {
    return errorResponse(error)
  }
}
