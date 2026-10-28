#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { decodeHtmlEntities } from '../app_src/lib/htmlEntities.mjs'
import { globalIdFragment } from '../app_src/lib/globalIds.mjs'

// Synthetic provider messages and in-memory SQL fixtures only. These tests must
// not read credentials, connect to a hosted database, or send any email.
const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const plain = value => JSON.parse(JSON.stringify(value))
const sourcePath = 'app_src/lib/crm/emailIngestion.ts'
function loadModule(path, mocks = {}, extraExports = '') {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') + extraExports
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer, Error, TextDecoder, URL, URLSearchParams, Response, AbortSignal,
    process: { env: { CLAWPILOT_ARCHIVE_EMAIL: 'archive@example.test' } },
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('node:')) return require(name)
      return new Proxy({}, { get: (_, method) => () => { throw new Error(`Unexpected dependency ${name}.${String(method)}`) } })
    },
  }, { filename: path })
  return module.exports
}

const headers = loadModule('app_src/lib/crm/emailAddressHeaders.ts')
const participantEligibility = loadModule('app_src/lib/crm/participantEligibility.ts')
const ownerEmail = 'operator@example.test'
const mailboxEmail = 'primary@example.test'
const ownAlias = 'operator@business.example.test'
const primaryPipeline = '11111111-1111-4111-8111-111111111111'
const businessPipeline = '22222222-2222-4222-8222-222222222222'
const unrelatedPipeline = '33333333-3333-4333-8333-333333333333'
const customerOrganization = '44444444-4444-4444-8444-444444444444'
const otherOrganization = '55555555-5555-4555-8555-555555555555'
const ownedPipelines = [
  { id: primaryPipeline, is_default: true },
  { id: businessPipeline, is_default: true },
]
const header = (name, value) => ({ name, value })
const fixtureContact = (referenceCode, email, pipelineId = businessPipeline, organizationId = customerOrganization, entity = 'contacts') => ({
  id: `record-${referenceCode}`, referenceCode, email, pipelineId, organizationId, entity, suiteCrmId: null,
})
const adrian = fixtureContact('gc1234567', 'adrian@customer.example.test')
const secondContact = fixtureContact('gc2345678', 'second@customer.example.test')

function enrichmentHelper(query, stageCrmRecordWithClient) {
  const path = 'app_src/lib/persistence/crm.ts'
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const declarations = ['activeCrmRecordSql', 'nullable', 'clean', 'isoTimestamp',
    'enrichCrmEmailInteractionParticipantsInPostgres'].map(name => {
    const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement)
      && statement.name?.text === name && statement.body)
    assert.ok(declaration, `Production enrichment declaration ${name} must exist`)
    return declaration.getText(parsed).replace(/^export\s+/, '')
  }).join('\n')
  const output = ts.transpileModule(declarations, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const context = { withTransaction: callback => callback({ query }), stageCrmRecordWithClient, Error }
  vm.runInNewContext(`${output}\nglobalThis.enrich = enrichCrmEmailInteractionParticipantsInPostgres`, context)
  return context.enrich
}

function rawMessage(id = 'synthetic-message', {
  from = 'colleague@partner.example.test',
  to = `${adrian.email}, ${ownerEmail}`,
  cc = '', bcc = '', body = 'A synthetic customer discussion.',
  labels = ['INBOX'], extraHeaders = [], nestedHeaders = [],
} = {}) {
  return {
    id, threadId: `thread-${id}`, internalDate: String(Date.parse('2026-09-17T12:00:00Z')),
    labelIds: labels,
    payload: {
      mimeType: 'text/plain',
      headers: [header('From', from), header('To', to), header('Subject', 'Synthetic routing acceptance'),
        ...(cc ? [header('Cc', cc)] : []), ...(bcc ? [header('Bcc', bcc)] : []), ...extraHeaders],
      body: { data: Buffer.from(body).toString('base64url') },
      ...(nestedHeaders.length ? { parts: [{ mimeType: 'message/rfc822', headers: nestedHeaders }] } : {}),
    },
  }
}

