#!/usr/bin/env node
// Actual bounded reconciliation and ingestion orchestration; database/native
// transport/archive transaction are mocked. No provider or production proof.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
function load(path, dependencies) {
  const module = { exports: {} }
  const code = ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  new Function('module', 'exports', 'require', code)(module, module.exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unmocked dependency ' + name)
    return dependencies[name]
  })
  return module.exports
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const local = (n = 1, module = 'Accounts', extra = {}) => ({ module, local_id: id(n), pipeline_id: id(101),
  workspace_id: id(201), owner_email: 'owner@example.test', native_id: `native-${n}`,
  global_id: `${module === 'Accounts' ? 'ga' : 'gc'}${String(n).padStart(7, '0')}`,
  protected_identity: false, identity_match_count: '1', cursor_key: `${module}:${id(n)}`, ...extra })
const identity = row => ({ module: row.module, nativeId: row.native_id, globalId: row.global_id })
const snapshot = (row, deleted = true) => ({ id: row.native_id,
  attributes: { global_id_c: row.global_id, deleted, date_modified: '2026-10-30 12:00:00' } })
const CURSOR = 'crm.suitecrm.account_contact_lifecycle.cursor'
function harness(options = {}) {
  const queries = [], inspections = [], archives = []
  const rows = options.rows ?? [local()]
  const api = load('app_src/lib/crm/suiteCrmAccountContactLifecycle.ts', {
    '@/lib/persistence/postgres': { query: async (sql, values) => {
      queries.push({ sql, values })
      if (sql.startsWith('SELECT value')) return { rows: options.cursor ? [{ value: options.cursor }] : [] }
      if (sql.startsWith('WITH records')) return { rows }
      if (sql.startsWith('INSERT INTO app_settings')) return { rows: [] }
      assert.fail('Unexpected SQL ' + sql)
    } },
    '@/lib/persistence/crm': { archiveCrmRecordInPostgres: async input => {
      archives.push(input)
      if (options.archiveError) throw Error('atomic identity changed')
      return { changed: options.changed ?? true }
    } },
    '@/lib/crm/suiteCrmRecordLifecycleClient': { inspectSuiteCrmRecordLifecycle: async records => {
      inspections.push(records)
      if (options.inspectError) throw options.inspectError
      return options.observed ?? records.map(record => ({ ...record, state: 'deleted', dateModified: '2026-10-30 12:00:00' }))
    } },
  })
  return { ...api, queries, inspections, archives }
}
const previous = process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED
let checks = 0
async function check(label, fn) { await fn(); checks++; console.log('PASS ' + label) }
try {
  await check('exact opt-in is required before database or provider inspection', async () => {
    for (const value of ['', 'true', 'yes', '0']) {
      process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED = value
      const h = harness(), result = await h.processSuiteCrmAccountContactLifecycle()
      assert.equal(result.enabled, false); assert.equal(result.archived, 0)
      assert.equal((await h.reconcileSuiteCrmAccountContactTombstone('Accounts', snapshot(local()))).held, 1)
      assert.equal(h.queries.length, 0); assert.equal(h.inspections.length, 0); assert.equal(h.archives.length, 0)
    }
    process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED = '1'
  })
  await check('bounded exact-known pairs archive only positive deletions and suppress outbound echo', async () => {
    const active = local(1), deleted = local(2, 'Contacts'), missing = local(3)
    const rows = [active, deleted, missing, local(4, 'Accounts', { protected_identity: true }),
      local(5, 'Contacts', { identity_match_count: '2' }), local(6, 'Accounts', { workspace_id: null })]
    const observed = [active, deleted, missing].map((row, i) => ({ ...identity(row),
      state: ['active', 'deleted', 'missing'][i], dateModified: null }))
    const h = harness({ rows, observed }), result = await h.processSuiteCrmAccountContactLifecycle()
    assert.deepEqual(h.inspections, [[identity(active), identity(deleted), identity(missing)]])
    assert.deepEqual(h.archives, [{ pipelineId: deleted.pipeline_id, entity: 'contacts', id: deleted.local_id,
      actorEmail: deleted.owner_email, emitSuiteCrmOutbox: false, archiveSource: 'suitecrm',
      expectedSuiteCrmIdentity: { nativeId: deleted.native_id, globalId: deleted.global_id } }])
    assert.equal(result.scanned, 6); assert.equal(result.archived, 1); assert.equal(result.missing, 1)
    assert.equal(result.protected, 1); assert.equal(result.held, 2); assert.equal(result.errors, 0)
    assert.deepEqual(result.pipelineIds, [deleted.pipeline_id])
    assert.deepEqual(h.queries[1].values, ['', 100])
    assert.equal(h.queries.at(-1).values[0], CURSOR)
    assert.equal(JSON.parse(h.queries.at(-1).values[1]).after, null)
    assert.ok(h.queries[1].sql.includes('lower(candidate.suitecrm_id)=lower(contact.suitecrm_id)'))
    assert.ok(h.queries[1].sql.includes("NOT IN ('true','1','yes')"))
    assert.ok(h.queries[1].sql.includes("'workspace_root','workspace_member'"))
    assert.ok(h.queries[1].sql.includes("contact.contact_type,'')='pipeline_user'"))
    assert.ok(h.queries[1].sql.includes('contact.pipeline_user IS TRUE'))
    assert.doesNotMatch(h.queries[1].sql, /date_modified|updated_at\s*[<>]/)
  })
  await check('unavailable forbidden missing endpoint and identity mismatch never archive or advance cursor', async () => {
    for (const inspectError of [Error('404'), Error('403'), Error('disabled'), Error('network')]) {
      const h = harness({ inspectError }), result = await h.processSuiteCrmAccountContactLifecycle()
      assert.equal(result.errors, 1); assert.equal(result.pending, true); assert.equal(h.archives.length, 0)
      assert.ok(!h.queries.some(q => q.sql.startsWith('INSERT')))
    }
    for (const observed of [[], [{ ...identity(local()), state: 'unknown' }],
      [{ ...identity(local()), globalId: 'ga0000002', state: 'deleted' }],
      [{ ...identity(local()), nativeId: 'other', state: 'deleted' }]]) {
      const h = harness({ observed }), result = await h.processSuiteCrmAccountContactLifecycle()
      assert.equal(result.errors, 1); assert.equal(h.archives.length, 0)
      assert.ok(!h.queries.some(q => q.sql.startsWith('INSERT')))
    }
  })
  await check('validate whole native batch before the first archive and retain retry on atomic conflict', async () => {
    const rows = [local(1), local(2)]
    const h = harness({ rows, observed: [{ ...identity(rows[0]), state: 'deleted' },
      { ...identity(rows[1]), nativeId: 'wrong-second-record', state: 'deleted' }] })
    assert.equal((await h.processSuiteCrmAccountContactLifecycle()).errors, 1); assert.equal(h.archives.length, 0)
    const raced = harness({ archiveError: true })
    const result = await raced.processSuiteCrmAccountContactLifecycle()
    assert.equal(result.errors, 1); assert.equal(result.archived, 0)
    assert.ok(!raced.queries.some(q => q.sql.startsWith('INSERT')))
  })
  await check('independent rotating cursor is bounded and wraps after the final known-local page', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => local(i + 1))
    const h = harness({ rows, cursor: { after: 'Accounts:' + id(0) },
      observed: rows.map(row => ({ ...identity(row), state: 'active', dateModified: null })) })
    const result = await h.processSuiteCrmAccountContactLifecycle()
    assert.equal(result.pending, true); assert.equal(h.inspections[0].length, 100)
    assert.deepEqual(h.queries[1].values, ['Accounts:' + id(0), 100])
    assert.equal(JSON.parse(h.queries.at(-1).values[1]).after, rows.at(-1).cursor_key)
    const empty = harness({ rows: [], cursor: { after: rows.at(-1).cursor_key } })
    assert.equal((await empty.processSuiteCrmAccountContactLifecycle()).pending, false)
    assert.equal(empty.inspections.length, 0)
    assert.equal(JSON.parse(empty.queries.at(-1).values[1]).after, null)
  })
  await check('enabled explicit deleted feed snapshots archive the exact account or contact once', async () => {
    for (const module of ['Accounts', 'Contacts']) {
      const row = local(1, module), h = harness({ rows: [row] })
      const result = await h.reconcileSuiteCrmAccountContactTombstone(module, snapshot(row))
      assert.equal(result.archived, 1); assert.equal(h.inspections.length, 0)
      assert.deepEqual(h.queries[0].values, [module, row.native_id, row.global_id])
      assert.equal(h.archives[0].entity, module === 'Accounts' ? 'organizations' : 'contacts')
      assert.deepEqual(h.archives[0].expectedSuiteCrmIdentity, { nativeId: row.native_id, globalId: row.global_id })
    }
    const repeat = harness({ changed: false })
    assert.equal((await repeat.reconcileSuiteCrmAccountContactTombstone('Accounts', snapshot(local()))).archived, 0)
  })
  await check('missing global ID mismatched pair duplicate tenant and managed identity remain held', async () => {
    for (const rows of [[local(1, 'Accounts', { global_id: 'ga0000002' })],
      [local(1, 'Accounts', { native_id: 'different' })], [local(), local(2)],
      [local(1, 'Accounts', { identity_match_count: '2' })], [local(1, 'Accounts', { protected_identity: true })],
      [local(1, 'Accounts', { workspace_id: null })]]) {
      const h = harness({ rows }), result = await h.reconcileSuiteCrmAccountContactTombstone('Accounts', snapshot(local()))
      assert.ok(result.held + result.protected > 0); assert.equal(h.archives.length, 0)
    }
    for (const input of [{ id: 'native-1', attributes: { deleted: true } },
      { ...snapshot(local()), id: 'native-1\n' },
      { id: 'native-1', attributes: { deleted: true, global_id_c: 'ga0000001\n' } }, snapshot(local(), false)]) {
      const h = harness(); assert.equal((await h.reconcileSuiteCrmAccountContactTombstone('Accounts', input)).archived, 0)
      assert.equal(h.queries.length, 0); assert.equal(h.archives.length, 0)
    }
  })
  await check('modified feed invokes exact tombstone path and lifecycle failures do not block normal polling', async () => {
    const queries = [], tombstones = [], projections = [], polls = []
    const lifecycle = { enabled: true, scanned: 0, inspected: 0, archived: 0, protected: 0, held: 0,
      missing: 0, errors: 1, pending: true, pipelineIds: [] }
    const api = load('app_src/lib/crm/suiteCrmAccountContactIngestion.ts', {
      '@/lib/crm/boardProjection': { reconcileCrmBoardProjectionsForPipeline: async input => projections.push(input) },
      '@/lib/htmlEntities.mjs': { decodeHtmlEntities: value => String(value ?? '') },
      '@/lib/crm/suiteCrmClient': { listSuiteCrmAccountContactRecordsUpdatedSince: async input => {
        polls.push(input); return { records: input.module === 'Accounts' ? [snapshot(local())] : [], totalPages: 1 }
      } },
      '@/lib/persistence/crm': { stageCrmRecordInPostgres: () => assert.fail('deleted snapshots cannot be staged') },
      '@/lib/persistence/postgres': { query: async (sql, values) => { queries.push({ sql, values }); return { rows: [] } } },
      '@/lib/crm/suiteCrmAccountContactLifecycle': {
        processSuiteCrmAccountContactLifecycle: async () => lifecycle,
        reconcileSuiteCrmAccountContactTombstone: async (...args) => {
          tombstones.push(args); return { matched: 1, archived: 1, protected: 0, held: 0, pipelineIds: [id(101)] }
        },
      },
    })
    const result = await api.processSuiteCrmAccountContactIngestion()
    assert.equal(polls.length, 2); assert.deepEqual(tombstones, [['Accounts', snapshot(local())]])
    assert.equal(result.accountsArchived, 1); assert.equal(result.accountsMatched, 1)
    assert.equal(result.errors, 1); assert.equal(result.deletedRecordsIgnored, 0)
    assert.deepEqual(projections, [{ pipelineId: id(101) }])
    assert.ok(queries.every(q => q.values?.[0] !== CURSOR))
    const ingestion = source('app_src/lib/crm/suiteCrmAccountContactIngestion.ts')
    assert.match(ingestion, /organization\.source_payload->>'archived'/)
    assert.match(ingestion, /contact\.source_payload->>'archived'/)
    assert.doesNotMatch(ingestion, /DELETE FROM crm_|deleteSuiteCrmRecord/)
  })
  console.log(`PASS ${checks} account/contact lifecycle groups; mocked DB/native/archive, no production proof`)
} finally {
  if (previous === undefined) delete process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED
  else process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED = previous
}
