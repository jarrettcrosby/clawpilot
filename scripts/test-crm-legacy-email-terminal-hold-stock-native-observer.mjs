#!/usr/bin/env node
// Synthetic Maria query port only. No connections, credentials, shell, or writes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript'), modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(new URL(`../app_src/lib/crm/${name}.ts`, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const result = { exports: {} }
  new Function('require', 'module', 'exports', js)(dependency => {
    if (dependency === 'server-only') return {}
    if (dependency.startsWith('node:')) return require(dependency)
    assert.match(dependency, /^\.\/[A-Za-z0-9]+$/u)
    return load(dependency.slice(2))
  }, result, result.exports)
  modules.set(name, result.exports)
  return result.exports
}
const { createLegacyEmailTerminalHoldStockNativeObserver: create } = load('legacyEmailTerminalHoldStockNativeObserver')
const { nativeEmailDigest } = load('nativeEmailPublication')
const { nativeEmailMariaStoreFingerprint } = load('nativeEmailRecoveryStoreBinding')
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = character => character.repeat(64)
const now = 1790000000123
const stock = ['emails', 'emails_beans', 'emails_cstm', 'emails_email_addr_rel', 'emails_text', 'securitygroups_records']
const managed = ['clawpilot_email_authority_approvals', 'clawpilot_email_authority_operations', 'clawpilot_email_bindings',
  'clawpilot_email_identities', 'clawpilot_email_initial_enrollments', 'clawpilot_email_operations',
  'clawpilot_email_write_permissions', 'clawpilot_email_write_scopes']
const countKeys = ['emails', 'customById', 'customByGlobal', 'emailText', 'beanLinks', 'addressLinks', 'securityGroupLinks']
const store = Object.freeze({ database: 'fixture_stock', hostname: 'fixture-maria', serverId: '12',
  serverVersion: '11.4.13-MariaDB', serverUid: Buffer.alloc(20, 8).toString('base64') })
const observer = Object.freeze({ user: 'fixture_reader', host: 'localhost' })
const scope = Object.freeze({ projectId: uuid(100), environmentId: uuid(101), postgresDatabaseFingerprint: hash('e'),
  appCommit: 'a'.repeat(40), nativeDeploymentId: uuid(102), nativeReplicaId: uuid(103), nativeCommit: 'b'.repeat(40),
  nativeDatabaseFingerprint: nativeEmailMariaStoreFingerprint(store), nativeAuthorityInstanceId: 'native-fixture' })
const identities = [1, 2].map(i => ({ outboxId: uuid(i), localId: uuid(10+i), nativeId: uuid(20+i), globalId: `gi100000${i}` }))
const effective = 'fixture_reader@localhost', grantee = "'fixture_reader'@'localhost'", schemaGrant = 'fixture\\_stock'
const code = suffix => error => error?.code === `legacy_terminal_hold_stock_observer_${suffix}`
const pin = request => ({ ...request, candidateFingerprint: nativeEmailDigest({
  version: 1, purpose: 'clawpilot-legacy-terminal-hold-preview-target-v1', target: request.target,
}) })

