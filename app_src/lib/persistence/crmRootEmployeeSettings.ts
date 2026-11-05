import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withTransaction } from './postgres'
import { lockCrmNativeEmailAuthorityWithClient } from './crmNativeEmailAuthority'
import { recordAuditEvent } from '../auditWriter'
import { nativeEmailCanonicalJson as json, nativeEmailDigest } from '../crm/nativeEmailPublication'
import { prepareRootEmployeeCrmRegistryChange, type RootEmployeeCrmRegistryChange } from '../crm/rootEmployeeCrmRegistryChange'
import { RootCrmSettingsError, parseRootCrmSettingsRequest, type RootCrmSettings } from '../crm/rootEmployeeCrmSettings'
import { changeRootEmployeeCrmRegistryWithNativeAuthority, getPendingRootEmployeeCrmRegistryChange,
  resumeRootEmployeeCrmRegistryChange } from '../crm/nativeEmailRootRegistryRuntime'
import { NativeEmailAccessPendingError } from '../crm/nativeEmailAuthorityRuntime'

type Row = Record<string, unknown>
type Registry = { account: Row | null; bindings: Row[]; grants: Row[] }
type Client = Pick<PoolClient, 'query'>
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
async function owner(client: Client, actorEmail: string, workspaceId: string) {
  if (!UUID.test(workspaceId) || actorEmail !== actorEmail.toLowerCase()) throw new RootCrmSettingsError('Owner access is required.', 403)
  const rows = (await client.query(`SELECT w.id::text,w.name FROM workspace_organizations w
    JOIN app_user_organization_memberships m ON m.organization_id=w.id AND m.user_email=$1
    JOIN app_users u ON u.email=m.user_email WHERE w.id=$2::uuid AND w.parent_id IS NULL AND w.organization_type='root'
      AND NOT w.is_demo AND u.status='active' AND m.status='active' AND m.role='owner' AND m.trashed_at IS NULL`, [actorEmail,workspaceId])).rows
  if (rows.length !== 1) throw new RootCrmSettingsError('The active organization owner must manage company-wide CRM access.', 403)
  return rows[0] as { id: string; name: string }
}
async function registry(client: Client, actorEmail: string, workspaceId: string): Promise<Registry> {
  const accounts = (await client.query(`SELECT clawpilot_crm_root_registry_projection('account',to_jsonb(a)) AS row
    FROM crm_operator_accounts a WHERE root_workspace_id=$1::uuid`, [workspaceId])).rows
  const account = (accounts[0]?.row ?? null) as Row | null
  if (accounts.length > 1 || account && account.owner_email !== actorEmail) throw new RootCrmSettingsError('This CRM account belongs to its original owner.', 403)
  if (!account) return { account: null, bindings: [], grants: [] }
  const bindings = (await client.query(`SELECT clawpilot_crm_root_registry_projection('binding',to_jsonb(b)) AS row
    FROM crm_operator_workspace_bindings b WHERE operator_account_id=$1::uuid ORDER BY workspace_id LIMIT 101`, [account.id])).rows.map(row => row.row as Row)
  const grants = (await client.query(`SELECT clawpilot_crm_root_registry_projection('grant',to_jsonb(g)) AS row
    FROM crm_root_employee_access_grants g WHERE operator_account_id=$1::uuid ORDER BY id LIMIT 501`, [account.id])).rows.map(row => row.row as Row)
  if (bindings.length > 100 || grants.length > 500) throw new RootCrmSettingsError('CRM access inventory requires review.', 409)
  return { account, bindings, grants }
}
function version(workspaceId: string, value: Registry) { return nativeEmailDigest([workspaceId,value.account,value.bindings,value.grants]) }
async function ownedWorkspaces(client: Client, actorEmail: string, accountId: unknown) {
  return (await client.query(`SELECT w.id::text,w.name,NOT EXISTS(SELECT 1 FROM crm_operator_workspace_bindings b
      WHERE b.workspace_id=w.id AND b.enabled AND b.operator_account_id IS DISTINCT FROM $2::uuid) AS available FROM workspace_organizations w
    JOIN app_user_organization_memberships m ON m.organization_id=w.id AND m.user_email=$1
    JOIN app_users u ON u.email=m.user_email WHERE m.role='owner' AND m.status='active' AND m.trashed_at IS NULL
      AND u.status='active' AND NOT w.is_demo ORDER BY w.name,w.id LIMIT 101`, [actorEmail,accountId??null])).rows as Array<{id:string;name:string;available:boolean}>
}

