#!/usr/bin/env node
// Executable authorization boundaries with real application modules and inert I/O.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const env = { ...process.env, APP_AUTH_REQUIRED: '1' }
function load(file, mocks = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, process: { env, cwd: process.cwd }, Buffer, Date, URL, Headers, console,
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id),
  }, { filename: file })
  return module.exports
}
const noIo = () => { throw new Error('Unexpected I/O') }
const users = load('app_src/lib/users.ts', {
  '@/lib/persistence/postgres': { query: noIo, withTransaction: noIo }, '@/lib/auditWriter': {}, '@/lib/crm/suiteCrmClient': {}, '@/lib/demoMode': {},
})
const registry = load('app_src/lib/moduleAccess.ts')
const authorization = load('app_src/lib/moduleAuthorization.ts', { 'server-only': {}, '@/lib/users': users, '@/lib/moduleAccess': registry })
const permissions = (...allowed) => Object.fromEntries(['viewDocs', 'viewProjects', 'viewCrm', 'viewLinks', 'viewAgents', 'viewVersions', 'viewAccounting', 'viewOperations', 'viewShipping'].map((key) => [key, allowed.includes(key)]))
const actor = (perms = {}, role = 'member') => ({ email: 'member@example.test', role: 'owner', status: 'active', permissions: users.OWNER_PERMISSIONS,
  organizationId: 'org-a', organizationRole: role, organizationPermissions: perms })

for (const role of ['member', 'admin']) {
  const legacy = users.permissionsForRole(role, {})
  for (const key of ['viewDocs', 'viewProjects', 'viewCrm', 'viewLinks', 'viewAgents', 'viewVersions']) assert.equal(legacy[key], true, `${role} legacy ${key}`)
  const denied = users.permissionsForRole(role, { ...permissions(), createBoards: true, createPipelines: true, manageLinks: true, viewFullReleaseHistory: true, manageBackups: true })
  for (const key of ['createBoards', 'createPipelines', 'manageLinks', 'viewFullReleaseHistory', 'manageBackups']) assert.equal(denied[key], false)
}
assert.ok(Object.values(authorization.moduleCapabilitiesForUser(actor(permissions(), 'owner'))).every(Boolean), 'Workspace owner retains authority')
assert.equal(authorization.moduleCapabilitiesForUser(actor(permissions())).docs, false, 'Global owner cannot override scoped member denial')
assert.throws(() => authorization.moduleCapabilitiesForUser({ ...actor(), organizationPermissions: undefined }), /validation unavailable/)
assert.equal(registry.validatedModuleCapabilities(undefined).docs, false)
assert.equal(registry.validatedModuleCapabilities({ crm: 'true' }).crm, false)
assert.equal(registry.moduleAccessFromPermissions({ viewCrm: false }).pipeline, false)
assert.equal(registry.moduleAccessFromPermissions({ viewAccounting: true }).pos, true)
assert.equal(registry.modulePermissionDependencies({}, 'purchaseLivePostage', true).viewShipping, true)
assert.equal(registry.modulePermissionDependencies({ purchaseLivePostage: true }, 'viewShipping', false).purchaseLivePostage, false)
assert.equal(registry.modulePermissionDependencies({ reconcileCarrierBilling: true, approveCarrierSettlement: true }, 'viewCarrierCost', false).reconcileCarrierBilling, false)
assert.equal(registry.modulePermissionDependencies({ viewShipping: false }, 'reconcileCarrierBilling', true).viewShipping, false, 'Operations-only carrier billing preserved')

class NextResponse extends Response {
  constructor(body, init) { super(body, init); this.cookies = { set() {} } }
  static json(body, init) { return new NextResponse(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }) }
  static next() { return new NextResponse(null, { status: 200, headers: { 'x-test-next': '1' } }) }
  static redirect(url) { return new NextResponse(null, { status: 307, headers: { location: String(url) } }) }
}
const request = (path, method = 'GET', body, headers) => ({ url: `https://app.example.test${path}`, nextUrl: new URL(`https://app.example.test${path}`), method,
  headers: new Headers(headers), cookies: { get: () => undefined }, json: async () => body })
