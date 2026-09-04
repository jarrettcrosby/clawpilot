#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { decodeHtmlEntities } from '../app_src/lib/htmlEntities.mjs'
import { globalIdFragment } from '../app_src/lib/globalIds.mjs'

const require = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const testEnv = {
  CLAWPILOT_MAIL_FROM: 'platform@example.test',
  CLAWPILOT_AUTH_MAIL_FROM: 'auth@example.test',
  CLAWPILOT_AUTH_MAIL_ADDITIONAL_SENDERS: ' LEGACY-AUTH@EXAMPLE.TEST , cross-env@example.test, , not-an-email, @example.test, Display <display@example.test>, https://invalid.example.test ',
  MATON_GMAIL_CONNECTION_ID: 'platform-connection',
  MATON_AUTH_GMAIL_CONNECTION_ID: 'auth-connection',
}

function loadModule(path, mocks) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer, TextDecoder, URL, URLSearchParams, Response, AbortSignal,
    process: { env: testEnv },
    module, exports: module.exports,
    require(name) { return Object.hasOwn(mocks, name) ? mocks[name] : require(name) },
  }, { filename: path })
  return module.exports
}

// All addresses and codes below are synthetic test data; no live mailbox calls.
const template = 'ClawPilot sign-in\n\nYour sign-in code is: 123456\n\nThis code expires in 15 minutes and can be used once.\nIf you did not request this code, ignore this email.'
const htmlTemplate = '<html><body><img src="https://example.test/logo.png"><h1>ClawPilot sign-in</h1><p>Use this code to sign in:</p><p>123456</p><p>This code expires in 15 minutes and can be used once.</p><p>If you did not request this code, ignore this email.</p></body></html>'
const purpose = { name: 'X-ClawPilot-Message-Purpose', value: 'auth-magic-code' }

