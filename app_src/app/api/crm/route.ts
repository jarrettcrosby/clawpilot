import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { CRM_ENTITIES, type CrmEntity } from '@/lib/crm/types'
import {
  ensurePipelineCrmHierarchy,
  listCrmRecordsInPostgres,
  readCrmRecordReference,
  readCrmSummaryFromPostgres,
  stageCrmRecordInPostgres,
} from '@/lib/persistence/crm'
import { listWorkspaceOrganizationHierarchy } from '@/lib/organizations'
import { suiteCrmAdminPortalUrl, suiteCrmAdminUsername } from '@/lib/crm/suiteCrmPublicUrl'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

function entityValue(value: unknown): CrmEntity {
  const entity = String(value || '') as CrmEntity
  if (!CRM_ENTITIES.includes(entity)) throw new Error('CRM entity is invalid')
  return entity
}

function objectValue(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CRM record fields are required')
  return value as Record<string, unknown>
}

function stringValue(value: unknown, max = 500) {
  const out = String(value ?? '').trim()
  if (out.length > max) throw new Error('CRM field is too long')
  return out
}

function numberValue(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const out = Number(value)
  if (!Number.isFinite(out)) return 0
  return Math.max(min, Math.min(max, out))
}

function validEmail(value: unknown) {
  const email = stringValue(value, 254).toLowerCase()
  if (email && !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) {
    throw new Error('Contact email is invalid')
  }
  return email
}

