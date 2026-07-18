#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

function assertIncludes(source, fragment, label) {
  assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
}

const migrationPath = 'db/migrations/0060_multi_workspace_memberships.sql'
assert.ok(fs.existsSync(path.join(root, migrationPath)), `${migrationPath} must exist`)
const migration = read(migrationPath)

for (const fragment of [
  'CREATE TABLE IF NOT EXISTS app_user_organization_memberships',
  'PRIMARY KEY (user_email, organization_id)',
  'idx_app_user_organization_memberships_default',
  'WHERE is_default',
  'INSERT INTO app_user_organization_memberships',
  'ON CONFLICT (user_email, organization_id) DO UPDATE SET',
]) {
  assertIncludes(migration, fragment, 'multi-workspace membership migration')
}
assert.match(
  migration,
  /ALTER TABLE project_boards[\s\S]*?ADD COLUMN IF NOT EXISTS workspace_organization_id uuid[\s\S]*?ALTER COLUMN workspace_organization_id SET NOT NULL/i,
  'project boards must have a required workspace organization',
)
assert.match(
  migration,
  /ALTER TABLE pipeline_spaces\s+ALTER COLUMN workspace_organization_id SET NOT NULL/i,
  'pipelines must have a required workspace organization',
)
assert.match(
  migration,
  /ALTER TABLE app_documents[\s\S]*?ADD COLUMN IF NOT EXISTS workspace_organization_id uuid[\s\S]*?ALTER COLUMN workspace_organization_id SET NOT NULL/i,
  'documents must have a required workspace organization',
)
for (const fragment of [
  'idx_project_boards_default_owner_workspace',
  'idx_project_boards_owner_workspace_crm_board',
  'idx_pipeline_spaces_default_owner_workspace',
  'PRIMARY KEY (user_email, workspace_organization_id)',
  'ADD COLUMN IF NOT EXISTS active_workspace_organization_id uuid',
  'ALTER COLUMN active_workspace_organization_id SET NOT NULL',
  'FOREIGN KEY (effective_user_email, active_workspace_organization_id)',
  'REFERENCES app_user_organization_memberships (user_email, organization_id)',
  'idx_app_documents_owner_workspace_source',
  'idx_app_documents_owner_workspace_slug',
]) {
  assertIncludes(migration, fragment, 'workspace isolation migration')
}

for (const fragment of [
  'ALTER TABLE agent_context_memories',
  'organization_id uuid',
  'idx_agent_context_memories_workspace_identity',
  'Every private agent memory must resolve to a workspace organization',
]) {
  assertIncludes(migration, fragment, 'workspace-scoped private agent memory')
}

const agentContextMemory = read('app_src/lib/agents/contextMemory.ts')
assertIncludes(agentContextMemory, 'organizationId: string', 'agent memory workspace input')
assertIncludes(agentContextMemory, 'organization_id = $3::uuid', 'agent memory workspace read isolation')
assertIncludes(agentContextMemory, 'app_user_organization_memberships', 'agent memory active membership guard')

const memberships = read('app_src/lib/workspaceMemberships.ts')
for (const fragment of [
  'listWorkspaceMemberships',
  'requireWorkspaceAppUser',
  'createIndependentRootWorkspace',
  "membership.status = 'active'",
  'membership.organization_id = $2::uuid',
  'organizationRole: membership.role',
  'organizationPermissions: membership.permissions',
]) {
  assertIncludes(memberships, fragment, 'workspace membership adapter')
}
assert.ok(!memberships.includes('insertCompatibilityMembership'), 'ordinary reads cannot recreate a removed membership')
const createRootWorkspace = memberships.slice(
  memberships.indexOf('export async function createIndependentRootWorkspace'),
)
assert.doesNotMatch(
  createRootWorkspace,
  /project_boards|pipeline_spaces|crm_(?:organizations|contacts|opportunities)|app_documents/,
  'creating a peer root must not copy tenant-owned records',
)
assertIncludes(
  createRootWorkspace,
  "VALUES ($1, $2::uuid, 'owner'",
  'peer root creation grants only the creating owner membership',
)