export async function readRootEmployeeCrmSettings(actorEmail: string, workspaceId: string): Promise<RootCrmSettings> {
  const state = await withTransaction(async client => {
    const selected = await owner(client,actorEmail,workspaceId), current = await registry(client,actorEmail,workspaceId)
    const options = await ownedWorkspaces(client,actorEmail,current.account?.id)
    if (options.length > 100) throw new RootCrmSettingsError('Select a smaller explicit CRM business scope with support.', 409)
    const staff = (await client.query(`SELECT u.email,u.display_name,CASE WHEN u.status<>'active' THEN u.status ELSE m.status END AS status,m.permissions,m.role FROM app_users u
      JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=$1::uuid
      WHERE u.email<>$2 AND m.trashed_at IS NULL ORDER BY u.email LIMIT 501`, [workspaceId,actorEmail])).rows
    if (staff.length > 500) throw new RootCrmSettingsError('Employee scope requires review.', 409)
    const missing = current.bindings.filter(row => !options.some(option => option.id === row.workspace_id))
    return { workspaceId,workspaceName:selected.name,registryVersion:version(workspaceId,current),configured:!!current.account,
      enabled:current.account?.enabled === true,
      workspaces:[...options.map(option => ({ ...option,selected:current.bindings.some(row => row.workspace_id===option.id&&row.enabled===true) })),
        ...missing.map(row => ({id:String(row.workspace_id),name:'Previously linked business (ownership unavailable)',selected:row.enabled===true,available:false}))],
      employees:staff.map(row => ({email:String(row.email),displayName:row.display_name as string|null,status:String(row.status),
        crmAllowed:row.role==='owner'||(row.permissions as Row).viewCrm!==false,
        enabled:current.grants.some(grant => grant.user_email===row.email&&grant.enabled===true)})),pending:null }
  })
  const pending = await getPendingRootEmployeeCrmRegistryChange(actorEmail,workspaceId)
  return { ...state,pending:pending?{transitionId:pending.transitionId,changes:pending.changes}:null }
}

/** Exact rows are discovered under the same control lock as every writer.
 * Browser inputs are choices plus a stale-form check, never authority rows,
 * native identities, an operator account ID or a default-workspace hint. */
