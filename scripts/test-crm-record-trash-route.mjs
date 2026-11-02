#!/usr/bin/env node
// Execute the actual route with its real origin helper; storage and auth are
// mocked. This is command/authorization routing proof, not database deletion.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as publicOriginRouting from '../app_src/lib/publicOriginRouting.mjs'
const requireApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireApp('typescript')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function load(source, dependencies, environment = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, Error, URL, process: { env: environment }, require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`)
      return dependencies[name]
    } })
  return module.exports
}
const routeSource = read('app_src/app/api/crm/route.ts')
const helper = load(read('app_src/lib/browserSameOrigin.ts'), { './publicOriginRouting.mjs': publicOriginRouting })
const entities = ['organizations', 'contacts', 'products', 'leads', 'opportunities', 'meetings', 'interactions', 'campaigns']
const actor = { email: 'editor@example.test' }
const pipelineId = '00000000-0000-4000-8000-000000000001'
const recordId = '00000000-0000-4000-8000-000000000002'
function harness(options = {}) {
  const calls = [], imports = {}
  const ast = ts.createSourceFile('route.ts', routeSource, ts.ScriptTarget.Latest, true)
  for (const node of ast.statements.filter(ts.isImportDeclaration)) imports[node.moduleSpecifier.text] = {}
  Object.assign(imports, {
    'node:crypto': requireApp('node:crypto'),
    'next/server': { NextResponse: { json: (body, init = {}) => ({ body, status: init.status || 200 }) } },
    '@/lib/crm/types': { CRM_ENTITIES: entities },
    '@/lib/browserSameOrigin': helper,
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => options.postgres !== false },
    '@/lib/requestUser': {
      requestSession: async () => ({ authenticatedUser: actor.email, effectiveUser: actor.email, ...options.session }),
      requireRequestUser: async () => { if (options.signedOut) throw new Error('Unauthorized'); return actor },
    },
    '@/lib/tenancy': {
      PIPELINE_SELECTION_COOKIE: 'pipeline',
      resolvePipelineSpaceAccess: async () => { if (options.accessDenied) throw new Error('Access denied'); return { id: pipelineId, accessRole: options.viewer ? 'viewer' : 'editor' } },
      requireResourceEditor: pipeline => { if (pipeline.accessRole === 'viewer') throw new Error('Pipeline is view-only') },
    },
    '@/lib/persistence/crm': { archiveCrmRecordInPostgres: async input => {
      calls.push(plain(input))
      if (options.storageError) throw options.storageError
      return { archived: true }
    } },
  })
  const route = load(routeSource, imports, { CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED: Object.hasOwn(options, 'lifecycleEnabled') ? options.lifecycleEnabled : '1' })
  const request = async (body = { action: 'archive', entity: 'organizations', id: recordId }, headers = {}, origin = 'https://aiapp.bposupplychain.com') => route.PATCH({
    nextUrl: new URL(`${origin}/api/crm`), headers: new Headers({ origin, ...headers }),
    cookies: { get: () => ({ value: pipelineId }) }, json: async () => body,
  })
  return { calls, request }
}
let checks = 0
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`) }
await check('organizations and contacts dispatch exact scoped record to existing archive store', async () => {
  for (const entity of ['organizations', 'contacts', 'leads', 'interactions', 'campaigns']) {
    const h = harness(), result = await h.request({ action: 'archive', entity, id: recordId, actorEmail: 'forged@example.test', pipelineId: 'foreign' })
    assert.equal(result.status, 200)
    assert.deepEqual(h.calls, [{ entity, id: recordId, pipelineId, actorEmail: actor.email }])
    assert.equal(result.body.result.archived, true)
  }
})
await check('same-origin app aliases work; absent, foreign and cross-site origins cannot archive', async () => {
  for (const origin of ['https://aiapp.bposupplychain.com', 'https://aiapp.eigenracing.com']) {
    assert.equal((await harness().request(undefined, {}, origin)).status, 200)
  }
  for (const headers of [{ origin: '' }, { origin: 'https://foreign.example.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    const h = harness(); assert.equal((await h.request(undefined, headers)).status, 403); assert.equal(h.calls.length, 0)
  }
})
await check('disabled or malformed native lifecycle flag prevents organization/contact removal but preserves older archive entities', async () => {
  for (const lifecycleEnabled of [undefined, '', '0', 'true', ' 1']) {
    for (const entity of ['organizations', 'contacts']) {
      const h = harness({ lifecycleEnabled }), result = await h.request({ action: 'archive', entity, id: recordId })
      assert.equal(result.status, 409)
      assert.equal(result.body.error, 'CRM deletion synchronization is not enabled yet. No records were removed.')
      assert.equal(h.calls.length, 0, 'Default-off configuration cannot hide the local record')
    }
    for (const entity of ['leads', 'interactions', 'campaigns']) {
      const h = harness({ lifecycleEnabled }), result = await h.request({ action: 'archive', entity, id: recordId })
      assert.equal(result.status, 200); assert.equal(h.calls.length, 1)
    }
  }
})
await check('signed-out, viewer, impersonation and unavailable storage cannot call archive', async () => {
  for (const [options, status] of [[{ signedOut: true }, 401], [{ viewer: true }, 403], [{ accessDenied: true }, 403],
    [{ session: { impersonating: true } }, 403], [{ session: { effectiveUser: 'other@example.test' } }, 403], [{ postgres: false }, 409]]) {
    const h = harness(options); assert.equal((await h.request()).status, status); assert.equal(h.calls.length, 0)
  }
})
await check('invalid identities, unsupported modules and actions cannot call archive', async () => {
  for (const body of [{ action: 'archive', entity: 'organizations', id: 'not-an-id' },
    ...['products', 'meetings', 'opportunities', 'unknown'].map(entity => ({ action: 'archive', entity, id: recordId })),
    { action: 'delete-everything', entity: 'organizations', id: recordId }]) {
    const h = harness(); assert.equal((await h.request(body)).status, 400); assert.equal(h.calls.length, 0)
  }
})
await check('backend protected/missing/fenced record failures remain errors, never false success', async () => {
  for (const [storageError, status] of [[new Error('Managed organization cannot be archived'), 400], [new Error('CRM record not found'), 404],
    [Object.assign(new Error('Record lifecycle held'), { status: 409, code: 'CRM_RECORD_LIFECYCLE_HELD' }), 409]]) {
    const h = harness({ storageError }), result = await h.request()
    assert.equal(result.status, status); assert.equal(result.body.ok, false); assert.equal(h.calls.length, 1)
  }
})
console.log(`CRM Trash route passed ${checks} groups; real route/origin helper with mocked auth/storage, no live deletion.`)
