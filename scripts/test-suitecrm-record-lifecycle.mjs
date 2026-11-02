#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const clone = value => JSON.parse(JSON.stringify(value))
const identities = [
  { module: 'Accounts', nativeId: '11111111-2222-4333-8444-555555555555', globalId: 'ga6i0qmt2qudss' },
  { module: 'Accounts', nativeId: '22222222-3333-4444-8555-666666666666', globalId: 'gagmco24va588e' },
  { module: 'Contacts', nativeId: '33333333-4444-4555-8666-777777777777', globalId: 'gc1234567' },
]
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function load(path, env, mocks = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: path,
  }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, Buffer, URL, URLSearchParams, Response, AbortSignal,
    process: { env }, require: name => mocks[name] || {},
  }, { filename: path })
  return module.exports
}
function harness(options = {}) {
  const env = { SUITECRM_BASE_URL: 'https://crm.fixture.invalid/legacy', SUITECRM_CLIENT_ID: 'synthetic-client',
    SUITECRM_CLIENT_SECRET: 'synthetic-secret', CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED: '1', ...options.env }
  const transport = load('app_src/lib/crm/suiteCrmClient.ts', env)
  const api = load('app_src/lib/crm/suiteCrmRecordLifecycleClient.ts', env, { '@/lib/crm/suiteCrmClient': transport })
  const calls = []; let inspections = 0
  const fetchMock = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/Api/access_token')) return Response.json({ access_token: 'synthetic-token', expires_in: 3600 })
    if (init.method === 'DELETE') {
      assert.match(url, /\/Api\/V8\/module\/(?:Accounts|Contacts)\/[a-zA-Z0-9-]+$/)
      return Response.json({ meta: { message: 'fixture' } }, { status: options.deleteStatus || 200 })
    }
    inspections++
    const records = JSON.parse(init.body).records
    const response = { version: 1, records: records.map((identity, index) => ({ ...identity,
      state: ['deleted', 'active', 'missing'][index % 3], dateModified: index % 3 === 2 ? null : '2026-10-30 12:34:56' })) }
    options.response?.(response, inspections)
    if (options.throw) throw new Error('sensitive fake token, SQL, or contents')
    if (options.raw) return new Response(options.raw, { status: options.status || 200 })
    return Response.json(response, { status: options.status || 200 })
  }
  return { api, calls, fetchMock }
}
let checks = 0
async function check(label, run) { await run(); checks++; console.log('PASS ' + label) }
const unavailable = error => error?.code === 'SUITECRM_RECORD_LIFECYCLE_UNAVAILABLE' && !/sensitive|synthetic-secret/.test(error.message)

await check('real shared OAuth wrapper uses fixed authenticated read-only route and exact batch', async () => {
  const h = harness(), original = clone(identities), result = clone(await h.api.inspectSuiteCrmRecordLifecycle(identities, h.fetchMock))
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[0].url, 'https://crm.fixture.invalid/legacy/Api/access_token')
  assert.equal(JSON.parse(h.calls[0].init.body).grant_type, 'client_credentials')
  assert.equal(h.calls[1].url, 'https://crm.fixture.invalid/legacy/Api/V8/custom/clawpilot-record-lifecycle/inspect')
  assert.deepEqual(JSON.parse(h.calls[1].init.body), { version: 1, records: identities })
  assert.equal(h.calls[1].init.headers.Authorization, 'Bearer synthetic-token')
  for (const { init } of h.calls) { assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.ok(init.signal) }
  assert.deepEqual(result.map(record => record.state), ['deleted', 'active', 'missing'])
  assert.equal(result[1].globalId, 'gagmco24va588e')
  assert.equal(result[2].dateModified, null)
  assert.deepEqual(identities, original)
})
const outgoing = () => ({ entity: 'organizations', pipelineId: 'fixture-pipeline', localId: 'fixture-local',
  suiteCrmId: identities[0].nativeId, attributes: { global_id_c: identities[0].globalId } })
