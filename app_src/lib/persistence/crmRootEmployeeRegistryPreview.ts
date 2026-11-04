import type { NativeEmailSqlClient } from '../crm/nativeEmailPublicationPostgres'
import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from '../crm/nativeEmailPublication'
import { ROOT_CRM_REGISTRY_KEYS, prepareRootEmployeeCrmRegistryChange,
  type RootEmployeeCrmRegistryChange, type RootEmployeeCrmRegistryTable } from '../crm/rootEmployeeCrmRegistryChange'
import { lockCrmNativeEmailAuthorityWithClient } from './crmNativeEmailAuthority'
import { collectProposedRootEmployeeCrmAccessWithClient, type RootEmployeeCrmRegistryProjection } from './crmRootEmployeeAccess'

type Row = Record<string, unknown>
type Registry = Record<RootEmployeeCrmRegistryTable, Row[]>
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const key = (table: RootEmployeeCrmRegistryTable, row: Row) => String(table === 'binding' ? row.workspace_id : row.id)
const ordered = (table: RootEmployeeCrmRegistryTable, rows: Row[]) => rows.sort((a, b) => key(table, a).localeCompare(key(table, b)))
const projection = (table: RootEmployeeCrmRegistryTable, alias: string) =>
  `jsonb_build_object(${ROOT_CRM_REGISTRY_KEYS[table].map(name => `'${name}',${alias}.${name}${name === 'revision' ? '::text' : ''}`).join(',')})`

/** Locked, owner-authorized, READ-ONLY proposed registry source inventory.
 * This is not admission, a permission receipt, activation or a user DTO. The
 * later coordinator must compare contextFingerprint and both full snapshots
 * on every phase, then use an exact SQL delta ledger after native revoke.
 * Never call this over provider I/O or authorize reads from its proposed scope.
 * `current` identifies which exact registry preimage should exist now; it is
 * checked, not a request to write or advance a phase. */
