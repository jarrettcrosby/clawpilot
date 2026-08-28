#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const authorizationPath =
  'app_src/lib/operations/physicalOutputAttestationAuthorization.ts'
const authorizationOutput = ts.transpileModule(
  readFileSync(authorizationPath, 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: authorizationPath,
  },
).outputText
const authorizationModule = { exports: {} }
vm.runInNewContext(authorizationOutput, {
  Set,
  exports: authorizationModule.exports,
  module: authorizationModule,
  require(specifier) {
    if (specifier === '@/lib/users') {
      return {
        effectiveAuthorizationRole(value) {
          return value.organizationRole || value.role
        },
      }
    }
    return requireFromApp(specifier)
  },
}, { filename: authorizationPath })
const physicalOutputAuthorization = authorizationModule.exports
const path = 'app_src/app/api/operations/print-jobs/route.ts'
const output = ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: path,
}).outputText

class OperationsRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const organizationId = '11111111-1111-4111-8111-111111111111'
const actorEmail = 'warehouse.operator@example.test'
const actor = {
  email: actorEmail,
  organizationId,
  role: 'member',
  organizationRole: 'member',
}
const baseSession = {
  id: '22222222-2222-4222-8222-222222222222',
  authenticatedUser: actorEmail,
  effectiveUser: actorEmail,
  authenticatedRole: 'member',
  effectiveRole: 'member',
  activeWorkspaceOrganizationId: organizationId,
  activeWorkspaceRole: 'member',
  authMethod: 'magic_code',
  impersonationStartedAt: null,
  impersonationExpiresAt: null,
  impersonating: false,
  legacy: false,
}

let session = { ...baseSession }
let requireSessionCalls = 0
const attestationInputs = []
const reprintInputs = []
const workspaceInputs = []

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
            return {
              payload,
              status: init.status || 200,
              headers: init.headers,
            }
          },
        },
      }
    }
    if (specifier === '@/lib/browserSameOrigin') {
      return {
        isBrowserSameOriginRequest(input) {
          return input.headers.get('sec-fetch-site') !== 'cross-site'
            && input.headers.get('origin') === input.requestOrigin
        },
      }
    }
    if (specifier === '@/lib/operations/authorization') {
      return {
        activeOperationsOrganizationId(value) {
          return value.organizationId
        },
        operationsCapabilities() {
          return {
            canView: true,
            canManage: true,
            canExecute: true,
            canActivate: false,
          }
        },
      }
    }
    if (
      specifier
      === '@/lib/operations/physicalOutputAttestationAuthorization'
    ) {
      return physicalOutputAuthorization
    }
    if (specifier === '@/lib/persistence/config') {
      return { isPostgresStorageEnabled() { return true } }
    }
    if (specifier === '@/lib/persistence/operationPrintDelivery') {
      return {
        async attestOperationsPrintJobPhysicalOutputInPostgres(input) {
          attestationInputs.push(structuredClone(input))
          return { globalId: input.jobGlobalId }
        },
        async reprintOperationsPrintJobInPostgres(input) {
          reprintInputs.push(structuredClone(input))
          return { globalId: 'gpj7654322' }
        },
        async cancelOperationsPrintJobInPostgres() {
          throw new Error('unexpected cancel')
        },
        async enqueueOperationsPrintJobInPostgres() {
          throw new Error('unexpected enqueue')
        },
        async readOperationsPrintJobWorkspaceFromPostgres(input) {
          workspaceInputs.push(structuredClone(input))
          return {
            organizationId: input.organizationId,
            capabilities: {
              canView: input.canView,
              canManage: input.canManage,
              canExecute: input.canExecute,
              canReprint: input.canManage && input.canExecute,
              canVerifyPhysicalOutput: input.canExecute
                && input.canVerifyPhysicalOutput === true,
            },
            jobs: [],
            generatedAt: '2026-08-28T12:00:00.000Z',
          }
        },
        async retryOperationsPrintJobInPostgres() {
          throw new Error('unexpected retry')
        },
      }
    }
    if (specifier === '@/lib/persistence/operations') {
      return { OperationsRequestError }
    }
    if (specifier === '@/lib/publicUrl') {
      return { appPublicUrl() { return 'https://dev.example.test' } }
    }
    if (specifier === '@/lib/requestUser') {
      return {
        async requestSession() {
          return session
        },
        async requireRequestSession() {
          requireSessionCalls += 1
          if (!session) throw new Error('Unauthorized')
          return session
        },
        async requireRequestUser() {
          return actor
        },
      }
    }
    if (specifier === '@/lib/users') return {}
    return requireFromApp(specifier)
  },
}, { filename: path })

const route = module.exports

function request(body, options = {}) {
  const raw = JSON.stringify(body)
  return {
    headers: new Headers({
      'content-type': 'application/json',
      'idempotency-key': options.idempotencyKey || 'physical-output-route-test',
      origin: options.origin || 'https://dev.example.test',
      'sec-fetch-site': options.fetchSite || 'same-origin',
    }),
    nextUrl: new URL('https://dev.example.test/api/operations/print-jobs'),
    async text() { return raw },
  }
}

