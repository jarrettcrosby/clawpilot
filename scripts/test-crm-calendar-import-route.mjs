#!/usr/bin/env node
// Execute the actual route and same-origin helper; all persistence/provider
// boundaries are fail-closed fixtures. No server, credentials or database.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import * as publicOriginRouting from '../app_src/lib/publicOriginRouting.mjs'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const routeSource = read('app_src/app/api/crm/calendar-import/route.ts')
const email = 'owner@example.test'
const organizationId = '00000000-0000-4000-8000-000000000001'
const pipelineId = '00000000-0000-4000-8000-000000000002'
const command = { pipelineId, connectionId: 'reviewed-calendar', calendarId: 'business@example.test', enabled: true }
const scoped = { pipelineId, actorEmail: email, organizationId }
class CalendarDiscoveryConfigurationError extends Error {
  constructor(message, status = 409) { super(message); this.status = status }
}
function load(source, dependencies = {}, environment = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  vm.runInNewContext(output, {
    module, exports: module.exports, Error, Buffer, Uint8Array, URL, JSON, Object,
    process: { env: environment },
    require(name) { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`); return dependencies[name] },
  })
  return module.exports
}
const plain = value => JSON.parse(JSON.stringify(value))
function harness(options = {}) {
  const calls = [], accessCalls = [], authCalls = []
  const actor = { email, organizationId, role: 'owner', ...options.actor }
  const session = options.noSession ? null : { authenticatedUser: email, effectiveUser: email,
    activeWorkspaceOrganizationId: organizationId, impersonating: false, ...options.session }
  const pipeline = { id: pipelineId, ownerEmail: email, workspaceOrganizationId: organizationId, ...options.pipeline }
  const sources = [{ id: 'source-fixture', calendarId: command.calendarId, enabled: true }]
  const route = load(routeSource, {
    'next/server': { NextResponse: { json: (body, init) => ({ body, ...init }) } },
    '@/lib/browserSameOrigin': load(read('app_src/lib/browserSameOrigin.ts'), {
      './publicOriginRouting.mjs': publicOriginRouting,
    }, { CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON: options.additionalOrigins }),
    '@/lib/publicUrl': { appPublicUrl: () => 'https://app.example.test' },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => options.postgres !== false },
    '@/lib/requestUser': {
      requestSession: async () => session,
      requireRequestUser: async () => { authCalls.push(actor); if (options.unauthorized) throw new Error('Unauthorized'); return actor },
    },
    '@/lib/tenancy': { resolvePipelineSpaceAccess: async input => {
      accessCalls.push(input); if (options.accessError) throw new Error('private pipeline details'); return pipeline
    } },
    '@/lib/crm/calendarDiscoveryPersistence': {
      CalendarDiscoveryConfigurationError,
      listCalendarDiscoverySources: async input => { calls.push({ type: 'list', input }); return sources },
      configureCalendarDiscoverySource: async input => {
        calls.push({ type: 'configure', input }); if (options.error) throw options.error
        return sources.map(source => ({ ...source, enabled: input.enabled }))
      },
    },
    '@/lib/integrations/organizationCommunications': { getOrganizationCommunicationState: async input => {
      calls.push({ type: 'connections', input }); return { availableConnections: [
        { app: 'google-mail', id: 'mail-connection' }, { app: 'google-calendar', id: 'calendar-connection' },
      ] }
    } },
  })
  async function request(method = 'PUT', body = command, headers = {}, selectedPipeline = pipelineId) {
    const req = new Request(`https://app.example.test/api/crm/calendar-import?pipelineId=${encodeURIComponent(selectedPipeline)}`, {
      method, headers: { origin: 'https://app.example.test', 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }),
    })
    req.nextUrl = new URL(req.url)
    return route[method](req)
  }
  return { route, request, calls, accessCalls, authCalls, actor }
}

test('GET lists only owner-scoped sources and Calendar connections with private no-store headers', async () => {
  const app = harness(), result = await app.request('GET')
  assert.equal(result.status, 200)
  assert.deepEqual(plain(app.calls), [{ type: 'list', input: scoped }, { type: 'connections', input: scoped }])
  assert.deepEqual(plain(result.body.connections), [{ app: 'google-calendar', id: 'calendar-connection' }])
  assert.equal(app.accessCalls[0].actorEmail, app.actor)
  assert.equal(app.accessCalls[0].pipelineId, pipelineId)
  assert.match(result.headers['Cache-Control'], /private.*no-store/)
  assert.equal(result.headers.Vary, 'Cookie, Origin')
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(app.route.POST, undefined)
  assert.equal(app.route.DELETE, undefined)
})

test('PUT enable and pause pass only validated exact calendar and authenticated owner scope', async () => {
  for (const enabled of [true, false]) {
    const app = harness(), result = await app.request('PUT', { ...command, enabled })
    assert.equal(result.status, 200)
    assert.deepEqual(plain(app.calls), [{ type: 'configure', input: { ...scoped,
      connectionId: command.connectionId, calendarId: command.calendarId, enabled } }])
    assert.equal(result.body.sources[0].enabled, enabled)
  }
})

