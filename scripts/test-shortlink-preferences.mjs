#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const appRequire = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = appRequire('typescript')

function loadAuthorizationModule(path, dependencies = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(output, {
    module, exports: module.exports, console, URL, process,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
      return appRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}
const noAuthorizationIo = () => { throw new Error('Unexpected authorization I/O') }
const users = loadAuthorizationModule('app_src/lib/users.ts', {
  '@/lib/persistence/postgres': { query: noAuthorizationIo, withTransaction: noAuthorizationIo },
  '@/lib/auditWriter': {}, '@/lib/crm/suiteCrmClient': {}, '@/lib/demoMode': {},
})
const authorization = loadAuthorizationModule('app_src/lib/moduleAuthorization.ts', {
  'server-only': {}, '@/lib/users': users,
  '@/lib/moduleAccess': loadAuthorizationModule('app_src/lib/moduleAccess.ts'),
})

function loadRoute(path, shortlinks) {
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(output, {
    module, exports: module.exports, console, URL,
    require(specifier) {
      if (specifier === 'next/server') return { NextResponse: { json: (data, options) => Response.json(data, options) } }
      if (specifier === '@/lib/moduleAuthorization') return authorization
      if (specifier === '@/lib/shortlinks') return shortlinks
      throw new Error(`Unexpected preference test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

class ShortLinkRequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
let currentActor = { ownerEmail: 'operator@example.test', organizationId: 'test-workspace', service: false }
let browserUser = { email: currentActor.ownerEmail, role: 'owner', status: 'active', permissions: users.OWNER_PERMISSIONS,
  organizationId: currentActor.organizationId, organizationRole: 'member', organizationPermissions: { viewLinks: true } }
let saved = 'bpo'
let reads = 0
let saves = 0
const creates = []
const shortlinks = {
  ShortLinkRequestError,
  resolveShortLinkActor: async (req) => {
    if (!currentActor.service) authorization.requireRequestModuleAccess(req, browserUser)
    return currentActor
  },
  availableShortLinkDomains: () => [{ key: 'eigenracing', label: 'eigenracing.com' }, { key: 'bpo', label: 'bposupplychain.com' }],
  readShortLinkDefaultDomain: async () => { reads += 1; return saved },
  readShortLinkDomainPreferences: async () => { reads += 1; return { defaultDomain: saved, userDefaultDomain: saved, organizationDefaultDomain: 'bpo', canOverrideDefault: true, availableDomains: shortlinks.availableShortLinkDomains() } },
  saveShortLinkDefaultDomain: async (_actor, value) => {
    if (value !== 'bpo' && value !== 'eigenracing') throw new ShortLinkRequestError('Unsupported default short-link domain')
    saved = value
    saves += 1
  },
  listShortLinks: async () => [],
  createShortLink: async (actor, body) => { creates.push({ actor, body }); return { id: 'new-link', ...body } },
}
const links = loadRoute('app_src/app/api/shortlinks/route.ts', shortlinks)
const preferences = loadRoute('app_src/app/api/shortlinks/preferences/route.ts', shortlinks)
const request = (body) => ({ url: 'https://aiapp.bposupplychain.com/api/shortlinks', json: async () => body })

assert.equal((await (await links.GET(request())).json()).defaultDomain, 'bpo')
assert.equal((await links.POST(request({ destinationUrl: 'https://example.test' }))).status, 201)
assert.equal(creates.at(-1).body.publicDomain, 'bpo', 'Browser omission uses persisted effective preference')
const priorReads = reads
await links.POST(request({ destinationUrl: 'https://example.test', publicDomain: 'eigenracing' }))
assert.equal(creates.at(-1).body.publicDomain, 'eigenracing', 'Explicit per-link choice wins')
assert.equal(reads, priorReads, 'Manual choice does not load or change preference')
assert.equal(saves, 0)

assert.equal((await preferences.PUT(request({ defaultDomain: 'eigenracing' }))).status, 200)
assert.equal((await (await preferences.GET(request())).json()).defaultDomain, 'eigenracing')
assert.equal((await preferences.PUT(request({ defaultDomain: 'untrusted-host.test' }))).status, 400)
assert.equal((await preferences.PUT(request(null))).status, 400)
assert.equal((await preferences.PUT({ ...request(), json: async () => { throw new Error('bad json') } })).status, 400)
assert.equal(saved, 'eigenracing')

browserUser = { ...browserUser, organizationPermissions: { viewLinks: false } }
const beforeDenied = { reads, saves, creates: creates.length }
for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
  const response = await links[method](request({ destinationUrl: 'https://example.test', publicDomain: 'bpo' }))
  assert.equal(response.status, 403, `${method}: organization Links denial overrides the global owner role`)
  const payload = await response.json()
  assert.equal(payload.code, 'MODULE_VIEW_REQUIRED')
  assert.equal(payload.module, 'links')
}
for (const method of ['GET', 'PUT']) {
  const response = await preferences[method]({ ...request({ defaultDomain: 'bpo' }), url: 'https://aiapp.bposupplychain.com/api/shortlinks/preferences' })
  assert.equal(response.status, 403, `${method} preference: module denial is not a server failure`)
  const payload = await response.json()
  assert.equal(payload.code, 'MODULE_VIEW_REQUIRED')
  assert.equal(payload.module, 'links')
}
assert.deepEqual({ reads, saves, creates: creates.length }, beforeDenied, 'Denied browser requests perform no preference or link I/O')

currentActor = { ...currentActor, service: true }
const beforeServiceReads = reads
await links.POST(request({ destinationUrl: 'https://example.test' }))
assert.equal(creates.at(-1).body.publicDomain, undefined, 'Service omission retains internal legacy domain behavior')
assert.equal(reads, beforeServiceReads)
assert.equal((await preferences.PUT(request({ defaultDomain: 'bpo' }))).status, 403)
assert.equal((await preferences.GET(request())).status, 403)
assert.equal(saves, 1)
console.log('Short-link browser default, explicit override, persisted preference API, module denial, and service isolation passed')
