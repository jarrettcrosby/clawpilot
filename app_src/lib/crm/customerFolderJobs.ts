import { claimCustomerFolderJob, customerFolderJobContext, settleCustomerFolderJob } from '@/lib/persistence/crmCustomerFolderJobs'
import { GoogleWorkspaceClientError } from '@/lib/integrations/googleWorkspaceClient'
import { provisionCustomerAccountFolder } from './customerFolderProvisioning'
import { CustomerFolderHeldError } from './customerDriveFolders'

export async function processCustomerFolderJobs(input: { limit?: number } = {}) {
  const limit = Math.max(1,Math.min(3,Math.trunc(Number(input.limit)||1)))
  const summary = { claimed:0, ready:0, queued:0, held:0, leaseLost:0 }
  for (let index=0;index<limit;index++) {
    const job = await claimCustomerFolderJob()
    if (!job) break
    summary.claimed++
    let result: {status:'ready'|'queued'|'held';errorCode?:string}
    try {
      const context = await customerFolderJobContext(job)
      await provisionCustomerAccountFolder({ ...context, actorEmail:job.actor_email, adoptRootId:job.adopt_root_id??undefined })
      result = { status:'ready' }
    } catch (error) {
      const retryable = error instanceof GoogleWorkspaceClientError && error.retryable && job.attempts<5
      const code = error instanceof CustomerFolderHeldError && /^[a-z0-9_]{1,100}$/.test(error.code)
        ? error.code : retryable ? 'customer_folder_provider_retry' : 'customer_folder_processing_held'
      result = { status:retryable?'queued':'held',errorCode:code }
    }
    if (await settleCustomerFolderJob(job,result)) summary[result.status]++
    else summary.leaseLost++
  }
  // Aggregate counts only: provider errors, actor addresses, account identities
  // and private folder metadata must not escape a secret worker response.
  return summary
}
