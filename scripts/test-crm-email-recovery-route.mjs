#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import * as publicOriginRouting from '../app_src/lib/publicOriginRouting.mjs'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const source = readFileSync('app_src/app/api/crm/email-recovery/route.ts', 'utf8')
const sameOriginSource = readFileSync('app_src/lib/browserSameOrigin.ts', 'utf8')
const organizationId = '00000000-0000-4000-8000-000000000001'
const pipelineId = '00000000-0000-4000-8000-000000000002'
const connectionId = '00000000-0000-4000-8000-000000000003'
const email = 'owner@example.test'
const digest = 'a'.repeat(64)
const command = { pipelineId, connectionId, messageIds: ['19abcdef01234567'] }
class SafeEmailIngestionError extends Error {}

function load(code, mocks = {}, environment = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  vm.runInNewContext(output, {
    module, exports: module.exports, Error, Uint8Array, TextDecoder, URL,
    Object, String, Number, JSON, RegExp, Set,
    process: { env: environment },
    require: name => { assert.ok(name in mocks, `Unexpected dependency: ${name}`); return mocks[name] },
  })
  return module.exports
}

function harness(options = {}) {
  const calls = [], accessCalls = [], authCalls = []
  const actor = { email, organizationId, role: 'owner', ...options.actor }
  const session = options.noSession ? null : {
    authenticatedUser: email, effectiveUser: email, activeWorkspaceOrganizationId: organizationId,
    impersonating: false, ...options.session,
  }
  const pipeline = { id: pipelineId, ownerEmail: email, workspaceOrganizationId: organizationId, ...options.pipeline }
  const route = load(source, {
    'next/server': { NextResponse: { json: (body, init) => ({ body, ...init }) } },
    '@/lib/browserSameOrigin': load(sameOriginSource, {
      './publicOriginRouting.mjs': publicOriginRouting,
    }, { CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON: options.additionalOrigins }),
    '@/lib/publicUrl': { appPublicUrl: () => 'https://app.example.test' },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => options.postgres !== false },
    '@/lib/requestUser': {
      requestSession: async () => session,
      requireRequestUser: async () => { authCalls.push(actor); if (options.unauthorized) throw new Error('Unauthorized'); return actor },
    },
    '@/lib/tenancy': { resolvePipelineSpaceAccess: async input => {
      accessCalls.push(input); if (options.accessError) throw new Error('private pipeline metadata'); return pipeline
    } },
    '@/lib/crm/emailIngestion': {
      SafeEmailIngestionError,
      reconcileGmailMessages: async input => {
        calls.push(input); if (options.error) throw options.error
        return { applied: input.apply, digest, pipelineId, messages: [], ...(input.apply ? { interactions: 0, links: 0 } : {}) }
      },
    },
  })
  async function request(body = command, headers = {}) {
    const req = new Request('https://app.example.test/api/crm/email-recovery', {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    })
    req.nextUrl = new URL(req.url)
    return route.POST(req)
  }
  return { route, request, calls, accessCalls, authCalls, actor }
}

test('POST-only dry run defaults to read-only and passes only authenticated pipeline owner authority', async () => {
  const app = harness()
  assert.equal(app.route.GET, undefined)
  assert.equal(app.route.PUT, undefined)
  const result = await app.request()
  assert.equal(result.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls)), [{ ...command, ownerEmail: email, apply: false }])
  assert.equal(app.accessCalls[0].actorEmail, app.actor)
  assert.equal(app.accessCalls[0].pipelineId, pipelineId)
  assert.equal(result.body.recovery.applied, false)
  assert.equal(result.body.recovery.digest, digest)
  assert.equal(result.body.recovery.interactions, undefined)
  assert.match(result.headers['Cache-Control'], /private.*no-store/)
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(result.headers.Vary, 'Cookie, Origin')
})

