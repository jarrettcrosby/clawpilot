#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const path =
  'app_src/app/api/integrations/commerce/shopify/location-administration/route.ts'
const output = ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: path,
}).outputText

class TypedError extends Error {
  constructor(input) {
    super(input.message)
    this.code = input.code
    this.status = input.status || 409
    this.uncertain = Boolean(input.uncertain)
    this.providerMutationAttempted = Boolean(input.providerMutationAttempted)
  }
}

let session = null
let providerCalls = 0
const actor = {
  email: 'owner@example.test',
  organizationId: '11111111-1111-4111-8111-111111111111',
}
const module = { exports: {} }
vm.runInNewContext(output, {
  Array,
  Boolean,
  Buffer,
  Error,
  JSON,
  Map,
  Math,
  Number,
  Object,
  Promise,
  RegExp,
  Set,
  String,
  URL,
  console,
  exports: module.exports,
  module,
  process,
  require(specifier) {
    if (specifier === 'next/server') {
      return {
        NextRequest: class NextRequest {},
        NextResponse: {
          json(payload, init = {}) {
            return { payload, status: init.status || 200, headers: init.headers }
          },
        },
      }
    }
    if (specifier === '@/lib/browserSameOrigin') {
      return {
        isBrowserSameOriginRequest(input) {
          return input.headers.get('origin') === input.requestOrigin
        },
      }
    }
    if (
      specifier
      === '@/lib/integrations/shopifyLocationAdministration'
    ) {
      return {
        async executeShopifyLocationAdministration() {
          providerCalls += 1
          return { status: 'succeeded' }
        },
        async prepareShopifyLocationAdministration(input) {
          providerCalls += 1
          return { status: 'prepared', actorEmail: input.actorEmail }
        },
        async readShopifyLocationAdministrationState() {
          providerCalls += 1
          return { providerWrites: 0 }
        },
        async reconcileShopifyLocationAdministration() {
          providerCalls += 1
          return { status: 'reconciled' }
        },
        ShopifyLocationAdministrationError: TypedError,
      }
    }
    if (specifier === '@/lib/operations/authorization') {
      return {
        activeOperationsOrganizationId(value) {
          return value.organizationId
        },
        operationsCapabilities() {
          return {
            canActivate: true,
            canManage: true,
            canExecute: true,
          }
        },
      }
    }
    if (specifier === '@/lib/persistence/config') {
      return { isPostgresStorageEnabled() { return true } }
    }
    if (specifier === '@/lib/publicUrl') {
      return { appPublicUrl() { return 'https://dev.example.test' } }
    }
    if (specifier === '@/lib/requestUser') {
      return {
        async requestSession() { return session },
        async requireRequestUser() { return actor },
      }
    }
    if (specifier === '@/lib/users') {
      return { effectiveAuthorizationRole() { return 'owner' } }
    }
    if (specifier === '@/lib/integrations/integrationCredentialRuntimeHttp') {
      return {
        integrationCredentialRuntimeMaintenanceResponse() { return null },
      }
    }
    return requireFromApp(specifier)
  },
}, { filename: path })

const route = module.exports

function request(input = {}) {
  const body = JSON.stringify(input.body || {
    action: 'prepare',
    accountGlobalId: 'gia2890001',
    mutation: 'locationAdd',
    warehouseGlobalId: 'gwh2890001',
    expectedWarehouseRowVersion: 0,
    reason: 'Create the reviewed development location.',
    confirmationStatement:
      'AUTHORIZE SHOPIFY LOCATION | ADD | gia2890001 | gwh2890001 | NEW',
  })
  const origin = input.origin || 'https://dev.example.test'
  return {
    headers: new Headers({
      origin,
      'content-length': String(Buffer.byteLength(body)),
      'idempotency-key': 'route-test-2890001',
    }),
    nextUrl: new URL(
      'https://dev.example.test/api/integrations/commerce/shopify/location-administration?accountGlobalId=gia2890001',
    ),
    async arrayBuffer() {
      return Buffer.from(body)
    },
  }
}

session = {
  authenticatedUser: 'support@example.test',
  effectiveUser: actor.email,
  impersonating: true,
}
providerCalls = 0
let response = await route.POST(request())
assert.equal(response.status, 403)
assert.equal(
  response.payload.code,
  'SHOPIFY_LOCATION_ADMINISTRATION_IMPERSONATION_FORBIDDEN',
)
assert.equal(providerCalls, 0)

session = {
  authenticatedUser: 'support@example.test',
  effectiveUser: actor.email,
  impersonating: false,
}
response = await route.GET(request())
assert.equal(response.status, 403)
assert.equal(
  response.payload.code,
  'SHOPIFY_LOCATION_ADMINISTRATION_IMPERSONATION_FORBIDDEN',
)

session = {
  authenticatedUser: actor.email,
  effectiveUser: actor.email,
  impersonating: false,
}
providerCalls = 0
response = await route.POST(request({ origin: 'https://foreign.example.test' }))
assert.equal(response.status, 403)
assert.equal(
  response.payload.code,
  'SHOPIFY_LOCATION_ADMINISTRATION_SAME_ORIGIN_REQUIRED',
)
assert.equal(providerCalls, 0)

response = await route.POST(request())
assert.equal(response.status, 201)
assert.equal(response.payload.ok, true)
assert.equal(response.payload.result.actorEmail, actor.email)
assert.equal(providerCalls, 1)

console.log('Shopify location-administration route authority fences passed')