function harness({ records = [adrian], organizations = [], providerInteractions = [], activePipelines = ownedPipelines,
  selectedMailboxes = [{ owner_email: ownerEmail, account_email: mailboxEmail, connection_id: 'fixture-connection' }],
  polledMessages = [], onAudit, beforeEnrichment, beforeReferenceRead, beforeReviewedBatch } = {}) {
  const queries = [], staged = [], providerCalls = [], audits = [], messages = new Map(), links = new Map()
  const initialProviderMessageIds = polledMessages.map(message => message.id)
  const persistedInteractions = [], enrichments = []
  const reviewedBatches = [], reviewedStages = [], reviewedInteractions = new Map()
  const result = rows => ({ rows, rowCount: rows.length })
  const enrichmentQuery = async (sql, values = []) => {
    queries.push({ sql, values: plain(values) })
    const row = [...providerInteractions, ...persistedInteractions].find(row => row.id === values[0] || row.id === values[1])
    if (sql.includes('SELECT interaction.*')) {
      await beforeEnrichment?.(row)
      assert.match(sql, /pipeline\.owner_email = \$3/)
      assert.match(sql, /membership\.user_email = pipeline\.owner_email AND membership\.status = 'active'/)
      assert.match(sql, /FOR UPDATE OF interaction FOR SHARE OF pipeline, membership, owner_user/)
      return result(row && activePipelines.some(pipeline => pipeline.id === values[1]) && row.owner_email !== 'other@example.test'
        ? [{ interaction_type: 'email', organization_id: null, contact_id: null, lead_id: null,
          source_key: `existing:${row.id}`, source_payload: {}, subject: 'Retained authored subject',
          description: 'Retained authored body', metadata: { retained: true }, direction: 'outbound',
          ...row, provider_message_id: row.provider_message_id || 'already-sent', provider_thread_id: row.provider_thread_id ?? null }] : [])
    }
    if (sql.includes('FROM crm_interaction_contacts')) return result((row?.contact_ids || []).map((contact_id, index) => ({ contact_id, is_primary: index === 0, sort_order: index })))
    if (sql.includes('FROM crm_contacts contact') || sql.includes('FROM crm_leads lead')) {
      const entity = sql.includes('FROM crm_contacts contact') ? 'contacts' : 'leads'
      return result(records.filter(record => record.pipelineId === values[0] && record.entity === entity && values[1].includes(record.id))
        .map(record => ({ id: record.id, organization_id: record.organizationId, reference_code: record.referenceCode,
          email: record.email.trim().toLowerCase(), active: !record.archived })))
    }
    if (sql.includes('FROM crm_opportunities')) return result([])
    if (sql.includes('FROM crm_organizations organization')) return result([{ id: values[1] }])
    assert.fail(`Unexpected participant enrichment SQL: ${sql}`)
  }
  const enrich = enrichmentHelper(enrichmentQuery, async (client, input, options) => {
    assert.deepEqual(plain(options), { preserveInteractionAgent: true })
    enrichments.push(plain(input))
    const row = [...providerInteractions, ...persistedInteractions].find(row => row.id === input.localId)
    Object.assign(row, { organization_id: input.fields.organizationId, contact_id: input.fields.contactId,
      contact_ids: plain(input.fields.contactIds), lead_id: input.fields.leadId })
    return { id: input.localId }
  })
  const ingestion = loadModule(sourcePath, {
    '@/lib/crm/emailAddressHeaders': headers,
    '@/lib/crm/participantEligibility': participantEligibility,
    '@/lib/htmlEntities.mjs': { decodeHtmlEntities },
    '@/lib/globalIds.mjs': { globalIdFragment },
    '@/lib/auditWriter': { recordAuditEvent: async input => {
      audits.push(plain(input))
      await onAudit?.()
    } },
    '@/lib/maton': { matonFetch: async (path, init, scope) => {
      assert.equal(init.method, 'GET', 'Mail ingestion must never modify Gmail')
      assert.equal(scope.ownerEmail, ownerEmail)
      assert.equal(scope.boundConnectionId, 'fixture-connection')
      providerCalls.push(path)
      const url = new URL(path, 'https://gateway.example.test')
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: polledMessages.map(message => ({ id: message.id })) })
      const message = polledMessages.find((candidate, index) => candidate.id === url.pathname.split('/').at(-1)
        || initialProviderMessageIds[index] === url.pathname.split('/').at(-1))
      assert.ok(message, 'Only exact fixture message IDs may be fetched')
      return Response.json(message)
    } },
    '@/lib/tenancy': { resolvePipelineSpaceAccess: async ({ actorEmail }) => {
      assert.equal(actorEmail, ownerEmail)
      return { id: primaryPipeline, ownerEmail }
    } },
    '@/lib/persistence/postgres': { query: async (sql, values = []) => {
      queries.push({ sql, values: plain(values) })
      if (sql.includes('FROM app_users app_user')) return result(selectedMailboxes)
      if (sql.includes('SELECT cursor_value')) return result([])
      if (sql.includes('INSERT INTO crm_integration_cursors')) return result([{}])
      if (sql.includes('FROM organization_communication_bindings')) {
        assert.match(sql, /credential_owner_email = \$1 AND maton_connection_id = \$2/)
        assert.match(sql, /app = 'google-mail'.*status = 'active'.*verified_at IS NOT NULL/s)
        assert.deepEqual(plain(values), [ownerEmail, 'fixture-connection'])
        return result([{ account_email: mailboxEmail, identity_email: ownAlias }])
      }
      if (sql.includes('FROM pipeline_spaces')) {
        assert.match(sql, /JOIN app_user_organization_memberships/)
        assert.match(sql, /membership\.organization_id = pipeline\.workspace_organization_id/)
        assert.match(sql, /membership\.user_email = pipeline\.owner_email/)
        assert.match(sql, /membership\.status = 'active'/)
        assert.match(sql, /pipeline\.owner_email = \$1/)
        assert.match(sql, /pipeline\.reference_access_disabled = false/)
        assert.equal(values[0], ownerEmail)
        assert.ok([primaryPipeline, businessPipeline].includes(values[1]))
        return result(activePipelines)
      }
      if (sql.includes('INSERT INTO crm_inbound_messages')) {
        const existing = messages.get(values[2])
        if (existing) return result([])
        const row = { id: `inbound-${values[2]}`, pipeline_id: values[1], owner_email: values[0] }
        messages.set(values[2], row)
        return result([row])
      }
      if (sql.includes('FROM crm_inbound_messages') && !sql.includes('UPDATE')) {
        const row = messages.get(values[1])
        return result(row && (!row.owner_email || row.owner_email === values[0]) ? [row] : [])
      }
      if (sql.includes('SELECT id::text, reference_code FROM crm_organizations')) {
        assert.equal(values[0], businessPipeline)
        assert.match(sql, /id = ANY\(\$2::uuid\[\]\)/)
        assert.match(sql, /source_payload->>'archived'/)
        return result(organizations.filter(record => record.pipelineId === values[0]
          && values[1].includes(record.id) && !record.archived)
          .map(record => ({ id: record.id, reference_code: record.referenceCode })))
      }
      if (sql.includes('FROM crm_contacts')) {
        const ids = values.find(value => Array.isArray(value) && value.every(item => /^[0-9a-f-]{36}$/i.test(item))) || []
        const addresses = values.find(value => Array.isArray(value) && value.some(item => String(item).includes('@'))) || []
        assert.ok(ids.length, 'Routing must be bounded to explicitly owned pipeline IDs')
        assert.ok(addresses.length, 'Routing must use explicit validated participant addresses')
        assert.match(sql, /ANY\(/, 'Participant lookup must remain an exact bounded query')
        const ordinary = !sql.includes('FROM crm_organizations')
        if (ordinary) assert.equal((sql.match(/source_payload->>'archived'/g) || []).length, 2, 'Both contacts and leads must exclude archived candidates before ambiguity checks')
        let candidates = records.filter(record => ids.includes(record.pipelineId) && addresses.includes(record.email.toLowerCase()) && (!ordinary || !record.archived))
        if (ordinary) {
          assert.match(sql, /FROM quickbooks_crm_links accounting_link/)
          assert.match(sql, /accounting_pipeline\.workspace_organization_id = accounting_link\.organization_id/)
          assert.match(sql, /crm_candidate\.email = candidate\.email AND NOT crm_candidate\.accounting_mirror/)
          // Actual SQL provenance checks are exercised by the PostgreSQL suite.
          candidates = candidates.filter(record => !record.accountingMirror || !candidates.some(candidate => (
            candidate.email.toLowerCase() === record.email.toLowerCase() && !candidate.accountingMirror
          )))
        }
        return result(candidates.map(record => ({ pipeline_id: record.pipelineId, reference_code: record.referenceCode, email: record.email.toLowerCase() })))
      }
      if (sql.includes('FROM crm_inbound_message_links')) {
        return result([...(links.get(values[0]) || new Map()).entries()]
          .map(([reference_code, interaction_id]) => ({ reference_code, interaction_id })))
      }
      if (sql.includes('INSERT INTO crm_inbound_message_links')) {
        const messageLinks = links.get(values[0]) || new Map()
        messageLinks.set(values[1], values[4])
        links.set(values[0], messageLinks)
        return result([{}])
      }
      if (sql.includes('UPDATE crm_inbound_messages SET')) return result([{}])
      if (sql.includes('FROM crm_interactions')) {
        assert.match(sql, /pipeline_id/, 'Existing interaction reuse must retain pipeline scope')
        assert.match(sql, /provider_message_id/, 'Existing interaction reuse needs the exact provider message')
        assert.match(sql, /provider_thread_id/, 'Existing interaction reuse must validate provider thread identity')
        assert.match(sql, /interaction_type = 'email'/)
        assert.match(sql, /LIMIT 2/, 'An ambiguous existing provider mapping must be detectable')
        assert.ok([primaryPipeline, businessPipeline].includes(values[0]))
        assert.doesNotMatch(sql.split('WHERE')[1], /provider_thread_id/, 'Do not hide a conflicting or missing thread from candidate detection')
        if (values.length === 3) {
          assert.match(sql, /source_key = \$3/)
          assert.match(values[2], /^gmail:inbound:[a-f0-9]{64}$/)
        }
        else {
          assert.equal(values.length, 2)
        }
        return result([...providerInteractions, ...persistedInteractions]
          .filter(row => (!row.pipeline_id || row.pipeline_id === values[0]) && (!row.provider_message_id || row.provider_message_id === values[1])
            && (values.length !== 3 || row.source_key === values[2]))
          .map(row => {
            row.provider_message_id ||= values[1]
            row.pipeline_id ||= values[0]
            return { ...row, provider_thread_id: row.provider_thread_id ?? null }
          }))
      }
      assert.fail(`Unexpected SQL in email routing test: ${sql}`)
    } },
    '@/lib/persistence/crm': {
      enrichCrmEmailInteractionParticipantsInPostgres: enrich,
      // Only orchestration is simulated here. The PostgreSQL suite exercises
      // production locking, target validation, and atomic multi-message staging.
      stageReviewedGmailInteractionsInPostgres: async input => {
        reviewedBatches.push(plain(input))
        await beforeReviewedBatch?.(input)
        const prepared = input.messages.map(message => {
          const key = `${message.pipelineId}:${message.providerMessageId}`
          const existing = reviewedInteractions.get(key)
          const targetFingerprint = createHash('sha256').update(JSON.stringify({
            primaryOrganization: message.primaryOrganization, contactTargets: message.contactTargets,
          })).digest('hex')
          if (input.apply) {
            assert.equal(message.expectedExistingInteractionId, existing?.interactionId || null)
            assert.equal(message.expectedTargetFingerprint, targetFingerprint)
          }
          return { message, key, existing, targetFingerprint }
        })
        return prepared.map(({ message, key, existing, targetFingerprint }) => {
          let interactionId = existing?.interactionId || null
          const applied = input.apply === true && !existing
          if (applied) {
            reviewedStages.push(plain(message.interaction))
            interactionId = `reviewed-interaction-${reviewedStages.length}`
            reviewedInteractions.set(key, { interactionId, targetFingerprint })
          }
          return { interactionId, inboundMessageId: messages.get(message.providerMessageId)?.id,
            applied, alreadyLinked: Boolean(existing), targetFingerprint }
        })
      },
      readCrmRecordByReference: async ({ pipelineId, referenceCode }) => {
        await beforeReferenceRead?.()
        const record = [...records, ...organizations].find(candidate => candidate.pipelineId === pipelineId && candidate.referenceCode === referenceCode)
        if (!record) throw new Error('CRM record not found')
        return record
      },
      stageCrmRecordInPostgres: async input => {
        staged.push(plain(input))
        const id = `interaction-${staged.length}`
        persistedInteractions.push({ id, pipeline_id: input.pipelineId, source_key: input.sourceKey,
          provider_message_id: input.fields.providerMessageId, provider_thread_id: input.fields.providerThreadId,
          organization_id: input.fields.organizationId, contact_id: input.fields.contactId || null,
          contact_ids: input.fields.contactIds || [], lead_id: input.fields.leadId || null })
        return { id }
      },
    },
  }, '\nexport { participantEmailTargets, referenceTargets, groupReferenceTargets, stageInboundInteraction, processMessage, listGmailPage, ownedPipelines, configuredMailboxAddresses }\n')
  const input = (raw = rawMessage(), overrides = {}) => ({
    ownerEmail, mailboxEmail, selfAddresses: [ownAlias],
    defaultPipelineId: primaryPipeline, ownedPipelines,
    message: ingestion.parseGmailMessage(raw), ...overrides,
  })
  return { ingestion, input, queries, staged, enrichments, providerCalls, audits, messages, links, persistedInteractions,
    reviewedBatches, reviewedStages, reviewedInteractions }
}

