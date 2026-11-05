#!/usr/bin/env node
// Execute the real transaction entry points against a strict synthetic query
// recorder. This proves call order/fail-closed behavior, not PostgreSQL locking.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const functions = (path, names) => {
  const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return names.map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body)
    assert.ok(node, `Actual production function ${name} exists`)
    return node.getText(ast)
  }).join('\n')
}
const compiled = ts.transpileModule([
  functions('app_src/lib/persistence/crmNativeEmailAuthority.ts', ['lockCrmNativeEmailAuthorityWithClient']),
  functions('app_src/lib/persistence/crm.ts', ['stagedCrmSourceHash', 'stageCrmRecordWithClient',
    'reviewedEmailAudienceModeUnderControlWithClient',
    'stageCrmRecordInPostgres', 'enrichCrmEmailInteractionParticipantsInPostgres',
    'stageReviewedGmailInteractionsInPostgres', 'convertCrmLeadInPostgres',
    'appendCrmOpportunityCommentInPostgres', 'lockCrmMutation']),
].join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const controlSql = 'SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE'
const stop = new Error('fixture stopped at next production boundary')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const input = () => ({ entity: 'interactions', pipelineId: id(1), localId: id(2),
  sourceKey: 'fixture:email', actorEmail: 'owner@example.test', sourcePayload: {},
  fields: { interactionType: 'email', subject: 'Known Email', description: 'Edited body' } })

function harness({ controlRows = [{ singleton: true }], modeRows = [{ enabled: false }], completeStage = false } = {}) {
  const calls = []
  const row = { id: id(2), suitecrm_id: id(3), reference_code: 'gi1234567', source_hash: 'old',
    source_payload: {}, metadata: {}, suitecrm_module: 'Emails' }
  const client = { async query(sql) {
    calls.push(sql)
    if (sql === controlSql) return { rows: controlRows }
    if (sql === 'SELECT enabled FROM crm_native_email_publication_control WHERE singleton') return { rows: modeRows }
    if (!completeStage) throw stop
    if (sql.includes('SELECT id::text, suitecrm_id, reference_code, source_hash, source_payload, suitecrm_module, metadata')) {
      return { rows: [row] }
    }
    if (sql.includes('SELECT COALESCE(wo.is_demo')) return { rows: [{ is_demo: false }] }
    throw new Error(`Unexpected SQL: ${sql}`)
  } }
  const runtime = { exports: {}, withTransaction: async callback => callback(client),
    crmSourceHash: value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    clean: value => String(value ?? '').trim(),
    normalizeStageCrmRecordInput: async (_client, value) => {
      calls.push('normalize-source')
      if (!completeStage) throw stop
      return value
    },
    stableSuiteCrmId: () => id(3), REVIEWED_GMAIL_RELATIONSHIPS: Symbol('reviewed'),
    stageInteraction: async (_client, value, nativeId, hash) => {
      assert.equal(value.fields.description, 'Edited body')
      assert.equal(nativeId, row.suitecrm_id)
      calls.push('content-stage')
      row.source_hash = hash
      return row
    },
    enqueueSuiteCrmRecord: async () => { calls.push('outbox-stage'); return 'fixture-key' },
    interactionSuiteCrmModule: () => 'Emails', ensureCrmReferenceShortLink: async () => 'https://example.test/s/gi1234567',
    recordAuditEvent: async () => {},
    prepareReviewedGmailInteractionWithClient: async () => { calls.push('prepare-reviewed'); throw stop },
  }
  vm.runInNewContext(compiled, runtime)
  return { api: runtime.exports, client, calls, row }
}

const reviewed = apply => ({ apply, messages: [{ pipelineId: id(1), providerMessageId: 'fixture-message',
  ownerEmail: 'owner@example.test', participantEmails: ['person@example.test'] }] })
const entries = [
  ['generic interaction staging', h => h.api.stageCrmRecordWithClient(h.client, input())],
  ['standalone interaction transaction', h => h.api.stageCrmRecordInPostgres(input())],
  ['reviewed Gmail apply', h => h.api.stageReviewedGmailInteractionsInPostgres(reviewed(true))],
  ['reviewed Gmail nonmutating preview', h => h.api.stageReviewedGmailInteractionsInPostgres(reviewed(false))],
  ['participant enrichment apply', h => h.api.enrichCrmEmailInteractionParticipantsInPostgres({ apply: true })],
  ['lead conversion Notes staging', h => h.api.convertCrmLeadInPostgres({ pipelineId: id(1), leadId: id(4) })],
  ['opportunity comment Notes staging', h => h.api.appendCrmOpportunityCommentInPostgres({ pipelineId: id(1), opportunityId: id(5) })],
]
for (const [label, invoke] of entries) test(`${label} takes control before the first source/advisory/authority boundary`, async () => {
  const h = harness()
  await assert.rejects(invoke(h), error => error === stop)
  assert.equal(h.calls[0], controlSql)
  assert.ok(h.calls.length >= 2, 'The real entry continues into its next production boundary')
})

test('every mutating entry fails closed before source locks when control is missing', async () => {
  for (const [, invoke] of entries) {
    const h = harness({ controlRows: [] })
    await assert.rejects(invoke(h), /Native Email authority control is missing or inconsistent/)
    assert.deepEqual(h.calls, [controlSql])
  }
})

test('unrelated enrichment previews and entity staging do not gain the control lock', async () => {
  for (const invoke of [h => h.api.enrichCrmEmailInteractionParticipantsInPostgres({ apply: false }),
    h => h.api.stageCrmRecordWithClient(h.client, { ...input(), entity: 'products' })]) {
    const h = harness()
    await assert.rejects(invoke(h), error => error === stop)
    assert.ok(!h.calls.includes(controlSql))
  }
})

test('reviewed preview/apply and interaction staging reject unknown mode before participant/source locks', async () => {
  for (const modeRows of [[], [{ enabled: null }], [{ enabled: 'true' }], [{ enabled: false }, { enabled: true }]]) {
    for (const invoke of [h => h.api.stageReviewedGmailInteractionsInPostgres(reviewed(false)),
      h => h.api.stageReviewedGmailInteractionsInPostgres(reviewed(true)),
      h => h.api.stageCrmRecordWithClient(h.client, input())]) {
      const h = harness({ modeRows })
      await assert.rejects(invoke(h), /Native Email audience control mode is missing or inconsistent/)
      assert.deepEqual(h.calls, [controlSql, 'SELECT enabled FROM crm_native_email_publication_control WHERE singleton'])
    }
  }
})

test('the source-order helper does not impose an active-transition blanket freeze on content staging', async () => {
  // Only the singleton is queried: authority/known-identity changes remain the
  // real DB trigger's decision. A known Email's body can still stage normally.
  const h = harness({ completeStage: true })
  const staged = await h.api.stageCrmRecordInPostgres(input())
  assert.equal(staged.id, id(2))
  assert.equal(h.calls[0], controlSql)
  assert.ok(h.calls.includes('content-stage'))
  assert.ok(h.calls.includes('outbox-stage'))
  assert.notEqual(staged.sourceHash, 'old')
})
