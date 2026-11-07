#!/usr/bin/env node
// Execute actual recovery preparation/apply, staging, enqueue and audience
// declarations. SQL/storage and provider identity are synthetic: this proves
// mode propagation/CAS, not PostgreSQL locking, native ACLs or live delivery.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const copy = value => JSON.parse(JSON.stringify(value))
function declarations(path, names) {
  const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return names.map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body)
    assert.ok(node, `Actual production declaration ${name} must exist`)
    return node.getText(ast)
  }).join('\n')
}
function load(path, dependencies = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  new Function('module', 'exports', 'require', code)(module, module.exports, name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    assert.equal(name, 'node:crypto', 'No external provider/runtime dependency is available')
    return crypto
  })
  return module.exports
}
const identity = load('app_src/lib/crm/emailIdentity.ts')
const caseyPolicy = load('app_src/lib/crm/caseyGmailReview.ts', { '@/lib/crm/emailIdentity': identity })
const stable = load('app_src/lib/crm/stableId.ts')
const headers = load('app_src/lib/crm/emailAddressHeaders.ts')
const participants = load('app_src/lib/crm/participantEligibility.ts')
const projection = load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts')
const names = ['activeCrmRecordSql', 'clean', 'nullable', 'uniqueUuidList', 'isoTimestamp',
  'reviewedEmailAudienceModeUnderControlWithClient', 'reviewedEmailAudienceWithClient',
  'legacyReviewedEmailAudienceWithClient', 'reviewedEmailAudienceUnderNativeControlWithClient',
  'readReviewedGmailInteractionWithClient', 'reviewedGmailContentFingerprint',
  'prepareReviewedGmailInteractionWithClient', 'applyReviewedGmailInteractionWithClient',
  'stageReviewedGmailInteractionsInPostgres', 'stagedCrmSourceHash', 'stageCrmRecordWithClient',
  'enqueueSuiteCrmRecord', 'nativeEmailOutboxUnresolvedGuardSql']
const source = declarations('app_src/lib/persistence/crmNativeEmailAuthority.ts', ['lockCrmNativeEmailAuthorityWithClient'])
  + '\n' + declarations('app_src/lib/crm/nativeEmailEligibility.ts', ['viewCrmPermission', 'nativeEmailPrincipalIsEligible',
    'nativeEmailManualPipelinePrincipals', 'nativeEmailEffectivePipelinePrincipals'])
  + '\n' + declarations('app_src/lib/persistence/crm.ts', names)
  + '\nexports.audience = reviewedEmailAudienceWithClient;'
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pipeline = id(1), workspace = id(2), mailbox = id(3), sourceId = id(4), localId = id(5), cacheId = id(6)
const owner = 'owner@example.test', memberEmail = 'reader@example.test'
const companies = [{ id: id(10), reference_code: 'ga1234567', active: true },
  { id: id(11), reference_code: 'ga2345678', active: true }]
const contacts = [{ id: id(20), reference_code: 'gc1234567', email: 'contact@globus.example.test', organization_id: id(10), active: true },
  { id: id(21), reference_code: 'gc2345678', email: 'contact@airspace.example.test', organization_id: id(11), active: true }]
const controlSql = 'SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE'
const modeSql = 'SELECT enabled FROM crm_native_email_publication_control WHERE singleton'
const principal = (email, nativeId, extra = {}) => ({ email, suitecrm_user_id: nativeId, native_identity_count: nativeId === null ? 0 : 1,
  status: 'active', membership_status: 'active', membership_role: email === owner ? 'owner' : 'member',
  membership_permissions: { viewCrm: true }, membership_trashed_at: null, access_role: email === owner ? null : 'viewer', ...extra })
const rootReader = () => ({ pipeline_id: pipeline, workspace_id: workspace, grant_id: id(40), operator_account_id: id(41),
  email: 'root-employee@example.test', suitecrm_user_id: 'native-root', native_identity_count: 1,
  source_fingerprint: 'a'.repeat(64), registry_fingerprint: 'b'.repeat(64), allowed: true })

