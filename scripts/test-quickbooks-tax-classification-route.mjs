#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
function load(relativePath, mocks = {}) {
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    Buffer, Error, Number, Set, URLSearchParams, Response,
    module, exports: module.exports,
    require(specifier) {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier]
      throw new Error(`Unexpected import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

const helper = load('../app_src/lib/integrations/quickBooksTaxClassifications.ts')
const calls = []
let connected = true
let viewAccess = true
const route = load('../app_src/app/api/accounting/quickbooks/tax-classifications/route.ts', {
  'next/server': {
    NextResponse: {
      json(payload, options) { return { payload, status: options.status, headers: options.headers } },
    },
  },
  '@/lib/accountingAuthorization': {
    accountingCapabilities: () => ({ canView: viewAccess }),
    activeAccountingOrganizationId: () => '11111111-1111-4111-8111-111111111111',
  },
  '@/lib/integrations/quickBooksTaxClassifications': helper,
  '@/lib/maton': {
    async matonFetch(path, init, context) {
      calls.push({ path, init, context })
      const payload = path.includes('parentId=')
        ? { QueryResponse: { TaxClassification: [{
          Id: 'EUC-FOOD-V1-00120000', Name: 'Food & beverages', Level: '2',
          ParentRef: { value: 'V1-00120000', name: 'Retail' }, ApplicableTo: ['NonInventory'],
        }, {
          Id: 'EUC-SERVICE-V1-00120000', Name: 'Retail service', Level: '2',
          ParentRef: { value: 'V1-00120000', name: 'Retail' }, ApplicableTo: ['Service'],
        }] } }
        : { QueryResponse: { TaxClassification: [{
          Id: 'V1-00120000', Name: 'Retail', Level: '1', ApplicableTo: ['Inventory', 'NonInventory'],
        }] } }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  },
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/persistence/postgres': {
    async query(_statement, params) {
      assert.deepEqual(Array.from(params), ['11111111-1111-4111-8111-111111111111'])
      return { rows: connected ? [{ credential_owner_email: 'owner@example.com', maton_connection_id: 'bound-connection' }] : [] }
    },
  },
  '@/lib/requestUser': { requireRequestUser: async () => ({ email: 'viewer@example.com' }) },
})

function request(search) { return { nextUrl: new URL(`http://localhost/api/accounting/quickbooks/tax-classifications${search}`) } }

let result = await route.GET(request('?itemType=NonInventory'))
assert.equal(result.status, 200)
assert.equal(result.headers['Cache-Control'], 'no-store')
assert.equal(result.payload.categories.length, 1)
assert.equal(calls.length, 1)
assert.equal(calls[0].init.method, 'GET')
assert.equal(calls[0].context.boundConnectionId, 'bound-connection')

result = await route.GET(request('?itemType=NonInventory&parentId=V1-00120000'))
assert.equal(result.status, 200)
assert.equal(result.payload.categories[0].name, 'Food & beverages')
assert.equal(result.payload.categories.length, 2, 'inapplicable children remain visible to leaf detection')
assert.equal(calls.length, 3, 'child lookup validates the parent against the bound company')

const beforeInvalid = calls.length
result = await route.GET(request('?itemType=Bad&parentId=V1-00120000'))
assert.equal(result.status, 400)
assert.equal(calls.length, beforeInvalid)

result = await route.GET(request('?itemType=Service&parentId=V1-00120000'))
assert.equal(result.status, 400, 'inapplicable parent is rejected')

viewAccess = false
result = await route.GET(request('?itemType=NonInventory'))
assert.equal(result.status, 403)
viewAccess = true

connected = false
result = await route.GET(request('?itemType=NonInventory'))
assert.equal(result.status, 409)

console.log('QuickBooks tax classification route tests passed')
