#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { decodeHtmlEntities } from '../app_src/lib/htmlEntities.mjs'
import { globalIdFragment } from '../app_src/lib/globalIds.mjs'

const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const plain = value => JSON.parse(JSON.stringify(value))
function loadModule(path, mocks = {}, extraExports = '') {
  const output = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') + extraExports, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer, TextDecoder, URL, URLSearchParams, Response, AbortSignal, module, exports: module.exports,
    process: { env: { SUITECRM_BASE_URL: 'https://crm.example.test', SUITECRM_CLIENT_ID: 'fixture-client', SUITECRM_CLIENT_SECRET: 'fixture-secret' } },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('node:')) return require(name)
      return new Proxy({}, { get: (_, method) => () => { throw new Error(`Unexpected dependency ${name}.${String(method)}`) } })
    },
  }, { filename: path })
  return module.exports
}

const headers = loadModule('app_src/lib/crm/emailAddressHeaders.ts')
const capture = entries => plain(headers.captureEmailAddressHeaders(entries))
const project = evidence => plain(headers.suiteCrmEmailAddressAttributes(evidence))
const header = (name, value) => ({ name, value })
const completeHeaders = Object.freeze([
  Object.freeze(header('From', 'ClawPilot Stewards <STEWARDS@EXAMPLE.TEST>')),
  Object.freeze(header('To', 'First Recipient <first+alias@example.test>, FIRST+ALIAS@example.test, second@example.test')),
  Object.freeze(header('Cc', 'Élodie Example <elodie@example.test>')),
  Object.freeze(header('Bcc', 'Hidden Recipient <hidden@example.test>')),
  Object.freeze(header('Delivered-To', 'delivery-only@example.test')),
  Object.freeze(header('Reply-To', 'reply-only@example.test')),
])
const completeEvidence = capture(completeHeaders)
const completeAttributes = {
  from_addr_name: 'ClawPilot Stewards <stewards@example.test>',
  to_addrs_names: 'First Recipient <first+alias@example.test>, second@example.test',
  cc_addrs_names: 'Élodie Example <elodie@example.test>',
  bcc_addrs_names: 'Hidden Recipient <hidden@example.test>',
}
assert.deepEqual(project(completeEvidence), completeAttributes)
assert.deepEqual(capture(completeHeaders), completeEvidence, 'Capture cannot mutate frozen provider headers')
assert.deepEqual(project({ version: 1 }), {}, 'Absent fields must not produce destructive blanks')

// Real address categories only: delivery aliases and other header roles are not
// evidence of the visible From/To/Cc/Bcc fields, including on legacy records.
assert.deepEqual(capture(['Sender', 'Reply-To', 'Return-Path', 'Delivered-To', 'X-Original-To', 'Resent-To'].map(name => header(name, 'not-from-or-to@example.test'))), { version: 1 })
assert.deepEqual(capture([header('From', 'first@example.test'), header('FROM', 'second@example.test')]), { version: 1 })
assert.deepEqual(capture([header('To', 'first@example.test'), header('to', 'first@example.test')]), { version: 1 })
assert.deepEqual(capture([header('From', 'first@example.test, second@example.test')]), { version: 1 })
assert.deepEqual(capture([null, 7, { name: 1, value: 'first@example.test' }, header('To', 7)]), { version: 1 })
assert.deepEqual(capture({ from: 'first@example.test' }), { version: 1 })
assert.deepEqual(project(capture([header('From', '"Alias Name" <alias@example.test>')])), { from_addr_name: 'Alias Name <alias@example.test>' })
assert.deepEqual(project(capture([header('From', '"Last, First" <alias@example.test>')])), { from_addr_name: 'alias@example.test' }, 'SuiteCRM cleanEmails splits quoted commas: preserve exact address without inventing recipients')
assert.deepEqual(project(capture([header('To', 'First <first@example.test>,\r\n\tSecond <second@example.test>')])), { to_addrs_names: 'First <first@example.test>, Second <second@example.test>' })

