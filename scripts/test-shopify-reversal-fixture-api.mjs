#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const path = 'app_src/app/api/dev/shopify-test-fixtures/route.ts'
const source = readFileSync(resolve(path), 'utf8')
const secret = 'fixture-worker-secret-32-characters-minimum'
const calls = []
let runtimeAvailable = true
let postgresEnabled = true
let commandFailure = null

const commandResult = async (name, input) => {
  if (commandFailure) throw commandFailure
  calls.push({ name, input })
  if (name === 'status') {
    return {
      state: 'prepared',
      approvalGlobalId: 'gsfa1234567',
      approvedBy: 'owner@example.test',
      approvedAt: '2026-08-25T12:01:00.000Z',
    }
  }
  return { command: name }
}
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: path,
}).outputText
const module = { exports: {} }
const processValue = { env: { PIPELINE_OUTBOX_WORKER_SECRET: secret } }
vm.runInNewContext(output, {
  Buffer,
  Error,
  JSON,
  Number,
  Object,
  RegExp,
  String,
  console,
  process: processValue,
  exports: module.exports,
  module,
  require(specifier) {
    if (specifier === 'node:crypto') return crypto
    if (specifier === 'next/server') {
      return {
        NextResponse: {
          json(body, options = {}) {
            return {
              body,
              status: options.status || 200,
              headers: options.headers || {},
            }
          },
        },
      }
    }
    if (specifier === '@/lib/integrations/shopifyReversalFixtureRuntime') {
      return {
        shopifyReversalFixtureRuntime: () => ({
          available: runtimeAvailable,
          blockerCode: runtimeAvailable
            ? null
            : 'SHOPIFY_REVERSAL_FIXTURE_DISABLED',
        }),
      }
    }
    if (specifier === '@/lib/operations/shopifyReversalFixtureCommands') {
      return {
        prepareShopifyReversalFixtureOrder: (input) => (
          commandResult('prepare_order', input)
        ),
        prepareShopifyReversalFixtureFulfillment: (input) => (
          commandResult('prepare_fulfillment', input)
        ),
        executeShopifyReversalFixtureCommand: (input) => (
          commandResult('execute', input)
        ),
        reconcileShopifyReversalFixtureCommand: (input) => (
          commandResult('reconcile', input)
        ),
        readShopifyReversalFixtureStatus: (input) => (
          commandResult('status', input)
        ),
      }
    }
    if (specifier === '@/lib/persistence/config') {
      return { isPostgresStorageEnabled: () => postgresEnabled }
    }
    return requireFromApp(specifier)
  },
}, { filename: path })

function request(body, suppliedSecret = secret) {
  return {
    headers: {
      get(name) {
        return name.toLowerCase() === 'authorization'
          ? `Bearer ${suppliedSecret}`
          : null
      },
    },
    json: async () => body,
  }
}

const route = module.exports
assert.equal((await route.POST(request({}, 'wrong'))).status, 401)
assert.equal(calls.length, 0)

runtimeAvailable = false
assert.equal((await route.POST(request({}))).status, 403)
runtimeAvailable = true
postgresEnabled = false
assert.equal((await route.POST(request({}))).status, 409)
postgresEnabled = true

const common = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  actorEmail: 'owner@example.test',
}
const cases = [
  {
    action: 'prepare_order',
    body: { ...common, idempotencyKey: 'fixture-order-12345678' },
  },
  {
    action: 'prepare_fulfillment',
    body: {
      ...common,
      idempotencyKey: 'fixture-fulfillment-12345678',
      predecessorCommandGlobalId: 'gsfc1234567',
      orderGlobalId: 'gor1234567',
    },
  },
  {
    action: 'execute',
    body: {
      ...common,
      commandGlobalId: 'gsfc1234567',
      intentHash: 'a'.repeat(64),
      confirmationStatement: 'CREATE TEST ORDER aaaaaaaaaaaa',
    },
  },
  {
    action: 'reconcile',
    body: { ...common, commandGlobalId: 'gsfc1234567' },
  },
  {
    action: 'status',
    body: {
      organizationId: common.organizationId,
      commandGlobalId: 'gsfc1234567',
    },
  },
]

