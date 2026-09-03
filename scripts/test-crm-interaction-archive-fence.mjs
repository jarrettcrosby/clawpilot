#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')

function loadModule(path, mocks = {}) {
  const output = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer, URL, module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('node:')) return require(name)
      // Unused imports may load, but unexpected dependency calls fail closed.
      return new Proxy({}, { get: (_, method) => () => { throw new Error(`Unexpected dependency: ${name}.${String(method)}`) } })
    },
  }, { filename: path })
  return module.exports
}

const stable = loadModule('app_src/lib/crm/stableId.ts')
const plain = (value) => JSON.parse(JSON.stringify(value))
const pipelineId = '11111111-1111-4111-8111-111111111111'
const recordId = '22222222-2222-4222-8222-222222222222'
const actorEmail = 'operator@example.test'
const baseRecord = {
  id: recordId, pipeline_id: pipelineId, reference_code: 'giarchivefixture',
  suitecrm_id: 'persisted-suitecrm-id', suitecrm_module: 'Emails',
  source_key: 'gmail:synthetic-message', source_hash: 'persisted-source-hash',
  source_payload: { source: 'gmail-inbound', providerMessageId: 'synthetic-message' },
  description: 'Original customer email',
}

function harness(initialRecord = baseRecord) {
  let record = initialRecord ? plain(initialRecord) : null
  let linksDisabled = Boolean(record?.source_payload.archived)
  const calls = []
  const audits = []
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params: plain(params) })
      const result = (rows) => ({ rows, rowCount: rows.length })
      if (sql.includes('FROM app_users app_user')) return result([])
      if (sql.includes('WITH resolved AS')) return result([{}])
      if (sql.includes('FROM crm_contacts') && sql.includes('id = ANY')) return result([])
      if (sql.includes('pg_advisory_xact_lock')) return result([])
      if (sql.includes('FROM crm_interactions') && sql.includes('FOR UPDATE')) {
        assert.equal(params[0], pipelineId)
        if (sql.includes('LIMIT 1')) {
          assert.match(sql, /pipeline_id = \$1::uuid/)
          assert.match(sql, /\$2::uuid IS NOT NULL AND id = \$2::uuid/)
          assert.match(sql, /\$2::uuid IS NULL AND source_key = \$3/)
          assert.equal(params[2], baseRecord.source_key)
          assert.ok(params[1] === null || params[1] === recordId)
        } else assert.equal(params[1], recordId)
        return result(record ? [plain(record)] : [])
      }
      if (sql.includes('SET source_payload = source_payload ||')) {
        record.source_payload = { ...record.source_payload, ...JSON.parse(params[2]) }
        return result([])
      }
      if (sql.includes('DELETE FROM sync_outbox')) return result([])
      if (sql.includes('UPDATE short_links')) { linksDisabled = true; return result([]) }
      if (sql.includes('INSERT INTO crm_interactions')) {
        record = {
          ...(record || baseRecord), source_payload: JSON.parse(params[25]), source_hash: params[26],
          description: params[19], suitecrm_id: record?.suitecrm_id || params[7], suitecrm_module: params[12],
        }
        return result([plain(record)])
      }
      if (sql.includes('DELETE FROM crm_interaction_contacts')) return result([])
      if (sql.includes('SELECT COALESCE(wo.is_demo')) return result([{ is_demo: false }])
      if (sql.includes('SET sync_status =')) return result([])
      if (sql.includes('SELECT pipeline.owner_email')) {
        return result([{ owner_email: actorEmail, organization_id: 'organization', reference_access_disabled: false }])
      }
      if (sql.includes('INSERT INTO short_links')) {
        linksDisabled = false
        return result([{ slug: params[2] }])
      }
      if (sql.includes('AS link_field_name')) return result([])
      if (sql.includes('INSERT INTO sync_outbox')) return result([{ idempotency_key: params[3] }])
      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
  const crm = loadModule('app_src/lib/persistence/crm.ts', {
    '@/lib/crm/stableId': stable,
    '@/lib/persistence/postgres': { withTransaction: (callback) => callback(client) },
    '@/lib/publicUrl': { appPublicUrl: () => 'https://app.example.test' },
    '@/lib/shortlinks': { shortLinkUrl: (code) => `https://example.test/s/${code}` },
    '@/lib/auditWriter': { recordAuditEvent: async (event) => { audits.push(plain(event)) } },
  })
  return { crm, client, calls, audits, record: () => plain(record), linksDisabled: () => linksDisabled }
}

function staleInput(overrides = {}) {
  return {
    entity: 'interactions', pipelineId, localId: recordId,
    sourceKey: baseRecord.source_key, actorEmail, emitSuiteCrmOutbox: false,
    sourcePayload: { ...baseRecord.source_payload, suiteCrmInbound: { id: 'synthetic-note' } },
    fields: { interactionType: 'email', subject: 'Synthetic interaction', description: 'Stale inbound edit' },
    ...overrides,
  }
}