function harness({ enabled = true, appOnly = true } = {}) {
  const evidence = identity.normalizeGmailMessageEvidence({ externalMessageId: 'd1', externalThreadId: 'thread-d1',
    senderEmail: contacts[1].email, recipientEmails: [owner, contacts[0].email], subject: 'Reviewed customer email',
    receivedAt: '2026-10-27T12:00:00.123Z', snippet: 'Known snippet', bodyText: 'Known full body', markerReferences: [],
    emailAddressHeaders: { version: 1, from: [{ address: contacts[1].email }],
      to: [{ address: owner }, { address: contacts[0].email }], cc: [], bcc: [] } })
  const state = { enabled, readers: [principal(owner, 'native-owner'), principal(memberEmail, 'native-reader'),
    ...(appOnly ? [principal('app-only@example.test', null)] : [])], roots: [rootReader()],
    row: null, decisions: [], outbox: [], writes: [], audiences: [], queries: [], controlHeld: false }
  const cached = { id: cacheId, pipeline_id: pipeline, owner_email: owner, external_message_id: 'd1', external_thread_id: 'thread-d1',
    mailbox_id: mailbox, canonical_source_id: sourceId, sender_email: evidence.senderEmail, recipient_emails: evidence.recipientEmails,
    subject: evidence.subject, received_at: evidence.receivedAt, snippet: evidence.snippet, body_text: evidence.bodyText,
    marker_references: [], raw_metadata: { provider: 'gmail', labelIds: ['INBOX'], emailAddressHeaders: evidence.emailAddressHeaders } }
  const client = { async query(sql, params = []) {
    state.queries.push(sql)
    if (sql === controlSql) { state.controlHeld = true; return { rows: [{ singleton: true }] } }
    assert.equal(state.controlHeld, true, 'Authority/source reads occur after the transaction-entry control lock')
    if (sql === modeSql) return { rows: [{ enabled: state.enabled }] }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
    if (sql.includes('connection.connection_id, connection.account_email')) return { rows: [{ id: pipeline,
      workspace_organization_id: workspace, owner_email: owner, connection_id: 'selected-connection', account_email: owner }] }
    if (sql.includes('SELECT message.* FROM crm_inbound_messages')) return { rows: [copy(cached)] }
    if (sql.includes('lower(btrim(external_message_id))=lower($2::text) ORDER BY id LIMIT 2 FOR UPDATE')) {
      assert.deepEqual(copy(params), [owner, evidence.messageId])
      return { rows: [{ id: cacheId }] }
    }
    if (sql.includes('FROM crm_email_sources WHERE lower(btrim(provider_message_id))=lower($1::text)')) {
      assert.deepEqual(copy(params), [evidence.messageId, owner, mailbox])
      return { rows: [{ id: sourceId, mailbox_id: mailbox, owner_email: owner,
        provider_message_id: evidence.messageId, provider_thread_id: evidence.threadId, evidence_hash: identity.gmailEvidenceHash(evidence) }] }
    }
    if (sql.includes('lower(btrim(interaction.provider_message_id))=lower($3::text)')) {
      assert.deepEqual(copy(params), [owner, pipeline, evidence.messageId, sourceId])
      return { rows: [] }
    }
    if (sql.includes('lower(btrim(email)) AS email')) return { rows: copy(contacts) }
    if (sql.includes('ORDER BY pipeline.id FOR SHARE OF pipeline, membership')) return { rows: [{ id: pipeline }] }
    if (sql.startsWith('WITH participant_candidates')) return { rows: contacts.map(contact => ({ ...contact, pipeline_id: pipeline, entity: 'contacts' })) }
    if (sql.includes('FROM crm_organizations organization WHERE')) return { rows: copy(companies) }
    if (sql.includes('SELECT interaction.*, interaction.occurred_at::text')) return { rows: state.row ? [copy(state.row)] : [] }
    if (sql.includes('SELECT link.reference_code')) return { rows: [] }
    if (sql.includes('owner_user.suitecrm_user_id AS owner_native_id')) return { rows: [{ workspace_id: workspace,
      owner_email: owner, owner_native_id: 'native-owner', is_demo: false }] }
    if (sql.includes('JOIN LATERAL')) return { rows: copy(state.readers) }
    if (sql.startsWith('SELECT user_email,access_role')) return { rows: [] }
    if (sql.startsWith('SELECT app_user.suitecrm_user_id')) return { rows: state.readers.map(reader => ({ suitecrm_user_id: reader.suitecrm_user_id })) }
    if (sql.startsWith('SELECT workspace_organization_id::text AS workspace_id')) return { rows: [{ workspace_id: workspace }] }
    if (sql.startsWith('SELECT id::text, suitecrm_id, reference_code, source_hash')) return { rows: state.row ? [copy(state.row)] : [] }
    if (sql.includes('SELECT COALESCE(wo.is_demo')) return { rows: [{ is_demo: false }] }
    if (sql.includes("SELECT message.raw_metadata->'emailAddressHeaders'")) return { rows: [{ email_address_headers: evidence.emailAddressHeaders }] }
    if (sql.includes('SELECT contact.suitecrm_id AS contact_id')) return { rows: contacts.map((contact, index) => ({ contact_id: `native-contact-${index}`, account_id: `native-company-${index}` })) }
    if (sql.startsWith("SELECT metadata->'suiteCrmEmailProjection'")) return { rows: [] }
    if (sql.includes('INSERT INTO sync_outbox')) {
      state.writes.push('outbox'); state.outbox.push(JSON.parse(params[2])); return { rows: [{ idempotency_key: params[3] }] }
    }
    if (sql.startsWith('SELECT id::text,reference_code FROM crm_organizations')) return { rows: copy(companies) }
    if (sql.startsWith('SELECT id::text,revision FROM crm_email_review_decisions')) return { rows: [] }
    if (sql.startsWith('INSERT INTO crm_email_review_decisions')) {
      state.writes.push('decision'); state.decisions.push(JSON.parse(params[8])); return { rows: [] }
    }
    if (sql.startsWith('UPDATE crm_inbound_messages') || sql.startsWith('DELETE FROM crm_inbound_message_links')
      || sql.startsWith('INSERT INTO crm_inbound_message_links') || sql.startsWith('UPDATE crm_interactions SET metadata')) {
      state.writes.push(sql.split(' ').slice(0, 3).join(' ')); return { rows: [] }
    }
    throw new Error(`Unexpected synthetic SQL: ${sql}`)
  } }
  const runtime = { exports: {}, Buffer, ...identity, ...caseyPolicy, ...stable, ...headers, ...participants, ...projection,
    requireNativeEmail: (condition, code) => { if (!condition) throw new Error(code) },
    crmSourceHash: value => {
      if (value?.audience) state.audiences.push(copy(value.audience))
      return stable.crmSourceHash(value)
    },
    withTransaction: async callback => {
      state.controlHeld = false
      try { return await callback(client) } finally { state.controlHeld = false }
    },
    collectNativeEmailRootSourcesWithClient: async () => [], projectNativeEmailRootReaders: () => copy(state.roots),
    lockGmailMailboxBindingWithClient: async () => {},
    ensureGmailSourceWithClient: async () => ({ sourceId, provenance: { provider: 'gmail', originalMailboxProvenance: 'verified' } }),
    normalizeStageCrmRecordInput: async (_client, value) => value,
    REVIEWED_GMAIL_RELATIONSHIPS: Symbol('reviewed'),
    stageInteraction: async (_client, input, nativeId, hash) => {
      state.writes.push('interaction')
      state.row = { id: localId, pipeline_id: pipeline, suitecrm_id: nativeId, reference_code: 'gi1234567',
        source_key: input.sourceKey, source_hash: hash, source_payload: copy(input.sourcePayload || {}),
        suitecrm_module: 'Emails', interaction_type: 'email', organization_id: id(10), contact_id: id(20),
        organization_ids: [id(10), id(11)], contact_ids: [id(20), id(21)],
        subject: input.fields.subject, description: input.fields.description, retained_occurred_at: input.fields.occurredAt,
        provider_message_id: 'd1', provider_thread_id: 'thread-d1', metadata: copy(input.fields.metadata) }
      return state.row
    },
    interactionSuiteCrmModule: () => 'Emails',
    suiteCrmRelationships: async () => [...companies.map((company, index) => ({ linkFieldName: 'accounts', relatedModuleName: 'Accounts', relatedBeanId: `native-company-${index}` })),
      ...contacts.map((contact, index) => ({ linkFieldName: 'contacts', relatedModuleName: 'Contacts', relatedBeanId: `native-contact-${index}` }))],
    suiteCrmAttributes: () => ({ name: evidence.subject, assigned_user_id: 'native-owner' }),
    ensureCrmReferenceShortLink: async () => 'https://example.test/s/gi1234567', recordAuditEvent: async () => {},
  }
  vm.runInNewContext(compiled, runtime)
  const selection = () => ({ ownerEmail: owner, connectionId: 'selected-connection', pipelineId: pipeline,
    providerMessageId: 'd1', providerThreadId: 'thread-d1', participantEmails: contacts.map(contact => contact.email),
    mailboxIdentity: { version: 1, provider: 'gmail', mailboxId: mailbox, providerAccountId: 'verified-subject', accountEmail: owner,
      verifiedConnectionId: 'selected-connection', verifiedAt: '2026-10-27T10:00:00.000Z' }, messageEvidence: evidence,
    primaryOrganization: { id: id(10), referenceCode: 'ga1234567' },
    contactTargets: contacts.map(contact => ({ id: contact.id, referenceCode: contact.reference_code, email: contact.email, organizationId: contact.organization_id })),
    interaction: { entity: 'interactions', pipelineId: pipeline, actorEmail: owner, sourceKey: 'fixture:reviewed-d1',
      sourcePayload: { retained: true }, fields: { interactionType: 'email', subject: evidence.subject, description: evidence.bodyText,
        occurredAt: evidence.receivedAt, providerMessageId: 'd1', providerThreadId: 'thread-d1', metadata: { source: 'gmail-inbound' } } } })
  const preview = () => runtime.exports.stageReviewedGmailInteractionsInPostgres({ messages: [selection()] })
  const apply = targetFingerprint => runtime.exports.stageReviewedGmailInteractionsInPostgres({ apply: true,
    messages: [{ ...selection(), expectedExistingInteractionId: null, expectedTargetFingerprint: targetFingerprint }] })
  return { state, client, api: runtime.exports, preview, apply }
}

