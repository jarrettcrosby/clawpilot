#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const requireFromTest = createRequire(import.meta.url)
const ts = requireFromApp('typescript')

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function loadTypeScriptModule(relativePath, mocks) {
  const source = read(relativePath)
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    Buffer,
    Error,
    Headers,
    Request,
    Response,
    SyntaxError,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    module,
    process,
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      return requireFromTest(id)
    },
    setTimeout,
  }
  vm.runInNewContext(output, sandbox, { filename: relativePath })
  return { exports: module.exports, source }
}

const migration = read('db/migrations/0011_knowledge_releases_checkpoints.sql')
const hardeningMigration = read('db/migrations/0012_invitation_release_hardening.sql')
const documentBriefs = read('app_src/lib/documents.ts')
const releasesSource = read('app_src/lib/releases.ts')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS release_entries',
  'CREATE TABLE IF NOT EXISTS data_checkpoints',
  'object_counts jsonb NOT NULL',
  'snapshot jsonb NOT NULL',
  'viewFullReleaseHistory',
  'manageBackups',
]) {
  assert.ok(migration.includes(fragment), `release migration missing ${fragment}`)
}
for (const fragment of [
  'idx_app_user_invitations_one_active',
  'ADD COLUMN IF NOT EXISTS release_key',
  'DROP CONSTRAINT IF EXISTS release_entries_environment_commit_hash_key',
  'idx_release_entries_environment_key',
]) {
  assert.ok(hardeningMigration.includes(fragment), `release hardening migration missing ${fragment}`)
}
assert.ok(
  documentBriefs.includes('SELECT DISTINCT ON (commit_hash)'),
  'build brief must collapse repeated deployments of the same commit',
)
assert.ok(
  releasesSource.includes('SELECT DISTINCT ON (environment, commit_hash)'),
  'release history must collapse repeated deployments of a commit within each environment',
)

const overviewQueries = []
const checkpointInserts = []
let transactionCount = 0

const releaseRow = {
  id: '00000000-0000-4000-8000-000000000001',
  commit_hash: 'abcdef1234567890',
  environment: 'production',
  branch: 'main',
  deployment_id: 'deploy-1',
  title: 'Release title',
  summary: 'Release summary',
  features: ['Feature one'],
  fixes: ['Fix one'],
  source: 'deployment',
  deployed_at: '2026-07-13T12:00:00.000Z',
  created_at: '2026-07-13T12:00:00.000Z',
  updated_at: '2026-07-13T12:00:00.000Z',
}

const checkpointRow = {
  id: '00000000-0000-4000-8000-000000000002',
  release_id: releaseRow.id,
  created_by: 'admin@example.com',
  label: 'Before import',
  reason: 'Audit checkpoint',
  object_counts: { tasks: 1 },
  checksum: 'a'.repeat(64),
  size_bytes: 100,
  provider_backup_status: 'not_verified',
  created_at: '2026-07-13T12:05:00.000Z',
}

const tableNames = [
  'app_users',
  'project_boards',
  'project_board_members',
  'tasks',
  'task_activity',
  'task_comments',
  'task_checklist_items',
  'pipeline_spaces',
  'pipeline_space_members',
  'app_documents',
  'execution_runs',
  'execution_results',
  'pipeline_sheet_sources',
  'pipeline_sheet_rows',
  'sync_outbox',
  'audit_events',
  'agent_threads',
  'agent_thread_messages',
  'agent_assignments',
]

const datasetRows = {
  app_users: [{ email: 'admin@example.com', permissions: { manageBackups: true }, role: 'admin' }],
  project_boards: [{ id: 'board-1', name: 'Operations' }],
  project_board_members: [{ board_id: 'board-1', user_email: 'member@example.com' }],
  tasks: [{ id: 'task-1', payload: { z: 2, a: 1 } }],
  task_activity: [{ id: 'activity-1', task_id: 'task-1' }],
  task_comments: [{ id: 'comment-1', task_id: 'task-1' }],
  task_checklist_items: [{ id: 'check-1', task_id: 'task-1' }],
  pipeline_spaces: [{ id: 'pipeline-1', projection: { z: 2, a: 1 } }],
  pipeline_space_members: [{ pipeline_id: 'pipeline-1', user_email: 'member@example.com' }],
  app_documents: [{ id: 'doc-1', title: 'Runbook' }],
  execution_runs: [{ id: 'run-1', task_id: 'task-1', status: 'succeeded' }],
  execution_results: [{ id: 'result-1', task_id: 'task-1', result_type: 'execution-result' }],
  pipeline_sheet_sources: [{ id: 'source-1', source_name: 'Pipeline' }],
  pipeline_sheet_rows: [{ id: 'row-1', row_number: 2, payload: { name: 'Opportunity' } }],
  sync_outbox: [{ id: 'outbox-1', status: 'succeeded' }],
  audit_events: [{ id: 'audit-1', event_type: 'pipeline.sync' }],
  agent_threads: [{ thread_id: 'thread-1', context: { z: 2, a: 1 } }],
  agent_thread_messages: [{ id: 'message-1', thread_id: 'thread-1' }],
  agent_assignments: [{ task_id: 'task-1', agent_id: 'projects' }],
}

