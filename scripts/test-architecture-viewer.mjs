#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { architectureHarness, root } from './lib/architecture-test-harness.mjs'

const { state, metadata, viewer } = architectureHarness()
const applicationPackage = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'))
assert.equal(applicationPackage.engines.node, '>=24 <25', 'Railway must build the architecture viewer with the tested Node 24 runtime, not its former Node 20 minimum')
assert.equal(readFileSync(`${root}/.nvmrc`, 'utf8').trim(), '24', 'Local runtime selection matches hosted builds and CI')
const request = new Request('http://localhost/api/settings/architecture/viewer')
const owner = { ...state.actor }
const session = { ...state.session }
for (const route of [metadata, viewer]) {
  for (const [label, actor, activeSession, status] of [
    ['anonymous (including local auth-disabled mode)', owner, null, 401],
    ['member', { ...owner, role: 'member' }, session, 403],
    ['organization administrator', { ...owner, role: 'admin' }, session, 403],
    ['different global owner', { ...owner, email: 'other@example.test' }, session, 403],
    ['inactive owner', { ...owner, status: 'suspended' }, session, 403],
    ['impersonating owner', owner, { ...session, impersonating: true }, 403],
    ['mismatched effective identity', owner, { ...session, effectiveUser: 'member@example.test' }, 403],
  ]) {
    state.actor = actor; state.session = activeSession
    const reads = state.reads
    const response = await route.GET(request)
    assert.equal(response.status, status, label)
    assert.equal(state.reads, reads, `${label}: denied before private artifact access`)
    assert.match(response.headers.get('cache-control'), /private.*no-store/)
    assert.doesNotMatch(await response.text(), /Shopify|Postgres|model\.c4|server-assets|Sensitive/)
  }
}
state.actor = owner; state.session = session
const meta = await metadata.GET(request)
assert.equal(meta.status, 200)
assert.deepEqual((await meta.json()).views, ['index', 'runtimeData', 'commerceAccounting', 'domainsAndEnvironments'])
const response = await viewer.GET(request)
assert.equal(response.status, 200)
const html = await response.text()
assert.match(html, /likec4-root/)
assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/)
assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts(?:;|$)/)
assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-eval|allow-same-origin|https:/)
const nonce = response.headers.get('content-security-policy').match(/nonce-([^']+)/)[1]
assert.match(html, new RegExp(`<script nonce="${nonce.replace(/[+]/g, '\\+')}"`))
assert.notEqual((await viewer.GET(request)).headers.get('content-security-policy'), response.headers.get('content-security-policy'), 'Nonce is fresh per response')
state.corrupt = true
assert.equal((await viewer.GET(request)).status, 503, 'Tampered HTML fails closed')
state.corrupt = false; state.missing = true
for (const route of [metadata, viewer]) {
  const unavailable = await route.GET(request)
  assert.equal(unavailable.status, 503)
  assert.doesNotMatch(await unavailable.text(), /Sensitive|server-assets/)
}
const configuration = readFileSync(`${root}/app_src/next.config.ts`, 'utf8')
assert.match(configuration, /'\/api\/settings\/architecture\/viewer': \['\.\/server-assets\/architecture\/viewer\.html'/)
const component = readFileSync(`${root}/app_src/components/settings/ArchitecturePanel.tsx`, 'utf8')
assert.doesNotMatch(component, /from ['"].*(?:model\.c4|server-assets|likec4)/)
assert.match(component, /sandbox="allow-scripts"/)
assert.match(readFileSync(`${root}/app_src/lib/architectureViewer.ts`, 'utf8'), /isRootAppOwner\(actor\)/)
console.log('Architecture viewer: root-owner-only, impersonation denial, no local fallback, auth-before-artifact, private cache/CSP, integrity, and private tracing passed')
