import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  }, { env })
  return module.exports
}

function request(path, body = {}, credential = secret) {
  const req = new Request(`${origin}${path}`, { method: 'POST', body: JSON.stringify(body), headers: {
    'content-type': 'application/json', origin, authorization: `Bearer ${credential}`,
  } })
  return Object.assign(req, { nextUrl: new URL(req.url) })
}

test('only authorized CRM outbox work pauses before the worker; Drive folder work still runs', async () => {
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
    nativeResolutionHeld: false, projectionsQueued: 0, items: [], customerFolders: { claimed: 1 } })
  assert.deepEqual(work, [])
  assert.deepEqual(folders, [{ limit: 1 }])

  delete env[flag]
  const resumed = await route.POST(request(path, { limit: 3 }))
  assert.equal(resumed.status, 200)
  assert.deepEqual(await resumed.json(), { ok: true, claimed: 1, customerFolders: { claimed: 1 } })
  assert.deepEqual(work, [{ limit: 3 }])
  assert.deepEqual(folders, [{ limit: 1 }, { limit: 1 }])
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

test('manual exact Email Apply is rejected before claim, but preview and later Apply still work', async () => {
  const env = { [flag]: '1' }, work = []
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
    '@/lib/requestUser': { requireRequestUser: async () => actor, requestSession: async () => ({
      authenticatedUser: actor.email, effectiveUser: actor.email, activeWorkspaceOrganizationId: workspaceId,
    }) },
    '@/lib/tenancy': { resolvePipelineSpaceAccess: async () => ({ id: pipelineId,
      ownerEmail: actor.email, workspaceOrganizationId: workspaceId }) },
  }, env)
  const payload = { pipelineId, connectionId: 'fixture-mailbox', messageIds: ['a1'] }
  const apply = { ...payload, apply: true, expectedDigest: 'a'.repeat(64) }
  const paused = await route.POST(request(path, apply))
  assert.equal(paused.status, 503)
  assert.match((await paused.json()).error, /temporarily paused/)
  assert.deepEqual(work, [])
  assert.equal((await route.POST(request(path, payload))).status, 200)
  assert.deepEqual(work, [false])

  delete env[flag]
  assert.equal((await route.POST(request(path, apply))).status, 200)
  assert.deepEqual(work, [false, true])
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
