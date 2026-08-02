import {
  deleteSuiteCrmRecord,
  upsertSuiteCrmRecordWithResult,
  upsertSuiteCrmUserIdentity,
} from '@/lib/crm/suiteCrmClient'
import type {
  SuiteCrmNativeProductImageResult,
} from '@/lib/crm/suiteCrmNativeProductImageClient'
import {
  claimSuiteCrmOutboxInPostgres,
  completeSuiteCrmOutboxInPostgres,
  failSuiteCrmOutboxInPostgres,
  readCrmWorkbookProjectionContext,
  readCrmWorkbookProjectionReadiness,
  writeSuiteCrmWorkerHeartbeat,
} from '@/lib/persistence/crm'
import { enqueuePipelineSyncOutboxInPostgres } from '@/lib/persistence/pipeline'

export async function processSuiteCrmOutbox(input: { limit?: number; maxAttempts?: number } = {}) {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const items = await claimSuiteCrmOutboxInPostgres({ limit: input.limit, maxAttempts })
  const results: Array<{ id: string; status: 'succeeded' | 'failed' | 'dead' }> = []
  const projectedPipelines = new Map<string, string>()
  await writeSuiteCrmWorkerHeartbeat({ phase: 'started', claimed: items.length })
  for (const item of items) {
    try {
      if (!item.payload || item.payload.localId !== item.aggregateId) throw new Error('SuiteCRM outbox payload is invalid')
      let productImageProjection: SuiteCrmNativeProductImageResult | null = null
      if (item.operation === 'upsert_user_identity') await upsertSuiteCrmUserIdentity(item.payload)
      else if (item.operation === 'delete_record') await deleteSuiteCrmRecord(item.payload)
      else if (item.operation === 'reproject_record') {
        if (item.payload.previousSuiteCrmModule) {
          await deleteSuiteCrmRecord({
            ...item.payload,
            suiteCrmModule: item.payload.previousSuiteCrmModule,
            previousSuiteCrmModule: undefined,
            attributes: {},
            relationships: undefined,
          })
        }
        if (item.payload.suiteCrmModule) {
          productImageProjection = (
            await upsertSuiteCrmRecordWithResult(item.payload)
          ).productImageProjection
        }
      }
      else {
        productImageProjection = (
          await upsertSuiteCrmRecordWithResult(item.payload)
        ).productImageProjection
      }
      await completeSuiteCrmOutboxInPostgres(item, {
        productImageProjection,
      })
      if (item.operation !== 'upsert_user_identity') projectedPipelines.set(item.payload.pipelineId, item.id)
      results.push({ id: item.id, status: 'succeeded' })
    } catch (error) {
      const status = await failSuiteCrmOutboxInPostgres({
        item,
        error: error instanceof Error ? error.message : String(error),
        maxAttempts,
      })
      results.push({ id: item.id, status })
    }
  }
  let projectionsQueued = 0
  for (const [pipelineId, triggerId] of projectedPipelines) {
    const readiness = await readCrmWorkbookProjectionReadiness(pipelineId)
    if (!readiness.ready) continue
    const context = await readCrmWorkbookProjectionContext(pipelineId)
    if (!context) continue
    await enqueuePipelineSyncOutboxInPostgres({
      pipelineId: context.pipelineId,
      sheetId: context.sheetId,
      aggregateType: 'pipeline_crm_projection',
      aggregateId: context.pipelineId,
      operation: 'project_crm_workbook',
      payload: { actorEmail: context.ownerEmail, triggerId },
      actor: context.ownerEmail,
      idempotencyKey: `crm-projection:${triggerId}`,
    })
    projectionsQueued += 1
  }
  const summary = {
    claimed: items.length,
    succeeded: results.filter((result) => result.status === 'succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
    dead: results.filter((result) => result.status === 'dead').length,
    projectionsQueued,
  }
  await writeSuiteCrmWorkerHeartbeat({ phase: 'completed', ...summary })
  return { ...summary, items: results }
}
