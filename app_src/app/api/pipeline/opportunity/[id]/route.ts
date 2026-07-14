import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { resolveManagedGoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspace'
import { googleSheetsJson, type GoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspaceClient'
import { matonFetch } from '@/lib/maton'
import { logPipelineEvent } from '@/lib/pipelineLog'
import { getErrorMessage } from '@/lib/errorUtils'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import {
  DEFAULT_PIPELINE_SHEET_ID,
  type PipelineProjection,
  type PipelineSheetContext,
  enqueuePipelineSyncOutboxInPostgres,
  isPostgresPipelineStoreEnabled,
  resolvePipelineSheetBindingInPostgres,
  upsertPipelineProjectionAndEnqueueInPostgres,
  upsertPipelineProjectionInPostgres,
} from '@/lib/persistence/pipeline'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  isLegacyOwnerSheetPipeline,
  readPipelineProjectionForSpace,
  requirePipelineSheetContext,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
  writeAppPipelineProjection,
  type PipelineSpace,
} from '@/lib/tenancy'

const PIPELINE_FILE = process.env.PIPELINE_NORMALIZED_PATH || path.join(process.cwd(), '..', 'data', 'pipeline', 'normalized', 'current.json')

async function managedRuntimeForPipelineSheet(
  sheetContext: PipelineSheetContext,
): Promise<GoogleWorkspaceRuntime | null> {
  const binding = await resolvePipelineSheetBindingInPostgres(sheetContext)
  if (binding.legacyOwnerFallback) return null
  if (!binding.googleServiceAccountEmail || !binding.googleSharedDriveId) {
    throw new Error('Managed pipeline is missing its native Google Workspace binding')
  }
  return resolveManagedGoogleWorkspaceRuntime({
    serviceAccountEmail: binding.googleServiceAccountEmail,
    sharedDriveId: binding.googleSharedDriveId,
  })
}

async function getSheetValues(sheetId: string, range: string, sheetContext?: PipelineSheetContext) {
  const managedRuntime = sheetContext ? await managedRuntimeForPipelineSheet(sheetContext) : null
  const pathname = `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`
  if (managedRuntime) return googleSheetsJson<Record<string, unknown>>(managedRuntime, pathname)
  const res = await matonFetch(`/google-sheets${pathname}`)
  if (!res.ok) throw new Error(await res.text())
  return await res.json()
}

type OpportunityRecord = Record<string, unknown>

type PipelineDataSource = 'postgres-sheet' | 'postgres-app' | 'file'

function sheetContextForPipeline(pipeline: PipelineSpace | null): PipelineSheetContext | null {
  return pipeline ? requirePipelineSheetContext(pipeline) : null
}

async function resolvePipelineContext(req: NextRequest): Promise<{ actorEmail: string; pipeline: PipelineSpace | null }> {
  if (!isPostgresPipelineStoreEnabled()) {
    return { actorEmail: String(req.headers.get('x-clawpilot-actor') || 'Jarrett'), pipeline: null }
  }
  const actor = await requireRequestUser(req)
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
  const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
    .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
  requireResourceEditor(pipeline)
  return { actorEmail: actor.email, pipeline }
}

async function readPipelineData(pipeline: PipelineSpace | null): Promise<{ data: Record<string, unknown>; source: PipelineDataSource }> {
  if (isPostgresPipelineStoreEnabled()) {
    if (!pipeline) throw new Error('Pipeline context is required')
    try {
      const projection = await readPipelineProjectionForSpace(pipeline)
      if (projection) {
        return {
          data: projection as unknown as Record<string, unknown>,
          source: pipeline.syncEnabled ? 'postgres-sheet' : 'postgres-app',
        }
      }
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError() || !isLegacyOwnerSheetPipeline(pipeline)) throw error
      console.warn('[pipeline-opportunity] Postgres projection read failed; falling back to file store', error)
    }
  }

  if (!fs.existsSync(PIPELINE_FILE)) {
    throw new Error('Pipeline data not synced yet')
  }

  return {
    data: JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf-8')),
    source: 'file',
  }
}