for (const invalid of [
  'first@example.test\r\nBcc: injected@example.test',
  'first@example.test\n injected@example.test',
  'First\u0000Name <first@example.test>', 'First\u0085Name <first@example.test>',
  'First <first@example.test', 'First <<first@example.test>>', '"First <first@example.test>',
  'Group: first@example.test;', 'first@example.test;second@example.test',
  'first@example.test, invalid', 'javascript:alert(1)', 'bad@', 'x'.repeat(8001),
  `${'x'.repeat(243)}@example.test`,
]) {
  assert.deepEqual(project(capture([header('To', invalid), header('Cc', 'valid@example.test')])), { cc_addrs_names: 'valid@example.test' }, 'Malformed category must be omitted as a whole; independent valid category remains')
}
const recipients = Array.from({ length: 51 }, (_, index) => `person${index}@example.test`)
assert.equal(capture([header('To', recipients.slice(0, 50).join(', '))]).to.length, 50)
assert.deepEqual(capture([header('To', recipients.join(', '))]), { version: 1 })
for (const invalidEvidence of [null, [], 'From: no@example.test', { version: 2, from: [{ address: 'a@example.test' }] },
  { version: 1, to: [{ address: 'valid@example.test' }, { address: 'invalid' }] },
  { version: 1, from: [{ address: 'a@example.test' }, { address: 'b@example.test' }] },
  { version: 1, to: recipients.map(address => ({ address })) },
  { version: 1, to: [null] }, { version: 1, to: [{ address: 'a@example.test\r\nBcc: x@example.test' }] },
  { sender_email: 'fallback@example.test', recipient_emails: ['delivery-only@example.test'] },
]) assert.deepEqual(project(invalidEvidence), {})
assert.deepEqual(project({ version: 1, to: [{ address: 'a@example.test', displayName: 'Injected\r\nName' }, { address: 'A@EXAMPLE.TEST' }] }), { to_addrs_names: 'a@example.test' })

const pipelineId = '11111111-1111-4111-8111-111111111111'
const recordId = '22222222-2222-4222-8222-222222222222'
const inboundId = '33333333-3333-4333-8333-333333333333'
const organizationId = '55555555-5555-4555-8555-555555555555'
const actorEmail = 'operator@example.test'
const providerId = 'synthetic-exact-message'
const threadId = 'synthetic-exact-thread'
const referenceCode = 'gi1234567'
const originalBody = '<div>Original body and PDF link <a href="https://example.test/report.pdf">Report</a></div>'
const rawMessage = {
  id: providerId, threadId, historyId: '123', internalDate: String(Date.parse('2026-09-04T12:00:00Z')), labelIds: ['INBOX'],
  payload: { mimeType: 'text/plain', headers: [...completeHeaders, header('Subject', 'Synthetic exact message')],
    body: { data: Buffer.from(originalBody).toString('base64url') },
    parts: [{ mimeType: 'message/rfc822', headers: [header('To', 'nested@example.test')] }],
  },
}
const ingestionWrites = []
const emailIdentity = loadModule('app_src/lib/crm/emailIdentity.ts')
const nativeEmail = loadModule('app_src/lib/crm/suiteCrmNativeEmailProjection.ts')
const mailboxIdentity = { version: 1, provider: 'gmail', mailboxId: '66666666-6666-4666-8666-666666666666',
  providerAccountId: 'synthetic-google-subject', accountEmail: actorEmail,
  verifiedConnectionId: 'synthetic-connection', verifiedAt: '2026-09-01T00:00:00.000Z' }
const ingestion = loadModule('app_src/lib/crm/emailIngestion.ts', {
  '@/lib/crm/emailAddressHeaders': headers,
  '@/lib/htmlEntities.mjs': { decodeHtmlEntities },
  '@/lib/globalIds.mjs': { globalIdFragment },
  '@/lib/crm/emailIdentity': emailIdentity,
  '@/lib/crm/emailReconciliation': loadModule('app_src/lib/crm/emailReconciliation.ts', { '@/lib/crm/emailIdentity': emailIdentity }),
  '@/lib/crm/caseyGmailReview': loadModule('app_src/lib/crm/caseyGmailReview.ts', { '@/lib/crm/emailIdentity': emailIdentity }),
  '@/lib/persistence/crmEmailIdentity': { recordGmailMessageIntakeInPostgres: async input => {
    ingestionWrites.push(plain(input))
    return { id: inboundId, pipelineId, inserted: true, identityStatus: 'verified' }
  } },
}, '\nexport { storeInboundMessage }\n')
const rawBefore = plain(rawMessage)
const parsed = ingestion.parseGmailMessage(rawMessage)
assert.deepEqual(plain(parsed.emailAddressHeaders), completeEvidence)
assert.equal(parsed.bodyText, originalBody, 'Header capture cannot rewrite the original body')
assert.deepEqual(rawMessage, rawBefore)
await ingestion.storeInboundMessage({ ownerEmail: actorEmail, pipelineId, message: parsed,
  mailboxIdentity, connectionId: 'synthetic-connection', observedAccountEmail: actorEmail,
  messageEvidence: emailIdentity.normalizeGmailMessageEvidence(parsed) })