const attestationBody = {
  action: 'attest-physical-output',
  jobGlobalId: 'gpj7654321',
  expectedDeliveryAttemptId: '99fdcbe7-a2bf-489c-b82b-93499c171304',
  expectedDeliveryAttemptSequenceNumber: 3,
  reason: 'Observed one complete label exit the printer',
}
let response

for (const [candidateSession, expected] of [
  [{ ...baseSession }, true],
  [{ ...baseSession, legacy: true, authMethod: 'legacy_upgrade' }, false],
  [{ ...baseSession, authMethod: 'demo' }, false],
  [{ ...baseSession, authenticatedUser: 'different@example.test' }, false],
  [{
    ...baseSession,
    authenticatedUser: 'support@example.test',
    effectiveUser: actorEmail,
    impersonating: true,
    impersonationStartedAt: '2026-08-28T12:00:00.000Z',
    impersonationExpiresAt: '2026-08-28T12:30:00.000Z',
  }, false],
  [{
    ...baseSession,
    activeWorkspaceOrganizationId:
      '33333333-3333-4333-8333-333333333333',
  }, false],
]) {
  session = candidateSession
  response = await route.GET(request({}))
  assert.equal(response.status, 200)
  assert.equal(
    response.payload.jobs.capabilities.canVerifyPhysicalOutput,
    expected,
  )
  assert.equal(workspaceInputs.at(-1).canVerifyPhysicalOutput, expected)
}

session = {
  ...baseSession,
  authenticatedUser: 'support@example.test',
  effectiveUser: actorEmail,
  impersonating: true,
  impersonationStartedAt: '2026-08-28T12:00:00.000Z',
  impersonationExpiresAt: '2026-08-28T12:30:00.000Z',
}
response = await route.POST(request(attestationBody))
assert.equal(response.status, 403)
assert.equal(
  response.payload.code,
  'OPERATIONS_PRINT_PHYSICAL_OUTPUT_BROWSER_SESSION_REQUIRED',
)
assert.equal(attestationInputs.length, 0)

for (const invalidSession of [
  { ...baseSession, legacy: true, authMethod: 'legacy_upgrade' },
  { ...baseSession, authMethod: 'demo' },
  { ...baseSession, authenticatedUser: 'different@example.test' },
  {
    ...baseSession,
    activeWorkspaceOrganizationId:
      '33333333-3333-4333-8333-333333333333',
  },
]) {
  session = invalidSession
  response = await route.POST(request(attestationBody))
  assert.equal(response.status, 403)
  assert.equal(
    response.payload.code,
    'OPERATIONS_PRINT_PHYSICAL_OUTPUT_BROWSER_SESSION_REQUIRED',
  )
}
assert.equal(attestationInputs.length, 0)

session = { ...baseSession }
response = await route.POST(request(attestationBody, {
  origin: 'https://foreign.example.test',
  fetchSite: 'cross-site',
}))
assert.equal(response.status, 403)
assert.equal(
  response.payload.code,
  'OPERATIONS_PRINT_PHYSICAL_OUTPUT_SAME_ORIGIN_REQUIRED',
)
assert.equal(attestationInputs.length, 0)

const multilineReason = [
  'Observed one complete, legible 4 x 6 label exit the printer.',
  '\tSecond operator-visible line contained no tears or clipping.',
].join('\n')
response = await route.POST(request({
  ...attestationBody,
  reason: multilineReason,
}))
assert.equal(response.status, 200)
assert.equal(response.payload.ok, true)
assert.equal(attestationInputs.length, 1)
assert.equal(attestationInputs[0].reason, multilineReason)
assert.equal(attestationInputs[0].actorEmail, actorEmail)

response = await route.POST(request({
  ...attestationBody,
  reason: 'Observed label\u0007but contains a forbidden control',
}, { idempotencyKey: 'physical-output-forbidden-control' }))
assert.equal(response.status, 400)
assert.equal(
  response.payload.code,
  'OPERATIONS_PRINT_PHYSICAL_OUTPUT_REASON_INVALID',
)
assert.equal(attestationInputs.length, 1)

const sessionCallsBeforeReprint = requireSessionCalls
session = null
response = await route.POST(request({
  action: 'reprint-job',
  jobGlobalId: 'gpj7654321',
  reason: 'Authorized non-attestation reprint',
}, { idempotencyKey: 'reprint-route-test-valid' }))
assert.equal(response.status, 200)
assert.equal(reprintInputs.length, 1)
assert.equal(requireSessionCalls, sessionCallsBeforeReprint)

response = await route.POST(request({
  action: 'reprint-job',
  jobGlobalId: 'gpj7654321',
  reason: 'Generic reasons still reject\ncontrol characters',
}, { idempotencyKey: 'reprint-route-test-newline' }))
assert.equal(response.status, 400)
assert.equal(response.payload.code, 'OPERATIONS_PRINT_JOB_REQUEST_INVALID')
assert.equal(reprintInputs.length, 1)

console.log('Operations physical-output route session and reason checks passed.')
