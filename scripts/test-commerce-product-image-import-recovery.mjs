#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const path = 'app_src/app/api/crm/products/[productId]/image-import-recovery/route.ts'
const source = readFileSync(path, 'utf8')
const productId = '00000000-0000-4000-8000-000000000002'
const organizationId = '00000000-0000-4000-8000-000000000001'
const command = { jobId: '00000000-0000-4000-8000-000000000003',
  expectedJobGeneration: 3, expectedErrorCode: 'COMMERCE_PROVIDER_IMAGE_TIMEOUT',
  confirmInboundOnly: true, reason: 'Reviewed provider image endpoint recovery',
  idempotencyKey: '00000000-0000-4000-8000-000000000004' }
class ImportError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}

function harness(options = {}) {
  const calls = []
  const actor = { email: 'manager@example.test', organizationId, role: 'owner',
    permissions: { manageOperations: true }, ...options.actor }
  const mocks = {
    'next/server': { NextResponse: { json: (body, init) => ({ body, ...init }) } },
    '@/lib/browserSameOrigin': { isBrowserSameOriginRequest: ({ headers }) => headers.get('origin') === 'https://app.example.test' },
    '@/lib/integrations/commerceIntake': { commerceReadRuntimeAvailable: () => options.runtime !== false },
    '@/lib/integrations/integrationCredentialRuntimeHttp': { integrationCredentialRuntimeMaintenanceResponse: () => null },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => options.postgres !== false },
    '@/lib/publicUrl': { appPublicUrl: () => 'https://app.example.test' },
    '@/lib/requestUser': {
      requestSession: async () => ({ impersonating: options.impersonating === true }),
      requireRequestUser: async () => { if (options.unauthorized) throw new Error('Unauthorized'); return actor },
    },
    '@/lib/users': { effectiveAuthorizationRole: (user) => user.role },
    '@/lib/persistence/commerceProductImageImports': {
      CommerceProductImageImportError: ImportError,
      listDeadCommerceProductImageImportRecoveriesInPostgres: async (input) => {
        calls.push(['read', input]); if (options.error) throw options.error
        return { jobs: [], hasMore: false, providerWrites: 0 }
      },
      retryDeadCommerceProductImageImportJobInPostgres: async (input) => {
        calls.push(['retry', input]); if (options.error) throw options.error
        return { jobId: command.jobId, replayed: false, providerWrites: 0 }
      },
    },
  }
  const module = { exports: {} }
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, Error, Uint8Array,
    TextDecoder, Object, String, Number, JSON, RegExp,
    require: (name) => { assert.ok(name in mocks, `Unexpected dependency: ${name}`); return mocks[name] } })
  async function request(method = 'POST', body = command, headers = {}, selectedProduct = productId) {
    const req = new Request(`https://app.example.test/api/crm/products/${selectedProduct}/image-import-recovery`, {
      method, headers: { origin: 'https://app.example.test', 'content-type': 'application/json', ...headers },
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    })
    req.nextUrl = new URL(req.url)
    return module.exports[method](req, { params: Promise.resolve({ productId: selectedProduct }) })
  }
  return { request, calls }
}

test('read and retry use only authenticated organization/product and bounded reviewed command', async () => {
  const app = harness()
  const read = await app.request('GET')
  assert.equal(read.status, 200)
  assert.match(read.headers['Cache-Control'], /no-store/)
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0][1])), { organizationId, productId, actorEmail: 'manager@example.test' })
  const posted = await app.request()
  assert.equal(posted.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[1][1])), { ...command, organizationId, productId, actorEmail: 'manager@example.test' })
  assert.equal(posted.body.recovery.providerWrites, 0)
})

test('authorization, impersonation and runtime gates apply to GET and POST before persistence', async () => {
  for (const [options, expected] of [
    [{ unauthorized: true }, 401], [{ impersonating: true }, 403],
    [{ actor: { role: 'member' } }, 403], [{ actor: { permissions: { manageOperations: false } } }, 403],
    [{ actor: { organizationId: null } }, 403], [{ runtime: false }, 503], [{ postgres: false }, 503],
  ]) {
    for (const method of ['GET', 'POST']) {
      const app = harness(options)
      assert.equal((await app.request(method)).status, expected)
      assert.equal(app.calls.length, 0)
    }
  }
})

test('cross-origin, malformed, oversized, unreviewed and injected authority commands fail closed', async () => {
  for (const [body, headers, status] of [
    [command, { origin: 'https://attacker.test' }, 403],
    [command, { 'content-type': 'text/plain' }, 415],
    [command, { 'content-length': '5000' }, 413],
    [' '.repeat(4097), {}, 413], ['{', {}, 400], [[], {}, 400],
    [{ ...command, organizationId: 'other' }, {}, 400],
    [{ ...command, confirmInboundOnly: false }, {}, 400],
    [{ ...command, expectedJobGeneration: 0 }, {}, 400],
    [{ ...command, expectedJobGeneration: 3.5 }, {}, 400],
    [{ ...command, expectedErrorCode: 'https://sensitive.test' }, {}, 400],
    [{ ...command, reason: 'short' }, {}, 400], [{ ...command, reason: 'x'.repeat(501) }, {}, 400],
    [{ ...command, idempotencyKey: '' }, {}, 400], [{ ...command, jobId: 'not-a-uuid' }, {}, 400],
  ]) {
    const app = harness()
    assert.equal((await app.request('POST', body, headers)).status, status)
    assert.equal(app.calls.length, 0)
  }
  const app = harness()
  assert.equal((await app.request('GET', undefined, {}, 'bad-id')).status, 404)
})

test('persistence tenant/current-evidence rejection reaches client; unexpected errors are sanitized', async () => {
  for (const method of ['GET', 'POST']) {
    const rejected = harness({ error: new ImportError('FENCE_STALE', 'Reload current evidence', 409) })
    assert.equal((await rejected.request(method)).status, 409)
    const unknown = harness({ error: new Error('secret raw source URL') })
    const result = await unknown.request(method)
    assert.equal(result.status, 500)
    assert.doesNotMatch(JSON.stringify(result), /secret/)
  }
})

test('UI separates inbound retry and keeps reviewed command key on ambiguous failures', () => {
  const ui = readFileSync('app_src/components/crm/ProductImageImportRecoveryPanel.tsx', 'utf8')
  const panel = readFileSync('app_src/components/crm/ProductImagePanel.tsx', 'utf8')
  assert.match(ui, /image-import-recovery/)
  assert.match(ui, /idempotencyKey: pending\.current\.key/)
  assert.match(ui, /confirmInboundOnly: true/)
  assert.match(ui, /expectedJobGeneration: selected\.jobGeneration/)
  assert.match(ui, /expectedErrorCode: selected\.errorCode/)
  assert.match(panel, /canManage && state\?\.imageImportAvailable/)
  assert.doesNotMatch(ui, /shopify-product-image|faire-product-images|inventory\/|publish-product/)
})
