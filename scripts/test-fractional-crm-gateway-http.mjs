import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as crypto from 'node:crypto'
import { isFractionalCrmGatewayPath } from '../app_src/lib/fractionalCrmGatewayPath.mjs'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
function load(path, dependencies) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const module = { exports: {} }
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  vm.runInNewContext(output, {
    module, exports: module.exports, Buffer, URL, Request, Response, AbortSignal, Uint8Array,
    Error, Date, Object, Array, Set, JSON, Number, String, RegExp, Promise,
    process: { env: {} },
    require: name => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
  }, { filename: path })
  return module.exports
}
const auth = load('app_src/lib/fractionalCrmGatewayAuth.ts', { 'node:crypto': crypto })
const http = load('app_src/lib/fractionalCrmGatewayHttp.ts', {
  './fractionalCrmGatewayAuth': auth, './fractionalCrmGatewayPath.mjs': { isFractionalCrmGatewayPath },
})
const credentialId = '00000000-0000-4000-8000-000000000001'
const token = `fcg_${credentialId.replaceAll('-', '')}_${'A'.repeat(43)}`
const origin = 'https://clawpilot.example.invalid'
const sourceInstanceId = '00000000-0000-4000-8000-000000000002'
const workspaceOrganizationId = '00000000-0000-4000-8000-000000000003'
const pipelineId = '00000000-0000-4000-8000-000000000004'
const fractionalDeploymentId = '00000000-0000-4000-8000-000000000005'
const rootCompanyGlobalId = 'ga0000001'
const company = 'ga0000002', contact = 'gc0000003'
const base = '/api/integrations/fractional-crm/v1'
const scope = { sourceInstanceId, workspaceOrganizationId, pipelineId, rootCompanyGlobalId }
const env = { FRACTIONAL_CRM_GATEWAY_ENABLED: '1', FRACTIONAL_CRM_GATEWAY_ORIGIN: origin,
  FRACTIONAL_CRM_GATEWAY_SOURCE_INSTANCE_ID: sourceInstanceId }
function fixture(overrides = {}) {
  return { credentialId, ...scope, fractionalDeploymentId, fractionalOrganizationId: 'fractional-org', actorEmail: 'registered-operator@example.invalid',
    allowedCompanyGlobalIds: [company], capabilities: [...auth.fractionalCrmCapabilities], tokenHash: auth.hashFractionalCrmGatewayToken(token),
    enabled: true, revokedAt: null, expiresAt: '2099-01-01T00:00:00Z', ...overrides }
}
function harness(options = {}) {
  const lookups = [], calls = []
  let row = options.row === undefined ? fixture() : options.row
  const services = { readFractionalCrmCredential: async id => { lookups.push(id); return row } }
  for (const name of ['readFractionalCrmCompany', 'readFractionalCrmContact', 'listFractionalCrmContacts',
    'updateFractionalCrmCompany', 'updateFractionalCrmContact', 'resolveOrCreateFractionalCrmOnboarding']) {
    services[name] = async (...args) => { calls.push({ name, args }); if (options.error) throw options.error; return options.result ?? { ok: true } }
  }
  async function request(path = `/companies/${company}`, options2 = {}) {
    const query = options2.query ?? new URLSearchParams(scope).toString()
    const headers = { authorization: `Bearer ${token}`, ...(options2.body !== undefined ? { 'content-type': 'application/json' } : {}), ...options2.headers }
    const body = options2.body === undefined ? undefined : typeof options2.body === 'string' || options2.body instanceof ReadableStream
      ? options2.body : JSON.stringify(options2.body)
    const req = new Request(`${options2.origin ?? origin}${base}${path}${query ? `?${query}` : ''}`, {
      method: options2.method ?? 'GET', headers, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      ...(options2.signal ? { signal: options2.signal } : {}),
    })
    return http.handleFractionalCrmGateway(req, services, options.env ?? env)
  }
  return { request, services, calls, lookups, setRow: value => { row = value } }
}
const writeHeaders = { 'if-match': '"opaque-version-1"', 'idempotency-key': 'request-fixed-1' }
const patch = { fields: { companyName: "Original &amp; <x> O'Connor" }, assertedFractionalActor: { userId: 'asserted-user', organizationId: 'fractional-org', customerId: 'local-customer' } }

