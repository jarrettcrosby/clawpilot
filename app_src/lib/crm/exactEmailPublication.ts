import { previewExactEmailPublicationInPostgres, claimExactEmailPublicationInPostgres,
  type ExactEmailPublicationSelection } from '../persistence/crmExactEmailPublication'
import { createPostgresNativeEmailWorkerPersistence } from '../persistence/crmNativeEmailPublication'
import { createNativeEmailPublicationWorker } from './nativeEmailPublicationWorker'
import { createSuiteCrmNativeEmailPublicationClient } from './suiteCrmClient'

/** Operator publication is exact-source scoped, not a small global queue batch.
 * No global resume(), generic worker or legacy Email writer is called. */
export async function publishExactCrmEmails(input: ExactEmailPublicationSelection & { apply?: boolean; expectedDigest?: string }) {
  const {apply,expectedDigest,...selection} = input
  if (!apply) return {applied:false,...await previewExactEmailPublicationInPostgres(selection)}
  const claimed = await claimExactEmailPublicationInPostgres(selection,expectedDigest || '')
  const worker = createNativeEmailPublicationWorker(createPostgresNativeEmailWorkerPersistence({maxAttempts:claimed.maxAttempts}),
    createSuiteCrmNativeEmailPublicationClient())
  const outcomes:Array<{outboxId:string;status:'succeeded'|'held'}> = []
  for (const item of claimed.items) {
    try {
      const result = await worker.process(item,claimed.maxAttempts)
      // If control was changed after claim, never call the legacy writer.
      outcomes.push({outboxId:item.id,status:result.handled ? result.status : 'held'})
    } catch { outcomes.push({outboxId:item.id,status:'held'}) }
  }
  return {applied:true,...claimed.preview,claimed:claimed.items.length,alreadyCompleted:claimed.alreadyCompleted,
    succeeded:outcomes.filter(row => row.status === 'succeeded').length,
    held:outcomes.filter(row => row.status === 'held').length,outcomes}
}