let scoped = actor(permissions()), lookups = 0, lookupError = false, worker = null
const session = { id: 'session', authenticatedUser: scoped.email, effectiveUser: scoped.email, activeWorkspaceOrganizationId: 'org-a', legacy: false }
const workspace = { requireWorkspaceAppUser: async (email, org) => { lookups++; assert.equal(email, scoped.email); assert.equal(org, 'org-a'); if (lookupError) throw new Error('Unavailable'); return scoped } }
const authSessions = { resolveRequestSession: async () => session }
const proxy = load('app_src/proxy.ts', {
  'next/server': { NextResponse }, '@/lib/authAttribution': { createAuthAttributionHeaders: () => ({}) }, '@/lib/authSessions': authSessions,
  '@/lib/workerAuth': { resolveAgentDispatchWorker: async () => worker }, '@/lib/demoMode': { demoMutationIsRestricted: () => false },
  '@/lib/bpoShortlinkPublicPath.mjs': { isPublicBpoShortlinkResolvePath: (path) => path.startsWith('/api/shortlinks/bpo/resolve/') },
  '@/lib/moduleAuthorization': authorization, '@/lib/workspaceMemberships': workspace,
}).proxy
const mapped = {
  '/api/docs': 'docs', '/api/docs/generate': 'docs', '/api/docs-sync': 'docs', '/api/tasks': 'projects', '/api/tasks/id/claim': 'projects',
  '/api/deleted-tasks': 'projects', '/api/checklist/id': 'projects', '/api/task-creation-audit/summary': 'projects', '/api/crm/email-recovery': 'crm',
  '/crm/gi123': 'crm', '/api/pipeline': 'crm', '/api/pipeline/catalog': 'crm', '/api/accounting/quickbooks/actions': 'accounting', '/api/pos/catalog': 'accounting',
  '/api/shortlinks/preferences': 'links', '/api/agents/threads': 'agents', '/api/execution-results': 'agents', '/api/execution-selftest': 'agents', '/api/freeze': 'agents',
  '/api/nightly-status': 'agents', '/api/versions': 'versions', '/api/railway-backups': 'versions',
}
for (const [path, module] of Object.entries(mapped)) {
  assert.equal(authorization.moduleForApiPath(path), module)
  const response = await proxy(request(path))
  assert.equal(response.status, 403, path)
  assert.equal((await response.json()).module, module, path)
  assert.equal(response.headers.get('cache-control'), 'no-store')
}
const beforeUnrelated = lookups
for (const path of ['/api/activity', '/api/auth/session', '/api/auth/workspace/prefetch', '/api/health', '/s/public', '/api/crm/outbox/process', '/api/docs/embeddings/process', '/api/shortlinks', '/api/shortlinks/bpo/resolve/test']) {
  assert.equal((await proxy(request(path))).status, 200, path)
}
assert.equal(lookups, beforeUnrelated, 'Unrelated and existing public/worker paths do not add membership reads')
worker = { boardId: 'board' }
assert.equal((await proxy(request('/api/tasks', 'PATCH', {}, { 'x-clawpilot-worker': 'agent-dispatch' }))).status, 200)
worker = null
assert.equal((await proxy(request('/api/tasks', 'PATCH', {}, { 'x-clawpilot-worker': 'agent-dispatch' }))).status, 403, 'Unverified worker header cannot bypass')
lookupError = true
assert.equal((await proxy(request('/api/docs'))).status, 503)
lookupError = false
scoped = actor({})
assert.equal((await proxy(request('/api/docs'))).status, 200, 'Legacy member documents remain available')

const requestUsers = load('app_src/lib/requestUser.ts', { '@/lib/authSessions': authSessions, '@/lib/users': users, '@/lib/workspaceMemberships': workspace, '@/lib/moduleAuthorization': authorization })
scoped = actor(permissions())
await assert.rejects(requestUsers.requireRequestUser(request('/api/shortlinks')), (error) => error.code === 'MODULE_VIEW_REQUIRED' && error.module === 'links')
await assert.rejects(requestUsers.requireRequestUser(request('/api/docs')), (error) => error.code === 'MODULE_VIEW_REQUIRED')