async function persistPipelineData(data: Record<string, unknown>, source: PipelineDataSource, pipeline: PipelineSpace | null) {
  if (source !== 'file' || isPostgresPipelineStoreEnabled()) {
    if (!pipeline) throw new Error('Pipeline context is required')
    try {
      if (pipeline.syncEnabled) {
        await upsertPipelineProjectionInPostgres({ ...requirePipelineSheetContext(pipeline), projection: data })
      } else {
        await writeAppPipelineProjection(pipeline, data as unknown as PipelineProjection)
      }
      return
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError() || !isLegacyOwnerSheetPipeline(pipeline)) throw error
      console.warn('[pipeline-opportunity] Postgres projection write failed; falling back to file store', error)
    }
  }

  fs.writeFileSync(PIPELINE_FILE, JSON.stringify(data, null, 2))
}

function idempotencyKey(req: NextRequest) {
  const provided = String(req.headers.get('idempotency-key') || '').trim()
  return (provided || crypto.randomUUID()).slice(0, 200)
}

function pipelineErrorStatus(message: string) {
  if (message === 'Unauthorized') return 401
  if (/denied|view-only/i.test(message)) return 403
  return 500
}

function projectedRowNumber(opportunity: OpportunityRecord, fallbackRow: number) {
  const explicit = Number(opportunity.sheetRowNumber || opportunity.rowNumber || opportunity._rowNumber)
  return Number.isFinite(explicit) && explicit >= 5 ? Math.trunc(explicit) : fallbackRow
}

function refreshPipelineSummary(data: Record<string, unknown>, rows: OpportunityRecord[]) {
  const existing = data.summary && typeof data.summary === 'object'
    ? data.summary as Record<string, unknown>
    : {}
  const closed = new Set(['abandoned', 'loss', 'closed', 'closed-lost'])
  data.summary = {
    ...existing,
    opportunities: rows.length,
    totalOpenValue: Math.round(rows
      .filter((opportunity) => !closed.has(String(opportunity.status || '').toLowerCase()))
      .reduce((total, opportunity) => total + toFiniteNumber(opportunity.value, 0), 0) * 100) / 100,
  }
}