let passed = 0
async function check(name, work) {
  await work()
  passed += 1
  console.log(`PASS ${name}`)
}

await check('colleague to customer routes outside the primary workspace by exact To', async () => {
  const h = harness()
  const targets = await h.ingestion.participantEmailTargets(h.input())
  assert.equal(targets.length, 1)
  assert.equal(targets[0].pipelineId, businessPipeline)
  assert.equal(targets[0].record.referenceCode, adrian.referenceCode)
  assert.equal(targets[0].matchedBy, 'participant-email')
})

await check('From, Cc and Bcc exact participants are supported without body matching', async () => {
  for (const options of [
    { from: adrian.email, to: ownerEmail },
    { to: ownerEmail, cc: adrian.email },
    { to: ownerEmail, bcc: adrian.email },
  ]) {
    const h = harness()
    assert.equal((await h.ingestion.participantEmailTargets(h.input(rawMessage('category', options)))).length, 1)
  }
})

await check('body, snippet, delivery headers, Reply-To and nested headers cannot route ordinary mail', async () => {
  const h = harness()
  const raw = rawMessage('untrusted-address', {
    to: ownerEmail, body: `Quoted customer: ${adrian.email}`,
    extraHeaders: ['Delivered-To', 'Reply-To', 'X-Original-To', 'Sender'].map(name => header(name, adrian.email)),
    nestedHeaders: [header('To', adrian.email)],
  })
  raw.snippet = adrian.email
  assert.equal((await h.ingestion.participantEmailTargets(h.input(raw))).length, 0)
})

await check('invalid, duplicated or missing From cannot authorize participant routing', async () => {
  for (const options of [
    { from: 'invalid' },
    { from: `${adrian.email}, second@example.test` },
    { extraHeaders: [header('From', 'duplicate@example.test')] },
    { from: 'bad@example.test\r\nBcc: injected@example.test' },
  ]) {
    const h = harness()
    assert.equal((await h.ingestion.participantEmailTargets(h.input(rawMessage('invalid-from', options)))).length, 0)
  }
  const h = harness()
  const raw = rawMessage()
  raw.payload.headers = raw.payload.headers.filter(entry => entry.name !== 'From')
  assert.equal((await h.ingestion.participantEmailTargets(h.input(raw))).length, 0)
})

await check('self owner, mailbox, verified aliases and SENT From are excluded', async () => {
  for (const selfEmail of [ownerEmail, mailboxEmail, ownAlias, 'sent-only-alias@example.test']) {
    const h = harness({ records: [fixtureContact('gc3456789', selfEmail, primaryPipeline, otherOrganization), adrian] })
    const raw = rawMessage('self', { from: selfEmail, labels: ['SENT'] })
    const targets = await h.ingestion.participantEmailTargets(h.input(raw))
    assert.equal(targets.length, 1)
    assert.equal(targets[0].record.referenceCode, adrian.referenceCode)
  }
})

await check('unknown participants and records outside owned pipelines stay unlinked', async () => {
  const h = harness({ records: [fixtureContact(adrian.referenceCode, adrian.email, unrelatedPipeline)] })
  assert.equal((await h.ingestion.participantEmailTargets(h.input())).length, 0)
})

await check('owned pipeline scope excludes disabled access and inactive organization membership', async () => {
  const h = harness()
  assert.deepEqual(plain(await h.ingestion.ownedPipelines(ownerEmail, primaryPipeline)), ownedPipelines)
  const disabledDefault = harness({ activePipelines: [{ id: businessPipeline, is_default: true }] })
  await assert.rejects(disabledDefault.ingestion.ownedPipelines(ownerEmail, primaryPipeline), /CRM pipeline is unavailable/)
})

await check('configured self addresses require exact mailbox ownership and verified active binding', async () => {
  const h = harness()
  const addresses = await h.ingestion.configuredMailboxAddresses({ owner_email: ownerEmail, connection_id: 'fixture-connection', account_email: mailboxEmail })
  assert.deepEqual(plain(addresses), [mailboxEmail, ownAlias])
})

await check('duplicate email contacts or contact-plus-lead fail closed', async () => {
  for (const entity of ['contacts', 'leads']) {
    const h = harness({ records: [adrian, fixtureContact('gc4567890', adrian.email, businessPipeline, customerOrganization, entity)] })
    assert.equal((await h.ingestion.participantEmailTargets(h.input())).length, 0)
  }
})

await check('same-email accounting mirror cannot block a real CRM customer in another workspace', async () => {
  const mirror = { ...fixtureContact('gc4567890', adrian.email, primaryPipeline, otherOrganization), accountingMirror: true }
  for (const options of [{ from: adrian.email, to: ownerEmail }, { from: ownAlias, to: adrian.email, labels: ['SENT'] }]) {
    const h = harness({ records: [mirror, adrian] })
    const targets = await h.ingestion.participantEmailTargets(h.input(rawMessage('accounting-mirror', options)))
    assert.equal(targets.length, 1)
    assert.equal(targets[0].pipelineId, businessPipeline)
    assert.equal(targets[0].record.referenceCode, adrian.referenceCode)
  }
})

await check('standalone accounting contacts remain eligible and real CRM conflicts still fail closed', async () => {
  const mirror = { ...fixtureContact('gc4567890', adrian.email, primaryPipeline, otherOrganization), accountingMirror: true }
  const standalone = harness({ records: [mirror] })
  assert.equal((await standalone.ingestion.participantEmailTargets(standalone.input()))[0].record.referenceCode, mirror.referenceCode)
  const adopted = harness({ records: [adrian, { ...mirror, accountingMirror: false }] })
  assert.equal((await adopted.ingestion.participantEmailTargets(adopted.input())).length, 0)
  const unrelated = harness({ records: [adrian, { ...mirror, email: secondContact.email }] })
  assert.equal((await unrelated.ingestion.participantEmailTargets(unrelated.input(rawMessage('unrelated-accounting', { cc: secondContact.email })))).length, 0)
})

await check('explicit markers still resolve accounting mirrors rather than silently retargeting them', async () => {
  const mirror = { ...fixtureContact('gc4567890', adrian.email, primaryPipeline, otherOrganization), accountingMirror: true }
  const h = harness({ records: [adrian, mirror] })
  const resolved = await h.ingestion.referenceTargets(h.input(rawMessage('explicit-accounting', { body: `%gslt${mirror.referenceCode}` })))
  assert.equal(resolved.targets.length, 1)
  assert.equal(resolved.targets[0].record.referenceCode, mirror.referenceCode)
  assert.equal(resolved.targets[0].matchedBy, 'marker')
})

await check('archived candidates cannot stall ingestion or make an active customer ambiguous', async () => {
  const archived = { ...fixtureContact('gc4567890', adrian.email), archived: true }
  const h = harness({ records: [adrian, archived] })
  const targets = await h.ingestion.participantEmailTargets(h.input())
  assert.equal(targets.length, 1)
  assert.equal(targets[0].record.referenceCode, adrian.referenceCode)
  const onlyArchived = harness({ records: [archived] })
  assert.equal((await onlyArchived.ingestion.participantEmailTargets(onlyArchived.input())).length, 0)
})

await check('more than 100 matching records cannot produce a partial accidental match', async () => {
  const h = harness({ records: Array.from({ length: 101 }, (_, index) => fixtureContact(`gc${1000000 + index}`, adrian.email)) })
  assert.equal((await h.ingestion.participantEmailTargets(h.input())).length, 0)
  assert.match(h.queries.find(({ sql }) => sql.includes('FROM crm_contacts')).sql, /LIMIT 101/)
})

await check('cross-pipeline and cross-organization participant matches fail closed', async () => {
  for (const other of [
    fixtureContact('gc4567890', secondContact.email, primaryPipeline, customerOrganization),
    fixtureContact('gc4567890', secondContact.email, businessPipeline, otherOrganization),
    fixtureContact('gc4567890', secondContact.email, businessPipeline, null),
  ]) {
    const h = harness({ records: [adrian, other] })
    const targets = await h.ingestion.participantEmailTargets(h.input(rawMessage('ambiguous', { cc: secondContact.email })))
    assert.equal(targets.length, 0)
  }
})

