#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { chromium } = requireFromApp('@playwright/test')
const ts = requireFromApp('typescript')
const { NextRequest } = requireFromApp('next/server')
const path =
  'app_src/app/api/dev/shopify-test-fixtures/approve/route.ts'
const organizationId = 'c6c8e6e7-fffa-4969-9526-e99da0ab2754'
const actorEmail = 'owner@example.test'
const commandGlobalId = 'gsfc1234567'
const intentHash = 'a'.repeat(64)
const confirmationStatement = 'CREATE TEST ORDER aaaaaaaaaaaa'

let sessionMode = 'owner'
let approvalCalls = 0
let durableApprovals = 0
let providerWrites = 0
let postgresEnabled = true
const approvalKeys = new Set()
const approvalInputs = []

const baseSession = {
  id: '11111111-1111-4111-8111-111111111111',
  authenticatedUser: actorEmail,
  effectiveUser: actorEmail,
  authenticatedRole: 'owner',
  effectiveRole: 'owner',
  activeWorkspaceOrganizationId: organizationId,
  activeWorkspaceRole: 'owner',
  authMethod: 'magic_code',
  impersonationStartedAt: null,
  impersonationExpiresAt: null,
  impersonating: false,
}

function sessionForMode() {
  if (sessionMode === 'unauthenticated') throw new Error('Unauthorized')
  if (sessionMode === 'legacy') {
    return { ...baseSession, legacy: true, authMethod: 'legacy_upgrade' }
  }
  if (sessionMode === 'impersonated') {
    return {
      ...baseSession,
      effectiveUser: 'member@example.test',
      impersonating: true,
      impersonationStartedAt: '2026-08-25T12:00:00.000Z',
      impersonationExpiresAt: '2026-08-25T12:30:00.000Z',
    }
  }
  if (sessionMode === 'wrong-workspace') {
    return {
      ...baseSession,
      activeWorkspaceOrganizationId:
        '22222222-2222-4222-8222-222222222222',
    }
  }
  if (sessionMode === 'member') {
    return {
      ...baseSession,
      authenticatedRole: 'member',
      effectiveRole: 'member',
      activeWorkspaceRole: 'member',
    }
  }
  return { ...baseSession }
}

function actorForMode() {
  if (sessionMode === 'member') {
    return { email: actorEmail, role: 'member', organizationRole: 'member' }
  }
  if (sessionMode === 'impersonated') {
    return {
      email: 'member@example.test',
      role: 'member',
      organizationRole: 'member',
    }
  }
  return { email: actorEmail, role: 'owner', organizationRole: 'owner' }
}

function fixtureError(code, message, status) {
  return Object.assign(new Error(message), { code, status })
}