async function selectedPipeline(req: NextRequest, actorEmail: string) {
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
  return resolvePipelineSpaceAccess({ actorEmail, pipelineId: selected })
    .catch(() => resolvePipelineSpaceAccess({ actorEmail }))
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'CRM request failed'
  const status = message === 'Unauthorized' ? 401 : /view-only|denied/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 400
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function GET(req: NextRequest) {
  if (!isPostgresStorageEnabled()) return NextResponse.json({ ok: false, error: 'CRM requires Postgres storage' }, { status: 409 })
  try {
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor.email)
    const entity = entityValue(req.nextUrl.searchParams.get('entity') || 'organizations')
    const canOpenSuiteCrm = actor.role === 'owner' || actor.role === 'admin'
    await ensurePipelineCrmHierarchy({ pipelineId: pipeline.id, actorEmail: actor.email })
    const [records, summary, workspaceHierarchy] = await Promise.all([
      listCrmRecordsInPostgres({
        pipelineId: pipeline.id,
        entity,
        query: req.nextUrl.searchParams.get('query') || '',
        limit: Number(req.nextUrl.searchParams.get('limit') || 250),
      }),
      readCrmSummaryFromPostgres(pipeline.id),
      listWorkspaceOrganizationHierarchy(actor.email),
    ])
    return NextResponse.json({
      ok: true,
      entity,
      records,
      summary,
      pipeline: {
        id: pipeline.id,
        name: pipeline.name,
        ownerEmail: pipeline.ownerEmail,
        workspaceOrganizationId: pipeline.workspaceOrganizationId,
        accessRole: pipeline.accessRole,
        shortLinkUrl: pipeline.shortLinkUrl,
      },
      workspaceHierarchy,
      canManageHierarchy: actor.role === 'owner' || actor.role === 'admin',
      suiteCrmPunchoutUrl: canOpenSuiteCrm ? '/api/crm/punchout' : null,
      suiteCrmUsername: canOpenSuiteCrm ? suiteCrmAdminUsername() : null,
      suiteCrmAdminPortalUrl: canOpenSuiteCrm ? suiteCrmAdminPortalUrl() : null,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  if (!isPostgresStorageEnabled()) return NextResponse.json({ ok: false, error: 'CRM requires Postgres storage' }, { status: 409 })
  try {
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor.email)
    requireResourceEditor(pipeline)
    const hierarchy = await ensurePipelineCrmHierarchy({ pipelineId: pipeline.id, actorEmail: actor.email })
    const body = await req.json()
    const entity = entityValue(body?.entity)
    const fields = objectValue(body?.fields)
    let sourceKey = `app:${entity}:${crypto.randomUUID()}`
    let current: Awaited<ReturnType<typeof readCrmRecordReference>> | null = null
    if (body?.id) {
      current = await readCrmRecordReference({ pipelineId: pipeline.id, entity, id: String(body.id) })
      sourceKey = current.sourceKey
    }

    if (entity === 'organizations') {
      if (current?.workspaceOrganizationId) throw new Error('Workspace organizations are managed in the hierarchy')
      const name = stringValue(fields.name, 250)
      if (!name) throw new Error('Organization name is required')
      const staged = await stageCrmRecordInPostgres({
        entity, pipelineId: pipeline.id, localId: current?.id, sourceKey, actorEmail: actor.email,
        sourcePayload: { source: 'clawpilot' },
        fields: {
          parentOrganizationId: hierarchy.customerParent.id,
          parentOrganizationSuiteCrmId: hierarchy.customerParent.suiteCrmId,
          relationshipType: 'customer',
          name, priority: stringValue(fields.priority, 50), accountType: stringValue(fields.accountType, 100),
          accountManager: stringValue(fields.accountManager, 200), website: stringValue(fields.website, 500),
          linkedinUrl: stringValue(fields.linkedinUrl, 500), phone: stringValue(fields.phone, 100),
          address: stringValue(fields.address, 500), city: stringValue(fields.city, 150), state: stringValue(fields.state, 150),
          postalCode: stringValue(fields.postalCode, 50), country: stringValue(fields.country, 100),
          description: stringValue(fields.description, 10_000),
        },
      })
      return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
    }

    let organization: Awaited<ReturnType<typeof readCrmRecordReference>> | null = null
    if (fields.organizationId) {
      organization = await readCrmRecordReference({ pipelineId: pipeline.id, entity: 'organizations', id: String(fields.organizationId) })
    }

    if (entity === 'contacts') {
      const fullName = stringValue(fields.fullName, 250)
      if (!fullName) throw new Error('Contact name is required')
      const staged = await stageCrmRecordInPostgres({
        entity, pipelineId: pipeline.id, localId: current?.id, sourceKey, actorEmail: actor.email,
        sourcePayload: { source: 'clawpilot' },
        fields: {
          organizationId: organization?.id || null, organizationSuiteCrmId: organization?.suiteCrmId || null,
          fullName, firstName: stringValue(fields.firstName, 100), lastName: stringValue(fields.lastName, 150),
          priority: stringValue(fields.priority, 50), contactType: stringValue(fields.contactType, 100),
          accountManager: stringValue(fields.accountManager, 200), jobTitle: stringValue(fields.jobTitle, 250),
          email: validEmail(fields.email), linkedinUrl: stringValue(fields.linkedinUrl, 500),
          phoneWork: stringValue(fields.phoneWork, 100), phoneMobile: stringValue(fields.phoneMobile, 100),
          address: stringValue(fields.address, 500), city: stringValue(fields.city, 150), state: stringValue(fields.state, 150),
          postalCode: stringValue(fields.postalCode, 50), country: stringValue(fields.country, 100),
          description: stringValue(fields.description, 10_000),
        },
      })
      return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
    }

    if (entity === 'opportunities') {
      const name = stringValue(fields.name, 250)
      const organizationName = organization?.name || stringValue(fields.organization, 250)
      if (!name || !organizationName) throw new Error('Opportunity and organization are required')
      const staged = await stageCrmRecordInPostgres({
        entity, pipelineId: pipeline.id, sourceKey, actorEmail: actor.email,
        sourcePayload: { source: 'clawpilot' },
        fields: {
          organizationId: organization?.id || null, organizationSuiteCrmId: organization?.suiteCrmId || null,
          name, organization: organizationName, priority: stringValue(fields.priority, 50), owner: stringValue(fields.owner, 200),
          status: stringValue(fields.status, 100), stage: stringValue(fields.stage, 100), lossReason: stringValue(fields.lossReason, 250),
          source: stringValue(fields.source, 150), value: numberValue(fields.value), probability: numberValue(fields.probability, 0, 100),
          expectedClose: stringValue(fields.expectedClose, 20) || null, notes: stringValue(fields.notes, 10_000),
        },
      })
      return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
    }

    let opportunity: Awaited<ReturnType<typeof readCrmRecordReference>> | null = null
    if (fields.opportunityId) {
      opportunity = await readCrmRecordReference({ pipelineId: pipeline.id, entity: 'opportunities', id: String(fields.opportunityId) })
    }
    const subject = stringValue(fields.subject, 250)
    if (!subject) throw new Error('Interaction subject is required')
    const staged = await stageCrmRecordInPostgres({
      entity, pipelineId: pipeline.id, sourceKey, actorEmail: actor.email,
      sourcePayload: { source: 'clawpilot' },
      fields: {
        organizationId: organization?.id || null, opportunityId: opportunity?.id || null,
        parentSuiteCrmId: opportunity?.suiteCrmId || null, interactionType: stringValue(fields.interactionType, 100),
        subject, agentName: stringValue(fields.agentName, 200), occurredAt: stringValue(fields.occurredAt, 50) || null,
        description: stringValue(fields.description, 10_000),
      },
    })
    return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