await check('two known contacts in one organization produce one interaction and both links', async () => {
  const h = harness({ records: [adrian, secondContact] })
  const input = h.input(rawMessage('two-contacts', { cc: secondContact.email }))
  const first = await h.ingestion.processMessage(input)
  assert.equal(first.interactions, 1)
  assert.equal(first.links, 2)
  assert.equal(h.staged.length, 1)
  assert.deepEqual(new Set(h.staged[0].fields.metadata.relatedReferences), new Set([adrian.referenceCode, secondContact.referenceCode]))
  assert.deepEqual(new Set(h.staged[0].fields.contactIds), new Set([adrian.id, secondContact.id]), 'Every positively matched contact needs a native CRM activity relationship')
  const second = await h.ingestion.processMessage(input)
  assert.equal(second.inserted, false)
  assert.equal(second.interactions, 0)
  assert.equal(second.links, 0)
  assert.equal(h.staged.length, 1, 'Repeated polling must not create another CRM email')
})

await check('SENT labels stage outbound/sent and inbox labels stage inbound/received', async () => {
  for (const [labels, direction, deliveryStatus] of [
    [['SENT'], 'outbound', 'sent'], [['INBOX'], 'inbound', 'received'], [['SENT', 'INBOX'], 'outbound', 'sent'],
  ]) {
    const h = harness()
    await h.ingestion.processMessage(h.input(rawMessage(`direction-${direction}`, { from: ownAlias, labels })))
    assert.equal(h.staged.length, 1)
    assert.equal(h.staged[0].fields.direction, direction)
    assert.equal(h.staged[0].fields.deliveryStatus, deliveryStatus)
    assert.equal(h.staged[0].fields.providerMessageId, `direction-${direction}`)
  }
})

await check('exact existing provider interaction is linked without a duplicate send record', async () => {
  const h = harness({ providerInteractions: [{ id: 'existing-app-outbound-interaction', provider_thread_id: 'thread-already-sent' }] })
  const result = await h.ingestion.processMessage(h.input(rawMessage('already-sent', { from: ownAlias, labels: ['SENT'] })))
  assert.equal(result.interactions, 0)
  assert.equal(h.staged.length, 0)
  assert.equal(result.links, 1)
  assert.equal([...h.links.values()][0].get(adrian.referenceCode), 'existing-app-outbound-interaction')
})

await check('legacy exact provider-message interaction with a null thread is reused', async () => {
  const h = harness({ providerInteractions: [{ id: 'legacy-no-thread', provider_thread_id: null }] })
  const result = await h.ingestion.processMessage(h.input(rawMessage('legacy-sent', { from: ownAlias, labels: ['SENT'] })))
  assert.equal(result.interactions, 0)
  assert.equal(h.staged.length, 0)
  assert.equal([...h.links.values()][0].get(adrian.referenceCode), 'legacy-no-thread')
})

await check('late same-account participants enrich native relationships once while preserving the original email', async () => {
  const records = [adrian]
  const h = harness({ records })
  const raw = rawMessage('late-contact', { cc: secondContact.email })
  await h.ingestion.processMessage(h.input(raw))
  records.push(secondContact)
  const result = await h.ingestion.processMessage(h.input(raw))
  assert.equal(result.interactions, 0)
  assert.equal(result.links, 1)
  assert.equal(h.staged.length, 1)
  assert.equal(h.enrichments.length, 1)
  const enriched = h.enrichments[0]
  assert.deepEqual(enriched.fields.contactIds, [adrian.id, secondContact.id])
  assert.equal(enriched.localId, 'interaction-1')
  assert.equal(enriched.sourceKey, h.staged[0].sourceKey)
  assert.equal(enriched.fields.subject, 'Retained authored subject')
  assert.equal(enriched.fields.description, 'Retained authored body')
  const replay = await h.ingestion.processMessage(h.input(raw))
  assert.equal(replay.interactions, 0)
  assert.equal(replay.links, 0)
  assert.equal(h.enrichments.length, 1, 'Unchanged replay must not restage or emit projection work')
})

await check('existing account, primary contact, lead, mapping, owner and archive conflicts are rejected before caching', async () => {
  const unrelated = fixtureContact('gc8765432', 'unrelated@example.test', businessPipeline, otherOrganization)
  const unrelatedLead = fixtureContact('gl8765432', 'lead@example.test', businessPipeline, otherOrganization, 'leads')
  for (const evidence of [
    { organization_id: otherOrganization }, { contact_id: unrelated.id },
    { lead_id: unrelatedLead.id }, { contact_ids: [unrelated.id] },
    { owner_email: 'other@example.test' }, { source_payload: { archived: true } },
  ]) {
    const h = harness({ records: [adrian, unrelated, unrelatedLead],
      providerInteractions: [{ id: 'existing-conflict', provider_thread_id: null, ...evidence }] })
    await assert.rejects(h.ingestion.processMessage(h.input()), /conflicting CRM participant evidence/)
    assert.equal(h.messages.size, 0)
    assert.equal(h.links.size, 0)
    assert.equal(h.enrichments.length, 0)
    assert.equal(h.staged.length, 0)
  }
})

await check('target email changes are rechecked under the enrichment lock before any CRM write', async () => {
  const records = [{ ...adrian }]
  const h = harness({ records, providerInteractions: [{ id: 'raced-email' }], beforeEnrichment: () => {
    records[0].email = 'changed@example.test'
  } })
  await assert.rejects(h.ingestion.processMessage(h.input()), /conflicting CRM participant evidence/)
  assert.equal(h.messages.size, 0)
  assert.equal(h.enrichments.length, 0)
})

await check('candidate email proof cannot be replaced by a later record-reference read', async () => {
  const records = [{ ...adrian }]
  const h = harness({ records, beforeReferenceRead: () => { records[0].email = 'changed-before-reference-read@example.test' } })
  const result = await h.ingestion.processMessage(h.input())
  assert.equal(result.unmatched, true)
  assert.equal(h.staged.length, 0)
  assert.equal(h.links.size, 0)
})

await check('an unmatched cached message is retryable explicitly after its contact is created', async () => {
  const records = []
  const h = harness({ records })
  assert.equal((await h.ingestion.processMessage(h.input())).unmatched, true)
  records.push(adrian)
  const retried = await h.ingestion.processMessage(h.input())
  assert.equal(retried.inserted, false)
  assert.equal(retried.interactions, 1)
  assert.equal(h.messages.size, 1)
})

await check('a customer-plus-partner thread remains unlinked and cannot pass exact-message recovery preview', async () => {
  const partner = fixtureContact('gc8765432', 'partner@example.test', businessPipeline, otherOrganization)
  const raw = rawMessage('a1', { from: adrian.email, cc: partner.email })
  const h = harness({ records: [adrian, partner], polledMessages: [raw] })
  assert.equal((await h.ingestion.processMessage(h.input(raw))).unmatched, true)
  await assert.rejects(h.ingestion.reconcileGmailMessages({ ownerEmail, connectionId: 'fixture-connection',
    pipelineId: businessPipeline, messageIds: ['a1'] }), /ambiguous/)
  assert.equal(h.staged.length, 0)
  assert.equal(h.links.size, 0)
  assert.equal(h.enrichments.length, 0)
})

await check('conflicting provider thread cannot become an apparently missing interaction', async () => {
  const h = harness({ providerInteractions: [{ id: 'conflicting-thread', provider_thread_id: 'another-thread' }] })
  await assert.rejects(h.ingestion.processMessage(h.input()), /conflicting CRM thread identity/)
  assert.equal(h.staged.length, 0)
  assert.equal(h.links.size, 0)
  assert.equal(h.queries.some(({ sql }) => sql.includes('UPDATE crm_inbound_messages SET')), false)
})

await check('ambiguous existing provider-message interactions cannot be guessed or duplicated', async () => {
  const h = harness({ providerInteractions: [{ id: 'first' }, { id: 'second' }] })
  await assert.rejects(h.ingestion.processMessage(h.input()), /ambiguous CRM interactions/)
  assert.equal(h.staged.length, 0)
  assert.equal(h.links.size, 0)
})

await check('legacy completed links must match the scoped provider candidate and cannot redirect it', async () => {
  for (const providerInteractions of [
    [],
    [{ id: 'different-interaction', provider_thread_id: null }],
    [{ id: 'linked-interaction', provider_thread_id: null, pipeline_id: primaryPipeline }],
    [{ id: 'linked-interaction', provider_thread_id: null, provider_message_id: 'another-message' }],
  ]) {
    const h = harness({ providerInteractions })
    h.links.set('inbound-synthetic-message', new Map([[adrian.referenceCode, 'linked-interaction']]))
    await assert.rejects(h.ingestion.processMessage(h.input()), /conflicting existing CRM links/)
    assert.equal(h.staged.length, 0)
    assert.equal(h.links.get('inbound-synthetic-message').get(adrian.referenceCode), 'linked-interaction', 'Do not rewrite legacy conflict evidence')
    assert.equal(h.queries.some(({ sql }) => sql.includes('INSERT INTO crm_inbound_message_links') || sql.includes('UPDATE crm_inbound_messages SET')), false)
  }
})

