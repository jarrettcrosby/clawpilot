import type { NativeEmailSqlClient } from '../crm/nativeEmailPublicationPostgres'
import { lockCrmNativeEmailAuthorityWithClient } from './crmNativeEmailAuthority'
import { deriveRootEmployeeCrmReadScope, type RootEmployeeCrmAccessSource } from '../crm/rootEmployeeCrmAccess'
import { nativeEmailDigest, requireNativeEmail } from '../crm/nativeEmailPublication'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/
type MembershipRow = { organization_id: string; user_email: string; status: 'active' | 'invited' | 'disabled'
  role: 'owner' | 'admin' | 'member'; trashed: boolean; permissions: unknown }
export type RootEmployeeCrmRegistryProjection = {
  account: { id: string; root_workspace_id: string; owner_email: string; enabled: boolean; revision: string }
  grant: { id: string; operator_account_id: string; user_email: string; source_workspace_id: string; enabled: boolean; revision: string }
  bindings: Array<{ operator_account_id: string; workspace_id: string; owner_email: string; enabled: boolean; revision: string }>
  // Absent proposed rows are represented only as disabled preview identities.
  // This is not persisted intent and cannot authorize an application read.
  accountPresent: boolean; grantPresent: boolean
}
type SourceSelection = {
  actorEmail: string; grantId: string
  readInactivePreimage?: boolean
  nativePipelineIds?: string[]
}
function membership(row: MembershipRow | undefined) {
  requireNativeEmail(row, 'root_employee_membership_missing')
  requireNativeEmail(row.permissions && typeof row.permissions === 'object' && !Array.isArray(row.permissions)
    && Object.values(row.permissions).every(value => typeof value === 'boolean'), 'root_employee_permissions_invalid')
  const permission = (row.permissions as Record<string, boolean>).viewCrm
  return { workspaceId: row.organization_id, userEmail: row.user_email, status: row.status,
    role: row.role, trashed: row.trashed, viewCrm: row.role === 'owner' || permission !== false }
}

/** Private source collector for the root-access coordinator. The caller must
 * supply an actual transaction client. Control is locked before every source
 * read; registry writers must share that same fence. Never expose this raw
 * source inventory/native identities as an ordinary user-list response.
 * Collection does not create memberships, activate a grant or bypass native
 * admission. No root visibility may be authorized from this preview alone. */
export async function collectRootEmployeeCrmAccessWithClient(client: NativeEmailSqlClient, input: SourceSelection) {
  return collectSourceWithClient(client, input)
}

/** Private proposed-source reader, never the current access resolver. Only the
 * locked registry coordinator may supply its checked before/after inventory.
 * All users, memberships, workspaces and pipelines still come from live SQL;
 * the projection supplies registry intent only. No temporary INSERT/UPDATE is
 * used to preview an account, binding or employee that does not exist yet. */
export async function collectProposedRootEmployeeCrmAccessWithClient(client: NativeEmailSqlClient,
  input: SourceSelection, projection: RootEmployeeCrmRegistryProjection) {
  requireNativeEmail(projection.account.id === projection.grant.operator_account_id
    && projection.grant.id === input.grantId && projection.account.owner_email === input.actorEmail
    && (projection.accountPresent || !projection.account.enabled)
    && (projection.grantPresent || !projection.grant.enabled), 'root_employee_projection_scope')
  return collectSourceWithClient(client, input, projection)
}