const sessions = read('app_src/lib/authSessions.ts')
for (const fragment of [
  'activeWorkspaceOrganizationId',
  'activeWorkspacePermissions',
  'session.active_workspace_organization_id::text',
  'JOIN app_user_organization_memberships active_membership',
  'active_membership.organization_id = session.active_workspace_organization_id',
  'organizationId?: string | null',
  'active_workspace_organization_id',
  'switchBrowserSessionWorkspace',
  "eventType: 'auth.workspace.switched'",
  "row.active_membership_status !== 'active'",
]) {
  assertIncludes(sessions, fragment, 'active workspace session adapter')
}
assert.match(
  sessions,
  /WHERE membership\.user_email = \$1[\s\S]{0,180}?membership\.organization_id = \$2::uuid[\s\S]{0,100}?membership\.status = 'active'/,
  'workspace switching must require the effective user active membership',
)
assert.match(
  sessions,
  /UPDATE app_sessions[\s\S]{0,180}?token_hash = \$2[\s\S]{0,180}?active_workspace_organization_id = \$3::uuid/,
  'workspace switching must rotate the session token and update its active workspace',
)

const requestUser = read('app_src/lib/requestUser.ts')
assertIncludes(
  requestUser,
  'requireWorkspaceAppUser(session.effectiveUser, session.activeWorkspaceOrganizationId)',
  'request user workspace scope',
)

const authWorkspaceRoute = read('app_src/app/api/auth/workspace/route.ts')
for (const fragment of [
  'listWorkspaceMemberships(actor.email)',
  'canCreateRoot: isRootAppOwner(actor)',
  'switchBrowserSessionWorkspace({ session, organizationId })',
  'setBrowserSessionCookie(response, issued)',
  'clearWorkspaceSelectionCookies(response)',
]) {
  assertIncludes(authWorkspaceRoute, fragment, 'active workspace route')
}

const tenancy = read('app_src/lib/tenancy.ts')
for (const fragment of [
  'ON CONFLICT (owner_email, workspace_organization_id) WHERE is_default DO NOTHING',
  'WHERE board.workspace_organization_id = $2::uuid',
  'WHERE pipeline.workspace_organization_id = $2::uuid',
  'WHERE user_email = $1 AND workspace_organization_id = $2::uuid',
  'ON CONFLICT (user_email, workspace_organization_id) DO UPDATE SET',
  'VALUES ($1, $2, $3::uuid, true, NULL, false)',
  'AND (pipeline_spaces.sheet_id IS NULL OR pipeline_spaces.sheet_id = $2)',
  'WHERE existing.sheet_id = $2',
  'AND existing.id <> $1::uuid',
  'if (legacySheetClaim.rows[0]) personalPipeline = legacySheetClaim',
]) {
  assertIncludes(tenancy, fragment, 'workspace-scoped tenancy adapter')
}
assert.doesNotMatch(
  tenancy,
  /VALUES \(\$1, \$2, \$3::uuid, true, \$4, \$5\)/,
  'a new owner pipeline cannot claim the legacy workbook before checking existing ownership',
)
assert.ok(
  !tenancy.includes("SELECT workspace_organization_id::text FROM project_boards WHERE id = $1::uuid"),
  'a requested board cannot replace the active browser workspace',
)
assert.ok(
  !tenancy.includes("SELECT workspace_organization_id::text FROM pipeline_spaces WHERE id = $1::uuid"),
  'a requested pipeline cannot replace the active browser workspace',
)

const workerAuth = read('app_src/lib/workerAuth.ts')
assertIncludes(workerAuth, 'requireWorkspaceAppUser(operatorId, board.rows[0].workspace_organization_id)', 'worker workspace authorization')
assertIncludes(workerAuth, 'actor: AppUser', 'worker scoped actor')

