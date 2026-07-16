import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { isCrmBoardCard } from '@/lib/crm/boardCard.mjs'
import type { CrmContact, CrmOpportunity } from '@/lib/crm/types'
import { buildCanonicalWorkItem } from '@/lib/workItemModel'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import {
  listCrmRecordsInPostgres,
  readCrmOpportunityInPostgres,
  readCrmRecordReference,
  readCrmSummaryFromPostgres,
  stageCrmRecordInPostgres,
} from '@/lib/persistence/crm'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres } from '@/lib/persistence/tasks'
import { isPostgresPipelineStoreEnabled } from '@/lib/persistence/pipeline'
import { requireRequestUser } from '@/lib/requestUser'
import {
  BOARD_SELECTION_COOKIE,
  PIPELINE_SELECTION_COOKIE,
  isLegacyOwnerSheetPipeline,
  readPipelineProjectionForSpace,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
  resolveProjectBoardAccess,
  type PipelineSpace,
} from '@/lib/tenancy'

const PIPELINE_FILE = process.env.PIPELINE_NORMALIZED_PATH || path.join(process.cwd(), '..', 'data', 'pipeline', 'normalized', 'current.json')
const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)

async function readTasks(boardId?: string): Promise<Task[]> {
  if (isPostgresTaskStoreEnabled()) {
    if (!boardId) throw new Error('Project board context is required')
    try {
      return await readTasksFromPostgres({ boardId })
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[pipeline] Postgres task read failed; falling back to file store', error)
    }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function pipelineWorkItemsFromTasks(tasks: Task[]) {
  return tasks
    .filter((task) => !isCrmBoardCard(task))
    .filter((task) => {
      const tags = Array.isArray(task.tags) ? task.tags.map((t) => String(t).toLowerCase()) : []
      return String(task.category || '').toLowerCase() === 'pipeline' || tags.includes('pipeline')
    })
    .map((task) => ({
      taskId: String(task.id),
      title: String(task.title || ''),
      ...buildCanonicalWorkItem(task),
      updatedAt: task.updatedAt,
    }))
}

function crmOpportunityForPipeline(
  opportunity: CrmOpportunity,
  contactsByOrganization: Map<string, CrmContact[]>,
) {
  const contacts = opportunity.organizationId
    ? contactsByOrganization.get(opportunity.organizationId) || []
    : []
  return {
    ...opportunity,
    org: opportunity.organization,
    closeDate: opportunity.expectedClose,
    contacts: contacts.map((contact) => ({
      id: contact.id,
      name: contact.fullName,
      phone: contact.phoneMobile || contact.phoneWork,
      email: contact.email,
      title: contact.jobTitle,
    })),
  }
}

function opportunityIdempotencyKey(req: NextRequest, pipelineId: string, actorEmail: string) {
  const provided = String(req.headers.get('idempotency-key') || '').trim()
  if (!provided) throw new Error('Idempotency-Key is required for opportunity creation')
  if (provided.length > 200) throw new Error('Idempotency-Key must be 200 characters or fewer')
  const digest = crypto
    .createHash('sha256')
    .update(`${pipelineId}\n${actorEmail.toLowerCase()}\n${provided}`)
    .digest('hex')
    .slice(0, 40)
  return `app:opportunities:${digest}`
}

export async function GET(req: NextRequest) {
  let workItems: ReturnType<typeof pipelineWorkItemsFromTasks> = []
  try {
    let boardId: string | undefined
    let selectedPipeline: PipelineSpace | null = null
    if (isPostgresPipelineStoreEnabled()) {
      const actor = await requireRequestUser(req)
      const explicitBoardId = req.nextUrl.searchParams.get('boardId') || undefined
      const explicitPipelineId = req.nextUrl.searchParams.get('pipelineId') || undefined
      const selectedBoardId = explicitBoardId || req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
      const selectedPipelineId = explicitPipelineId || req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
      const board = explicitBoardId
        ? await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: explicitBoardId })
        : await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: selectedBoardId })
          .catch(() => resolveProjectBoardAccess({ actorEmail: actor.email }))
      selectedPipeline = explicitPipelineId
        ? await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: explicitPipelineId })
        : await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selectedPipelineId })
          .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
      boardId = board.id
    }
    workItems = pipelineWorkItemsFromTasks(await readTasks(boardId))

    if (isPostgresPipelineStoreEnabled()) {
      try {
        if (selectedPipeline) {
          const [projection, opportunities, contacts, crmSummary] = await Promise.all([
            readPipelineProjectionForSpace(selectedPipeline),
            listCrmRecordsInPostgres({
              pipelineId: selectedPipeline.id,
              entity: 'opportunities',
              limit: 1000,
            }) as Promise<CrmOpportunity[]>,
            listCrmRecordsInPostgres({
              pipelineId: selectedPipeline.id,
              entity: 'contacts',
              limit: 1000,
            }) as Promise<CrmContact[]>,
            readCrmSummaryFromPostgres(selectedPipeline.id),
          ])
          const contactsByOrganization = new Map<string, CrmContact[]>()
          for (const contact of contacts) {
            if (!contact.organizationId) continue
            const current = contactsByOrganization.get(contact.organizationId) || []
            current.push(contact)
            contactsByOrganization.set(contact.organizationId, current)
          }
          return NextResponse.json({
            syncedAt: projection.syncedAt || null,
            summary: {
              opportunities: crmSummary.opportunities,
              organizations: crmSummary.organizations,
              contacts: crmSummary.contacts,
              totalOpenValue: crmSummary.openPipelineValue,
              weightedPipelineValue: crmSummary.weightedPipelineValue,
              pendingSync: crmSummary.pendingSync,
              failedSync: crmSummary.failedSync,
            },
            opportunities: opportunities.map((opportunity) => crmOpportunityForPipeline(opportunity, contactsByOrganization)),
            workItems,
            storage: 'postgres',
            pipeline: {
              id: selectedPipeline.id,
              name: selectedPipeline.name,
              ownerEmail: selectedPipeline.ownerEmail,
              accessRole: selectedPipeline.accessRole,
              sheetBacked: selectedPipeline.sheetBacked,
              syncEnabled: selectedPipeline.syncEnabled,
              shortLinkUrl: selectedPipeline.shortLinkUrl,
              provisioningStatus: selectedPipeline.provisioningStatus,
              provisioningError: selectedPipeline.provisioningError,
            },
          })
        }
      } catch (error) {
        if (!shouldFallbackToFileOnDatabaseError() || !isLegacyOwnerSheetPipeline(selectedPipeline)) throw error
        console.warn('[pipeline] Postgres projection read failed; falling back to file store', error)
      }
    }

    if (!fs.existsSync(PIPELINE_FILE)) {
      return NextResponse.json({
        syncedAt: null,
        summary: { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
        opportunities: [],
        workItems,
        error: 'Pipeline data not synced yet',
      })
    }

    const raw = fs.readFileSync(PIPELINE_FILE, 'utf-8')
    const data = JSON.parse(raw)

    return NextResponse.json({
      syncedAt: data.syncedAt || null,
      summary: data.summary || { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
      opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
      workItems,
      storage: 'file',
    })
  } catch (e: unknown) {
    return NextResponse.json({
      syncedAt: null,
      summary: { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
      opportunities: [],
      workItems,
      error: String(e),
    }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!isPostgresPipelineStoreEnabled()) {
    return NextResponse.json({ ok: false, error: 'Opportunity creation requires Postgres storage' }, { status: 409 })
  }

  try {
    const actor = await requireRequestUser(req)
    const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
    const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
      .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
    requireResourceEditor(pipeline)

    const body = await req.json()
    const name = String(body?.name || '').trim()
    const organizationId = String(body?.organizationId || '').trim()
    if (!name || !organizationId) {
      return NextResponse.json({ ok: false, error: 'Opportunity name and a CRM organization are required' }, { status: 400 })
    }
    const organizationRecord = await readCrmRecordReference({
      pipelineId: pipeline.id,
      entity: 'organizations',
      id: organizationId,
    })
    const organization = String(organizationRecord.name || '').trim()
    if (!organization) throw new Error('The selected CRM organization has no name')

    const value = Number.isFinite(Number(body?.value)) ? Math.max(0, Number(body.value)) : 0
    const probability = Number.isFinite(Number(body?.probability))
      ? Math.max(0, Math.min(100, Number(body.probability)))
      : 0
    const sourceKey = opportunityIdempotencyKey(req, pipeline.id, actor.email)
    const priority = String(body?.priority || 'C')
    const owner = String(body?.owner || actor.displayName || actor.email)
    const status = String(body?.status || 'Open')
    const stage = String(body?.stage || 'Identified Lead')
    const source = String(body?.source || '')
    const expectedClose = String(body?.closeDate || body?.expectedClose || '')
    const notes = String(body?.notes || '')
    if (organizationRecord.relationshipType !== 'customer') {
      throw new Error('Opportunities must be linked to a customer organization')
    }
    const staged = await stageCrmRecordInPostgres({
      entity: 'opportunities',
      pipelineId: pipeline.id,
      sourceKey,
      sourcePayload: { source: 'clawpilot-pipeline' },
      actorEmail: actor.email,
      fields: {
        organizationId: organizationRecord.id,
        organizationSuiteCrmId: organizationRecord.suiteCrmId,
        name,
        organization,
        priority,
        owner,
        status,
        stage,
        source,
        value,
        probability,
        expectedClose: expectedClose || null,
        notes,
      },
    })
    const opportunity = await readCrmOpportunityInPostgres({ pipelineId: pipeline.id, id: staged.id })
    return NextResponse.json({
      ok: true,
      queued: true,
      opportunity: crmOpportunityForPipeline(opportunity, new Map()),
      crm: { id: staged.id, referenceCode: staged.referenceCode, syncStatus: 'pending' },
    }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create opportunity'
    const status = message === 'Unauthorized' ? 401 : /denied|view-only/i.test(message) ? 403 : 400
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
