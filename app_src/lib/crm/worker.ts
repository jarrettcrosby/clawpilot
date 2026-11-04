import {
  deleteSuiteCrmRecord,
  upsertSuiteCrmRecordWithResult,
  upsertSuiteCrmUserIdentity,
  type SuiteCrmMeetingProjectionReadback,
  createSuiteCrmNativeEmailPublicationClient,
} from '@/lib/crm/suiteCrmClient'
import type {
  SuiteCrmNativeProductImageResult,
} from '@/lib/crm/suiteCrmNativeProductImageClient'
import { SuiteCrmEmailProjectionHeldError, type SuiteCrmEmailProjectionReadback } from '@/lib/crm/suiteCrmNativeEmailProjection'
import {
  claimSuiteCrmOutboxInPostgres,
  completeSuiteCrmOutboxInPostgres,
  failSuiteCrmOutboxInPostgres,
  readCrmWorkbookProjectionContext,
  readCrmWorkbookProjectionReadiness,
  writeSuiteCrmWorkerHeartbeat,
  withVerifiedSuiteCrmEmailPublication,
  withVerifiedSuiteCrmRecordLifecycle,
  mayDispatchSuiteCrmUserIdentityInPostgres,
} from '@/lib/persistence/crm'
import { enqueuePipelineSyncOutboxInPostgres } from '@/lib/persistence/pipeline'
import { createNativeEmailPublicationWorker, touchesNativeEmail } from '@/lib/crm/nativeEmailPublicationWorker'
import { createPostgresNativeEmailWorkerPersistence } from '@/lib/persistence/crmNativeEmailPublication'
import { deleteSuiteCrmAccountContactVerified } from '@/lib/crm/suiteCrmRecordLifecycleClient'

export async function processSuiteCrmOutbox(input: { limit?: number; maxAttempts?: number } = {}) {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const nativeEmail = createNativeEmailPublicationWorker(createPostgresNativeEmailWorkerPersistence({ maxAttempts }),
    createSuiteCrmNativeEmailPublicationClient())
  // Resolve an exact durable native operation before considering fresh work.
  // A missing/invalid control table is a held worker, never a legacy fallback.
  const resumed = await nativeEmail.resume()
  const items = await claimSuiteCrmOutboxInPostgres({ limit: input.limit, maxAttempts })
  const results: Array<{ id: string; status: 'succeeded' | 'failed' | 'dead' | 'held' }> = []
  const projectedPipelines = new Map<string, string>()
  let nativeProjectionsQueued = resumed.settled?.projectionQueued ? 1 : 0
  await writeSuiteCrmWorkerHeartbeat({ phase: 'started', claimed: items.length })
  for (const item of items) {
    let nativeEmailHandled = touchesNativeEmail(item)
    try {
      if (!item.payload || item.payload.localId !== item.aggregateId) throw new Error('SuiteCRM outbox payload is invalid')
      const nativeResult = await nativeEmail.process(item, maxAttempts)
      if (nativeResult.handled) {
        if (nativeResult.settled?.projectionQueued) nativeProjectionsQueued += 1
        results.push({ id: item.id, status: nativeResult.status })
        continue
      }
      nativeEmailHandled = false
      let productImageProjection: SuiteCrmNativeProductImageResult | null = null
      let meetingProjection: SuiteCrmMeetingProjectionReadback | null = null
      let emailProjection: SuiteCrmEmailProjectionReadback | null = null
      if (item.operation === 'upsert_user_identity') {
        // Recheck a previously claimed identity at dispatch. It must never
        // mutate the native policy behind the authority/publication protocol.
        if (!await mayDispatchSuiteCrmUserIdentityInPostgres(item)) {
          results.push({ id:item.id,status:'held' })
          continue
        }
        await upsertSuiteCrmUserIdentity(item.payload)
      }
      else if (item.operation === 'delete_record') {
        const payload = item.payload
        await withVerifiedSuiteCrmRecordLifecycle(item, () =>
          payload.entity === 'organizations' || payload.entity === 'contacts'
            ? deleteSuiteCrmAccountContactVerified(payload) : deleteSuiteCrmRecord(payload))
      }
      else if (item.operation === 'reproject_record') {
        // Create the target record before removing the legacy projection. A
        // provider-schema or validation failure must never erase the last
        // visible SuiteCRM copy of a durable ClawPilot interaction.
        if (item.payload.suiteCrmModule) {
          const payload = item.payload
          const projection = payload.suiteCrmModule === 'Emails'
            ? await withVerifiedSuiteCrmEmailPublication(item, () => upsertSuiteCrmRecordWithResult(payload))
            : await withVerifiedSuiteCrmRecordLifecycle(item, () => upsertSuiteCrmRecordWithResult(payload))
          productImageProjection = projection.productImageProjection
          meetingProjection = projection.meetingProjection || null
          emailProjection = projection.emailProjection || null
          if (item.payload.suiteCrmModule === 'Emails' && !emailProjection) throw new SuiteCrmEmailProjectionHeldError()
        }
        if (item.payload.previousSuiteCrmModule) {
          await deleteSuiteCrmRecord({
            ...item.payload,
            suiteCrmModule: item.payload.previousSuiteCrmModule,
            previousSuiteCrmModule: undefined,
            attributes: {},
            relationships: undefined,
          })
        }
      }
      else {
        const payload = item.payload
        const projection = payload.suiteCrmModule === 'Emails'
          ? await withVerifiedSuiteCrmEmailPublication(item, () => upsertSuiteCrmRecordWithResult(payload))
          : await withVerifiedSuiteCrmRecordLifecycle(item, () => upsertSuiteCrmRecordWithResult(payload))
        productImageProjection = projection.productImageProjection
        meetingProjection = projection.meetingProjection || null
        emailProjection = projection.emailProjection || null
      }
      if (item.operation !== 'delete_record' && item.operation !== 'upsert_user_identity'
        && item.payload.suiteCrmModule === 'Emails' && !emailProjection) {
        throw new SuiteCrmEmailProjectionHeldError()
      }
      await completeSuiteCrmOutboxInPostgres(item, {
        productImageProjection,
        ...(meetingProjection ? { meetingProjection } : {}),
        ...(emailProjection ? { emailProjection } : {}),
      })
      if (item.operation !== 'upsert_user_identity') projectedPipelines.set(item.payload.pipelineId, item.id)
      results.push({ id: item.id, status: 'succeeded' })
    } catch (error) {
      // Once an Email path may have an admission, neither generic fail nor
      // lease-recycling may discard unknown native outcomes. The coordinator
      // records known pre-admission holds itself; unreadable state stays held.
      if (nativeEmailHandled) {
        results.push({ id: item.id, status: 'held' })
        continue
      }
      const status = await failSuiteCrmOutboxInPostgres({
        item,
        error: error instanceof Error ? error.message : String(error),
        maxAttempts,
      })
      results.push({ id: item.id, status })
    }
  }
  let projectionsQueued = nativeProjectionsQueued
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
    held: results.filter((result) => result.status === 'held').length,
    nativeResolutionHeld: resumed.blocked,
    projectionsQueued,
  }
  await writeSuiteCrmWorkerHeartbeat({ phase: 'completed', ...summary })
  return { ...summary, items: results }
}
