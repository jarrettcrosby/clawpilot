import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { isCrmBoardCard } from '@/lib/crm/boardCard.mjs'
import type { CrmOpportunity } from '@/lib/crm/types'
import { buildCanonicalWorkItem } from '@/lib/workItemModel'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import {
  createCrmOpportunityInPostgres,
  listCrmRecordsInPostgres,
  readPipelineCatalogInPostgres,
  readCrmRecordReference,
  readCrmSummaryFromPostgres,
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

function crmOpportunityForPipeline(opportunity: CrmOpportunity) {
  return {
    ...opportunity,
    org: opportunity.organization,
    closeDate: opportunity.expectedClose,
    contacts: opportunity.contacts.map((contact) => ({
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

function opportunityProducts(value: unknown) {
  const products = Array.isArray(value) ? value : String(value || '').split(',')
  return [...new Set(products.map((product) => String(product || '').trim()).filter(Boolean))]
}

function uniqueActivePersonByName<T extends { active: boolean; displayName: string }>(people: T[], name: string) {
  const matches = people.filter((person) => (
    person.active && person.displayName.trim().toLowerCase() === name
  ))
  if (matches.length > 1) throw new Error('Opportunity owner name is ambiguous; select the person by ID')
  return matches[0]
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
          const [projection, opportunities, crmSummary] = await Promise.all([
            readPipelineProjectionForSpace(selectedPipeline),
            listCrmRecordsInPostgres({
              pipelineId: selectedPipeline.id,
              entity: 'opportunities',
              limit: 1000,
            }) as Promise<CrmOpportunity[]>,
            readCrmSummaryFromPostgres(selectedPipeline.id),
          ])
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
            opportunities: opportunities.map(crmOpportunityForPipeline),
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
    const pipeline = selected
      ? await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
      : await resolvePipelineSpaceAccess({ actorEmail: actor.email })
    requireResourceEditor(pipeline)

    const body = await req.json()
    const catalog = await readPipelineCatalogInPostgres({ pipelineId: pipeline.id, actorEmail: actor.email })
    const requestedProductIds = Array.isArray(body?.productIds)
      ? [...new Set(body.productIds.map((id: unknown) => String(id || '').trim()).filter(Boolean))]
      : []
    const requestedProductNames = opportunityProducts(body?.products ?? body?.name)
    const selectedProducts = requestedProductIds.length > 0
      ? requestedProductIds.map((id) => catalog.products.find((product) => product.id === id && product.active))
      : requestedProductNames.map((name) => {
          const matches = catalog.products.filter((product) => product.active && product.name.trim().toLowerCase() === name.toLowerCase())
          return matches.length === 1 ? matches[0] : undefined
        })
    if (selectedProducts.some((product) => !product)) {
      throw new Error('Opportunity products must be active products in Pipeline setup')
    }
    const products = selectedProducts.filter((product): product is NonNullable<typeof product> => Boolean(product))
    const name = products.map((product) => product.name).join(', ')
    const organizationId = String(body?.organizationId || '').trim()
    if (!name || !organizationId) {
      return NextResponse.json({ ok: false, error: 'At least one product and a CRM organization are required' }, { status: 400 })
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
    const requestedOwnerContactId = String(body?.ownerContactId || '').trim()
    const requestedOwnerName = String(body?.owner || '').trim().toLowerCase()
    const ownerPerson = requestedOwnerContactId
      ? catalog.people.find((person) => person.id === requestedOwnerContactId && person.active)
      : requestedOwnerName
        ? uniqueActivePersonByName(catalog.people, requestedOwnerName)
        : catalog.people.find((person) => person.active && person.email.toLowerCase() === actor.email.toLowerCase())
    if ((requestedOwnerContactId || requestedOwnerName) && !ownerPerson) {
      throw new Error('Opportunity owner must be an active person in Pipeline setup')
    }
    const owner = ownerPerson?.displayName || actor.displayName || actor.email
    const status = String(body?.status || 'Open')
    const stage = String(body?.stage || 'Identified Lead')
    const source = String(body?.source || '')
    const expectedClose = String(body?.closeDate || body?.expectedClose || '')
    const notes = String(body?.notes || '')
    const contactIds = Array.isArray(body?.contactIds) ? body.contactIds.map(String) : []
    if (organizationRecord.relationshipType !== 'customer') {
      throw new Error('Opportunities must be linked to a customer organization')
    }
    const staged = await createCrmOpportunityInPostgres({
      entity: 'opportunities',
      pipelineId: pipeline.id,
      sourceKey,
      sourcePayload: { source: 'clawpilot-pipeline' },
      actorEmail: actor.email,
      fields: {
        organizationId: organizationRecord.id,
        organizationSuiteCrmId: organizationRecord.suiteCrmId,
        contactIds,
        productIds: products.map((product) => product.id),
        ownerContactId: ownerPerson?.id || null,
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
    return NextResponse.json({
      ok: true,
      queued: staged.created,
      replayed: !staged.created,
      opportunity: crmOpportunityForPipeline(staged.opportunity),
      crm: {
        id: staged.opportunity.id,
        referenceCode: staged.opportunity.referenceCode,
        syncStatus: staged.opportunity.syncStatus,
      },
    }, { status: staged.created ? 201 : 200 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create opportunity'
    const status = message === 'Unauthorized' ? 401 : /denied|view-only/i.test(message) ? 403 : 400
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