const fakeClient = {
  async query(sql, values = []) {
    if (sql.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')) return { rows: [], rowCount: 0 }
    if (sql.includes("pg_advisory_xact_lock(hashtext('clawpilot-data-checkpoint'))")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM data_checkpoints') && sql.includes('created_at > now()')) return { rows: [], rowCount: 0 }
    if (sql.includes('DELETE FROM data_checkpoints')) return { rows: [], rowCount: 0 }
    if (sql.includes('information_schema.tables')) {
      return { rows: tableNames.map((table_name) => ({ table_name })), rowCount: tableNames.length }
    }
    if (sql.includes('SELECT id') && sql.includes('FROM release_entries')) {
      return { rows: [{ id: releaseRow.id }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO data_checkpoints')) {
      checkpointInserts.push(values)
      return {
        rows: [{
          ...checkpointRow,
          object_counts: JSON.parse(values[4]),
          checksum: values[6],
          size_bytes: values[7],
        }],
        rowCount: 1,
      }
    }
    const table = tableNames.find((name) => sql.includes(`FROM ${name}`))
    if (table && sql.includes('count(*)::text AS count')) {
      return {
        rows: [{
          count: String(datasetRows[table].length),
          size_bytes: String(datasetRows[table].reduce(
            (total, row) => total + Buffer.byteLength(JSON.stringify(row), 'utf8'),
            0,
          )),
        }],
        rowCount: 1,
      }
    }
    if (table) return { rows: datasetRows[table], rowCount: datasetRows[table].length }
    throw new Error(`Unexpected checkpoint query: ${sql}`)
  },
}

const permissionsDefaults = {
  inviteUsers: false,
  manageUserAccess: false,
  createBoards: true,
  createPipelines: true,
  viewFullReleaseHistory: false,
  manageBackups: false,
  manageLinks: false,
  viewOrganizationAudit: false,
  viewSystemAudit: false,
}

const persistenceMock = {
  async query(sql, values = []) {
    overviewQueries.push({ sql, values })
    if (sql.includes('FROM release_entries')) return { rows: [releaseRow], rowCount: 1 }
    if (sql.includes('FROM data_checkpoints')) return { rows: [checkpointRow], rowCount: 1 }
    throw new Error(`Unexpected overview query: ${sql}`)
  },
  async withTransaction(fn) {
    transactionCount += 1
    return fn(fakeClient)
  },
}

const usersMock = {
  effectiveAuthorizationRole(user) {
    return user.organizationRole || user.role
  },
  effectiveUserPermissions(user) {
    const role = user.organizationRole || user.role
    if (role === 'owner') {
      return { ...permissionsDefaults, viewFullReleaseHistory: true, manageBackups: true, manageLinks: true, viewOrganizationAudit: true, viewSystemAudit: true }
    }
    return { ...permissionsDefaults, ...(user.organizationPermissions || user.permissions) }
  },
}

const releaseModule = loadTypeScriptModule('app_src/lib/releases.ts', {
  '@/lib/persistence/postgres': persistenceMock,
  '@/lib/users': usersMock,
})
const {
  createDataCheckpoint,
  getReleaseOverview,
  releaseAccessFor,
  ReleasePermissionError,
  ReleaseRequestError,
} = releaseModule.exports

const member = { email: 'member@example.com', role: 'member', permissions: { ...permissionsDefaults } }
const memberWithFullHistory = { ...member, permissions: { ...permissionsDefaults, viewFullReleaseHistory: true } }
const memberWithBackupFlag = {
  ...member,
  permissions: { ...permissionsDefaults, manageBackups: true },
}
const admin = {
  email: 'admin@example.com',
  role: 'admin',
  permissions: { ...permissionsDefaults, viewFullReleaseHistory: true, manageBackups: true },
}

const memberAccess = releaseAccessFor(member)
assert.equal(memberAccess.historyScope, 'last-30-days')
assert.equal(memberAccess.historyDays, 30)
assert.equal(memberAccess.manageBackups, false)
assert.equal(releaseAccessFor(memberWithFullHistory).historyScope, 'last-30-days')
assert.equal(releaseAccessFor(memberWithBackupFlag).manageBackups, false)
assert.equal(releaseAccessFor(admin).historyScope, 'full')
assert.equal(releaseAccessFor(admin).manageBackups, true)
assert.equal(releaseAccessFor({ ...admin, permissions: permissionsDefaults }).manageBackups, false)
assert.equal(releaseAccessFor({ ...admin, permissions: permissionsDefaults }).historyScope, 'last-30-days')
assert.equal(releaseAccessFor({ ...admin, role: 'owner', permissions: permissionsDefaults }).manageBackups, true)
assert.equal(releaseAccessFor({
  ...admin,
  organizationRole: 'member',
  organizationPermissions: permissionsDefaults,
}).manageBackups, false)

overviewQueries.length = 0
const memberOverview = await getReleaseOverview(member)
assert.equal(memberOverview.releases.length, 1)
assert.equal(memberOverview.releases[0].shortCommit, 'abcdef1')
assert.equal(Object.hasOwn(memberOverview, 'checkpoints'), false)
assert.equal(overviewQueries.length, 1)
assert.deepEqual(Array.from(overviewQueries[0].values), [false, 30])

overviewQueries.length = 0
const adminOverview = await getReleaseOverview(admin)
assert.equal(adminOverview.checkpoints.length, 1)
assert.equal(overviewQueries.length, 2)
assert.ok(overviewQueries.some(({ sql }) => sql.includes('FROM data_checkpoints')))
assert.ok(!overviewQueries.find(({ sql }) => sql.includes('FROM data_checkpoints')).sql.includes('snapshot'))

await assert.rejects(
  createDataCheckpoint(memberWithBackupFlag, { label: 'Denied', reason: 'Member flag must not elevate' }),
  (error) => error instanceof ReleasePermissionError,
)
assert.equal(transactionCount, 0)
await assert.rejects(
  createDataCheckpoint(admin, { label: '', reason: 'Missing label' }),
  (error) => error instanceof ReleaseRequestError,
)
assert.equal(transactionCount, 0)

const firstCheckpoint = await createDataCheckpoint(admin, { label: 'Before import', reason: 'Audit checkpoint' })
const secondCheckpoint = await createDataCheckpoint(admin, { label: 'Before import', reason: 'Audit checkpoint' })
assert.equal(transactionCount, 2)
assert.equal(firstCheckpoint.checksum, secondCheckpoint.checksum)
assert.equal(checkpointInserts.length, 2)
assert.equal(checkpointInserts[0][5], checkpointInserts[1][5])
assert.equal(checkpointInserts[0][6], checkpointInserts[1][6])
assert.equal(Buffer.byteLength(checkpointInserts[0][5], 'utf8'), checkpointInserts[0][7])
assert.equal(
  crypto.createHash('sha256').update(checkpointInserts[0][5]).digest('hex'),
  checkpointInserts[0][6],
)

const snapshot = JSON.parse(checkpointInserts[0][5])
const counts = JSON.parse(checkpointInserts[0][4])
assert.equal(snapshot.schemaVersion, 1)
assert.deepEqual(
  Object.keys(snapshot.objects),
  [...Object.keys(snapshot.objects)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
)
assert.deepEqual(Object.keys(snapshot.objects.tasks[0]), ['id', 'payload'])
assert.deepEqual(Object.keys(snapshot.objects.tasks[0].payload), ['a', 'z'])
assert.equal(Object.keys(counts).length, tableNames.length)
assert.ok(Object.values(counts).every((count) => count === 1))

for (const forbiddenTable of ['auth_magic_codes', 'app_user_invitations', 'agent_chatgpt_credentials']) {
  assert.ok(!releaseModule.source.includes(forbiddenTable), `checkpoint source must exclude ${forbiddenTable}`)
  assert.ok(!Object.hasOwn(snapshot.objects, forbiddenTable), `checkpoint snapshot must exclude ${forbiddenTable}`)
}
assert.ok(releaseModule.source.includes('email, role, status, display_name'))
assert.ok(!releaseModule.source.includes('SELECT * FROM app_users'))
assert.ok(releaseModule.source.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'))
assert.ok(releaseModule.source.includes('octet_length(to_jsonb(checkpoint_row)::text)'))
for (const fragment of ['MAX_CHECKPOINT_ROWS', 'MAX_CHECKPOINT_BYTES', 'MAX_RETAINED_CHECKPOINTS', 'CHECKPOINT_COOLDOWN_MINUTES']) {
  assert.ok(releaseModule.source.includes(fragment), `checkpoint source missing ${fragment}`)
}
assert.ok(releaseModule.source.includes('getLocalReleaseOverview'))

let requestUserImplementation = async () => admin
let createCheckpointImplementation = async () => checkpointRow
let postgresStorageEnabled = true
let hostedRuntime = true
const routeModule = loadTypeScriptModule('app_src/app/api/versions/route.ts', {
  'next/server': {
    NextResponse: {
      json(body, init = {}) {
        return { body, status: init.status || 200 }
      },
    },
  },
  '@/lib/requestUser': {
    requireRequestUser(req) {
      return requestUserImplementation(req)
    },
  },
  '@/lib/persistence/config': {
    isPostgresStorageEnabled() { return postgresStorageEnabled },
    isHostedRuntime() { return hostedRuntime },
  },
  '@/lib/releases': {
    ...releaseModule.exports,
    async getReleaseOverview(user) {
      return { access: releaseAccessFor(user), releases: [] }
    },
    createDataCheckpoint(user, body) {
      return createCheckpointImplementation(user, body)
    },
  },
})

postgresStorageEnabled = false
hostedRuntime = false
assert.equal((await routeModule.exports.GET({})).status, 200)
postgresStorageEnabled = true
hostedRuntime = true

requestUserImplementation = async () => { throw new Error('Unauthorized') }
assert.equal((await routeModule.exports.GET({})).status, 401)
requestUserImplementation = async () => { throw new Error('User access is not active') }
assert.equal((await routeModule.exports.GET({})).status, 401)
requestUserImplementation = async () => member
let bodyParsed = false
const denied = await routeModule.exports.POST({
  async json() {
    bodyParsed = true
    return { label: 'Denied', reason: 'Denied' }
  },
})
assert.equal(denied.status, 403)
assert.equal(bodyParsed, false)

requestUserImplementation = async () => admin
assert.equal((await routeModule.exports.POST({ async json() { throw new SyntaxError('bad json') } })).status, 400)
createCheckpointImplementation = async () => { throw new ReleaseRequestError('Label is required') }
assert.equal((await routeModule.exports.POST({ async json() { return {} } })).status, 400)
createCheckpointImplementation = async () => { throw new Error('database unavailable') }
const unexpected = await routeModule.exports.POST({ async json() { return { label: 'A', reason: 'B' } } })
assert.equal(unexpected.status, 500)
assert.equal(unexpected.body.error, 'Release request failed')
createCheckpointImplementation = async () => checkpointRow
assert.equal((await routeModule.exports.POST({ async json() { return { label: 'A', reason: 'B' } } })).status, 201)

for (const forbiddenImport of ['child_process', "from 'fs'", "from 'path'"]) {
  assert.ok(!routeModule.source.includes(forbiddenImport), `Versions API must not import ${forbiddenImport}`)
}
for (const fragment of ["export const runtime = 'nodejs'", '{ status: 401 }', '{ status: 403 }', '{ status: 400 }', '{ status: 500 }']) {
  assert.ok(routeModule.source.includes(fragment), `Versions API missing ${fragment}`)
}

const uiSource = read('app_src/components/versions/VersionsSection.tsx')
for (const fragment of ['Versions', 'Release Notes', 'Commits', 'last-30-days', 'Data Checkpoints', 'Railway provider backups', 'create-data-checkpoint']) {
  assert.ok(uiSource.includes(fragment), `release UI missing ${fragment}`)
}
for (const legacyAction of ['/api/versions/revert', 'Restore task data', 'Revert code']) {
  assert.ok(!uiSource.includes(legacyAction), `release UI must not include ${legacyAction}`)
}

const recorderSource = read('scripts/record-release.mjs')
for (const fragment of [
  'docs/releases/catalog.json',
  'scripts', 'db-migrate.mjs',
  'ON CONFLICT (environment, release_key)',
  'IS DISTINCT FROM',
  'release_entries.deployed_at',
  'oncePerEnvironment',
  'passed the ClawPilot startup health contract',
]) {
  assert.ok(recorderSource.includes(fragment), `release recorder missing ${fragment}`)
}
assert.ok(!recorderSource.includes('requestUser'))
assert.ok(!recorderSource.includes('APP_SESSION_SECRET'))
assert.ok(
  recorderSource.indexOf("'RAILWAY_GIT_COMMIT_SHA'") < recorderSource.indexOf("'RELEASE_COMMIT'"),
  'Railway commit metadata must take precedence over direct-upload release metadata',
)

const runtimeRouteSource = read('app_src/app/api/runtime/route.ts')
const versionRouteSource = read('app_src/app/api/version/route.ts')
for (const [label, source] of [['runtime', runtimeRouteSource], ['version', versionRouteSource]]) {
  assert.ok(source.includes('process.env.RELEASE_COMMIT'), `${label} endpoint missing direct-upload release identity`)
}
assert.ok(runtimeRouteSource.includes('Hosted build identity is not configured'))
assert.ok(runtimeRouteSource.includes('!commit && !hosted'))

const railwayConfig = JSON.parse(read('railway.json'))
assert.equal(railwayConfig.deploy.preDeployCommand, 'bash scripts/predeploy-railway.sh')
const railwayPredeploy = read('scripts/predeploy-railway.sh')
for (const fragment of [
  'npm run mail:verify',
  'npm run db:preflight:commerce-storage',
  'npm run db:migrate',
  'npm run verify:commerce-order-revision-evidence-keys',
  'npm run demo:seed',
  'npm run demo:verify',
]) {
  assert.ok(railwayPredeploy.includes(fragment), `Railway predeploy wrapper missing ${fragment}`)
}
assert.ok(!railwayPredeploy.includes('CLAWPILOT_DEMO_MODE'))
assert.ok(!railwayPredeploy.includes('RAILWAY_ENVIRONMENT_NAME'))
assert.ok(
  railwayPredeploy.indexOf('npm run db:preflight:commerce-storage')
    < railwayPredeploy.indexOf('npm run db:migrate'),
  'commerce storage preflight must run before online migrations',
)
assert.ok(
  railwayPredeploy.indexOf('npm run db:migrate') < railwayPredeploy.indexOf('npm run demo:seed'),
  'demo data must only be seeded after migrations complete',
)
assert.ok(
  railwayPredeploy.indexOf('npm run db:migrate')
    < railwayPredeploy.indexOf('npm run verify:commerce-order-revision-evidence-keys')
  && railwayPredeploy.indexOf('npm run verify:commerce-order-revision-evidence-keys')
    < railwayPredeploy.indexOf('npm run demo:seed'),
  'revision evidence keys must be verified after migrations and before seeding',
)
const railwayStart = read('scripts/start-railway.sh')
assert.ok(railwayStart.indexOf('/api/health') < railwayStart.indexOf('npm run release:record'))
assert.ok(railwayStart.includes('application did not pass health validation'))

const vercelConfig = JSON.parse(read('app_src/vercel.json'))
assert.deepEqual(
  vercelConfig.git?.deploymentEnabled,
  { dev: false, main: false },
  'Vercel must wait for an explicit exact-commit deployment on dev and main while retaining feature previews',
)

const vercelBuild = read('scripts/vercel-build.mjs')
for (const fragment of [
  "run('npm', ['run', 'build'], appRoot)",
  "if (environment === 'production')",
  "if (branch !== 'main')",
  "environment === 'preview' && branch === 'dev'",
  "resolve(root, 'scripts', 'verify-mail-sender.mjs')",
  'database migrations are owned by the Railway deployment path',
]) {
  assert.ok(vercelBuild.includes(fragment), `Vercel build contract missing ${fragment}`)
}
for (const forbiddenMigrationPath of [
  'db-migrate.mjs',
  'db:migrate',
  'db:preflight:commerce-storage',
  'predeploy-railway.sh',
]) {
  assert.ok(
    !vercelBuild.includes(forbiddenMigrationPath),
    `Vercel build must not invoke the migration authority through ${forbiddenMigrationPath}`,
  )
}
assert.ok(
  vercelBuild.indexOf("run('npm', ['run', 'build'], appRoot)")
    < vercelBuild.indexOf("resolve(root, 'scripts', 'verify-mail-sender.mjs')"),
  'Vercel must compile before its managed mail verification gate',
)

console.log('PASS test-release-contract')
