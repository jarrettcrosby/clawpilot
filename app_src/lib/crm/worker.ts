import { upsertSuiteCrmRecord } from '@/lib/crm/suiteCrmClient'
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
      await upsertSuiteCrmRecord(item.payload)
      await completeSuiteCrmOutboxInPostgres(item)
      projectedPipelines.set(item.payload.pipelineId, item.id)
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
