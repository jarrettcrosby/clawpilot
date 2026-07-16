import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import type { CrmOpportunity } from '@/lib/crm/types'
import { getErrorMessage } from '@/lib/errorUtils'
import { logPipelineEvent } from '@/lib/pipelineLog'
import {
  readCrmOpportunityInPostgres,
  readCrmRecordReference,
  stageCrmRecordInPostgres,
} from '@/lib/persistence/crm'
import { isPostgresPipelineStoreEnabled } from '@/lib/persistence/pipeline'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
  type PipelineSpace,
} from '@/lib/tenancy'
import type { AppUser } from '@/lib/users'

type PipelineContext = {
  actor: AppUser
  pipeline: PipelineSpace
}

function pipelineErrorStatus(message: string) {
  if (message === 'Unauthorized') return 401
  if (/denied|view-only/i.test(message)) return 403
  if (/not found/i.test(message)) return 404
  return 400
}

async function resolvePipelineContext(req: NextRequest): Promise<PipelineContext> {
  if (!isPostgresPipelineStoreEnabled()) throw new Error('Pipeline changes require Postgres storage')
  const actor = await requireRequestUser(req)
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
  const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
    .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
  requireResourceEditor(pipeline)
  return { actor, pipeline }
}

function stableInteractionSourceKey(req: NextRequest, context: PipelineContext, opportunityId: string) {
  const provided = String(req.headers.get('idempotency-key') || '').trim()
  if (!provided) throw new Error('Idempotency-Key is required for interaction creation')
  if (provided.length > 200) throw new Error('Idempotency-Key must be 200 characters or fewer')
  const digest = crypto
    .createHash('sha256')
    .update(`${context.pipeline.id}\n${context.actor.email}\n${opportunityId}\n${provided}`)
    .digest('hex')
    .slice(0, 40)
  return `app:interactions:${digest}`
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function displayOpportunity(opportunity: CrmOpportunity) {
  return {
    ...opportunity,
    org: opportunity.organization,
    closeDate: opportunity.expectedClose,
  }
}

function actorTimestamp(actor: AppUser) {
  const formatted = new Intl.DateTimeFormat(actor.locale || 'en-US', {
    timeZone: actor.timezone || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date())
  return `${formatted} (${actor.timezone || 'America/New_York'})`
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolvePipelineContext(req)
    const { id } = await ctx.params
    const body = await req.json()
    if (String(body.action || '') !== 'interaction') {
      return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
    }

    const opportunity = await readCrmOpportunityInPostgres({
      pipelineId: context.pipeline.id,
      id,
    })
    const interactionType = String(body.interaction || 'Note').trim() || 'Note'
    const notes = String(body.notes || '').trim()
    const contactLabel = String(body.contact || '').trim()
    const occurredAt = String(body.date || new Date().toISOString())
    const staged = await stageCrmRecordInPostgres({
      entity: 'interactions',
      pipelineId: context.pipeline.id,
      sourceKey: stableInteractionSourceKey(req, context, opportunity.id),
      sourcePayload: { source: 'clawpilot-pipeline', opportunityId: opportunity.id },
      actorEmail: context.actor.email,
      fields: {
        organizationId: opportunity.organizationId,
        opportunityId: opportunity.id,
        parentSuiteCrmId: opportunity.suiteCrmId,
        parentSuiteCrmType: 'Opportunities',
        interactionType,
        subject: `${interactionType}: ${opportunity.name}`,
        agentName: String(body.agent || context.actor.displayName || context.actor.email),
        occurredAt,
        description: notes,
        direction: 'internal',
        metadata: contactLabel ? { contactLabel } : {},
      },
    })

    logPipelineEvent({
      module: 'pipeline-interaction',
      action: 'queue',
      recordId: opportunity.id,
      result: 'ok',
      actor: context.actor.email,
      pipelineId: context.pipeline.id,
    })
    return NextResponse.json({
      ok: true,
      syncStatus: 'queued',
      interaction: staged,
    }, { status: 202 })
  } catch (error) {
    const detail = getErrorMessage(error)
    logPipelineEvent({ module: 'pipeline-interaction', action: 'queue', result: 'error', detail })
    return NextResponse.json({ error: detail }, { status: pipelineErrorStatus(detail) })
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolvePipelineContext(req)
    const { id } = await ctx.params
    const updates = await req.json() as Record<string, unknown>
    const current = await readCrmOpportunityInPostgres({ pipelineId: context.pipeline.id, id })
    const organization = current.organizationId
      ? await readCrmRecordReference({
          pipelineId: context.pipeline.id,
          entity: 'organizations',
          id: current.organizationId,
        })
      : null

    if (updates.expectedUpdatedAt && current.updatedAt && updates.expectedUpdatedAt !== current.updatedAt) {
      return NextResponse.json({
        error: 'Conflict: record changed since load',
        conflict: true,
        current: displayOpportunity(current),
      }, { status: 409 })
    }

    let notes = updates.notes !== undefined ? String(updates.notes || '') : current.notes
    const appendedComment = String(updates.appendComment || '').trim()
    if (appendedComment) {
      const line = `[${actorTimestamp(context.actor)}] [${context.actor.email}] ${appendedComment}`
      notes = notes ? `${notes}\n${line}` : line
    }

    await stageCrmRecordInPostgres({
      entity: 'opportunities',
      pipelineId: context.pipeline.id,
      localId: current.id,
      sourceKey: current.sourceKey,
      sourcePayload: { source: 'clawpilot-pipeline' },
      actorEmail: context.actor.email,
      fields: {
        organizationId: current.organizationId,
        organizationSuiteCrmId: organization?.suiteCrmId || null,
        name: updates.name !== undefined ? String(updates.name || '').trim() : current.name,
        organization: current.organization,
        priority: updates.priority !== undefined ? String(updates.priority || '') : current.priority,
        owner: updates.owner !== undefined ? String(updates.owner || '') : current.owner,
        status: updates.status !== undefined ? String(updates.status || '') : current.status,
        stage: updates.stage !== undefined ? String(updates.stage || '') : current.stage,
        lossReason: updates.lossReason !== undefined ? String(updates.lossReason || '') : current.lossReason,
        source: updates.source !== undefined ? String(updates.source || '') : current.source,
        value: updates.value !== undefined
          ? Math.max(0, finiteNumber(updates.value, current.value))
          : current.value,
        probability: updates.probability !== undefined
          ? Math.max(0, Math.min(100, finiteNumber(updates.probability, current.probability)))
          : current.probability,
        expectedClose: String(updates.closeDate ?? updates.expectedClose ?? current.expectedClose ?? '') || null,
        notes,
      },
    })
    const updated = await readCrmOpportunityInPostgres({ pipelineId: context.pipeline.id, id })

    if (updates.stage !== undefined && String(updates.stage) !== current.stage) {
      logPipelineEvent({
        module: 'pipeline',
        action: 'stage-change',
        activityType: 'moved',
        recordId: id,
        result: 'ok',
        actor: context.actor.email,
        pipelineId: context.pipeline.id,
        opportunityName: updated.name,
        organization: updated.organization,
        fromStage: current.stage,
        toStage: updated.stage,
        message: `Stage changed from ${current.stage || '—'} to ${updated.stage || '—'}`,
      })
    }
    logPipelineEvent({
      module: 'pipeline-opportunity',
      action: appendedComment ? 'comment' : 'update',
      activityType: appendedComment ? 'comment' : 'updated',
      recordId: id,
      result: 'ok',
      actor: context.actor.email,
      pipelineId: context.pipeline.id,
      opportunityName: updated.name,
      organization: updated.organization,
      message: appendedComment ? `Note added: "${appendedComment.slice(0, 80)}"` : 'Opportunity updated',
    })

    return NextResponse.json({
      ok: true,
      opportunity: displayOpportunity(updated),
      syncStatus: updated.syncStatus === 'synced' ? 'succeeded' : 'queued',
    }, { status: updated.syncStatus === 'synced' ? 200 : 202 })
  } catch (error) {
    const detail = getErrorMessage(error)
    logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', result: 'error', detail })
    return NextResponse.json({ error: detail }, { status: pipelineErrorStatus(detail) })
  }
}
