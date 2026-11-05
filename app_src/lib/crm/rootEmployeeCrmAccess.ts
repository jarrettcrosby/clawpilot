import { nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'

type Status = 'active' | 'invited' | 'disabled'
type Role = 'owner' | 'admin' | 'member'
type Membership = { workspaceId: string; userEmail: string; status: Status; role: Role; trashed: boolean; viewCrm: boolean }
type ResourceKind = 'workspace' | 'pipeline' | 'crm_board'
type Provenance = { anchorId: string; grantId: string }
export type RootEmployeeCrmAccessSource = {
  version: 1
  // An explicit durable operator-account anchor, not a default-workspace ID,
  // an email domain, a CRM employee identity or a root-looking business name.
  anchor: { id: string; rootWorkspaceId: string; ownerEmail: string; enabled: boolean }
  rootWorkspace: { id: string; parentId: null; organizationType: 'root'; isDemo: boolean }
  operator: { email: string; status: Status; membership: Membership }
  grant: { id: string; anchorId: string; userEmail: string; sourceWorkspaceId: string; enabled: boolean }
  user: { email: string; status: Status; suiteCrmUserId: string | null; nativeIdentityCount: number }
  sourceMembership: Membership
  targets: Array<{
    anchorId: string; workspaceId: string; isDemo: boolean
    ownerMembership: Membership
    // A pre-existing explicit denial or suspended/trashed membership wins over
    // inheritance. Absence means provisioning is needed, never owner access.
    employeeMembership: Membership | null
    pipelines: Array<{ id: string; referenceAccessDisabled: boolean }>
    boards: Array<{ id: string; kind: 'crm_projection' | 'private'; pipelineId: string | null }>
  }>
}
export type RootEmployeeCrmReadEdge = { kind: ResourceKind; resourceId: string; workspaceId: string }
export type RootEmployeeCrmReadScope = {
  version: 1; sourceHash: string; anchorId: string; grantId: string; userEmail: string; suiteCrmUserId: string | null
  enabled: boolean; edges: RootEmployeeCrmReadEdge[]
}
export type RootEmployeeCrmCurrentEdge = RootEmployeeCrmReadEdge & {
  userEmail: string
  // Independent manual authority must be proven separately by the source
  // collector. A changed effective row is not itself proof of a manual grant.
  manualRole: 'owner' | 'editor' | 'viewer' | null
  inherited: Provenance[]
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), 'root_employee_source_shape')
}
function uuid(value: unknown) { requireNativeEmail(typeof value === 'string' && UUID.test(value), 'root_employee_source_identity') }
function email(value: unknown) {
  requireNativeEmail(typeof value === 'string' && EMAIL.test(value) && value === value.toLowerCase(), 'root_employee_source_identity')
}
function status(value: unknown) { requireNativeEmail(typeof value === 'string' && ['active', 'invited', 'disabled'].includes(value), 'root_employee_source_status') }
function bool(value: unknown) { requireNativeEmail(typeof value === 'boolean', 'root_employee_source_boolean') }
function membership(value: Membership, workspaceId: string, userEmail: string) {
  exact(value, ['workspaceId', 'userEmail', 'status', 'role', 'trashed', 'viewCrm'])
  requireNativeEmail(value.workspaceId === workspaceId && value.userEmail === userEmail, 'root_employee_membership_scope')
  status(value.status); bool(value.trashed); bool(value.viewCrm)
  requireNativeEmail(typeof value.role === 'string' && ['owner', 'admin', 'member'].includes(value.role), 'root_employee_membership_role')
}
function active(value: Membership) {
  return value.status === 'active' && !value.trashed && (value.role === 'owner' || value.viewCrm)
}
const edgeKey = (edge: RootEmployeeCrmReadEdge) => [edge.kind, edge.workspaceId, edge.resourceId].join(':')
const order = (a: RootEmployeeCrmReadEdge, b: RootEmployeeCrmReadEdge) => edgeKey(a) < edgeKey(b) ? -1 : edgeKey(a) > edgeKey(b) ? 1 : 0

/** Pure source contract for the root-employee integration. Call only with a
 * complete locked database inventory. This function neither reads browser
 * assertions nor grants access, writes memberships or alters native policy.
 * Persistence/native-first admission and normal entrypoint wiring remain
 * required before this result may authorize any application read. */