async function resolveOpportunityRow(
  current: OpportunityRecord,
  fallbackRow: number,
  sheetId: string = DEFAULT_PIPELINE_SHEET_ID,
  sheetContext?: PipelineSheetContext,
): Promise<number> {
  try {
    const out = await getSheetValues(sheetId, 'Opportunities!B5:M2000', sheetContext)
    const rows = Array.isArray(out?.values) ? out.values : []
    const targetName = String(current?.name || '').trim().toLowerCase()
    const targetOrg = String(current?.organization || current?.org || '').trim().toLowerCase()
    const targetOwner = String(current?.owner || '').trim().toLowerCase()

    let best = -1
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || []
      const name = String(r[1] || '').trim().toLowerCase()
      const owner = String(r[2] || '').trim().toLowerCase()
      const org = String(r[3] || '').trim().toLowerCase()
      if (!name) continue
      const nameMatch = targetName && name === targetName
      const orgMatch = targetOrg && org === targetOrg
      const ownerMatch = targetOwner && owner === targetOwner
      if (nameMatch && orgMatch && ownerMatch) { best = i; break }
      if (best < 0 && nameMatch && orgMatch) best = i
      if (best < 0 && nameMatch && ownerMatch) best = i
      if (best < 0 && nameMatch) best = i
    }

    if (best >= 0) return 5 + best
    return fallbackRow
  } catch {
    return fallbackRow
  }
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function money(v: number | string | undefined) {
  const n = toFiniteNumber(v, 0)
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pct(v: number | string | undefined) {
  const n = toFiniteNumber(v, 0)
  const clamped = Math.max(0, Math.min(100, n))
  return `${clamped.toFixed(1)}%`
}

async function writeSheet(
  sheetId: string,
  range: string,
  values: unknown[][],
  retries = 3,
  mode: 'update' | 'append' = 'update',
  sheetContext?: PipelineSheetContext,
) {
  const managedRuntime = sheetContext ? await managedRuntimeForPipelineSheet(sheetContext) : null
  let lastErr = ''
  for (let attempt = 1; attempt <= retries; attempt++) {
    const endpoint = mode === 'append'
      ? `/google-sheets/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
      : `/google-sheets/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`

    if (managedRuntime) {
      await googleSheetsJson<Record<string, unknown>>(
        managedRuntime,
        endpoint.slice('/google-sheets'.length),
        {
          method: mode === 'append' ? 'POST' : 'PUT',
          body: { range, majorDimension: 'ROWS', values },
          idempotent: mode !== 'append',
        },
      )
      return
    }

    const res = await matonFetch(endpoint, {
      method: mode === 'append' ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
    })

    if (res.ok) return
    lastErr = await res.text()
    if (attempt < retries) await new Promise(r => setTimeout(r, 250 * attempt))
  }

  throw new Error(lastErr || 'Sheet write failed after retries')
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolvePipelineContext(req)
    const { id } = await ctx.params
    const body = await req.json()
    const action = String(body.action || '')

    if (action !== 'interaction') {
      return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
    }

    let data: Record<string, unknown>
    try {
      data = (await readPipelineData(context.pipeline)).data
    } catch (error) {
      if (getErrorMessage(error) === 'Pipeline data not synced yet') {
        return NextResponse.json({ error: 'Pipeline data not synced yet' }, { status: 400 })
      }
      throw error
    }
    const rows = Array.isArray(data.opportunities) ? data.opportunities : []
    const opp = rows.find((r: OpportunityRecord) => r.id === id)
    if (!opp) return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })

    const range = 'Interactions!B:I'
    const interaction = {
      interaction: String(body.interaction || 'Note'),
      actor: context.actorEmail,
      agent: String(body.agent || 'ClawPilot'),
      date: String(body.date || new Date().toISOString()),
      contact: String(body.contact || ''),
      notes: String(body.notes || ''),
    }
    const values = [[
      opp.priority || 'C',
      interaction.interaction,
      opp.owner || 'Jarrett Crosby',
      interaction.agent,
      new Date(interaction.date).toLocaleDateString('en-US'),
      opp.name || '',
      interaction.contact,
      interaction.notes,
    ]]

    if (context.pipeline && !context.pipeline.syncEnabled) {
      opp.interactions = [...(Array.isArray(opp.interactions) ? opp.interactions : []), interaction]
      await persistPipelineData(data, 'postgres-app', context.pipeline)
      logPipelineEvent({ module: 'pipeline-interaction', action: 'append', recordId: id, result: 'ok', actor: context.actorEmail, pipelineId: context.pipeline.id })
      return NextResponse.json({ ok: true, syncStatus: 'succeeded' })
    }

    if (isPostgresPipelineStoreEnabled()) {
      const sheetContext = sheetContextForPipeline(context.pipeline)
      if (!sheetContext) throw new Error('Pipeline Sheet context is required')
      const outbox = await enqueuePipelineSyncOutboxInPostgres({
        ...sheetContext,
        aggregateType: 'pipeline_interaction',
        aggregateId: id,
        operation: 'append_interaction',
        payload: { range, values, opportunity: opp },
        actor: context.actorEmail,
        idempotencyKey: idempotencyKey(req),
      })
      logPipelineEvent({ module: 'pipeline-interaction', action: 'queue', recordId: id, result: 'ok', actor: context.actorEmail, pipelineId: context.pipeline?.id })
      const syncStatus = outbox.status === 'succeeded' ? 'succeeded' : 'queued'
      return NextResponse.json(
        { ok: true, syncStatus, outboxId: outbox.id },
        { status: syncStatus === 'queued' ? 202 : 200 },
      )
    }

    await writeSheet(DEFAULT_PIPELINE_SHEET_ID, range, values, 3, 'append')
    logPipelineEvent({ module: 'pipeline-interaction', action: 'append', recordId: id, result: 'ok' })
    return NextResponse.json({ ok: true, syncStatus: 'succeeded' })
  } catch (e: unknown) {
    const detail = getErrorMessage(e)
    logPipelineEvent({ module: 'pipeline-interaction', action: 'append', result: 'error', detail })
    return NextResponse.json({ error: detail }, { status: pipelineErrorStatus(detail) })
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolvePipelineContext(req)
    let loaded: { data: Record<string, unknown>; source: PipelineDataSource }
    try {
      loaded = await readPipelineData(context.pipeline)
    } catch (error) {
      if (getErrorMessage(error) !== 'Pipeline data not synced yet') throw error
      logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', result: 'error', detail: 'pipeline not synced' })
      return NextResponse.json({ error: 'Pipeline data not synced yet' }, { status: 400 })
    }

    const { id } = await ctx.params
    const updates = await req.json()

    const data = loaded.data
    const rows = Array.isArray(data.opportunities) ? data.opportunities : []
    const idx = rows.findIndex((r: OpportunityRecord) => r.id === id)
    if (idx === -1) return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })

    const current = rows[idx]

    // Conflict check
    if (updates.expectedUpdatedAt && current.updatedAt && updates.expectedUpdatedAt !== current.updatedAt) {
      logPipelineEvent({
        module: 'pipeline-opportunity',
        action: 'patch',
        recordId: id,
        result: 'conflict',
        detail: { expected: updates.expectedUpdatedAt, current: current.updatedAt },
      })
      return NextResponse.json({
        error: 'Conflict: record changed since load',
        conflict: true,
        current,
      }, { status: 409 })
    }

    let nextNotes = updates.notes !== undefined ? String(updates.notes || '') : String(current.notes || '')
    if (updates.appendComment) {
      const actor = context.actorEmail
      const msg = String(updates.appendComment || '').trim()
      if (msg) {
        const t = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false })
        const line = `[${t} ET] [${actor}] ${msg}`
        nextNotes = nextNotes ? `${nextNotes}\n${line}` : line
      }
    }

    const {
      expectedUpdatedAt: _expectedUpdatedAt,
      appendComment: _appendComment,
      actor: _actor,
      ...persistedUpdates
    } = updates
    void _expectedUpdatedAt
    void _appendComment
    void _actor

    const merged = {
      ...current,
      ...persistedUpdates,
      notes: nextNotes,
      value: updates.value !== undefined
        ? toFiniteNumber(updates.value, toFiniteNumber(current.value, 0))
        : toFiniteNumber(current.value, 0),
      probability: updates.probability !== undefined
        ? Math.max(0, Math.min(100, toFiniteNumber(updates.probability, toFiniteNumber(current.probability, 0))))
        : Math.max(0, Math.min(100, toFiniteNumber(current.probability, 0))),
      // Keep org aliases in sync so UI never drops to Unknown Organization due to key mismatch.
      org: (updates.organization ?? updates.org ?? current.org ?? current.organization ?? ''),
      organization: (updates.organization ?? updates.org ?? current.organization ?? current.org ?? ''),
      updatedAt: new Date().toISOString(),
    }

    const actor = context.actorEmail
    const baseActivity = {
      module: 'pipeline',
      recordId: id,
      result: 'ok' as const,
      actor,
      changedBy: actor,
      opportunityName: String(merged.name || current.name || ''),
      organization: String(merged.organization || merged.org || current.organization || current.org || ''),
      pipelineId: context.pipeline?.id,
    }

    const fallbackRow = 4 + Number(String(id).replace('opp_', ''))
    const rowNum = context.pipeline
      ? projectedRowNumber(current, fallbackRow)
      : await resolveOpportunityRow(current, fallbackRow, DEFAULT_PIPELINE_SHEET_ID)
    const range = `Opportunities!B${rowNum}:M${rowNum}`

    const beforeValues = [[
      current.priority || '',
      current.name || '',
      current.owner || '',
      current.organization || current.org || '',
      current.status || '',
      current.stage || '',
      current.lossReason || '',
      current.source || '',
      current.valueRaw !== undefined ? current.valueRaw : money(current.value),
      current.probabilityRaw !== undefined ? current.probabilityRaw : pct(current.probability),
      current.closeDate || current.expectedClose || '',
      current.notes || '',
    ]]

    const values = [[
      merged.priority || '',
      merged.name || '',
      merged.owner || '',
      merged.organization || merged.org || '',
      merged.status || '',
      merged.stage || '',
      merged.lossReason || '',
      merged.source || '',
      money(merged.value),
      pct(merged.probability),
      merged.closeDate || merged.expectedClose || '',
      merged.notes || '',
    ]]

    rows[idx] = merged
    data.opportunities = rows
    refreshPipelineSummary(data, rows)
    let outboxId: string | null = null
    let syncStatus: 'queued' | 'succeeded' = 'succeeded'

    if (isPostgresPipelineStoreEnabled() && context.pipeline?.syncEnabled) {
      const sheetContext = requirePipelineSheetContext(context.pipeline)
      try {
        const queued = await upsertPipelineProjectionAndEnqueueInPostgres({
          ...sheetContext,
          projection: data,
          outbox: {
            aggregateType: 'pipeline_opportunity',
            aggregateId: id,
            operation: 'update_opportunity',
            payload: { range, values, beforeValues, before: current, after: merged },
            actor,
            idempotencyKey: idempotencyKey(req),
          },
        })
        outboxId = queued.outboxId
        syncStatus = queued.outboxStatus === 'succeeded' ? 'succeeded' : 'queued'
      } catch (error) {
        if (!shouldFallbackToFileOnDatabaseError() || !isLegacyOwnerSheetPipeline(context.pipeline)) throw error
        console.warn('[pipeline-opportunity] Postgres projection/outbox write failed; using synchronous fallback', error)
        await writeSheet(sheetContext.sheetId, range, values, 3, 'update', sheetContext)
        await persistPipelineData(data, loaded.source, context.pipeline)
      }
    } else if (isPostgresPipelineStoreEnabled() && context.pipeline) {
      await persistPipelineData(data, loaded.source, context.pipeline)
    } else {
      try {
        await writeSheet(DEFAULT_PIPELINE_SHEET_ID, range, values, 3)
        await persistPipelineData(data, loaded.source, context.pipeline)
      } catch (e: unknown) {
        logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', recordId: id, result: 'error', detail: String(e) })
        return NextResponse.json({ error: 'Sheet write failed', detail: String(e).slice(0, 4000) }, { status: 500 })
      }
    }

    logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', recordId: id, result: 'ok' })

    if (updates.stage !== undefined && String(updates.stage) !== String(current.stage || '')) {
      logPipelineEvent({
        ...baseActivity,
        action: 'stage-change',
        activityType: 'moved',
        fromStage: String(current.stage || ''),
        toStage: String(updates.stage || ''),
        message: `Stage changed from ${String(current.stage || '—')} to ${String(updates.stage || '—')}`,
      })
    }

    const changedKeys = ['priority', 'status', 'owner', 'source', 'lossReason', 'value', 'probability', 'closeDate', 'expectedClose']
      .filter((k) => updates[k] !== undefined && String(updates[k]) !== String(current[k] ?? ''))

    logPipelineEvent({
      ...baseActivity,
      action: 'update',
      activityType: 'updated',
      message: changedKeys.length > 0 ? `Opportunity updated (${changedKeys.join(', ')})` : 'Opportunity saved',
      detail: { changedKeys },
    })

    if (updates.appendComment) {
      const msg = String(updates.appendComment || '').trim()
      if (msg) {
        logPipelineEvent({
          ...baseActivity,
          action: 'comment',
          activityType: 'comment',
          message: `Note added: "${msg.slice(0, 80)}${msg.length > 80 ? '...' : ''}"`,
        })
      }
    }

    return NextResponse.json(
      { ok: true, opportunity: merged, syncStatus, outboxId },
      { status: syncStatus === 'queued' ? 202 : 200 },
    )
  } catch (error: unknown) {
    const detail = getErrorMessage(error)
    logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', result: 'error', detail })
    return NextResponse.json({ error: detail }, { status: pipelineErrorStatus(detail) })
  }
}
