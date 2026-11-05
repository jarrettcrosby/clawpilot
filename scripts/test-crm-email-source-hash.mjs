#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const source = readFileSync(new URL('../app_src/lib/persistence/crm.ts', import.meta.url), 'utf8')
const authorityHelperSource = readFileSync(new URL('../app_src/lib/persistence/crmNativeEmailAuthority.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('crm.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
// Execute the real hash, staging and completion functions. SQL and adjacent
// normalization/provider helpers are synthetic; this is not database acceptance.
const functions = ['activeCrmRecordSql', 'stagedCrmSourceHash', 'stageCrmRecordWithClient', 'completeSuiteCrmOutboxInPostgres',
  'reviewedEmailAudienceModeUnderControlWithClient',
  'lockNativeEmailPublicationModeWithClient', 'nativeEmailOutboxTouchesEmail', 'nativeEmailOutboxUnresolvedGuardSql']
  .map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body)
    assert.ok(node, `Real function ${name} must exist`)
    return node.getText(ast)
  }).join('\n')
const compiled = ts.transpileModule(`${authorityHelperSource}\n${functions}\nexports.hash = stagedCrmSourceHash;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const copy = value => JSON.parse(JSON.stringify(value))
const crmSourceHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pipelineId = id(1), localId = id(2), nativeId = id(3)
const audience = { fingerprint: 'a'.repeat(64), allowedSuiteCrmUserIds: ['native-owner'] }
const input = () => ({
  entity: 'interactions', pipelineId, localId, sourceKey: 'gmail:synthetic-message', actorEmail: 'owner@example.test',
  sourcePayload: { providerMessageId: 'synthetic-message' },
  fields: { interactionType: 'email', subject: 'Customer email', description: 'Original content',
    metadata: { source: 'gmail-inbound' } },
})
const receipt = (revision = 1) => ({ version: 1, suiteCrmId: nativeId,
  capturedAt: `2026-10-30T10:00:0${revision}.000Z`, attributes: { name: 'Customer email' },
  accounts: [], contacts: [], contactAccounts: [], audience: {
    fingerprint: audience.fingerprint, readerSuiteCrmUserIds: ['native-owner'], administratorSuiteCrmUserIds: ['native-owner'],
  } })

function harness(initial = null) {
  let row = initial && copy(initial)
  const outbox = [], writes = []
  const client = { async query(sql, params = []) {
    if (sql === 'SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE') {
      return { rows: [{ singleton: true }] }
    }
    if (sql.startsWith('SELECT enabled, active_operation_id, active_transition_id FROM crm_native_email_publication_control')) {
      return { rows: [{ enabled: false, active_operation_id: null, active_transition_id: null }] }
    }
    if (sql === 'SELECT enabled FROM crm_native_email_publication_control WHERE singleton') return { rows: [{ enabled: false }] }
    if (sql.includes('SELECT id::text, suitecrm_id, reference_code, source_hash, source_payload, suitecrm_module, metadata')) {
      assert.deepEqual(copy(params), [pipelineId, localId, 'gmail:synthetic-message'])
      return { rows: row ? [copy(row)] : [] }
    }
    if (sql.includes('SELECT COALESCE(wo.is_demo')) return { rows: [{ is_demo: false }] }
    if (sql.includes('SELECT source_hash FROM crm_interactions')) return { rows: [{ source_hash: row.source_hash }] }
    if (sql.includes('set_config(')) return { rows: [] }
    writes.push(sql)
    if (sql.includes("jsonb_build_object('suiteCrmEmailProjection'")) {
      row.metadata = { ...row.metadata, suiteCrmEmailProjection: JSON.parse(params[1]) }
      return { rows: [] }
    }
    if (sql.includes("UPDATE sync_outbox SET status = 'succeeded'")) return { rows: [{ aggregate_type: 'crm_interactions', aggregate_id: localId }] }
    if (sql.includes("SET sync_status = 'synced'")) { row.sync_status = 'synced'; return { rows: [] } }
    if (sql.includes('UPDATE pipeline_spaces SET crm_last_synced_at')) return { rows: [] }
    throw new Error(`Unexpected SQL: ${sql}`)
  } }
  const runtime = {
    exports: {}, crmSourceHash, clean: value => String(value ?? '').trim(),
    normalizeStageCrmRecordInput: async (_client, value) => value,
    stableSuiteCrmId: () => nativeId, REVIEWED_GMAIL_RELATIONSHIPS: Symbol('reviewed'),
    stageInteraction: async (_client, value, suiteCrmId, sourceHash) => {
      row = { ...(row || {}), id: localId, suitecrm_id: suiteCrmId, reference_code: 'gi1234567',
        source_payload: copy(value.sourcePayload || {}), source_hash: sourceHash, suitecrm_module: 'Emails',
        metadata: copy(value.fields.metadata || {}), sync_status: 'pending' }
      return { id: localId, suitecrm_id: suiteCrmId, reference_code: row.reference_code }
    },
    enqueueSuiteCrmRecord: async (_client, value, recordId, suiteCrmId, globalId, sourceHash) => {
      const item = { id: id(10 + outbox.length), aggregateType: 'crm_interactions', aggregateId: recordId,
        operation: 'upsert_record', lockToken: 'synthetic-lease', attempts: 1,
        idempotencyKey: `crm:interactions:v4:${recordId}:Emails:${sourceHash}`,
        payload: { entity: 'interactions', pipelineId, localId: recordId, suiteCrmId, suiteCrmModule: 'Emails',
          attributes: { global_id_c: globalId, name: value.fields.subject, description: value.fields.description },
          emailProjection: { version: 1, accounts: [], contacts: [], contactAccounts: [], audience } } }
      outbox.push(item)
      return item.idempotencyKey
    },
    interactionSuiteCrmModule: () => 'Emails', ensureCrmReferenceShortLink: async () => 'https://example.test/s/gi1234567',
    recordAuditEvent: async () => {}, withTransaction: callback => callback(client),
    legacyReviewedEmailAudienceWithClient: async () => audience,
    tableForAggregate: aggregate => { assert.equal(aggregate, 'crm_interactions'); return 'crm_interactions' },
  }
  vm.runInNewContext(compiled, runtime, { filename: 'actual-crm-source-hash-functions.js' })
  return { api: runtime.exports, client, outbox, writes, row: () => row,
    putReceipt: value => { row.metadata = { ...row.metadata, suiteCrmEmailProjection: copy(value) } },
    stage: value => runtime.exports.stageCrmRecordWithClient(client, value),
    complete: item => runtime.exports.completeSuiteCrmOutboxInPostgres(item, {
      emailProjection: { ...receipt(3), attributes: copy(item.payload.attributes) },
    }) }
}

test('real staging preserves fresh server receipts without manufacturing new source revisions', async () => {
  const h = harness(), original = input(), before = copy(original)
  const first = await h.stage(original)
  for (const proof of [receipt(1), receipt(2), { ...receipt(2), version: 2, snapshotFingerprint: 'b'.repeat(64) }]) {
    h.putReceipt(proof)
    const staged = await h.stage(original)
    assert.equal(staged.sourceHash, first.sourceHash)
    assert.deepEqual(h.row().metadata.suiteCrmEmailProjection, proof, 'Evidence remains stored, not stripped from persistence')
  }
  assert.equal(new Set(h.outbox.map(item => item.idempotencyKey)).size, 1, 'Existing outbox uniqueness can reuse one content identity')
  const changed = { ...original, fields: { ...original.fields, description: 'A real customer content edit' } }
  const changedStage = await h.stage(changed)
  assert.notEqual(changedStage.sourceHash, first.sourceHash, 'Real staging still detects authored content changes')
  h.putReceipt(receipt(3))
  assert.equal((await h.stage(changed)).sourceHash, changedStage.sourceHash)
  assert.equal(new Set(h.outbox.map(item => item.idempotencyKey)).size, 2, 'Only the two actual content revisions have distinct keys')
  assert.deepEqual(original, before, 'Caller input is not mutated')
})

test('no metadata, empty metadata and receipt-only metadata have identical content identity', () => {
  const h = harness(), value = input()
  delete value.fields.metadata
  const expected = h.api.hash(value)
  for (const metadata of [{}, { suiteCrmEmailProjection: receipt(1) }, { suiteCrmEmailProjection: receipt(2) }]) {
    assert.equal(h.api.hash({ ...value, fields: { ...value.fields, metadata } }), expected)
  }
})

test('authored content, source evidence and non-publication metadata still change source identity', () => {
  const h = harness(), original = input(), expected = h.api.hash(original)
  const variants = [
    { ...original, fields: { ...original.fields, description: 'Updated content' } },
    { ...original, fields: { ...original.fields, subject: 'Updated subject' } },
    { ...original, fields: { ...original.fields, organizationIds: [id(20), id(21)] } },
    { ...original, fields: { ...original.fields, metadata: { ...original.fields.metadata, canonicalSourceId: id(22) } } },
    { ...original, fields: { ...original.fields, metadata: { ...original.fields.metadata, reviewedGmailRecovery: { decision: 'changed' } } } },
    { ...original, sourcePayload: { providerMessageId: 'different-message' } },
    { ...original, sourcePayload: { ...original.sourcePayload, suiteCrmEmailProjection: { retainedProviderEvidence: true } } },
  ]
  for (const variant of variants) assert.notEqual(h.api.hash(variant), expected)
  const other = { ...original, entity: 'opportunities' }
  assert.equal(h.api.hash(other), crmSourceHash({ fields: other.fields, sourcePayload: other.sourcePayload }), 'Non-interaction hashing is unchanged')
})

test('receipt exclusion does not authorize caller receipt replacement or bypass an archive', async () => {
  const h = harness()
  await h.stage(input()); h.putReceipt(receipt(1))
  await assert.rejects(h.stage({ ...input(), fields: { ...input().fields, metadata: {
    ...input().fields.metadata, suiteCrmEmailProjection: receipt(2),
  } } }), /Native Email projection receipts cannot be supplied/)
  const archived = harness({ ...copy(h.row()), source_payload: { archived: true }, source_hash: 'legacy-archived-hash' })
  const result = await archived.stage(input())
  assert.equal(result.sourceHash, 'legacy-archived-hash')
  assert.equal(archived.outbox.length, 0)
})

test('one-time old hash transition does not let an older v1 completion mark the new revision synced', async () => {
  const original = input(), oldProof = receipt(1)
  const oldHash = crmSourceHash({ fields: { ...original.fields, metadata: { ...original.fields.metadata,
    suiteCrmEmailProjection: oldProof } }, sourcePayload: original.sourcePayload })
  const h = harness({ id: localId, suitecrm_id: nativeId, reference_code: 'gi1234567', source_hash: oldHash,
    source_payload: original.sourcePayload, suitecrm_module: 'Emails', metadata: { ...original.fields.metadata,
      suiteCrmEmailProjection: oldProof } })
  const staged = await h.stage(original)
  assert.notEqual(staged.sourceHash, oldHash, 'Authorized restaging transitions a receipt-inclusive legacy hash once')
  const currentItem = h.outbox[0]
  await h.complete({ ...currentItem, idempotencyKey: `crm:interactions:v4:${localId}:Emails:${oldHash}` })
  assert.equal(h.row().sync_status, 'pending', 'Old outcome cannot mark latest source synced')
  assert.deepEqual(h.row().metadata.suiteCrmEmailProjection, oldProof, 'Old completion cannot overwrite current-source evidence')
  assert.ok(!h.writes.some(sql => sql.includes("SET sync_status = 'synced'")))
  await h.complete(currentItem)
  assert.equal(h.row().sync_status, 'synced', 'Exact current v1 completion retains its existing behavior')
  assert.equal((await h.stage(original)).sourceHash, staged.sourceHash, 'Current completion does not generate another revision')
  assert.equal(new Set(h.outbox.map(item => item.idempotencyKey)).size, 1)
})
