import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import type { CrmOpportunity } from '@/lib/crm/types'
import { getErrorMessage } from '@/lib/errorUtils'
import { logPipelineEvent } from '@/lib/pipelineLog'
import {
  appendCrmOpportunityCommentInPostgres,
  readCrmOpportunityInPostgres,
  stageCrmRecordInPostgres,
  updateCrmOpportunityInPostgres,
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
  const pipeline = selected
    ? await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
    : await resolvePipelineSpaceAccess({ actorEmail: actor.email })
  requireResourceEditor(pipeline)
  return { actor, pipeline }
}

function stableMutationSourceKey(
  req: NextRequest,
  context: PipelineContext,
  opportunityId: string,
  namespace: 'interactions' | 'comments' | 'updates',
) {
  const provided = String(req.headers.get('idempotency-key') || '').trim()
  if (!provided) throw new Error('Idempotency-Key is required for opportunity mutations')
  if (provided.length > 200) throw new Error('Idempotency-Key must be 200 characters or fewer')
  const digest = crypto
    .createHash('sha256')
    .update(`${namespace}\n${context.pipeline.id}\n${context.actor.email.toLowerCase()}\n${opportunityId}\n${provided}`)
    .digest('hex')
    .slice(0, 40)
  return `app:pipeline-opportunity-${namespace}:${digest}`
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function opportunityProductName(value: unknown) {
  const products = Array.isArray(value) ? value : String(value || '').split(',')
  return [...new Set(products.map((product) => String(product || '').trim()).filter(Boolean))].join(', ')
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
      sourceKey: stableMutationSourceKey(req, context, opportunity.id, 'interactions'),
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
    const expectedUpdatedAt = String(updates.expectedUpdatedAt || '').trim()
    if (!expectedUpdatedAt) {
      return NextResponse.json({ error: 'expectedUpdatedAt is required for opportunity mutations' }, { status: 400 })
    }
    const current = await readCrmOpportunityInPostgres({ pipelineId: context.pipeline.id, id })

    const appendedComment = String(updates.appendComment || '').trim()
    if (appendedComment) {
      const line = `[${actorTimestamp(context.actor)}] [${context.actor.email}] ${appendedComment}`
      const result = await appendCrmOpportunityCommentInPostgres({
        pipelineId: context.pipeline.id,
        opportunityId: current.id,
        sourceKey: stableMutationSourceKey(req, context, current.id, 'comments'),
        expectedUpdatedAt,
        actorEmail: context.actor.email,
        actorName: context.actor.displayName || context.actor.email,
        occurredAt: new Date().toISOString(),
        comment: appendedComment,
        commentLine: line,
      })
      if (result.conflict) {
        return NextResponse.json({
          error: 'Conflict: record changed since load',
          conflict: true,
          current: displayOpportunity(result.opportunity),
        }, { status: 409 })
      }
      if (result.created) {
        logPipelineEvent({
          module: 'pipeline-opportunity',
          action: 'comment',
          activityType: 'comment',
          recordId: id,
          result: 'ok',
          actor: context.actor.email,
          pipelineId: context.pipeline.id,
          opportunityName: result.opportunity.name,
          organization: result.opportunity.organization,
          message: `Note added: "${appendedComment.slice(0, 80)}"`,
        })
      }
      return NextResponse.json({
        ok: true,
        duplicate: !result.created,
        opportunity: displayOpportunity(result.opportunity),
        syncStatus: result.opportunity.syncStatus === 'synced' ? 'succeeded' : 'queued',
      }, { status: result.opportunity.syncStatus === 'synced' ? 200 : 202 })
    }

    const notes = updates.notes !== undefined ? String(updates.notes || '') : current.notes
    const name = updates.products !== undefined || updates.name !== undefined
      ? opportunityProductName(updates.products ?? updates.name)
      : current.name
    if (!name) {
      return NextResponse.json({ error: 'At least one product is required' }, { status: 400 })
    }

    const result = await updateCrmOpportunityInPostgres({
      pipelineId: context.pipeline.id,
      opportunityId: current.id,
      mutationKey: stableMutationSourceKey(req, context, current.id, 'updates'),
      expectedUpdatedAt,
      actorEmail: context.actor.email,
      fields: {
        organizationId: current.organizationId,
        name,
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
    if (result.conflict) {
      return NextResponse.json({
        error: 'Conflict: record changed since load',
        conflict: true,
        current: displayOpportunity(result.opportunity),
      }, { status: 409 })
    }
    const updated = result.opportunity

    if (result.applied && updates.stage !== undefined && String(updates.stage) !== current.stage) {
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
    if (result.applied) {
      logPipelineEvent({
        module: 'pipeline-opportunity',
        action: 'update',
        activityType: 'updated',
        recordId: id,
        result: 'ok',
        actor: context.actor.email,
        pipelineId: context.pipeline.id,
        opportunityName: updated.name,
        organization: updated.organization,
        message: 'Opportunity updated',
      })
    }

    return NextResponse.json({
      ok: true,
      duplicate: result.replayed,
      opportunity: displayOpportunity(updated),
      syncStatus: updated.syncStatus === 'synced' ? 'succeeded' : 'queued',
    }, { status: updated.syncStatus === 'synced' ? 200 : 202 })
  } catch (error) {
    const detail = getErrorMessage(error)
    logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', result: 'error', detail })
    return NextResponse.json({ error: detail }, { status: pipelineErrorStatus(detail) })
  }
}