const source = readFileSync(resolve(path), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: path,
}).outputText
const module = { exports: {} }
vm.runInNewContext(output, {
  Buffer,
  Error,
  JSON,
  Number,
  Object,
  String,
  URLSearchParams,
  console,
  exports: module.exports,
  module,
  require(specifier) {
    if (specifier === 'next/server') return requireFromApp(specifier)
    if (specifier === '@/lib/browserSameOrigin') {
      return {
        isBrowserSameOriginRequest: ({ headers, requestOrigin }) => (
          headers.get('sec-fetch-site') !== 'cross-site'
          && headers.get('origin') === requestOrigin
        ),
      }
    }
    if (specifier === '@/lib/integrations/shopifyReversalFixtureRuntime') {
      return { SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID: organizationId }
    }
    if (specifier === '@/lib/operations/shopifyReversalFixtureCommands') {
      return {
        readShopifyReversalFixtureApprovalIntent: async (input) => {
          assert.equal(input.organizationId, organizationId)
          assert.equal(input.actorEmail, actorEmail)
          if (input.commandGlobalId === 'gsfc7654321') {
            throw fixtureError(
              'SHOPIFY_REVERSAL_FIXTURE_APPROVAL_EXPIRED',
              'This fixture approval window has expired',
              409,
            )
          }
          if (input.commandGlobalId !== commandGlobalId) {
            throw fixtureError(
              'SHOPIFY_REVERSAL_FIXTURE_APPROVAL_ACTOR_MISMATCH',
              'The signed-in actor does not own this fixture approval',
              403,
            )
          }
          return {
            commandGlobalId,
            phase: 'create_order',
            intentHash,
            confirmationStatement,
            expiresAt: '2099-08-25T12:05:00.000Z',
          }
        },
        approveShopifyReversalFixtureCommand: async (input) => {
          approvalCalls += 1
          approvalInputs.push(structuredClone(input))
          if (input.commandGlobalId === 'gsfc7654321') {
            throw fixtureError(
              'SHOPIFY_REVERSAL_FIXTURE_APPROVAL_EXPIRED',
              'This fixture approval window has expired',
              409,
            )
          }
          if (
            input.commandGlobalId !== commandGlobalId
            || input.intentHash !== intentHash
            || input.confirmationStatement !== confirmationStatement
          ) {
            throw fixtureError(
              'SHOPIFY_REVERSAL_FIXTURE_APPROVAL_REQUIRED',
              'The signed-in actor must approve the exact unexpired fixture intent',
              403,
            )
          }
          const key = [
            input.browserSessionId,
            input.commandGlobalId,
            input.intentHash,
            input.confirmationStatement,
          ].join(':')
          if (!approvalKeys.has(key)) {
            approvalKeys.add(key)
            durableApprovals += 1
          }
          return {
            approvalGlobalId: 'gsfa1234567',
            commandGlobalId,
            approvedBy: actorEmail,
            approvedAt: '2026-08-25T12:01:00.000Z',
            providerWrites: 0,
            oneTime: true,
          }
        },
      }
    }
    if (specifier === '@/lib/publicUrl') {
      return { appPublicUrl: () => 'https://dev.aiapp.eigenracing.com' }
    }
    if (specifier === '@/lib/persistence/config') {
      return { isPostgresStorageEnabled: () => postgresEnabled }
    }
    if (specifier === '@/lib/requestUser') {
      return {
        requireRequestSession: async () => sessionForMode(),
        requireRequestUserForWorkspace: async (_req, requestedOrg) => {
          assert.equal(requestedOrg, organizationId)
          if (sessionMode === 'unauthenticated') throw new Error('Unauthorized')
          return actorForMode()
        },
      }
    }
    if (specifier === '@/lib/users') {
      return {
        effectiveAuthorizationRole: (actor) => (
          actor.organizationRole || actor.role
        ),
      }
    }
    return requireFromApp(specifier)
  },
}, { filename: path })

const route = module.exports

function getRequest(command = commandGlobalId) {
  return new NextRequest(
    `https://dev.aiapp.eigenracing.com/api/dev/shopify-test-fixtures/approve?command=${command}`,
  )
}

function postRequest(fields, options = {}) {
  const body = typeof fields === 'string'
    ? fields
    : new URLSearchParams(fields).toString()
  return new NextRequest(
    'https://dev.aiapp.eigenracing.com/api/dev/shopify-test-fixtures/approve',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(body)),
        origin: options.origin || 'https://dev.aiapp.eigenracing.com',
        'sec-fetch-site': options.fetchSite || 'same-origin',
        ...(options.authorization
          ? { authorization: options.authorization }
          : {}),
      },
      body,
    },
  )
}

const exactFields = {
  commandGlobalId,
  intentHash,
  confirmationStatement,
}

sessionMode = 'unauthenticated'
let response = await route.GET(getRequest())
assert.equal(response.status, 401)
assert.match(await response.text(), /Unauthorized/u)

for (const mode of ['legacy', 'impersonated', 'wrong-workspace', 'member']) {
  sessionMode = mode
  response = await route.GET(getRequest())
  assert.equal(response.status, 403, `${mode} must not view approval intent`)
}

sessionMode = 'owner'
response = await route.GET(getRequest())
assert.equal(response.status, 200)
assert.equal(response.headers.get('referrer-policy'), 'strict-origin')
const approvalHeaders = Object.fromEntries(response.headers.entries())
const form = await response.text()
assert.match(form, /Approve Shopify test fixture/u)
assert.match(form, new RegExp(commandGlobalId, 'u'))
assert.match(form, new RegExp(confirmationStatement, 'u'))
assert.equal(providerWrites, 0)