function fixture({ change = (_kind, _index, rows) => rows, scopeProvider = async (run, session) => run(session) } = {}) {
  let opens = 0
  const calls = [], invocations = new Map()
  const session = { async query(sql, values) {
    assert.match(sql, /^SELECT /)
    assert.doesNotMatch(sql, /;|FOR UPDATE|INTO OUTFILE|\bdeleted\b/i)
    const kind = sql.includes('SCHEMA_PRIVILEGES') ? 'grant' : sql.includes('information_schema.TABLES') ? 'tables'
      : sql.includes('COUNT(*) FROM emails') ? 'counts' : 'session'
    calls.push({ kind, values })
    const index = (invocations.get(kind) ?? 0) + 1
    invocations.set(kind, index)
    let rows
    if (kind === 'session') {
      assert.equal(values, undefined)
      assert.match(sql, /@@SESSION\.in_transaction.*\n.*@@SESSION\.tx_read_only.*\n.*@@SESSION\.tx_isolation/)
      rows = [{ database_name: store.database, hostname: store.hostname, server_id: store.serverId,
        server_version: store.serverVersion, server_uid: store.serverUid, effective_user: effective,
        login_user: observer.user, active_role: null, connection_id: '77', active_transaction: '1',
        session_read_only: '1', repeatable_read: '1', observed_at_ms: String(now + index) }]
    } else if (kind === 'grant') {
      assert.deepEqual(values, [grantee, schemaGrant])
      assert.match(sql, /BINARY GRANTEE=BINARY \? AND BINARY TABLE_SCHEMA=BINARY \?/)
      rows = [{ connection_id: '77', grantee, schema_grant: schemaGrant, privilege_type: 'SELECT' }]
    } else if (kind === 'tables') {
      assert.deepEqual(values, [...stock, ...managed])
      assert.match(sql, /BINARY TABLE_SCHEMA=BINARY DATABASE\(\) AND LOWER\(TABLE_NAME\) IN \(/)
      rows = stock.map(table_name => ({ connection_id: '77', table_name, table_type: 'BASE TABLE', engine: 'InnoDB' }))
    } else {
      const { nativeId, globalId } = identities[index - 1]
      assert.deepEqual(values, [nativeId, nativeId, globalId, nativeId, nativeId, nativeId, nativeId])
      assert.equal((sql.match(/FROM emails_cstm WHERE LOWER\((?:id_c|global_id_c)\)=\?/g) ?? []).length, 2)
      rows = [{ connection_id: '77', ...Object.fromEntries(countKeys.map(key => [key, '0'])) }]
    }
    return { rows: change(kind, index, rows) }
  } }
  const adapter = create({ target: { scope, store, observer }, async withReadOnlySession(signal, run) {
    opens++
    assert.equal(signal.aborted, false)
    return scopeProvider(run, session)
  } })
  const request = pin({ phase: 'nativeAbsence', observationId: uuid(9), identities,
    target: { operationId: uuid(7), scope, actorEmail: 'fixture@example.invalid', operatorAccountId: uuid(8),
      rootWorkspaceId: uuid(91), fenceEpoch: uuid(92), outboxIds: identities.map(row => row.outboxId),
      postgresObserverFingerprint: hash('f'), nativeObserverFingerprint: adapter.observerFingerprint } })
  const run = (customRequest = request, signal = new AbortController().signal) => adapter.observeNative(customRequest, signal)
  return { adapter, request, run, calls, opens: () => opens }
}

test('observer checks the complete exact stock and managed inventory around every exact count', async () => {
  const f = fixture()
  const initializer = readFileSync(new URL('../services/suitecrm/install-native-email-initial-state.php', import.meta.url), 'utf8')
  const tables = initializer.match(/const CP_INITIAL_TABLES=\[([^;]+)\];/u)?.[1]
  assert.ok(tables)
  assert.deepEqual([...tables.matchAll(/'(clawpilot_email_[a-z_]+)'/gu)].map(([, table]) => table).sort(), managed)
  const result = await f.run()
  assert.equal(f.opens(), 1)
  assert.deepEqual(f.calls.map(({ kind }) => kind), ['session', 'grant', 'tables', 'counts', 'counts', 'tables', 'session'])
  assert.equal(result.storeFingerprint, scope.nativeDatabaseFingerprint)
  assert.equal(result.observerFingerprint, f.adapter.observerFingerprint)
  assert.equal(result.candidateFingerprint, f.request.candidateFingerprint)
  assert.equal(result.observationId, f.request.observationId)
  assert.equal(result.observedAtMs, now + 2)
  assert.match(result.stockSchemaAbsenceFingerprint, /^[0-9a-f]{64}$/u)
  assert.deepEqual(result.rows, identities.map(row => ({ ...row, counts: {
    ...Object.fromEntries(countKeys.map(key => [key, 0])), managedIdentities: 0, nativeOperations: 0,
  } })))
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.rows[0].counts))
  const fresh = fixture()
  assert.notEqual((await fresh.run({ ...fresh.request, observationId: uuid(999) })).stockSchemaAbsenceFingerprint,
    result.stockSchemaAbsenceFingerprint, 'A different observation must not carry a replayed stock-schema proof')
})

test('empty, extra or non-exact direct grant readback does not count as visibility', async () => {
  const variants = [() => [], rows => [...rows, ...rows], rows => [{ ...rows[0], schema_grant: 'fixture_%' }],
    rows => [{ ...rows[0], schema_grant: 'other_schema' }], rows => [{ ...rows[0], privilege_type: 'TRIGGER' }],
    rows => [{ ...rows[0], grantee: "'fixture_reader'@'%'" }], rows => [{ ...rows[0], connection_id: '78' }]]
  for (const patch of variants) {
    const f = fixture({ change: (kind, _, rows) => kind === 'grant' ? patch(rows) : rows })
    await assert.rejects(f.run(), error => code('metadata_visibility')(error) || code('query_rows')(error))
    assert.deepEqual(f.calls.map(({ kind }) => kind), ['session', 'grant'])
  }
})

