import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const flag = 'CLAWPILOT_CRM_SYNC_MAINTENANCE'
const origin = 'https://app.example.test'
const secret = 'fixture-worker-secret'
const nextServer = { NextResponse: { json: (body, init) => Response.json(body, init) } }

function load(path, dependencies, env) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(read(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  new Function('module', 'exports', 'require', 'process', compiled)(module, module.exports, name => {
    if (name.startsWith('node:')) return require(name)
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected import: ${name}`)
    return dependencies[name]
  }, { env, cwd: () => '/maintenance-fixture' })
  return module.exports
}

function request(path, body = {}, credential = secret, method = 'POST') {
  const req = new Request(`${origin}${path}`, { method, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), headers: {
    'content-type': 'application/json', origin, authorization: `Bearer ${credential}`,
  } })
  return Object.assign(req, { nextUrl: new URL(req.url) })
}

test('authorized CRM outbox pauses before either SuiteCRM or Drive folder worker', async () => {
  const env = { [flag]: '1', PIPELINE_OUTBOX_WORKER_SECRET: secret }
  const work = [], folders = []
  const path = '/api/crm/outbox/process'
  const route = load(`app_src/app${path}/route.ts`, {
    'next/server': nextServer,
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
    '@/lib/crm/worker': { processSuiteCrmOutbox: async input => { work.push(input); return { claimed: 1 } } },
    '@/lib/crm/customerFolderJobs': { processCustomerFolderJobs: async input => { folders.push(input); return { claimed: 1 } } },
  }, env)
  assert.equal((await route.POST(request(path, {}, 'wrong'))).status, 401)
  assert.deepEqual(work, [])
  assert.deepEqual(folders, [])

  const paused = await route.POST(request(path, { limit: 3 }))
  assert.equal(paused.status, 200)
  assert.deepEqual(await paused.json(), { ok: true, paused: true, claimed: 0, succeeded: 0, failed: 0, dead: 0, held: 0,
    nativeResolutionHeld: false, projectionsQueued: 0, items: [],
    customerFolders: { claimed: 0, ready: 0, queued: 0, held: 0, leaseLost: 0 } })
  assert.deepEqual(work, [])
  assert.deepEqual(folders, [])

  delete env[flag]
  const resumed = await route.POST(request(path, { limit: 3 }))
  assert.equal(resumed.status, 200)
  assert.deepEqual(await resumed.json(), { ok: true, claimed: 1, customerFolders: { claimed: 1 } })
  assert.deepEqual(work, [{ limit: 3 }])
  assert.deepEqual(folders, [{ limit: 1 }])
})

test('authorized CRM integration poll returns before any providers or leases, then resumes normally', async () => {
  const env = { [flag]: '1', PIPELINE_OUTBOX_WORKER_SECRET: secret }
  const work = []
  const path = '/api/crm/integrations/process'
  const deps = { 'next/server': nextServer, '@/lib/persistence/config': { isPostgresStorageEnabled: () => true } }
  const workers = {
    suiteCrmAccountContactIngestion: 'processSuiteCrmAccountContactIngestion',
    suiteCrmMeetingIngestion: 'processSuiteCrmMeetingIngestion',
    suiteCrmCallIngestion: 'processSuiteCrmCallIngestion',
    suiteCrmInteractionIngestion: 'processSuiteCrmInteractionIngestion',
    suiteCrmProductImageIngestion: 'processSuiteCrmProductImageIngestion',
    integrationActions: 'processDueCrmIntegrationActions',
    emailIngestion: 'processInboundGmailIngestion',
    calendarIngestion: 'processCalendarIngestion',
    calendarDiscoveryPersistence: 'processCalendarDiscoveryInPostgres',
  }
  for (const [file, worker] of Object.entries(workers)) {
    deps[`@/lib/crm/${file}`] = { [worker]: async () => { work.push(file); return [] } }
  }
  const route = load(`app_src/app${path}/route.ts`, deps, env)
  assert.equal((await route.POST(request(path, {}, 'wrong'))).status, 401)
  const paused = await route.POST(request(path))
  assert.equal(paused.status, 200)
  assert.deepEqual(await paused.json(), { ok: true, paused: true })
  assert.deepEqual(work, [])

  env[flag] = '0'
  const resumed = await route.POST(request(path))
  assert.equal(resumed.status, 200)
  assert.equal((await resumed.json()).ok, true)
  assert.deepEqual(work, Object.keys(workers))
})

test('exact Email publication pauses preview and Apply before owner or pipeline provisioning', async () => {
  const env = { [flag]: '1' }, work = [], authorizations = []
  const workspaceId = '11111111-1111-4111-8111-111111111111'
  const pipelineId = '22222222-2222-4222-8222-222222222222'
  const actor = { email: 'owner@example.test', organizationId: workspaceId }
  const path = '/api/crm/email-publication'
  const route = load(`app_src/app${path}/route.ts`, {
    'next/server': nextServer,
    '@/lib/browserSameOrigin': { isBrowserSameOriginRequest: () => true },
    '@/lib/crm/exactEmailPublication': { publishExactCrmEmails: async input => { work.push(input.apply); return { applied: input.apply } } },
    '@/lib/persistence/crmExactEmailPublication': { ExactEmailPublicationHeld: class extends Error {} },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
    '@/lib/publicUrl': { appPublicUrl: () => origin },
    '@/lib/requestUser': { requireRequestUser: async () => { authorizations.push('actor'); return actor }, requestSession: async () => ({
      authenticatedUser: actor.email, effectiveUser: actor.email, activeWorkspaceOrganizationId: workspaceId,
    }) },
    '@/lib/tenancy': { resolvePipelineSpaceAccess: async () => { authorizations.push('pipeline'); return { id: pipelineId,
      ownerEmail: actor.email, workspaceOrganizationId: workspaceId } } },
  }, env)
  const payload = { pipelineId, connectionId: 'fixture-mailbox', messageIds: ['a1'] }
  const apply = { ...payload, apply: true, expectedDigest: 'a'.repeat(64) }
  const paused = await route.POST(request(path, apply))
  assert.equal(paused.status, 503)
  assert.match((await paused.json()).error, /temporarily paused/)
  assert.equal(paused.headers.get('retry-after'), '60')
  assert.equal((await route.POST(request(path, payload))).status, 503)
  assert.deepEqual(work, [])
  assert.deepEqual(authorizations, [])

  delete env[flag]
  assert.equal((await route.POST(request(path, payload))).status, 200)
  assert.equal((await route.POST(request(path, apply))).status, 200)
  assert.deepEqual(work, [false, true])
  assert.deepEqual(authorizations, ['actor', 'pipeline', 'actor', 'pipeline'])
})

test('email recovery pauses preview and Apply before even starting session, provisioning or reconciliation', async () => {
  const env = { [flag]: '1' }, stages = []
  const workspaceId = '11111111-1111-4111-8111-111111111111'
  const pipelineId = '22222222-2222-4222-8222-222222222222'
  const actor = { email: 'fixture-owner@example.test', organizationId: workspaceId }
  const path = '/api/crm/email-recovery'
  const route = load(`app_src/app${path}/route.ts`, {
    'next/server': nextServer,
    '@/lib/browserSameOrigin': { isBrowserSameOriginRequest: () => true },
    '@/lib/crm/emailIngestion': {
      reconcileGmailMessages: async input => { stages.push(input.apply); return { applied: input.apply } },
      SafeEmailIngestionError: class extends Error {},
    },
    '@/lib/crm/caseyGmailReview': {},
    '@/lib/globalIds.mjs': { globalIdPattern: () => /^unused-fixture$/ },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
    '@/lib/publicUrl': { appPublicUrl: () => origin },
    '@/lib/requestUser': { requireRequestUser: async () => actor, requestSession: async () => {
      stages.push('session')
      return { authenticatedUser: actor.email, effectiveUser: actor.email, activeWorkspaceOrganizationId: workspaceId }
    } },
    '@/lib/tenancy': { resolvePipelineSpaceAccess: async () => {
      stages.push('provisioning-capable')
      return { id: pipelineId, ownerEmail: actor.email, workspaceOrganizationId: workspaceId }
    } },
  }, env)
  const preview = { pipelineId, connectionId: 'fixture-only', messageIds: ['f00df00d'] }
  const apply = { ...preview, apply: true, expectedDigest: 'a'.repeat(64) }
  for (const payload of [preview, apply]) {
    const response = await route.POST(request(path, payload))
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('retry-after'), '60')
  }
  assert.deepEqual(stages, [])
  env[flag] = '0'
  assert.equal((await route.POST(request(path, preview))).status, 200)
  assert.equal((await route.POST(request(path, apply))).status, 200)
  assert.deepEqual(stages, ['session', 'provisioning-capable', false, 'session', 'provisioning-capable', true])
})

test('ordinary CRM gates GET, POST and PATCH before any route logic', async () => {
  const env = { [flag]: '1' }, calls = []
  const path = '/api/crm'
  const source = `app_src/app${path}/route.ts`
  const deps = Object.fromEntries([...read(source).matchAll(/\bfrom ['"]([^'"]+)['"]/g)].map(([, id]) => [id, {}]))
  deps['next/server'] = nextServer
  deps['@/lib/persistence/config'] = { isPostgresStorageEnabled: () => { calls.push('storage'); return false } }
  const route = load(source, deps, env)
  for (const method of ['GET', 'POST', 'PATCH']) {
    const response = await route[method](request(path, {}, secret, method))
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '60')
  }
  assert.deepEqual(calls, [])
  delete env[flag]
  assert.equal((await route.GET(request(path, {}, secret, 'GET'))).status, 409)
  assert.deepEqual(calls, ['storage'])
})

test('CRM writes through Pipeline pause before storage, authorization, request body, or provider access', async () => {
  const env = { [flag]: '1' }, calls = []
  const routes = [
    ['/api/pipeline', ['POST']],
    ['/api/pipeline/catalog', ['GET', 'POST']],
    ['/api/pipeline/opportunity/[id]', ['POST', 'PATCH']],
    ['/api/pipeline/sync/pull', ['POST']],
  ]
  for (const [path, methods] of routes) {
    const source = `app_src/app${path}/route.ts`
    const deps = Object.fromEntries([...read(source).matchAll(/\bfrom ['"]([^'"]+)['"]/g)].map(([, id]) => [id, {}]))
    const storage = () => { calls.push('storage'); return false }
    deps['next/server'] = nextServer
    deps.fs = { existsSync: () => false, readFileSync: () => '[]' }
    deps.path = require('node:path')
    deps['@/lib/persistence/pipeline'] = { isPostgresPipelineStoreEnabled: storage }
    deps['@/lib/persistence/tasks'] = { isPostgresTaskStoreEnabled: storage }
    const route = load(source, deps, env)
    for (const method of methods) {
      const req = request(path.replace('[id]', 'fixture-only'), {}, secret, method)
      req.json = async () => { calls.push('body'); return {} }
      const response = await route[method](req)
      assert.equal(response.status, 503)
      assert.equal(response.headers.get('retry-after'), '60')
      assert.deepEqual(calls, [], `${method} ${path}`)
    }
    if (path === '/api/pipeline') {
      assert.equal((await route.GET(request(path, {}, secret, 'GET'))).status, 200)
      assert.deepEqual(calls.splice(0), ['storage', 'storage', 'storage'])
    }
  }
})

test('existing project boards keep workspace and board ACLs without default provisioning during maintenance', async () => {
  const env = { [flag]: '1' }, reads = []
  const actor = { email: 'fixture-owner@example.test', organizationId: 'fixture-workspace', organizationAccessOrigin: 'membership' }
  const inaccessible = { ...actor, organizationId: 'other-workspace' }
  const path = 'app_src/lib/tenancy.ts'
  const deps = Object.fromEntries([...read(path).matchAll(/\bfrom ['"]([^'"]+)['"]/g)].map(([, id]) => [id, {}]))
  const board = (id, access_role, is_default = false) => ({
    id, access_role, is_default, owner_email: access_role === 'owner' ? actor.email : 'shared@example.test',
    workspace_organization_id: actor.organizationId, name: id, members: [],
  })
  let boards = [board('owned-default', 'owner', true), board('shared-editor', 'editor'), board('shared-viewer', 'viewer')]
  let permissions = { viewProjects: true, viewCrm: true }
  let coldBootstrap = false
  const unexpectedWrite = () => assert.fail('Board access must not provision existing resources')
  Object.assign(deps, {
    '@/lib/persistence/postgres': {
      query: async (sql, params) => {
        assert.match(sql, /^\s*SELECT\b/)
        reads.push(params)
        if (/FROM project_boards board/.test(sql)) {
          assert.match(sql, /board\.workspace_organization_id = \$2::uuid/)
          assert.match(sql, /membership\.user_email = \$1/)
          return { rows: boards }
        }
        if (/^\s*SELECT 1 FROM clawpilot_crm_root_read_workspaces/.test(sql)) {
          assert.ok(coldBootstrap, 'Existing resources need no provisioning eligibility probe')
          return { rows: [] }
        }
        assert.match(sql, /FROM pipeline_spaces pipeline/)
        return { rows: [] }
      },
      withTransaction: () => {
        if (coldBootstrap) throw new Error('fixture cold board bootstrap')
        unexpectedWrite()
      },
    },
    '@/lib/organizations': { ensurePrimaryWorkspaceOrganization: unexpectedWrite },
    '@/lib/users': {
      normalizeUserEmail: value => String(value).toLowerCase(),
      requireActiveAppUser: async email => { assert.equal(email, actor.email); return actor },
      getAppUser: async () => actor,
      effectiveUserPermissions: () => permissions,
    },
    '@/lib/workspaceMemberships': {
      requireWorkspaceAppUser: async (email, organizationId) => {
        assert.equal(email, actor.email)
        if (organizationId !== actor.organizationId) throw new Error('Active workspace access is not available')
        return actor
      },
    },
    '@/lib/demoMode': { isDemoWorkspaceId: () => false },
  })
  const tenancy = load(path, deps, env)
  const listed = await tenancy.listProjectBoards(actor)
  assert.equal(listed.map(item => item.accessRole).join(','), 'owner,editor,viewer')
  assert.equal((await tenancy.resolveProjectBoardAccess({ actorEmail: actor })).id, 'owned-default')
  const editor = await tenancy.resolveProjectBoardAccess({ actorEmail: actor.email, boardId: 'shared-editor' })
  const viewer = await tenancy.resolveProjectBoardAccess({ actorEmail: actor, boardId: 'shared-viewer' })
  assert.doesNotThrow(() => tenancy.requireResourceEditor(editor))
  assert.throws(() => tenancy.requireResourceEditor(viewer), /view-only/i)
  await assert.rejects(tenancy.resolveProjectBoardAccess({ actorEmail: actor, boardId: 'foreign-board' }), /Project board access denied/)
  await assert.rejects(tenancy.listProjectBoards(inaccessible), /Active workspace access is not available/)
  const defaults = await tenancy.ensureDefaultResourcesForUser(actor)
  assert.equal(defaults.boardId, 'owned-default')
  assert.equal(defaults.pipelineId, null)
  assert.equal(defaults.pipelineProvisioningRequired, false)
  boards = [board('shared-editor', 'editor')]
  assert.equal((await tenancy.resolveProjectBoardAccess({ actorEmail: actor })).id, 'shared-editor')
  boards = []
  assert.equal((await tenancy.listProjectBoards(actor)).length, 0)
  env[flag] = '0'
  boards = [board('owned-default', 'owner', true), board('shared-editor', 'editor')]
  assert.equal((await tenancy.listProjectBoards(actor.email)).length, 2, 'Existing defaults stay read-only without the application flag')
  boards = [board('shared-editor', 'editor')]
  assert.equal((await tenancy.resolveProjectBoardAccess({ actorEmail: actor, boardId: 'shared-editor' })).id, 'shared-editor')
  const beforeDenied = reads.length
  permissions = { viewProjects: false, viewCrm: false }
  assert.equal((await tenancy.listProjectBoards(actor)).length, 0)
  assert.equal(reads.length, beforeDenied)
  permissions = { viewProjects: true, viewCrm: true }
  coldBootstrap = true
  await assert.rejects(tenancy.listProjectBoards(actor), /fixture cold board bootstrap/,
    'Outside maintenance a shared-only list still provisions a personal default')
})

test('CRM board binding lookup cannot repair a missing binding during maintenance', async () => {
  const env = { [flag]: '1' }, path = 'app_src/lib/crm/boardProjection.ts'
  const deps = Object.fromEntries([...read(path).matchAll(/\bfrom ['"]([^'"]+)['"]/g)].map(([, id]) => [id, {}]))
  let row = { board_id: 'board', board_name: 'CRM board', owner_organization_id: 'workspace', pipeline_id: null }
  let repairs = 0
  deps['@/lib/persistence/postgres'] = {
    query: async sql => { assert.match(sql, /^SELECT\b/); return { rows: [row] } },
    withTransaction: () => { repairs++; throw new Error('fixture binding repair') },
  }
  const projection = load(path, deps, env)
  assert.equal(await projection.resolveCrmBoardBinding('board'), null)
  row = { ...row, pipeline_id: 'pipeline', workspace_organization_id: 'workspace' }
  assert.equal((await projection.resolveCrmBoardBinding('board')).pipeline_id, 'pipeline')
  env[flag] = '0'
  assert.equal((await projection.resolveCrmBoardBinding('board')).pipeline_id, 'pipeline')
  assert.equal(repairs, 0)
  row = { ...row, pipeline_id: null }
  await assert.rejects(projection.resolveCrmBoardBinding('board'), /fixture binding repair/)
  assert.equal(repairs, 1)
})

test('Projects blocks CRM board mutations but still reads and saves ordinary tasks during maintenance', async () => {
  const env = { [flag]: '1' }, writes = [], reads = [], reconciles = [], pipelineChecks = []
  const path = '/api/tasks', source = `app_src/app${path}/route.ts`
  const deps = Object.fromEntries([...read(source).matchAll(/\bfrom ['"]([^'"]+)['"]/g)].map(([, id]) => [id, {}]))
  const actor = { email: 'fixture-owner@example.test' }, crmBoard = 'fixture-crm-board', unbound = 'fixture-crm-unbound'
  let pipelineAccess = true
  const fixtureTask = boardId => ({ id: 'fixture-card', title: 'Fixture', status: 'backlog',
    ...(boardId === crmBoard ? { crm: { recordId: 'fixture-record' } } : {}) })
  const identity = value => value
  Object.assign(deps, {
    'next/server': nextServer, path: require('node:path'),
    '@/lib/freeze': { ensureNotFrozen: () => null },
    '@/lib/agents/routing': { normalizeProductAgentId: () => undefined },
    '@/lib/crm/boardCard.mjs': { isCrmBoardCard: task => Boolean(task.crm), normalizeCrmBoardCard: identity },
    '@/lib/workItemModel': { applyCanonicalWorkItem: identity, canonicalizeTasks: identity },
    '@/lib/persistence/tasks': {
      isPostgresTaskStoreEnabled: () => true,
      readTasksFromPostgres: async ({ boardId, includeCrmCards }) => {
        reads.push([boardId, includeCrmCards])
        return [fixtureTask(boardId)]
      },
      replaceTasksInPostgres: async (tasks, { boardId }) => writes.push([boardId, tasks[0].desc]),
    },
    '@/lib/requestUser': { requireRequestUser: async () => actor },
    '@/lib/moduleAuthorization': { requireModuleAccess: () => undefined, moduleCapabilitiesForUser: () => ({ crm: true }) },
    '@/lib/workerAuth': { resolveAgentDispatchWorker: async () => null },
    '@/lib/tenancy': {
      requireResourceEditor: () => undefined,
      resolvePipelineSpaceAccess: async ({ pipelineId }) => {
        pipelineChecks.push(pipelineId)
        if (!pipelineAccess) throw new Error('Pipeline access denied')
        return { id: pipelineId }
      },
      resolveProjectBoardAccess: async ({ boardId }) => ({ id: boardId, name: boardId === crmBoard || boardId === unbound ? ' CRM board ' : 'Ordinary' }),
    },
    '@/lib/crm/boardProjection': {
      CRM_BOARD_NAME: 'crm board',
      resolveCrmBoardBinding: async boardId => boardId === crmBoard ? { pipeline_id: 'fixture-pipeline' } : null,
      reconcileCrmBoardProjection: async ({ boardId }) => reconciles.push(boardId),
      updateCrmBoardTaskDescription: async ({ boardId, description }) => {
        writes.push([boardId, description])
        return { description }
      },
    },
  })
  const route = load(source, deps, env)
  const patch = board => route.PATCH(request(`${path}?boardId=${board}`, {
    id: 'fixture-card', desc: 'updated description',
  }, secret, 'PATCH'))
  const paused = await patch(crmBoard)
  assert.equal(paused.status, 503)
  assert.equal(paused.headers.get('retry-after'), '60')
  assert.equal((await patch(unbound)).status, 503)
  assert.equal((await route.POST(request(`${path}?boardId=${unbound}`))).status, 409)
  assert.deepEqual(reads, [])
  assert.deepEqual(writes, [])
  const get = board => route.GET(request(`${path}?boardId=${board}&includeCrmCards=true`, {}, secret, 'GET'))
  assert.equal((await get('fixture-ordinary-board')).status, 200)
  assert.deepEqual(reads.at(-1), ['fixture-ordinary-board', false])
  assert.equal((await get(crmBoard)).status, 200)
  assert.deepEqual(reads.at(-1), [crmBoard, true])
  assert.deepEqual(reconciles, [])
  pipelineAccess = false
  const beforeDenied = reads.length
  assert.equal((await get(crmBoard)).status, 403)
  assert.equal(reads.length, beforeDenied)
  pipelineAccess = true
  assert.equal((await patch('fixture-ordinary-board')).status, 200)
  assert.deepEqual(reads.at(-1), ['fixture-ordinary-board', false])
  env[flag] = '0'
  assert.equal((await get(crmBoard)).status, 200)
  assert.deepEqual(reconciles, [crmBoard])
  assert.equal((await patch(crmBoard)).status, 200)
  assert.ok(pipelineChecks.every(pipeline => pipeline === 'fixture-pipeline'))
  assert.deepEqual(writes, [['fixture-ordinary-board', 'updated description'], [crmBoard, 'updated description']])
})

test('Fractional GET remains available; maintenance POST and PATCH do not enter gateway or queue', async () => {
  const env = { [flag]: '1' }, calls = []
  const path = '/api/integrations/fractional-crm/v1'
  const route = load(`app_src/app${path}/[...path]/route.ts`, {
    '@/lib/fractionalCrmGatewayHttp': { handleFractionalCrmGateway: async req => {
      calls.push(req.method)
      return Response.json({ ok: true })
    } },
    '@/lib/persistence/fractionalCrmGateway': {},
    '@/lib/crm/boardProjection': {},
  }, env)
  assert.equal((await route.GET(request(`${path}/organization/contacts`, {}, secret, 'GET'))).status, 200)
  for (const method of ['POST', 'PATCH']) {
    const response = await route[method](request(`${path}/organization/contacts`, {}, secret, method))
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '60')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal((await response.json()).error, 'GATEWAY_UNAVAILABLE')
  }
  assert.deepEqual(calls, ['GET'])
  env[flag] = '0'
  for (const method of ['POST', 'PATCH']) {
    assert.equal((await route[method](request(`${path}/organization/contacts`, {}, secret, method))).status, 200)
  }
  assert.deepEqual(calls, ['GET', 'POST', 'PATCH'])
})

test('CRM route inventory fences every mutator and every GET with provisioning or audit effects', () => {
  const directory = new URL('../app_src/app/api/crm/', import.meta.url)
  const reviewedReadOnlyGets = new Set([
    'punchout/route.ts', 'root-access/route.ts', 'products/[productId]/faire-product-image/route.ts',
    'products/[productId]/image-import-recovery/route.ts', 'products/[productId]/images/route.ts',
    'products/[productId]/images/[assetId]/route.ts',
  ])
  const workers = new Set(['integrations/process/route.ts', 'outbox/process/route.ts'])
  let fencedHandlers = 0
  for (const path of readdirSync(directory, { recursive: true }).filter(path => path.endsWith('route.ts'))) {
    if (workers.has(path)) continue // Authorized worker response shape is tested above.
    const source = readFileSync(new URL(path, directory), 'utf8')
    assert.doesNotMatch(source, /^export const (GET|POST|PUT|PATCH|DELETE)\b/m, `Review aliased CRM route ${path}`)
    for (const handler of source.matchAll(/^export async function (GET|POST|PUT|PATCH|DELETE)\b[\s\S]*?\)\s*\{/gm)) {
      if (handler[1] === 'GET' && reviewedReadOnlyGets.has(path)) continue
      const afterSignature = source.slice(handler.index + handler[0].length).replace(/^\s*(?:\/\/[^\n]*\n\s*)*/, '')
      assert.match(afterSignature, /^if \(process\.env\.CLAWPILOT_CRM_SYNC_MAINTENANCE === '1'\)/,
        `${handler[1]} ${path} must fence before any downstream work`)
      fencedHandlers++
    }
  }
  assert.ok(fencedHandlers >= 25)
})

test('direct SuiteCRM calls cannot open OAuth or a media session while fenced', async () => {
  const env = { [flag]: '1', SUITECRM_BASE_URL: 'https://suitecrm.example.test',
    SUITECRM_CLIENT_ID: 'fixture-client-id', SUITECRM_CLIENT_SECRET: 'fixture-client-secret' }
  const calls = []
  const transport = async url => {
    calls.push(new URL(url).pathname)
    return Response.json(url.endsWith('/Api/access_token') ? { access_token: 'fixture' } : { data: [] })
  }
  const client = load('app_src/lib/crm/suiteCrmClient.ts', {
    '@/lib/currency': {}, '@/lib/crm/productImagePublic': {}, '@/lib/crm/suiteCrmNativeProductImageClient': {},
    '@/lib/publicUrl': {}, '@/lib/crm/suiteCrmNativeEmailProjection': {}, '@/lib/crm/nativeEmailPublicationTransport': {},
  }, env)
  const media = load('app_src/lib/crm/suiteCrmNativeProductImageClient.ts', {
    sharp: {}, '@/lib/crm/productImagePublic': {}, '@/lib/publicUrl': {},
  }, env)
  const reader = load('app_src/lib/crm/suiteCrmProductImageReadClient.ts', {}, env)
  await assert.rejects(client.testSuiteCrmConnection(transport), /temporarily paused/)
  await assert.rejects(client.requestSuiteCrmNativeRecordLifecycle({}, transport), /temporarily paused/)
  await assert.rejects(media.projectSuiteCrmNativeProductImage({ entity: 'products', productImage: null }, transport), /temporarily paused/)
  assert.throws(() => reader.createSuiteCrmProductImageReadClient(transport), /temporarily paused/)
  assert.deepEqual(calls, [])

  delete env[flag]
  assert.equal(await client.testSuiteCrmConnection(transport), true)
  assert.deepEqual(calls, ['/Api/access_token', '/Api/V8/meta/modules'])
  env[flag] = '1'
  await assert.rejects(client.testSuiteCrmConnection(transport), /temporarily paused/)
  assert.deepEqual(calls, ['/Api/access_token', '/Api/V8/meta/modules'], 'a cached OAuth token cannot bypass the fence')
})

test('health reports intentional CRM pause without skipping unrelated worker readiness', () => {
  const source = read('app_src/app/api/health/route.ts')
  assert.match(source, /crm = \{ status: crmSyncPaused \? 'paused' : 'configured' \}/)
  assert.match(source, /if \(crmEnabled && !crmSyncPaused\) \{\s*const crmHeartbeat = await readSuiteCrmWorkerHeartbeat\(\)/)
  assert.match(source, /const heartbeat = await readPipelineOutboxWorkerHeartbeatFromPostgres\(\)/)
  assert.match(source, /errors\.push\('Pipeline outbox worker heartbeat is missing or stale\.'\)/)
})

test('Railway startup rejects a malformed maintenance selector even if CRM is disabled', () => {
  const validator = read('scripts/validate-runtime-config.mjs').match(/function validateSuiteCrmConfiguration\(\) \{[\s\S]+?\n\}/)?.[0]
  assert.ok(validator)
  const validate = env => new Function('process', 'fail', `${validator}\nreturn validateSuiteCrmConfiguration()`)(
    { env }, message => { throw new Error(message) },
  )
  for (const accepted of [undefined, '', '0', '1']) {
    assert.equal(validate({ [flag]: accepted, CRM_ENABLED: '0' }), 'disabled')
  }
  for (const invalid of ['true', ' 1 ', '2', 'off']) {
    assert.throws(() => validate({ [flag]: invalid, CRM_ENABLED: '0' }), /CLAWPILOT_CRM_SYNC_MAINTENANCE/)
  }
})