export async function collectRootEmployeeCrmRegistryPreviewWithClient(client: NativeEmailSqlClient, input: {
  actorEmail: string; actorWorkspaceId: string; change: RootEmployeeCrmRegistryChange
  pipelineIds: string[]; current: 'before' | 'after'
}) {
  const change = prepareRootEmployeeCrmRegistryChange(input.change)
  requireNativeEmail(input.actorEmail === change.ownerEmail && input.actorWorkspaceId === change.workspaceId
    && (input.current === 'before' || input.current === 'after'), 'root_registry_actor_denied')
  requireNativeEmail(input.pipelineIds.length > 0 && input.pipelineIds.length <= 100
    && input.pipelineIds.every(id => UUID.test(id))
    && nativeEmailCanonicalJson(input.pipelineIds) === nativeEmailCanonicalJson([...new Set(input.pipelineIds)].sort()), 'authority_pipeline_scope')
  await lockCrmNativeEmailAuthorityWithClient(client)
  const actor = (await client.query(`SELECT w.id::text,w.parent_id::text,w.organization_type,w.is_demo,u.status AS user_status,
    m.status,m.role,m.trashed_at IS NOT NULL AS trashed,m.permissions::text AS permissions_json
    FROM workspace_organizations w JOIN app_user_organization_memberships m ON m.organization_id=w.id AND m.user_email=$2
    JOIN app_users u ON u.email=m.user_email WHERE w.id=$1::uuid`, [change.workspaceId, input.actorEmail])).rows
  requireNativeEmail(actor.length === 1 && actor[0].parent_id === null && actor[0].organization_type === 'root'
    && actor[0].is_demo === false && actor[0].user_status === 'active' && actor[0].status === 'active'
    && actor[0].role === 'owner' && actor[0].trashed === false, 'root_registry_actor_denied')
  const account = (await client.query(`SELECT ${projection('account', 'a')} AS authority FROM crm_operator_accounts a
    WHERE a.id=$1::uuid OR a.root_workspace_id=$2::uuid ORDER BY a.id LIMIT 2`, [change.operatorAccountId, change.workspaceId])).rows
  requireNativeEmail(account.length <= 1 && account.every(row => (row.authority as Row).id === change.operatorAccountId
    && (row.authority as Row).root_workspace_id === change.workspaceId
    && (row.authority as Row).owner_email === change.ownerEmail), 'root_registry_account_conflict')
  const selectedBindings = change.changes.filter(row => row.table === 'binding').map(row => JSON.parse(row.afterJson).workspace_id)
  const selectedGrants = change.changes.filter(row => row.table === 'grant').map(row => JSON.parse(row.afterJson).id)
  const bindings = (await client.query(`SELECT ${projection('binding', 'b')} AS authority FROM crm_operator_workspace_bindings b
    WHERE b.operator_account_id=$1::uuid OR b.workspace_id=ANY($2::uuid[]) ORDER BY b.operator_account_id,b.workspace_id LIMIT 202`,
  [change.operatorAccountId, selectedBindings])).rows.map(row => row.authority as Row)
  requireNativeEmail(bindings.length <= 201, 'root_registry_inventory_bound')
  const grants = (await client.query(`SELECT ${projection('grant', 'g')} AS authority FROM crm_root_employee_access_grants g
    WHERE g.operator_account_id=$1::uuid OR g.id=ANY($2::uuid[]) ORDER BY g.id LIMIT 602`,
  [change.operatorAccountId, selectedGrants])).rows.map(row => row.authority as Row)
  requireNativeEmail(grants.length <= 601 && grants.every(row => row.operator_account_id === change.operatorAccountId),
    'root_registry_grant_conflict_or_bound')
  const live: Registry = { account: account.map(row => row.authority as Row),
    binding: bindings.filter(row => row.operator_account_id === change.operatorAccountId), grant: grants }
  requireNativeEmail(live.binding.length <= 100 && live.grant.length <= 500, 'root_registry_inventory_bound')
  const before = JSON.parse(nativeEmailCanonicalJson(live)) as Registry
  const after = JSON.parse(nativeEmailCanonicalJson(live)) as Registry
  for (const delta of change.changes) {
    const next = JSON.parse(delta.afterJson) as Row, logicalKey = key(delta.table, next)
    const current = live[delta.table].filter(row => key(delta.table, row) === logicalKey)
    requireNativeEmail(current.length <= 1 && nativeEmailCanonicalJson(current[0] ?? null)
      === (input.current === 'before' ? delta.beforeJson ?? 'null' : delta.afterJson), 'root_registry_preimage_changed')
    before[delta.table] = before[delta.table].filter(row => key(delta.table, row) !== logicalKey)
    after[delta.table] = after[delta.table].filter(row => key(delta.table, row) !== logicalKey)
    if (delta.beforeJson !== null) before[delta.table].push(JSON.parse(delta.beforeJson) as Row)
    after[delta.table].push(next)
    if (delta.table === 'binding' && next.enabled) requireNativeEmail(!bindings.some(row => row.operator_account_id !== change.operatorAccountId
      && row.workspace_id === next.workspace_id && row.enabled === true), 'root_registry_binding_conflict')
  }
  for (const stage of [before, after]) {
    for (const table of ['account', 'binding', 'grant'] as const) ordered(table, stage[table])
    requireNativeEmail(stage.account.length <= 1 && stage.binding.length <= 100 && stage.grant.length <= 500
      && new Set(stage.grant.map(row => row.user_email)).size === stage.grant.length, 'root_registry_inventory_bound_or_duplicate')
  }
  requireNativeEmail(after.account.length === 1, 'root_registry_account_missing')
  const workspaces = [...new Set([change.workspaceId, ...before.binding.map(row => String(row.workspace_id)),
    ...after.binding.map(row => String(row.workspace_id))])].sort()
  const targetOwners = (await client.query(`SELECT w.id::text,w.is_demo,u.status AS user_status,m.status,m.role,
    m.trashed_at IS NOT NULL AS trashed FROM workspace_organizations w
    LEFT JOIN app_user_organization_memberships m ON m.organization_id=w.id AND m.user_email=$2
    LEFT JOIN app_users u ON u.email=m.user_email WHERE w.id=ANY($1::uuid[]) ORDER BY w.id`, [workspaces, change.ownerEmail])).rows
  requireNativeEmail(targetOwners.length === workspaces.length, 'root_registry_workspace_missing')
  for (const delta of change.changes.filter(row => row.table === 'binding')) {
    const next = JSON.parse(delta.afterJson) as Row
    const target = targetOwners.find(row => row.id === next.workspace_id)
    if (delta.beforeJson === null || next.enabled) requireNativeEmail(target?.is_demo === false && target.user_status === 'active'
      && target.status === 'active' && target.role === 'owner' && target.trashed === false, 'root_registry_target_not_owned')
  }
  const pipelines = (await client.query(`SELECT id::text,workspace_organization_id::text AS workspace_id,reference_access_disabled
    FROM pipeline_spaces WHERE workspace_organization_id=ANY($1::uuid[]) ORDER BY id LIMIT 101`, [workspaces])).rows
  requireNativeEmail(pipelines.length <= 100, 'root_registry_pipeline_coverage')
  const omitted = pipelines.filter(row => row.reference_access_disabled === false && !input.pipelineIds.includes(String(row.id)))
  for (const pipeline of omitted) {
    const proof = (await client.query('SELECT public.clawpilot_crm_native_unmanaged_pipeline_retained($1::uuid) AS unmanaged', [pipeline.id])).rows
    requireNativeEmail(proof.length === 1 && proof[0].unmanaged === true, 'root_registry_pipeline_coverage')
  }
  // The complete pipeline inventory below remains in contextFingerprint; an
  // omitted app-only scope is not erased from app/root authorization evidence.
  const grantIds = [...new Set([...before.grant, ...after.grant].map(row => String(row.id)))].sort()
  const collect = async (stage: Registry) => {
    const account = stage.account[0] ?? { ...after.account[0], enabled: false }
    const sources = []
    for (const grantId of grantIds) {
      const present = stage.grant.find(row => row.id === grantId)
      const grant = present ?? { ...after.grant.find(row => row.id === grantId)!, enabled: false }
      const selected = await collectProposedRootEmployeeCrmAccessWithClient(client,
        { actorEmail: change.ownerEmail, grantId, readInactivePreimage: true, nativePipelineIds: input.pipelineIds },
        { account, grant, bindings: stage.binding, accountPresent: stage.account.length === 1,
          grantPresent: !!present } as RootEmployeeCrmRegistryProjection)
      sources.push({ source: selected.source, registryHash: selected.registryHash })
    }
    return sources
  }
  const beforeSources = await collect(before), afterSources = await collect(after)
  // Actual source metadata and the full before/after intent remain stable
  // across native generation changes and the exact eventual app commit.
  const contextFingerprint = nativeEmailDigest({ actor: actor[0], targetOwners, pipelines, before, after,
    beforeSources, afterSources })
  return { before: beforeSources, after: afterSources, registryBefore: before, registryAfter: after, contextFingerprint }
}
