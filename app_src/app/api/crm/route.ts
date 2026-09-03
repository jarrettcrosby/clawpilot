import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { GLOBAL_ID_MAX_LENGTH } from '@/lib/globalIds.mjs'
import {
  CRM_ENTITIES,
  type CrmActivityStatus,
  type CrmEntity,
  type SuiteCrmInteractionModule,
} from '@/lib/crm/types'
import { isIso4217CurrencyCode } from '@/lib/currency'
import {
  CrmIntegrationActionError,
  crmIntegrationClientRequestHash,
  replayCrmMeetingSaveByIdempotencyKey,
  stageCrmMeetingAndEnqueueCalendarAction,
} from '@/lib/crm/integrationActions'
import { resolveVerifiedPipelineCalendarSelection } from '@/lib/integrations/organizationCommunications'
import { reconcileCrmBoardProjectionsForPipeline } from '@/lib/crm/boardProjection'
import {
  archiveCrmRecordInPostgres,
  convertCrmLeadInPostgres,
  ensurePipelineCrmHierarchy,
  ensurePipelineCrmReferenceLinks,
  listCrmCampaignRecipientsInPostgres,
  listCrmPipelineUsersInPostgres,
  listCrmRecordsInPostgres,
  readCrmRecordReference,
  readCrmSummaryFromPostgres,
  isRecoverableCrmProfileReconciliationError,
  stageCrmRecordInPostgres,
  syncAppUserProfileToCrm,
} from '@/lib/persistence/crm'
import { listWorkspaceOrganizationHierarchy, workspaceOrganizationById } from '@/lib/organizations'
import { suiteCrmAdminPortalUrl, suiteCrmAdminUsername } from '@/lib/crm/suiteCrmPublicUrl'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  OrganizationCommunicationPersistenceError,
  resolvePipelineCommunicationSnapshotInPostgres,
} from '@/lib/persistence/organizationCommunications'
import { readMeasurementPreferences } from '@/lib/persistence/measurementPreferences'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole, type AppUser } from '@/lib/users'
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

const INTERACTION_TYPES = ['email', 'call', 'meeting', 'linkedin', 'note', 'campaign'] as const

function interactionTypeValue(value: unknown) {
  const normalized = stringValue(value, 100).toLowerCase().replace(/\s+/g, ' ')
  const canonical = normalized === 'in person' ? 'meeting' : normalized
  if (INTERACTION_TYPES.includes(canonical as (typeof INTERACTION_TYPES)[number])) return canonical
  throw new Error('Interaction type is invalid')
}

function activityStatusValue(value: unknown, fallback: CrmActivityStatus): CrmActivityStatus {
  const normalized = stringValue(value, 32).toLowerCase().replace(/[\s-]+/g, '_')
  if (!normalized) return fallback
  if (normalized === 'planned' || normalized === 'held' || normalized === 'not_held') return normalized
  throw new Error('Activity status is invalid')
}

function activityDurationMinutes(value: unknown, fallback = 15) {
  if (value === undefined || value === null || value === '') return fallback
  const minutes = Number(value)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new Error('Activity duration must be a whole number from 1 to 1440 minutes')
  }
  return minutes
}

function callDirectionValue(value: unknown) {
  const direction = stringValue(value, 32).toLowerCase()
  if (!direction) return 'outbound' as const
  if (direction === 'inbound' || direction === 'outbound') return direction
  throw new Error('Call direction is invalid')
}

function validEmail(value: unknown) {
  const email = stringValue(value, 254).toLowerCase()
  if (email && !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) {
    throw new Error('CRM email is invalid')
  }
  return email
}

function emailList(value: unknown) {
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value)) throw new Error('Meeting attendees must be a list')
  return Array.from(new Set(value.map(validEmail).filter(Boolean))).slice(0, 200)
}

