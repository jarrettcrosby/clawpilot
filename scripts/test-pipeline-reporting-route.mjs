#!/usr/bin/env node
// Execute the real route with isolated authentication/persistence dependencies.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as period from '../app_src/lib/pipeline/reportingPeriod.mjs'
const requireApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireApp('typescript')
const source = readFileSync(new URL('../app_src/app/api/pipeline/report/route.ts', import.meta.url), 'utf8')
function harness(options = {}) {
  const calls = [], scopes = [], module = { exports: {} }
  const dependencies = {
    'next/server': { NextResponse: { json: (body, init = {}) => ({ body, status: 200, ...init }) } },
    '@/lib/pipeline/reportingPeriod.mjs': period,
    '@/lib/persistence/pipeline': { isPostgresPipelineStoreEnabled: () => true },
    '@/lib/requestUser': { requireRequestUser: async () => {
      if (options.unauthorized) throw new Error('Unauthorized')
      return { email: 'owner@example.test', timezone: 'America/New_York' }
    } },
    '@/lib/tenancy': { PIPELINE_SELECTION_COOKIE: 'pipeline', resolvePipelineSpaceAccess: async input => {
      scopes.push(input)
      if (options.denied) throw new Error('view-only access denied')
      return { id: 'authorized-pipeline', workspaceOrganizationId: 'authorized-workspace' }
    } },
    '@/lib/persistence/crm': { readCrmPipelineActivityReportFromPostgres: async input => {
      calls.push(input)
      return { snapshot: { totalContacts: 4 }, interactions: 3, interactionsByMonth: [], contactsAdded: 1, opportunitiesCreated: 0 }
    } },
  }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Error, String, console,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] },
  })
  return { calls, scopes, get: query => module.exports.GET({
    nextUrl: new URL(`https://app.example.test/api/pipeline/report?${query}`),
    cookies: { get: () => ({ value: 'selected-pipeline' }) },
  }) }
}
test('default sales and explicit all use authenticated workspace and timezone, ignoring query-supplied tenants', async () => {
  for (const [query, expected] of [['', 'sales'], ['interactionScope=sales', 'sales'], ['interactionScope=all', 'all']]) {
    const app = harness(), result = await app.get(`${query}&pipelineId=foreign&organizationId=foreign&timeZone=UTC`)
    assert.equal(result.status, 200)
    assert.equal(app.calls.length, 1)
    assert.equal(app.calls[0].interactionScope, expected)
    assert.equal(app.calls[0].pipelineId, 'authorized-pipeline')
    assert.equal(app.calls[0].organizationId, 'authorized-workspace')
    assert.equal(app.calls[0].timeZone, 'America/New_York')
    assert.equal(result.body.activity.interactionScope, expected)
    assert.equal(result.body.activity.interactions, 3)
    assert.equal(result.body.snapshot.totalContacts, 4)
    assert.equal(result.headers['Cache-Control'], 'private, no-store')
  }
})
test('invalid activity scope fails before querying reporting data', async () => {
  for (const value of ['', 'supplier', 'ALL', 'sales%27OR%201%3D1']) {
    const app = harness(), result = await app.get(`interactionScope=${value}`)
    assert.equal(result.status, 400)
    assert.equal(app.calls.length, 0)
  }
})
test('scope selector never bypasses sign-in or pipeline access', async () => {
  for (const [options, status] of [[{ unauthorized: true }, 401], [{ denied: true }, 403]]) {
    const app = harness(options), result = await app.get('interactionScope=all')
    assert.equal(result.status, status)
    assert.equal(app.calls.length, 0)
  }
})