await check('every selected legacy link is checked even when the first one matches', async () => {
  const h = harness({ records: [adrian, secondContact], providerInteractions: [{ id: 'correct-interaction', provider_thread_id: null }] })
  h.links.set('inbound-synthetic-message', new Map([
    [adrian.referenceCode, 'correct-interaction'], [secondContact.referenceCode, 'wrong-interaction'],
  ]))
  await assert.rejects(h.ingestion.processMessage(h.input(rawMessage('synthetic-message', { cc: secondContact.email }))), /conflicting existing CRM links/)
  assert.equal(h.staged.length, 0)
  assert.equal(h.links.get('inbound-synthetic-message').get(secondContact.referenceCode), 'wrong-interaction')
})

await check('matching legacy link remains idempotent after provider identity validation', async () => {
  const h = harness({ providerInteractions: [{ id: 'correct-interaction', provider_thread_id: null }] })
  h.links.set('inbound-synthetic-message', new Map([[adrian.referenceCode, 'correct-interaction']]))
  const result = await h.ingestion.processMessage(h.input())
  assert.equal(result.interactions, 0)
  assert.equal(result.links, 0)
  assert.equal(h.staged.length, 0)
})

await check('explicit markers and archive-address routing keep their distinct behavior', async () => {
  const h = harness()
  const marker = await h.ingestion.referenceTargets(h.input(rawMessage('marker', { to: ownerEmail, body: `%gslt${adrian.referenceCode}` })))
  assert.equal(marker.targets.length, 1)
  assert.equal(marker.targets[0].matchedBy, 'marker')
  const archived = await h.ingestion.referenceTargets(h.input(rawMessage('archive', {
    to: 'archive@example.test', body: `Forwarded customer address ${adrian.email}`,
  })))
  assert.equal(archived.targets.length, 1)
  assert.equal(archived.targets[0].matchedBy, 'archive-email')
  const invalidMarker = await h.ingestion.referenceTargets(h.input(rawMessage('invalid-marker', { body: '%gsltgc9999999' })))
  assert.equal(invalidMarker.targets.length, 0, 'Unknown explicit references must not fall back to ordinary participant guessing')
})

await check('multiple explicit markers and archive references retain distinct native interactions on replay', async () => {
  for (const options of [
    { body: `%gslt${adrian.referenceCode} %gslt${secondContact.referenceCode}` },
    { to: 'archive@example.test', body: `Forwarded conversation between ${adrian.email} and ${secondContact.email}` },
  ]) {
    const h = harness({ records: [adrian, secondContact] })
    const input = h.input(rawMessage('multi-reference', options))
    const first = await h.ingestion.processMessage(input)
    assert.equal(first.interactions, 2)
    assert.equal(first.links, 2)
    assert.equal(h.staged.length, 2)
    assert.deepEqual(new Set(h.staged.map(record => record.fields.contactId)), new Set([adrian.id, secondContact.id]))
    assert.equal(new Set(h.staged.map(record => record.sourceKey)).size, 2)
    assert.equal(new Set(h.links.get('inbound-multi-reference').values()).size, 2)
    const replay = await h.ingestion.processMessage(input)
    assert.equal(replay.interactions, 0)
    assert.equal(replay.links, 0)
    assert.equal(h.staged.length, 2)
  }
})

await check('Gmail list includes sent history but still excludes drafts and stays bounded', async () => {
  const h = harness()
  await h.ingestion.listGmailPage({ owner_email: ownerEmail, connection_id: 'fixture-connection', account_email: mailboxEmail }, {
    since: '2026-09-17T00:00:00Z', pollStartedAt: '2026-09-17T12:00:00Z', pageToken: 'fixture-page-token',
  })
  const url = new URL(h.providerCalls[0], 'https://gateway.example.test')
  const query = url.searchParams.get('q')
  assert.doesNotMatch(query, /-in:sent/)
  assert.match(query, /-in:drafts/)
  assert.match(query, /after:\d+/)
  assert.equal(url.searchParams.get('maxResults'), '100')
  assert.equal(url.searchParams.get('pageToken'), 'fixture-page-token')
})

await check('auth magic code is excluded before raw storage even with matching participants', async () => {
  const raw = rawMessage('synthetic-auth', {
    from: 'stewards@eigenracing.com', labels: ['SENT'],
    body: 'ClawPilot sign-in\n\nYour sign-in code is: 123456\n\nThis code expires in 15 minutes and can be used once.\nIf you did not request this code, ignore this email.',
    extraHeaders: [header('X-ClawPilot-Message-Purpose', 'auth-magic-code')],
  })
  raw.payload.headers.find(entry => entry.name === 'Subject').value = 'Your ClawPilot sign-in code'
  const h = harness({ polledMessages: [raw] })
  const counts = await h.ingestion.processInboundGmailIngestion()
  assert.equal(counts.errors, 0)
  assert.equal(counts.authMessagesSkipped, 1)
  assert.equal(counts.messagesStored, 0)
  assert.equal(counts.interactions, 0)
  assert.equal(counts.mailboxesPolled, 1)
  assert.equal(h.messages.size, 0)
  assert.equal(h.staged.length, 0)
  assert.equal(JSON.stringify(counts).includes('123456'), false)
})

const recoverySelection = overrides => ({
  ownerEmail, connectionId: 'fixture-connection', pipelineId: businessPipeline,
  messageIds: ['a1'], ...overrides,
})
const crmWriteQueries = h => h.queries.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))

await check('recovery preview reads only selected exact message IDs and leaves CRM/cursor untouched', async () => {
  const h = harness({ polledMessages: [rawMessage('a1')] })
  const preview = await h.ingestion.reconcileGmailMessages(recoverySelection())
  assert.equal(preview.applied, false)
  assert.match(preview.digest, /^[0-9a-f]{64}$/)
  assert.equal(preview.pipelineId, businessPipeline)
  assert.deepEqual(plain(preview.messages[0].targetReferences), [adrian.referenceCode])
  assert.deepEqual(h.providerCalls, ['/google-mail/gmail/v1/users/me/messages/a1?format=full'])
  assert.equal(crmWriteQueries(h).length, 0)
  assert.equal(h.audits.length, 0)
  assert.equal(h.staged.length, 0)
})

await check('recovery rejects wrong owner, connection, reviewed pipeline and unbounded selections', async () => {
  for (const override of [
    { ownerEmail: 'other@example.test' }, { connectionId: 'other-connection' },
    { pipelineId: primaryPipeline }, { pipelineId: 'not-a-uuid' },
    { messageIds: [] }, { messageIds: ['a1', 'a1'] }, { messageIds: ['not-hex'] },
    { messageIds: Array.from({ length: 26 }, (_, index) => (index + 1).toString(16)) }, { apply: 'true' },
  ]) {
    const h = harness({ polledMessages: [rawMessage('a1')] })
    await assert.rejects(h.ingestion.reconcileGmailMessages(recoverySelection(override)))
    assert.equal(crmWriteQueries(h).length, 0)
    assert.equal(h.audits.length, 0)
    assert.equal(h.staged.length, 0)
  }
})

await check('recovery never imports drafts, spam, trash, or magic codes', async () => {
  for (const label of ['DRAFT', 'SPAM', 'TRASH', 'AUTH']) {
    const raw = rawMessage('a1', { labels: [label] })
    if (label === 'AUTH') {
      raw.payload.headers.find(entry => entry.name === 'From').value = 'stewards@eigenracing.com'
      raw.payload.headers.find(entry => entry.name === 'Subject').value = 'Your ClawPilot sign-in code'
      raw.payload.headers.push(header('X-ClawPilot-Message-Purpose', 'auth-magic-code'))
    }
    const h = harness({ polledMessages: [raw] })
    await assert.rejects(h.ingestion.reconcileGmailMessages(recoverySelection()), /not eligible/)
    assert.equal(crmWriteQueries(h).length, 0)
    assert.equal(h.staged.length, 0)
  }
})

