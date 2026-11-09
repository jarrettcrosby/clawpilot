#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const source = readFileSync(new URL('../app_src/lib/persistence/crm.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('crm.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = ['activeCrmRecordSql', 'nativeEmailOutboxUnresolvedGuardSql', 'lockNativeEmailPublicationModeWithClient',
  'nativeEmailOutboxTouchesEmail', 'claimSuiteCrmOutboxInPostgres', 'tableForAggregate',
  'mayDispatchSuiteCrmUserIdentityInPostgres',
  'failSuiteCrmOutboxInPostgres', 'completeSuiteCrmOutboxInPostgres', 'completeSuiteCrmOutboxInTransaction', 'enqueueSuiteCrmRecord']
const functions = names.map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body)
  assert.ok(node, `Real ${name} must exist`)
  return node.getText(ast)
}).join('\n')
const compiled = ts.transpileModule(`${functions}\nexports.enqueue = enqueueSuiteCrmRecord;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const copy = value => JSON.parse(JSON.stringify(value))
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pipelineId = id(1), localId = id(2)
function row(n, module = 'Emails', unresolved = null) {
  return { id: id(n), aggregate_type: 'crm_interactions', aggregate_id: localId, operation: 'upsert_record',
    target_system: 'suitecrm', status: 'processing', expired: true, attempts: 1, lock_token: 'old-claim',
    idempotency_key: `crm:interactions:v4:${localId}:${module}:source-hash`, unresolved,
    payload: { entity: 'interactions', pipelineId, localId, suiteCrmId: id(3), suiteCrmModule: module, attributes: {} } }
}
const pending = value => ['admitted', 'dispatched', 'unknown'].includes(value)
function guarded(sql) {
  assert.match(sql, /NOT EXISTS \([\s\S]*FROM crm_native_email_publication_work native_work/)
  assert.match(sql, /native_admission\.operation_id = native_work\.operation_id/)
  assert.match(sql, /native_work\.work_kind = 'outbox'/)
  assert.match(sql, /native_work\.context->>'outboxId' = sync_outbox\.id::text/)
  assert.match(sql, /native_admission\.state IN \('admitted', 'dispatched', 'unknown'\)/)
}
function harness(values, enabled = true, controlOverride) {
  const rows = copy(values), calls = [], entityWrites = []
  const control = controlOverride === undefined
    ? [{ enabled, active_operation_id: null, active_transition_id: null }] : controlOverride
  const client = { async query(sql, params = []) {
    calls.push({ sql, params })
    if (sql.startsWith('SELECT enabled, active_operation_id, active_transition_id FROM crm_native_email_publication_control')) {
      assert.match(sql, /WHERE singleton FOR UPDATE$/)
      return { rows: control }
    }
    if (sql.includes('set_config(')) return { rows: [] }
    if (sql.includes('SuiteCRM worker lease expired')) {
      guarded(sql)
      for (const record of rows) if (record.status === 'processing' && record.expired && !pending(record.unresolved)) {
        record.status = 'failed'; record.lock_token = null
      }
      return { rows: [] }
    }
    if (sql.includes('WITH candidates AS')) {
      guarded(sql)
      assert.match(sql, /AND NOT \(\$4::boolean AND \(COALESCE\(payload->>'suiteCrmModule', ''\) = 'Emails'/)
      assert.match(sql, /OR COALESCE\(payload->>'previousSuiteCrmModule', ''\) = 'Emails'/)
      assert.match(sql, /AND NOT \(\$5::boolean AND operation = 'upsert_user_identity'\)/)
      const selected = rows.filter(record => ['queued', 'failed'].includes(record.status)
        && record.attempts < params[0] && !pending(record.unresolved)
        && !(params[3] && (record.payload.suiteCrmModule === 'Emails'
          || record.payload.previousSuiteCrmModule === 'Emails'))
        && !(params[4] && record.operation === 'upsert_user_identity')).slice(0, params[1])
      for (const record of selected) { record.status = 'processing'; record.attempts++; record.lock_token = params[2] }
      return { rows: copy(selected) }
    }
    if (sql.startsWith('SELECT id FROM sync_outbox')) {
      assert.match(sql,/target_system='suitecrm' AND operation='upsert_user_identity'/)
      assert.match(sql,/aggregate_type='app_users' AND aggregate_id=\$2 AND status='processing'/)
      assert.match(sql,/lock_token=\$3 AND payload=\$4::jsonb/)
      assert.match(sql,/FOR SHARE$/)
      return {rows:rows.filter(record=>record.id===params[0]&&record.aggregate_id===params[1]
        &&record.status==='processing'&&record.lock_token===params[2]
        &&JSON.stringify(record.payload)===params[3]).map(record=>({id:record.id}))}
    }
    if (sql.startsWith('UPDATE sync_outbox SET status = $3')) {
      guarded(sql)
      const record = rows.find(record => record.id === params[0] && record.status === 'processing'
        && record.lock_token === params[1] && !pending(record.unresolved))
      if (!record) return { rows: [] }
      record.status = params[2]; record.lock_token = null
      return { rows: [{ status: record.status }] }
    }
    if (sql.startsWith("UPDATE sync_outbox SET status = 'succeeded'")) {
      guarded(sql)
      const record = rows.find(record => record.id === params[0] && record.status === 'processing'
        && record.lock_token === params[1] && !pending(record.unresolved))
      if (!record) return { rows: [] }
      record.status = 'succeeded'; record.lock_token = null
      return { rows: [{ aggregate_type: record.aggregate_type, aggregate_id: record.aggregate_id }] }
    }
    if (sql.includes('UPDATE pipeline_spaces SET crm_last_synced_at')) return { rows: [] }
    if (sql.includes('UPDATE crm_interactions') || sql.includes('UPDATE crm_products')) {
      entityWrites.push(sql)
      return { rows: [] }
    }
    if (sql.includes('DELETE FROM sync_outbox')) {
      guarded(sql)
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].aggregate_type === params[0]
        && rows[i].aggregate_id === params[1] && ['queued', 'failed', 'dead'].includes(rows[i].status)
        && !pending(rows[i].unresolved)) rows.splice(i, 1)
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO sync_outbox')) {
      guarded(sql)
      const record = rows.find(record => record.idempotency_key === params[3])
      if (record && (!['succeeded', 'dead'].includes(record.status) || pending(record.unresolved))) return { rows: [] }
      if (record) { record.payload = JSON.parse(params[2]); record.status = 'queued'; record.attempts = 0 }
      else rows.push({ id: id(90 + rows.length), idempotency_key: params[3], payload: JSON.parse(params[2]), status: 'queued', attempts: 0 })
      return { rows: [{ idempotency_key: params[3] }] }
    }
    if (sql.includes('SELECT contact.suitecrm_id AS contact_id') || sql.includes("metadata->'suiteCrmEmailProjection'")) return { rows: [] }
    throw new Error(`Unexpected SQL: ${sql}`)
  } }
  const runtime = { exports: {}, crypto, clean: value => String(value ?? '').trim(),
    ENTITY_TABLE: { interactions: 'crm_interactions', products: 'crm_products' },
    withTransaction: callback => callback(client),
    interactionSuiteCrmModule: fields => fields.suiteCrmModule,
    suiteCrmRelationships: async () => [], suiteCrmAttributes: () => ({}),
    reviewedEmailAudienceWithClient: async () => ({ fingerprint: 'b'.repeat(64) }),
    legacyReviewedEmailAudienceWithClient: async () => ({ fingerprint: 'b'.repeat(64) }),
  }
  vm.runInNewContext(compiled, runtime)
  return { api: runtime.exports, client, calls, rows, entityWrites }
}
const item = record => ({ id: record.id, aggregateType: record.aggregate_type, aggregateId: record.aggregate_id,
  operation: record.operation, payload: record.payload, attempts: record.attempts,
  lockToken: record.lock_token, idempotencyKey: record.idempotency_key })

test('claim and lease recycle exclude each unresolved state under the control lock', async () => {
  const protectedRows = ['admitted', 'dispatched', 'unknown'].map((state, i) => row(10 + i, 'Emails', state))
  const h = harness([...protectedRows, row(20, 'Emails'), row(21, 'Notes')])
  const claimed = await h.api.claimSuiteCrmOutboxInPostgres()
  assert.deepEqual(copy(claimed.map(record => record.id)), [id(20), id(21)])
  assert.match(h.calls[0].sql, /publication_control.*FOR UPDATE/)
  for (const original of protectedRows) assert.deepEqual(h.rows.find(record => record.id === original.id), original)
  assert.equal(h.entityWrites.length, 1, 'Native Email state is left to coordinator; non-Email behavior remains')
})

test('enabled mode also leaves previous-Email transitions to coordinator', async () => {
  const transition = row(10, 'Notes'); transition.payload.previousSuiteCrmModule = 'Emails'
  const h = harness([transition])
  assert.equal((await h.api.claimSuiteCrmOutboxInPostgres()).length, 1)
  assert.equal(h.entityWrites.length, 0)
})

function identityRow(n, status = 'queued') {
  return {...row(n,'Users'),aggregate_type:'app_users',aggregate_id:'synthetic@example.test',operation:'upsert_user_identity',
    status,attempts:0,expired:false,payload:{localId:'synthetic@example.test',suiteCrmUserId:id(30),referenceCode:'gu1234567',username:'gu1234567'}}
}
test('enabled mode holds only legacy identity claims without burning attempts while unrelated jobs continue', async()=>{
  for(const active_transition_id of [null,'a'.repeat(64)]){
    const identity=identityRow(10),note={...row(11,'Notes'),status:'queued',expired:false}
    const h=harness([identity,note],true,[{enabled:true,active_operation_id:null,active_transition_id}])
    assert.deepEqual(copy((await h.api.claimSuiteCrmOutboxInPostgres()).map(value=>value.id)),[note.id])
    assert.deepEqual(h.rows.find(value=>value.id===identity.id),identity)
  }
})
test('identity dispatch rechecks current mode and exact owned claim before any provider work',async()=>{
  const identity=identityRow(10,'processing'),enabled=harness([identity],true)
  assert.equal(await enabled.api.mayDispatchSuiteCrmUserIdentityInPostgres(item(identity)),false)
  assert.equal(enabled.calls.length,1);assert.deepEqual(enabled.rows[0],identity)
  const disabled=harness([identity],false)
  assert.equal(await disabled.api.mayDispatchSuiteCrmUserIdentityInPostgres(item(identity)),true)
  assert.match(disabled.calls[0].sql,/publication_control.*FOR UPDATE/)
  const changed=item(identity);changed.payload={...changed.payload,username:'gu7654321'}
  await assert.rejects(disabled.api.mayDispatchSuiteCrmUserIdentityInPostgres(changed),/claim changed/)
  const unavailable=harness([identity],false,[])
  await assert.rejects(unavailable.api.mayDispatchSuiteCrmUserIdentityInPostgres(item(identity)),/control is missing/)
})
test('identity activation migration statically requires every outstanding identity to drain, including expired failures',()=>{
  const sql=readFileSync(new URL('../db/migrations/0381_crm_native_email_identity_quiescence.sql',import.meta.url),'utf8')
  assert.match(sql,/IF NEW.enabled AND NOT OLD.enabled AND EXISTS/)
  assert.match(sql,/target_system='suitecrm' AND operation='upsert_user_identity'/)
  assert.match(sql,/status IS DISTINCT FROM 'succeeded'/)
  assert.match(sql,/BEFORE UPDATE OF enabled[\s\S]*ON crm_native_email_publication_control FOR EACH ROW/)
  assert.doesNotMatch(sql,/UPDATE\s+(?:public\.)?sync_outbox|DELETE FROM|INSERT INTO/)
})

test('an active native operation does not burn fresh Email attempts while non-Email work continues', async () => {
  const email = { ...row(10), status: 'queued', attempts: 0, expired: false }
  const transition = { ...row(11, 'Notes'), status: 'failed', attempts: 2, expired: false }
  transition.payload.previousSuiteCrmModule = 'Emails'
  const note = { ...row(12, 'Notes'), status: 'queued', attempts: 0, expired: false }
  const h = harness([email, transition, note], true, [{ enabled: true, active_operation_id: 'a'.repeat(64), active_transition_id: null }])
  assert.deepEqual(copy((await h.api.claimSuiteCrmOutboxInPostgres()).map(value => value.id)), [note.id])
  assert.deepEqual(h.rows.find(value => value.id === email.id), email)
  assert.deepEqual(h.rows.find(value => value.id === transition.id), transition)
  assert.equal(h.rows.find(value => value.id === note.id).attempts, 1)
})

test('an active authority transition leaves current and previous Email jobs queued without burning attempts', async () => {
  const email = { ...row(10), status: 'queued', attempts: 0, expired: false }
  const transition = { ...row(11, 'Notes'), status: 'failed', attempts: 2, expired: false }
  transition.payload.previousSuiteCrmModule = 'Emails'
  const note = { ...row(12, 'Notes'), status: 'queued', attempts: 0, expired: false }
  const h = harness([email, transition, note], true,
    [{ enabled: true, active_operation_id: null, active_transition_id: 'b'.repeat(64) }])
  assert.deepEqual(copy((await h.api.claimSuiteCrmOutboxInPostgres()).map(value => value.id)), [note.id])
  assert.deepEqual(h.rows.find(value => value.id === email.id), email)
  assert.deepEqual(h.rows.find(value => value.id === transition.id), transition)
  assert.equal(h.rows.find(value => value.id === note.id).attempts, 1)
  assert.equal(h.entityWrites.length, 1)
})

test('disabled mode preserves ordinary claim and failure state writes but still requires valid control', async () => {
  const h = harness([row(10)], false)
  const [claimed] = await h.api.claimSuiteCrmOutboxInPostgres()
  assert.equal(h.entityWrites.length, 1)
  assert.equal(await h.api.failSuiteCrmOutboxInPostgres({ item: claimed, error: 'synthetic' }), 'failed')
  assert.equal(h.entityWrites.length, 2)
  for (const control of [[],
    [{ enabled: false, active_operation_id: 'a'.repeat(64), active_transition_id: null }],
    [{ enabled: 'false', active_operation_id: null, active_transition_id: null }],
    [{ enabled: false, active_operation_id: null }],
    [{ enabled: false, active_operation_id: null, active_transition_id: 'b'.repeat(64) }],
    [{ enabled: true, active_operation_id: 'a'.repeat(64), active_transition_id: 'b'.repeat(64) }],
    [{ enabled: true, active_operation_id: null, active_transition_id: 'b'.repeat(64) + '\n' }]]) {
    const invalid = harness([row(11)], false, control)
    await assert.rejects(invalid.api.claimSuiteCrmOutboxInPostgres(), /control is missing or inconsistent/)
    assert.equal(invalid.calls.length, 1, 'No queue writes after missing/inconsistent control')
  }
})

test('generic failure cannot release unresolved publication or write its interaction state', async () => {
  for (const state of ['admitted', 'dispatched', 'unknown']) {
    const original = row(10, 'Emails', state), h = harness([original])
    await assert.rejects(h.api.failSuiteCrmOutboxInPostgres({ item: item(original), error: 'lost response' }), /lease was lost/)
    assert.deepEqual(h.rows[0], original)
    assert.equal(h.entityWrites.length, 0)
    assert.match(h.calls[0].sql, /publication_control.*FOR UPDATE/)
  }
  const h = harness([row(11)])
  await h.api.failSuiteCrmOutboxInPostgres({ item: item(h.rows[0]), error: 'no admission' })
  assert.equal(h.entityWrites.length, 0, 'Enabled mode avoids outbox-to-interaction lock inversion')
})

test('generic completion locks control before outbox/source rows and authority-triggering pipeline update', async () => {
  for (const enabled of [false, true]) {
    const original = row(10, 'Notes'), h = harness([original], enabled)
    await h.api.completeSuiteCrmOutboxInPostgres(item(original))
    assert.match(h.calls[0].sql, /publication_control.*FOR UPDATE/)
    assert.equal(h.rows[0].status, 'succeeded')
    assert.equal(h.entityWrites.length, 1)
    assert.ok(h.calls.some(call => call.sql.includes('UPDATE pipeline_spaces SET crm_last_synced_at')))
  }
  for (const module of ['Emails', 'Notes']) {
    const original = row(10, module), h = harness([original], true)
    if (module === 'Notes') original.payload.previousSuiteCrmModule = 'Emails'
    await assert.rejects(h.api.completeSuiteCrmOutboxInPostgres(item(original)), /publication coordinator/)
    assert.equal(h.calls.length, 1, 'Enabled Email completion stops before source or queue writes')
  }
  const original = row(10, 'Notes', 'unknown'), h = harness([original], false)
  await assert.rejects(h.api.completeSuiteCrmOutboxInPostgres(item(original)), /lease or projection identity was lost/)
  assert.deepEqual(h.rows[0], original)
  assert.equal(h.entityWrites.length, 0)
  const missing = harness([row(10, 'Notes')], false, [])
  await assert.rejects(missing.api.completeSuiteCrmOutboxInPostgres(item(row(10, 'Notes'))), /control is missing or inconsistent/)
  assert.equal(missing.calls.length, 1)
})

test('module-transition cleanup retains unresolved old jobs without taking control after the interaction lock', async () => {
  const protectedRow = { ...row(10, 'Emails', 'unknown'), status: 'failed' }
  const ordinaryRow = { ...row(11, 'Emails'), status: 'failed' }
  const h = harness([protectedRow, ordinaryRow])
  await h.api.enqueue(h.client, { entity: 'interactions', pipelineId, fields: { suiteCrmModule: 'Notes' } },
    localId, id(3), 'gi1234567', 'source-hash', 'Emails')
  assert.deepEqual(h.rows.find(record => record.id === protectedRow.id), protectedRow)
  assert.ok(!h.rows.some(record => record.id === ordinaryRow.id))
  assert.ok(!h.calls.some(call => call.sql.includes('publication_control')), 'Staging already owns interaction; do not reverse lock order')
})

test('ordinary and module-delete ON CONFLICT resets retain unresolved work evidence', async () => {
  for (const mode of ['Emails', null]) {
    const record = { ...row(10, 'Emails', 'dispatched'), status: 'dead' }
    if (mode === null) record.idempotency_key = `crm:interactions:module-delete:v1:${localId}:Emails`
    const h = harness([record])
    const result = await h.api.enqueue(h.client, { entity: 'interactions', pipelineId, fields: { suiteCrmModule: mode } },
      localId, id(3), 'gi1234567', 'source-hash', mode === null ? 'Emails' : undefined)
    assert.equal(result, null)
    assert.deepEqual(h.rows[0], record)
  }
})