test('partial, view, case-variant, or managed table metadata holds before any count', async () => {
  const variants = [() => [], rows => rows.slice(1), rows => [{ ...rows[0], table_type: 'VIEW' }, ...rows.slice(1)],
    rows => [{ ...rows[0], engine: 'MyISAM' }, ...rows.slice(1)],
    rows => [...rows, { ...rows[0], table_name: 'CLAWPILOT_EMAIL_IDENTITIES' }],
    rows => [...rows.slice(0, 5), { ...rows[5], table_name: 'clawpilot_email_operations' }]]
  for (const patch of variants) {
    const f = fixture({ change: (kind, _, rows) => kind === 'tables' ? patch(rows) : rows })
    await assert.rejects(f.run(), code('not_stock_schema'))
    assert.deepEqual(f.calls.map(({ kind }) => kind), ['session', 'grant', 'tables'])
  }
})

test('installed or inaccessible metadata after the reads cannot prove stock absence', async () => {
  const late = fixture({ change: (kind, index, rows) => kind === 'tables' && index === 2
    ? [...rows, { ...rows[0], table_name: 'clawpilot_email_operations' }] : rows })
  await assert.rejects(late.run(), code('not_stock_schema'))
  const inaccessible = fixture({ change(kind, _, rows) {
    if (kind === 'tables') throw Object.assign(new Error('private-driver-details'), { errno: 1142 })
    return rows
  } })
  await assert.rejects(inaccessible.run(), error => code('observation_failed')(error) && !String(error).includes('private-driver-details'))
})

test('any exact stock collision, malformed count or session drift blocks absence', async () => {
  for (const key of countKeys) {
    const f = fixture({ change: (kind, _, rows) => kind === 'counts' ? [{ ...rows[0], [key]: '1' }] : rows })
    await assert.rejects(f.run(), code('native_not_absent'))
  }
  const wrongSession = fixture({ change: (kind, index, rows) => kind === 'session' && index === 2 ? [{ ...rows[0], connection_id: '78' }] : rows })
  await assert.rejects(wrongSession.run(), code('session_changed'))
  const wrongCountSession = fixture({ change: (kind, _, rows) => kind === 'counts' ? [{ ...rows[0], connection_id: '78' }] : rows })
  await assert.rejects(wrongCountSession.run(), code('native_not_absent'))
})

test('refuses wrong physical target, effective/login role and read-only transaction pins', async () => {
  for (const [key, value] of Object.entries({ hostname: 'other', database_name: 'other', server_uid: 'unknown',
    effective_user: 'different@localhost', login_user: 'different', active_role: 'granted_role',
    session_read_only: '0', active_transaction: '0', repeatable_read: '0', observed_at_ms: '9007199254740992' })) {
    const f = fixture({ change: (kind, _, rows) => kind === 'session' ? [{ ...rows[0], [key]: value }] : rows })
    await assert.rejects(f.run(), code('session_identity'))
    assert.deepEqual(f.calls.map(({ kind }) => kind), ['session'])
  }
})

test('rejects wrong scope, fingerprint, expanded or duplicate selection before opening the port', async () => {
  const f = fixture(), { request } = f
  const variants = [
    [{ ...request, candidateFingerprint: hash('0') }, 'request_candidate'],
    [pin({ ...request, target: { ...request.target, scope: { ...scope, nativeCommit: 'c'.repeat(40) } } }), 'request_binding'],
    [{ ...request, identities: [...identities, identities[0]] }, 'request_row'],
    [{ ...request, identities: [identities[0], { ...identities[1], nativeId: identities[0].nativeId }] }, 'request_rows'],
    [{ ...request, identities: [{ ...identities[0], globalId: "gi1000001' OR 1" }, identities[1]] }, 'request_row'],
  ]
  for (const [value, suffix] of variants) await assert.rejects(f.run(value), code(suffix))
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(f.run(request, cancelled.signal), code('cancelled'))
  assert.equal(f.opens(), 0)
})

test('a returned synthetic result, session reuse or abort during a query never substitutes for actual observations', async () => {
  const returnedEarly = fixture({ scopeProvider: async () => ({ fabricated: true }) })
  await assert.rejects(returnedEarly.run(), code('session_provider_failed'))
  const reused = fixture({ async scopeProvider(run, session) {
    const first = await run(session)
    try { await run(session) } catch { /* bad provider attempts replay */ }
    return first
  } })
  await assert.rejects(reused.run(), code('session_provider_failed'))
  assert.equal(reused.calls.filter(call => call.kind === 'session').length, 2)
  const abort = new AbortController()
  const timed = fixture({ change(kind, _, rows) { if (kind === 'grant') abort.abort(); return rows } })
  await assert.rejects(timed.run(timed.request, abort.signal), code('session_scope'))
  assert.deepEqual(timed.calls.map(({ kind }) => kind), ['session', 'grant'])
})