export function deriveRootEmployeeCrmReadScope(source: RootEmployeeCrmAccessSource): RootEmployeeCrmReadScope {
  exact(source, ['version', 'anchor', 'rootWorkspace', 'operator', 'grant', 'user', 'sourceMembership', 'targets'])
  requireNativeEmail(source.version === 1, 'root_employee_source_version')
  exact(source.anchor, ['id', 'rootWorkspaceId', 'ownerEmail', 'enabled'])
  uuid(source.anchor.id); uuid(source.anchor.rootWorkspaceId); email(source.anchor.ownerEmail); bool(source.anchor.enabled)
  exact(source.rootWorkspace, ['id', 'parentId', 'organizationType', 'isDemo'])
  requireNativeEmail(source.rootWorkspace.id === source.anchor.rootWorkspaceId && source.rootWorkspace.parentId === null
    && source.rootWorkspace.organizationType === 'root' && source.rootWorkspace.isDemo === false, 'root_employee_anchor_scope')
  exact(source.operator, ['email', 'status', 'membership']); status(source.operator.status)
  requireNativeEmail(source.operator.email === source.anchor.ownerEmail, 'root_employee_anchor_scope')
  membership(source.operator.membership, source.anchor.rootWorkspaceId, source.anchor.ownerEmail)
  exact(source.grant, ['id', 'anchorId', 'userEmail', 'sourceWorkspaceId', 'enabled']); uuid(source.grant.id); bool(source.grant.enabled)
  exact(source.user, ['email', 'status', 'suiteCrmUserId', 'nativeIdentityCount']); email(source.user.email); status(source.user.status)
  requireNativeEmail(source.grant.anchorId === source.anchor.id && source.grant.sourceWorkspaceId === source.anchor.rootWorkspaceId
    && source.grant.userEmail === source.user.email && source.user.email !== source.anchor.ownerEmail, 'root_employee_grant_scope')
  membership(source.sourceMembership, source.anchor.rootWorkspaceId, source.user.email)
  requireNativeEmail(source.user.suiteCrmUserId === null ? source.user.nativeIdentityCount === 0
    : typeof source.user.suiteCrmUserId === 'string' && /^[a-z0-9][a-z0-9-]{0,35}(?![\s\S])/i.test(source.user.suiteCrmUserId)
      && source.user.nativeIdentityCount === 1, 'root_employee_native_identity_ambiguous')
  requireNativeEmail(Array.isArray(source.targets) && source.targets.length <= 100, 'root_employee_inventory_bound')
  const enabled = source.anchor.enabled && source.grant.enabled && source.operator.status === 'active'
    && source.operator.membership.role === 'owner'
    && active(source.operator.membership) && source.user.status === 'active' && active(source.sourceMembership)
  const edges: RootEmployeeCrmReadEdge[] = [], workspaces = new Set<string>(), pipelines = new Set<string>(), boards = new Set<string>()
  for (const target of source.targets) {
    exact(target, ['anchorId', 'workspaceId', 'isDemo', 'ownerMembership', 'employeeMembership', 'pipelines', 'boards'])
    uuid(target.anchorId); uuid(target.workspaceId); bool(target.isDemo)
    requireNativeEmail(!workspaces.has(target.workspaceId), 'root_employee_inventory_duplicate'); workspaces.add(target.workspaceId)
    membership(target.ownerMembership, target.workspaceId, source.anchor.ownerEmail)
    if (target.employeeMembership !== null) membership(target.employeeMembership, target.workspaceId, source.user.email)
    if (target.workspaceId === source.anchor.rootWorkspaceId) requireNativeEmail(
      nativeEmailDigest(target.ownerMembership) === nativeEmailDigest(source.operator.membership)
      && target.employeeMembership !== null
      && nativeEmailDigest(target.employeeMembership) === nativeEmailDigest(source.sourceMembership), 'root_employee_source_inconsistent')
    requireNativeEmail(Array.isArray(target.pipelines) && target.pipelines.length <= 100
      && Array.isArray(target.boards) && target.boards.length <= 500, 'root_employee_inventory_bound')
    const selected = enabled && target.anchorId === source.anchor.id && !target.isDemo
      && target.ownerMembership.role === 'owner' && active(target.ownerMembership)
      && (target.employeeMembership === null || active(target.employeeMembership))
    if (selected) edges.push({ kind: 'workspace', resourceId: target.workspaceId, workspaceId: target.workspaceId })
    const visiblePipelines = new Set<string>()
    for (const pipeline of target.pipelines) {
      exact(pipeline, ['id', 'referenceAccessDisabled']); uuid(pipeline.id); bool(pipeline.referenceAccessDisabled)
      requireNativeEmail(!pipelines.has(pipeline.id), 'root_employee_inventory_duplicate'); pipelines.add(pipeline.id)
      if (selected && !pipeline.referenceAccessDisabled) {
        visiblePipelines.add(pipeline.id)
        edges.push({ kind: 'pipeline', resourceId: pipeline.id, workspaceId: target.workspaceId })
      }
    }
    for (const board of target.boards) {
      exact(board, ['id', 'kind', 'pipelineId']); uuid(board.id)
      requireNativeEmail(['crm_projection', 'private'].includes(board.kind) && !boards.has(board.id), 'root_employee_inventory_duplicate')
      boards.add(board.id)
      requireNativeEmail(board.pipelineId === null || UUID.test(board.pipelineId), 'root_employee_source_identity')
      if (board.kind === 'crm_projection') requireNativeEmail(board.pipelineId !== null
        && target.pipelines.some(p => p.id === board.pipelineId), 'root_employee_board_scope')
      if (selected && board.kind === 'crm_projection' && visiblePipelines.has(board.pipelineId!))
        edges.push({ kind: 'crm_board', resourceId: board.id, workspaceId: target.workspaceId })
    }
  }
  return { version: 1, sourceHash: nativeEmailDigest(source), anchorId: source.anchor.id, grantId: source.grant.id,
    userEmail: source.user.email, suiteCrmUserId: source.user.suiteCrmUserId, enabled, edges: edges.sort(order) }
}

