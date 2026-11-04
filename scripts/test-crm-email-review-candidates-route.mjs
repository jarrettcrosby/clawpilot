#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const source = readFileSync('app_src/app/api/crm/email-review-candidates/route.ts', 'utf8')
const pipelineId = '00000000-0000-4000-8000-000000000002'
const workspaceId = '00000000-0000-4000-8000-000000000001'
const mailboxId = '00000000-0000-4000-8000-000000000003'
const owner = 'owner@example.test'
function harness(options = {}) {
  const queries = []
  const module = { exports: {} }
  const mocks = {
    'next/server': { NextResponse: { json: (body, init) => ({ body, ...init }) } },
    '@/lib/browserSameOrigin': { isBrowserSameOriginRequest: ({ headers }) => options.sameOrigin !== false
      && headers.get('origin') === 'https://app.example.invalid' },
    '@/lib/publicUrl': { appPublicUrl: () => 'https://app.example.invalid' },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => options.postgres !== false },
    '@/lib/requestUser': { requestSession: async () => options.noSession ? null : { authenticatedUser: owner, effectiveUser: owner,
      activeWorkspaceOrganizationId: workspaceId, ...options.session }, requireRequestUser: async () => ({ email: owner, organizationId: workspaceId, ...options.actor }) },
    '@/lib/tenancy': { resolvePipelineSpaceAccess: async () => ({ id: pipelineId, ownerEmail: owner, workspaceOrganizationId: workspaceId, ...options.pipeline }) },
    '@/lib/persistence/crmEmailIdentity': { readVerifiedGmailMailboxIdentityInPostgres: async () => options.unverified ? null : ({ mailboxId }) },
    '@/lib/persistence/postgres': { query: async (sql, values) => {
      queries.push({ sql, values })
      if (sql.includes('FROM user_maton_connections')) return { rows: options.noConnection ? [] : [{ account_email: owner }] }
      return { rows: options.rows || [{ message_id: '19abcdef01234567', thread_id: '19abcdef01234560', subject: 'Selected cached message',
        received_at: '2026-10-27T10:00:00Z', participant_emails: ['actual@example.test'],
        participant_contact_ids: ['00000000-0000-4000-8000-000000000005'], legacy: false }] }
    } },
  }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, URL, require: name => { assert.ok(name in mocks, name); return mocks[name] } })
  return { queries, async request(params = {}, extra = '', headers = { origin: 'https://app.example.invalid' }) {
    const nextUrl = new URL('https://app.example.invalid/api/crm/email-review-candidates?' + new URLSearchParams({ pipelineId, connectionId: 'selected-mailbox', ...params }) + extra)
    return module.exports.GET({ nextUrl, headers: new Headers(headers) })
  } }
}
let checks = 0
async function check(label, run) { await run(); checks++; console.log('PASS ' + label) }
await check('owner-only bounded candidate metadata uses actual headers, verified mailbox and active source membership', async () => {
  const h = harness(), response = await h.request({ participantEmail: 'actual@example.test', messageIds: '19abcdef01234567' })
  assert.equal(response.status, 200); assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0')
  const { sql, values } = h.queries[1]
  for (const fragment of ['message.owner_email=$1', 'source_pipeline.owner_email=message.owner_email', 'NOT source_pipeline.reference_access_disabled',
    "source_owner.status='active'", "source_membership.status='active'", 'source_pipeline.workspace_organization_id=$3::uuid AND message.mailbox_id=$4::uuid',
    "ARRAY['from','to','cc','bcc']", 'LIMIT 25', 'contact.pipeline_id=$2::uuid', '$5=ANY(candidate.participant_emails)']) assert.ok(sql.includes(fragment), fragment)
  assert.doesNotMatch(sql, /\bbody_text\b|\bsnippet\b|\brecipient_emails\b|Reply-To/)
  assert.equal(values[0], owner); assert.equal(values[2], workspaceId); assert.equal(values[3], mailboxId)
  assert.equal(values[4], 'actual@example.test'); assert.deepEqual(Array.from(values[5]), ['19abcdef01234567'])
  assert.equal(response.body.messages.length, 1)
  assert.deepEqual(Object.keys(response.body.messages[0]).sort(), ['legacy','messageId','participantContactIds','participantEmails','receivedAt','subject','threadId'].sort())
})
await check('cross-workspace fallback is only the exact fixed target/thread/three-message allowlist', async () => {
  const h = harness(); await h.request()
  const { sql, values } = h.queries[1]
  assert.ok(sql.includes('$2::uuid=$7::uuid AND message.external_thread_id=$8'))
  assert.ok(sql.includes('message.external_message_id=ANY($9::text[])'))
  assert.ok(sql.includes('(message.mailbox_id IS NULL OR message.mailbox_id=$4::uuid)'))
  assert.equal(values[6], '587c8746-ecf6-40ae-8c50-e456f99ad555'); assert.equal(values[7], '1a179e9e2743f926')
  assert.deepEqual(Array.from(values[8]), ['1a17e730c78d319c','1a17f5004f29592c','1a17f5d46a224e0a'])
})
const caseyScope = 'casey-reviewed-two-v1', caseyOwner = 'jarrett@suburbiasandwichco.com'
const caseyPipeline = '587c8746-ecf6-40ae-8c50-e456f99ad555', caseyConnection = 'eb13a0fd-c0b2-4ad1-99b7-3bbda178a027'
const caseyIds = ['1a18e03ea586cd7e','1a18f01749eb87a6'], caseyThread = '1a179e9e2743f926'
const caseyParams = { pipelineId: caseyPipeline, connectionId: caseyConnection, admissionScope: caseyScope }
const caseyRows = caseyIds.map(message_id => ({ message_id, thread_id: caseyThread, subject: 'Synthetic reviewed pair',
  received_at: '2026-10-27T10:00:00Z', participant_emails: ['actual@example.test'],
  participant_contact_ids: ['00000000-0000-4000-8000-000000000005'], legacy: true }))
