import { withTransaction } from './postgres'
import { lockCrmNativeEmailAuthorityWithClient } from './crmNativeEmailAuthority'
import { updateCrmDescriptionWithClient } from './crm'
import { prepareCustomerFolderPublication, type CustomerFolderPublicationStatus } from '../crm/customerFolderPublication'
import { assertCustomerFolderPlan, validateCustomerFolderScope, CustomerFolderHeldError,
  type CustomerFolderPlan, type CustomerFolderScope, type CustomerFolderStore } from '../crm/customerDriveFolders'
import type { PoolClient } from 'pg'

/** Internal storage port, not a public authorization bypass. Every reservation
 * and completion rechecks active editor authority and the exact live account.
 * Provider calls occur outside database transactions. */
export function postgresCustomerFolderStore(actorEmail: string): CustomerFolderStore {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actorEmail) || actorEmail !== actorEmail.toLowerCase()) {
    throw new CustomerFolderHeldError('customer_folder_actor_invalid')
  }
  async function authorize(client: PoolClient, scope: CustomerFolderScope) {
    validateCustomerFolderScope(scope)
    // Serialize with account lifecycle changes. These reservation-only writes
    // do not change CRM reader authority or acquire native control afterward.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`crm-record-lifecycle:${scope.pipelineId}`])
    const current = await client.query<{ description: string | null }>(`SELECT o.id,o.description
      FROM crm_organizations o JOIN pipeline_spaces p ON p.id=o.pipeline_id
      JOIN workspace_organizations w ON w.id=p.workspace_organization_id AND NOT w.is_demo
      JOIN app_users u ON u.email=$5 AND u.status='active'
      JOIN app_user_organization_memberships m ON m.user_email=u.email
        AND m.organization_id=p.workspace_organization_id AND m.status='active' AND m.trashed_at IS NULL
      WHERE o.id=$1::uuid AND o.pipeline_id=$2::uuid AND o.reference_code=$3
        AND p.workspace_organization_id=$4::uuid AND p.reference_access_disabled=false
        AND o.workspace_organization_id IS NULL
        AND lower(btrim(COALESCE(o.account_type,'')))='customer'
        AND COALESCE(lower(o.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
        AND (m.role='owner' OR COALESCE((m.permissions->>'viewCrm')::boolean,true))
        AND (p.owner_email=u.email OR EXISTS(SELECT 1 FROM pipeline_space_members pm
          WHERE pm.pipeline_id=p.id AND pm.user_email=u.email AND pm.access_role='editor'))
      FOR SHARE OF o,p,u,m,w`, [scope.accountId, scope.pipelineId, scope.accountGlobalId, scope.workspaceId, actorEmail])
    if (current.rows.length !== 1) throw new CustomerFolderHeldError('customer_folder_account_or_editor_unavailable')
    return current.rows[0]
  }
  async function read(client: PoolClient, scope: CustomerFolderScope) {
    const result = await client.query<{ plan: CustomerFolderPlan }>(
      'SELECT plan FROM crm_customer_drive_folders WHERE account_id=$1::uuid FOR UPDATE', [scope.accountId])
    if (!result.rows[0]) return null
    const plan = result.rows[0].plan
    assertCustomerFolderPlan(plan, scope)
    return plan
  }
  return {
    read: scope => withTransaction(async client => { await authorize(client, scope); return read(client, scope) }),
    reserve: candidate => withTransaction(async client => {
      assertCustomerFolderPlan(candidate, candidate.scope)
      const scope = candidate.scope
      const current = await authorize(client, scope)
      const existing = await read(client, scope)
      if (existing) return existing
      // Catch a pre-existing manual reference before any provider create. An
      // explicit root adoption may preserve that reference without repointing.
      prepareCustomerFolderPublication({ description: current.description ?? '', rootId: candidate.nodes[0].id,
        status: 'pending', adopted: candidate.nodes[0].adopted })
      await client.query(`INSERT INTO crm_customer_drive_folders(
        account_id,pipeline_id,workspace_id,account_global_id,shared_drive_id,customers_parent_id,service_account_email,plan,created_by)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9)`,
      [scope.accountId,scope.pipelineId,scope.workspaceId,scope.accountGlobalId,scope.sharedDriveId,
        scope.customersParentId,scope.serviceAccountEmail,JSON.stringify(candidate),actorEmail])
      return candidate
    }),
    complete: plan => withTransaction(async client => {
      assertCustomerFolderPlan(plan, plan.scope)
      // Publication restages the Account and its native outbox. Take native
      // control before lifecycle/account/card locks, never over provider I/O.
      await lockCrmNativeEmailAuthorityWithClient(client)
      await authorize(client, plan.scope)
      const reserved = await client.query<{ publication_status: CustomerFolderPublicationStatus }>(
        `SELECT publication_status FROM crm_customer_drive_folders
         WHERE account_id=$1::uuid AND plan=$2::jsonb FOR UPDATE`, [plan.scope.accountId,JSON.stringify(plan)])
      if (reserved.rows.length !== 1) throw new CustomerFolderHeldError('customer_folder_reservation_changed')
      const account = await client.query<{ description: string | null }>(
        'SELECT description FROM crm_organizations WHERE id=$1::uuid AND pipeline_id=$2::uuid FOR UPDATE',
        [plan.scope.accountId,plan.scope.pipelineId])
      if (account.rows.length !== 1) throw new CustomerFolderHeldError('customer_folder_account_or_editor_unavailable')
      const current = account.rows[0].description ?? ''
      const publication = prepareCustomerFolderPublication({ description: current, rootId: plan.nodes[0].id,
        status: reserved.rows[0].publication_status, adopted: plan.nodes[0].adopted })
      if (publication.description !== current) {
        const staged = await updateCrmDescriptionWithClient(client, { entity: 'organizations', pipelineId: plan.scope.pipelineId,
          id: plan.scope.accountId, description: publication.description, actorEmail })
        if (staged.id !== plan.scope.accountId || staged.referenceCode !== plan.scope.accountGlobalId) {
          throw new CustomerFolderHeldError('customer_folder_publication_identity_changed')
        }
      }
      const result = await client.query(`UPDATE crm_customer_drive_folders
        SET status='ready',publication_status=$3,verified_at=now()
        WHERE account_id=$1::uuid AND plan=$2::jsonb RETURNING account_id`,
      [plan.scope.accountId,JSON.stringify(plan),publication.status])
      if (result.rows.length !== 1) throw new CustomerFolderHeldError('customer_folder_reservation_changed')
    }),
  }
}
