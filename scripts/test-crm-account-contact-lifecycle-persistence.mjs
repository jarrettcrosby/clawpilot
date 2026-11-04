#!/usr/bin/env node
// Actual persistence functions executed with an explicit SQL model. This
// validates call ordering and command fences, not PostgreSQL concurrency or
// native SuiteCRM deletion. No database/container/provider is contacted.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const requireApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireApp('typescript')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function load(path, mocks = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read(path), { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, Buffer, URL, Error,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('node:')) return requireApp(name)
      return new Proxy({}, { get: (_, method) => () => assert.fail(`Unexpected dependency ${name}.${String(method)}`) })
    },
  })
  return module.exports
}
const stable = load('app_src/lib/crm/stableId.ts')
const authority = load('app_src/lib/persistence/crmNativeEmailAuthority.ts')
const pipelineId = '11111111-1111-4111-8111-111111111111'
const foreignPipeline = '99999999-9999-4999-8999-999999999999'
const recordId = '22222222-2222-4222-8222-222222222222'
const foreignId = '33333333-3333-4333-8333-333333333333'
const actorEmail = 'operator@example.test'
const controlSql = 'SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE'
const contextSql = "SELECT set_config('clawpilot.crm_shared_write_v1', 'on', true)"
const archived = record => ['true', '1', 'yes'].includes(String(record.source_payload?.archived ?? '').toLowerCase())
function recordFor(entity, overrides = {}) {
  return { id: recordId, pipeline_id: pipelineId, reference_code: entity === 'organizations' ? 'ga1111111' : 'gc1111111',
    suitecrm_id: 'native-exact-identity', source_key: 'sheet:original-row', identity_key: 'canonical-identity', source_hash: 'original-hash',
    source_payload: { source: 'sheet' }, workspace_organization_id: null, relationship_type: 'customer', app_user_email: null, pipeline_user: false,
    aliases: ['sheet:old-row-alias'], ...overrides }
}
function harness(entity, overrides = {}) {
  const table = `crm_${entity}`, target = recordFor(entity, overrides)
  const foreign = recordFor(entity, { id: foreignId, pipeline_id: foreignPipeline, reference_code: 'ga9999999', suitecrm_id: 'native-foreign', source_key: 'sheet:foreign' })
  const records = [target, foreign], calls = [], audits = [], outbox = [], links = new Set([target.reference_code, foreign.reference_code])
  let duplicateBinding = false, lease = null
  const client = { async query(sql, values = []) {
    const params = plain(values); calls.push({ sql, params })
    const result = rows => ({ rows: plain(rows), rowCount: rows.length })
    if (sql === controlSql) return result([{ singleton: true }])
    if (sql === contextSql || sql.includes('pg_advisory_xact_lock')) return result([])
    if (sql.includes('AS managed_identity')) {
      assert.match(sql, new RegExp(`FROM ${table}\\s+WHERE pipeline_id = \\$1::uuid AND id = \\$2::uuid\\s+FOR UPDATE`))
      if (entity === 'organizations') assert.ok(sql.includes("workspace_organization_id IS NOT NULL OR relationship_type IN ('workspace_root','workspace_member')"))
      else assert.ok(sql.includes('app_user_email IS NOT NULL OR pipeline_user = true'))
      return result(records.filter(row => row.pipeline_id === params[0] && row.id === params[1]).map(row => ({ ...row,
        managed_identity: entity === 'organizations' ? Boolean(row.workspace_organization_id || ['workspace_root', 'workspace_member'].includes(row.relationship_type))
          : Boolean(row.app_user_email !== null || row.pipeline_user === true),
      })))
    }
    if (sql.includes('WHERE lower(suitecrm_id)=lower($1) OR lower(reference_code)=lower($2)')) {
      assert.ok(sql.includes(`FROM ${table}`) && sql.includes('ORDER BY id'))
      assert.ok(!sql.includes('pipeline_id='), 'Native/global uniqueness must include other pipelines')
      if (calls.some(call => call.sql.includes('AS managed_identity'))) assert.ok(sql.includes('FOR SHARE'))
      const found = records.filter(row => row.suitecrm_id?.toLowerCase() === params[0]?.toLowerCase() || row.reference_code.toLowerCase() === params[1].toLowerCase()).map(row => ({ id: row.id }))
      return result(duplicateBinding ? [...found, { id: foreignId }] : found)
    }
    if (sql.includes(`UPDATE ${table}`) && sql.includes('source_payload = source_payload ||')) {
      assert.ok(sql.includes('WHERE pipeline_id = $1::uuid AND id = $2::uuid'))
      for (const row of records.filter(row => row.pipeline_id === params[0] && row.id === params[1])) row.source_payload = { ...row.source_payload, ...JSON.parse(params[2]) }
      return result([])
    }
    if (sql.includes('DELETE FROM sync_outbox')) {
      assert.ok(sql.includes("operation IN ('upsert_record', 'reproject_record')") && sql.includes("status <> 'processing'"))
      assert.deepEqual(params, [`crm_${entity}`, recordId]); return result([])
    }
    if (sql.includes('INSERT INTO sync_outbox')) {
      assert.ok(sql.includes("'delete_record'")); assert.deepEqual(params.slice(0, 2), [`crm_${entity}`, recordId])
      outbox.push(JSON.parse(params[2])); return result([])
    }
    if (sql.includes('UPDATE short_links')) {
      assert.ok(sql.includes("source_app = 'clawpilot-crm'") && sql.includes('slug = ANY($1::text[])'))
      params[0].forEach(slug => links.delete(slug)); return result([])
    }
    if (sql.includes('identity_key=ANY($3::text[])')) {
      assert.ok(sql.includes(`FROM ${table}`) && sql.includes('pipeline_id=$1::uuid') && sql.includes('ORDER BY id FOR UPDATE'))
      if (entity === 'contacts') assert.ok(sql.includes('crm_contact_source_aliases') && sql.includes('WHERE pipeline_id=$1::uuid AND source_key=ANY($3::text[])'))
      return result(records.filter(row => row.pipeline_id === params[0]
        && (params[1] ? row.id === params[1] : params[2].some(key => key === row.identity_key || key === row.source_key || (entity === 'contacts' && row.aliases.includes(key))))))
    }
    if (sql.includes('JOIN sync_outbox outbox')) {
      for (const fragment of ['outbox.id=$4::uuid', 'outbox.aggregate_id=record.id::text', 'outbox.aggregate_type=$5', "outbox.status='processing'",
        'outbox.lock_token=$6', 'outbox.payload=$7::jsonb', 'record.id=$1::uuid', 'record.pipeline_id=$2::uuid', 'record.suitecrm_id=$3']) assert.ok(sql.includes(fragment), fragment)
      assert.ok(sql.includes(`FROM ${table} record`) && sql.includes("source_payload->>'archived'"))
      const matched = lease && lease.id === params[3] && lease.aggregateType === params[4] && lease.aggregateId === params[0]
        && lease.lockToken === params[5] && lease.status === 'processing' && JSON.stringify(lease.payload) === params[6]
      return result(!matched ? [] : records.filter(row => row.id === params[0] && row.pipeline_id === params[1] && row.suitecrm_id === params[2])
        .map(row => ({ source_hash: row.source_hash, reference_code: row.reference_code, archived: archived(row) })))
    }
    assert.fail(`Unexpected SQL in bounded fixture: ${sql}`)
  } }
  const crm = load('app_src/lib/persistence/crm.ts', {
    '@/lib/crm/stableId': stable,
    '@/lib/persistence/crmNativeEmailAuthority': authority,
    '@/lib/persistence/postgres': { withTransaction: callback => callback(client) },
    '@/lib/auditWriter': { recordAuditEvent: async event => audits.push(plain(event)) },
  })
  return { crm, client, target, foreign, calls, audits, outbox, links,
    duplicateBinding: () => { duplicateBinding = true }, setLease: item => { lease = { status: 'processing', ...plain(item) } } }
}
const input = entity => ({ pipelineId, entity, id: recordId, actorEmail })
const writeCalls = calls => calls.filter(({ sql }) => /^(?:UPDATE|INSERT|DELETE)\b/u.test(sql.trim()))
let checks = 0
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`) }
await check('exact account/contact archive preserves other pipeline and all activities; native delete queued once', async () => {
  for (const entity of ['organizations', 'contacts']) {
    const h = harness(entity), untouched = plain(h.foreign)
    const result = await h.crm.archiveCrmRecordInPostgres(input(entity))
    assert.equal(result.archived, true); assert.equal(result.suiteCrmDeleteQueued, true)
    assert.equal(h.target.source_payload.archived, true); assert.equal(h.target.source_payload.archivedBy, actorEmail)
    assert.deepEqual(h.foreign, untouched)
    assert.deepEqual(h.outbox, [{ entity, pipelineId, localId: recordId, suiteCrmId: h.target.suitecrm_id, attributes: { global_id_c: h.target.reference_code } }])
    assert.equal(h.links.has(h.target.reference_code), false); assert.equal(h.links.has(h.foreign.reference_code), true)
    assert.equal(h.calls[0].sql, controlSql)
    assert.deepEqual(h.calls.filter(call => call.sql.includes('pg_advisory_xact_lock')).map(call => call.params[0]),
      [`crm-record-lifecycle:${pipelineId}`, `crm-archive:${pipelineId}:${entity}:${recordId}`])
    assert.ok(writeCalls(h.calls).every(({ sql }) => !/\bcrm_(?:interactions|meetings|opportunities)\b/.test(sql)), 'No activity cascade')
    assert.ok(writeCalls(h.calls).every(({ sql }) => !sql.includes(`UPDATE crm_${entity === 'contacts' ? 'organizations' : 'contacts'}`)), 'No counterpart cascade')
    assert.equal(h.audits.length, 1)
    h.calls.length = 0
    const repeated = await h.crm.archiveCrmRecordInPostgres(input(entity))
    assert.equal(repeated.changed, false); assert.equal(repeated.suiteCrmDeleteQueued, false)
    assert.equal(h.outbox.length, 1); assert.equal(writeCalls(h.calls).length, 0)
  }
})
await check('local-only archives and provider-confirmed archives never falsely report a queued deletion', async () => {
  for (const entity of ['organizations', 'contacts']) {
    const local = harness(entity, { suitecrm_id: null })
    assert.equal((await local.crm.archiveCrmRecordInPostgres(input(entity))).suiteCrmDeleteQueued, false)
    assert.equal(local.outbox.length, 0)
    const native = harness(entity)
    const result = await native.crm.archiveCrmRecordInPostgres({ ...input(entity), archiveSource: 'suitecrm', emitSuiteCrmOutbox: false,
      expectedSuiteCrmIdentity: { nativeId: native.target.suitecrm_id, globalId: native.target.reference_code } })
    assert.equal(result.suiteCrmDeleteQueued, false); assert.equal(native.target.source_payload.archivedSource, 'suitecrm'); assert.equal(native.outbox.length, 0)
  }
})
await check('managed identities, wrong scopes, absent or ambiguous native/global pairs refuse before writes', async () => {
  for (const [entity, protections] of [['organizations', [{ workspace_organization_id: pipelineId }, { relationship_type: 'workspace_root' }, { relationship_type: 'workspace_member' }]],
    ['contacts', [{ app_user_email: actorEmail }, { pipeline_user: true }]]]) {
    for (const fields of protections) {
      const h = harness(entity, fields)
      await assert.rejects(h.crm.archiveCrmRecordInPostgres(input(entity)), /managed in Settings/)
      assert.equal(writeCalls(h.calls).length, 0)
    }
    for (const override of [{ pipelineId: foreignPipeline }, { id: foreignId }, { archiveSource: 'suitecrm' },
      { expectedSuiteCrmIdentity: { nativeId: 'wrong', globalId: 'wrong' } }]) {
      const h = harness(entity)
      await assert.rejects(h.crm.archiveCrmRecordInPostgres({ ...input(entity), ...override }), /not found|required|binding changed/)
      assert.equal(writeCalls(h.calls).length, 0)
    }
    const h = harness(entity); h.duplicateBinding()
    await assert.rejects(h.crm.archiveCrmRecordInPostgres({ ...input(entity), expectedSuiteCrmIdentity: {
      nativeId: h.target.suitecrm_id, globalId: h.target.reference_code,
    } }), /ambiguous/)
    assert.equal(writeCalls(h.calls).length, 0)
  }
})
await check('ordinary outgoing archive refuses cross-pipeline native/global conflicts, including case variants', async () => {
  for (const entity of ['organizations', 'contacts']) for (const conflict of ['native-exact', 'native-case', 'global-case']) {
    const h = harness(entity)
    if (conflict === 'global-case') h.foreign.reference_code = h.target.reference_code.toUpperCase()
    else h.foreign.suitecrm_id = conflict === 'native-case' ? h.target.suitecrm_id.toUpperCase() : h.target.suitecrm_id
    const before = plain([h.target, h.foreign])
    // No expectedSuiteCrmIdentity is supplied by the ordinary UI action. It
    // must still run the same global uniqueness guard as provider reconciliation.
    await assert.rejects(h.crm.archiveCrmRecordInPostgres(input(entity)), /binding is ambiguous/)
    assert.deepEqual([h.target, h.foreign], before)
    assert.equal(writeCalls(h.calls).length, 0); assert.equal(h.outbox.length, 0); assert.equal(h.audits.length, 0)
    assert.equal(h.links.has(h.target.reference_code), true)
  }
})
await check('actual staging retains tombstones by local ID, source key, canonical identity and contact alias', async () => {
  for (const entity of ['organizations', 'contacts']) for (const archivedValue of [true, 'TRUE', '1', 'YeS']) {
    const fields = entity === 'organizations' ? { name: 'Saved customer' } : { fullName: 'Saved contact', email: 'contact@example.test' }
    const identity = entity === 'organizations' ? stable.organizationIdentityKey(fields) : stable.contactIdentityKey(fields)
    for (const match of ['local', 'source', 'identity', ...(entity === 'contacts' ? ['alias'] : [])]) {
      const h = harness(entity, { identity_key: identity, source_payload: { archived: archivedValue, archivedBy: actorEmail } }), before = plain(h.target)
      const returned = await h.crm.stageCrmRecordWithClient(h.client, { entity, pipelineId, actorEmail,
        ...(match === 'local' ? { localId: recordId } : {}), sourceKey: match === 'alias' ? 'sheet:old-row-alias' : match === 'source' ? h.target.source_key : 'new-source',
        fields: match === 'identity' ? fields : entity === 'organizations' ? { name: 'Stale renamed customer' } : { fullName: 'Stale contact', email: 'stale@example.test' },
        sourcePayload: { archived: false },
      })
      assert.deepEqual(plain(returned), { id: recordId, suiteCrmId: h.target.suitecrm_id, referenceCode: h.target.reference_code, sourceHash: h.target.source_hash, shortUrl: null })
      assert.deepEqual(h.target, before); assert.equal(writeCalls(h.calls).length, 0); assert.equal(h.outbox.length, 0)
      assert.equal(h.calls[0].sql, controlSql); assert.equal(h.calls[1].params[0], `crm-record-lifecycle:${pipelineId}`)
    }
  }
})
await check('create-only and missing-native tombstones refuse resurrection without writes', async () => {
  for (const entity of ['organizations', 'contacts']) for (const variant of ['create-only', 'missing-native']) {
    const h = harness(entity, { source_payload: { archived: true }, ...(variant === 'missing-native' ? { suitecrm_id: null } : {}) })
    await assert.rejects(h.crm.stageCrmRecordWithClient(h.client, { entity, pipelineId, actorEmail, localId: recordId,
      sourceKey: h.target.source_key, fields: {}, ...(variant === 'create-only' ? { createOnly: true } : {}) }), /deleted|Deleted/)
    assert.equal(writeCalls(h.calls).length, 0)
  }
})
function outboxItem(entity, overrides = {}) {
  return { id: '44444444-4444-4444-8444-444444444444', aggregateType: `crm_${entity}`, aggregateId: recordId,
    operation: 'upsert_record', lockToken: 'current-lease', idempotencyKey: `crm:${entity}:v1:${recordId}:original-hash`,
    payload: { entity, pipelineId, localId: recordId, suiteCrmId: 'native-exact-identity',
      attributes: { global_id_c: entity === 'organizations' ? 'ga1111111' : 'gc1111111' } }, ...overrides }
}
await check('dispatch runs only with current active identity/revision/lease; tombstones and stale jobs never publish', async () => {
  for (const entity of ['organizations', 'contacts']) {
    for (const variant of ['current', 'archived', 'old-lease', 'not-processing', 'changed-payload', 'changed-native', 'changed-global', 'missing-global', 'changed-revision', 'wrong-aggregate']) {
      const h = harness(entity), item = outboxItem(entity)
      h.setLease(item)
      if (variant === 'archived') h.target.source_payload.archived = true
      if (variant === 'old-lease') h.setLease({ ...item, lockToken: 'new-lease' })
      if (variant === 'not-processing') h.setLease({ ...item, status: 'queued' })
      if (variant === 'changed-payload') h.setLease({ ...item, payload: { ...item.payload, attributes: { name: 'newer' } } })
      if (variant === 'changed-native') h.target.suitecrm_id = 'new-native'
      if (variant === 'changed-global') h.target.reference_code = entity === 'organizations' ? 'ga2222222' : 'gc2222222'
      if (variant === 'missing-global') { delete item.payload.attributes.global_id_c; h.setLease(item) }
      if (variant === 'changed-revision') h.target.source_hash = 'new-hash'
      if (variant === 'wrong-aggregate') item.aggregateId = foreignId
      let published = 0
      const apply = () => h.crm.withVerifiedSuiteCrmRecordLifecycle(item, async () => { published++; return 'published' })
      if (variant === 'current') { assert.equal(await apply(), 'published'); assert.equal(published, 1) }
      else { await assert.rejects(apply(), /identity changed|revision changed/); assert.equal(published, 0) }
      if (variant !== 'wrong-aggregate') assert.equal(h.calls[0].params[0], `crm-record-lifecycle:${pipelineId}`)
      assert.equal(h.calls.some(call => call.sql === controlSql), false, 'Provider I/O is not held under authority control')
      assert.equal(writeCalls(h.calls).length, 0)
    }
  }
})
await check('delete dispatch rechecks global casefold uniqueness before the native delete callback', async () => {
  for (const entity of ['organizations', 'contacts']) {
    for (const conflict of ['native-exact', 'native-case', 'global-case']) {
      const h = harness(entity, { source_payload: { archived: true } }), item = outboxItem(entity, { operation: 'delete_record' })
      if (conflict === 'global-case') h.foreign.reference_code = h.target.reference_code.toUpperCase()
      else h.foreign.suitecrm_id = conflict === 'native-case' ? h.target.suitecrm_id.toUpperCase() : h.target.suitecrm_id
      h.setLease(item); const before = plain([h.target, h.foreign]); let published = 0
      await assert.rejects(h.crm.withVerifiedSuiteCrmRecordLifecycle(item, async () => ++published), /identity is ambiguous/)
      assert.equal(published, 0); assert.deepEqual([h.target, h.foreign], before); assert.equal(writeCalls(h.calls).length, 0)
      assert.ok(h.calls.some(call => call.sql.includes('lower(suitecrm_id)=lower($1) OR lower(reference_code)=lower($2)')))
    }
  }
})
await check('legitimately shared managed identities still support exact ordinary upserts across pipelines', async () => {
  for (const entity of ['organizations', 'contacts']) {
    const managed = entity === 'organizations' ? { workspace_organization_id: pipelineId, relationship_type: 'workspace_root' }
      : { app_user_email: actorEmail, pipeline_user: true }
    const h = harness(entity, managed), item = outboxItem(entity)
    Object.assign(h.foreign, managed, { suitecrm_id: h.target.suitecrm_id, reference_code: h.target.reference_code })
    h.setLease(item); const before = plain([h.target, h.foreign]); let published = 0
    assert.equal(await h.crm.withVerifiedSuiteCrmRecordLifecycle(item, async () => ++published), 1)
    assert.equal(published, 1); assert.deepEqual([h.target, h.foreign], before)
    assert.equal(h.calls.some(call => call.sql.includes('lower(suitecrm_id)=lower($1) OR lower(reference_code)=lower($2)')), false,
      'Shared identity prohibition is a deletion guard, not a blanket ordinary-upsert restriction')
    assert.equal(writeCalls(h.calls).length, 0)
    await assert.rejects(h.crm.archiveCrmRecordInPostgres(input(entity)), /managed in Settings/)
    assert.equal(writeCalls(h.calls).length, 0, 'Managed shared identities remain protected against deletion')
  }
})
await check('delete dispatch requires its exact archived identity; unrelated modules retain existing dispatch', async () => {
  for (const entity of ['organizations', 'contacts']) {
    for (const tombstone of [false, true]) {
      const h = harness(entity, { source_payload: { archived: tombstone } }), item = outboxItem(entity, { operation: 'delete_record' })
      h.setLease(item); let published = 0
      const apply = () => h.crm.withVerifiedSuiteCrmRecordLifecycle(item, async () => ++published)
      if (tombstone) assert.equal(await apply(), 1)
      else await assert.rejects(apply(), /deleted|identity changed/)
      assert.equal(published, tombstone ? 1 : 0)
    }
  }
  const h = harness('organizations'); let published = 0
  assert.equal(await h.crm.withVerifiedSuiteCrmRecordLifecycle(outboxItem('leads'), async () => ++published), 1)
  assert.equal(h.calls.length, 0)
  await assert.rejects(h.crm.withVerifiedSuiteCrmRecordLifecycle(outboxItem('organizations', { operation: 'upsert_user_identity' }), async () => ++published), /payload is invalid/)
  assert.equal(published, 1)
})
console.log(`Account/contact lifecycle persistence passed ${checks} actual-function/SQL-model groups; no PostgreSQL, native provider, or concurrency proof.`)
