import { nativeEmailCanonicalJson, requireNativeEmail } from './nativeEmailPublication'

export type RootEmployeeCrmRegistryTable = 'account' | 'binding' | 'grant'
export type RootEmployeeCrmRegistryChange = {
  kind: 'root_registry_v1'
  workspaceId: string
  operatorAccountId: string
  ownerEmail: string
  actorScope: { workspaceId: string; ancestryJson: string }
  contextFingerprint: string
  changes: Array<{ table: RootEmployeeCrmRegistryTable; beforeJson: string | null; afterJson: string }>
}

// Authority projections only. Audit timestamps are deliberately not encoded as
// permission state; the SQL writer must preserve originals and set actor audit
// fields independently. This contract is private plan data, never a user DTO.
export const ROOT_CRM_REGISTRY_KEYS = {
  account: ['id', 'root_workspace_id', 'owner_email', 'enabled', 'revision'],
  binding: ['operator_account_id', 'workspace_id', 'owner_email', 'enabled', 'revision'],
  grant: ['id', 'operator_account_id', 'user_email', 'source_workspace_id', 'enabled', 'revision'],
} as const
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/
type Row = Record<string, unknown>
function exact(value: unknown, keys: readonly string[]): asserts value is Row {
  requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value)
    && nativeEmailCanonicalJson(Object.keys(value).sort()) === nativeEmailCanonicalJson([...keys].sort()), 'root_registry_change_shape')
}
function uuid(value: unknown) { requireNativeEmail(typeof value === 'string' && UUID.test(value), 'root_registry_identity') }
function email(value: unknown) {
  requireNativeEmail(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 320
    && EMAIL.test(value) && value === value.toLowerCase(), 'root_registry_identity')
}
function parsed(value: unknown): unknown {
  requireNativeEmail(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 4096, 'root_registry_row_invalid')
  let result: unknown
  try { result = JSON.parse(value) } catch { requireNativeEmail(false, 'root_registry_row_invalid') }
  requireNativeEmail(nativeEmailCanonicalJson(result) === value, 'root_registry_row_noncanonical')
  return result
}
function row(value: unknown, table: RootEmployeeCrmRegistryTable): Row {
  const result = parsed(value); exact(result, ROOT_CRM_REGISTRY_KEYS[table])
  requireNativeEmail(typeof result.enabled === 'boolean' && typeof result.revision === 'string'
    && /^[1-9][0-9]{0,15}(?![\s\S])/.test(result.revision) && Number.isSafeInteger(Number(result.revision))
    && String(Number(result.revision)) === result.revision, 'root_registry_revision')
  if (table === 'account') { uuid(result.id); uuid(result.root_workspace_id); email(result.owner_email) }
  else if (table === 'binding') { uuid(result.operator_account_id); uuid(result.workspace_id); email(result.owner_email) }
  else { uuid(result.id); uuid(result.operator_account_id); uuid(result.source_workspace_id); email(result.user_email) }
  return result
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

/** Exact proposed registry delta only. No actor authorization, current-row
 * discovery, native approval, admission, write or access is supplied here.
 * The coordinator must derive the complete locked app/native before/after
 * inventories and recheck this source at every phase. No browser source hints,
 * email-domain inference or mutable default workspace is accepted. */
export function prepareRootEmployeeCrmRegistryChange(value: unknown): RootEmployeeCrmRegistryChange {
  exact(value, ['kind', 'workspaceId', 'operatorAccountId', 'ownerEmail', 'actorScope', 'contextFingerprint', 'changes'])
  requireNativeEmail(value.kind === 'root_registry_v1', 'root_registry_change_kind')
  uuid(value.workspaceId); uuid(value.operatorAccountId); email(value.ownerEmail)
  requireNativeEmail(typeof value.contextFingerprint === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value.contextFingerprint), 'root_registry_context')
  exact(value.actorScope, ['workspaceId', 'ancestryJson'])
  const ancestry = parsed(value.actorScope.ancestryJson)
  requireNativeEmail(value.actorScope.workspaceId === value.workspaceId && Array.isArray(ancestry) && ancestry.length === 1, 'root_registry_actor_scope')
  exact(ancestry[0], ['id', 'parent_id', 'is_demo'])
  requireNativeEmail(ancestry[0].id === value.workspaceId && ancestry[0].parent_id === null && ancestry[0].is_demo === false, 'root_registry_actor_scope')
  requireNativeEmail(Array.isArray(value.changes) && value.changes.length > 0 && value.changes.length <= 100, 'root_registry_change_bound')
  const grants = new Set<string>(); let previous = ''
  for (const change of value.changes) {
    exact(change, ['table', 'beforeJson', 'afterJson'])
    requireNativeEmail(change.table === 'account' || change.table === 'binding' || change.table === 'grant', 'root_registry_table')
    const table = change.table, after = row(change.afterJson, table)
    const before = change.beforeJson === null ? null : row(change.beforeJson, table)
    if (table === 'account') requireNativeEmail(after.id === value.operatorAccountId && after.root_workspace_id === value.workspaceId
      && after.owner_email === value.ownerEmail, 'root_registry_account_scope')
    else {
      requireNativeEmail(after.operator_account_id === value.operatorAccountId, 'root_registry_account_scope')
      if (table === 'binding') requireNativeEmail(after.owner_email === value.ownerEmail, 'root_registry_account_scope')
      else {
        requireNativeEmail(after.source_workspace_id === value.workspaceId && after.user_email !== value.ownerEmail, 'root_registry_grant_scope')
        requireNativeEmail(!grants.has(String(after.user_email)), 'root_registry_duplicate')
        grants.add(String(after.user_email))
      }
    }
    const key = table + ':' + String(table === 'binding' ? after.workspace_id : after.id)
    requireNativeEmail(previous < key, 'root_registry_duplicate_or_order'); previous = key
    if (before) {
      requireNativeEmail(after.revision === String(Number(before.revision) + 1) && after.enabled !== before.enabled
        && nativeEmailCanonicalJson({ ...before, enabled: after.enabled, revision: after.revision }) === change.afterJson, 'root_registry_delta_invalid')
    } else requireNativeEmail(after.revision === '1', 'root_registry_revision')
  }
  requireNativeEmail(Buffer.byteLength(nativeEmailCanonicalJson(value), 'utf8') <= 64000, 'root_registry_change_bound')
  return freeze(JSON.parse(nativeEmailCanonicalJson(value)) as RootEmployeeCrmRegistryChange)
}