for (const workerAuditPath of [
  'app_src/lib/persistence/agentDispatch.ts',
  'app_src/lib/persistence/agentResearch.ts',
]) {
  const workerAudit = read(workerAuditPath)
  assertIncludes(workerAudit, 'board.workspace_organization_id', `${workerAuditPath} workspace audit attribution`)
  assertIncludes(workerAudit, 'WHERE board.id = $4::uuid', `${workerAuditPath} success audit board scope`)
  assertIncludes(workerAudit, 'WHERE board.id = $5::uuid', `${workerAuditPath} failure audit board scope`)
  assertIncludes(workerAudit, 'boardId:', `${workerAuditPath} audit routing context`)
}

const documents = read('app_src/lib/documents.ts')
for (const fragment of [
  'organizationId: string',
  'workspace_organization_id = $2::uuid',
  'ON CONFLICT (owner_email, workspace_organization_id, source_key)',
  'resolveProjectBoardAccess({ actorEmail: user',
  'resolvePipelineSpaceAccess({ actorEmail: user',
]) {
  assertIncludes(documents, fragment, 'workspace-scoped documents')
}

const users = read('app_src/lib/users.ts')
for (const fragment of [
  'INSERT INTO app_user_organization_memberships',
  'ON CONFLICT (user_email, organization_id) DO UPDATE SET',
  'organization_id = COALESCE(app_users.organization_id, EXCLUDED.organization_id)',
  'JOIN managed ON managed.id = membership.organization_id',
  'previousMembership',
]) {
  assertIncludes(users, fragment, 'membership-scoped user invitation')
}

const authMagicCode = read('app_src/lib/authMagicCode.ts')
for (const fragment of [
  'membership.organization_id = invitation.workspace_organization_id',
  "membership.status = 'invited'",
  'AND organization_id = $2::uuid',
  'organization_id: invitation.rows[0].workspace_organization_id',
]) {
  assertIncludes(authMagicCode, fragment, 'organization-specific invitation acceptance')
}

const magicVerifyRoute = read('app_src/app/api/auth/magic/verify/route.ts')
assertIncludes(magicVerifyRoute, 'requireWorkspaceAppUser(result.email, result.organizationId)', 'invitation workspace session issuance')
assertIncludes(magicVerifyRoute, 'organizationId: actor.organizationId', 'invitation workspace session issuance')

const sessionRoute = read('app_src/app/api/auth/session/route.ts')
assertIncludes(sessionRoute, 'activeWorkspace:', 'session workspace response')
assertIncludes(sessionRoute, 'availableWorkspaces:', 'session workspace response')