let resolveBrowserSubmission
let rejectBrowserSubmission
const browserSubmission = new Promise((resolve, reject) => {
  resolveBrowserSubmission = resolve
  rejectBrowserSubmission = reject
})
const approvalServer = createServer((request, serverResponse) => {
  if (request.method === 'GET') {
    for (const [name, value] of Object.entries(approvalHeaders)) {
      serverResponse.setHeader(name, value)
    }
    serverResponse.end(form)
    return
  }
  if (request.method !== 'POST') {
    serverResponse.writeHead(405).end()
    return
  }
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('error', rejectBrowserSubmission)
  request.on('end', () => {
    resolveBrowserSubmission({
      body: Buffer.concat(chunks).toString('utf8'),
      headers: request.headers,
    })
    serverResponse.setHeader('content-type', 'text/html; charset=utf-8')
    serverResponse.end('<h1>Captured</h1>')
  })
})
await new Promise((resolve, reject) => {
  approvalServer.once('error', reject)
  approvalServer.listen(0, '127.0.0.1', resolve)
})
const address = approvalServer.address()
assert.ok(address && typeof address === 'object')
const approvalOrigin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(
    `${approvalOrigin}/api/dev/shopify-test-fixtures/approve?command=${commandGlobalId}`,
  )
  await page.getByLabel(new RegExp(confirmationStatement, 'u')).fill(
    confirmationStatement,
  )
  await Promise.all([
    page.waitForURL(`${approvalOrigin}/api/dev/shopify-test-fixtures/approve?command=${commandGlobalId}`),
    page.getByRole('button', { name: 'Approve once' }).click(),
  ])
  const submitted = await browserSubmission
  assert.equal(submitted.headers.origin, approvalOrigin)
  assert.equal(submitted.headers['sec-fetch-site'], 'same-origin')
  assert.equal(new URL(submitted.headers.referer).origin, approvalOrigin)
  assert.equal(submitted.headers.referer.includes('?command='), false)
  assert.equal(submitted.headers.referer.includes(commandGlobalId), false)
  assert.equal(
    new URLSearchParams(submitted.body).get('confirmationStatement'),
    confirmationStatement,
  )
} finally {
  await browser.close()
  await new Promise((resolve, reject) => {
    approvalServer.close((error) => error ? reject(error) : resolve())
  })
}

response = await route.GET(getRequest('gsfc7654321'))
assert.equal(response.status, 409)
assert.match(await response.text(), /APPROVAL_EXPIRED/u)
response = await route.GET(getRequest('gsfc0000001'))
assert.equal(response.status, 403)
assert.match(await response.text(), /APPROVAL_ACTOR_MISMATCH/u)

const approvalCallsBeforeCrossOrigin = approvalCalls
response = await route.POST(postRequest(exactFields, {
  origin: 'https://attacker.example',
  fetchSite: 'cross-site',
}))
assert.equal(response.status, 403)
assert.equal(approvalCalls, approvalCallsBeforeCrossOrigin)

sessionMode = 'unauthenticated'
response = await route.POST(postRequest(exactFields, {
  authorization: `Bearer ${'w'.repeat(64)}`,
}))
assert.equal(response.status, 401)
sessionMode = 'owner'

postgresEnabled = false
response = await route.GET(getRequest())
assert.equal(response.status, 409)
assert.match(await response.text(), /POSTGRES_REQUIRED/u)
const approvalCallsBeforeStorageGate = approvalCalls
response = await route.POST(postRequest(exactFields))
assert.equal(response.status, 409)
assert.equal(approvalCalls, approvalCallsBeforeStorageGate)
postgresEnabled = true

response = await route.POST(postRequest({
  commandGlobalId,
  intentHash,
}))
assert.equal(response.status, 400)
response = await route.POST(postRequest(
  `commandGlobalId=${commandGlobalId}&commandGlobalId=${commandGlobalId}&intentHash=${intentHash}&confirmationStatement=${encodeURIComponent(confirmationStatement)}`,
))
assert.equal(response.status, 400)

response = await route.POST(postRequest({
  ...exactFields,
  confirmationStatement: 'CREATE TEST ORDER bbbbbbbbbbbb',
}))
assert.equal(response.status, 403)
response = await route.POST(postRequest({
  ...exactFields,
  commandGlobalId: 'gsfc7654321',
}))
assert.equal(response.status, 409)

response = await route.POST(postRequest(exactFields))
assert.equal(response.status, 200)
assert.match(await response.text(), /Approved once/u)
assert.equal(durableApprovals, 1)
assert.deepEqual(approvalInputs.at(-1), {
  organizationId,
  actorEmail,
  browserSessionId: baseSession.id,
  commandGlobalId,
  intentHash,
  confirmationStatement,
})

response = await route.POST(postRequest(exactFields))
assert.equal(response.status, 200)
assert.equal(durableApprovals, 1, 'exact approval replay must not append again')
assert.equal(providerWrites, 0, 'approval must never issue a provider write')

console.log('Shopify reversal fixture authenticated approval API passed.')