for (const fixture of cases) {
  const response = await route.POST(request({
    action: fixture.action,
    ...fixture.body,
  }))
  assert.equal(response.status, 200, fixture.action)
  assert.equal(response.body.ok, true, fixture.action)
  assert.equal(calls.at(-1).name, fixture.action, fixture.action)
  if (fixture.action === 'status') {
    assert.deepEqual(response.body.result, {
      state: 'prepared',
      approvalGlobalId: 'gsfa1234567',
      approvedBy: 'owner@example.test',
      approvedAt: '2026-08-25T12:01:00.000Z',
    })
  }

  const rejected = await route.POST(request({
    action: fixture.action,
    ...fixture.body,
    arbitraryPayload: true,
  }))
  assert.equal(rejected.status, 400, `${fixture.action} extra key`)
}

commandFailure = Object.assign(new Error('DATABASE_URL=must-not-leak'), {
  code: 'UNSAFE_INTERNAL_CODE',
  status: 418,
})
const redactedFailure = await route.POST(request({
  action: cases[0].action,
  ...cases[0].body,
}))
assert.equal(redactedFailure.status, 500)
assert.equal(redactedFailure.body.code, 'SHOPIFY_REVERSAL_FIXTURE_FAILED')
assert.equal(
  redactedFailure.body.error,
  'Shopify reversal fixture request failed',
)
assert.doesNotMatch(JSON.stringify(redactedFailure.body), /DATABASE_URL/u)

commandFailure = Object.assign(new Error('Known fixed-fixture rejection'), {
  code: 'SHOPIFY_REVERSAL_FIXTURE_EXPECTED_REJECTION',
  status: 409,
})
const expectedFailure = await route.POST(request({
  action: cases[0].action,
  ...cases[0].body,
}))
assert.equal(expectedFailure.status, 409)
assert.equal(
  expectedFailure.body.code,
  'SHOPIFY_REVERSAL_FIXTURE_EXPECTED_REJECTION',
)
assert.equal(expectedFailure.body.error, 'Known fixed-fixture rejection')
commandFailure = null

const cliSource = readFileSync(resolve('scripts/shopify-test-fixture.mjs'), 'utf8')
assert.match(cliSource, /process\.env\.PIPELINE_OUTBOX_WORKER_SECRET/u)
assert.doesNotMatch(cliSource, /--secret|secret=|endpoint-url|base-url/iu)
assert.equal((cliSource.match(/\bfetch\s*\(/gu) || []).length, 1)
assert.match(cliSource, /do not retry an execute command/iu)

const cliUrl = pathToFileURL(resolve('scripts/shopify-test-fixture.mjs')).href
const cliArguments = Object.freeze({
  execute: [
    `--organization-id=${common.organizationId}`,
    `--actor-email=${common.actorEmail}`,
    '--command=gsfc1234567',
    `--intent=${'a'.repeat(64)}`,
    '--confirmation=CREATE TEST ORDER aaaaaaaaaaaa',
  ],
  reconcile: [
    `--organization-id=${common.organizationId}`,
    `--actor-email=${common.actorEmail}`,
    '--command=gsfc1234567',
  ],
  status: [
    `--organization-id=${common.organizationId}`,
    '--command=gsfc1234567',
  ],
})

function runCli(command, state) {
  const responseBody = { ok: true, result: { state } }
  const runner = [
    `process.argv = [process.execPath, 'fixture', ${JSON.stringify(command)}, ...${JSON.stringify(cliArguments[command])}]`,
    `globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => (${JSON.stringify(responseBody)}) })`,
    `await import(${JSON.stringify(cliUrl)})`,
  ].join(';\n')
  return spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    runner,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PIPELINE_OUTBOX_WORKER_SECRET: secret,
    },
  })
}

const successfulCli = runCli('execute', 'succeeded')
assert.equal(successfulCli.status, 0, successfulCli.stderr)
assert.equal(successfulCli.stderr, '')

for (const [command, state] of [
  ['execute', 'rejected'],
  ['execute', 'unknown'],
  ['reconcile', 'reconciled_absent'],
  ['reconcile', 'reconciled_ambiguous'],
  ['status', 'processing'],
]) {
  const result = runCli(command, state)
  assert.equal(result.status, 1, `${command}:${state}\n${result.stderr}`)
  assert.match(result.stderr, new RegExp(`state "${state}"`, 'u'))
  assert.match(result.stderr, /Do not retry an execute command/u)
  assert.match(result.stdout, new RegExp(`"state": "${state}"`, 'u'))
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret, 'u'))
}

console.log('Shopify reversal fixture worker-secret API and one-shot CLI passed.')