test('gateway is disabled unless the exact HTTPS source origin and identity are configured', () => {
  for (const candidate of [{}, { ...env, FRACTIONAL_CRM_GATEWAY_ENABLED: '0' }, { ...env, FRACTIONAL_CRM_GATEWAY_ORIGIN: 'http://localhost:4002' },
    { ...env, FRACTIONAL_CRM_GATEWAY_ORIGIN: `${origin}/path` }, { ...env, FRACTIONAL_CRM_GATEWAY_SOURCE_INSTANCE_ID: 'default' }]) {
    assert.throws(() => auth.fractionalCrmGatewayConfiguration(candidate), error => error.code === 'GATEWAY_UNAVAILABLE')
  }
  assert.equal(auth.fractionalCrmGatewayConfiguration(env).sourceInstanceId, sourceInstanceId)
})
test('fresh token has a public credential ID and domain-separated digest, never browser/worker fallback', () => {
  assert.equal(auth.fractionalCrmCredentialId(token), credentialId)
  assert.equal(auth.hashFractionalCrmGatewayToken(token), crypto.createHash('sha256').update(`fractional-crm-gateway-token:v1\n${token}`).digest('hex'))
  for (const value of ['', 'worker-secret', 'session-cookie', token + '\n', token.replace('fcg_', 'other_'), token.replace(/A$/, '!')]) {
    assert.throws(() => auth.fractionalCrmCredentialId(value))
  }
})
test('pure company read authenticates each call and returns private no-store response without secret authority', async () => {
  const app = harness(), response = await app.request()
  assert.equal(response.status, 200)
  assert.equal(app.calls[0].name, 'readFractionalCrmCompany')
  assert.equal(app.calls[0].args[1], company)
  const principal = app.calls[0].args[0]
  assert.equal(principal.actorEmail, 'registered-operator@example.invalid')
  assert.equal(principal.tokenHash, undefined); assert.equal(principal.token, undefined)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('vary'), 'Authorization')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  app.setRow(fixture({ revokedAt: new Date() }))
  assert.equal((await app.request()).status, 401)
  assert.equal(app.lookups.length, 2); assert.equal(app.calls.length, 1)
})
test('unknown, expired, disabled, revoked, malformed and mismatched credentials fail without data access', async () => {
  for (const row of [null, fixture({ tokenHash: '0'.repeat(64) }), fixture({ tokenHash: 'invalid' }), fixture({ enabled: false }),
    fixture({ revokedAt: '2020-01-01' }), fixture({ expiresAt: '2020-01-01' }), fixture({ expiresAt: 'invalid' }),
    fixture({ sourceInstanceId: pipelineId }), fixture({ allowedCompanyGlobalIds: ['gc0000002'] }),
    fixture({ capabilities: ['*'] }), fixture({ credentialId: sourceInstanceId })]) {
    const app = harness({ row }), response = await app.request()
    assert.equal(response.status, 401)
    assert.equal(app.calls.length, 0)
    assert.doesNotMatch(await response.text(), /fcg_|tokenHash|registered-operator/)
  }
})
test('machine boundary rejects browser cookies, origins and cross-site context even with a valid token', async () => {
  for (const headers of [{ cookie: 'clawpilot-session=anything' }, { origin }, { 'sec-fetch-site': 'same-origin' }, { authorization: '' },
    { authorization: `Basic ${token}` }, { authorization: `Bearer ${token}, Bearer ${token}` }]) {
    const app = harness(), response = await app.request(undefined, { headers })
    assert.ok([401, 403].includes(response.status))
    assert.equal(app.calls.length, 0); assert.equal(app.lookups.length, 0)
  }
  assert.equal((await harness().request(undefined, { origin: 'https://other.example.invalid' })).status, 403)
})
test('each method requires its own explicit capability; no broad read or write permission', async () => {
  for (const [path, method, capability, expectedMethod] of [
    [`/companies/${company}`, 'GET', 'crm.company.read', 'readFractionalCrmCompany'],
    [`/companies/${company}/contacts/${contact}`, 'GET', 'crm.contact.read', 'readFractionalCrmContact'],
    [`/companies/${company}`, 'PATCH', 'crm.company.write', 'updateFractionalCrmCompany'],
    [`/companies/${company}/contacts/${contact}`, 'PATCH', 'crm.contact.write', 'updateFractionalCrmContact'],
  ]) {
    const body = method === 'PATCH' ? { ...patch, fields: path.includes('contacts') ? { phone: null } : patch.fields } : undefined
    const denied = harness({ row: fixture({ capabilities: ['crm.onboarding.write'] }) })
    assert.equal((await denied.request(path, { method, body, headers: writeHeaders })).status, 403)
    assert.equal(denied.calls.length, 0)
    const allowed = harness({ row: fixture({ capabilities: [capability] }) })
    assert.equal((await allowed.request(path, { method, body, headers: writeHeaders })).status, 200)
    assert.equal(allowed.calls[0].name, expectedMethod)
  }
})
test('scope must explicitly and uniquely match source, workspace, pipeline and root; no query fallback', async () => {
  for (const key of Object.keys(scope)) {
    for (const action of ['missing', 'different', 'duplicate']) {
      const query = new URLSearchParams(scope)
      if (action === 'missing') query.delete(key)
      if (action === 'different') query.set(key, 'other')
      if (action === 'duplicate') query.append(key, scope[key])
      const app = harness(), response = await app.request(undefined, { query: query.toString() })
      assert.ok([400, 403].includes(response.status)); assert.equal(app.calls.length, 0)
    }
  }
  assert.equal((await harness().request(undefined, { query: new URLSearchParams({ ...scope, customer: '*' }).toString() })).status, 400)
})
test('exact proxy path/method bypass never covers sibling integrations, arbitrary IDs or unsupported operations', () => {
  for (const [path, method] of [[`/companies/${company}`, 'GET'], [`/companies/${company}/contacts`, 'GET'],
    [`/companies/${company}/contacts/${contact}`, 'PATCH'], ['/onboarding/resolve-or-create', 'POST']]) {
    assert.equal(isFractionalCrmGatewayPath(base + path, method), true)
  }
  for (const path of [base, base + '/', `${base}/companies/${company}/`, `${base}/companies/%67a0000002`, `${base}/companies/gc0000002`,
    `${base}/companies/${company}/contacts/other`, `${base}/companies/${company}/export`, `${base}/companies/${company}/contacts/${contact}/delete`,
    '/api/integrations/commerce/orders/process', '/api/crm', `${base}-evil/companies/${company}`]) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) assert.equal(isFractionalCrmGatewayPath(path, method), false, `${method} ${path}`)
  }
  for (const method of ['POST', 'DELETE', 'PUT', 'HEAD', 'OPTIONS']) assert.equal(isFractionalCrmGatewayPath(`${base}/companies/${company}`, method), false)
  const proxy = readFileSync(new URL('../app_src/proxy.ts', import.meta.url), 'utf8')
  assert.match(proxy, /isFractionalCrmGatewayPath\(pathname, method\)/)
})
test('HTTP dispatch preserves exact company/contact IDs and rejects unsupported paths before lookup', async () => {
  const app = harness()
  assert.equal((await app.request(`/companies/${company}/contacts/${contact}`)).status, 200)
  assert.equal(app.calls[0].args[1], company); assert.equal(app.calls[0].args[2], contact)
  assert.equal((await app.request(`/companies/${company}/contacts/${contact}/delete`, { method: 'POST' })).status, 404)
  assert.equal(app.lookups.length, 1); assert.equal(app.calls.length, 1)
})
test('contact listing is bounded and scope remains explicit with an opaque cursor', async () => {
  const app = harness(), query = new URLSearchParams({ ...scope, limit: '100', cursor: 'opaque_cursor-1' }).toString()
  assert.equal((await app.request(`/companies/${company}/contacts`, { query })).status, 200)
  assert.equal(app.calls[0].args[2].limit, 100); assert.equal(app.calls[0].args[2].cursor, 'opaque_cursor-1')
  for (const limit of ['0', '101', '-1', '1.2', 'Infinity', '01']) {
    assert.equal((await harness().request(`/companies/${company}/contacts`, { query: new URLSearchParams({ ...scope, limit }).toString() })).status, 400)
  }
})
test('PATCH requires a single strong quoted version and stable idempotency key before persistence', async () => {
  for (const [headers, status] of [[{ ...writeHeaders, 'if-match': '' }, 428], [{ ...writeHeaders, 'if-match': '*' }, 400],
    [{ ...writeHeaders, 'if-match': 'W/"opaque"' }, 400], [{ ...writeHeaders, 'if-match': '"one", "two"' }, 400],
    [{ ...writeHeaders, 'idempotency-key': '' }, 400]]) {
    const app = harness()
    assert.equal((await app.request(undefined, { method: 'PATCH', body: patch, headers })).status, status)
    assert.equal(app.calls.length, 0)
  }
  const app = harness()
  assert.equal((await app.request(undefined, { method: 'PATCH', body: patch, headers: writeHeaders })).status, 200)
  assert.equal(app.calls[0].args[2].ifMatch, 'opaque-version-1')
  assert.equal(app.calls[0].args[2].idempotencyKey, 'request-fixed-1')
  assert.equal(app.calls[0].args[2].fields.companyName, patch.fields.companyName)
  assert.equal(app.calls[0].args[0].actorEmail, 'registered-operator@example.invalid')
  assert.equal(app.calls[0].args[2].assertedFractionalActor.userId, 'asserted-user')
})
test('PATCH fields cannot overwrite identity, parent, grants or authenticated principal', async () => {
  for (const body of [{ ...patch, actorEmail: 'admin@example.invalid' }, { ...patch, fields: { globalId: company } },
    { ...patch, fields: { companyGlobalId: 'ga0000009' } }, { ...patch, fields: {} },
    { ...patch, fields: { companyName: { html: 'nested' } } },
    { ...patch, assertedFractionalActor: { ...patch.assertedFractionalActor, organizationId: 'other' } },
    { ...patch, assertedFractionalActor: { ...patch.assertedFractionalActor, role: 'owner' } }]) {
    const app = harness(), response = await app.request(undefined, { method: 'PATCH', body, headers: writeHeaders })
    assert.ok([400, 403, 422].includes(response.status)); assert.equal(app.calls.length, 0)
  }
})
test('JSON body is bounded by actual bytes and type, not just a declared Content-Length', async () => {
  for (const [body, headers, status] of [[patch, { 'content-type': 'text/plain' }, 415], [patch, { 'content-encoding': 'gzip' }, 415],
    ['{broken', {}, 400], ['[]', {}, 400], [' '.repeat(65_537), {}, 413],
    [patch, { 'content-length': '65537' }, 413], [patch, { 'content-length': 'not-a-number' }, 413]]) {
    const app = harness(), response = await app.request(undefined, { method: 'PATCH', body, headers: { ...writeHeaders, ...headers } })
    assert.equal(response.status, status); assert.equal(app.calls.length, 0)
  }
})
test('aborted or failing body streams cannot reach persistence or reveal transport errors', async () => {
  const abort = new AbortController(); abort.abort()
  const app = harness(), stream = new ReadableStream({ start() {} })
  assert.equal((await app.request(undefined, { method: 'PATCH', body: stream, signal: abort.signal, headers: writeHeaders })).status, 408)
  assert.equal(app.calls.length, 0)
  const fail = new ReadableStream({ start(controller) { controller.error(new Error('private transport secret')) } })
  const response = await harness().request(undefined, { method: 'PATCH', body: fail, headers: writeHeaders })
  assert.equal(response.status, 400); assert.doesNotMatch(await response.text(), /private transport secret/)
})
test('onboarding uses a separate capability and source-bound command, not caller authority or invitation delivery', async () => {
  const body = { schemaVersion: 1, sourceInstanceId, origin: { deploymentId: fractionalDeploymentId, organizationId: 'fractional-org', customerId: 'customer', contactId: 'contact', onboardingId: 'operation' },
    company: { globalId: company, verifiedIdentifiers: [], fields: {} }, contact: { globalId: contact, fields: {} },
    allowCreate: { company: true, contact: true }, reviewDecisionToken: null, actor: { fractionalUserId: 'asserted-user' } }
  const app = harness({ row: fixture({ capabilities: ['crm.onboarding.write'] }), result: { status: 'review_required', reason: 'CONTACT_RELATIONSHIP_REVIEW' } })
  const response = await app.request('/onboarding/resolve-or-create', { method: 'POST', body, headers: { 'idempotency-key': 'onboarding-fixed-1' } })
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'review_required')
  assert.equal(app.calls[0].name, 'resolveOrCreateFractionalCrmOnboarding')
  assert.equal(app.calls[0].args[2], 'onboarding-fixed-1')
  for (const invalid of [{ ...body, sourceInstanceId: pipelineId }, { ...body, origin: { ...body.origin, deploymentId: pipelineId } },
    { ...body, origin: { ...body.origin, organizationId: 'other' } }, { ...body, sendInvitation: true }]) {
    const denied = harness()
    assert.ok([400, 403].includes((await denied.request('/onboarding/resolve-or-create', { method: 'POST', body: invalid, headers: { 'idempotency-key': 'onboarding-fixed-1' } })).status))
    assert.equal(denied.calls.length, 0)
  }
})
test('safe errors retain conflict/retirement semantics while unexpected errors never leak secrets or SQL', async () => {
  for (const [code, status] of [['VERSION_CONFLICT', 412], ['IDEMPOTENCY_CONFLICT', 409], ['RECORD_RETIRED', 410], ['CAPABILITY_DENIED', 403], ['DISCOVERY_LIMIT', 409]]) {
    const response = await harness({ error: new auth.FractionalCrmGatewayError(status, code) }).request()
    assert.equal(response.status, status); assert.equal((await response.json()).error, code)
  }
  for (const error of [new Error(`postgres secret ${token}`), new auth.FractionalCrmGatewayError(500, token)]) {
    const response = await harness({ error }).request()
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /postgres|fcg_/)
  }
})
test('Next route exports only intended methods and all use the authenticated HTTP boundary', async () => {
  const app = harness()
  const route = load('app_src/app/api/integrations/fractional-crm/v1/[...path]/route.ts', {
    '@/lib/fractionalCrmGatewayHttp': { handleFractionalCrmGateway: (request, services) => http.handleFractionalCrmGateway(request, services, env) },
    '@/lib/persistence/fractionalCrmGateway': app.services,
  })
  assert.equal(route.runtime, 'nodejs'); assert.equal(route.dynamic, 'force-dynamic')
  assert.equal(route.DELETE, undefined); assert.equal(route.PUT, undefined)
  const url = `${origin}${base}/companies/${company}?${new URLSearchParams(scope)}`
  assert.equal((await route.GET(new Request(url))).status, 401)
  assert.equal(app.calls.length, 0)
  assert.equal((await route.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }))).status, 200)
  assert.equal(app.calls[0].name, 'readFractionalCrmCompany')
  assert.equal(route.GET, route.PATCH); assert.equal(route.GET, route.POST)
})