const retainedMetadata = ingestionWrites[0].rawMetadata
assert.deepEqual(retainedMetadata.emailAddressHeaders, completeEvidence)
assert.equal(retainedMetadata.provider, 'gmail')
assert.equal(ingestionWrites[0].messageEvidence.bodyText, originalBody)
assert.equal(ingestionWrites[0].messageEvidence.senderEmail, parsed.senderEmail, 'Existing matching fields stay unchanged')
assert.deepEqual(ingestionWrites[0].messageEvidence.recipientEmails, plain([...parsed.recipientEmails].sort()))
assert.equal(ingestionWrites[0].mailboxIdentity.providerAccountId, mailboxIdentity.providerAccountId)

const stable = loadModule('app_src/lib/crm/stableId.ts')
async function stage({ retained = [{ email_address_headers: completeEvidence }], fieldOverrides = {},
  receiptOwner = actorEmail, sourcePipelineOwner = actorEmail, targetPipelineOwner = actorEmail,
  sourcePipelineId = pipelineId,
} = {}) {
  const calls = []
  const companyLinks = new Map()
  const baseRecord = { id: recordId, suitecrm_id: recordId, suitecrm_module: 'Emails', reference_code: referenceCode, source_payload: {}, source_hash: 'old-hash' }
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params: plain(params) })
    const result = rows => ({ rows, rowCount: rows.length })
    if (sql === 'SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE') {
      return result([{ singleton: true }])
    }
    if (sql === 'SELECT enabled FROM crm_native_email_publication_control WHERE singleton') {
      assert.equal(calls[0].sql, 'SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
      assert.deepEqual(plain(params), [])
      return result([{ enabled: false }])
    }
    if (sql.includes('FROM app_users app_user')) return result([])
    if (sql.includes('set_config(')) return result([])
    if (sql === 'SELECT user_email,access_role FROM pipeline_space_members WHERE pipeline_id=$1::uuid FOR SHARE') return result([])
    if (sql.includes('owner_user.suitecrm_user_id AS owner_native_id')) return result([{ workspace_id: organizationId, owner_native_id: 'native-owner' }])
    if (sql.includes('SELECT app_user.suitecrm_user_id')) return result([{ suitecrm_user_id: 'native-owner' }])
    if (sql.includes('SELECT contact.suitecrm_id AS contact_id')) return result([])
    if (sql.includes("metadata->'suiteCrmEmailProjection' AS receipt")) return result([])
    if (sql.includes('WITH resolved AS')) return result([params[1]
      ? { organization_id: params[1], organization_suitecrm_id: 'native-company' } : {}])
    if (sql.includes('pg_advisory_xact_lock')) return result([])
    if (sql.includes('FROM crm_interactions') && sql.includes('FOR UPDATE')) return result([baseRecord])
    if (sql.includes('INSERT INTO crm_interactions')) return result([{ ...baseRecord, source_hash: params[26], suitecrm_module: params[12] }])
    if (sql.includes('DELETE FROM crm_interaction_organizations')) {
      assert.match(sql, /pipeline_id = \$1::uuid AND interaction_id = \$2::uuid/)
      assert.match(sql, /NOT \(organization_id = ANY\(\$3::uuid\[\]\)\)/)
      assert.deepEqual(plain(params.slice(0, 2)), [pipelineId, recordId])
      assert.ok(Array.isArray(params[2]))
      for (const id of companyLinks.keys()) if (!params[2].includes(id)) companyLinks.delete(id)
      return result([])
    }
    if (sql.includes('INSERT INTO crm_interaction_organizations')) {
      assert.match(sql, /ON CONFLICT \(interaction_id, organization_id\) DO UPDATE/)
      assert.deepEqual(plain(params), [pipelineId, recordId, organizationId, true, 0, actorEmail])
      companyLinks.set(params[2], { id: params[2], isPrimary: params[3], sortOrder: params[4] })
      return result([])
    }
    if (sql.includes('DELETE FROM crm_interaction_contacts')) return result([])
    if (sql.includes('SELECT COALESCE(wo.is_demo')) return result([{ is_demo: false }])
    if (sql.includes('SET sync_status =')) return result([])
    if (sql.includes('SELECT pipeline.owner_email')) return result([{ owner_email: actorEmail, organization_id: 'organization', reference_access_disabled: false }])
    if (sql.includes('INSERT INTO short_links')) return result([{ slug: params[2] }])
    if (sql.includes('AS link_field_name')) return result([...companyLinks.values()].map(() => ({
      link_field_name: 'accounts', related_module_name: 'Accounts', related_bean_id: 'native-company',
    })))
    if (sql.includes('DELETE FROM sync_outbox')) return result([])
    if (sql.includes('INSERT INTO sync_outbox')) return result([{ idempotency_key: params[3] }])
    if (sql.includes('FROM crm_inbound_messages message')) {
      assert.match(sql, /source_pipeline\.id = message\.pipeline_id/)
      assert.match(sql, /source_pipeline\.owner_email = message\.owner_email/)
      assert.match(sql, /target_pipeline\.id = \$2::uuid/)
      assert.match(sql, /target_pipeline\.owner_email = message\.owner_email/)
      assert.match(sql, /message\.id = \$1::uuid AND message\.owner_email = \$5/)
      assert.match(sql, /message\.external_message_id = \$3/)
      assert.match(sql, /message\.external_thread_id IS NOT DISTINCT FROM \$4::text/)
      assert.match(sql, /message\.raw_metadata->>'provider' = 'gmail'/)
      assert.deepEqual(plain(params), [inboundId, pipelineId, providerId, threadId, actorEmail])
      assert.ok(sourcePipelineId)
      assert.doesNotMatch(sql, /message\.pipeline_id = \$2/, 'The default receipt pipeline can differ from the matched same-owner target pipeline')
      return result(receiptOwner === params[4] && sourcePipelineOwner === receiptOwner && targetPipelineOwner === receiptOwner ? retained : [])
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  } }
  const crm = loadModule('app_src/lib/persistence/crm.ts', {
    '@/lib/persistence/crmNativeEmailAuthority': loadModule('app_src/lib/persistence/crmNativeEmailAuthority.ts'),
    '@/lib/crm/stableId': stable,
    '@/lib/crm/emailAddressHeaders': headers,
    '@/lib/crm/suiteCrmNativeEmailProjection': nativeEmail,
    '@/lib/persistence/postgres': { withTransaction: callback => callback(client) },
    '@/lib/publicUrl': { appPublicUrl: () => 'https://app.example.test' },
    '@/lib/shortlinks': { shortLinkUrl: code => `https://example.test/s/${code}` },
    '@/lib/auditWriter': { recordAuditEvent: async () => undefined },
  })
  const input = {
    entity: 'interactions', pipelineId, localId: recordId, sourceKey: `gmail:${providerId}`, actorEmail,
    emitSuiteCrmOutbox: true, sourcePayload: { source: 'gmail-inbound', untouched: true },
    fields: { interactionType: 'email', subject: 'Synthetic exact message', description: originalBody,
      occurredAt: '2026-09-04T12:00:00.000Z',
      direction: 'inbound', deliveryStatus: 'received', providerMessageId: providerId, providerThreadId: threadId,
      metadata: { source: 'gmail-inbound', inboundMessageId: inboundId }, ...fieldOverrides },
  }
  const before = plain(input), retainedBefore = plain(retained)
  await crm.stageCrmRecordInPostgres(input)
  assert.deepEqual(input, before)
  assert.deepEqual(retained, retainedBefore)
  const outbox = calls.find(({ sql }) => sql.includes('INSERT INTO sync_outbox'))
  return { calls, companyLinks: [...companyLinks.values()], payload: JSON.parse(outbox.params[2]) }
}
const staged = await stage()
assert.deepEqual(Object.fromEntries(Object.keys(completeAttributes).map(key => [key, staged.payload.attributes[key]])), completeAttributes)
assert.equal(staged.payload.attributes.description, originalBody)
assert.equal(staged.payload.attributes.description_html, '')
assert.equal(staged.payload.attributes.global_id_c, referenceCode)
assert.equal(staged.payload.suiteCrmId, recordId)
assert.equal(staged.payload.suiteCrmModule, 'Emails')
assert.deepEqual(staged.companyLinks, [], 'Header capture must not invent a company association')
const companyStaged = await stage({ fieldOverrides: { organizationId } })
assert.deepEqual(companyStaged.companyLinks, [{ id: organizationId, isPrimary: true, sortOrder: 0 }])
assert.deepEqual(companyStaged.payload.relationships, [{ linkFieldName: 'accounts', relatedModuleName: 'Accounts', relatedBeanId: 'native-company' }])
assert.equal(companyStaged.payload.attributes.description, originalBody)
const otherOwnedPipeline = await stage({ sourcePipelineId: '44444444-4444-4444-8444-444444444444' })
assert.equal(otherOwnedPipeline.payload.attributes.from_addr_name, completeAttributes.from_addr_name)
for (const ownership of [{ receiptOwner: 'other@example.test' }, { sourcePipelineOwner: 'other@example.test' }, { targetPipelineOwner: 'other@example.test' }]) {
  const { payload } = await stage(ownership)
  for (const key of Object.keys(completeAttributes)) assert.equal(Object.hasOwn(payload.attributes, key), false, 'Cross-owner or shared-pipeline receipt selection is denied')
}
for (const retained of [[], [{ email_address_headers: null }], [{ email_address_headers: completeEvidence }, { email_address_headers: completeEvidence }],
  [{ email_address_headers: { sender_email: 'fallback@example.test', recipient_emails: ['delivery@example.test'] } }],
]) {
  const { payload } = await stage({ retained })
  for (const key of Object.keys(completeAttributes)) assert.equal(Object.hasOwn(payload.attributes, key), false)
  assert.equal(payload.attributes.description, originalBody)
}
for (const fieldOverrides of [
  { interactionType: 'note' },
  { metadata: { source: 'manual', inboundMessageId: inboundId, emailAddressHeaders: completeEvidence } },
  { metadata: { source: 'gmail-inbound', inboundMessageId: 'not-a-uuid' } },
  { providerMessageId: null },
]) {
  const { calls, payload } = await stage({ fieldOverrides })
  assert.ok(calls.every(({ sql }) => !sql.includes('FROM crm_inbound_messages message')))
  for (const key of Object.keys(completeAttributes)) assert.equal(Object.hasOwn(payload.attributes, key), false)
}
const forged = await stage({ retained: [], fieldOverrides: { metadata: { source: 'gmail-inbound', inboundMessageId: inboundId, emailAddressHeaders: completeEvidence } } })
assert.equal(Object.hasOwn(forged.payload.attributes, 'from_addr_name'), false, 'Caller metadata cannot manufacture retained provider evidence')

