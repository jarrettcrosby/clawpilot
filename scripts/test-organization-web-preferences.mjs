#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const file = 'app_src/app/api/settings/organization-web/route.ts'
let actor = { email: 'admin@example.test', organizationId: 'org-a', organizationName: 'Org A', role: 'admin' }
let session = { authenticatedUser: actor.email, effectiveUser: actor.email }
let sameOrigin = true
let authorized = true
const saves = []
const preferences = { organizationId: 'org-a', appDomain: 'bpo', shortLinkDomain: 'bpo', allowUserShortLinkOverride: true, revision: 0 }
class PreferenceError extends Error { constructor(message, status = 400) { super(message); this.status = status } }
const api = { exports: {} }
const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
vm.runInNewContext(code, { module: api, exports: api.exports, Buffer, Error, console, require(specifier) {
  if (specifier === 'next/server') return { NextResponse: { json: (body, options) => Response.json(body, options) } }
  if (specifier === '@/lib/browserSameOrigin') return { isBrowserSameOriginRequest: () => sameOrigin }
  if (specifier === '@/lib/users') return { effectiveAuthorizationRole: (user) => user.role }
  if (specifier === '@/lib/requestUser') return {
    requireRequestUser: async () => { if (!authorized) throw new Error('Unauthorized'); return actor },
    requireRequestSession: async () => { if (!authorized) throw new Error('Unauthorized'); return session },
  }
  if (specifier === '@/lib/shortlinks') return { availableShortLinkDomains: () => [{ key: 'eigenracing', label: 'eigenracing.com' }] }
  if (specifier === '@/lib/organizationWebPreferences') return {
    OrganizationWebPreferenceError: PreferenceError,
    availableOrganizationAppDomains: () => [{ key: 'bpo', label: 'aiapp.bposupplychain.com', url: 'https://aiapp.bposupplychain.com' }],
    effectiveOrganizationAppDomain: () => ({ key: 'bpo', label: 'aiapp.bposupplychain.com', url: 'https://aiapp.bposupplychain.com' }),
    readOrganizationWebPreferences: async (organizationId) => { assert.equal(organizationId, actor.organizationId); return preferences },
    saveOrganizationWebPreferences: async (user, input) => {
      if (!['owner', 'admin'].includes(user.role)) throw new PreferenceError('Admin required', 403)
      if (input.revision !== 0) throw new PreferenceError('Reload settings', 409)
      saves.push({ user, input })
    },
  }
  throw new Error(`Unexpected organization API test import: ${specifier}`)
} }, { filename: file })
const request = (input = preferences, headers = {}) => ({ nextUrl: { origin: 'https://aiapp.bposupplychain.com' }, headers: new Headers({ 'content-type': 'application/json', ...headers }), text: async () => JSON.stringify(input) })
const validInput = { expectedOrganizationId: 'org-a', appDomain: 'bpo', shortLinkDomain: 'bpo', allowUserShortLinkOverride: true, revision: 0 }
assert.equal((await (await api.exports.GET(request())).json()).canEdit, true)
assert.equal((await api.exports.PUT(request(validInput))).status, 200)
assert.equal(saves[0].user.organizationId, 'org-a', 'Save target is the active session organization')
assert.equal((await api.exports.PUT(request({ ...validInput, organizationId: 'org-b' }))).status, 400, 'Cannot supply another target organization')
assert.equal((await api.exports.PUT(request({ ...validInput, expectedOrganizationId: 'org-b' }))).status, 409, 'Stale same-revision draft cannot cross organization boundary')
assert.equal((await api.exports.PUT(request({ ...validInput, revision: 2 }))).status, 409)
assert.equal((await api.exports.PUT(request(validInput, { 'content-length': '3000' }))).status, 413)
assert.equal((await api.exports.PUT(request(validInput, { 'content-type': 'text/plain' }))).status, 415)
assert.equal((await api.exports.PUT({ ...request(), text: async () => '{' })).status, 400)
sameOrigin = false
assert.equal((await api.exports.PUT(request(validInput))).status, 403)
sameOrigin = true
session = { ...session, impersonating: true }
assert.equal((await api.exports.PUT(request(validInput))).status, 403)
session = { authenticatedUser: actor.email, effectiveUser: actor.email }
actor = { ...actor, role: 'member' }
assert.equal((await (await api.exports.GET(request())).json()).canEdit, false)
assert.equal((await api.exports.PUT(request(validInput))).status, 403)
authorized = false
assert.equal((await api.exports.GET(request())).status, 401)
assert.equal((await api.exports.PUT(request(validInput))).status, 401)
assert.equal(saves.length, 1, 'Rejected requests never mutate preferences')
assert.match(readFileSync('app_src/lib/invitations.ts', 'utf8'), /organizationAppPublicUrl\(assignment\.organization\.id\)/, 'Invitation origin uses explicitly assigned organization')
assert.doesNotMatch(readFileSync('app_src/lib/publicUrl.ts', 'utf8'), /organizationWebPreferences/, 'Provider callback origin remains global and canonical')
console.log('Organization web preference API: active-org fencing, admin boundary, same-origin, impersonation, bounded JSON, conflict handling, invitation origin passed')