await check('recovery apply requires matching digest and rechecks provider content before writes', async () => {
  for (const change of ['missing-digest', 'bad-digest', 'body-changed', 'header-changed', 'labels-changed']) {
    const raw = rawMessage('a1')
    const h = harness({ polledMessages: [raw] })
    const preview = await h.ingestion.reconcileGmailMessages(recoverySelection())
    if (change === 'body-changed') raw.payload.body.data = Buffer.from('Changed after review.').toString('base64url')
    if (change === 'header-changed') raw.payload.headers.push(header('Cc', 'new@example.test'))
    if (change === 'labels-changed') raw.labelIds = ['SENT']
    await assert.rejects(h.ingestion.reconcileGmailMessages(recoverySelection({
      apply: true,
      expectedDigest: change === 'missing-digest' ? undefined : change === 'bad-digest' ? '0'.repeat(64) : preview.digest,
    })), /changed after preview/)
    assert.equal(crmWriteQueries(h).length, 0, change)
    assert.equal(h.staged.length, 0, change)
    assert.equal(h.audits.length, 0, change)
  }
})

await check('reviewed recovery apply is idempotent and records a content-bound audit', async () => {
  const h = harness({ polledMessages: [rawMessage('a1', { labels: ['SENT'], from: ownAlias })] })
  const preview = await h.ingestion.reconcileGmailMessages(recoverySelection())
  const apply = recoverySelection({ apply: true, expectedDigest: preview.digest })
  const first = await h.ingestion.reconcileGmailMessages(apply)
  assert.equal(first.applied, true)
  assert.equal(first.interactions, 1)
  assert.equal(first.links, 1)
  assert.equal(h.staged[0].fields.direction, 'outbound')
  assert.equal(h.audits[0].eventType, 'crm.email_recovery.requested')
  assert.equal(h.audits[0].payload.digest, preview.digest)
  assert.equal(h.audits[0].payload.providerWrites, 0)
  const second = await h.ingestion.reconcileGmailMessages(apply)
  assert.equal(second.interactions, 0)
  assert.equal(second.links, 0)
  assert.equal(h.staged.length, 1)
  assert.equal(h.messages.size, 1)
  assert.equal(h.audits[0].eventKey, h.audits[1].eventKey)
  assert.equal(h.queries.some(({ sql }) => sql.includes('INSERT INTO crm_integration_cursors')), false, 'Exact recovery must never advance or reset mailbox polling')
})

await check('reviewed recovery refuses routing drift between plan validation and write phase', async () => {
  const records = [{ ...adrian }]
  const h = harness({ records, polledMessages: [rawMessage('a1')], onAudit: () => { records[0].pipelineId = primaryPipeline } })
  const preview = await h.ingestion.reconcileGmailMessages(recoverySelection())
  await assert.rejects(h.ingestion.reconcileGmailMessages(recoverySelection({ apply: true, expectedDigest: preview.digest })), error => (
    error.name === 'SafeEmailIngestionError' && /routing|review|changed/i.test(error.message)
  ))
  assert.equal(h.staged.length, 0, 'A fresh match in another owned pipeline is not the approved recovery target')
  assert.equal(h.links.size, 0)
  assert.equal(crmWriteQueries(h).length, 0)
})

await check('recovery rechecks active pipeline membership after the review audit before any CRM write', async () => {
  const activePipelines = ownedPipelines.map(pipeline => ({ ...pipeline }))
  const h = harness({ activePipelines, polledMessages: [rawMessage('a1')], onAudit: () => {
    activePipelines.splice(activePipelines.findIndex(pipeline => pipeline.id === businessPipeline), 1)
  } })
  const preview = await h.ingestion.reconcileGmailMessages(recoverySelection())
  await assert.rejects(h.ingestion.reconcileGmailMessages(recoverySelection({ apply: true, expectedDigest: preview.digest })), /unavailable|owned|pipeline/i)
  assert.equal(h.audits.length, 1)
  assert.equal(h.staged.length, 0)
  assert.equal(h.links.size, 0)
  assert.equal(h.messages.size, 0)
  assert.equal(crmWriteQueries(h).length, 0)
})

await check('recovery preview shares null-thread reuse and conflicting-thread rejection with apply', async () => {
  const h = harness({ polledMessages: [rawMessage('a1')], providerInteractions: [{ id: 'legacy-no-thread', provider_thread_id: null }] })
  const preview = await h.ingestion.reconcileGmailMessages(recoverySelection())
  assert.equal(preview.messages[0].alreadyLinked, true)
  assert.equal(crmWriteQueries(h).length, 0)
  const applied = await h.ingestion.reconcileGmailMessages(recoverySelection({ apply: true, expectedDigest: preview.digest }))
  assert.equal(applied.interactions, 0)
  assert.equal(h.staged.length, 0)
  const conflicting = harness({ polledMessages: [rawMessage('a1')], providerInteractions: [{ id: 'wrong-thread', provider_thread_id: 'other' }] })
  await assert.rejects(conflicting.ingestion.reconcileGmailMessages(recoverySelection()), /conflicting|thread|ambiguous/i)
  assert.equal(crmWriteQueries(conflicting).length, 0)
})

await check('recovery preview and apply preserve all explicit multi-reference groups', async () => {
  const raw = rawMessage('a1', { body: `%gslt${adrian.referenceCode} %gslt${secondContact.referenceCode}` })
  const h = harness({ records: [adrian, secondContact], polledMessages: [raw] })
  const preview = await h.ingestion.reconcileGmailMessages(recoverySelection())
  assert.equal(preview.messages[0].alreadyLinked, false)
  const first = await h.ingestion.reconcileGmailMessages(recoverySelection({ apply: true, expectedDigest: preview.digest }))
  assert.equal(first.interactions, 2)
  const refreshed = await h.ingestion.reconcileGmailMessages(recoverySelection())
  assert.equal(refreshed.messages[0].alreadyLinked, true)
  const replay = await h.ingestion.reconcileGmailMessages(recoverySelection({ apply: true, expectedDigest: refreshed.digest }))
  assert.equal(replay.interactions, 0)
  assert.equal(replay.links, 0)
  assert.equal(h.staged.length, 2)
})

async function reviewedFixture(options = {}) {
  const customer = { ...adrian }
  const partner = fixtureContact('gc8765432', 'partner@example.test', businessPipeline, otherOrganization)
  const records = [customer, partner]
  const organizations = [
    { id: customerOrganization, referenceCode: 'ga1234567', pipelineId: businessPipeline, entity: 'organizations' },
    { id: otherOrganization, referenceCode: 'ga2345678', pipelineId: businessPipeline, entity: 'organizations' },
  ]
  const activePipelines = ownedPipelines.map(pipeline => ({ ...pipeline }))
  const selectedMailboxes = [{ owner_email: ownerEmail, account_email: mailboxEmail, connection_id: 'fixture-connection' }]
  const raw = rawMessage('a1', { from: customer.email, to: ownerEmail, cc: partner.email })
  raw.threadId = 'b1'
  const polledMessages = [raw]
  const h = harness({ ...options, records, organizations, activePipelines, selectedMailboxes, polledMessages })
  const held = await h.ingestion.processMessage(h.input(raw))
  assert.equal(held.unmatched, true, 'Unreviewed mixed-company intake must remain held')
  assert.equal(h.staged.length, 0)
  assert.equal(h.links.size, 0)
  assert.equal(h.messages.get('a1').pipeline_id, primaryPipeline, 'A held owner cache may precede review in another owned pipeline')
  // Exclude the known normal-intake cache write from reviewed-path assertions.
  h.queries.length = 0
  const association = { messageId: 'a1', threadId: 'b1', primaryOrganizationReference: 'ga1234567',
    contactReferences: [customer.referenceCode, partner.referenceCode] }
  const selection = overrides => recoverySelection({ reviewedAssociations: [association], ...overrides })
  return { h, raw, customer, partner, records, organizations, activePipelines, selectedMailboxes, polledMessages, association, selection }
}