test('apply requires a reviewed digest; no-op result stays explicit', async () => {
  const app = harness()
  const result = await app.request({ ...command, apply: true, expectedDigest: digest })
  assert.equal(result.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0])), { ...command, ownerEmail: email, apply: true, expectedDigest: digest })
  assert.equal(result.body.recovery.applied, true)
  assert.equal(result.body.recovery.interactions, 0)
  assert.equal(result.body.recovery.links, 0)
})

test('requires a real non-impersonating browser session and an active same-workspace owner', async () => {
  for (const [options, status] of [
    [{ noSession: true }, 401], [{ unauthorized: true }, 401],
    [{ session: { authenticatedUser: '' } }, 401],
    [{ session: { impersonating: true } }, 403],
    [{ session: { effectiveUser: 'member@example.test' } }, 403],
    [{ actor: { email: 'other@example.test' } }, 403],
    [{ actor: { organizationId: null } }, 403],
    [{ session: { activeWorkspaceOrganizationId: 'other-org' } }, 403],
    [{ pipeline: { ownerEmail: 'other@example.test' }, actor: { role: 'member' } }, 403],
    [{ pipeline: { workspaceOrganizationId: 'other-org' } }, 403],
    [{ pipeline: { workspaceOrganizationId: null } }, 403],
    [{ pipeline: { id: 'other-pipeline' } }, 403], [{ accessError: true }, 403],
    [{ postgres: false }, 503],
  ]) {
    const app = harness(options), result = await app.request()
    assert.equal(result.status, status, JSON.stringify(options))
    assert.equal(app.calls.length, 0)
    assert.doesNotMatch(JSON.stringify(result), /private pipeline metadata/)
  }
  const fallback = harness({ noSession: true })
  await fallback.request()
  assert.equal(fallback.authCalls.length, 0, 'local development auth fallback is not consulted')
})

