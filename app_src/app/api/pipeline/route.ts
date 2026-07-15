import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Task } from '@/lib/types'
import { isCrmBoardCard } from '@/lib/crm/boardCard.mjs'
import { buildCanonicalWorkItem } from '@/lib/workItemModel'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
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
  writeAppPipelineProjection,
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

export async function GET(req: NextRequest) {
  let workItems: ReturnType<typeof pipelineWorkItemsFromTasks> = []
  try {
    let boardId: string | undefined
    let selectedPipeline: PipelineSpace | null = null
    if (isPostgresPipelineStoreEnabled()) {
      const actor = await requireRequestUser(req)
      const selectedBoardId = req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
      const selectedPipelineId = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
      const board = await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: selectedBoardId })
        .catch(() => resolveProjectBoardAccess({ actorEmail: actor.email }))
      selectedPipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selectedPipelineId })
        .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
      boardId = board.id
    }
    workItems = pipelineWorkItemsFromTasks(await readTasks(boardId))

    if (isPostgresPipelineStoreEnabled()) {
      try {
        const projection = selectedPipeline ? await readPipelineProjectionForSpace(selectedPipeline) : null
        if (projection) {
          return NextResponse.json({
            syncedAt: projection.syncedAt || null,
            summary: projection.summary || { opportunities: 0, organizations: 0, contacts: 0, totalOpenValue: 0 },
            opportunities: Array.isArray(projection.opportunities) ? projection.opportunities : [],
            workItems,
            storage: 'postgres',
            pipeline: selectedPipeline ? {
              id: selectedPipeline.id,
              name: selectedPipeline.name,
              ownerEmail: selectedPipeline.ownerEmail,
              accessRole: selectedPipeline.accessRole,
              sheetBacked: selectedPipeline.sheetBacked,
              syncEnabled: selectedPipeline.syncEnabled,
              shortLinkUrl: selectedPipeline.shortLinkUrl,
              provisioningStatus: selectedPipeline.provisioningStatus,
              provisioningError: selectedPipeline.provisioningError,
            } : null,
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
    if (pipeline.syncEnabled) {
      return NextResponse.json({ ok: false, error: 'Create sheet-backed opportunities in the connected operator sheet' }, { status: 409 })
    }

    const body = await req.json()
    const name = String(body?.name || '').trim()
    const organization = String(body?.organization || body?.org || '').trim()
    if (!name || !organization) {
      return NextResponse.json({ ok: false, error: 'Opportunity name and organization are required' }, { status: 400 })
    }
    const now = new Date().toISOString()
    const value = Number.isFinite(Number(body?.value)) ? Math.max(0, Number(body.value)) : 0
    const probability = Number.isFinite(Number(body?.probability))
      ? Math.max(0, Math.min(100, Number(body.probability)))
      : 0
    const opportunity = {
      id: `opp_${crypto.randomUUID()}`,
      name,
      organization,
      org: organization,
      priority: String(body?.priority || 'C'),
      owner: String(body?.owner || actor.displayName || actor.email),
      status: String(body?.status || 'Open'),
      stage: String(body?.stage || 'Identified Lead'),
      source: String(body?.source || ''),
      value,
      probability,
      closeDate: String(body?.closeDate || ''),
      notes: String(body?.notes || ''),
      createdAt: now,
      createdBy: actor.email,
      updatedAt: now,
    }
    const projection = await readPipelineProjectionForSpace(pipeline)
    const opportunities = [...(Array.isArray(projection.opportunities) ? projection.opportunities : []), opportunity]
    const closed = new Set(['abandoned', 'loss', 'closed', 'closed-lost', 'lost'])
    const summary = {
      ...projection.summary,
      opportunities: opportunities.length,
      organizations: new Set(opportunities.map((entry) => String(entry.organization || entry.org || '').trim()).filter(Boolean)).size,
      totalOpenValue: Math.round(opportunities
        .filter((entry) => !closed.has(String(entry.status || '').toLowerCase()))
        .reduce((total, entry) => total + (Number(entry.value) || 0), 0) * 100) / 100,
    }
    await writeAppPipelineProjection(pipeline, { ...projection, syncedAt: now, source: 'app', summary, opportunities })
    return NextResponse.json({ ok: true, opportunity }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create opportunity'
    const status = message === 'Unauthorized' ? 401 : /denied|view-only/i.test(message) ? 403 : 400
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
