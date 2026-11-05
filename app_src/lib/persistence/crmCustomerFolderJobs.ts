import { query, withTransaction } from './postgres'
import { CustomerFolderHeldError, validateCustomerFolderScope, type CustomerFolderScope } from '../crm/customerDriveFolders'

export type CustomerFolderJob = {
  account_id: string; pipeline_id: string; workspace_id: string; account_global_id: string;
  actor_email: string; config_revision: string; adopt_root_id: string | null; lock_token: string; attempts: number;
}

/** A single bounded claim; a lost lease never permits overwriting another
 * worker's outcome. Fixed Drive IDs make expired-job reconciliation repeatable. */
export async function claimCustomerFolderJob() {
  return withTransaction(async client => {
    const result = await client.query<CustomerFolderJob>(`WITH candidate AS (
      SELECT account_id FROM crm_customer_folder_jobs
      WHERE (status='queued' AND available_at<=now() OR status='processing' AND locked_until<now())
      ORDER BY available_at,account_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE crm_customer_folder_jobs j SET status='processing',attempts=j.attempts+1,
      lock_token=gen_random_uuid(),locked_until=now()+interval '5 minutes',last_error_code=NULL,updated_at=now()
      FROM candidate c WHERE j.account_id=c.account_id RETURNING j.*`)
    return result.rows[0] ?? null
  })
}

export async function customerFolderJobContext(job: CustomerFolderJob): Promise<{ scope: CustomerFolderScope; customerName: string }> {
  const result = await query<{
    shared_drive_id: string; customers_parent_id: string; service_account_email: string; name: string;
  }>(`SELECT s.shared_drive_id,s.customers_parent_id,s.service_account_email,o.name
    FROM crm_customer_folder_jobs j JOIN crm_customer_folder_settings s ON s.workspace_id=j.workspace_id
    JOIN crm_organizations o ON o.id=j.account_id AND o.pipeline_id=j.pipeline_id AND o.reference_code=j.account_global_id
    JOIN pipeline_spaces p ON p.id=o.pipeline_id AND p.workspace_organization_id=j.workspace_id
    WHERE j.account_id=$1::uuid AND j.lock_token=$2::uuid AND j.status='processing' AND j.locked_until>now()
      AND j.actor_email=$3 AND s.enabled AND s.revision=j.config_revision AND j.config_revision=$4::bigint`,
  [job.account_id,job.lock_token,job.actor_email,job.config_revision])
  if (result.rows.length !== 1) throw new CustomerFolderHeldError('customer_folder_configuration_or_lease_changed')
  const row = result.rows[0]
  const scope: CustomerFolderScope = { workspaceId:job.workspace_id,pipelineId:job.pipeline_id,accountId:job.account_id,
    accountGlobalId:job.account_global_id,sharedDriveId:row.shared_drive_id,customersParentId:row.customers_parent_id,
    serviceAccountEmail:row.service_account_email }
  validateCustomerFolderScope(scope)
  return { scope, customerName:row.name }
}

export async function settleCustomerFolderJob(job: CustomerFolderJob, input: {
  status: 'ready' | 'queued' | 'held'; errorCode?: string;
}): Promise<boolean> {
  if (!['ready','queued','held'].includes(input.status)
    || input.errorCode !== undefined && !/^[a-z0-9_]{1,100}$/.test(input.errorCode)) {
    throw new CustomerFolderHeldError('customer_folder_job_result_invalid')
  }
  const result = await query(`UPDATE crm_customer_folder_jobs SET status=$3,last_error_code=$4,
    available_at=CASE WHEN $3='queued' THEN now()+interval '30 seconds' ELSE available_at END,
    lock_token=NULL,locked_until=NULL,updated_at=now()
    WHERE account_id=$1::uuid AND lock_token=$2::uuid AND status='processing' AND locked_until>now()
    RETURNING account_id`, [job.account_id,job.lock_token,input.status,input.errorCode??null])
  return result.rows.length === 1
}