await check('reviewed cross-company preview keeps one exact group and leaves held cache, activity and cursor untouched', async () => {
  const { h, customer, partner, association, selection } = await reviewedFixture()
  const before = plain([...h.messages.entries()])
  const preview = await h.ingestion.reconcileGmailMessages(selection())
  assert.equal(preview.applied, false)
  assert.match(preview.digest, /^[a-f0-9]{64}$/)
  assert.deepEqual(plain(preview.messages), [{ messageId: 'a1', threadId: 'b1', subject: 'Synthetic routing acceptance',
    receivedAt: '2026-09-17T12:00:00.000Z', direction: 'inbound', primaryOrganizationReference: 'ga1234567',
    contactReferences: association.contactReferences, organizationReferences: ['ga1234567', 'ga2345678'],
    targetReferences: ['ga1234567', 'ga2345678', customer.referenceCode, partner.referenceCode].sort(), alreadyLinked: false }])
  assert.deepEqual(plain([...h.messages.entries()]), before)
  assert.equal(crmWriteQueries(h).length, 0)
  assert.equal(h.staged.length, 0)
  assert.equal(h.reviewedStages.length, 0)
  assert.equal(h.audits.length, 0)
  assert.equal(h.reviewedBatches.length, 1)
  const batch = h.reviewedBatches[0]
  assert.equal(batch.apply, false)
  assert.equal(batch.messages.length, 1)
  const message = batch.messages[0]
  assert.deepEqual(Object.keys(message).sort(), ['ownerEmail', 'pipelineId', 'connectionId', 'providerMessageId',
    'providerThreadId', 'participantEmails', 'primaryOrganization', 'contactTargets', 'interaction'].sort())
  assert.equal(message.ownerEmail, ownerEmail)
  assert.equal(message.pipelineId, businessPipeline)
  assert.equal(message.connectionId, 'fixture-connection')
  assert.equal(message.providerMessageId, 'a1')
  assert.equal(message.providerThreadId, 'b1')
  assert.deepEqual(new Set(message.participantEmails), new Set([customer.email, partner.email]))
  assert.deepEqual(message.primaryOrganization, { id: customerOrganization, referenceCode: 'ga1234567' })
  assert.deepEqual(message.contactTargets, [customer, partner].map(record => ({ id: record.id,
    referenceCode: record.referenceCode, email: record.email, organizationId: record.organizationId })))
  assert.equal(message.interaction.fields.organizationId, customerOrganization)
  assert.deepEqual(message.interaction.fields.contactIds, [customer.id, partner.id])
  assert.equal(message.interaction.fields.description, 'A synthetic customer discussion.')
  assert.match(message.interaction.sourceKey, /^gmail:inbound:[a-f0-9]{64}$/)
  assert.deepEqual(h.providerCalls, ['/google-mail/gmail/v1/users/me/messages/a1?format=full'])
})

await check('reviewed cross-company apply stages one email and repeats idempotently with the same receipt-stable digest', async () => {
  const { h, raw, customer, partner, selection } = await reviewedFixture()
  raw.labelIds = ['SENT']
  raw.payload.headers.find(entry => entry.name === 'From').value = ownAlias
  raw.payload.headers.find(entry => entry.name === 'To').value = `${customer.email}, ${ownerEmail}`
  const preview = await h.ingestion.reconcileGmailMessages(selection())
  const apply = selection({ apply: true, expectedDigest: preview.digest })
  const first = await h.ingestion.reconcileGmailMessages(apply)
  assert.equal(first.interactions, 1)
  assert.equal(first.links, 4, 'The reviewed contacts and both verified Accounts share one activity')
  assert.equal(h.reviewedStages.length, 1)
  assert.equal(h.staged.length, 0, 'Reviewed recovery must use the locked batch helper, not generic independent staging')
  assert.equal(h.reviewedStages[0].fields.direction, 'outbound')
  assert.equal(h.reviewedStages[0].fields.deliveryStatus, 'sent')
  const ids = [...h.links.get('inbound-a1').values()]
  assert.equal(new Set(ids).size, 1)
  assert.deepEqual([...h.links.get('inbound-a1').keys()].sort(), ['ga1234567', 'ga2345678', customer.referenceCode, partner.referenceCode].sort())
  const appliedBatch = h.reviewedBatches.find(batch => batch.apply)
  assert.equal(appliedBatch.messages[0].expectedExistingInteractionId, null)
  assert.match(appliedBatch.messages[0].expectedTargetFingerprint, /^[a-f0-9]{64}$/)
  const refreshed = await h.ingestion.reconcileGmailMessages(selection())
  assert.equal(refreshed.digest, preview.digest, 'Creation of the reviewed receipt must not invalidate an otherwise unchanged approval')
  assert.equal(refreshed.messages[0].alreadyLinked, true)
  const second = await h.ingestion.reconcileGmailMessages(apply)
  assert.equal(second.interactions, 0)
  assert.equal(second.links, 0)
  assert.equal(h.reviewedStages.length, 1)
  assert.equal(h.reviewedInteractions.size, 1)
  assert.equal(h.messages.size, 1)
  assert.equal(h.audits.length, 2)
  assert.equal(h.audits[0].eventKey, h.audits[1].eventKey)
  assert.deepEqual(h.audits[0].payload.reviewedAssociations, plain(selection().reviewedAssociations))
  assert.equal(h.audits[0].payload.providerWrites, 0)
  assert.equal(h.queries.some(({ sql }) => sql.includes('INSERT INTO crm_integration_cursors')
    || sql.includes('INSERT INTO crm_inbound_messages')), false, 'Review cannot reset polling or create a new receipt cache')
})

await check('reviewed primary Account must be represented by a selected current participant', async () => {
  for (const change of ['primary-not-selected', 'unknown-primary', 'wrong-primary-entity']) {
    const fixture = await reviewedFixture()
    if (change === 'primary-not-selected') fixture.association.contactReferences = [fixture.partner.referenceCode]
    if (change === 'unknown-primary') fixture.association.primaryOrganizationReference = 'ga9999999'
    if (change === 'wrong-primary-entity') fixture.organizations[0].entity = 'contacts'
    await assert.rejects(fixture.h.ingestion.reconcileGmailMessages(fixture.selection()), /unambiguous current participants/)
    assert.equal(fixture.h.reviewedBatches.length, 0, change)
    assert.equal(crmWriteQueries(fixture.h).length, 0, change)
  }
})

await check('reviewed Contact selection needs actual top-level participants, never body, Reply-To, delivery or nested headers', async () => {
  for (const evidence of ['body', 'reply-to', 'delivery', 'nested']) {
    const fixture = await reviewedFixture()
    fixture.raw.payload.headers = fixture.raw.payload.headers.filter(entry => entry.name !== 'Cc')
    if (evidence === 'body') fixture.raw.payload.body.data = Buffer.from(`Quoted customer ${fixture.partner.email}`).toString('base64url')
    if (evidence === 'reply-to') fixture.raw.payload.headers.push(header('Reply-To', fixture.partner.email))
    if (evidence === 'delivery') fixture.raw.payload.headers.push(header('Delivered-To', fixture.partner.email))
    if (evidence === 'nested') fixture.raw.payload.parts = [{ mimeType: 'message/rfc822', headers: [header('From', fixture.partner.email)] }]
    await assert.rejects(fixture.h.ingestion.reconcileGmailMessages(fixture.selection()), /unambiguous current participants/)
    assert.equal(fixture.h.reviewedStages.length, 0, evidence)
    assert.equal(crmWriteQueries(fixture.h).length, 0, evidence)
  }
})

await check('reviewed recovery accepts actual From, To, Cc and Bcc participants without widening the selected Contact set', async () => {
  for (const field of ['From', 'To', 'Cc', 'Bcc']) {
    const fixture = await reviewedFixture()
    fixture.raw.payload.headers = [header('From', fixture.customer.email), header('To', ownerEmail), header('Subject', 'Exact reviewed participants')]
    if (field === 'From') {
      fixture.raw.payload.headers[0].value = fixture.partner.email
      fixture.raw.payload.headers[1].value = `${fixture.customer.email}, ${ownerEmail}`
    } else if (field === 'To') fixture.raw.payload.headers[1].value = `${fixture.partner.email}, ${ownerEmail}`
    else fixture.raw.payload.headers.push(header(field, fixture.partner.email))
    const preview = await fixture.h.ingestion.reconcileGmailMessages(fixture.selection())
    assert.deepEqual(plain(preview.messages[0].contactReferences), fixture.association.contactReferences, field)
    assert.equal(fixture.h.reviewedBatches[0].messages.length, 1)
    assert.equal(crmWriteQueries(fixture.h).length, 0)
  }
})

await check('review cannot override duplicate email, unknown, foreign-pipeline, archived or lead-only participant evidence', async () => {
  for (const change of ['duplicate-contact', 'contact-plus-lead', 'unknown', 'foreign-owned', 'foreign-unowned', 'archived-contact', 'archived-account', 'lead-only']) {
    const fixture = await reviewedFixture()
    if (change === 'duplicate-contact' || change === 'contact-plus-lead') fixture.records.push(fixtureContact('gc3456789', fixture.partner.email,
      businessPipeline, otherOrganization, change === 'contact-plus-lead' ? 'leads' : 'contacts'))
    if (change === 'unknown') fixture.association.contactReferences = [fixture.customer.referenceCode, 'gc9999999']
    if (change === 'foreign-owned') fixture.partner.pipelineId = primaryPipeline
    if (change === 'foreign-unowned') fixture.partner.pipelineId = unrelatedPipeline
    if (change === 'archived-contact') fixture.partner.archived = true
    if (change === 'archived-account') fixture.organizations[1].archived = true
    if (change === 'lead-only') fixture.partner.entity = 'leads'
    await assert.rejects(fixture.h.ingestion.reconcileGmailMessages(fixture.selection()), /unambiguous current participants/)
    assert.equal(fixture.h.reviewedStages.length, 0, change)
    assert.equal(crmWriteQueries(fixture.h).length, 0, change)
    assert.equal(fixture.h.audits.length, 0, change)
  }
})