/** Reconcile only the selected grant's proven provenance. Revocation removes
 * effective inherited viewer access only if no independent manual/other grant
 * remains. It never deletes unrelated provenance or upgrades an editor/owner.
 * The native-first coordinator must execute the resulting full app/native
 * change; this pure plan is not permission to apply SQL directly. */
export function planRootEmployeeCrmReadEdges(source: RootEmployeeCrmAccessSource, current: RootEmployeeCrmCurrentEdge[]) {
  const scope = deriveRootEmployeeCrmReadScope(source)
  requireNativeEmail(Array.isArray(current) && current.length <= 20_000, 'root_employee_inventory_bound')
  const desired = new Map(scope.edges.map(edge => [edgeKey(edge), edge])), seen = new Set<string>()
  const changes: Array<RootEmployeeCrmReadEdge & { action: 'attach' | 'detach'; changesEffectiveRead: boolean }> = []
  for (const edge of current) {
    exact(edge, ['kind', 'resourceId', 'workspaceId', 'userEmail', 'manualRole', 'inherited'])
    requireNativeEmail(['workspace', 'pipeline', 'crm_board'].includes(edge.kind) && edge.userEmail === scope.userEmail
      && [null, 'owner', 'editor', 'viewer'].includes(edge.manualRole), 'root_employee_edge_scope')
    uuid(edge.resourceId); uuid(edge.workspaceId)
    requireNativeEmail(edge.kind !== 'workspace' || edge.resourceId === edge.workspaceId, 'root_employee_edge_scope')
    requireNativeEmail(!seen.has(edgeKey(edge)), 'root_employee_inventory_duplicate'); seen.add(edgeKey(edge))
    requireNativeEmail(Array.isArray(edge.inherited) && edge.inherited.length <= 100, 'root_employee_inventory_bound')
    const origins = new Set<string>()
    for (const origin of edge.inherited) {
      exact(origin, ['anchorId', 'grantId']); uuid(origin.anchorId); uuid(origin.grantId)
      const key = origin.anchorId + ':' + origin.grantId
      requireNativeEmail(!origins.has(key), 'root_employee_inventory_duplicate'); origins.add(key)
    }
    const ours = origins.has(scope.anchorId + ':' + scope.grantId), needed = desired.has(edgeKey(edge))
    if (ours !== needed) changes.push({ kind: edge.kind, resourceId: edge.resourceId, workspaceId: edge.workspaceId,
      action: needed ? 'attach' : 'detach', changesEffectiveRead: edge.manualRole === null && edge.inherited.length === (ours ? 1 : 0) })
    desired.delete(edgeKey(edge))
  }
  for (const edge of desired.values()) changes.push({ ...edge, action: 'attach', changesEffectiveRead: true })
  return { scope, changes: changes.sort(order) }
}