test('both methods reject missing/impersonated sessions and mismatched exact owner/workspace without provider work', async () => {
  for (const [options, status] of [
    [{ noSession: true }, 401], [{ unauthorized: true }, 401], [{ session: { authenticatedUser: '' } }, 401],
    [{ session: { impersonating: true } }, 401], [{ session: { effectiveUser: 'other@example.test' } }, 401],
    [{ session: { authenticatedUser: 'other@example.test', effectiveUser: 'other@example.test' } }, 403],
    [{ session: { activeWorkspaceOrganizationId: 'other-workspace' } }, 403],
    [{ actor: { organizationId: null } }, 403], [{ pipeline: { ownerEmail: 'other@example.test' } }, 403],
    [{ pipeline: { workspaceOrganizationId: 'other-workspace' } }, 403], [{ pipeline: { id: 'other-pipeline' } }, 403],
    [{ actor: { email: 'other@example.test' }, pipeline: { ownerEmail: 'other@example.test' } }, 403],
    [{ accessError: true }, 409],
  ]) {
    for (const method of ['GET', 'PUT']) {
      const app = harness(options), result = await app.request(method)
      assert.equal(result.status, status, `${method} ${JSON.stringify(options)} must deny access`)
      assert.equal(app.calls.length, 0, `${method} ${JSON.stringify(options)} must not list, configure or inspect provider state`)
      assert.doesNotMatch(JSON.stringify(result), /private pipeline details/)
    }
  }
  for (const method of ['GET', 'PUT']) {
    const app = harness({ postgres: false })
    assert.equal((await app.request(method)).status, 503)
    assert.equal(app.calls.length, 0)
  }
  const signedOut = harness({ noSession: true })
  await signedOut.request('GET')
  assert.equal(signedOut.authCalls.length, 0, 'local-development identity fallback is never consulted')
})

test('PUT uses real same-origin helper and denies cross-site requests before authentication', async () => {
  for (const headers of [{ origin: '' }, { origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    const app = harness(), result = await app.request('PUT', command, headers)
    assert.equal(result.status, 403)
    assert.equal(app.authCalls.length, 0)
    assert.equal(app.calls.length, 0)
  }
  const app = harness({ additionalOrigins: JSON.stringify(['https://aiapp.bposupplychain.com']) })
  assert.equal((await app.request('PUT', command, { origin: 'https://aiapp.bposupplychain.com' })).status, 200)
})

test('PUT rejects unknown authority fields, malformed JSON and invalid bounded exact calendar IDs', async () => {
  for (const [body, headers, status] of [
    [command, { 'content-type': 'text/plain' }, 415], ['{', {}, 400], ['null', {}, 400], [[], {}, 400],
    [{ ...command, ownerEmail: 'other@example.test' }, {}, 400],
    [{ ...command, organizationId }, {}, 400], [{ ...command, resetCursor: true }, {}, 400],
    [{ ...command, pipelineId: 'not-a-uuid' }, {}, 400], [{ ...command, pipelineId: null }, {}, 400],
    [{ ...command, enabled: 'true' }, {}, 400], [{ ...command, connectionId: '' }, {}, 400],
    [{ ...command, connectionId: 'a'.repeat(513) }, {}, 400], [{ ...command, connectionId: 'has space' }, {}, 400],
    [{ ...command, connectionId: 'é' }, {}, 400], [{ ...command, calendarId: '' }, {}, 400],
    [{ ...command, calendarId: 'primary' }, {}, 400], [{ ...command, calendarId: 'a'.repeat(1025) }, {}, 400],
    [{ ...command, calendarId: 'has\nnewline' }, {}, 400], [' '.repeat(8193), {}, 413], ['é'.repeat(4097), {}, 413],
  ]) {
    const app = harness(), result = await app.request('PUT', body, headers)
    assert.equal(result.status, status, JSON.stringify({ body, headers }).slice(0, 200))
    assert.equal(app.calls.length, 0)
  }
  const app = harness()
  const result = await app.route.PUT({ headers: new Headers({ origin: 'https://app.example.test', 'content-type': 'application/json' }),
    nextUrl: new URL('https://app.example.test/api/crm/calendar-import'), body: null })
  assert.equal(result.status, 400)
  assert.equal(app.calls.length, 0)
})

test('PUT enforces streaming byte bound, cancels and releases body despite false content-length', async () => {
  const app = harness()
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4096)); controller.enqueue(new Uint8Array(4097)) },
    cancel() { cancelled = true },
  })
  const result = await app.route.PUT({ headers: new Headers({ origin: 'https://app.example.test',
    'content-type': 'application/json', 'content-length': '1' }),
  nextUrl: new URL('https://app.example.test/api/crm/calendar-import'), body })
  assert.equal(result.status, 413)
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
  assert.equal(app.calls.length, 0)
  const valid = harness(), encoded = JSON.stringify(command)
  assert.equal((await valid.request('PUT', encoded + ' '.repeat(8192 - Buffer.byteLength(encoded)))).status, 200)
  assert.equal(valid.calls.length, 1, 'exact 8192-byte JSON command remains accepted')
})

test('safe configuration errors preserve status; unexpected errors cannot expose provider details', async () => {
  const safe = harness({ error: new CalendarDiscoveryConfigurationError('Calendar is not accessible', 403) })
  assert.equal((await safe.request()).status, 403)
  const unexpected = harness({ error: new Error('private provider bearer secret') }), result = await unexpected.request()
  assert.equal(result.status, 409)
  assert.doesNotMatch(JSON.stringify(result), /private provider bearer secret/)
})

test('existing CRM meeting save retains recorded Calendar unless an explicit calendar override was supplied', () => {
  const source = read('app_src/app/api/crm/route.ts')
  assert.match(source, /calendarCommunication\s*=\s*hasCalendarOverride\s*\?\s*await resolveVerifiedPipelineCalendarSelection\([\s\S]*?\)\s*:\s*current\?\.externalEventId\s*\?\s*\(await resolveRecordedCrmMeetingCalendarCommunication\(/)
  assert.match(source, /resolveRecordedCrmMeetingCalendarCommunication\(\{\s*pipelineId: pipeline\.id, meetingId: current\.id, referenceCode: current\.referenceCode,\s*externalEventId: current\.externalEventId, sourcePayload: current\.sourcePayload,/)
})