await check('reviewed association may reinforce selected references but refuses a conflicting explicit marker', async () => {
  const fixture = await reviewedFixture()
  fixture.raw.payload.body.data = Buffer.from(`Selected %gslt${fixture.customer.referenceCode} %gsltga2345678`).toString('base64url')
  assert.equal((await fixture.h.ingestion.reconcileGmailMessages(fixture.selection())).applied, false)
  fixture.raw.payload.body.data = Buffer.from('Conflicting %gsltgc9999999').toString('base64url')
  await assert.rejects(fixture.h.ingestion.reconcileGmailMessages(fixture.selection()), /Explicit message references conflict/)
  assert.equal(fixture.h.reviewedStages.length, 0)
  assert.equal(crmWriteQueries(fixture.h).length, 0)
})

await check('reviewed recovery requires an existing owner cache and never fetches a broad mailbox history', async () => {
  for (const change of ['missing-cache', 'foreign-cache-owner']) {
    const fixture = await reviewedFixture()
    if (change === 'missing-cache') fixture.h.messages.delete('a1')
    else fixture.h.messages.get('a1').owner_email = 'other@example.test'
    await assert.rejects(fixture.h.ingestion.reconcileGmailMessages(fixture.selection()), /existing owned cached Gmail message/)
    assert.equal(fixture.h.reviewedBatches.length, 0, change)
    assert.equal(crmWriteQueries(fixture.h).length, 0, change)
    assert.deepEqual(fixture.h.providerCalls, ['/google-mail/gmail/v1/users/me/messages/a1?format=full'])
  }
})

await check('reviewed preview and apply reject mismatched provider identity, thread and ineligible message labels', async () => {
  for (const change of ['thread', 'message-id', 'DRAFT', 'SPAM', 'TRASH', 'AUTH']) {
    const fixture = await reviewedFixture()
    if (change === 'thread') fixture.association.threadId = 'c1'
    else if (change === 'message-id') fixture.raw.id = 'c1'
    else if (change === 'AUTH') {
      fixture.raw.payload.headers.find(entry => entry.name === 'From').value = 'stewards@eigenracing.com'
      fixture.raw.payload.headers.find(entry => entry.name === 'Subject').value = 'Your ClawPilot sign-in code'
      fixture.raw.payload.headers.push(header('X-ClawPilot-Message-Purpose', 'auth-magic-code'))
    } else fixture.raw.labelIds = [change]
    await assert.rejects(fixture.h.ingestion.reconcileGmailMessages(fixture.selection()), /participants|not eligible/)
    assert.equal(fixture.h.reviewedStages.length, 0, change)
    assert.equal(crmWriteQueries(fixture.h).length, 0, change)
  }
})

await check('reviewed apply rechecks raw content, Contact email/account, membership and selected connection before staging', async () => {
  for (const change of ['body', 'raw-header', 'contact-email', 'contact-account', 'account-reference', 'membership', 'connection', 'mailbox-account']) {
    const fixture = await reviewedFixture()
    const preview = await fixture.h.ingestion.reconcileGmailMessages(fixture.selection())
    if (change === 'body') fixture.raw.payload.body.data = Buffer.from('Changed reviewed content').toString('base64url')
    if (change === 'raw-header') fixture.raw.payload.headers.push(header('Reply-To', 'changed@example.test'))
    if (change === 'contact-email') fixture.partner.email = 'changed@example.test'
    if (change === 'contact-account') fixture.partner.organizationId = customerOrganization
    if (change === 'account-reference') fixture.organizations[1].referenceCode = 'ga3456789'
    if (change === 'membership') fixture.activePipelines.splice(fixture.activePipelines.findIndex(pipeline => pipeline.id === businessPipeline), 1)
    if (change === 'connection') fixture.selectedMailboxes[0].connection_id = 'changed-connection'
    if (change === 'mailbox-account') fixture.selectedMailboxes[0].account_email = 'renamed@example.test'
    await assert.rejects(fixture.h.ingestion.reconcileGmailMessages(fixture.selection({ apply: true, expectedDigest: preview.digest })),
      /changed after preview|unambiguous current participants|unavailable|not active/, change)
    assert.equal(fixture.h.reviewedBatches.some(batch => batch.apply), false, change)
    assert.equal(fixture.h.reviewedStages.length, 0, change)
    assert.equal(fixture.h.audits.length, 0, change)
    assert.equal(crmWriteQueries(fixture.h).length, 0, change)
  }
})

await check('reviewed apply rejects missing or stale approval and revalidates the exact chosen primary Account', async () => {
  for (const change of ['missing', 'wrong', 'primary']) {
    const fixture = await reviewedFixture()
    const preview = await fixture.h.ingestion.reconcileGmailMessages(fixture.selection())
    if (change === 'primary') fixture.association.primaryOrganizationReference = 'ga2345678'
    await assert.rejects(fixture.h.ingestion.reconcileGmailMessages(fixture.selection({ apply: true,
      expectedDigest: change === 'missing' ? undefined : change === 'wrong' ? '0'.repeat(64) : preview.digest })), /changed after preview/)
    assert.equal(fixture.h.reviewedBatches.some(batch => batch.apply), false, change)
    assert.equal(fixture.h.reviewedStages.length, 0, change)
    assert.equal(crmWriteQueries(fixture.h).length, 0, change)
  }
})

await check('reviewed internal contract rejects missing, extra and duplicate associations before provider reads', async () => {
  const fixture = await reviewedFixture()
  for (const reviewedAssociations of [[], [null], [{ ...fixture.association, ownerEmail }],
    [{ ...fixture.association, messageId: 'c1' }],
    [{ ...fixture.association, threadId: null }],
    [{ ...fixture.association, contactReferences: [] }],
    [{ ...fixture.association, contactReferences: [fixture.customer.referenceCode, fixture.customer.referenceCode.toUpperCase()] }],
    [fixture.association, fixture.association],
  ]) {
    await assert.rejects(fixture.h.ingestion.reconcileGmailMessages(fixture.selection({ reviewedAssociations })), /exact reviewed association/)
    assert.equal(fixture.h.providerCalls.length, 0)
    assert.equal(fixture.h.reviewedBatches.length, 0)
  }
})

await check('reviewed apply uses one CAS batch and safely reports helper rejection before audit or linking', async () => {
  const fixture = await reviewedFixture({ beforeReviewedBatch: input => {
    if (input.apply) throw new Error('synthetic private provider or database detail')
  } })
  const second = rawMessage('c1', { from: fixture.customer.email, to: ownerEmail, cc: fixture.partner.email })
  second.threadId = 'd1'
  fixture.polledMessages.push(second)
  assert.equal((await fixture.h.ingestion.processMessage(fixture.h.input(second))).unmatched, true)
  fixture.h.queries.length = 0
  const selection = fixture.selection({ messageIds: ['c1', 'a1'], reviewedAssociations: [
    { ...fixture.association, messageId: 'c1', threadId: 'd1' }, fixture.association,
  ] })
  const preview = await fixture.h.ingestion.reconcileGmailMessages(selection)
  await assert.rejects(fixture.h.ingestion.reconcileGmailMessages({ ...selection, apply: true, expectedDigest: preview.digest }), error => (
    error.name === 'SafeEmailIngestionError' && /evidence changed before apply/.test(error.message)
      && !/private|provider|database/.test(error.message)
  ))
  assert.equal(fixture.h.reviewedBatches.filter(batch => batch.apply).length, 1)
  const apply = fixture.h.reviewedBatches.find(batch => batch.apply)
  assert.deepEqual(apply.messages.map(message => message.providerMessageId), ['a1', 'c1'], 'Every message is submitted in one deterministic compare-and-swap batch')
  assert.ok(apply.messages.every(message => message.expectedExistingInteractionId === null
    && /^[a-f0-9]{64}$/.test(message.expectedTargetFingerprint)))
  assert.equal(fixture.h.reviewedStages.length, 0)
  assert.equal(fixture.h.links.size, 0)
  assert.equal(fixture.h.audits.length, 0)
  assert.equal(crmWriteQueries(fixture.h).length, 0)
})

console.log(`CRM email routing passed: ${passed} focused checks; no live provider or database operations`)