// Model the exact race: the worker takes its payload snapshot, then the real
// archive helper commits, then the worker reaches the existing staging row lock.
for (const emitSuiteCrmOutbox of [false, true]) {
  for (const localId of [recordId, undefined]) {
    const h = harness()
    const input = staleInput({ emitSuiteCrmOutbox, localId })
    const originalInput = plain(input)
    await h.crm.archiveCrmRecordInPostgres({
      pipelineId, entity: 'interactions', id: recordId, actorEmail, emitSuiteCrmOutbox: false,
    })
    const archived = h.record()
    assert.equal(archived.source_payload.archived, true)
    assert.equal(archived.source_payload.archivedBy, actorEmail)
    assert.equal(archived.source_payload.archivedSource, 'clawpilot')
    assert.ok(archived.source_payload.archivedAt)
    h.calls.length = 0
    h.audits.length = 0
    const returned = await h.crm.stageCrmRecordInPostgres(input)
    assert.deepEqual(plain(returned), {
      id: recordId, suiteCrmId: baseRecord.suitecrm_id, referenceCode: baseRecord.reference_code,
      shortUrl: null, sourceHash: baseRecord.source_hash,
    })
    assert.deepEqual(h.record(), archived, 'Stale staging must preserve the entire archived record, not just its flag')
    assert.deepEqual(plain(input), originalInput, 'Staging must not alter its caller snapshot')
    assert.equal(h.linksDisabled(), true, 'Staging must not reactivate either archived short link')
    assert.equal(h.audits.length, 0)
    assert.equal(h.calls.filter(({ sql }) => sql.includes('FOR UPDATE')).length, 1)
    assert.ok(h.calls.every(({ sql }) => !/\b(?:INSERT|UPDATE|DELETE)\b/.test(sql.replace('FOR UPDATE', ''))),
      'Archived no-op must not write records, relationships, outbox jobs, or links')
  }
}

// Preserve every archive spelling hidden by activeCrmRecordSql and truthful
// nullable provider identity; caller-supplied unarchive fields are not authority.
for (const archived of [true, 'true', 'TRUE', 1, '1', 'yes', 'YeS']) {
  const h = harness({ ...baseRecord, suitecrm_id: null, source_payload: {
    ...baseRecord.source_payload, archived, archivedAt: '2026-09-03T12:00:00Z',
    archivedBy: actorEmail, archivedSource: 'suitecrm',
  } })
  const before = h.record()
  const returned = await h.crm.stageCrmRecordWithClient(h.client, staleInput({
    sourcePayload: { archived: false, archivedAt: null, archivedBy: null, archivedSource: null },
  }))
  assert.equal(returned.suiteCrmId, null)
  assert.equal(returned.sourceHash, baseRecord.source_hash)
  assert.deepEqual(h.record(), before)
  assert.equal(h.linksDisabled(), true)
}

// Active and new records still use real normalization, staging, hash generation,
// outbox creation, and reference-link persistence without an archive early exit.
for (const initial of [null, baseRecord, { ...baseRecord, source_payload: { archived: false } },
  { ...baseRecord, source_payload: { archived: 'no' } }]) {
  for (const interactionType of ['email', 'note']) {
    const h = harness(initial)
    const input = staleInput({ emitSuiteCrmOutbox: true, fields: {
      interactionType, subject: 'Synthetic active interaction', description: 'Fresh inbound edit',
    } })
    const returned = await h.crm.stageCrmRecordInPostgres(input)
    assert.deepEqual(h.record().source_payload, input.sourcePayload)
    assert.equal(h.record().description, input.fields.description)
    assert.equal(returned.sourceHash, h.record().source_hash)
    assert.notEqual(returned.sourceHash, baseRecord.source_hash)
    assert.equal(returned.shortUrl, `https://example.test/s/${baseRecord.reference_code}`)
    assert.equal(h.linksDisabled(), false)
    assert.ok(h.calls.some(({ sql }) => sql.includes('INSERT INTO sync_outbox')))
    const lockIndex = h.calls.findIndex(({ sql }) => sql.includes('FOR UPDATE'))
    const writeIndex = h.calls.findIndex(({ sql }) => sql.includes('INSERT INTO crm_interactions'))
    assert.ok(lockIndex >= 0 && writeIndex > lockIndex)
  }
}

// Existing input/relationship checks still happen before the archive lookup;
// the fence adds no new way around pipeline-user or contact validation.
for (const fields of [{ agentEmail: 'unauthorized@example.test' }, { contactIds: [recordId] }]) {
  const h = harness({ ...baseRecord, source_payload: { archived: true } })
  await assert.rejects(h.crm.stageCrmRecordWithClient(h.client, staleInput({
    fields: { interactionType: 'email', subject: 'Invalid mapping', ...fields },
  })), /Interaction (agent must be an active ClawPilot user with pipeline access|contact selection is invalid)/)
  assert.ok(h.calls.every(({ sql }) => !sql.includes('FOR UPDATE')))
}

console.log('crm interaction archive fence tests passed (locked stale-update no-op, active paths, mapping guards)')