const taskBackedAgentPaths = ['/api/agents/threads', '/api/agents/assignments', '/api/agents/repository-runs', '/api/execution-runs', '/api/execution-runs/summary', '/api/execution-results', '/api/execution-results/summary', '/api/execution-threads', '/api/execution-selftest', '/api/execution-queue-selftest']
scoped = actor(permissions('viewAgents'))
for (const path of taskBackedAgentPaths) {
  assert.deepEqual(Array.from(authorization.requiredModulesForApiPath(path)), ['agents', 'projects'])
  const denied = await proxy(request(path))
  assert.equal(denied.status, 403, `${path}: Agents alone cannot access Projects data`)
  assert.equal((await denied.json()).module, 'projects')
  await assert.rejects(requestUsers.requireRequestUser(request(path)), (error) => error.code === 'MODULE_VIEW_REQUIRED' && error.module === 'projects')
}
assert.equal((await proxy(request('/api/agents/threads', 'POST', {}))).status, 403)
assert.equal((await proxy(request('/api/agents/docs-bootstrap', 'POST', {}))).status, 403, 'Agents cannot write Docs scaffolds without Docs View')
for (const path of ['/api/agents', '/api/agents/auth', '/api/execution-log-integrity']) assert.equal((await proxy(request(path))).status, 200, `${path} stays independent of Projects`)
worker = { boardId: 'board' }
assert.equal((await proxy(request('/api/agents/threads', 'POST', {}, { 'x-clawpilot-worker': 'agent-dispatch' }))).status, 200, 'Verified task worker preserved')
worker = null
scoped = actor(permissions('viewAgents', 'viewProjects'))
for (const path of taskBackedAgentPaths) assert.equal((await proxy(request(path))).status, 200)
scoped = actor(permissions())

let boardReads = 0, pipelineReads = 0, taskReads = 0, docsReads = 0, crmReads = 0, taskOptions, crmBinding = null, pipelineAclDenied = false, pipelineAclChecks = 0
const tenancy = {
  listProjectBoards: async () => { boardReads++; return [{ id: 'board', name: 'Board', ownerEmail: scoped.email, isDefault: true }] },
  listPipelineSpaces: async () => { pipelineReads++; return [{ id: 'pipeline', name: 'Pipeline', ownerEmail: scoped.email, isDefault: true }] },
  readWorkspacePreferences: async () => ({ defaultBoardId: 'board', defaultPipelineId: 'pipeline' }),
}
const dashboardWorkspace = load('app_src/lib/dashboardWorkspace.ts', { '@/lib/tenancy': tenancy, '@/lib/moduleAuthorization': authorization })
const dashboard = load('app_src/lib/dashboardBootstrapServer.ts', {
  '@/lib/dashboardWorkspace': dashboardWorkspace, '@/lib/moduleAuthorization': authorization,
  '@/lib/documents': { ensureApplicationUserGuide: async () => { docsReads++ }, listUserDocuments: async () => [] },
  '@/lib/persistence/pipeline': { isPostgresPipelineStoreEnabled: () => true }, '@/lib/persistence/crm': { readCrmSummaryFromPostgres: async () => { crmReads++; return {} } },
  '@/lib/persistence/tasks': { isPostgresTaskStoreEnabled: () => true, readTasksFromPostgres: async (options) => { taskReads++; taskOptions = options; return [] } },
  '@/lib/crm/boardProjection': { resolveCrmBoardBinding: async () => crmBinding },
  '@/lib/tenancy': { resolvePipelineSpaceAccess: async ({ pipelineId }) => { pipelineAclChecks++; assert.equal(pipelineId, 'private-pipeline'); if (pipelineAclDenied) throw new Error('Pipeline access denied'); return { id: pipelineId } } },
})
const empty = await dashboard.buildDashboardBootstrap(scoped)
assert.equal(boardReads + pipelineReads + taskReads + docsReads + crmReads, 0, 'Denied prefetch never calls protected data readers')
assert.equal(empty.workspace.selectedBoardId, null)
assert.equal(empty.workspace.selectedPipelineId, null)
assert.deepEqual(JSON.parse(JSON.stringify(empty.availability)), { tasks: false, docs: false, pipeline: false })
scoped = actor(permissions('viewProjects'))
await dashboard.buildDashboardBootstrap(scoped)
assert.equal(boardReads, 1); assert.equal(taskReads, 1); assert.equal(pipelineReads + docsReads + crmReads, 0)
assert.equal(taskOptions.includeCrmCards, false, 'Project-only prefetch excludes CRM cards')
scoped = actor(permissions('viewCrm'))
await dashboard.buildDashboardBootstrap(scoped)
assert.equal(boardReads, 1); assert.equal(taskReads, 1); assert.equal(pipelineReads, 1); assert.equal(crmReads, 1)
scoped = actor(permissions('viewProjects', 'viewCrm'))
crmBinding = { pipeline_id: 'private-pipeline' }; pipelineAclDenied = true
const deniedPrefetch = await dashboard.buildDashboardBootstrap(scoped)
assert.equal(taskReads, 1, 'Shared board never grants implicit CRM pipeline access or reads its cards')
assert.equal(deniedPrefetch.availability.tasks, false)
assert.equal(pipelineAclChecks, 1)
pipelineAclDenied = false
await dashboard.buildDashboardBootstrap(scoped)
assert.equal(taskReads, 2); assert.equal(taskOptions.includeCrmCards, true)
assert.equal(pipelineAclChecks, 2)
scoped = actor(permissions('viewCrm'))

