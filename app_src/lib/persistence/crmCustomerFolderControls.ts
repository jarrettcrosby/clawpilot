import type { PoolClient } from 'pg'
import { withTransaction } from './postgres'
import { recordAuditEvent } from '@/lib/auditWriter'
import { assertCustomerFolderPlan, CustomerFolderHeldError, type CustomerFolderPlan, type CustomerFolderScope } from '../crm/customerDriveFolders'
import { customerFolderUuid, customerDriveFolderId, type CustomerFolderControlsState, type CustomerFolderCommand } from '../crm/customerFolderControls'
import { parseCustomerFolderLinks } from '../crm/customerFolderLinks'

type Account = { id:string; reference_code:string; name:string; description:string|null; workspace_id:string;
  is_customer:boolean; can_edit:boolean; can_configure:boolean }
type Settings = { enabled:boolean; revision:string; shared_drive_id:string;customers_parent_id:string;service_account_email:string }
async function account(client:PoolClient,input:{pipelineId:string;accountId:string;actorEmail:string}):Promise<Account> {
  customerFolderUuid(input.pipelineId);customerFolderUuid(input.accountId)
  const result=await client.query<Account>(`SELECT o.id::text,o.reference_code,o.name,o.description,
    p.workspace_organization_id::text AS workspace_id,
    (o.workspace_organization_id IS NULL AND lower(btrim(COALESCE(o.account_type,'')))='customer') AS is_customer,
    (p.owner_email=u.email OR pm.access_role='editor') IS TRUE AS can_edit,
    (u.role='owner' AND m.role IN ('owner','admin') AND (p.owner_email=u.email OR pm.access_role='editor')) IS TRUE AS can_configure
    FROM crm_organizations o JOIN pipeline_spaces p ON p.id=o.pipeline_id
    JOIN workspace_organizations w ON w.id=p.workspace_organization_id AND NOT w.is_demo
    JOIN app_users u ON u.email=$3 AND u.status='active'
    JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=w.id
      AND m.status='active' AND m.trashed_at IS NULL
    LEFT JOIN pipeline_space_members pm ON pm.pipeline_id=p.id AND pm.user_email=u.email
    WHERE o.id=$1::uuid AND o.pipeline_id=$2::uuid AND NOT p.reference_access_disabled
      AND (p.owner_email=u.email OR pm.user_email IS NOT NULL)
      AND (m.role='owner' OR COALESCE((m.permissions->>'viewCrm')::boolean,true))
      AND COALESCE(lower(o.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
    FOR SHARE OF o,p,w,u,m`,[input.accountId,input.pipelineId,input.actorEmail])
  if(result.rows.length!==1)throw new CustomerFolderHeldError('customer_folder_access_denied')
  return result.rows[0]
}
async function settings(client:PoolClient,workspaceId:string,lock=true) {
  return (await client.query<Settings>(`SELECT * FROM crm_customer_folder_settings WHERE workspace_id=$1::uuid${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]??null
}
const revision=(value:unknown)=>{
  const n=Number(value??0)
  if(!Number.isSafeInteger(n)||n<0)throw new CustomerFolderHeldError('customer_folder_revision_invalid')
  return n
}
export async function readCustomerFolderControls(input:{pipelineId:string;accountId:string;actorEmail:string}):Promise<CustomerFolderControlsState> {
  return withTransaction(async client=>{
    const row=await account(client,input),config=await settings(client,row.workspace_id,false)
    const job=(await client.query<{status:'queued'|'processing'|'ready'|'held';request_generation:number;last_error_code:string|null}>(
      `SELECT status,request_generation,last_error_code FROM crm_customer_folder_jobs
       WHERE account_id=$1::uuid AND pipeline_id=$2::uuid AND workspace_id=$3::uuid AND account_global_id=$4`,
    [row.id,input.pipelineId,row.workspace_id,row.reference_code])).rows[0]
    const folder=(await client.query<{plan:CustomerFolderPlan;status:string;publication_status:'pending'|'published'|'manual_override'}>(
      'SELECT plan,status,publication_status FROM crm_customer_drive_folders WHERE account_id=$1::uuid',[row.id])).rows[0]
    if(folder){const scope=folder.plan.scope;assertCustomerFolderPlan(folder.plan,scope)
      if(scope.accountId!==row.id||scope.pipelineId!==input.pipelineId||scope.workspaceId!==row.workspace_id
        ||scope.accountGlobalId!==row.reference_code)throw new CustomerFolderHeldError('customer_folder_plan_mismatch')}
    const parsed=parseCustomerFolderLinks(row.description??'')
    return {account:{id:row.id,globalId:row.reference_code,name:row.name,isCustomer:row.is_customer,
      hasManualLink:Boolean(parsed.values.bpoDriveUrl)},canEdit:row.can_edit,canConfigure:row.can_configure,
      settings:{enabled:config?.enabled??false,revision:revision(config?.revision),
        parentUrl:config?`https://drive.google.com/drive/folders/${customerDriveFolderId(config.customers_parent_id)}`:null},
      job:job?{status:job.status,version:job.request_generation,errorCode:job.last_error_code}:null,
      folder:folder?.status==='ready'?{url:`https://drive.google.com/drive/folders/${folder.plan.nodes[0].id}`,
        publicationStatus:folder.publication_status==='published'
          &&parsed.values.bpoDriveUrl!==`https://drive.google.com/drive/folders/${folder.plan.nodes[0].id}`
          ?'manual_override':folder.publication_status}:null}
  })
}