test('enabled reviewed preview/apply/outbox/decision use one native audience with app-only and root readers', async () => {
  const h = harness(), [preview] = await h.preview()
  assert.equal(preview.applied, false)
  assert.deepEqual(h.state.writes, [], 'Preview changes no content, membership, decision or outbox')
  const [applied] = await h.apply(preview.targetFingerprint)
  assert.equal(applied.applied, true)
  assert.equal(h.state.outbox.length, 1)
  assert.equal(h.state.decisions.length, 1)
  const audience = h.state.outbox[0].emailProjection.audience
  assert.deepEqual(audience.allowedSuiteCrmUserIds, ['native-owner', 'native-reader', 'native-root'])
  assert.deepEqual(h.state.decisions[0], audience)
  assert.ok(h.state.audiences.length >= 4)
  assert.ok(h.state.audiences.every(snapshot => JSON.stringify(snapshot) === JSON.stringify(audience)))
  assert.deepEqual(h.state.row.organization_ids, [id(10), id(11)])
  assert.deepEqual(h.state.row.contact_ids, [id(20), id(21)])
  assert.equal(h.state.queries[0], controlSql)
  assert.equal(h.state.queries[1], modeSql)
})

test('adding another explicit app-only member does not change native recovery audience or fingerprint', async () => {
  const h = harness(), [before] = await h.preview()
  h.state.readers.push(principal('second-app-only@example.test', null))
  const [after] = await h.preview()
  assert.equal(after.targetFingerprint, before.targetFingerprint)
  assert.equal((await h.apply(before.targetFingerprint))[0].applied, true)
})