export async function changeRootEmployeeCrmSettings(actorEmail: string, workspaceId: string, value: unknown): Promise<void> {
  const request = parseRootCrmSettingsRequest(value)
  if (request.action === 'resume') {
    await withTransaction(client => owner(client,actorEmail,workspaceId))
    await resumeRootEmployeeCrmRegistryChange(actorEmail,workspaceId,request.transitionId); return
  }
  const prepared = await withTransaction(async client => {
    await lockCrmNativeEmailAuthorityWithClient(client)
    await owner(client,actorEmail,workspaceId)
    const current = await registry(client,actorEmail,workspaceId)
    if (version(workspaceId,current)!==request.registryVersion) throw new RootCrmSettingsError('CRM access changed. Reload and review the latest settings.',409,'ROOT_CRM_SETTINGS_STALE')
    const control = (await client.query('SELECT enabled,active_operation_id,active_transition_id FROM crm_native_email_publication_control WHERE singleton')).rows[0]
    if (!control || control.active_operation_id || control.active_transition_id) throw new NativeEmailAccessPendingError()
    const accountId = String(current.account?.id ?? randomUUID()), changes:RootEmployeeCrmRegistryChange['changes'] = []
    const add = (table:'account'|'binding'|'grant',before:Row|null,after:Row) => changes.push({table,beforeJson:before?json(before):null,afterJson:json(after)})
    const toggle = (row:Row,enabled:boolean) => ({...row,enabled,revision:String(Number(row.revision)+1)})
    if (request.action === 'configure') {
      const choices = await ownedWorkspaces(client,actorEmail,current.account?.id)
      if (!request.workspaceIds.includes(workspaceId) || request.workspaceIds.some(id => !choices.some(option => option.id===id&&option.available))) {
        throw new RootCrmSettingsError('Include this organization and select only businesses you currently own.',403)
      }
      if (!current.account) add('account',null,{id:accountId,root_workspace_id:workspaceId,owner_email:actorEmail,enabled:request.enabled,revision:'1'})
      else if (current.account.enabled!==request.enabled) add('account',current.account,toggle(current.account,request.enabled))
      const selected = new Set(request.workspaceIds)
      for (const row of current.bindings) if (row.enabled!==selected.has(String(row.workspace_id))) add('binding',row,toggle(row,selected.has(String(row.workspace_id))))
      for (const id of request.workspaceIds) if (!current.bindings.some(row => row.workspace_id===id)) add('binding',null,
        {operator_account_id:accountId,workspace_id:id,owner_email:actorEmail,enabled:true,revision:'1'})
    } else {
      if (!current.account) throw new RootCrmSettingsError('Set up the CRM business scope first.',409)
      if (request.userEmail===actorEmail) throw new RootCrmSettingsError('The owner already manages this CRM scope.',403)
      const employee = (await client.query(`SELECT m.user_email FROM app_user_organization_memberships m
        JOIN app_users u ON u.email=m.user_email WHERE m.organization_id=$1::uuid AND m.user_email=$2 AND m.trashed_at IS NULL`,
      [workspaceId,request.userEmail])).rows
      if (employee.length!==1) throw new RootCrmSettingsError('Select an existing employee in this organization.',403)
      const old = current.grants.find(row => row.user_email===request.userEmail)
      if (old && old.enabled!==request.enabled) add('grant',old,toggle(old,request.enabled))
      else if (!old && request.enabled) add('grant',null,{id:randomUUID(),operator_account_id:accountId,user_email:request.userEmail,
        source_workspace_id:workspaceId,enabled:true,revision:'1'})
    }
    if (!changes.length) return null
    changes.sort((a,b) => {const key=(row:typeof a)=>row.table+':'+String(JSON.parse(row.afterJson)[row.table==='binding'?'workspace_id':'id']);return key(a)<key(b)?-1:key(a)>key(b)?1:0})
    const change = prepareRootEmployeeCrmRegistryChange({kind:'root_registry_v1',workspaceId,operatorAccountId:accountId,ownerEmail:actorEmail,
      actorScope:{workspaceId,ancestryJson:json([{id:workspaceId,parent_id:null,is_demo:false}])},contextFingerprint:'0'.repeat(64),changes})
    if (control.enabled) return change
    // The disabled-policy path stays in this locked owner-authorized transaction.
    // Original row guards enforce ownership/FKs/revisions and invalidate pins.
    for (const delta of change.changes) {
      const row=JSON.parse(delta.afterJson) as Row
      const table=delta.table==='account'?'crm_operator_accounts':delta.table==='binding'?'crm_operator_workspace_bindings':'crm_root_employee_access_grants'
      const fields=Object.keys(row)
      const result = delta.beforeJson===null
        ? await client.query(`INSERT INTO ${table}(${fields.join(',')},created_by,updated_by)
          SELECT ${fields.map(key=>'r.'+key).join(',')},$2,$2 FROM jsonb_populate_record(NULL::${table},$1::jsonb) r RETURNING 1`,[delta.afterJson,actorEmail])
        : await client.query(`UPDATE ${table} SET enabled=$1,revision=$2::bigint,updated_by=$3,updated_at=clock_timestamp()
          WHERE ${delta.table==='binding'?'workspace_id':'id'}=$4::uuid
            AND clawpilot_crm_root_registry_projection($5,to_jsonb(${table}))=$6::jsonb RETURNING 1`,
        [row.enabled,row.revision,actorEmail,delta.table==='binding'?row.workspace_id:row.id,delta.table,delta.beforeJson])
      if(result.rowCount!==1)throw new RootCrmSettingsError('CRM access changed. Reload before saving.',409,'ROOT_CRM_SETTINGS_STALE')
    }
    await recordAuditEvent({actor:actorEmail,eventType:'crm.root_access.changed',aggregateType:'crm_operator_account',aggregateId:accountId,
      organizationId:workspaceId,payload:{nativeAuthority:false,changes:changes.length}},client)
    return null
  })
  if (prepared && !await changeRootEmployeeCrmRegistryWithNativeAuthority(actorEmail,workspaceId,prepared)) {
    // A policy switch between preview and coordinator must never fall through
    // into a second, unaudited legacy mutation. Refresh to start a new request.
    throw new NativeEmailAccessPendingError()
  }
}