/** Provider verification happens first in the server service. This transaction
 * rechecks administrator scope and a revision so stale forms cannot move work. */
export async function saveVerifiedCustomerFolderSettings(input:{pipelineId:string;accountId:string;actorEmail:string;
  parentId:string;sharedDriveId:string;serviceAccountEmail:string;enabled:boolean;expectedRevision:number}) {
  return withTransaction(async client=>{
    const row=await account(client,input)
    if(!row.can_configure)throw new CustomerFolderHeldError('customer_folder_admin_required')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`customer-folder-settings:${row.workspace_id}`])
    const current=await settings(client,row.workspace_id),currentRevision=revision(current?.revision)
    if(currentRevision!==input.expectedRevision) {
      if(currentRevision===input.expectedRevision+1&&current?.customers_parent_id===input.parentId
        &&current.shared_drive_id===input.sharedDriveId&&current.service_account_email===input.serviceAccountEmail
        &&current.enabled===input.enabled)return
      throw new CustomerFolderHeldError('customer_folder_settings_changed')
    }
    await client.query(`INSERT INTO crm_customer_folder_settings(workspace_id,shared_drive_id,customers_parent_id,
      service_account_email,parent_name,enabled,revision,updated_by) VALUES($1::uuid,$2,$3,$4,'01 Customers',$5,$6,$7)
      ON CONFLICT(workspace_id) DO UPDATE SET shared_drive_id=EXCLUDED.shared_drive_id,customers_parent_id=EXCLUDED.customers_parent_id,
        service_account_email=EXCLUDED.service_account_email,enabled=EXCLUDED.enabled,revision=EXCLUDED.revision,
        updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [row.workspace_id,input.sharedDriveId,input.parentId,input.serviceAccountEmail,input.enabled,currentRevision+1,input.actorEmail])
    await recordAuditEvent({actor:input.actorEmail,organizationId:row.workspace_id,eventType:'crm.customer_folders.configured',
      aggregateType:'workspace',aggregateId:row.workspace_id,eventKey:`customer-folder-config:${row.workspace_id}:${currentRevision+1}`,
      payload:{enabled:input.enabled,revision:currentRevision+1}},client)
  })
}

/** Pausing the existing verified binding must work during a Google outage;
 * it cannot change the parent/Drive/service account or issue provider calls. */
export async function pauseCustomerFolderSettings(input:{pipelineId:string;accountId:string;actorEmail:string;parentId:string;expectedRevision:number}) {
  return withTransaction(async client=>{
    const row=await account(client,input)
    if(!row.can_configure)throw new CustomerFolderHeldError('customer_folder_admin_required')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`customer-folder-settings:${row.workspace_id}`])
    const current=await settings(client,row.workspace_id),currentRevision=revision(current?.revision)
    if(!current||current.customers_parent_id!==input.parentId)throw new CustomerFolderHeldError('customer_folder_settings_changed')
    if(!current.enabled&&(currentRevision===input.expectedRevision||currentRevision===input.expectedRevision+1))return
    if(currentRevision!==input.expectedRevision)throw new CustomerFolderHeldError('customer_folder_settings_changed')
    await client.query('UPDATE crm_customer_folder_settings SET enabled=false,revision=revision+1,updated_by=$2,updated_at=now() WHERE workspace_id=$1::uuid',
      [row.workspace_id,input.actorEmail])
    await recordAuditEvent({actor:input.actorEmail,organizationId:row.workspace_id,eventType:'crm.customer_folders.configured',
      aggregateType:'workspace',aggregateId:row.workspace_id,eventKey:`customer-folder-config:${row.workspace_id}:${currentRevision+1}`,
      payload:{enabled:false,revision:currentRevision+1}},client)
  })
}

export async function requestCustomerFolderJob(input:Extract<CustomerFolderCommand,{action:'queue'}>&{actorEmail:string}) {
  return withTransaction(async client=>{
    // Publication takes lifecycle -> account -> reservation. Use the same
    // order before inspecting a frozen reservation; never upgrade account
    // locks while another transaction holds its reservation lock.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`crm-record-lifecycle:${input.pipelineId}`])
    const row=await account(client,input)
    if(!row.can_edit||!row.is_customer)throw new CustomerFolderHeldError('customer_folder_customer_editor_required')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`customer-folder-settings:${row.workspace_id}`])
    const config=await settings(client,row.workspace_id)
    if(!config?.enabled||revision(config.revision)!==input.expectedRevision)throw new CustomerFolderHeldError('customer_folder_settings_changed')
    const scope:CustomerFolderScope={workspaceId:row.workspace_id,pipelineId:input.pipelineId,accountId:row.id,
      accountGlobalId:row.reference_code,sharedDriveId:config.shared_drive_id,customersParentId:config.customers_parent_id,
      serviceAccountEmail:config.service_account_email}
    const frozen=(await client.query<{plan:CustomerFolderPlan}>('SELECT plan FROM crm_customer_drive_folders WHERE account_id=$1::uuid FOR UPDATE',[row.id])).rows[0]
    if(frozen){assertCustomerFolderPlan(frozen.plan,scope)
      if(input.adoptRootId&&frozen.plan.nodes[0].id!==input.adoptRootId)throw new CustomerFolderHeldError('customer_folder_adoption_changed')}
    const existing=(await client.query<{status:string;pipeline_id:string;workspace_id:string;account_global_id:string;request_generation:number;request_key:string|null;actor_email:string;
      config_revision:string;adopt_root_id:string|null;lease_live:boolean}>(`SELECT *,locked_until>now() AS lease_live
      FROM crm_customer_folder_jobs WHERE account_id=$1::uuid FOR UPDATE`,[row.id])).rows[0]
    const adopted=input.adoptRootId??existing?.adopt_root_id??null
    if(existing&&(existing.pipeline_id!==input.pipelineId||existing.workspace_id!==row.workspace_id||existing.account_global_id!==row.reference_code)) {
      throw new CustomerFolderHeldError('customer_folder_plan_mismatch')
    }
    if(existing?.request_key===input.requestKey){
      if(existing.actor_email!==input.actorEmail||revision(existing.config_revision)!==input.expectedRevision
        ||existing.adopt_root_id!==adopted)throw new CustomerFolderHeldError('customer_folder_request_changed')
      return
    }
    if(existing?.status==='ready')return
    if(existing?.status==='processing'&&existing.lease_live)throw new CustomerFolderHeldError('customer_folder_job_busy')
    if((existing?.request_generation??0)!==input.expectedJobVersion)throw new CustomerFolderHeldError('customer_folder_job_changed')
    await client.query(`INSERT INTO crm_customer_folder_jobs(account_id,pipeline_id,workspace_id,account_global_id,
      actor_email,config_revision,adopt_root_id,request_key,request_generation) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid,$9)
      ON CONFLICT(account_id) DO UPDATE SET actor_email=EXCLUDED.actor_email,config_revision=EXCLUDED.config_revision,
        adopt_root_id=EXCLUDED.adopt_root_id,request_key=EXCLUDED.request_key,request_generation=EXCLUDED.request_generation,
        status='queued',attempts=0,available_at=now(),lock_token=NULL,locked_until=NULL,last_error_code=NULL,updated_at=now()`,
    [row.id,input.pipelineId,row.workspace_id,row.reference_code,input.actorEmail,input.expectedRevision,adopted,input.requestKey,input.expectedJobVersion+1])
    await recordAuditEvent({actor:input.actorEmail,organizationId:row.workspace_id,eventType:'crm.customer_folders.requested',
      aggregateType:'crm_organizations',aggregateId:row.id,eventKey:`customer-folder-request:${row.id}:${input.requestKey}`,
      payload:{pipelineId:input.pipelineId,globalId:row.reference_code,adoptExisting:Boolean(adopted)}},client)
  })
}