test('mapped membership or inherited-root drift between preview and apply fails before the first write', async () => {
  for (const drift of [h => { h.state.readers[1].membership_permissions.viewCrm = false },
    h => { h.state.roots[0].allowed = false },
    h => { h.state.readers[1].suitecrm_user_id = 'changed-native-reader' }]) {
    const h = harness(), [preview] = await h.preview()
    drift(h)
    await assert.rejects(h.apply(preview.targetFingerprint), /evidence changed or conflicts/)
    assert.deepEqual(h.state.writes, [])
    assert.equal(h.state.row, null)
  }
})

test('enabled ambiguous app-only/native identity does not fall back to permissive legacy audience', async () => {
  const h = harness()
  h.state.readers[2].native_identity_count = 1
  await assert.rejects(h.preview(), /unambiguous active CRM readers/)
  assert.deepEqual(h.state.writes, [])
})

test('disabled reviewed mode keeps its strict legacy audience and excludes inherited native-only readers', async () => {
  const rejected = harness({ enabled: false })
  await assert.rejects(rejected.preview(), /verified native identities for all pipeline readers/)
  assert.deepEqual(rejected.state.writes, [])
  const h = harness({ enabled: false, appOnly: false }), [preview] = await h.preview()
  await h.apply(preview.targetFingerprint)
  assert.deepEqual(h.state.outbox[0].emailProjection.audience.allowedSuiteCrmUserIds, ['native-owner', 'native-reader'])
  assert.deepEqual(h.state.decisions[0], h.state.outbox[0].emailProjection.audience)
})

test('audience dispatch requires an explicit mode and never acquires control implicitly', async () => {
  const h = harness()
  for (const mode of [undefined, null, 'enabled', true]) {
    await assert.rejects(h.api.audience(h.client, pipeline, mode), /explicit held-control Email audience mode/)
  }
  assert.deepEqual(h.state.queries, [])
})