function message(id, { from = 'ClawPilot Stewards <stewards@eigenracing.com>', subject = 'Your ClawPilot sign-in code', body = template, mimeType = 'text/plain', headers = [] } = {}) {
  return {
    id, threadId: `thread-${id}`, internalDate: String(Date.parse('2026-09-03T12:00:00Z')),
    labelIds: ['INBOX'],
    payload: {
      mimeType,
      headers: [
        { name: 'From', value: from }, { name: 'To', value: 'operator@example.test' },
        { name: 'Subject', value: subject }, ...headers,
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  }
}

const excluded = [
  message('legacy-stewards'),
  message('legacy-html', { body: htmlTemplate, mimeType: 'text/html' }),
  message('legacy-platform', { from: 'platform@example.test' }),
  message('legacy-auth', { from: 'auth@example.test' }),
  message('legacy-case', { from: '"ClawPilot Stewards" <STEWARDS@EIGENRACING.COM>' }),
  message('marked-auth', { from: 'auth@example.test', headers: [purpose] }),
  message('marked-platform', { from: 'platform@example.test', headers: [purpose] }),
  message('legacy-additional', { from: 'legacy-auth@example.test' }),
  message('marked-cross-environment', { from: 'CROSS-ENV@EXAMPLE.TEST', headers: [purpose] }),
  // Even explicit CRM markers or a matching sender must not turn auth into CRM activity.
  message('marked-with-reference', { headers: [purpose], body: `${template}\nhttps://example.test/s/gc1234567` }),
]
const retained = [
  message('customer-discussion', { from: 'customer@example.test', subject: 'Our sign-in code problem', body: 'Please help with the sign-in code for our shipping portal.' }),
  message('customer-same-template', { from: 'customer@example.test' }),
  message('unlisted-same-domain', { from: 'other@example.test' }),
  message('invalid-allowlist-display', { from: 'display@example.test' }),
  message('listed-sender-customer-reply', { from: 'cross-env@example.test', subject: 'Re: Your ClawPilot sign-in code' }),
  message('listed-sender-other-mail', { from: 'legacy-auth@example.test', subject: 'Customer follow-up', body: 'The code issue is resolved.' }),
  message('reply', { subject: 'Re: Your ClawPilot sign-in code' }),
  message('forward', { subject: 'Fwd: Your ClawPilot sign-in code' }),
  message('quoted-template', { body: `Can you help with this?\n\n${template}` }),
  message('customer-followup', { body: `${template}\n\nThis is the message I received.` }),
  message('import-boundary', { body: `${template}\n%xx\nA separate customer discussion.` }),
  message('other-stewards-mail', { subject: 'ClawPilot project update', body: 'Your account changes are complete.' }),
  message('same-subject-different-content', { body: 'We should discuss how to improve the sign-in code flow.' }),
  message('purpose-other-subject', { headers: [purpose], subject: 'Customer discussion' }),
  message('purpose-unknown-sender', { from: 'customer@example.test', headers: [purpose] }),
  message('purpose-wrong', { headers: [{ ...purpose, value: 'customer-email' }] }),
  message('purpose-conflict', { headers: [purpose, { ...purpose, value: 'customer-email' }] }),
  message('from-duplicate', { headers: [{ name: 'From', value: 'customer@example.test' }] }),
  message('subject-duplicate', { headers: [{ name: 'Subject', value: 'Customer discussion' }] }),
  message('reply-to-not-from', { from: 'customer@example.test', headers: [{ name: 'Reply-To', value: 'stewards@eigenracing.com' }] }),
  message('display-name-not-from', { from: '"stewards@eigenracing.com" <customer@example.test>' }),
  message('multiple-from-addresses', { from: 'stewards@eigenracing.com, customer@example.test' }),
  message('lookalike-sender', { from: 'stewards@eigenracing.com.example.test' }),
  message('nested-purpose', { body: 'Customer discussion' }),
]
retained.at(-1).payload.parts = [{ mimeType: 'message/rfc822', headers: [purpose] }]

const pipelineId = '11111111-1111-4111-8111-111111111111'
const ownerEmail = 'operator@example.test'
const providerCalls = []
const storedMessageIds = []
const stagedInteractions = []
const cursorWrites = []
const matchedSenders = []
const linkedIds = []
const fixtureMessages = new Map([...excluded, ...retained].map((entry) => [entry.id, entry]))
const ingestion = loadModule('app_src/lib/crm/emailIngestion.ts', {
  '@/lib/crm/emailAddressHeaders': loadModule('app_src/lib/crm/emailAddressHeaders.ts', {}),
  '@/lib/htmlEntities.mjs': { decodeHtmlEntities },
  '@/lib/globalIds.mjs': { globalIdFragment },
  '@/lib/tenancy': { resolvePipelineSpaceAccess: async () => ({ id: pipelineId, ownerEmail }) },
  '@/lib/maton': {
    async matonFetch(path, init, scope) {
      assert.equal(init.method, 'GET', 'Ingestion must never modify Gmail')
      assert.equal(scope.ownerEmail, ownerEmail)
      assert.equal(scope.boundConnectionId, 'owned-mailbox')
      providerCalls.push(path)
      const url = new URL(path, 'https://gateway.example.test')
      if (url.pathname.endsWith('/messages')) {
        const secondPage = url.searchParams.get('pageToken') === 'page-2'
        return Response.json({
          messages: (secondPage ? retained : excluded).map((entry) => ({ id: entry.id })),
          ...(secondPage ? {} : { nextPageToken: 'page-2' }),
        })
      }
      const entry = fixtureMessages.get(url.pathname.split('/').at(-1))
      assert.ok(entry, 'Unexpected provider message request')
      return Response.json(entry)
    },
  },
  '@/lib/persistence/postgres': {
    async query(sql, values) {
      if (sql.includes('FROM app_users app_user')) return { rows: [{ owner_email: ownerEmail, connection_id: 'owned-mailbox', account_email: ownerEmail }] }
      if (sql.includes('SELECT cursor_value')) return { rows: [] }
      if (sql.includes('INSERT INTO crm_integration_cursors')) {
        cursorWrites.push(values)
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('FROM pipeline_spaces')) return { rows: [{ id: pipelineId, is_default: true }] }
      if (sql.includes('INSERT INTO crm_inbound_messages')) {
        assert.ok(retained.some((entry) => entry.id === values[2]), 'Auth email must be excluded before raw CRM persistence')
        storedMessageIds.push(values[2])
        return { rows: [{ id: `inbound-${values[2]}`, pipeline_id: pipelineId }] }
      }
      if (sql.includes('FROM crm_contacts')) {
        matchedSenders.push(values[1])
        return { rows: [{ reference_code: 'gc1234567' }] }
      }
      if (sql.includes('FROM crm_inbound_message_links')) return { rows: [] }
      if (sql.includes('UPDATE crm_inbound_messages SET')) return { rows: [], rowCount: 1 }
      if (sql.includes('INSERT INTO crm_inbound_message_links')) {
        linkedIds.push(values[0])
        return { rows: [], rowCount: 1 }
      }
      assert.fail('Unexpected persistence operation')
    },
  },
  '@/lib/persistence/crm': {
    async readCrmRecordByReference({ pipelineId: requestedPipeline }) {
      assert.equal(requestedPipeline, pipelineId)
      return { entity: 'contacts', id: 'contact-id', referenceCode: 'gc1234567', pipelineId, organizationId: 'organization-id', suiteCrmId: null }
    },
    async stageCrmRecordInPostgres(input) {
      stagedInteractions.push(input)
      return { id: `interaction-${stagedInteractions.length}` }
    },
  },
})

for (const entry of excluded) assert.equal(ingestion.isClawPilotAuthEmail(entry), true, entry.id)
for (const entry of retained) assert.equal(ingestion.isClawPilotAuthEmail(entry), false, entry.id)
const additionalSenders = testEnv.CLAWPILOT_AUTH_MAIL_ADDITIONAL_SENDERS
delete testEnv.CLAWPILOT_AUTH_MAIL_ADDITIONAL_SENDERS
assert.equal(ingestion.isClawPilotAuthEmail(message('additional-absent', { from: 'legacy-auth@example.test' })), false)
testEnv.CLAWPILOT_AUTH_MAIL_ADDITIONAL_SENDERS = 'invalid, @example.test, Display <display@example.test>'
assert.equal(ingestion.isClawPilotAuthEmail(message('invalid-list', { from: 'display@example.test' })), false)
testEnv.CLAWPILOT_AUTH_MAIL_ADDITIONAL_SENDERS = additionalSenders
// The general parser is reused by Career Desk: leave its message semantics alone.
assert.equal(ingestion.parseGmailMessage(excluded[0]).bodyText, template)

const counts = await ingestion.processInboundGmailIngestion()
assert.equal(counts.errors, 0)
assert.equal(counts.authMessagesSkipped, excluded.length)
assert.equal(counts.messagesFetched, excluded.length + retained.length)
assert.equal(counts.messagesStored, retained.length)
assert.equal(counts.interactions, retained.length)
assert.equal(counts.links, retained.length)
assert.equal(counts.mailboxesPolled, 1)
assert.equal(counts.pendingMailboxes, 0)
assert.equal(counts.markerReferences, 0, 'Auth markers must never enter target resolution')
assert.deepEqual(storedMessageIds, retained.map((entry) => entry.id))
assert.equal(matchedSenders.length, retained.length)
assert.equal(stagedInteractions.length, retained.length)
assert.equal(linkedIds.length, retained.length)
assert.equal(providerCalls.filter((path) => path.includes('pageToken=page-2')).length, 1)
assert.equal(cursorWrites.at(-1)[3], null, 'Skipped auth messages must not prevent the cursor completing')
assert.equal(cursorWrites.at(-1)[5], null)
assert.equal(JSON.stringify(counts).includes('123456'), false, 'Skipped-message counts must never expose a code')

// Verify actual producer output, including auth sent through platform fallback.
const deliveries = []
function mailFetch(profile) {
  return async (path, init) => {
    if (path.endsWith('/profile')) return Response.json({ emailAddress: `${profile}@example.test` })
    if (path.includes('/settings/sendAs/')) return Response.json({
      sendAsEmail: decodeURIComponent(path.split('/').at(-1)), verificationStatus: 'accepted',
    })
    assert.equal(path, '/google-mail/gmail/v1/users/me/messages/send')
    assert.equal(init.method, 'POST')
    const raw = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8')
    deliveries.push({ profile, raw })
    return Response.json({ id: `sent-${deliveries.length}` })
  }
}
const mail = loadModule('app_src/lib/matonMail.ts', {
  '@/lib/maton': { matonAuthMailFetch: mailFetch('auth'), matonPlatformMailFetch: mailFetch('platform') },
  '@/lib/publicUrl': { appPublicUrl: () => 'https://clawpilot.example.test' },
  '@/lib/persistence/config': { isHostedRuntime: () => false },
})
await mail.sendAuthMagicCodeEmail({ to: 'recipient@example.test', code: '123456' })
await mail.sendAuthMagicCodeEmail({ to: 'auth@example.test', code: '123456' })
assert.deepEqual(deliveries.map((delivery) => delivery.profile), ['auth', 'platform'])
for (const [index, delivery] of deliveries.entries()) {
  const topHeaders = delivery.raw.split('\r\n\r\n')[0]
  assert.match(topHeaders, /^X-ClawPilot-Message-Purpose: auth-magic-code$/m)
  assert.match(topHeaders, /^Auto-Submitted: auto-generated$/m)
  const headers = topHeaders.split('\r\n').map((line) => {
    const colon = line.indexOf(':')
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() }
  })
  const plain = delivery.raw.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n([\s\S]*?)\r\n--clawpilot-/)?.[1]
  assert.ok(plain, 'Actual auth output must retain a plain-text body')
  const generated = message(`generated-${index}`, { body: plain })
  generated.payload.headers = headers
  assert.equal(ingestion.isClawPilotAuthEmail(generated), true)
  generated.payload.headers = headers.filter((header) => header.name !== 'X-ClawPilot-Message-Purpose')
  assert.equal(ingestion.isClawPilotAuthEmail(generated), true, 'Legacy matcher must match the real producer template')
}
await mail.sendInvitationEmail({
  to: 'recipient@example.test', inviterName: 'Test Operator', organizationName: 'Test Company',
  welcomeUrl: 'https://clawpilot.example.test/welcome', expiresAt: '2026-09-04T12:00:00Z',
})
assert.doesNotMatch(deliveries.at(-1).raw.split('\r\n\r\n')[0], /X-ClawPilot-Message-Purpose|Auto-Submitted/)

console.log('CRM auth-email exclusion: producer headers, precise legacy detection, pre-storage skip and unchanged customer ingestion passed')