const switcher = read('app_src/components/workspaces/ActiveWorkspaceSwitcher.tsx')
assertIncludes(switcher, "fetch('/api/auth/workspace'", 'workspace switcher')
assertIncludes(switcher, "body: JSON.stringify({ action: 'switch', organizationId })", 'workspace switcher')
assertIncludes(switcher, "body: JSON.stringify({ action: 'create-root', name })", 'peer root workspace creation')
assertIncludes(switcher, 'Add business', 'peer root workspace creation')
assertIncludes(switcher, 'announceWorkspaceChange', 'in-app workspace transition')
assert.ok(!switcher.includes('window.location.assign'), 'workspace switching cannot force a full document reload')
const workspaceClient = read('app_src/lib/workspaceClient.ts')
assertIncludes(workspaceClient, "WORKSPACE_CHANGED_EVENT = 'clawpilot:workspace-changed'", 'workspace change event')
assertIncludes(workspaceClient, 'window.history.replaceState', 'workspace URL reset without navigation')
assertIncludes(workspaceClient, 'WORKSPACE_PREFETCH_TTL_MS = 45_000', 'bounded workspace bootstrap cache')
assertIncludes(workspaceClient, '.slice(0, WORKSPACE_PREFETCH_LIMIT)', 'bounded recent-workspace prefetch')
assertIncludes(workspaceClient, 'bootstrapRequests.get(organizationId)', 'workspace prefetch request deduplication')
assertIncludes(switcher, 'selectWorkspacePrefetchTargets(payload.workspaces', 'menu-open workspace prefetch')
assertIncludes(switcher, 'new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 200))', 'bounded switch hydration wait')
const workspacePrefetchRoute = read('app_src/app/api/auth/workspace/prefetch/route.ts')
assertIncludes(workspacePrefetchRoute, 'requireRequestUserForWorkspace(req, organizationId)', 'prefetch membership authorization')
assertIncludes(workspacePrefetchRoute, 'UUID_PATTERN.test(organizationId)', 'prefetch workspace identifier validation')
assertIncludes(workspacePrefetchRoute, "'Cache-Control': 'private, no-store, max-age=0'", 'prefetch response cache isolation')
assert.ok(!workspacePrefetchRoute.includes('switchBrowserSessionWorkspace'), 'prefetch cannot change the active browser workspace')
assert.ok(!workspacePrefetchRoute.includes('recordAuditEvent'), 'prefetch cannot emit a workspace switch audit event')
const dashboardBootstrap = read('app_src/lib/dashboardBootstrapServer.ts')
assertIncludes(dashboardBootstrap, 'ensureDefaults: false', 'read-only workspace bootstrap')
assertIncludes(dashboardBootstrap, 'Promise.allSettled([', 'parallel workspace bootstrap reads')
assert.ok(!dashboardBootstrap.includes('ensureUserBriefs'), 'prefetch cannot generate workspace documents')
const homeClient = read('app_src/app/HomeClient.tsx')
assertIncludes(homeClient, 'window.addEventListener(WORKSPACE_CHANGED_EVENT', 'workspace-scoped content refresh')
assertIncludes(homeClient, 'key={`workspace-${workspaceRevision}`}', 'workspace-scoped content remount')
assertIncludes(homeClient, 'initialWorkspaceId={activeWorkspaceId}', 'prefetched workspace dashboard handoff')
const dashboard = read('app_src/components/dashboard/DashboardSection.tsx')
assertIncludes(dashboard, 'const independentResultsPromise = Promise.allSettled([', 'parallel dashboard loading')
assertIncludes(dashboard, 'independentResultsPromise,', 'parallel dashboard loading')
assertIncludes(dashboard, 'readWorkspaceBootstrap(initialWorkspaceId)', 'instant prefetched dashboard hydration')
assertIncludes(dashboard, 'const [loading, setLoading] = useState(!initialBootstrap)', 'background dashboard revalidation')
assertIncludes(authWorkspaceRoute, 'const [session, body] = await Promise.all([', 'single session validation on workspace switch')
assert.ok(
  !authWorkspaceRoute.includes('const [session, actor, body] = await Promise.all(['),
  'ordinary workspace switching cannot resolve the request session twice',
)
const header = read('app_src/components/AppHeader.tsx')
assertIncludes(header, '<ActiveWorkspaceSwitcher />', 'application header workspace switcher')

const deployedSmoke = read('scripts/smoke-deployed-runtime.mjs')
assertIncludes(deployedSmoke, 'CLAWPILOT_SMOKE_WORKSPACE', 'workspace-aware deployed smoke')
assertIncludes(deployedSmoke, "getJson('/api/auth/session')", 'workspace-aware deployed smoke')
assertIncludes(deployedSmoke, "fetch(`${baseUrl}/api/auth/workspace`", 'workspace-aware deployed smoke')
assertIncludes(deployedSmoke, "body: JSON.stringify({ action: 'switch', organizationId: workspace.organizationId })", 'workspace-aware deployed smoke')

const health = read('app_src/app/api/health/route.ts')
assertIncludes(health, '0060_multi_workspace_memberships.sql', 'migration health gate')
const predeploy = read('scripts/verify-predeploy.mjs')
assertIncludes(predeploy, migrationPath, 'predeploy migration gate')

const packageJson = JSON.parse(read('package.json'))
assert.equal(
  packageJson.scripts['test:multi-workspace-memberships'],
  'node scripts/test-multi-workspace-memberships.mjs',
)
assert.match(packageJson.scripts.test, /npm run test:multi-workspace-memberships/)

console.log('PASS test-multi-workspace-memberships')