test('origin validation uses real helper and rejects missing, foreign and cross-site origins before auth', async () => {
  for (const headers of [
    { origin: '' }, { origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' },
  ]) {
    const app = harness(), result = await app.request(command, headers)
    assert.equal(result.status, 403)
    assert.equal(app.authCalls.length, 0)
    assert.equal(app.calls.length, 0)
  }
})

test('real origin helpers allow only configured additional origins without bypassing cross-site protection', async () => {
  const additionalOrigins = JSON.stringify(['https://aiapp.bposupplychain.com'])
  const allowed = harness({ additionalOrigins })
  assert.equal((await allowed.request(command, { origin: 'https://aiapp.bposupplychain.com' })).status, 200)
  assert.equal(allowed.calls.length, 1)

  for (const [options, headers] of [
    [{}, { origin: 'https://aiapp.bposupplychain.com' }],
    [{ additionalOrigins }, { origin: 'https://aiapp.bposupplychain.com.attacker.test' }],
    [{ additionalOrigins }, { origin: 'http://aiapp.bposupplychain.com' }],
    [{ additionalOrigins }, { origin: 'https://aiapp.bposupplychain.com', 'sec-fetch-site': 'cross-site' }],
  ]) {
    const app = harness(options)
    assert.equal((await app.request(command, headers)).status, 403)
    assert.equal(app.authCalls.length, 0)
    assert.equal(app.calls.length, 0)
  }
})

test('invalid additional-origin configuration fails closed before authentication or recovery', async () => {
  for (const additionalOrigins of [
    '{', JSON.stringify(['http://aiapp.bposupplychain.com']),
    JSON.stringify(['https://aiapp.bposupplychain.com/path']),
    JSON.stringify(['https://aiapp.bposupplychain.com', 'https://aiapp.bposupplychain.com']),
  ]) {
    const app = harness({ additionalOrigins })
    const result = await app.request()
    assert.equal(result.status, 500)
    assert.equal(result.body.error, 'Email recovery is unavailable')
    assert.equal(app.authCalls.length, 0)
    assert.equal(app.calls.length, 0)
  }
})

test('bounded strict JSON rejects forged authority, broad replay, invalid IDs and unreviewed apply', async () => {
  for (const [body, headers, status] of [
    [command, { 'content-type': 'text/plain' }, 415],
    [command, { 'content-length': '8193' }, 413], [command, { 'content-length': '-1' }, 413],
    [' '.repeat(8193), {}, 413], ['é'.repeat(4097), {}, 413],
    [new Uint8Array([0xff]), {}, 400], ['{', {}, 400], ['null', {}, 400], [[], {}, 400],
    [{ ...command, ownerEmail: 'other@example.test' }, {}, 400],
    [{ ...command, organizationId: 'other' }, {}, 400], [{ ...command, resetCursor: true }, {}, 400],
    [{ ...command, pipelineId: '' }, {}, 400], [{ ...command, connectionId: '../other' }, {}, 400],
    [{ ...command, pipelineId: 'not-a-uuid' }, {}, 400],
    [{ ...command, pipelineId: 'a'.repeat(201) }, {}, 400],
    [{ ...command, messageIds: [] }, {}, 400],
    [{ ...command, messageIds: Array.from({ length: 26 }, (_, i) => (i + 1).toString(16)) }, {}, 400],
    [{ ...command, messageIds: ['abc', 'ABC'] }, {}, 400],
    [{ ...command, messageIds: ['abc/def'] }, {}, 400], [{ ...command, messageIds: [1] }, {}, 400],
    [{ ...command, messageIds: ['a'.repeat(129)] }, {}, 400],
    [{ ...command, apply: 'true' }, {}, 400], [{ ...command, apply: true }, {}, 400],
    [{ ...command, apply: true, expectedDigest: 'bad' }, {}, 400],
    [{ ...command, expectedDigest: digest }, {}, 400],
    [{ ...command, apply: false, expectedDigest: digest }, {}, 400],
  ]) {
    const app = harness(), result = await app.request(body, headers)
    assert.equal(result.status, status, JSON.stringify({ body, headers }).slice(0, 250))
    assert.equal(app.calls.length, 0)
    assert.equal(app.accessCalls.length, 0)
  }
})

test('oversized streaming body cancels before provider work and ignores a false small content-length', async () => {
  const app = harness()
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4096)); controller.enqueue(new Uint8Array(4097)) },
    cancel() { cancelled = true },
  })
  const result = await app.route.POST({
    headers: new Headers({ origin: 'https://app.example.test', 'content-type': 'application/json', 'content-length': '1' }),
    nextUrl: new URL('https://app.example.test/api/crm/email-recovery'), body,
  })
  assert.equal(result.status, 413)
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
  assert.equal(app.calls.length, 0)
})

test('exact byte and message-count boundaries are accepted without broadening the requested IDs', async () => {
  const app = harness()
  const selected = { ...command, messageIds: Array.from({ length: 25 }, (_, i) => (i + 1).toString(16).toUpperCase()) }
  const raw = JSON.stringify(selected)
  const result = await app.request(raw + ' '.repeat(8192 - Buffer.byteLength(raw)))
  assert.equal(result.status, 200)
  assert.equal(app.calls.length, 1)
  assert.deepEqual([...app.calls[0].messageIds], selected.messageIds.map(id => id.toLowerCase()))
  assert.equal(app.calls[0].apply, false)
})

test('safe ingestion conflicts are actionable; unexpected failures never leak provider secrets', async () => {
  const conflict = await harness({ error: new SafeEmailIngestionError('Recovery preview changed; run another dry run') }).request()
  assert.equal(conflict.status, 409)
  assert.match(conflict.body.error, /preview changed/)
  const unexpected = await harness({ error: new Error('secret token and provider body') }).request()
  assert.equal(unexpected.status, 500)
  assert.doesNotMatch(JSON.stringify(unexpected), /secret|token|provider body/)
  assert.match(unexpected.headers['Cache-Control'], /no-store/)
})