const caseyOptions = { actor: { email: caseyOwner }, session: { authenticatedUser: caseyOwner, effectiveUser: caseyOwner },
  pipeline: { id: caseyPipeline, ownerEmail: caseyOwner }, rows: caseyRows }
await check('explicit Casey mode lists only its complete pinned pair with unknown historical identity retained on replay', async () => {
  const h = harness(caseyOptions), response = await h.request(caseyParams)
  assert.equal(response.status, 200); assert.equal(response.body.maximum, 2)
  assert.equal(response.body.admissionScope, caseyScope)
  assert.deepEqual(response.body.messages.map(message => message.messageId), caseyIds)
  assert.ok(response.body.messages.every(message => message.admissionScope === caseyScope && message.legacy === true))
  const { sql, values } = h.queries[1]
  assert.equal(values[0], caseyOwner); assert.deepEqual(Array.from(values[8]), caseyIds)
  assert.equal(values[9], '0ce9d945-0b71-495b-88ef-420ddd51fd9c')
  assert.deepEqual(Array.from(values.slice(10)), [caseyIds[0], '756e4e17-2458-470b-b00c-129c85ee821a',
    caseyIds[1], '78a5b2cc-ba50-4a71-a17c-adaf0c1041c2'])
  assert.ok(sql.includes('message.id=CASE message.external_message_id WHEN $11 THEN $12::uuid WHEN $13 THEN $14::uuid END'))
  assert.ok(sql.includes('target_pipeline.owner_email=$1 AND target_pipeline.workspace_organization_id=$3::uuid'))
  assert.ok(sql.includes('(true) AS legacy'))
  assert.ok(!sql.includes('source_pipeline.workspace_organization_id=$3::uuid AND message.mailbox_id=$4::uuid'),
    'Explicit historical pair cannot broaden into the ordinary current mailbox listing')
  assert.doesNotMatch(sql, /\bbody_text\b|\bsnippet\b/)
})
await check('Casey subsets, supersets, mixed groups, participant searches and unknown scopes are rejected before database reads', async () => {
  for (const params of [{ admissionScope: 'all-history' }, { messageIds: caseyIds[0] }, { messageIds: [...caseyIds,'1a17e730c78d319c'].join(',') },
    { messageIds: '1a17e730c78d319c,1a17f5004f29592c,1a17f5d46a224e0a' }, { participantEmail: 'actual@example.test' },
    { connectionId: 'other-mailbox' }, { pipelineId }]) {
    const h = harness(caseyOptions)
    assert.equal((await h.request({ ...caseyParams, ...params })).status, 400)
    assert.equal(h.queries.length, 0)
  }
  const wrongOwner = harness({ ...caseyOptions, actor: { email: owner },
    session: { authenticatedUser: owner, effectiveUser: owner }, pipeline: { id: caseyPipeline, ownerEmail: owner } })
  assert.equal((await wrongOwner.request(caseyParams)).status, 403); assert.equal(wrongOwner.queries.length, 0)
})
await check('missing, duplicated or different-thread Casey rows fail without returning a partial review', async () => {
  for (const rows of [[], caseyRows.slice(0, 1), [caseyRows[0],caseyRows[0]],
    [{ ...caseyRows[0], thread_id: 'another-thread' },caseyRows[1]]]) {
    const h = harness({ ...caseyOptions, rows })
    const response = await h.request(caseyParams)
    assert.equal(response.status, 409); assert.equal(response.body.messages, undefined)
  }
})
await check('normal browser GET without Origin succeeds; cross-site or foreign supplied Origin is refused', async () => {
  const h = harness()
  assert.equal((await h.request({}, '', { 'sec-fetch-site': 'same-origin' })).status, 200)
  assert.equal(h.queries.length, 2)
  for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://foreign.example.invalid', 'sec-fetch-site': 'same-site' }]) {
    const denied = harness(); assert.equal((await denied.request({}, '', headers)).status, 403); assert.equal(denied.queries.length, 0)
  }
})
for (const [label, options, status] of [
  ['cross-origin', { sameOrigin: false }, 403], ['signed out', { noSession: true }, 401],
  ['impersonation', { session: { impersonating: true } }, 403], ['effective user mismatch', { session: { effectiveUser: 'other@example.test' } }, 403],
  ['non-owner pipeline member', { pipeline: { ownerEmail: 'other@example.test' } }, 403],
  ['foreign workspace', { pipeline: { workspaceOrganizationId: 'different-workspace' } }, 403],
  ['wrong active workspace', { session: { activeWorkspaceOrganizationId: 'different-workspace' } }, 403],
]) await check(label + ' cannot query candidates', async () => {
  const h = harness(options); assert.equal((await h.request()).status, status); assert.equal(h.queries.length, 0)
})
for (const [label, options] of [['unverified mailbox', { unverified: true }], ['inactive selected connection', { noConnection: true }]]) {
  await check(label + ' cannot query cached email metadata', async () => {
    const h = harness(options); assert.equal((await h.request()).status, 409); assert.equal(h.queries.length, 1)
  })
}
await check('malformed, duplicate, oversized and unknown selections fail before queries', async () => {
  for (const params of [{ pipelineId: 'invalid' }, { connectionId: 'bad/value' }, { messageIds: '' }, { messageIds: 'aa,aa' },
    { messageIds: Array.from({ length: 26 }, (_, index) => index.toString(16)).join(',') }, { participantEmail: 'not an email' }, { expandAll: 'true' }]) {
    const h = harness(); assert.equal((await h.request(params)).status, 400); assert.equal(h.queries.length, 0)
  }
  const h = harness(); assert.equal((await h.request({}, '&pipelineId=' + pipelineId)).status, 400); assert.equal(h.queries.length, 0)
})
console.log(`Email review candidate route passed ${checks} synthetic/source checks; no live calls or database.`)