function uuidList(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`)
  const ids = value.map((item) => stringValue(item, 50)).filter(Boolean)
  if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error(`${label} contains an invalid record`)
  }
  return [...new Set(ids)]
}

function uuidValue(value: unknown, label: string) {
  const id = stringValue(value, 50)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`${label} is invalid`)
  }
  return id
}

function relatedEntityValue(value: unknown): Exclude<CrmEntity, 'interactions' | 'products'> | undefined {
  const entity = stringValue(value, 50)
  if (!entity) return undefined
  if (entity === 'interactions' || entity === 'products' || !CRM_ENTITIES.includes(entity as CrmEntity)) {
    throw new Error('CRM activity relationship is invalid')
  }
  return entity as Exclude<CrmEntity, 'interactions' | 'products'>
}

function timezoneValue(value: unknown) {
  const timezone = stringValue(value, 100) || 'America/New_York'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    return timezone
  } catch {
    throw new Error('Meeting timezone is invalid')
  }
}

async function selectedPipeline(req: NextRequest, actor: AppUser) {
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
  return resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: selected })
    .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor }))
}

async function exactRequestActor(req: NextRequest) {
  const session = await requestSession(req)
  if (session?.impersonating || (session && session.authenticatedUser !== session.effectiveUser)) {
    throw Object.assign(new Error('Exit user view before changing CRM records'), {
      status: 403,
      code: 'CRM_IMPERSONATION_FORBIDDEN',
    })
  }
  return requireRequestUser(req)
}

function meetingSaveIdempotencyKey(req: NextRequest, body: Record<string, unknown>) {
  const bodyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
  const headerKey = (req.headers.get('idempotency-key') || '').trim()
  if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== 'string') {
    throw new CrmIntegrationActionError(
      'Meeting save idempotency key is invalid',
      400,
      'CRM_MEETING_IDEMPOTENCY_INVALID',
    )
  }
  if (bodyKey && headerKey && bodyKey !== headerKey) {
    throw new CrmIntegrationActionError(
      'Meeting save idempotency key fields do not match',
      400,
      'CRM_MEETING_IDEMPOTENCY_MISMATCH',
    )
  }
  const key = bodyKey || headerKey
  if (key.length < 8 || key.length > 200 || /\s|[\u0000-\u001f\u007f]/.test(key)) {
    throw new CrmIntegrationActionError(
      'Meeting save requires a valid idempotency key',
      400,
      'CRM_MEETING_IDEMPOTENCY_REQUIRED',
    )
  }
  return key
}

function meetingSaveKey(namespace: string, pipelineId: string, actorEmail: string, idempotencyKey: string) {
  const digest = crypto.createHash('sha256')
    .update(`${pipelineId}\n${actorEmail}\n${idempotencyKey}`)
    .digest('hex')
  return `crm:meeting-${namespace}:${digest}`
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'CRM request failed'
  const shaped = error as { status?: unknown; code?: unknown }
  const status = Number.isInteger(shaped?.status)
    ? Number(shaped.status)
    : message === 'Unauthorized'
      ? 401
      : /view-only|denied/i.test(message)
        ? 403
        : /not found/i.test(message)
          ? 404
          : 400
  return NextResponse.json({
    ok: false,
    error: message,
    ...(typeof shaped?.code === 'string' ? { code: shaped.code } : {}),
  }, { status })
}

export async function GET(req: NextRequest) {
  if (!isPostgresStorageEnabled()) return NextResponse.json({ ok: false, error: 'CRM requires Postgres storage' }, { status: 409 })
  try {
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor)
    const entity = entityValue(req.nextUrl.searchParams.get('entity') || 'organizations')
    const relatedEntity = entity === 'interactions'
      ? relatedEntityValue(req.nextUrl.searchParams.get('relatedEntity'))
      : undefined
    const relatedId = relatedEntity
      ? uuidValue(req.nextUrl.searchParams.get('relatedId'), 'CRM activity record')
      : undefined
    const currentOrganization = actor.organizationId
      ? await workspaceOrganizationById(actor.organizationId)
      : null
    const organizationRole = effectiveAuthorizationRole(actor)
    const canOpenSuiteCrm = (organizationRole === 'owner' || organizationRole === 'admin')
      && currentOrganization?.parentId === null
    try {
      await syncAppUserProfileToCrm({ email: actor.email, pipelineId: pipeline.id })
    } catch (error) {
      if (!isRecoverableCrmProfileReconciliationError(error)) throw error
      console.error('[crm] profile reconciliation deferred', {
        pipelineId: pipeline.id,
        error: error instanceof Error ? error.message : 'unknown error',
      })
    }
    await ensurePipelineCrmReferenceLinks(pipeline.id)
    const [
      records,
      summary,
      workspaceHierarchy,
      googleMailIdentity,
      googleCalendarIdentity,
      pipelineUsers,
      campaignRecipients,
    ] = await Promise.all([
      listCrmRecordsInPostgres({
        pipelineId: pipeline.id,
        entity,
        query: req.nextUrl.searchParams.get('query') || '',
        limit: Number(req.nextUrl.searchParams.get('limit') || 250),
        needsReview: req.nextUrl.searchParams.get('needsReview') === 'true',
        relatedEntity,
        relatedId,
      }),
      readCrmSummaryFromPostgres(pipeline.id),
      listWorkspaceOrganizationHierarchy(actor),
      resolvePipelineCommunicationSnapshotInPostgres({
        pipelineId: pipeline.id,
        actorEmail: actor.email,
        app: 'google-mail',
      }).catch(() => null),
      resolvePipelineCommunicationSnapshotInPostgres({
        pipelineId: pipeline.id,
        actorEmail: actor.email,
        app: 'google-calendar',
      }).catch(() => null),
      listCrmPipelineUsersInPostgres(pipeline.id),
      relatedEntity === 'campaigns' && relatedId
        ? listCrmCampaignRecipientsInPostgres({ pipelineId: pipeline.id, campaignId: relatedId })
        : Promise.resolve([]),
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
      pipelineUsers,
      campaignRecipients,
      canManageHierarchy: organizationRole === 'owner' || organizationRole === 'admin',
      canManageProductIdentities: operationsCapabilities(actor).canManage,
      providerIdentities: {
        googleMail: googleMailIdentity?.identityEmail || null,
        googleCalendar: googleCalendarIdentity?.identityEmail || null,
        googleMailSendAsEmail: googleMailIdentity?.identityEmail || null,
        googleMailConnectionId: googleMailIdentity?.connectionId || null,
        googleMailAccountEmail: googleMailIdentity?.accountEmail || null,
        googleCalendarOrganizer: googleCalendarIdentity?.identityEmail || null,
        googleCalendarConnectionId: googleCalendarIdentity?.connectionId || null,
        googleCalendarId: googleCalendarIdentity?.calendarId || null,
        googleMailSource: googleMailIdentity?.source || null,
        googleCalendarSource: googleCalendarIdentity?.source || null,
      },
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
    const actor = await exactRequestActor(req)
    const pipeline = await selectedPipeline(req, actor)
    requireResourceEditor(pipeline)
    const body = await req.json()
    const entity = entityValue(body?.entity)
    const fields = objectValue(body?.fields)
    const meetingIdempotencyKey = entity === 'meetings'
      ? meetingSaveIdempotencyKey(req, body as Record<string, unknown>)
      : null
    const meetingCalendarActionKey = meetingIdempotencyKey
      ? meetingSaveKey('calendar', pipeline.id, actor.email, meetingIdempotencyKey)
      : null
    const meetingClientRequestHash = meetingIdempotencyKey
      ? crmIntegrationClientRequestHash({
          contract: 'crm-meeting-save-v1',
          pipelineId: pipeline.id,
          actorEmail: actor.email,
          entity: 'meetings',
          id: body?.id ?? null,
          fields,
        })
      : null
    if (meetingCalendarActionKey && meetingClientRequestHash) {
      const replay = await replayCrmMeetingSaveByIdempotencyKey({
        pipelineId: pipeline.id,
        actorEmail: actor.email,
        idempotencyKey: meetingCalendarActionKey,
        clientRequestHash: meetingClientRequestHash,
      })
      if (replay) {
        return NextResponse.json({
          ok: true,
          queued: ['queued', 'processing', 'failed'].includes(replay.action.status),
          record: replay.staged,
          calendarAction: replay.action,
          calendarActionUnavailable: null,
        })
      }
    }
    const hierarchy = await ensurePipelineCrmHierarchy({ pipelineId: pipeline.id, actorEmail: actor.email })
    let sourceKey = meetingIdempotencyKey
      ? meetingSaveKey('record', pipeline.id, actor.email, meetingIdempotencyKey)
      : `app:${entity}:${crypto.randomUUID()}`
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
          email: validEmail(fields.email), emailOptOut: fields.emailOptOut === true,
          address: stringValue(fields.address, 500), city: stringValue(fields.city, 150), state: stringValue(fields.state, 150),
          postalCode: stringValue(fields.postalCode, 50), country: stringValue(fields.country, 100),
          description: stringValue(fields.description, 10_000),
        },
      })
      await reconcileCrmBoardProjectionsForPipeline({ pipelineId: pipeline.id })
      return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
    }

    let organization: Awaited<ReturnType<typeof readCrmRecordReference>> | null = null
    if (fields.organizationId) {
      organization = await readCrmRecordReference({ pipelineId: pipeline.id, entity: 'organizations', id: String(fields.organizationId) })
    }

    if (entity === 'contacts') {
      const fullName = stringValue(fields.fullName, 250)
      if (!fullName) throw new Error('Contact name is required')
      if (!organization) throw new Error('Contact organization is required')
      const staged = await stageCrmRecordInPostgres({
        entity, pipelineId: pipeline.id, localId: current?.id, sourceKey, actorEmail: actor.email,
        sourcePayload: { source: 'clawpilot' },
        fields: {
          organizationId: organization.id, organizationSuiteCrmId: organization.suiteCrmId,
          fullName, firstName: stringValue(fields.firstName, 100), lastName: stringValue(fields.lastName, 150),
          priority: stringValue(fields.priority, 50), contactType: stringValue(fields.contactType, 100),
          accountManager: stringValue(fields.accountManager, 200),
          ...(fields.ownerUserReferenceCode === undefined ? {} : {
            ownerUserReferenceCode: stringValue(fields.ownerUserReferenceCode, GLOBAL_ID_MAX_LENGTH).toLowerCase() || null,
          }),
          jobTitle: stringValue(fields.jobTitle, 250),
          email: validEmail(fields.email), linkedinUrl: stringValue(fields.linkedinUrl, 500),
          phoneWork: stringValue(fields.phoneWork, 100), phoneMobile: stringValue(fields.phoneMobile, 100),
          address: stringValue(fields.address, 500), city: stringValue(fields.city, 150), state: stringValue(fields.state, 150),
          postalCode: stringValue(fields.postalCode, 50), country: stringValue(fields.country, 100),
          description: stringValue(fields.description, 10_000),
          emailOptOut: fields.emailOptOut === true,
        },
      })
      await reconcileCrmBoardProjectionsForPipeline({ pipelineId: pipeline.id })
      return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
    }

    if (entity === 'leads') {
      const fullName = stringValue(fields.fullName, 250)
      if (!fullName) throw new Error('Lead name is required')
      const nameParts = fullName.split(/\s+/).filter(Boolean)
      const staged = await stageCrmRecordInPostgres({
        entity, pipelineId: pipeline.id, localId: current?.id, sourceKey, actorEmail: actor.email,
        sourcePayload: { ...(current?.sourcePayload || {}), source: 'clawpilot' },
        fields: {
          organizationId: organization?.id || null, organizationSuiteCrmId: organization?.suiteCrmId || null,
          firstName: stringValue(fields.firstName, 100) || nameParts[0] || fullName,
          lastName: stringValue(fields.lastName, 150) || nameParts.slice(1).join(' '), fullName,
          companyName: organization?.name || stringValue(fields.companyName, 250), jobTitle: stringValue(fields.jobTitle, 250),
          email: validEmail(fields.email), phoneWork: stringValue(fields.phoneWork, 100),
          phoneMobile: stringValue(fields.phoneMobile, 100), status: stringValue(fields.status, 100),
          source: stringValue(fields.source, 150), assignedTo: stringValue(fields.assignedTo, 200),
          description: stringValue(fields.description, 10_000), emailOptOut: fields.emailOptOut === true,
        },
      })
      return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
    }

    if (entity === 'opportunities') {
      const name = stringValue(fields.name, 250)
      const organizationName = organization?.name || stringValue(fields.organization, 250)
      if (!name || !organizationName) throw new Error('Opportunity and organization are required')
      const staged = await stageCrmRecordInPostgres({
        entity, pipelineId: pipeline.id, localId: current?.id, sourceKey, actorEmail: actor.email,
        sourcePayload: { source: 'clawpilot' },
        fields: {
          organizationId: organization?.id || null, organizationSuiteCrmId: organization?.suiteCrmId || null,
          contactIds: fields.contactIds === undefined ? undefined : uuidList(fields.contactIds, 'Opportunity contacts'),
          name, organization: organizationName, priority: stringValue(fields.priority, 50), owner: stringValue(fields.owner, 200),
          productIds: fields.productIds === undefined ? undefined : uuidList(fields.productIds, 'Opportunity products'),
          status: stringValue(fields.status, 100), stage: stringValue(fields.stage, 100), lossReason: stringValue(fields.lossReason, 250),
          source: stringValue(fields.source, 150), value: numberValue(fields.value), probability: numberValue(fields.probability, 0, 100),
          expectedClose: stringValue(fields.expectedClose, 20) || null, notes: stringValue(fields.notes, 10_000),
        },
      })
      return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
    }

    if (entity === 'products') {
      const name = stringValue(fields.name, 250)
      if (!name) throw new Error('Product name is required')
      const sku = stringValue(fields.sku, 25)
      const requestedCurrency = stringValue(fields.currency, 3)
      const existingCurrency = stringValue(
        current && 'currency' in current ? current.currency : '',
        3,
      )
      const preferences = !current && !requestedCurrency
        ? await readMeasurementPreferences(actor)
        : null
      const currency = (
        requestedCurrency
        || existingCurrency
        || preferences?.organizationCurrencyCode
        || ''
      ).toUpperCase()
      if (!isIso4217CurrencyCode(currency)) {
        throw new Error('Product currency must be a supported ISO 4217 code')
      }
      const url = stringValue(fields.url, 2_000)
      if (url && !/^https?:\/\//i.test(url)) throw new Error('Product URL must use http or https')
      const staged = await stageCrmRecordInPostgres({
        entity,
        pipelineId: pipeline.id,
        localId: current?.id,
        sourceKey,
        actorEmail: actor.email,
        sourcePayload: { ...(current?.sourcePayload || {}), source: 'clawpilot' },
        fields: {
          name,
          sku,
          productType: stringValue(fields.productType, 100) || 'Good',
          categoryId: fields.categoryId === undefined
            ? undefined
            : fields.categoryId ? uuidValue(fields.categoryId, 'Product category') : null,
          category: stringValue(fields.category, 100),
          status: stringValue(fields.status, 100) || 'Active',
          price: numberValue(fields.price),
          cost: numberValue(fields.cost),
          currency,
          url,
          description: stringValue(fields.description, 10_000),
          active: fields.active !== false,
        },
      })
      return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
    }


    let contact: Awaited<ReturnType<typeof readCrmRecordReference>> | null = null
    const interactionContactIds = entity === 'interactions'
      ? fields.contactIds === undefined
        ? current?.contactIds?.length
          ? current.contactIds
          : current?.contactId
            ? [current.contactId]
            : []
        : uuidList(fields.contactIds, 'Interaction contacts')
      : []
    const contactId = entity === 'interactions'
      ? interactionContactIds[0] || null
      : fields.contactId === undefined
        ? current?.contactId || null
        : stringValue(fields.contactId, 50) || null
    if (contactId) {
      contact = await readCrmRecordReference({ pipelineId: pipeline.id, entity: 'contacts', id: String(contactId) })
    }
    let lead: Awaited<ReturnType<typeof readCrmRecordReference>> | null = null
    const leadId = fields.leadId === undefined ? current?.leadId || null : stringValue(fields.leadId, 50) || null
    if (leadId) {
      lead = await readCrmRecordReference({ pipelineId: pipeline.id, entity: 'leads', id: String(leadId) })
    }

    let opportunity: Awaited<ReturnType<typeof readCrmRecordReference>> | null = null
    const opportunityId = fields.opportunityId === undefined
      ? current?.opportunityId || null
      : stringValue(fields.opportunityId, 50) || null
    if (opportunityId) {
      opportunity = await readCrmRecordReference({ pipelineId: pipeline.id, entity: 'opportunities', id: String(opportunityId) })
    }

    if (entity === 'meetings') {
      const subject = stringValue(fields.subject, 250)
      if (!subject) throw new Error('Meeting subject is required')
      const startsAt = stringValue(fields.startsAt, 50)
      const endsAt = stringValue(fields.endsAt, 50)
      if (!startsAt || !endsAt) throw new Error('Meeting start and end are required')
      const resolvedOrganizationId = organization?.id || contact?.organizationId || lead?.organizationId || null
      const resolvedOrganization = resolvedOrganizationId
        ? await readCrmRecordReference({ pipelineId: pipeline.id, entity: 'organizations', id: resolvedOrganizationId })
        : null
      const parentSuiteCrmId = opportunity?.suiteCrmId
        || contact?.suiteCrmId
        || lead?.suiteCrmId
        || resolvedOrganization?.suiteCrmId
        || null
      const parentSuiteCrmType = opportunity?.suiteCrmId
        ? 'Opportunities' as const
        : contact?.suiteCrmId
          ? 'Contacts' as const
          : lead?.suiteCrmId
            ? 'Leads' as const
            : resolvedOrganization?.suiteCrmId
              ? 'Accounts' as const
              : undefined
      const meetingTimezone = timezoneValue(fields.timezone)
      const meetingAttendees = emailList(fields.attendeeEmails)
      const meetingStatus = ['planned', 'queued', 'scheduled', 'completed', 'cancelled', 'failed'].includes(String(fields.status))
        ? fields.status as 'planned' | 'queued' | 'scheduled' | 'completed' | 'cancelled' | 'failed'
        : 'planned'
      const meetingMode = stringValue(fields.meetingMode, 32) || 'google_meet'
      if (!['google_meet', 'in_person', 'custom_link'].includes(meetingMode)) {
        throw new Error('Meeting mode must be Google Meet, in person, or custom link')
      }
      const meetingLocation = stringValue(fields.location, 500)
      const customJoinUrlInput = stringValue(fields.customJoinUrl, 2000)
      let customJoinUrl = ''
      if (customJoinUrlInput) {
        try {
          const parsed = new URL(customJoinUrlInput)
          if (parsed.protocol !== 'https:') throw new Error('not HTTPS')
          customJoinUrl = parsed.toString()
        } catch {
          throw new Error('Custom meeting URL must be a valid HTTPS URL')
        }
      }
      if (meetingMode === 'in_person' && !meetingLocation) {
        throw new Error('An in-person meeting requires a location')
      }
      if (meetingMode === 'custom_link' && !customJoinUrl) {
        throw new Error('A custom-link meeting requires a valid HTTPS meeting URL')
      }
      const calendarConnectionId = stringValue(fields.calendarConnectionId, 512)
      const selectedCalendarId = stringValue(fields.calendarId, 1024)
      const hasCalendarOverride = Boolean(calendarConnectionId || selectedCalendarId)
      if (Boolean(calendarConnectionId) !== Boolean(selectedCalendarId)) {
        throw new Error('Per-meeting Calendar selection requires both a connection and writable calendar')
      }
      let calendarCommunication: Awaited<ReturnType<typeof resolvePipelineCommunicationSnapshotInPostgres>> | null = null
      let calendarActionUnavailable: { code: string; message: string } | null = null
      try {
        calendarCommunication = hasCalendarOverride
          ? await resolveVerifiedPipelineCalendarSelection({
              pipelineId: pipeline.id,
              actorEmail: actor.email,
              connectionId: calendarConnectionId,
              calendarId: selectedCalendarId,
            })
          : await resolvePipelineCommunicationSnapshotInPostgres({
              pipelineId: pipeline.id,
              actorEmail: actor.email,
              app: 'google-calendar',
            })
      } catch (error) {
        if (
          error instanceof OrganizationCommunicationPersistenceError
          && error.code === 'ORGANIZATION_COMMUNICATION_CONNECTION_REQUIRED'
        ) {
          calendarActionUnavailable = {
            code: 'CRM_COMMUNICATION_CONNECTION_REQUIRED',
            message: 'Configure an active Google Calendar connection for this organization',
          }
        } else {
          throw error
        }
      }
      const calendarOwnerEmail = calendarCommunication?.credentialOwnerEmail || actor.email
      const meetingStageInput = {
        entity, pipelineId: pipeline.id, localId: current?.id, sourceKey, actorEmail: actor.email,
        sourcePayload: {
          ...(current?.sourcePayload || {}),
          source: 'clawpilot',
          calendarOwnerEmail,
          calendarConnectionId: calendarCommunication?.connectionId || null,
          calendarOrganizerEmail: calendarCommunication?.identityEmail || null,
          calendarId: calendarCommunication?.calendarId || null,
          calendarDeliveryStatus: calendarCommunication ? 'queued' : 'not-configured',
          calendarDeliveryError: null,
          calendarDeliveryFailure: null,
          meetingMode,
          customJoinUrl: customJoinUrl || null,
        },
        fields: {
          organizationId: resolvedOrganization?.id || null,
          organizationSuiteCrmId: resolvedOrganization?.suiteCrmId || null,
          contactId: contact?.id || null, leadId: lead?.id || null, opportunityId: opportunity?.id || null,
          parentSuiteCrmId, parentSuiteCrmType, subject,
          description: stringValue(fields.description, 10_000), startsAt, endsAt,
          timezone: meetingTimezone, location: meetingLocation,
          attendeeEmails: meetingAttendees,
          status: meetingStatus,
          provider: stringValue(fields.provider, 100), externalEventId: stringValue(fields.externalEventId, 500) || null,
          externalEventUrl: stringValue(fields.externalEventUrl, 2000) || null,
          joinUrl: customJoinUrl || stringValue(fields.joinUrl, 2000) || null,
        },
      } as const
      const calendarPayload = {
        subject,
        description: stringValue(fields.description, 10_000),
        startsAt,
        endsAt,
        timezone: meetingTimezone,
        location: meetingLocation,
        attendeeEmails: meetingAttendees,
        meetingStatus,
        meetingMode,
        customJoinUrl: customJoinUrl || null,
      }
      const previousCalendarSource = current?.sourcePayload || {}
      const previousCalendar = current?.externalEventId
        && typeof previousCalendarSource.calendarOwnerEmail === 'string'
        && typeof previousCalendarSource.calendarConnectionId === 'string'
        && typeof previousCalendarSource.calendarId === 'string'
        ? {
            eventId: current.externalEventId,
            credentialOwnerEmail: previousCalendarSource.calendarOwnerEmail,
            connectionId: previousCalendarSource.calendarConnectionId,
            calendarId: previousCalendarSource.calendarId,
            organizerEmail: typeof previousCalendarSource.calendarOrganizerEmail === 'string'
              ? previousCalendarSource.calendarOrganizerEmail
              : null,
          }
        : undefined
      let staged: Awaited<ReturnType<typeof stageCrmRecordInPostgres>>
      let calendarAction: Awaited<ReturnType<typeof stageCrmMeetingAndEnqueueCalendarAction>> | null = null
      if (calendarCommunication) {
        calendarAction = await stageCrmMeetingAndEnqueueCalendarAction({
          stageInput: meetingStageInput,
          payload: calendarPayload,
          idempotencyKey: meetingCalendarActionKey as string,
          clientRequestHash: meetingClientRequestHash as string,
          communication: calendarCommunication,
          previousCalendar,
        })
        staged = calendarAction.staged
      } else {
        staged = await stageCrmRecordInPostgres(meetingStageInput)
      }
      return NextResponse.json({
        ok: true,
        queued: Boolean(calendarAction && ['queued', 'processing', 'failed'].includes(calendarAction.action.status)),
        record: staged,
        calendarAction: calendarAction?.action || null,
        calendarActionUnavailable,
      }, { status: body?.id ? 200 : 201 })
    }

    if (entity === 'campaigns') {
      const name = stringValue(fields.name, 250)
      if (!name) throw new Error('Campaign name is required')
      const startDate = stringValue(fields.startDate, 20) || null
      const endDate = stringValue(fields.endDate, 20) || null
      if (startDate && endDate && endDate < startDate) throw new Error('Campaign end date must be on or after its start date')
      const staged = await stageCrmRecordInPostgres({
        entity, pipelineId: pipeline.id, localId: current?.id, sourceKey, actorEmail: actor.email,
        sourcePayload: { ...(current?.sourcePayload || {}), source: 'clawpilot' },
        fields: {
          name, campaignType: 'email',
          status: ['draft', 'queued', 'sending', 'sent', 'paused', 'failed'].includes(String(fields.status))
            ? fields.status as 'draft' | 'queued' | 'sending' | 'sent' | 'paused' | 'failed'
            : 'draft',
          startDate, endDate,
          subjectTemplate: stringValue(fields.subjectTemplate, 500), bodyTemplate: stringValue(fields.bodyTemplate, 50_000),
          senderEmail: validEmail(fields.senderEmail), description: stringValue(fields.description, 10_000),
        },
      })
      return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
    }

    let campaign: Awaited<ReturnType<typeof readCrmRecordReference>> | null = null
    const campaignId = fields.campaignId === undefined
      ? current?.campaignId || null
      : stringValue(fields.campaignId, 50) || null
    if (campaignId) {
      campaign = await readCrmRecordReference({ pipelineId: pipeline.id, entity: 'campaigns', id: campaignId })
    }

    const subject = stringValue(fields.subject, 250)
    if (!subject) throw new Error('Interaction subject is required')
    const parentSuiteCrmId = opportunity?.suiteCrmId
      || contact?.suiteCrmId
      || lead?.suiteCrmId
      || organization?.suiteCrmId
      || campaign?.suiteCrmId
      || null
    const parentSuiteCrmType = opportunity?.suiteCrmId
      ? 'Opportunities' as const
      : contact?.suiteCrmId
        ? 'Contacts' as const
        : lead?.suiteCrmId
          ? 'Leads' as const
          : organization?.suiteCrmId
            ? 'Accounts' as const
            : campaign?.suiteCrmId
              ? 'Campaigns' as const
              : undefined
    const interactionType = interactionTypeValue(fields.interactionType)
    const meetingId = fields.meetingId === undefined
      ? current?.meetingId || null
      : stringValue(fields.meetingId, 50) || null
    const suiteCrmModule: SuiteCrmInteractionModule | null = interactionType === 'call'
      ? 'Calls'
      : interactionType === 'meeting'
        ? meetingId ? null : 'Meetings'
        : interactionType === 'email'
          ? 'Emails'
          : 'Notes'
    const nativeActivity = suiteCrmModule === 'Calls' || suiteCrmModule === 'Meetings'
    const activityStatus = nativeActivity
      ? activityStatusValue(fields.activityStatus, 'held')
      : null
    const durationMinutes = nativeActivity
      ? activityDurationMinutes(fields.durationMinutes, suiteCrmModule === 'Calls' ? 15 : 30)
      : null
    const direction = suiteCrmModule === 'Calls'
      ? callDirectionValue(fields.direction)
      : ['inbound', 'outbound', 'internal'].includes(String(fields.direction))
        ? fields.direction as 'inbound' | 'outbound' | 'internal'
        : 'internal'
    const staged = await stageCrmRecordInPostgres({
      entity, pipelineId: pipeline.id, localId: current?.id, sourceKey, actorEmail: actor.email,
      sourcePayload: { ...(current?.sourcePayload || {}), source: 'clawpilot' },
      fields: {
        organizationId: organization?.id || contact?.organizationId || lead?.organizationId || current?.organizationId || null,
        contactId: contact?.id || null, contactIds: interactionContactIds,
        leadId: lead?.id || null, opportunityId: opportunity?.id || null,
        meetingId,
        campaignId: campaign?.id || null,
        parentSuiteCrmId, parentSuiteCrmType, interactionType, suiteCrmModule,
        activityStatus, durationMinutes,
        subject, agentEmail: validEmail(fields.agentEmail || current?.agentEmail),
        agentName: stringValue(fields.agentName || current?.agentName, 200),
        occurredAt: stringValue(fields.occurredAt, 50) || null,
        description: stringValue(fields.description, 10_000),
        direction,
        deliveryStatus: stringValue(fields.deliveryStatus, 100),
      },
    })
    return NextResponse.json({ ok: true, queued: true, record: staged }, { status: body?.id ? 200 : 201 })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  if (!isPostgresStorageEnabled()) return NextResponse.json({ ok: false, error: 'CRM requires Postgres storage' }, { status: 409 })
  try {
    const actor = await exactRequestActor(req)
    const pipeline = await selectedPipeline(req, actor)
    requireResourceEditor(pipeline)
    const body = await req.json()
    const action = stringValue(body?.action, 50)
    const id = uuidValue(body?.id, 'CRM record')

    if (action === 'archive') {
      const entity = entityValue(body?.entity)
      if (entity !== 'leads' && entity !== 'interactions' && entity !== 'campaigns') {
        throw new Error('Only leads, interactions, and campaigns can be archived from this workflow')
      }
      const result = await archiveCrmRecordInPostgres({
        pipelineId: pipeline.id,
        entity,
        id,
        actorEmail: actor.email,
      })
      return NextResponse.json({ ok: true, result })
    }

    if (action === 'convert-lead') {
      if (body?.entity !== undefined && entityValue(body.entity) !== 'leads') {
        throw new Error('Lead conversion requires a lead record')
      }
      const hierarchy = await ensurePipelineCrmHierarchy({ pipelineId: pipeline.id, actorEmail: actor.email })
      const fields = body?.fields === undefined ? {} : objectValue(body.fields)
      const result = await convertCrmLeadInPostgres({
        pipelineId: pipeline.id,
        leadId: id,
        actorEmail: actor.email,
        customerParentId: hierarchy.customerParent.id,
        customerParentSuiteCrmId: hierarchy.customerParent.suiteCrmId,
        accountName: stringValue(fields.accountName, 250),
        opportunityName: stringValue(fields.opportunityName, 250),
        opportunityValue: numberValue(fields.opportunityValue),
      })
      return NextResponse.json({ ok: true, result })
    }

    throw new Error('CRM lifecycle action is invalid')
  } catch (error) {
    return errorResponse(error)
  }
}