let writes = 0
const workspaces = load('app_src/app/api/workspaces/route.ts', { 'next/server': { NextResponse }, '@/lib/requestUser': { requireRequestUser: async () => scoped },
  '@/lib/dashboardWorkspace': dashboardWorkspace, '@/lib/moduleAuthorization': authorization,
  '@/lib/pipelineProvisioning': { PipelineProvisioningRequestError: class extends Error {} },
  '@/lib/tenancy': { ...tenancy, createProjectBoard: async () => { writes++; return { id: 'new' } } },
})
assert.equal((await workspaces.POST(request('/api/workspaces', 'POST', { action: 'create-board' }))).status, 403)
assert.equal(writes, 0)

const sqlCalls = []
const briefInsights = load('app_src/lib/pipelineBrief.ts')
const documents = load('app_src/lib/documents.ts', {
  '@/lib/aiRadar': { listAiRadarItems: noIo }, '@/lib/agents/taskDocument': {}, '@/lib/documentEmbeddings': { embedSearchQuery: async () => null }, '@/lib/pipelineBrief': briefInsights,
  '@/lib/persistence/postgres': { query: async (sql, params) => { sqlCalls.push({ sql, params }); return { rows: [] } } },
  '@/lib/releases': { releaseAccessFor: () => ({ historyScope: 'recent' }), MEMBER_RELEASE_HISTORY_DAYS: 30 }, '@/lib/tenancy': {},
  '@/lib/users': users, '@/lib/workspaceMemberships': {}, '@/lib/moduleAuthorization': authorization,
})
scoped = actor(permissions('viewDocs'))
await documents.listUserDocuments(scoped)
assert.match(sqlCalls[0].sql, /\$6::boolean OR \(board_id IS NULL/)
assert.match(sqlCalls[0].sql, /\$7::boolean OR \(pipeline_id IS NULL/)
assert.deepEqual(Array.from(sqlCalls[0].params.slice(5)), [false, false, false, false])
await documents.ensureUserBriefs(scoped)
assert.equal(sqlCalls.length, 1, 'Automatic briefs do not resolve forbidden source modules')
await documents.refreshUserBriefs(scoped)
assert.equal(sqlCalls.length, 1, 'Explicit docs-only refresh does not query forbidden source data')
await assert.rejects(documents.generateUserDocument({ user: scoped, kind: 'pipeline-report' }), (error) => error.code === 'MODULE_VIEW_REQUIRED')
assert.equal(sqlCalls.length, 1, 'Denied generation cannot query or persist content')
scoped = actor(permissions())
await assert.rejects(documents.listUserDocuments(scoped), (error) => error.code === 'MODULE_VIEW_REQUIRED')

let projectDataReads = 0
const pipeline = load('app_src/app/api/pipeline/route.ts', {
  'next/server': { NextResponse }, '@/lib/crm/boardCard.mjs': { isCrmBoardCard: () => false }, '@/lib/workItemModel': {},
  '@/lib/persistence/config': { shouldFallbackToFileOnDatabaseError: () => false },
  '@/lib/persistence/crm': { listCrmRecordsInPostgres: async () => [], readCrmSummaryFromPostgres: async () => ({}) },
  '@/lib/persistence/tasks': { isPostgresTaskStoreEnabled: () => true, readTasksFromPostgres: async () => { projectDataReads++; return [] } },
  '@/lib/persistence/pipeline': { isPostgresPipelineStoreEnabled: () => true }, '@/lib/requestUser': { requireRequestUser: async () => scoped },
  '@/lib/moduleAuthorization': authorization, '@/lib/tenancy': { resolveProjectBoardAccess: noIo, resolvePipelineSpaceAccess: async () => ({ id: 'pipeline' }), readPipelineProjectionForSpace: async () => ({}) },
})
scoped = actor(permissions('viewCrm'))
const pipelineResponse = await pipeline.GET(request('/api/pipeline'))
assert.equal(pipelineResponse.status, 200)
assert.deepEqual((await pipelineResponse.json()).workItems, [])
assert.equal(projectDataReads, 0, 'CRM-only Pipeline does not resolve boards or read project tasks')

let crmBindings = 0, crmReconciles = 0, taskRouteReads = 0, taskRouteOptions
const tasks = load('app_src/app/api/tasks/route.ts', {
  'next/server': { NextResponse }, '@/lib/freeze': { ensureNotFrozen: () => null }, '@/lib/agents/routing': {}, '@/lib/agents/dispatch': {},
  '@/lib/crm/boardCard.mjs': { isCrmBoardCard: () => false }, '@/lib/taskState': {}, '@/lib/fileLock': {}, '@/lib/workItemModel': {},
  '@/lib/persistence/config': { shouldFallbackToFileOnDatabaseError: () => false },
  '@/lib/persistence/tasks': { isPostgresTaskStoreEnabled: () => true, readTasksFromPostgres: async (options) => { taskRouteReads++; taskRouteOptions = options; return [] } },
  '@/lib/requestUser': { requireRequestUser: async () => scoped }, '@/lib/moduleAuthorization': authorization, '@/lib/workerAuth': { resolveAgentDispatchWorker: async () => worker },
  '@/lib/tenancy': { resolveProjectBoardAccess: async () => ({ id: 'board' }), requireResourceEditor() {}, resolvePipelineSpaceAccess: async () => ({ id: 'pipeline' }) },
  '@/lib/crm/boardProjection': { resolveCrmBoardBinding: async () => { crmBindings++; return { pipeline_id: 'pipeline' } }, reconcileCrmBoardProjection: async () => { crmReconciles++ } },
})
scoped = actor(permissions('viewProjects'))
assert.equal((await tasks.GET(request('/api/tasks?includeCrmCards=true'))).status, 200)
assert.equal(taskRouteOptions.includeCrmCards, false)
assert.equal(crmBindings + crmReconciles, 0)
assert.equal((await tasks.PATCH(request('/api/tasks', 'PATCH', { id: 'crm-card' }))).status, 403)
assert.equal(taskRouteReads, 1, 'Denied CRM-card mutation never reads task/CRM payloads')

const taskQueries = []
const taskStore = load('app_src/lib/persistence/tasks.ts', {
  '@/lib/crm/boardCard.mjs': {}, '@/lib/persistence/config': {}, '@/lib/persistence/agentDispatch': {}, '@/lib/auditWriter': {},
  '@/lib/persistence/postgres': { query: async (sql) => { taskQueries.push(sql); return { rows: [] } } },
})
await taskStore.readTasksFromPostgres({ boardId: 'board', includeCrmCards: false })
assert.equal(taskQueries.length, 1)
assert.match(taskQueries[0], /AND source <> 'crm-projection'/, 'Legacy CRM projection rows excluded before read')

const operationsAuth = load('app_src/lib/operations/authorization.ts', { '@/lib/users': users })
scoped = actor(permissions())
assert.equal(operationsAuth.operationsCapabilities(scoped).canView, false)
assert.equal(operationsAuth.shippingCapabilities(scoped).canView, false)
const shipping = load('app_src/app/api/operations/shipping/route.ts', {
  'next/server': { NextResponse }, '@/lib/operations/authorization': operationsAuth, '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/persistence/shipping': { readShippingWorkspaceFromPostgres: noIo }, '@/lib/requestUser': { requireRequestUser: async () => scoped },
})
assert.equal((await shipping.GET(request('/api/operations/shipping'))).status, 403, 'Existing Shipping route rejects before data read')
for (const file of ['app_src/app/api/operations/route.ts', 'app_src/app/api/operations/order-workbench/route.ts', 'app_src/app/api/operations/orders/route.ts', 'app_src/app/api/operations/orders/unified/route.ts']) {
  assert.match(readFileSync(file, 'utf8'), /if \(!capabilities.canView\)/, `${file} retains existing Operations view gate`)
}

console.log('PASS module backend: legacy defaults, scoped owner isolation, dependencies, every route family, worker/public bypasses, lookup failures, request helper, dashboard/prefetch, workspace writes, generated document filters, CRM-only Pipeline and Projects-only task isolation')
