#!/usr/bin/env node
// Actual route + SSO verification control flow; synthetic tokens/profiles only.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as publicOriginRouting from '../app_src/lib/publicOriginRouting.mjs'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function load(path, mocks, env = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(read(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, Error, Buffer, URL, Date,
    process: { env }, require: name => { assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency ${name}`); return mocks[name] } })
  return module.exports
}
const ownerEmail = 'owner@example.test'
const accountEmail = 'mailbox@example.test'
const workspace = '11111111-1111-4111-8111-111111111111'
const pipelineId = '22222222-2222-4222-8222-222222222222'
const connectionId = 'synthetic-selected-connection'
const clientId = 'synthetic.apps.googleusercontent.com'
const command = { pipelineId, connectionId, idToken: 'SYNTHETIC_ID_TOKEN_NOT_CREDENTIAL' }
function harness(options = {}) {
  const calls = [], profileReads = [], bindings = [], queries = [], repairReads = [], previews = [], repairs = []
  const actor = { email: ownerEmail, organizationId: workspace, ...options.actor }
  const session = options.noSession ? null : { authenticatedUser: ownerEmail, effectiveUser: ownerEmail,
    impersonating: false, activeWorkspaceOrganizationId: workspace, lastAuthenticatedAt: new Date().toISOString(), ...options.session }
  const sso = load('app_src/lib/googleSso.ts', { 'google-auth-library': { OAuth2Client: class {
    constructor(audience) { assert.equal(audience, clientId) }
    async verifyIdToken(input) {
      calls.push(['verify', input.idToken])
      assert.equal(input.audience, clientId)
      if (options.badToken) throw new Error('Synthetic signature/audience failure')
      return { getPayload: () => ({ sub: 'stable-google-subject', email: accountEmail,
        email_verified: true, name: 'Synthetic Mailbox', iat: Math.floor(Date.now() / 1000), ...options.tokenPayload }) }
    }
  } } }, { GOOGLE_SSO_SERVER_CLIENT_ID: clientId })
  const sameOrigin = load('app_src/lib/browserSameOrigin.ts', { './publicOriginRouting.mjs': publicOriginRouting })
  const route = load('app_src/app/api/crm/mailbox-identity/route.ts', {
    'next/server': { NextResponse: { json: (body, init = {}) => ({ body, ...init }) } },
    '@/lib/browserSameOrigin': sameOrigin, '@/lib/googleSso': sso,
    '@/lib/crm/emailIngestion': { readGmailMailboxProfileForOwner: async input => {
      profileReads.push(input); calls.push(['profile'])
      if (options.inactiveConnection) throw new Error('Selected connection unavailable')
      return { accountEmail: options.profileEmail || accountEmail }
    }, readGmailMailboxLabelRepairObservationForOwner: async input => {
      calls.push(['repair-profile']); repairReads.push(input)
      if (options.inactiveConnection) throw new Error('Selected connection unavailable')
      return { accountEmail: options.profileEmail || accountEmail, snapshot: { accountEmail: 'old-label@example.test' } }
    } },
    '@/lib/persistence/crmEmailIdentity': {
      bindVerifiedGmailMailboxInPostgres: async input => {
        // Model the persistence equality fence too: even a route regression
        // cannot turn a mismatched verified token/profile into a durable bind.
        if (input.identity.email !== input.observedAccountEmail) throw new Error('Profile mismatch')
        bindings.push(input); calls.push(['bind'])
        return { mailboxId: '33333333-3333-4333-8333-333333333333', accountEmail, verified: true }
      },
      readVerifiedGmailMailboxIdentityInPostgres: async () => options.knownIdentity ? { providerAccountId: 'stable-google-subject' } : null,
      prepareGmailMailboxLabelRepairPreview: input => {
        if (input.identity.email !== input.observation.accountEmail) throw new Error('Profile mismatch')
        calls.push(['preview']); previews.push(input)
        return { required: true, oldAccountEmail: 'old-label@example.test', newAccountEmail: accountEmail,
          expectedDigest: 'a'.repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() }
      },
      applyGmailMailboxLabelRepairInPostgres: async input => {
        if (input.identity.email !== input.observation.accountEmail || options.staleReview) throw new Error('Repair refused')
        calls.push(['repair']); repairs.push(input)
        return { mailboxId: '33333333-3333-4333-8333-333333333333', accountEmail, verified: true, connectionLabelUpdated: true }
      },
    },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => options.postgres !== false },
    '@/lib/persistence/postgres': { query: async (sql, values) => {
      queries.push({ sql, values }); return { rows: [{ connection_id: connectionId, account_email: options.nullSavedLabel ? null : accountEmail }] }
    } },
    '@/lib/requestUser': { requestSession: async () => session, requireRequestUser: async () => {
      if (options.inactiveActor) throw new Error('Inactive actor'); return actor
    } },
    '@/lib/tenancy': { resolvePipelineSpaceAccess: async input => {
      assert.equal(input.actorEmail, actor)
      if (options.deniedPipeline) throw new Error('Private pipeline error')
      return { id: pipelineId, ownerEmail, workspaceOrganizationId: workspace, ...options.pipeline }
    } },
    '@/lib/publicUrl': { appPublicUrl: () => 'https://app.example.test' },
    '@/lib/authSessions': { SESSION_POLICY: { recentAuthSeconds: 300 } },
  })
  const request = async (body = command, headers = {}) => {
    const req = new Request('https://app.example.test/api/crm/mailbox-identity', {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    req.nextUrl = new URL(req.url)
    return route.POST(req)
  }
  return { route, request, calls, profileReads, bindings, queries, actor, repairReads, previews, repairs }
}
let passed = 0
async function check(name, work) { await work(); passed++; console.log(`PASS ${name}`) }

await check('fresh same-origin pipeline owner verifies signed Google identity, then exact selected Gmail profile, then binds', async () => {
  const h = harness()
  const result = await h.request()
  assert.equal(result.status, 200)
  assert.equal(result.body.verified, true)
  assert.deepEqual(h.calls.map(call => call[0]), ['verify', 'profile', 'bind'])
  assert.equal(h.bindings[0].identity.subject, 'stable-google-subject')
  assert.equal(h.bindings[0].observedAccountEmail, accountEmail)
  assert.equal(h.profileReads[0].ownerEmail, ownerEmail)
  assert.equal(h.profileReads[0].connectionId, connectionId)
  assert.match(result.headers['Cache-Control'], /no-store/)
  assert.equal(JSON.stringify(result).includes(command.idToken), false)
})
await check('cross-origin, missing origin and non-JSON commands fail before identity verification', async () => {
  for (const headers of [{ origin: 'https://evil.example.test' }, { origin: '' }, { 'content-type': 'text/plain' }]) {
    const h = harness(); const result = await h.request(command, headers)
    assert.ok([403, 415].includes(result.status)); assert.equal(h.calls.length, 0)
  }
})
await check('missing, impersonated, inactive, different-workspace and nonowner sessions never reach provider or binder', async () => {
  for (const options of [{ noSession: true }, { session: { impersonating: true } },
    { session: { authenticatedUser: 'other@example.test' } }, { inactiveActor: true }, { deniedPipeline: true },
    { pipeline: { ownerEmail: 'other@example.test' } }, { actor: { organizationId: 'other-workspace' } },
    { pipeline: { id: '44444444-4444-4444-8444-444444444444' } },
    { session: { activeWorkspaceOrganizationId: 'other-workspace' } }, { postgres: false }]) {
    const h = harness(options); const result = await h.request()
    assert.notEqual(result.status, 200); assert.equal(h.calls.length, 0)
    assert.equal(JSON.stringify(result).includes('Private pipeline'), false)
  }
})
await check('recent-auth boundary rejects stale, malformed and future timestamps before token/provider access', async () => {
  for (const lastAuthenticatedAt of ['not-a-time', new Date(Date.now() - 301_000).toISOString(), new Date(Date.now() + 60_000).toISOString()]) {
    const h = harness({ session: { lastAuthenticatedAt } }); const result = await h.request()
    assert.equal(result.status, 403); assert.equal(h.calls.length, 0)
  }
})
await check('invalid signatures/audiences/unverified email/absent subject cannot bind or trigger Gmail reads', async () => {
  for (const options of [{ badToken: true }, { tokenPayload: { email_verified: false } },
    { tokenPayload: { sub: '' } }, { tokenPayload: { email: '' } }]) {
    const h = harness(options); const result = await h.request()
    assert.equal(result.status, 401); assert.equal(h.profileReads.length + h.bindings.length, 0)
  }
})
await check('a different actual Gmail profile or inactive selected connection cannot become a verified binding', async () => {
  for (const options of [{ profileEmail: 'different@example.test' }, { inactiveConnection: true }]) {
    const h = harness(options); const result = await h.request()
    assert.equal(result.status, 409); assert.equal(h.bindings.length, 0)
  }
})
await check('oversize, unknown-authority fields, malformed and missing-token commands cannot reach a binding', async () => {
  for (const body of [JSON.stringify({ ...command, idToken: 'x'.repeat(13 * 1024) }),
    { ...command, providerAccountId: 'forged-subject' }, { ...command, ownerEmail: 'other@example.test' },
    { ...command, verified: true }, { ...command, connectionId: 'bad connection' }, { ...command, pipelineId: '' },
    { ...command, pipelineId: 'default' }, { pipelineId, connectionId }, null, []]) {
    const h = harness(); const result = await h.request(body)
    assert.notEqual(result.status, 200); assert.equal(h.bindings.length, 0)
  }
})
await check('GET reports only selected owned mailbox verification state without returning subjects/tokens', async () => {
  const h = harness({ knownIdentity: true })
  const req = new Request(`https://app.example.test/api/crm/mailbox-identity?pipelineId=${pipelineId}`); req.nextUrl = new URL(req.url)
  const result = await h.route.GET(req)
  assert.equal(result.status, 200)
  assert.equal(result.body.mailboxes[0].verified, true)
  assert.match(h.queries[0].sql, /owner_email=\$1/)
  assert.match(h.queries[0].sql, /status='ACTIVE' AND is_selected/)
  assert.equal(h.queries[0].values[0], ownerEmail)
  assert.equal(h.calls.length, 0, 'Status lookup performs no Google writes or reads')
  assert.equal(JSON.stringify(result).includes('stable-google-subject'), false)
})
await check('a missing saved label remains visible and unverified so the owner can explicitly repair it', async () => {
  const h = harness({ nullSavedLabel: true, knownIdentity: true })
  const req = new Request(`https://app.example.test/api/crm/mailbox-identity?pipelineId=${pipelineId}`); req.nextUrl = new URL(req.url)
  const result = await h.route.GET(req)
  assert.equal(result.status, 200); assert.equal(result.body.mailboxes[0].accountEmail, '')
  assert.equal(result.body.mailboxes[0].verified, false); assert.equal(h.calls.length, 0)
})
await check('explicit repair preview reads fresh owner-scoped profile and returns review without binding or applying', async () => {
  const h = harness(), result = await h.request({ ...command, action: 'preview-label-repair' })
  assert.equal(result.status, 200); assert.equal(result.body.repair.required, true)
  assert.deepEqual(h.calls.map(call => call[0]), ['verify', 'repair-profile', 'preview'])
  assert.equal(h.bindings.length + h.repairs.length, 0)
  assert.equal(h.repairReads[0].ownerEmail, ownerEmail)
  assert.equal(h.repairReads[0].workspaceOrganizationId, workspace)
  assert.equal(h.repairReads[0].pipelineId, pipelineId)
  assert.equal(JSON.stringify(result).includes('stable-google-subject'), false)
  assert.equal(JSON.stringify(result).includes(command.idToken), false)
})
await check('explicit apply forwards only the anchored review to atomic DAL; ordinary binder is not used', async () => {
  const h = harness(), expiresAt = new Date(Date.now() + 299_000).toISOString()
  const result = await h.request({ ...command, action: 'apply-label-repair', expectedDigest: 'a'.repeat(64), expiresAt })
  assert.equal(result.status, 200); assert.equal(result.body.connectionLabelUpdated, true)
  assert.deepEqual(h.calls.map(call => call[0]), ['verify', 'repair-profile', 'repair'])
  assert.equal(h.bindings.length, 0); assert.equal(h.repairs[0].expiresAt, expiresAt)
  assert.equal(h.repairs[0].expectedDigest, 'a'.repeat(64))
})
await check('repair-only token freshness rejects stale, absent, fractional and future signed iat before fresh profile access', async () => {
  for (const iat of [undefined, Math.floor(Date.now() / 1000) - 301, Math.floor(Date.now() / 1000) + 60, 1.5]) {
    const h = harness({ tokenPayload: { iat } }), result = await h.request({ ...command, action: 'preview-label-repair' })
    assert.equal(result.status, 401); assert.equal(h.repairReads.length, 0)
  }
  const h = harness({ tokenPayload: { iat: undefined } })
  assert.equal((await h.request()).status, 200, 'Existing ordinary verification token contract is unchanged')
})
await check('repair command shape, inactive owner scope, fresh profile mismatch and stale CAS cannot write', async () => {
  for (const body of [{ ...command, action: 'unknown' }, { ...command, action: 'preview-label-repair', expectedDigest: 'a'.repeat(64) },
    { ...command, action: 'apply-label-repair' }, { ...command, action: 'apply-label-repair', expectedDigest: 'bad', expiresAt: 'now' },
    { ...command, action: 'preview-label-repair', providerAccountId: 'forged-subject' }]) {
    const h = harness(); assert.equal((await h.request(body)).status, 400)
    assert.equal(h.calls.length, 0)
  }
  for (const options of [{ noSession: true }, { inactiveConnection: true }, { inactiveActor: true },
    { session: { impersonating: true } }, { pipeline: { ownerEmail: 'other@example.test' } },
    { session: { lastAuthenticatedAt: new Date(Date.now() - 301_000).toISOString() } },
    { profileEmail: 'different@example.test' }]) {
    const h = harness(options), result = await h.request({ ...command, action: 'preview-label-repair' })
    assert.notEqual(result.status, 200); assert.equal(h.previews.length + h.repairs.length + h.bindings.length, 0)
  }
  const h = harness({ staleReview: true })
  assert.equal((await h.request({ ...command, action: 'apply-label-repair', expectedDigest: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 299_000).toISOString() })).status, 409)
  assert.equal(h.repairs.length + h.bindings.length, 0)
})
console.log(`${passed} mailbox identity route checks passed; synthetic verification/profile only`)