const lifecycleStates = states => (response, inspection) => {
  response.records[0].state = states[Math.min(inspection - 1, states.length - 1)]
  response.records[0].dateModified = response.records[0].state === 'missing' ? null : '2026-10-30 12:34:56'
}
await check('verified outgoing delete settles only exact positive native deletion evidence', async () => {
  const h = harness({ response: lifecycleStates(['active', 'deleted']) })
  await h.api.deleteSuiteCrmAccountContactVerified(outgoing(), h.fetchMock)
  assert.deepEqual(h.calls.map(call => call.init.method), ['POST', 'POST', 'DELETE', 'POST'])
  assert.equal(h.calls[2].url, `https://crm.fixture.invalid/legacy/Api/V8/module/Accounts/${identities[0].nativeId}`)
  const deleted = harness({ response: lifecycleStates(['deleted']) })
  await deleted.api.deleteSuiteCrmAccountContactVerified(outgoing(), deleted.fetchMock)
  assert.equal(deleted.calls.filter(call => call.init.method === 'DELETE').length, 0)
})
await check('disabled, unknown or wrong-identity deletes hold before any native mutation', async () => {
  for (const options of [{ env: { CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED: '0' } },
    { response: lifecycleStates(['missing']) }, { status: 404 },
    { response: r => { r.records[0].globalId = identities[1].globalId } }]) {
    const h = harness(options)
    await assert.rejects(() => h.api.deleteSuiteCrmAccountContactVerified(outgoing(), h.fetchMock), unavailable)
    assert.equal(h.calls.filter(call => call.init.method === 'DELETE').length, 0)
  }
  for (const changed of [{ entity: 'interactions' }, { suiteCrmModule: 'Emails' }, { attributes: {} },
    { previousSuiteCrmModule: 'Notes' }, { suiteCrmId: 'foreign/../id' }]) {
    const h = harness()
    await assert.rejects(() => h.api.deleteSuiteCrmAccountContactVerified({ ...outgoing(), ...changed }, h.fetchMock), unavailable)
    assert.equal(h.calls.length, 0)
  }
})
await check('DELETE 404, nondeleted readback and missing proof remain held, without resending', async () => {
  for (const options of [{ deleteStatus: 404, response: lifecycleStates(['active', 'missing']) },
    { response: lifecycleStates(['active', 'active']) }, { response: lifecycleStates(['active', 'missing']) },
    { deleteStatus: 403, response: lifecycleStates(['active']) }]) {
    const h = harness(options)
    await assert.rejects(() => h.api.deleteSuiteCrmAccountContactVerified(outgoing(), h.fetchMock), unavailable)
    assert.equal(h.calls.filter(call => call.init.method === 'DELETE').length, 1)
  }
  const h = harness({ response: lifecycleStates(['active', 'deleted']) }), record = outgoing()
  const wrapped = async (url, init) => {
    const result = await h.fetchMock(url, init)
    if (url.endsWith('/inspect')) { record.suiteCrmId = identities[1].nativeId; record.entity = 'contacts' }
    return result
  }
  await h.api.deleteSuiteCrmAccountContactVerified(record, wrapped)
  assert.equal(h.calls.find(call => call.init.method === 'DELETE').url,
    `https://crm.fixture.invalid/legacy/Api/V8/module/Accounts/${identities[0].nativeId}`)
})
await check('disabled capability and malformed commands hold before all network calls', async () => {
  for (const value of [undefined, '', '0', 'true']) {
    const h = harness({ env: { CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED: value } })
    await assert.rejects(() => h.api.inspectSuiteCrmRecordLifecycle(identities, h.fetchMock), unavailable)
    assert.equal(h.calls.length, 0)
  }
  for (const command of [null, {}, Array(101).fill(identities[0]), [identities[0], identities[0]],
    [{ ...identities[0], module: 'Users' }], [{ ...identities[0], globalId: 'gc1234567' }],
    [{ ...identities[0], nativeId: "x' OR 1=1" }], [{ ...identities[0], extra: true }],
    [{ ...identities[0], nativeId: identities[0].nativeId + '\n' }],
    [{ ...identities[0], globalId: identities[0].globalId + '\n' }],
    [identities[0], { ...identities[0], nativeId: identities[1].nativeId }]]) {
    const h = harness(); await assert.rejects(() => h.api.inspectSuiteCrmRecordLifecycle(command, h.fetchMock), unavailable)
    assert.equal(h.calls.length, 0)
  }
  const h = harness({ env: { CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED: '0' } })
  assert.deepEqual(clone(await h.api.inspectSuiteCrmRecordLifecycle([], h.fetchMock)), []); assert.equal(h.calls.length, 0)
})
await check('the complete hundred-record bound works without a provider-wide scan', async () => {
  const records = Array.from({ length: 100 }, (_, index) => ({ module: 'Accounts', nativeId: `native-${index}`, globalId: `ga${String(index).padStart(7, '0')}` }))
  const h = harness(); assert.equal((await h.api.inspectSuiteCrmRecordLifecycle(records, h.fetchMock)).length, 100)
  assert.equal(h.calls.length, 2)
})
await check('HTTP error, absent route, invalid JSON and provider exception never imply deletion', async () => {
  for (const options of [400, 401, 403, 404, 409, 500].map(status => ({ status })).concat([
    { raw: '{malformed' }, { raw: 'x'.repeat(2 * 1024 * 1024 + 1) }, { throw: true },
  ])) {
    const h = harness(options)
    await assert.rejects(() => h.api.inspectSuiteCrmRecordLifecycle(identities, h.fetchMock), unavailable)
    assert.equal(h.calls.length, 2)
  }
})
await check('partial, mismatched, reordered or malformed evidence refuses the whole batch', async () => {
  for (const response of [r => { r.records.pop() }, r => { r.records.reverse() }, r => { r.extra = true },
    r => { r.version = '1' }, r => { r.records[0].nativeId = identities[1].nativeId },
    r => { r.records[0].globalId = identities[1].globalId }, r => { r.records[0].module = 'Contacts' },
    r => { r.records[0].state = 'deleted-ish' }, r => { r.records[0].dateModified = null },
    r => { r.records[0].dateModified = '2026-02-30 12:00:00' }, r => { r.records[0].dateModified = '2026-10-30T12:00:00Z' },
    r => { r.records[0].dateModified = '2026-10-30 12:00:00\n' },
    r => { r.records[2].dateModified = '2026-10-30 12:00:00' }, r => { r.records[0].description = 'provider content' }]) {
    const h = harness({ response }); await assert.rejects(() => h.api.inspectSuiteCrmRecordLifecycle(identities, h.fetchMock), unavailable)
  }
})
await check('native source contracts remain read-only, bounded and independently authenticated', () => {
  const service = read('services/suitecrm/record-lifecycle/RecordLifecycle.php')
  const route = read('services/suitecrm/record-lifecycle/routes.php')
  const installer = read('services/suitecrm/install-record-lifecycle.php')
  assert.match(service, /MYSQLI_TRANS_START_READ_ONLY \| MYSQLI_TRANS_START_WITH_CONSISTENT_SNAPSHOT/)
  assert.match(service, /active_transaction'\] === 0/)
  assert.match(service, /count\(\$command\['records'\]\) <= 100/)
  assert.match(service, /\$row\['global_id_c'\] === \$record\['globalId'\]/)
  assert.match(service, /\$row\['id'\] === \$record\['nativeId'\]/)
  assert.match(service, /\$token\['assigned_user_id'\] === \$token\['client_user_id'\]/)
  assert.match(service, /access_token_expires>UTC_TIMESTAMP\(\)/)
  assert.match(service, /\$token\['status'\] === 'Active'/)
  assert.match(service, /\$token\['is_admin'\]/)
  assert.match(service, /\$db->rollback\(\)/)
  assert.doesNotMatch(service, /(?:UPDATE|DELETE FROM|INSERT INTO|REPLACE INTO|FOR UPDATE)\s/i)
  assert.doesNotMatch(service, /SELECT\s+(?:\*|b\.\*|description|email1)/i)
  assert.match(route, /getAttribute\('oauth_access_token_id'\)/)
  assert.match(route, /strlen\(\$body\) > 32768/)
  assert.match(route, /private, no-store/)
  assert.match(installer, /bool \$apply = false/)
  assert.match(installer, /Publish the router LAST/)
  assert.match(installer, /Refusing|requires review/)
  const docker = read('services/suitecrm/Dockerfile'), entrypoint = read('services/suitecrm/entrypoint.sh')
  assert.match(docker, /COPY record-lifecycle \/opt\/clawpilot\/record-lifecycle/)
  assert.match(entrypoint, /if \[\[ "\$\{CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED:-\}" == "1" \]\]; then/)
  assert.ok(entrypoint.indexOf('php /opt/clawpilot/install-email-audience.php')
    < entrypoint.indexOf('php /opt/clawpilot/install-record-lifecycle.php'))
})
console.log(`Record lifecycle passed ${checks} local fake-HTTP/source checks. No database, provider call, native PHP runtime or production proof.`)
