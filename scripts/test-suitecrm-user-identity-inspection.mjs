#!/usr/bin/env node
// Actual SuiteCRM client with synthetic HTTP, no credentials or live service.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../app_src/lib/crm/suiteCrmClient.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { module, exports: module.exports, Buffer, URL, URLSearchParams, Response, AbortSignal,
  process: { env: { SUITECRM_BASE_URL: 'https://crm.example.invalid', SUITECRM_CLIENT_ID: 'fixture-client', SUITECRM_CLIENT_SECRET: 'fixture-secret' } },
  require: name => new Proxy({}, { get: () => () => { throw new Error(`Unexpected dependency ${name}`) } }),
})
const api = module.exports, id = '11111111-2222-4333-8444-555555555555', gu = 'gu0123456789av'
const record = { localId: 'member@example.test', suiteCrmUserId: id, referenceCode: gu, username: gu }
const canonical = { id, type: 'Users', attributes: { user_name: gu, global_id_c: gu } }
let calls = [], count = 0
function fetcher({ user = canonical, globalMatches = [{ id }], usernameMatches = [{ id }], patchId = id } = {}) {
  return async (url, init) => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, method: init.method, body: init.body })
    if (parsed.pathname === '/Api/access_token') return Response.json({ access_token: 'synthetic-fixture', expires_in: 3600 })
    if (init.method === 'PATCH') { assert.equal(parsed.pathname, '/Api/V8/module'); return Response.json({ data: { id: patchId } }) }
    assert.equal(init.method, 'GET')
    if (parsed.pathname.endsWith('/' + id)) return Response.json({ data: user })
    assert.equal(parsed.pathname, '/Api/V8/module/Users')
    assert.equal(parsed.searchParams.get('page[size]'), '2')
    return Response.json({ data: parsed.searchParams.has('filter[global_id_c][eq]') ? globalMatches : usernameMatches })
  }
}
async function check(name, run) { calls = []; await run(); count++; console.log('PASS ' + name) }
const writes = () => calls.filter(c => c.method !== 'GET' && c.path !== '/Api/access_token')
await check('read-only canonical inspection and repeated worker retries never resave native Users', async () => {
  assert.equal((await api.inspectSuiteCrmUserIdentity(record, fetcher())).verified, true)
  for (let n = 0; n < 2; n++) assert.equal(await api.upsertSuiteCrmUserIdentity(record, fetcher()), id)
  assert.deepEqual(writes(), [])
  assert.equal(calls.filter(c => c.method === 'GET').length, 9)
})
await check('legacy repair remains an exact two-field native PATCH, not a principal creation', async () => {
  const config = { user: { ...canonical, attributes: { user_name: 'legacy', global_id_c: null } }, globalMatches: [], usernameMatches: [] }
  assert.equal((await api.inspectSuiteCrmUserIdentity(record, fetcher(config))).verified, false)
  assert.deepEqual(writes(), [])
  assert.equal(await api.upsertSuiteCrmUserIdentity(record, fetcher(config)), id)
  assert.equal(writes().length, 1)
  assert.deepEqual(JSON.parse(writes()[0].body), { data: { type: 'Users', id, attributes: { user_name: gu, global_id_c: gu } } })
})
await check('normalization cannot turn noncanonical native bytes into no-op proof', async () => {
  for (const attributes of [{ user_name: gu.toUpperCase(), global_id_c: gu }, { user_name: gu, global_id_c: ' ' + gu }]) {
    assert.equal((await api.inspectSuiteCrmUserIdentity(record, fetcher({ user: { ...canonical, attributes } }))).verified, false)
  }
  assert.deepEqual(writes(), [])
})
await check('missing or malformed native metadata, foreign permanent identity and wrong target fail without User writes', async () => {
  for (const user of [{ ...canonical, id: 'other' }, { ...canonical, type: 'Contact' }, { ...canonical, attributes: {} },
    { ...canonical, attributes: { user_name: gu } }, { ...canonical, attributes: { user_name: null, global_id_c: gu } },
    { ...canonical, attributes: { user_name: gu, global_id_c: 'gu7654321' } }]) {
    await assert.rejects(api.upsertSuiteCrmUserIdentity(record, fetcher({ user })))
  }
  assert.deepEqual(writes(), [])
})
await check('ambiguous malformed conflicting and inconsistent uniqueness responses fail closed', async () => {
  for (const config of [{ globalMatches: null }, { usernameMatches: {} }, { globalMatches: [{ id }, { id }] },
    { usernameMatches: [{ id }, { id }] }, { globalMatches: [{ id: 'other' }] }, { usernameMatches: [null] },
    { globalMatches: [] }, { usernameMatches: [] }]) await assert.rejects(api.upsertSuiteCrmUserIdentity(record, fetcher(config)))
  assert.deepEqual(writes(), [])
})
await check('invalid local identity is rejected before provider requests', async () => {
  for (const invalid of [{ suiteCrmUserId: '../other' }, { referenceCode: 'ga1234567' }, { username: 'different' }]) {
    await assert.rejects(api.inspectSuiteCrmUserIdentity({ ...record, ...invalid }, fetcher()))
  }
  assert.deepEqual(calls, [])
})
console.log(`${count} user-identity HTTP fixture groups passed. No live CRM, account eligibility or Email permission proof.`)