// Exercise the real V8 writer AND exact Email readback/audience helper. Supply a
// valid explicit transport association fixture; header capture above still must
// invent no company/contact. Missing projection proof is independently held.
const suiteCrm = loadModule('app_src/lib/crm/suiteCrmClient.ts', {
  '@/lib/crm/suiteCrmNativeEmailProjection': nativeEmail,
})
let unexpectedTransportCalls = 0
await assert.rejects(suiteCrm.upsertSuiteCrmRecordWithResult({ ...staged.payload, emailProjection: undefined }, async () => {
  unexpectedTransportCalls++; assert.fail('Missing Email projection proof must hold before transport')
}), /projection held/)
assert.equal(unexpectedTransportCalls, 0)
for (const sourceRecord of [staged.payload, forged.payload]) {
  const audience = { policy: 'pipeline-internal', ownerSuiteCrmId: 'native-owner',
    allowedSuiteCrmUserIds: ['native-owner'], workspaceId: organizationId, pipelineId, fingerprint: '' }
  audience.fingerprint = nativeEmail.suiteCrmEmailAudienceFingerprint(audience)
  const record = { ...sourceRecord, relationships: [
    { linkFieldName: 'accounts', relatedModuleName: 'Accounts', relatedBeanId: 'native-company' },
    { linkFieldName: 'contacts', relatedModuleName: 'Contacts', relatedBeanId: 'native-contact' },
  ], emailProjection: { version: 1, accounts: ['native-company'], contacts: ['native-contact'],
    contactAccounts: [{ contactId: 'native-contact', accountId: 'native-company' }],
    previousManaged: { accounts: [], contacts: [] }, audience } }
  let patches = 0
  let savedAttributes = { global_id_c: referenceCode, bcc_addrs_names: 'existing-private@example.test' }
  const linked = { accounts: new Set(), contacts: new Set() }
  const audiencePhases = []
  const fetchMock = async (url, init) => {
    if (url.endsWith('/Api/access_token')) return Response.json({ access_token: 'synthetic-test-token', expires_in: 3600 })
    const path = new URL(url).pathname
    if (path.endsWith('/Api/V8/custom/clawpilot-email-audience')) {
      assert.equal(init.method, 'POST')
      const body = JSON.parse(init.body)
      assert.ok(['before', 'after'].includes(body.phase))
      audiencePhases.push(body.phase)
      return Response.json({ version: 1, suiteCrmId: recordId, phase: body.phase,
        complete: true, noImplicitSharing: true, fingerprint: audience.fingerprint,
        capturedAt: new Date().toISOString(), readerSuiteCrmUserIds: ['native-owner'], administratorSuiteCrmUserIds: [] })
    }
    const relationship = path.match(/\/relationships\/(accounts|contacts)$/)?.[1]
    if (relationship) {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body)
        assert.equal(body.data.type, relationship === 'accounts' ? 'Accounts' : 'Contacts')
        linked[relationship].add(body.data.id)
        return Response.json({ data: body.data })
      }
      assert.equal(init.method, 'GET')
      return Response.json({ data: [...linked[relationship]].map(id => ({ id, type: relationship === 'accounts' ? 'Accounts' : 'Contacts' })) })
    }
    if (init.method === 'GET') {
      if (path.endsWith('/Api/V8/module/Emails')) return Response.json({ data: [{ id: recordId, type: 'Emails' }] })
      if (path.endsWith('/Api/V8/module/Contacts/native-contact')) return Response.json({ data: {
        id: 'native-contact', type: 'Contacts', attributes: { account_id: 'native-company' },
      } })
      assert.ok(path.endsWith(`/Api/V8/module/Emails/${recordId}`))
      return Response.json({ data: { id: recordId, type: 'Emails', attributes: savedAttributes } })
    }
    assert.equal(init.method, 'PATCH')
    assert.ok(url.endsWith('/Api/V8/module'))
    const body = JSON.parse(init.body)
    assert.equal(body.data.type, 'Emails')
    assert.equal(body.data.id, recordId)
    assert.deepEqual(body.data.attributes, record.attributes)
    savedAttributes = { ...savedAttributes, ...body.data.attributes }
    patches += 1
    return Response.json({ data: { id: recordId, type: 'Emails', attributes: savedAttributes } })
  }
  const result = await suiteCrm.upsertSuiteCrmRecordWithResult(record, fetchMock)
  assert.equal(result.suiteCrmId, recordId)
  assert.deepEqual(plain(result.emailProjection.accounts), ['native-company'])
  assert.deepEqual(plain(result.emailProjection.contacts), ['native-contact'])
  assert.deepEqual(audiencePhases, ['before', 'after'])
  if (!Object.hasOwn(record.attributes, 'bcc_addrs_names')) assert.equal(savedAttributes.bcc_addrs_names, 'existing-private@example.test', 'Unavailable header remains omitted, never blanked or replaced by metadata fallback')
  assert.equal(patches, 1)
}
console.log('CRM email header projection passed: exact categories, invalid/CRLF/limit guards, retained scope, legacy omission, body/global-ID preservation, native V8 transport')