async function collectSourceWithClient(client: NativeEmailSqlClient, input: SourceSelection,
  projection?: RootEmployeeCrmRegistryProjection) {
  requireNativeEmail(typeof input.actorEmail === 'string' && EMAIL.test(input.actorEmail)
    && input.actorEmail === input.actorEmail.toLowerCase() && UUID.test(input.grantId), 'root_employee_selection_invalid')
  await lockCrmNativeEmailAuthorityWithClient(client)
  const read = async <Row,>(sql: string, values: unknown[] = []) => {
    const result = await client.query(sql, values)
    return { rows: result.rows as Row[] }
  }
  if (input.nativePipelineIds) requireNativeEmail(input.nativePipelineIds.length > 0 && input.nativePipelineIds.length <= 100
    && input.nativePipelineIds.every(value => UUID.test(value)), 'root_employee_selection_invalid')
  const control = (await read<{ generation: string; enabled: boolean; active_operation_id: string | null; active_transition_id: string | null }>(
    'SELECT generation::text,enabled,active_operation_id,active_transition_id FROM crm_native_email_publication_control WHERE singleton')).rows[0]
  requireNativeEmail(control, 'root_employee_control_missing')
  const found = await read<{
    account_id: string; root_workspace_id: string; owner_email: string; account_enabled: boolean; account_revision: string
    grant_id: string; user_email: string; source_workspace_id: string; grant_enabled: boolean; grant_revision: string
    root_parent_id: string | null; root_type: 'root'; root_is_demo: boolean
    operator_status: 'active' | 'invited' | 'disabled'; user_status: 'active' | 'invited' | 'disabled'
    suitecrm_user_id: string | null; native_identity_count: number
  }>(`${projection ? `WITH projected_accounts AS (
      SELECT * FROM jsonb_populate_record(NULL::crm_operator_accounts,$2::jsonb)), projected_grants AS (
      SELECT * FROM jsonb_populate_record(NULL::crm_root_employee_access_grants,$3::jsonb))` : ''}
    SELECT a.id::text AS account_id,a.root_workspace_id::text,a.owner_email,a.enabled AS account_enabled,
    a.revision::text AS account_revision,g.id::text AS grant_id,g.user_email,g.source_workspace_id::text,
    g.enabled AS grant_enabled,g.revision::text AS grant_revision,w.parent_id::text AS root_parent_id,
    w.organization_type AS root_type,w.is_demo AS root_is_demo,operator.status AS operator_status,
    employee.status AS user_status,employee.suitecrm_user_id,
    (SELECT count(*)::int FROM app_users duplicate WHERE lower(duplicate.suitecrm_user_id)=lower(employee.suitecrm_user_id)) AS native_identity_count
    FROM ${projection ? 'projected_grants' : 'crm_root_employee_access_grants'} g
    JOIN ${projection ? 'projected_accounts' : 'crm_operator_accounts'} a ON a.id=g.operator_account_id
    JOIN workspace_organizations w ON w.id=a.root_workspace_id JOIN app_users operator ON operator.email=a.owner_email
    JOIN app_users employee ON employee.email=g.user_email WHERE g.id=$1::uuid`, projection
      ? [input.grantId, JSON.stringify(projection.account), JSON.stringify(projection.grant)] : [input.grantId])
  requireNativeEmail(found.rows.length === 1, 'root_employee_grant_missing')
  const row = found.rows[0]
  requireNativeEmail(row.owner_email === input.actorEmail, 'root_employee_actor_not_owner')
  const bindings = (await read<{ operator_account_id: string; workspace_id: string; enabled: boolean; revision: string; is_demo: boolean }>(
    `${projection ? `WITH projected_bindings AS (
       SELECT * FROM jsonb_populate_recordset(NULL::crm_operator_workspace_bindings,$2::jsonb))` : ''}
     SELECT b.operator_account_id::text,b.workspace_id::text,b.enabled,b.revision::text,w.is_demo
     FROM ${projection ? 'projected_bindings' : 'crm_operator_workspace_bindings'} b
     JOIN workspace_organizations w ON w.id=b.workspace_id
     WHERE b.operator_account_id=$1::uuid ORDER BY b.workspace_id LIMIT 101`, projection
      ? [row.account_id, JSON.stringify(projection.bindings)] : [row.account_id])).rows
  requireNativeEmail(!projection || bindings.length === projection.bindings.length, 'root_employee_projection_workspace_missing')
  requireNativeEmail(bindings.length <= 100, 'root_employee_inventory_bound')
  const workspaceIds = [...new Set([row.root_workspace_id, ...bindings.map(binding => binding.workspace_id)])].sort()
  const members = (await read<MembershipRow>(`SELECT organization_id::text,user_email,status,role,
    trashed_at IS NOT NULL AS trashed,permissions FROM app_user_organization_memberships
    WHERE organization_id=ANY($1::uuid[]) AND user_email=ANY($2::text[]) ORDER BY organization_id,user_email`,
  [workspaceIds, [row.owner_email, row.user_email]])).rows
  const member = (workspaceId: string, userEmail: string) => {
    const selected = members.filter(value => value.organization_id === workspaceId && value.user_email === userEmail)
    requireNativeEmail(selected.length <= 1, 'root_employee_membership_ambiguous')
    return selected[0]
  }
  const operatorMembership = membership(member(row.root_workspace_id, row.owner_email))
  requireNativeEmail(input.readInactivePreimage === true || row.operator_status === 'active' && operatorMembership.role === 'owner'
    && operatorMembership.status === 'active' && !operatorMembership.trashed, 'root_employee_actor_not_owner')
  const pipelines = (await read<{ id: string; workspace_id: string; reference_access_disabled: boolean }>(
    `SELECT id::text,workspace_organization_id::text AS workspace_id,reference_access_disabled FROM pipeline_spaces
     WHERE workspace_organization_id=ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[]))
     ORDER BY workspace_organization_id,id LIMIT 10001`, [workspaceIds,input.nativePipelineIds ?? null])).rows
  const boards = input.nativePipelineIds ? [] : (await read<{ id: string; workspace_id: string; pipeline_id: string }>(
    `SELECT b.id::text,b.workspace_organization_id::text AS workspace_id,p.pipeline_id::text
     FROM project_boards b JOIN crm_board_projections p ON p.board_id=b.id
     WHERE b.workspace_organization_id=ANY($1::uuid[]) AND p.workspace_organization_id=b.workspace_organization_id
     ORDER BY b.workspace_organization_id,b.id LIMIT 50001`, [workspaceIds])).rows
  requireNativeEmail(pipelines.length <= 10_000 && boards.length <= 50_000, 'root_employee_inventory_bound')
  const source: RootEmployeeCrmAccessSource = {
    version: 1, anchor: { id: row.account_id, rootWorkspaceId: row.root_workspace_id, ownerEmail: row.owner_email, enabled: row.account_enabled },
    rootWorkspace: { id: row.root_workspace_id, parentId: row.root_parent_id as null, organizationType: row.root_type, isDemo: row.root_is_demo },
    operator: { email: row.owner_email, status: row.operator_status, membership: operatorMembership },
    grant: { id: row.grant_id, anchorId: row.account_id, userEmail: row.user_email, sourceWorkspaceId: row.source_workspace_id, enabled: row.grant_enabled },
    user: { email: row.user_email, status: row.user_status, suiteCrmUserId: row.suitecrm_user_id, nativeIdentityCount: row.native_identity_count },
    sourceMembership: membership(member(row.source_workspace_id, row.user_email)),
    targets: bindings.filter(binding => binding.enabled).map(binding => ({ anchorId: binding.operator_account_id,
      workspaceId: binding.workspace_id, isDemo: binding.is_demo,
      ownerMembership: membership(member(binding.workspace_id, row.owner_email)),
      employeeMembership: member(binding.workspace_id, row.user_email) ? membership(member(binding.workspace_id, row.user_email)) : null,
      pipelines: pipelines.filter(value => value.workspace_id === binding.workspace_id).map(value => ({ id: value.id, referenceAccessDisabled: value.reference_access_disabled })),
      boards: boards.filter(value => value.workspace_id === binding.workspace_id).map(value => ({ id: value.id, kind: 'crm_projection', pipelineId: value.pipeline_id })),
    })),
  }
  const scope = deriveRootEmployeeCrmReadScope(source)
  // Native generation is a separate phase fence: revoke/grant legitimately
  // advance it without modifying registry intent. Do not bake that counter
  // into a registry preimage that must survive both phases unchanged.
  return { source, scope, nativeControl: control, registryHash: nativeEmailDigest({
    accountId: row.account_id, accountRevision: row.account_revision,
    grantId: row.grant_id, grantRevision: row.grant_revision,
    bindings: bindings.map(binding => ({ workspaceId: binding.workspace_id, enabled: binding.enabled, revision: binding.revision })),
    ...(projection && (!projection.accountPresent || !projection.grantPresent)
      ? { accountPresent: projection.accountPresent, grantPresent: projection.grantPresent } : {}) }) }
}
